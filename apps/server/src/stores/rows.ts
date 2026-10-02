import { and, eq } from "drizzle-orm";
import { isAnonymous, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { VerifiedOneTime, VerifiedSubscription } from "./types.js";

/** Stored purchase rows back to verified purchases, for store notifications that only change part of the state. */

const { subscriptions, nonSubscriptions, customerAliases } = schema;
export type SubRow = typeof subscriptions.$inferSelect;
export type NonSubRow = typeof nonSubscriptions.$inferSelect;

export const rowPrice = (r: { priceAmount: number | null; priceCurrency: string | null }) =>
  r.priceAmount !== null && r.priceCurrency ? { amount: r.priceAmount, currency: r.priceCurrency } : null;

export async function subRowOf(db: DB, projectId: string, store: Store, storeKey: string): Promise<SubRow | undefined> {
  const [row] = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.projectId, projectId), eq(subscriptions.store, store), eq(subscriptions.storeKey, storeKey))).limit(1);
  return row;
}

export async function nonSubRowOf(db: DB, projectId: string, store: Store, storeTransactionId: string): Promise<NonSubRow | undefined> {
  const [row] = await db.select().from(nonSubscriptions)
    .where(and(eq(nonSubscriptions.projectId, projectId), eq(nonSubscriptions.store, store), eq(nonSubscriptions.storeTransactionId, storeTransactionId))).limit(1);
  return row;
}

/** An app user id of a customer, preferring a non-anonymous one (what webhooks report). */
export async function appUserIdOf(db: DB, customerId: string): Promise<string | null> {
  const rows = await db.select({ a: customerAliases.appUserId }).from(customerAliases).where(eq(customerAliases.customerId, customerId));
  return rows.find((r) => !isAnonymous(r.a))?.a ?? rows[0]?.a ?? null;
}

export function subRowToVerified(row: SubRow): VerifiedSubscription {
  return {
    kind: "subscription", store: row.store as Store, storeKey: row.storeKey, productIdentifier: row.productIdentifier,
    productPlanIdentifier: row.productPlanIdentifier, isSandbox: row.isSandbox, purchaseDate: row.purchaseDate,
    originalPurchaseDate: row.originalPurchaseDate, expiresDate: row.expiresDate, periodType: row.periodType as VerifiedSubscription["periodType"],
    unsubscribeDetectedAt: row.unsubscribeDetectedAt, billingIssuesDetectedAt: row.billingIssuesDetectedAt,
    gracePeriodExpiresDate: row.gracePeriodExpiresDate, refundedAt: row.refundedAt, autoResumeDate: row.autoResumeDate,
    storeTransactionId: row.storeTransactionId ?? row.storeKey, originalTransactionId: row.originalTransactionId,
    price: rowPrice(row), countryCode: row.countryCode, autoRenewProductId: row.autoRenewProductId,
  };
}

export function nonSubRowToVerified(row: NonSubRow): VerifiedOneTime {
  return {
    kind: "non_subscription", store: row.store as Store, productIdentifier: row.productIdentifier, storeTransactionId: row.storeTransactionId,
    isSandbox: row.isSandbox, isConsumable: row.isConsumable, purchaseDate: row.purchaseDate, refundedAt: row.refundedAt,
    price: rowPrice(row), countryCode: row.countryCode,
  };
}

/**
 * A store snapshot re-read for a notification, merged with the stored chain so re-reading the same state records no new
 * events: the same period keeps its start, type and price (a stored zero for a paid period is a placeholder the paid
 * amount replaces); an access end already in the past stays where it was (a paused or cancelled chain whose end is
 * derived from "now" would otherwise move forward on every read, a false SUBSCRIPTION_EXTENDED); a renewal without a
 * price costs what the last period cost; the first time a billing issue or cancellation was seen wins.
 */
export function mergeSnapshot(next: VerifiedSubscription, row: SubRow, now: Date): VerifiedSubscription {
  const out = { ...next };
  const stored = rowPrice(row);
  if (row.storeTransactionId === next.storeTransactionId) {
    out.purchaseDate = row.purchaseDate;
    out.periodType = row.periodType as VerifiedSubscription["periodType"];
    const placeholder = stored?.amount === 0 && !!next.price && next.price.amount > 0 && row.periodType !== "trial" && next.periodType !== "trial";
    out.price = placeholder ? next.price : stored ?? next.price;
    if (row.expiresDate && next.expiresDate && row.expiresDate <= now && next.expiresDate > row.expiresDate && next.expiresDate <= now) {
      out.expiresDate = row.expiresDate;
    }
    if (row.refundedAt && !next.refundedAt) {
      // A refunded period stays refunded, and its access stays ended, however often the store state is re-read.
      out.refundedAt = row.refundedAt;
      if (out.expiresDate && out.expiresDate > row.refundedAt) out.expiresDate = row.refundedAt;
    }
  } else if (!next.price && stored && stored.amount > 0 && next.periodType !== "trial") {
    out.price = stored;
  }
  if (row.billingIssuesDetectedAt && next.billingIssuesDetectedAt) out.billingIssuesDetectedAt = row.billingIssuesDetectedAt;
  if (row.unsubscribeDetectedAt && next.unsubscribeDetectedAt) out.unsubscribeDetectedAt = row.unsubscribeDetectedAt;
  return out;
}

/** Stores whose receipt re-posts are merged with the stored chain (their receipts carry no refund or first-seen history). */
const MERGED_ON_RECEIPT = new Set<string>(["amazon", "stripe", "paddle", "roku", "galaxy"]);

/**
 * Receipt posts for Amazon, Stripe, Paddle, Roku and the Galaxy Store: a purchase posted again keeps what notifications recorded. Without this a
 * re-post after a refund would clear the refund (a false REFUND_REVERSED), and every post would move the first time a
 * billing issue or cancellation was seen. Other stores are returned unchanged.
 */
export async function mergeStoredState<T extends VerifiedOneTime | VerifiedSubscription>(db: DB, projectId: string, purchases: T[], now: Date): Promise<T[]> {
  const out: T[] = [];
  for (const p of purchases) {
    if (!MERGED_ON_RECEIPT.has(p.store)) { out.push(p); continue; }
    if (p.kind === "subscription") {
      const row = await subRowOf(db, projectId, p.store, p.storeKey);
      out.push((row ? mergeSnapshot(p, row, now) : p) as T);
    } else {
      const row = await nonSubRowOf(db, projectId, p.store, p.storeTransactionId);
      out.push((row ? { ...p, refundedAt: p.refundedAt ?? row.refundedAt, price: p.price ?? rowPrice(row) } : p) as T);
    }
  }
  return out;
}
