import { and, eq, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { contextsFor, projectCatalog, subActive, type LoadedContext } from "./customer-context.js";
import { exactCount, type ListCountSpec } from "./customer-counts.js";
import { BUILT_IN_LISTS, filterSql, orderedPage, PAGE_SIZE, SORT_KEYS, type BuiltInList, type SortKey } from "./customer-scan.js";
import { rulesMatch, type Rules } from "./targeting.js";

/**
 * Customers lists (prd/lifecycle/PRD.md): the built-in lists in the Customers rail, saved audiences, filters from the
 * condition builder, the four summary cards and the CSV export, over every customer of the project. Built-in lists,
 * search and sorting are SQL; audience conditions run on pages of 1,000 contexts (services/customer-scan.ts), and their
 * card counts come from services/customer-counts.ts.
 */

export { BUILT_IN_LISTS, SORT_KEYS, type BuiltInList, type SortKey };

export const prodSubs = (i: LoadedContext) => i.data.subs.filter((s) => s.store !== "promotional" && !s.isSandbox);

/** Built-in lists: production subscriptions decide Active and Expired; Sandbox is anyone with a sandbox purchase. */
export function inBuiltIn(list: BuiltInList, i: LoadedContext, now: Date): boolean {
  switch (list) {
    case "all": return true;
    case "active": return prodSubs(i).some((s) => subActive(s, now));
    case "sandbox": return i.ctx.hasMadeSandboxPurchase;
    case "non_subscription": return i.data.ones.some((o) => !o.isSandbox);
    case "expired": {
      const subs = prodSubs(i);
      // Subscribers whose every subscription has ended (one-time buyers are in Non-subscription).
      return subs.length > 0 && !subs.some((s) => subActive(s, now));
    }
  }
}

export interface ListRow {
  object: "customer_list_row";
  id: string; customer_uuid: string; email: string | null;
  subscription_status: "active" | "trialing" | "grace_period" | "billing_issue" | "expired" | "none";
  auto_renewal_status: "on" | "off" | null;
  first_seen_at: number; last_seen_at: number; spent_in_usd: number;
  latest_purchase: { product_id: string; store: string; purchased_at: number; environment: "production" | "sandbox" } | null;
  country: string | null; platform: string | null;
}

const ANON = "$RCAnonymousID:";
/** The ID a row shows: the original app user ID unless anonymous, else the lowest other non-anonymous alias (SQL: customer-scan.ts). */
export function displayId(original: string, aliases: string[]): string {
  if (!original.startsWith(ANON)) return original;
  return aliases.filter((a) => !a.startsWith(ANON)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))[0] ?? original;
}

export function rowOf(i: LoadedContext, now: Date): ListRow {
  const d = i.data;
  const real = d.subs.filter((s) => s.store !== "promotional");
  const active = real.filter((s) => subActive(s, now)).sort((a, b) => (b.expiresDate?.getTime() ?? Infinity) - (a.expiresDate?.getTime() ?? Infinity));
  const lead = active[0];
  let status: ListRow["subscription_status"] = real.length ? "expired" : "none";
  if (lead) {
    const inGrace = !!lead.gracePeriodExpiresDate && lead.gracePeriodExpiresDate > now && (!lead.expiresDate || lead.expiresDate <= now);
    status = inGrace ? "grace_period" : lead.billingIssuesDetectedAt ? "billing_issue" : lead.periodType === "trial" ? "trialing" : "active";
  }
  const purchases = [
    ...real.map((s) => ({ product_id: s.productIdentifier, store: s.store, purchased_at: s.purchaseDate.getTime(), environment: s.isSandbox ? "sandbox" as const : "production" as const })),
    ...d.ones.map((o) => ({ product_id: o.productIdentifier, store: o.store, purchased_at: o.purchaseDate.getTime(), environment: o.isSandbox ? "sandbox" as const : "production" as const })),
  ].sort((a, b) => b.purchased_at - a.purchased_at);
  return {
    object: "customer_list_row", id: displayId(d.customer.originalAppUserId, d.aliases), customer_uuid: d.customer.id,
    email: d.attributes.$email ?? null, subscription_status: status,
    auto_renewal_status: lead ? (lead.unsubscribeDetectedAt ? "off" : "on") : null,
    first_seen_at: d.customer.firstSeen.getTime(), last_seen_at: d.customer.lastSeen.getTime(), spent_in_usd: i.ctx.totalSpent,
    latest_purchase: purchases[0] ?? null, country: d.customer.lastSeenCountry?.toUpperCase() ?? null, platform: d.customer.lastSeenPlatform,
  };
}

