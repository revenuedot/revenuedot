import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { newId, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord, Deps } from "../../context.js";
import { RCError } from "../../errors.js";
import { applyFromStore } from "../../services/purchases.js";
import { adoptImportedChain } from "../../services/imported-chains.js";
import { handleConsumptionRequest, noteAppleRefund, noteRefundDeclined } from "../../services/refunds.js";
import type { AppRow } from "../types.js";
import { appleStoreOf, expectedBundleId, verifyRenewalJws, verifyTransactionJws, xcodeRootsOf } from "./index.js";
import { JwsError, verifyAppleJws } from "./jws.js";
import { fromTransaction, type AppleTransaction, type MapOptions } from "./map.js";

const { apps, storeNotifications, subscriptions, nonSubscriptions } = schema;

const FORWARD_TIMEOUT_MS = 10_000;

/** ResponseBodyV2DecodedPayload (the fields we use). */
interface NotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID?: string;
  signedDate?: number;
  data?: { appAppleId?: number; bundleId?: string; environment?: string; signedTransactionInfo?: string; signedRenewalInfo?: string; status?: number; consumptionRequestReason?: string };
  summary?: { bundleId?: string; environment?: string };
}

/** The payload cannot be trusted or does not belong to this app: 400, so it shows up as failed in App Store Connect. */
class NotificationError extends Error {}

/** Notification types whose signed transaction and renewal info describe a new state for the purchase. */
const STATE_CHANGES = new Set([
  "SUBSCRIBED", "DID_RENEW", "DID_FAIL_TO_RENEW", "GRACE_PERIOD_EXPIRED", "DID_CHANGE_RENEWAL_STATUS", "DID_CHANGE_RENEWAL_PREF",
  "EXPIRED", "REFUND", "REFUND_REVERSED", "REVOKE", "RENEWAL_EXTENDED", "OFFER_REDEEMED", "ONE_TIME_CHARGE", "PRICE_INCREASE",
]);

/** What the notification type itself tells us, for when the renewal info is missing or lags behind. */
function overrides(type: string, subtype?: string): Pick<MapOptions, "autoRenew" | "billingIssue" | "priceIncrease" | "cancelReason"> {
  switch (type) {
    case "DID_FAIL_TO_RENEW":
    case "GRACE_PERIOD_EXPIRED": return { billingIssue: true };
    case "DID_RENEW": return { billingIssue: false };
    case "DID_CHANGE_RENEWAL_STATUS":
      if (subtype === "AUTO_RENEW_DISABLED") return { autoRenew: false };
      if (subtype === "AUTO_RENEW_ENABLED") return { autoRenew: true };
      return {};
    case "EXPIRED":
      if (subtype === "BILLING_RETRY") return { billingIssue: true };
      if (subtype === "VOLUNTARY") return { autoRenew: false, billingIssue: false };
      if (subtype === "PRICE_INCREASE") return { autoRenew: false, billingIssue: false, cancelReason: "PRICE_INCREASE" };
      return {};
    case "PRICE_INCREASE":
      if (subtype === "PENDING") return { priceIncrease: "pending" };
      if (subtype === "ACCEPTED") return { priceIncrease: "accepted" };
      return {};
    default: return {};
  }
}

async function decode(raw: string, app: AppRow, now: Date): Promise<NotificationPayload> {
  let body: { signedPayload?: unknown };
  try { body = JSON.parse(raw); } catch { throw new NotificationError("The body is not JSON."); }
  if (typeof body?.signedPayload !== "string") throw new NotificationError("signedPayload is missing.");
  let n: NotificationPayload;
  try {
    n = await verifyAppleJws<NotificationPayload>(body.signedPayload, { xcodeRoots: xcodeRootsOf(app), now });
  } catch (e) {
    if (e instanceof JwsError) throw new NotificationError(`The signed payload is not valid: ${e.message}.`);
    throw e;
  }
  if (typeof n?.notificationType !== "string") throw new NotificationError("The signed payload is not an App Store notification.");
  const bundleId = n.data?.bundleId ?? n.summary?.bundleId;
  const expected = expectedBundleId(app);
  if (expected && bundleId && bundleId !== expected) throw new NotificationError(`The notification is for bundle id ${bundleId}, not ${expected}.`);
  const appAppleId = app.credentials?.app_apple_id;
  if (appAppleId && n.data?.environment === "Production" && n.data.appAppleId && String(n.data.appAppleId) !== String(appAppleId)) {
    throw new NotificationError(`The notification is for Apple app id ${n.data.appAppleId}, not ${appAppleId}.`);
  }
  return n;
}

async function existingFor(db: DB, projectId: string, store: Store, tx: AppleTransaction) {
  if (tx.type === "Auto-Renewable Subscription") {
    const [row] = await db.select().from(subscriptions)
      .where(and(eq(subscriptions.projectId, projectId), eq(subscriptions.store, store), eq(subscriptions.storeKey, tx.originalTransactionId))).limit(1);
    return row ? { kind: "subscription" as const, row } : null;
  }
  const [row] = await db.select().from(nonSubscriptions)
    .where(and(eq(nonSubscriptions.projectId, projectId), eq(nonSubscriptions.store, store), eq(nonSubscriptions.storeTransactionId, tx.transactionId))).limit(1);
  return row ? { kind: "non_subscription" as const, row } : null;
}

/**
 * Applies one verified notification. Returns true when it concerns a purchase we know (or just created),
 * which is what moves the app's "last received" time.
 */
