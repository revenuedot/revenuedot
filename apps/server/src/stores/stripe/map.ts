import type { PeriodType, Price } from "@revenuedot/core";
import type { VerifiedOneTime, VerifiedSubscription } from "../types.js";
import { idOf, StripeApiError, type StripeCheckoutSession, type StripeInvoice, type StripePrice, type StripeSubscription } from "./api.js";

export interface Catalog { productType: (storeId: string) => string | null; productDuration: (storeId: string) => string | null }

/** What the chain looked like before (the stored row), for periods Stripe has started but not been paid for. */
export interface StoredPeriod { storeTransactionId: string | null; purchaseDate: Date; price: Price | null }

/** Currencies Stripe counts in whole units (https://docs.stripe.com/currencies#zero-decimal). */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** Currencies Stripe counts in thousandths (https://docs.stripe.com/currencies#three-decimal). */
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);
export const fromMinor = (amount: number, currency: string) => {
  const c = currency.toLowerCase();
  return ZERO_DECIMAL.has(c) ? amount : THREE_DECIMAL.has(c) ? Math.round(amount) / 1000 : Math.round(amount) / 100;
};

const sec = (s: number | null | undefined) => (typeof s === "number" && Number.isFinite(s) ? new Date(s * 1000) : null);
const minDate = (a: Date, b: Date) => (a < b ? a : b);

/** A catalog product of a Stripe app is a price id (wins) or a product id (RevenueCat's rule). */
export function productIdOfPrice(price: StripePrice | null | undefined, catalog: Catalog): string {
  if (!price) throw new StripeApiError("invalid", "The Stripe purchase has no price.");
  const product = idOf(price.product);
  if (catalog.productType(price.id)) return price.id;
  if (product && catalog.productType(product)) return product;
  return product ?? price.id;
}

/** The subscription's invoice id under both API shapes (before 2025-03-31 `subscription`, after `parent.subscription_details`). */
export const invoiceSubscriptionId = (inv: StripeInvoice) => idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription) ?? null;

export const invoicePaid = (inv: StripeInvoice) => inv.status === "paid" || inv.paid === true;

/** The current period: on the subscription before API 2025-03-31, on its item after. */
function periodOf(sub: StripeSubscription) {
  const item = sub.items?.data?.[0];
  return { start: sec(item?.current_period_start ?? sub.current_period_start), end: sec(item?.current_period_end ?? sub.current_period_end) };
}

/**
 * The list price of a subscription item in the subscription's currency: the price's `currency_options` entry for that
 * currency (multi-currency prices), else the price's own amount labelled with the price's own currency.
 */
function unitPriceOf(price: StripePrice, quantity: number, subscriptionCurrency: string): Price | null {
  const option = price.currency_options?.[subscriptionCurrency.toLowerCase()]?.unit_amount;
  if (typeof option === "number") return { amount: fromMinor(option * quantity, subscriptionCurrency), currency: subscriptionCurrency.toUpperCase() };
  if (typeof price.unit_amount !== "number") return null;
  const own = (price.currency ?? subscriptionCurrency).toUpperCase();
  return { amount: fromMinor(price.unit_amount * quantity, own), currency: own };
}

export type RegisterOn = "invoice_paid" | "invoice_created";

/** Thrown when a subscription must not be registered yet (its first invoice is unpaid and the app counts paid invoices only). */
export class StripeNotYetPaid extends Error {}

/**
 * A Stripe subscription as one chain keyed by its id; each paid invoice is a period (transaction id = invoice id).
 *   trialing:       trial until trial_end, price 0.
 *   active:         the current period, paid by the latest invoice.
 *   past_due:       the renewal invoice is open: billing issue, access to the end of the paid period, grace until the
 *                   invoice's next payment attempt.
 *   unpaid:         billing issue, access ended at the end of the paid period.
 *   canceled:       access ended at ended_at; a payment_failed cancellation is a billing error.
 *   paused:         (trial ended without a payment method) access ended.
 *   cancel_at_period_end / cancel_at: auto-renew off (UNSUBSCRIBE), access to the period end or cancel_at.
 *   pause_collection with resumes_at: paused until then (SUBSCRIPTION_PAUSED).
 * A proration invoice in the middle of a period is not a new period.
 */
