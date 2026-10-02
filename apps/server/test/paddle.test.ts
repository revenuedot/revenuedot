import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { FAKE_PADDLE_KEY, FAKE_PADDLE_LIMITED_KEY, FAKE_PADDLE_LIVE_KEY } from "../../../packages/contract/src/fake-paddle.js";
import { flushStoreForwards } from "../src/stores/forward.js";
import { paddleSignature, signPaddlePayload, verifyPaddleSignature } from "../src/stores/paddle/signature.js";
import { tick } from "../src/services/tick.js";
import { secretKeyFrom, unseal } from "../src/services/secrets.js";
import { TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";
import { at, DAY, env, eventTypes, PADDLE_PRICES, T0, type Env } from "./stores3-helpers.js";

let e: Env;
beforeEach(async () => {
  e = await env("paddle");
  const pro = e.paddle.product({ id: "pro_01scannerpro00000000000000", name: "Scanner Pro" });
  e.paddle.price({ id: PADDLE_PRICES.monthly, product: pro.id, amount: 999, interval: "month", name: "Monthly" });
  e.paddle.price({ id: PADDLE_PRICES.annual, product: pro.id, amount: 7999, interval: "year", name: "Annual" });
  const coins = e.paddle.product({ id: "pro_01coins000000000000000000", name: "100 coins" });
  e.paddle.price({ id: PADDLE_PRICES.coins, product: coins.id, amount: 199, interval: null });
  const life = e.paddle.product({ id: "pro_01lifetime00000000000000", name: "Lifetime" });
  e.paddle.price({ id: PADDLE_PRICES.lifetime, product: life.id, amount: 4999, interval: null });
  e.paddle.price({ id: "pri_01trial000000000000000000", product: pro.id, amount: 999, interval: "month", trialDays: 7 });
});
afterEach(async () => { await e?.h.close(); });

const info = async (user: string) => CustomerInfoSchema.parse(await (await e.call(`/v1/subscribers/${encodeURIComponent(user)}`, { key: e.key })).json());
/** Delivers events the way Paddle does: signed with the destination's secret key. */
async function deliver(events: Array<Record<string, any>>, o: { secret?: string } = {}) {
  const out: Response[] = [];
  for (const ev of events) {
    const w = await e.paddle.sign(ev, o);
    out.push(await e.notify(w.body, { "paddle-signature": w.signature }));
  }
  return out;
}
const sub = async (key: string) => (await e.h.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.store, "paddle"), eq(schema.subscriptions.storeKey, key))))[0]!;
const move = (days: number) => e.h.setNow(at(days));
/** The tick's expiration worker, as the server runs it every minute. */
const expire = () => tick(e.h.db, e.h.now(), (async () => new Response("{}")) as unknown as typeof fetch);

/** A monthly subscription bought at T0 and posted by the developer's backend. */
async function bought(price = PADDLE_PRICES.monthly, user = "web_user_1") {
  const b = e.paddle.buy(price, { customData: { app_user_id: user } });
  const res = await e.receipt({ app_user_id: user, fetch_token: b.subscription!.id });
  expect(res.status).toBe(200);
  return { ...b, sub: b.subscription!, res };
}

describe("Paddle-Signature", () => {
  it("is HMAC-SHA256 over '<ts>:<raw body>' in hex, as Paddle documents, with several h1 values while a key rotates", async () => {
    const body = '{"event_id":"evt_1"}';
    const secret = "pdl_ntfset_01abc_secret";
    expect(await paddleSignature(secret, 1_700_000_000, body)).toBe(createHmac("sha256", secret).update(`1700000000:${body}`).digest("hex"));
    const now = new Date(1_700_000_100_000);
    await verifyPaddleSignature(body, await signPaddlePayload(secret, body, 1_700_000_000), secret, now);
    await verifyPaddleSignature(body, `ts=1700000000;h1=${"0".repeat(64)};h1=${await paddleSignature(secret, 1_700_000_000, body)}`, secret, now);
  });

  it("refuses a wrong secret, a changed body, a missing header or h1, and a timestamp outside 5 minutes", async () => {
    const body = '{"event_id":"evt_1"}';
    const secret = "pdl_ntfset_01abc_secret";
    const now = new Date(1_700_000_000_000);
    const good = await signPaddlePayload(secret, body, 1_700_000_000);
    await expect(verifyPaddleSignature(body, await signPaddlePayload("pdl_ntfset_other", body, 1_700_000_000), secret, now)).rejects.toThrow(/No signature/);
    await expect(verifyPaddleSignature(`${body} `, good, secret, now)).rejects.toThrow(/No signature/);
    await expect(verifyPaddleSignature(body, null, secret, now)).rejects.toThrow(/missing/);
    await expect(verifyPaddleSignature(body, "ts=1700000000", secret, now)).rejects.toThrow(/no h1/);
    await expect(verifyPaddleSignature(body, good, secret, new Date(1_700_000_301_000))).rejects.toThrow(/tolerance/);
  });
});

