import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import {
  APP_ID, DAY, T0, appleHarness, makePki, notificationBody, renewalInfo, signJws, transaction, type AppleHarness, type Pki,
} from "./apple-fixtures.js";
import type { AppleRenewalInfo, AppleTransaction } from "../src/stores/apple/map.js";

let pki: Pki;
let h: AppleHarness | undefined;
beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
afterAll(() => setAppleRootsForTesting(null));
afterEach(async () => { vi.unstubAllGlobals(); await h?.close(); h = undefined; });

const types = (events: { type: string }[]) => events.map((e) => e.type).sort();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The first period: bought at T0, renews at T0 + 30 days. */
const first = transaction();
const renewed = transaction({ transactionId: "2000000002", originalTransactionId: "2000000001", purchaseDate: T0 + 30 * DAY, expiresDate: T0 + 60 * DAY, signedDate: T0 + 30 * DAY });

/** A harness with user1 holding the pro_monthly chain 2000000001, bought from the device. */
async function subscribed(opts: Parameters<typeof appleHarness>[0] = {}) {
  const harness = await appleHarness(opts);
  expect((await harness.postReceipt("user1", await signJws(first, pki))).status).toBe(200);
  await harness.newEvents();
  return harness;
}

async function send(type: string, subtype: string | undefined, tx: AppleTransaction | null, renewal: AppleRenewalInfo | null = renewalInfo(), over: Record<string, unknown> = {}) {
  // Apple signs the notification when it sends it.
  const res = await h!.notify(await notificationBody(pki, type, subtype, tx, renewal, { signedDate: h!.now().getTime(), ...over }));
  expect(res.status).toBe(200);
  return h!.newEvents();
}

const sub = async () => (await h!.customerInfo("user1")).subscriber.subscriptions.pro_monthly;
const lastReceived = async () => (await h!.db.select().from(schema.apps).where(eq(schema.apps.id, APP_ID)))[0]!.lastNotificationAt;

