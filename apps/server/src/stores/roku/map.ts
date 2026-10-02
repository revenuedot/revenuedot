import type { PeriodType, Price } from "@revenuedot/core";
import type { VerifiedOneTime, VerifiedSubscription } from "../types.js";
import { RokuApiError, rokuDate, type RokuTransaction } from "./api.js";

export interface Catalog { productType: (storeId: string) => string | null; productDuration: (storeId: string) => string | null }

/** Roku keeps access for 3 days after a failed renewal (https://developer.roku.com/dev/docs/subscription-on-hold). */
export const ROKU_GRACE_DAYS = 3;
const DAY = 86_400_000;

/** Roku sends lowercase currency codes and numbers with up to four decimals. */
export function rokuPrice(t: Pick<RokuTransaction, "total" | "amount" | "currency">): Price | null {
  const amount = typeof t.total === "number" ? t.total : typeof t.amount === "number" ? t.amount : null;
  const currency = typeof t.currency === "string" && /^[a-z]{3}$/i.test(t.currency) ? t.currency.toUpperCase() : null;
  return amount !== null && currency ? { amount: Math.round(amount * 100) / 100, currency } : null;
}

/** What the SDK posted next to the transaction id (its free trial and intro price lengths). */
export interface Posted { trialDuration?: string | null; introDuration?: string | null }

/** The chain a transaction belongs to: the first transaction of the subscription. */
export const chainKeyOf = (t: RokuTransaction) => (t.OriginalTransactionId && t.OriginalTransactionId.trim()) || t.transactionId!;

export const isPending = (t: RokuTransaction) => t.purchaseStatus === "PendingActive";

/**
 * A validated Roku transaction. A product the catalog marks one-time, or a transaction without an expiration date, is a
 * one-time purchase; anything else is a period of the subscription chain keyed by the original transaction id.
 *   entitled, expiry in the future            active (cancelled: auto-renew off)
 *   entitled, expiry passed, not cancelled    grace: billing issue, access 3 more days
 *   not entitled, not cancelled, expired      on hold: billing issue, access ended
 */
export function mapTransaction(t: RokuTransaction, ctx: { catalog: Catalog; now: Date; sandbox: boolean; posted?: Posted | null }): VerifiedSubscription | VerifiedOneTime {
  const { now } = ctx;
  if (!t.transactionId || !t.productId) throw new RokuApiError("invalid", "Roku returned a transaction without an id or product.");
  const purchaseDate = rokuDate(t.purchaseDate) ?? now;
  const expires = rokuDate(t.expirationDate);
  const kind = ctx.catalog.productType(t.productId);
  const price = rokuPrice(t);
  if ((kind && kind !== "subscription") || !expires) {
    return {
      kind: "non_subscription", store: "roku", productIdentifier: t.productId, storeTransactionId: t.transactionId, isSandbox: ctx.sandbox,
      isConsumable: kind === "consumable", purchaseDate, refundedAt: t.cancelled ? now : null, price, countryCode: null,
    };
  }
  const chain = chainKeyOf(t);
  const first = chain === t.transactionId;
  const free = (t.total ?? t.amount ?? null) === 0;
  const periodType: PeriodType = first && (!!ctx.posted?.trialDuration || free) ? "trial" : first && ctx.posted?.introDuration ? "intro" : "normal";
  let billingIssuesDetectedAt: Date | null = null;
  let gracePeriodExpiresDate: Date | null = null;
  if (!t.cancelled && expires <= now) {
    // The renewal charge failed (Roku retries during grace and on hold). The first day of the problem is the expiry.
    billingIssuesDetectedAt = expires;
    if (t.isEntitled) gracePeriodExpiresDate = new Date(expires.getTime() + ROKU_GRACE_DAYS * DAY);
  }
  return {
    kind: "subscription", store: "roku", storeKey: chain, productIdentifier: t.productId, productPlanIdentifier: null,
    isSandbox: ctx.sandbox, purchaseDate, originalPurchaseDate: rokuDate(t.originalPurchaseDate) ?? purchaseDate, expiresDate: expires, periodType,
    unsubscribeDetectedAt: t.cancelled ? now : null, billingIssuesDetectedAt, gracePeriodExpiresDate, refundedAt: null, autoResumeDate: null,
    storeTransactionId: t.transactionId, originalTransactionId: chain, price: periodType === "trial" ? { amount: 0, currency: price?.currency ?? "USD" } : price,
    countryCode: null, autoRenewProductId: t.productId, cancelReason: null,
  };
}
