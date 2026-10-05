import { and, asc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  buckets, chartFromRollup, computeRollupDays, firstDays, isEmptyDay, isRollupChart, newCustomerDays, newId, Prepared, ROLLUP_VERSION, rollupKeys,
  type ChartDef, type ChartOutput, type ChartRequest, type RollupDay,
} from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { loadChartInput } from "./load.js";

/**
 * Daily chart rollups (prd/charts/PRD.md "Daily rollups"; the arithmetic is core charts/rollup.ts).
 *
 * Nothing is incremental. For each project and environment whose charts were viewed (realtime=false) since its last
 * build, and in the last day, the scheduled job rebuilds every day from scratch at most every REBUILD_MS into a new
 * generation, as of one `now` (the build's start). A build that does not fit in a run's budget continues on the next
 * run under a lease, reading only rows recorded by its start (where the table says when). When the last day is written
 * the state switches to the new generation in one statement; the replaced generation is deleted when the next build
 * starts, so a request reading during the switch still finds its days. A build finished in one run equals the live
 * computation at its start; one spread over several runs is accurate as of its build window (a subscription's state can
 * change meanwhile), and the next build corrects any drift.
 *
 * A request with realtime=false, no filter or segment, in USD, for a rollup chart is answered from the newest complete
 * generation when it was built today (UTC) at most STALE_MS ago and with this code; otherwise the chart is computed live.
 */
export const REBUILD_MS = 15 * 60_000;
export const STALE_MS = 20 * 60_000;
const VIEW_WINDOW_MS = 24 * 3_600_000;
const FORGET_MS = 7 * 24 * 3_600_000;
const LEASE_MS = 3 * 60_000;
const SLICE_DAYS = 31;
const DAY = 86_400_000;
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
const AD_TYPES = ["rc_ads_ad_displayed", "rc_ads_ad_opened", "rc_ads_ad_loaded", "rc_ads_ad_failed_to_load", "rc_ads_ad_revenue"];

class LeaseLost extends Error {}

/** The database's clock. */
async function dbNow(db: DB): Promise<Date> {
  const res = await db.execute<{ now: string | Date }>(sql`SELECT now() AS now`);
  const row = (Array.isArray(res) ? res : (res as { rows: { now: string | Date }[] }).rows)[0]!;
  return new Date(row.now);
}

type State = typeof schema.chartRollupState.$inferSelect;
/** Whether a project's next generation is due: none served, other code, or the served one switched to REBUILD_MS ago and viewed since. */
const rebuildDue = (s: Pick<State, "generation" | "version" | "switchedAt" | "computedAt" | "viewedAt">, now: Date) =>
  !s.generation || s.version !== ROLLUP_VERSION || !s.switchedAt || !s.computedAt
  || (!!s.viewedAt && s.viewedAt > s.switchedAt
    // REBUILD_MS after the switch, or at once on a new day (yesterday's build lacks today).
    && (now.getTime() - s.switchedAt.getTime() >= REBUILD_MS || dayStart(s.computedAt.getTime()) < dayStart(now.getTime())));

/** Takes the project's lease (measured on the real clock), or null when another run holds it. Creates the state row on first use. */
async function claim(db: DB, projectId: string, sandbox: boolean) {
  const ST = schema.chartRollupState;
  const t = new Date();
  await db.insert(ST).values({ projectId, isSandbox: sandbox, updatedAt: t }).onConflictDoNothing();
  const token = newId("lease_", 12);
  const [row] = await db.update(ST).set({ leaseToken: token, leaseUntil: new Date(t.getTime() + LEASE_MS), updatedAt: t })
    .where(and(eq(ST.projectId, projectId), eq(ST.isSandbox, sandbox), or(isNull(ST.leaseUntil), lt(ST.leaseUntil, t)))).returning();
  return row ? { row, token } : null;
}

export interface BuildResult { days: number; done: boolean; started: boolean; skipped: boolean; busy?: boolean; runs?: number; ms?: number }

/**
 * Works on one project and environment until `deadline` (a Date.now() value): starts a new generation when the served
 * one is older than REBUILD_MS (or was built by other code), continues a generation in progress, and flips to it when
 * it is complete. `force` starts a new generation now.
 */
