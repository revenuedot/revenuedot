import { desc, eq, inArray } from "drizzle-orm";
import { computeEntitlements, isActive, type CustomerState } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { entitlementMap } from "../repo/catalog.js";
import { nonSubRowToDomain, subRowToDomain, type CustomerRow } from "../repo/customers.js";
import { emptyContext, type CustomerContext } from "./targeting.js";
import { accessFor, projectAccess } from "../repo/access.js";

/**
 * Everything the audience condition builder can ask about customers, loaded for many customers in a handful of queries.
 * Targeting (one customer per SDK request), audience previews, Refund Control policies, win-back audiences and the
 * Customers lists all build their CustomerContext here, so a condition means the same thing on every page.
 */

export type SubRow = typeof schema.subscriptions.$inferSelect;
export type NonSubRow = typeof schema.nonSubscriptions.$inferSelect;
export interface TxLite { usd: number; kind: string; sandbox: boolean; at: Date; product: string }

export interface CustomerData {
  customer: CustomerRow;
  aliases: string[];
  attributes: Record<string, string | null>;
  attributeTimes: Record<string, number>;
  subs: SubRow[];
  ones: NonSubRow[];
  tx: TxLite[];
  /** The customer's first-class attribution row (prd/attribution-benchmarks-insights §1), if any. */
  attribution: typeof schema.customerAttribution.$inferSelect | null;
}

const CHUNK = 500;
async function chunked<T>(ids: string[], load: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await load(ids.slice(i, i + CHUNK))));
  return out;
}

/** Aliases, attributes, purchases and transactions of these customers, keyed by customer id. */
export async function loadCustomerData(db: DB, customers: CustomerRow[]): Promise<Map<string, CustomerData>> {
  const out = new Map<string, CustomerData>();
  for (const c of customers) out.set(c.id, { customer: c, aliases: [], attributes: {}, attributeTimes: {}, subs: [], ones: [], tx: [], attribution: null });
  const ids = customers.map((c) => c.id);
  if (!ids.length) return out;
  const [aliases, attrs, subs, ones, tx, attribution] = await Promise.all([
    chunked(ids, (p) => db.select({ c: schema.customerAliases.customerId, a: schema.customerAliases.appUserId }).from(schema.customerAliases).where(inArray(schema.customerAliases.customerId, p))),
    chunked(ids, (p) => db.select().from(schema.customerAttributes).where(inArray(schema.customerAttributes.customerId, p))),
    chunked(ids, (p) => db.select().from(schema.subscriptions).where(inArray(schema.subscriptions.customerId, p))),
    chunked(ids, (p) => db.select().from(schema.nonSubscriptions).where(inArray(schema.nonSubscriptions.customerId, p))),
    chunked(ids, (p) => db.select({ c: schema.transactions.customerId, usd: schema.transactions.revenueUsd, kind: schema.transactions.kind, sandbox: schema.transactions.isSandbox, at: schema.transactions.purchasedAt, product: schema.transactions.productIdentifier })
      .from(schema.transactions).where(inArray(schema.transactions.customerId, p))),
    chunked(ids, (p) => db.select().from(schema.customerAttribution).where(inArray(schema.customerAttribution.customerId, p))),
  ]);
  for (const a of attribution) { const d = out.get(a.customerId); if (d) d.attribution = a; }
  for (const a of aliases) out.get(a.c)?.aliases.push(a.a);
  for (const a of attrs) { const d = out.get(a.customerId); if (d) { d.attributes[a.key] = a.value; d.attributeTimes[a.key] = a.updatedAtMs; } }
  for (const s of subs) out.get(s.customerId)?.subs.push(s);
  for (const o of ones) out.get(o.customerId)?.ones.push(o);
  for (const t of tx) out.get(t.c)?.tx.push({ usd: t.usd, kind: t.kind, sandbox: t.sandbox, at: t.at, product: t.product });
  return out;
}

export function stateOf(d: CustomerData): CustomerState {
  const attributes: CustomerState["attributes"] = {};
  for (const [k, v] of Object.entries(d.attributes)) attributes[k] = { value: v, updatedAtMs: d.attributeTimes[k] ?? 0 };
  const c = d.customer;
  return {
    originalAppUserId: c.originalAppUserId, firstSeen: c.firstSeen, lastSeen: c.lastSeen, originalApplicationVersion: c.originalApplicationVersion,
    originalPurchaseDate: c.originalPurchaseDate, subscriptions: d.subs.map(subRowToDomain), nonSubscriptions: d.ones.map(nonSubRowToDomain), attributes,
  };
}

/** A subscription gives access now: not refunded, and not expired (a grace period counts). */
export const subActive = (s: SubRow, now: Date) => !s.refundedAt && (!s.expiresDate || s.expiresDate > now || (!!s.gracePeriodExpiresDate && s.gracePeriodExpiresDate > now));

