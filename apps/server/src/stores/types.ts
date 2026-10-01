import type { OwnershipType, PeriodType, Price, Store } from "@revenuedot/core";

/** A purchase proven by a store (or by the Test Store), normalised for storage. */
export interface VerifiedSubscription {
  kind: "subscription";
  store: Store;
  storeKey: string;
  productIdentifier: string;
  productPlanIdentifier?: string | null;
  isSandbox: boolean;
  purchaseDate: Date;
  originalPurchaseDate: Date;
  expiresDate: Date | null;
  periodType: PeriodType;
  ownershipType?: OwnershipType;
  unsubscribeDetectedAt?: Date | null;
  billingIssuesDetectedAt?: Date | null;
  gracePeriodExpiresDate?: Date | null;
  refundedAt?: Date | null;
  autoResumeDate?: Date | null;
  storeTransactionId: string;
  originalTransactionId?: string | null;
  price?: Price | null;
  countryCode?: string | null;
  autoRenewProductId?: string | null;
  /** Why auto-renew is off beyond "the customer turned it off". `undefined` = the store did not say (keep what is stored). */
  cancelReason?: "PRICE_INCREASE" | "DEVELOPER_INITIATED" | "BILLING_ERROR" | null;
  /** Google Play: the answer to the cancel survey (CANCEL_SURVEY_REASON_…), when the customer gave one. */
  cancelSurveyReason?: string | null;
  /** Price increase consent state. `undefined` = the store did not say (keep what is stored). */
  priceIncreaseStatus?: "pending" | "accepted" | null;
  /** Google Play: the purchase token this one replaced (`linkedPurchaseToken` of an upgrade, downgrade or resubscribe). */
  replacesStoreKey?: string | null;
  /** When the store says the replaced chain ended (its line item expiry), if known. */
  replacedExpiresDate?: Date | null;
  /** Google Play: order ids of the replaced token (to find a chain imported by order id before its token was known). */
  replacedOrderIds?: string[] | null;
  /** Other store transaction ids of this chain that the store proved (Apple receipt history), for matching imported chains. */
  chainTransactionIds?: string[] | null;
}

export interface VerifiedOneTime {
  kind: "non_subscription";
  store: Store;
  productIdentifier: string;
  storeTransactionId: string;
  isSandbox: boolean;
  isConsumable: boolean;
  purchaseDate: Date;
  refundedAt?: Date | null;
  price?: Price | null;
  countryCode?: string | null;
}

export type VerifiedPurchase = VerifiedSubscription | VerifiedOneTime;

export interface AppRow { id: string; projectId: string; type: string; bundleId: string | null; credentials: Record<string, unknown> }

/** What the SDK posted to /v1/receipts, normalised across iOS and Android. */
export interface ReceiptInput {
  fetchToken: string | null;
  appTransaction: string | null;
  transactionId: string | null;
  productIds: string[];
  platformProducts: { productId: string; basePlanId?: string; offerId?: string }[];
  price: number | null;
  currency: string | null;
  storeCountry: string | null;
  normalDuration: string | null;
  isRestore: boolean;
  isSandboxHeader: boolean;
  storeUserId: string | null;
}

export interface StoreAdapter {
  /** Verifies what the device posted and returns every purchase it proves. Throws RCError on invalid receipts. */
  verify(app: AppRow, input: ReceiptInput, catalog: { productType: (storeId: string) => string | null; productDuration: (storeId: string) => string | null }): Promise<VerifiedPurchase[]>;
}