async function processNotification(deps: Deps, app: AppRecord, n: NotificationPayload): Promise<boolean> {
  if (n.notificationType === "TEST" || n.summary) return true;
  const d = n.data;
  if (!d?.signedTransactionInfo) return false;
  const now = deps.now();
  const opts = { bundleId: expectedBundleId(app), xcodeRoots: xcodeRootsOf(app), now, source: "device" as const };
  let tx: AppleTransaction;
  let renewal = null;
  try {
    tx = await verifyTransactionJws(d.signedTransactionInfo, opts);
    if (d.signedRenewalInfo) renewal = await verifyRenewalJws(d.signedRenewalInfo, opts);
  } catch (e) {
    if (e instanceof RCError && e.status === 400) throw new NotificationError(e.message);
    throw e;
  }
  // Refund Control: answer Apple's refund request, or record that Apple declined one (services/refunds.ts).
  if (n.notificationType === "CONSUMPTION_REQUEST") {
    await handleConsumptionRequest(deps, app, tx, { signedDate: n.signedDate, reason: d.consumptionRequestReason ?? null });
    return true;
  }
  if (n.notificationType === "REFUND_DECLINED") {
    await noteRefundDeclined(deps, app, tx, n.signedDate ? new Date(n.signedDate) : now);
    return true;
  }
  const store = appleStoreOf(app);
  if (tx.type === "Auto-Renewable Subscription") {
    // A chain imported under a guessed key takes Apple's original_transaction_id now.
    await adoptImportedChain(deps.db, app.projectId, { store, storeKey: tx.originalTransactionId, storeTransactionId: tx.transactionId, originalTransactionId: tx.originalTransactionId });
  }
  const existing = await existingFor(deps.db, app.projectId, store, tx);
  if (!STATE_CHANGES.has(n.notificationType)) return !!existing;
  // An older period (e.g. a refund of a past renewal) never rolls the chain back; RevenueCat reports only the latest period.
  if (existing?.kind === "subscription" && existing.row.purchaseDate.getTime() > tx.purchaseDate && existing.row.storeTransactionId !== tx.transactionId) {
    if (n.notificationType === "REFUND") await noteAppleRefund(deps.db, app.projectId, store, tx.transactionId, tx.revocationDate ? new Date(tx.revocationDate) : now);
    return true;
  }
  const purchase = fromTransaction(tx, {
    store, renewal, detectedAt: n.signedDate ? new Date(n.signedDate) : now,
    previous: existing?.kind === "subscription" ? { unsubscribeDetectedAt: existing.row.unsubscribeDetectedAt, billingIssuesDetectedAt: existing.row.billingIssuesDetectedAt } : null,
    ...overrides(n.notificationType, n.subtype),
  });
  // A refund of an older period does not change the chain, but it still answers a refund request for that transaction.
  if (n.notificationType === "REFUND") await noteAppleRefund(deps.db, app.projectId, store, tx.transactionId, tx.revocationDate ? new Date(tx.revocationDate) : now);
  const applied = await applyFromStore(deps.db, {
    projectId: app.projectId, appId: app.id, purchase, now,
    createIfUnknown: app.credentials?.track_new_purchases === true, appUserIdHint: tx.appAccountToken ?? null, fetch: deps.fetch,
  });
  return applied;
}

/** Sends the exact body Apple sent to the app's forwarding URL (e.g. RevenueCat during a dual run) without delaying Apple. */
function forward(c: Context, db: DB, url: string, raw: string, contentType: string, notificationId: string) {
  const task = (async () => {
    let status = 0; // 0 = no response (network error or timeout)
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": contentType }, body: raw, signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) });
      status = res.status;
    } catch { /* recorded as 0 */ }
    await db.update(storeNotifications).set({ forwardStatus: status }).where(eq(storeNotifications.id, notificationId));
  })().catch((e) => console.error("Recording an Apple notification forward failed", e));
  try { c.executionCtx.waitUntil(task); } catch { /* Node has no execution context; the promise runs on its own. */ }
}

/**
 * App Store Server Notifications V2: POST /v1/notifications/apple/{appId} with `{ signedPayload }`.
 * Apple retries anything but 2xx, so valid payloads get 200 even when the purchase is unknown; 400 means the payload
 * cannot be verified; 500 only for our own failures.
 */
export function appleNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/:appId", async (c) => {
    const { db } = deps;
    const [app] = await db.select().from(apps).where(eq(apps.id, c.req.param("appId"))).limit(1);
    if (!app || (app.type !== "app_store" && app.type !== "mac_app_store")) return c.json({ error: "Unknown App Store app." }, 404);
    const raw = await c.req.text();
    const id = newId("ntf_", 16);
    await db.insert(storeNotifications).values({ id, projectId: app.projectId, appId: app.id, store: appleStoreOf(app), body: raw, receivedAt: deps.now() });
    if (app.notificationForwardUrl) forward(c, db, app.notificationForwardUrl, raw, c.req.header("content-type") ?? "application/json", id);
    const fail = async (status: 400 | 500, message: string) => {
      await db.update(storeNotifications).set({ error: message }).where(eq(storeNotifications.id, id));
      return c.json({ error: message }, status);
    };
    try {
      const n = await decode(raw, app, deps.now());
      const env = n.data?.environment ?? n.summary?.environment;
      await db.update(storeNotifications).set({ type: n.notificationType, subtype: n.subtype ?? null, environment: env ? env.toLowerCase() : null })
        .where(eq(storeNotifications.id, id));
      const known = await processNotification(deps, app, n);
      await db.update(storeNotifications).set({ processedAt: deps.now() }).where(eq(storeNotifications.id, id));
      if (known) await db.update(apps).set({ lastNotificationAt: deps.now() }).where(eq(apps.id, app.id));
    } catch (e) {
      if (e instanceof NotificationError) return fail(400, e.message);
      console.error("Processing an Apple notification failed", e);
      return fail(500, "The notification could not be processed.");
    }
    deps.kick?.();
    return c.json({ ok: true });
  });
  return r;
}
