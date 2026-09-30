import type { NonSubscription, Store, Subscription } from "./types.js";

export type EventType =
  | "TEST" | "INITIAL_PURCHASE" | "RENEWAL" | "CANCELLATION" | "UNCANCELLATION" | "NON_RENEWING_PURCHASE"
  | "SUBSCRIPTION_PAUSED" | "EXPIRATION" | "BILLING_ISSUE" | "PRODUCT_CHANGE" | "SUBSCRIPTION_EXTENDED"
  | "REFUND_REVERSED" | "TRANSFER" | "TEMPORARY_ENTITLEMENT_GRANT" | "VIRTUAL_CURRENCY_TRANSACTION"
  | "INVOICE_ISSUANCE" | "EXPERIMENT_ENROLLMENT" | "PURCHASE_REDEEMED" | "SUBSCRIBER_ALIAS"
  | "PRICE_INCREASE_CONSENT_REQUIRED" | "PRICE_INCREASE_CONSENT_APPROVED";

export const EVENT_TYPES: EventType[] = [
  "TEST", "INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION", "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_PAUSED", "EXPIRATION", "BILLING_ISSUE", "PRODUCT_CHANGE", "SUBSCRIPTION_EXTENDED",
  "REFUND_REVERSED", "TRANSFER", "TEMPORARY_ENTITLEMENT_GRANT", "VIRTUAL_CURRENCY_TRANSACTION",
  "INVOICE_ISSUANCE", "EXPERIMENT_ENROLLMENT", "PURCHASE_REDEEMED", "SUBSCRIBER_ALIAS",
  "PRICE_INCREASE_CONSENT_REQUIRED", "PRICE_INCREASE_CONSENT_APPROVED",
];

export type CancelReason = "UNSUBSCRIBE" | "BILLING_ERROR" | "DEVELOPER_INITIATED" | "PRICE_INCREASE" | "CUSTOMER_SUPPORT" | "UNKNOWN";

export interface DerivedEvent {
  type: EventType;
  cancelReason?: CancelReason;
  expirationReason?: CancelReason | "SUBSCRIPTION_PAUSED";
  newProductId?: string;
  /** For refunds the price is negative. */
  isRefund?: boolean;
  /** RENEWAL only: the first paid period after a free trial. */
  isTrialConversion?: boolean;
}

const t = (d: Date | null | undefined) => (d ? d.getTime() : null);

/**
 * Which lifecycle events a change to one subscription chain produces, in RevenueCat's vocabulary.
 * `prev` is null for a chain seen for the first time.
 */
export function diffSubscription(prev: Subscription | null, next: Subscription, now: Date): DerivedEvent[] {
  const out: DerivedEvent[] = [];
  if (!prev) {
    out.push({ type: "INITIAL_PURCHASE" });
    if (next.unsubscribeDetectedAt) out.push({ type: "CANCELLATION", cancelReason: "UNSUBSCRIBE" });
    if (next.refundedAt) out.push({ type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", isRefund: true });
    return out;
  }
  if (prev.productIdentifier !== next.productIdentifier) out.push({ type: "PRODUCT_CHANGE", newProductId: next.productIdentifier });
  else if (t(next.purchaseDate)! > t(prev.purchaseDate)! && (next.storeTransactionId ?? "") !== (prev.storeTransactionId ?? "")) {
    // A renewal, or a lapsed customer resubscribing: RevenueCat sends RENEWAL for both. INITIAL_PURCHASE is only the first purchase of a chain.
    out.push({ type: "RENEWAL", isTrialConversion: prev.periodType === "trial" && next.periodType !== "trial" });
  } else if (next.expiresDate && prev.expiresDate && next.expiresDate > prev.expiresDate && t(next.purchaseDate) === t(prev.purchaseDate)) {
    out.push({ type: "SUBSCRIPTION_EXTENDED" });
  }
  const renewedNow = out.some((e) => e.type === "RENEWAL");
  if (!prev.refundedAt && next.refundedAt) out.push({ type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", isRefund: true });
  else if (prev.refundedAt && !next.refundedAt) out.push({ type: "REFUND_REVERSED" });
  if (!prev.billingIssuesDetectedAt && next.billingIssuesDetectedAt) out.push({ type: "BILLING_ISSUE" });
  if (!prev.unsubscribeDetectedAt && next.unsubscribeDetectedAt && !next.refundedAt) {
    out.push({ type: "CANCELLATION", cancelReason: next.billingIssuesDetectedAt ? "BILLING_ERROR" : "UNSUBSCRIBE" });
  } else if (prev.unsubscribeDetectedAt && !next.unsubscribeDetectedAt && !(renewedNow && prev.billingIssuesDetectedAt)) {
    // Recovering a failed payment is a RENEWAL, not the customer turning auto-renew back on.
    out.push({ type: "UNCANCELLATION" });
  }
  if (!prev.autoResumeDate && next.autoResumeDate) out.push({ type: "SUBSCRIPTION_PAUSED" });
  const prevLive = prev.expiresDate === null || prev.expiresDate > now;
  const nextLive = next.expiresDate === null || next.expiresDate > now || (next.gracePeriodExpiresDate ?? null) !== null && next.gracePeriodExpiresDate! > now;
  if (prevLive && !nextLive && !next.refundedAt) {
    out.push({ type: "EXPIRATION", expirationReason: next.autoResumeDate ? "SUBSCRIPTION_PAUSED" : next.billingIssuesDetectedAt ? "BILLING_ERROR" : "UNSUBSCRIBE" });
  }
  return out;
}

export function diffNonSubscription(prev: NonSubscription | null, next: NonSubscription): DerivedEvent[] {
  if (!prev) return [{ type: "NON_RENEWING_PURCHASE" }];
  if (!prev.refundedAt && next.refundedAt) return [{ type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", isRefund: true }];
  return [];
}

/** Store names in webhook payloads are upper case (APP_STORE, PLAY_STORE ...). */
export const webhookStore = (s: Store) => s.toUpperCase();

/** Approximate store commission used for take-home estimates (RevenueCat reports 0.7 / 0.85 / 1.0 similarly). */
export function commission(store: Store, smallBusiness = false): number {
  if (store === "app_store" || store === "mac_app_store" || store === "play_store" || store === "amazon") return smallBusiness ? 0.15 : 0.3;
  return 0;
}
