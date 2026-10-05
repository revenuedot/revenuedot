import { asc, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema, type DB } from "@revenuedot/db";
import type { CustomerRow } from "../repo/customers.js";
import { contextsFor, projectCatalog, type LoadedContext, type ProjectCatalog } from "./customer-context.js";

/**
 * Whole-project customer scans in bounded pages (prd/lifecycle/PRD.md "Scale"). Built-in lists and search are SQL
 * (`filterSql`); audience conditions run in JavaScript on one page of contexts at a time, so memory stays at one page
 * (1,000 customers) however large the project is. Two orders:
 * - `orderedPages`: the Customers list's order (a sort column, then last seen and id), resumable after any customer.
 * - `idPages`: customer id order, which never changes while a project grows; background counts resume from the last id.
 */

export const PAGE_SIZE = 1_000;
export const BUILT_IN_LISTS = ["all", "active", "sandbox", "non_subscription", "expired"] as const;
export type BuiltInList = (typeof BUILT_IN_LISTS)[number];
export const SORT_KEYS = ["id", "subscription_status", "auto_renewal_status", "first_seen_at", "last_seen_at", "spent_in_usd"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface ScanFilter { list?: BuiltInList; search?: string | null; where?: SQL }

const rowsOf = <T>(res: unknown): T[] => (res as { rows?: T[] }).rows ?? (res as T[]);
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const ANON = "$RCAnonymousID:";

/** Subscription `s` gives access at `now`: not refunded, not expired (a grace period counts). Same as `subActive`. */
const activeSql = (now: Date) => sql`(s.refunded_at IS NULL AND (s.expires_date IS NULL OR s.expires_date > ${at(now)} OR (s.grace_period_expires_date IS NOT NULL AND s.grace_period_expires_date > ${at(now)})))`;
const prodSub = sql`s.customer_id = c.id AND s.store <> 'promotional' AND NOT s.is_sandbox`;

/** The WHERE clause (customers as `c`) for a built-in list and a search; exactly `inBuiltIn` and the list search. */
export function filterSql(projectId: string, f: ScanFilter, now: Date): SQL {
  const parts: SQL[] = [sql`c.project_id = ${projectId}`];
  switch (f.list ?? "all") {
    case "active": parts.push(sql`EXISTS (SELECT 1 FROM subscriptions s WHERE ${prodSub} AND ${activeSql(now)})`); break;
    case "expired": parts.push(sql`EXISTS (SELECT 1 FROM subscriptions s WHERE ${prodSub}) AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE ${prodSub} AND ${activeSql(now)})`); break;
    case "sandbox": parts.push(sql`(EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id AND s.store <> 'promotional' AND s.is_sandbox) OR EXISTS (SELECT 1 FROM non_subscriptions o WHERE o.customer_id = c.id AND o.is_sandbox))`); break;
    case "non_subscription": parts.push(sql`EXISTS (SELECT 1 FROM non_subscriptions o WHERE o.customer_id = c.id AND NOT o.is_sandbox)`); break;
  }
  const s = f.search?.trim().toLowerCase();
  if (s) {
    parts.push(sql`(EXISTS (SELECT 1 FROM customer_aliases a WHERE a.customer_id = c.id AND strpos(lower(a.app_user_id), ${s}) > 0)
      OR EXISTS (SELECT 1 FROM customer_attributes x WHERE x.customer_id = c.id AND x.key = '$email' AND strpos(lower(x.value), ${s}) > 0))`);
  }
  if (f.where) parts.push(f.where);
  return sql.join(parts, sql` AND `);
}

/** The ID a list row shows: the original app user ID unless it is anonymous, else the first other non-anonymous alias. */
const displayIdSql = sql`(CASE WHEN left(c.original_app_user_id, 15) <> ${ANON} THEN c.original_app_user_id
  ELSE coalesce((SELECT min(a.app_user_id COLLATE "C") FROM customer_aliases a WHERE a.customer_id = c.id AND left(a.app_user_id, 15) <> ${ANON}), c.original_app_user_id) END)`;

/** The subscription a row's status and auto-renewal come from: the active one (sandbox too) that expires last. */
const leadSql = (now: Date, col: SQL) => sql`(SELECT ${col} FROM subscriptions s WHERE s.customer_id = c.id AND s.store <> 'promotional' AND ${activeSql(now)} ORDER BY s.expires_date DESC NULLS FIRST LIMIT 1)`;

/**
 * Sort value `k` of each sort column and `nk`, which puts rows without a value last in both directions (anonymous IDs
 * when sorting by ID sort among themselves by the ID shown). Matches customer-lists.ts `sortRows`.
 */
function sortSql(key: SortKey | null, now: Date): { nk: SQL; k: SQL } {
  const plain = (k: SQL) => ({ nk: sql`0`, k });
  const nullable = (k: SQL) => ({ nk: sql`(${k} IS NULL)::int`, k });
  switch (key) {
    case null: case "last_seen_at": return plain(sql`c.last_seen`);
    case "first_seen_at": return plain(sql`c.first_seen`);
    case "spent_in_usd": return plain(sql`round(coalesce((SELECT sum(t.revenue_usd) FROM transactions t WHERE t.customer_id = c.id AND NOT t.is_sandbox), 0)::numeric, 2)`);
    case "id": return { nk: sql`(left(${displayIdSql}, 15) = ${ANON})::int`, k: sql`lower(${displayIdSql}) COLLATE "C"` };
    case "subscription_status": return plain(sql`coalesce(${leadSql(now, sql`CASE WHEN s.grace_period_expires_date > ${at(now)} AND (s.expires_date IS NULL OR s.expires_date <= ${at(now)}) THEN 2
      WHEN s.billing_issues_detected_at IS NOT NULL THEN 3 WHEN s.period_type = 'trial' THEN 1 ELSE 0 END`)},
      CASE WHEN EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id AND s.store <> 'promotional') THEN 4 ELSE 5 END)`);
    case "auto_renewal_status": return nullable(leadSql(now, sql`CASE WHEN s.unsubscribe_detected_at IS NOT NULL THEN 1 ELSE 0 END`));
  }
}

async function rowsByIds(db: DB, ids: string[]): Promise<CustomerRow[]> {
  if (!ids.length) return [];
  const rows = await db.select().from(schema.customers).where(inArray(schema.customers.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is CustomerRow => !!r);
}

export interface OrderedQuery { filter: ScanFilter; sort?: SortKey | null; direction?: "asc" | "desc" }

/**
 * Up to `limit` customers in list order after customer `after` (null: from the start). `null` when `after` is not in the
 * filtered list. Ties keep last seen, then id, newest first.
 */
export async function orderedPage(db: DB, projectId: string, now: Date, q: OrderedQuery, after: string | null, limit: number): Promise<CustomerRow[] | null> {
  const { nk, k } = sortSql(q.sort ?? null, now);
  const asc = (q.direction ?? "asc") === "asc" && !!q.sort;
  const dir = asc ? sql`ASC` : sql`DESC`;
  const base = sql`WITH base AS NOT MATERIALIZED (SELECT c.id, c.last_seen AS ls, ${nk} AS nk, ${k} AS k FROM customers c WHERE ${filterSql(projectId, q.filter, now)})`;
  const order = sql`ORDER BY b.nk, b.k ${dir}, b.ls DESC, b.id DESC LIMIT ${limit}`;
  let ids: string[];
  if (after) {
    const op = asc ? sql`>` : sql`<`;
    const found = rowsOf<{ id: string }>(await db.execute(sql`${base} SELECT id FROM base WHERE id = ${after}`));
    if (!found.length) return null;
    ids = rowsOf<{ id: string }>(await db.execute(sql`${base}
      SELECT b.id FROM base b, (SELECT nk, k, ls, id FROM base WHERE id = ${after}) cur
      WHERE b.nk > cur.nk OR (b.nk = cur.nk AND (b.k ${op} cur.k OR (b.k IS NOT DISTINCT FROM cur.k AND (b.ls < cur.ls OR (b.ls = cur.ls AND b.id < cur.id)))))
      ${order}`)).map((r) => r.id);
  } else {
    ids = rowsOf<{ id: string }>(await db.execute(sql`${base} SELECT b.id FROM base b ${order}`)).map((r) => r.id);
  }
  return rowsByIds(db, ids);
}

/** Customers in id order after `after`, `limit` at most (background counts): one query, rows included. */
export async function idPage(db: DB, projectId: string, now: Date, filter: ScanFilter, after: string | null, limit: number): Promise<CustomerRow[]> {
  const c = alias(schema.customers, "c");
  return db.select().from(c).where(sql`${filterSql(projectId, filter, now)} ${after ? sql`AND c.id > ${after}` : sql``}`).orderBy(asc(c.id)).limit(limit);
}

/** Pages of contexts in id order, from `after` to the end of the project; the catalog is read once. */
export async function* contextPages(db: DB, projectId: string, now: Date, filter: ScanFilter, o: { after?: string | null; pageSize?: number; catalog?: ProjectCatalog } = {}): AsyncGenerator<{ items: LoadedContext[]; last: string; more: boolean }> {
  const size = o.pageSize ?? PAGE_SIZE;
  const catalog = o.catalog ?? await projectCatalog(db, projectId);
  let after = o.after ?? null;
  for (;;) {
    // One extra id tells whether another page follows, so the last page is known without reading an empty one.
    const got = await idPage(db, projectId, now, filter, after, size + 1);
    const rows = got.slice(0, size);
    if (!rows.length) return;
    after = rows[rows.length - 1]!.id;
    yield { items: await contextsFor(db, projectId, rows, now, catalog), last: after, more: got.length > size };
    if (got.length <= size) return;
  }
}

/** Customers in the project (index-only count). */
export async function customerCount(db: DB, projectId: string): Promise<number> {
  const [r] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM customers c WHERE c.project_id = ${projectId}`));
  return Number(r?.n ?? 0);
}

/** A sample reads at most this many pages (10,000 customers), so a rare audience never walks a large project in a request. */
export const SAMPLE_PAGES = 10;

/** The first `n` customers, most recently seen first, that `match`; reads at most `maxPages` pages. */
export async function firstMatches(db: DB, projectId: string, now: Date, filter: ScanFilter, match: (i: LoadedContext) => boolean, n: number, maxPages = SAMPLE_PAGES): Promise<LoadedContext[]> {
  const catalog = await projectCatalog(db, projectId);
  const out: LoadedContext[] = [];
  let after: string | null = null;
  for (let p = 0; p < maxPages && out.length < n; p++) {
    const page = await orderedPage(db, projectId, now, { filter }, after, PAGE_SIZE);
    if (!page?.length) break;
    for (const i of await contextsFor(db, projectId, page, now, catalog)) if (out.length < n && match(i)) out.push(i);
    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1]!.id;
  }
  return out;
}
