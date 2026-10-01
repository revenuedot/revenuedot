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
import { attributionDataToAttributes, inBackground, resolveAdServicesToken, resolveDeviceAttributes, setAttributionOnce } from "../services/attribution.js";
import { appleCredentials } from "../stores/apple/api.js";
import { appAccountTokenFor, signOffer } from "../services/promo-offers.js";
import { customerCenterFor } from "../services/customer-center.js";
import { publicOrigin } from "./oauth.js";
import { buildRemoteConfig } from "../services/remote-config.js";
import { activeEntitlementKeys, contextFor, resolveOfferings } from "../services/targeting.js";
import { balancesOf } from "../services/virtual-currencies.js";
import { amazonClientFor, amazonReceiptData } from "../stores/amazon/index.js";
import { rowPrice, subRowOf } from "../stores/rows.js";
import { MAX_BODY_BYTES, storeSdkEvents } from "../services/sdk-events.js";

const safeDecode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };

/** Store adapter key for an app type. Test Store keys (test_) and test apps use the Test Store. */
const storeFor = (type: string) => (type === "mac_app_store" ? "app_store" : type);

export function sdkRoutes(deps: Deps) {
  const r = new Hono<{ Variables: Vars }>();

  r.onError((e, c) => errorResponse(c, e));

  // Every SDK request carries Authorization: Bearer <public app key>. Health checks are the exception.
  const sdkAuth = async (c: any, next: () => Promise<void>) => {
    const path = c.req.path;
    // Every SDK response carries the server time, the unauthenticated health calls too (they are signature-verified).
    c.header("X-RevenueCat-Request-Time", String(deps.now().getTime()));
    if (path === "/v1/health" || path === "/v1/health/connectivity" || path.endsWith("/health_report_availability")) return next();
    const key = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const auth = await resolveKey(deps.db, key);
    if (!auth) throw new RCError(401, Codes.INVALID_API_KEY, "Invalid API Key.");
    c.set("auth", auth);
    c.set("app", auth.app ?? (await appForPlatform(deps.db, auth.projectId, c.req.header("x-platform"))) ?? ({ id: null, projectId: auth.projectId, type: "none" } as any));
    // Which SDK builds call us (setup_health.sdk_versions). Server calls with a secret key are not SDKs.
    if (auth.kind !== "secret") {
      const m = /^\/v1\/subscribers\/([^/]+)/.exec(path);
      const user = m && m[1] !== "identify" && m[1] !== "redeem_purchase" ? safeDecode(m[1]!) : null;
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
    if (b.attributes) await setAttributes(deps.db, customer.id, resolveDeviceAttributes(b.attributes, c), now);
    // iOS sends the AdServices token with the first receipt when attribution collection is on.
    if (typeof b.aad_attribution_token === "string" && b.aad_attribution_token) {
      const id = customer.id, token = b.aad_attribution_token;
      inBackground(deps, () => resolveAdServicesToken(deps, id, token));
    }
    const key = c.req.header("authorization")!.replace(/^Bearer\s+/i, "").trim();
    if (!app.id) throw new RCError(400, Codes.BAD_REQUEST, "X-Platform header is required with a secret key.");
    const adapter = key.startsWith("test_") || app.type === "test_store" ? deps.stores.test_store : deps.stores[storeFor(app.type)];
    if (!adapter) throw new RCError(400, Codes.UNSUPPORTED_RECEIPT, `Receipts for ${app.type} apps are not supported yet.`);
    if (!input.fetchToken && !input.appTransaction) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token or app_transaction is required.");
    const purchases = input.fetchToken ? await adapter.verify(app, input, await productInfo(deps.db, app.id), {
      storedPeriod: async (store, storeKey) => {
        const row = await subRowOf(deps.db, app.projectId, store, storeKey);
        return row ? { storeTransactionId: row.storeTransactionId, purchaseDate: row.purchaseDate, price: rowPrice(row) } : null;
      },
    }) : [];
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
    const body = await offeringsJSON(deps.db, app.projectId, app.id, { assetBaseUrl: `${publicOrigin(c)}/assets/${app.projectId}` }) as Awaited<ReturnType<typeof offeringsJSON>> & { targeting?: { revision: number; rule_id: string } };
    const id = c.req.param("id");
    const cust = id ? await findCustomer(deps.db, app.projectId, decodeURIComponent(id)) : null;
    const offs = await deps.db.select({ id: schema.offerings.id, key: schema.offerings.lookupKey, current: schema.offerings.isCurrent }).from(schema.offerings).where(eq(schema.offerings.projectId, app.projectId));
    const keyOf = (oid: string | null) => offs.find((o) => o.id === oid)?.key ?? null;
    if (cust?.offeringOverrideId) {
      // An offering override set through the API wins over targeting and experiments, as in RevenueCat.
      body.current_offering_id = keyOf(cust.offeringOverrideId) ?? body.current_offering_id;
      return c.json(body);
    }
    const now = deps.now();
    const headers = Object.fromEntries(["x-platform", "x-client-version", "x-version", "x-platform-flavor", "x-platform-version", "x-storefront", "x-preferred-locales"].map((h) => [h, c.req.header(h)]));
    const ctx = await contextFor(deps.db, cust, headers, now, cust ? await activeEntitlementKeys(deps.db, cust, now) : []);
    const r = await resolveOfferings(deps.db, app.projectId, cust, ctx, now, offs.find((o) => o.current)?.id ?? null);
    body.current_offering_id = keyOf(r.currentOfferingId) ?? body.current_offering_id;
    body.placements = {
      fallback_offering_id: body.current_offering_id,
      offering_ids_by_placement: Object.fromEntries(Object.entries(r.placements).map(([p, oid]) => [p, oid ? keyOf(oid) : null])),
    };
    if (r.rule) body.targeting = { revision: r.rule.revision, rule_id: r.rule.id };
    return c.json(body);
  };
  // Remote configuration (paywalls as workflows, ui_config). RC Container body; 204 when the SDK's manifest is current.
  r.post("/v1/config/:domain", async (c) => {
    const app = c.get("app");
    const b = (await c.req.json().catch(() => ({}))) as { manifest?: string; prefetched_blobs?: string[] };
    const built = await buildRemoteConfig(deps.db, app.projectId, publicOrigin(c), typeof b.manifest === "string" ? b.manifest : null, Array.isArray(b.prefetched_blobs) ? b.prefetched_blobs.filter((x) => typeof x === "string") : []);
    if (!built.body) return c.body(null, 204);
    return new Response(built.body as unknown as BodyInit, { headers: { "content-type": "application/x-rc-format", "cache-control": "no-store", "x-revenuecat-request-time": String(deps.now().getTime()) } });
  });
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
    const attrs = resolveDeviceAttributes(b.attributes ?? {}, c);
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

  // 8. Promotional offer signing (iOS). Signed with the app's In-App Purchase key; without one the SDK gets 7234
  // (invalidAppleSubscriptionKeyError), which fails only that offer.
  r.post("/v1/offers", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const appUserId = userId(String(b.app_user_id ?? ""));
    const wanted: Array<Record<string, unknown>> = Array.isArray(b.generate_offers) ? b.generate_offers : [];
    if (!wanted.length) throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "generate_offers is required.");
    const creds = app.type === "app_store" || app.type === "mac_app_store" ? appleCredentials(app) : null;
    if (!creds) throw new RCError(400, Codes.INVALID_APPLE_SUBSCRIPTION_KEY, "Promotional offers need the app's App Store In-App Purchase key. Add it in the app's settings.");
    const sk2 = c.req.header("x-storekit2-enabled") === "true" || c.req.header("x-storekit-version") === "2";
    const token = appAccountTokenFor(appUserId, sk2);
    const offers = [];
    for (const o of wanted) {
      const productId = String(o.product_id ?? ""), offerId = String(o.offer_id ?? "");
      const sig = await signOffer(creds, productId, offerId, token, now);
      offers.push({ key_id: sig.keyId, offer_id: offerId, product_id: productId, signature_data: { nonce: sig.nonce, signature: sig.signature, timestamp: sig.timestamp } });
    }
    return c.json({ offers });
  });

  // 9-10. Attribution. The legacy call's identifiers and Apple Search Ads data become reserved attributes; the AdServices
  // token is resolved with Apple after the response. The SDK ignores both response bodies.
  r.post("/v1/subscribers/:id/attribution", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const { customer } = await getOrCreateCustomer(deps.db, app.projectId, userId(c.req.param("id")), now);
    await setAttributionOnce(deps.db, customer.id, attributionDataToAttributes({ network: b.network, data: b.data }, now.getTime()), now);
    return c.json({});
  });
  r.post("/v1/subscribers/:id/adservices_attribution", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const token = typeof b.aad_attribution_token === "string" ? b.aad_attribution_token.trim() : "";
    if (!token) throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "aad_attribution_token is required.");
    const { customer } = await getOrCreateCustomer(deps.db, app.projectId, userId(c.req.param("id")), now);
    inBackground(deps, () => resolveAdServicesToken(deps, customer.id, token));
    return c.json({});
  });

  // 11-13. Health, and the API-source probe (iOS, internal failover setting).
  r.get("/v1/health", (c) => c.json({ status: "ok" }));
  r.get("/v1/health/connectivity", (c) => c.json({ status: "ok" }));
  r.get("/v1/subscribers/:id/health_report_availability", (c) => c.json({ report_logs: false }));
  r.get("/v1/subscribers/:id/health_report", (c) => c.json({ status: "passed", project_id: c.get("app")?.projectId ?? null, app_id: c.get("app")?.id ?? null, checks: [] }));

  // 14. Product → entitlement mapping (offline entitlements)
  r.get("/v1/product_entitlement_mapping", async (c) => c.json(await productEntitlementMappingJSON(deps.db, c.get("app").projectId)));

  // 15-16. Customer Center (Tier 2): no config yet, so the SDK hides the UI.
  r.get("/v1/customercenter/:id", async (c) => c.json({ customer_center: await customerCenterFor(deps.db, c.get("app").projectId) }));
  r.post("/v1/customercenter/support/create-ticket", (c) => c.json({ sent: false }));

  // 17-18. Virtual currencies (Tier 2): empty balances.
  r.get("/v1/subscribers/:id/virtual_currencies", async (c) => {
    const projectId = c.get("app").projectId;
    const cust = await findCustomer(deps.db, projectId, decodeURIComponent(c.req.param("id")));
    const out: Record<string, { balance: number; name: string; code: string; description: string | null }> = {};
    if (cust) for (const b of await balancesOf(deps.db, projectId, cust.id, { includeEmpty: true })) out[b.code] = { balance: b.balance, name: b.name, code: b.code, description: b.description };
    return c.json({ virtual_currencies: out });
  });

  // 19. Web purchase redemption. RevenueDot sells nothing on the web, so no token is valid: 7849 is the SDK's
  // `invalidToken` result, which apps show as "this link is not valid".
  r.post("/v1/subscribers/redeem_purchase", () => {
    throw new RCError(400, Codes.INVALID_WEB_REDEMPTION_TOKEN, "This redemption link is not valid: RevenueDot has no web purchases to redeem.");
  });

  // 20. External purchase tokens (iOS, Apple's external purchase and link-out flows). The token is acknowledged with an
  // id, which is all the SDK reads; the web checkout it leads to answers 7000 below.
  r.post("/v1/external_purchase_tokens", async (c) => {
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const purchaseType = b.purchase_type === "IN_APP" ? "IN_APP" : "LINK_OUT";
    return c.json({ id: `ept${crypto.randomUUID().replace(/-/g, "")}`, purchase_type: purchaseType, is_sandbox: c.req.header("x-is-sandbox") === "true", token_source: b.token ? "APPLE_SDK" : "RC_GENERATED" });
  });

  // 21. Restore eligibility (StoreKit 2)
  r.post("/v1/subscribers/:id/restore/eligibility", (c) => c.json({ is_purchase_allowed_by_restore_behavior: true }));

  // 22. Ad reward verification. There is no server-side ad verification, so the answer is final ("failed"), which stops
  // the SDK's polling after one request.
  r.get("/v1/subscribers/:id/ads/reward_verifications/:tx", (c) =>
    c.json({ status: "failed", reward: null, failure_reason: "not_supported", message: "Server-side reward verification is not available on RevenueDot." }));

  // 24. Amazon receipt details (Android, Amazon builds): RVS's receipt as Amazon returned it. The SDK reads `termSku` and
  // posts it as the product id. A key that is not an Amazon app's answers 7662 (the purchase stays unconsumed).
  // The SDK encodes the store user id but not the receipt id, which can contain "/".
  const amazonReceipt = async (c: any) => {
    const app = c.get("app");
    if (app.type !== "amazon") throw new RCError(400, Codes.UNSUPPORTED_RECEIPT, "This API key does not belong to an Amazon Appstore app.");
    const rest = new URL(c.req.url).pathname.replace(/^\/v1\/receipts\/amazon\//, "");
    const slash = rest.indexOf("/");
    const storeUserId = slash > 0 ? safeDecode(rest.slice(0, slash)) : "";
    const receiptId = slash > 0 ? safeDecode(rest.slice(slash + 1)) : "";
    if (!storeUserId || !receiptId) throw new RCError(400, Codes.INVALID_RECEIPT, "Expected /v1/receipts/amazon/{store_user_id}/{receipt_id}.");
    const { client } = amazonClientFor(deps.stores, deps.fetch);
    return c.json(await amazonReceiptData(client, app, storeUserId, receiptId));
  };
  r.get("/v1/receipts/amazon/:storeUserId/:receiptId", amazonReceipt);
  r.get("/v1/receipts/amazon/*", amazonReceipt);

  // 23. Remote config: POST is above (RC Container with workflows and ui_config). The GET form is the SDK's JSON fallback
  // host, never used with a proxy URL: "no configuration".
  r.get("/v1/config/:domain", (c) => c.body(null, 204));

  // 31-32. Events and diagnostics: accepted (a 404 would make the SDK resend forever).
  // Paywall, Customer Center and ad events are kept for the charts (services/sdk-events.ts); a bad batch is still a 200.
  r.post("/v1/events", async (c) => {
    try {
      // An oversized batch is dropped unread: the endpoint takes a public key.
      if (Number(c.req.header("content-length") ?? 0) <= MAX_BODY_BYTES) {
        const text = await c.req.text();
        let body: unknown = null;
        if (text.length <= MAX_BODY_BYTES) { try { body = JSON.parse(text); } catch { /* skipped */ } }
        await storeSdkEvents(deps.db, { projectId: c.get("auth").projectId, app: c.get("app")?.id ? c.get("app") : null, body, now: deps.now(), sandboxHeader: c.req.header("x-is-sandbox") === "true" });
      }
    } catch (e) { console.warn("Storing SDK events failed", e); }
    return c.json({});
  });
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

  // 26. Web offering products (iOS; defined, no caller in the SDK): no web offerings.
  r.get("/rcbilling/v1/subscribers/:id/offering_products", (c) => c.json({ offerings: {} }));

  // Web Billing checkout (iOS hosted checkout; purchases-js with an rcb_ key). RevenueDot takes no payments, so a checkout
  // cannot start: iOS returns `.failed` from the checkout, purchases-js shows its purchase error.
  const noCheckout = () => { throw new RCError(400, Codes.INVALID_PLATFORM, "Web checkout is not available on RevenueDot."); };
  const noSession = () => { throw new RCError(400, Codes.INVALID_OPERATION_SESSION, "There is no such checkout session."); };
  r.post("/rcbilling/v1/hosted-checkout", noCheckout);
  r.post("/rcbilling/v1/purchase", noCheckout);
  r.post("/rcbilling/v1/checkout/prepare", noCheckout);
  r.post("/rcbilling/v1/checkout/start", noCheckout);
  r.get("/rcbilling/v1/checkout/:session", noSession);
  r.patch("/rcbilling/v1/checkout/:session", noSession);
  r.post("/rcbilling/v1/checkout/:session/complete", noSession);
  // Branding for the web checkout (purchases-js, rcb_ keys): the app's name and no custom look.
  r.get("/rcbilling/v1/branding", (c) => {
    const app = c.get("app");
    return c.json({
      id: app.id ?? app.projectId, app_name: app.name ?? null, app_icon: null, app_icon_webp: null, app_wordmark: null, app_wordmark_webp: null,
      appearance: null, support_email: null, gateway_tax_collection_enabled: false, brand_font_config: null,
    });
  });
  // Paywall workflows (purchases-js presentPaywall): none, so the SDK uses the offering's own paywall.
  r.get("/v1/subscribers/:id/workflows", (c) => c.json({ workflows: [], ui_config: {} }));
  r.get("/v1/subscribers/:id/workflows/:workflow", () => { throw new RCError(404, Codes.NOT_FOUND, "Workflow not found."); });

  restV1(r, deps);
  return r;
}

export { aliasesOf, isAnonymous };
