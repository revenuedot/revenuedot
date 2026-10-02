import type { DB } from "@revenuedot/db";
import type { AppRecord } from "../../context.js";
import { productInfo } from "../../repo/catalog.js";
import { applyFromStore } from "../../services/purchases.js";
import { appUserIdOf, mergeSnapshot, nonSubRowOf, rowPrice, subRowOf } from "../rows.js";
import type { VerifiedPurchase, VerifiedSubscription } from "../types.js";
import type { GalaxyClient } from "./api.js";
import { purchaseForId } from "./index.js";
import type { GalaxyNotification } from "./isn.js";

export interface SyncCtx { db: DB; app: AppRecord; client: GalaxyClient; now: Date }
export interface SyncResult { status: "processed" | "unknown_purchase" | "ignored"; sandbox?: boolean }

const track = (app: AppRecord) => app.credentials?.track_new_purchases === true;
const minDate = (a: Date, b: Date) => (a < b ? a : b);
const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Applies one re-read purchase as a store update, keeping what earlier notifications recorded. */
async function apply(ctx: SyncCtx, p: VerifiedPurchase, o: { testPay: boolean; refundOrderId?: string | null; refundAt?: Date; refundItem?: boolean; ownerHint?: string | null }): Promise<boolean> {
  const { db, app, now } = ctx;
  if (o.testPay) p.isSandbox = true;
  if (p.kind === "subscription") {
    const row = await subRowOf(db, app.projectId, "galaxy", p.storeKey);
    if (row) p = mergeSnapshot(p, row, now);
    if (o.refundOrderId && o.refundOrderId === p.storeTransactionId) {
      p.refundedAt = row?.refundedAt ?? o.refundAt ?? now;
      if (p.expiresDate && p.expiresDate > p.refundedAt) p.expiresDate = p.refundedAt;
      p.gracePeriodExpiresDate = null;
    }
  } else {
    const row = await nonSubRowOf(db, app.projectId, "galaxy", p.storeTransactionId);
    if (row) { p.purchaseDate = row.purchaseDate; p.price = rowPrice(row) ?? p.price; p.refundedAt = p.refundedAt ?? row.refundedAt; }
    if (o.refundItem) p.refundedAt ??= o.refundAt ?? now;
  }
  // A plan change belongs to whoever owns the plan it replaced, also when its notification comes before the app posts it.
  return applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: track(app) || !!o.ownerHint, appUserIdHint: o.ownerHint ?? null });
}

/**
 * One Samsung server notification. The purchase it names is re-read from Samsung (receipt and subscription APIs), so the
 * body only says which purchase changed:
 *   ITEM_PURCHASED, ITEM_REFUNDED                   the item (`purchaseId`); a refund marks it refunded
 *   ARS_SUBSCRIBED, ARS_RESUBSCRIBED, ARS_RENEWED   the subscription by its newest purchase id
 *   ARS_UNSUBSCRIBED, ARS_IN_GRACE_PERIOD, ARS_OUT_GRACE_PERIOD, ARS_PRICECHANGE_AGREED, ARS_REFUNDED
 *                                                   the subscription by its first purchase id; a refund marks that order's period
 *   ARS_UPDOWNGRADED                                the new purchase, and the old chain renews into the new item
 *   TEST                                            proves the URL (counts as received); ORDER_HISTORY_DELETED is ignored
 */
export async function handleGalaxyNotification(ctx: SyncCtx, n: GalaxyNotification): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  const d = n.data ?? {};
  const testPay = d.testPayYn === "Y" || d.betaTestYn === "Y";
  if (n.event === "TEST") return { status: "processed", sandbox: true };
  if (n.event === "ORDER_HISTORY_DELETED") return { status: "ignored" };
  const catalog = await productInfo(db, app.id);
  const read = (id: string) => purchaseForId(client, app, id, { catalog, now });
  const done = (applied: boolean, p?: VerifiedPurchase): SyncResult => ({ status: applied ? "processed" : "unknown_purchase", sandbox: testPay || !!p?.isSandbox });

  switch (n.event) {
    case "ITEM_PURCHASED":
    case "ITEM_REFUNDED": {
      const id = s(d.purchaseId);
      if (!id) return { status: "ignored" };
      const p = await read(id);
      return done(await apply(ctx, p, { testPay, refundItem: n.event === "ITEM_REFUNDED" && p.kind === "non_subscription" }), p);
    }
    case "ARS_SUBSCRIBED":
    case "ARS_RESUBSCRIBED":
    case "ARS_RENEWED":
    case "ARS_OUT_GRACE_PERIOD":
    case "ARS_UNSUBSCRIBED":
    case "ARS_IN_GRACE_PERIOD":
    case "ARS_PRICECHANGE_AGREED":
    case "ARS_REFUNDED": {
      const id = s(d.renewedPurchaseId) ?? s(d.resubscribedPurchaseId) ?? s(d.purchaseId) ?? s(d.firstPurchaseId);
      if (!id) return { status: "ignored" };
      const p = await read(id);
      const refundAt = typeof d.refundedPurchaseDate === "number" ? new Date(d.refundedPurchaseDate * 1000) : now;
      return done(await apply(ctx, p, { testPay, ...(n.event === "ARS_REFUNDED" ? { refundOrderId: s(d.refundedOrderId), refundAt: minDate(refundAt, now) } : {}) }), p);
    }
    case "ARS_UPDOWNGRADED": {
      const newId = s(d.newPurchaseId), oldId = s(d.oldPurchaseId);
      if (!newId) return { status: "ignored" };
      const next = await read(newId);
      let applied = false;
      let ownerHint: string | null = null;
      if (oldId && next.kind === "subscription") {
        const old = await read(oldId);
        const oldRow = old.kind === "subscription" ? await subRowOf(db, app.projectId, "galaxy", old.storeKey) : undefined;
        ownerHint = oldRow ? await appUserIdOf(db, oldRow.customerId) : null;
        if (old.kind === "subscription" && old.storeKey !== next.storeKey) {
          // The old chain renews into the new item: now for an immediate change, at the scheduled renewal otherwise.
          const switchAt = typeof d.scheduledTimeOfRenewal === "number" && d.scheduledTimeOfRenewal * 1000 > now.getTime() ? new Date(d.scheduledTimeOfRenewal * 1000) : minDate(next.purchaseDate, now);
          const o: VerifiedSubscription = { ...old, autoRenewProductId: next.productIdentifier, unsubscribeDetectedAt: null, billingIssuesDetectedAt: null, gracePeriodExpiresDate: null };
          if (o.expiresDate) o.expiresDate = minDate(o.expiresDate, switchAt);
          applied = (await apply(ctx, o, { testPay })) || applied;
        }
      }
      applied = (await apply(ctx, next, { testPay, ownerHint })) || applied;
      return done(applied, next);
    }
    default:
      return { status: "ignored" };
  }
}

/** Re-reads one purchase from Samsung and applies it (after a store action); `refundOrderId` marks that period refunded. */
export async function syncGalaxyPurchase(ctx: SyncCtx, purchaseId: string, o: { refundOrderId?: string | null; refundAt?: Date } = {}): Promise<boolean> {
  const catalog = await productInfo(ctx.db, ctx.app.id);
  const p = await purchaseForId(ctx.client, ctx.app, purchaseId, { catalog, now: ctx.now });
  return apply(ctx, p, { testPay: false, refundOrderId: o.refundOrderId, refundAt: o.refundAt, refundItem: p.kind === "non_subscription" && !!o.refundOrderId });
}
