import { commissionRate } from "./commission.js";
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

/** RevenueDot's own web funnel events (prd/web-billing/PRD.md §5); RevenueCat has no webhook types for them. Opt-in. */
export const FUNNEL_WEBHOOK_TYPES = ["FUNNEL_VIEWED", "FUNNEL_STEP_COMPLETED", "FUNNEL_PURCHASE"] as const;

/**
 * Paywall events the SDKs post to /v1/events (services/sdk-events.ts), forwarded to webhooks and integrations whose event
 * filter names them (prd/integrations/PRD.md "Paywall events"). The first five are the ones RevenueCat sends to Amplitude,
 * Mixpanel, PostHog and Segment; PAYWALL_PURCHASE_INITIATED and PAYWALL_PURCHASE_ERROR are RevenueDot additions. Opt-in.
 */
export const PAYWALL_WEBHOOK_TYPES = [
  "PAYWALL_IMPRESSION", "PAYWALL_CLOSE", "PAYWALL_CANCEL", "PAYWALL_EXIT_OFFER", "PAYWALL_COMPONENT_INTERACTED",
  "PAYWALL_PURCHASE_INITIATED", "PAYWALL_PURCHASE_ERROR",
] as const;

/**
 * Types delivered only to webhooks and integrations whose event filter names them. SUBSCRIBER_ALIAS is deprecated by
 * RevenueCat and "new projects don't receive this webhook", so an endpoint without a filter never gets it. For an
 * integration (not a webhook), naming opt-in types adds them to the other events: they never narrow its filter
 * (services/integrations/queue.ts).
 */
export const OPT_IN_EVENT_TYPES: ReadonlySet<string> = new Set(["SUBSCRIBER_ALIAS", ...FUNNEL_WEBHOOK_TYPES, ...PAYWALL_WEBHOOK_TYPES]);

/** Types RevenueDot never produces, because it never has the fact behind them (prd/webhooks/PRD.md). They stay valid filters. */
export const NEVER_SENT_EVENT_TYPES: ReadonlySet<string> = new Set(["TEMPORARY_ENTITLEMENT_GRANT", "INVOICE_ISSUANCE"]);

export type CancelReason = "UNSUBSCRIBE" | "BILLING_ERROR" | "DEVELOPER_INITIATED" | "PRICE_INCREASE" | "CUSTOMER_SUPPORT" | "UNKNOWN";

export interface DerivedEvent {
  type: EventType;
  cancelReason?: CancelReason;
  expirationReason?: CancelReason | "SUBSCRIPTION_PAUSED";
  newProductId?: string;
  /** PRODUCT_CHANGE on a chain that already switched: the product the customer switched from (the event's `product_id`). */
  fromProduct?: { productId: string; productPlanId?: string | null };
  /** For refunds the price is negative. */
  isRefund?: boolean;
  /** RENEWAL only: the first paid period after a free trial. */
  isTrialConversion?: boolean;
}

const t = (d: Date | null | undefined) => (d ? d.getTime() : null);

/** `cancel_reason` of a CANCELLATION that turns auto-renew off: a failed charge wins, then what the store said, else the customer. */
export const cancelReasonOf = (s: Pick<Subscription, "billingIssuesDetectedAt" | "cancelReason">): CancelReason =>
  s.billingIssuesDetectedAt ? "BILLING_ERROR" : s.cancelReason ?? "UNSUBSCRIBE";

/** `expiration_reason` of an EXPIRATION: paused, a failed charge, the stored cancel reason, else the customer unsubscribed. */
export const expirationReasonOf = (s: Pick<Subscription, "autoResumeDate" | "billingIssuesDetectedAt" | "cancelReason">): CancelReason | "SUBSCRIPTION_PAUSED" =>
  s.autoResumeDate ? "SUBSCRIPTION_PAUSED" : cancelReasonOf(s);

/** Price-increase consent events for a change of the consent state (null = nothing outstanding). */
function priceIncreaseEvents(prev: Subscription["priceIncreaseStatus"], next: Subscription["priceIncreaseStatus"]): DerivedEvent[] {
  if ((prev ?? null) === (next ?? null)) return [];
  if (next === "pending") return [{ type: "PRICE_INCREASE_CONSENT_REQUIRED" }];
  if (next === "accepted") return [{ type: "PRICE_INCREASE_CONSENT_APPROVED" }];
  return [];
}

/**
 * Which lifecycle events a change to one subscription chain produces, in RevenueCat's vocabulary.
 * `prev` is null for a chain seen for the first time.
 */
