import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "../src/services/auth.js";
import type { FetchFn } from "../src/stores/apple/api.js";
import { APP_ID, appleHarness, makeP8, type AppleHarness } from "./apple-fixtures.js";
import { API as PLAY_API, env as googleEnv, makeKeys, type Env as GoogleEnv, type Keys } from "./google-helpers.js";
import { KEY as STRIPE_KEY, env as stripeEnv, type Env as StripeEnv } from "./stripe-helpers.js";

/**
 * Import products from the store (prd/catalog/PRD.md "Import from store") against fake App Store Connect, Google Play
 * Developer and Stripe APIs that answer in the shapes those APIs document. No real store is called.
 */
const LIST = "/v2/projects/proj1/apps/{app}/store_products";
const IMPORT = `${LIST}/actions/import`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function call(request: (path: string, init: RequestInit) => Promise<Response>, key: string, method: string, path: string, body?: unknown) {
  const res = await request(path, { method, headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}

// ---- App Store Connect ----------------------------------------------------------------------------------------------

/** A fake App Store Connect: one app, two subscription groups, in-app purchases served two per page through links.next. */
function fakeConnect() {
  const calls: { path: string; auth: string | null }[] = [];
  let mode: "ok" | "401" | "403" | "503" | "foreign-next" = "ok";
  const res = (id: string, type: string, attributes: Record<string, unknown>) => ({ type, id, attributes });
  const groups = [res("20000001", "subscriptionGroups", { referenceName: "Pro" }), res("20000002", "subscriptionGroups", { referenceName: "Family" })];
  const subs: Record<string, unknown[]> = {
    "20000001": [
      res("6500000002", "subscriptions", { name: "Pro Annual", productId: "pro_annual", subscriptionPeriod: "ONE_YEAR", state: "APPROVED", groupLevel: 2 }),
      res("6500000001", "subscriptions", { name: "Pro Monthly", productId: "pro_monthly", subscriptionPeriod: "ONE_MONTH", state: "APPROVED", groupLevel: 1 }),
      res("6500000003", "subscriptions", { name: "Pro Weekly", productId: "pro_weekly", subscriptionPeriod: "ONE_WEEK", state: "READY_TO_SUBMIT", groupLevel: 3 }),
    ],
    "20000002": [res("6500000004", "subscriptions", { name: "Family 6 months", productId: "family_6m", subscriptionPeriod: "SIX_MONTHS", state: "MISSING_METADATA", groupLevel: 1 })],
  };
  const iaps = [
    res("6600000001", "inAppPurchases", { name: "100 coins", productId: "coins_100", inAppPurchaseType: "CONSUMABLE", state: "APPROVED" }),
    res("6600000002", "inAppPurchases", { name: "500 coins", productId: "coins_500", inAppPurchaseType: "CONSUMABLE", state: "APPROVED" }),
    res("6600000003", "inAppPurchases", { name: "Lifetime", productId: "lifetime", inAppPurchaseType: "NON_CONSUMABLE", state: "APPROVED" }),
    res("6600000004", "inAppPurchases", { name: "Season pass", productId: "season_pass", inAppPurchaseType: "NON_RENEWING_SUBSCRIPTION", state: "WAITING_FOR_REVIEW" }),
    res("6600000005", "inAppPurchases", { name: "Remove ads", productId: "remove_ads", inAppPurchaseType: "NON_CONSUMABLE", state: "DEVELOPER_ACTION_NEEDED" }),
  ];
  const fetchFn: FetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host !== "api.appstoreconnect.apple.com") throw new Error(`unexpected fetch ${url}`);
    calls.push({ path: u.pathname + u.search, auth: new Headers(init.headers).get("authorization") });
    if (mode === "401") return json(401, { errors: [{ status: "401", code: "NOT_AUTHORIZED", title: "Authentication credentials are missing or invalid." }] });
    if (mode === "403") return json(403, { errors: [{ status: "403", code: "FORBIDDEN_ERROR", title: "This request is forbidden for security reasons", detail: "The API key in use does not allow this request" }] });
    if (mode === "503") return new Response("", { status: 503 });
    const page = (all: unknown[], size: number) => {
      const cursor = Number(u.searchParams.get("cursor") ?? 0);
      const next = cursor + size < all.length ? (() => { const q = new URLSearchParams(u.search); q.set("cursor", String(cursor + size)); return `https://api.appstoreconnect.apple.com${u.pathname}?${q}`; })() : undefined;
      return json(200, { data: all.slice(cursor, cursor + size), links: { self: url, ...(next ? { next: mode === "foreign-next" ? next.replace("api.appstoreconnect.apple.com", "evil.example.com") : next } : {}) }, meta: { paging: { total: all.length, limit: size } } });
    };
    if (u.pathname === "/v1/apps") return json(200, { data: u.searchParams.get("filter[bundleId]") === "com.example.scanner" ? [res("6400000001", "apps", { bundleId: "com.example.scanner", name: "Scanner" })] : [] });
    if (u.pathname === "/v1/apps/6400000001/subscriptionGroups") return page(groups, 200);
    const g = /^\/v1\/subscriptionGroups\/(\d+)\/subscriptions$/.exec(u.pathname);
    if (g) return page(subs[g[1]!] ?? [], 200);
    if (u.pathname === "/v1/apps/6400000001/inAppPurchasesV2") return page(iaps, 2);
    return json(404, { errors: [{ status: "404", title: "The specified resource does not exist" }] });
  };
  return { fetchFn, calls, setMode: (m: typeof mode) => { mode = m; } };
}