export interface ListQuery { list: string; rules?: Rules | null; search?: string | null; sort?: SortKey | null; direction?: "asc" | "desc" }
interface Resolved { q: ListQuery; builtIn: BuiltInList; audienceRules: Rules | null; js: boolean }

/** The list's built-in part and saved audience; null when the audience does not exist. */
async function resolve(db: DB, projectId: string, q: ListQuery): Promise<Resolved | null> {
  if ((BUILT_IN_LISTS as readonly string[]).includes(q.list)) return { q, builtIn: q.list as BuiltInList, audienceRules: null, js: !!q.rules };
  const [a] = await db.select().from(schema.audiences).where(and(eq(schema.audiences.projectId, projectId), eq(schema.audiences.id, q.list))).limit(1);
  if (!a) return null;
  return { q, builtIn: "all", audienceRules: a.rules as Rules, js: true };
}

const matches = (r: Resolved, i: LoadedContext, now: Date) => inBuiltIn(r.builtIn, i, now)
  && (!r.audienceRules || rulesMatch(i.ctx, r.audienceRules, now.getTime())) && (!r.q.rules || rulesMatch(i.ctx, r.q.rules, now.getTime()));

/**
 * Matching rows in list order after customer `after`, up to `limit` (`null`: to the end), streamed in pages. Without
 * audience conditions SQL picks the rows; with them pages of 1,000 customers are read until enough match.
 * Yields `null` once when `after` is not in the list.
 */
async function* matchingRows(db: DB, projectId: string, r: Resolved, now: Date, after: string | null, limit: number | null): AsyncGenerator<ListRow[] | null> {
  const catalog = await projectCatalog(db, projectId);
  const oq = { filter: { list: r.builtIn, search: r.q.search }, sort: r.q.sort ?? null, direction: r.q.direction };
  let cursor = after, left = limit ?? Infinity;
  while (left > 0) {
    const size = r.js || limit === null ? PAGE_SIZE : Math.min(left, PAGE_SIZE);
    const page = await orderedPage(db, projectId, now, oq, cursor, size);
    if (!page) { if (cursor === after) yield null; return; }
    if (!page.length) return;
    const ctxs = await contextsFor(db, projectId, page, now, catalog);
    const rows = ctxs.filter((i) => !r.js || matches(r, i, now)).slice(0, left).map((i) => rowOf(i, now));
    left -= rows.length;
    if (rows.length) yield rows;
    if (page.length < size) return;
    cursor = page[page.length - 1]!.id;
  }
}

export interface ListSummary {
  object: "customer_list_summary"; customers: number; trialing_subscribers: number; paid_subscribers: number; total_revenue_in_usd: number;
  is_approximate: false; is_counting: boolean; counted_at: number | null;
}

