import { and, eq, inArray } from "drizzle-orm";
import { isAnonymous } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord } from "../../context.js";
import { productInfo } from "../../repo/catalog.js";
import { applyFromStore } from "../../services/purchases.js";
import type { VerifiedOneTime, VerifiedSubscription } from "../types.js";
import { GoogleApiError, type GooglePlayClient, type SubscriptionPurchaseV2 } from "./api.js";
import { acknowledgeProductIfNeeded, acknowledgeSubscriptionIfNeeded, replacedExpiry } from "./index.js";
import { mapProduct, mapSubscription, S } from "./map.js";

const { subscriptions, nonSubscriptions, customerAliases } = schema;
type SubRow = typeof subscriptions.$inferSelect;
type NonSubRow = typeof nonSubscriptions.$inferSelect;

/** Everything a notification needs: the app it was sent to, the Play client, and times. */
export interface SyncCtx { db: DB; app: AppRecord; client: GooglePlayClient; now: Date; eventTime: Date }

export interface SyncResult { status: "processed" | "unknown_purchase" | "ignored"; sandbox?: boolean }

const minDate = (a: Date, b: Date) => (a < b ? a : b);
const createIfUnknown = (app: AppRecord) => app.credentials?.track_new_purchases === true;
const rowPrice = (r: { priceAmount: number | null; priceCurrency: string | null }) =>
  r.priceAmount !== null && r.priceCurrency ? { amount: r.priceAmount, currency: r.priceCurrency } : null;

async function subRow(db: DB, projectId: string, token: string): Promise<SubRow | undefined> {
  const [row] = await db.select().from(subscriptions)
    .where(and(eq(subscriptions.projectId, projectId), eq(subscriptions.store, "play_store"), eq(subscriptions.storeKey, token))).limit(1);
  return row;
}

/** An app user id of a customer, preferring a non-anonymous one (what webhooks report). */
async function appUserIdOf(db: DB, customerId: string): Promise<string | null> {
  const rows = await db.select({ a: customerAliases.appUserId }).from(customerAliases).where(eq(customerAliases.customerId, customerId));
  return rows.find((r) => !isAnonymous(r.a))?.a ?? rows[0]?.a ?? null;
}

function rowToVerified(row: SubRow): VerifiedSubscription {
  return {
    kind: "subscription", store: "play_store", storeKey: row.storeKey, productIdentifier: row.productIdentifier,
    productPlanIdentifier: row.productPlanIdentifier, isSandbox: row.isSandbox, purchaseDate: row.purchaseDate,
    originalPurchaseDate: row.originalPurchaseDate, expiresDate: row.expiresDate, periodType: row.periodType as VerifiedSubscription["periodType"],
    unsubscribeDetectedAt: row.unsubscribeDetectedAt, billingIssuesDetectedAt: row.billingIssuesDetectedAt,
    gracePeriodExpiresDate: row.gracePeriodExpiresDate, refundedAt: row.refundedAt, autoResumeDate: row.autoResumeDate,
    storeTransactionId: row.storeTransactionId ?? row.storeKey, originalTransactionId: row.originalTransactionId,
    price: rowPrice(row), countryCode: row.countryCode, autoRenewProductId: row.autoRenewProductId,
  };
}

/**
 * Google's state is a snapshot; this keeps what the snapshot cannot tell us from the stored chain so that
 * re-reading the same state produces no new events: the period's start, type and price, when a billing issue or
 * cancellation was first seen, a refund, the pre-grace expiry, and a scheduled pause.
 */
