import { describe, expect, it } from "vitest";
import {
  aggregateBenchmarks, BENCHMARK_METRICS, benchmarkPlatform, benchmarkValues, benchmarkWindow, chartDef, compareToPeers, estimatePercentile, K_ANONYMITY, percentile,
  projectBenchmarkSlices, roundedCount, runChart,
  type BenchmarkAggregate, type BenchmarkContribution, type ChartInput, type ChartTx, type MetricValues,
} from "../src/index.js";

const DAY = 86_400_000;
const T = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
const NOW = T("2026-10-01T09:00:00Z");

/**
 * One project over the 12 months Oct 2025 – Sep 2026: 20 new customers a month (240), half on iOS, half on Android;
 * every 4th starts a 7-day trial; of those every 2nd converts ($10 monthly, two months); every 5th of the rest buys a
 * $50 annual subscription on day 0; one annual purchase in ten is refunded on day 2.
 */
function project(): ChartInput {
  let n = 0;
  const tx = (customerId: string, productId: string, kind: ChartTx["kind"], at: number, days: number | null, usd: number, o: Partial<ChartTx> = {}): ChartTx =>
    ({ id: `t${n++}`, customerId, appId: "ios", store: "app_store", storeTransactionId: o.storeTransactionId ?? `${customerId}-${kind}-${at}`, productId, kind, at, expiresAt: days === null ? null : at + days * DAY, usd, country: "US", ...o });
  const customers: ChartInput["customers"] = [];
  const txs: ChartTx[] = [];
  let i = 0;
  for (let m = 0; m < 12; m++) {
    const month = Date.UTC(2025, 9 + m, 1);
    for (let k = 0; k < 20; k++, i++) {
      const id = `c${i}`, at = month + (k + 1) * 3600_000 * 20;
      customers.push({ id, firstSeen: at, country: k % 3 ? "US" : "DE", platform: k % 2 ? "iOS" : "Android", appVersion: "1.0" });
      if (i % 4 === 0) {
        txs.push(tx(id, "monthly", "trial", at, 7, 0));
        if (i % 8 === 0) { txs.push(tx(id, "monthly", "renewal", at + 7 * DAY, 30, 10)); txs.push(tx(id, "monthly", "renewal", at + 37 * DAY, 30, 10)); }
      } else if (i % 5 === 0) {
        txs.push(tx(id, "annual", "purchase", at, 365, 50, { storeTransactionId: `a${i}` }));
        if (i % 50 === 5) txs.push(tx(id, "annual", "refund", at + 2 * DAY, null, -50, { storeTransactionId: `a${i}` }));
      }
    }
  }
  return {
    now: NOW, fx: () => 1, txs, customers, subStates: [], lifecycle: [], sdkEvents: [], refundEvents: [],
    activity: customers.map((c) => ({ customerId: c.id, day: Math.floor(c.firstSeen / DAY) * DAY })),
    products: [{ appId: "ios", storeIdentifier: "monthly", type: "subscription", duration: "P1M" }, { appId: "ios", storeIdentifier: "annual", type: "subscription", duration: "P1Y" }],
  };
}

