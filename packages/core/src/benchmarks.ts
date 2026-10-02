import { chartDef, type Dim } from "./charts/catalog.js";
import type { ChartOutput } from "./charts/compute.js";
import { isExcludedStore, productIndex, type ChartInput } from "./charts/model.js";
import { dimValues, restrict, runChart, type ChartFilter } from "./charts/run.js";
import { addMonths, floorTo } from "./charts/time.js";

/**
 * Benchmarks (prd/attribution-benchmarks-insights §2). Pure functions:
 * - `projectBenchmarkSlices`: one project's own values, for the whole project and per platform and country slice,
 *   computed with the chart definitions (trailing 12 complete months, production, USD).
 * - `aggregateBenchmarks`: peer percentiles with k-anonymity: a group (category × platform × country × metric) is
 *   published only when at least K_ANONYMITY projects contributed a value; the 10th and 90th percentiles need
 *   K_DECILES. App counts are rounded down to a multiple of 5. No mean, minimum, maximum or project id is produced.
 * - `compareToPeers`: where a project stands against a published group, and its biggest opportunity.
 */

export const K_ANONYMITY = 10;
export const K_DECILES = 20;

export type BenchmarkMetricId =
  | "initial_conversion" | "trial_conversion" | "conversion_to_paying" | "churn" | "refund_rate"
  | "ltv_per_customer" | "ltv_per_paying_customer" | "arpu" | "price_monthly" | "price_annual";

export interface BenchmarkMetricDef {
  id: BenchmarkMetricId;
  display_name: string;
  description: string;
  unit: "%" | "$";
  /** Which direction is good; "neutral" metrics (prices) are shown without a verdict. */
  better: "higher" | "lower" | "neutral";
  /** A project counts for this metric only with at least this much of its own data. */
  min_sample: number;
  sample_label: string;
  /** The chart with the same definition, and the selectors that make it match. */
  chart: { name: string; selectors?: Record<string, string> } | null;
}

export const BENCHMARK_METRICS: BenchmarkMetricDef[] = [
  { id: "initial_conversion", display_name: "Initial conversion (7 days)", description: "New customers who started a trial or bought anything within 7 days of first being seen.", unit: "%", better: "higher", min_sample: 100, sample_label: "new customers", chart: { name: "initial_conversion", selectors: { conversion_timeframe: "7_days" } } },
  { id: "trial_conversion", display_name: "Trial conversion", description: "Finished free trials that converted to a paid subscription.", unit: "%", better: "higher", min_sample: 20, sample_label: "finished trials", chart: { name: "trial_conversion_rate" } },
  { id: "conversion_to_paying", display_name: "Conversion to paying (7 days)", description: "New customers who paid within 7 days of first being seen and were not refunded in that time.", unit: "%", better: "higher", min_sample: 100, sample_label: "new customers", chart: { name: "conversion_to_paying", selectors: { conversion_timeframe: "7_days" } } },
  { id: "churn", display_name: "Monthly churn", description: "Paid subscriptions that ended in a month, as a share of those active when it started.", unit: "%", better: "lower", min_sample: 50, sample_label: "active subscription-months", chart: { name: "churn" } },
  { id: "refund_rate", display_name: "Refund rate", description: "Paid transactions that were refunded.", unit: "%", better: "lower", min_sample: 50, sample_label: "transactions", chart: { name: "refund_rate" } },
  { id: "ltv_per_customer", display_name: "Realized LTV per customer (30 days)", description: "Revenue of new customers in their first 30 days, per new customer.", unit: "$", better: "higher", min_sample: 100, sample_label: "new customers", chart: { name: "ltv_per_customer", selectors: { customer_lifetime: "30_days" } } },
  { id: "ltv_per_paying_customer", display_name: "Realized LTV per paying customer (30 days)", description: "Revenue of new customers in their first 30 days, per customer who paid in that time.", unit: "$", better: "higher", min_sample: 20, sample_label: "paying customers", chart: { name: "ltv_per_paying_customer", selectors: { customer_lifetime: "30_days" } } },
  { id: "arpu", display_name: "ARPU (monthly)", description: "Revenue per active customer per month.", unit: "$", better: "higher", min_sample: 100, sample_label: "active customer-months", chart: { name: "revenue" } },
  { id: "price_monthly", display_name: "Monthly price", description: "Median price customers paid for 1-month subscriptions, in USD.", unit: "$", better: "neutral", min_sample: 20, sample_label: "monthly transactions", chart: null },
  { id: "price_annual", display_name: "Annual price", description: "Median price customers paid for 1-year subscriptions, in USD.", unit: "$", better: "neutral", min_sample: 20, sample_label: "annual transactions", chart: null },
];
export const benchmarkMetric = (id: string) => BENCHMARK_METRICS.find((m) => m.id === id) ?? null;

