import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { asc } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { getOrCreateCustomer } from "@revenuedot/server/repo/customers.js";
import { applyPurchases } from "@revenuedot/server/services/purchases.js";
import type { VerifiedSubscription } from "@revenuedot/server/stores/types.js";
import { harness, type Harness } from "../src/harness.js";
import { WebhookEventSchema } from "../src/sdk-schemas.js";
import { v2 } from "./v2-helpers.js";

/**
 * Every webhook event type we send, compared key by key with RevenueCat's sample payloads (fixtures/webhooks) and its
 * "Event Types and Fields" page: the same keys, null where RevenueCat sends null, omitted where it omits them, epoch-ms
 * integers for every `*_ms` field. Keys we cannot have yet are listed in UNSUPPORTED.
 */
const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/webhooks/${name}.json`, import.meta.url), "utf8")).event as Record<string, unknown>;
/** experiments: no experiments yet. renewal_number: not tracked yet (RevenueCat marks it "Sometimes"). metadata: RevenueCat Billing only. */
const UNSUPPORTED = new Set(["experiments", "renewal_number", "metadata"]);
const FIXTURES: [string, string, (e: Record<string, any>) => boolean][] = [
  ["INITIAL_PURCHASE", "initial_purchase", (e) => e.period_type === "NORMAL"],
  ["INITIAL_PURCHASE", "trial_started", (e) => e.period_type === "TRIAL"],
  ["RENEWAL", "renewal", () => true],
  ["CANCELLATION", "cancellation", (e) => e.cancel_reason === "UNSUBSCRIBE"],
  ["CANCELLATION", "refund", (e) => e.cancel_reason === "CUSTOMER_SUPPORT"],
  ["UNCANCELLATION", "uncancellation", () => true],
  ["NON_RENEWING_PURCHASE", "non_renewing_purchase", () => true],
  ["SUBSCRIPTION_PAUSED", "subscription_paused", () => true],
  ["EXPIRATION", "expiration", () => true],
  ["BILLING_ISSUE", "billing_issue", () => true],
  ["PRODUCT_CHANGE", "product_change", (e) => "new_product_id" in e],
  ["SUBSCRIPTION_EXTENDED", "subscription_extended", () => true],
  ["REFUND_REVERSED", "refund_reversed", () => true],
  ["TRANSFER", "transfer", () => true],
];
/** Keys RevenueCat documents as "Sometimes" that its sample happens to leave out. */
const DOCUMENTED_EXTRAS: Record<string, string[]> = { TRANSFER: ["subscriber_attributes"] };
/** Money moves only on purchases, renewals, refunds and reversals; RevenueCat's samples report 0 on every other event. */
const ZERO_PRICE = new Set(["CANCELLATION:UNSUBSCRIBE", "UNCANCELLATION", "SUBSCRIPTION_PAUSED", "EXPIRATION", "BILLING_ISSUE", "PRODUCT_CHANGE", "SUBSCRIPTION_EXTENDED"]);

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const DAY = 86_400_000;

/** Drives one of every event type through the real pipeline and returns the stored webhook bodies. */
async function everyEvent() {
  const call = v2(h);
  const now = h.now();
  const seed = (json: Record<string, unknown>) => call("POST", "/v2/projects/{project_id}/test_purchases", {}, { ext: true, json: { product_id: "pro_monthly", price: 9.99, ...json } });
  await seed({ app_user_id: "buyer", scenario: "renewal" });
  await seed({ app_user_id: "trialer", scenario: "trial" });
  await seed({ app_user_id: "canceller", scenario: "cancel" });
  await seed({ app_user_id: "failing", scenario: "billing_issue" });
  await seed({ app_user_id: "refunded", scenario: "refund" });
  await seed({ app_user_id: "lapsed", scenario: "expire" });
  await seed({ app_user_id: "collector", product_id: "lifetime", price: 49.99 });

  // Store states the Test Store scenarios do not cover, applied like a store notification would.
  const { customer } = await getOrCreateCustomer(h.db, "proj1", "play_user", now);
  const base: VerifiedSubscription = {
    kind: "subscription", store: "play_store", storeKey: "tok_1", productIdentifier: "pro", productPlanIdentifier: "monthly", isSandbox: false,
    purchaseDate: new Date(now.getTime() - 5 * DAY), originalPurchaseDate: new Date(now.getTime() - 5 * DAY), expiresDate: new Date(now.getTime() + 25 * DAY),
    periodType: "normal", storeTransactionId: "GPA.1", originalTransactionId: "GPA.1", price: { amount: 9.99, currency: "USD" }, countryCode: "US", autoRenewProductId: "pro",
  };
  const apply = (p: Partial<VerifiedSubscription>, fromDevice = false) =>
    applyPurchases(h.db, customer, [{ ...base, ...p }], { projectId: "proj1", appId: "app_play", appUserId: "play_user", now: h.now(), fromDevice });
  await apply({}, true);
  await apply({ unsubscribeDetectedAt: now });
  await apply({});
  await apply({ autoResumeDate: new Date(now.getTime() + 40 * DAY) });
  await apply({ autoResumeDate: null, expiresDate: new Date(now.getTime() + 30 * DAY) });
  await apply({ expiresDate: new Date(now.getTime() + 30 * DAY), autoRenewProductId: "premium" });
  await apply({ expiresDate: new Date(now.getTime() + 30 * DAY), autoRenewProductId: "premium", refundedAt: now });
  await apply({ expiresDate: new Date(now.getTime() + 30 * DAY), autoRenewProductId: "premium", refundedAt: null });
  await apply({ expiresDate: new Date(now.getTime() + 30 * DAY), autoRenewProductId: "premium", priceIncreaseStatus: "pending" });

  // A receipt already owned by another identified user moves to the poster (the default transfer behaviour).
  const token = `test_${now.getTime()}_${crypto.randomUUID()}`;
  await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "first_owner", fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
  await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "second_owner", fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD" } });

  const rows = await h.db.select().from(schema.events).orderBy(asc(schema.events.eventTimestampMs), asc(schema.events.createdAt));
  return rows.map((r) => r.payload as { api_version: string; event: Record<string, any> });
}

describe("webhook payloads match RevenueCat's samples field by field", () => {
  it("every event type has RevenueCat's keys, nulls and millisecond timestamps", async () => {
    const payloads = await everyEvent();
    expect(payloads.every((p) => p.api_version === "1.0")).toBe(true);
    const events = payloads.map((p) => p.event);
    for (const [type, name, pick] of FIXTURES) {
      const ours = events.find((e) => e.type === type && pick(e));
      expect(ours, `no ${type} (${name}) was produced`).toBeDefined();
      const sample = fx(name);
      const want = [...Object.keys(sample).filter((k) => !UNSUPPORTED.has(k)), ...(DOCUMENTED_EXTRAS[type] ?? [])].sort();
      expect(Object.keys(ours!).sort(), `${type} (${name}) keys`).toEqual(want);
      for (const [k, v] of Object.entries(ours!)) {
        if (k.endsWith("_ms") && v !== null) expect(Number.isInteger(v) && (v as number) > 1e12, `${type}.${k} is epoch ms`).toBe(true);
        // Where RevenueCat's sample has a value, ours is never null (and vice versa for the always-null deprecated entitlement_id).
        if (sample[k] !== null && sample[k] !== undefined && !["presented_offering_id", "offer_code", "entitlement_id", "country_code"].includes(k)) {
          expect(v, `${type}.${k} should not be null`).not.toBeNull();
        }
      }
      const key = type === "CANCELLATION" ? `${type}:${ours!.cancel_reason}` : type;
      if (ZERO_PRICE.has(key)) expect([ours!.price, ours!.price_in_purchased_currency], `${key} price`).toEqual([0, 0]);
      if (type !== "TRANSFER") expect(WebhookEventSchema.safeParse({ api_version: "1.0", event: ours }).success, `${type} decodes`).toBe(true);
    }
    // Refunds are negative and reversals positive.
    expect(events.find((e) => e.type === "CANCELLATION" && e.cancel_reason === "CUSTOMER_SUPPORT")!.price).toBeLessThan(0);
    expect(events.find((e) => e.type === "REFUND_REVERSED")!.price).toBeGreaterThan(0);
    // Only BILLING_ISSUE carries grace_period_expiration_at_ms, only SUBSCRIPTION_PAUSED auto_resume_at_ms, only RENEWAL is_trial_conversion.
    for (const e of events) {
      expect("grace_period_expiration_at_ms" in e, e.type).toBe(e.type === "BILLING_ISSUE");
      expect("auto_resume_at_ms" in e, e.type).toBe(e.type === "SUBSCRIPTION_PAUSED");
      expect("is_trial_conversion" in e, e.type).toBe(e.type === "RENEWAL");
      expect("cancel_reason" in e, e.type).toBe(e.type === "CANCELLATION");
      expect("expiration_reason" in e, e.type).toBe(e.type === "EXPIRATION");
    }
    // Price-increase consent: identity plus the documented price-consent fields, no lifecycle group.
    const consent = events.find((e) => e.type === "PRICE_INCREASE_CONSENT_REQUIRED")!;
    expect(Object.keys(consent).sort()).toEqual(["aliases", "app_id", "app_user_id", "country_code", "currency", "environment", "event_timestamp_ms", "id",
      "original_app_user_id", "original_transaction_id", "product_id", "store", "subscriber_attributes", "transaction_id", "type"]);
    // TRANSFER names both sides.
    expect(events.find((e) => e.type === "TRANSFER")).toMatchObject({ transferred_from: ["first_owner"], transferred_to: ["second_owner"], store: "TEST_STORE", environment: "SANDBOX" });
  });

  it("promotional grants leave app_id out, as RevenueCat does for the PROMOTIONAL store", async () => {
    await h.fetch("/v1/subscribers/promo/entitlements/pro/promotional", { method: "POST", key: h.ids.secretKey, json: { duration: "weekly" } });
    const [row] = await h.db.select().from(schema.events);
    const e = (row!.payload as { event: Record<string, unknown> }).event;
    expect(e).toMatchObject({ type: "INITIAL_PURCHASE", store: "PROMOTIONAL", period_type: "PROMOTIONAL" });
    expect("app_id" in e).toBe(false);
  });
});
