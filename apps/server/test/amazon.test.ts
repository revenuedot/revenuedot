import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema, ErrorSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { AmazonRvsClient } from "../src/stores/amazon/api.js";
import { termDuration } from "../src/stores/amazon/map.js";
import { clearSnsCertCache, stringToSign } from "../src/stores/amazon/sns.js";
import { flushStoreForwards } from "../src/stores/forward.js";
import { tick } from "../src/services/tick.js";
import { secretKeyFrom, unseal } from "../src/services/secrets.js";
import { sealStoreSecrets } from "../src/services/store-secrets.js";
import { TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";
import { AMZ_USER, at, CERT_URL, env, makeSnsKeys, PKG, receipt, SECRET, snsMessage, T0, TOPIC, type Env, type SnsKeys } from "./amazon-helpers.js";

let keys: SnsKeys;
let e: Env;
beforeAll(async () => { keys = await makeSnsKeys(); });
beforeEach(async () => { clearSnsCertCache(); e = await env(keys); });
afterEach(async () => { await e?.h.close(); });

const RID = receipt().receiptId;
const buy = (extra: Record<string, unknown> = {}, user = "fire_user") =>
  e.receipt({ app_user_id: user, fetch_token: RID, product_ids: ["pro.monthly"], price: 4.99, currency: "USD", ...extra });
const info = async (user: string) => CustomerInfoSchema.parse(await (await e.call(`/v1/subscribers/${user}`, { key: e.key })).json());
const txns = () => e.h.db.select().from(schema.transactions).where(eq(schema.transactions.store, "amazon"));

describe("RVS client", () => {
  it("calls RVS with the shared key, user and receipt, and falls back to the cloud sandbox for receipts production does not know", async () => {
    e.a.put(receipt({ receiptId: "r-sbx" }), { env: "sandbox" });
    const client = new AmazonRvsClient({ fetch: e.a.fetch });
    const { receipt: r, sandbox } = await client.verify({ credentials: { shared_secret: SECRET } }, AMZ_USER, "r-sbx");
    expect(sandbox).toBe(true);
    expect(r.termSku).toBe("pro.monthly");
    expect(e.a.rvsCalls().map((c) => c.url)).toEqual([
      `https://appstore-sdk.amazon.com/version/1.0/verifyReceiptId/developer/${encodeURIComponent(SECRET)}/user/${encodeURIComponent(AMZ_USER)}/receiptId/r-sbx`,
      `https://appstore-sdk.amazon.com/sandbox/version/1.0/verifyReceiptId/developer/${encodeURIComponent(SECRET)}/user/${encodeURIComponent(AMZ_USER)}/receiptId/r-sbx`,
    ]);
  });

  it("reads Amazon's term names as ISO durations", () => {
    expect(["1 Week", "2 Weeks", "1 Month", "3 Months", "6 Months", "1 Year", "Quarterly", "Bi-Weekly", "SemiAnnually", "nonsense"].map(termDuration))
      .toEqual(["P1W", "P2W", "P1M", "P3M", "P6M", "P1Y", "P3M", "P2W", "P6M", null]);
  });
});

describe("GET /v1/receipts/amazon/{store_user_id}/{receipt_id}", () => {
  it("answers Amazon's receipt data, the term SKU included, for a receipt id with / = and :", async () => {
    const r = e.a.put(receipt({ receiptId: "hQ8uPyAd/wptg=:3:24" }));
    const res = await e.call(`/v1/receipts/amazon/${encodeURIComponent(AMZ_USER)}/hQ8uPyAd/wptg=:3:24`, { key: e.key, headers: { "X-Platform": "amazon" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-revenuecat-request-time")).toMatch(/^\d+$/);
    expect(await res.json()).toEqual(r);
  });

  it("an unknown receipt is 400 7103, a non-Amazon key 7662, Amazon down 503 7101, no shared key 500 7101", async () => {
    let res = await e.call(`/v1/receipts/amazon/${AMZ_USER}/nope`, { key: e.key });
    expect([res.status, ErrorSchema.parse(await res.json()).code]).toEqual([400, 7103]);
    res = await e.call(`/v1/receipts/amazon/${AMZ_USER}/nope`, { key: e.h.ids.androidKey });
    expect([res.status, (await res.json()).code]).toEqual([400, 7662]);
    e.a.override = (url) => (url.includes("verifyReceiptId") ? new Response("busy", { status: 503 }) : undefined);
    res = await e.call(`/v1/receipts/amazon/${AMZ_USER}/${RID}`, { key: e.key });
    expect([res.status, (await res.json()).code]).toEqual([503, 7101]);
    e.a.override = null;
    await e.setCredentials({});
    res = await e.call(`/v1/receipts/amazon/${AMZ_USER}/${RID}`, { key: e.key });
    const b = await res.json();
    expect([res.status, b.code]).toEqual([500, 7101]);
    expect(b.message).toMatch(/shared key/);
  });
});

describe("POST /v1/receipts with an Amazon receipt", () => {
  it("verifies a subscription with RVS and records it with the term SKU, the posted price and RevenueCat's events", async () => {
    e.a.put(receipt());
    const res = await buy();
    expect(res.status).toBe(200);
    const body = await res.json();
    const ci = CustomerInfoSchema.parse(body);
    expect(ci.subscriber.subscriptions["pro.monthly"]).toMatchObject({ store: "amazon", period_type: "normal", is_sandbox: false,
      purchase_date: "2026-09-01T12:00:00Z", expires_date: "2026-10-01T12:00:00Z", store_transaction_id: RID });
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: "pro.monthly", expires_date: "2026-10-01T12:00:00Z" });
    expect(body.purchased_products["pro.monthly"]).toEqual({ should_consume: false });
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ store: "AMAZON", product_id: "pro.monthly", period_type: "NORMAL", price: 4.99, currency: "USD", environment: "PRODUCTION",
      transaction_id: RID, original_transaction_id: RID, country_code: "US", entitlement_ids: ["pro"], app_user_id: "fire_user", commission_percentage: 0.3 });
    expect(await txns()).toHaveLength(1);
    expect((await txns())[0]).toMatchObject({ kind: "purchase", revenueUsd: 4.99, priceAmount: 4.99 });
    // Restores post the same receipt again: nothing new.
    await buy({ is_restore: true });
    expect(await e.events("INITIAL_PURCHASE")).toHaveLength(1);
    expect(await txns()).toHaveLength(1);
    expect(e.a.rvsCalls()[0]!.url).toContain(`/user/${encodeURIComponent(AMZ_USER)}/receiptId/`);
  });

  it("an app in the Small Business Accelerator sends 20% commission from its entry date", async () => {
    const res = await e.call(`/v2/projects/${e.h.ids.project}/apps/${e.appId}`, { method: "POST", key: e.h.ids.secretKey,
      json: { amazon: { small_business_accelerator: { enrolled: true, periods: [{ entry_date: "2026-01-01", exit_date: null }] } } } });
    expect(res.status).toBe(200);
    e.a.put(receipt());
    expect((await buy()).status).toBe(200);
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ commission_percentage: 0.2, takehome_percentage: 0.8 });
  });

  it("a free trial is TRIAL at price 0; an introductory promotion is INTRO", async () => {
    e.a.put(receipt({ freeTrialEndDate: at(7).getTime(), renewalDate: at(7).getTime() }));
    let ci = CustomerInfoSchema.parse(await (await buy()).json());
    expect(ci.subscriber.subscriptions["pro.monthly"]).toMatchObject({ period_type: "trial", expires_date: "2026-09-08T12:00:00Z" });
    expect((await e.events("INITIAL_PURCHASE"))[0]).toMatchObject({ period_type: "TRIAL", price: 0 });

    e.a.put(receipt({ receiptId: "r-intro", promotions: [{ promotionType: "Introductory Price - All Customers", promotionStatus: "InProgress" }] }));
    ci = CustomerInfoSchema.parse(await (await e.receipt({ app_user_id: "intro_user", fetch_token: "r-intro", product_ids: ["pro.monthly"], price: 0.99, currency: "USD" })).json());
    expect(ci.subscriber.subscriptions["pro.monthly"]!.period_type).toBe("intro");
  });

  it("consumables answer should_consume and entitlements unlock lifetime access; Live App Testing and test transactions are sandbox", async () => {
    e.a.put(receipt({ receiptId: "r-coins", productId: "coins.100", productType: "CONSUMABLE", termSku: null, term: null, renewalDate: null, autoRenewing: false, testTransaction: true }));
    let body = await (await e.receipt({ app_user_id: "buyer", fetch_token: "r-coins", product_ids: ["coins.100"], price: 0.99, currency: "EUR" })).json();
    expect(body.purchased_products["coins.100"]).toEqual({ should_consume: true });
    expect(CustomerInfoSchema.parse(body).subscriber.non_subscriptions["coins.100"]![0]).toMatchObject({ store: "amazon", store_transaction_id: "r-coins", is_sandbox: true });

    e.a.put(receipt({ receiptId: "r-life", productId: "lifetime.unlock", productType: "ENTITLED", termSku: null, term: null, renewalDate: null, autoRenewing: false, betaProduct: true }));
    body = await (await e.receipt({ app_user_id: "buyer", fetch_token: "r-life", product_ids: ["lifetime.unlock"], price: 19.99, currency: "USD" })).json();
    expect(body.purchased_products["lifetime.unlock"]).toEqual({ should_consume: false });
    expect(CustomerInfoSchema.parse(body).subscriber.entitlements.pro).toMatchObject({ product_identifier: "lifetime.unlock", expires_date: null });
    expect((await e.events("NON_RENEWING_PURCHASE")).map((x) => x.environment)).toEqual(["SANDBOX", "SANDBOX"]);
  });

  it("an App Tester receipt found only in the RVS cloud sandbox is sandbox data", async () => {
    e.a.put(receipt(), { env: "sandbox" });
    const ci = CustomerInfoSchema.parse(await (await buy()).json());
    expect(ci.subscriber.subscriptions["pro.monthly"]!.is_sandbox).toBe(true);
    expect((await e.events("INITIAL_PURCHASE"))[0]!.environment).toBe("SANDBOX");
  });

  it("bad receipts are 400 7103 (the SDK finishes them); outages, throttling, timeouts and a rejected shared key are 5xx 7101", async () => {
    let res = await buy();
    expect([res.status, ErrorSchema.parse(await res.json()).code]).toEqual([400, 7103]);
    e.a.put(receipt());
    res = await buy({ store_user_id: "someone.else" });
    expect([res.status, (await res.json()).code]).toEqual([400, 7103]);
    res = await e.receipt({ app_user_id: "u", fetch_token: RID, product_ids: ["pro.monthly"], store_user_id: null });
    expect([res.status, (await res.json()).code]).toEqual([400, 7103]);
    e.a.status.set(RID, 410);
    res = await buy();
    expect([res.status, (await res.json()).code]).toEqual([400, 7103]);
    e.a.status.delete(RID);

    for (const status of [429, 500, 503]) {
      e.a.override = (url) => (url.includes("verifyReceiptId") ? new Response("", { status }) : undefined);
      res = await buy();
      expect([status, res.status, (await res.json()).code]).toEqual([status, 503, 7101]);
    }
    e.a.override = (url) => (url.includes("verifyReceiptId") ? new Promise<Response>(() => {}) : undefined);
    res = await buy();
    expect(res.status).toBe(503);
    expect((await res.json()).message).toMatch(/timed out/);
    e.a.override = null;

    await e.setCredentials({ shared_secret: "wrong" });
    res = await buy();
    const b = await res.json();
    expect([res.status, b.code]).toEqual([500, 7101]);
    expect(b.message).toMatch(/Shared Key/);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(app).toMatchObject({ credentialsStatus: "failing" });
    expect(app!.credentialsError).toMatch(/496/);
  });
});