describe("App Store Server Notifications V2", () => {
  it("stores the raw body, verifies it and answers 200", async () => {
    h = await subscribed();
    const body = await notificationBody(pki, "DID_RENEW", undefined, renewed, renewalInfo());
    h.setNow(T0 + 30 * DAY);
    const res = await h.notify(body);
    expect(res.status).toBe(200);
    const [row] = await h.db.select().from(schema.storeNotifications);
    expect(row).toMatchObject({ appId: APP_ID, projectId: "proj1", store: "app_store", type: "DID_RENEW", subtype: null, environment: "production", body, error: null });
    expect(row!.processedAt).not.toBeNull();
    expect(await lastReceived()).toEqual(new Date(T0 + 30 * DAY));
  });

  it("SUBSCRIBED/INITIAL_BUY for an unknown purchase is ignored with 200 unless tracking new purchases is on", async () => {
    h = await appleHarness();
    expect(await send("SUBSCRIBED", "INITIAL_BUY", first)).toEqual([]);
    expect(await lastReceived()).toBeNull();
    await h.close();

    h = await appleHarness({ credentials: { track_new_purchases: true } });
    const events = await send("SUBSCRIBED", "INITIAL_BUY", transaction({ offerType: 1, offerDiscountType: "FREE_TRIAL", price: 0 }));
    expect(events.map((e) => [e.type, e.period_type])).toEqual([["INITIAL_PURCHASE", "TRIAL"]]);
    expect(events[0].app_user_id).toMatch(/^\$RCAnonymousID:/);
    expect(await lastReceived()).not.toBeNull();
  });

  it("an appAccountToken matching an app user id attaches a new purchase to that customer", async () => {
    h = await appleHarness();
    await h.customerInfo("3f1c2a52-6f4e-4a8e-9f0e-0b8a5b1a7c11");
    const events = await send("SUBSCRIBED", "INITIAL_BUY", transaction({ appAccountToken: "3f1c2a52-6f4e-4a8e-9f0e-0b8a5b1a7c11" }));
    expect(events.map((e) => [e.type, e.app_user_id])).toEqual([["INITIAL_PURCHASE", "3f1c2a52-6f4e-4a8e-9f0e-0b8a5b1a7c11"]]);
  });

  it("a notification the device already reported records nothing new", async () => {
    h = await subscribed();
    expect(await send("SUBSCRIBED", "INITIAL_BUY", first)).toEqual([]);
  });

  it("DID_RENEW records RENEWAL and moves the period", async () => {
    h = await subscribed();
    h.setNow(T0 + 30 * DAY);
    const events = await send("DID_RENEW", undefined, renewed);
    expect(events.map((e) => [e.type, e.transaction_id, e.original_transaction_id])).toEqual([["RENEWAL", "2000000002", "2000000001"]]);
    expect(await sub()).toMatchObject({ store_transaction_id: "2000000002", expires_date: iso(T0 + 60 * DAY) });
  });

  it("SUBSCRIBED/RESUBSCRIBE shortly after expiry records RENEWAL on the same chain", async () => {
    h = await subscribed();
    h.setNow(T0 + 30 * DAY + 3_600_000);
    const back = transaction({ transactionId: "2000000003", originalTransactionId: "2000000001", purchaseDate: T0 + 30 * DAY + 3_600_000, expiresDate: T0 + 60 * DAY, signedDate: T0 + 30 * DAY + 3_600_000 });
    expect(types(await send("SUBSCRIBED", "RESUBSCRIBE", back))).toEqual(["RENEWAL"]);
  });

  it("DID_FAIL_TO_RENEW/GRACE_PERIOD: BILLING_ISSUE with the grace end and CANCELLATION(BILLING_ERROR); access continues", async () => {
    h = await subscribed();
    h.setNow(T0 + 30 * DAY + 60_000);
    const graceEnd = T0 + 46 * DAY;
    const events = await send("DID_FAIL_TO_RENEW", "GRACE_PERIOD", first, renewalInfo({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: graceEnd, expirationIntent: 2 }));
    expect(types(events)).toEqual(["BILLING_ISSUE", "CANCELLATION"]);
    expect(events.find((e) => e.type === "BILLING_ISSUE")).toMatchObject({ grace_period_expiration_at_ms: graceEnd });
    expect(events.find((e) => e.type === "CANCELLATION")).toMatchObject({ cancel_reason: "BILLING_ERROR" });
    expect(await sub()).toMatchObject({ billing_issues_detected_at: iso(T0 + 30 * DAY), grace_period_expires_date: iso(graceEnd) });
    const info = await h.customerInfo("user1");
    expect(info.subscriber.entitlements.pro.expires_date).toBe(iso(graceEnd));

    // Apple recovers the payment inside the grace period: RENEWAL, and the billing issue and grace end are cleared.
    h.setNow(T0 + 30 * DAY + 12 * 3_600_000);
    const recovered = transaction({ transactionId: "2000000004", originalTransactionId: "2000000001", purchaseDate: h.now().getTime(), expiresDate: T0 + 61 * DAY, signedDate: h.now().getTime() });
    expect(types(await send("DID_RENEW", "BILLING_RECOVERY", recovered))).toContain("RENEWAL");
    expect(await sub()).toMatchObject({ billing_issues_detected_at: null, grace_period_expires_date: null, unsubscribe_detected_at: null, expires_date: iso(T0 + 61 * DAY) });
  });

  it("GRACE_PERIOD_EXPIRED sends no second BILLING_ISSUE and access ends at the grace end", async () => {
    h = await subscribed();
    const graceEnd = T0 + 46 * DAY;
    const retry = renewalInfo({ isInBillingRetryPeriod: true, gracePeriodExpiresDate: graceEnd, expirationIntent: 2 });
    h.setNow(T0 + 30 * DAY + 60_000);
    await send("DID_FAIL_TO_RENEW", "GRACE_PERIOD", first, retry);
    h.setNow(graceEnd + 60_000);
    expect(await send("GRACE_PERIOD_EXPIRED", undefined, first, retry)).toEqual([]);
    const info = await h.customerInfo("user1");
    expect(info.subscriber.entitlements.pro.expires_date).toBe(iso(graceEnd));
    expect(info.subscriber.subscriptions.pro_monthly.billing_issues_detected_at).toBe(iso(T0 + 30 * DAY));
  });

  it("DID_FAIL_TO_RENEW without a grace period: BILLING_ISSUE and CANCELLATION(BILLING_ERROR), and access ends", async () => {
    h = await subscribed();
    h.setNow(T0 + 30 * DAY + 60_000);
    const events = await send("DID_FAIL_TO_RENEW", undefined, first, renewalInfo({ isInBillingRetryPeriod: true, expirationIntent: 2 }));
    expect(types(events)).toEqual(["BILLING_ISSUE", "CANCELLATION"]);
    expect((await h.customerInfo("user1")).subscriber.entitlements.pro.expires_date).toBe(iso(T0 + 30 * DAY));
  });

  it("DID_CHANGE_RENEWAL_STATUS: AUTO_RENEW_DISABLED is CANCELLATION(UNSUBSCRIBE), AUTO_RENEW_ENABLED is UNCANCELLATION", async () => {
    h = await subscribed();
    h.setNow(T0 + 10 * DAY);
    const off = await send("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", first, renewalInfo({ autoRenewStatus: 0 }), { signedDate: T0 + 10 * DAY });
    expect(off.map((e) => [e.type, e.cancel_reason])).toEqual([["CANCELLATION", "UNSUBSCRIBE"]]);
    expect((await sub()).unsubscribe_detected_at).toBe(iso(T0 + 10 * DAY));
    // Apple retries the same notification: nothing new.
    expect(await send("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED", first, renewalInfo({ autoRenewStatus: 0 }))).toEqual([]);
    expect(types(await send("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED", first, renewalInfo({ autoRenewStatus: 1 })))).toEqual(["UNCANCELLATION"]);
    expect((await sub()).unsubscribe_detected_at).toBeNull();
  });

  it("DID_CHANGE_RENEWAL_PREF/UPGRADE switches the product immediately with PRODUCT_CHANGE", async () => {
    h = await subscribed();
    h.setNow(T0 + 10 * DAY);
    const upgraded = transaction({ transactionId: "2000000005", originalTransactionId: "2000000001", productId: "pro_annual", purchaseDate: T0 + 10 * DAY, expiresDate: T0 + 375 * DAY, price: 59990, signedDate: T0 + 10 * DAY });
    const events = await send("DID_CHANGE_RENEWAL_PREF", "UPGRADE", upgraded, renewalInfo({ productId: "pro_annual", autoRenewProductId: "pro_annual" }));
    expect(events.find((e) => e.type === "PRODUCT_CHANGE")).toMatchObject({ new_product_id: "pro_annual" });
    const info = await h.customerInfo("user1");
    expect(info.subscriber.entitlements.pro.product_identifier).toBe("pro_annual");
  });

  it("DID_CHANGE_RENEWAL_PREF/DOWNGRADE keeps the current product until renewal and stores the next product", async () => {
    h = await subscribed();
    await send("DID_CHANGE_RENEWAL_PREF", "DOWNGRADE", first, renewalInfo({ autoRenewProductId: "pro_weekly" }));
    const [row] = await h.db.select().from(schema.subscriptions);
    expect(row).toMatchObject({ productIdentifier: "pro_monthly", autoRenewProductId: "pro_weekly" });
  });

  it("EXPIRED/VOLUNTARY ends access and records the cancellation it implies", async () => {
    h = await subscribed();
    h.setNow(T0 + 30 * DAY + 60_000);
    const events = await send("EXPIRED", "VOLUNTARY", first, renewalInfo({ autoRenewStatus: 0, expirationIntent: 1 }));
    expect(events.map((e) => [e.type, e.cancel_reason])).toEqual([["CANCELLATION", "UNSUBSCRIBE"]]);
    const info = await h.customerInfo("user1");
    expect(new Date(info.subscriber.entitlements.pro.expires_date).getTime()).toBeLessThan(h.now().getTime());
  });

  it("EXPIRED/BILLING_RETRY keeps the billing issue so the expiration reason is BILLING_ERROR", async () => {
    h = await subscribed();
    h.setNow(T0 + 30 * DAY + 60_000);
    await send("DID_FAIL_TO_RENEW", undefined, first, renewalInfo({ isInBillingRetryPeriod: true }));
    h.setNow(T0 + 90 * DAY);
    expect(await send("EXPIRED", "BILLING_RETRY", first, renewalInfo({ isInBillingRetryPeriod: false, expirationIntent: 2 }))).toEqual([]);
    expect((await sub()).billing_issues_detected_at).toBe(iso(T0 + 30 * DAY));
  });

  it("REFUND is CANCELLATION(CUSTOMER_SUPPORT) with a negative price; REFUND_REVERSED restores access", async () => {
    h = await subscribed();
    h.setNow(T0 + 5 * DAY);
    const refundAt = T0 + 5 * DAY - 60_000;
    const events = await send("REFUND", undefined, transaction({ revocationDate: refundAt, revocationReason: 0, signedDate: T0 + 5 * DAY }));
    expect(events.map((e) => [e.type, e.cancel_reason, e.price_in_purchased_currency])).toEqual([["CANCELLATION", "CUSTOMER_SUPPORT", -9.99]]);
    expect((await h.customerInfo("user1")).subscriber.entitlements.pro.expires_date).toBe(iso(refundAt));
    expect(types(await send("REFUND_REVERSED", undefined, first))).toEqual(["REFUND_REVERSED"]);
    expect((await h.customerInfo("user1")).subscriber.entitlements.pro.expires_date).toBe(iso(T0 + 30 * DAY));
  });

  it("REFUND of an earlier period does not touch the current one", async () => {
    h = await subscribed();
    h.setNow(T0 + 30 * DAY);
    await send("DID_RENEW", undefined, renewed);
    h.setNow(T0 + 35 * DAY);
    expect(await send("REFUND", undefined, transaction({ revocationDate: T0 + 35 * DAY, signedDate: T0 + 35 * DAY }))).toEqual([]);
    expect((await sub()).refunded_at).toBeNull();
  });

  it("REVOKE removes a family member's access", async () => {
    h = await appleHarness();
    const shared = transaction({ inAppOwnershipType: "FAMILY_SHARED" });
    await h.postReceipt("member", await signJws(shared, pki));
    await h.newEvents();
    h.setNow(T0 + 3 * DAY);
    const events = await send("REVOKE", undefined, transaction({ inAppOwnershipType: "FAMILY_SHARED", revocationDate: T0 + 3 * DAY, revocationReason: 0, signedDate: T0 + 3 * DAY }));
    expect(events.map((e) => [e.type, e.is_family_share])).toEqual([["CANCELLATION", true]]);
    expect((await h.customerInfo("member")).subscriber.entitlements.pro.expires_date).toBe(iso(T0 + 3 * DAY));
  });

  it("RENEWAL_EXTENDED is SUBSCRIPTION_EXTENDED", async () => {
    h = await subscribed();
    const events = await send("RENEWAL_EXTENDED", undefined, transaction({ expiresDate: T0 + 37 * DAY, signedDate: T0 + DAY }));
    expect(types(events)).toEqual(["SUBSCRIPTION_EXTENDED"]);
    expect((await sub()).expires_date).toBe(iso(T0 + 37 * DAY));
  });

  it("OFFER_REDEEMED on an active subscription records nothing until the discounted renewal", async () => {
    h = await subscribed();
    expect(await send("OFFER_REDEEMED", undefined, first)).toEqual([]);
  });

  it("PRICE_INCREASE records the consent events once per status", async () => {
    h = await subscribed();
    expect(types(await send("PRICE_INCREASE", "PENDING", first))).toEqual(["PRICE_INCREASE_CONSENT_REQUIRED"]);
    expect(await send("PRICE_INCREASE", "PENDING", first)).toEqual([]);
    expect(types(await send("PRICE_INCREASE", "ACCEPTED", first))).toEqual(["PRICE_INCREASE_CONSENT_APPROVED"]);
  });

  it("CONSUMPTION_REQUEST is accepted and records no event", async () => {
    h = await subscribed();
    const coins = transaction({ transactionId: "3000000001", productId: "coins_100", type: "Consumable", expiresDate: undefined });
    await h.postReceipt("user1", await signJws(coins, pki));
    await h.newEvents();
    expect(await send("CONSUMPTION_REQUEST", undefined, coins, null)).toEqual([]);
    expect(await lastReceived()).not.toBeNull();
  });

  it("ONE_TIME_CHARGE records NON_RENEWING_PURCHASE for the customer named by appAccountToken", async () => {
    h = await appleHarness();
    await h.customerInfo("8d5c6f7e-1111-4222-8333-944455556666");
    const coins = transaction({ transactionId: "3000000002", productId: "coins_100", type: "Consumable", expiresDate: undefined, appAccountToken: "8d5c6f7e-1111-4222-8333-944455556666" });
    const events = await send("ONE_TIME_CHARGE", undefined, coins, null);
    expect(events.map((e) => [e.type, e.transaction_id])).toEqual([["NON_RENEWING_PURCHASE", "3000000002"]]);
    // A refund of it later is a CANCELLATION too.
    expect(types(await send("REFUND", undefined, { ...coins, revocationDate: T0 + DAY }, null))).toEqual(["CANCELLATION"]);
  });

  it("TEST updates the last received time and records no event", async () => {
    h = await appleHarness();
    expect(await send("TEST", undefined, null, null)).toEqual([]);
    expect(await lastReceived()).toEqual(new Date(T0));
  });
});

