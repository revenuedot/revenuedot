import { and, asc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  addRollupDays, buckets, chartFromRollup, computeRollupDays, finishRollupDays, firstDataDay, isRollupChart, newId, ROLLUP_VERSION, rollupKeys,
  type ChartDef, type ChartOutput, type ChartRequest, type RollupDay,
} from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { loadChartInput, playTierCrossingsOf } from "./load.js";

/**
 * Daily chart rollups (prd/charts/PRD.md "Daily rollups"; the arithmetic is core charts/rollup.ts).
 *
 * Nothing is incremental. For each project and environment whose charts were viewed (realtime=false) since its last
 * build, and in the last day, the scheduled job rebuilds every day from scratch at most every REBUILD_MS into a new
 * generation, as of one `now` (the build's start). Memory stays bounded whatever the project's size: the build reads
 * BATCH_CUSTOMERS customers at a time with their rows, computes their days, and adds them into a running total (every
 * stored value is a sum over customers; rates are recomputed from their summed parts). A build that does not fit in a
 * run's budget saves its place and total and continues on the next run under a lease, reading only rows recorded by its
 * start (where the table says when). When the last batch is added the days are written and the state switches to the
 * new generation in one statement; the replaced generation is deleted when the next build starts, so a request reading
 * during the switch still finds its days. A build finished in one run equals the live computation at its start; one
 * spread over several runs is accurate as of its build window (a customer's rows can change between batches), and the
 * next build corrects any drift.
 *
 * A request with realtime=false, no filter or segment, in USD, for a rollup chart is answered from the newest complete
 * generation when it was built today (UTC) at most STALE_MS ago and with this code; otherwise the chart is computed live.
 */
export const REBUILD_MS = 15 * 60_000;
export const STALE_MS = 20 * 60_000;
/** Customers per batch: a 200,000-customer project builds within a 96 MB heap at this size (scripts/bench/rollups.ts). */
export const BATCH_CUSTOMERS = 2_000;
const VIEW_WINDOW_MS = 24 * 3_600_000;
const FORGET_MS = 7 * 24 * 3_600_000;
const LEASE_MS = 3 * 60_000;
const DAY = 86_400_000;
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
const AD_TYPES = ["rc_ads_ad_displayed", "rc_ads_ad_opened", "rc_ads_ad_loaded", "rc_ads_ad_failed_to_load", "rc_ads_ad_revenue"];

class LeaseLost extends Error {}

const rowsOf = <T>(res: unknown) => (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];

/** The database's clock. */
async function dbNow(db: DB): Promise<Date> {
  return new Date(rowsOf<{ now: string | Date }>(await db.execute(sql`SELECT now() AS now`))[0]!.now);
}