export function diffSubscription(prev: Subscription | null, next: Subscription, now: Date): DerivedEvent[] {
  const out: DerivedEvent[] = [];
  if (!prev) {
    out.push({ type: "INITIAL_PURCHASE" });
    if (next.unsubscribeDetectedAt && !next.refundedAt) out.push({ type: "CANCELLATION", cancelReason: cancelReasonOf(next) });
    if (next.refundedAt) out.push({ type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", isRefund: true });
    out.push(...priceIncreaseEvents(null, next.priceIncreaseStatus));
    return out;
  }
  // A renewal, or a lapsed customer resubscribing: RevenueCat sends RENEWAL for both. INITIAL_PURCHASE is only the first purchase of a chain.
  const newPeriod = t(next.purchaseDate)! > t(prev.purchaseDate)! && (next.storeTransactionId ?? "") !== (prev.storeTransactionId ?? "");
  const renewal: DerivedEvent = { type: "RENEWAL", isTrialConversion: prev.periodType === "trial" && next.periodType !== "trial" };
  if (prev.productIdentifier !== next.productIdentifier) {
    // A switch announced earlier (a scheduled downgrade reached renewal) is only the renewal now; an immediate one is PRODUCT_CHANGE
    // from the old product, plus RENEWAL when the new product starts a new period (App Store upgrades).
    if ((prev.autoRenewProductId ?? null) !== next.productIdentifier) {
      out.push({ type: "PRODUCT_CHANGE", newProductId: next.productIdentifier, fromProduct: { productId: prev.productIdentifier, productPlanId: prev.productPlanIdentifier ?? null } });
    }
    if (newPeriod) out.push(renewal);
  } else if (newPeriod) {
    out.push(renewal);
  } else if (next.expiresDate && prev.expiresDate && next.expiresDate > prev.expiresDate && t(next.purchaseDate) === t(prev.purchaseDate) && !(prev.refundedAt && !next.refundedAt)) {
    // (A refund taken back restores the period's own end: REFUND_REVERSED below, not an extension.)
    out.push({ type: "SUBSCRIPTION_EXTENDED" });
  }
  // A downgrade or crossgrade scheduled for the next renewal (App Store DOWNGRADE, deferred Google Play replacement).
  const scheduled = next.autoRenewProductId ?? null;
  const known = prev.autoRenewProductId ?? prev.productIdentifier;
  if (prev.productIdentifier === next.productIdentifier && scheduled && scheduled !== next.productIdentifier && scheduled !== known) {
    out.push({ type: "PRODUCT_CHANGE", newProductId: scheduled });
  }
  const renewedNow = out.some((e) => e.type === "RENEWAL");
  if (!prev.refundedAt && next.refundedAt) out.push({ type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", isRefund: true });
  // A new period after a refunded one is a renewal (Stripe keeps billing a subscription whose last invoice was refunded), not a reversal.
  else if (prev.refundedAt && !next.refundedAt && !newPeriod) out.push({ type: "REFUND_REVERSED" });
  if (!prev.billingIssuesDetectedAt && next.billingIssuesDetectedAt) out.push({ type: "BILLING_ISSUE" });
  if (!prev.unsubscribeDetectedAt && next.unsubscribeDetectedAt && !next.refundedAt) {
    out.push({ type: "CANCELLATION", cancelReason: cancelReasonOf(next) });
  } else if (prev.unsubscribeDetectedAt && !next.unsubscribeDetectedAt && !(renewedNow && prev.billingIssuesDetectedAt)) {
    // Recovering a failed payment is a RENEWAL, not the customer turning auto-renew back on.
    out.push({ type: "UNCANCELLATION" });
  }
  if (!prev.autoResumeDate && next.autoResumeDate) out.push({ type: "SUBSCRIPTION_PAUSED" });
  out.push(...priceIncreaseEvents(prev.priceIncreaseStatus, next.priceIncreaseStatus));
  // Access during a grace period is access too: a chain that ends while in grace expires then.
  const prevLive = prev.expiresDate === null || prev.expiresDate > now || (prev.gracePeriodExpiresDate ?? null) !== null && prev.gracePeriodExpiresDate! > now;
  const nextLive = next.expiresDate === null || next.expiresDate > now || (next.gracePeriodExpiresDate ?? null) !== null && next.gracePeriodExpiresDate! > now;
  if (prevLive && !nextLive && !next.refundedAt) out.push({ type: "EXPIRATION", expirationReason: expirationReasonOf(next) });
  return out;
}

/** One-time purchases: the purchase, a refund (CANCELLATION with CUSTOMER_SUPPORT), and a refund being reversed. */
export function diffNonSubscription(prev: NonSubscription | null, next: NonSubscription): DerivedEvent[] {
  if (!prev) return next.refundedAt ? [{ type: "NON_RENEWING_PURCHASE" }, { type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", isRefund: true }] : [{ type: "NON_RENEWING_PURCHASE" }];
  if (!prev.refundedAt && next.refundedAt) return [{ type: "CANCELLATION", cancelReason: "CUSTOMER_SUPPORT", isRefund: true }];
  if (prev.refundedAt && !next.refundedAt) return [{ type: "REFUND_REVERSED" }];
  return [];
}

/** Store names in webhook payloads are upper case (APP_STORE, PLAY_STORE ...). */
export const webhookStore = (s: Store) => s.toUpperCase();

/**
 * The store's commission rate without transaction context (no program dates, under Google Play's $1M tier): App Store,
 * Amazon and Galaxy Store 30% (15% with `smallBusiness`), Google Play 15%, Roku 20%, Paddle 5%. Per-transaction rates,
 * with the Small Business Program dates and Google Play's yearly tier, come from `commissionRate` (commission.ts).
 */
export function commission(store: Store, smallBusiness = false): number {
  if (smallBusiness && (store === "app_store" || store === "mac_app_store" || store === "play_store" || store === "amazon" || store === "galaxy")) return 0.15;
  return commissionRate({ store, appId: null, at: 0, kind: "purchase" });
}