describe("rejected notifications", () => {
  it("an unverifiable payload is 400 and the raw body is kept with the error", async () => {
    h = await appleHarness();
    const other = await makePki();
    const forged = JSON.stringify({ signedPayload: await signJws({ notificationType: "DID_RENEW", data: { bundleId: "com.example.scanner" } }, other) });
    const res = await h.notify(forged);
    expect(res.status).toBe(400);
    const [row] = await h.db.select().from(schema.storeNotifications);
    expect(row).toMatchObject({ body: forged, rejected: true });
    expect(row!.error).toMatch(/trusted root/);
  });

  it("bad JSON and a missing signedPayload are 400", async () => {
    h = await appleHarness();
    expect((await h.notify("{nope")).status).toBe(400);
    expect((await h.notify(JSON.stringify({}))).status).toBe(400);
  });

  it("a notification for another bundle id is 400", async () => {
    h = await appleHarness();
    const body = await notificationBody(pki, "DID_RENEW", undefined, transaction({ bundleId: "com.evil.app" }), renewalInfo(), {});
    const res = await h.notify(body);
    expect(res.status).toBe(400);
    const wrongBundle = JSON.stringify({ signedPayload: await signJws({ notificationType: "TEST", signedDate: T0, data: { bundleId: "com.evil.app", environment: "Production" } }, pki) });
    expect((await h.notify(wrongBundle)).status).toBe(400);
  });

  it("an unknown app is 404", async () => {
    h = await appleHarness();
    const res = await Promise.resolve((await import("../src/app.js")).createApp({ db: h.db, now: h.now, stores: {} }).fetch(
      new Request("http://localhost/v1/notifications/apple/nope", { method: "POST", body: "{}" })));
    expect(res.status).toBe(404);
  });
});

