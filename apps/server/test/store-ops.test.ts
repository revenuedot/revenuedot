import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "../src/services/auth.js";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import type { FetchFn } from "../src/stores/apple/api.js";
import { loadSpec } from "../../../packages/contract/src/openapi.js";
import { DAY, T0, appleHarness, makeP8, makePki, mockAppleApi, renewalInfo, signJws, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";
import { env, makeKeys, sub, type Env, type Keys } from "./google-helpers.js";

/**
 * restore_purchase_by_order_id and create_in_store against fake stores (Google Play Developer API, App Store Server API,
 * App Store Connect API). Every v2 answer is validated against RevenueCat's schema when the spec is on disk.
 */
const spec = loadSpec();
const RESTORE = "/v2/projects/{project_id}/customers/{customer_id}/actions/restore_purchase_by_order_id";
const CREATE = "/v2/projects/{project_id}/products/{product_id}/create_in_store";

async function v2(fetcher: (path: string, init: RequestInit) => Promise<Response>, key: string, method: string, tmpl: string, params: Record<string, string>, json?: unknown) {
  const path = tmpl.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? "proj1"));
  const res = await fetcher(path, { method, headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
  const body = await res.json() as any;
  if (spec) expect(spec.check(method, tmpl, res.status, body), `${method} ${tmpl} ${res.status}: ${JSON.stringify(body).slice(0, 500)}`).toBeNull();
  return { status: res.status, body };
}

describe("restore a Google Play purchase by order id", () => {
  let keys: Keys;
  let e: Env | undefined;
  beforeAll(async () => { keys = await makeKeys(); });
  afterEach(async () => { await e?.h.close(); e = undefined; });

  const call = (en: Env, method: string, tmpl: string, params: Record<string, string>, json?: unknown) =>
    v2((p, i) => en.call(p, i as any), en.h.ids.secretKey, method, tmpl, params, json);

  it("finds the purchase token with orders.batchGet, verifies it, and gives the subscription to the customer", async () => {
    e = await env(keys);
    const now = e.h.now();
    e.g.subs.set("tok_restore", sub({ start: new Date(now.getTime() - 3 * DAY), expiry: new Date(now.getTime() + 27 * DAY), order: "GPA.1111-2222-3333-44444", offerId: "intro-offer" }));
    e.g.orders.set("GPA.1111-2222-3333-44444", "tok_restore");
    e.g.orderLines.set("GPA.1111-2222-3333-44444", [{ productId: "pro", subscriptionDetails: { basePlanId: "monthly" } }]);
    await call(e, "POST", "/v2/projects/{project_id}/customers", {}, { id: "support_case" });

    const r = await call(e, "POST", RESTORE, { customer_id: "support_case" }, { order_id: "GPA.1111-2222-3333-44444" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "customer", id: "support_case" });
    expect(r.body.active_entitlements.items.map((x: any) => x.entitlement_id)).toEqual(["ent_pro"]);
    const [row] = await e.h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.storeKey, "tok_restore"));
    expect(row).toMatchObject({ store: "play_store", productIdentifier: "pro", productPlanIdentifier: "monthly", storeTransactionId: "GPA.1111-2222-3333-44444" });
    expect((await e.events("INITIAL_PURCHASE")).map((x) => x.app_user_id)).toEqual(["support_case"]);
    // The purchase was acknowledged, as a receipt post does.
    expect(e.g.acks("tok_restore")).toHaveLength(1);
    // Restoring again changes nothing.
    expect((await call(e, "POST", RESTORE, { customer_id: "support_case" }, { order_id: "GPA.1111-2222-3333-44444" })).status).toBe(200);
    expect(await e.events("INITIAL_PURCHASE")).toHaveLength(1);
  });

  it("restores a one-time product from the order's line item, and a renewal order id finds the same purchase", async () => {
    e = await env(keys);
    e.g.products.set("lifetime_unlock|tok_life", { purchaseTimeMillis: String(e.h.now().getTime() - DAY), purchaseState: 0, consumptionState: 0, orderId: "GPA.5555-6666-7777-88888", acknowledgementState: 1, regionCode: "DE" });
    e.g.orders.set("GPA.5555-6666-7777-88888", "tok_life");
    e.g.orderLines.set("GPA.5555-6666-7777-88888", [{ productId: "lifetime_unlock", oneTimePurchaseDetails: { quantity: 1 } }]);
    await call(e, "POST", "/v2/projects/{project_id}/customers", {}, { id: "collector" });
    const r = await call(e, "POST", RESTORE, { customer_id: "collector" }, { order_id: "GPA.5555-6666-7777-88888" });
    expect(r.status).toBe(200);
    const [p] = await e.h.db.select().from(schema.nonSubscriptions).where(eq(schema.nonSubscriptions.storeTransactionId, "GPA.5555-6666-7777-88888"));
    expect(p).toMatchObject({ productIdentifier: "lifetime_unlock", countryCode: "DE" });
    expect((await e.events("NON_RENEWING_PURCHASE")).map((x) => x.app_user_id)).toEqual(["collector"]);

    const now = e.h.now();
    e.g.subs.set("tok_renewed", sub({ start: new Date(now.getTime() - 40 * DAY), expiry: new Date(now.getTime() + 20 * DAY), order: "GPA.9999-0000-1111-22222..0" }));
    e.g.orders.set("GPA.9999-0000-1111-22222..0", "tok_renewed");
    expect((await call(e, "POST", RESTORE, { customer_id: "collector" }, { order_id: "GPA.9999-0000-1111-22222..0" })).status).toBe(200);
    const [renewed] = await e.h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.storeKey, "tok_renewed"));
    expect(renewed!.originalTransactionId).toBe("GPA.9999-0000-1111-22222");
  });

  it("moves a purchase owned by another customer under the transfer behaviour (TRANSFER), and 409 when the project keeps purchases with their owner", async () => {
    e = await env(keys);
    const now = e.h.now();
    e.g.subs.set("tok_owned", sub({ start: now, expiry: new Date(now.getTime() + 30 * DAY), order: "GPA.4444-3333-2222-11111" }));
    e.g.orders.set("GPA.4444-3333-2222-11111", "tok_owned");
    expect((await e.receipt({ app_user_id: "first_owner", fetch_token: "tok_owned", product_ids: ["pro"], platform_product_ids: [{ product_id: "pro", base_plan_id: "monthly" }] })).status).toBe(200);
    await call(e, "POST", "/v2/projects/{project_id}/customers", {}, { id: "new_owner" });
    await call(e, "POST", "/v2/projects/{project_id}/customers", {}, { id: "third" });

    expect((await call(e, "POST", RESTORE, { customer_id: "new_owner" }, { order_id: "GPA.4444-3333-2222-11111" })).status).toBe(200);
    expect(await e.events("TRANSFER")).toMatchObject([{ transferred_from: ["first_owner"], transferred_to: ["new_owner"] }]);

    await e.h.db.update(schema.projects).set({ transferBehavior: "keep" });
    const kept = await call(e, "POST", RESTORE, { customer_id: "third" }, { order_id: "GPA.4444-3333-2222-11111" });
    expect(kept.status).toBe(409);
    expect(kept.body).toMatchObject({ type: "resource_already_exists", param: "order_id" });
  });

  it("404 for an order Google does not know, 422 store_error (retryable) while Google is down, 422 when Google refuses the service account", async () => {
    e = await env(keys);
    await call(e, "POST", "/v2/projects/{project_id}/customers", {}, { id: "c1" });
    const missing = await call(e, "POST", RESTORE, { customer_id: "c1" }, { order_id: "GPA.0000-0000-0000-00000" });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ type: "resource_missing", param: "order_id" });

    e.g.override = (url) => (url.includes("orders:batchGet") ? new Response("{}", { status: 503 }) : undefined);
    const down = await call(e, "POST", RESTORE, { customer_id: "c1" }, { order_id: "GPA.0000-0000-0000-00001" });
    expect(down.status).toBe(422);
    expect(down.body).toMatchObject({ type: "store_error", retryable: true });

    e.g.override = (url) => (url.includes("orders:batchGet") ? new Response(JSON.stringify({ error: { code: 403, message: "The caller does not have permission", errors: [{ reason: "permissionDenied" }] } }), { status: 403 }) : undefined);
    const denied = await call(e, "POST", RESTORE, { customer_id: "c1" }, { order_id: "GPA.0000-0000-0000-00002" });
    expect(denied.status).toBe(422);
    expect(denied.body.type).toBe("unprocessable_entity_error");
  });
});