/** RevenueCat's 11 benchmark categories, plus Other. */
export const BENCHMARK_CATEGORIES = [
  { id: "business", display_name: "Business" }, { id: "education", display_name: "Education" }, { id: "gaming", display_name: "Gaming" },
  { id: "health_fitness", display_name: "Health & Fitness" }, { id: "media_entertainment", display_name: "Media & Entertainment" },
  { id: "photo_video", display_name: "Photo & Video" }, { id: "productivity", display_name: "Productivity" }, { id: "shopping", display_name: "Shopping" },
  { id: "social_lifestyle", display_name: "Social & Lifestyle" }, { id: "travel", display_name: "Travel" }, { id: "utilities", display_name: "Utilities" },
  { id: "other", display_name: "Other" },
] as const;
export const ALL = "all";
export const BENCHMARK_PLATFORMS = [{ id: ALL, display_name: "All platforms" }, { id: "ios", display_name: "iOS" }, { id: "android", display_name: "Android" }] as const;

/** iOS, iPadOS, macOS, tvOS, watchOS and visionOS count as iOS (the App Store); Android as Android; others only in "all". */
export function benchmarkPlatform(raw: string | null | undefined): "ios" | "android" | null {
  const p = (raw ?? "").toLowerCase().replace(/\s+/g, "");
  if (/^(ios|ipados|macos|tvos|watchos|visionos|mac)/.test(p)) return "ios";
  if (p.startsWith("android")) return "android";
  return null;
}

export interface MetricValue { value: number | null; sample: number }
export type MetricValues = Partial<Record<BenchmarkMetricId, MetricValue>>;
export interface BenchmarkSlice { platform: string; country: string; metrics: MetricValues }

/** Countries a project gets its own slice in (by new customers in the window), at most. */
export const MAX_COUNTRY_SLICES = 10;

/** The trailing 12 complete months before `now`: [first day of the month a year ago, first day of this month). */
export function benchmarkWindow(now: number): { from: number; to: number } {
  const to = floorTo(now, "month");
  return { from: addMonths(to, -12), to };
}

function sums(o: ChartOutput, completeOnly: boolean): number[] {
  if (o.kind !== "series") return [];
  const out = o.measures.map(() => 0);
  for (const p of o.points) {
    if (completeOnly && p.incomplete) continue;
    p.values.forEach((v, i) => { out[i]! += v ?? 0; });
  }
  return out;
}
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** One slice's values. `minSample` overrides the per-metric minimums (tests). */
export function benchmarkValues(input: ChartInput, filters: ChartFilter[] = [], o: { minSample?: Partial<Record<BenchmarkMetricId, number>> } = {}): MetricValues {
  const w = benchmarkWindow(input.now);
  const req = (selectors: Record<string, string> = {}) => ({ resolution: "month" as const, rangeStart: w.from, rangeEnd: w.to, expand: true, selectors });
  // Filtered once, the same way Charts filters (customer dimensions filter customers and everything they did).
  const base = filters.length ? restrict(input, filters) : input;
  const run = (name: string, selectors?: Record<string, string>) => runChart(chartDef(name)!, base, req(selectors)).output;
  const min = (id: BenchmarkMetricId) => o.minSample?.[id] ?? benchmarkMetric(id)!.min_sample;
  const out: MetricValues = {};
  const put = (id: BenchmarkMetricId, value: number | null, sample: number) => { out[id] = { value: sample >= min(id) && value !== null && Number.isFinite(value) ? value : null, sample }; };

  // Measures in catalog order: [rate, numerator, denominator] for the conversion and LTV charts.
  const ic = sums(run("initial_conversion", { conversion_timeframe: "7_days" }), true);
  put("initial_conversion", pct(ic[1]!, ic[2]!), ic[2]!);
  const tc = sums(run("trial_conversion_rate"), false); // [rate, trials, conversions, pending]
  const finished = tc[1]! - tc[3]!;
  put("trial_conversion", pct(tc[2]!, finished), finished);
  const cp = sums(run("conversion_to_paying", { conversion_timeframe: "7_days" }), true);
  put("conversion_to_paying", pct(cp[1]!, cp[2]!), cp[2]!);
  const ch = sums(run("churn"), true); // [rate, actives, churned]
  put("churn", pct(ch[2]!, ch[1]!), ch[1]!);
  const rr = sums(run("refund_rate"), false); // [rate, transactions, refunded]
  put("refund_rate", pct(rr[2]!, rr[1]!), rr[1]!);
  const lc = sums(run("ltv_per_customer", { customer_lifetime: "30_days" }), true); // [ltv, revenue, customers]
  put("ltv_per_customer", ratio(lc[1]!, lc[2]!), lc[2]!);
  const lp = sums(run("ltv_per_paying_customer", { customer_lifetime: "30_days" }), true); // [ltv, revenue, paying]
  put("ltv_per_paying_customer", ratio(lp[1]!, lp[2]!), lp[2]!);
  const rev = sums(run("revenue"), true)[0]!;
  const act = sums(run("customers_active"), true)[0]!;
  put("arpu", ratio(rev, act), act);

  // Prices: what customers paid (USD at the purchase date) for 1-month and 1-year subscriptions in the window.
  const product = productIndex(input.products);
  const monthly: number[] = [], annual: number[] = [];
  for (const t of base.txs) {
    if ((t.kind !== "purchase" && t.kind !== "renewal") || isExcludedStore(t.store) || t.usd <= 0 || t.at < w.from || t.at >= w.to) continue;
    const d = product(t.appId, t.productId)?.duration;
    if (d === "P1M") monthly.push(t.usd); else if (d === "P1Y") annual.push(t.usd);
  }
  put("price_monthly", median(monthly), monthly.length);
  put("price_annual", median(annual), annual.length);
  return out;
}

