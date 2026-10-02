import type { DB } from "@revenuedot/db";
import type { AppRecord } from "../../context.js";
import { productInfo } from "../../repo/catalog.js";
import { applyFromStore } from "../../services/purchases.js";
import { appUserIdOf, mergeSnapshot, nonSubRowOf, rowPrice, subRowOf } from "../rows.js";
import type { RokuClient } from "./api.js";
import { purchasesForTransaction } from "./index.js";
import type { RokuPushMessage } from "./push.js";

export interface SyncCtx { db: DB; app: AppRecord; client: RokuClient; now: Date }
export interface SyncResult { status: "processed" | "unknown_purchase" | "ignored"; sandbox?: boolean }

const track = (app: AppRecord) => app.credentials?.track_new_purchases === true;
const minDate = (a: Date, b: Date) => (a < b ? a : b);

/**
 * Pushes that change nothing RevenueDot records: credits, chargebacks (RevenueCat does not support Roku chargebacks) and the
 * start of a cancellation offer (the subscription is unchanged until the customer accepts or the offer ends).
 */
export const IGNORED_TYPES = new Set(["Credit", "Chargeback", "ChargebackReversed", "SecondChargeback", "CancellationOfferInitiated"]);

/**
 * One verified push. The transaction is validated with Roku again and applied as a store update, so the push only says
 * which transaction changed; a `Refund` also marks that transaction's period refunded.
 */
export async function handleRokuPush(ctx: SyncCtx, m: RokuPushMessage): Promise<SyncResult> {
  const { db, app, client, now } = ctx;
  if (IGNORED_TYPES.has(m.transactionType)) return { status: "ignored" };
  const t = await client.validate(app, m.transactionId);
  const catalog = await productInfo(db, app.id);
  const purchases = await purchasesForTransaction(client, app, t, { catalog, now, sandbox: false, posted: null });
  if (!purchases.length) return { status: "ignored" };
  const refund = m.transactionType === "Refund";
  const refundAt = minDate(m.eventDate ? new Date(m.eventDate) : now, now);
  let applied = false, sandbox = false;
  // An upgrade belongs to whoever owns the plan it replaced, also when Roku's push comes before the app posts it.
  let ownerHint: string | null = null, inherited = false;
  for (const p of purchases.slice(1)) {
    const row = p.kind === "subscription" ? await subRowOf(db, app.projectId, "roku", p.storeKey) : undefined;
    if (row) { ownerHint = await appUserIdOf(db, row.customerId); inherited = row.isSandbox; break; }
  }
  for (let p of purchases) {
    if (p.kind === "subscription") {
      const row = await subRowOf(db, app.projectId, "roku", p.storeKey);
      // Sandbox is what the receipt post said (X-Is-Sandbox); a purchase first seen here is production.
      p.isSandbox = row?.isSandbox ?? inherited;
      if (row) p = mergeSnapshot(p, row, now);
      if (refund && p.storeTransactionId === m.transactionId) {
        p.refundedAt = row?.refundedAt ?? (Number.isNaN(refundAt.getTime()) ? now : refundAt);
        if (p.expiresDate && p.expiresDate > p.refundedAt) p.expiresDate = p.refundedAt;
        p.gracePeriodExpiresDate = null;
      }
    } else {
      const row = await nonSubRowOf(db, app.projectId, "roku", p.storeTransactionId);
      p.isSandbox = row?.isSandbox ?? false;
      if (row) { p.purchaseDate = row.purchaseDate; p.price = rowPrice(row) ?? p.price; p.refundedAt = row.refundedAt ?? p.refundedAt; }
      if (refund && p.storeTransactionId === m.transactionId) p.refundedAt ??= Number.isNaN(refundAt.getTime()) ? now : refundAt;
    }
    sandbox ||= p.isSandbox;
    applied = (await applyFromStore(db, { projectId: app.projectId, appId: app.id, purchase: p, now, createIfUnknown: track(app) || !!ownerHint, appUserIdHint: ownerHint })) || applied;
  }
  return { status: applied ? "processed" : "unknown_purchase", sandbox };
}