export async function refreshRollups(db: DB, projectId: string, sandbox: boolean, now: Date, deadline: number, o: { force?: boolean } = {}): Promise<BuildResult> {
  const R = schema.chartRollups, ST = schema.chartRollupState;
  const claimed = await claim(db, projectId, sandbox);
  if (!claimed) return { days: 0, done: false, started: false, skipped: true, busy: true };
  const { row: state, token } = claimed;
  const mine = and(eq(ST.projectId, projectId), eq(ST.isSandbox, sandbox), eq(ST.leaseToken, token));
  const release = (v: Partial<typeof ST.$inferInsert> = {}) => db.update(ST).set({ ...v, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(mine);
  const runStarted = Date.now();
  try {
    let gen = state.buildGeneration, buildNow = state.buildNow, rowsAt = state.buildRowsAt, from = state.buildFromMs;
    // A build of other code is dropped and started again.
    const inProgress = gen !== null && buildNow !== null && rowsAt !== null && from !== null && state.buildVersion === ROLLUP_VERSION;
    // Due when the served generation is missing, of other code, or switched to REBUILD_MS ago and looked at since.
    const due = rebuildDue(state, now);
    let started = false;
    if (!inProgress || o.force) {
      if (!due && !o.force) { await release(); return { days: 0, done: true, started: false, skipped: true }; }
      gen = Math.max(state.generation ?? 0, state.buildGeneration ?? 0) + 1;
      buildNow = now;
      // Rows are stamped by the database (or the app, whose clock agrees): the database's clock bounds what this build reads.
      rowsAt = await dbNow(db);
      from = null;
      started = true;
      // Every generation but the served one: the one it replaced, and rows a stopped build left behind.
      await db.delete(R).where(and(eq(R.projectId, projectId), eq(R.isSandbox, sandbox), ne(R.generation, state.generation ?? -1)));
    }
    const asOf = buildNow!;
    // Every run of a build reads the rows as of the build's `now`, so the generation is one computation at that time.
    const input = await loadChartInput(db, { projectId, sandbox, now: asOf, asOf: rowsAt!, currency: "USD", fetch: null, sources: { sdkTypes: AD_TYPES, activity: null, refundRequests: false } });
    const prepared = new Prepared(input);
    const f = firstDays(input);
    const end = dayStart(asOf.getTime()) + DAY;
    let start = from ?? Math.min(f.activity ?? end, f.customers ?? end, end);
    const write = async (rows: { projectId: string; isSandbox: boolean; generation: number; dayMs: number; data: RollupDay }[]) => {
      // Under the lease, renewed by each slice: a run that lost it (it took too long) stops instead of writing on.
      await db.transaction(async (tx) => {
        const held = await tx.update(ST).set({ leaseUntil: new Date(Date.now() + LEASE_MS) }).where(mine).returning({ p: ST.projectId });
        if (!held.length) throw new LeaseLost();
        for (let k = 0; k < rows.length; k += 200) await tx.insert(R).values(rows.slice(k, k + 200)).onConflictDoUpdate({ target: [R.projectId, R.isSandbox, R.generation, R.dayMs], set: { data: sql`excluded.data` } });
      });
    };
    let days = 0;
    // Before the first purchase, lifecycle or SDK event only New Customers has values: one pass, not slices.
    const activity = f.activity ?? end;
    if (start < activity) {
      const to = Math.min(activity, end);
      await write([...newCustomerDays(prepared, start, to)].filter(([, n]) => n > 0).map(([dayMs, n]) => ({ projectId, isSandbox: sandbox, generation: gen!, dayMs, data: { customers_new: [n] } as RollupDay })));
      days += Math.round((to - start) / DAY);
      start = to;
    }
    // Slices shrink when one takes more than a quarter of the budget, so the deadline is checked often enough.
    let slice = SLICE_DAYS;
    const budget = Math.max(1, deadline - runStarted);
    while (start < end) {
      const to = Math.min(end, start + slice * DAY);
      const t0 = Date.now();
      await write([...computeRollupDays(input, start, to, prepared)].filter(([, d]) => !isEmptyDay(d)).map(([dayMs, data]) => ({ projectId, isSandbox: sandbox, generation: gen!, dayMs, data })));
      days += Math.round((to - start) / DAY);
      start = to;
      if (Date.now() - t0 > budget / 4) slice = Math.max(1, Math.floor(slice / 2));
      if (start < end && Date.now() > deadline) {
        const ms = Date.now() - runStarted;
        // Paused: only the build's own columns; the served generation and its version stay as they are.
        await release({ buildVersion: ROLLUP_VERSION, buildGeneration: gen, buildNow: asOf, buildRowsAt: rowsAt, buildFromMs: start, buildRuns: (started ? 0 : state.buildRuns) + 1, buildMs: (started ? 0 : state.buildMs) + ms });
        return { days, done: false, started, skipped: false };
      }
    }
    // Complete: serve the new generation, in one statement and only if this run still holds the lease. The replaced
    // generation stays until the next build starts.
    const runs = (started ? 0 : state.buildRuns) + 1, ms = (started ? 0 : state.buildMs) + (Date.now() - runStarted);
    // On the app's clock, like the requests that measure freshness from it.
    const switchedAt = now;
    const switched = await db.update(ST).set({ generation: gen, version: ROLLUP_VERSION, computedAt: asOf, switchedAt, rowsAt, buildGeneration: null, buildVersion: null, buildNow: null, buildRowsAt: null, buildFromMs: null, buildRuns: 0, buildMs: 0, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(mine).returning({ p: ST.projectId });
    if (!switched.length) return { days, done: false, started, skipped: true, busy: true };
    // A build that took longer than its answers stay fresh: logged, so the cost shows.
    if (switchedAt.getTime() - asOf.getTime() > STALE_MS) console.warn("rollups: slow build", JSON.stringify({ project: projectId, env: sandbox ? "sandbox" : "production", runs, ms, wall_ms: switchedAt.getTime() - asOf.getTime() }));
    return { days, done: true, started, skipped: false, runs, ms };
  } catch (e) {
    if (e instanceof LeaseLost) return { days: 0, done: false, started: false, skipped: true, busy: true };
    await release().catch(() => undefined);
    throw e;
  }
}

export interface RollupRun { builds: number; days: number; skipped: number; pending: number; busy: number; forgotten: number }

/**
 * The scheduled job: the projects and environments whose charts were viewed in the last day, the least recently worked
 * on first, within `budgetMs`. Rollups of projects not viewed for a week are deleted.
 */
export async function runRollupJob(d: { db: DB }, now: Date, o: { budgetMs?: number } = {}): Promise<RollupRun> {
  const deadline = Date.now() + (o.budgetMs ?? 20_000);
  const ST = schema.chartRollupState, R = schema.chartRollups;
  const out: RollupRun = { builds: 0, days: 0, skipped: 0, pending: 0, busy: 0, forgotten: 0 };
  const forgetBefore = new Date(now.getTime() - FORGET_MS);
  const notViewed = or(isNull(ST.viewedAt), lt(ST.viewedAt, forgetBefore));
  const stale = await d.db.select({ id: ST.projectId, sandbox: ST.isSandbox }).from(ST).where(notViewed);
  for (const p of stale) {
    // Re-checked in the delete: a view since the select keeps the project.
    const gone = await d.db.delete(ST).where(and(eq(ST.projectId, p.id), eq(ST.isSandbox, p.sandbox), notViewed)).returning({ p: ST.projectId });
    if (!gone.length) continue;
    await d.db.delete(R).where(and(eq(R.projectId, p.id), eq(R.isSandbox, p.sandbox)));
    out.forgotten++;
  }
  // Only the projects with work: a build in progress, or a new generation due; none whose lease another run holds.
  const t = new Date();
  const pairs = await d.db.select({ id: ST.projectId, sandbox: ST.isSandbox }).from(ST).where(and(
    gte(ST.viewedAt, new Date(now.getTime() - VIEW_WINDOW_MS)),
    or(isNull(ST.leaseUntil), lt(ST.leaseUntil, t)),
    or(sql`${ST.buildGeneration} is not null`, isNull(ST.generation), sql`${ST.version} is distinct from ${ROLLUP_VERSION}`, isNull(ST.switchedAt),
      and(sql`${ST.viewedAt} > ${ST.switchedAt}`, or(lt(ST.switchedAt, new Date(now.getTime() - REBUILD_MS)), lt(ST.computedAt, new Date(dayStart(now.getTime())))))),
  )).orderBy(asc(ST.updatedAt));
  for (const p of pairs) {
    if (Date.now() > deadline) break;
    try {
      const r = await refreshRollups(d.db, p.id, p.sandbox, now, deadline);
      if (r.busy) out.busy++;
      else if (r.skipped) out.skipped++;
      else if (!r.done) out.pending++;
      out.days += r.days;
      if (r.done && !r.skipped) {
        out.builds++;
        // The cost of a build: its runs and time, per project and environment.
        console.log("rollups", JSON.stringify({ project: p.id, env: p.sandbox ? "sandbox" : "production", runs: r.runs, ms: r.ms }));
      }
    } catch (e) {
      console.error(`rollups: ${p.id} (${p.sandbox ? "sandbox" : "production"}) failed`, e);
    }
  }
  return out;
}

/**
 * A chart answered from the rollups, or null when it must be computed live (see the file comment). Records that the
 * project's charts are being looked at, which keeps its rollups built.
 */
export async function chartFromRollups(db: DB, o: { projectId: string; sandbox: boolean; def: ChartDef; req: ChartRequest; now: Date; currency: string; filtered: boolean; segmented: boolean }): Promise<{ output: ChartOutput; computedAt: Date } | null> {
  if (o.currency !== "USD" || o.filtered || o.segmented || !isRollupChart(o.def.name)) return null;
  const ST = schema.chartRollupState;
  const key = and(eq(ST.projectId, o.projectId), eq(ST.isSandbox, o.sandbox));
  const [state] = await db.select({ viewedAt: ST.viewedAt, switchedAt: ST.switchedAt }).from(ST).where(key).limit(1);
  // A view after the served generation was switched to makes the next one due (one write per build, at most).
  if (!state) await db.insert(ST).values({ projectId: o.projectId, isSandbox: o.sandbox, viewedAt: o.now, updatedAt: new Date(0) }).onConflictDoNothing();
  else if (!state.viewedAt || (state.switchedAt && state.viewedAt <= state.switchedAt) || o.now.getTime() - state.viewedAt.getTime() > 3_600_000) await db.update(ST).set({ viewedAt: o.now }).where(key);
  const bs = buckets(o.req.rangeStart, o.req.rangeEnd, o.req.resolution, 1000, o.req.weekStart);
  if (!bs.length) return null;
  // One statement: the state's served generation and its days, so a switch between two reads cannot mix them; only
  // the keys this chart reads.
  const keys = rollupKeys(o.def, o.req.selectors);
  const pick = sql.join(keys.map((k) => sql`${k}::text, r.data -> ${k}::text`), sql`, `);
  type Row = { generation: number | null; version: string | null; computed_at: string | Date | null; switched_at: string | Date | null; day_ms: string | number | null; data: RollupDay | null };
  const res = await db.execute<Row>(sql`
    SELECT s.generation, s.version, s.computed_at, s.switched_at, r.day_ms, jsonb_strip_nulls(jsonb_build_object(${pick})) AS data
    FROM chart_rollup_state s
    LEFT JOIN chart_rollups r ON r.project_id = s.project_id AND r.is_sandbox = s.is_sandbox AND r.generation = s.generation
      AND r.day_ms >= ${dayStart(bs[0]!.start)} AND r.day_ms < ${o.req.rangeEnd}
    WHERE s.project_id = ${o.projectId} AND s.is_sandbox = ${o.sandbox}`);
  const rows = (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Row[];
  const head = rows[0];
  const computedAt = head?.computed_at ? new Date(head.computed_at) : null;
  const switchedAt = head?.switched_at ? new Date(head.switched_at) : null;
  const t = o.now.getTime();
  // Fresh: switched to at most STALE_MS ago, and built as of today (yesterday's days would lack today).
  if (!head || head.generation === null || head.version !== ROLLUP_VERSION || !computedAt || !switchedAt
    || dayStart(computedAt.getTime()) !== dayStart(t) || t - switchedAt.getTime() > STALE_MS) return null;
  const days = new Map<number, RollupDay>();
  for (const r of rows) if (r.day_ms !== null && r.data) days.set(Number(r.day_ms), r.data);
  // As of the build time: the answer is the chart as computed then.
  const output = chartFromRollup(o.def, o.req, computedAt.getTime(), days);
  return output ? { output, computedAt } : null;
}
