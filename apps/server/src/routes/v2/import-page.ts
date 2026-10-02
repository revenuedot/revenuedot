// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: writes one page of POST /v2/projects/{id}/import/customers with a fixed number of SQL round trips.
// Docs: https://revenuedot.app/docs/migrate
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { accessEndsAt, isAttributionKey, newId, type AppleAdsNames, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { mergeCustomers, subRowToDomain, type CustomerRow } from "../../repo/customers.js";
import { appleAdsNames, syncAttributionBatch } from "../../repo/attribution.js";
import { applyPurchases } from "../../services/purchases.js";
import { importedAppleChainKey } from "../../services/imported-chains.js";
import type { VerifiedOneTime, VerifiedSubscription } from "../../stores/types.js";
import type { ImportCustomer, ImportPurchase, ImportSub } from "./import.js";

/**
 * Every SQL statement is a network round trip (on Cloud: Worker to Hyperdrive to Postgres, tens of milliseconds), so the
 * page is written in three steps instead of row by row:
 *   1. load every row the page can touch in a few queries (aliases with their customers, attributes, subscriptions by
 *      chain key and by customer, one-time purchases);
 *   2. run the import rules for each customer in order against that working set in memory;
 *   3. write the result with one multi-row statement per table (INSERT ... ON CONFLICT).
 * A merge of existing customers, and `emit_events` (which runs the purchase pipeline), use SQL directly: the working set
 * is written first and loaded again afterwards, so each customer still sees exactly what the customers before it wrote.
 */

export interface Ctx {
  projectId: string;
  now: Date;
  products: (typeof schema.products.$inferSelect)[];
  keys: Map<ImportSub, KeyInfo>;
  emit: boolean;
}
/** `original` is null for an Apple chain keyed by a guess (its first known transaction): store traffic may re-key it later. */
export interface KeyInfo {
  key: string; placeholder: string | null; original: string | null; note?: string;
  /** Apple: the guessed key the chain had before Apple confirmed `original`; an earlier run may have stored the chain under it. */
  guess?: string;
}
export interface Report { id: string; status: "created" | "updated" | "merged"; subscriptions: number; purchases: number; needs_token_refresh: number; notes: string[] }

const C = schema.customers, A = schema.customerAliases, CA = schema.customerAttributes, S = schema.subscriptions, N = schema.nonSubscriptions, T = schema.transactions;
type SubRow = typeof S.$inferSelect;
type NonSubRow = typeof N.$inferSelect;
type TxnRow = typeof T.$inferInsert;

const d = (ms: number | null | undefined) => (typeof ms === "number" ? new Date(ms) : null);
const isApple = (s: string) => s === "app_store" || s === "mac_app_store";
const uniq = <X>(xs: X[]) => [...new Set(xs)];
const K = (...parts: string[]) => parts.join("\u0000");
/** Ids per IN list, and rows per multi-row statement: Postgres takes at most 65,535 parameters per statement. */
const IN_CHUNK = 5000;
const chunks = <X>(xs: X[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const rowChunks = <X extends object>(rows: X[]) => (rows.length ? chunks(rows, Math.max(1, Math.floor(60_000 / Math.max(...rows.map((r) => Object.keys(r).length))))) : []);
/** `SET col = excluded.col` for the columns this import changed; every other column (live SDK traffic's) stays as it is. */
const excluded = <Tb extends object>(table: Tb, cols: readonly (keyof Tb & string)[]) =>
  Object.fromEntries(cols.map((c) => [c, sql.raw(`excluded."${(table[c] as unknown as PgColumn).name}"`)]));

const NON_SUB_COLS = ["customerId", "appId", "productIdentifier", "isSandbox", "isConsumable", "purchaseDate", "refundedAt", "priceAmount", "priceCurrency", "priceUsd", "countryCode"] as const satisfies readonly (keyof NonSubRow)[];
/** Columns of a new subscription row the import does not set (database defaults). */
const SUB_DEFAULTS = { presentedOfferingId: null, cancelSurveyReason: null, offerType: null, offerId: null, eligibleWinBackOfferIds: null, winBackOffersAt: null } satisfies Partial<SubRow>;

const same = (x: unknown, v: unknown) => (v instanceof Date || x instanceof Date ? (x as Date | null)?.getTime?.() === (v as Date | null)?.getTime?.() : x === v);
export function sameState(a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const [k, v] of Object.entries(b)) if (!same(a[k], v)) return false;
  return true;
}
/** Records which columns of `cur` a patch really changes. */
function markChanged(cols: Map<string, Set<string>>, id: string, cur: Record<string, unknown>, patch: Record<string, unknown>) {
  let set = cols.get(id);
  for (const [k, v] of Object.entries(patch)) if (!same(cur[k], v)) { if (!set) cols.set(id, (set = new Set())); set.add(k); }
}
/** Changed rows grouped by the exact columns they changed: one upsert per group sets only those columns. */
function byColumns<R>(cols: Map<string, Set<string>>, row: (id: string) => R) {
  const groups = new Map<string, { cols: string[]; rows: R[] }>();
  for (const [id, set] of cols) {
    const list = [...set].sort();
    const g = groups.get(list.join(",")) ?? { cols: list, rows: [] };
    g.rows.push(row(id));
    groups.set(list.join(","), g);
  }
  return [...groups.values()];
}

/** The rows one page can touch, the changes made to them, and the statements that write those changes. */
class WorkingSet {
  customers = new Map<string, CustomerRow>();
  /** app user id → customer id */
  aliases = new Map<string, string>();
  /** customer id + key → attribute */
  attrs = new Map<string, { value: string | null; updatedAtMs: number }>();
  subs = new Map<string, SubRow>();
  /** store + store key → subscription id */
  subKeys = new Map<string, string>();
  /** store + store transaction id → one-time purchase */
  nonSubs = new Map<string, NonSubRow>();

  private newCustomers = new Set<string>();
  /** customer id → the columns this page changed */
  private changedCustomers = new Map<string, Set<string>>();
  private newAliases: (typeof A.$inferInsert)[] = [];
  private changedAttrs = new Map<string, { customerId: string; key: string }>();
  private newSubs = new Set<string>();
  /** subscription id → the columns this page changed */
  private changedSubs = new Map<string, Set<string>>();
  private goneSubs = new Set<string>();
  private changedNonSubs = new Set<string>();
  private txns = new Map<string, TxnRow>();
  private owners = new Map<string, { store: string; tx: string; customerId: string }>();
  /** Store transactions whose first-or-renewal kind is now known for sure (a confirmed Apple chain); rows of the other kind go. */
  private settledKinds = new Map<string, { store: string; tx: string; renewal: boolean }>();

  /** The project's Apple Search Ads names, loaded once per page when an imported customer has attribution. */
  private names?: AppleAdsNames;

  constructor(readonly db: DB, private projectId: string, private now = new Date()) {}

  /** Loads what `customers` can read: 3 to 5 queries for a page. */
  async load(customers: ImportCustomer[], keys: Map<ImportSub, KeyInfo>) {
    const { db, projectId } = this;
    this.customers.clear(); this.aliases.clear(); this.attrs.clear(); this.subs.clear(); this.subKeys.clear(); this.nonSubs.clear();
    const ids = uniq(customers.flatMap((c) => [c.id, ...(c.aliases ?? [])]));
    for (const part of chunks(ids, IN_CHUNK)) {
      const rows = await db.select({ appUserId: A.appUserId, c: C }).from(A).innerJoin(C, eq(C.id, A.customerId))
        .where(and(eq(A.projectId, projectId), inArray(A.appUserId, part)));
      for (const r of rows) { this.aliases.set(r.appUserId, r.c.id); this.customers.set(r.c.id, r.c); }
    }
    const known = [...this.customers.keys()];
    const names = uniq(customers.flatMap((c) => (c.attributes ?? []).map((a) => a.name)));
    for (const part of chunks(known, IN_CHUNK)) for (const namePart of chunks(names, IN_CHUNK)) {
      const rows = await db.select().from(CA).where(and(inArray(CA.customerId, part), inArray(CA.key, namePart)));
      for (const r of rows) this.attrs.set(K(r.customerId, r.key), { value: r.value, updatedAtMs: r.updatedAtMs });
    }
    // Subscriptions by every chain key the page may use, and every subscription of the page's existing customers
    // (an Apple chain the store re-keyed is found again by its transactions among those).
    const subs = customers.flatMap((c) => c.subscriptions ?? []);
    const chainKeys = uniq(subs.flatMap((s) => {
      const k = keys.get(s)!;
      return [k.key, ...(k.placeholder ? [k.placeholder] : []), ...(k.guess ? [k.guess] : []), ...(s.store === "promotional" ? (s.entitlement_lookup_keys ?? []).slice(1).map((e) => `${k.key}:${e}`) : [])];
    }));
    const stores = uniq(subs.map((s) => s.store));
    const addSub = (r: SubRow) => { this.subs.set(r.id, r); this.subKeys.set(K(r.store, r.storeKey), r.id); };
    for (const part of chunks(chainKeys, IN_CHUNK)) {
      (await db.select().from(S).where(and(eq(S.projectId, projectId), inArray(S.store, stores), inArray(S.storeKey, part)))).forEach(addSub);
    }
    for (const part of chunks(known, IN_CHUNK)) {
      (await db.select().from(S).where(and(eq(S.projectId, projectId), inArray(S.customerId, part)))).forEach(addSub);
    }
    const buys = customers.flatMap((c) => c.purchases ?? []);
    const buyStores = uniq(buys.map((p) => p.store));
    for (const part of chunks(uniq(buys.map((p) => p.store_purchase_identifier)), IN_CHUNK)) {
      const rows = await db.select().from(N).where(and(eq(N.projectId, projectId), inArray(N.store, buyStores), inArray(N.storeTransactionId, part)));
      for (const r of rows) this.nonSubs.set(K(r.store, r.storeTransactionId), r);
    }
  }

  addCustomer(row: CustomerRow) { this.customers.set(row.id, row); this.newCustomers.add(row.id); }
  patchCustomer(id: string, patch: Partial<CustomerRow>) {
    const cur = this.customers.get(id)!;
    if (sameState(cur, patch)) return;
    if (!this.newCustomers.has(id)) markChanged(this.changedCustomers, id, cur, patch);
    this.customers.set(id, { ...cur, ...patch });
  }
  addAlias(appUserId: string, customerId: string, createdAt: Date) {
    if (this.aliases.has(appUserId)) return;
    this.aliases.set(appUserId, customerId);
    this.newAliases.push({ projectId: this.projectId, appUserId, customerId, createdAt });
  }
  attr(customerId: string, key: string) { return this.attrs.get(K(customerId, key)); }
  setAttr(customerId: string, key: string, value: string | null, updatedAtMs: number) {
    this.attrs.set(K(customerId, key), { value, updatedAtMs });
    this.changedAttrs.set(K(customerId, key), { customerId, key });
  }
  sub(store: string, key: string) { const id = this.subKeys.get(K(store, key)); return id ? this.subs.get(id) : undefined; }
  addSub(row: SubRow) { this.subs.set(row.id, row); this.subKeys.set(K(row.store, row.storeKey), row.id); this.newSubs.add(row.id); }
  patchSub(id: string, patch: Partial<SubRow>) {
    const cur = this.subs.get(id)!;
    if (sameState(cur, patch)) return;
    const next = { ...cur, ...patch };
    if (next.storeKey !== cur.storeKey) { this.subKeys.delete(K(cur.store, cur.storeKey)); this.subKeys.set(K(next.store, next.storeKey), id); }
    if (!this.newSubs.has(id)) markChanged(this.changedSubs, id, cur, patch);
    this.subs.set(id, next);
  }
  deleteSub(id: string) {
    const cur = this.subs.get(id)!;
    this.subs.delete(id);
    this.subKeys.delete(K(cur.store, cur.storeKey));
    if (this.newSubs.delete(id)) return;
    this.changedSubs.delete(id);
    this.goneSubs.add(id);
  }
  nonSub(store: string, tx: string) { return this.nonSubs.get(K(store, tx)); }
  putNonSub(row: NonSubRow) { this.nonSubs.set(K(row.store, row.storeTransactionId), row); this.changedNonSubs.add(K(row.store, row.storeTransactionId)); }
  /** Revenue rows are insert-only (the first row for a store transaction and kind stays). */
  addTxn(row: TxnRow) { const k = K(row.store, row.storeTransactionId, row.kind); if (!this.txns.has(k)) this.txns.set(k, row); }
  /** Every revenue row of a store transaction belongs to the customer that last imported it. */
  ownTxn(store: string, tx: string, customerId: string) { this.owners.set(K(store, tx), { store, tx, customerId }); }
  settleKind(store: string, tx: string, renewal: boolean) { this.settledKinds.set(K(store, tx), { store, tx, renewal }); }

  /** Writes every change: one statement per table (more only past the parameter limit). */
  async flush() {
    const { db, projectId } = this;
    for (const part of rowChunks([...this.newCustomers].map((id) => this.customers.get(id)!))) await db.insert(C).values(part);
    for (const g of byColumns(this.changedCustomers, (id) => this.customers.get(id)!)) {
      for (const part of rowChunks(g.rows)) await db.insert(C).values(part).onConflictDoUpdate({ target: C.id, set: excluded(C, g.cols as (keyof typeof C & string)[]) });
    }
    for (const part of rowChunks(this.newAliases)) await db.insert(A).values(part).onConflictDoNothing();
    const attrRows = [...this.changedAttrs].map(([k, { customerId, key }]) => ({ customerId, key, ...this.attrs.get(k)! }));
    for (const part of rowChunks(attrRows)) await db.insert(CA).values(part).onConflictDoUpdate({ target: [CA.customerId, CA.key], set: excluded(CA, ["value", "updatedAtMs"]) });
    // Imported attribution attributes ($mediaSource, $campaign …) also become the customers' first-class attribution rows.
    const attributed = attrRows.filter((r) => isAttributionKey(r.key)).map((r) => r.customerId);
    if (attributed.length) await syncAttributionBatch(db, projectId, attributed, this.now, this.names ??= await appleAdsNames(db, projectId));
    for (const part of chunks([...this.goneSubs], IN_CHUNK)) await db.delete(S).where(inArray(S.id, part));
    // Existing rows before new ones: a placeholder key one row gives up may be taken by a new row.
    for (const g of byColumns(this.changedSubs, (id) => this.subs.get(id)!)) {
      for (const part of rowChunks(g.rows)) await db.insert(S).values(part).onConflictDoUpdate({ target: S.id, set: excluded(S, g.cols as (keyof typeof S & string)[]) });
    }
    for (const part of rowChunks([...this.newSubs].map((id) => this.subs.get(id)!))) await db.insert(S).values(part);
    const nonSubRows = [...this.changedNonSubs].map((k) => this.nonSubs.get(k)!);
    for (const part of rowChunks(nonSubRows)) {
      await db.insert(N).values(part).onConflictDoUpdate({ target: [N.projectId, N.store, N.storeTransactionId], set: excluded(N, NON_SUB_COLS) });
    }
    // A run that keyed a chain by a guessed original recorded its transactions with guessed kinds: drop those once confirmed.
    for (const part of chunks([...this.settledKinds.values()], 5000)) {
      const rows = sql.join(part.map((o) => sql`(${o.store}::text, ${o.tx}::text, ${o.renewal}::boolean)`), sql`, `);
      await db.execute(sql`DELETE FROM transactions AS t USING (VALUES ${rows}) AS v(store, tx, renewal)
        WHERE t.project_id = ${projectId} AND t.store = v.store AND t.store_transaction_id = v.tx
          AND CASE WHEN v.renewal THEN t.kind IN ('purchase', 'trial') ELSE t.kind = 'renewal' END`);
    }
    for (const part of rowChunks([...this.txns.values()])) await db.insert(T).values(part).onConflictDoNothing();
    for (const part of chunks([...this.owners.values()], 5000)) {
      const rows = sql.join(part.map((o) => sql`(${o.store}::text, ${o.tx}::text, ${o.customerId}::text)`), sql`, `);
      await db.execute(sql`UPDATE transactions AS t SET customer_id = v.cid FROM (VALUES ${rows}) AS v(store, tx, cid)
        WHERE t.project_id = ${projectId} AND t.store = v.store AND t.store_transaction_id = v.tx AND t.customer_id <> v.cid`);
    }
    this.newCustomers.clear(); this.changedCustomers.clear(); this.newAliases = []; this.changedAttrs.clear();
    this.newSubs.clear(); this.changedSubs.clear(); this.goneSubs.clear(); this.changedNonSubs.clear(); this.txns.clear(); this.owners.clear(); this.settledKinds.clear();
  }
}

/** Imports one page in order. Call it inside a transaction: the page is written whole or not at all. */
export async function importPage(db: DB, ctx: Ctx, customers: ImportCustomer[]): Promise<Report[]> {
  const ws = new WorkingSet(db, ctx.projectId, ctx.now);
  await ws.load(customers, ctx.keys);
  const out: Report[] = [];
  for (let i = 0; i < customers.length; i++) {
    // Writes the working set, runs `step` in SQL, then loads again for this customer and the ones after it.
    const viaSql = async (step: () => Promise<unknown>) => { await ws.flush(); await step(); await ws.load(customers.slice(i), ctx.keys); };
    out.push(await importCustomer(ws, ctx, customers[i]!, viaSql));
  }
  await ws.flush();
  return out;
}

type ViaSql = (step: () => Promise<unknown>) => Promise<void>;

async function importCustomer(ws: WorkingSet, ctx: Ctx, cu: ImportCustomer, viaSql: ViaSql): Promise<Report> {
  const { projectId, now } = ctx;
  const notes: string[] = [];
  const ids = uniq([cu.id, ...(cu.aliases ?? [])]);
  const firstSeen = d(cu.first_seen_at) ?? now;
  const lastSeen = d(cu.last_seen_at) ?? firstSeen;

  // Every existing customer that holds one of these ids becomes one customer (RevenueCat already merged them).
  const found = uniq(ids.map((id) => ws.aliases.get(id)).filter((x): x is string => !!x)).map((id) => ws.customers.get(id)!);
  let status: Report["status"] = "updated";
  let customerId: string;
  if (!found.length) {
    status = "created";
    customerId = newId("cus_", 16);
    ws.addCustomer({
      id: customerId, projectId, originalAppUserId: cu.id, firstSeen, lastSeen,
      lastSeenAppVersion: cu.last_seen_app_version ?? null, lastSeenCountry: cu.last_seen_country ?? null, lastSeenPlatform: cu.last_seen_platform ?? null,
      lastSeenSdkVersion: null, lastSeenSdkFlavor: null, lastSeenPlatformVersion: null, lastSeenAppBuild: null,
      originalApplicationVersion: null, originalPurchaseDate: null, offeringOverrideId: null,
    });
  } else {
    // The customer that already holds the main id stays; otherwise the oldest one.
    const byId = ws.aliases.get(cu.id);
    const order = byId ? found : [...found].sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime());
    customerId = byId ?? order[0]!.id;
    const others = order.filter((o) => o.id !== customerId);
    if (others.length) {
      status = "merged";
      const into = customerId;
      await viaSql(async () => { for (const o of others) await mergeCustomers(ws.db, o.id, into); });
    }
    const row = ws.customers.get(customerId)!;
    const newer = row.lastSeen <= lastSeen;
    ws.patchCustomer(customerId, {
      firstSeen: row.firstSeen < firstSeen ? row.firstSeen : firstSeen,
      lastSeen: newer ? lastSeen : row.lastSeen,
      ...(newer && cu.last_seen_app_version ? { lastSeenAppVersion: cu.last_seen_app_version } : {}),
      ...(newer && cu.last_seen_country ? { lastSeenCountry: cu.last_seen_country } : {}),
      ...(newer && cu.last_seen_platform ? { lastSeenPlatform: cu.last_seen_platform } : {}),
    });
  }
  for (const id of ids) ws.addAlias(id, customerId, firstSeen);

  // Attributes keep their source timestamps; a newer value already here wins (the rule of repo/customers.ts setAttributes).
  const attrs = Object.fromEntries((cu.attributes ?? []).map((a) => [a.name, a]));
  for (const [key, a] of Object.entries(attrs)) {
    const value = a.value === null || a.value === "" ? null : String(a.value);
    const updatedAtMs = Number(a.updated_at ?? 0);
    const cur = ws.attr(customerId, key);
    if (cur && cur.updatedAtMs > updatedAtMs) continue;
    if (cur && cur.value === value && cur.updatedAtMs === updatedAtMs) continue;
    ws.setAttr(customerId, key, value, updatedAtMs);
  }

  let pending = 0;
  // Oldest period first: when two source subscriptions share a store chain (an Apple resubscribe), the latest state wins.
  const subs = [...(cu.subscriptions ?? [])].sort((a, b) => a.current_period_starts_at - b.current_period_starts_at);
  for (const s of subs) {
    const k = ctx.keys.get(s)!;
    if (k.note) notes.push(k.note);
    if (k.placeholder && k.key === k.placeholder) pending++;
    await importSubscription(ws, ctx, customerId, cu, s, k, notes, viaSql);
  }
  for (const p of cu.purchases ?? []) await importPurchase(ws, ctx, customerId, cu, p, notes, viaSql);

  return { id: cu.id, status, subscriptions: subs.length, purchases: cu.purchases?.length ?? 0, needs_token_refresh: pending, notes: uniq(notes) };
}

/** Maps an imported subscription to the stored fields, with deterministic detection times so re-imports change nothing. */
function toVerified(s: ImportSub, k: KeyInfo, notes: string[]): VerifiedSubscription & { entitlement: string | null } {
  const google = s.store === "play_store";
  const [product, plan] = google && s.product_identifier.includes(":") ? s.product_identifier.split(":", 2) as [string, string] : [s.product_identifier, null];
  const periodStart = new Date(s.current_period_starts_at);
  const periodEnd = d(s.current_period_ends_at);
  const promo = s.store === "promotional";
  const renewalOff = s.auto_renewal_status === "will_not_renew" || s.auto_renewal_status === "requires_price_increase_consent";
  const billing = s.status === "in_grace_period" || s.status === "in_billing_retry";
  let expiresDate: Date | null = periodEnd;
  if (!expiresDate && !promo) expiresDate = periodStart; // paused until an indefinite date: no access now
  const lastTx = [...(s.transactions ?? [])].sort((a, b) => b.purchased_at - a.purchased_at)[0];
  const lastTxEnd = d(lastTx?.expires_at ?? null);
  // The store already renewed (RevenueCat: has_already_renewed): its newest transaction starts at or after the period
  // end and runs past it, so access lasts to that transaction's expiry, as RevenueCat's ends_at says.
  if (expiresDate && lastTx && lastTxEnd && lastTxEnd > expiresDate && lastTx.purchased_at >= expiresDate.getTime() - 86_400_000
    && s.status !== "expired" && s.status !== "in_grace_period") {
    expiresDate = lastTxEnd;
  }
  let grace: Date | null = null;
  if (s.status === "in_grace_period") {
    const latestTxEnd = d(Math.max(...(s.transactions ?? []).map((t) => t.expires_at ?? 0), 0) || null);
    grace = d(s.grace_period_expires_at) ?? latestTxEnd;
    if (expiresDate && latestTxEnd && latestTxEnd < expiresDate && !(grace && grace > expiresDate)) {
      // RevenueCat reports a subscription in its grace period with the grace end as the period end; the paid period
      // ended at the newest transaction's expiry.
      grace = expiresDate;
      expiresDate = latestTxEnd;
    } else if (!grace || (expiresDate && grace <= expiresDate)) {
      grace = new Date((expiresDate ?? periodStart).getTime() + 7 * 86_400_000);
      notes.push(`${s.store_subscription_identifier}: grace period end unknown; assumed 7 days after the period end.`);
    }
  }
  const price = s.price ?? lastTx?.price ?? null;
  return {
    kind: "subscription", store: s.store as Store, storeKey: k.key, productIdentifier: product, productPlanIdentifier: plan,
    isSandbox: s.environment === "sandbox", purchaseDate: periodStart, originalPurchaseDate: new Date(s.starts_at), expiresDate,
    periodType: s.period_type ?? (promo ? "promotional" : s.status === "trialing" ? "trial" : "normal"),
    ownershipType: s.ownership === "family_shared" ? "FAMILY_SHARED" : "PURCHASED",
    unsubscribeDetectedAt: d(s.unsubscribe_detected_at) ?? (!promo && (renewalOff || billing || s.status === "expired") ? periodStart : null),
    billingIssuesDetectedAt: d(s.billing_issues_detected_at) ?? (billing ? expiresDate ?? periodStart : null),
    gracePeriodExpiresDate: grace, refundedAt: d(s.refunded_at),
    autoResumeDate: s.status === "paused" ? d(s.auto_resume_at) ?? periodEnd ?? periodStart : d(s.auto_resume_at),
    storeTransactionId: s.store_subscription_identifier, originalTransactionId: k.original,
    price, countryCode: s.country ? s.country.toUpperCase() : null,
    autoRenewProductId: s.auto_renew_product_identifier ?? null,
    entitlement: promo ? s.entitlement_lookup_keys?.[0] ?? null : null,
  };
}

const lastUsd = (s: ImportSub) => [...(s.transactions ?? [])].sort((a, b) => b.purchased_at - a.purchased_at)[0]?.revenue_usd ?? null;

async function importSubscription(ws: WorkingSet, ctx: Ctx, customerId: string, cu: ImportCustomer, s: ImportSub, k: KeyInfo, notes: string[], viaSql: ViaSql) {
  const { projectId, now } = ctx;
  // A token found on a later run upgrades the placeholder row in place.
  if (k.placeholder && k.key !== k.placeholder) {
    const ph = ws.sub(s.store, k.placeholder);
    const real = ws.sub(s.store, k.key);
    if (ph && !real) ws.patchSub(ph.id, { storeKey: k.key });
    else if (ph && real) ws.deleteSub(ph.id);
  }
  // Apple confirmed an original id that differs from the guess an earlier run keyed the chain by: move that row to it,
  // or drop it when the confirmed chain already has a row (the two were halves of one chain).
  if (k.guess && k.guess !== k.key) {
    const guessed = ws.sub(s.store, k.guess);
    if (guessed && guessed.customerId === customerId) {
      if (!ws.sub(s.store, k.key)) ws.patchSub(guessed.id, { storeKey: k.key });
      else ws.deleteSub(guessed.id);
    }
  }
  // An Apple chain the store already re-keyed (a receipt came after an earlier run) is found again by its transactions.
  if (isApple(s.store) && !k.original) {
    const same = ws.sub(s.store, k.key);
    const rekeyed = same ? null : importedAppleChainKey(ws.subs.values(), s.store, customerId, [s.store_subscription_identifier, ...(s.transactions ?? []).map((t) => t.id)]);
    if (rekeyed) k = { ...k, key: rekeyed, original: rekeyed };
  }
  const promoKeys = s.store === "promotional" ? (s.entitlement_lookup_keys?.length ? s.entitlement_lookup_keys : [null]) : [null];
  for (const [i, ent] of promoKeys.entries()) {
    const v = toVerified(s, i === 0 ? k : { ...k, key: `${k.key}:${ent}` }, notes);
    if (ent) v.entitlement = ent;
    const existing = ws.sub(s.store, v.storeKey);
    if (existing && existing.customerId !== customerId) notes.push(`${s.store} ${v.storeKey} moved from another customer to ${cu.id}.`);
    // Live traffic already recorded a newer period: keep it, only fix the owner and the chain's start.
    if (existing && existing.purchaseDate > v.purchaseDate) {
      ws.patchSub(existing.id, {
        customerId,
        originalPurchaseDate: existing.originalPurchaseDate < v.originalPurchaseDate ? existing.originalPurchaseDate : v.originalPurchaseDate,
      });
      continue;
    }
    // A detection time already stored stays put while the state it describes is unchanged.
    const keep = (prev: Date | null | undefined, next: Date | null | undefined) => (next && prev ? prev : next ?? null);
    const values = {
      projectId, customerId, appId: s.app_id ?? existing?.appId ?? null, store: v.store, storeKey: v.storeKey,
      productIdentifier: v.productIdentifier, productPlanIdentifier: v.productPlanIdentifier ?? null, isSandbox: v.isSandbox,
      purchaseDate: v.purchaseDate,
      originalPurchaseDate: existing && existing.originalPurchaseDate < v.originalPurchaseDate ? existing.originalPurchaseDate : v.originalPurchaseDate,
      expiresDate: v.expiresDate, periodType: v.periodType, ownershipType: v.ownershipType ?? "PURCHASED",
      unsubscribeDetectedAt: keep(existing?.unsubscribeDetectedAt, v.unsubscribeDetectedAt),
      billingIssuesDetectedAt: keep(existing?.billingIssuesDetectedAt, v.billingIssuesDetectedAt),
      gracePeriodExpiresDate: v.gracePeriodExpiresDate ?? null, refundedAt: v.refundedAt ?? null, autoResumeDate: v.autoResumeDate ?? null,
      storeTransactionId: v.storeTransactionId, originalTransactionId: v.originalTransactionId ?? null,
      priceAmount: v.price?.amount ?? null, priceCurrency: v.price?.currency ?? null,
      priceUsd: v.price ? (v.price.currency === "USD" ? v.price.amount : lastUsd(s)) : null,
      countryCode: v.countryCode ?? null, autoRenewProductId: v.autoRenewProductId ?? null,
      entitlementIdentifier: v.entitlement,
      // Why auto-renew is off, and a pending price increase, as the store adapters record them.
      cancelReason: !v.unsubscribeDetectedAt ? null : s.auto_renewal_status === "requires_price_increase_consent" ? "PRICE_INCREASE"
        : v.billingIssuesDetectedAt ? "BILLING_ERROR" : existing?.cancelReason ?? null,
      priceIncreaseStatus: s.auto_renewal_status === "requires_price_increase_consent" ? "pending" : existing?.priceIncreaseStatus === "accepted" ? "accepted" : null,
    };
    // Access that already ended counts as expired, so the expiration job does not send EXPIRATION for old history.
    const end = accessEndsAt(subRowToDomain({ ...(existing ?? {}), ...values, id: existing?.id ?? "" } as SubRow));
    const expiredEventAt = end !== null && end <= now ? existing?.expiredEventAt ?? end : null;
    if (ctx.emit) {
      const customer = ws.customers.get(customerId)!;
      await viaSql(async () => {
        await applyPurchases(ws.db, customer, [v], { projectId, appId: values.appId, appUserId: cu.id, now, fromDevice: false });
        await ws.db.update(S).set({ appId: values.appId, entitlementIdentifier: v.entitlement, originalPurchaseDate: values.originalPurchaseDate })
          .where(and(eq(S.projectId, projectId), eq(S.store, s.store), eq(S.storeKey, v.storeKey)));
      });
      continue;
    }
    const updatedAt = existing && sameState(existing, values) ? existing.updatedAt : now;
    if (existing) ws.patchSub(existing.id, { ...values, expiredEventAt, updatedAt });
    else ws.addSub({ ...SUB_DEFAULTS, id: newId("sub_", 16), ...values, expiredEventAt, updatedAt });
    importTransactions(ws, ctx, customerId, s, values);
  }
  const cur = ws.customers.get(customerId);
  const start = new Date(s.starts_at);
  if (cur && (!cur.originalPurchaseDate || cur.originalPurchaseDate > start)) ws.patchCustomer(customerId, { originalPurchaseDate: start });
}

/** Revenue history for charts: one row per store transaction (idempotent on the store transaction id). */
function importTransactions(ws: WorkingSet, ctx: Ctx, customerId: string, s: ImportSub, v: { appId: string | null; storeKey: string; originalTransactionId: string | null; productIdentifier: string; isSandbox: boolean; countryCode: string | null }) {
  const txs = s.transactions?.length ? s.transactions : [{ id: s.store_subscription_identifier, purchased_at: s.current_period_starts_at, expires_at: s.current_period_ends_at ?? null, revenue_usd: s.total_revenue_usd ?? null, price: s.price ?? null }];
  const first = v.originalTransactionId ?? v.storeKey;
  for (const t of txs) {
    const revenue = t.revenue_usd ?? (t.price?.currency === "USD" ? t.price.amount : 0);
    const kind = t.id === first || txs.length === 1 && !s.transactions?.length ? (revenue === 0 && s.status === "trialing" ? "trial" : "purchase") : "renewal";
    ws.addTxn({
      id: newId("txn_", 16), projectId: ctx.projectId, customerId, appId: v.appId, store: s.store, storeTransactionId: t.id,
      productIdentifier: v.productIdentifier, kind, isSandbox: v.isSandbox, purchasedAt: new Date(t.purchased_at), expiresAt: d(t.expires_at),
      revenueUsd: revenue, priceAmount: t.price?.amount ?? null, priceCurrency: t.price?.currency ?? null, countryCode: v.countryCode,
    });
    if (isApple(s.store) && v.originalTransactionId) ws.settleKind(s.store, t.id, kind === "renewal");
  }
  // A transaction moved to another customer by a merge or transfer follows its chain.
  for (const t of txs) ws.ownTxn(s.store, t.id, customerId);
}

async function importPurchase(ws: WorkingSet, ctx: Ctx, customerId: string, cu: ImportCustomer, p: ImportPurchase, notes: string[], viaSql: ViaSql) {
  const { projectId, now } = ctx;
  const product = ctx.products.find((x) => x.storeIdentifier === p.product_identifier && (!p.app_id || x.appId === p.app_id));
  const refundedAt = p.status === "refunded" ? d(p.refunded_at) ?? new Date(p.purchased_at) : null;
  const v: VerifiedOneTime = {
    kind: "non_subscription", store: p.store as Store, productIdentifier: p.product_identifier, storeTransactionId: p.store_purchase_identifier,
    isSandbox: p.environment === "sandbox", isConsumable: p.consumable ?? product?.type === "consumable", purchaseDate: new Date(p.purchased_at),
    refundedAt, price: p.price ?? null, countryCode: p.country ? p.country.toUpperCase() : null,
  };
  const existing = ws.nonSub(p.store, p.store_purchase_identifier);
  if (existing && existing.customerId !== customerId) notes.push(`${p.store} purchase ${p.store_purchase_identifier} moved from another customer to ${cu.id}.`);
  if (ctx.emit) {
    const customer = ws.customers.get(customerId)!;
    await viaSql(() => applyPurchases(ws.db, customer, [v], { projectId, appId: p.app_id ?? null, appUserId: cu.id, now, fromDevice: false }));
    return;
  }
  const revenueUsd = p.revenue_usd ?? (p.price?.currency === "USD" ? p.price.amount : null);
  const values = {
    projectId, customerId, appId: p.app_id ?? existing?.appId ?? null, store: p.store, productIdentifier: p.product_identifier,
    storeTransactionId: p.store_purchase_identifier, isSandbox: v.isSandbox, isConsumable: v.isConsumable, purchaseDate: v.purchaseDate,
    refundedAt: existing?.refundedAt && refundedAt ? existing.refundedAt : refundedAt, priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null,
    priceUsd: revenueUsd, countryCode: v.countryCode ?? null,
  };
  if (!existing || !sameState(existing, values)) ws.putNonSub(existing ? { ...existing, ...values } : { id: newId("", 10), presentedOfferingId: null, ...values });
  const row = (kind: string, sign: number, at: Date): TxnRow => ({
    id: newId("txn_", 16), projectId, customerId, appId: values.appId, store: p.store, storeTransactionId: p.store_purchase_identifier,
    productIdentifier: p.product_identifier, kind, isSandbox: v.isSandbox, purchasedAt: at, revenueUsd: sign * (revenueUsd ?? 0),
    priceAmount: p.price?.amount ?? null, priceCurrency: p.price?.currency ?? null, countryCode: v.countryCode ?? null,
  });
  ws.addTxn(row("one_time", 1, v.purchaseDate));
  if (values.refundedAt) ws.addTxn(row("refund", -1, values.refundedAt));
  ws.ownTxn(p.store, p.store_purchase_identifier, customerId);
}
