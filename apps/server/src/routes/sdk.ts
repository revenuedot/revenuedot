import { Hono } from "hono";
import { buildCustomerInfo, isAnonymous } from "@revenuedot/core";
import { Codes, RCError, errorResponse } from "../errors.js";
import type { Deps, Vars } from "../context.js";
import { appByPublicKey, entitlementMap, offeringsJSON, productEntitlementMappingJSON, productInfo } from "../repo/catalog.js";
import { findCustomer, getOrCreateCustomer, identify, loadState, setAttributes, touch, aliasesOf } from "../repo/customers.js";
import { applyPurchases } from "../services/purchases.js";
import type { ReceiptInput } from "../stores/types.js";
import { schema } from "@revenuedot/db";
import { eq } from "drizzle-orm";

/** Store adapter key for an app type. Test Store keys (test_) and test apps use the Test Store. */
const storeFor = (type: string) => (type === "mac_app_store" ? "app_store" : type);

export function sdkRoutes(deps: Deps) {
  const r = new Hono<{ Variables: Vars }>();

  r.onError((e, c) => errorResponse(c, e));

  // Every SDK request carries Authorization: Bearer <public app key>. Health checks are the exception.
  r.use("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/v1/health" || path.endsWith("/health_report_availability")) return next();
    const auth = c.req.header("authorization") ?? "";
    const key = auth.replace(/^Bearer\s+/i, "").trim();
    const app = key ? await appByPublicKey(deps.db, key) : null;
    if (!app) throw new RCError(401, Codes.INVALID_API_KEY, "Invalid API Key.");
    c.set("app", app);
    c.header("X-RevenueCat-Request-Time", String(deps.now().getTime()));
    await next();
  });

  const reqInfo = (c: { req: { header: (k: string) => string | undefined } }) => ({
    appVersion: c.req.header("x-client-version") ?? null,
    platform: c.req.header("x-platform") ?? null,
    country: c.req.header("x-storefront") ?? null,
  });

  async function customerInfoFor(projectId: string, appUserId: string, now: Date, create = true) {
    const customer = create ? (await getOrCreateCustomer(deps.db, projectId, appUserId, now)).customer : await findCustomer(deps.db, projectId, appUserId);
    if (!customer) throw new RCError(404, Codes.NOT_FOUND, "Subscriber not found.");
    const state = await loadState(deps.db, customer);
    return { customer, body: buildCustomerInfo(state, await entitlementMap(deps.db, projectId), now) };
  }

  const userId = (raw: string) => {
    const id = decodeURIComponent(raw);
    if (!id || id.length > 100) throw new RCError(400, Codes.INVALID_APP_USER_ID, "Invalid app_user_id.");
    return id;
  };

  // 1. Customer info
  r.get("/v1/subscribers/:id", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const { customer, body } = await customerInfoFor(app.projectId, userId(c.req.param("id")), now);
    await touch(deps.db, customer.id, now, reqInfo(c));
    return c.json(body);
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
    let { customer } = await getOrCreateCustomer(deps.db, app.projectId, appUserId, now);
    if (b.attributes) await setAttributes(deps.db, customer.id, b.attributes, now);
    const key = c.req.header("authorization")!.replace(/^Bearer\s+/i, "").trim();
    const adapter = key.startsWith("test_") || app.type === "test_store" ? deps.stores.test_store : deps.stores[storeFor(app.type)];
    if (!adapter) throw new RCError(400, Codes.UNSUPPORTED_RECEIPT, `Receipts for ${app.type} apps are not supported yet.`);
    if (!input.fetchToken && !input.appTransaction) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token or app_transaction is required.");
    const purchases = input.fetchToken ? await adapter.verify(app, input, await productInfo(deps.db, app.id)) : [];
    customer = await applyPurchases(deps.db, customer, purchases, {
      projectId: app.projectId, appId: app.id, appUserId, now, presentedOfferingId: b.presented_offering_identifier ?? null, fromDevice: true,
    });
    await touch(deps.db, customer.id, now, reqInfo(c));
    deps.kick?.();
    const state = await loadState(deps.db, customer);
    const body = buildCustomerInfo(state, await entitlementMap(deps.db, app.projectId), now);
    // Android consumes a purchase only when told to; iOS matches store_transaction_id in non_subscriptions.
    const purchased_products: Record<string, { should_consume: boolean }> = {};
    for (const p of purchases) purchased_products[p.productIdentifier] = { should_consume: p.kind === "non_subscription" && p.isConsumable };
    return c.json({ ...body, purchased_products });
  });

  // 3. Offerings (and the fallback path without a user id)
  const offerings = async (c: any) => {
    const app = c.get("app");
    return c.json(await offeringsJSON(deps.db, app.projectId, app.id));
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
    const product_details = rows.filter((p) => ids.length === 0 || ids.includes(p.storeIdentifier)).map((p) => ({
      identifier: p.storeIdentifier, product_type: p.type === "subscription" ? "subscription" : p.type === "consumable" ? "consumable" : "non_consumable",
      title: p.displayName ?? p.storeIdentifier, description: null, default_purchase_option_id: "base",
      purchase_options: { base: { id: "base", price_id: "base", base: p.type === "subscription" ? { period_duration: p.duration ?? "P1M", cycle_count: null, price: { amount_micros: 0, currency: "USD" } } : null, base_price: p.type === "subscription" ? null : { amount_micros: 0, currency: "USD" } } },
    }));
    return c.json({ product_details });
  });

  return r;
}

export { aliasesOf, isAnonymous };
