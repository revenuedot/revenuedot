// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: compares daily chart rollups with the live computation for one project, read-only, and times both.
// Run: DATABASE_URL=… npx tsx scripts/compare-rollups.ts <project_id> [production|sandbox] [batch customers]
// It only reads, on a read-only session: the rollups are computed in memory from the project's rows, never written,
// both in one pass and in customer batches as the scheduled build does. Spec: prd/charts/PRD.md "Daily rollups".
import { addRollupDays, chartDef, chartFromRollup, computeRollupDays, finishRollupDays, firstDataDay, ROLLUP_CHARTS, runChart, type ChartOutput, type ChartRequest, type Resolution, type RollupDay } from "../packages/core/src/index.js";
import { connectPostgres } from "../packages/db/src/worker.js";
import { sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import { loadChartInput, playTierCrossingsOf } from "../apps/server/src/services/charts/load.js";
import { BATCH_CUSTOMERS, batchEnd } from "../apps/server/src/services/charts/rollups.js";

const DAY = 86_400_000;
const [projectId, env = "production", batchArg] = process.argv.slice(2);
if (!projectId) { console.error("usage: compare-rollups.ts <project_id> [production|sandbox] [batch customers]"); process.exit(2); }
// A plain connection that never migrates (openDb would), and a read-only session: the database may be production.
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set("default_transaction_read_only", "on");
const { db, close } = connectPostgres(url.toString());
const [ro] = (await db.execute<{ default_transaction_read_only: string }>(sql`SHOW default_transaction_read_only`)) as unknown as { default_transaction_read_only: string }[];
if (ro?.default_transaction_read_only !== "on") { console.error("The session is not read-only; stopping."); process.exit(2); }
const now = new Date();
const today = Math.floor(now.getTime() / DAY) * DAY;
const AD = ["rc_ads_ad_displayed", "rc_ads_ad_opened", "rc_ads_ad_loaded", "rc_ads_ad_failed_to_load", "rc_ads_ad_revenue"];
const load = () => loadChartInput(db, { projectId, sandbox: env === "sandbox", now, currency: "USD", fetch: null, sources: { sdkTypes: AD, activity: null, refundRequests: false } });

let t = performance.now();
const input = await load();
const loadMs = performance.now() - t;
const first = firstDataDay(input);
if (first === null) { console.log("No data."); process.exit(0); }
t = performance.now();
const whole = computeRollupDays(input, first, today + DAY);
const buildMs = performance.now() - t;
// As the scheduled build does: customer batches, their days added up.
t = performance.now();
const size = Number(batchArg ?? BATCH_CUSTOMERS);
const playTier = await playTierCrossingsOf(db, { projectId, sandbox: env === "sandbox" });
const acc = new Map<number, RollupDay>();
let after: string | null = null, batches = 0;
for (;;) {
  const upTo = await batchEnd(db, projectId, after, size);
  const part = await loadChartInput(db, { projectId, sandbox: env === "sandbox", now, currency: "USD", fetch: null, customers: { after, upTo }, playTier, sources: { sdkTypes: AD, activity: null, refundRequests: false } });
  const from = firstDataDay(part);
  if (from !== null) addRollupDays(acc, computeRollupDays(part, from, today + DAY));
  batches++;
  if (upTo === null) break;
  after = upTo;
}
const days = finishRollupDays(acc);
const batchedMs = performance.now() - t;

const reqs: [string, ChartRequest][] = [
  ["30 days", { resolution: "day", rangeStart: today - 29 * DAY, rangeEnd: today + DAY, expand: false, selectors: {} }],
  ["12 months", { resolution: "month", rangeStart: Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1), rangeEnd: today + DAY, expand: false, selectors: {} }],
  ["all weeks", { resolution: "week" as Resolution, rangeStart: first, rangeEnd: today + DAY, expand: true, selectors: {} }],
  ["all quarters", { resolution: "quarter", rangeStart: first, rangeEnd: today + DAY, expand: false, selectors: {} }],
];
const eq = (a: ChartOutput, b: ChartOutput) => {
  if (a.kind !== "series" || b.kind !== "series" || a.points.length !== b.points.length) return false;
  return a.points.every((p, i) => p.start === b.points[i]!.start && p.incomplete === b.points[i]!.incomplete
    && p.values.every((v, k) => { const w = b.points[i]!.values[k]; return v === null || w === null ? v === w : Math.abs(v - w) < 1e-6 * Math.max(1, Math.abs(v)); }));
};
let compared = 0, mismatches = 0, liveMs = 0, rollMs = 0;
for (const name of ROLLUP_CHARTS) {
  const def = chartDef(name)!;
  const sels = def.selectors.length ? def.selectors[0]!.options.map((o) => ({ [def.selectors[0]!.id]: o.id })) : [{}];
  for (const sel of sels) for (const [label, r] of reqs) {
    const req = { ...r, selectors: sel };
    let s = performance.now();
    const live = runChart(def, input, req).output;
    liveMs += performance.now() - s;
    s = performance.now();
    const rolled = chartFromRollup(def, req, now.getTime(), days);
    rollMs += performance.now() - s;
    const once = chartFromRollup(def, req, now.getTime(), whole);
    compared++;
    if (!rolled || !eq(live, rolled)) { mismatches++; console.log(`MISMATCH batched ${name} ${JSON.stringify(sel)} ${label}`); }
    if (!once || !eq(live, once)) { mismatches++; console.log(`MISMATCH one pass ${name} ${JSON.stringify(sel)} ${label}`); }
  }
}
console.log(JSON.stringify({
  projectId, env, transactions: input.txs.length, customers: input.customers.length, days: days.size, batches, batch_customers: size, compared, mismatches,
  load_ms: Math.round(loadMs), build_all_days_ms: Math.round(buildMs), build_batched_ms: Math.round(batchedMs),
  live_compute_ms_per_chart: +(liveMs / compared).toFixed(2), rollup_combine_ms_per_chart: +(rollMs / compared).toFixed(3),
}, null, 1));
await close();
process.exit(mismatches ? 1 : 0);
