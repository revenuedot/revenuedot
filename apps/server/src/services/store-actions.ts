import { and, desc, eq, or } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { AppRecord, Deps } from "../context.js";
import { AppleApiClientError } from "../stores/apple/api.js";
import { appleApiFor, readAppleSubscription } from "../stores/apple/index.js";
import { GoogleApiError } from "../stores/google/api.js";
import { googleClientFor } from "../stores/google/index.js";
import { baseOrderId } from "../stores/google/map.js";
import { applyVoided, syncSubscription } from "../stores/google/sync.js";
import { RCError } from "../errors.js";
import { applyFromStore } from "./purchases.js";

/**
 * Store-side actions on a customer's purchases, performed by the store that sold them and then read back so the answer
 * shows the new state:
 *   Google Play: refund and revoke (subscriptionsv2.revoke with a full refund of the latest order), cancel
 *   (subscriptionsv2.cancel), defer (subscriptionsv2.defer), refund one order (orders.refund with revoke).
 *   App Store: extend the renewal date (Extend a Subscription Renewal Date); no consumption information is needed.
 * Anything else is `unsupported` for that store.
 */

type SubRow = typeof schema.subscriptions.$inferSelect;
type NonSubRow = typeof schema.nonSubscriptions.$inferSelect;

export type StoreActionErrorKind = "not_found" | "unsupported" | "invalid" | "rejected" | "unavailable";

export class StoreActionError extends Error {
  constructor(public kind: StoreActionErrorKind, message: string) { super(message); }
}

const APPLE = new Set(["app_store", "mac_app_store"]);
const DAY = 86_400_000;
const storeName = (store: string) => (APPLE.has(store) ? "App Store" : store === "play_store" ? "Google Play" : store === "test_store" ? "Test Store" : store === "promotional" ? "promotional" : store);

async function appOf(deps: Deps, row: { appId: string | null; projectId: string; store: string }): Promise<AppRecord> {
  const A = schema.apps;
  const [a] = row.appId
    ? await deps.db.select().from(A).where(and(eq(A.projectId, row.projectId), eq(A.id, row.appId))).limit(1)
    : await deps.db.select().from(A).where(and(eq(A.projectId, row.projectId), eq(A.type, row.store))).limit(1);
  if (!a) throw new StoreActionError("invalid", `The ${storeName(row.store)} app this purchase belongs to no longer exists.`);
  return a;
}

/** Google and Apple failures in neutral terms: a 4xx about the purchase is `rejected`, everything else `unavailable` (retry). */
function storeFailure(e: unknown, store: string): never {
  if (e instanceof StoreActionError) throw e;
  if (e instanceof GoogleApiError) {
    if (e.kind === "invalid_token") throw new StoreActionError("rejected", `Google Play rejected the request: ${e.message}`);
    if (e.kind === "credentials") throw new StoreActionError("unavailable", `Google Play credentials problem: ${e.message}`);
    throw new StoreActionError("unavailable", `Google Play could not be reached: ${e.message}`);
  }
  if (e instanceof AppleApiClientError) throw new StoreActionError("rejected", `The App Store rejected the request: ${e.message}${e.errorCode ? ` (${e.errorCode})` : ""}`);
  if (e instanceof RCError) throw new StoreActionError(e.status >= 500 ? "unavailable" : "rejected", e.message);
  throw new StoreActionError("unavailable", `${storeName(store)} could not be reached: ${e instanceof Error ? e.message : String(e)}`);
}

const unsupported = (action: string, store: string, supported: string) =>
  new StoreActionError("unsupported", `${action} is not supported for ${storeName(store)} purchases. It works for ${supported} subscriptions.`);

/** Reads the chain back from Google after an action. The action already happened, so a failed read only logs. */
async function resyncGoogle(deps: Deps, app: AppRecord, token: string, opts: Parameters<typeof syncSubscription>[2] = {}) {
  const { client } = googleClientFor(deps.stores, deps.fetch);
  const now = deps.now();
  try {
    await syncSubscription({ db: deps.db, app, client, now, eventTime: now }, token, opts);
  } catch (e) {
    console.warn(`Reading ${token} back from Google Play after a store action failed: ${e instanceof Error ? e.message : e}`);
  }
  deps.kick?.();
}