describe("Amazon Real-time Notifications through SNS", () => {
  async function purchased(over = {}) {
    e.a.put(receipt(over));
    expect((await buy()).status).toBe(200);
  }

  it("confirms the SNS subscription (Amazon's 'Verified'), which counts as the first notification", async () => {
    const m = await snsMessage(keys, { type: "SubscriptionConfirmation", message: "You have chosen to subscribe to the topic." });
    const res = await e.sns(m);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "confirmed" });
    expect(e.a.confirmations).toEqual([m.SubscribeURL]);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(app!.lastNotificationAt?.toISOString()).toBe(T0.toISOString());
    const settings = await (await e.call(`/v2/projects/${e.h.ids.project}/apps/${e.appId}/store_settings`, { key: e.h.ids.secretKey })).json();
    expect(settings).toMatchObject({ notification_url: `http://localhost/v1/notifications/amazon/${e.appId}`, notification_status: "ready", credentials: { amazon_shared_secret: { configured: true } } });
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });

  it("checks SNS signatures: SHA-1 and SHA-256 pass; a tampered message, a foreign certificate host or an expired certificate are 400 and change nothing", async () => {
    await purchased();
    e.a.update(RID, { autoRenewing: false });
    const good = await snsMessage(keys, { version: "2", message: { appPackageName: PKG, notificationType: "SUBSCRIPTION_AUTO_RENEWAL_OFF", appUserId: AMZ_USER, receiptId: RID, timestamp: T0.getTime() } });
    const tampered = { ...good, Message: good.Message.replace("AUTO_RENEWAL_OFF", "PURCHASED") };
    let res = await e.sns(tampered);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/signature does not match/);
    expect(await e.events("CANCELLATION")).toHaveLength(0);

    const foreign = await snsMessage(keys, { certUrl: "https://evil.example.com/SimpleNotificationService-test.pem", message: { notificationType: "SUBSCRIPTION_AUTO_RENEWAL_OFF", receiptId: RID } });
    res = await e.sns(foreign);
    expect(res.status).toBe(400);
    expect(e.a.calls.some((c) => c.url.startsWith("https://evil.example.com"))).toBe(false);
    const httpCert = await snsMessage(keys, { certUrl: CERT_URL.replace("https:", "http:"), message: {} });
    expect((await e.sns(httpCert)).status).toBe(400);

    // The canonical string follows AWS's key order; Subject is signed when present.
    expect(stringToSign({ ...good, Subject: "s" })).toBe(`Message\n${good.Message}\nMessageId\n${good.MessageId}\nSubject\ns\nTimestamp\n${good.Timestamp}\nTopicArn\n${TOPIC}\nType\nNotification\n`);

    res = await e.sns(good);
    expect(res.status).toBe(200);
    expect(await e.events("CANCELLATION")).toHaveLength(1);
    const v1 = await snsMessage(keys, { version: "1", message: { appPackageName: PKG, notificationType: "SUBSCRIPTION_AUTO_RENEWAL_OFF", appUserId: AMZ_USER, receiptId: RID } });
    expect((await e.sns(v1)).status).toBe(200);
    expect(e.a.certFetches).toBe(1);

    // A certificate outside its validity is refused.
    clearSnsCertCache();
    const expired = await makeSnsKeys({ notAfter: new Date("2026-01-01T00:00:00Z") });
    e.a.keys = expired;
    res = await e.sns(await snsMessage(expired, { message: {} }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/not valid now/);
  });

  it("a pinned SNS topic refuses messages from any other topic", async () => {
    await e.setCredentials({ shared_secret: SECRET, sns_topic_arn: TOPIC });
    const other = await snsMessage(keys, { topic: "arn:aws:sns:us-east-1:999999999999:someone-else", message: { notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID } });
    expect((await e.sns(other)).status).toBe(400);
    expect((await e.sns(await snsMessage(keys, { message: { appPackageName: PKG, notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID, appUserId: AMZ_USER } }))).status).toBe(200);
  });

  it("a renewal moves the period, records RENEWAL at the last price, and redelivery is processed once", async () => {
    await purchased();
    e.h.setNow(at(30));
    e.a.update(RID, { renewalDate: at(60).getTime() });
    const res = await e.rtn({ notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID }, { messageId: "renew-1" });
    expect(await res.json()).toEqual({ status: "processed" });
    const [renewal] = await e.events("RENEWAL");
    expect(renewal).toMatchObject({ store: "AMAZON", price: 4.99, transaction_id: `${RID}.${at(30).getTime()}`, original_transaction_id: RID, purchased_at_ms: at(30).getTime(), expiration_at_ms: at(60).getTime() });
    expect((await info("fire_user")).subscriber.entitlements.pro!.expires_date).toBe("2026-10-31T12:00:00Z");
    expect(await e.rtn({ notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID }, { messageId: "renew-1" }).then((r) => r.json())).toEqual({ status: "duplicate" });
    // A second message about the same state records nothing new.
    await e.rtn({ notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID });
    expect(await e.events("RENEWAL")).toHaveLength(1);
    expect((await txns()).map((t) => t.kind)).toEqual(["purchase", "renewal"]);
  });

  it("a trial converting to paid is RENEWAL with is_trial_conversion", async () => {
    await purchased({ freeTrialEndDate: at(7).getTime(), renewalDate: at(7).getTime() });
    e.h.setNow(at(7));
    e.a.update(RID, { renewalDate: at(37).getTime() });
    await e.rtn({ notificationType: "SUBSCRIPTION_CONVERTED_FREE_TRIAL_TO_PAID", receiptId: RID });
    const [r] = await e.events("RENEWAL");
    expect(r).toMatchObject({ is_trial_conversion: true, period_type: "NORMAL", purchased_at_ms: at(7).getTime() });
  });

  it("auto-renew off is CANCELLATION (UNSUBSCRIBE), back on is UNCANCELLATION, and the end is EXPIRATION", async () => {
    await purchased();
    e.a.update(RID, { autoRenewing: false });
    await e.rtn({ notificationType: "SUBSCRIPTION_AUTO_RENEWAL_OFF", receiptId: RID });
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "UNSUBSCRIBE" });
    expect((await info("fire_user")).subscriber.subscriptions["pro.monthly"]!.unsubscribe_detected_at).toBe("2026-09-01T12:00:00Z");
    e.a.update(RID, { autoRenewing: true });
    await e.rtn({ notificationType: "SUBSCRIPTION_AUTO_RENEWAL_ON", receiptId: RID });
    expect(await e.events("UNCANCELLATION")).toHaveLength(1);
    e.h.setNow(at(30));
    e.a.update(RID, { autoRenewing: false, cancelDate: at(30).getTime(), cancelReason: 1 });
    await e.rtn({ notificationType: "SUBSCRIPTION_EXPIRED", receiptId: RID });
    // Access ended exactly now; the expiration worker records EXPIRATION once a period is over.
    await tick(e.h.db, e.h.now(), e.a.fetch);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "UNSUBSCRIBE" });
    expect((await info("fire_user")).subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
  });

  it("grace period: BILLING_ISSUE and CANCELLATION (BILLING_ERROR) with access until the grace end; out of grace is EXPIRATION (BILLING_ERROR)", async () => {
    await purchased();
    e.h.setNow(at(30));
    e.a.update(RID, { gracePeriodEndDate: at(33).getTime() });
    await e.rtn({ notificationType: "SUBSCRIPTION_IN_GRACE_PERIOD", receiptId: RID });
    expect(await e.events("BILLING_ISSUE")).toHaveLength(1);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "BILLING_ERROR" });
    const ci = await info("fire_user");
    expect(ci.subscriber.subscriptions["pro.monthly"]).toMatchObject({ grace_period_expires_date: "2026-10-04T12:00:00Z", billing_issues_detected_at: "2026-10-01T12:00:00Z" });
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-04T12:00:00Z");
    expect(await e.events("EXPIRATION")).toHaveLength(0);
    e.h.setNow(at(33));
    e.a.update(RID, { gracePeriodEndDate: null, autoRenewing: false, cancelDate: at(30).getTime(), cancelReason: 2 });
    await e.rtn({ notificationType: "SUBSCRIPTION_OUT_OF_GRACE_PERIOD", receiptId: RID });
    await tick(e.h.db, e.h.now(), e.a.fetch);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "BILLING_ERROR" });
  });

  it("a deferred tier change is PRODUCT_CHANGE to the deferred SKU", async () => {
    await purchased();
    e.a.update(RID, { deferredSku: "pro.annual", deferredDate: at(30).getTime() });
    await e.rtn({ notificationType: "SUBSCRIPTION_MODIFIED_DEFERRED", receiptId: RID });
    expect(await e.events("PRODUCT_CHANGE")).toEqual([expect.objectContaining({ product_id: "pro.monthly", new_product_id: "pro.annual" })]);
    expect((await info("fire_user")).subscriber.entitlements.pro!.product_identifier).toBe("pro.monthly");
  });

  it("an immediate tier change starts a new receipt for the same customer and ends the old chain with PRODUCT_CHANGE", async () => {
    await purchased();
    e.h.setNow(at(10));
    e.a.put(receipt({ receiptId: "r-annual", termSku: "pro.annual", term: "1 Year", purchaseDate: at(10).getTime(), renewalDate: at(375).getTime() }));
    e.a.update(RID, { cancelDate: at(10).getTime(), autoRenewing: false });
    const res = await e.rtn({ notificationType: "SUBSCRIPTION_MODIFIED_IMMEDIATE", receiptId: "r-annual", relatedReceipts: { cancelledReceiptId: RID } });
    expect(await res.json()).toEqual({ status: "processed" });
    const initial = await e.events("INITIAL_PURCHASE");
    expect(initial.map((x) => [x.product_id, x.app_user_id])).toEqual([["pro.monthly", "fire_user"], ["pro.annual", "fire_user"]]);
    expect(await e.events("PRODUCT_CHANGE")).toEqual([expect.objectContaining({ product_id: "pro.monthly", original_transaction_id: RID })]);
    const ci = await info("fire_user");
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: "pro.annual" });
    expect(ci.subscriber.subscriptions["pro.monthly"]!.expires_date).toBe("2026-09-11T12:00:00Z");
  });

  it("a one-time purchase cancelled by Amazon is a refund: CANCELLATION (CUSTOMER_SUPPORT) and a negative transaction; RVS 410 too", async () => {
    e.a.put(receipt({ receiptId: "r-coins", productId: "coins.100", productType: "CONSUMABLE", termSku: null, term: null, renewalDate: null, autoRenewing: false }));
    await e.receipt({ app_user_id: "buyer", fetch_token: "r-coins", product_ids: ["coins.100"], price: 0.99, currency: "USD" });
    e.h.setNow(at(2));
    await e.rtn({ notificationType: "CONSUMABLE_CANCELLED", receiptId: "r-coins" });
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -0.99, product_id: "coins.100" });
    expect((await txns()).map((t) => [t.kind, t.revenueUsd])).toEqual([["one_time", 0.99], ["refund", -0.99]]);

    e.a.put(receipt({ receiptId: "r-life", productId: "lifetime.unlock", productType: "ENTITLED", termSku: null, term: null, renewalDate: null, autoRenewing: false }));
    await e.receipt({ app_user_id: "buyer", fetch_token: "r-life", product_ids: ["lifetime.unlock"], price: 19.99, currency: "USD" });
    expect((await info("buyer")).subscriber.entitlements.pro).toBeDefined();
    e.a.status.set("r-life", 410);
    expect(await (await e.rtn({ notificationType: "ENTITLEMENT_CANCELLED", receiptId: "r-life" })).json()).toEqual({ status: "processed" });
    // Access ends at the refund (the entitlement is listed as expired).
    expect((await info("buyer")).subscriber.entitlements.pro!.expires_date).toBe("2026-09-03T12:00:00Z");
    expect(await e.events("CANCELLATION")).toHaveLength(2);
  });

  it("unknown receipts are acknowledged and ignored, unless the app tracks new purchases (an anonymous customer)", async () => {
    e.a.put(receipt({ receiptId: "r-new" }));
    let res = await e.rtn({ notificationType: "SUBSCRIPTION_PURCHASED", receiptId: "r-new" });
    expect(await res.json()).toEqual({ status: "unknown_purchase" });
    expect(await e.events()).toHaveLength(0);
    await e.setCredentials({ shared_secret: SECRET, track_new_purchases: true });
    res = await e.rtn({ notificationType: "SUBSCRIPTION_PURCHASED", receiptId: "r-new" });
    expect(await res.json()).toEqual({ status: "processed" });
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev!.app_user_id).toMatch(/^\$RCAnonymousID:/);
    expect(ev!.price).toBeNull();
  });

  it("another package is ignored; RVS outages answer 500 so SNS retries, and the retry is processed", async () => {
    await purchased();
    let res = await e.rtn({ notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID, appPackageName: "com.other.app" });
    expect(await res.json()).toEqual({ status: "ignored" });
    e.a.override = (url) => (url.includes("verifyReceiptId") ? new Response("", { status: 503 }) : undefined);
    e.a.update(RID, { autoRenewing: false });
    res = await e.rtn({ notificationType: "SUBSCRIPTION_AUTO_RENEWAL_OFF", receiptId: RID }, { messageId: "retry-me" });
    expect(res.status).toBe(500);
    e.a.override = null;
    res = await e.rtn({ notificationType: "SUBSCRIPTION_AUTO_RENEWAL_OFF", receiptId: RID }, { messageId: "retry-me" });
    expect(await res.json()).toEqual({ status: "processed" });
    expect(await e.events("CANCELLATION")).toHaveLength(1);
    const rows = await e.h.db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.appId, e.appId));
    expect(rows.map((r) => r.type).sort()).toEqual(["SUBSCRIPTION_AUTO_RENEWAL_OFF", "SUBSCRIPTION_RENEWED"]);
  });

  it("forwards every SNS message unchanged to the forwarding URL", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/amazon" }).where(eq(schema.apps.id, e.appId));
    const m = await snsMessage(keys, { type: "SubscriptionConfirmation", message: "confirm" });
    await e.sns(m);
    await flushStoreForwards();
    expect(e.a.forwarded).toHaveLength(1);
    expect(JSON.parse(e.a.forwarded[0]!.body)).toEqual(m);
    expect(e.a.forwarded[0]!.headers.get("x-amz-sns-message-type")).toBe("SubscriptionConfirmation");
    const [row] = await e.h.db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.appId, e.appId));
    expect(row!.forwardStatus).toBe(202);
  });

  it("the expiration worker ends access at the period end without a notification", async () => {
    await purchased({ autoRenewing: false });
    await tick(e.h.db, at(31), e.a.fetch);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ store: "AMAZON", expiration_reason: "UNSUBSCRIBE" });
  });
});