export function mergeWithStored(next: VerifiedSubscription, row: SubRow, state: string | undefined, now: Date): VerifiedSubscription {
  const out = { ...next };
  const sameOrder = row.storeTransactionId === next.storeTransactionId;
  const stored = rowPrice(row);
  if (sameOrder) {
    out.purchaseDate = row.purchaseDate;
    out.periodType = row.periodType as VerifiedSubscription["periodType"];
    out.price = stored ?? next.price;
    if (row.refundedAt) out.refundedAt = row.refundedAt;
    // The paid period ended when grace began; keep that as the expiry and report the grace end separately.
    if (state === S.GRACE && row.expiresDate && next.expiresDate && row.expiresDate < next.expiresDate) out.expiresDate = row.expiresDate;
    if (!next.autoResumeDate && row.autoResumeDate && row.autoResumeDate > now && state === S.ACTIVE) out.autoResumeDate = row.autoResumeDate;
  } else if (!next.price && stored && stored.amount > 0 && next.periodType !== "trial") {
    out.price = stored; // renewals are assumed to cost what the last period cost
  }
  if (row.billingIssuesDetectedAt && (next.billingIssuesDetectedAt || state === S.EXPIRED)) out.billingIssuesDetectedAt = row.billingIssuesDetectedAt;
  if (row.unsubscribeDetectedAt && (next.unsubscribeDetectedAt || state === S.EXPIRED)) out.unsubscribeDetectedAt = row.unsubscribeDetectedAt;
  return out;
}

/**
 * Re-reads a subscription from Google and applies it. Used for every subscription notification.
 * `refundAt` marks the current period refunded (revocations, and voided purchases of the current order).
 */
export async function syncSubscription(ctx: SyncCtx, token: string, opts: { refundAt?: Date; voidedOrderId?: string | null; pauseScheduleFor?: string | null } = {}): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const row = await subRow(db, app.projectId, token);
  let sub: SubscriptionPurchaseV2 | null = null;
  try {
    sub = await client.getSubscriptionV2(app, token);
  } catch (e) {
    // A voided purchase can outlive its token (60 days after expiry): refund from what we stored.
    if (!(e instanceof GoogleApiError && e.kind === "invalid_token" && opts.refundAt && row)) throw e;
  }
  const state = sub?.subscriptionState;
  if (state === S.PENDING || state === S.PENDING_CANCELED) return { status: "ignored", sandbox: !!sub?.testPurchase };
  // The token an upgrade or downgrade replaced is updated when the new token is processed (PRODUCT_CHANGE), not here.
  if (sub?.canceledStateContext?.replacementCancellation && row && !opts.refundAt) return { status: "processed", sandbox: row.isSandbox };

  const catalog = await productInfo(db, app.id);
  let p = sub ? mapSubscription(sub, token, { catalog, now }) : rowToVerified(row!);
  if (sub && row) p = mergeWithStored(p, row, state, now);

  if (opts.pauseScheduleFor && sub && state === S.ACTIVE) {
    try {
      const v1 = await client.getSubscriptionV1(app, opts.pauseScheduleFor, token);
      p.autoResumeDate = v1.autoResumeTimeMillis ? new Date(Number(v1.autoResumeTimeMillis)) : null;
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.kind === "invalid_token")) throw e;
    }
  }
  if (opts.refundAt) {
    const isCurrentOrder = !opts.voidedOrderId || opts.voidedOrderId === p.storeTransactionId;
    if (isCurrentOrder) {
      p.refundedAt = row?.refundedAt ?? opts.refundAt;
      if (p.expiresDate) p.expiresDate = minDate(p.expiresDate, p.refundedAt);
    }
  }

  // A purchase that replaced another one belongs to the same customer; the old chain ends where Google says it did.
  let hint: string | null = null;
  const linked = sub?.linkedPurchaseToken ? await subRow(db, app.projectId, sub.linkedPurchaseToken) : undefined;
  if (!row && linked) hint = await appUserIdOf(db, linked.customerId);
  if (linked) p.replacedExpiresDate = await replacedExpiry(client, app, linked.storeKey);
  else p.replacesStoreKey = null;

  // A new order on a token whose access had ended is Google renewing it (recovery from account hold, resume from a
  // pause): RevenueCat reports RENEWAL, not a new purchase. Moving the stored end to now keeps the event a RENEWAL.
  const newOrder = !!row && row.storeTransactionId !== p.storeTransactionId && !!p.expiresDate && p.expiresDate > now;
  if (newOrder && row!.expiresDate && row!.expiresDate < now) {
    await db.update(subscriptions).set({ expiresDate: now }).where(eq(subscriptions.id, row!.id));
  }

  const applied = await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: createIfUnknown(app), appUserIdHint: hint });
  // The expiration worker records EXPIRATION once per row; a renewed period needs it again at its own end.
  if (newOrder) await db.update(subscriptions).set({ expiredEventAt: null }).where(eq(subscriptions.id, row!.id));
  if (sub && !(await acknowledgeSubscriptionIfNeeded(client, app, token, sub))) {
    throw new GoogleApiError("transient", "acknowledging the purchase failed; Pub/Sub will retry");
  }
  return { status: applied ? "processed" : "unknown_purchase", sandbox: p.isSandbox };
}