describe("benchmarkValues", () => {
  it("uses the trailing 12 complete months", () => {
    expect(benchmarkWindow(NOW)).toEqual({ from: T("2025-10-01"), to: T("2026-10-01") });
  });

  it("matches the charts with the same definitions", () => {
    const input = project();
    const v = benchmarkValues(input);
    const w = benchmarkWindow(NOW);
    const req = (selectors: Record<string, string> = {}) => ({ resolution: "year" as const, rangeStart: w.from, rangeEnd: w.to, expand: true, selectors });
    // 240 customers: 60 trials (all 7-day, all finished), 30 converted; 36 annual buyers (i % 5 === 0 among non-trial customers).
    expect(v.initial_conversion).toEqual({ value: (96 / 240) * 100, sample: 240 });
    expect(v.trial_conversion).toEqual({ value: 50, sample: 60 });
    // Paid within 7 days: the 36 annual buyers minus the 4 refunded on day 2; trial conversions happen on day 7 (inside the window).
    const cp = runChart(chartDef("conversion_to_paying")!, input, { ...req({ conversion_timeframe: "7_days" }), resolution: "month" }).output;
    const paying = cp.kind === "series" ? cp.points.reduce((s, p) => s + (p.values[1] ?? 0), 0) : 0;
    expect(v.conversion_to_paying!.sample).toBe(240);
    expect(v.conversion_to_paying!.value).toBeCloseTo((paying / 240) * 100, 6);
    expect(v.refund_rate!.sample).toBeGreaterThanOrEqual(50);
    expect(v.price_annual).toEqual({ value: 50, sample: 36 });
    // 30 conversions renew twice, except the two September ones whose second renewal falls after the window.
    expect(v.price_monthly).toEqual({ value: 10, sample: 58 });
    expect(v.arpu!.sample).toBe(240);
  });

  it("leaves a metric out when the project has too little data for it", () => {
    const v = benchmarkValues(project(), [], { minSample: { trial_conversion: 61 } });
    expect(v.trial_conversion).toEqual({ value: null, sample: 60 });
    const small = benchmarkValues({ ...project(), customers: project().customers.slice(0, 50) });
    expect(small.initial_conversion!.value).toBeNull();
  });
});

describe("projectBenchmarkSlices", () => {
  it("adds iOS, Android and country slices with their own values", () => {
    const slices = projectBenchmarkSlices(project(), { minSample: { initial_conversion: 10, conversion_to_paying: 10, ltv_per_customer: 10, arpu: 10 } });
    expect(slices.map((s) => `${s.platform}/${s.country}`).sort()).toEqual(["all/DE", "all/US", "all/all", "android/all", "ios/all"]);
    const ios = slices.find((s) => s.platform === "ios")!;
    expect(ios.metrics.initial_conversion!.sample).toBe(120);
  });
  it("maps platforms the SDKs send", () => {
    expect(["iOS", "ipados", "macOS", "visionOS", "Android", "android", "web", null].map(benchmarkPlatform)).toEqual(["ios", "ios", "ios", "ios", "android", "android", null, null]);
  });
});

const contrib = (i: number, value: number | null, o: Partial<BenchmarkContribution> = {}): BenchmarkContribution =>
  ({ projectId: `p${i}`, category: "health_fitness", platform: "all", country: "all", metrics: { trial_conversion: { value, sample: 100 } }, ...o });

describe("aggregateBenchmarks (k-anonymity)", () => {
  it("publishes nothing for 9 projects", () => {
    expect(aggregateBenchmarks(Array.from({ length: 9 }, (_, i) => contrib(i, 30 + i)))).toEqual([]);
  });

  it("publishes quartiles only from 10 projects, in the category and in all categories", () => {
    const rows = aggregateBenchmarks(Array.from({ length: 10 }, (_, i) => contrib(i, 10 * (i + 1))));
    expect(rows.map((r) => r.category).sort()).toEqual(["all", "health_fitness"]);
    const r = rows.find((x) => x.category === "health_fitness")!;
    expect(r).toEqual({ category: "health_fitness", platform: "all", country: "all", metric: "trial_conversion", projects: 10, p10: null, p25: 32.5, p50: 55, p75: 77.5, p90: null });
    expect(Object.keys(r)).not.toContain("mean");
  });

  it("adds the 10th and 90th percentiles from 20 projects and rounds app counts down to 5", () => {
    expect(aggregateBenchmarks(Array.from({ length: 19 }, (_, i) => contrib(i, i)))[0]).toMatchObject({ projects: 15, p10: null, p90: null });
    const r = aggregateBenchmarks(Array.from({ length: 23 }, (_, i) => contrib(i, i)))[0]!;
    expect(r.projects).toBe(20);
    expect(r.p10).toBeCloseTo(2.2, 6);
    expect(r.p90).toBeCloseTo(19.8, 6);
  });

  it("needs 10 different owners: nine made-up projects of one account next to a real one publish nothing", () => {
    // One account's nine projects placed around the target would put its value at the median.
    const sock = Array.from({ length: 9 }, (_, i) => contrib(i, i < 4 ? 1 : 99, { owner: "user:mallory" }));
    expect(aggregateBenchmarks([...sock, contrib(9, 42, { owner: "user:victim" })])).toEqual([]);
    // Ten owners publish; the deciles need 20 owners as well as 20 projects.
    const ten = Array.from({ length: 20 }, (_, i) => contrib(i, i, { owner: `user:${i % 10}` }));
    expect(aggregateBenchmarks(ten)[0]).toMatchObject({ projects: 20, p10: null, p90: null });
  });

  it("counts only projects with enough data, each once", () => {
    const rows = [...Array.from({ length: 9 }, (_, i) => contrib(i, 40)), contrib(9, null), contrib(0, 99)];
    expect(aggregateBenchmarks(rows)).toEqual([]);
  });

  it("keeps platform and country groups apart, and a peer group of other categories counts only in all", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => contrib(i, 40)),
      ...Array.from({ length: 6 }, (_, i) => contrib(10 + i, 60, { category: "travel" })),
      ...Array.from({ length: 10 }, (_, i) => contrib(i, 50, { platform: "ios" })),
    ];
    const out = aggregateBenchmarks(rows);
    expect(out.map((r) => `${r.category}/${r.platform}`).sort()).toEqual(["all/all", "all/ios", "health_fitness/ios"]);
    expect(out.find((r) => r.category === "all" && r.platform === "all")!.projects).toBe(10);
  });

  it("computes type-7 percentiles and rounded counts", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5], 0.9)).toBe(5);
    expect([9, 10, 14, 15, 26].map(roundedCount)).toEqual([5, 10, 10, 15, 25]);
  });
});