/** The four cards, exact: one SQL query for built-in lists and search; with audience conditions, customer-counts.ts. */
async function summaryOf(db: DB, projectId: string, r: Resolved, now: Date, inlineLimit?: number): Promise<ListSummary> {
  if (r.js) {
    const spec: ListCountSpec = { list: r.builtIn, audience_rules: r.audienceRules, rules: r.q.rules ?? null, search: r.q.search?.trim().toLowerCase() || null };
    const c = await exactCount(db, projectId, "customer_list", spec, now, inlineLimit);
    return { object: "customer_list_summary", ...c.result, is_approximate: false, is_counting: c.counting, counted_at: c.countedAt };
  }
  const at = sql`${now.toISOString()}::timestamptz`;
  const active = sql`(s.refunded_at IS NULL AND (s.expires_date IS NULL OR s.expires_date > ${at} OR (s.grace_period_expires_date IS NOT NULL AND s.grace_period_expires_date > ${at})))`;
  const res = await db.execute(sql`SELECT count(*)::int AS customers, (count(*) FILTER (WHERE ps.trialing))::int AS trialing, (count(*) FILTER (WHERE ps.paid))::int AS paid,
      coalesce(sum(round(coalesce(tx.usd, 0)::numeric, 2)), 0)::float8 AS revenue
    FROM customers c
    LEFT JOIN (SELECT s.customer_id, bool_or(${active} AND s.period_type = 'trial') AS trialing, bool_or(${active} AND s.period_type <> 'trial') AS paid
      FROM subscriptions s WHERE s.project_id = ${projectId} AND s.store <> 'promotional' AND NOT s.is_sandbox GROUP BY s.customer_id) ps ON ps.customer_id = c.id
    LEFT JOIN (SELECT t.customer_id, sum(t.revenue_usd) AS usd FROM transactions t WHERE t.project_id = ${projectId} AND NOT t.is_sandbox GROUP BY t.customer_id) tx ON tx.customer_id = c.id
    WHERE ${filterSql(projectId, { list: r.builtIn, search: r.q.search }, now)}`);
  const [x] = (res as unknown as { rows?: Record<string, number>[] }).rows ?? (res as unknown as Record<string, number>[]);
  return {
    object: "customer_list_summary", customers: Number(x?.customers ?? 0), trialing_subscribers: Number(x?.trialing ?? 0), paid_subscribers: Number(x?.paid ?? 0),
    // The cards count production subscriptions only, like charts; sandbox testers are in the Sandbox list.
    total_revenue_in_usd: Math.round(Number(x?.revenue ?? 0) * 100) / 100, is_approximate: false, is_counting: false, counted_at: now.getTime(),
  };
}

/** One page of the list (`limit` rows after customer `startingAfter`) and its exact summary cards. */
export async function listPage(db: DB, projectId: string, q: ListQuery, now: Date, o: { limit: number; startingAfter?: string | null; inlineLimit?: number }) {
  const r = await resolve(db, projectId, q);
  if (!r) return null;
  const rows: ListRow[] = [];
  for await (const part of matchingRows(db, projectId, r, now, o.startingAfter ?? null, o.limit + 1)) {
    if (!part) return { badCursor: true as const };
    rows.push(...part);
  }
  const page = rows.slice(0, o.limit);
  return { badCursor: false as const, rows: page, next: rows.length > o.limit ? page[page.length - 1]!.customer_uuid : null, summary: await summaryOf(db, projectId, r, now, o.inlineLimit) };
}

/** Every matching row, in list order, a page at a time (the CSV export streams these). */
export async function exportPages(db: DB, projectId: string, q: ListQuery, now: Date): Promise<AsyncGenerator<ListRow[]> | null> {
  const r = await resolve(db, projectId, q);
  if (!r) return null;
  return (async function* () { for await (const part of matchingRows(db, projectId, r, now, null, null)) if (part) yield part; })();
}

export const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  // A text cell that starts with = + - @ (also after spaces or control characters, or as full-width ＝＋－＠) would run as
  // a formula in Excel, Sheets or LibreOffice: a leading apostrophe keeps it text. Numbers are written as numbers.
  const safe = /^[\s\u0000-\u001f]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");

export const CSV_HEAD = "app_user_id,email,subscription_status,auto_renewal_status,first_seen_at,last_seen_at,spent_in_usd,latest_product_id,latest_store,latest_purchase_at,country,platform\r\n";
export const csvLines = (rows: ListRow[]) => rows.map((r) => [r.id, r.email, r.subscription_status, r.auto_renewal_status, iso(r.first_seen_at), iso(r.last_seen_at), r.spent_in_usd.toFixed(2),
  r.latest_purchase?.product_id, r.latest_purchase?.store, iso(r.latest_purchase?.purchased_at), r.country, r.platform].map(csvCell).join(",") + "\r\n").join("");

export const toCsv = (rows: ListRow[]): string => CSV_HEAD + csvLines(rows);