/** One-time product purchased (RTDN oneTimeProductNotification PURCHASED). */
export async function syncOneTime(ctx: SyncCtx, sku: string, token: string): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const purchase = await client.getProduct(app, sku, token);
  if (purchase.purchaseState === 2) return { status: "ignored", sandbox: purchase.purchaseType === 0 };
  const catalog = await productInfo(db, app.id);
  const v = mapProduct(purchase, sku, token, { catalog, now });
  const [row] = await db.select().from(nonSubscriptions).where(and(
    eq(nonSubscriptions.projectId, app.projectId), eq(nonSubscriptions.store, "play_store"), eq(nonSubscriptions.storeTransactionId, v.storeTransactionId))).limit(1);
  if (row) {
    v.price = rowPrice(row) ?? v.price;
    v.refundedAt = row.refundedAt ?? v.refundedAt;
    v.purchaseDate = row.purchaseDate;
  }
  const applied = await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: v, now, createIfUnknown: createIfUnknown(app) });
  if (!(await acknowledgeProductIfNeeded(client, app, sku, token, purchase, v.isConsumable))) {
    throw new GoogleApiError("transient", "acknowledging the purchase failed; Pub/Sub will retry");
  }
  return { status: applied ? "processed" : "unknown_purchase", sandbox: v.isSandbox };
}

function nonSubToVerified(row: NonSubRow): VerifiedOneTime {
  return {
    kind: "non_subscription", store: "play_store", productIdentifier: row.productIdentifier, storeTransactionId: row.storeTransactionId,
    isSandbox: row.isSandbox, isConsumable: row.isConsumable, purchaseDate: row.purchaseDate, refundedAt: row.refundedAt,
    price: rowPrice(row), countryCode: row.countryCode,
  };
}

/**
 * voidedPurchaseNotification: a refund, chargeback or revocation. productType 1 = subscription, 2 = one-time;
 * refundType 2 is a partial (quantity) refund, which leaves the purchase in place.
 */
export async function applyVoided(ctx: SyncCtx, n: { purchaseToken?: string; orderId?: string; productType?: number; refundType?: number }): Promise<SyncResult> {
  const { db, app, now } = ctx;
  const refundAt = minDate(ctx.eventTime, now);
  if (!n.purchaseToken) return { status: "ignored" };
  if (n.productType === 1) return syncSubscription(ctx, n.purchaseToken, { refundAt, voidedOrderId: n.orderId ?? null });
  if (n.refundType === 2) return { status: "ignored" };
  const ids = [n.orderId, n.purchaseToken].filter((x): x is string => !!x);
  const [row] = await db.select().from(nonSubscriptions).where(and(
    eq(nonSubscriptions.projectId, app.projectId), eq(nonSubscriptions.store, "play_store"), inArray(nonSubscriptions.storeTransactionId, ids))).limit(1);
  if (!row) return { status: "unknown_purchase" };
  const v = nonSubToVerified(row);
  v.refundedAt = row.refundedAt ?? refundAt;
  await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: v, now });
  return { status: "processed", sandbox: row.isSandbox };
}
