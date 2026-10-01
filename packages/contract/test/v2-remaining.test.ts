import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "@revenuedot/server/services/auth.js";
import { harness, type Harness } from "../src/harness.js";
import { buy, v2 } from "./v2-helpers.js";

/**
 * The last 15 operations of RevenueCat's v2 spec (prd/rest-api/PRD.md): subscriber tokens and the SDK paths that take them,
 * the 12 RevenueCat Billing operations answered on purpose, and the store operations' answers when the credentials they need
 * are missing. The store round trips (fake Google, Apple and App Store Connect) are in apps/server/test/store-ops.test.ts.
 * Every v2 answer is validated against RevenueCat's schema for its operation and status.
 */
let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const AUTH = "/v2/projects/{project_id}/apps/{app_id}/authenticate";
const D = "/v2/projects/{project_id}/discounts";
const DI = `${D}/{discount_id}`;
const INV = "/v2/projects/{project_id}/customers/{customer_id}/invoices";

const tokenFor = async (appUserId: string, app = h.ids.app) => {
  const r = await call("POST", AUTH, { app_id: app }, { json: { app_user_id: appUserId } });
  expect(r.status).toBe(200);
  return r.body as { object: string; access_token: string; expires_at: number };
};
const sdk = (path: string, key: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
  h.fetch(path, { key, method: init.method ?? "GET", json: init.json, headers: init.headers });

describe("discounts and invoices (RevenueCat Billing only) answer on purpose", () => {
  it("writes answer 422, lists are empty, single reads are a 404 that says why; all valid against RevenueCat's schema", async () => {
    const id = { discount_id: "discnt_abc" };
    const writes: [string, string, Record<string, string>, unknown?][] = [
      ["POST", D, {}, { identifier: "black_friday", customer_facing_name: "Black Friday", type: "percentage", percentage: 20, duration_mode: "one_time", eligibility: "everyone" }],
      ["PATCH", DI, id, { customer_facing_name: "BF" }],
      ["DELETE", DI, id],
      ["POST", `${DI}/actions/enable`, id],
      ["POST", `${DI}/actions/disable`, id],
      ["POST", `${DI}/discount_codes`, id, { codes: ["SAVE20"] }],
      ["DELETE", `${DI}/discount_codes/{discount_code}`, { ...id, discount_code: "SAVE20" }],
    ];
    for (const [method, path, params, json] of writes) {
      const r = await call(method, path, params, { json });
      expect(r.status, `${method} ${path}`).toBe(422);
      expect(r.body).toMatchObject({ object: "error", type: "unprocessable_entity_error", retryable: false });
      expect(r.body.message).toMatch(/RevenueCat Billing/);
    }
    const list = await call("GET", D);
    expect(list).toMatchObject({ status: 200, body: { object: "list", items: [], next_page: null } });
    for (const path of [DI, `${DI}/discount_codes`]) {
      const r = await call("GET", path, id);
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ type: "resource_missing", param: "discount_id" });
      expect(r.body.message).toMatch(/RevenueCat Billing/);
    }

    await buy(h, "payer", "pro_monthly", h.now());
    const inv = await call("GET", INV, { customer_id: "payer" });
    expect(inv).toMatchObject({ status: 200, body: { object: "list", items: [], next_page: null } });
    expect((await call("GET", INV, { customer_id: "nobody" })).status).toBe(404);
    const file = await call("GET", `${INV}/{invoice_id}/file`, { customer_id: "payer", invoice_id: "rcbin_1" });
    expect(file.status).toBe(404);
    expect(file.body.message).toMatch(/RevenueCat Billing/);
  });

  it("checks the permission first: a key without the discounts or invoices scope gets 403", async () => {
    const { key } = await createSecretKey(h.db, "proj1", "catalog only", ["project_configuration:products:read_write"]);
    expect((await call("GET", D, {}, { key })).status).toBe(403);
    expect((await call("POST", D, {}, { key, json: {} })).status).toBe(403);
    expect((await call("GET", INV, { customer_id: "x" }, { key })).status).toBe(403);
    const reader = (await createSecretKey(h.db, "proj1", "reader", ["project_configuration:discounts:read"])).key;
    expect((await call("GET", D, {}, { key: reader })).status).toBe(200);
    expect((await call("DELETE", DI, { discount_id: "d" }, { key: reader })).status).toBe(403);
  });
});