describe("POST /v1/receipts with X-Platform: paddle", () => {
  it("reads a subscription from the sandbox API with the app's key and records it under the price id", async () => {
    const { sub: s, transaction, res } = await bought();
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.subscriptions[PADDLE_PRICES.monthly]).toMatchObject({ store: "paddle", period_type: "normal", is_sandbox: true, store_transaction_id: transaction.id,
      purchase_date: "2026-09-01T12:00:00Z", expires_date: "2026-10-01T12:00:00Z" });
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: PADDLE_PRICES.monthly, expires_date: "2026-10-01T12:00:00Z" });
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ store: "PADDLE", product_id: PADDLE_PRICES.monthly, price: 9.99, currency: "USD", environment: "SANDBOX", transaction_id: transaction.id,
      original_transaction_id: s.id, country_code: "US", app_user_id: "web_user_1", entitlement_ids: ["pro"], commission_percentage: 0.05 });
    const calls = e.paddle.calls.filter((c) => c.url.includes("/subscriptions/") || c.url.includes("/transactions"));
    expect(calls.every((c) => c.url.startsWith("https://sandbox-api.paddle.com/") && c.auth === `Bearer ${FAKE_PADDLE_KEY}`)).toBe(true);
    // Posting it again changes nothing.
    await e.receipt({ app_user_id: "web_user_1", fetch_token: s.id });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
  });

  it("accepts the transaction id (txn_…) of a subscription, and a trial with price 0", async () => {
    const b = e.paddle.buy("pri_01trial000000000000000000");
    const res = await e.receipt({ app_user_id: "trial_user", fetch_token: b.transaction.id });
    expect(res.status).toBe(200);
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.subscriptions["pri_01trial000000000000000000"]).toMatchObject({ period_type: "trial", expires_date: "2026-09-08T12:00:00Z" });
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ period_type: "TRIAL", price: 0, original_transaction_id: b.subscription!.id });
  });

  it("records one-time transactions: a consumable the SDK is told to consume, and a lifetime unlock", async () => {
    const coins = e.paddle.buy(PADDLE_PRICES.coins);
    const r1 = await e.receipt({ app_user_id: "buyer", fetch_token: coins.transaction.id });
    expect((await r1.json()).purchased_products).toEqual({ [PADDLE_PRICES.coins]: { should_consume: true } });
    const life = e.paddle.buy(PADDLE_PRICES.lifetime);
    const r2 = await e.receipt({ app_user_id: "buyer", fetch_token: life.transaction.id });
    const ci = CustomerInfoSchema.parse(await r2.json());
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: PADDLE_PRICES.lifetime, expires_date: null });
    expect((await e.events("NON_RENEWING_PURCHASE")).map((x) => [x.product_id, x.price, x.transaction_id])).toEqual([[PADDLE_PRICES.coins, 1.99, coins.transaction.id], [PADDLE_PRICES.lifetime, 49.99, life.transaction.id]]);
  });

  it("answers 400 for what will never work and 5xx for what may work later", async () => {
    const code = async (r: Response) => [r.status, (await r.json()).code];
    expect(await code(await e.receipt({ app_user_id: "u", fetch_token: "sub_01nosuchsubscription000000000" }))).toEqual([400, 7103]);
    expect(await code(await e.receipt({ app_user_id: "u", fetch_token: "cs_test_123" }))).toEqual([400, 7103]);
    // A checkout that is not finished yet: the backend posts it again later.
    const draft = e.paddle.buy(PADDLE_PRICES.monthly).transaction;
    draft.status = "ready"; draft.subscription_id = null;
    expect(await code(await e.receipt({ app_user_id: "u", fetch_token: draft.id }))).toEqual([503, 7101]);
    draft.status = "canceled";
    expect(await code(await e.receipt({ app_user_id: "u", fetch_token: draft.id }))).toEqual([400, 7103]);
    e.paddle.outage = 429;
    expect(await code(await e.receipt({ app_user_id: "u", fetch_token: "sub_01any0000000000000000000000" }))).toEqual([503, 7101]);
    e.paddle.outage = null;
    // A revoked key: Paddle answers 403 invalid_token. The app's credentials are marked failing.
    await e.setCredentials({ paddle_api_key: FAKE_PADDLE_LIMITED_KEY.replace("limited", "revoked0") });
    expect(await code(await e.receipt({ app_user_id: "u", fetch_token: "sub_01any0000000000000000000000" }))).toEqual([500, 7101]);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(app).toMatchObject({ credentialsStatus: "failing" });
    expect(app!.credentialsError).toMatch(/Paddle|Invalid or revoked/);
    await e.setCredentials({});
    expect(await code(await e.receipt({ app_user_id: "u", fetch_token: "sub_01any0000000000000000000000" }))).toEqual([500, 7101]);
  });

  it("a live key reads the live API", async () => {
    e.paddle.environment = "live";
    e.paddle.keys = new Set([FAKE_PADDLE_LIVE_KEY]);
    await e.setCredentials({ paddle_api_key: FAKE_PADDLE_LIVE_KEY, paddle_webhook_secret: e.paddle.secret });
    const { res } = await bought();
    expect(CustomerInfoSchema.parse(await res.json()).subscriber.subscriptions[PADDLE_PRICES.monthly]!.is_sandbox).toBe(false);
    expect(e.paddle.calls.some((c) => c.url.startsWith("https://api.paddle.com/subscriptions/"))).toBe(true);
    expect((await e.events("INITIAL_PURCHASE"))[0]!.environment).toBe("PRODUCTION");
  });
});

