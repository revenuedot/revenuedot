import type { OfferType, PeriodType, Price } from "@revenuedot/core";
import { addDuration } from "../test-store.js";
import type { VerifiedOneTime, VerifiedSubscription } from "../types.js";
import type { Money, ProductPurchase, SubscriptionPurchaseV2 } from "./api.js";

export interface Catalog { productType: (storeId: string) => string | null; productDuration: (storeId: string) => string | null }

/** What the device posted about this purchase (receipt path only). */
export interface Posted { productId: string | null; price: number | null; currency: string | null }

export const S = {
  PENDING: "SUBSCRIPTION_STATE_PENDING",
  ACTIVE: "SUBSCRIPTION_STATE_ACTIVE",
  PAUSED: "SUBSCRIPTION_STATE_PAUSED",
  GRACE: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  ON_HOLD: "SUBSCRIPTION_STATE_ON_HOLD",
  CANCELED: "SUBSCRIPTION_STATE_CANCELED",
  EXPIRED: "SUBSCRIPTION_STATE_EXPIRED",
  PENDING_CANCELED: "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED",
} as const;

const date = (s?: string | null) => (s ? new Date(s) : null);
const minDate = (a: Date, b: Date) => (a < b ? a : b);

export const moneyToPrice = (m?: Money | null): Price | null =>
  m?.currencyCode ? { amount: Number(m.units ?? 0) + (m.nanos ?? 0) / 1e9, currency: m.currencyCode } : null;

/** Renewal orders carry a `..N` suffix on the first order id (GPA.1234-5678-9012-34567..0). */
export const isRenewalOrder = (orderId?: string | null) => !!orderId && /\.\.\d+$/.test(orderId);
export const baseOrderId = (orderId: string) => orderId.replace(/\.\.\d+$/, "");

/** The line item RevenueDot tracks for a subscription purchase (single-item subscriptions are the norm). */
export const lineItemOf = (sub: SubscriptionPurchaseV2) => sub.lineItems?.[0];

/** Order id of the period that is paid for now; during grace or hold the pending renewal is not counted. */
export const currentOrderId = (sub: SubscriptionPurchaseV2, token: string) =>
  lineItemOf(sub)?.latestSuccessfulOrderId ?? sub.latestOrderId ?? token;

function periodTypeOf(sub: SubscriptionPurchaseV2, orderId: string): PeriodType {
  const li = lineItemOf(sub);
  if (li?.offerPhase) {
    if (li.offerPhase.freeTrial) return "trial";
    if (li.offerPhase.introductoryPrice) return "intro";
    return li.prepaidPlan ? "prepaid" : "normal";
  }
  if (li?.prepaidPlan) return "prepaid";
  // Without offerPhase, an offer only describes the first period: renewals are full price.
  if (!li?.offerDetails?.offerId || isRenewalOrder(orderId)) return "normal";
  const tags = (li.offerDetails.offerTags ?? []).join(" ").toLowerCase();
  if (/intro|discount/.test(tags)) return "intro";
  return "trial";
}

/**
 * The offer of the current period. A free-trial or introductory-price phase names itself; without `offerPhase` the first
 * order follows the period type and a renewal order is `unspecified` (RevenueCat's "Google offers not on the first period").
 * A period at the base price has no offer.
 */
export function offerOf(sub: SubscriptionPurchaseV2, orderId: string): { offerType: OfferType | null; offerId: string | null } {
  const li = lineItemOf(sub);
  const offerId = li?.offerDetails?.offerId;
  if (!offerId) return { offerType: null, offerId: null };
  const ph = li!.offerPhase;
  let offerType: OfferType | null;
  if (ph) offerType = ph.freeTrial ? "free_trial" : ph.introductoryPrice ? "introductory" : ph.basePrice ? null : "unspecified";
  else if (isRenewalOrder(orderId)) offerType = "unspecified";
  else offerType = periodTypeOf(sub, orderId) === "trial" ? "free_trial" : "introductory";
  return { offerType, offerId: offerType ? offerId : null };
}

/**
 * Start of the current paid period. The first order starts at `startTime`; a renewal starts one base-plan period
 * before the expiry when the catalog knows the period, otherwise now (notifications arrive at renewal time).
 */
function periodStart(sub: SubscriptionPurchaseV2, orderId: string, catalog: Catalog, now: Date): Date {
  const li = lineItemOf(sub);
  const start = date(sub.startTime) ?? now;
  if (!isRenewalOrder(orderId)) return start;
  const expiry = date(li?.expiryTime);
  const plan = li?.offerDetails?.basePlanId;
  const dur = (plan ? catalog.productDuration(`${li!.productId}:${plan}`) : null) ?? (li ? catalog.productDuration(li.productId) : null);
  let d: Date;
  if (dur && expiry) {
    try { d = addDuration(expiry, dur, -1); } catch { d = now; }
  } else d = expiry ? minDate(now, expiry) : now;
  return d < start ? start : d;
}

/**
 * SubscriptionPurchaseV2 → one subscription chain keyed by purchase token.
 * Google state → RevenueCat fields:
 *   IN_GRACE_PERIOD: billing issue now, grace period until the line item expiry (access continues).
 *   ON_HOLD: billing issue, access ended.
 *   PAUSED: auto-resume date from pausedStateContext, access ended.
 *   CANCELED (and a turned-off auto-renew): unsubscribe detected at the user's cancel time.
 *   A replacement (upgrade/downgrade) cancellation is not a customer cancellation.
 */
