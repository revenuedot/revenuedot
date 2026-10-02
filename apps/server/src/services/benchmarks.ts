import { and, asc, desc, eq, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import {
  aggregateBenchmarks, ALL, BENCHMARK_CATEGORIES, BENCHMARK_METRICS, benchmarkWindow, compareToPeers, isoDay, K_ANONYMITY, projectBenchmarkSlices,
  type BenchmarkAggregate, type BenchmarkContribution, type BenchmarkMetricId, type MetricValues,
} from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { loadChartInput } from "./charts/load.js";

/**
 * Benchmarks (prd/attribution-benchmarks-insights §2), RevenueDot Cloud only:
 * - `runBenchmarkJob`: called by the Worker's cron every minute. From START_HOUR UTC it computes the values of sharing
 *   projects not yet done today (within a time budget per tick), then rebuilds today's aggregates once all are done.
 * - `setBenchmarkSharing`: turning sharing off deletes the project's values and rebuilds the aggregates without it at once.
 * - `benchmarksFor`: what the Benchmarks page and API show one project: its own values and the published peer groups.
 * Production data never leaves the Worker: nothing here runs on a laptop against production.
 */

export const START_HOUR = 2;
const PV = schema.benchmarkProjectValues, AG = schema.benchmarkAggregates, RUNS = schema.benchmarkRuns, P = schema.projects;

export interface BenchmarkOptions {
  /** k-anonymity threshold (default K_ANONYMITY = 10; tests may not go lower than 2). */
  k?: number;
  kDeciles?: number;
  minSample?: Partial<Record<BenchmarkMetricId, number>>;
}

const categoryIds = new Set<string>(BENCHMARK_CATEGORIES.map((c) => c.id));
export const isCategory = (c: unknown): c is string => typeof c === "string" && categoryIds.has(c);

/** Computes one sharing project's slices and replaces its stored values. */
export async function computeProjectBenchmarks(db: DB, projectId: string, category: string, now: Date, o: BenchmarkOptions = {}) {
  const w = benchmarkWindow(now.getTime());
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const input = await loadChartInput(db, {
    projectId, sandbox: false, now, currency: "USD", fetch: null,
    // Ad revenue counts in ARPU; activity days give active customers.
    sources: { sdkTypes: ["rc_ads_ad_revenue"], activity: { from: iso(w.from), to: iso(w.to) }, refundRequests: false },
  });
  const slices = projectBenchmarkSlices(input, { minSample: o.minSample });
  const day = isoDay(now.getTime());
  await db.transaction(async (tx) => {
    await tx.delete(PV).where(eq(PV.projectId, projectId));
    await tx.insert(PV).values(slices.map((s) => ({ projectId, platform: s.platform, country: s.country, category, metrics: s.metrics as Record<string, { value: number | null; sample: number }>, computedOn: day, computedAt: now })));
  });
  return slices.length;
}

/** Rebuilds every published group from the values of projects that share now. Returns how many groups were published. */
export async function rebuildAggregates(db: DB, now: Date, o: BenchmarkOptions = {}): Promise<number> {
  const rows = await db.select({ projectId: PV.projectId, platform: PV.platform, country: PV.country, metrics: PV.metrics, category: P.benchmarksCategory })
    .from(PV).innerJoin(P, eq(P.id, PV.projectId)).where(and(eq(P.benchmarksShare, true), isNotNull(P.benchmarksCategory)));
  const contributions: BenchmarkContribution[] = rows.map((r) => ({ projectId: r.projectId, category: r.category!, platform: r.platform, country: r.country, metrics: r.metrics as MetricValues }));
  const groups = aggregateBenchmarks(contributions, { k: o.k, kDeciles: o.kDeciles });
  const day = isoDay(now.getTime());
  await db.transaction(async (tx) => {
    await tx.delete(AG);
    for (let i = 0; i < groups.length; i += 500) await tx.insert(AG).values(groups.slice(i, i + 500).map((g) => ({ ...g, computedOn: day })));
  });
  return groups.length;
}

/**
 * The nightly job, one step per call. Returns what it did. Off unless the deployment has benchmarks (Cloud).
 * `budgetMs` bounds the time spent computing projects in one call; the cron calls it every minute until done.
 */
export async function runBenchmarkJob(d: { db: DB; benchmarks?: boolean }, now: Date, o: BenchmarkOptions & { budgetMs?: number; force?: boolean } = {}) {
  const out = { computed: 0, aggregated: false, groups: 0 };
  if (!d.benchmarks) return out;
  if (!o.force && now.getUTCHours() < START_HOUR) return out;
  const { db } = d;
  const day = isoDay(now.getTime());
  await db.insert(RUNS).values({ day, startedAt: now }).onConflictDoNothing();
  const started = Date.now();
  const budget = o.budgetMs ?? 20_000;
  for (;;) {
    // Sharing projects without values computed today, oldest first.
    const [due] = await db.select({ id: P.id, category: P.benchmarksCategory }).from(P)
      .leftJoin(PV, and(eq(PV.projectId, P.id), eq(PV.platform, ALL), eq(PV.country, ALL)))
      .where(and(eq(P.benchmarksShare, true), isNotNull(P.benchmarksCategory), or(sql`${PV.computedOn} is null`, lt(PV.computedOn, day))))
      .orderBy(asc(PV.computedAt), asc(P.id)).limit(1);
    if (!due) break;
    if (Date.now() - started > budget && out.computed > 0) return out;
    // Mark the project attempted today first: if this computation is cut off (the Worker's CPU limit), the next tick
    // moves on to the next project instead of retrying this one forever. It then counts with no values today.
    await db.transaction(async (tx) => {
      await tx.delete(PV).where(eq(PV.projectId, due.id));
      await tx.insert(PV).values({ projectId: due.id, platform: ALL, country: ALL, category: due.category!, metrics: {}, computedOn: day, computedAt: now });
    });
    try {
      await computeProjectBenchmarks(db, due.id, due.category!, now, o);
    } catch (e) {
      // One project's failure must not stop the night: it keeps the empty row written above.
      console.error(`benchmarks: project ${due.id} failed`, e);
    }
    out.computed++;
  }
  const [run] = await db.select().from(RUNS).where(eq(RUNS.day, day)).limit(1);
  if (run && !run.aggregatedAt) {
    await pruneBenchmarkValues(db);
    out.groups = await rebuildAggregates(db, now, o);
    out.aggregated = true;
    const [count] = await db.select({ n: sql<number>`count(distinct ${PV.projectId})::int` }).from(PV);
    await db.update(RUNS).set({ aggregatedAt: now, groups: out.groups, projects: Number(count?.n ?? 0) }).where(eq(RUNS.day, day));
  }
  return out;
}

/** Turns sharing on or off and sets the category. Off deletes the project's values and rebuilds the aggregates now. */
export async function setBenchmarkSharing(db: DB, projectId: string, share: boolean, category: string | null, now: Date, o: BenchmarkOptions = {}) {
  const [cur] = await db.select({ share: P.benchmarksShare, category: P.benchmarksCategory }).from(P).where(eq(P.id, projectId)).limit(1);
  await db.update(P).set({ benchmarksShare: share, benchmarksCategory: category, benchmarksSharedAt: share ? (cur?.share ? undefined : now) : null }).where(eq(P.id, projectId));
  if (!share) {
    const removed = await db.delete(PV).where(eq(PV.projectId, projectId)).returning({ p: PV.projectId });
    if (removed.length) await rebuildAggregates(db, now, o);
  } else if (cur?.share && cur.category !== category) {
    // A new category moves the project's values to that peer group; it counts there from the next nightly run.
    await db.update(PV).set({ category: category! }).where(eq(PV.projectId, projectId));
  }
}

/** The next time the job starts (START_HOUR UTC). */
export function nextRunAt(now: Date): number {
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), START_HOUR);
  return t > now.getTime() ? t : t + 86_400_000;
}

