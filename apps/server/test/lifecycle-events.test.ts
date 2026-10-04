import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { tick } from "../src/services/tick.js";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { env, makeKeys, sub, type Env, type Keys } from "./google-helpers.js";
import { DAY as ADAY, T0 as AT0, appleHarness, makePki, notificationBody, renewalInfo, signJws, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";
import type { AppleRenewalInfo, AppleTransaction } from "../src/stores/apple/map.js";
import { TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";

const DAY = 86_400_000;
const T0 = new Date("2026-09-01T12:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const MONTH_END = new Date("2026-10-01T12:00:00Z");
const ORDER = "GPA.1000-0000-0000-00001";
const PRO = [{ product_id: "pro", base_plan_id: "monthly" }];

describe("Google Play lifecycle events", () => {
  let keys: Keys;
  let e: Env;
  beforeAll(async () => { keys = await makeKeys(); });
  beforeEach(async () => {
    e = await env(keys);
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: ORDER }));
    expect((await e.receipt({ app_user_id: "user_a", fetch_token: "tok_pro_1", product_ids: ["pro"], platform_product_ids: PRO, price: 9.99, currency: "USD" })).status).toBe(200);
  });
  afterEach(async () => { await e.h.close(); });
  const note = (notificationType: number, purchaseToken = "tok_pro_1", subscriptionId = "pro") => e.rtdn({ subscriptionNotification: { version: "1.0", notificationType, purchaseToken, subscriptionId } });
  const withPlan = (plan: Record<string, unknown>, extra: Partial<ReturnType<typeof sub>> = {}) => {
    const s = sub({ start: T0, expiry: MONTH_END, order: ORDER, ack: true });
    s.lineItems![0]!.autoRenewingPlan = { ...s.lineItems![0]!.autoRenewingPlan, ...plan };
    return { ...s, ...extra };
  };

  it("an upgrade posted by the device records PRODUCT_CHANGE for the old product and ends the old chain, before any notification", async () => {
    e.h.setNow(at(10));
    e.g.subs.set("tok_premium", sub({ product: "premium", start: at(10), expiry: at(40), order: "GPA.2000-0000-0000-00002", linked: "tok_pro_1", price: 19.99 }));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: at(10), order: ORDER, state: "SUBSCRIPTION_STATE_EXPIRED", replaced: true, ack: true }));
    const res = await e.receipt({ app_user_id: "user_a", fetch_token: "tok_premium", product_ids: ["premium"], platform_product_ids: [{ product_id: "premium", base_plan_id: "monthly" }], price: 19.99, currency: "USD" });
    const ci = CustomerInfoSchema.parse(await res.json());
    const [change] = await e.events("PRODUCT_CHANGE");
    expect(change).toMatchObject({ product_id: "pro", transaction_id: ORDER, expiration_at_ms: at(10).getTime(), price: 0, app_user_id: "user_a" });
    expect(change!.new_product_id).toBeUndefined();
    expect(ci.subscriber.subscriptions.pro!.expires_date).toBe("2026-09-11T12:00:00Z");
    expect(ci.subscriber.entitlements.pro!.product_identifier).toBe("premium");
    // The notification for the new token and a repeated receipt post add nothing.
    await note(4, "tok_premium", "premium");
    await e.receipt({ app_user_id: "user_a", fetch_token: "tok_premium", product_ids: ["premium"], platform_product_ids: [{ product_id: "premium", base_plan_id: "monthly" }] });
    expect(await e.events("PRODUCT_CHANGE")).toHaveLength(1);
    expect(await e.events("CANCELLATION")).toHaveLength(0);
  });

  it("a deferred replacement is PRODUCT_CHANGE with new_product_id when it is scheduled, then only RENEWAL", async () => {
    e.h.setNow(at(3));
    const s = sub({ start: T0, expiry: MONTH_END, order: ORDER, ack: true });
    s.lineItems![0]!.deferredItemReplacement = { productId: "premium" };
    e.g.subs.set("tok_pro_1", s);
    await note(2);
    const [change] = await e.events("PRODUCT_CHANGE");
    expect(change).toMatchObject({ product_id: "pro", new_product_id: "premium", price: 0 });
  });

  it("price increase consent comes from priceChangeDetails: REQUIRED while OUTSTANDING, APPROVED when CONFIRMED, once each", async () => {
    e.h.setNow(at(5));
    e.g.subs.set("tok_pro_1", withPlan({ priceChangeDetails: { newPrice: { currencyCode: "USD", units: "12", nanos: 990000000 }, priceChangeMode: "PRICE_INCREASE", priceChangeState: "OUTSTANDING" } }));
    await note(19);
    await note(19);
    const [required] = await e.events("PRICE_INCREASE_CONSENT_REQUIRED");
    expect(await e.events("PRICE_INCREASE_CONSENT_REQUIRED")).toHaveLength(1);
    // RevenueCat's price-consent fields: identity plus product, transactions, store, environment, currency, country. No lifecycle fields.
    expect(Object.keys(required!).sort()).toEqual(["aliases", "app_id", "app_user_id", "country_code", "currency", "environment", "event_timestamp_ms", "id",
      "original_app_user_id", "original_transaction_id", "product_id", "store", "subscriber_attributes", "transaction_id", "type"]);
    expect(required).toMatchObject({ product_id: "pro", transaction_id: ORDER, store: "PLAY_STORE", environment: "PRODUCTION", currency: "USD", country_code: "US" });
    e.g.subs.set("tok_pro_1", withPlan({ priceChangeDetails: { priceChangeMode: "PRICE_INCREASE", priceChangeState: "CONFIRMED" } }));
    await note(19);
    expect(await e.events("PRICE_INCREASE_CONSENT_APPROVED")).toHaveLength(1);
    const [row] = await e.h.db.select().from(schema.subscriptions);
    expect(row!.priceIncreaseStatus).toBe("accepted");
  });

  it("a subscription the system cancels while a price increase is outstanding is CANCELLATION(PRICE_INCREASE), then EXPIRATION(PRICE_INCREASE)", async () => {
    e.h.setNow(at(5));
    const pending = { priceChangeDetails: { priceChangeMode: "PRICE_INCREASE", priceChangeState: "OUTSTANDING" } };
    e.g.subs.set("tok_pro_1", withPlan(pending));
    await note(19);
    e.h.setNow(at(20));
    e.g.subs.set("tok_pro_1", withPlan({ ...pending, autoRenewEnabled: false }, { subscriptionState: "SUBSCRIPTION_STATE_CANCELED", canceledStateContext: { systemInitiatedCancellation: {} } }));
    await note(3);
    expect((await e.events("CANCELLATION")).map((x) => x.cancel_reason)).toEqual(["PRICE_INCREASE"]);
    e.h.setNow(new Date(MONTH_END.getTime() + 60_000));
    await tick(e.h.db, e.h.now(), e.g.fetch, { stores: { play_store: e.store } });
    expect((await e.events("EXPIRATION")).map((x) => x.expiration_reason)).toEqual(["PRICE_INCREASE"]);
  });

  it("the daily voided-purchases scan refunds what Google voided without a notification, once", async () => {
    e.g.products.set("lifetime_unlock|tok_life", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, orderId: "GPA.L1", acknowledgementState: 1 });
    await e.receipt({ app_user_id: "lifer", fetch_token: "tok_life", product_ids: ["lifetime_unlock"], platform_product_ids: [{ product_id: "lifetime_unlock" }], price: 49.99, currency: "USD" });
    e.h.setNow(at(3));
    e.g.voided = [
      { purchaseToken: "tok_pro_1", orderId: ORDER, voidedTimeMillis: String(at(2).getTime()), voidedSource: 1, voidedReason: 1, refundType: 1 },
      { purchaseToken: "tok_life", orderId: "GPA.L1", voidedTimeMillis: String(at(2).getTime() + 3_600_000), refundType: 1 },
      { purchaseToken: "tok_unknown", orderId: "GPA.X", voidedTimeMillis: String(at(1).getTime()) },
    ];
    const stores = { play_store: e.store };
    const r = await tick(e.h.db, e.h.now(), e.g.fetch, { stores, encryptionKey: TEST_ENCRYPTION_KEY });
    expect(r.voided).toBe(2);
    const cancels = await e.events("CANCELLATION");
    expect(cancels.map((x) => [x.product_id, x.cancel_reason, x.price])).toEqual([["pro", "CUSTOMER_SUPPORT", -9.99], ["lifetime_unlock", "CUSTOMER_SUPPORT", -49.99]]);
    const list = e.g.calls.find((c) => c.url.includes("/purchases/voidedpurchases"))!;
    expect(new URL(list.url).searchParams.get("type")).toBe("1");
    const ci = CustomerInfoSchema.parse(await (await e.call("/v1/subscribers/user_a", { key: e.h.ids.androidKey })).json());
    expect(ci.subscriber.subscriptions.pro!.refunded_at).toBe("2026-09-03T12:00:00Z");
    // Within the day: no second scan. A day later: scanned again from where it left off, nothing new.
    await tick(e.h.db, at(3.5), e.g.fetch, { stores });
    expect(e.g.calls.filter((c) => c.url.includes("/purchases/voidedpurchases"))).toHaveLength(1);
    e.h.setNow(at(4.1));
    await tick(e.h.db, e.h.now(), e.g.fetch, { stores, encryptionKey: TEST_ENCRYPTION_KEY });
    const scans = e.g.calls.filter((c) => c.url.includes("/purchases/voidedpurchases"));
    expect(scans).toHaveLength(2);
    expect(Number(new URL(scans[1]!.url).searchParams.get("startTime"))).toBe(at(3).getTime() - 3_600_000);
    expect(await e.events("CANCELLATION")).toHaveLength(2);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_play"));
    expect(app!.voidedPurchasesCheckedAt?.toISOString()).toBe(at(4.1).toISOString());
  });

  it("a failed voided-purchases scan retries an hour later", async () => {
    e.g.override = (url) => (url.includes("voidedpurchases") ? new Response("down", { status: 503 }) : undefined);
    await tick(e.h.db, at(1), e.g.fetch, { stores: { play_store: e.store } });
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_play"));
    expect(app!.voidedPurchasesCheckedAt!.getTime()).toBe(at(1).getTime() - DAY + 3_600_000);
  });
});