/** The last customer id of the batch after `after` (by the database's ordering, as the batch's range compares), or null when fewer than `size` remain. */
export async function batchEnd(db: DB, projectId: string, after: string | null, size: number): Promise<string | null> {
  const rows = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM customers WHERE project_id = ${projectId} ${after !== null ? sql`AND id > ${after}` : sql``} ORDER BY id LIMIT 1 OFFSET ${size - 1}`));
  return rows[0]?.id ?? null;
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

export interface BuildResult { days: number; done: boolean; started: boolean; skipped: boolean; busy?: boolean; runs?: number; ms?: number; batches?: number }

/**
 * Works on one project and environment until `deadline` (a Date.now() value): starts a new generation when the served
 * one is older than REBUILD_MS (or was built by other code), continues a generation in progress, and flips to it when
 * it is complete. `force` starts a new generation now; `batchCustomers` sets the batch size (tests).
 */
export async function refreshRollups(db: DB, projectId: string, sandbox: boolean, now: Date, deadline: number, o: { force?: boolean; batchCustomers?: number } = {}): Promise<BuildResult> {
  const R = schema.chartRollups, ST = schema.chartRollupState;
  const claimed = await claim(db, projectId, sandbox);
  if (!claimed) return { days: 0, done: false, started: false, skipped: true, busy: true };
  const { row: state, token } = claimed;
  const mine = and(eq(ST.projectId, projectId), eq(ST.isSandbox, sandbox), eq(ST.leaseToken, token));
  const release = (v: Partial<typeof ST.$inferInsert> = {}) => db.update(ST).set({ ...v, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(mine);
  const renew = async (tx: Pick<DB, "update"> = db) => {
    const held = await tx.update(ST).set({ leaseUntil: new Date(Date.now() + LEASE_MS) }).where(mine).returning({ p: ST.projectId });
    if (!held.length) throw new LeaseLost();
  };
  const runStarted = Date.now();
  try {
    let gen = state.buildGeneration, buildNow = state.buildNow, rowsAt = state.buildRowsAt;
    // A paused build always has a place (the last customer of a batch that was not the last) and a running total.
    const inProgress = gen !== null && buildNow !== null && rowsAt !== null && state.buildCursor !== null && state.buildPartial !== null && state.buildVersion === ROLLUP_VERSION;
    // Due when the served generation is missing, of other code, or switched to REBUILD_MS ago and looked at since.
    const due = rebuildDue(state, now);
    let started = false;
    let after: string | null = null;
    const acc = new Map<number, RollupDay>();
    if (!inProgress || o.force) {
      if (!due && !o.force) { await release(); return { days: 0, done: true, started: false, skipped: true }; }
      gen = Math.max(state.generation ?? 0, state.buildGeneration ?? 0) + 1;
      buildNow = now;
      // Rows are stamped by the database (or the app, whose clock agrees): the database's clock bounds what this build reads.
      rowsAt = await dbNow(db);
      started = true;
      // Every generation but the served one: the one it replaced, and rows a stopped build left behind.
      await db.delete(R).where(and(eq(R.projectId, projectId), eq(R.isSandbox, sandbox), ne(R.generation, state.generation ?? -1)));
    } else {
      after = state.buildCursor;
      for (const [d, v] of state.buildPartial!) acc.set(d, v);
    }
    const asOf = buildNow!;
    const end = dayStart(asOf.getTime()) + DAY;
    const size = Math.max(1, o.batchCustomers ?? BATCH_CUSTOMERS);
    // Google Play's $1M tier depends on all of the environment's sales, not only a batch's.
    const playTier = await playTierCrossingsOf(db, { projectId, sandbox, asOf: rowsAt! });
    let batches = 0;
    for (;;) {
      const upTo = await batchEnd(db, projectId, after, size);
      // Every batch reads the rows as of the build's `now`, so the generation is one computation at that time.
      const input = await loadChartInput(db, { projectId, sandbox, now: asOf, asOf: rowsAt!, currency: "USD", fetch: null, customers: { after, upTo }, playTier, sources: { sdkTypes: AD_TYPES, activity: null, refundRequests: false } });
      const from = firstDataDay(input);
      if (from !== null && from < end) addRollupDays(acc, computeRollupDays(input, from, end));
      batches++;
      // A run that lost the lease (it took too long) stops instead of writing on.
      await renew();
      if (upTo === null) break;
      after = upTo;
      if (Date.now() > deadline) {
        const ms = Date.now() - runStarted;
        // Paused: only the build's own columns; the served generation and its version stay as they are.
        await release({ buildVersion: ROLLUP_VERSION, buildGeneration: gen, buildNow: asOf, buildRowsAt: rowsAt, buildCursor: after, buildPartial: [...acc],
          buildRuns: (started ? 0 : state.buildRuns) + 1, buildMs: (started ? 0 : state.buildMs) + ms });
        return { days: 0, done: false, started, skipped: false, batches };
      }
    }
    const days = [...finishRollupDays(acc)].map(([dayMs, data]) => ({ projectId, isSandbox: sandbox, generation: gen!, dayMs, data }));
    await db.transaction(async (tx) => {
      await renew(tx);
      for (let k = 0; k < days.length; k += 200) await tx.insert(R).values(days.slice(k, k + 200)).onConflictDoUpdate({ target: [R.projectId, R.isSandbox, R.generation, R.dayMs], set: { data: sql`excluded.data` } });
    });
    // Complete: serve the new generation, in one statement and only if this run still holds the lease. The replaced
    // generation stays until the next build starts.
    const runs = (started ? 0 : state.buildRuns) + 1, ms = (started ? 0 : state.buildMs) + (Date.now() - runStarted);
    // On the app's clock, like the requests that measure freshness from it.
    const switchedAt = now;
    const switched = await db.update(ST).set({ generation: gen, version: ROLLUP_VERSION, computedAt: asOf, switchedAt, rowsAt, buildGeneration: null, buildVersion: null, buildNow: null, buildRowsAt: null, buildCursor: null, buildPartial: null, buildRuns: 0, buildMs: 0, leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(mine).returning({ p: ST.projectId });
    if (!switched.length) return { days: 0, done: false, started, skipped: true, busy: true };
    // A build that took longer than its answers stay fresh: logged, so the cost shows.
    if (switchedAt.getTime() - asOf.getTime() > STALE_MS) console.warn("rollups: slow build", JSON.stringify({ project: projectId, env: sandbox ? "sandbox" : "production", runs, ms, wall_ms: switchedAt.getTime() - asOf.getTime() }));
    return { days: days.length, done: true, started, skipped: false, runs, ms, batches };
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
export async function runRollupJob(d: { db: DB }, now: Date, o: { budgetMs?: number; batchCustomers?: number } = {}): Promise<RollupRun> {
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
      const r = await refreshRollups(d.db, p.id, p.sandbox, now, deadline, { batchCustomers: o.batchCustomers });
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
