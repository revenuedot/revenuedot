import type { DB } from "@revenuedot/db";
import type { AppRecord } from "../../context.js";
import { productInfo } from "../../repo/catalog.js";
import { applyFromStore } from "../../services/purchases.js";
import { mergeSnapshot, nonSubRowOf, nonSubRowToVerified, rowPrice, subRowOf } from "../rows.js";
import { paddleEnvOf, type PaddleAdjustment, type PaddleClient, type PaddleEvent, type PaddleTransaction } from "./api.js";
import { mapRead, readSubscription } from "./index.js";
import { mapOneTime, PaddleNotYetPaid } from "./map.js";

export interface SyncCtx { db: DB; app: AppRecord; client: PaddleClient; now: Date; eventTime: Date }
export interface SyncResult { status: "processed" | "unknown_purchase" | "ignored"; sandbox?: boolean }

const track = (app: AppRecord) => app.credentials?.track_new_purchases === true;
const minDate = (a: Date, b: Date) => (a < b ? a : b);

/**
 * Which app user id a purchase first seen in a notification belongs to (only with "track new purchases"): a key of the
 * subscription's or transaction's `custom_data` (RevenueCat's "Metadata field key", default `app_user_id`), else anonymous.
 */
export function appUserIdFor(app: AppRecord, customData: Record<string, unknown> | null | undefined): string | null {
  const cr = app.credentials ?? {};
  if (cr.app_user_id_source === "anonymous") return null;
  const key = typeof cr.app_user_id_custom_data_key === "string" && cr.app_user_id_custom_data_key.trim() ? cr.app_user_id_custom_data_key.trim() : "app_user_id";
  const v = customData?.[key];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : typeof v === "number" ? String(v) : null;
}

/** A refund applies to the period it paid for: `refund` marks it, `reverse` takes a refund back. */
interface RefundOpt { transactionId: string; at: Date | null }

/** Re-reads a subscription from Paddle and applies it. `refund` marks the period paid by that transaction refunded (null `at`: reversed). */
export async function syncSubscription(ctx: SyncCtx, subId: string, opts: { customData?: Record<string, unknown> | null; refund?: RefundOpt } = {}): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const row = await subRowOf(db, app.projectId, "paddle", subId);
  const r = await readSubscription(client, app, subId);
  const catalog = await productInfo(db, app.id);
  let p;
  try {
    p = mapRead(app, r, { catalog, now, stored: row ? { storeTransactionId: row.storeTransactionId, purchaseDate: row.purchaseDate, price: rowPrice(row), expiresDate: row.expiresDate } : null });
  } catch (e) {
    if (e instanceof PaddleNotYetPaid) return { status: "ignored", sandbox: paddleEnvOf(app) === "sandbox" };
    throw e;
  }
  const freshExpires = p.expiresDate;
  if (row) p = mergeSnapshot(p, row, now);
  if (opts.refund && opts.refund.transactionId === p.storeTransactionId) {
    if (opts.refund.at) {
      p.refundedAt = row?.refundedAt ?? opts.refund.at;
      if (p.expiresDate) p.expiresDate = minDate(p.expiresDate, p.refundedAt);
      p.gracePeriodExpiresDate = null;
    } else {
      // A chargeback reversed: the refund is taken back and access returns to the period's end.
      p.refundedAt = null;
      p.expiresDate = freshExpires;
    }
  }
  const custom = { ...(opts.customData ?? {}), ...(r.paid?.custom_data ?? {}), ...(r.sub.custom_data ?? {}) };
  const hint = !row && track(app) ? appUserIdFor(app, custom) : null;
  const applied = await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: track(app), appUserIdHint: hint });
  return { status: applied ? "processed" : "unknown_purchase", sandbox: p.isSandbox };
}