const ascCreds = async () => ({ app_store_connect_api_key: await makeP8(), app_store_connect_api_key_id: "ASCKEY1", app_store_connect_api_key_issuer: "69a6de70-0000-47e3-e053-5b8c7c11a4d1" });

describe("import from App Store Connect", () => {
  let h: AppleHarness | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });

  it("lists subscriptions by group and in-app purchases over every page, marks what the catalog has, imports the chosen ones and attaches them", async () => {
    const asc = fakeConnect();
    h = await appleHarness({ credentials: await ascCreds(), fetch: asc.fetchFn });
    const { key } = await createSecretKey(h.db, "proj1", "catalog");
    const v2 = (method: string, path: string, body?: unknown) => call(h!.request, key, method, path.replace("{app}", APP_ID), body);

    const list = await v2("GET", LIST);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ object: "list", next_page: null, app_id: APP_ID, store: "app_store", warnings: [] });
    const rows = list.body.items.map((i: any) => [i.store_identifier, i.type, i.duration, i.display_name, i.group?.name ?? null, i.in_catalog]);
    expect(rows).toEqual([
      ["pro_monthly", "subscription", "P1M", "Pro Monthly", "Pro", true],
      ["pro_annual", "subscription", "P1Y", "Pro Annual", "Pro", true],
      ["pro_weekly", "subscription", "P1W", "Pro Weekly", "Pro", false],
      ["family_6m", "subscription", "P6M", "Family 6 months", "Family", false],
      ["coins_100", "consumable", null, "100 coins", null, true],
      ["coins_500", "consumable", null, "500 coins", null, false],
      ["lifetime", "non_consumable", null, "Lifetime", null, true],
      ["season_pass", "non_renewing_subscription", null, "Season pass", null, false],
      ["remove_ads", "non_consumable", null, "Remove ads", null, false],
    ]);
    expect(list.body.items[0]).toMatchObject({ object: "store_product_listing", product_id: "p1", store_state: "APPROVED", importable: true });
    // In-app purchases came over three pages (two per page), and every call carried the App Store Connect token.
    expect(asc.calls.filter((c) => c.path.startsWith("/v1/apps/6400000001/inAppPurchasesV2"))).toHaveLength(3);
    const claims = decodeJwt(asc.calls[0]!.auth!.replace("Bearer ", ""));
    expect(claims).toMatchObject({ iss: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", aud: "appstoreconnect-v1" });

    const imported = await v2("POST", IMPORT, { store_identifiers: ["pro_weekly", "family_6m", "coins_500", "season_pass", "pro_monthly", "not_in_store"], entitlement_ids: ["ent_pro"] });
    expect(imported.status).toBe(201);
    expect(imported.body.object).toBe("store_product_import");
    expect(imported.body.created.map((p: any) => [p.store_identifier, p.type, p.subscription?.duration ?? null, p.display_name])).toEqual([
      ["pro_weekly", "subscription", "P1W", "Pro Weekly"],
      ["family_6m", "subscription", "P6M", "Family 6 months"],
      ["coins_500", "consumable", null, "500 coins"],
      ["season_pass", "non_renewing_subscription", null, "Season pass"],
    ]);
    expect(imported.body.existing.map((p: any) => p.id)).toEqual(["p1"]);
    expect(imported.body.failed).toEqual([{ store_identifier: "not_in_store", reason: "not_in_store", message: "not_in_store was not found in the store for this app." }]);
    const attached = await h.db.select().from(schema.entitlementProducts).where(eq(schema.entitlementProducts.entitlementId, "ent_pro"));
    const ids = new Set(attached.map((a) => a.productId));
    for (const p of imported.body.created) expect(ids.has(p.id)).toBe(true);

    // The same import again changes nothing.
    const again = await v2("POST", IMPORT, { store_identifiers: ["pro_weekly", "family_6m", "coins_500", "season_pass", "pro_monthly"], entitlement_ids: ["ent_pro"] });
    expect(again.status).toBe(200);
    expect(again.body.created).toEqual([]);
    expect(again.body.existing).toHaveLength(5);
    expect(await h.db.select().from(schema.products).where(eq(schema.products.appId, APP_ID))).toHaveLength(8);
    expect((await v2("GET", LIST)).body.items.filter((i: any) => !i.in_catalog).map((i: any) => i.store_identifier)).toEqual(["remove_ads"]);

    // The import is in the audit log under the app.
    const [audit] = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actionType, "app_store_products_import"));
    expect(audit).toMatchObject({ targetType: "app", targetIdentifier: APP_ID });
  });

  it("names the missing key and the App Manager role, retries on outages, and refuses a paging link to another host", async () => {
    const asc = fakeConnect();
    h = await appleHarness({ credentials: {}, fetch: asc.fetchFn });
    const { key } = await createSecretKey(h.db, "proj1", "catalog");
    const v2 = (method: string, path: string, body?: unknown) => call(h!.request, key, method, path.replace("{app}", APP_ID), body);

    const missing = await v2("GET", LIST);
    expect(missing).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(missing.body.message).toMatch(/App Store Connect API key/);
    expect(missing.body.message).toMatch(/App Manager/);
    expect(asc.calls).toHaveLength(0);

    await h.db.update(schema.apps).set({ credentials: await ascCreds() }).where(eq(schema.apps.id, APP_ID));
    for (const m of ["401", "403"] as const) {
      asc.setMode(m);
      const refused = await v2("GET", LIST);
      expect(refused).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
      expect(refused.body.message).toMatch(/App Manager role/);
    }
    asc.setMode("503");
    expect(await v2("GET", LIST)).toMatchObject({ status: 422, body: { type: "store_error", retryable: true } });
    expect(await v2("POST", IMPORT, { store_identifiers: ["pro_weekly"] })).toMatchObject({ status: 422, body: { type: "store_error", retryable: true } });
    asc.setMode("foreign-next");
    const before = asc.calls.length;
    const foreign = await v2("GET", LIST);
    expect(foreign).toMatchObject({ status: 422, body: { type: "store_error" } });
    expect(asc.calls.slice(before).every((c) => !c.path.includes("evil"))).toBe(true);
    // Nothing was created by the failed import.
    expect(await h.db.select().from(schema.products).where(eq(schema.products.storeIdentifier, "pro_weekly"))).toHaveLength(0);
  });

  it("validates the request: unknown entitlement, empty list, another project's app, and keys without the permissions", async () => {
    const asc = fakeConnect();
    h = await appleHarness({ credentials: await ascCreds(), fetch: asc.fetchFn });
    const { key } = await createSecretKey(h.db, "proj1", "catalog");
    const v2 = (k: string, method: string, path: string, body?: unknown) => call(h!.request, k, method, path.replace("{app}", APP_ID), body);
    const unknownEnt = await v2(key, "POST", IMPORT, { store_identifiers: ["pro_weekly"], entitlement_ids: ["ent_nope"] });
    expect(unknownEnt).toMatchObject({ status: 400, body: { param: "entitlement_ids" } });
    expect((await v2(key, "POST", IMPORT, { store_identifiers: [] })).status).toBe(400);
    expect((await call(h.request, key, "GET", "/v2/projects/proj1/apps/app_elsewhere/store_products")).status).toBe(404);

    const readOnly = (await createSecretKey(h.db, "proj1", "read", ["project_configuration:products:read"])).key;
    expect((await v2(readOnly, "GET", LIST)).status).toBe(200);
    expect((await v2(readOnly, "POST", IMPORT, { store_identifiers: ["pro_weekly"] })).status).toBe(403);
    const productsOnly = (await createSecretKey(h.db, "proj1", "products", ["project_configuration:products:read_write"])).key;
    const noEnt = await v2(productsOnly, "POST", IMPORT, { store_identifiers: ["pro_weekly"], entitlement_ids: ["ent_pro"] });
    expect(noEnt.status).toBe(403);
    expect(noEnt.body.message).toMatch(/project_configuration:entitlements:read_write/);
    expect((await v2(productsOnly, "POST", IMPORT, { store_identifiers: ["pro_weekly"] })).status).toBe(201);
  });
});