describe("Paddle notifications", () => {
  it("refuses bodies without a saved secret, without or with a bad signature, and keeps them with the reason", async () => {
    const { sub: s } = await bought();
    const r = e.paddle.renew(s.id);
    const w = await e.paddle.sign(r.events[0]!);
    expect((await e.notify(w.body)).status).toBe(400);
    expect((await e.notify(w.body, { "paddle-signature": (await e.paddle.sign(r.events[0]!, { secret: "pdl_ntfset_wrong" })).signature })).status).toBe(400);
    expect((await e.notify(w.body.replace('"completed"', '"canceled"'), { "paddle-signature": w.signature })).status).toBe(400);
    const stored = await e.h.db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.appId, e.appId));
    expect(stored).toHaveLength(3);
    expect(stored.every((n) => n.id.includes("_rejected_") && /^rejected: /.test(n.error ?? ""))).toBe(true);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
    await e.setCredentials({ paddle_api_key: FAKE_PADDLE_KEY });
    expect((await e.notify(w.body, { "paddle-signature": w.signature })).status).toBe(400);
  });

  it("renewal, redelivery, trial conversion and the store_settings status", async () => {
    const { sub: s } = await bought();
    move(30);
    const r = e.paddle.renew(s.id);
    const res = await deliver(r.events);
    expect(res.map((x) => x.status)).toEqual([200, 200]);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL"]);
    expect((await e.events("RENEWAL"))[0]).toMatchObject({ transaction_id: r.transaction.id, price: 9.99, purchased_at_ms: at(30).getTime() });
    // Redelivered: processed once.
    const again = await e.paddle.sign(r.events[0]!);
    expect(await (await e.notify(again.body, { "paddle-signature": again.signature })).json()).toEqual({ status: "duplicate" });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL"]);
    const st = await (await e.v2("GET", `/apps/${e.appId}/store_settings`)).json();
    expect(st).toMatchObject({ notification_url: `http://localhost/v1/notifications/paddle/${e.appId}`, notification_status: "ready", paddle: { environment: "sandbox", app_user_id_source: "custom_data" } });
    expect(st.credentials.paddle_api_key).toEqual({ configured: true, environment: "sandbox", last4: FAKE_PADDLE_KEY.slice(-4) });
    expect(JSON.stringify(st)).not.toContain(FAKE_PADDLE_KEY);
  });

  it("a trial converts into a paid period: RENEWAL with is_trial_conversion", async () => {
    const b = e.paddle.buy("pri_01trial000000000000000000");
    await e.receipt({ app_user_id: "trial_user", fetch_token: b.subscription!.id });
    move(7);
    await deliver(e.paddle.renew(b.subscription!.id).events);
    const [ev] = await e.events("RENEWAL");
    expect(ev).toMatchObject({ is_trial_conversion: true, period_type: "NORMAL", price: 9.99 });
  });

  it("past due is a billing issue with RevenueCat's 30-day grace period; recovery is a renewal", async () => {
    const { sub: s } = await bought();
    move(30);
    await deliver(e.paddle.renew(s.id, { fail: true }).events);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "BILLING_ISSUE"]);
    const row = await sub(s.id);
    expect(row.billingIssuesDetectedAt).toEqual(at(30));
    expect(row.gracePeriodExpiresDate).toEqual(at(60));
    expect(row.expiresDate).toEqual(at(30));
    move(35);
    const ci = await info("web_user_1");
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-31T12:00:00Z");
    await deliver(e.paddle.recover(s.id).events);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "BILLING_ISSUE", "RENEWAL"]);
    expect((await sub(s.id)).billingIssuesDetectedAt).toBeNull();
  });

  it("dunning that gives up ends the subscription with a billing error", async () => {
    const { sub: s } = await bought();
    move(30);
    await deliver(e.paddle.renew(s.id, { fail: true }).events);
    move(45);
    await deliver(e.paddle.cancelNow(s.id));
    const types = await eventTypes(e);
    expect(types).toEqual(["INITIAL_PURCHASE", "BILLING_ISSUE", "CANCELLATION", "EXPIRATION"]);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "BILLING_ERROR" });
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "BILLING_ERROR" });
  });

  it("a scheduled cancellation, taken back, then cancelled for good", async () => {
    const { sub: s } = await bought();
    move(5);
    await deliver(e.paddle.scheduleCancel(s.id));
    move(6);
    await deliver(e.paddle.unscheduleChange(s.id));
    move(7);
    await deliver(e.paddle.scheduleCancel(s.id));
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "UNCANCELLATION", "CANCELLATION"]);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "UNSUBSCRIBE" });
    move(30);
    await deliver(e.paddle.cancelNow(s.id));
    await expire();
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "UNCANCELLATION", "CANCELLATION", "EXPIRATION"]);
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
  });

  it("a pause with a resume date, then the resume", async () => {
    const { sub: s } = await bought();
    move(30);
    await deliver(e.paddle.pause(s.id, at(60)));
    await expire();
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "SUBSCRIPTION_PAUSED", "EXPIRATION"]);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "SUBSCRIPTION_PAUSED" });
    move(60);
    await deliver(e.paddle.resume(s.id).events);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "SUBSCRIPTION_PAUSED", "EXPIRATION", "RENEWAL"]);
  });

  it("a plan change in the period is PRODUCT_CHANGE; the proration is not a new period", async () => {
    const { sub: s, transaction } = await bought();
    move(10);
    await deliver(e.paddle.changePlan(s.id, PADDLE_PRICES.annual).events);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "PRODUCT_CHANGE"]);
    const row = await sub(s.id);
    expect(row).toMatchObject({ productIdentifier: PADDLE_PRICES.annual, storeTransactionId: transaction.id, purchaseDate: T0 });
  });

  it("refunds: a full approved refund ends access, partial and pending ones change nothing, a reversed chargeback restores it", async () => {
    const { sub: s, transaction } = await bought();
    move(3);
    await deliver(e.paddle.refund(transaction.id, { partial: true }).events);
    const pending = e.paddle.refund(transaction.id, { status: "pending_approval" });
    await deliver(pending.events);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
    move(4);
    await deliver(e.paddle.approve(pending.adjustment.id));
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION"]);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -9.99 });
    expect((await sub(s.id)).refundedAt).toEqual(at(4));
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-09-05T12:00:00Z");
    // A chargeback reversal gives the period back.
    const rev = e.paddle.refund(transaction.id, { action: "chargeback" });
    rev.adjustment.action = "chargeback_reverse";
    await deliver([e.paddle.ev("adjustment.updated", rev.adjustment)]);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "REFUND_REVERSED"]);
    expect((await info("web_user_1")).subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
  });

  it("refunds a one-time purchase", async () => {
    const life = e.paddle.buy(PADDLE_PRICES.lifetime);
    await e.receipt({ app_user_id: "buyer", fetch_token: life.transaction.id });
    move(2);
    await deliver(e.paddle.refund(life.transaction.id).events);
    expect(await eventTypes(e)).toEqual(["NON_RENEWING_PURCHASE", "CANCELLATION"]);
    expect((await info("buyer")).subscriber.entitlements.pro!.expires_date).toBe("2026-09-03T12:00:00Z");
  });

  it("unknown purchases are ignored, or tracked under the custom_data key or an anonymous id", async () => {
    const b = e.paddle.buy(PADDLE_PRICES.monthly, { customData: { user_ref: "from_custom_data" } });
    expect(await (await deliver(b.events))[0]!.json()).toEqual({ status: "unknown_purchase" });
    expect(await e.h.db.select().from(schema.subscriptions)).toHaveLength(0);
    await e.setCredentials({ paddle_api_key: FAKE_PADDLE_KEY, paddle_webhook_secret: e.paddle.secret, track_new_purchases: true, app_user_id_custom_data_key: "user_ref" });
    const c = e.paddle.buy(PADDLE_PRICES.monthly, { customData: { user_ref: "from_custom_data" } });
    await deliver(c.events);
    expect((await e.events("INITIAL_PURCHASE"))[0]).toMatchObject({ app_user_id: "from_custom_data" });
    await e.setCredentials({ paddle_api_key: FAKE_PADDLE_KEY, paddle_webhook_secret: e.paddle.secret, track_new_purchases: true, app_user_id_source: "anonymous" });
    const d = e.paddle.buy(PADDLE_PRICES.annual, { customData: { user_ref: "ignored" } });
    await deliver(d.events);
    expect((await e.events("INITIAL_PURCHASE"))[1]!.app_user_id).toMatch(/^\$RCAnonymousID:/);
  });

  it("simulated events count as received and change nothing; other events are ignored; outages answer 500", async () => {
    const { sub: s } = await bought();
    const sim = { ...e.paddle.ev("subscription.updated", s), event_id: "ntfsimevt_01abc" };
    delete (sim as Record<string, unknown>).notification_id;
    expect(await (await deliver([sim]))[0]!.json()).toEqual({ status: "simulated" });
    expect(await (await deliver([e.paddle.ev("customer.updated", { id: "ctm_01x" })]))[0]!.json()).toEqual({ status: "ignored" });
    move(30);
    const r = e.paddle.renew(s.id);
    e.paddle.outage = 503;
    const res = await deliver([r.events[0]!]);
    expect(res[0]!.status).toBe(500);
    e.paddle.outage = null;
    const w = await e.paddle.sign(r.events[0]!);
    expect((await e.notify(w.body, { "paddle-signature": w.signature })).status).toBe(200);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL"]);
  });

  it("forwards each verified body with its signature to notification_forward_url", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/paddle" }).where(eq(schema.apps.id, e.appId));
    const { sub: s } = await bought();
    move(30);
    const ev = e.paddle.renew(s.id).events[0]!;
    const w = await e.paddle.sign(ev);
    await e.notify(w.body, { "paddle-signature": w.signature });
    await flushStoreForwards();
    expect(e.forwarded).toHaveLength(1);
    expect(e.forwarded[0]).toMatchObject({ url: "https://hooks.example.com/paddle", body: w.body });
    expect(e.forwarded[0]!.headers.get("paddle-signature")).toBe(w.signature);
  });

  it("the expiration worker ends a scheduled cancellation when its date passes", async () => {
    const { sub: s } = await bought();
    await deliver(e.paddle.scheduleCancel(s.id));
    move(31);
    await tick(e.h.db, e.h.now(), (async () => new Response("{}")) as unknown as typeof fetch);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]);
  });
});

