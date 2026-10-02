import { eq } from "drizzle-orm";
import { attributionReport, BENCHMARK_METRICS, chartDef, runChart, type ChartInput, type ChartOutput } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { loadChartInput } from "../charts/load.js";
import { benchmarksFor } from "../benchmarks.js";

/**
 * The numbers pack AI growth insights rest on (prd/attribution-benchmarks-insights §3): computed here from the project's
 * own rows with the chart definitions, never by the model. Each item has an id the model must cite, the real value, the
 * value it compares with, and the dashboard page it comes from. The UI shows these values, not the model's text.
 */

export interface PackItem {
  id: string;
  label: string;
  unit: "$" | "%" | "#";
  value: number | null;
  previous: number | null;
  /** Relative change from `previous`, in % (null when there is nothing to compare). */
  change_pct: number | null;
  /** What `value` and `previous` cover, in words ("last 28 days vs the 28 days before"). */
  window: string;
  /** Lower is better (churn, refunds): the UI colours the change the other way. */
  lower_is_better?: boolean;
  /** A dashboard path in this project. */
  link: string;
  /** Benchmarks: the peer median and where the project stands. */
  peer_median?: number | null;
  standing?: string | null;
}

export interface InsightPack { project: string; computed_at: number; currency: "USD"; items: PackItem[]; has_revenue: boolean }

const DAY = 86_400_000;
const r2 = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const change = (v: number | null, p: number | null) => (v === null || p === null || p === 0 ? null : r2(((v - p) / Math.abs(p)) * 100));
const sums = (o: ChartOutput) => {
  if (o.kind !== "series") return [];
  const out = o.measures.map(() => 0);
  for (const p of o.points) p.values.forEach((v, i) => { out[i]! += v ?? 0; });
  return out;
};