/** Google Play: refund the latest order and revoke access now. */
export async function revokeSubscription(deps: Deps, sub: SubRow) {
  if (sub.store !== "play_store") throw unsupported("Refunding and revoking a subscription", sub.store, "Google Play");
  const app = await appOf(deps, sub);
  const { client } = googleClientFor(deps.stores, deps.fetch);
  try { await client.revokeSubscriptionV2(app, sub.storeKey); } catch (e) { storeFailure(e, sub.store); }
  await resyncGoogle(deps, app, sub.storeKey, { refundAt: deps.now() });
}

/** Google Play: stop renewal; access continues to the end of the paid period. */
export async function cancelSubscription(deps: Deps, sub: SubRow) {
  if (sub.store !== "play_store") throw unsupported("Cancelling a subscription", sub.store, "Google Play");
  const app = await appOf(deps, sub);
  const { client } = googleClientFor(deps.stores, deps.fetch);
  try { await client.cancelSubscriptionV2(app, sub.storeKey); } catch (e) { storeFailure(e, sub.store); }
  await resyncGoogle(deps, app, sub.storeKey);
}

/**
 * Moves the next renewal later: Google Play defers it (up to 365 days), the App Store extends the renewal date (1 to 90
 * days, reason code 0-3, at most twice a year per customer, which Apple enforces).
 */
export async function extendSubscription(deps: Deps, sub: SubRow, p: { extendByDays?: number | null; expiryTimeMs?: number | null; extendReasonCode?: number | null }) {
  const now = deps.now();
  if (sub.store === "play_store") {
    const app = await appOf(deps, sub);
    const { client } = googleClientFor(deps.stores, deps.fetch);
    let current;
    try { current = await client.getSubscriptionV2(app, sub.storeKey); } catch (e) { storeFailure(e, sub.store); }
    const expiry = current.lineItems?.[0]?.expiryTime ? new Date(current.lineItems[0].expiryTime).getTime() : sub.expiresDate?.getTime() ?? now.getTime();
    let seconds: number;
    if (p.expiryTimeMs !== undefined && p.expiryTimeMs !== null) {
      if (p.expiryTimeMs <= expiry) throw new StoreActionError("invalid", "The new expiry time must be later than the subscription's current expiry.");
      seconds = (p.expiryTimeMs - expiry) / 1000;
    } else if (p.extendByDays !== undefined && p.extendByDays !== null) {
      if (!Number.isInteger(p.extendByDays) || p.extendByDays < 1 || p.extendByDays > 365) throw new StoreActionError("invalid", "extend_by_days must be a whole number from 1 to 365.");
      seconds = p.extendByDays * 86_400;
    } else throw new StoreActionError("invalid", "expiry_time_ms or extend_by_days is required.");
    if (seconds > 365 * 86_400) throw new StoreActionError("invalid", "Google Play defers a subscription by at most 365 days.");
    if (!current.etag) throw new StoreActionError("rejected", "Google Play did not return the subscription's etag, so it cannot be deferred.");
    try { await client.deferSubscriptionV2(app, sub.storeKey, current.etag, seconds); } catch (e) { storeFailure(e, sub.store); }
    await resyncGoogle(deps, app, sub.storeKey);
    return;
  }
  if (APPLE.has(sub.store)) {
    let days = p.extendByDays ?? null;
    if (days === null && p.expiryTimeMs !== undefined && p.expiryTimeMs !== null && sub.expiresDate) days = Math.ceil((p.expiryTimeMs - sub.expiresDate.getTime()) / DAY);
    if (days === null || !Number.isInteger(days) || days < 1 || days > 90) throw new StoreActionError("invalid", "extend_by_days must be a whole number from 1 to 90 for App Store subscriptions.");
    const reason = p.extendReasonCode;
    if (reason === undefined || reason === null || !Number.isInteger(reason) || reason < 0 || reason > 3) throw new StoreActionError("invalid", "extend_reason_code (0 to 3) is required for App Store subscriptions.");
    const app = await appOf(deps, sub);
    let api;
    try { api = appleApiFor(deps.stores, app, deps.fetch, deps.now); } catch (e) { storeFailure(e, sub.store); }
    if (!api) throw new StoreActionError("unavailable", "Extending App Store subscriptions needs the app's in-app purchase key. Add it in the app's settings.");
    const env = sub.isSandbox ? "sandbox" : "production";
    const original = sub.originalTransactionId ?? sub.storeKey;
    let res;
    try { res = await api.extendRenewalDate(env, original, { extendByDays: days, extendReasonCode: reason, requestIdentifier: crypto.randomUUID() }); } catch (e) { storeFailure(e, sub.store); }
    if (!res) throw new StoreActionError("not_found", "The App Store has no subscription with this original transaction id.");
    if (res.success === false) throw new StoreActionError("rejected", "The App Store did not extend the subscription (free offers, billing retry and expired subscriptions cannot be extended).");
    try {
      const fresh = await readAppleSubscription(api, app, original, env, now);
      if (fresh) await applyFromStore(deps.db, { projectId: app.projectId, appId: app.id, purchase: fresh, now, fetch: deps.fetch });
    } catch (e) {
      console.warn(`Reading ${original} back from the App Store after an extension failed: ${e instanceof Error ? e.message : e}`);
    }
    deps.kick?.();
    return;
  }
  throw unsupported("Extending a subscription", sub.store, "App Store and Google Play");
}

