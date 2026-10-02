import { Hono } from "hono";
import { buildCustomerInfo, isAnonymous, newId } from "@revenuedot/core";
import { Codes, RCError, errorResponse } from "../errors.js";
import type { Deps, Vars } from "../context.js";
import { entitlementMap, offeringsJSON, productEntitlementMappingJSON, productInfo } from "../repo/catalog.js";
import { findCustomer, getOrCreateCustomer, identify, loadState, setAttributes, touch, aliasesOf } from "../repo/customers.js";
import { applyPurchases } from "../services/purchases.js";
import { recordSubscriberAlias } from "../services/events.js";
import { restV1 } from "./rest-v1.js";
import { appForPlatform, isSubscriberToken, resolveKey } from "../services/auth.js";
import type { ReceiptInput } from "../stores/types.js";
import { schema } from "@revenuedot/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { recordSdkVersion, sdkHeaders } from "../services/sdk-versions.js";
import { attributionDataToAttributes, inBackground, resolveAdServicesToken, resolveDeviceAttributes, setAttributionOnce } from "../services/attribution.js";
import { appleCredentials } from "../stores/apple/api.js";
import { alpha2 } from "../stores/apple/map.js";
import { appAccountTokenFor, signOffer } from "../services/promo-offers.js";
import { customerCenterFor } from "../services/customer-center.js";
import { publicOrigin } from "./oauth.js";
import { buildRemoteConfig } from "../services/remote-config.js";
import { activeEntitlementKeys, contextFor, resolveOfferings } from "../services/targeting.js";
import { balancesOf } from "../services/virtual-currencies.js";
import { amazonClientFor, amazonReceiptData } from "../stores/amazon/index.js";
import { mergeStoredState, rowPrice, subRowOf } from "../stores/rows.js";
import { withStoreSecrets } from "../services/store-secrets.js";
import { MAX_BODY_BYTES, storeSdkEvents } from "../services/sdk-events.js";
import { CheckoutError, redeemWebPurchase, startCheckout } from "../services/web/checkout.js";
import { domainOf, mailPayBase, payBaseOf } from "../services/web/domains.js";
import { offeringByKey, webPackages } from "../services/web/catalog.js";
import { stripeAppsOf } from "../services/web/config.js";
import { createTicket, type TicketInput } from "../services/support.js";
import { clientIp } from "../services/rate-limit.js";
import { pollReward } from "../services/ads/rewards.js";