describe("Amazon app setup (v2)", () => {
  const P = () => `/v2/projects/${e.h.ids.project}`;
  const v2 = (method: string, path: string, json?: unknown) => e.call(path, { method, key: e.h.ids.secretKey, ...(json === undefined ? {} : { json }) });

  it("creates an Amazon app with the shared key, never returns it, and refuses a malformed SNS topic", async () => {
    let res = await v2("POST", `${P()}/apps`, { name: "Fire", type: "amazon", amazon: { package_name: "com.example.fire", shared_secret: "s3cr3t-key", notification_forward_url: "https://hooks.example.com/amz" } });
    expect(res.status).toBe(201);
    const app = await res.json();
    expect(app).toMatchObject({ type: "amazon", amazon: { package_name: "com.example.fire" } });
    expect(JSON.stringify(app)).not.toContain("s3cr3t-key");
    // The shared key is sealed (AES-GCM under the server's key), never stored in credentials.
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    expect(row).toMatchObject({ credentials: {}, secretHints: { shared_secret: "set" }, notificationForwardUrl: "https://hooks.example.com/amz" });
    expect(row!.secrets).toMatch(/^v1:/);
    expect(row!.secrets).not.toContain("s3cr3t-key");
    expect(await unseal(row!.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ shared_secret: "s3cr3t-key" });
    const settings = await (await v2("GET", `${P()}/apps/${app.id}/store_settings`)).json();
    expect(settings.credentials.amazon_shared_secret).toEqual({ configured: true });
    expect(JSON.stringify(settings)).not.toContain("s3cr3t-key");
    // Clearing it (null) unsets it.
    res = await v2("POST", `${P()}/apps/${app.id}`, { amazon: { shared_secret: null } });
    expect(res.status).toBe(200);
    const [cleared] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    expect([cleared!.secrets, cleared!.secretHints]).toEqual([null, {}]);
    res = await v2("POST", `${P()}/apps/${app.id}`, { amazon: { sns_topic_arn: "not-an-arn" } });
    expect(res.status).toBe(400);
    expect((await res.json()).param).toBe("amazon.sns_topic_arn");
    res = await v2("POST", `${P()}/apps/${app.id}`, { amazon: { sns_topic_arn: TOPIC } });
    expect(res.status).toBe(200);
  });

  it("verify_credentials asks RVS: 496 means a wrong shared key, 400 means the key works; outages are unreachable", async () => {
    let r = await (await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, {})).json();
    expect(r).toMatchObject({ object: "credentials_check", status: "valid", valid: true, message: "Amazon accepted the shared key." });
    expect(e.a.rvsCalls().at(-1)!.url).toContain("/receiptId/revenuedot-credentials-check");
    r = await (await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, { amazon: { shared_secret: "wrong" } })).json();
    expect(r).toMatchObject({ status: "invalid", valid: false });
    expect(r.message).toMatch(/rejected the shared key/);
    e.a.override = () => new Response("", { status: 500 });
    r = await (await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, {})).json();
    expect(r.status).toBe("unreachable");
    // A check of the stored key updates the app's credential health.
    e.a.override = null;
    await e.setCredentials({ shared_secret: "wrong" });
    await v2("POST", `${P()}/apps/${e.appId}/actions/verify_credentials`, {});
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(row!.credentialsStatus).toBe("failing");
    const health = await (await v2("GET", `${P()}/setup_health`)).json();
    expect(health.apps.find((x: { id: string }) => x.id === e.appId)).toMatchObject({ credentials_configured: true, notification_url: `http://localhost/v1/notifications/amazon/${e.appId}` });
  });
});

