import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { LoadedContext } from "./customer-context.js";
import { projectCatalog } from "./customer-context.js";
import { contextPages, customerCount, type BuiltInList, type ScanFilter } from "./customer-scan.js";
import { inBuiltIn, prodSubs } from "./customer-lists.js";
import { subActive } from "./customer-context.js";
import { rulesMatch, type Rules } from "./targeting.js";
import { choosePolicy, type PolicyRow } from "./refunds.js";
import { winbackCounter, type WinbackCountSpec } from "./winback.js";

/**
 * Exact counts over every customer of a project (prd/lifecycle/PRD.md "Scale"). A project with at most `inlineLimit`
 * customers is counted in the request, page by page. A larger one is counted by the tick (`runCountJobs`), which walks
 * the project in id order from a saved cursor within a time budget per tick; the request answers the last stored count
 * with when it was made, or "counting" the first time. Each kind adds one customer at a time into JSON totals, so a
 * count can stop after any page and go on in the next tick.
 */

/** Projects up to this many customers are counted in the request (a few pages; measured in the PRD). */
export const INLINE_LIMIT = 5_000;
/** A stored count older than this is refreshed in the background (the old one is shown until then). */
export const FRESH_MS = 10 * 60_000;
/** Counts nobody asked for in this long are removed. */
export const KEEP_MS = 7 * 86_400_000;
const LEASE_MS = 2 * 60_000;

export interface ListCountSpec { list: BuiltInList; audience_rules: Rules | null; rules: Rules | null; search: string | null }
export interface ListCounts { customers: number; trialing_subscribers: number; paid_subscribers: number; total_revenue_in_usd: number }
export interface AudienceCounts { total_customers: number; active_subscriptions: number; active_trials: number; total_revenue: number }
export interface PolicyCounts { byPolicy: Record<string, number>; default: number }

interface Counter<S, A, P = unknown> {
  filter(spec: S): ScanFilter;
  prepare?(db: DB, projectId: string, spec: S): Promise<P>;
  empty(spec: S): A;
  add(acc: A, item: LoadedContext, spec: S, now: Date, prep: P): void;
  finish?(acc: A): A;
}

const cents = (n: number) => Math.round(n * 100) / 100;

const COUNTERS = {
  customer_list: {
    filter: (s) => ({ list: s.list, search: s.search }),
    empty: () => ({ customers: 0, trialing_subscribers: 0, paid_subscribers: 0, total_revenue_in_usd: 0 }),
    add(acc, i, s, now) {
      const t = now.getTime();
      if (!inBuiltIn(s.list, i, now) || (s.audience_rules && !rulesMatch(i.ctx, s.audience_rules, t)) || (s.rules && !rulesMatch(i.ctx, s.rules, t))) return;
      acc.customers++;
      if (prodSubs(i).some((x) => subActive(x, now) && x.periodType === "trial")) acc.trialing_subscribers++;
      if (prodSubs(i).some((x) => subActive(x, now) && x.periodType !== "trial")) acc.paid_subscribers++;
      acc.total_revenue_in_usd += i.ctx.totalSpent;
    },
    finish: (a) => ({ ...a, total_revenue_in_usd: cents(a.total_revenue_in_usd) }),
  } satisfies Counter<ListCountSpec, ListCounts>,
  audience: {
    filter: () => ({}),
    empty: () => ({ total_customers: 0, active_subscriptions: 0, active_trials: 0, total_revenue: 0 }),
    add(acc, i, s, now) {
      if (!rulesMatch(i.ctx, s.rules, now.getTime())) return;
      acc.total_customers++;
      if (i.ctx.status === "active") acc.active_subscriptions++;
      if (i.ctx.status === "trialing") acc.active_trials++;
      acc.total_revenue += i.ctx.totalSpent;
    },
    finish: (a) => ({ ...a, total_revenue: cents(a.total_revenue) }),
  } satisfies Counter<{ rules: Rules }, AudienceCounts>,
  refund_policies: {
    filter: () => ({}),
    empty: (s) => ({ byPolicy: Object.fromEntries(s.policies.map((p) => [p.id, 0])), default: 0 }),
    prepare: async (_db, _p, s) => s.policies.map((p, position) => ({ id: p.id, name: p.id, rules: p.rules, preference: "do_not_respond", position })),
    add(acc, i, _s, now, rows) {
      const d = choosePolicy(rows, i.ctx, now.getTime(), "do_not_respond");
      if (d.policyId) acc.byPolicy[d.policyId] = (acc.byPolicy[d.policyId] ?? 0) + 1; else acc.default++;
    },
  } satisfies Counter<{ policies: { id: string; rules: Rules }[] }, PolicyCounts, PolicyRow[]>,
  // A getter: winback.ts imports this file too, so its counter is read when used, not while the modules load.
  get winback() { return winbackCounter; },
};

interface Specs { customer_list: ListCountSpec; audience: { rules: Rules }; refund_policies: { policies: { id: string; rules: Rules }[] }; winback: WinbackCountSpec }
interface Results { customer_list: ListCounts; audience: AudienceCounts; refund_policies: PolicyCounts; winback: { eligible: number } }
export type CountKind = keyof Specs;
type SpecOf<K extends CountKind> = Specs[K];
type ResultOf<K extends CountKind> = Results[K];
// The registry is heterogeneous; inside this file each kind is driven through this one shape.
const counterOf = (k: string) => (COUNTERS as unknown as Record<string, Counter<unknown, Record<string, unknown>> | undefined>)[k];
const counter = (k: CountKind) => counterOf(k)!;

