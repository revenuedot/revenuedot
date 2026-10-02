import { describe, expect, it } from "vitest";
import {
  assignVariant, chanceMeanBeats, chanceRateBeats, computeExperimentResults, csvCell, dailyCsv, EXPERIMENT_METRICS, hash16, liftInterval, logGamma,
  meanInterval, normalCdf, normalQuantile, PRIMARY_METRIC_IDS, rateSe, sampleSizeMean, sampleSizeRate, summarize, summaryCsv, TYPE_DEFAULTS, variantIndex,
  variantSignature, wilson, type ChartTx, type ResultsInput,
} from "../src/index.js";

// Reference values from scipy 1.17 (scipy.stats.norm, scipy.stats.beta numerically integrated) and published tables.
describe("experiment statistics", () => {
  it("normal CDF and quantile match scipy", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 6);
    expect(normalCdf(0.5)).toBeCloseTo(0.6914625, 6);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 6);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
    expect(logGamma(10)).toBeCloseTo(Math.log(362880), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
  });

  it("Wilson score intervals", () => {
    const w = wilson(10, 100)!;
    expect(w.lower).toBeCloseTo(0.0552291, 6);
    expect(w.upper).toBeCloseTo(0.1743657, 6);
    expect(wilson(0, 50)).toEqual({ lower: 0, upper: expect.closeTo(0.0713476, 6) });
    expect(wilson(50, 50)!.lower).toBeCloseTo(0.9286524, 6);
    expect(wilson(50, 50)!.upper).toBe(1);
    expect(wilson(0, 0)).toBeNull();
  });

  it("chance to beat: exact Beta posteriors, both sum directions, and the large-sample path", () => {
    // Beta(2,1) vs Beta(1,1): P(B > A) = ∫ 2x(1−x) dx = 1/3.
    expect(chanceRateBeats(0, 0, 1, 1)).toBeCloseTo(1 / 3, 10);
    expect(chanceRateBeats(60, 1000, 50, 1000)).toBeCloseTo(0.8356113, 6);
    expect(chanceRateBeats(15, 100, 10, 100)).toBeCloseTo(0.8532838, 6);
    // Symmetry: the two directions add up to 1, whichever alpha the sum runs over.
    expect(chanceRateBeats(50, 1000, 60, 1000) + chanceRateBeats(60, 1000, 50, 1000)).toBeCloseTo(1, 10);
    expect(chanceRateBeats(5200, 100000, 5000, 100000)).toBeCloseTo(0.9789617, 4);
    // Beyond 20,000 successes on both sides the normal approximation answers.
    const big = chanceRateBeats(30500, 300000, 30000, 300000);
    expect(big).toBeGreaterThan(0.98);
    expect(big).toBeLessThan(1);
    expect(chanceRateBeats(10, 100, 10, 100)).toBeCloseTo(0.5, 6);
  });

  it("means: normal interval, chance, lift by the delta method, sample sizes", () => {
    const s = summarize([0, 10, 20]);
    expect(s).toMatchObject({ n: 3, mean: 10, sd: 10 });
    expect(meanInterval(s)!.upper).toBeCloseTo(10 + 1.959964 * 10 / Math.sqrt(3), 5);
    expect(meanInterval(s)!.lower).toBe(0);
    expect(chanceMeanBeats({ n: 400, mean: 12, sd: 20, se: 1 }, { n: 400, mean: 10, sd: 18, se: 0.9 })).toBeCloseTo(0.9314382, 6);
    const lift = liftInterval({ value: 0.06, se: rateSe(60, 1000) }, { value: 0.05, se: rateSe(50, 1000) })!;
    expect(lift.lift).toBeCloseTo(0.2, 10);
    expect(lift.lower).toBeCloseTo(-0.1669019, 6);
    expect(lift.upper).toBeCloseTo(0.7284879, 6);
    expect(liftInterval({ value: 0.1, se: 0.01 }, { value: 0, se: 0 })).toBeNull();
    expect(sampleSizeRate(0.1)).toBe(3839);
    expect(sampleSizeMean(10, 25)).toBe(2453);
    expect(sampleSizeRate(0)).toBeNull();
  });
});