describe("Amazon trust boundaries", () => {
  const settings = async () => (await e.call(`/v2/projects/${e.h.ids.project}/apps/${e.appId}/store_settings`, { key: e.h.ids.secretKey })).json();

  it("certificate and SubscribeURL hosts must be SNS in an AWS region: an S3 bucket named sns is not SNS", async () => {
    const bucket = "https://sns.s3.amazonaws.com/SimpleNotificationService-test.pem";
    let res = await e.sns(await snsMessage(keys, { certUrl: bucket, message: { notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID } }));
    expect(res.status).toBe(400);
    expect(e.a.calls.some((c) => c.url.startsWith("https://sns.s3."))).toBe(false);
    const m = await snsMessage(keys, { type: "SubscriptionConfirmation", message: "confirm" });
    m.SubscribeURL = "https://sns.s3.amazonaws.com/?Action=ConfirmSubscription&Token=x";
    const resigned = await snsMessage(keys, { type: "SubscriptionConfirmation", message: "confirm" });
    Object.assign(resigned, { SubscribeURL: m.SubscribeURL });
    // Re-sign with the changed SubscribeURL so only the host check can refuse it.
    resigned.Signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.sha1, new TextEncoder().encode(stringToSign(resigned)))).toString("base64");
    res = await e.sns(resigned);
    expect(res.status).toBe(400);
    expect(e.a.confirmations).toEqual([]);
  });

  it("the first verified message pins its topic; another AWS account's signed messages are then refused", async () => {
    expect((await settings()).sns_topic_arn).toBeNull();
    expect((await e.sns(await snsMessage(keys, { type: "SubscriptionConfirmation", message: "confirm" }))).status).toBe(200);
    expect((await settings()).sns_topic_arn).toBe(TOPIC);
    await purchased();
    e.a.put(receipt({ receiptId: "r-coins", productId: "coins.100", productType: "CONSUMABLE", termSku: null, term: null, renewalDate: null, autoRenewing: false }));
    const attacker = "arn:aws:sns:us-east-1:999999999999:attacker";
    const res = await e.sns(await snsMessage(keys, { topic: attacker, message: { appPackageName: PKG, notificationType: "CONSUMABLE_CANCELLED", appUserId: AMZ_USER, receiptId: "r-coins" } }));
    expect(res.status).toBe(400);
    expect(await e.events("CANCELLATION")).toHaveLength(0);
    expect((await settings()).sns_topic_arn).toBe(TOPIC);
    async function purchased() { e.a.put(receipt()); expect((await buy()).status).toBe(200); }
  });

  it("an unsigned body never takes a real message's id and is never forwarded", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/amazon" }).where(eq(schema.apps.id, e.appId));
    const real = await snsMessage(keys, { type: "SubscriptionConfirmation", message: "confirm", messageId: "m-1" });
    const forged = { ...real, Message: "forged" };
    expect((await e.sns(forged)).status).toBe(400);
    expect(await (await e.sns(real)).json()).toEqual({ status: "confirmed" });
    await flushStoreForwards();
    expect(e.a.forwarded.map((f) => JSON.parse(f.body).Message)).toEqual(["confirm"]);
  });

  it("redirects are never followed: RVS (5xx, retried), the certificate (refused) and SubscribeURL (5xx, retried)", async () => {
    const elsewhere = (status = 302) => new Response(null, { status, headers: { location: "https://attacker.example.com/" } });
    e.a.put(receipt());
    e.a.override = (url) => (url.includes("verifyReceiptId") ? elsewhere() : undefined);
    let res = await buy();
    expect([res.status, (await res.json()).code]).toEqual([503, 7101]);
    e.a.override = (url) => (url === CERT_URL ? elsewhere(301) : undefined);
    res = await e.sns(await snsMessage(keys, { type: "SubscriptionConfirmation", message: "confirm" }));
    expect(res.status).toBe(400);
    e.a.override = (url) => (url.includes("Action=ConfirmSubscription") ? elsewhere(307) : undefined);
    res = await e.sns(await snsMessage(keys, { type: "SubscriptionConfirmation", message: "confirm" }));
    expect(res.status).toBe(503);
    expect(e.a.calls.some((c) => c.url.startsWith("https://attacker.example.com"))).toBe(false);
    // Every Amazon request (RVS, certificate, SubscribeURL) is made with redirect: "manual".
    expect(e.a.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of e.a.calls) expect([c.url.split("?")[0], c.redirect]).toEqual([c.url.split("?")[0], "manual"]);
  });

  it("an immediate tier change never ends another customer's chain", async () => {
    e.a.put(receipt());
    expect((await buy({}, "victim")).status).toBe(200);
    e.a.put(receipt({ receiptId: "r-other", termSku: "pro.annual", term: "1 Year", renewalDate: at(365).getTime() }));
    expect((await buy({ fetch_token: "r-other", product_ids: ["pro.annual"] }, "someone")).status).toBe(200);
    await e.rtn({ notificationType: "SUBSCRIPTION_MODIFIED_IMMEDIATE", receiptId: "r-other", relatedReceipts: { cancelledReceiptId: RID } });
    expect((await info("victim")).subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
    expect(await e.events("PRODUCT_CHANGE")).toHaveLength(0);
  });

  it("a receipt posted again after a refund keeps the refund (no REFUND_REVERSED)", async () => {
    e.a.put(receipt({ receiptId: "r-coins", productId: "coins.100", productType: "CONSUMABLE", termSku: null, term: null, renewalDate: null, autoRenewing: false }));
    const post = () => e.receipt({ app_user_id: "buyer", fetch_token: "r-coins", product_ids: ["coins.100"], price: 0.99, currency: "USD" });
    await post();
    e.h.setNow(at(1));
    await e.rtn({ notificationType: "CONSUMABLE_CANCELLED", receiptId: "r-coins" });
    expect((await post()).status).toBe(200);
    expect(await e.events("REFUND_REVERSED")).toHaveLength(0);
    expect((await txns()).map((t) => t.kind)).toEqual(["one_time", "refund"]);
  });

  it("secrets sealed under another key are a 5xx (never 4xx), and plain secrets saved before sealing still work and move on save", async () => {
    e.a.put(receipt());
    const other = await sealStoreSecrets({ type: "amazon", credentials: {}, secrets: null }, { shared_secret: SECRET }, await secretKeyFrom(Buffer.alloc(32, 9).toString("base64")));
    await e.h.db.update(schema.apps).set({ secrets: other.secrets }).where(eq(schema.apps.id, e.appId));
    let res = await buy();
    expect([res.status, (await res.json()).code]).toEqual([500, 7101]);
    expect((await e.rtn({ notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID })).status).toBe(500);

    await e.h.db.update(schema.apps).set({ secrets: null, secretHints: {}, credentials: { shared_secret: SECRET } }).where(eq(schema.apps.id, e.appId));
    res = await buy();
    expect(res.status).toBe(200);
    expect((await settings()).credentials.amazon_shared_secret).toEqual({ configured: true });
    res = await e.call(`/v2/projects/${e.h.ids.project}/apps/${e.appId}`, { method: "POST", key: e.h.ids.secretKey, json: { amazon: { sns_topic_arn: TOPIC } } });
    expect(res.status).toBe(200);
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(row!.credentials).toEqual({ sns_topic_arn: TOPIC });
    expect(await unseal(row!.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ shared_secret: SECRET });
    expect((await buy()).status).toBe(200);
  });
});

