import type { DB } from "@revenuedot/db";
import type { AppRecord } from "../../context.js";
import { productInfo } from "../../repo/catalog.js";
import { applyFromStore } from "../../services/purchases.js";
import { mergeSnapshot, nonSubRowOf, nonSubRowToVerified, rowPrice, subRowOf } from "../rows.js";
import { idOf, type StripeCharge, type StripeCheckoutSession, type StripeClient, type StripeEvent, type StripeInvoice } from "./api.js";
import { registerOnOf } from "./index.js";
import { invoiceSubscriptionId, mapCheckoutOneTime, mapSubscription, StripeNotYetPaid } from "./map.js";

export interface SyncCtx { db: DB; app: AppRecord; client: StripeClient; now: Date; eventTime: Date }
export interface SyncResult { status: "processed" | "unknown_purchase" | "ignored"; sandbox?: boolean }

const sec = (s: number | null | undefined) => (typeof s === "number" ? new Date(s * 1000) : null);
const minDate = (a: Date, b: Date) => (a < b ? a : b);
const track = (app: AppRecord) => app.credentials?.track_new_purchases === true;

/**
 * Which app user id a purchase first seen in a webhook belongs to (only with "track new purchases"):
 * a metadata key (default `app_user_id`), the Stripe customer id, or an anonymous id (null here).
 */
export function appUserIdFor(app: AppRecord, metadata: Record<string, string> | null | undefined, customer: string | null): string | null {
  const cr = app.credentials ?? {};
  const source = cr.app_user_id_source === "customer_id" || cr.app_user_id_source === "anonymous" ? cr.app_user_id_source : "metadata";
  if (source === "anonymous") return null;
  if (source === "customer_id") return customer;
  const key = typeof cr.app_user_id_metadata_key === "string" && cr.app_user_id_metadata_key.trim() ? cr.app_user_id_metadata_key.trim() : "app_user_id";
  const v = metadata?.[key];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null;
}

/** Re-reads a subscription from Stripe and applies it. `refund` marks the period paid by that invoice refunded. */
export async function syncSubscription(ctx: SyncCtx, subId: string, opts: { metadata?: Record<string, string> | null; refund?: { invoiceId: string; at: Date } } = {}): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const row = await subRowOf(db, app.projectId, "stripe", subId);
  const sub = await client.subscription(app, subId);
  const catalog = await productInfo(db, app.id);
  let p;
  try {
    p = mapSubscription(sub, { catalog, now, registerOn: registerOnOf(app), stored: row ? { storeTransactionId: row.storeTransactionId, purchaseDate: row.purchaseDate, price: rowPrice(row) } : null });
  } catch (e) {
    if (e instanceof StripeNotYetPaid) return { status: "ignored", sandbox: !sub.livemode };
    throw e;
  }
  if (row) p = mergeSnapshot(p, row, now);
  if (opts.refund && opts.refund.invoiceId === p.storeTransactionId) {
    p.refundedAt = row?.refundedAt ?? opts.refund.at;
    if (p.expiresDate) p.expiresDate = minDate(p.expiresDate, p.refundedAt);
    p.gracePeriodExpiresDate = null;
  }
  const meta = { ...(opts.metadata ?? {}), ...(sub.metadata ?? {}) };
  // A subscription from RevenueDot's hosted checkout names its app user id itself and is always tracked (prd/web-billing/PRD.md §2).
  const web = typeof meta.rd_app_user_id === "string" && meta.rd_app_user_id ? meta.rd_app_user_id.slice(0, 100) : null;
  const hint = !row && (web || track(app)) ? web ?? appUserIdFor(app, meta, idOf(sub.customer)) : null;
  const applied = await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: track(app) || !!web, appUserIdHint: hint });
  return { status: applied ? "processed" : "unknown_purchase", sandbox: p.isSandbox };
}

