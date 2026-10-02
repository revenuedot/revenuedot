import type { PeriodType, Price } from "@revenuedot/core";
import type { VerifiedOneTime, VerifiedSubscription } from "../types.js";
import { GalaxyApiError, samsungDate, type GalaxyReceipt, type GalaxySubscription } from "./api.js";
import { alpha2Of } from "./countries.js";

export interface Catalog { productType: (storeId: string) => string | null; productDuration: (storeId: string) => string | null }

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const money = (amount: unknown, currency: unknown): Price | null => {
  const a = num(amount), c = typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency.trim()) ? currency.trim().toUpperCase() : null;
  return a !== null && c ? { amount: Math.round(a * 100) / 100, currency: c } : null;
};
const minDate = (a: Date, b: Date) => (a < b ? a : b);

export const isSubscriptionReceipt = (r: GalaxyReceipt, catalog: Catalog) =>
  /^subscription$/i.test(r.itemType ?? "") || (!r.itemType && catalog.productType(r.itemId) === "subscription");

/** Test mode: the receipt's `mode: TEST`, or the subscription's `realMode: N` (a license tester's purchase). */
export const isTestReceipt = (r: GalaxyReceipt | null, s?: GalaxySubscription | null) => r?.mode === "TEST" || s?.realMode === "N";

/** What the SDK posted, used only when Samsung reports no price. */
export interface Posted { price: number | null; currency: string | null }

/**
 * A Galaxy Store subscription: one chain keyed by its first purchase id, each period by its latest order id.
 *   ACTIVE                       access to `subscriptionEndDate`
 *   currentPaymentPlan F / T     free trial / tiered (intro) price; R or `freeTrial: N` normal
 *   CANCEL                       auto-renew off (`cancelSubscriptionDate`), access to the end date
 *   gracePeriodYN: Y             billing issue, access to `gracePeriodEndDate`
 */
export function mapSubscription(r: GalaxyReceipt | null, s: GalaxySubscription, ctx: { catalog: Catalog; now: Date; purchaseId: string; posted?: Posted | null }): VerifiedSubscription {
  const { now } = ctx;
  const productId = s.itemID ?? r?.itemId;
  if (!productId) throw new GalaxyApiError("invalid", "Samsung returned a subscription without an item id.");
  const origin = samsungDate(s.subscriptionPurchaseDate) ?? samsungDate(r?.purchaseDate) ?? now;
  const start = samsungDate(s.latestRenewalDate) ?? origin;
  const end = samsungDate(s.subscriptionEndDate);
  if (!end) throw new GalaxyApiError("transient", "Samsung returned a subscription without an end date.");
  const plan = s.currentPaymentPlan ?? (s.freeTrial === "Y" ? "F" : s.freeTrial === "T" ? "T" : "R");
  const periodType: PeriodType = plan === "F" ? "trial" : plan === "T" ? "intro" : "normal";
  let price = money(s.price?.localPrice, s.price?.localCurrencyCode) ?? (r ? money(r.paymentAmount, r.currencyCode) : null) ?? money(ctx.posted?.price, ctx.posted?.currency);
  if (periodType === "trial") price = { amount: 0, currency: price?.currency ?? "USD" };
  const cancelled = s.subscriptionStatus === "CANCEL";
  const grace = s.gracePeriodYN === "Y" ? samsungDate(s.gracePeriodEndDate) : null;
  return {
    kind: "subscription", store: "galaxy", storeKey: s.subscriptionFirstPurchaseID ?? ctx.purchaseId, productIdentifier: productId, productPlanIdentifier: null,
    isSandbox: isTestReceipt(r, s), purchaseDate: start, originalPurchaseDate: origin, expiresDate: end, periodType,
    unsubscribeDetectedAt: cancelled ? minDate(samsungDate(s.cancelSubscriptionDate) ?? now, now) : null,
    billingIssuesDetectedAt: grace ? minDate(end, now) : null, gracePeriodExpiresDate: grace, refundedAt: null, autoResumeDate: null,
    storeTransactionId: s.latestOrderId ?? r?.orderId ?? ctx.purchaseId, originalTransactionId: s.subscriptionFirstPurchaseID ?? ctx.purchaseId,
    price, countryCode: alpha2Of(s.countryCode ?? r?.countryCode), autoRenewProductId: productId, cancelReason: null,
    ...(s.priceChange?.agreeYN === "Y" ? { priceIncreaseStatus: "accepted" as const } : {}),
  };
}

/** An in-app item: a one-time purchase keyed by its purchase id; `status: cancel` is a refund. */
export function mapItem(r: GalaxyReceipt, ctx: { catalog: Catalog; now: Date; purchaseId: string; posted?: Posted | null }): VerifiedOneTime {
  return {
    kind: "non_subscription", store: "galaxy", productIdentifier: r.itemId, storeTransactionId: ctx.purchaseId, isSandbox: isTestReceipt(r),
    isConsumable: ctx.catalog.productType(r.itemId) === "consumable", purchaseDate: samsungDate(r.purchaseDate) ?? ctx.now,
    refundedAt: r.status === "cancel" ? minDate(samsungDate(r.cancelDate) ?? ctx.now, ctx.now) : null,
    price: money(r.paymentAmount, r.currencyCode) ?? money(ctx.posted?.price, ctx.posted?.currency), countryCode: alpha2Of(r.countryCode),
  };
}
