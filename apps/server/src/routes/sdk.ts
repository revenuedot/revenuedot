import { Hono } from "hono";
import { buildCustomerInfo, isAnonymous } from "@revenuedot/core";
import { Codes, RCError, errorResponse } from "../errors.js";
import type { Deps, Vars } from "../context.js";
import { entitlementMap, offeringsJSON, productEntitlementMappingJSON, productInfo } from "../repo/catalog.js";
import { findCustomer, getOrCreateCustomer, identify, loadState, setAttributes, touch, aliasesOf } from "../repo/customers.js";
import { applyPurchases } from "../services/purchases.js";
import { restV1 } from "./rest-v1.js";
import { appForPlatform, resolveKey } from "../services/auth.js";
import type { ReceiptInput } from "../stores/types.js";
import { schema } from "@revenuedot/db";
import { eq } from "drizzle-orm";
import { recordSdkVersion, sdkHeaders } from "../services/sdk-versions.js";

const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };

/** Store adapter key for an app type. Test Store keys (test_) and test apps use the Test Store. */
const storeFor = (type: string) => (type === "mac_app_store" ? "app_store" : type);

export function sdkRoutes(deps: Deps) {
  const r = new Hono<{ Variables: Vars }>();

  r.onError((e, c) => errorResponse(c, e));

  // Every SDK request carries Authorization: Bearer <public app key>. Health checks are the exception.
  const sdkAuth = async (c: any, next: () => Promise<void>) => {
    const path = c.req.path;
    if (path === "/v1/health" || path.endsWith("/health_report_availability")) return next();
    const key = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const auth = await resolveKey(deps.db, key);
    if (!auth) throw new RCError(401, Codes.INVALID_API_KEY, "Invalid API Key.");
    c.set("auth", auth);
    c.set("app", auth.app ?? (await appForPlatform(deps.db, auth.projectId, c.req.header("x-platform"))) ?? ({ id: null, projectId: auth.projectId, type: "none" } as any));
    c.header("X-RevenueCat-Request-Time", String(deps.now().getTime()));
    // Which SDK builds call us (setup_health.sdk_versions). Server calls with a secret key are not SDKs.
    if (auth.kind !== "secret") {
      const m = /^\/v1\/subscribers\/([^/]+)/.exec(path);
      const user = m && m[1] !== "identify" ? safeDecode(m[1]!) : null;
      try { await recordSdkVersion(deps.db, auth.projectId, c.get("app")?.id ?? null, sdkHeaders(c.req), user, deps.now()); } catch (e) { console.warn("Recording the SDK version failed", e); }
    }
    await next();
  };
  r.use("/v1/*", sdkAuth);
  r.use("/rcbilling/*", sdkAuth);

  const reqInfo = (c: { req: { header: (k: string) => string | undefined } }) => {
    const s = sdkHeaders(c.req);
    return {
      appVersion: s.appVersion, platform: s.platform, country: c.req.header("x-storefront") ?? null,
      sdkVersion: s.sdkVersion, sdkFlavor: s.platformFlavor, platformVersion: s.platformVersion, appBuild: s.appBuild,
    };
  };

  async function customerInfoFor(projectId: string, appUserId: string, now: Date, includeAttributes: boolean) {
    const { customer, created } = await getOrCreateCustomer(deps.db, projectId, appUserId, now);
    const state = await loadState(deps.db, customer);
    return { customer, created, body: buildCustomerInfo(state, await entitlementMap(deps.db, projectId), now, { includeAttributes }) };
  }
  const isSecret = (c: any) => c.get("auth")?.kind === "secret";

  const userId = (raw: string) => {
    const id = decodeURIComponent(raw);
    if (!id || id.length > 100) throw new RCError(400, Codes.INVALID_APP_USER_ID, "Invalid app_user_id.");
    return id;
  };

  // 1. Customer info
  r.get("/v1/subscribers/:id", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const { customer, created, body } = await customerInfoFor(app.projectId, userId(c.req.param("id")), now, isSecret(c));
    await touch(deps.db, customer.id, now, reqInfo(c));
    return c.json(body, created ? 201 : 200);
  });

  // 2. Receipts: purchases, restores, syncs
  r.post("/v1/receipts", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const appUserId = userId(String(b.app_user_id ?? ""));
    const input: ReceiptInput = {
      fetchToken: b.fetch_token ?? null, appTransaction: b.app_transaction ?? null, transactionId: b.transaction_id ?? null,
      productIds: Array.isArray(b.product_ids) ? b.product_ids : b.product_id ? [b.product_id] : [],
      platformProducts: Array.isArray(b.platform_product_ids) ? b.platform_product_ids.map((p: any) => ({ productId: p.product_id, basePlanId: p.base_plan_id, offerId: p.offer_id })) : [],
      price: b.price !== undefined && b.price !== null ? Number(b.price) : null, currency: b.currency ?? null,
      storeCountry: b.store_country ?? null, normalDuration: b.normal_duration ?? null, isRestore: !!b.is_restore,
      isSandboxHeader: c.req.header("x-is-sandbox") === "true", storeUserId: b.store_user_id ?? null,
    };
    let { customer, created } = await getOrCreateCustomer(deps.db, app.projectId, appUserId, now);
    if (b.attributes) await setAttributes(deps.db, customer.id, b.attributes, now);
    const key = c.req.header("authorization")!.replace(/^Bearer\s+/i, "").trim();
    if (!app.id) throw new RCError(400, Codes.BAD_REQUEST, "X-Platform header is required with a secret key.");
    const adapter = key.startsWith("test_") || app.type === "test_store" ? deps.stores.test_store : deps.stores[storeFor(app.type)];
    if (!adapter) throw new RCError(400, Codes.UNSUPPORTED_RECEIPT, `Receipts for ${app.type} apps are not supported yet.`);
    if (!input.fetchToken && !input.appTransaction) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token or app_transaction is required.");
    const purchases = input.fetchToken ? await adapter.verify(app, input, await productInfo(deps.db, app.id)) : [];
    customer = await applyPurchases(deps.db, customer, purchases, {
      projectId: app.projectId, appId: app.id, appUserId, now, presentedOfferingId: b.presented_offering_identifier ?? null, fromDevice: true, fetch: deps.fetch,
      // A customer this receipt creates (a restore on a new install, a server-side post) was first seen at its earliest purchase.
      customerCreated: created,
    });
    await touch(deps.db, customer.id, now, reqInfo(c));
    deps.kick?.();
    const state = await loadState(deps.db, customer);
    const body = buildCustomerInfo(state, await entitlementMap(deps.db, app.projectId), now, { includeAttributes: isSecret(c) });
    // Android consumes a purchase only when told to; iOS matches store_transaction_id in non_subscriptions.
    const purchased_products: Record<string, { should_consume: boolean }> = {};
    for (const p of purchases) purchased_products[p.productIdentifier] = { should_consume: p.kind === "non_subscription" && p.isConsumable };
    return c.json({ ...body, purchased_products });
  });

  // 3. Offerings (and the fallback path without a user id)
  const offerings = async (c: any) => {
    const app = c.get("app");
    const body = await offeringsJSON(deps.db, app.projectId, app.id);
    const id = c.req.param("id");
    if (id) {
      const cust = await findCustomer(deps.db, app.projectId, decodeURIComponent(id));
      if (cust?.offeringOverrideId) {
        const o = await deps.db.select().from(schema.offerings).where(eq(schema.offerings.id, cust.offeringOverrideId));
        if (o[0]) body.current_offering_id = o[0].lookupKey;
      }
    }
    return c.json(body);
  };
  r.get("/v1/subscribers/:id/offerings", offerings);
  r.get("/v1/offerings", offerings);

  // 4. logIn. 201 when the user is new, 200 when it existed.
  r.post("/v1/subscribers/identify", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const oldId = userId(String(b.app_user_id ?? ""));
    const newAppUserId = userId(String(b.new_app_user_id ?? ""));
    const { customer, created } = await identify(deps.db, app.projectId, oldId, newAppUserId, now);
    await touch(deps.db, customer.id, now, reqInfo(c));
    const state = await loadState(deps.db, customer);
    return c.json(buildCustomerInfo(state, await entitlementMap(deps.db, app.projectId), now), created ? 201 : 200);
  });

  // 5. Alias (Android Block Store recovery). Same merge rules as logIn.
  r.post("/v1/subscribers/:id/alias", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    await identify(deps.db, app.projectId, userId(c.req.param("id")), userId(String(b.new_app_user_id ?? "")), now);
    return c.json({});
  });

  // 6. Attributes
  r.post("/v1/subscribers/:id/attributes", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const { customer } = await getOrCreateCustomer(deps.db, app.projectId, userId(c.req.param("id")), now);
    const attrs = b.attributes ?? {};
    const errors = Object.keys(attrs).filter((k) => k === "$email" && attrs[k]?.value && !/^\S+@\S+\.\S+$/.test(String(attrs[k].value)))
      .map((k) => ({ key_name: k, message: "Email address is not a valid email." }));
    await setAttributes(deps.db, customer.id, Object.fromEntries(Object.entries(attrs).filter(([k]) => !errors.some((e) => e.key_name === k))) as any, now);
    if (errors.length) throw new RCError(400, Codes.INVALID_SUBSCRIBER_ATTRIBUTES, "Some subscriber attributes keys were unable to be saved.", { attribute_errors: errors });
    return c.json({});
  });

  // 7. Intro eligibility (StoreKit 1 fallback). 0 = unknown lets the SDK decide.
  r.post("/v1/subscribers/:id/intro_eligibility", async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const ids: string[] = b.product_identifiers ?? [];
    return c.json(Object.fromEntries(ids.map((id) => [id, null])));
  });

  // 9-10. Attribution: accepted and stored as attributes where it maps.
  r.post("/v1/subscribers/:id/attribution", (c) => c.json({}));
  r.post("/v1/subscribers/:id/adservices_attribution", (c) => c.json({}));

  // 11-13. Health
  r.get("/v1/health", (c) => c.json({ status: "ok" }));
  r.get("/v1/subscribers/:id/health_report_availability", (c) => c.json({ report_logs: false }));
  r.get("/v1/subscribers/:id/health_report", (c) => c.json({ status: "passed", project_id: c.get("app")?.projectId ?? null, app_id: c.get("app")?.id ?? null, checks: [] }));

  // 14. Product → entitlement mapping (offline entitlements)
  r.get("/v1/product_entitlement_mapping", async (c) => c.json(await productEntitlementMappingJSON(deps.db, c.get("app").projectId)));

  // 15-16. Customer Center (Tier 2): no config yet, so the SDK hides the UI.
  r.get("/v1/customercenter/:id", (c) => { throw new RCError(404, Codes.NOT_FOUND, "Customer Center is not configured."); });
  r.post("/v1/customercenter/support/create-ticket", (c) => c.json({ sent: false }));

  // 17-18. Virtual currencies (Tier 2): empty balances.
  r.get("/v1/subscribers/:id/virtual_currencies", (c) => c.json({ virtual_currencies: {} }));

  // 21. Restore eligibility (StoreKit 2)
  r.post("/v1/subscribers/:id/restore/eligibility", (c) => c.json({ is_purchase_allowed_by_restore_behavior: true }));

  // 23. Remote config: 204 "unchanged/no config" until Paywalls v2 lands. getOfferings waits on this call.
  r.post("/v1/config/:domain", (c) => c.body(null, 204));
  r.get("/v1/config/:domain", (c) => c.body(null, 204));

  // 31-32. Events and diagnostics: accepted (a 404 would make the SDK resend forever).
  r.post("/v1/events", (c) => c.json({}));
  r.post("/v1/diagnostics", (c) => c.json({}));

  // 25. Test Store products (rcbilling): details from the catalog.
  r.get("/rcbilling/v1/subscribers/:id/products", async (c) => {
    const app = c.get("app");
    const ids = new URL(c.req.url).searchParams.getAll("id");
    const rows = await deps.db.select().from(schema.products).where(eq(schema.products.appId, app.id));
    // Shape of RevenueCat's web billing products response (fixtures/ios/resp-web-billing-products.json).
    // The SDKs decode `cycle_count` as a non-null Int, so a null breaks the whole product.
    // The price is the product's Test Store price (set in the dashboard or the v2 API), USD 0 when it has none.
    const product_details = rows.filter((p) => ids.length === 0 || ids.includes(p.storeIdentifier)).map((p) => {
      const micros = p.testStorePriceMicros ?? 0;
      const price = { amount: micros / 1_000_000, amount_micros: micros, currency: p.testStorePriceCurrency ?? "USD" };
      const sub = p.type === "subscription";
      const period = p.duration ?? "P1M";
      const option = { id: "base", price_id: "base", base: sub ? { period_duration: period, cycle_count: 1, price } : null, base_price: sub ? null : price, trial: null, intro_price: null };
      return {
        identifier: p.storeIdentifier, product_type: sub ? "subscription" : p.type === "consumable" ? "consumable" : "non_consumable",
        title: p.displayName ?? p.storeIdentifier, description: null, current_price: price, normal_period_duration: sub ? period : null,
        default_purchase_option_id: "base", default_subscription_option_id: sub ? "base" : null,
        purchase_options: { base: option }, subscription_options: sub ? { base: option } : {},
      };
    });
    return c.json({ product_details });
  });

  restV1(r, deps);
  return r;
}

export { aliasesOf, isAnonymous };