/** A completed Checkout Session: its subscription, or its one-time purchases. */
export async function syncCheckoutSession(ctx: SyncCtx, sessionId: string): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const s: StripeCheckoutSession = await client.checkoutSession(app, sessionId);
  if (s.status !== "complete") return { status: "ignored", sandbox: !s.livemode };
  if (s.mode === "subscription") {
    const subId = idOf(s.subscription as { id: string } | string | null);
    return subId ? syncSubscription(ctx, subId, { metadata: s.metadata }) : { status: "ignored" };
  }
  if (s.mode !== "payment" || (s.payment_status !== "paid" && s.payment_status !== "no_payment_required")) return { status: "ignored", sandbox: !s.livemode };
  const catalog = await productInfo(db, app.id);
  const hint = track(app) ? appUserIdFor(app, s.metadata, idOf(s.customer ?? null) ?? null) : null;
  let applied = false;
  for (const p of mapCheckoutOneTime(s, { catalog, now })) {
    const row = await nonSubRowOf(db, app.projectId, "stripe", p.storeTransactionId);
    if (row) { p.purchaseDate = row.purchaseDate; p.price = rowPrice(row) ?? p.price; p.refundedAt = row.refundedAt; }
    applied = (await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: track(app), appUserIdHint: hint })) || applied;
  }
  return { status: applied ? "processed" : "unknown_purchase", sandbox: !s.livemode };
}

/**
 * charge.refunded: a full refund. The refunded invoice's period of a subscription, or a one-time Checkout purchase
 * (keyed by its PaymentIntent). Partial refunds leave the purchase in place.
 */
export async function applyRefund(ctx: SyncCtx, charge: StripeCharge): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  if (!charge.refunded && charge.amount_refunded < charge.amount) return { status: "ignored", sandbox: charge.livemode === false };
  const at = minDate(sec(charge.refunds?.data?.[0]?.created) ?? ctx.eventTime, now);
  const pi = idOf(charge.payment_intent ?? null);
  const invoiceId = idOf(charge.invoice ?? null) ?? (pi ? await client.invoiceForPaymentIntent(app, pi) : null);
  if (invoiceId) {
    const inv: StripeInvoice = await client.invoice(app, invoiceId);
    const subId = invoiceSubscriptionId(inv);
    if (subId) return syncSubscription(ctx, subId, { refund: { invoiceId, at } });
  }
  if (!pi) return { status: "ignored" };
  const row = await nonSubRowOf(db, app.projectId, "stripe", pi);
  if (!row) return { status: "unknown_purchase" };
  const v = nonSubRowToVerified(row);
  v.refundedAt = row.refundedAt ?? at;
  await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: v, now });
  return { status: "processed", sandbox: row.isSandbox };
}

export const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused",
  "customer.subscription.resumed", "customer.subscription.trial_will_end", "customer.subscription.pending_update_applied", "customer.subscription.pending_update_expired",
]);
export const INVOICE_EVENTS = new Set(["invoice.updated", "invoice.paid", "invoice.payment_succeeded", "invoice.payment_failed", "invoice.marked_uncollectible", "invoice.voided"]);

/** One verified Stripe event. Everything about a subscription is re-read from Stripe, so event order does not matter. */
export async function handleStripeEvent(ctx: SyncCtx, e: StripeEvent): Promise<SyncResult> {
  const o = e.data?.object ?? {};
  if (SUBSCRIPTION_EVENTS.has(e.type)) return typeof o.id === "string" ? syncSubscription(ctx, o.id) : { status: "ignored" };
  if (INVOICE_EVENTS.has(e.type)) {
    const subId = invoiceSubscriptionId(o as StripeInvoice);
    return subId ? syncSubscription(ctx, subId) : { status: "ignored", sandbox: e.livemode === false };
  }
  if (e.type === "checkout.session.completed" || e.type === "checkout.session.async_payment_succeeded") return typeof o.id === "string" ? syncCheckoutSession(ctx, o.id) : { status: "ignored" };
  if (e.type === "charge.refunded") return applyRefund(ctx, o as StripeCharge);
  return { status: "ignored", sandbox: e.livemode === false };
}