const TICKET_BODY_BYTES = 32_000;

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
    const auth = await resolveKey(deps.db, key, deps.now());
    // An unknown or revoked access token is "invalid auth token", so an SDK in token mode refreshes or signs in again.
    if (!auth && isSubscriberToken(key)) throw new RCError(401, Codes.INVALID_AUTH_TOKEN, "The access token is not valid. Sign in again.");
    if (!auth) throw new RCError(401, Codes.INVALID_API_KEY, "Invalid API Key.");
    if (auth.subscriber) await pinSubscriber(c, auth.subscriber);
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

  /**
   * A subscriber token (`rdat_`) speaks for one app user id: an expired token, or a path or body naming another app user
   * id, is the SDK's "invalid auth token" (7224). The `/v1/customer/*` paths name no user and are served below.
   * Ids are compared the way the routes read them: a path segment is decoded twice (Hono, then `userId`), a body id once.
   */
  const USERLESS_POSTS = new Set(["/v1/subscribers/identify", "/v1/subscribers/redeem_purchase", "/v1/customercenter/support/create-ticket"]);
  const BODY_USER_POSTS = new Set(["/v1/receipts", "/v1/subscribers/identify", "/v1/subscribers/redeem_purchase", "/v1/offers"]);
  async function pinSubscriber(c: any, sub: { appUserId: string; expired: boolean }) {
    const refuse = (m: string) => new RCError(401, Codes.INVALID_AUTH_TOKEN, m);
    if (sub.expired) throw refuse("The access token has expired. Ask your server for a new one.");
    const other = () => refuse("The access token belongs to another app user id.");
    const path: string = c.req.path;
    const post = c.req.method === "POST";
    const m = /^\/(?:rcbilling\/)?v1\/(?:subscribers|customercenter)\/([^/]+)/.exec(path);
    if (m && !(post && USERLESS_POSTS.has(path)) && safeDecode(safeDecode(m[1]!)) !== sub.appUserId) throw other();
    const alias = /^\/v1\/subscribers\/[^/]+\/alias$/.test(path);
    if (post && (BODY_USER_POSTS.has(path) || alias)) {
      const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      // identify and alias would merge, or answer for, the customer named by new_app_user_id.
      for (const k of ["app_user_id", "new_app_user_id"]) if (b?.[k] !== undefined && safeDecode(String(b[k])) !== sub.appUserId) throw other();
    }
  }

  /** The SDKs' subscriber-token paths (IAM mode) and the route that serves each, for the token's app user id. */
  const IAM_PATHS: [RegExp, (user: string, m: RegExpExecArray) => string][] = [
    [/^\/v1\/customer$/, (u) => `/v1/subscribers/${u}`],
    [/^\/v1\/customer\/customercenter$/, (u) => `/v1/customercenter/${u}`],
    [/^\/v1\/customer\/customercenter\/support\/create-ticket$/, () => "/v1/customercenter/support/create-ticket"],
    [/^\/v1\/customer\/(offerings|intro_eligibility|attribution|attributes|adservices_attribution|health_report|virtual_currencies|restore\/eligibility|ads\/reward_verifications\/[^/]+)$/, (u, m) => `/v1/subscribers/${u}/${m[1]}`],
    [/^\/rcbilling\/v1\/customer\/(offering_products|products)$/, (u, m) => `/rcbilling/v1/subscribers/${u}/${m[1]}`],
  ];
  const subscriberOf = (c: any): string => {
    const sub = c.get("auth")?.subscriber as { appUserId: string } | undefined;
    if (!sub) throw new RCError(401, Codes.INVALID_AUTH_TOKEN, "This path needs a subscriber access token (from POST /v2/projects/{project_id}/apps/{app_id}/authenticate), not an app API key.");
    return sub.appUserId;
  };

  // IAM 41. Spend in-app currency as the subscriber: all adjustments or none, never below zero, once per Idempotency-Key.
  r.post("/v1/customer/virtual_currencies/spend", async (c) => {
    const appUserId = subscriberOf(c);
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => null) as { adjustments?: unknown; reference?: unknown } | null;
    const adj = b?.adjustments;
    if (!adj || typeof adj !== "object" || Array.isArray(adj) || !Object.keys(adj).length || Object.values(adj).some((v) => !Number.isInteger(v) || (v as number) <= 0 || (v as number) > 2_147_483_647)) {
      throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "adjustments must map currency codes to positive whole amounts to spend.");
    }
    const amounts = Object.entries(adj as Record<string, number>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const { customer } = await getOrCreateCustomer(deps.db, app.projectId, appUserId, now);
    const key = c.req.header("idempotency-key");
    const sourceKey = key ? `sdk:${key.slice(0, 200)}` : null;
    const have = new Map((await balancesOf(deps.db, app.projectId, customer.id, { includeEmpty: true })).map((x) => [x.code, x.balance]));
    for (const [code] of amounts) if (!have.has(code)) throw new RCError(400, Codes.BAD_REQUEST_PARAMS, `There is no in-app currency with code ${code}.`);
    const reference = typeof b!.reference === "string" ? b!.reference.slice(0, 255) : null;
    // One transaction: every currency is spent or none. A conditional decrement keeps concurrent spends from taking a
    // balance below zero; the ledger's unique source key makes a retry with the same Idempotency-Key spend nothing again.
    await deps.db.transaction(async (tx) => {
      for (const [code, amount] of amounts) {
        const entry = await tx.insert(schema.virtualCurrencyTransactions).values({
          id: newId("vct_", 16), projectId: app.projectId, customerId: customer.id, code, amount: -amount, source: "sdk", sourceKey, reference, createdAt: now,
        }).onConflictDoNothing().returning({ id: schema.virtualCurrencyTransactions.id });
        if (!entry.length) continue;
        const spent = await tx.update(schema.virtualCurrencyBalances).set({ balance: sql`${schema.virtualCurrencyBalances.balance} - ${amount}` })
          .where(and(eq(schema.virtualCurrencyBalances.customerId, customer.id), eq(schema.virtualCurrencyBalances.code, code), gte(schema.virtualCurrencyBalances.balance, amount)))
          .returning({ balance: schema.virtualCurrencyBalances.balance });
        if (!spent.length) throw new RCError(422, Codes.BAD_REQUEST, `Balance of ${code} is ${have.get(code)}; spending ${amount} would take it below zero.`);
      }
    });
    const out: Record<string, { balance: number; name: string; code: string; description: string | null }> = {};
    for (const x of await balancesOf(deps.db, app.projectId, customer.id, { includeEmpty: true })) out[x.code] = { balance: x.balance, name: x.name, code: x.code, description: x.description };
    return c.json({ virtual_currencies: out });
  });

  // IAM 42-55. Served by the matching /v1/subscribers/{app_user_id} route, for the token's app user id.
  const iam = async (c: any) => {
    const appUserId = subscriberOf(c);
    const url = new URL(c.req.url);
    const hit = IAM_PATHS.map(([re, to]) => [re.exec(url.pathname), to] as const).find(([m]) => m);
    if (!hit) throw new RCError(404, Codes.NOT_FOUND, "Unknown subscriber path.");
    url.pathname = hit[1](encodeURIComponent(appUserId), hit[0]!);
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
    return r.fetch(new Request(url, { method, headers: c.req.raw.headers, body }));
  };
  r.get("/v1/customer", iam);
  r.get("/v1/customer/offerings", iam);
  r.post("/v1/customer/intro_eligibility", iam);
  r.post("/v1/customer/attribution", iam);
  r.post("/v1/customer/attributes", iam);
  r.get("/v1/customer/attributes", iam);
  r.post("/v1/customer/adservices_attribution", iam);
  r.get("/v1/customer/health_report", iam);
  r.get("/v1/customer/customercenter", iam);
  r.post("/v1/customer/customercenter/support/create-ticket", iam);
  r.get("/v1/customer/virtual_currencies", iam);
  r.post("/v1/customer/restore/eligibility", iam);
  r.get("/v1/customer/ads/reward_verifications/:client_transaction_id", iam);
  r.get("/rcbilling/v1/customer/offering_products", iam);
  r.get("/rcbilling/v1/customer/products", iam);

  const reqInfo = (c: { req: { header: (k: string) => string | undefined } }) => {
    const s = sdkHeaders(c.req);
    return {
      // The App Store storefront is alpha-3 (USA); customers keep alpha-2 (US), as RevenueCat and the importer store it.
      appVersion: s.appVersion, platform: s.platform, country: alpha2(c.req.header("x-storefront")),
      sdkVersion: s.sdkVersion, sdkFlavor: s.platformFlavor, platformVersion: s.platformVersion, appBuild: s.appBuild,
    };
  };

  // Payment recovery links in customer info (management_url) point at the API origin apps call.
  const recoveryBase = (c: Parameters<typeof publicOrigin>[0]) => deps.apiUrl ?? publicOrigin(c);
  async function customerInfoFor(projectId: string, appUserId: string, now: Date, includeAttributes: boolean, base?: string) {
    const { customer, created } = await getOrCreateCustomer(deps.db, projectId, appUserId, now);
    const state = await loadState(deps.db, customer, { recoveryBase: base });
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
    const { customer, created, body } = await customerInfoFor(app.projectId, userId(c.req.param("id")), now, isSecret(c), recoveryBase(c));
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
      // The Roku SDK posts a formatted price ("$4.99") and no currency; Roku's own price is used for it.
      price: b.price !== undefined && b.price !== null && Number.isFinite(Number(b.price)) ? Number(b.price) : null, currency: b.currency ?? null,
      storeCountry: b.store_country ?? null, normalDuration: b.normal_duration ?? null, isRestore: !!b.is_restore,
      isSandboxHeader: c.req.header("x-is-sandbox") === "true", storeUserId: b.store_user_id ?? null,
      trialDuration: typeof b.trial_duration === "string" ? b.trial_duration : null, introDuration: typeof b.intro_duration === "string" ? b.intro_duration : null,
    };
    let { customer, created } = await getOrCreateCustomer(deps.db, app.projectId, appUserId, now);
    if (b.attributes) await setAttributes(deps.db, customer.id, resolveDeviceAttributes(b.attributes, c), now, { attributionOnce: true });
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
    // Amazon and Stripe keys are sealed; the adapter gets them in memory only.
    const storeApp = await withStoreSecrets(deps, app);
    const verified = input.fetchToken ? await adapter.verify(storeApp, input, await productInfo(deps.db, app.id), {
      storedPeriod: async (store, storeKey) => {
        const row = await subRowOf(deps.db, app.projectId, store, storeKey);
        return row ? { storeTransactionId: row.storeTransactionId, purchaseDate: row.purchaseDate, price: rowPrice(row) } : null;
      },
    }) : [];
    // A re-posted Amazon or Stripe purchase keeps what notifications recorded (a refund, the first billing issue), like a re-read in a notification.
    const purchases = await mergeStoredState(deps.db, app.projectId, verified, now);
    customer = await applyPurchases(deps.db, customer, purchases, {
      projectId: app.projectId, appId: app.id, appUserId, now, presentedOfferingId: b.presented_offering_identifier ?? null, fromDevice: true, fetch: deps.fetch,
      // A customer this receipt creates (a restore on a new install, a server-side post) was first seen at its earliest purchase.
      customerCreated: created,
    });
    await touch(deps.db, customer.id, now, reqInfo(c));
    deps.kick?.();
    const state = await loadState(deps.db, customer, { recoveryBase: recoveryBase(c) });
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

  /** SUBSCRIBER_ALIAS for a logIn or alias call that gave an existing customer a new app user id. */
  const aliasEvent = async (c: any, customerId: string, appUserId: string, now: Date) => {
    const app = c.get("app");
    await recordSubscriberAlias(deps.db, { projectId: app.projectId, appId: app.id ?? null, customerId, appUserId, sandbox: c.req.header("x-is-sandbox") === "true", now });
    deps.kick?.();
  };

  // 4. logIn. 201 when the user is new, 200 when it existed.
  r.post("/v1/subscribers/identify", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const oldId = userId(String(b.app_user_id ?? ""));
    const newAppUserId = userId(String(b.new_app_user_id ?? ""));
    const { customer, created, aliased } = await identify(deps.db, app.projectId, oldId, newAppUserId, now);
    if (aliased) await aliasEvent(c, customer.id, newAppUserId, now);
    await touch(deps.db, customer.id, now, reqInfo(c));
    const state = await loadState(deps.db, customer, { recoveryBase: recoveryBase(c) });
    return c.json(buildCustomerInfo(state, await entitlementMap(deps.db, app.projectId), now), created ? 201 : 200);
  });

  // 5. Alias (Android Block Store recovery). Same merge rules as logIn.
  r.post("/v1/subscribers/:id/alias", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const newAppUserId = userId(String(b.new_app_user_id ?? ""));
    const { customer, aliased } = await identify(deps.db, app.projectId, userId(c.req.param("id")), newAppUserId, now);
    if (aliased) await aliasEvent(c, customer.id, newAppUserId, now);
    return c.json({});
  });

  // 6. Attributes
  // Auth (prd/auth §6): the attributes the SDK set, read back by the app with its access token (or by a server with a
  // secret key). A plain public key cannot read them: attributes can hold an email address or a phone number.
  r.get("/v1/subscribers/:id/attributes", async (c) => {
    const auth = c.get("auth");
    if (auth.kind !== "secret" && !auth.subscriber) throw new RCError(401, Codes.INVALID_AUTH_TOKEN, "Reading attributes needs a subscriber access token or a secret key.");
    const app = c.get("app");
    const cust = await findCustomer(deps.db, app.projectId, userId(c.req.param("id")));
    const out: Record<string, { value: string | null; updated_at_ms: number }> = {};
    if (cust) for (const a of await deps.db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.customerId, cust.id))) out[a.key] = { value: a.value, updated_at_ms: a.updatedAtMs };
    return c.json({ subscriber_attributes: out });
  });

  r.post("/v1/subscribers/:id/attributes", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const { customer } = await getOrCreateCustomer(deps.db, app.projectId, userId(c.req.param("id")), now);
    const attrs = resolveDeviceAttributes(b.attributes ?? {}, c);
    const errors = Object.keys(attrs).filter((k) => k === "$email" && attrs[k]?.value && !/^\S+@\S+\.\S+$/.test(String(attrs[k].value)))
      .map((k) => ({ key_name: k, message: "Email address is not a valid email." }));
    await setAttributes(deps.db, customer.id, Object.fromEntries(Object.entries(attrs).filter(([k]) => !errors.some((e) => e.key_name === k))) as any, now, { attributionOnce: true });
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
  r.get("/v1/product_entitlement_mapping", async (c) => c.json(await productEntitlementMappingJSON(deps.db, c.get("app").projectId, c.get("app").id ?? null)));

  // 15-16. Customer Center: the project's configuration in the customer's language (prd/customer-center/PRD.md).
  r.get("/v1/customercenter/:id", async (c) => c.json({ customer_center: await customerCenterFor(deps.db, c.get("app").projectId, { preferredLocales: c.req.header("x-preferred-locales") ?? null }) }));
  // Customer Center tickets (body: app_user_id, customer_email, issue_description): stored, emailed to the support address,
  // listed under Lifecycle > Support (services/support.ts).
  r.post("/v1/customercenter/support/create-ticket", async (c) => {
    const app = c.get("app");
    // A ticket is a few kilobytes; a larger body is not read.
    const text = Number(c.req.header("content-length") ?? 0) <= TICKET_BODY_BYTES ? await c.req.text().catch(() => "") : "";
    let b: TicketInput = {};
    if (text.length <= TICKET_BODY_BYTES) { try { b = (JSON.parse(text) ?? {}) as TicketInput; } catch { /* sent: false below */ } }
    if (typeof b !== "object" || Array.isArray(b)) b = {};
    // A subscriber token speaks for its own app user id only.
    const sub = c.get("auth")?.subscriber as { appUserId: string } | undefined;
    if (sub) b.app_user_id = sub.appUserId;
    return c.json(await createTicket(deps, { id: app.id ?? null, projectId: app.projectId, name: app.name ?? null }, b, publicOrigin(c), clientIp((n) => c.req.header(n), c.env)));
  });

  // 17-18. Virtual currencies (Tier 2): empty balances.
  r.get("/v1/subscribers/:id/virtual_currencies", async (c) => {
    const projectId = c.get("app").projectId;
    const cust = await findCustomer(deps.db, projectId, decodeURIComponent(c.req.param("id")));
    const out: Record<string, { balance: number; name: string; code: string; description: string | null }> = {};
    if (cust) for (const b of await balancesOf(deps.db, projectId, cust.id, { includeEmpty: true })) out[b.code] = { balance: b.balance, name: b.name, code: b.code, description: b.description };
    return c.json({ virtual_currencies: out });
  });

  // 19. Web purchase redemption (prd/web-billing/PRD.md §4): the redemption link's token attaches an anonymous web purchase
  // to this app user. 7849 invalid token, 7852 redeemed by someone else, 7853 expired (a new link is emailed).
  r.post("/v1/subscribers/redeem_purchase", async (c) => {
    const app = c.get("app"); const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const appUserId = userId(String(b.app_user_id ?? ""));
    const token = typeof b.redemption_token === "string" ? b.redemption_token.trim() : "";
    const owner = await redeemWebPurchase(deps, app, { appUserId, token, platform: c.req.header("x-platform") ?? null, payBase: mailPayBase(deps, publicOrigin(c)) });
    await touch(deps.db, owner.id, now, reqInfo(c));
    const { body } = await customerInfoFor(app.projectId, appUserId, now, isSecret(c), recoveryBase(c));
    return c.json(body);
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

  // 22. Ad reward verification (prd/ads/PRD.md): "pending" until the ad network's server-side callback is recorded
  // (GET /v1/ads/admob/ssv), then "verified" with the rewards the project's rules granted, or "failed".
  r.get("/v1/subscribers/:id/ads/reward_verifications/:tx", async (c) =>
    c.json(await pollReward(deps.db, c.get("app").projectId, safeDecode(c.req.param("id")), safeDecode(c.req.param("tx")).slice(0, 128))));

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
    return c.json(await amazonReceiptData(client, await withStoreSecrets(deps, app), storeUserId, receiptId));
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
        // A subscriber token records events for its own app user id only.
        const sub = c.get("auth").subscriber;
        if (sub && body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)) {
          const b = body as { events: Array<{ app_user_id?: unknown } | null> };
          b.events = b.events.filter((ev) => ev?.app_user_id === sub.appUserId);
        }
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

  // iOS paywall web checkout (prd/web-billing/PRD.md §2): a Stripe Checkout for the package's web product, bought for this
  // app user id. The SDK shows checkout_url and closes it when the browser reaches success_url or cancel_url (origin and path).
  r.post("/rcbilling/v1/hosted-checkout", async (c) => {
    const app = c.get("app");
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const appUserId = userId(String(b.app_user_id ?? ""));
    const offering = await offeringByKey(deps.db, app.projectId, typeof b.presented_offering_identifier === "string" ? b.presented_offering_identifier : null);
    if (!offering || typeof b.package_id !== "string") throw new RCError(400, Codes.INVALID_PLATFORM, "Web checkout needs the package and its offering.");
    let stripe = null;
    for (const s of await stripeAppsOf(deps.db, app.projectId)) {
      if ((await webPackages(deps.db, app.projectId, s.id, offering.id)).some((p) => p.key === b.package_id)) { stripe = s; break; }
    }
    if (!stripe) throw new RCError(400, Codes.INVALID_PLATFORM, "This package has no web product, so it cannot be bought on the web.");
    const d = await domainOf(deps.db, app.projectId, deps.now());
    const root = `${payBaseOf(deps.payUrl, publicOrigin(c))}/${d.slug}/_`;
    try {
      const out = await startCheckout(deps, { app: stripe, offering, packageKey: b.package_id, appUserId, source: { type: "sdk", id: null }, pageUrl: root, cancelUrl: `${root}/cancel` });
      return c.json({ operation_session_id: out.checkout.id, checkout_url: out.url, success_url: `${root}/success`, cancel_url: `${root}/cancel` });
    } catch (e) {
      if (e instanceof CheckoutError) throw new RCError(e.status === 503 ? 503 : 400, e.status === 503 ? Codes.STORE_PROBLEM : Codes.INVALID_PLATFORM, e.message);
      throw e;
    }
  });
  // purchases-js Web Billing (rcb_ keys, Stripe Elements inside the SDK) is not available: RevenueDot's checkout is a hosted
  // page. The SDK shows its purchase error.
  const noCheckout = () => { throw new RCError(400, Codes.INVALID_PLATFORM, "Web Billing checkout inside the SDK is not available on RevenueDot. Use a purchase link or the hosted checkout."); };
  const noSession = () => { throw new RCError(400, Codes.INVALID_OPERATION_SESSION, "There is no such checkout session."); };
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
