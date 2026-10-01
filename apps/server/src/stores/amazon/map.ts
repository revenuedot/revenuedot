import type { PeriodType, Price } from "@revenuedot/core";
import { addDuration } from "../test-store.js";
import type { VerifiedOneTime, VerifiedSubscription } from "../types.js";
import type { AmazonReceipt } from "./api.js";

export interface Catalog { productType: (storeId: string) => string | null; productDuration: (storeId: string) => string | null }
/** What the device posted about this purchase (receipt path only). */
export interface Posted { productId: string | null; price: number | null; currency: string | null; country: string | null }

const date = (ms: number | null | undefined) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null);
const minDate = (a: Date, b: Date) => (a < b ? a : b);
const maxDate = (a: Date, b: Date) => (a > b ? a : b);

const UNITS: Record<string, string> = { day: "D", week: "W", month: "M", year: "Y" };
const NAMED: Record<string, string> = {
  weekly: "P1W", biweekly: "P2W", monthly: "P1M", bimonthly: "P2M", quarterly: "P3M", semiannually: "P6M", semiannual: "P6M", annually: "P1Y", annual: "P1Y", yearly: "P1Y",
};

/** RVS `term` ("1 Week", "3 Months", "1 Year", or a period name such as "Quarterly") as an ISO 8601 duration. */
export function termDuration(term: string | null | undefined): string | null {
  if (!term) return null;
  const t = term.trim().toLowerCase();
  const m = /^(\d+)\s*-?\s*(day|week|month|year)s?$/.exec(t);
  if (m) return `P${m[1]}${UNITS[m[2]!]}`;
  return NAMED[t.replace(/[^a-z]/g, "")] ?? null;
}

/** The catalog identifier of a receipt: the term SKU for subscriptions (what the SDK posts), else the SKU. */
export function productIdOf(r: AmazonReceipt, catalog: Catalog): string {
  if (r.productType !== "SUBSCRIPTION") return r.productId;
  if (r.termSku && (catalog.productType(r.termSku) || !catalog.productType(r.productId))) return r.termSku;
  return r.productId;
}

const isSandbox = (r: AmazonReceipt, sandboxEndpoint: boolean) => sandboxEndpoint || r.testTransaction === true || r.betaProduct === true;

function postedPrice(posted: Posted | null | undefined, ids: string[]): Price | null {
  if (!posted || posted.price === null || !posted.currency) return null;
  if (posted.productId && !ids.includes(posted.productId)) return null;
  return { amount: posted.price, currency: posted.currency };
}

/**
 * An RVS subscription receipt as one chain keyed by the receipt id (Amazon keeps the id across renewals).
 *   period end:  renewalDate (the next renewal), the trial end while in a trial, or purchase + term.
 *   period start: one term before the period end, never before the purchase or (after a trial) the trial end.
 *   cancelDate:  access ends there (customer or Amazon cancellation, or the end of a scheduled cancellation).
 *   gracePeriodEndDate in the future: billing issue, access continues to that date.
 *   autoRenewing false: unsubscribe detected (first time seen; the stored time wins on later reads).
 *   deferredSku: the product the next period renews into.
 */