export interface BenchmarkQuery { category?: string | null; platform?: string | null; country?: string | null }

/** Everything the Benchmarks page shows one project. Never returns another project's values or a group under k. */
export async function benchmarksFor(db: DB, projectId: string, q: BenchmarkQuery, now: Date, o: { k?: number } = {}) {
  const k = Math.max(o.k ?? K_ANONYMITY, 2);
  const [proj] = await db.select({ share: P.benchmarksShare, category: P.benchmarksCategory, sharedAt: P.benchmarksSharedAt }).from(P).where(eq(P.id, projectId)).limit(1);
  const settings = { share: !!proj?.share, category: proj?.category ?? null, shared_at: proj?.sharedAt?.getTime() ?? null };
  const [lastRun] = await db.select().from(RUNS).where(isNotNull(RUNS.aggregatedAt)).orderBy(desc(RUNS.day)).limit(1);
  const base = {
    object: "benchmarks" as const, available: true, settings, last_computed_at: lastRun?.aggregatedAt?.getTime() ?? null, next_run_at: nextRunAt(now),
    k_anonymity: k, window: (() => { const w = benchmarkWindow(now.getTime()); return { start_date: isoDay(w.from), end_date: isoDay(w.to - 86_400_000) }; })(),
    categories: BENCHMARK_CATEGORIES, metrics_catalog: BENCHMARK_METRICS,
  };
  if (!settings.share) return { ...base, peer_group: null, own_computed_at: null, metrics: [], opportunity: null, options: null };
  const category = q.category === ALL || isCategory(q.category) ? q.category! : settings.category ?? ALL;
  const platform = q.platform === "ios" || q.platform === "android" ? q.platform : ALL;
  const country = q.country && /^[A-Z]{2}$/.test(q.country) ? q.country : ALL;
  const [own] = await db.select().from(PV).where(and(eq(PV.projectId, projectId), eq(PV.platform, platform), eq(PV.country, country))).limit(1);
  const groups = await db.select().from(AG).where(and(eq(AG.category, category), eq(AG.platform, platform), eq(AG.country, country)));
  const byMetric: Partial<Record<BenchmarkMetricId, BenchmarkAggregate>> = {};
  for (const g of groups) if (g.projects >= k) byMetric[g.metric as BenchmarkMetricId] = { ...g, metric: g.metric as BenchmarkMetricId };
  const cmp = compareToPeers((own?.metrics as MetricValues | undefined) ?? null, byMetric, { k });
  // Pickers: the groups that are published for this category (countries) and the slices the project has values for.
  const published = await db.selectDistinct({ platform: AG.platform, country: AG.country }).from(AG).where(and(eq(AG.category, category), sql`${AG.projects} >= ${k}`));
  const mine = await db.select({ platform: PV.platform, country: PV.country }).from(PV).where(eq(PV.projectId, projectId));
  const projects = Math.max(0, ...groups.filter((g) => g.projects >= k).map((g) => g.projects));
  return {
    ...base,
    peer_group: { category, platform, country, projects: projects || null },
    own_computed_at: own?.computedAt.getTime() ?? null,
    metrics: cmp.rows.map((r) => ({ ...r, definition: BENCHMARK_METRICS.find((m) => m.id === r.metric)! })),
    opportunity: cmp.opportunity,
    options: {
      countries: [...new Set([...published.filter((x) => x.country !== ALL).map((x) => x.country), ...mine.filter((x) => x.country !== ALL).map((x) => x.country)])].sort(),
      platforms: [ALL, "ios", "android"],
    },
  };
}

/** Projects that stopped existing or sharing keep no values (a safety net; opting out already deletes them). */
export async function pruneBenchmarkValues(db: DB) {
  const sharing = (await db.select({ id: P.id }).from(P).where(eq(P.benchmarksShare, true))).map((r) => r.id);
  if (!sharing.length) await db.delete(PV);
  else await db.delete(PV).where(notInArray(PV.projectId, sharing));
}