// ---- Google Play ----------------------------------------------------------------------------------------------------

describe("import from Google Play", () => {
  let keys: Keys;
  let e: GoogleEnv | undefined;
  beforeAll(async () => { keys = await makeKeys(); });
  afterEach(async () => { await e?.h.close(); e = undefined; });

  const subscriptions = [
    [
      { packageName: "com.example.scanner", productId: "premium", listings: [{ languageCode: "de-DE", title: "Premium DE" }, { languageCode: "en-US", title: "Premium" }],
        basePlans: [
          { basePlanId: "monthly", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1M", legacyCompatible: true } },
          { basePlanId: "annual", state: "ACTIVE", autoRenewingBasePlanType: { billingPeriodDuration: "P1Y" } },
          { basePlanId: "pass-1m", state: "DRAFT", prepaidBasePlanType: { billingPeriodDuration: "P1M" } },
        ] },
    ],
    [
      { packageName: "com.example.scanner", productId: "no_plans", listings: [{ languageCode: "en-US", title: "Not ready" }], basePlans: [] },
      { packageName: "com.example.scanner", productId: "old", archived: true, basePlans: [{ basePlanId: "m", state: "INACTIVE" }] },
    ],
  ];
  const oneTime = [
    { packageName: "com.example.scanner", productId: "lifetime_unlock", listings: [{ languageCode: "en-US", title: "Lifetime" }], purchaseOptions: [{ purchaseOptionId: "buy", state: "ACTIVE", buyOption: { legacyCompatible: true } }] },
    { packageName: "com.example.scanner", productId: "gems_50", listings: [{ languageCode: "en-GB", title: "50 gems" }], purchaseOptions: [{ purchaseOptionId: "buy", state: "ACTIVE", buyOption: { legacyCompatible: false } }] },
  ];
  /** monetization.subscriptions.list in two pages, and onetimeproducts.list (or 404 and the legacy inappproducts.list). */
  function serve(en: GoogleEnv, o: { oneTime404?: boolean; deny?: boolean } = {}) {
    en.g.override = (url, method) => {
      if (method !== "GET" || !url.startsWith(PLAY_API)) return undefined;
      const u = new URL(url);
      const path = u.pathname.slice(new URL(PLAY_API).pathname.length);
      if (o.deny && (path === "/subscriptions" || path === "/oneTimeProducts")) return json(403, { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED", errors: [{ reason: "permissionDenied" }] } });
      if (path === "/subscriptions") {
        const p = u.searchParams.get("pageToken") === "page-2" ? 1 : 0;
        return json(200, { subscriptions: subscriptions[p], ...(p === 0 ? { nextPageToken: "page-2" } : {}) });
      }
      if (path === "/oneTimeProducts") return o.oneTime404 ? json(404, { error: { code: 404, message: "Method not found.", status: "NOT_FOUND" } }) : json(200, { oneTimeProducts: oneTime });
      if (path === "/inappproducts") {
        return json(200, { kind: "androidpublisher#inappproductsListResponse", inappproduct: [
          { packageName: "com.example.scanner", sku: "coins_100", status: "active", purchaseType: "managedUser", defaultLanguage: "en-US", listings: { "en-US": { title: "100 coins" } } },
          { packageName: "com.example.scanner", sku: "legacy_sub", status: "active", purchaseType: "subscription", defaultLanguage: "en-US", listings: { "en-US": { title: "Legacy" } } },
        ] });
      }
      return undefined;
    };
  }

  it("lists every base plan as subscription:base_plan over every page, and one-time products; imports with the base plan's period", async () => {
    e = await googleEnv(keys);
    serve(e);
    const v2 = (method: string, path: string, body?: unknown) => call((p, i) => e!.call(p, i as any), e!.h.ids.secretKey, method, path.replace("{app}", e!.h.ids.androidApp), body);
    const list = await v2("GET", LIST);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => [i.store_identifier, i.type, i.duration, i.display_name, i.importable, i.in_catalog])).toEqual([
      ["premium:monthly", "subscription", "P1M", "Premium (monthly)", true, true],
      ["premium:annual", "subscription", "P1Y", "Premium (annual)", true, false],
      ["premium:pass-1m", "subscription", "P1M", "Premium (pass-1m)", true, false],
      ["no_plans", "subscription", null, "Not ready", false, false],
      ["lifetime_unlock", "one_time", null, "Lifetime", true, true],
      ["gems_50", "one_time", null, "50 gems", true, false],
    ]);
    expect(list.body.items[2].note).toMatch(/Prepaid/);
    expect(list.body.items[3].note).toMatch(/no base plan/);
    expect(list.body.items[5].note).toMatch(/backwards compatible/);
    // Both subscription pages were read, after an OAuth token for the service account.
    expect(e.g.calls.filter((c) => c.url.includes("/subscriptions?")).map((c) => new URL(c.url).searchParams.get("pageToken"))).toEqual([null, "page-2"]);
    expect(e.g.tokenRequests.length).toBeGreaterThan(0);

    const r = await v2("POST", IMPORT, { store_identifiers: ["premium:annual", "gems_50", "no_plans", "premium:monthly"], entitlement_ids: ["ent_pro"] });
    expect(r.status).toBe(201);
    expect(r.body.created.map((p: any) => [p.store_identifier, p.type, p.subscription?.duration ?? null, p.display_name])).toEqual([
      ["premium:annual", "subscription", "P1Y", "Premium (annual)"],
      ["gems_50", "one_time", null, "50 gems"],
    ]);
    expect(r.body.existing.map((p: any) => p.store_identifier)).toEqual(["premium:monthly"]);
    expect(r.body.failed).toMatchObject([{ store_identifier: "no_plans", reason: "not_importable" }]);
    // The SDK's product-to-entitlement mapping now has the imported base plan.
    const mapping = await (await e.call("/v1/product_entitlement_mapping", { key: e.h.ids.androidKey })).json() as any;
    expect(mapping.product_entitlement_mapping["premium:annual"]).toMatchObject({ entitlements: ["pro"] });
  });

  it("falls back to the legacy in-app products list, and names the Play Console permission when Google refuses", async () => {
    e = await googleEnv(keys);
    serve(e, { oneTime404: true });
    const v2 = (method: string, path: string) => call((p, i) => e!.call(p, i as any), e!.h.ids.secretKey, method, path.replace("{app}", e!.h.ids.androidApp));
    const list = await v2("GET", LIST);
    expect(list.status).toBe(200);
    expect(list.body.items.filter((i: any) => i.type === "one_time").map((i: any) => [i.store_identifier, i.display_name, i.in_catalog])).toEqual([["coins_100", "100 coins", true]]);

    serve(e, { deny: true });
    const denied = await v2("GET", LIST);
    expect(denied).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(denied.body.message).toContain("View app information and download bulk reports (read-only)");

    await e.h.db.update(schema.apps).set({ credentials: {} }).where(eq(schema.apps.id, e.h.ids.androidApp));
    const none = await v2("GET", LIST);
    expect(none.status).toBe(422);
    expect(none.body.message).toMatch(/service account/);
  });
});

// ---- Stripe ---------------------------------------------------------------------------------------------------------

describe("import from Stripe", () => {
  let e: StripeEnv | undefined;
  afterEach(async () => { await e?.h.close(); e = undefined; });

  const product = (id: string, name: string, defaultPrice: string | null = null) => ({ id, object: "product", active: true, name, default_price: defaultPrice, livemode: false });
  const price = (id: string, productId: string, o: { amount?: number | null; currency?: string; interval?: string; count?: number; usage?: string; nickname?: string; scheme?: string } = {}) => ({
    id, object: "price", active: true, product: productId, currency: o.currency ?? "usd", unit_amount: o.amount === undefined ? 999 : o.amount, nickname: o.nickname ?? null,
    billing_scheme: o.scheme ?? "per_unit", type: o.interval ? "recurring" : "one_time",
    recurring: o.interval ? { interval: o.interval, interval_count: o.count ?? 1, usage_type: o.usage ?? "licensed", trial_period_days: null } : null,
  });
  const products = [
    product("prod_ProMonthly", "Pro monthly"),
    product("prod_Pro", "Pro", "price_ProYear"),
    product("prod_Coins", "Coins"),
    product("prod_Api", "API usage"),
    product("prod_Empty", "No price yet"),
    product("prod_Yen", "Yen pack"),
  ];
  const prices = [
    price("price_1PmMonthly", "prod_ProMonthly", { interval: "month" }),
    price("price_ProQuarter", "prod_Pro", { interval: "month", count: 3, amount: 2499 }),
    price("price_ProYear", "prod_Pro", { interval: "year", amount: 7999, nickname: "Annual" }),
    price("price_Coins", "prod_Coins", { amount: 199 }),
    price("price_Api", "prod_Api", { interval: "month", usage: "metered", amount: null }),
    price("price_Yen", "prod_Yen", { amount: 1200, currency: "jpy" }),
  ];
  /** Stripe's list paging: two objects per page, `starting_after`, `has_more`. */
  function serve(en: StripeEnv, o: { forbidden?: boolean } = {}) {
    en.st.override = (url) => {
      const u = new URL(url);
      if (u.pathname !== "/v1/products" && u.pathname !== "/v1/prices") return undefined;
      if (o.forbidden) return json(403, { error: { type: "invalid_request_error", message: `The provided key 'rk_test_****0000' does not have the required permissions for this endpoint on account 'acct_1Test'. Having the 'rak_product_read' permission would allow this request to continue.` } });
      const all = (u.pathname === "/v1/products" ? products : prices) as Array<{ id: string }>;
      const after = u.searchParams.get("starting_after");
      const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
      return json(200, { object: "list", data: all.slice(start, start + 2), has_more: start + 2 < all.length, url: u.pathname });
    };
  }

  it("lists one row per active price (recurring prices as subscriptions), pages through both lists, and imports prices that web billing can sell", async () => {
    e = await stripeEnv();
    serve(e);
    const v2 = (method: string, path: string, body?: unknown) => call((p, i) => e!.call(p, i as any), e!.h.ids.secretKey, method, path.replace("{app}", e!.appId), body);
    const list = await v2("GET", LIST);
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => [i.store_identifier, i.type, i.duration, i.display_name, i.group.id, i.importable, i.in_catalog, i.product_id])).toEqual([
      ["price_1PmMonthly", "subscription", "P1M", "Pro monthly", "prod_ProMonthly", true, true, "st_m"],
      ["price_ProYear", "subscription", "P1Y", "Pro (Annual)", "prod_Pro", true, false, null],
      ["price_ProQuarter", "subscription", "P3M", "Pro (every 3 months)", "prod_Pro", true, false, null],
      ["price_Coins", "non_consumable", null, "Coins", "prod_Coins", true, true, "st_coins"],
      ["price_Api", "subscription", "P1M", "API usage", "prod_Api", false, false, null],
      ["prod_Empty", "non_consumable", null, "No price yet", "prod_Empty", false, false, null],
      ["price_Yen", "non_consumable", null, "Yen pack", "prod_Yen", true, false, null],
    ]);
    expect(list.body.items[1].price).toEqual({ amount_micros: 79_990_000, currency: "USD" });
    expect(list.body.items[6].price).toEqual({ amount_micros: 1_200_000_000, currency: "JPY" });
    expect(list.body.items[4].note).toMatch(/Metered/);
    expect(list.body.items.some((i: any) => "stripe" in i)).toBe(false);
    // Three pages of each list, with the restricted key, through the outbound guard (redirects never followed).
    const listCalls = e.st.calls.filter((c) => /\/v1\/(products|prices)\?/.test(c.url));
    expect(listCalls).toHaveLength(6);
    expect(listCalls.every((c) => c.auth === `Bearer ${STRIPE_KEY}` && c.redirect === "manual" && c.method === "GET")).toBe(true);
    expect(new URL(listCalls[1]!.url).searchParams.get("starting_after")).toBe("prod_Pro");

    const r = await v2("POST", IMPORT, { store_identifiers: ["price_ProYear", "price_ProQuarter", "price_Yen", "price_Api", "price_Coins"] });
    expect(r.status).toBe(201);
    expect(r.body.created.map((p: any) => [p.store_identifier, p.type, p.subscription?.duration ?? null])).toEqual([
      ["price_ProYear", "subscription", "P1Y"], ["price_ProQuarter", "subscription", "P3M"], ["price_Yen", "non_consumable", null],
    ]);
    expect(r.body.existing.map((p: any) => p.id)).toEqual(["st_coins"]);
    expect(r.body.failed).toMatchObject([{ store_identifier: "price_Api", reason: "not_importable" }]);
    // Flat-rate prices became web products, so the web checkout can sell them.
    const web = await e.h.db.select().from(schema.webProducts).where(eq(schema.webProducts.appId, e.appId));
    expect(web.map((w) => [w.stripePriceId, w.stripeProductId, w.amountMinor, w.currency, w.interval, w.intervalCount]).sort()).toEqual([
      ["price_ProQuarter", "prod_Pro", 2499, "usd", "month", 3], ["price_ProYear", "prod_Pro", 7999, "usd", "year", 1], ["price_Yen", "prod_Yen", 1200, "jpy", null, null],
    ]);
  });

  it("names the Products permission when the restricted key lacks it, and asks for a key when there is none", async () => {
    e = await stripeEnv();
    serve(e, { forbidden: true });
    const v2 = (path: string) => call((p, i) => e!.call(p, i as any), e!.h.ids.secretKey, "GET", path.replace("{app}", e!.appId));
    const denied = await v2(LIST);
    expect(denied).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(denied.body.message).toMatch(/"Products" permission set to Read/);
    expect(denied.body.message).not.toContain(STRIPE_KEY);
    await e.setCredentials({});
    const none = await v2(LIST);
    expect(none.status).toBe(422);
    expect(none.body.message).toMatch(/restricted key/);
  });
});

