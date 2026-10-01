import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema, ErrorSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { tick } from "../src/services/tick.js";
import { GooglePlayClient } from "../src/stores/google/api.js";
import { purchaseTokensForOrders } from "../src/stores/google/index.js";
import { flushGoogleForwards, FORWARD_TIMEOUT_MS } from "../src/stores/google/notifications.js";
import { API, env, FakeGoogle, makeKeys, pushToken, sub, type Env, type Keys } from "./google-helpers.js";

const DAY = 86_400_000;
const T0 = new Date("2026-09-01T12:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const MONTH_END = new Date("2026-10-01T12:00:00Z");

let keys: Keys;
let e: Env;
beforeAll(async () => { keys = await makeKeys(); });
afterEach(async () => { await e?.h.close(); });

const PRO = [{ product_id: "pro", base_plan_id: "monthly" }];
const buyPro = (user = "user_a", token = "tok_pro_1", extra: Record<string, unknown> = {}) =>
  e.receipt({ app_user_id: user, fetch_token: token, product_ids: ["pro"], platform_product_ids: PRO, price: 9.99, currency: "USD", ...extra });
const info = async (user: string) => CustomerInfoSchema.parse(await (await e.call(`/v1/subscribers/${user}`, { key: e.h.ids.androidKey })).json());
const subNote = (notificationType: number, purchaseToken: string, subscriptionId = "pro") => ({ subscriptionNotification: { version: "1.0", notificationType, purchaseToken, subscriptionId } });

describe("Play Developer API client", () => {
  it("exchanges an RS256 JWT signed with the service account key for an access token and caches it", async () => {
    const g = new FakeGoogle(keys.publicKey);
    g.subs.set("t1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1" }));
    const client = new GooglePlayClient({ fetch: g.fetch });
    const app = { id: "a", projectId: "p", type: "play_store", bundleId: "com.example.scanner", credentials: { service_account: JSON.stringify(keys.sa) } };
    await client.getSubscriptionV2(app, "t1");
    await client.getSubscriptionV2(app, "t1");
    expect(g.tokenRequests).toHaveLength(1);
    const form = g.tokenRequests[0]!;
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion")!;
    expect(decodeProtectedHeader(assertion)).toMatchObject({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    const { payload } = await jwtVerify(assertion, keys.publicKey, { algorithms: ["RS256"] });
    expect(payload).toMatchObject({ iss: keys.sa.client_email, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/androidpublisher" });
    expect(payload.exp! - payload.iat!).toBe(3600);
    expect(g.calls.every((c) => c.auth === "Bearer ya29.test-token")).toBe(true);
  });

  it("orders.batchGet maps order ids to purchase tokens", async () => {
    const g = new FakeGoogle(keys.publicKey);
    g.orders.set("GPA.1111-2222-3333-44444", "tok_a").set("GPA.5555-6666-7777-88888..2", "tok_b");
    const client = new GooglePlayClient({ fetch: g.fetch });
    const app = { id: "a", projectId: "p", type: "play_store", bundleId: "com.example.scanner", credentials: { service_account: keys.sa } };
    const map = await purchaseTokensForOrders(app, ["GPA.1111-2222-3333-44444", "GPA.5555-6666-7777-88888..2", "GPA.missing"], client);
    expect(map).toEqual({ "GPA.1111-2222-3333-44444": "tok_a", "GPA.5555-6666-7777-88888..2": "tok_b" });
    const url = new URL(g.calls[0]!.url);
    expect(url.origin + url.pathname).toBe(`${API}/orders:batchGet`);
    expect(url.searchParams.getAll("orderIds")).toHaveLength(3);
  });
});

describe("POST /v1/receipts with a Google Play purchase token", () => {
  beforeEach(async () => { e = await env(keys); });

  it("verifies a subscription, acknowledges it, and returns decodable customer info with the base plan", async () => {
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1234-5678-9012-34567" }));
    const res = await buyPro();
    expect(res.status).toBe(200);
    const body = await res.json();
    const ci = CustomerInfoSchema.parse(body);
    const s = ci.subscriber.subscriptions.pro!;
    expect(s).toMatchObject({ store: "play_store", product_plan_identifier: "monthly", period_type: "normal", is_sandbox: false,
      purchase_date: "2026-09-01T12:00:00Z", expires_date: "2026-10-01T12:00:00Z", store_transaction_id: "GPA.1234-5678-9012-34567" });
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: "pro", product_plan_identifier: "monthly", expires_date: "2026-10-01T12:00:00Z" });
    expect(body.purchased_products.pro.should_consume).toBe(false);
    expect(e.g.acks("tok_pro_1")).toHaveLength(1);
    expect(e.g.acks("tok_pro_1")[0]!.url).toBe(`${API}/purchases/subscriptions/pro/tokens/tok_pro_1:acknowledge`);
    const [initial] = await e.events("INITIAL_PURCHASE");
    expect(initial).toMatchObject({ product_id: "pro", store: "PLAY_STORE", period_type: "NORMAL", price: 9.99, currency: "USD", environment: "PRODUCTION",
      transaction_id: "GPA.1234-5678-9012-34567", original_transaction_id: "GPA.1234-5678-9012-34567", country_code: "US", entitlement_ids: ["pro"] });
    // Posting again (a restore) neither acknowledges twice nor records a second purchase.
    await buyPro("user_a", "tok_pro_1", { is_restore: true });
    expect(e.g.acks("tok_pro_1")).toHaveLength(1);
    expect(await e.events("INITIAL_PURCHASE")).toHaveLength(1);
  });

  it("marks a free-trial offer as a trial with a zero price, and a license tester purchase as sandbox", async () => {
    e.g.subs.set("tok_trial", sub({ start: T0, expiry: at(7), order: "GPA.9", offerId: "free-week", offerTags: ["freetrial"], test: true }));
    const res = await e.receipt({ app_user_id: "trial_user", fetch_token: "tok_trial", product_ids: ["pro"], platform_product_ids: [{ product_id: "pro", base_plan_id: "monthly", offer_id: "free-week" }], price: 9.99, currency: "USD" });
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.subscriptions.pro).toMatchObject({ period_type: "trial", is_sandbox: true });
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ period_type: "TRIAL", price: 0, environment: "SANDBOX" });
  });

  it("an invalid token is 400 with code 7103", async () => {
    const res = await buyPro("u", "tok_nope");
    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await res.json()).code).toBe(7103);
    e.g.override = (url) => (url.includes("tok_gone") ? new Response(JSON.stringify({ error: { code: 410, message: "The subscription purchase is no longer available for query because it has been expired for too long." } }), { status: 410 }) : undefined);
    const gone = await buyPro("u", "tok_gone");
    expect(gone.status).toBe(400);
    expect((await gone.json()).code).toBe(7103);
  });

  it("Google 5xx, token endpoint outages and timeouts are 503 with code 7101, so the SDK retries", async () => {
    e.g.override = (url) => (url.startsWith(API) ? new Response("backend error", { status: 503 }) : undefined);
    let res = await buyPro("u", "tok_x");
    expect(res.status).toBe(503);
    expect(ErrorSchema.parse(await res.json()).code).toBe(7101);

    await e.h.close();
    e = await env(keys);
    e.g.override = (url) => (url.includes("oauth2.googleapis.com/token") ? new Response("{}", { status: 500 }) : undefined);
    res = await buyPro("u", "tok_x");
    expect(res.status).toBe(503);

    e.g.override = () => new Promise<Response>(() => {});
    res = await buyPro("u", "tok_x");
    expect(res.status).toBe(503);
    expect((await res.json()).message).toMatch(/timed out/);
  });

  it("missing or rejected credentials are 503 with code 7101 (the SDK keeps the purchase unfinished and retries once the operator fixes them) and say what to fix", async () => {
    await e.h.db.update(schema.apps).set({ credentials: {} }).where(eq(schema.apps.id, e.h.ids.androidApp));
    let res = await buyPro("u", "tok_x");
    expect(res.status).toBe(503);
    let b = await res.json();
    expect(b.code).toBe(7101);
    expect(b.message).toMatch(/service account/);

    await e.h.db.update(schema.apps).set({ credentials: { service_account: keys.sa } }).where(eq(schema.apps.id, e.h.ids.androidApp));
    e.g.override = (url) => (url.startsWith(API) ? new Response(JSON.stringify({ error: { code: 403, message: "The current user has insufficient permissions to perform the requested operation.", errors: [{ reason: "permissionDenied" }] } }), { status: 403 }) : undefined);
    res = await buyPro("u", "tok_x");
    expect(res.status).toBe(503);
    b = await res.json();
    expect(b.code).toBe(7101);
    expect(b.message).toMatch(/Play Console/);
  });

  it("a consumable is returned with should_consume true and is not acknowledged or consumed by the server", async () => {
    e.g.products.set("coins_100|tok_coins", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, consumptionState: 0, orderId: "GPA.C1", acknowledgementState: 0, regionCode: "DE" });
    const res = await e.receipt({ app_user_id: "buyer", fetch_token: "tok_coins", product_ids: ["coins_100"], platform_product_ids: [{ product_id: "coins_100" }], price: 0.99, currency: "EUR" });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ci = CustomerInfoSchema.parse(body);
    expect(body.purchased_products.coins_100.should_consume).toBe(true);
    expect(ci.subscriber.non_subscriptions.coins_100![0]).toMatchObject({ store: "play_store", store_transaction_id: "GPA.C1" });
    expect(e.g.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(await e.events("NON_RENEWING_PURCHASE")).toHaveLength(1);
  });

  it("a non-consumable is acknowledged and unlocks a lifetime entitlement", async () => {
    e.g.products.set("lifetime_unlock|tok_life", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, orderId: "GPA.L1", acknowledgementState: 0, purchaseType: 0 });
    const res = await e.receipt({ app_user_id: "lifer", fetch_token: "tok_life", product_ids: ["lifetime_unlock"], platform_product_ids: [{ product_id: "lifetime_unlock" }], price: 49.99, currency: "USD" });
    const body = await res.json();
    const ci = CustomerInfoSchema.parse(body);
    expect(body.purchased_products.lifetime_unlock.should_consume).toBe(false);
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: "lifetime_unlock", expires_date: null });
    expect(ci.subscriber.non_subscriptions.lifetime_unlock![0]!.is_sandbox).toBe(true);
    expect(e.g.acks("tok_life")).toHaveLength(1);
    expect(e.g.acks("tok_life")[0]!.url).toBe(`${API}/purchases/products/lifetime_unlock/tokens/tok_life:acknowledge`);
  });

  it("a product missing from the catalog is tried as a subscription first, then as a one-time product", async () => {
    e.g.products.set("gems_unknown|tok_gems", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, orderId: "GPA.G1", acknowledgementState: 1 });
    const res = await e.receipt({ app_user_id: "g", fetch_token: "tok_gems", product_ids: ["gems_unknown"], platform_product_ids: [{ product_id: "gems_unknown" }] });
    expect(res.status).toBe(200);
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.non_subscriptions.gems_unknown).toHaveLength(1);
    expect(e.g.calls.map((c) => new URL(c.url).pathname.split("/")[6])).toEqual(["subscriptionsv2", "products"]);
  });
});

