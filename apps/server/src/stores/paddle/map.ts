import type { PeriodType, Price } from "@revenuedot/core";
import type { VerifiedOneTime, VerifiedSubscription } from "../types.js";
import { fromMinor } from "../stripe/map.js";
import { PaddleApiError, type PaddlePrice, type PaddleSubscription, type PaddleTransaction } from "./api.js";

export interface Catalog { productType: (storeId: string) => string | null; productDuration: (storeId: string) => string | null }

/** What the chain looked like before (the stored row), for periods Paddle has started but nobody has paid for. */
export interface StoredPeriod { storeTransactionId: string | null; purchaseDate: Date; price: Price | null; expiresDate?: Date | null }

/** Thrown when a subscription must not be registered yet: its first transaction is not paid (checkout still open). */
export class PaddleNotYetPaid extends Error {}

/** RevenueCat: "event data always shows a 30-day grace period" for Paddle; Paddle's own dunning decides the real end. */
export const PADDLE_GRACE_DAYS = 30;
const DAY = 86_400_000;

const date = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
const minDate = (a: Date, b: Date) => (a < b ? a : b);
const sameTime = (a: Date | null, b: Date | null) => !!a && !!b && Math.abs(a.getTime() - b.getTime()) < 2000;

/** Transactions that pay for a period. Proration (`subscription_update`) and card changes are not a period of their own. */
export const isPeriodPayment = (t: PaddleTransaction) =>
  (t.status === "completed" || t.status === "paid") && t.origin !== "subscription_update" && t.origin !== "subscription_payment_method_change";

const minor = (v: string | undefined | null) => (typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);
/** A Paddle amount with the tax inside it (both in the lowest denomination, as strings): Paddle is the merchant of record. */
function paddlePrice(total: string | undefined, tax: string | undefined | null, currency: string): Price | null {
  const t = minor(total);
  if (t === null || !currency) return null;
  const x = minor(tax);
  const amount = fromMinor(t, currency);
  return x === null ? { amount, currency } : { amount, currency, tax: Math.min(Math.abs(amount), fromMinor(Math.max(0, x), currency)) };
}

/** The amount the customer paid: `details.totals.total` (tax included, the tax in `details.totals.tax`) in the lowest denomination, as a string. */
export function transactionPrice(t: PaddleTransaction): Price | null {
  const totals = t.details?.totals;
  const currency = (totals?.currency_code ?? t.currency_code ?? "").toUpperCase();
  if (!totals) return null;
  return paddlePrice(totals.total, totals.tax, currency);
}

const unitPrice = (p: PaddlePrice): Price | null =>
  p.unit_price && /^\d+$/.test(p.unit_price.amount) ? { amount: fromMinor(Number(p.unit_price.amount), p.unit_price.currency_code), currency: p.unit_price.currency_code.toUpperCase() } : null;

/**
 * A catalog product of a Paddle app is the price id (`pri_…`): RevenueCat maps a Paddle price to a product. A catalog
 * product with the price's product id (`pro_…`) also matches when no product has the price id.
 */
export function productIdOfPrice(price: PaddlePrice | null | undefined, catalog: Catalog): string {
  if (!price?.id) throw new PaddleApiError("invalid", "The Paddle purchase has no price.");
  if (catalog.productType(price.id)) return price.id;
  if (price.product_id && catalog.productType(price.product_id)) return price.product_id;
  return price.id;
}

/** When a renewal charge failed: the first failed payment attempt of the unpaid transaction. */
function failedAt(t: PaddleTransaction | null, now: Date): Date {
  const attempts = (t?.payments ?? []).map((p) => date(p.created_at)).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
  const at = attempts[0] ?? date(t?.billed_at) ?? date(t?.updated_at) ?? now;
  return minDate(at, now);
}

/**
 * A Paddle subscription as one chain keyed by its id; each paid period is a transaction (transaction id = `txn_…`).
 * `paid` is the newest transaction that paid for a period, `latest` the newest transaction of any kind (a past-due renewal).
 *   trialing:  trial until the item's trial end, price 0.
 *   active:    the current billing period, paid by `paid`.
 *   past_due:  the renewal is unpaid: billing issue, access to the end of the paid period plus a 30-day grace period.
 *   canceled:  access ended at `canceled_at` (a billing error when the last renewal was never paid).
 *   paused:    access ended when the pause started; `scheduled_change.resume_at` is the auto-resume date.
 *   scheduled_change cancel: auto-renew off, access to `effective_at`. scheduled_change pause: paused from `effective_at`.
 */
