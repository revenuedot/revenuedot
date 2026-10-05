import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { schema } from "@revenuedot/db";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { billingPlanOf, fromTransaction, periodTypeOf } from "../src/stores/apple/map.js";
import { parseAppReceipt } from "../src/stores/apple/receipt.js";
import { base64ToBytes } from "../src/stores/apple/asn1.js";
import {
  BUNDLE, DAY, T0, appleHarness, makeP8, makePki, makeReceipt, makeXcodePki, mockAppleApi, renewalInfo, signJws, transaction,
  type AppleHarness, type Pki,
} from "./apple-fixtures.js";

let pki: Pki;
let h: AppleHarness | undefined;
beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
afterAll(() => setAppleRootsForTesting(null));
afterEach(async () => { await h?.close(); h = undefined; });

const types = (events: { type: string }[]) => events.map((e) => e.type).sort();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const expectInvalid = async (res: Response, message?: RegExp) => {
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.code).toBe(7103);
  if (message) expect(body.message).toMatch(message);
};

describe("StoreKit 2 signed transactions", () => {
  it("a production subscription purchase grants the entitlement and records INITIAL_PURCHASE", async () => {
    h = await appleHarness();
    const res = await h.postReceipt("user1", await signJws(transaction(), pki), { product_id: "pro_monthly", price: "9.99", currency: "USD", store_country: "USA" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({
      store: "app_store", is_sandbox: false, period_type: "normal", ownership_type: "PURCHASED", store_transaction_id: "2000000001",
      purchase_date: iso(T0), original_purchase_date: iso(T0), expires_date: iso(T0 + 30 * DAY), unsubscribe_detected_at: null,
      billing_issues_detected_at: null, refunded_at: null, price: { amount: 9.99, currency: "USD" },
    });
    expect(body.subscriber.entitlements.pro).toMatchObject({ product_identifier: "pro_monthly", expires_date: iso(T0 + 30 * DAY) });
    const events = await h.newEvents();
    expect(types(events)).toEqual(["INITIAL_PURCHASE"]);
    expect(events[0]).toMatchObject({
      store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL", product_id: "pro_monthly", transaction_id: "2000000001",
      original_transaction_id: "2000000001", country_code: "US", currency: "USD", price_in_purchased_currency: 9.99, is_family_share: false,
      app_user_id: "user1", expiration_at_ms: T0 + 30 * DAY,
    });
  });

  it("posting the same transaction again changes nothing and records no event", async () => {
    h = await appleHarness();
    const jws = await signJws(transaction(), pki);
    await h.postReceipt("user1", jws);
    await h.newEvents();
    expect((await h.postReceipt("user1", jws)).status).toBe(200);
    expect(await h.newEvents()).toEqual([]);
  });

  it("maps free trials to trial and paid introductory offers to intro", async () => {
    h = await appleHarness();
    await h.postReceipt("trial_user", await signJws(transaction({ offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0, expiresDate: T0 + 7 * DAY }), pki));
    await h.postReceipt("intro_user", await signJws(transaction({ transactionId: "2000000002", offerType: 1, offerDiscountType: "PAY_AS_YOU_GO", price: 990 }), pki));
    expect((await h.customerInfo("trial_user")).subscriber.subscriptions.pro_monthly.period_type).toBe("trial");
    expect((await h.customerInfo("intro_user")).subscriber.subscriptions.pro_monthly.period_type).toBe("intro");
    const events = await h.newEvents();
    expect(events.map((e) => [e.app_user_id, e.type, e.period_type])).toEqual(expect.arrayContaining([
      ["trial_user", "INITIAL_PURCHASE", "TRIAL"], ["intro_user", "INITIAL_PURCHASE", "INTRO"],
    ]));
  });

  it("period type follows the offer: trial when free, intro for paid intro offers and offer codes, normal for paid promotional offers", () => {
    expect(periodTypeOf({})).toBe("normal");
    expect(periodTypeOf({ offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0 })).toBe("trial");
    expect(periodTypeOf({ offerType: 1, offerDiscountType: "PAY_UP_FRONT", price: 1990 })).toBe("intro");
    expect(periodTypeOf({ offerType: 2, offerDiscountType: "FREE_TRIAL", price: 0 })).toBe("trial");
    expect(periodTypeOf({ offerType: 2, offerDiscountType: "PAY_AS_YOU_GO", price: 490 })).toBe("normal");
    expect(periodTypeOf({ offerType: 3, offerDiscountType: "FREE_TRIAL", price: 0 })).toBe("trial");
    expect(periodTypeOf({ offerType: 3, offerDiscountType: "PAY_AS_YOU_GO", price: 490 })).toBe("intro");
    expect(periodTypeOf({ offerType: 4, price: 490 })).toBe("normal");
  });

  it("billing plan (iOS 26.4): MONTHLY is product plan monthly; up front, a missing field and unknown values are none", () => {
    expect(billingPlanOf({ billingPlanType: "MONTHLY" })).toBe("monthly");
    expect(billingPlanOf({ billingPlanType: "BILLED_UPFRONT" })).toBeNull();
    expect(billingPlanOf({})).toBeNull();
    expect(billingPlanOf({ billingPlanType: "QUARTERLY" })).toBeNull();
    const at = { store: "app_store" as const, detectedAt: new Date(T0) };
    expect(fromTransaction(transaction({ billingPlanType: "MONTHLY" }), at)).toMatchObject({ kind: "subscription", productIdentifier: "pro_monthly", productPlanIdentifier: "monthly" });
    expect(fromTransaction(transaction(), at)).toMatchObject({ kind: "subscription", productPlanIdentifier: null });
    expect(fromTransaction(transaction({ productId: "lifetime", type: "Non-Consumable", expiresDate: undefined, billingPlanType: "MONTHLY" }), at)).not.toHaveProperty("productPlanIdentifier");
  });

  it("a monthly billing plan purchase reports product_plan_identifier and keeps unlocking a bare product", async () => {
    h = await appleHarness();
    const body = await (await h.postReceipt("plan_user", await signJws(transaction({ billingPlanType: "MONTHLY" }), pki))).json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({ product_plan_identifier: "monthly", store_transaction_id: "2000000001" });
    expect(body.subscriber.entitlements.pro).toMatchObject({ product_identifier: "pro_monthly", product_plan_identifier: "monthly", expires_date: iso(T0 + 30 * DAY) });
    const [row] = await h.db.select().from(schema.subscriptions);
    expect(row!.productPlanIdentifier).toBe("monthly");
  });

  it("a consumable lands in non_subscriptions with store_transaction_id equal to the transaction id, so the SDK can finish it", async () => {
    h = await appleHarness();
    const tx = transaction({ transactionId: "3000000001", productId: "coins_100", type: "Consumable", expiresDate: undefined, price: 19990 });
    const res = await h.postReceipt("user1", await signJws(tx, pki), { product_id: "coins_100" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscriber.non_subscriptions.coins_100).toHaveLength(1);
    expect(body.subscriber.non_subscriptions.coins_100[0]).toMatchObject({ store_transaction_id: "3000000001", store: "app_store", is_sandbox: false });
    expect(body.purchased_products.coins_100).toEqual({ should_consume: true });
    expect(body.subscriber.entitlements).toEqual({});
    const events = await h.newEvents();
    expect(events.map((e) => [e.type, e.transaction_id, e.price_in_purchased_currency])).toEqual([["NON_RENEWING_PURCHASE", "3000000001", 19.99]]);
  });

  it("a non-consumable unlocks its entitlement for life", async () => {
    h = await appleHarness();
    const tx = transaction({ transactionId: "3000000002", productId: "lifetime", type: "Non-Consumable", expiresDate: undefined });
    const body = await (await h.postReceipt("user1", await signJws(tx, pki))).json();
    expect(body.subscriber.entitlements.pro).toMatchObject({ product_identifier: "lifetime", expires_date: null });
    expect(body.purchased_products.lifetime).toEqual({ should_consume: false });
  });

  it("family sharing sets ownership_type FAMILY_SHARED and is_family_share", async () => {
    h = await appleHarness();
    const body = await (await h.postReceipt("member", await signJws(transaction({ inAppOwnershipType: "FAMILY_SHARED" }), pki))).json();
    expect(body.subscriber.subscriptions.pro_monthly.ownership_type).toBe("FAMILY_SHARED");
    expect((await h.newEvents())[0]).toMatchObject({ type: "INITIAL_PURCHASE", is_family_share: true });
  });

  it("a revoked transaction is a refund: CANCELLATION with CUSTOMER_SUPPORT and access ends at the refund time", async () => {
    h = await appleHarness();
    await h.postReceipt("user1", await signJws(transaction(), pki));
    await h.newEvents();
    h.setNow(T0 + 6 * DAY);
    const refundAt = T0 + 5 * DAY;
    const res = await h.postReceipt("user1", await signJws(transaction({ revocationDate: refundAt, revocationReason: 0, signedDate: T0 + 5 * DAY }), pki));
    const body = await res.json();
    expect(body.subscriber.subscriptions.pro_monthly.refunded_at).toBe(iso(refundAt));
    expect(body.subscriber.entitlements.pro.expires_date).toBe(iso(refundAt));
    const events = await h.newEvents();
    expect(events.map((e) => [e.type, e.cancel_reason, e.price_in_purchased_currency])).toEqual([["CANCELLATION", "CUSTOMER_SUPPORT", -9.99]]);
  });

  it("sandbox transactions are marked sandbox; Production ones are not", async () => {
    h = await appleHarness();
    const body = await (await h.postReceipt("tester", await signJws(transaction({ environment: "Sandbox" }), pki))).json();
    expect(body.subscriber.subscriptions.pro_monthly.is_sandbox).toBe(true);
    expect((await h.newEvents())[0]).toMatchObject({ environment: "SANDBOX" });
  });

  it("rejects a transaction for another bundle id with 400 / 7103", async () => {
    h = await appleHarness();
    await expectInvalid(await h.postReceipt("user1", await signJws(transaction({ bundleId: "com.evil.app" }), pki)), /bundle id com\.evil\.app/);
    expect(await h.newEvents()).toEqual([]);
  });

  it("rejects a tampered payload", async () => {
    h = await appleHarness();
    const [head, , sig] = (await signJws(transaction(), pki)).split(".");
    const forged = Buffer.from(JSON.stringify(transaction({ expiresDate: T0 + 3650 * DAY }))).toString("base64url");
    await expectInvalid(await h.postReceipt("user1", `${head}.${forged}.${sig}`));
  });

  it("rejects a chain that does not lead to the trusted Apple root", async () => {
    h = await appleHarness();
    const other = await makePki();
    await expectInvalid(await h.postReceipt("user1", await signJws(transaction(), other)), /trusted root/);
  });

  it("rejects an expired signing certificate", async () => {
    h = await appleHarness();
    const expired = await makePki({ leafNotBefore: new Date("2020-01-01T00:00:00Z"), leafNotAfter: new Date("2025-01-01T00:00:00Z") });
    setAppleRootsForTesting([pki.rootPem, expired.rootPem]);
    try {
      await expectInvalid(await h.postReceipt("user1", await signJws(transaction(), expired)), /expired/);
    } finally {
      setAppleRootsForTesting([pki.rootPem]);
    }
  });

  it("rejects certificates without Apple's App Store marker extensions", async () => {
    h = await appleHarness();
    const plain = await makePki({ appleOids: false });
    setAppleRootsForTesting([pki.rootPem, plain.rootPem]);
    try {
      await expectInvalid(await h.postReceipt("user1", await signJws(transaction(), plain)), /App Store certificates/);
    } finally {
      setAppleRootsForTesting([pki.rootPem]);
    }
  });

  it("rejects garbage and signed payloads that are not transactions", async () => {
    h = await appleHarness();
    await expectInvalid(await h.postReceipt("user1", "not a receipt!!"));
    await expectInvalid(await h.postReceipt("user1", await signJws(renewalInfo(), pki)), /not an App Store transaction/);
  });
});

describe("StoreKit 1 app receipts", () => {
  const items = [
    { productId: "pro_monthly", transactionId: "1000000001", purchaseDate: "2026-08-01T12:00:00Z", expiresDate: "2026-08-08T12:00:00Z", isTrial: true },
    { productId: "pro_monthly", transactionId: "1000000002", originalTransactionId: "1000000001", purchaseDate: "2026-08-08T12:00:00Z", originalPurchaseDate: "2026-08-01T12:00:00Z", expiresDate: "2026-09-08T12:00:00Z" },
    { productId: "coins_100", transactionId: "1000000003", purchaseDate: "2026-08-20T12:00:00Z" },
  ];

  it("parses bundle id, versions, environment and every in-app record", () => {
    const r = parseAppReceipt(base64ToBytes(makeReceipt({ environment: "ProductionSandbox", originalApplicationVersion: "1.2", inApp: [...items, { productId: "pro_annual", transactionId: "1000000004", purchaseDate: "2026-08-21T12:00:00Z", expiresDate: "2027-08-21T12:00:00Z", cancellationDate: "2026-08-22T12:00:00Z", isIntro: true, quantity: 1 }] })));
    expect(r).toMatchObject({ environment: "ProductionSandbox", bundleId: BUNDLE, applicationVersion: "42", originalApplicationVersion: "1.2" });
    expect(r.inApp).toHaveLength(4);
    expect(r.inApp[0]).toEqual({
      productId: "pro_monthly", transactionId: "1000000001", originalTransactionId: "1000000001", quantity: 1,
      purchaseDate: new Date("2026-08-01T12:00:00Z"), originalPurchaseDate: new Date("2026-08-01T12:00:00Z"), expiresDate: new Date("2026-08-08T12:00:00Z"),
      cancellationDate: null, isTrialPeriod: true, isInIntroOfferPeriod: false,
    });
    expect(r.inApp[2]!.expiresDate).toBeNull();
    expect(r.inApp[3]).toMatchObject({ cancellationDate: new Date("2026-08-22T12:00:00Z"), isInIntroOfferPeriod: true, isTrialPeriod: false });
  });

  it("refuses an unsigned receipt by default (anyone could forge it) with 500 and code 7234", async () => {
    h = await appleHarness();
    const res = await h.postReceipt("user1", makeReceipt({ inApp: items }), { product_id: "pro_monthly" });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe(7234);
  });

  it("with allow_unsigned_receipts (development), maps the latest transaction of each chain and one-time purchases", async () => {
    h = await appleHarness({ credentials: { allow_unsigned_receipts: true } });
    const res = await h.postReceipt("user1", makeReceipt({ inApp: items }), { product_id: "pro_monthly", price: 9.99, currency: "EUR", store_country: "ESP" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({
      store_transaction_id: "1000000002", period_type: "normal", is_sandbox: false, purchase_date: "2026-08-08T12:00:00Z",
      original_purchase_date: "2026-08-01T12:00:00Z", expires_date: "2026-09-08T12:00:00Z", price: { amount: 9.99, currency: "EUR" },
    });
    expect(body.subscriber.non_subscriptions.coins_100[0].store_transaction_id).toBe("1000000003");
    expect(body.subscriber.entitlements.pro.expires_date).toBe("2026-09-08T12:00:00Z");
    const events = await h.newEvents();
    expect(types(events)).toEqual(["INITIAL_PURCHASE", "NON_RENEWING_PURCHASE"]);
    expect(events.find((e) => e.type === "INITIAL_PURCHASE")).toMatchObject({ country_code: "ES", transaction_id: "1000000002", original_transaction_id: "1000000001" });
  });

  it("reads trial and intro flags from the latest period", async () => {
    h = await appleHarness({ credentials: { allow_unsigned_receipts: true } });
    const body = await (await h.postReceipt("user1", makeReceipt({ environment: "ProductionSandbox", inApp: [items[0]!] }))).json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({ period_type: "trial", is_sandbox: true });
  });

  it("rejects a receipt for another app, an Xcode receipt, and bytes that are not a receipt", async () => {
    h = await appleHarness();
    await expectInvalid(await h.postReceipt("user1", makeReceipt({ bundleId: "com.evil.app", inApp: items })), /com\.evil\.app/);
    await expectInvalid(await h.postReceipt("user1", makeReceipt({ environment: "Xcode", inApp: items })), /Xcode/);
    await expectInvalid(await h.postReceipt("user1", "YW4gYXdlc29tZSByZWNlaXB0"));
  });

  it("a receipt without purchases returns an empty customer", async () => {
    h = await appleHarness();
    const res = await h.postReceipt("user1", makeReceipt({ inApp: [] }));
    expect(res.status).toBe(200);
    expect((await res.json()).subscriber.subscriptions).toEqual({});
  });
});

describe("App Store Server API", () => {
  const creds = async () => ({ key_id: "KEY123", issuer_id: "issuer-uuid", private_key: await makeP8() });

  it("uses history and renewal info: the latest renewal, auto-renew off, and one-time purchases from any page", async () => {
    const first = transaction();
    const renewal = transaction({ transactionId: "2000000011", originalTransactionId: "2000000001", purchaseDate: T0 + 30 * DAY, expiresDate: T0 + 60 * DAY, signedDate: T0 + 30 * DAY });
    const lifetime = transaction({ transactionId: "3000000009", productId: "lifetime", type: "Non-Consumable", expiresDate: undefined });
    const api = mockAppleApi({
      production: {
        transactions: [await signJws(first, pki), await signJws(renewal, pki), await signJws(lifetime, pki)],
        statuses: { data: [{ subscriptionGroupIdentifier: "g1", lastTransactions: [{ originalTransactionId: "2000000001", status: 1, signedTransactionInfo: await signJws(renewal, pki), signedRenewalInfo: await signJws(renewalInfo({ autoRenewStatus: 0 }), pki) }] }] },
      },
    });
    h = await appleHarness({ credentials: await creds(), fetch: api.fetch });
    h.setNow(T0 + 31 * DAY);
    const res = await h.postReceipt("user1", await signJws(first, pki));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({ store_transaction_id: "2000000011", expires_date: iso(T0 + 60 * DAY), unsubscribe_detected_at: iso(T0 + 31 * DAY) });
    expect(body.subscriber.non_subscriptions.lifetime[0].store_transaction_id).toBe("3000000009");
    const events = await h.newEvents();
    expect(types(events)).toEqual(["CANCELLATION", "INITIAL_PURCHASE", "NON_RENEWING_PURCHASE"]);
    expect(events.find((e) => e.type === "CANCELLATION")).toMatchObject({ cancel_reason: "UNSUBSCRIBE" });

    // Two history pages, then statuses, all against production with an App Store Connect JWT.
    expect(api.calls.map((c) => c.path.split("?")[0])).toEqual(["/inApps/v2/history/2000000001", "/inApps/v2/history/2000000001", "/inApps/v1/subscriptions/2000000011"]);
    expect(api.calls[1]!.path).toContain("revision=2");
    expect(api.calls.every((c) => c.env === "production")).toBe(true);
    const jwt = api.calls[0]!.auth!.replace(/^Bearer /, "");
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(decodeJwt(jwt)).toMatchObject({ iss: "issuer-uuid", aud: "appstoreconnect-v1", bid: BUNDLE });
  });

  it("billing retry with a grace period: BILLING_ISSUE and CANCELLATION(BILLING_ERROR), detected at the renewal date, access until the grace end", async () => {
    const tx = transaction();
    const graceEnd = T0 + 46 * DAY;
    const status = async (code: number, renewal: ReturnType<typeof renewalInfo>) =>
      ({ data: [{ lastTransactions: [{ originalTransactionId: "2000000001", status: code, signedTransactionInfo: await signJws(tx, pki), signedRenewalInfo: await signJws(renewal, pki) }] }] });
    const production = { transactions: [await signJws(tx, pki)], statuses: await status(1, renewalInfo()) };
    const api = mockAppleApi({ production });
    h = await appleHarness({ credentials: await creds(), fetch: api.fetch });
    await h.postReceipt("user1", await signJws(tx, pki));
    expect(types(await h.newEvents())).toEqual(["INITIAL_PURCHASE"]);

    production.statuses = await status(4, renewalInfo({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: graceEnd, expirationIntent: 2 }));
    h.setNow(T0 + 31 * DAY);
    const body = await (await h.postReceipt("user1", await signJws(tx, pki))).json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({
      billing_issues_detected_at: iso(T0 + 30 * DAY), grace_period_expires_date: iso(graceEnd), unsubscribe_detected_at: iso(T0 + 30 * DAY),
    });
    expect(body.subscriber.entitlements.pro.expires_date).toBe(iso(graceEnd));
    const events = await h.newEvents();
    expect(types(events)).toEqual(["BILLING_ISSUE", "CANCELLATION"]);
    expect(events.find((e) => e.type === "CANCELLATION")).toMatchObject({ cancel_reason: "BILLING_ERROR" });
    expect(events.find((e) => e.type === "BILLING_ISSUE")).toMatchObject({ grace_period_expiration_at_ms: graceEnd });
  });

  it("a StoreKit 1 receipt names a transaction; production 404 retries the sandbox", async () => {
    const tx = transaction({ transactionId: "1000000002", originalTransactionId: "1000000001", environment: "Sandbox" });
    const api = mockAppleApi({ sandbox: { transactions: [await signJws(tx, pki)] } });
    h = await appleHarness({ credentials: await creds(), fetch: api.fetch });
    const receipt = makeReceipt({ inApp: [{ productId: "pro_monthly", transactionId: "1000000002", originalTransactionId: "1000000001", purchaseDate: "2026-09-01T12:00:00Z", expiresDate: "2026-10-01T12:00:00Z" }] });
    const body = await (await h.postReceipt("user1", receipt)).json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({ is_sandbox: true, store_transaction_id: "1000000002" });
    expect(api.calls.map((c) => c.env)).toEqual(["production", "sandbox", "sandbox"]);
  });

  it("a StoreKit 1 receipt whose transactions Apple does not know is invalid", async () => {
    const api = mockAppleApi({});
    h = await appleHarness({ credentials: await creds(), fetch: api.fetch });
    const receipt = makeReceipt({ inApp: [{ productId: "pro_monthly", transactionId: "999", purchaseDate: "2026-09-01T12:00:00Z", expiresDate: "2026-10-01T12:00:00Z" }] });
    await expectInvalid(await h.postReceipt("user1", receipt), /no record/);
  });

  it("a rejected key answers 500 with 7234 so the SDK keeps the transaction and retries", async () => {
    h = await appleHarness({ credentials: await creds(), fetch: mockAppleApi({ failWith: 401 }).fetch });
    const res = await h.postReceipt("user1", await signJws(transaction(), pki));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe(7234);
  });

  it("incomplete credentials answer 500 with 7234", async () => {
    h = await appleHarness({ credentials: { key_id: "KEY123" } });
    const res = await h.postReceipt("user1", await signJws(transaction(), pki));
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe(7234);
  });

  it("an App Store outage answers 503 (retryable), never 4xx", async () => {
    h = await appleHarness({ credentials: await creds(), fetch: mockAppleApi({ failWith: 503 }).fetch });
    const res = await h.postReceipt("user1", await signJws(transaction(), pki));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe(7101);
    await h.close();
    h = await appleHarness({ credentials: await creds(), fetch: async () => { throw new TypeError("fetch failed"); } });
    expect((await h.postReceipt("user1", await signJws(transaction(), pki))).status).toBe(503);
  });

  it("a verified StoreKit 2 transaction Apple cannot find yet is still granted from the signed transaction", async () => {
    h = await appleHarness({ credentials: await creds(), fetch: mockAppleApi({}).fetch });
    const body = await (await h.postReceipt("user1", await signJws(transaction(), pki))).json();
    expect(body.subscriber.subscriptions.pro_monthly.store_transaction_id).toBe("2000000001");
  });
});

describe("Xcode StoreKit testing receipts", () => {
  it("are trusted only with the app's StoreKit test certificate, and are sandbox", async () => {
    const xcode = await makeXcodePki();
    const tx = transaction({ environment: "Xcode", transactionId: "0" });
    const receipt = Buffer.from(JSON.stringify({ bundle_id: BUNDLE, environment: "xcode", transactions: [await signJws(tx, xcode)], subscription_status: {} })).toString("base64");
    h = await appleHarness();
    await expectInvalid(await h.postReceipt("user1", receipt), /StoreKit test certificate/);
    await h.close();
    h = await appleHarness({ credentials: { xcode_certificate: xcode.rootPem } });
    const body = await (await h.postReceipt("user1", receipt)).json();
    expect(body.subscriber.subscriptions.pro_monthly).toMatchObject({ is_sandbox: true, store_transaction_id: "0" });
  });
});
