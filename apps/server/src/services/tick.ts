import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { recordEvent } from "./events.js";
import { deliverDue } from "./webhooks.js";
import { subRowToDomain } from "../repo/customers.js";

const { subscriptions, customers, customerAliases } = schema;

/**
 * The one periodic job (every minute: Workers cron in the cloud, an interval in Node):
 * record EXPIRATION for subscriptions whose access has ended, then send due webhooks.
 */
export async function tick(db: DB, now: Date, fetchImpl: typeof fetch = fetch) {
  const expired = await db.select().from(subscriptions).where(and(
    isNull(subscriptions.expiredEventAt), isNotNull(subscriptions.expiresDate), lte(subscriptions.expiresDate, now),
    or(isNull(subscriptions.gracePeriodExpiresDate), lte(subscriptions.gracePeriodExpiresDate, now)),
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
        derived: { type: "EXPIRATION", expirationReason: s.billingIssuesDetectedAt ? "BILLING_ERROR" : s.store === "promotional" ? "UNSUBSCRIBE" : "UNSUBSCRIBE" },
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
  const sent = await deliverDue(db, fetchImpl, now);
  return { expired: expired.length, sent };
}
