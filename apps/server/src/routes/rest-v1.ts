import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { buildCustomerInfo, newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { Codes, RCError } from "../errors.js";
import type { Deps, Vars } from "../context.js";
import { entitlementMap } from "../repo/catalog.js";
import { aliasesOf, findCustomer, getOrCreateCustomer, loadState } from "../repo/customers.js";
import { revokeSubscriberTokens } from "../services/auth.js";
import { applyPurchases } from "../services/purchases.js";
import { addDuration } from "../stores/test-store.js";
import {
  StoreActionError, cancelSubscription, extendSubscription, refundOrder, revokeSubscription, subscriptionByProduct, subscriptionByTransaction, transactionTarget,
} from "../services/store-actions.js";

const DURATIONS: Record<string, string | null> = {
  daily: "P1D", three_day: "P3D", weekly: "P1W", two_week: "P2W", monthly: "P1M", two_month: "P2M", three_month: "P3M", six_month: "P6M", yearly: "P1Y", lifetime: null,
};

/** Secret-key-only REST API v1 endpoints (the SDK paths live in sdk.ts). */
export function restV1(r: Hono<{ Variables: Vars }>, deps: Deps) {
  const requireSecret = (c: any) => {
    if (c.get("auth")?.kind !== "secret") throw new RCError(403, Codes.INVALID_API_KEY, "This endpoint requires a secret API key.");
    return c.get("auth").projectId as string;
  };
  const uid = (c: any) => decodeURIComponent(c.req.param("id"));
  const respond = async (c: any, projectId: string, customerId: string) => {
    const [cust] = await deps.db.select().from(schema.customers).where(eq(schema.customers.id, customerId));
    const state = await loadState(deps.db, cust!);
    return c.json(buildCustomerInfo(state, await entitlementMap(deps.db, projectId), deps.now(), { includeAttributes: true }));
  };

  r.delete("/v1/subscribers/:id", async (c) => {
    const projectId = requireSecret(c);
    const cust = await findCustomer(deps.db, projectId, uid(c));
    if (!cust) throw new RCError(404, Codes.NOT_FOUND, "Subscriber not found.");
    await revokeSubscriberTokens(deps.db, projectId, await aliasesOf(deps.db, cust.id));
    await deps.db.delete(schema.customers).where(eq(schema.customers.id, cust.id));
    return c.json({ app_user_id: uid(c) });
  });

  // Grant promotional access: end_time_ms, or the deprecated duration enum (+ start_time_ms).
  r.post("/v1/subscribers/:id/entitlements/:ent/promotional", async (c) => {
    const projectId = requireSecret(c);
    const now = deps.now();
    const b = await c.req.json().catch(() => ({})) as Record<string, any>;
    const ent = c.req.param("ent");
    const [row] = await deps.db.select().from(schema.entitlements).where(and(eq(schema.entitlements.projectId, projectId), eq(schema.entitlements.lookupKey, ent)));
    if (!row) throw new RCError(404, Codes.NOT_FOUND, `Entitlement ${ent} not found.`);
    const start = b.start_time_ms ? new Date(Number(b.start_time_ms)) : now;
    let end: Date | null;
    let label: string;
    if (b.end_time_ms) { end = new Date(Number(b.end_time_ms)); label = "custom"; }
    else if (b.duration && b.duration in DURATIONS) { const iso = DURATIONS[b.duration]; end = iso ? addDuration(start, iso) : null; label = b.duration; }
    else throw new RCError(400, Codes.BAD_REQUEST, "end_time_ms or duration is required.");
    if (end && end <= now) throw new RCError(400, Codes.BAD_REQUEST, "end_time_ms must be in the future.");
    const { customer } = await getOrCreateCustomer(deps.db, projectId, uid(c), now);
    // A grant within 2 hours of an existing promotional expiry for the same entitlement is a duplicate.
    const promos = await deps.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.customerId, customer.id), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.entitlementIdentifier, ent)));
    const dup = promos.some((p) => (p.expiresDate === null && end === null) || (p.expiresDate && end && Math.abs(p.expiresDate.getTime() - end.getTime()) < 2 * 3600_000));
    if (!dup) {
      await applyPurchases(deps.db, customer, [{
        kind: "subscription", store: "promotional", storeKey: newId("promo_", 16), productIdentifier: `rc_promo_${ent}_${label}`,
        isSandbox: false, purchaseDate: start, originalPurchaseDate: start, expiresDate: end, periodType: "promotional",
        storeTransactionId: newId("promo_", 16),
      }], { projectId, appId: null, appUserId: uid(c), now, fromDevice: false });
      await deps.db.update(schema.subscriptions).set({ entitlementIdentifier: ent })
        .where(and(eq(schema.subscriptions.customerId, customer.id), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.productIdentifier, `rc_promo_${ent}_${label}`)));
    }
    return respond(c, projectId, customer.id);
  });

  r.post("/v1/subscribers/:id/entitlements/:ent/revoke_promotionals", async (c) => {
    const projectId = requireSecret(c);
    const now = deps.now();
    const cust = await findCustomer(deps.db, projectId, uid(c));
    if (!cust) throw new RCError(404, Codes.NOT_FOUND, "Subscriber not found.");
    const promos = await deps.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.customerId, cust.id), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.entitlementIdentifier, c.req.param("ent"))));
    for (const p of promos) {
      if (p.expiresDate === null || p.expiresDate > now) {
        await applyPurchases(deps.db, cust, [{
          kind: "subscription", store: "promotional", storeKey: p.storeKey, productIdentifier: p.productIdentifier, isSandbox: false,
          purchaseDate: p.purchaseDate, originalPurchaseDate: p.originalPurchaseDate, expiresDate: now, periodType: "promotional", storeTransactionId: p.storeTransactionId ?? p.storeKey,
        }], { projectId, appId: null, appUserId: uid(c), now, fromDevice: false });
      }
    }
    return respond(c, projectId, cust.id);
  });

  r.post("/v1/subscribers/:id/offerings/:offering/override", async (c) => {
    const projectId = requireSecret(c);
    const now = deps.now();
    const key = c.req.param("offering");
    const [o] = await deps.db.select().from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.id, key)));
    const [byLookup] = o ? [o] : await deps.db.select().from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.lookupKey, key)));
    if (!byLookup) throw new RCError(404, Codes.NOT_FOUND, "Offering not found.");
    const { customer } = await getOrCreateCustomer(deps.db, projectId, uid(c), now);
    await deps.db.update(schema.customers).set({ offeringOverrideId: byLookup.id }).where(eq(schema.customers.id, customer.id));
    return respond(c, projectId, customer.id);
  });

  r.delete("/v1/subscribers/:id/offerings/override", async (c) => {
    const projectId = requireSecret(c);
    const cust = await findCustomer(deps.db, projectId, uid(c));
    if (!cust) throw new RCError(404, Codes.NOT_FOUND, "Subscriber not found.");
    await deps.db.update(schema.customers).set({ offeringOverrideId: null }).where(eq(schema.customers.id, cust.id));
    return respond(c, projectId, cust.id);
  });

  // Store actions, performed by the store that sold the purchase (see services/store-actions.ts). Each answers the customer info.
  const storeAction = (path: string, run: (c: any, customerId: string, id: string) => Promise<void>) => r.post(path, async (c) => {
    const projectId = requireSecret(c);
    const cust = await findCustomer(deps.db, projectId, uid(c));
    if (!cust) throw new RCError(404, Codes.NOT_FOUND, "Subscriber not found.");
    try {
      await run(c, cust.id, decodeURIComponent(c.req.param("pid") ?? ""));
    } catch (e) {
      throw v1ActionError(e);
    }
    return respond(c, projectId, cust.id);
  });
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  storeAction("/v1/subscribers/:id/subscriptions/:pid/revoke", async (_c, customerId, pid) =>
    revokeSubscription(deps, await subscriptionByProduct(deps, customerId, pid)));
  storeAction("/v1/subscribers/:id/subscriptions/:pid/defer", async (c, customerId, pid) => {
    const sub = await subscriptionByProduct(deps, customerId, pid);
    if (sub.store !== "play_store") throw new StoreActionError("unsupported", "Deferring is only supported for Google Play subscriptions. Use extend for App Store subscriptions.");
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    await extendSubscription(deps, sub, { expiryTimeMs: num(b.expiry_time_ms), extendByDays: num(b.extend_by_days) });
  });
  storeAction("/v1/subscribers/:id/transactions/:pid/refund", async (_c, customerId, pid) =>
    refundOrder(deps, await transactionTarget(deps, customerId, pid)));
  storeAction("/v1/subscribers/:id/subscriptions/:pid/cancel", async (_c, customerId, pid) =>
    cancelSubscription(deps, await subscriptionByTransaction(deps, customerId, pid)));
  storeAction("/v1/subscribers/:id/subscriptions/:pid/extend", async (c, customerId, pid) => {
    const sub = await subscriptionByTransaction(deps, customerId, pid);
    if (sub.store === "play_store") throw new StoreActionError("unsupported", "Extending is only supported for App Store subscriptions. Use defer for Google Play subscriptions.");
    const b = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    await extendSubscription(deps, sub, { extendByDays: num(b.extend_by_days), extendReasonCode: num(b.extend_reason_code) });
  });
}

/**
 * v1 errors for store actions, with the backend codes the RevenueCat SDKs and clients know: 7259 no such subscription,
 * 7000 the action does not exist for this store (RevenueCat's "invalid platform"), 7226 bad parameters, 7101 the store
 * refused or could not be reached (5xx when it is worth retrying).
 */
function v1ActionError(e: unknown) {
  if (!(e instanceof StoreActionError)) return e;
  switch (e.kind) {
    case "not_found": return new RCError(404, Codes.NOT_FOUND, e.message);
    case "unsupported": return new RCError(400, Codes.INVALID_PLATFORM, e.message);
    case "invalid": return new RCError(400, Codes.BAD_REQUEST_PARAMS, e.message);
    case "rejected": return new RCError(400, Codes.STORE_PROBLEM, e.message);
    default: return new RCError(503, Codes.STORE_PROBLEM, e.message);
  }
}