describe("subscriber tokens (authenticate)", () => {
  it("issues a one-hour token for an app of the project, with RevenueCat's authentication object", async () => {
    const t = await tokenFor("token_user");
    expect(t).toMatchObject({ object: "authentication" });
    expect(t.access_token).toMatch(/^rdat_[0-9a-f]{64}$/);
    expect(t.expires_at).toBe(h.now().getTime() + 3600_000);
    // Only the hash is stored.
    const rows = await h.db.select().from(schema.subscriberTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).not.toContain(t.access_token.slice(5, 20));
    expect((await call("POST", AUTH, { app_id: "app_nope" }, { json: { app_user_id: "x" } })).status).toBe(404);
    expect((await call("POST", AUTH, { app_id: h.ids.app }, { json: { app_user_id: "" } })).status).toBe(400);
    const { key } = await createSecretKey(h.db, "proj1", "no iam", ["customer_information:*"]);
    expect((await call("POST", AUTH, { app_id: h.ids.app }, { key, json: { app_user_id: "x" } })).status).toBe(403);
    const iam = (await createSecretKey(h.db, "proj1", "iam", ["iam:authorization:issue_token"])).key;
    expect((await call("POST", AUTH, { app_id: h.ids.app }, { key: iam, json: { app_user_id: "x" } })).status).toBe(200);
  });

  it("serves the SDK's /v1/customer paths for the token's app user id, with the same bodies as /v1/subscribers/{id}", async () => {
    await buy(h, "token_user", "pro_monthly", h.now());
    const { access_token: tok } = await tokenFor("token_user", "app_test");
    const viaToken = await sdk("/v1/customer", tok);
    expect(viaToken.status).toBe(200);
    const direct = await sdk("/v1/subscribers/token_user", h.ids.testKey);
    const a = await viaToken.json() as any, b = await direct.json() as any;
    expect(a.subscriber.entitlements.pro.product_identifier).toBe("pro_monthly");
    expect({ ...a, request_date: 0, request_date_ms: 0 }).toEqual({ ...b, request_date: 0, request_date_ms: 0 });
    expect(viaToken.headers.get("x-revenuecat-request-time")).toMatch(/^\d+$/);

    const offerings = await (await sdk("/v1/customer/offerings", tok)).json() as any;
    expect(offerings.current_offering_id).toBe("default");
    expect((await sdk("/v1/customer/attributes", tok, { method: "POST", json: { attributes: { $email: { value: "t@example.com", updated_at_ms: h.now().getTime() } } } })).status).toBe(200);
    const [attr] = await h.db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.key, "$email"));
    expect(attr!.value).toBe("t@example.com");
    expect((await sdk("/v1/customer/virtual_currencies", tok)).status).toBe(200);
    expect((await sdk("/v1/customer/customercenter", tok)).status).toBe(200);
    const products = await (await sdk("/rcbilling/v1/customer/products?id=pro_monthly", tok)).json() as any;
    expect(products.product_details[0].identifier).toBe("pro_monthly");
    // A receipt for the token's own user is accepted.
    const own = await sdk("/v1/receipts", tok, { method: "POST", json: { app_user_id: "token_user", fetch_token: `test_${Date.now()}_own`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect(own.status).toBe(200);
  });

  it("is pinned to its app user id and its hour: anything else is 401 with code 7224", async () => {
    const { access_token: tok } = await tokenFor("pinned");
    const refused = async (res: Response) => {
      expect(res.status).toBe(401);
      expect((await res.json() as { code: number }).code).toBe(7224);
    };
    await refused(await sdk("/v1/subscribers/someone_else", tok));
    await refused(await sdk("/v1/subscribers/someone_else/offerings", tok));
    await refused(await sdk("/v1/receipts", tok, { method: "POST", json: { app_user_id: "someone_else", fetch_token: "x" } }));
    await refused(await sdk("/v1/subscribers/identify", tok, { method: "POST", json: { app_user_id: "someone_else", new_app_user_id: "z" } }));
    // logIn and alias would answer for, or merge into, the customer named by new_app_user_id.
    await sdk("/v1/subscribers/someone_else", h.ids.iosKey);
    await refused(await sdk("/v1/subscribers/identify", tok, { method: "POST", json: { app_user_id: "pinned", new_app_user_id: "someone_else" } }));
    await refused(await sdk("/v1/subscribers/pinned/alias", tok, { method: "POST", json: { new_app_user_id: "someone_else" } }));
    await refused(await sdk("/v1/offers", tok, { method: "POST", json: { app_user_id: "someone_else", generate_offers: [{ product_id: "pro_monthly", offer_id: "o" }] } }));
    // App user ids that look like the user-less paths are still other users.
    for (const other of ["identify", "redeem_purchase", "support"]) await refused(await sdk(`/v1/subscribers/${other}`, tok));
    await refused(await sdk("/v1/customercenter/support", tok));
    // Ids are compared after the same decoding the routes apply.
    await refused(await sdk(`/v1/subscribers/${encodeURIComponent(encodeURIComponent("someone_else"))}`, tok));
    expect((await sdk("/v1/subscribers/pinned", tok)).status).toBe(201);
    // SDK events are recorded for the token's own app user id only.
    const ev = (id: string, user: string) => ({ id, app_user_id: user, type: "paywall_impression", timestamp: h.now().getTime(), version: 1, session_id: "s", paywall_id: "p", offering_id: "default" });
    expect((await sdk("/v1/events", tok, { method: "POST", json: { events: [ev("E1", "pinned"), ev("E2", "someone_else")] } })).status).toBe(200);
    expect((await h.db.select().from(schema.sdkEvents)).map((r) => [r.id, r.appUserId])).toEqual([["E1", "pinned"]]);
    // The app's own key has no subscriber to speak for.
    await refused(await sdk("/v1/customer", h.ids.iosKey));
    h.setNow(new Date(h.now().getTime() + 3600_000 + 1));
    await refused(await sdk("/v1/customer", tok));
    expect((await sdk("/v1/customer", "rdat_unknown")).status).toBe(401);
    // A token is never a v2 key.
    expect((await call("GET", "/v2/projects/{project_id}/apps", {}, { key: tok, ext: true })).status).toBe(403);
  });

  it("is revoked when its customer is deleted", async () => {
    await call("POST", "/v2/projects/{project_id}/customers", {}, { json: { id: "leaver" } });
    const { access_token: tok } = await tokenFor("leaver");
    expect((await sdk("/v1/customer", tok)).status).toBe(200);
    expect((await call("DELETE", "/v2/projects/{project_id}/customers/{customer_id}", { customer_id: "leaver" })).status).toBe(200);
    expect((await sdk("/v1/customer", tok)).status).toBe(401);
    expect(await h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, "leaver"))).toEqual([]);
  });

  it("spends in-app currency: all or nothing, never below zero, once per Idempotency-Key", async () => {
    await call("POST", "/v2/projects/{project_id}/virtual_currencies", {}, { json: { code: "GLD", name: "Gold" } });
    await call("POST", "/v2/projects/{project_id}/virtual_currencies", {}, { json: { code: "GEM", name: "Gems" } });
    await call("POST", "/v2/projects/{project_id}/customers", {}, { json: { id: "spender" } });
    await call("POST", "/v2/projects/{project_id}/customers/{customer_id}/virtual_currencies/transactions", { customer_id: "spender" }, { json: { adjustments: { GLD: 10, GEM: 1 } } });
    const { access_token: tok } = await tokenFor("spender");
    const spend = (json: unknown, key?: string) => sdk("/v1/customer/virtual_currencies/spend", tok, { method: "POST", json, headers: key ? { "Idempotency-Key": key } : {} });

    const ok = await spend({ adjustments: { GLD: 4 }, reference: "sword" }, "k1");
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).virtual_currencies.GLD).toMatchObject({ balance: 6, code: "GLD", name: "Gold" });
    const again = await spend({ adjustments: { GLD: 4 }, reference: "sword" }, "k1");
    expect((await again.json() as any).virtual_currencies.GLD.balance).toBe(6);

    const tooMuch = await spend({ adjustments: { GLD: 1, GEM: 2 } }, "k2");
    expect(tooMuch.status).toBe(422);
    expect((await tooMuch.json() as any).code).toBe(7000);
    const bal = await (await sdk("/v1/customer/virtual_currencies", tok)).json() as any;
    expect([bal.virtual_currencies.GLD.balance, bal.virtual_currencies.GEM.balance]).toEqual([6, 1]);
    for (const bad of [{}, { adjustments: { GLD: 0 } }, { adjustments: { GLD: -1 } }, { adjustments: { NOPE: 1 } }]) {
      const r = await spend(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect((await r.json() as any).code).toBe(7226);
    }
    const ledger = await h.db.select().from(schema.virtualCurrencyTransactions).where(eq(schema.virtualCurrencyTransactions.source, "sdk"));
    expect(ledger.map((l) => [l.code, l.amount, l.reference])).toEqual([["GLD", -4, "sword"]]);
    // Concurrent spends never take a balance below zero: 6 gold buys exactly three spends of 2.
    const results = await Promise.all(Array.from({ length: 6 }, () => spend({ adjustments: { GLD: 2 } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 422, 422, 422]);
    const after = await (await sdk("/v1/customer/virtual_currencies", tok)).json() as any;
    expect(after.virtual_currencies.GLD.balance).toBe(0);
    await h.db.delete(schema.virtualCurrencyTransactions).where(eq(schema.virtualCurrencyTransactions.amount, -2));
    expect((await spend({ adjustments: { GLD: 2_147_483_648 } })).status).toBe(400);
    // RevenueCat sends no webhook for balance changes outside purchases and the dashboard.
    expect(await h.db.select().from(schema.events).where(eq(schema.events.type, "VIRTUAL_CURRENCY_TRANSACTION"))).toEqual([]);
  });
});