describe("Amazon state that must not move on later reads", () => {
  it("grace without a renewal date: a later notification keeps the access end (no SUBSCRIPTION_EXTENDED)", async () => {
    e.a.put(receipt({ renewalDate: null }));
    expect((await buy()).status).toBe(200);
    e.h.setNow(at(1));
    e.a.update(RID, { gracePeriodEndDate: at(5).getTime() });
    await e.rtn({ notificationType: "SUBSCRIPTION_IN_GRACE_PERIOD", receiptId: RID });
    expect(await e.events("BILLING_ISSUE")).toHaveLength(1);
    e.h.setNow(at(2));
    await e.rtn({ notificationType: "SUBSCRIPTION_IN_GRACE_PERIOD", receiptId: RID });
    e.h.setNow(at(3));
    expect((await buy()).status).toBe(200);
    expect(await e.events("SUBSCRIPTION_EXTENDED")).toHaveLength(0);
    expect((await info("fire_user")).subscriber.subscriptions["pro.monthly"]).toMatchObject({ expires_date: "2026-09-02T12:00:00Z", grace_period_expires_date: "2026-09-06T12:00:00Z" });
  });

  it("a subscription without a renewal date or term ends when first seen and stays there", async () => {
    e.a.put(receipt({ renewalDate: null, term: null, termSku: "pro.legacy", productId: "pro.legacy.parent" }));
    expect((await buy({ product_ids: ["pro.legacy"] })).status).toBe(200);
    e.h.setNow(at(1));
    await e.rtn({ notificationType: "SUBSCRIPTION_RENEWED", receiptId: RID });
    e.h.setNow(at(2));
    expect((await buy({ product_ids: ["pro.legacy"] })).status).toBe(200);
    expect(await e.events("SUBSCRIPTION_EXTENDED")).toHaveLength(0);
    expect((await info("fire_user")).subscriber.subscriptions["pro.legacy"]!.expires_date).toBe("2026-09-01T12:00:00Z");
  });

  it("a refund learned from CONSUMABLE_CANCELLED survives a delayed CONSUMABLE_PURCHASED (no REFUND_REVERSED)", async () => {
    e.a.put(receipt({ receiptId: "r-coins", productId: "coins.100", productType: "CONSUMABLE", termSku: null, term: null, renewalDate: null, autoRenewing: false }));
    await e.receipt({ app_user_id: "buyer", fetch_token: "r-coins", product_ids: ["coins.100"], price: 0.99, currency: "USD" });
    e.h.setNow(at(1));
    await e.rtn({ notificationType: "CONSUMABLE_CANCELLED", receiptId: "r-coins" });
    e.h.setNow(at(2));
    expect(await (await e.rtn({ notificationType: "CONSUMABLE_PURCHASED", receiptId: "r-coins" })).json()).toEqual({ status: "processed" });
    expect(await e.events("REFUND_REVERSED")).toHaveLength(0);
    expect((await txns()).map((t) => [t.kind, t.revenueUsd])).toEqual([["one_time", 0.99], ["refund", -0.99]]);
  });
});
