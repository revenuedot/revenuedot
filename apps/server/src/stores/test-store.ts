import { Codes, RCError } from "../errors.js";
import type { Price } from "@revenuedot/core";
import type { StoreAdapter, VerifiedPurchase, VerifiedSubscription } from "./types.js";

/** ISO 8601 duration (P1W, P1M, P1Y, P3D) added to a date. */
export function addDuration(d: Date, iso: string, times = 1): Date {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso);
  if (!m) throw new Error(`Bad duration ${iso}`);
  const r = new Date(d);
  r.setUTCFullYear(r.getUTCFullYear() + Number(m[1] ?? 0) * times);
  r.setUTCMonth(r.getUTCMonth() + Number(m[2] ?? 0) * times);
  r.setUTCDate(r.getUTCDate() + (Number(m[3] ?? 0) * 7 + Number(m[4] ?? 0)) * times);
  return r;
}

/**
 * The Test Store: purchases made with `test_` API keys, no App Store or Google Play involved.
 * The SDK posts `fetch_token = test_<epoch ms>_<uuid>`; we trust it and use the catalog for the product's type and period.
 * Always sandbox.
 */
export const testStore: StoreAdapter = {
  async verify(_app, input, catalog) {
    const token = input.fetchToken;
    const m = token ? /^test_(\d+)_([\w-]+)$/.exec(token) : null;
    if (!m) throw new RCError(400, Codes.INVALID_RECEIPT, "The receipt is not a valid Test Store purchase token.");
    const productId = input.productIds[0] ?? input.platformProducts[0]?.productId;
    if (!productId) throw new RCError(400, Codes.INVALID_RECEIPT, "product_id is required for Test Store purchases.");
    const purchaseDate = new Date(Number(m[1]));
    const type = catalog.productType(productId) ?? (input.normalDuration ? "subscription" : "non_consumable");
    // The native SDKs post the price they showed; purchases-js posts Test Store receipts with `price: null` and only the
    // currency, as RevenueCat's backend knows the price from the product. Fall back to the catalog's Test Store price.
    const price = input.price !== null && input.currency ? { amount: input.price, currency: input.currency } : catalog.productPrice?.(productId) ?? null;
    const out: VerifiedPurchase[] = [];
    if (type === "subscription") {
      const dur = catalog.productDuration(productId) ?? input.normalDuration ?? "P1M";
      out.push({
        kind: "subscription", store: "test_store", storeKey: token!, productIdentifier: productId, isSandbox: true,
        purchaseDate, originalPurchaseDate: purchaseDate, expiresDate: addDuration(purchaseDate, dur), periodType: "normal",
        storeTransactionId: token!, originalTransactionId: token!, price, countryCode: input.storeCountry, offerType: null, offerId: null,
      });
    } else {
      out.push({
        kind: "non_subscription", store: "test_store", productIdentifier: productId, storeTransactionId: token!, isSandbox: true,
        isConsumable: type === "consumable", purchaseDate, price, countryCode: input.storeCountry,
      });
    }
    return out;
  },
};

export const TEST_SCENARIOS = ["purchase", "trial", "trial_conversion", "renewal", "cancel", "billing_issue", "refund", "expire"] as const;
export type TestScenario = typeof TEST_SCENARIOS[number];

/** A Test Store free trial lasts a week; a failed renewal keeps access for a week of grace. */
const TRIAL = "P7D";
const GRACE = "P7D";

export interface ScenarioStep { at: Date; purchase: VerifiedPurchase }

/**
 * A Test Store purchase history as the store would report it over time, one state per step, for seeding dashboards and demos
 * through the same purchase pipeline (and therefore the same events, transactions and webhooks) as real purchases.
 * `start` is when the scenario begins; every step happens at or before `now`.
 *   purchase          bought at start
 *   trial             free trial started at start
 *   trial_conversion  trial at start, first paid period when it ends, renewals until now (default start: a week ago)
 *   renewal           bought at start and renewed every period until now (default start: one period ago)
 *   cancel            as renewal, then auto-renew turned off now; access runs to the period end
 *   billing_issue     renewals until the last period end before now, where the charge fails: billing issue, a week of grace
 *                     (default start: one period ago)
 *   refund            as renewal (or a one-time purchase at start), refunded now
 *   expire            bought at start with auto-renew off, access ends at the period end or now, whichever is first
 *                     (default start: one period ago)
 */
