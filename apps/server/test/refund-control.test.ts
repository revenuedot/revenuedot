import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "../src/services/auth.js";
import { applyPurchases } from "../src/services/purchases.js";
import { getOrCreateCustomer } from "../src/repo/customers.js";
import { buildConsumptionRequest, buildConsumptionRequestV2, choosePolicy, consumptionPercentage, consumptionVersionFor, consumptionVersionOf, spentOfGrant, dollarsBucket, playTimeBucket, retryDueConsumption, tenureBucket, type ConsumptionInput, type PolicyRow } from "../src/services/refunds.js";
import { emptyContext } from "../src/services/targeting.js";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import type { VerifiedPurchase } from "../src/stores/types.js";
import { APP_ID, DAY, T0, appleHarness, makeP8, makePki, notificationBody, renewalInfo, signJws, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";

/** Refund Control (prd/lifecycle/PRD.md): policies, Apple's Send Consumption Information (V2, and V1 for Advanced Commerce), the 12-hour window, outcomes, cards. */

let pki: Pki;
let h: AppleHarness | undefined;
beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
afterAll(() => setAppleRootsForTesting(null));
afterEach(async () => { await h?.close(); h = undefined; });

const HOUR = 3_600_000;
const TOKEN = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";

describe("the ConsumptionRequestV1 payload", () => {
  const base: ConsumptionInput = {
    now: T0, customerConsented: true, preference: "prefer_no_refund", appAccountToken: TOKEN, productType: "subscription",
    purchasedAt: T0 - 10 * DAY, expiresAt: T0 + 20 * DAY,
    customer: { firstSeenAt: T0 - 40 * DAY, lastSeenAt: T0 - 2 * DAY, platform: "iOS", lifetimePurchasedUsd: 59.94, lifetimeRefundedUsd: 0, hadFreeTrial: true, attributes: {} },
  };

  it("fills every field from RevenueDot's records", () => {
    expect(buildConsumptionRequest(base)).toEqual({
      accountTenure: 4, appAccountToken: TOKEN, consumptionStatus: 2, customerConsented: true, deliveryStatus: 0,
      lifetimeDollarsPurchased: 3, lifetimeDollarsRefunded: 1, platform: 1, playTime: 0, refundPreference: 2, sampleContentProvided: true, userStatus: 1,
    });
  });

  it("maps preferences: full refund 1, no refund 2, consumption data only 0 (undeclared); V1 has no prorated refund, so prorated is 1", () => {
    expect(buildConsumptionRequest({ ...base, preference: "prefer_refund" }).refundPreference).toBe(1);
    expect(buildConsumptionRequest({ ...base, preference: "prefer_prorated_refund" }).refundPreference).toBe(1);
    expect(buildConsumptionRequest({ ...base, preference: "prefer_no_refund" }).refundPreference).toBe(2);
    expect(buildConsumptionRequest({ ...base, preference: "consumption_only" }).refundPreference).toBe(0);
  });

  it("consumption status: a finished period is fully consumed, an unused one not consumed; currency balances decide for consumables", () => {
    expect(buildConsumptionRequest({ ...base, now: T0 + 21 * DAY }).consumptionStatus).toBe(3);
    expect(buildConsumptionRequest({ ...base, customer: { ...base.customer!, lastSeenAt: T0 - 10 * DAY } }).consumptionStatus).toBe(1);
    expect(buildConsumptionRequest({ ...base, productType: "non_consumable" }).consumptionStatus).toBe(2);
    const coins = (balance: number) => buildConsumptionRequest({ ...base, productType: "consumable", customer: { ...base.customer!, currency: { granted: 100, balance } } }).consumptionStatus;
    expect([coins(100), coins(40), coins(0)]).toEqual([1, 2, 3]);
    expect(buildConsumptionRequest({ ...base, productType: "consumable" }).consumptionStatus).toBe(0);
  });

  it("an unknown customer declares nothing it cannot know, and an empty app account token is \"\"", () => {
    expect(buildConsumptionRequest({ ...base, customer: null, appAccountToken: null })).toEqual({
      accountTenure: 0, appAccountToken: "", consumptionStatus: 0, customerConsented: true, deliveryStatus: 0,
      lifetimeDollarsPurchased: 0, lifetimeDollarsRefunded: 0, platform: 0, playTime: 0, refundPreference: 2, sampleContentProvided: false, userStatus: 0,
    });
  });

  it("Android customers are a non-Apple platform; the app can report play time and account status as custom attributes", () => {
    const p = buildConsumptionRequest({ ...base, customer: { ...base.customer!, platform: "android", attributes: { rd_play_time_minutes: "90", rd_user_status: "suspended" } } });
    expect([p.platform, p.playTime, p.userStatus]).toEqual([2, 3, 2]);
  });

  it("uses Apple's buckets", () => {
    expect([1, 5, 20, 60, 100, 200, 400].map((d) => tenureBucket(d * DAY))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([0, 0.01, 50, 100, 500, 1000, 2000].map(dollarsBucket)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect([1, 30, 120, 600, 2000, 10000, 30000].map(playTimeBucket)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("the ConsumptionRequest (V2) payload", () => {
  const base: ConsumptionInput = {
    now: T0, customerConsented: true, preference: "prefer_no_refund", appAccountToken: TOKEN, productType: "subscription",
    purchasedAt: T0 - 10 * DAY, expiresAt: T0 + 20 * DAY,
    customer: { firstSeenAt: T0 - 40 * DAY, lastSeenAt: T0 - 2 * DAY, platform: "iOS", lifetimePurchasedUsd: 59.94, lifetimeRefundedUsd: 0, hadFreeTrial: true, attributes: {} },
  };

  it("an auto-renewable subscription sends the five fields Apple documents, with string enums and no consumption percentage", () => {
    expect(buildConsumptionRequestV2(base)).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", refundPreference: "DECLINE", sampleContentProvided: true });
    expect(Object.keys(buildConsumptionRequestV2(base))).toEqual(["customerConsented", "deliveryStatus", "refundPreference", "sampleContentProvided"]);
    expect(buildConsumptionRequestV2({ ...base, preference: "prefer_refund" }).refundPreference).toBe("GRANT_FULL");
    expect(buildConsumptionRequestV2({ ...base, preference: "consumption_only" })).not.toHaveProperty("refundPreference");
    // Apple computes the prorated share of an auto-renewable subscription from elapsed time.
    expect(buildConsumptionRequestV2({ ...base, preference: "prefer_prorated_refund" })).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", refundPreference: "GRANT_PRORATED", sampleContentProvided: true });
    expect(buildConsumptionRequestV2({ ...base, customer: null })).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", refundPreference: "DECLINE", sampleContentProvided: false });
  });

  it("consumption percentage in milliunits: time used of a non-renewing period, currency spent of a consumable, unused non-consumables", () => {
    const nonRenewing = { ...base, productType: "non_renewing_subscription" as const, purchasedAt: T0 - 10 * DAY, expiresAt: T0 + 20 * DAY };
    expect(consumptionPercentage(nonRenewing)).toBe(33333);
    expect(consumptionPercentage({ ...nonRenewing, now: T0 + 30 * DAY })).toBe(100000);
    expect(consumptionPercentage({ ...nonRenewing, expiresAt: null })).toBeNull();
    const coins = (amount: number, of = 100) => consumptionPercentage({ ...base, productType: "consumable", customer: { ...base.customer!, currency: { granted: of, balance: 0, spent: { amount, of } } } });
    expect([coins(0), coins(60), coins(100), coins(1, 3)]).toEqual([0, 60000, 100000, 33333]);
    expect(coins(Number.NaN)).toBeNull();
    // Without this purchase's grant in the ledger, the balance alone does not say what was spent.
    expect(consumptionPercentage({ ...base, productType: "consumable", customer: { ...base.customer!, currency: { granted: 100, balance: 40, spent: null } } })).toBeNull();
    expect(consumptionPercentage({ ...base, productType: "consumable" })).toBeNull();
    expect(consumptionPercentage({ ...base, productType: "non_consumable", customer: { ...base.customer!, lastSeenAt: base.purchasedAt } })).toBe(0);
    expect(consumptionPercentage({ ...base, productType: "non_consumable" })).toBeNull();
    expect(consumptionPercentage({ ...base, productType: "non_consumable", customer: null })).toBeNull();
    expect(consumptionPercentage(base)).toBeNull();
    expect(buildConsumptionRequestV2({ ...nonRenewing, preference: "consumption_only" })).toEqual({ customerConsented: true, consumptionPercentage: 33333, deliveryStatus: "DELIVERED", sampleContentProvided: true });
  });

  it("a prorated preference needs a percentage strictly between 0 and 100000 outside auto-renewable subscriptions", () => {
    const coins = (balance: number | null) => buildConsumptionRequestV2({ ...base, preference: "prefer_prorated_refund", productType: "consumable", customer: { ...base.customer!, hadFreeTrial: false, currency: balance === null ? null : { granted: 100, balance, spent: { amount: 100 - balance, of: 100 } } } });
    expect(coins(40)).toEqual({ customerConsented: true, consumptionPercentage: 60000, deliveryStatus: "DELIVERED", refundPreference: "GRANT_PRORATED", sampleContentProvided: false });
    expect(coins(100)).toMatchObject({ consumptionPercentage: 0, refundPreference: "GRANT_FULL" });
    expect(coins(0)).toMatchObject({ consumptionPercentage: 100000, refundPreference: "DECLINE" });
    expect(coins(null)).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", sampleContentProvided: false });
  });

  it("picks the version: V1 only for Advanced Commerce API transactions; a stored payload tells its version by shape", () => {
    expect(consumptionVersionFor({})).toBe("v2");
    expect(consumptionVersionFor({ advancedCommerceInfo: { requestReferenceId: "r1" } })).toBe("v1");
    expect(consumptionVersionOf(buildConsumptionRequest(base) as unknown as Record<string, unknown>)).toBe("v1");
    expect(consumptionVersionOf(buildConsumptionRequestV2(base) as unknown as Record<string, unknown>)).toBe("v2");
    expect(consumptionVersionOf(null)).toBeNull();
  });
});

describe("policy evaluation", () => {
  const ctx = { ...emptyContext(), platform: "ios", country: "US", lastRenewalAt: T0 - HOUR, firstPurchaseAt: T0 - 100 * DAY };
  const policy = (id: string, position: number, field: string, operator: string, value: string, preference: string): PolicyRow =>
    ({ id, name: id, position, preference, rules: { groups: [{ conditions: [{ field, operator, value }] }] } });

  it("takes the first matching policy by position, else the default", () => {
    const ps = [policy("new", 0, "firstPurchaseAt", "within", "7d", "prefer_refund"), policy("renewed", 1, "lastRenewalAt", "within", "24h", "prefer_no_refund"), policy("ios", 2, "platform", "is", "ios", "consumption_only")];
    expect(choosePolicy(ps, ctx, T0, "do_not_respond")).toEqual({ policyId: "renewed", policyName: "renewed", preference: "prefer_no_refund" });
    expect(choosePolicy([ps[2]!, ps[1]!].map((p, i) => ({ ...p, position: i })), ctx, T0, "do_not_respond").policyId).toBe("ios");
    expect(choosePolicy([ps[0]!], ctx, T0, "consumption_only")).toEqual({ policyId: null, policyName: "Default policy", preference: "consumption_only" });
    expect(choosePolicy([{ ...ps[0]!, rules: { groups: [] } }], ctx, T0, "do_not_respond").policyId).toBe("new");
  });
});

/** A fake App Store Server API: records consumption PUTs and answers with the status the test sets. */
function fakeApple() {
  const calls: { method: string; url: string; auth: string | null; body: any }[] = [];
  let status = 202;
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (/\/inApps\/v[12]\/transactions\/consumption\//.test(url)) return new Response(status === 202 ? null : JSON.stringify({ errorCode: 0 }), { status });
    return new Response(JSON.stringify({ errorCode: 4040010 }), { status: 404 });
  };
  return { fetch, calls, setStatus: (s: number) => { status = s; } };
}

const purchase = (over: Record<string, unknown> = {}) => transaction({ transactionId: "2000000101", originalTransactionId: "2000000101", purchaseDate: T0 - 10 * DAY, originalPurchaseDate: T0 - 10 * DAY, expiresDate: T0 + 20 * DAY, appAccountToken: TOKEN, ...over });

async function setup(o: { consent?: boolean; policies?: unknown[]; defaultPreference?: string } = {}) {
  const apple = fakeApple();
  h = await appleHarness({ fetch: apple.fetch });
  expect((await h.postReceipt("refund_asker", await signJws(purchase(), pki))).status).toBe(200);
  // The key is added after the purchase, so the receipt was verified from its JWS alone.
  await h.db.update(schema.apps).set({ credentials: { key_id: "KEY123", issuer_id: "issuer", private_key: await makeP8() } }).where(eq(schema.apps.id, APP_ID));
  const { key } = await createSecretKey(h.db, "proj1", "refunds");
  const save = await h.request("/v2/projects/proj1/refund_control", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ settings: { customer_consented: o.consent ?? true, default_preference: o.defaultPreference ?? "consumption_only" }, policies: o.policies ?? [] }),
  });
  expect(save.status).toBe(200);
  return { apple, key };
}

/** notificationBody's `over` replaces `data`, so the signed transaction goes back in here. */
async function consumptionNotification(signedDate = T0 + 2 * DAY, over: Record<string, unknown> = {}) {
  const tx = await signJws(purchase(over), pki);
  return notificationBody(pki, "CONSUMPTION_REQUEST", undefined, null, null, {
    signedDate, data: { bundleId: "com.example.scanner", environment: "Production", appAppleId: 1234567890, consumptionRequestReason: "UNSATISFIED_WITH_PURCHASE", signedTransactionInfo: tx },
  });
}

const requests = async () => h!.db.select().from(schema.refundRequests);

describe("CONSUMPTION_REQUEST", () => {
  it("evaluates the policies and sends Apple the consumption information (V2) once, with the In-App Purchase key", async () => {
    const { apple, key } = await setup({ policies: [
      { name: "Recent renewals", template: "recent_renewal", rules: { groups: [{ conditions: [{ field: "lastRenewalAt", operator: "within", value: "24h" }] }] }, preference: "prefer_refund" },
      { name: "iPhone customers", template: "platform", rules: { groups: [{ conditions: [{ field: "platform", operator: "isAnyOf", value: "ios,ipados" }] }] }, preference: "prefer_no_refund" },
    ] });
    h!.setNow(T0 + 2 * DAY + 5000);
    const res = await h!.notify(await consumptionNotification());
    expect(res.status).toBe(200);
    const puts = apple.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe("https://api.storekit.apple.com/inApps/v2/transactions/consumption/2000000101");
    expect(puts[0]!.auth).toMatch(/^Bearer ey/);
    expect(puts[0]!.body).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", refundPreference: "DECLINE", sampleContentProvided: false });
    const [row] = await requests();
    expect(row).toMatchObject({
      store: "app_store", transactionId: "2000000101", productId: "pro_monthly", appUserId: "refund_asker", amountUsd: 9.99, reason: "UNSATISFIED_WITH_PURCHASE",
      policyName: "iPhone customers", preference: "prefer_no_refund", consumptionStatus: "sent", outcome: "pending", attempts: 1,
    });
    expect(row!.deadlineAt!.getTime()).toBe(T0 + 2 * DAY + 12 * HOUR);

    // Apple repeats the notification: nothing is sent twice.
    expect((await h!.notify(await consumptionNotification())).status).toBe(200);
    expect(apple.calls.filter((c) => c.method === "PUT")).toHaveLength(1);

    const list = await (await h!.request("/v2/projects/proj1/refund_requests", { headers: { Authorization: `Bearer ${key}` } })).json() as any;
    expect(list.items[0]).toMatchObject({ object: "refund_request", app_user_id: "refund_asker", consumption_status: "sent", consumption_version: "v2", policy_name: "iPhone customers", outcome: "pending" });
  });

  it("an Advanced Commerce API transaction is answered with Send Consumption Information V1 (all 12 fields)", async () => {
    const { apple, key } = await setup({ defaultPreference: "prefer_prorated_refund" });
    h!.setNow(T0 + 2 * DAY + 5000);
    expect((await h!.notify(await consumptionNotification(T0 + 2 * DAY, { advancedCommerceInfo: { requestReferenceId: "8f2b", period: "P1M" } }))).status).toBe(200);
    const puts = apple.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe("https://api.storekit.itunes.apple.com/inApps/v1/transactions/consumption/2000000101");
    expect(puts[0]!.body).toEqual({
      accountTenure: 3, appAccountToken: TOKEN, consumptionStatus: 2, customerConsented: true, deliveryStatus: 0,
      lifetimeDollarsPurchased: 2, lifetimeDollarsRefunded: 1, platform: 1, playTime: 0, refundPreference: 1, sampleContentProvided: false, userStatus: 1,
    });
    const list = await (await h!.request("/v2/projects/proj1/refund_requests", { headers: { Authorization: `Bearer ${key}` } })).json() as any;
    expect(list.items[0]).toMatchObject({ consumption_status: "sent", consumption_version: "v1", preference: "prefer_prorated_refund" });
  });

  it("a prorated preference sends GRANT_PRORATED for an auto-renewable subscription, and V2 keeps its version through tick retries", async () => {
    const { apple } = await setup({ defaultPreference: "prefer_prorated_refund" });
    apple.setStatus(500);
    h!.setNow(T0 + 2 * DAY);
    await h!.notify(await consumptionNotification());
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "pending", attempts: 1, consumption: { customerConsented: true, deliveryStatus: "DELIVERED", refundPreference: "GRANT_PRORATED", sampleContentProvided: false } });
    apple.setStatus(202);
    h!.setNow(T0 + 2 * DAY + 6 * 60_000);
    expect(await retryDueConsumption({ db: h!.db, stores: {}, now: h!.now, fetch: apple.fetch as unknown as typeof fetch })).toBe(1);
    const puts = apple.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.url)).toEqual(Array(2).fill("https://api.storekit.apple.com/inApps/v2/transactions/consumption/2000000101"));
    expect(puts[1]!.body).toEqual({ customerConsented: true, deliveryStatus: "DELIVERED", refundPreference: "GRANT_PRORATED", sampleContentProvided: false });
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "sent", attempts: 2 });
  });

  it("a queued Advanced Commerce answer is retried by the tick on the V1 path", async () => {
    const { apple } = await setup();
    apple.setStatus(503);
    h!.setNow(T0 + 2 * DAY);
    await h!.notify(await consumptionNotification(T0 + 2 * DAY, { advancedCommerceInfo: { requestReferenceId: "8f2b" } }));
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "pending", attempts: 1 });
    apple.setStatus(202);
    h!.setNow(T0 + 2 * DAY + 6 * 60_000);
    expect(await retryDueConsumption({ db: h!.db, stores: {}, now: h!.now, fetch: apple.fetch as unknown as typeof fetch })).toBe(1);
    expect(apple.calls.filter((c) => c.method === "PUT").map((c) => c.url)).toEqual(Array(2).fill("https://api.storekit.itunes.apple.com/inApps/v1/transactions/consumption/2000000101"));
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "sent", attempts: 2 });
  });

  it("a non-renewing subscription reports the share of its period used, from the product's duration (Apple sends no expiry)", async () => {
    const { apple } = await setup({ defaultPreference: "prefer_prorated_refund" });
    await h!.db.insert(schema.products).values({ id: "prod_season", projectId: "proj1", appId: APP_ID, storeIdentifier: "season_pass", type: "non_renewing_subscription", duration: "P30D" });
    h!.setNow(T0 + 5 * DAY);
    const season = { transactionId: "2000000303", originalTransactionId: "2000000303", productId: "season_pass", type: "Non-Renewing Subscription", expiresDate: undefined };
    await h!.notify(await consumptionNotification(T0 + 5 * DAY, season));
    const puts = apple.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.url)).toEqual(["https://api.storekit.apple.com/inApps/v2/transactions/consumption/2000000303"]);
    expect(puts[0]!.body).toEqual({ customerConsented: true, consumptionPercentage: 50000, deliveryStatus: "DELIVERED", refundPreference: "GRANT_PRORATED", sampleContentProvided: false });
  });

  it("Apple refusing the V2 request (400 with an error code) fails it without retrying", async () => {
    const { apple } = await setup();
    apple.setStatus(400);
    h!.setNow(T0 + 2 * DAY);
    await h!.notify(await consumptionNotification());
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "failed", attempts: 1, nextAttemptAt: null });
    h!.setNow(T0 + 2 * DAY + HOUR);
    expect(await retryDueConsumption({ db: h!.db, stores: {}, now: h!.now, fetch: apple.fetch as unknown as typeof fetch })).toBe(0);
    expect(apple.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("sends nothing without the customer-consent confirmation, or when the policy says not to respond", async () => {
    const { apple } = await setup({ consent: false });
    await h!.notify(await consumptionNotification());
    expect(apple.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "skipped", preference: "consumption_only", lastError: expect.stringMatching(/consent/) });
    await h!.close();

    const second = await setup({ defaultPreference: "do_not_respond" });
    await h!.notify(await consumptionNotification());
    expect(second.apple.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "skipped", policyName: "Default policy", preference: "do_not_respond" });
  });

  it("retries a failed answer from the tick inside the 12-hour window, and gives up when the window closes", async () => {
    const { apple } = await setup();
    apple.setStatus(503);
    h!.setNow(T0 + 2 * DAY);
    await h!.notify(await consumptionNotification());
    let [row] = await requests();
    expect(row).toMatchObject({ consumptionStatus: "pending", attempts: 1 });
    expect(row!.nextAttemptAt!.getTime()).toBe(T0 + 2 * DAY + 5 * 60_000);

    const deps = { db: h!.db, stores: {}, now: h!.now };
    // The harness's Apple store carries the fake fetch; the tick reaches it through appleApiFor's fallback.
    const tickDeps = { ...deps, fetch: apple.fetch as unknown as typeof fetch };
    h!.setNow(T0 + 2 * DAY + 60_000);
    expect(await retryDueConsumption(tickDeps)).toBe(0);
    h!.setNow(T0 + 2 * DAY + 6 * 60_000);
    expect(await retryDueConsumption(tickDeps)).toBe(1);
    [row] = await requests();
    expect(row).toMatchObject({ consumptionStatus: "pending", attempts: 2 });
    apple.setStatus(202);
    h!.setNow(T0 + 2 * DAY + 30 * 60_000);
    await retryDueConsumption(tickDeps);
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "sent", attempts: 3 });

    // A second request that keeps failing expires at the deadline (minus a 5-minute margin).
    await h!.db.update(schema.refundRequests).set({ consumptionStatus: "pending", nextAttemptAt: new Date(T0 + 2 * DAY + 11.95 * HOUR), sentAt: null });
    apple.setStatus(500);
    h!.setNow(T0 + 2 * DAY + 11.96 * HOUR);
    await retryDueConsumption(tickDeps);
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "expired" });
    const before = apple.calls.length;
    h!.setNow(T0 + 2 * DAY + 13 * HOUR);
    await retryDueConsumption(tickDeps);
    expect(apple.calls.length).toBe(before);
  });

  it("a queued retry sends nothing once consent is turned off, and one tick never sends a request twice", async () => {
    const { apple, key } = await setup();
    apple.setStatus(503);
    h!.setNow(T0 + 2 * DAY);
    await h!.notify(await consumptionNotification());
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "pending", attempts: 1 });
    const tickDeps = { db: h!.db, stores: {}, now: h!.now, fetch: apple.fetch as unknown as typeof fetch };
    // Two overlapping ticks: only one of them claims the request.
    apple.setStatus(202);
    h!.setNow(T0 + 2 * DAY + 6 * 60_000);
    const [x, y] = await Promise.all([retryDueConsumption(tickDeps), retryDueConsumption(tickDeps)]);
    expect(x + y).toBe(1);
    expect(apple.calls.filter((c) => c.method === "PUT")).toHaveLength(2);

    // Queue it again, then turn consent off before the tick: the request is skipped, Apple hears nothing.
    await h!.db.update(schema.refundRequests).set({ consumptionStatus: "pending", nextAttemptAt: new Date(T0 + 2 * DAY + 7 * 60_000), sentAt: null });
    await h!.request("/v2/projects/proj1/refund_control", { method: "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ settings: { customer_consented: false } }) });
    h!.setNow(T0 + 2 * DAY + 8 * 60_000);
    await retryDueConsumption(tickDeps);
    expect(apple.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    expect((await requests())[0]).toMatchObject({ consumptionStatus: "skipped", lastError: expect.stringMatching(/consent/) });
  });

  it("the same notification delivered twice at once records one request", async () => {
    const { apple } = await setup();
    h!.setNow(T0 + 2 * DAY);
    const body = await consumptionNotification();
    const [a, b] = await Promise.all([h!.notify(body), h!.notify(body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await requests()).toHaveLength(1);
    expect(apple.calls.filter((c) => c.method === "PUT").length).toBeGreaterThanOrEqual(1);
  });

  it("REFUND approves the request and REFUND_DECLINED declines one; the cards count both", async () => {
    const { key } = await setup();
    h!.setNow(T0 + 2 * DAY);
    await h!.notify(await consumptionNotification());
    h!.setNow(T0 + 3 * DAY);
    const refunded = transaction({ ...purchase(), revocationDate: T0 + 3 * DAY, revocationReason: 0 });
    expect((await h!.notify(await notificationBody(pki, "REFUND", undefined, refunded, renewalInfo({ originalTransactionId: "2000000101", autoRenewStatus: 0 })))).status).toBe(200);
    expect((await requests())[0]).toMatchObject({ outcome: "approved", consumptionStatus: "sent" });

    // A second purchase whose refund Apple declined (we never saw its CONSUMPTION_REQUEST).
    const lifetime = transaction({ transactionId: "2000000202", originalTransactionId: "2000000202", productId: "lifetime", type: "Non-Consumable", expiresDate: undefined, price: 29990 });
    expect((await h!.notify(await notificationBody(pki, "REFUND_DECLINED", undefined, lifetime, null))).status).toBe(200);
    const rows = await requests();
    expect(rows.find((r) => r.transactionId === "2000000202")).toMatchObject({ outcome: "declined", consumptionStatus: "not_requested", amountUsd: 29.99 });

    const stats = await (await h!.request("/v2/projects/proj1/refund_control/stats?days=28", { headers: { Authorization: `Bearer ${key}` } })).json() as any;
    expect(stats).toMatchObject({ object: "refund_control_stats", days: 28, refund_rate: 0.5, requests: { approved: 1, declined: 1, pending: 0, total: 2 }, amount_in_usd: { approved: 9.99, declined: 29.99 } });
    const sandbox = await (await h!.request("/v2/projects/proj1/refund_control/stats?environment=sandbox", { headers: { Authorization: `Bearer ${key}` } })).json() as any;
    expect(sandbox.requests.total).toBe(0);
  });
});

describe("currency spent from one purchase's grant", () => {
  it("spends the oldest credits first, and knows nothing without the purchase's grant in the ledger", async () => {
    await setup();
    const { customer } = await getOrCreateCustomer(h!.db, "proj1", "coin_user", new Date(T0));
    const vt = schema.virtualCurrencyTransactions;
    const rows: [string, number, string, string | null][] = [["api", 50, "api", null], ["p1", 100, "purchase", "tx1"], ["s1", -80, "sdk", null], ["p2", 100, "purchase", "tx2"], ["s2", -40, "sdk", null]];
    for (const [i, [id, amount, source, sourceKey]] of rows.entries()) {
      await h!.db.insert(vt).values({ id: `vct_${id}`, projectId: "proj1", customerId: customer.id, code: "COIN", amount, source, sourceKey, createdAt: new Date(T0 + i * 1000) });
    }
    // 120 spent: the 50 credited first, then 70 of the first pack; the second pack is untouched.
    expect(await spentOfGrant(h!.db, "proj1", customer.id, "COIN", "tx1")).toEqual({ amount: 70, of: 100 });
    expect(await spentOfGrant(h!.db, "proj1", customer.id, "COIN", "tx2")).toEqual({ amount: 0, of: 100 });
    expect(await spentOfGrant(h!.db, "proj1", customer.id, "COIN", "tx3")).toBeNull();
  });
});

describe("a refund of an older period", () => {
  it("approves that transaction's request without rolling the subscription back", async () => {
    await setup();
    const renewal = transaction({ transactionId: "2000000102", originalTransactionId: "2000000101", purchaseDate: T0 + 20 * DAY, originalPurchaseDate: T0 - 10 * DAY, expiresDate: T0 + 50 * DAY });
    h!.setNow(T0 + 21 * DAY);
    await h!.notify(await notificationBody(pki, "DID_RENEW", undefined, renewal, renewalInfo({ originalTransactionId: "2000000101" })));
    await h!.notify(await consumptionNotification(T0 + 21 * DAY));
    const older = transaction({ ...purchase(), revocationDate: T0 + 22 * DAY, revocationReason: 0 });
    h!.setNow(T0 + 22 * DAY);
    await h!.notify(await notificationBody(pki, "REFUND", undefined, older, renewalInfo({ originalTransactionId: "2000000101" })));
    expect((await requests())[0]).toMatchObject({ transactionId: "2000000101", outcome: "approved" });
    const [sub] = await h!.db.select().from(schema.subscriptions);
    expect(sub).toMatchObject({ storeTransactionId: "2000000102", refundedAt: null });
  });
});

describe("refunds from other stores", () => {
  it("a Google Play refund or chargeback is recorded approved, with the policy that applies and nothing to answer", async () => {
    await setup();
    const { customer } = await getOrCreateCustomer(h!.db, "proj1", "android_user", new Date(T0));
    const sub = { kind: "subscription", store: "play_store", storeKey: "gp-token-1", productIdentifier: "pro:monthly", isSandbox: false, purchaseDate: new Date(T0 - 5 * DAY), originalPurchaseDate: new Date(T0 - 5 * DAY), expiresDate: new Date(T0 + 25 * DAY), periodType: "normal", ownershipType: "PURCHASED", storeTransactionId: "GPA.1111-2222-3333-44444", originalTransactionId: "GPA.1111-2222-3333-44444", price: { amount: 4.99, currency: "USD" } } as unknown as VerifiedPurchase;
    const ctx = { projectId: "proj1", appId: null, appUserId: "android_user", fromDevice: false };
    await applyPurchases(h!.db, customer, [sub], { ...ctx, now: new Date(T0) });
    await applyPurchases(h!.db, customer, [{ ...sub, refundedAt: new Date(T0 + DAY) } as VerifiedPurchase], { ...ctx, now: new Date(T0 + DAY) });
    expect((await requests())[0]).toMatchObject({ store: "play_store", transactionId: "GPA.1111-2222-3333-44444", outcome: "approved", consumptionStatus: "not_applicable", amountUsd: 4.99, policyName: "Default policy", appUserId: "android_user" });
  });
});

describe("Refund Control settings and policies API", () => {
  it("saves ordered policies, reports per-policy customer counts, and refuses unknown condition fields", async () => {
    const { key } = await setup();
    const call = (body?: unknown) => h!.request("/v2/projects/proj1/refund_control", { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const ios = { name: "iOS", template: "platform", rules: { groups: [{ conditions: [{ field: "platform", operator: "is", value: "ios" }] }] }, preference: "prefer_no_refund" };
    const everyone = { name: "Everyone", template: "custom", rules: { groups: [] }, preference: "prefer_refund" };
    const saved = await (await call({ policies: [ios, everyone] })).json() as any;
    expect(saved.policies.map((p: any) => [p.name, p.position, p.customer_count])).toEqual([["iOS", 0, 1], ["Everyone", 1, 0]]);
    expect(saved.settings).toEqual({ default_preference: "consumption_only", customer_consented: true });
    // Reorder: the same ids in a new order.
    const swapped = await (await call({ policies: [{ ...everyone, id: saved.policies[1].id }, { ...ios, id: saved.policies[0].id }] })).json() as any;
    expect(swapped.policies.map((p: any) => [p.name, p.customer_count])).toEqual([["Everyone", 1], ["iOS", 0]]);
    expect(swapped.policies[0].id).toBe(saved.policies[1].id);
    const bad = await call({ policies: [{ ...ios, rules: { groups: [{ conditions: [{ field: "favouriteColour", operator: "is", value: "red" }] }] } }] });
    expect(bad.status).toBe(400);
    expect((await (await call()).json() as any).policies).toHaveLength(2);

    // A stale tab: an id that is gone fails the whole save, settings included, and deletes nothing.
    const stale = await call({ settings: { default_preference: "prefer_refund" }, policies: [{ ...ios, id: "rfp_gone" }, { ...everyone, id: swapped.policies[0].id }] });
    expect(stale.status).toBe(400);
    const after = await (await call()).json() as any;
    expect(after.policies.map((p: any) => p.id)).toEqual(swapped.policies.map((p: any) => p.id));
    expect(after.settings.default_preference).toBe("consumption_only");
  });
});
