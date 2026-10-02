import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { notMoving } from "../../services/archive/moving.js";
import type { AppRecord } from "../../context.js";
import type { StoreAdapter } from "../types.js";
import { hasServiceAccount, type GooglePlayClient } from "./api.js";
import { googleClientFor } from "./index.js";
import { applyVoided } from "./sync.js";
import { credentialFailureOf, recordCredentialFailure } from "../../services/credential-health.js";

const { apps, subscriptions, nonSubscriptions } = schema;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Refunds, chargebacks and revocations Google never notified us about: `purchases.voidedpurchases.list` (type 1, so
 * subscriptions are included) since the last scan, at most Google's 30-day window. Each voided purchase we know and have not
 * recorded yet is applied like a voidedPurchaseNotification: CANCELLATION with cancel_reason CUSTOMER_SUPPORT, a negative
 * price, and access ending at the void time. Voided earlier periods of a subscription are left alone, as RevenueCat reports
 * only refunds of the latest period.
 */
export async function scanVoidedPurchases(db: DB, app: AppRecord, client: GooglePlayClient, now: Date): Promise<{ voided: number; applied: number }> {
  const floor = new Date(now.getTime() - 30 * DAY + HOUR);
  const last = app.voidedPurchasesCheckedAt ? new Date(app.voidedPurchasesCheckedAt.getTime() - HOUR) : floor;
  const list = await client.listVoidedPurchases(app, { startTime: last > floor ? last : floor, endTime: now, type: 1 });
  let applied = 0;
  for (const v of list) {
    if (!v.purchaseToken) continue;
    const eventTime = v.voidedTimeMillis ? new Date(Number(v.voidedTimeMillis)) : now;
    const ctx = { db, app, client, now, eventTime: Number.isNaN(eventTime.getTime()) ? now : eventTime };
    const [sub] = await db.select().from(subscriptions)
      .where(and(eq(subscriptions.projectId, app.projectId), eq(subscriptions.store, "play_store"), eq(subscriptions.storeKey, v.purchaseToken))).limit(1);
    if (sub) {
      if (sub.refundedAt || (v.orderId && sub.storeTransactionId && v.orderId !== sub.storeTransactionId)) continue;
      const r = await applyVoided(ctx, { purchaseToken: v.purchaseToken, orderId: v.orderId, productType: 1, refundType: v.refundType });
      if (r.status === "processed") applied++;
      continue;
    }
    const ids = [v.orderId, v.purchaseToken].filter((x): x is string => !!x);
    const [one] = await db.select().from(nonSubscriptions)
      .where(and(eq(nonSubscriptions.projectId, app.projectId), eq(nonSubscriptions.store, "play_store"), inArray(nonSubscriptions.storeTransactionId, ids))).limit(1);
    if (!one || one.refundedAt) continue;
    const r = await applyVoided(ctx, { purchaseToken: one.storeTransactionId, orderId: v.orderId, productType: 2, refundType: v.refundType });
    if (r.status === "processed") applied++;
  }
  await db.update(apps).set({ voidedPurchasesCheckedAt: now }).where(eq(apps.id, app.id));
  return { voided: list.length, applied };
}

/** The daily scan for every Google Play app with a service account whose last scan is a day old. A failed scan retries in an hour. */
export async function scanDueVoidedPurchases(db: DB, now: Date, stores: Record<string, StoreAdapter>, fetchImpl?: typeof fetch) {
  const due = await db.select().from(apps).where(and(eq(apps.type, "play_store"), notMoving(apps.projectId),
    or(isNull(apps.voidedPurchasesCheckedAt), lte(apps.voidedPurchasesCheckedAt, new Date(now.getTime() - DAY)))));
  let applied = 0;
  for (const app of due) {
    if (!app.bundleId || !hasServiceAccount(app)) continue;
    const { client } = googleClientFor(stores, fetchImpl);
    try {
      applied += (await scanVoidedPurchases(db, app, client, now)).applied;
    } catch (e) {
      console.warn(`Google voided purchases scan failed for ${app.id}: ${e instanceof Error ? e.message : e}`);
      const why = credentialFailureOf(e);
      if (why) await recordCredentialFailure(db, app.id, why, now);
      await db.update(apps).set({ voidedPurchasesCheckedAt: new Date(now.getTime() - DAY + HOUR) }).where(eq(apps.id, app.id));
    }
  }
  return applied;
}
