import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { findCustomer, getOrCreateCustomer, setAttributes, type CustomerRow } from "../../repo/customers.js";
import { applyPurchases } from "../../services/purchases.js";
import { subscriptionTransactions } from "../../services/subscription-transactions.js";
import { StoreActionError, cancelSubscription, extendSubscription, refundOrder, revokeSubscription } from "../../services/store-actions.js";
import { V2Error, body, conflict, expands, listOf, monetaryFor, notFound, pageParams, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { activeEntitlements, attributeItems, customerShape, loadCatalog, purchaseShape, subscriptionRevenue, subscriptionShape } from "./shapes.js";

const AttrName = z.string().min(1).max(500);
const CustomerCreate = z.object({ id: z.string().min(1).max(1500), attributes: z.array(z.object({ name: AttrName, value: z.string() })).max(500).optional() });
const SetAttributes = z.object({ attributes: z.array(z.object({ name: AttrName, value: z.string().nullable() })).min(1).max(500) });
const Grant = z.object({ entitlement_id: z.string().min(1), expires_at: z.number().int() });
const Revoke = z.object({ entitlement_id: z.string().min(1) });
const Assign = z.object({ offering_id: z.string().min(1).nullable() });
const Env = z.enum(["sandbox", "production"]).optional();
const REASON_CODES = { undeclared: 0, customer_satisfaction: 1, other: 2, service_issue_or_outage: 3 } as const;
const Extend = z.union([
  z.object({ extend_by_days: z.number().int().min(1), extend_reason_code: z.enum(["undeclared", "customer_satisfaction", "other", "service_issue_or_outage"]).optional() }).strict(),
  z.object({ extend_until_ms: z.number().int(), extend_reason_code: z.enum(["undeclared", "customer_satisfaction", "other", "service_issue_or_outage"]).optional() }).strict(),
]);

/** Store action failures in API v2's error vocabulary. */
function v2ActionError(e: unknown): unknown {
  if (!(e instanceof StoreActionError)) return e;
  switch (e.kind) {
    case "not_found": return new V2Error(404, "resource_missing", e.message);
    case "unsupported": return new V2Error(422, "unprocessable_entity_error", e.message);
    case "invalid": return new V2Error(400, "parameter_error", e.message);
    case "rejected": return new V2Error(422, "store_error", e.message);
    // RevenueCat's spec has store_error only on 422 (retryable when the store is down); its 503 is server_error alone.
    default: return new V2Error(422, "store_error", e.message, undefined, true);
  }
}
const act = async (run: () => Promise<void>) => { try { await run(); } catch (e) { throw v2ActionError(e); } };

export function customerRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const C = "/v2/projects/:project_id/customers";

  /** A customer id is any of its app user ids (RevenueCat's customer id is the app user id). */
  const find = async (c: V2Context) => {
    const cust = await findCustomer(db, c.get("projectId"), c.req.param("customer_id")!);
    if (!cust || cust.projectId !== c.get("projectId")) throw notFound("Customer");
    return cust;
  };
  const env = (c: V2Context) => {
    const r = Env.safeParse(c.req.query("environment") || undefined);
    if (!r.success) throw paramError("environment must be sandbox or production.", "environment");
    return r.data;
  };

  // List or search. Newest customers first (by first seen), keyset-paginated on (first_seen, id).
  r.get(C, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const { limit, startingAfter } = pageParams(c);
    const search = c.req.query("search")?.trim();
    const conds = [eq(schema.customers.projectId, projectId)];
    if (search) {
      // Exact matches, like RevenueCat: $email attribute, any app user id, or a store transaction / purchase id.
      const ids = new Set<string>();
      const byAlias = await db.select({ id: schema.customerAliases.customerId }).from(schema.customerAliases).where(and(eq(schema.customerAliases.projectId, projectId), eq(schema.customerAliases.appUserId, search)));
      const byEmail = await db.select({ id: schema.customerAttributes.customerId }).from(schema.customerAttributes).innerJoin(schema.customers, eq(schema.customers.id, schema.customerAttributes.customerId))
        .where(and(eq(schema.customers.projectId, projectId), eq(schema.customerAttributes.key, "$email"), sql`lower(${schema.customerAttributes.value}) = lower(${search})`));
      const bySub = await db.select({ id: schema.subscriptions.customerId }).from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, projectId),
        or(eq(schema.subscriptions.storeTransactionId, search), eq(schema.subscriptions.originalTransactionId, search), eq(schema.subscriptions.storeKey, search))));
      const byOne = await db.select({ id: schema.nonSubscriptions.customerId }).from(schema.nonSubscriptions).where(and(eq(schema.nonSubscriptions.projectId, projectId), eq(schema.nonSubscriptions.storeTransactionId, search)));
      for (const x of [...byAlias, ...byEmail, ...bySub, ...byOne]) ids.add(x.id);
      if (!ids.size) return c.json(listOf(c, [], null));
      conds.push(inArray(schema.customers.id, [...ids]));
    }
    if (startingAfter) {
      const cur = await findCustomer(db, projectId, startingAfter);
      if (!cur) throw paramError("starting_after does not match a customer in this project.", "starting_after");
      conds.push(sql`(${schema.customers.firstSeen}, ${schema.customers.id}) < (${cur.firstSeen.toISOString()}::timestamptz, ${cur.id})`);
    }
    const rows = await db.select().from(schema.customers).where(and(...conds)).orderBy(desc(schema.customers.firstSeen), desc(schema.customers.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map((x) => customerShape(db, x, { now: deps.now() })));
    return c.json(listOf(c, items, rows.length > limit ? page[page.length - 1]!.originalAppUserId : null));
  });

  r.post(C, scope("customer_information:customers:read_write"), async (c) => {
    const b = await body(c, CustomerCreate);
    const projectId = c.get("projectId");
    if (await findCustomer(db, projectId, b.id)) throw conflict(`A customer with id ${b.id} already exists.`, "id");
    const now = deps.now();
    const { customer } = await getOrCreateCustomer(db, projectId, b.id, now);
    if (b.attributes?.length) await setAttributes(db, customer.id, Object.fromEntries(b.attributes.map((a) => [a.name, { value: a.value, updated_at_ms: now.getTime() }])), now);
    return c.json(await customerShape(db, customer, { now, detail: true }), 201);
  });

  r.get(`${C}/:customer_id`, scope("customer_information:customers:read"), async (c) => {
    const cust = await find(c);
    return c.json(await customerShape(db, cust, { now: deps.now(), detail: true, attributes: expands(c).has("attributes") }));
  });

  r.delete(`${C}/:customer_id`, scope("customer_information:customers:read_write"), async (c) => {
    const cust = await find(c);
    // Aliases, attributes, subscriptions, purchases, transactions and events cascade.
    await db.delete(schema.customers).where(and(eq(schema.customers.projectId, cust.projectId), eq(schema.customers.id, cust.id)));
    return c.json({ object: "customer", id: c.req.param("customer_id"), deleted_at: deps.now().getTime() });
  });

  r.get(`${C}/:customer_id/aliases`, scope("customer_information:customers:read"), async (c) => {
    const cust = await find(c);
    const rows = await db.select().from(schema.customerAliases).where(and(eq(schema.customerAliases.projectId, cust.projectId), eq(schema.customerAliases.customerId, cust.id)));
    return c.json(paginate(c, rows, (a) => a.appUserId, (a) => a.createdAt.getTime(), (a) => ({ object: "customer.alias", id: a.appUserId, created_at: a.createdAt.getTime() })));
  });

  r.get(`${C}/:customer_id/attributes`, scope("customer_information:customers:read"), async (c) => {
    const cust = await find(c);
    const items = await attributeItems(db, cust.id);
    return c.json(paginate(c, items, (a) => a.name, () => 0, (a) => a));
  });

  r.post(`${C}/:customer_id/attributes`, scope("customer_information:customers:read_write"), async (c) => {
    const cust = await find(c);
    const b = await body(c, SetAttributes);
    const now = deps.now();
    // API writes always win: they carry the current time as updated_at.
    await setAttributes(db, cust.id, Object.fromEntries(b.attributes.map((a) => [a.name, { value: a.value, updated_at_ms: now.getTime() }])), now);
    const items = await attributeItems(db, cust.id);
    return c.json(listOf(c, items, null));
  });

  r.get(`${C}/:customer_id/active_entitlements`, scope("customer_information:customers:read"), async (c) => {
    const cust = await find(c);
    const items = await activeEntitlements(db, cust, deps.now());
    return c.json(paginate(c, items, (e) => e.entitlement_id, () => 0, (e) => e));
  });

  r.get(`${C}/:customer_id/subscriptions`, scope("customer_information:subscriptions:read"), async (c) => {
    const cust = await find(c);
    const e = env(c);
    const rows = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, cust.projectId), eq(schema.subscriptions.customerId, cust.id),
      ...(e ? [eq(schema.subscriptions.isSandbox, e === "sandbox")] : [])));
    const cat = await loadCatalog(db, cust.projectId);
    const rev = await subscriptionRevenue(db, rows);
    return c.json(paginate(c, rows, (s) => s.id, (s) => s.originalPurchaseDate.getTime(), (s) => subscriptionShape(s, cust.originalAppUserId, cat, rev.get(s.id) ?? 0, deps.now())));
  });

  r.get(`${C}/:customer_id/purchases`, scope("customer_information:purchases:read"), async (c) => {
    const cust = await find(c);
    const e = env(c);
    const rows = await db.select().from(schema.nonSubscriptions).where(and(eq(schema.nonSubscriptions.projectId, cust.projectId), eq(schema.nonSubscriptions.customerId, cust.id),
      ...(e ? [eq(schema.nonSubscriptions.isSandbox, e === "sandbox")] : [])));
    const cat = await loadCatalog(db, cust.projectId);
    return c.json(paginate(c, rows, (p) => p.id, (p) => p.purchaseDate.getTime(), (p) => purchaseShape(p, cust.originalAppUserId, cat)));
  });

  r.get(`${C}/:customer_id/events`, scope("customer_information:customers:read"), async (c) => {
    const cust = await find(c);
    const e = env(c);
    const rows = await db.select().from(schema.events).where(and(eq(schema.events.projectId, cust.projectId), eq(schema.events.customerId, cust.id), ...(e ? [eq(schema.events.environment, e)] : [])));
    // Newest first.
    return c.json(paginate(c, rows, (x) => x.id, (x) => -x.eventTimestampMs, (x) => ({
      object: "customer.event", id: x.id, app_id: x.appId, type: x.type, body: (x.payload as { event?: unknown }).event ?? x.payload,
      created_at: x.createdAt.getTime(), occurred_at: x.eventTimestampMs,
    })));
  });

  // Promotional access, same rules as v1: a grant whose expiry is within 2 hours of an existing one is a duplicate.
  r.post(`${C}/:customer_id/actions/grant_entitlement`, scope("customer_information:customers:read_write"), async (c) => {
    const cust = await find(c);
    const b = await body(c, Grant);
    const now = deps.now();
    const [ent] = await db.select().from(schema.entitlements).where(and(eq(schema.entitlements.projectId, cust.projectId), eq(schema.entitlements.id, b.entitlement_id))).limit(1);
    if (!ent) throw notFound("Entitlement");
    const end = new Date(b.expires_at);
    if (end <= now) throw paramError("expires_at must be in the future.", "expires_at");
    const promos = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.customerId, cust.id), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.entitlementIdentifier, ent.lookupKey)));
    const dup = promos.some((p) => p.expiresDate && Math.abs(p.expiresDate.getTime() - end.getTime()) < 2 * 3600_000);
    if (!dup) {
      const storeKey = newId("promo_", 16);
      const appUserId = c.req.param("customer_id")!;
      await applyPurchases(db, cust, [{
        kind: "subscription", store: "promotional", storeKey, productIdentifier: `rc_promo_${ent.lookupKey}_custom`, isSandbox: false,
        purchaseDate: now, originalPurchaseDate: now, expiresDate: end, periodType: "promotional", storeTransactionId: storeKey,
      }], { projectId: cust.projectId, appId: null, appUserId, now, fromDevice: false });
      await db.update(schema.subscriptions).set({ entitlementIdentifier: ent.lookupKey })
        .where(and(eq(schema.subscriptions.projectId, cust.projectId), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.storeKey, storeKey)));
      deps.kick?.();
    }
    return c.json(await customerShape(db, cust, { now, detail: true }), 201);
  });

  r.post(`${C}/:customer_id/actions/revoke_granted_entitlement`, scope("customer_information:customers:read_write"), async (c) => {
    const cust = await find(c);
    const b = await body(c, Revoke);
    const now = deps.now();
    const [ent] = await db.select().from(schema.entitlements).where(and(eq(schema.entitlements.projectId, cust.projectId), eq(schema.entitlements.id, b.entitlement_id))).limit(1);
    if (!ent) throw notFound("Entitlement");
    const promos = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.customerId, cust.id), eq(schema.subscriptions.store, "promotional"), eq(schema.subscriptions.entitlementIdentifier, ent.lookupKey)));
    const active = promos.filter((p) => p.expiresDate === null || p.expiresDate > now);
    if (!active.length) throw new V2Error(404, "resource_missing", "The customer has no active granted entitlement for this entitlement.", "entitlement_id");
    for (const p of active) {
      await applyPurchases(db, cust, [{
        kind: "subscription", store: "promotional", storeKey: p.storeKey, productIdentifier: p.productIdentifier, isSandbox: false,
        purchaseDate: p.purchaseDate, originalPurchaseDate: p.originalPurchaseDate, expiresDate: now, periodType: "promotional", storeTransactionId: p.storeTransactionId ?? p.storeKey,
      }], { projectId: cust.projectId, appId: null, appUserId: c.req.param("customer_id")!, now, fromDevice: false });
    }
    deps.kick?.();
    return c.json(await customerShape(db, cust, { now, detail: true }));
  });

  r.post(`${C}/:customer_id/actions/assign_offering`, scope("project_configuration:offerings:read", "customer_information:customers:read_write"), async (c) => {
    const cust = await find(c);
    const b = await body(c, Assign);
    if (b.offering_id !== null) {
      const [o] = await db.select().from(schema.offerings).where(and(eq(schema.offerings.projectId, cust.projectId), eq(schema.offerings.id, b.offering_id))).limit(1);
      if (!o) throw notFound("Offering");
    }
    await db.update(schema.customers).set({ offeringOverrideId: b.offering_id }).where(and(eq(schema.customers.projectId, cust.projectId), eq(schema.customers.id, cust.id)));
    return c.json({});
  });

  // Project-level subscription and purchase lookups.
  const S = "/v2/projects/:project_id/subscriptions";
  const findSub = async (c: V2Context) => {
    const [s] = await db.select({ s: schema.subscriptions, cu: schema.customers }).from(schema.subscriptions).innerJoin(schema.customers, eq(schema.customers.id, schema.subscriptions.customerId))
      .where(and(eq(schema.subscriptions.projectId, c.get("projectId")), eq(schema.subscriptions.id, c.req.param("subscription_id")!))).limit(1);
    if (!s) throw notFound("Subscription");
    return s;
  };
  const subsList = async (c: V2Context, rows: { s: typeof schema.subscriptions.$inferSelect; cu: CustomerRow }[]) => {
    const cat = await loadCatalog(db, c.get("projectId"));
    const rev = await subscriptionRevenue(db, rows.map((x) => x.s));
    return rows.map((x) => subscriptionShape(x.s, x.cu.originalAppUserId, cat, rev.get(x.s.id) ?? 0, deps.now()));
  };

  r.get(S, scope("customer_information:subscriptions:read"), async (c) => {
    const id = c.req.query("store_subscription_identifier");
    if (!id) throw paramError("store_subscription_identifier is required.", "store_subscription_identifier");
    const rows = await db.select({ s: schema.subscriptions, cu: schema.customers }).from(schema.subscriptions).innerJoin(schema.customers, eq(schema.customers.id, schema.subscriptions.customerId))
      .where(and(eq(schema.subscriptions.projectId, c.get("projectId")), or(eq(schema.subscriptions.storeTransactionId, id), eq(schema.subscriptions.storeKey, id), eq(schema.subscriptions.originalTransactionId, id))));
    return c.json(listOf(c, await subsList(c, rows), null));
  });

  r.get(`${S}/:subscription_id`, scope("customer_information:subscriptions:read"), async (c) => c.json((await subsList(c, [await findSub(c)]))[0]));

  r.get(`${S}/:subscription_id/entitlements`, scope("customer_information:subscriptions:read"), async (c) => {
    const [shape] = await subsList(c, [await findSub(c)]);
    return c.json(paginate(c, shape!.entitlements.items, (e) => e.id, (e) => e.created_at, (e) => e));
  });

  const TxQuery = z.object({ sort: z.enum(["id", "purchased_at"]).default("id"), direction: z.enum(["asc", "desc"]).default("asc") });
  r.get(`${S}/:subscription_id/transactions`, scope("customer_information:subscriptions:read"), async (c) => {
    const { s } = await findSub(c);
    const q = TxQuery.safeParse({ sort: c.req.query("sort") || undefined, direction: c.req.query("direction") || undefined });
    if (!q.success) throw paramError("sort must be id or purchased_at, and direction asc or desc.", q.error.issues[0]?.path[0]?.toString());
    const { limit, startingAfter } = pageParams(c);
    const sign = q.data.direction === "asc" ? 1 : -1;
    const items = (await subscriptionTransactions(db, s)).sort((a, b) => sign * (q.data.sort === "purchased_at" ? a.purchased_at - b.purchased_at || (a.id < b.id ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let start = 0;
    if (startingAfter) {
      const i = items.findIndex((t) => t.id === startingAfter);
      if (i < 0) throw paramError("starting_after does not match a transaction of this subscription.", "starting_after");
      start = i + 1;
    }
    const page = items.slice(start, start + limit);
    return c.json(listOf(c, page, start + limit < items.length && page.length ? page[page.length - 1]!.id : null));
  });

  // Store actions (services/store-actions.ts). RevenueCat offers cancel and refund for its own web billing; here they act on
  // Google Play subscriptions, the only store that lets a server do either. Other stores answer 422.
  const W = "customer_information:subscriptions:read_write";
  r.post(`${S}/:subscription_id/actions/cancel`, scope(W), async (c) => {
    const { s } = await findSub(c);
    await act(() => cancelSubscription(deps, s));
    return c.json((await subsList(c, [await findSub(c)]))[0]);
  });
  r.post(`${S}/:subscription_id/actions/refund`, scope(W), async (c) => {
    const { s } = await findSub(c);
    await act(() => revokeSubscription(deps, s));
    return c.json((await subsList(c, [await findSub(c)]))[0]);
  });
  r.post(`${S}/:subscription_id/actions/extend`, scope(W), async (c) => {
    const { s } = await findSub(c);
    const b = await body(c, Extend);
    const reason = b.extend_reason_code === undefined ? null : REASON_CODES[b.extend_reason_code];
    if (s.store === "app_store" || s.store === "mac_app_store") {
      if (reason === null) throw paramError("extend_reason_code is required for App Store subscriptions.", "extend_reason_code");
      if ("extend_by_days" in b && b.extend_by_days > 90) throw paramError("App Store subscriptions can be extended by at most 90 days.", "extend_by_days");
    }
    await act(() => extendSubscription(deps, s, "extend_by_days" in b ? { extendByDays: b.extend_by_days, extendReasonCode: reason } : { expiryTimeMs: b.extend_until_ms, extendReasonCode: reason }));
    return c.json((await subsList(c, [await findSub(c)]))[0]);
  });
  r.post(`${S}/:subscription_id/transactions/:transaction_id/actions/refund`, scope(W), async (c) => {
    const { s } = await findSub(c);
    const txId = c.req.param("transaction_id")!;
    const T = schema.transactions;
    const [t] = await db.select().from(T).where(and(eq(T.projectId, s.projectId), eq(T.customerId, s.customerId), eq(T.store, s.store), eq(T.storeTransactionId, txId),
      inArray(T.kind, ["purchase", "renewal", "trial"]))).limit(1);
    if (!t && txId !== s.storeTransactionId) throw notFound("Transaction");
    await act(() => refundOrder(deps, { kind: "subscription", row: s, orderId: txId }));
    const [after] = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.id, s.id));
    const purchasedAt = t?.purchasedAt ?? s.purchaseDate;
    const expires = t?.expiresAt ?? s.expiresDate;
    const local = t?.priceAmount ?? s.priceAmount;
    const currency = t?.priceCurrency ?? s.priceCurrency;
    return c.json({
      object: "subscription_transaction", id: txId, purchased_at: purchasedAt.getTime(), product_store_identifier: s.productIdentifier,
      revenue_in_local_currency: local !== null && currency ? monetaryFor(local, currency, s.store) : null,
      revenue_in_usd: monetaryFor(t?.revenueUsd ?? s.priceUsd ?? 0, "USD", s.store),
      expiration_date: expires ? expires.getTime() : null,
      effective_expiration_date: after?.refundedAt && txId === after.storeTransactionId ? after.refundedAt.getTime() : expires ? expires.getTime() : null,
    });
  });

  const U = "/v2/projects/:project_id/purchases";
  const purchasesList = async (c: V2Context, rows: { p: typeof schema.nonSubscriptions.$inferSelect; cu: CustomerRow }[]) => {
    const cat = await loadCatalog(db, c.get("projectId"));
    return rows.map((x) => purchaseShape(x.p, x.cu.originalAppUserId, cat));
  };
  const findPurchase = async (c: V2Context) => {
    const [p] = await db.select({ p: schema.nonSubscriptions, cu: schema.customers }).from(schema.nonSubscriptions).innerJoin(schema.customers, eq(schema.customers.id, schema.nonSubscriptions.customerId))
      .where(and(eq(schema.nonSubscriptions.projectId, c.get("projectId")), eq(schema.nonSubscriptions.id, c.req.param("purchase_id")!))).limit(1);
    if (!p) throw notFound("Purchase");
    return p;
  };

  r.get(U, scope("customer_information:purchases:read"), async (c) => {
    const id = c.req.query("store_purchase_identifier");
    if (!id) throw paramError("store_purchase_identifier is required.", "store_purchase_identifier");
    const rows = await db.select({ p: schema.nonSubscriptions, cu: schema.customers }).from(schema.nonSubscriptions).innerJoin(schema.customers, eq(schema.customers.id, schema.nonSubscriptions.customerId))
      .where(and(eq(schema.nonSubscriptions.projectId, c.get("projectId")), eq(schema.nonSubscriptions.storeTransactionId, id)));
    return c.json(listOf(c, await purchasesList(c, rows), null));
  });

  r.get(`${U}/:purchase_id`, scope("customer_information:purchases:read"), async (c) => c.json((await purchasesList(c, [await findPurchase(c)]))[0]));

  r.get(`${U}/:purchase_id/entitlements`, scope("customer_information:purchases:read"), async (c) => {
    const [shape] = await purchasesList(c, [await findPurchase(c)]);
    return c.json(paginate(c, shape!.entitlements.items, (e) => e.id, (e) => e.created_at, (e) => e));
  });

  // Refund a one-time purchase: Google Play refunds and revokes the order; other stores answer 422.
  r.post(`${U}/:purchase_id/actions/refund`, scope("customer_information:purchases:read_write"), async (c) => {
    const { p } = await findPurchase(c);
    await act(() => refundOrder(deps, { kind: "purchase", row: p }));
    return c.json((await purchasesList(c, [await findPurchase(c)]))[0]);
  });
}

