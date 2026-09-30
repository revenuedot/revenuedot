/** Stores a purchase can come from. Values are the wire strings the RevenueCat SDKs decode. */
export type Store =
  | "app_store" | "mac_app_store" | "play_store" | "amazon" | "stripe" | "rc_billing"
  | "promotional" | "external" | "paddle" | "test_store" | "roku" | "galaxy";

export type PeriodType = "normal" | "trial" | "intro" | "promotional" | "prepaid";
export type OwnershipType = "PURCHASED" | "FAMILY_SHARED";
export type Environment = "production" | "sandbox";

export interface Price { amount: number; currency: string }

/** One subscription as the server knows it: the latest state of one store subscription chain. */
export interface Subscription {
  productIdentifier: string;
  /** Google base plan id, when the product is `subscriptionId:basePlanId`. */
  productPlanIdentifier?: string | null;
  store: Store;
  isSandbox: boolean;
  purchaseDate: Date;
  originalPurchaseDate: Date;
  /** null only for promotional lifetime grants. */
  expiresDate: Date | null;
  periodType: PeriodType;
  ownershipType?: OwnershipType;
  unsubscribeDetectedAt?: Date | null;
  billingIssuesDetectedAt?: Date | null;
  gracePeriodExpiresDate?: Date | null;
  refundedAt?: Date | null;
  autoResumeDate?: Date | null;
  storeTransactionId?: string | null;
  originalTransactionId?: string | null;
  price?: Price | null;
  displayName?: string | null;
  managementUrl?: string | null;
  /** Promotional grants carry the entitlement they unlock. */
  entitlementIdentifier?: string | null;
  /** The product the next period renews into; differs from `productIdentifier` while a downgrade or crossgrade is scheduled. */
  autoRenewProductId?: string | null;
  /** Why auto-renew is off when it is more than the customer turning it off (price increase declined, developer cancelled). */
  cancelReason?: "PRICE_INCREASE" | "DEVELOPER_INITIATED" | "BILLING_ERROR" | null;
  /** An outstanding price increase: consent required and not given yet, or accepted. */
  priceIncreaseStatus?: "pending" | "accepted" | null;
}

/** A one-time purchase: consumable, non-consumable or non-renewing subscription. */
export interface NonSubscription {
  id: string;
  productIdentifier: string;
  store: Store;
  isSandbox: boolean;
  purchaseDate: Date;
  originalPurchaseDate?: Date;
  storeTransactionId: string;
  price?: Price | null;
  displayName?: string | null;
  /** Consumables are finished by the SDK; non-consumables grant lifetime access. */
  isConsumable?: boolean;
  refundedAt?: Date | null;
}

export interface AttributeValue { value: string | null; updatedAtMs: number }

/** Everything needed to answer "who is this customer and what do they have?". */
export interface CustomerState {
  originalAppUserId: string;
  firstSeen: Date;
  lastSeen: Date;
  originalApplicationVersion?: string | null;
  originalPurchaseDate?: Date | null;
  managementUrl?: string | null;
  subscriptions: Subscription[];
  nonSubscriptions: NonSubscription[];
  attributes: Record<string, AttributeValue>;
}

/** Entitlement lookup key -> product identifiers that unlock it (project catalog). */
export type EntitlementMap = Record<string, string[]>;

export interface ActiveEntitlement {
  identifier: string;
  productIdentifier: string;
  productPlanIdentifier?: string | null;
  purchaseDate: Date;
  /** null = lifetime. When in a grace period this is the grace end, so the SDK keeps access. */
  expiresDate: Date | null;
  gracePeriodExpiresDate?: Date | null;
}
