import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { spec } from "../../../packages/contract/test/v2-helpers.js";
import { createSecretKey } from "../src/services/auth.js";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import type { FetchFn } from "../src/stores/apple/api.js";
import { env, makeKeys, sub, type Env, type Keys } from "./google-helpers.js";
import { DAY as ADAY, T0 as AT0, appleHarness, makeP8, makePki, mockAppleApi, renewalInfo, signJws, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";

const DAY = 86_400_000;
const T0 = new Date("2026-09-01T12:00:00Z");
const MONTH_END = new Date("2026-10-01T12:00:00Z");
const P = "/v2/projects/{project_id}";

let keys: Keys;
let e: Env;
beforeAll(async () => { keys = await makeKeys(); });

const PRO = [{ product_id: "pro", base_plan_id: "monthly" }];
const ORDER = "GPA.1000-0000-0000-00001";
const buyPro = (user = "user_a", token = "tok_pro_1") =>
  e.receipt({ app_user_id: user, fetch_token: token, product_ids: ["pro"], platform_product_ids: PRO, price: 9.99, currency: "USD" });
const post = (path: string, json: unknown = {}) => e.call(path, { method: "POST", key: e.h.ids.secretKey, json });
const googleCalls = (suffix: string) => e.g.calls.filter((c) => c.method === "POST" && new URL(c.url).pathname.endsWith(suffix));
/** Checks a v2 body against RevenueCat's response schema for the operation, when the spec is available. */
const checkV2 = (method: string, tmpl: string, status: number, body: unknown) => {
  if (spec) expect(spec.check(method, tmpl, status, body), JSON.stringify(body).slice(0, 2000)).toBeNull();
};

describe("store actions on Google Play purchases", () => {
  afterEach(async () => { await e?.h.close(); });
  async function subscribed() {
    e = await env(keys);
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: ORDER }));
    expect((await buyPro()).status).toBe(200);
    e.h.setNow(new Date(T0.getTime() + 5 * DAY));
  }
  const events = async (type: string) => e.events(type);

  it("v1 revoke refunds the last payment and ends access now (subscriptionsv2.revoke with a full refund)", async () => {
    await subscribed();
    const res = await post("/v1/subscribers/user_a/subscriptions/pro/revoke");
    expect(res.status).toBe(200);
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(googleCalls("tok_pro_1:revoke")).toHaveLength(1);
    expect(JSON.parse(googleCalls("tok_pro_1:revoke")[0]!.body)).toEqual({ revocationContext: { fullRefund: {} } });
    expect(ci.subscriber.subscriptions.pro!.refunded_at).toBe("2026-09-06T12:00:00Z");
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-09-06T12:00:00Z");
    expect((await events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -9.99 });
  });

  it("v1 defer moves the renewal with the etag Google requires, by days or to a time; SUBSCRIPTION_EXTENDED", async () => {
    await subscribed();
    let res = await post("/v1/subscribers/user_a/subscriptions/pro/defer", { extend_by_days: 10 });
    expect(res.status).toBe(200);
    const [call] = googleCalls("tok_pro_1:defer");
    expect(JSON.parse(call!.body)).toEqual({ deferralContext: { etag: `etag-${ORDER}-${MONTH_END.toISOString()}`, deferDuration: "864000s" } });
    expect(CustomerInfoSchema.parse(await res.json()).subscriber.subscriptions.pro!.expires_date).toBe("2026-10-11T12:00:00Z");
    expect(await events("SUBSCRIPTION_EXTENDED")).toHaveLength(1);

    res = await post("/v1/subscribers/user_a/subscriptions/pro/defer", { expiry_time_ms: new Date("2026-10-20T12:00:00Z").getTime() });
    expect(CustomerInfoSchema.parse(await res.json()).subscriber.subscriptions.pro!.expires_date).toBe("2026-10-20T12:00:00Z");

    res = await post("/v1/subscribers/user_a/subscriptions/pro/defer", { expiry_time_ms: T0.getTime() });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(7226);
    res = await post("/v1/subscribers/user_a/subscriptions/pro/defer", {});
    expect((await res.json()).code).toBe(7226);
  });

  it("v1 cancel stops renewal and keeps access to the period end: CANCELLATION with DEVELOPER_INITIATED", async () => {
    await subscribed();
    const res = await post(`/v1/subscribers/user_a/subscriptions/${ORDER}/cancel`);
    expect(res.status).toBe(200);
    expect(JSON.parse(googleCalls("tok_pro_1:cancel")[0]!.body)).toEqual({ cancellationContext: { cancellationType: "DEVELOPER_REQUESTED_STOP_PAYMENTS" } });
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.subscriptions.pro!.unsubscribe_detected_at).not.toBeNull();
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
    expect((await events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "DEVELOPER_INITIATED", price: 0 });
  });

  it("v1 refund refunds and revokes one order (orders.refund), for a subscription period and a one-time purchase", async () => {
    await subscribed();
    let res = await post(`/v1/subscribers/user_a/transactions/${ORDER}/refund`);
    expect(res.status).toBe(200);
    expect(e.g.refunds).toEqual([{ orderId: ORDER, revoke: true }]);
    expect(CustomerInfoSchema.parse(await res.json()).subscriber.subscriptions.pro!.refunded_at).toBe("2026-09-06T12:00:00Z");

    e.g.products.set("lifetime_unlock|tok_life", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, orderId: "GPA.L1", acknowledgementState: 1 });
    await e.receipt({ app_user_id: "lifer", fetch_token: "tok_life", product_ids: ["lifetime_unlock"], platform_product_ids: [{ product_id: "lifetime_unlock" }], price: 49.99, currency: "USD" });
    res = await post("/v1/subscribers/lifer/transactions/GPA.L1/refund");
    expect(res.status).toBe(200);
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-09-06T12:00:00Z");
    expect((await events("CANCELLATION")).map((x) => [x.product_id, x.price])).toEqual([["pro", -9.99], ["lifetime_unlock", -49.99]]);
  });

  it("answers RevenueCat's codes: 7259 for an unknown subscription, 7000 for another store, 7101 (503) when Google is down, 7101 (400) when Google refuses", async () => {
    await subscribed();
    let res = await post("/v1/subscribers/user_a/subscriptions/nope/revoke");
    expect([res.status, (await res.json()).code]).toEqual([404, 7259]);
    res = await post("/v1/subscribers/nobody/subscriptions/pro/revoke");
    expect(res.status).toBe(404);
    res = await post(`/v1/subscribers/user_a/subscriptions/${ORDER}/extend`, { extend_by_days: 3, extend_reason_code: 1 });
    expect([res.status, (await res.json()).code]).toEqual([400, 7000]);

    // A Test Store subscription has no store to ask.
    await e.call("/v1/receipts", { method: "POST", key: e.h.ids.testKey, json: { app_user_id: "tester", fetch_token: `test_${T0.getTime()}_abc`, product_id: "pro_monthly" } });
    res = await post(`/v1/subscribers/tester/subscriptions/test_${T0.getTime()}_abc/cancel`);
    const body = await res.json();
    expect([res.status, body.code]).toEqual([400, 7000]);
    expect(body.message).toMatch(/Test Store/);

    e.g.override = (url) => (url.includes(":revoke") ? new Response("down", { status: 503 }) : undefined);
    res = await post("/v1/subscribers/user_a/subscriptions/pro/revoke");
    expect([res.status, (await res.json()).code]).toEqual([503, 7101]);
    e.g.override = (url) => (url.includes(":cancel") ? new Response(JSON.stringify({ error: { code: 400, message: "The subscription has expired.", errors: [{ reason: "subscriptionExpired" }] } }), { status: 400 }) : undefined);
    res = await post(`/v1/subscribers/user_a/subscriptions/${ORDER}/cancel`);
    const refused = await res.json();
    expect([res.status, refused.code]).toEqual([400, 7101]);
    expect(refused.message).toMatch(/expired/);
    // Public keys cannot run store actions.
    expect((await e.call("/v1/subscribers/user_a/subscriptions/pro/revoke", { method: "POST", key: e.h.ids.androidKey, json: {} })).status).toBe(403);
  });

  it("v2 cancel, extend and refund act on the Play subscription and answer RevenueCat's Subscription shape", async () => {
    await subscribed();
    const [row] = await e.h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.storeKey, "tok_pro_1"));
    const path = `/v2/projects/proj1/subscriptions/${row!.id}`;
    let res = await post(`${path}/actions/cancel`);
    let body = await res.json();
    expect(res.status).toBe(200);
    checkV2("POST", `${P}/subscriptions/{subscription_id}/actions/cancel`, 200, body);
    expect(body).toMatchObject({ object: "subscription", auto_renewal_status: "will_not_renew", gives_access: true });

    res = await post(`${path}/actions/extend`, { extend_by_days: 3 });
    body = await res.json();
    checkV2("POST", `${P}/subscriptions/{subscription_id}/actions/extend`, 200, body);
    expect(body.current_period_ends_at).toBe(MONTH_END.getTime() + 3 * DAY);
    expect((await post(`${path}/actions/extend`, { extend_by_days: 0 })).status).toBe(400);

    res = await post(`${path}/transactions/${ORDER}/actions/refund`);
    body = await res.json();
    expect(res.status).toBe(200);
    checkV2("POST", `${P}/subscriptions/{subscription_id}/transactions/{transaction_id}/actions/refund`, 200, body);
    expect(body).toMatchObject({ object: "subscription_transaction", id: ORDER, product_store_identifier: "pro", effective_expiration_date: T0.getTime() + 5 * DAY });
    expect((await post(`${path}/transactions/GPA.nope/actions/refund`)).status).toBe(404);

    res = await post(`${path}/actions/refund`);
    expect(res.status).toBe(200);
    expect(googleCalls("tok_pro_1:revoke")).toHaveLength(1);
  });

  it("v2 purchase refund refunds a Play one-time purchase; other stores answer 422", async () => {
    e = await env(keys);
    e.g.products.set("lifetime_unlock|tok_life", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, orderId: "GPA.L1", acknowledgementState: 1 });
    await e.receipt({ app_user_id: "lifer", fetch_token: "tok_life", product_ids: ["lifetime_unlock"], platform_product_ids: [{ product_id: "lifetime_unlock" }], price: 49.99, currency: "USD" });
    const [one] = await e.h.db.select().from(schema.nonSubscriptions);
    let res = await post(`/v2/projects/proj1/purchases/${one!.id}/actions/refund`);
    const body = await res.json();
    expect(res.status).toBe(200);
    checkV2("POST", `${P}/purchases/{purchase_id}/actions/refund`, 200, body);
    expect(body).toMatchObject({ object: "purchase", status: "refunded" });

    await e.call("/v1/receipts", { method: "POST", key: e.h.ids.testKey, json: { app_user_id: "tester", fetch_token: `test_${T0.getTime()}_x`, product_id: "lifetime" } });
    const [testOne] = await e.h.db.select().from(schema.nonSubscriptions).where(eq(schema.nonSubscriptions.store, "test_store"));
    res = await post(`/v2/projects/proj1/purchases/${testOne!.id}/actions/refund`);
    const err = await res.json();
    expect([res.status, err.type]).toEqual([422, "unprocessable_entity_error"]);
    checkV2("POST", `${P}/purchases/{purchase_id}/actions/refund`, 422, err);
  });
});