async function keyOf(projectId: string, kind: string, spec: unknown) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([projectId, kind, spec]))));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Counts every customer of the project now, page by page (memory stays at one page). */
export async function countAll<K extends CountKind>(db: DB, projectId: string, kind: K, spec: SpecOf<K>, now: Date): Promise<ResultOf<K>> {
  const c = counter(kind);
  const prep = c.prepare ? await c.prepare(db, projectId, spec) : undefined;
  let acc = c.empty(spec);
  for await (const page of contextPages(db, projectId, now, c.filter(spec))) for (const i of page.items) c.add(acc, i, spec, now, prep);
  if (c.finish) acc = c.finish(acc);
  return acc as ResultOf<K>;
}

export interface CountAnswer<R> { result: R; counting: boolean; countedAt: number | null }

/**
 * The exact count for the request: counted now for a project up to `inlineLimit` customers; otherwise the stored count
 * (refreshed in the background when older than FRESH_MS), or `counting` with empty totals until the first one is stored.
 */
export async function exactCount<K extends CountKind>(db: DB, projectId: string, kind: K, spec: SpecOf<K>, now: Date, inlineLimit = INLINE_LIMIT): Promise<CountAnswer<ResultOf<K>>> {
  if (await customerCount(db, projectId) <= inlineLimit) return { result: await countAll(db, projectId, kind, spec, now), counting: false, countedAt: now.getTime() };
  const T = schema.customerCounts;
  const key = await keyOf(projectId, kind, spec);
  const [row] = await db.select().from(T).where(eq(T.key, key)).limit(1);
  if (!row) {
    await db.insert(T).values({ key, projectId, kind, spec, state: "pending", requestedAt: now, readAt: now }).onConflictDoNothing();
    return { result: counter(kind).empty(spec) as ResultOf<K>, counting: true, countedAt: null };
  }
  const stale = !row.countedAt || now.getTime() - row.countedAt.getTime() > FRESH_MS;
  if ((stale && row.state === "idle") || now.getTime() - row.readAt.getTime() > 3600_000) {
    await db.update(T).set({ readAt: now, ...(stale && row.state === "idle" ? { state: "pending", requestedAt: now, cursor: null, partial: null, asOf: null } : {}) }).where(eq(T.key, key));
  }
  if (!row.result) return { result: counter(kind).empty(spec) as ResultOf<K>, counting: true, countedAt: null };
  return { result: row.result as ResultOf<K>, counting: false, countedAt: row.countedAt?.getTime() ?? null };
}

/**
 * The tick's share: go on with pending counts, oldest request first, page by page until `budgetMs` (wall clock) is
 * spent. Progress is saved after every page under a lease, so a stopped Worker loses at most one page and two ticks
 * never count the same pass. Returns the number of pages counted.
 */
export async function runCountJobs(db: DB, now: Date, o: { budgetMs?: number; pageSize?: number; clock?: () => number } = {}): Promise<{ pages: number; finished: number }> {
  const T = schema.customerCounts;
  const clock = o.clock ?? Date.now;
  const until = clock() + (o.budgetMs ?? 15_000);
  let pages = 0, finished = 0;
  await db.delete(T).where(lt(T.readAt, new Date(now.getTime() - KEEP_MS)));
  // At least one page per tick, then pages until the budget is spent.
  while (pages === 0 || clock() < until) {
    const [due] = await db.select().from(T).where(and(eq(T.state, "pending"), or(isNull(T.leaseUntil), lt(T.leaseUntil, now)))).orderBy(asc(T.requestedAt)).limit(1);
    if (!due) break;
    const leased = await db.update(T).set({ leaseUntil: new Date(now.getTime() + LEASE_MS) })
      .where(and(eq(T.key, due.key), eq(T.state, "pending"), or(isNull(T.leaseUntil), lt(T.leaseUntil, now)))).returning({ key: T.key });
    if (!leased.length) continue;
    const c = counterOf(due.kind);
    if (!c) { await db.delete(T).where(eq(T.key, due.key)); continue; }
    const asOf = due.asOf ?? now;
    const prep = c.prepare ? await c.prepare(db, due.projectId, due.spec) : undefined;
    let acc = (due.partial as Record<string, unknown> | null) ?? c.empty(due.spec);
    let done = false;
    const catalog = await projectCatalog(db, due.projectId);
    const pagesOf = contextPages(db, due.projectId, asOf, c.filter(due.spec), { after: due.cursor, pageSize: o.pageSize, catalog });
    for (;;) {
      const next = await pagesOf.next();
      if (next.done) { done = true; break; }
      for (const i of next.value.items) c.add(acc, i, due.spec, asOf, prep);
      pages++;
      if (!next.value.more) { done = true; break; }
      await db.update(T).set({ cursor: next.value.last, partial: acc, asOf }).where(eq(T.key, due.key));
      if (clock() >= until) break;
    }
    if (done) {
      if (c.finish) acc = c.finish(acc);
      await db.update(T).set({ result: acc, countedAt: new Date(Math.max(now.getTime(), asOf.getTime())), state: "idle", cursor: null, partial: null, asOf: null, leaseUntil: null }).where(eq(T.key, due.key));
      finished++;
    } else {
      await db.update(T).set({ leaseUntil: null }).where(eq(T.key, due.key));
      break;
    }
  }
  return { pages, finished };
}

/** The share of a project's pending counts (for tests and the API's "counting" state). */
export async function pendingCounts(db: DB, projectId: string): Promise<number> {
  const T = schema.customerCounts;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(T).where(and(eq(T.projectId, projectId), eq(T.state, "pending")));
  return Number(r?.n ?? 0);
}

export type { WinbackCountSpec };