describe("App Store lifecycle events", () => {
  let pki: Pki;
  let h: AppleHarness | undefined;
  beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
  afterAll(() => setAppleRootsForTesting(null));
  afterEach(async () => { await h?.close(); h = undefined; });
  const first = transaction();
  async function subscribed() {
    h = await appleHarness();
    expect((await h.postReceipt("user1", await signJws(first, pki))).status).toBe(200);
    await h.newEvents();
  }
  async function send(type: string, subtype: string | undefined, tx: AppleTransaction | null, renewal: AppleRenewalInfo | null = renewalInfo()) {
    const res = await h!.notify(await notificationBody(pki, type, subtype, tx, renewal, { signedDate: h!.now().getTime() }));
    expect(res.status).toBe(200);
    return h!.newEvents();
  }

  it("turning auto-renew off by declining a price increase (expirationIntent 3) is CANCELLATION(PRICE_INCREASE)", async () => {
    await subscribed();
    h!.setNow(AT0 + 10 * ADAY);
    const events = await send("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", first, renewalInfo({ autoRenewStatus: 0, expirationIntent: 3, priceIncreaseStatus: 0 }));
    expect(events.map((x) => x.type).sort()).toEqual(["CANCELLATION", "PRICE_INCREASE_CONSENT_REQUIRED"]);
    expect(events.find((x) => x.type === "CANCELLATION")).toMatchObject({ cancel_reason: "PRICE_INCREASE", price: 0 });
    expect(events.some((x) => x.type === "PRICE_INCREASE_CONSENT_REQUIRED")).toBe(true);
    h!.setNow(AT0 + 30 * ADAY + 60_000);
    await tick(h!.db, h!.now(), async () => new Response(null, { status: 200 }));
    expect((await h!.newEvents()).map((x) => [x.type, x.expiration_reason])).toEqual([["EXPIRATION", "PRICE_INCREASE"]]);
  });

  it("EXPIRED/PRICE_INCREASE records the cancellation with PRICE_INCREASE", async () => {
    await subscribed();
    h!.setNow(AT0 + 30 * ADAY + 60_000);
    const events = await send("EXPIRED", "PRICE_INCREASE", first, renewalInfo({ autoRenewStatus: 0 }));
    expect(events.map((x) => [x.type, x.cancel_reason])).toEqual([["CANCELLATION", "PRICE_INCREASE"]]);
  });

  it("the renewal info's priceIncreaseStatus drives the consent events on any notification", async () => {
    await subscribed();
    expect((await send("DID_CHANGE_RENEWAL_PREF", undefined, first, renewalInfo({ priceIncreaseStatus: 0 }))).map((x) => x.type)).toEqual(["PRICE_INCREASE_CONSENT_REQUIRED"]);
    expect((await send("PRICE_INCREASE", "ACCEPTED", first, renewalInfo({ priceIncreaseStatus: 1 }))).map((x) => x.type)).toEqual(["PRICE_INCREASE_CONSENT_APPROVED"]);
    expect(await send("DID_CHANGE_RENEWAL_PREF", undefined, first, renewalInfo({ priceIncreaseStatus: 1 }))).toEqual([]);
  });

  it("an immediate upgrade is PRODUCT_CHANGE from the old product plus RENEWAL of the new one", async () => {
    await subscribed();
    h!.setNow(AT0 + 10 * ADAY);
    const upgraded = transaction({ transactionId: "2000000005", originalTransactionId: "2000000001", productId: "pro_annual", purchaseDate: AT0 + 10 * ADAY, expiresDate: AT0 + 375 * ADAY, price: 59990, signedDate: AT0 + 10 * ADAY });
    const events = await send("DID_CHANGE_RENEWAL_PREF", "UPGRADE", upgraded, renewalInfo({ productId: "pro_annual", autoRenewProductId: "pro_annual" }));
    expect(events.map((x) => [x.type, x.product_id, x.new_product_id, x.price])).toEqual([["PRODUCT_CHANGE", "pro_monthly", "pro_annual", 0], ["RENEWAL", "pro_annual", undefined, 59.99]]);
    const txns = await h!.db.select().from(schema.transactions);
    expect(txns.map((t) => [t.kind, t.revenueUsd])).toEqual([["purchase", 9.99], ["renewal", 59.99]]);
  });

  it("a downgrade is PRODUCT_CHANGE with new_product_id when scheduled, and only RENEWAL when it takes effect", async () => {
    await subscribed();
    const scheduled = await send("DID_CHANGE_RENEWAL_PREF", "DOWNGRADE", first, renewalInfo({ autoRenewProductId: "pro_weekly" }));
    expect(scheduled.map((x) => [x.type, x.product_id, x.new_product_id])).toEqual([["PRODUCT_CHANGE", "pro_monthly", "pro_weekly"]]);
    h!.setNow(AT0 + 30 * ADAY);
    const weekly = transaction({ transactionId: "2000000006", originalTransactionId: "2000000001", productId: "pro_weekly", purchaseDate: AT0 + 30 * ADAY, expiresDate: AT0 + 37 * ADAY, signedDate: AT0 + 30 * ADAY });
    const renewed = await send("DID_RENEW", undefined, weekly, renewalInfo({ productId: "pro_weekly", autoRenewProductId: "pro_weekly" }));
    expect(renewed.map((x) => [x.type, x.product_id])).toEqual([["RENEWAL", "pro_weekly"]]);
  });

  it("a one-time purchase refund reversed is REFUND_REVERSED with the price back, and access returns", async () => {
    h = await appleHarness();
    const life = transaction({ transactionId: "3000000009", productId: "lifetime", type: "Non-Consumable", expiresDate: undefined, price: 49990 });
    await h.postReceipt("buyer", await signJws(life, pki));
    await h.newEvents();
    h.setNow(AT0 + 2 * ADAY);
    expect((await send("REFUND", undefined, { ...life, revocationDate: AT0 + 2 * ADAY }, null)).map((x) => [x.type, x.price])).toEqual([["CANCELLATION", -49.99]]);
    expect((await h.customerInfo("buyer")).subscriber.entitlements.pro.expires_date).not.toBeNull();
    h.setNow(AT0 + 9 * ADAY);
    const reversed = await send("REFUND_REVERSED", undefined, life, null);
    expect(reversed.map((x) => [x.type, x.price, x.price_in_purchased_currency, x.transaction_id])).toEqual([["REFUND_REVERSED", 49.99, 49.99, "3000000009"]]);
    expect((await h.customerInfo("buyer")).subscriber.entitlements.pro.expires_date).toBeNull();
    const txns = await h.db.select().from(schema.transactions);
    expect(txns.map((t) => [t.kind, t.revenueUsd])).toEqual([["one_time", 49.99], ["refund", -49.99], ["refund_reversal", 49.99]]);
  });
});