export function mapSubscription(sub: StripeSubscription, ctx: { catalog: Catalog; now: Date; registerOn: RegisterOn; stored?: StoredPeriod | null }): VerifiedSubscription {
  const { now, stored } = ctx;
  const item = sub.items?.data?.[0];
  if (!item) throw new StripeApiError("invalid", "The Stripe subscription has no items.");
  if (sub.status === "incomplete_expired") throw new StripeApiError("invalid", "The Stripe subscription's first payment never completed (incomplete_expired).");
  const productId = productIdOfPrice(item.price, ctx.catalog);
  const { start: pStart, end: pEnd } = periodOf(sub);
  const origin = sec(sub.start_date) ?? sec(sub.created) ?? pStart ?? now;
  const start = pStart ?? origin;
  const end = pEnd ?? start;
  const inv = sub.latest_invoice && typeof sub.latest_invoice === "object" ? sub.latest_invoice : null;
  const currency = (inv?.currency ?? sub.currency ?? item.price.currency ?? "usd").toUpperCase();
  const country = inv?.customer_address?.country ?? null;
  const unitPrice = unitPriceOf(item.price, item.quantity ?? 1, currency);

  const openCounts = ctx.registerOn === "invoice_created";
  if (sub.status === "incomplete" && !openCounts) throw new StripeNotYetPaid("The subscription's first invoice is not paid yet.");
  const proration = inv?.billing_reason === "subscription_update";
  const paid = !inv || invoicePaid(inv) || (openCounts && inv.status === "open" && sub.status !== "past_due" && sub.status !== "unpaid");
  const trial = sub.status === "trialing" || (!!sub.trial_end && sec(sub.trial_end)! >= end && start < sec(sub.trial_end)!);

  let purchaseDate = start;
  let expiresDate = trial ? sec(sub.trial_end) ?? end : end;
  let storeTransactionId = inv?.id ?? stored?.storeTransactionId ?? sub.id;
  // A paid invoice costs what was paid; an open one that counts (register_on invoice_created) what is due.
  const invoiceAmount = !inv ? null : invoicePaid(inv) ? inv.amount_paid : inv.amount_due ?? inv.total;
  let price: Price | null = trial ? { amount: 0, currency } : inv && paid && !proration && typeof invoiceAmount === "number" ? { amount: fromMinor(invoiceAmount, currency), currency } : unitPrice;
  let billingIssuesDetectedAt: Date | null = null;
  let gracePeriodExpiresDate: Date | null = null;
  let unsubscribeDetectedAt: Date | null = null;
  let cancelReason: VerifiedSubscription["cancelReason"] = null;
  let autoResumeDate: Date | null = null;

  if (proration && stored) {
    // A mid-period proration invoice: same period, same transaction, the period's own price.
    storeTransactionId = stored.storeTransactionId ?? storeTransactionId;
    price = stored.price ?? price;
  }
  const renewalUnpaid = !paid && !trial && inv?.billing_reason !== "subscription_create";
  if (renewalUnpaid) {
    // Stripe moved to the new period, but nobody has paid for it: the paid period is the one before.
    purchaseDate = stored?.purchaseDate ?? origin;
    storeTransactionId = stored?.storeTransactionId ?? sub.id;
    price = stored?.price ?? unitPrice;
    expiresDate = start;
  }

  switch (sub.status) {
    case "past_due":
    case "unpaid": {
      billingIssuesDetectedAt = now;
      unsubscribeDetectedAt = now;
      cancelReason = "BILLING_ERROR";
      expiresDate = minDate(expiresDate, start);
      const retry = sec(inv?.next_payment_attempt);
      if (sub.status === "past_due" && retry && retry > now) gracePeriodExpiresDate = retry;
      break;
    }
    case "canceled": {
      const ended = sec(sub.ended_at) ?? sec(sub.canceled_at) ?? now;
      expiresDate = minDate(expiresDate, ended);
      unsubscribeDetectedAt = sec(sub.canceled_at) ?? ended;
      if (sub.cancellation_details?.reason === "payment_failed") { cancelReason = "BILLING_ERROR"; billingIssuesDetectedAt = unsubscribeDetectedAt; }
      break;
    }
    case "paused":
      expiresDate = minDate(expiresDate, now);
      break;
    default:
      break;
  }
  if (sub.status !== "canceled" && (sub.cancel_at_period_end || sub.cancel_at)) {
    unsubscribeDetectedAt ??= sec(sub.canceled_at) ?? now;
    if (sub.cancellation_details?.reason === "payment_failed") cancelReason = "BILLING_ERROR";
    const at = sec(sub.cancel_at);
    if (at) expiresDate = minDate(expiresDate, at);
  }
  const resumes = sec(sub.pause_collection?.resumes_at);
  if (sub.pause_collection && resumes && resumes > now) autoResumeDate = resumes;

  const periodType: PeriodType = trial ? "trial" : "normal";
  return {
    kind: "subscription", store: "stripe", storeKey: sub.id, productIdentifier: productId, productPlanIdentifier: null,
    isSandbox: !sub.livemode, purchaseDate, originalPurchaseDate: origin, expiresDate, periodType,
    unsubscribeDetectedAt, billingIssuesDetectedAt, gracePeriodExpiresDate, refundedAt: null, autoResumeDate,
    storeTransactionId, originalTransactionId: sub.id, price, countryCode: country, autoRenewProductId: productId, cancelReason,
  };
}

/** A paid Checkout Session in payment mode: one one-time purchase per line item, keyed by the PaymentIntent. */
export function mapCheckoutOneTime(s: StripeCheckoutSession, ctx: { catalog: Catalog; now: Date }): VerifiedOneTime[] {
  const items = s.line_items?.data ?? [];
  if (!items.length) throw new StripeApiError("invalid", "The Checkout Session has no line items.");
  const key = idOf(s.payment_intent) ?? s.id;
  return items.map((li, i) => {
    const productIdentifier = productIdOfPrice(li.price, ctx.catalog);
    const currency = (li.currency ?? s.currency ?? li.price?.currency ?? "usd").toUpperCase();
    return {
      kind: "non_subscription" as const, store: "stripe" as const, productIdentifier,
      storeTransactionId: i === 0 ? key : `${key}:${i}`,
      isSandbox: !s.livemode, isConsumable: ctx.catalog.productType(productIdentifier) === "consumable",
      purchaseDate: sec(s.created) ?? ctx.now, refundedAt: null,
      price: typeof li.amount_total === "number" ? { amount: fromMinor(li.amount_total, currency), currency } : null,
      countryCode: s.customer_details?.address?.country ?? null,
    };
  });
}