/**
 * Every slice of one project: the whole project, iOS and Android when it has customers there, and up to
 * MAX_COUNTRY_SLICES countries by number of customers. A slice whose metrics are all under their minimum is left out.
 */
export function projectBenchmarkSlices(input: ChartInput, o: { minSample?: Partial<Record<BenchmarkMetricId, number>> } = {}): BenchmarkSlice[] {
  const out: BenchmarkSlice[] = [{ platform: ALL, country: ALL, metrics: benchmarkValues(input, [], o) }];
  const byPlatform = new Map<string, string[]>();
  for (const v of dimValues(input, "platform" as Dim)) { const p = benchmarkPlatform(v); if (p) byPlatform.set(p, [...(byPlatform.get(p) ?? []), v]); }
  for (const [platform, values] of byPlatform) out.push({ platform, country: ALL, metrics: benchmarkValues(input, [{ name: "platform", values }], o) });
  const countries = dimValues(input, "country").filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, MAX_COUNTRY_SLICES);
  for (const country of countries) out.push({ platform: ALL, country, metrics: benchmarkValues(input, [{ name: "country", values: [country] }], o) });
  return out.filter((s, i) => i === 0 || Object.values(s.metrics).some((m) => m?.value !== null && m?.value !== undefined));
}

export interface BenchmarkContribution { projectId: string; category: string; platform: string; country: string; metrics: MetricValues }
export interface BenchmarkAggregate {
  category: string; platform: string; country: string; metric: BenchmarkMetricId;
  /** Contributing projects, rounded down to a multiple of 5. */
  projects: number;
  p10: number | null; p25: number; p50: number; p75: number; p90: number | null;
}

/** Linear interpolation between closest ranks (the usual "type 7" percentile). */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (h - lo);
}
export const roundedCount = (n: number) => Math.floor(n / 5) * 5;

/**
 * Peer percentiles for every group with at least `k` projects. Each project counts once per group and metric, in its own
 * category and in "all" categories. Values under a project's minimum sample (null) do not count.
 */
