import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { expirationReasonOf } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { recordEvent } from "./events.js";
import { deliverDue } from "./webhooks.js";
import { subRowToDomain } from "../repo/customers.js";
import { scanDueVoidedPurchases } from "../stores/google/voided.js";
import type { StoreAdapter } from "../stores/types.js";

const { subscriptions, customers, customerAliases } = schema;

/**
 * The one periodic job (every minute: Workers cron in the cloud, an interval in Node):
 * record EXPIRATION for subscriptions whose access has ended, run the daily Google Play voided-purchases scan for apps
 * that are due, then send due webhooks. `stores` supplies the Play client (tests inject a fake Google).
 */
export async function tick(db: DB, now: Date, fetchImpl: typeof fetch = fetch, opts: { stores?: Record<string, StoreAdapter> } = {}) {
  const expired = await recordDueExpirations(db, now);
  const voided = await scanDueVoidedPurchases(db, now, opts.stores ?? {}, fetchImpl);
  const sent = await deliverDue(db, fetchImpl, now);
  return { expired, voided, sent };
}

/** EXPIRATION for every subscription whose access (including any grace period) has ended; optionally one chain only. */
export async function recordDueExpirations(db: DB, now: Date, only?: { projectId: string; store: string; storeKey: string }) {
  const expired = await db.select().from(subscriptions).where(and(
    isNull(subscriptions.expiredEventAt), isNotNull(subscriptions.expiresDate), lte(subscriptions.expiresDate, now),
    or(isNull(subscriptions.gracePeriodExpiresDate), lte(subscriptions.gracePeriodExpiresDate, now)),
    ...(only ? [eq(subscriptions.projectId, only.projectId), eq(subscriptions.store, only.store), eq(subscriptions.storeKey, only.storeKey)] : []),
  )).limit(500);
  for (const s of expired) {
    const [customer] = await db.select().from(customers).where(eq(customers.id, s.customerId));
    if (!customer) continue;
    const aliases = await db.select({ a: customerAliases.appUserId }).from(customerAliases).where(eq(customerAliases.customerId, customer.id));
    const appUserId = aliases.find((a) => !a.a.startsWith("$RCAnonymousID:"))?.a ?? customer.originalAppUserId;
    const d = subRowToDomain(s);
    if (!s.refundedAt) {
      await recordEvent(db, {
        projectId: s.projectId, appId: s.appId, customer, appUserId,
        derived: { type: "EXPIRATION", expirationReason: expirationReasonOf(d) },
        subject: {
          store: d.store, productId: d.productIdentifier, productPlanId: d.productPlanIdentifier, periodType: d.periodType,
          purchasedAt: d.purchaseDate, expiresAt: d.expiresDate, transactionId: d.storeTransactionId ?? null,
          originalTransactionId: d.originalTransactionId ?? s.storeKey, isSandbox: d.isSandbox, isFamilyShare: d.ownershipType === "FAMILY_SHARED",
          countryCode: s.countryCode, price: d.price, priceUsd: s.priceUsd,
        },
        now,
      });
    }
    await db.update(subscriptions).set({ expiredEventAt: now }).where(eq(subscriptions.id, s.id));
  }
  return expired.length;
}