export function mapSubscription(sub: PaddleSubscription, ctx: { catalog: Catalog; now: Date; sandbox: boolean; paid: PaddleTransaction | null; latest?: PaddleTransaction | null; stored?: StoredPeriod | null }): VerifiedSubscription {
  const { now, stored, paid } = ctx;
  const item = sub.items?.find((i) => i.status !== "inactive") ?? sub.items?.[0];
  if (!item) throw new PaddleApiError("invalid", "The Paddle subscription has no items.");
  const productId = productIdOfPrice(item.price, ctx.catalog);
  const origin = date(sub.started_at) ?? date(sub.created_at) ?? now;
  const period = sub.current_billing_period;
  const pStart = date(period?.starts_at), pEnd = date(period?.ends_at);
  const paidStart = date(paid?.billing_period?.starts_at), paidEnd = date(paid?.billing_period?.ends_at);
  const trial = sub.status === "trialing";
  const trialEnd = date(item.trial_dates?.ends_at);
  const currency = (paid?.currency_code ?? sub.currency_code ?? item.price.unit_price?.currency_code ?? "USD").toUpperCase();

  if (!paid && !trial && sub.status !== "canceled") throw new PaddleNotYetPaid("The subscription's first transaction is not paid yet.");

  let purchaseDate: Date, expiresDate: Date, storeTransactionId: string, price: Price | null;
  const periodPaid = !!paid && (!pStart || sameTime(pStart, paidStart));
  if (periodPaid && paid) {
    purchaseDate = pStart ?? paidStart ?? origin;
    expiresDate = trial ? trialEnd ?? pEnd ?? paidEnd ?? purchaseDate : pEnd ?? paidEnd ?? purchaseDate;
    storeTransactionId = paid.id;
    price = trial ? { amount: 0, currency } : transactionPrice(paid) ?? unitPrice(item.price);
  } else if (trial) {
    purchaseDate = pStart ?? origin;
    expiresDate = trialEnd ?? pEnd ?? purchaseDate;
    storeTransactionId = paid?.id ?? stored?.storeTransactionId ?? sub.id;
    price = { amount: 0, currency };
  } else {
    // Paddle moved to a new period that nobody has paid for (a failed renewal): the paid period is the one before.
    purchaseDate = stored?.purchaseDate ?? paidStart ?? origin;
    storeTransactionId = stored?.storeTransactionId ?? paid?.id ?? sub.id;
    price = stored?.price ?? (paid ? transactionPrice(paid) : null) ?? unitPrice(item.price);
    expiresDate = pStart ?? paidEnd ?? stored?.expiresDate ?? purchaseDate;
  }

  let billingIssuesDetectedAt: Date | null = null;
  let gracePeriodExpiresDate: Date | null = null;
  let unsubscribeDetectedAt: Date | null = null;
  let cancelReason: VerifiedSubscription["cancelReason"] = null;
  let autoResumeDate: Date | null = null;
  const unpaidRenewal = ctx.latest && ctx.latest.status === "past_due" && ctx.latest.id !== paid?.id ? ctx.latest : null;

  switch (sub.status) {
    case "past_due": {
      billingIssuesDetectedAt = failedAt(unpaidRenewal, now);
      gracePeriodExpiresDate = new Date(billingIssuesDetectedAt.getTime() + PADDLE_GRACE_DAYS * DAY);
      break;
    }
    case "canceled": {
      const ended = date(sub.canceled_at) ?? now;
      expiresDate = minDate(expiresDate, ended);
      unsubscribeDetectedAt = ended;
      if (unpaidRenewal) {
        // Paddle's dunning gave up on the renewal.
        cancelReason = "BILLING_ERROR";
        billingIssuesDetectedAt = failedAt(unpaidRenewal, now);
      }
      break;
    }
    case "paused": {
      expiresDate = minDate(expiresDate, date(sub.paused_at) ?? now);
      break;
    }
    default:
      break;
  }
  const change = sub.scheduled_change;
  if (change && sub.status !== "canceled") {
    const effective = date(change.effective_at);
    if (change.action === "cancel") {
      unsubscribeDetectedAt ??= now;
      if (effective) expiresDate = minDate(expiresDate, effective);
    } else if (change.action === "pause") {
      if (effective) expiresDate = minDate(expiresDate, effective);
      autoResumeDate = date(change.resume_at);
    } else if (change.action === "resume" && sub.status === "paused") {
      autoResumeDate = date(change.resume_at) ?? effective;
    }
  }
  if (autoResumeDate && autoResumeDate <= now) autoResumeDate = null;

  const periodType: PeriodType = trial ? "trial" : "normal";
  const country = paid?.address?.country_code ?? null;
  return {
    kind: "subscription", store: "paddle", storeKey: sub.id, productIdentifier: productId, productPlanIdentifier: null,
    isSandbox: ctx.sandbox, purchaseDate, originalPurchaseDate: origin, expiresDate, periodType,
    unsubscribeDetectedAt, billingIssuesDetectedAt, gracePeriodExpiresDate, refundedAt: null, autoResumeDate,
    storeTransactionId, originalTransactionId: sub.id, price, countryCode: country, autoRenewProductId: productId, cancelReason,
  };
}

/** A paid transaction without a subscription: one one-time purchase per item, keyed by the transaction id. */
export function mapOneTime(t: PaddleTransaction, ctx: { catalog: Catalog; now: Date; sandbox: boolean }): VerifiedOneTime[] {
  if (!t.items?.length) throw new PaddleApiError("invalid", "The Paddle transaction has no items.");
  const currency = (t.currency_code ?? "USD").toUpperCase();
  const lines = t.details?.line_items ?? [];
  return t.items.map((it, i) => {
    const productIdentifier = productIdOfPrice(it.price, ctx.catalog);
    const line = lines.find((l) => l.price_id === it.price.id) ?? lines[i];
    const price: Price | null = t.items.length === 1 ? transactionPrice(t) : paddlePrice(line?.totals?.total, line?.totals?.tax, currency) ?? unitPrice(it.price);
    return {
      kind: "non_subscription" as const, store: "paddle" as const, productIdentifier,
      storeTransactionId: i === 0 ? t.id : `${t.id}:${i}`, isSandbox: ctx.sandbox,
      isConsumable: ctx.catalog.productType(productIdentifier) === "consumable",
      purchaseDate: date(t.billed_at) ?? date(t.created_at) ?? ctx.now, refundedAt: null, price,
      countryCode: t.address?.country_code ?? null,
    };
  });
}

/** ISO 8601 duration of a Paddle billing cycle (`{ interval: "month", frequency: 3 }` → P3M). */
export function cycleDuration(c: { interval: string; frequency: number } | null | undefined): string | null {
  if (!c || !Number.isInteger(c.frequency) || c.frequency < 1) return null;
  const unit = { day: "D", week: "W", month: "M", year: "Y" }[c.interval];
  return unit ? `P${c.frequency}${unit}` : null;
}