export async function buildInsightPack(db: DB, projectId: string, now: Date): Promise<InsightPack> {
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const input: ChartInput = await loadChartInput(db, {
    projectId, sandbox: false, now, currency: "USD", fetch: null,
    sources: { sdkTypes: ["rc_ads_ad_revenue"], activity: null, refundRequests: false },
  });
  const base = `/projects/${projectId}`;
  const run = (name: string, from: number, to: number, selectors: Record<string, string> = {}) =>
    runChart(chartDef(name)!, input, { resolution: "day", rangeStart: from, rangeEnd: to, expand: false, selectors }).output;
  const window28 = "last 28 days vs the 28 days before";
  const cur: [number, number] = [today - 28 * DAY, today], prev: [number, number] = [today - 56 * DAY, today - 28 * DAY];
  const items: PackItem[] = [];
  const item = (i: Omit<PackItem, "change_pct">) => items.push({ ...i, value: r2(i.value), previous: r2(i.previous), change_pct: change(i.value, i.previous) });

  // Stocks: the value at the end of each window.
  const lastOf = (name: string, at: number) => { const o = run(name, at - DAY, at); return o.kind === "series" ? o.points[o.points.length - 1]?.values[0] ?? null : null; };
  item({ id: "mrr", label: "MRR", unit: "$", value: lastOf("mrr", today), previous: lastOf("mrr", cur[0]), window: "today vs 28 days ago", link: `${base}/charts/mrr` });
  item({ id: "active_subscriptions", label: "Active subscriptions", unit: "#", value: lastOf("actives", today), previous: lastOf("actives", cur[0]), window: "today vs 28 days ago", link: `${base}/charts/actives` });
  // Flows: totals over each window.
  const total = (name: string, w: [number, number], m = 0) => sums(run(name, w[0], w[1]))[m] ?? null;
  item({ id: "revenue", label: "Revenue", unit: "$", value: total("revenue", cur), previous: total("revenue", prev), window: window28, link: `${base}/charts/revenue` });
  item({ id: "new_customers", label: "New customers", unit: "#", value: total("customers_new", cur), previous: total("customers_new", prev), window: window28, link: `${base}/charts/customers_new` });
  item({ id: "new_trials", label: "New trials", unit: "#", value: total("trials_new", cur), previous: total("trials_new", prev), window: window28, link: `${base}/charts/trials_new` });
  // Conversion: cohorts old enough for their 7-day window (or trials) to have finished: days 35 to 7 ago vs 63 to 35.
  const cCur: [number, number] = [today - 35 * DAY, today - 7 * DAY], cPrev: [number, number] = [today - 63 * DAY, today - 35 * DAY];
  const cohortWindow = "customers first seen 35 to 7 days ago vs the 28 days before";
  const rate = (name: string, w: [number, number], num: number, den: number, sel: Record<string, string> = {}) => {
    const s = sums(run(name, w[0], w[1], sel));
    return s[den] ? (s[num]! / s[den]!) * 100 : null;
  };
  const tc = (w: [number, number]) => { const s = sums(run("trial_conversion_rate", w[0], w[1])); const fin = (s[1] ?? 0) - (s[3] ?? 0); return fin > 0 ? (s[2]! / fin) * 100 : null; };
  item({ id: "trial_conversion", label: "Trial conversion", unit: "%", value: tc(cCur), previous: tc(cPrev), window: "trials started 35 to 7 days ago vs the 28 days before", link: `${base}/charts/trial_conversion_rate` });
  item({ id: "initial_conversion", label: "Initial conversion (7 days)", unit: "%", value: rate("initial_conversion", cCur, 1, 2, { conversion_timeframe: "7_days" }), previous: rate("initial_conversion", cPrev, 1, 2, { conversion_timeframe: "7_days" }), window: cohortWindow, link: `${base}/charts/initial_conversion` });
  item({ id: "conversion_to_paying", label: "Conversion to paying (7 days)", unit: "%", value: rate("conversion_to_paying", cCur, 1, 2, { conversion_timeframe: "7_days" }), previous: rate("conversion_to_paying", cPrev, 1, 2, { conversion_timeframe: "7_days" }), window: cohortWindow, link: `${base}/charts/conversion_to_paying` });
  // 28-day churn: subscriptions that churned in the window ÷ those active when it started.
  const churn = (w: [number, number]) => {
    const o = run("churn", w[0], w[1]);
    if (o.kind !== "series" || !o.points.length) return null;
    const start = o.points[0]!.values[1] ?? 0;
    return start ? (sums(o)[2]! / start) * 100 : null;
  };
  item({ id: "churn", label: "Churn (28 days)", unit: "%", value: churn(cur), previous: churn(prev), window: "subscriptions churned in the window ÷ active at its start, " + window28, lower_is_better: true, link: `${base}/charts/churn` });
  const refunds = (w: [number, number]) => { const s = sums(run("refund_rate", w[0], w[1])); return s[1] ? (s[2]! / s[1]!) * 100 : null; };
  item({ id: "refund_rate", label: "Refund rate", unit: "%", value: refunds([today - 90 * DAY, today]), previous: refunds([today - 180 * DAY, today - 90 * DAY]), window: "transactions of the last 90 days vs the 90 days before", lower_is_better: true, link: `${base}/charts/refund_rate` });

  // Campaigns: customers first seen in the last 90 days by campaign, the top 5 by revenue.
  const report = attributionReport(input, { from: today - 90 * DAY, to: today + DAY, groupBy: "campaign" });
  report.rows.filter((r) => r.key !== "").slice(0, 5).forEach((r, i) => {
    items.push({
      id: `campaign_${i + 1}`, label: `Campaign "${r.key}": revenue per new customer (${r.customers} customers, ${r.paying_customers} paying, $${r.revenue_to_date} to date)`,
      unit: "$", value: r.revenue_per_customer, previous: report.total.revenue_per_customer, change_pct: change(r.revenue_per_customer, report.total.revenue_per_customer),
      window: "customers first seen in the last 90 days; compared with all new customers", link: `${base}/attribution?group_by=campaign&start=${iso(today - 90 * DAY)}`,
    });
  });
  const none = report.rows.find((r) => r.key === "");
  if (report.rows.length > 1 && none) {
    items.push({
      id: "unattributed", label: `New customers without attribution (${none.customers} of ${report.total.customers})`, unit: "%",
      value: report.total.customers ? r2((none.customers / report.total.customers) * 100) : null, previous: null, change_pct: null,
      window: "customers first seen in the last 90 days", link: `${base}/attribution?group_by=media_source`,
    });
  }

  // Benchmarks, when the project shares (Cloud).
  const [proj] = await db.select({ name: schema.projects.name, share: schema.projects.benchmarksShare }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (proj?.share) {
    const b = await benchmarksFor(db, projectId, {}, now);
    for (const m of b.metrics) {
      if (m.value === null || !m.peers) continue;
      const def = BENCHMARK_METRICS.find((x) => x.id === m.metric)!;
      items.push({
        id: `benchmark_${m.metric}`, label: `${def.display_name} against ${b.peer_group?.projects ?? 10}+ peer apps (median ${r2(m.peers.p50)})`, unit: def.unit, value: r2(m.value), previous: r2(m.peers.p50),
        change_pct: change(m.value, m.peers.p50), window: "trailing 12 months vs the peer median", lower_is_better: def.better === "lower", link: `${base}/benchmarks`,
        peer_median: r2(m.peers.p50), standing: m.standing,
      });
    }
  }
  const revenue = items.find((i) => i.id === "revenue");
  return { project: proj?.name ?? projectId, computed_at: now.getTime(), currency: "USD", items, has_revenue: (revenue?.value ?? 0) !== 0 || (revenue?.previous ?? 0) !== 0 || (items.find((i) => i.id === "mrr")?.value ?? 0) > 0 };
}