describe("restore an App Store purchase by order id (Look Up Order ID)", () => {
  let pki: Pki;
  let h: AppleHarness | undefined;
  beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
  afterAll(() => setAppleRootsForTesting(null));
  afterEach(async () => { await h?.close(); h = undefined; });

  it("verifies the order's signed transactions, reads their full state, and gives only the order's chains to the customer", async () => {
    const ordered = transaction({ transactionId: "4000000002", originalTransactionId: "4000000001", purchaseDate: T0 - 2 * DAY, originalPurchaseDate: T0 - 32 * DAY, expiresDate: T0 + 28 * DAY });
    const other = transaction({ transactionId: "4000000009", productId: "pro_annual", expiresDate: T0 + 300 * DAY });
    const renewal = await signJws(renewalInfo({ originalTransactionId: "4000000001", eligibleWinBackOfferIds: [] }), pki);
    const api = mockAppleApi({
      production: {
        transactions: [await signJws(ordered, pki), await signJws(other, pki)],
        statuses: { data: [{ subscriptionGroupIdentifier: "g1", lastTransactions: [{ originalTransactionId: "4000000001", status: 1, signedTransactionInfo: await signJws(ordered, pki), signedRenewalInfo: renewal }] }] },
      },
    });
    const lookups: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      const u = new URL(url);
      if (u.pathname.startsWith("/inApps/v1/lookup/")) {
        lookups.push(`${u.host.includes("sandbox") ? "sandbox" : "production"} ${decodeURIComponent(u.pathname.split("/").pop()!)}`);
        const known = u.pathname.endsWith("/MK5TTTVWJH") && !u.host.includes("sandbox");
        return Response.json(known ? { status: 0, signedTransactions: [await signJws(ordered, pki)] } : { status: 1, signedTransactions: [] });
      }
      return api.fetch(url, init);
    };
    h = await appleHarness({ credentials: { key_id: "ABC123", issuer_id: "issuer", private_key: await makeP8() }, fetch: fetchFn });
    const { key } = await createSecretKey(h.db, "proj1", "support");
    const call = (method: string, tmpl: string, params: Record<string, string>, json?: unknown) => v2(h!.request, key, method, tmpl, params, json);
    await call("POST", "/v2/projects/{project_id}/customers", {}, { id: "apple_support" });

    const r = await call("POST", RESTORE, { customer_id: "apple_support" }, { order_id: "MK5TTTVWJH" });
    expect(r.status).toBe(200);
    expect(lookups).toEqual(["production MK5TTTVWJH"]);
    const subs = await h.db.select().from(schema.subscriptions);
    expect(subs.map((s) => [s.storeKey, s.productIdentifier, s.storeTransactionId])).toEqual([["4000000001", "pro_monthly", "4000000002"]]);
    expect((await h.newEvents()).map((x) => [x.type, x.app_user_id])).toEqual([["INITIAL_PURCHASE", "apple_support"]]);

    const unknown = await call("POST", RESTORE, { customer_id: "apple_support" }, { order_id: "NOPE123" });
    expect(unknown.status).toBe(404);
    expect(lookups.slice(1)).toEqual(["production NOPE123", "sandbox NOPE123"]);
  });
});