describe("variant assignment", () => {
  const legacy = async (exp: string, cust: string) => {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${exp}:variant:${cust}`)));
    return ((h[0]! << 8) | h[1]!) % 100 < 50 ? "a" : "b";
  };
  it("two variants split exactly as the A/B release did, for 10,000 customers", async () => {
    for (let i = 0; i < 10_000; i++) expect(await assignVariant("prexp_legacy", `cust_${i}`, ["a", "b"])).toBe(await legacy("prexp_legacy", `cust_${i}`));
  });
  it("three and four variants split evenly and stay stable", async () => {
    for (const ids of [["a", "b", "c"], ["a", "b", "c", "d"]]) {
      const n = 30_000;
      const counts: Record<string, number> = {};
      for (let i = 0; i < n; i++) { const v = await assignVariant("prexp_multi", `c${i}`, ids); counts[v] = (counts[v] ?? 0) + 1; }
      for (const id of ids) expect(Math.abs(counts[id]! / n - 1 / ids.length)).toBeLessThan(0.02);
      for (let i = 0; i < 200; i++) expect(await assignVariant("prexp_multi", `c${i}`, ids)).toBe(await assignVariant("prexp_multi", `c${i}`, ids));
    }
    expect(variantIndex(49, 2)).toBe(0);
    expect(variantIndex(50, 2)).toBe(1);
    expect(variantIndex(99, 4)).toBe(3);
    expect(variantIndex(65535, 3)).toBe(65535 % 3);
    expect(await hash16("x")).toBeLessThan(65536);
  });
  it("catalog: every type default names real metrics, primaries have intervals, identical variants share a signature", () => {
    const ids = new Set(EXPERIMENT_METRICS.map((m) => m.id));
    for (const d of Object.values(TYPE_DEFAULTS)) {
      expect(PRIMARY_METRIC_IDS).toContain(d.primary);
      for (const s of d.secondary) expect(ids.has(s)).toBe(true);
    }
    expect(variantSignature({ offering_id: "o1", placements: { x: "o2", y: null } })).toBe(variantSignature({ offering_id: "o1", placements: { y: null, x: "o2" } }));
    expect(variantSignature({ offering_id: "o1", placements: {} })).not.toBe(variantSignature({ offering_id: "o2", placements: {} }));
  });
});

describe("experiment results from a ledger", () => {
  const DAY = 86_400_000, H = 3_600_000;
  const base = Date.UTC(2026, 8, 1);
  const d = (n: number, h = 0) => base + n * DAY + h * H;
  let seq = 0;
  const tx = (customerId: string, kind: ChartTx["kind"], at: number, usd: number, o: Partial<ChartTx> = {}): ChartTx =>
    ({ id: `t${seq++}`, customerId, appId: "app1", store: "app_store", storeTransactionId: o.storeTransactionId ?? `s${seq}`, productId: "monthly", kind, at, expiresAt: null, usd, country: "US", ...o });
  const input = (): ResultsInput => ({
    now: d(30, 12),
    variants: [{ id: "a", name: "Control", offering_id: "o_a" }, { id: "b", name: "Treatment B", offering_id: "o_b" }],
    controlId: "a",
    primaryMetric: "conversion_to_paying",
    enrollments: [
      { customerId: "c1", variant: "a", enrolledAt: d(0, 1) }, { customerId: "c2", variant: "a", enrolledAt: d(0, 1) }, { customerId: "c3", variant: "a", enrolledAt: d(2) },
      { customerId: "c4", variant: "b", enrolledAt: d(0, 1) }, { customerId: "c5", variant: "b", enrolledAt: d(1) }, { customerId: "c6", variant: "b", enrolledAt: d(1) },
      { customerId: "c7", variant: "b", enrolledAt: d(1) },
    ],
    txs: [
      // c1: a 7-day trial that converts.
      tx("c1", "trial", d(1, 2), 0, { expiresAt: d(8, 2) }), tx("c1", "renewal", d(8, 2), 10, { expiresAt: d(38, 2) }),
      // c3: subscribed before joining; its renewal after joining does not count.
      tx("c3", "purchase", d(-20), 5, { expiresAt: d(10) }), tx("c3", "renewal", d(10), 5, { expiresAt: d(40) }),
      // c4: a one-time purchase, refunded two days later.
      tx("c4", "one_time", d(3), 20, { storeTransactionId: "t4", productId: "lifetime" }), tx("c4", "refund", d(5), -20, { storeTransactionId: "t4", productId: "lifetime" }),
      // c5: an annual subscription. c6: a trial that lapses. c7: a month that is not renewed.
      tx("c5", "purchase", d(2), 50, { productId: "annual", expiresAt: d(367) }),
      tx("c6", "trial", d(2), 0, { expiresAt: d(9) }),
      tx("c7", "purchase", d(2), 10, { expiresAt: d(12) }),
    ],
    products: [{ appId: "app1", storeIdentifier: "monthly", type: "subscription", duration: "P1M" }, { appId: "app1", storeIdentifier: "annual", type: "subscription", duration: "P1Y" },
      { appId: "app1", storeIdentifier: "lifetime", type: "non_consumable", duration: null }],
    subStates: [], lifecycle: [], paywallViews: [{ customerId: "c1", at: d(0, 2) }, { customerId: "c5", at: d(1, 1) }, { customerId: "c2", at: d(-1) }], paywall: "all",
  });

  it("counts conversions, trials, payers, churn, refunds, revenue and MRR per variant", () => {
    const r = computeExperimentResults(input());
    const [a, b] = r.variants;
    const v = (x: typeof a, id: string) => x!.metrics[id]!.value;
    expect(a).toMatchObject({ id: "a", customers: 3, paywall_viewers: 1 });
    expect(b).toMatchObject({ id: "b", customers: 4, paywall_viewers: 1 });
    expect([v(a, "initial_conversions"), v(a, "trials_started"), v(a, "trials_completed"), v(a, "trials_converted"), v(a, "paid_customers"), v(a, "active_subscribers"), v(a, "churned_subscribers"), v(a, "refunded_customers")])
      .toEqual([1, 1, 1, 1, 1, 1, 0, 0]);
    expect([v(b, "initial_conversions"), v(b, "trials_started"), v(b, "trials_completed"), v(b, "trials_converted"), v(b, "paid_customers"), v(b, "active_subscribers"), v(b, "churned_subscribers"), v(b, "refunded_customers")])
      .toEqual([4, 1, 1, 0, 3, 1, 1, 1]);
    expect(v(a, "realized_ltv")).toBe(10);
    expect(v(b, "realized_ltv")).toBe(60);
    expect(v(a, "mrr")).toBe(10);
    expect(v(b, "mrr")).toBeCloseTo(50 / 12, 2);
    expect(a!.metrics.initial_conversion_rate).toMatchObject({ value: expect.closeTo(1 / 3, 6), numerator: 1, denominator: 3 });
    expect(b!.metrics.refund_rate).toMatchObject({ numerator: 1, denominator: 3 });
    expect(b!.metrics.realized_ltv_per_customer!.value).toBe(15);
    expect(b!.metrics.realized_ltv_per_paying_customer!.value).toBe(20);
    expect(a!.metrics.conversion_to_paying!.chance_to_beat_control).toBeUndefined();
    // b converts 3 of 4 to paying against 1 of 3.
    expect(b!.metrics.conversion_to_paying!.chance_to_beat_control).toBeCloseTo(chanceRateBeats(3, 4, 1, 3), 4);
    expect(b!.metrics.conversion_to_paying!.lift).toBeCloseTo(0.75 / (1 / 3) - 1, 6);
    // Lower refund rate wins: b has one refund among 3 payers, the control none.
    expect(b!.metrics.refund_rate!.chance_to_beat_control).toBeLessThan(0.5);
    expect(r.guidance.enough_data).toBe(false);
    expect(r.guidance.message).toMatch(/^Too early to call/);
  });

  it("builds a daily series as of each day's end", () => {
    const r = computeExperimentResults(input());
    expect(r.series.days.length).toBe(31);
    expect(r.series.days[0]).toBe(base);
    const ltvB = r.series.values.realized_ltv!.b!;
    expect(ltvB[1]).toBe(0);
    expect(ltvB[3]).toBe(80);
    expect(ltvB[5]).toBe(60);
    expect(r.series.values.customers ?? null).toBeNull();
    expect(r.series.values.trials_converted!.a![7]).toBe(0);
    expect(r.series.values.trials_converted!.a![8]).toBe(1);
    expect(r.series.values.active_subscribers!.b![11]).toBe(2);
    expect(r.series.values.active_subscribers!.b![12]).toBe(1);
  });

  it("filters by paywall views after joining", () => {
    const viewed = computeExperimentResults({ ...input(), paywall: "viewed" });
    expect(viewed.variants.map((x) => x.customers)).toEqual([1, 1]);
    const not = computeExperimentResults({ ...input(), paywall: "not_viewed" });
    expect(not.variants.map((x) => x.customers)).toEqual([2, 3]);
  });

  it("calls a winner with enough data", () => {
    const enrollments: ResultsInput["enrollments"] = [], txs: ChartTx[] = [];
    for (let i = 0; i < 400; i++) {
      const variant = i % 2 ? "b" : "a";
      enrollments.push({ customerId: `x${i}`, variant, enrolledAt: d(0) });
      if ((variant === "a" && i % 20 === 0) || (variant === "b" && i % 6 === 1)) txs.push(tx(`x${i}`, "purchase", d(1), 10, { expiresAt: d(31) }));
    }
    const r = computeExperimentResults({ ...input(), enrollments, txs, paywallViews: [] });
    expect(r.variants.map((x) => x.customers)).toEqual([200, 200]);
    expect(r.guidance.enough_data).toBe(true);
    expect(r.guidance.leader?.variant_id).toBe("b");
    expect(r.guidance.message).toMatch(/^Treatment B leads: \d+% chance to beat the control on Conversion to paying\./);
  });

  it("writes summary and daily CSV with safe cells", () => {
    const i = input();
    i.variants[1]!.name = '=HYPERLINK("x"), "B"';
    const r = computeExperimentResults(i);
    const s = summaryCsv(r).split("\r\n");
    expect(s[0]).toBe("variant_id,variant_name,offering_id,customers,metric,metric_name,value,numerator,denominator,lower_95,upper_95,lift,lift_lower_95,lift_upper_95,chance_to_beat_control");
    expect(s.length).toBe(1 + 2 * EXPERIMENT_METRICS.length + 1);
    expect(s.find((l) => l.startsWith("b,") && l.includes(",realized_ltv,"))).toBe(`b,"'=HYPERLINK(""x""), ""B""",o_b,4,realized_ltv,Realized LTV,60,,,,,,,,`);
    const daily = dailyCsv(r).split("\r\n");
    expect(daily[0]!.split(",").slice(0, 4)).toEqual(["date", "variant_id", "variant_name", "initial_conversion_rate"]);
    expect(daily.length).toBe(1 + 31 * 2 + 1);
    expect(daily[1]!.startsWith("2026-09-01,a,Control,")).toBe(true);
    expect(csvCell(-0.12)).toBe("-0.12");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell(null)).toBe("");
  });
});