export function mapSubscription(sub: SubscriptionPurchaseV2, token: string, ctx: { catalog: Catalog; now: Date; posted?: Posted | null }): VerifiedSubscription {
  const { catalog, now } = ctx;
  const li = lineItemOf(sub);
  if (!li?.productId) throw new Error("Google returned a subscription without line items.");
  const state = sub.subscriptionState ?? S.ACTIVE;
  const orderId = currentOrderId(sub, token);
  const expiry = date(li.expiryTime) ?? now;
  const periodType = periodTypeOf(sub, orderId);
  const cancel = sub.canceledStateContext;
  const replaced = !!cancel?.replacementCancellation;
  const autoRenewOff = li.autoRenewingPlan?.autoRenewEnabled === false;

  let expiresDate = expiry;
  let billingIssuesDetectedAt: Date | null = null;
  let gracePeriodExpiresDate: Date | null = null;
  let autoResumeDate: Date | null = null;
  let unsubscribeDetectedAt: Date | null = null;

  if (!replaced && (state === S.CANCELED || state === S.EXPIRED || autoRenewOff || cancel)) {
    unsubscribeDetectedAt = date(cancel?.userInitiatedCancellation?.cancelTime) ?? (state === S.EXPIRED ? minDate(expiry, now) : now);
  }
  if (state === S.GRACE) {
    billingIssuesDetectedAt = now;
    gracePeriodExpiresDate = expiry;
    // A failed renewal also turns renewal off until the payment is fixed (CANCELLATION with BILLING_ERROR).
    unsubscribeDetectedAt ??= now;
  } else if (state === S.ON_HOLD) {
    billingIssuesDetectedAt = now;
    unsubscribeDetectedAt ??= now;
    expiresDate = minDate(expiry, now);
  } else if (state === S.PAUSED) {
    autoResumeDate = date(sub.pausedStateContext?.autoResumeTime);
    expiresDate = minDate(expiry, now);
  }

  const posted = ctx.posted && (!ctx.posted.productId || ctx.posted.productId === li.productId) ? ctx.posted : null;
  const priceIncreaseStatus = priceIncreaseOf(li.autoRenewingPlan);
  // Google's cancellation context says who turned renewal off: the developer, or the system (a declined price increase or a failed charge).
  const cancelReason = !unsubscribeDetectedAt ? null
    : cancel?.developerInitiatedCancellation ? "DEVELOPER_INITIATED" as const
    : cancel?.systemInitiatedCancellation ? (priceIncreaseStatus === "pending" ? "PRICE_INCREASE" as const : "BILLING_ERROR" as const)
    : null;
  const recurring = moneyToPrice(li.autoRenewingPlan?.recurringPrice);
  let price: Price | null = null;
  if (periodType === "trial") {
    const currency = posted?.currency ?? recurring?.currency;
    price = currency ? { amount: 0, currency } : null;
  } else if (posted && posted.price !== null && posted.currency) price = { amount: posted.price, currency: posted.currency };
  else if (periodType === "normal") price = recurring;

  return {
    kind: "subscription", store: "play_store", storeKey: token,
    productIdentifier: li.productId, productPlanIdentifier: li.offerDetails?.basePlanId ?? null,
    isSandbox: !!sub.testPurchase,
    purchaseDate: periodStart(sub, orderId, catalog, now),
    originalPurchaseDate: date(sub.startTime) ?? now,
    expiresDate, periodType,
    unsubscribeDetectedAt, billingIssuesDetectedAt, gracePeriodExpiresDate, autoResumeDate, refundedAt: null,
    storeTransactionId: orderId, originalTransactionId: baseOrderId(orderId),
    price, countryCode: sub.regionCode ?? null,
    autoRenewProductId: li.deferredItemReplacement?.productId ?? li.productId,
    cancelReason, priceIncreaseStatus, replacesStoreKey: sub.linkedPurchaseToken ?? null,
    cancelSurveyReason: cancel?.userInitiatedCancellation?.cancelSurveyResult?.reason ?? (unsubscribeDetectedAt ? undefined : null),
    ...offerOf(sub, orderId),
  };
}

/**
 * Price increase consent from Google's state: a PRICE_INCREASE change (the opt-in kind) that is OUTSTANDING, or a price
 * step-up that is PENDING, needs consent; CONFIRMED means the customer accepted. Applied, cancelled, decreases and
 * opt-out increases leave nothing outstanding.
 */
export function priceIncreaseOf(plan: NonNullable<NonNullable<SubscriptionPurchaseV2["lineItems"]>[number]["autoRenewingPlan"]> | undefined): "pending" | "accepted" | null {
  const step = plan?.priceStepUpConsentDetails?.state;
  if (step === "PENDING") return "pending";
  if (step === "CONFIRMED") return "accepted";
  const d = plan?.priceChangeDetails;
  if (d?.priceChangeMode !== "PRICE_INCREASE") return null;
  if (d.priceChangeState === "OUTSTANDING") return "pending";
  if (d.priceChangeState === "CONFIRMED") return "accepted";
  return null;
}

/** ProductPurchase → one-time purchase keyed by order id (the token when Google has no order id). */
export function mapProduct(p: ProductPurchase, productId: string, token: string, ctx: { catalog: Catalog; now: Date; posted?: Posted | null }): VerifiedOneTime {
  const posted = ctx.posted && (!ctx.posted.productId || ctx.posted.productId === productId) ? ctx.posted : null;
  return {
    kind: "non_subscription", store: "play_store", productIdentifier: productId,
    storeTransactionId: p.orderId ?? token,
    isSandbox: p.purchaseType === 0,
    isConsumable: ctx.catalog.productType(productId) === "consumable",
    purchaseDate: p.purchaseTimeMillis ? new Date(Number(p.purchaseTimeMillis)) : ctx.now,
    refundedAt: p.purchaseState === 1 ? ctx.now : null,
    price: posted && posted.price !== null && posted.currency ? { amount: posted.price, currency: posted.currency } : null,
    countryCode: p.regionCode ?? null,
  };
}