describe("create a product in the store", () => {
  let pki: Pki;
  let h: AppleHarness | undefined;
  beforeAll(async () => { pki = await makePki(); });
  afterEach(async () => { await h?.close(); h = undefined; });

  /** A fake App Store Connect: one app, subscription groups, subscriptions and in-app purchases, with duplicate checks. */
  function fakeConnect() {
    const calls: { method: string; path: string; body: any; auth: string | null }[] = [];
    const groups = new Map<string, string>([["Existing", "21000000"]]);
    const productIds = new Set<string>();
    const fetchFn: FetchFn = async (url, init = {}) => {
      const u = new URL(url);
      if (u.host !== "api.appstoreconnect.apple.com") throw new Error(`unexpected fetch ${url}`);
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path: u.pathname + u.search, body, auth: new Headers(init.headers).get("authorization") });
      const ok = (status: number, data: unknown) => Response.json({ data }, { status });
      if (method === "GET" && u.pathname === "/v1/apps") {
        return ok(200, u.searchParams.get("filter[bundleId]") === "com.example.scanner" ? [{ type: "apps", id: "6400000001", attributes: { bundleId: "com.example.scanner", name: "Scanner" } }] : []);
      }
      if (method === "GET" && u.pathname === "/v1/apps/6400000001/subscriptionGroups") {
        const name = u.searchParams.get("filter[referenceName]")!;
        return ok(200, groups.has(name) ? [{ type: "subscriptionGroups", id: groups.get(name), attributes: { referenceName: name } }] : []);
      }
      if (method === "POST" && u.pathname === "/v1/subscriptionGroups") {
        const id = String(21000000 + groups.size);
        groups.set(body.data.attributes.referenceName, id);
        return ok(201, { type: "subscriptionGroups", id, attributes: body.data.attributes });
      }
      if (method === "POST" && (u.pathname === "/v1/subscriptions" || u.pathname === "/v2/inAppPurchases")) {
        const pid = body.data.attributes.productId;
        if (productIds.has(pid)) {
          return Response.json({ errors: [{ status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE", title: "The provided entity includes an attribute with a value that has already been used", detail: "The product ID you entered has already been used." }] }, { status: 409 });
        }
        productIds.add(pid);
        return ok(201, { type: body.data.type, id: String(6500000000 + productIds.size), attributes: { ...body.data.attributes, state: "MISSING_METADATA" } });
      }
      return Response.json({ errors: [{ status: "404", title: "Not found" }] }, { status: 404 });
    };
    return { fetchFn, calls, groups };
  }

  it("App Store: a subscription in a group found or created by name, an in-app purchase, 409 for a product id already in the store", async () => {
    const asc = fakeConnect();
    h = await appleHarness({ credentials: { app_store_connect_api_key: await makeP8(), app_store_connect_api_key_id: "ASCKEY1", app_store_connect_api_key_issuer: "69a6de70-0000-47e3-e053-5b8c7c11a4d1" }, fetch: asc.fetchFn });
    await h.db.update(schema.products).set({ displayName: "Pro Monthly" }).where(eq(schema.products.id, "p1"));
    const { key } = await createSecretKey(h.db, "proj1", "catalog");
    const call = (tmpl: string, params: Record<string, string>, json?: unknown) => v2(h!.request, key, "POST", tmpl, params, json);

    const created = await call(CREATE, { product_id: "p1" }, { store_information: { duration: "ONE_MONTH", subscription_group_name: "Pro" } });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ created_product: { object: "store_product", id: "6500000001", name: "Pro Monthly", product_identifier: "pro_monthly" } });
    const group = asc.calls.find((c) => c.path === "/v1/subscriptionGroups")!;
    expect(group.body).toEqual({ data: { type: "subscriptionGroups", attributes: { referenceName: "Pro" }, relationships: { app: { data: { type: "apps", id: "6400000001" } } } } });
    const subCall = asc.calls.find((c) => c.path === "/v1/subscriptions")!;
    expect(subCall.body).toEqual({ data: { type: "subscriptions", attributes: { name: "Pro Monthly", productId: "pro_monthly", subscriptionPeriod: "ONE_MONTH" }, relationships: { group: { data: { type: "subscriptionGroups", id: "21000001" } } } } });
    // The App Store Connect API token: ES256 with the key id, the issuer and Apple's audience, under 20 minutes.
    const jwt = subCall.auth!.replace("Bearer ", "");
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "ASCKEY1", typ: "JWT" });
    const claims = decodeJwt(jwt);
    expect(claims).toMatchObject({ iss: "69a6de70-0000-47e3-e053-5b8c7c11a4d1", aud: "appstoreconnect-v1" });
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(20 * 60);

    const annual = await call(CREATE, { product_id: "p2" }, { store_information: { duration: "ONE_YEAR", subscription_group_name: "Existing" } });
    expect(annual.status).toBe(201);
    expect(asc.calls.filter((c) => c.path === "/v1/subscriptionGroups")).toHaveLength(1);
    expect(asc.calls.filter((c) => c.path === "/v1/subscriptions")[1]!.body.data.relationships.group.data.id).toBe("21000000");

    const coins = await call(CREATE, { product_id: "p3" }, {});
    expect(coins.status).toBe(201);
    expect(asc.calls.find((c) => c.path === "/v2/inAppPurchases")!.body.data.attributes).toEqual({ name: "coins_100", productId: "coins_100", inAppPurchaseType: "CONSUMABLE" });
    expect((await call(CREATE, { product_id: "p4" }, undefined)).status).toBe(201);
    expect(asc.calls.filter((c) => c.path === "/v2/inAppPurchases")[1]!.body.data.attributes.inAppPurchaseType).toBe("NON_CONSUMABLE");

    const dup = await call(CREATE, { product_id: "p3" }, {});
    expect(dup.status).toBe(409);
    expect(dup.body.type).toBe("resource_already_exists");
  });

  it("App Store: 422 when App Store Connect refuses the key or has no app for the bundle id, 422 store_error (retryable) while it is down", async () => {
    const asc = fakeConnect();
    let mode: "ok" | "401" | "503" = "401";
    const fetchFn: FetchFn = async (url, init) => (mode === "401" ? Response.json({ errors: [{ status: "401", title: "Authentication credentials are missing or invalid." }] }, { status: 401 }) : mode === "503" ? new Response("", { status: 503 }) : asc.fetchFn(url, init));
    h = await appleHarness({ credentials: { app_store_connect_api_key: await makeP8(), app_store_connect_api_key_id: "K", app_store_connect_api_key_issuer: "I" }, fetch: fetchFn, bundleId: "com.example.other" });
    const { key } = await createSecretKey(h.db, "proj1", "catalog");
    const call = (json: unknown) => v2(h!.request, key, "POST", CREATE, { product_id: "p3" }, json);
    const refused = await call({});
    expect(refused).toMatchObject({ status: 422, body: { type: "unprocessable_entity_error" } });
    expect(refused.body.message).toMatch(/App Manager/);
    mode = "503";
    expect(await call({})).toMatchObject({ status: 422, body: { type: "store_error", retryable: true } });
    mode = "ok";
    const noApp = await call({});
    expect(noApp.status).toBe(422);
    expect(noApp.body.message).toMatch(/com\.example\.other/);
  });

  it("Google Play: a subscription with one listing in the app's default language; one-time products need a price", async () => {
    const keys = await makeKeys();
    const e = await env(keys);
    try {
      e.g.defaultLanguage = "de-DE";
      const call = (product: string) => v2((p, i) => e.call(p, i as any), e.h.ids.secretKey, "POST", CREATE, { product_id: product }, {});
      const r = await call("gp_premium");
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ created_product: { object: "store_product", id: "premium", name: "premium:monthly", product_identifier: "premium" } });
      expect(e.g.created.get("premium")).toEqual({ packageName: "com.example.scanner", productId: "premium", listings: [{ languageCode: "de-DE", title: "premium:monthly" }] });
      // The edit used to read the default language is thrown away.
      expect(e.g.calls.filter((c) => c.url.includes("/edits")).map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
      expect((await call("gp_premium")).status).toBe(409);
      const oneTime = await call("gp_lifetime");
      expect(oneTime.status).toBe(422);
      expect(oneTime.body.message).toMatch(/price/);
    } finally {
      await e.h.close();
    }
  });
});