describe("store operations without the store credentials they need", () => {
  it("restore_purchase_by_order_id: 404 for an unknown customer, 422 without credentials, 400 without order_id", async () => {
    const R = "/v2/projects/{project_id}/customers/{customer_id}/actions/restore_purchase_by_order_id";
    expect((await call("POST", R, { customer_id: "ghost" }, { json: { order_id: "GPA.1234-5678-9012-34567" } })).status).toBe(404);
    await call("POST", "/v2/projects/{project_id}/customers", {}, { json: { id: "restorer" } });
    const google = await call("POST", R, { customer_id: "restorer" }, { json: { order_id: "GPA.1234-5678-9012-34567" } });
    expect(google.status).toBe(422);
    expect(google.body).toMatchObject({ type: "unprocessable_entity_error", param: "order_id" });
    expect(google.body.message).toMatch(/service account/);
    const apple = await call("POST", R, { customer_id: "restorer" }, { json: { order_id: "MK5TTTVWJH" } });
    expect(apple.status).toBe(422);
    expect(apple.body.message).toMatch(/In-App Purchase key/);
    expect((await call("POST", R, { customer_id: "restorer" }, { json: {} })).status).toBe(400);
  });

  it("create_in_store: 404 for an unknown product, 422 without the App Store Connect key, for a Test Store product and for a subscription without store_information", async () => {
    const P = "/v2/projects/{project_id}/products/{product_id}/create_in_store";
    expect((await call("POST", P, { product_id: "nope" }, { json: {} })).status).toBe(404);
    const noKey = await call("POST", P, { product_id: "p1" }, { json: { store_information: { duration: "ONE_MONTH", subscription_group_name: "Pro" } } });
    expect(noKey.status).toBe(422);
    expect(noKey.body.message).toMatch(/App Store Connect API key/);
    const test = await call("POST", P, { product_id: "p4" }, { json: {} });
    expect(test.status).toBe(422);
    expect(test.body.message).toMatch(/test_store/);
    await h.db.update(schema.apps).set({ credentials: { app_store_connect_api_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----", app_store_connect_api_key_id: "K", app_store_connect_api_key_issuer: "I" } }).where(eq(schema.apps.id, h.ids.app));
    const noInfo = await call("POST", P, { product_id: "p1" }, { json: {} });
    expect(noInfo.status).toBe(422);
    expect(noInfo.body.param).toBe("store_information");
    expect((await call("POST", P, { product_id: "p1" }, { json: { store_information: { duration: "FOREVER", subscription_group_name: "Pro" } } })).status).toBe(400);
  });
});
