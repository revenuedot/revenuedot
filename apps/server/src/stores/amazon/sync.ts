import type { DB } from "@revenuedot/db";
import type { AppRecord } from "../../context.js";
import { productInfo } from "../../repo/catalog.js";
import { applyFromStore } from "../../services/purchases.js";
import { appUserIdOf, mergeSnapshot, nonSubRowOf, nonSubRowToVerified, rowPrice, subRowOf, subRowToVerified } from "../rows.js";
import { AmazonApiError, type AmazonReceipt, type AmazonRvsClient } from "./api.js";
import { mapReceipt } from "./map.js";

/** Amazon Real-time Notification (the JSON inside the SNS message). */
export interface AmazonNotification {
  appPackageName?: string;
  notificationType?: string;
  appUserId?: string;
  receiptId?: string;
  relatedReceipts?: Record<string, string> | null;
  timestamp?: number;
  betaProductTransaction?: boolean;
  /** Older payloads. */
  betaProduct?: boolean;
}

export interface SyncCtx { db: DB; app: AppRecord; client: AmazonRvsClient; now: Date; eventTime: Date }
export interface SyncResult { status: "processed" | "unknown_purchase" | "ignored"; sandbox?: boolean }

const minDate = (a: Date, b: Date) => (a < b ? a : b);
const createIfUnknown = (app: AppRecord) => app.credentials?.track_new_purchases === true;

/**
 * Applies one notification: the receipt is re-read from RVS with the notification's Amazon user id (RVS is the source of
 * truth; the notification type only fills what RVS cannot say, like a one-time refund before RVS shows the cancel date).
 */
export async function syncAmazonNotification(ctx: SyncCtx, n: AmazonNotification): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const receiptId = n.receiptId, userId = n.appUserId, type = n.notificationType ?? "";
  if (!receiptId || !userId) return { status: "ignored" };
  const at = minDate(ctx.eventTime, now);
  const track = createIfUnknown(app);

  let receipt: AmazonReceipt | null = null;
  let sandbox = false;
  try {
    ({ receipt, sandbox } = await client.verify(app, userId, receiptId));
  } catch (e) {
    if (!(e instanceof AmazonApiError && e.kind === "cancelled")) throw e;
  }

  if (!receipt) {
    // RVS 410: Amazon cancelled the receipt. A one-time purchase is refunded; a subscription's access ends now.
    const one = await nonSubRowOf(db, app.projectId, "amazon", receiptId);
    if (one) {
      const v = nonSubRowToVerified(one);
      v.refundedAt = one.refundedAt ?? at;
      await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: v, now });
      return { status: "processed", sandbox: one.isSandbox };
    }
    const sub = await subRowOf(db, app.projectId, "amazon", receiptId);
    if (!sub) return { status: "unknown_purchase" };
    const v = subRowToVerified(sub);
    v.unsubscribeDetectedAt = sub.unsubscribeDetectedAt ?? at;
    v.gracePeriodExpiresDate = null;
    if (!v.expiresDate || v.expiresDate > at) v.expiresDate = at;
    await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: v, now });
    return { status: "processed", sandbox: sub.isSandbox };
  }

  const catalog = await productInfo(db, app.id);
  const p = mapReceipt({ ...receipt, receiptId }, { catalog, now, sandbox: sandbox || n.betaProductTransaction === true || n.betaProduct === true });
  if (p.kind === "non_subscription") {
    const row = await nonSubRowOf(db, app.projectId, "amazon", receiptId);
    if (/_CANCELLED$/.test(type) && !p.refundedAt) p.refundedAt = at;
    if (row) {
      p.price = rowPrice(row) ?? p.price;
      p.purchaseDate = row.purchaseDate;
      if (row.refundedAt && p.refundedAt) p.refundedAt = row.refundedAt;
    }
    const applied = await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: track });
    return { status: applied ? "processed" : "unknown_purchase", sandbox: p.isSandbox };
  }

  const row = await subRowOf(db, app.projectId, "amazon", receiptId);
  let v = row ? mergeSnapshot(p, row) : p;
  let hint: string | null = null;
  // An immediate tier change: Amazon issues a new receipt and names the one it cancelled. The old chain ends now with
  // PRODUCT_CHANGE, and the new receipt belongs to the same customer.
  const replaced = type === "SUBSCRIPTION_MODIFIED_IMMEDIATE" ? n.relatedReceipts?.cancelledReceiptId ?? null : null;
  if (replaced && replaced !== receiptId) {
    const old = await subRowOf(db, app.projectId, "amazon", replaced);
    if (old) {
      v = { ...v, replacesStoreKey: replaced, replacedExpiresDate: at };
      if (!row) hint = await appUserIdOf(db, old.customerId);
    }
  }
  const applied = await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: v, now, createIfUnknown: track, appUserIdHint: hint });
  return { status: applied ? "processed" : "unknown_purchase", sandbox: v.isSandbox };
}