describe("compareToPeers", () => {
  const g = (metric: BenchmarkAggregate["metric"], o: Partial<BenchmarkAggregate> = {}): BenchmarkAggregate =>
    ({ category: "all", platform: "all", country: "all", metric, projects: 20, p10: 10, p25: 20, p50: 30, p75: 40, p90: 50, ...o });
  it("places a value among peers, inverting lower-is-better metrics, and names the biggest opportunity", () => {
    const own: MetricValues = { trial_conversion: { value: 45, sample: 100 }, churn: { value: 45, sample: 100 }, refund_rate: { value: 25, sample: 100 }, price_monthly: { value: 5, sample: 50 } };
    const r = compareToPeers(own, { trial_conversion: g("trial_conversion"), churn: g("churn"), refund_rate: g("refund_rate"), price_monthly: g("price_monthly") });
    const by = Object.fromEntries(r.rows.map((x) => [x.metric, x]));
    expect(by.trial_conversion).toMatchObject({ percentile: 83, standing: "top_quarter" });
    expect(by.churn).toMatchObject({ percentile: 83, standing: "bottom_quarter" });
    expect(by.refund_rate).toMatchObject({ percentile: 38, standing: "above_median" });
    expect(by.price_monthly).toMatchObject({ percentile: 5, standing: "bottom_quarter" });
    expect(r.opportunity).toBe("churn");
    expect(by.initial_conversion).toMatchObject({ value: null, peers: null, standing: null });
  });
  it("never shows a group under k, whatever is stored", () => {
    const r = compareToPeers({ trial_conversion: { value: 45, sample: 100 } }, { trial_conversion: g("trial_conversion", { projects: K_ANONYMITY - 1 }) });
    expect(r.rows.find((x) => x.metric === "trial_conversion")!.peers).toBeNull();
    expect(r.opportunity).toBeNull();
  });
  it("estimates percentiles from quartiles alone", () => {
    const q = { p10: null, p25: 20, p50: 30, p75: 40, p90: null };
    expect(estimatePercentile(30, q)).toBe(50);
    expect(estimatePercentile(35, q)).toBe(62.5);
    expect(estimatePercentile(5, q)).toBe(12.5);
    expect(estimatePercentile(99, q)).toBe(87.5);
  });
  it("has a definition and a minimum sample for every metric", () => {
    for (const m of BENCHMARK_METRICS) { expect(m.min_sample).toBeGreaterThan(0); if (m.chart) expect(chartDef(m.chart.name)).toBeTruthy(); }
  });
});