describe("store actions on App Store subscriptions", () => {
  let pki: Pki;
  let h: AppleHarness | undefined;
  beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
  afterAll(() => setAppleRootsForTesting(null));
  afterEach(async () => { await h?.close(); h = undefined; });

  const first = transaction();
  /** The mock App Store: history and statuses from mockAppleApi, plus Extend and Mass Extend. */
  async function harness() {
    const data = { production: { transactions: [await signJws(first, pki)], statuses: { data: [] as any[] } } };
    const base = mockAppleApi(data);
    const extends_: { path: string; body: any }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      const u = new URL(url);
      if (u.pathname.startsWith("/inApps/v1/subscriptions/extend")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        extends_.push({ path: u.pathname, body });
        if (u.pathname.endsWith("/mass")) return Response.json({ requestIdentifier: body.requestIdentifier }, { status: 202 });
        if (u.pathname.startsWith("/inApps/v1/subscriptions/extend/mass/")) return Response.json({ requestIdentifier: u.pathname.split("/").pop(), complete: true, completeDate: AT0 + ADAY, succeededCount: 12, failedCount: 1 });
        const extended = transaction({ expiresDate: first.expiresDate! + body.extendByDays * ADAY, signedDate: AT0 + ADAY });
        data.production.statuses = { data: [{ subscriptionGroupIdentifier: "g", lastTransactions: [{ originalTransactionId: "2000000001", status: 1, signedTransactionInfo: await signJws(extended, pki), signedRenewalInfo: await signJws(renewalInfo(), pki) }] }] };
        return Response.json({ originalTransactionId: "2000000001", success: true, effectiveDate: AT0 + ADAY });
      }
      return base.fetch(url, init);
    };
    h = await appleHarness({ credentials: { key_id: "KEY123", issuer_id: "issuer-uuid", private_key: await makeP8() }, fetch: fetchFn });
    expect((await h.postReceipt("user1", await signJws(first, pki))).status).toBe(200);
    await h.newEvents();
    const { key } = await createSecretKey(h.db, "proj1", "test");
    const call = (path: string, json: unknown) => h!.request(path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(json) });
    return { call, extends_, key };
  }

  it("v1 extend calls Apple's Extend a Subscription Renewal Date and records SUBSCRIPTION_EXTENDED", async () => {
    const { call, extends_ } = await harness();
    const res = await call("/v1/subscribers/user1/subscriptions/2000000001/extend", { extend_by_days: 7, extend_reason_code: 1 });
    expect(res.status).toBe(200);
    expect(extends_[0]!.path).toBe("/inApps/v1/subscriptions/extend/2000000001");
    expect(extends_[0]!.body).toMatchObject({ extendByDays: 7, extendReasonCode: 1, requestIdentifier: expect.any(String) });
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.subscriptions.pro_monthly!.expires_date).toBe(new Date(first.expiresDate! + 7 * ADAY).toISOString().replace(".000", ""));
    expect((await h!.newEvents()).map((x) => x.type)).toEqual(["SUBSCRIPTION_EXTENDED"]);

    for (const bad of [{ extend_by_days: 91, extend_reason_code: 1 }, { extend_by_days: 5 }, { extend_by_days: 5, extend_reason_code: 9 }]) {
      const r = await call("/v1/subscribers/user1/subscriptions/2000000001/extend", bad);
      expect([r.status, (await r.json()).code]).toEqual([400, 7226]);
    }
    // Revoke, defer and cancel are Google Play only.
    const r = await call("/v1/subscribers/user1/subscriptions/pro_monthly/revoke", {});
    expect([r.status, (await r.json()).code]).toEqual([400, 7000]);
  });

  it("v2 extend needs a reason code for the App Store; v2 cancel answers 422 for App Store subscriptions", async () => {
    const { key } = await harness();
    const [row] = await h!.db.select().from(schema.subscriptions);
    const v2 = (path: string, json: unknown) => h!.request(`/v2/projects/proj1/subscriptions/${row!.id}${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(json) });
    let res = await v2("/actions/extend", { extend_by_days: 5 });
    expect([res.status, (await res.json()).param]).toEqual([400, "extend_reason_code"]);
    res = await v2("/actions/extend", { extend_by_days: 5, extend_reason_code: "service_issue_or_outage" });
    const body = await res.json();
    expect(res.status).toBe(200);
    checkV2("POST", `${P}/subscriptions/{subscription_id}/actions/extend`, 200, body);
    expect(body.current_period_ends_at).toBe(first.expiresDate! + 5 * ADAY);
    res = await v2("/actions/cancel", {});
    const err = await res.json();
    expect([res.status, err.type]).toEqual([422, "unprocessable_entity_error"]);
    checkV2("POST", `${P}/subscriptions/{subscription_id}/actions/cancel`, 422, err);
  });

  it("mass extension goes to Apple and its status can be read back", async () => {
    const { key, extends_ } = await harness();
    const req = (path: string, init: RequestInit = {}) => h!.request(`/v2/projects/proj1/apps/app_ios${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" } });
    let res = await req("/actions/mass_extend", { method: "POST", body: JSON.stringify({ product_id: "pro_monthly", extend_by_days: 3, extend_reason_code: "service_issue_or_outage", storefront_country_codes: ["USA"] }) });
    const created = await res.json();
    expect(res.status).toBe(202);
    expect(extends_[0]).toMatchObject({ path: "/inApps/v1/subscriptions/extend/mass", body: { extendByDays: 3, extendReasonCode: 3, productId: "pro_monthly", storefrontCountryCodes: ["USA"], requestIdentifier: created.id } });
    res = await req(`/mass_extensions/${created.id}?product_id=pro_monthly`);
    expect(await res.json()).toMatchObject({ id: created.id, complete: true, succeeded_count: 12, failed_count: 1 });
    expect((await req("/actions/mass_extend", { method: "POST", body: JSON.stringify({ product_id: "pro_monthly", extend_by_days: 91, extend_reason_code: "other" }) })).status).toBe(400);
  });
});
