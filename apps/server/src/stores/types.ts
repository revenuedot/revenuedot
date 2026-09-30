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