describe("Google real-time developer notifications", () => {
  beforeEach(async () => { e = await env(keys); });

  async function purchased() {
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1000-0000-0000-00001" }));
    expect((await buyPro()).status).toBe(200);
  }

  it("stores every message, updates the app's last notification time, forwards the raw body, and answers a test notification", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/play" }).where(eq(schema.apps.id, e.h.ids.androidApp));
    const res = await e.rtdn({ testNotification: { version: "1.0" } }, { messageId: "m-test-1" });
    expect(res.status).toBe(200);
    await flushGoogleForwards();
    const [row] = await e.h.db.select().from(schema.storeNotifications);
    expect(row).toMatchObject({ appId: "app_play", store: "play_store", type: "TEST", forwardStatus: 202, error: null });
    expect(row!.processedAt).not.toBeNull();
    expect(JSON.parse(row!.body).message.messageId).toBe("m-test-1");
    expect(e.g.forwarded).toHaveLength(1);
    expect(e.g.forwarded[0]!.body).toBe(row!.body);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_play"));
    expect(app!.lastNotificationAt?.toISOString()).toBe(T0.toISOString());
    // Pub/Sub redelivery of the same message is acknowledged without processing or forwarding again.
    const again = await e.rtdn({ testNotification: { version: "1.0" } }, { messageId: "m-test-1" });
    expect(await again.json()).toEqual({ status: "duplicate" });
    await flushGoogleForwards();
    expect(e.g.forwarded).toHaveLength(1);
  });

  it("a forward that does not answer within 10 seconds is recorded as status 0, also without an injected fetch (the Node server)", async () => {
    await e.h.close();
    e = await env(keys, {}, { depsFetch: false });
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/slow" }).where(eq(schema.apps.id, e.h.ids.androidApp));
    const signals: (AbortSignal | null | undefined)[] = [];
    e.g.override = (url, _m, init) => {
      if (!url.startsWith("https://hooks.example.com/")) return undefined;
      signals.push(init.signal);
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const asked: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { asked.push(ms); return timeout(ms === FORWARD_TIMEOUT_MS ? 20 : ms); });
    try {
      expect((await e.rtdn({ testNotification: { version: "1.0" } })).status).toBe(200);
      await flushGoogleForwards();
    } finally { spy.mockRestore(); }
    expect(FORWARD_TIMEOUT_MS).toBe(10_000);
    expect(asked).toContain(10_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    const [row] = await e.h.db.select().from(schema.storeNotifications);
    expect(row!.forwardStatus).toBe(0);
  });

  it("renewal produces RENEWAL with the new order and period", async () => {
    await purchased();
    e.h.setNow(new Date("2026-10-01T12:05:00Z"));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: new Date("2026-11-01T12:00:00Z"), order: "GPA.1000-0000-0000-00001..0", ack: true }));
    const res = await e.rtdn(subNote(2, "tok_pro_1"));
    expect(await res.json()).toEqual({ status: "processed" });
    const [ev] = await e.events("RENEWAL");
    expect(ev).toMatchObject({ product_id: "pro", transaction_id: "GPA.1000-0000-0000-00001..0", original_transaction_id: "GPA.1000-0000-0000-00001", price: 9.99, app_user_id: "user_a" });
    const ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro).toMatchObject({ purchase_date: "2026-10-01T12:00:00Z", expires_date: "2026-11-01T12:00:00Z", store_transaction_id: "GPA.1000-0000-0000-00001..0" });
    const [n] = await e.h.db.select().from(schema.storeNotifications);
    expect(n).toMatchObject({ type: "SUBSCRIPTION_RENEWED", environment: "production" });
    // The same state read again (a second notification) records nothing new.
    await e.rtdn(subNote(2, "tok_pro_1"));
    expect(await e.events("RENEWAL")).toHaveLength(1);
  });

  it("a trial converting to paid is a RENEWAL with a normal period", async () => {
    e.g.subs.set("tok_t", sub({ start: T0, expiry: at(7), order: "GPA.T", offerId: "free-week", offerTags: ["freetrial"] }));
    await e.receipt({ app_user_id: "tu", fetch_token: "tok_t", product_ids: ["pro"], platform_product_ids: PRO, price: 9.99, currency: "USD" });
    e.h.setNow(at(7));
    e.g.subs.set("tok_t", sub({ start: T0, expiry: new Date(at(7).getTime() + 30 * DAY), order: "GPA.T..0", offerId: "free-week", offerTags: ["freetrial"], ack: true }));
    await e.rtdn(subNote(2, "tok_t"));
    const [ev] = await e.events("RENEWAL");
    expect(ev).toMatchObject({ period_type: "NORMAL", price: 9.99 });
  });

  it("grace period: BILLING_ISSUE and CANCELLATION(BILLING_ERROR), access until grace ends; on hold ends access; recovery renews", async () => {
    await purchased();
    e.h.setNow(new Date("2026-10-01T13:00:00Z"));
    const graceEnd = new Date("2026-10-08T12:00:00Z");
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: graceEnd, order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", ack: true }));
    await e.rtdn(subNote(6, "tok_pro_1"));
    expect(await e.events("BILLING_ISSUE")).toHaveLength(1);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "BILLING_ERROR" });
    expect(await e.events("SUBSCRIPTION_EXTENDED")).toHaveLength(0);
    let ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro).toMatchObject({ expires_date: "2026-10-01T12:00:00Z", grace_period_expires_date: "2026-10-08T12:00:00Z", billing_issues_detected_at: "2026-10-01T13:00:00Z" });
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-08T12:00:00Z");

    e.h.setNow(new Date("2026-10-08T12:30:00Z"));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: graceEnd, order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_ON_HOLD", ack: true }));
    await e.rtdn(subNote(5, "tok_pro_1"));
    expect(await e.events("BILLING_ISSUE")).toHaveLength(1);
    ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro!.grace_period_expires_date).toBeNull();
    expect(new Date(ci.subscriber.entitlements.pro!.expires_date!).getTime()).toBeLessThanOrEqual(e.h.now().getTime());
    await tick(e.h.db, e.h.now(), e.g.fetch);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "BILLING_ERROR" });

    e.h.setNow(new Date("2026-10-10T12:00:00Z"));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: new Date("2026-11-10T12:00:00Z"), order: "GPA.1000-0000-0000-00001..0", ack: true }));
    await e.rtdn(subNote(1, "tok_pro_1"));
    expect(await e.events("RENEWAL")).toHaveLength(1);
    ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro).toMatchObject({ billing_issues_detected_at: null, grace_period_expires_date: null, expires_date: "2026-11-10T12:00:00Z" });
  });

  it("on hold without a grace period: BILLING_ISSUE and CANCELLATION, and no access", async () => {
    await purchased();
    e.h.setNow(new Date("2026-10-01T13:00:00Z"));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_ON_HOLD", ack: true }));
    await e.rtdn(subNote(5, "tok_pro_1"));
    expect(await e.events("BILLING_ISSUE")).toHaveLength(1);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "BILLING_ERROR" });
    const ci = await info("user_a");
    expect(new Date(ci.subscriber.entitlements.pro!.expires_date!).getTime()).toBeLessThanOrEqual(e.h.now().getTime());
  });

  it("pause: a scheduled pause sends SUBSCRIPTION_PAUSED with auto_resume_at_ms and keeps access; the pause starting ends access", async () => {
    await purchased();
    e.h.setNow(at(10));
    const resume = new Date("2026-11-01T12:00:00Z");
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1000-0000-0000-00001", ack: true }));
    e.g.v1.set("tok_pro_1", { autoResumeTimeMillis: String(resume.getTime()) });
    await e.rtdn(subNote(11, "tok_pro_1"));
    const [paused] = await e.events("SUBSCRIPTION_PAUSED");
    expect(paused).toMatchObject({ auto_resume_at_ms: resume.getTime() });
    let ci = await info("user_a");
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
    expect(ci.subscriber.subscriptions.pro!.auto_resume_date).toBe("2026-11-01T12:00:00Z");

    e.h.setNow(new Date("2026-10-01T12:01:00Z"));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_PAUSED", autoResume: resume, ack: true }));
    await e.rtdn(subNote(10, "tok_pro_1"));
    expect(await e.events("SUBSCRIPTION_PAUSED")).toHaveLength(1);
    ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro!.auto_resume_date).toBe("2026-11-01T12:00:00Z");
    expect(new Date(ci.subscriber.entitlements.pro!.expires_date!).getTime()).toBeLessThanOrEqual(e.h.now().getTime());
  });

  it("cancel then restore: CANCELLATION(UNSUBSCRIBE) at the cancel time, then UNCANCELLATION", async () => {
    await purchased();
    e.h.setNow(at(5));
    const cancelled = sub({ start: T0, expiry: MONTH_END, order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_CANCELED", cancelTime: at(4), ack: true });
    cancelled.canceledStateContext!.userInitiatedCancellation!.cancelSurveyResult = { reason: "CANCEL_SURVEY_REASON_COST_RELATED" };
    e.g.subs.set("tok_pro_1", cancelled);
    await e.rtdn(subNote(3, "tok_pro_1"));
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "UNSUBSCRIBE" });
    // The cancel survey answer is kept for the Play Store Cancel Reasons chart (not sent on webhooks).
    const surveyOf = async () => (await e.h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.storeKey, "tok_pro_1")))[0]!.cancelSurveyReason;
    expect(await surveyOf()).toBe("CANCEL_SURVEY_REASON_COST_RELATED");
    expect((await e.events("CANCELLATION"))[0]).not.toHaveProperty("cancel_survey_reason");
    let ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro!.unsubscribe_detected_at).toBe(at(4).toISOString().replace(".000", ""));
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");

    e.h.setNow(at(6));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1000-0000-0000-00001", ack: true }));
    await e.rtdn(subNote(7, "tok_pro_1"));
    expect(await e.events("UNCANCELLATION")).toHaveLength(1);
    ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro!.unsubscribe_detected_at).toBeNull();
    expect(await surveyOf()).toBeNull();
  });

  it("a voided purchase refunds the current period: CANCELLATION(CUSTOMER_SUPPORT) with a negative price, access ends", async () => {
    await purchased();
    e.h.setNow(at(3));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_EXPIRED", ack: true }));
    await e.rtdn({ voidedPurchaseNotification: { purchaseToken: "tok_pro_1", orderId: "GPA.1000-0000-0000-00001", productType: 1, refundType: 1 } });
    const cancels = await e.events("CANCELLATION");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -9.99, price_in_purchased_currency: -9.99 });
    const ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro!.refunded_at).toBe("2026-09-04T12:00:00Z");
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-09-04T12:00:00Z");
    const refunds = await e.h.db.select().from(schema.transactions).where(eq(schema.transactions.kind, "refund"));
    expect(refunds[0]!.revenueUsd).toBe(-9.99);
    // Google also sends SUBSCRIPTION_REVOKED for the same refund: nothing new.
    await e.rtdn(subNote(12, "tok_pro_1"));
    expect(await e.events("CANCELLATION")).toHaveLength(1);
    await tick(e.h.db, e.h.now(), e.g.fetch);
    expect(await e.events("EXPIRATION")).toHaveLength(0);
  });

  it("a voided one-time purchase is refunded", async () => {
    e.g.products.set("lifetime_unlock|tok_life", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, orderId: "GPA.L1", acknowledgementState: 1 });
    await e.receipt({ app_user_id: "lifer", fetch_token: "tok_life", product_ids: ["lifetime_unlock"], platform_product_ids: [{ product_id: "lifetime_unlock" }], price: 49.99, currency: "USD" });
    e.h.setNow(at(1));
    await e.rtdn({ voidedPurchaseNotification: { purchaseToken: "tok_life", orderId: "GPA.L1", productType: 2, refundType: 1 } });
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -49.99 });
    const ci = await info("lifer");
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-09-02T12:00:00Z");
  });

  it("upgrade: the new token is its own chain (INITIAL_PURCHASE) and the linked old chain gets PRODUCT_CHANGE and ends", async () => {
    await purchased();
    e.h.setNow(at(10));
    e.g.subs.set("tok_premium", sub({ product: "premium", start: at(10), expiry: new Date(at(10).getTime() + 30 * DAY), order: "GPA.2000-0000-0000-00002", linked: "tok_pro_1", price: 19.99 }));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: at(10), order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_EXPIRED", replaced: true, ack: true }));
    const res = await e.receipt({ app_user_id: "user_a", fetch_token: "tok_premium", product_ids: ["premium"], platform_product_ids: [{ product_id: "premium", base_plan_id: "monthly" }], price: 19.99, currency: "USD" });
    expect(res.status).toBe(200);
    expect((await e.events("INITIAL_PURCHASE")).map((x) => x.product_id)).toEqual(["pro", "premium"]);

    await e.rtdn(subNote(4, "tok_premium", "premium"));
    const changes = await e.events("PRODUCT_CHANGE");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ product_id: "pro", original_transaction_id: "GPA.1000-0000-0000-00001", expiration_at_ms: at(10).getTime(), app_user_id: "user_a" });
    expect(changes[0]!.new_product_id).toBeUndefined();
    const ci = await info("user_a");
    expect(ci.subscriber.subscriptions.pro!.expires_date).toBe("2026-09-11T12:00:00Z");
    expect(ci.subscriber.entitlements.pro).toMatchObject({ product_identifier: "premium", product_plan_identifier: "monthly" });

    // Old-token notifications and redeliveries add nothing: no CANCELLATION, no EXPIRATION, no second PRODUCT_CHANGE.
    await e.rtdn(subNote(13, "tok_pro_1"));
    await e.rtdn(subNote(4, "tok_premium", "premium"));
    e.h.setNow(at(11));
    await tick(e.h.db, e.h.now(), e.g.fetch);
    expect(await e.events("PRODUCT_CHANGE")).toHaveLength(1);
    expect(await e.events("CANCELLATION")).toHaveLength(0);
    expect(await e.events("EXPIRATION")).toHaveLength(0);
  });

  it("a replacement notified before the device posts it is attached to the old chain's customer", async () => {
    await purchased();
    e.h.setNow(at(10));
    e.g.subs.set("tok_premium", sub({ product: "premium", start: at(10), expiry: new Date(at(10).getTime() + 30 * DAY), order: "GPA.2", linked: "tok_pro_1" }));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: at(10), order: "GPA.1000-0000-0000-00001", state: "SUBSCRIPTION_STATE_EXPIRED", replaced: true, ack: true }));
    const res = await e.rtdn(subNote(4, "tok_premium", "premium"));
    expect(await res.json()).toEqual({ status: "processed" });
    expect(e.g.acks("tok_premium")).toHaveLength(1);
    const ci = await info("user_a");
    expect(ci.subscriber.subscriptions.premium).toBeDefined();
    expect(await e.events("PRODUCT_CHANGE")).toHaveLength(1);
  });

  it("unknown purchases are ignored unless track_new_purchases is on, then they go to a new anonymous customer", async () => {
    e.g.subs.set("tok_new", sub({ start: T0, expiry: MONTH_END, order: "GPA.N" }));
    let res = await e.rtdn(subNote(4, "tok_new"));
    expect(await res.json()).toEqual({ status: "unknown_purchase" });
    expect(await e.h.db.select().from(schema.subscriptions)).toHaveLength(0);
    expect(e.g.acks("tok_new")).toHaveLength(1);

    await e.h.db.update(schema.apps).set({ credentials: { service_account: keys.sa, track_new_purchases: true } }).where(eq(schema.apps.id, e.h.ids.androidApp));
    res = await e.rtdn(subNote(4, "tok_new"));
    expect(await res.json()).toEqual({ status: "processed" });
    const [initial] = await e.events("INITIAL_PURCHASE");
    expect(initial!.app_user_id).toMatch(/^\$RCAnonymousID:/);
  });

  it("one-time product notifications record the purchase and acknowledge non-consumables", async () => {
    await e.h.db.update(schema.apps).set({ credentials: { service_account: keys.sa, track_new_purchases: true } }).where(eq(schema.apps.id, e.h.ids.androidApp));
    e.g.products.set("lifetime_unlock|tok_l2", { purchaseTimeMillis: String(T0.getTime()), purchaseState: 0, orderId: "GPA.L2", acknowledgementState: 0 });
    const res = await e.rtdn({ oneTimeProductNotification: { version: "1.0", notificationType: 1, purchaseToken: "tok_l2", sku: "lifetime_unlock" } });
    expect(await res.json()).toEqual({ status: "processed" });
    expect(await e.events("NON_RENEWING_PURCHASE")).toHaveLength(1);
    expect(e.g.acks("tok_l2")).toHaveLength(1);
  });

  it("Google outages answer 500 so Pub/Sub redelivers; the redelivery is processed", async () => {
    await purchased();
    e.h.setNow(new Date("2026-10-01T12:05:00Z"));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: new Date("2026-11-01T12:00:00Z"), order: "GPA.1000-0000-0000-00001..0", ack: true }));
    e.g.override = (url) => (url.startsWith(API) ? new Response("oops", { status: 500 }) : undefined);
    let res = await e.rtdn(subNote(2, "tok_pro_1"), { messageId: "m-1" });
    expect(res.status).toBe(500);
    let [row] = await e.h.db.select().from(schema.storeNotifications);
    expect(row!.processedAt).toBeNull();
    expect(row!.error).toMatch(/500/);
    e.g.override = null;
    res = await e.rtdn(subNote(2, "tok_pro_1"), { messageId: "m-1" });
    expect(res.status).toBe(200);
    [row] = await e.h.db.select().from(schema.storeNotifications);
    expect(row!.processedAt).not.toBeNull();
    expect(await e.events("RENEWAL")).toHaveLength(1);
  });

  it("an invalid token or another package is acknowledged (200) and recorded as an error", async () => {
    let res = await e.rtdn(subNote(2, "tok_missing"));
    expect(res.status).toBe(200);
    res = await e.rtdn({ packageName: "com.other.app", ...subNote(2, "tok_missing") });
    expect(await res.json()).toEqual({ status: "ignored" });
    const rows = await e.h.db.select().from(schema.storeNotifications);
    expect(rows.every((r) => r.error && r.processedAt)).toBe(true);
    expect((await e.call("/v1/notifications/google/app_ios", { method: "POST", json: {} })).status).toBe(404);
    expect((await e.call("/v1/notifications/google/app_play", { method: "POST", body: "nope" })).status).toBe(400);
  });

  it("verifies the Pub/Sub push OIDC token when an audience is configured", async () => {
    const aud = "https://api.example.com/v1/notifications/google/app_play";
    await e.h.db.update(schema.apps).set({ credentials: { service_account: keys.sa, pubsub_audience: aud, pubsub_service_account: "pubsub@scanner.iam.gserviceaccount.com" } }).where(eq(schema.apps.id, e.h.ids.androidApp));
    const token = await pushToken(keys, e.g, aud);
    expect((await e.rtdn({ testNotification: {} })).status).toBe(401);
    expect((await e.rtdn({ testNotification: {} }, { auth: `Bearer ${await pushToken(keys, e.g, "https://wrong")}` })).status).toBe(401);
    expect((await e.rtdn({ testNotification: {} }, { auth: `Bearer ${await pushToken(keys, e.g, aud, "someone@else.com")}` })).status).toBe(401);
    expect((await e.rtdn({ testNotification: {} }, { auth: `Bearer ${token}` })).status).toBe(200);
  });
});