/** Google Play: refund one order (a subscription period or a one-time purchase) and revoke what it granted. */
export async function refundOrder(deps: Deps, target: { kind: "subscription"; row: SubRow; orderId: string } | { kind: "purchase"; row: NonSubRow }) {
  const row = target.row;
  if (row.store !== "play_store") throw new StoreActionError("unsupported", `Refunding a transaction is not supported for ${storeName(row.store)} purchases. It works for Google Play purchases; App Store refunds go through Apple.`);
  const app = await appOf(deps, row);
  const { client } = googleClientFor(deps.stores, deps.fetch);
  const orderId = target.kind === "subscription" ? target.orderId : target.row.storeTransactionId;
  try { await client.refundOrder(app, orderId, true); } catch (e) { storeFailure(e, row.store); }
  const now = deps.now();
  if (target.kind === "subscription") {
    await resyncGoogle(deps, app, target.row.storeKey, { refundAt: now, voidedOrderId: orderId });
  } else {
    try {
      await applyVoided({ db: deps.db, app, client, now, eventTime: now }, { purchaseToken: target.row.storeTransactionId, orderId, productType: 2, refundType: 1 });
    } catch (e) {
      console.warn(`Recording the refund of ${orderId} failed: ${e instanceof Error ? e.message : e}`);
    }
    deps.kick?.();
  }
}

// ---------- Lookups for the REST API v1 paths ----------

const S = schema.subscriptions;
const N = schema.nonSubscriptions;

/** v1 revoke/defer name the subscription by product identifier (`sub` or `sub:basePlan`); the latest chain wins. */
export async function subscriptionByProduct(deps: Deps, customerId: string, productId: string): Promise<SubRow> {
  const rows = await deps.db.select().from(S).where(eq(S.customerId, customerId)).orderBy(desc(S.expiresDate), desc(S.purchaseDate));
  const match = rows.filter((r) => r.productIdentifier === productId || `${r.productIdentifier}:${r.productPlanIdentifier ?? ""}` === productId);
  if (!match.length) throw new StoreActionError("not_found", `The customer has no subscription to ${productId}.`);
  return match.find((r) => r.store === "play_store") ?? match[0]!;
}

/** v1 cancel/extend name the subscription by a store transaction id: the current, original or renewal transaction, or the chain key. */
export async function subscriptionByTransaction(deps: Deps, customerId: string, id: string): Promise<SubRow> {
  const [row] = await deps.db.select().from(S).where(and(eq(S.customerId, customerId),
    or(eq(S.storeTransactionId, id), eq(S.originalTransactionId, id), eq(S.storeKey, id), eq(S.originalTransactionId, baseOrderId(id))))).limit(1);
  if (row) return row;
  // An earlier renewal of an App Store chain: the transactions ledger knows which product it was.
  const [t] = await deps.db.select().from(schema.transactions).where(and(eq(schema.transactions.customerId, customerId), eq(schema.transactions.storeTransactionId, id))).limit(1);
  if (t) {
    const [bySub] = await deps.db.select().from(S).where(and(eq(S.customerId, customerId), eq(S.store, t.store), eq(S.productIdentifier, t.productIdentifier))).limit(1);
    if (bySub) return bySub;
  }
  throw new StoreActionError("not_found", `The customer has no subscription with transaction ${id}.`);
}

/** v1 refund names one transaction: a one-time purchase, or a subscription period (Google order id). */
export async function transactionTarget(deps: Deps, customerId: string, id: string) {
  const [one] = await deps.db.select().from(N).where(and(eq(N.customerId, customerId), eq(N.storeTransactionId, id))).limit(1);
  if (one) return { kind: "purchase" as const, row: one };
  const sub = await subscriptionByTransaction(deps, customerId, id);
  return { kind: "subscription" as const, row: sub, orderId: id };
}