// ---- Stores without a product API -----------------------------------------------------------------------------------

describe("stores without a product list", () => {
  it("Amazon and the Test Store answer 422 with the reason", async () => {
    const asc = fakeConnect();
    const h = await appleHarness({ credentials: {}, fetch: asc.fetchFn });
    try {
      await h.db.insert(schema.apps).values([
        { id: "app_amzn", projectId: "proj1", name: "Scanner Fire", type: "amazon", bundleId: "com.example.scanner", publicKey: "amzn_key1" },
        { id: "app_ts", projectId: "proj1", name: "Test Store", type: "test_store", publicKey: "test_key1" },
      ]);
      const { key } = await createSecretKey(h.db, "proj1", "catalog");
      const amazon = await call(h.request, key, "GET", "/v2/projects/proj1/apps/app_amzn/store_products");
      expect(amazon).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
      expect(amazon.body.message).toMatch(/Amazon has no API/);
      const importAmazon = await call(h.request, key, "POST", "/v2/projects/proj1/apps/app_amzn/store_products/actions/import", { store_identifiers: ["sku_1"] });
      expect(importAmazon.status).toBe(422);
      const ts = await call(h.request, key, "GET", "/v2/projects/proj1/apps/app_ts/store_products");
      expect(ts.status).toBe(422);
      expect(ts.body.message).toMatch(/Test Store/);
      expect(await h.db.select().from(schema.products).where(and(eq(schema.products.appId, "app_amzn")))).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});
