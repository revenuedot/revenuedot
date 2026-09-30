// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the billing transactions of one subscription chain (REST API v2 subscription transactions).
// Docs: https://revenuedot.app/docs/api
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { monetaryFor } from "../routes/v2/common.js";
import { baseOrderId } from "../stores/google/map.js";

type SubRow = typeof schema.subscriptions.$inferSelect;
type TxRow = typeof schema.transactions.$inferSelect;

export interface SubscriptionTransaction {
  object: "subscription_transaction";
  id: string;
  purchased_at: number;
  product_store_identifier: string;
  revenue_in_local_currency: ReturnType<typeof monetaryFor> | null;
  revenue_in_usd: ReturnType<typeof monetaryFor> | null;
  expiration_date: number | null;
  effective_expiration_date: number | null;
}

const PAID = ["purchase", "renewal", "trial"];

/**
 * Which stored transactions belong to a chain. The transactions table is per customer, so the chain is found by store ids:
 * - Google Play: every order of a purchase token shares the base order id (`GPA.x`, `GPA.x..0`, `GPA.x..1`).
 * - Other stores: the customer's transactions for this store since the chain started, for a product the chain has had,
 *   minus those that are the current transaction of another of the customer's chains.
 */
export async function chainTransactions(db: DB, s: SubRow): Promise<TxRow[]> {
  const T = schema.transactions;
  const rows = await db.select().from(T).where(and(eq(T.projectId, s.projectId), eq(T.customerId, s.customerId), eq(T.store, s.store)));
  if (s.store === "play_store") {
    const base = baseOrderId(s.originalTransactionId ?? s.storeTransactionId ?? s.storeKey);
    return rows.filter((t) => baseOrderId(t.storeTransactionId) === base);
  }
  const others = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.customerId, s.customerId), eq(schema.subscriptions.store, s.store)));
  const otherIds = new Set(others.filter((o) => o.id !== s.id).flatMap((o) => [o.storeKey, o.storeTransactionId ?? ""]));
  const products = new Set([s.productIdentifier, s.autoRenewProductId ?? s.productIdentifier]);
  const own = new Set([s.storeKey, s.storeTransactionId ?? "", s.originalTransactionId ?? ""]);
  return rows.filter((t) => own.has(t.storeTransactionId)
    || (!otherIds.has(t.storeTransactionId) && products.has(t.productIdentifier) && t.purchasedAt >= s.originalPurchaseDate));
}

/** One item per store transaction (purchases, trials, renewals); a refunded transaction's access ends at the refund. */
export async function subscriptionTransactions(db: DB, s: SubRow): Promise<SubscriptionTransaction[]> {
  const rows = await chainTransactions(db, s);
  const refunds = new Map(rows.filter((t) => t.kind === "refund").map((t) => [t.storeTransactionId, t.purchasedAt]));
  const reversed = new Set(rows.filter((t) => t.kind === "refund_reversal").map((t) => t.storeTransactionId));
  const paid = new Map<string, TxRow>();
  for (const t of rows) if (PAID.includes(t.kind) && !paid.has(t.storeTransactionId)) paid.set(t.storeTransactionId, t);
  const items = [...paid.values()].map((t) => shape(s, {
    id: t.storeTransactionId, purchasedAt: t.purchasedAt, product: t.productIdentifier, expires: t.expiresAt,
    local: t.priceAmount, currency: t.priceCurrency, usd: t.revenueUsd, refundedAt: reversed.has(t.storeTransactionId) ? null : refunds.get(t.storeTransactionId) ?? null,
  }));
  // A chain stored without revenue history (no transaction rows yet) still has its current transaction.
  const current = s.storeTransactionId ?? s.storeKey;
  if (!paid.has(current) && s.store !== "promotional") {
    items.push(shape(s, {
      id: current, purchasedAt: s.purchaseDate, product: s.productIdentifier, expires: s.expiresDate,
      local: s.priceAmount, currency: s.priceCurrency, usd: s.priceUsd, refundedAt: s.refundedAt,
    }));
  }
  return items;
}

function shape(s: SubRow, t: { id: string; purchasedAt: Date; product: string; expires: Date | null; local: number | null; currency: string | null; usd: number | null; refundedAt: Date | null }): SubscriptionTransaction {
  const current = t.id === (s.storeTransactionId ?? s.storeKey);
  const refundedAt = t.refundedAt ?? (current ? s.refundedAt : null);
  const grace = current && s.gracePeriodExpiresDate && t.expires && s.gracePeriodExpiresDate > t.expires ? s.gracePeriodExpiresDate : null;
  const effective = refundedAt ?? grace ?? t.expires;
  return {
    object: "subscription_transaction", id: t.id, purchased_at: t.purchasedAt.getTime(), product_store_identifier: t.product,
    revenue_in_local_currency: t.local !== null && t.currency ? monetaryFor(t.local, t.currency, s.store) : null,
    revenue_in_usd: t.usd !== null ? monetaryFor(t.usd, "USD", s.store) : null,
    expiration_date: t.expires ? t.expires.getTime() : null,
    effective_expiration_date: effective ? effective.getTime() : null,
  };
}