describe("Paddle apps through REST v2", () => {
  it("creates a Paddle app with the key and secret sealed, RevenueCat's shape, and checks the fields", async () => {
    const res = await e.v2("POST", "/apps", { name: "Web", type: "paddle", paddle: { paddle_api_key: FAKE_PADDLE_KEY, paddle_webhook_secret: "pdl_ntfset_01abc_SecretValue" } });
    expect(res.status).toBe(201);
    const app = await res.json();
    expect(app).toMatchObject({ type: "paddle", paddle: { paddle_is_sandbox: true, paddle_api_key: null } });
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    expect(row!.credentials).toEqual({});
    expect(JSON.stringify(row)).not.toContain(FAKE_PADDLE_KEY);
    expect(await unseal(row!.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ paddle_api_key: FAKE_PADDLE_KEY, paddle_webhook_secret: "pdl_ntfset_01abc_SecretValue" });
    const keys = await (await e.v2("GET", `/apps/${app.id}/public_api_keys`)).json();
    expect(keys.items[0].key).toMatch(/^pdl_/);
    const bad = async (paddle: Record<string, unknown>) => (await e.v2("POST", "/apps", { name: "x", type: "paddle", paddle })).status;
    expect(await bad({ paddle_api_key: "test_0123456789abcdef" })).toBe(400);
    expect(await bad({ paddle_api_key: "pdl_live_apikey_short" })).toBe(400);
    expect(await bad({ paddle_webhook_secret: "whsec_123" })).toBe(400);
    expect(await bad({ app_user_id_source: "metadata" })).toBe(400);
  });

  it("verify_credentials: valid, a key without read access, a revoked key, Paddle down", async () => {
    const check = async (paddle?: Record<string, unknown>) => (await e.v2("POST", `/apps/${e.appId}/actions/verify_credentials`, paddle ? { paddle } : {})).json();
    expect(await check()).toMatchObject({ status: "valid", environment: "sandbox" });
    expect(await check({ paddle_api_key: FAKE_PADDLE_LIMITED_KEY })).toMatchObject({ status: "invalid", message: expect.stringMatching(/read access/) });
    expect(await check({ paddle_api_key: FAKE_PADDLE_LIVE_KEY })).toMatchObject({ status: "invalid", message: expect.stringMatching(/rejected the key/) });
    e.paddle.outage = 500;
    expect(await check()).toMatchObject({ status: "unreachable" });
  });

  it("Apply in Paddle creates the notification destination once, seals its secret, and later events verify with it", async () => {
    await e.setCredentials({ paddle_api_key: FAKE_PADDLE_KEY });
    const r1 = await (await e.v2("POST", `/apps/${e.appId}/actions/apply_notification_settings`)).json();
    expect(r1).toMatchObject({ notification_setting_id: expect.stringMatching(/^ntfset_/), destination: `http://localhost/v1/notifications/paddle/${e.appId}`, secret_saved: true });
    expect(r1.subscribed_events).toEqual(expect.arrayContaining(["subscription.updated", "transaction.completed", "adjustment.created"]));
    const r2 = await (await e.v2("POST", `/apps/${e.appId}/actions/apply_notification_settings`)).json();
    expect(r2.notification_setting_id).toBe(r1.notification_setting_id);
    expect(e.paddle.notificationSettings.size).toBe(1);
    const { sub: s } = await bought();
    move(30);
    expect((await deliver(e.paddle.renew(s.id).events)).map((x) => x.status)).toEqual([200, 200]);
    expect(await eventTypes(e)).toContain("RENEWAL");
    const st = await (await e.v2("GET", `/apps/${e.appId}/store_settings`)).json();
    expect(st.credentials.paddle_webhook_secret).toEqual({ configured: true });
    expect(st.paddle.notification_setting_id).toBe(r1.notification_setting_id);
  });

  it("lists prices for Import products and imports them", async () => {
    const list = await (await e.v2("GET", `/apps/${e.appId}/store_products`)).json();
    expect(list.store).toBe("paddle");
    const byId = Object.fromEntries(list.items.map((i: Record<string, unknown>) => [i.store_identifier, i]));
    expect(byId[PADDLE_PRICES.annual]).toMatchObject({ type: "subscription", duration: "P1Y", display_name: "Scanner Pro (Annual)", in_catalog: true, price: { amount_micros: 79_990_000, currency: "USD" } });
    expect(byId["pri_01trial000000000000000000"]).toMatchObject({ in_catalog: false, note: "Free trial: 7 days." });
    const imp = await e.v2("POST", `/apps/${e.appId}/store_products/actions/import`, { store_identifiers: ["pri_01trial000000000000000000"] });
    expect(imp.status).toBe(201);
    expect((await imp.json()).created[0]).toMatchObject({ store_identifier: "pri_01trial000000000000000000", type: "subscription", subscription: { duration: "P1M" } });
  });

  it("the management link is an authenticated customer portal session", async () => {
    const { sub: s } = await bought();
    const row = await sub(s.id);
    const r = await (await e.v2("GET", `/subscriptions/${row.id}/authenticated_management_url`)).json();
    expect(r.management_url).toMatch(/^https:\/\/sandbox-customer-portal\.paddle\.com\/.*action=overview/);
  });
});

describe("Paddle receipts keep what notifications recorded", () => {
  it("a re-post after a refund keeps the refund", async () => {
    const { sub: s, transaction } = await bought();
    move(2);
    await deliver(e.paddle.refund(transaction.id).events);
    await e.receipt({ app_user_id: "web_user_1", fetch_token: s.id });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION"]);
    expect((await sub(s.id)).refundedAt).toEqual(at(2));
    expect(DAY).toBeGreaterThan(0);
  });
});