export function mapSubscription(r: AmazonReceipt, ctx: { catalog: Catalog; now: Date; sandbox: boolean; posted?: Posted | null }): VerifiedSubscription {
  const { catalog, now } = ctx;
  const productId = productIdOf(r, catalog);
  const purchase = date(r.purchaseDate) ?? now;
  const renewal = date(r.renewalDate);
  const cancel = date(r.cancelDate);
  const trialEnd = date(r.freeTrialEndDate);
  const graceEnd = date(r.gracePeriodEndDate);
  const dur = termDuration(r.term) ?? catalog.productDuration(productId) ?? (r.termSku ? catalog.productDuration(r.termSku) : null) ?? catalog.productDuration(r.productId);

  const inTrial = !!trialEnd && trialEnd > purchase && (!renewal || renewal <= trialEnd);
  let periodEnd: Date | null = renewal ?? (inTrial ? trialEnd : dur ? addDuration(purchase, dur) : null);
  let start = purchase;
  if (!inTrial && periodEnd && dur) {
    try { start = addDuration(periodEnd, dur, -1); } catch { start = purchase; }
    if (trialEnd && trialEnd > purchase && periodEnd > trialEnd) start = maxDate(start, trialEnd);
    start = maxDate(start, purchase);
  }
  if (!periodEnd) periodEnd = cancel ?? now;
  let expiresDate = cancel ? minDate(cancel, periodEnd) : periodEnd;

  let billingIssuesDetectedAt: Date | null = null;
  let gracePeriodExpiresDate: Date | null = null;
  if (graceEnd && graceEnd > now && !cancel) {
    billingIssuesDetectedAt = now;
    gracePeriodExpiresDate = graceEnd;
    expiresDate = minDate(expiresDate, maxDate(start, renewal ?? now));
  }
  const autoRenewOff = r.autoRenewing === false || !!cancel;
  const unsubscribeDetectedAt = autoRenewOff || billingIssuesDetectedAt ? (cancel && cancel < now ? cancel : now) : null;
  const cancelReason = !unsubscribeDetectedAt ? null : billingIssuesDetectedAt || r.cancelReason === 2 ? "BILLING_ERROR" as const : null;

  const intro = (r.promotions ?? []).some((p) => /introductory/i.test(p.promotionType ?? "") && /inprogress/i.test((p.promotionStatus ?? "").replace(/\s/g, "")));
  const periodType: PeriodType = inTrial ? "trial" : intro ? "intro" : "normal";
  const ids = [productId, r.productId, r.termSku].filter((x): x is string => !!x);
  const posted = postedPrice(ctx.posted, ids);
  const price: Price | null = periodType === "trial" ? (posted || ctx.posted?.currency ? { amount: 0, currency: posted?.currency ?? ctx.posted!.currency! } : null) : posted;

  return {
    kind: "subscription", store: "amazon", storeKey: r.receiptId, productIdentifier: productId, productPlanIdentifier: null,
    isSandbox: isSandbox(r, ctx.sandbox),
    purchaseDate: start, originalPurchaseDate: purchase, expiresDate, periodType,
    unsubscribeDetectedAt, billingIssuesDetectedAt, gracePeriodExpiresDate, refundedAt: null, autoResumeDate: null,
    storeTransactionId: start.getTime() === purchase.getTime() ? r.receiptId : `${r.receiptId}.${start.getTime()}`,
    originalTransactionId: r.receiptId,
    price, countryCode: r.countryCode ?? ctx.posted?.country ?? null,
    autoRenewProductId: r.deferredSku ?? productId,
    cancelReason,
  };
}

/** CONSUMABLE and ENTITLED receipts. A cancelDate on a one-time purchase is a refund. */
export function mapOneTime(r: AmazonReceipt, ctx: { catalog: Catalog; now: Date; sandbox: boolean; posted?: Posted | null }): VerifiedOneTime {
  const type = ctx.catalog.productType(r.productId);
  const cancel = date(r.cancelDate);
  return {
    kind: "non_subscription", store: "amazon", productIdentifier: r.productId, storeTransactionId: r.receiptId,
    isSandbox: isSandbox(r, ctx.sandbox),
    isConsumable: type ? type === "consumable" : r.productType === "CONSUMABLE",
    purchaseDate: date(r.purchaseDate) ?? ctx.now,
    refundedAt: cancel ? minDate(cancel, ctx.now) : null,
    price: postedPrice(ctx.posted, [r.productId]),
    countryCode: r.countryCode ?? ctx.posted?.country ?? null,
  };
}

export const mapReceipt = (r: AmazonReceipt, ctx: Parameters<typeof mapSubscription>[1]) =>
  r.productType === "SUBSCRIPTION" ? mapSubscription(r, ctx) : mapOneTime(r, ctx);