export function aggregateBenchmarks(rows: BenchmarkContribution[], o: { k?: number; kDeciles?: number } = {}): BenchmarkAggregate[] {
  const k = Math.max(o.k ?? K_ANONYMITY, 2), kd = Math.max(o.kDeciles ?? K_DECILES, k);
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    for (const category of new Set([r.category, ALL])) {
      for (const [metric, v] of Object.entries(r.metrics)) {
        if (!v || v.value === null || !Number.isFinite(v.value) || !benchmarkMetric(metric)) continue;
        const key = `${category}\u0000${r.platform}\u0000${r.country}\u0000${metric}`;
        const g = groups.get(key) ?? groups.set(key, new Map()).get(key)!;
        g.set(r.projectId, v.value);
      }
    }
  }
  const out: BenchmarkAggregate[] = [];
  for (const [key, byProject] of groups) {
    if (byProject.size < k) continue;
    const [category, platform, country, metric] = key.split("\u0000") as [string, string, string, BenchmarkMetricId];
    const s = [...byProject.values()].sort((a, b) => a - b);
    const deciles = s.length >= kd;
    out.push({
      category, platform, country, metric, projects: roundedCount(s.length),
      p10: deciles ? percentile(s, 0.1) : null, p25: percentile(s, 0.25), p50: percentile(s, 0.5), p75: percentile(s, 0.75), p90: deciles ? percentile(s, 0.9) : null,
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.platform.localeCompare(b.platform) || a.country.localeCompare(b.country) || a.metric.localeCompare(b.metric));
}

export type Standing = "top_quarter" | "above_median" | "below_median" | "bottom_quarter";
export interface PeerComparison {
  metric: BenchmarkMetricId;
  value: number | null;
  sample: number;
  peers: Omit<BenchmarkAggregate, "category" | "platform" | "country" | "metric"> | null;
  /** Estimated percentile of the value among peers (1–99), from the published percentiles. */
  percentile: number | null;
  /** Where the value stands in the "better" direction; for neutral metrics, in the direction of higher values. */
  standing: Standing | null;
}

/** An estimate of where `v` sits among peers, read off the published percentiles (1 to 99). */
export function estimatePercentile(v: number, a: Pick<BenchmarkAggregate, "p10" | "p25" | "p50" | "p75" | "p90">): number {
  const pts: [number, number][] = [];
  if (a.p10 !== null) pts.push([a.p10, 10]);
  pts.push([a.p25, 25], [a.p50, 50], [a.p75, 75]);
  if (a.p90 !== null) pts.push([a.p90, 90]);
  if (v <= pts[0]![0]) return Math.max(1, v === pts[0]![0] ? pts[0]![1] : pts[0]![1] / 2);
  if (v >= pts[pts.length - 1]![0]) return Math.min(99, v === pts[pts.length - 1]![0] ? pts[pts.length - 1]![1] : (100 + pts[pts.length - 1]![1]) / 2);
  for (let i = 1; i < pts.length; i++) {
    const [x0, p0] = pts[i - 1]!, [x1, p1] = pts[i]!;
    if (v <= x1) return x1 === x0 ? p1 : p0 + ((v - x0) / (x1 - x0)) * (p1 - p0);
  }
  return 50;
}

export function compareToPeers(own: MetricValues | null, groups: Partial<Record<BenchmarkMetricId, BenchmarkAggregate>>, o: { k?: number } = {}): { rows: PeerComparison[]; opportunity: BenchmarkMetricId | null } {
  const k = o.k ?? K_ANONYMITY;
  const rows = BENCHMARK_METRICS.map((def): PeerComparison => {
    const g = groups[def.id];
    // Checked again on read: a group under k is never shown, whatever is stored.
    const peers = g && g.projects >= k ? { projects: g.projects, p10: g.p10, p25: g.p25, p50: g.p50, p75: g.p75, p90: g.p90 } : null;
    const mine = own?.[def.id];
    const value = mine?.value ?? null;
    let pctile: number | null = null, standing: Standing | null = null;
    if (peers && value !== null) {
      pctile = Math.round(estimatePercentile(value, peers));
      const good = def.better === "lower" ? 100 - pctile : pctile;
      standing = good >= 75 ? "top_quarter" : good >= 50 ? "above_median" : good > 25 ? "below_median" : "bottom_quarter";
    }
    return { metric: def.id, value, sample: mine?.sample ?? 0, peers, percentile: pctile, standing };
  });
  // The biggest opportunity: the judged metric where the project stands lowest, below the median.
  let opportunity: BenchmarkMetricId | null = null, worst = 50;
  for (const r of rows) {
    const def = benchmarkMetric(r.metric)!;
    if (def.better === "neutral" || r.percentile === null) continue;
    const good = def.better === "lower" ? 100 - r.percentile : r.percentile;
    if (good < worst) { worst = good; opportunity = r.metric; }
  }
  return { rows, opportunity };
}