/** The customer's context from loaded data; `headers` are the SDK request's (targeting) and win over stored values where they exist. */
export function buildContext(d: CustomerData, now: Date, activeEntitlements: string[], headers: Partial<CustomerContext> = {}): CustomerContext {
  const ctx = emptyContext();
  Object.assign(ctx, Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== null && v !== undefined)));
  const cu = d.customer;
  ctx.customerId = cu.id;
  ctx.originalAppUserId = cu.originalAppUserId;
  ctx.appUserIds = d.aliases;
  ctx.country = cu.lastSeenCountry ?? ctx.country;
  ctx.platform ??= cu.lastSeenPlatform?.toLowerCase() ?? null;
  ctx.appVersion ??= cu.lastSeenAppVersion;
  ctx.sdkVersion ??= cu.lastSeenSdkVersion;
  ctx.firstSeenAt = cu.firstSeen.getTime();
  ctx.lastSeenAt = cu.lastSeen.getTime();
  ctx.attributes = { ...d.attributes };
  const at = d.attribution;
  ctx.attribution = at
    ? { mediaSource: at.mediaSource, campaign: at.campaign, adGroup: at.adGroup, ad: at.ad, keyword: at.keyword, creative: at.creative }
    : { mediaSource: null, campaign: null, adGroup: null, ad: null, keyword: null, creative: null };
  ctx.totalSpent = Math.round(d.tx.filter((t) => !t.sandbox).reduce((s, t) => s + t.usd, 0) * 100) / 100;
  ctx.totalRenewals = d.tx.filter((t) => t.kind === "renewal").length;
  const renewals = d.tx.filter((t) => t.kind === "renewal").map((t) => t.at.getTime());
  ctx.lastRenewalAt = renewals.length ? Math.max(...renewals) : null;
  const real = d.subs.filter((s) => s.store !== "promotional");
  const active = real.filter((s) => subActive(s, now));
  ctx.isCurrentlyTrialing = active.some((s) => s.periodType === "trial");
  ctx.status = active.length ? (ctx.isCurrentlyTrialing ? "trialing" : "active") : real.length || d.ones.length ? "expired" : "never";
  ctx.anyActiveStore = [...new Set(active.map((s) => s.store))];
  const purchases = [...real.map((s) => ({ at: s.purchaseDate.getTime(), first: s.originalPurchaseDate.getTime(), product: s.productIdentifier, store: s.store, sandbox: s.isSandbox })),
    ...d.ones.map((o) => ({ at: o.purchaseDate.getTime(), first: o.purchaseDate.getTime(), product: o.productIdentifier, store: o.store, sandbox: o.isSandbox }))].sort((a, b) => b.at - a.at);
  ctx.latestProduct = purchases[0]?.product ?? null;
  ctx.latestStore = purchases[0]?.store ?? null;
  ctx.mostRecentPurchaseAt = purchases[0]?.at ?? null;
  ctx.firstPurchaseAt = purchases.length ? Math.min(...purchases.map((p) => p.first)) : null;
  ctx.latestExpirationAt = real.reduce<number | null>((m, s) => (s.expiresDate && (m === null || s.expiresDate.getTime() > m) ? s.expiresDate.getTime() : m), null);
  ctx.hasMadeSandboxPurchase = purchases.some((p) => p.sandbox);
  ctx.hasMadeNonSubscriptionPurchase = d.ones.length > 0;
  ctx.allPurchasedProductIds = [...new Set(purchases.map((p) => p.product))];
  ctx.activeEntitlements = activeEntitlements;
  return ctx;
}

export interface LoadedContext { data: CustomerData; ctx: CustomerContext }

/** Contexts for these customers, active entitlements included (one catalog read per project). */
export async function contextsFor(db: DB, projectId: string, customers: CustomerRow[], now: Date): Promise<LoadedContext[]> {
  const data = await loadCustomerData(db, customers);
  const [map, pa] = await Promise.all([entitlementMap(db, projectId), projectAccess(db, projectId)]);
  return customers.map((c) => {
    const d = data.get(c.id)!;
    const ents = computeEntitlements({ ...stateOf(d), access: accessFor(pa, d.aliases) }, map).filter((e) => isActive(e, now)).map((e) => e.identifier);
    return { data: d, ctx: buildContext(d, now, ents) };
  });
}

/** Most customers a list, preview or policy count looks at. */
export const SCAN_LIMIT = 10_000;

/** The project's most recently seen customers (up to `limit`), with their contexts; `truncated` when there are more. */
export async function projectContexts(db: DB, projectId: string, now: Date, limit = SCAN_LIMIT): Promise<{ items: LoadedContext[]; truncated: boolean }> {
  const rows = await db.select().from(schema.customers).where(eq(schema.customers.projectId, projectId)).orderBy(desc(schema.customers.lastSeen), desc(schema.customers.id)).limit(limit + 1);
  const truncated = rows.length > limit;
  return { items: await contextsFor(db, projectId, rows.slice(0, limit), now), truncated };
}