/** A paid transaction without a subscription: its one-time purchases. */
export async function syncOneTime(ctx: SyncCtx, t: PaddleTransaction): Promise<SyncResult> {
  const { db, app, now } = ctx;
  const sandbox = paddleEnvOf(app) === "sandbox";
  if (t.status !== "completed" && t.status !== "paid") return { status: "ignored", sandbox };
  const catalog = await productInfo(db, app.id);
  const hint = track(app) ? appUserIdFor(app, t.custom_data) : null;
  let applied = false;
  for (const p of mapOneTime(t, { catalog, now, sandbox })) {
    const row = await nonSubRowOf(db, app.projectId, "paddle", p.storeTransactionId);
    if (row) { p.purchaseDate = row.purchaseDate; p.price = rowPrice(row) ?? p.price; p.refundedAt = row.refundedAt; }
    applied = (await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: track(app), appUserIdHint: hint })) || applied;
  }
  return { status: applied ? "processed" : "unknown_purchase", sandbox };
}

/**
 * An adjustment: an approved full refund or chargeback marks the transaction refunded, an approved chargeback reversal
 * takes it back. Pending, rejected, partial and credit adjustments change nothing (a partial refund leaves the purchase).
 */
export async function applyAdjustment(ctx: SyncCtx, a: PaddleAdjustment): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const sandbox = paddleEnvOf(app) === "sandbox";
  if (a.status !== "approved") return { status: "ignored", sandbox };
  const reverse = a.action === "chargeback_reverse";
  if (!reverse && !((a.action === "refund" || a.action === "chargeback") && a.type !== "partial")) return { status: "ignored", sandbox };
  const at = reverse ? null : minDate(new Date(a.updated_at ?? a.created_at), now);
  if (a.subscription_id) return syncSubscription(ctx, a.subscription_id, { refund: { transactionId: a.transaction_id, at } });
  // One-time purchases: the transaction id (and `{txn}:{n}` for further items).
  const t = await client.transaction(app, a.transaction_id);
  let applied = false;
  for (let i = 0; i < Math.max(1, t.items?.length ?? 1); i++) {
    const row = await nonSubRowOf(db, app.projectId, "paddle", i === 0 ? t.id : `${t.id}:${i}`);
    if (!row) continue;
    const v = nonSubRowToVerified(row);
    v.refundedAt = reverse ? null : row.refundedAt ?? at;
    await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: v, now });
    applied = true;
  }
  return { status: applied ? "processed" : "unknown_purchase", sandbox };
}

export const SUBSCRIPTION_EVENTS = new Set([
  "subscription.created", "subscription.activated", "subscription.trialing", "subscription.updated", "subscription.past_due",
  "subscription.paused", "subscription.resumed", "subscription.canceled", "subscription.imported",
]);
export const TRANSACTION_EVENTS = new Set(["transaction.completed", "transaction.paid", "transaction.past_due", "transaction.payment_failed", "transaction.billed", "transaction.updated"]);
/** What Apply in Paddle subscribes the destination to. */
export const PADDLE_EVENTS = [...SUBSCRIPTION_EVENTS, ...TRANSACTION_EVENTS, "adjustment.created", "adjustment.updated"];

/** One verified Paddle event. Subscriptions are re-read from Paddle, so delivery order does not matter. */
export async function handlePaddleEvent(ctx: SyncCtx, e: PaddleEvent): Promise<SyncResult> {
  const o = e.data ?? {};
  if (SUBSCRIPTION_EVENTS.has(e.event_type)) return typeof o.id === "string" ? syncSubscription(ctx, o.id, { customData: o.custom_data }) : { status: "ignored" };
  if (TRANSACTION_EVENTS.has(e.event_type)) {
    if (typeof o.subscription_id === "string") return syncSubscription(ctx, o.subscription_id, { customData: o.custom_data });
    if (typeof o.id !== "string") return { status: "ignored" };
    // The one-time transaction as Paddle has it now, not as the event body says.
    return syncOneTime(ctx, await ctx.client.transaction(ctx.app, o.id));
  }
  if (e.event_type === "adjustment.created" || e.event_type === "adjustment.updated") return applyAdjustment(ctx, o as PaddleAdjustment);
  return { status: "ignored" };
}