export function testStoreScenario(o: {
  scenario: TestScenario; token: string; productId: string; productType: string; duration: string | null; start: Date | null; now: Date;
  price: Price | null; countryCode?: string | null;
}): ScenarioStep[] {
  const { scenario, token, now } = o;
  const oneTime = o.productType !== "subscription";
  if (oneTime && scenario !== "purchase" && scenario !== "refund") throw new Error(`The ${scenario} scenario needs a subscription product.`);
  const dur = o.duration ?? "P1M";
  const defaultStart = scenario === "trial_conversion" ? addDuration(now, TRIAL, -1)
    : scenario === "renewal" || scenario === "billing_issue" || scenario === "expire" ? addDuration(now, dur, -1) : now;
  const start = o.start ?? defaultStart;
  if (start > now) throw new Error("The scenario cannot start in the future.");

  if (oneTime) {
    const p: VerifiedPurchase = {
      kind: "non_subscription", store: "test_store", productIdentifier: o.productId, storeTransactionId: token, isSandbox: true,
      isConsumable: o.productType === "consumable", purchaseDate: start, price: o.price, countryCode: o.countryCode ?? null,
    };
    return scenario === "refund" ? [{ at: start, purchase: p }, { at: now, purchase: { ...p, refundedAt: now } }] : [{ at: start, purchase: p }];
  }

  const base = {
    kind: "subscription" as const, store: "test_store" as const, storeKey: token, productIdentifier: o.productId, isSandbox: true,
    originalPurchaseDate: start, originalTransactionId: token, countryCode: o.countryCode ?? null,
  };
  const zero = o.price ? { amount: 0, currency: o.price.currency } : null;
  const steps: ScenarioStep[] = [];
  const period = (from: Date, n: number, trial = false): VerifiedSubscription => ({
    ...base, purchaseDate: from, expiresDate: addDuration(from, trial ? TRIAL : dur), periodType: trial ? "trial" : "normal",
    storeTransactionId: n === 0 ? token : `${token}..${n}`, price: trial ? zero : o.price,
    // The offer each period was bought with, as the stores state it: the trial is a free trial, paid periods have none.
    offerType: trial ? "free_trial" : null, offerId: null,
  });
  /** Paid periods from `from` while each starts at or before `until`; returns the last one. */
  const renewUntil = (first: VerifiedSubscription, until: Date) => {
    let cur = first;
    for (let n = Number(/\.\.(\d+)$/.exec(cur.storeTransactionId)?.[1] ?? 0) + 1; cur.expiresDate! <= until; n++) {
      cur = period(cur.expiresDate!, n);
      steps.push({ at: cur.purchaseDate, purchase: cur });
    }
    return cur;
  };

  if (scenario === "trial" || scenario === "trial_conversion") {
    const trial = period(start, 0, true);
    steps.push({ at: start, purchase: trial });
    if (scenario === "trial") return steps;
    if (trial.expiresDate! > now) throw new Error("trial_conversion needs offset_days of at least 7 (the trial lasts a week).");
    const paid = period(trial.expiresDate!, 1);
    steps.push({ at: paid.purchaseDate, purchase: paid });
    renewUntil(paid, now);
    return steps;
  }

  const first = period(start, 0);
  steps.push({ at: start, purchase: first });
  if (scenario === "purchase") return steps;

  if (scenario === "expire") {
    const off = { ...first, unsubscribeDetectedAt: start };
    steps.push({ at: start, purchase: off });
    const end = first.expiresDate! <= now ? first.expiresDate! : now;
    steps.push({ at: end, purchase: { ...off, expiresDate: end } });
    return steps;
  }

  if (scenario === "billing_issue") {
    if (first.expiresDate! > now) throw new Error("billing_issue needs offset_days of at least one period (the charge fails at a period end).");
    // Renew while the next period end is still before now; the charge at the last period end before now fails.
    let cur = first;
    for (let n = 1; addDuration(cur.expiresDate!, dur) <= now; n++) {
      cur = period(cur.expiresDate!, n);
      steps.push({ at: cur.purchaseDate, purchase: cur });
    }
    const failedAt = cur.expiresDate!;
    steps.push({ at: failedAt, purchase: { ...cur, billingIssuesDetectedAt: failedAt, unsubscribeDetectedAt: failedAt, gracePeriodExpiresDate: addDuration(failedAt, GRACE) } });
    return steps;
  }

  const last = renewUntil(first, now);
  if (scenario === "renewal") {
    if (steps.length < 2) throw new Error("renewal needs offset_days of at least one period.");
    return steps;
  }
  if (scenario === "cancel") {
    steps.push({ at: now, purchase: { ...last, unsubscribeDetectedAt: now } });
    return steps;
  }
  // refund: the latest period, now.
  steps.push({ at: now, purchase: { ...last, refundedAt: now } });
  return steps;
}
