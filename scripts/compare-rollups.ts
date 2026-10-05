// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: compares daily chart rollups with the live computation for one project, read-only, and times both.
// Run: DATABASE_URL=… npx tsx scripts/compare-rollups.ts <project_id> [production|sandbox]
// It only reads: the rollups are computed in memory from the project's rows, never written. Spec: prd/charts/PRD.md "Daily rollups".
import { chartDef, chartFromRollup, computeRollupDays, firstDataDay, ROLLUP_CHARTS, runChart, type ChartOutput, type ChartRequest, type Resolution } from "../packages/core/src/index.js";
import { connectPostgres } from "../packages/db/src/worker.js";
import { loadChartInput } from "../apps/server/src/services/charts/load.js";

const DAY = 86_400_000;
const [projectId, env = "production"] = process.argv.slice(2);
if (!projectId) { console.error("usage: compare-rollups.ts <project_id> [production|sandbox]"); process.exit(2); }
// A plain connection that never migrates (openDb would): the database may be production.
const { db, close } = connectPostgres(process.env.DATABASE_URL!);
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
const days = computeRollupDays(input, first, today + DAY);
const buildMs = performance.now() - t;

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
    compared++;
    if (!rolled || !eq(live, rolled)) { mismatches++; console.log(`MISMATCH ${name} ${JSON.stringify(sel)} ${label}`); }
  }
}
console.log(JSON.stringify({
  projectId, env, transactions: input.txs.length, customers: input.customers.length, days: days.size, compared, mismatches,
  load_ms: Math.round(loadMs), build_all_days_ms: Math.round(buildMs),
  live_compute_ms_per_chart: +(liveMs / compared).toFixed(2), rollup_combine_ms_per_chart: +(rollMs / compared).toFixed(3),
}, null, 1));
await close();
process.exit(mismatches ? 1 : 0);