describe("forwarding", () => {
  it("forwards the exact body and content type to the forwarding URL and records the status", async () => {
    const forwarded: { url: string; body: string; contentType: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      forwarded.push({ url, body: String(init.body), contentType: new Headers(init.headers).get("content-type") });
      return new Response("ok", { status: 202 });
    });
    h = await subscribed({ forwardUrl: "https://example.test/apple-forward" });
    const body = await notificationBody(pki, "DID_RENEW", undefined, renewed, renewalInfo());
    h.setNow(T0 + 30 * DAY);
    expect((await h.notify(body, "application/json; charset=utf-8")).status).toBe(200);
    await vi.waitFor(async () => {
      const [row] = await h!.db.select().from(schema.storeNotifications);
      expect(row!.forwardStatus).toBe(202);
    });
    expect(forwarded).toEqual([{ url: "https://example.test/apple-forward", body, contentType: "application/json; charset=utf-8" }]);
  });

  it("forwards even payloads it cannot verify, and records 0 when the target is unreachable", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    h = await appleHarness({ forwardUrl: "https://example.test/down" });
    expect((await h.notify(JSON.stringify({ signedPayload: "a.b.c" }))).status).toBe(400);
    await vi.waitFor(async () => {
      const [row] = await h!.db.select().from(schema.storeNotifications);
      expect(row!.forwardStatus).toBe(0);
    });
  });
});
