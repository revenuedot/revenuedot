import { describe, expect, it } from "vitest";
import {
  buckets, buildSubscriptions, chartDef, CHARTS, API_CHART_NAMES, floorTo, mrrFactor, runChart, hasComputation,
  type ChartInput, type ChartTx, type ChartRequest,
} from "../src/index.js";

const DAY = 86_400_000;
const T = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
const NOW = T("2026-06-30T12:00:00Z");

let n = 0;
function tx(customerId: string, productId: string, kind: ChartTx["kind"], at: string, expires: string | null, usd: number, o: Partial<ChartTx> = {}): ChartTx {
  return { id: `t${n++}`, customerId, appId: "ios", store: "app_store", storeTransactionId: o.storeTransactionId ?? `${customerId}-${at}`, productId, kind, at: T(at), expiresAt: expires ? T(expires) : null, usd, country: "US", ...o };
}
const monthly = (c: string, from: string, periods: number, usd = 10, product = "monthly") => {
  const out: ChartTx[] = [];
  let d = new Date(T(from));
  for (let i = 0; i < periods; i++) {
    const e = new Date(d); e.setUTCMonth(e.getUTCMonth() + 1);
    out.push(tx(c, product, i === 0 ? "purchase" : "renewal", d.toISOString(), e.toISOString(), usd));
    d = e;
  }
  return out;
};

/**
 * A: monthly $10 from Jan 1, six periods (active now).
 * B: 7-day trial Mar 1, converts Mar 8, renews Apr 8, lapses May 8.
 * C: trial Apr 1–8, never converts.
 * D: annual $120 on Feb 15, refunded Feb 20.
 * E: weekly $5 from Jun 1 (five periods, active now).
 * F: monthly Jan 10 and Feb 10, lapses Mar 10, resubscribes Apr 20, lapses May 20.
 * G: monthly $10 on Mar 1, upgrades to annual $240 on Mar 15.
 * H: one-time purchase $30 on May 5.
 */
function ledger(): ChartTx[] {
  const e: ChartTx[] = [];
  for (let i = 0; i < 5; i++) e.push(tx("E", "weekly", i ? "renewal" : "purchase", new Date(T("2026-06-01") + i * 7 * DAY).toISOString(), new Date(T("2026-06-01") + (i + 1) * 7 * DAY).toISOString(), 5, { country: "DE" }));
  return [
    ...monthly("A", "2026-01-01", 6),
    tx("B", "monthly", "trial", "2026-03-01", "2026-03-08", 0), tx("B", "monthly", "renewal", "2026-03-08", "2026-04-08", 10), tx("B", "monthly", "renewal", "2026-04-08", "2026-05-08", 10),
    tx("C", "monthly", "trial", "2026-04-01", "2026-04-08", 0),
    tx("D", "annual", "purchase", "2026-02-15", "2027-02-15", 120, { storeTransactionId: "D1" }), tx("D", "annual", "refund", "2026-02-20", null, -120, { storeTransactionId: "D1" }),
    ...e,
    ...monthly("F", "2026-01-10", 2), ...monthly("F", "2026-04-20", 1),
    tx("G", "monthly", "purchase", "2026-03-01", "2026-04-01", 10), tx("G", "annual", "purchase", "2026-03-15", "2027-03-15", 240),
    tx("H", "coins", "one_time", "2026-05-05", null, 30),
  ];
}
function input(txs = ledger(), extra: Partial<ChartInput> = {}): ChartInput {
  const first = new Map<string, number>();
  for (const t of txs) first.set(t.customerId, Math.min(first.get(t.customerId) ?? Infinity, t.at));
  return {
    now: NOW, txs,
    customers: [...first].map(([id, at]) => ({ id, firstSeen: at, country: id === "E" ? "DE" : "US", platform: "iOS", appVersion: "1.0" })),
    products: [
      { appId: "ios", storeIdentifier: "monthly", type: "subscription", duration: "P1M" }, { appId: "ios", storeIdentifier: "annual", type: "subscription", duration: "P1Y" },
      { appId: "ios", storeIdentifier: "weekly", type: "subscription", duration: "P1W" }, { appId: "ios", storeIdentifier: "coins", type: "consumable", duration: null },
    ],
    subStates: [], lifecycle: [], sdkEvents: [], refundEvents: [], activity: [], fx: () => 1,
    ...extra,
  };
}
const req = (o: Partial<ChartRequest> = {}): ChartRequest => ({ resolution: "month", rangeStart: T("2026-01-01"), rangeEnd: T("2026-07-01"), expand: false, selectors: {}, ...o });
const series = (name: string, inp = input(), r = req()) => {
  const out = runChart(chartDef(name)!, inp, r).output;
  if (out.kind !== "series") throw new Error("not a series");
  return { out, col: (i = 0) => out.points.map((p) => p.values[i]), at: (month: string, i = 0) => out.points.find((p) => p.start === T(month))!.values[i] };
};

describe("chart periods", () => {
  it("floors to UTC days, Monday weeks, months, quarters and years", () => {
    expect(floorTo(T("2026-07-01T15:00:00Z"), "week")).toBe(T("2026-06-29"));
    expect(floorTo(T("2026-08-17T00:00:00Z"), "quarter")).toBe(T("2026-07-01"));
    expect(buckets(T("2026-01-15"), T("2026-03-02"), "month").map((b) => new Date(b.start).toISOString().slice(0, 10))).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
  });
  it("normalises prices to a month with RevenueCat's table", () => {
    expect(mrrFactor("P1D")).toBe(30);
    expect(mrrFactor("P3D")).toBe(10);
    expect(mrrFactor("P1W")).toBe(4);
    expect(mrrFactor("P2W")).toBe(2);
    expect(mrrFactor("P4W")).toBe(1);
    expect(mrrFactor("P1M")).toBe(1);
    expect(mrrFactor("P3M")).toBeCloseTo(1 / 3);
    expect(mrrFactor("P6M")).toBeCloseTo(1 / 6);
    expect(mrrFactor("P1Y")).toBeCloseTo(1 / 12);
    expect(mrrFactor(null)).toBeNull();
  });
});

describe("catalog", () => {
  it("has every chart: 42 in the rail, 41 API names, all computable", () => {
    expect(CHARTS).toHaveLength(43);
    expect(CHARTS.filter((c) => c.inRail)).toHaveLength(42);
    expect(API_CHART_NAMES).toHaveLength(41);
    for (const c of CHARTS) expect(hasComputation(c.name), c.name).toBe(true);
  });
});

describe("subscriptions from the ledger", () => {
  const subs = buildSubscriptions(input());
  const of = (c: string) => subs.filter((s) => s.customerId === c).sort((a, b) => a.start - b.start);
  it("joins renewals, starts a resubscription after a lapse, and marks trial conversions", () => {
    expect(of("A")).toHaveLength(1);
    expect(of("A")[0]!.end).toBe(T("2026-07-01"));
    expect(of("F").map((s) => s.origin)).toEqual(["new", "resubscription"]);
    const b = of("B")[0]!;
    expect([b.trialStart, b.trialEnd, b.paidStart]).toEqual([T("2026-03-01"), T("2026-03-08"), T("2026-03-08")]);
    expect(of("C")[0]!.paidStart).toBeNull();
  });
  it("cuts a refunded period at the refund and ends a replaced product at the change", () => {
    expect(of("D")[0]!.end).toBe(T("2026-02-20"));
    const [m, a] = of("G");
    expect(a!.origin).toBe("product_change");
    expect(m!.end).toBe(T("2026-03-15"));
    expect(m!.replacedAt).toBe(T("2026-03-15"));
  });
  it("keeps a billing recovery in the same subscription and extends the last period by a grace period", () => {
    const txs = [tx("R", "monthly", "purchase", "2026-01-01", "2026-02-01", 10), tx("R", "monthly", "renewal", "2026-02-10", "2026-03-10", 10)];
    const withIssue = buildSubscriptions(input(txs, { lifecycle: [{ customerId: "R", store: "app_store", productId: "monthly", type: "BILLING_ISSUE", at: T("2026-02-01T01:00:00Z") }] }));
    expect(withIssue).toHaveLength(1);
    expect(withIssue[0]!.gaps).toEqual([{ from: T("2026-02-01"), to: T("2026-02-10") }]);
    expect(buildSubscriptions(input(txs))).toHaveLength(2);
    const grace = buildSubscriptions(input([tx("Q", "monthly", "purchase", "2026-06-01", "2026-06-29", 10)], {
      subStates: [{ customerId: "Q", store: "app_store", appId: "ios", productId: "monthly", expiresAt: T("2026-06-29"), autoRenew: true, billingIssue: true, graceUntil: T("2026-07-10"), familyShared: false, offering: null, cancelSurveyReason: null, unsubscribeAt: null }],
    }));
    expect(grace[0]!.end).toBe(T("2026-07-10"));
  });
});

describe("charts on a hand-built ledger", () => {
  it("active subscriptions, MRR and ARR at the end of each month", () => {
    expect(series("actives").col()).toEqual([2, 2, 3, 4, 2, 3]);
    // Jun (now): A 10 + G 240/12 + E 5×4.
    expect(series("mrr").col()).toEqual([20, 20, 40, 50, 30, 50]);
    expect(series("arr").at("2026-06-01")).toBe(600);
    expect(series("actives").out.points.map((p) => p.incomplete)).toEqual([false, false, false, false, false, true]);
  });
  it("movements add up to the change in the stock", () => {
    const mv = series("actives_movement");
    // [new, resubscription, churned, movement] per month.
    expect(mv.out.points.map((p) => p.values)).toEqual([[2, 0, 0, 2], [1, 0, -1, 0], [2, 0, -1, 1], [0, 1, 0, 1], [0, 0, -2, -2], [1, 0, 0, 1]]);
    const mm = series("mrr_movement");
    // March: B and G's monthly are new (+20), G's upgrade expands by 10, F churns 10.
    expect(mm.out.points[2]!.values).toEqual([20, 0, 10, -10, 0, 20]);
    const m = series("mrr").col() as number[];
    mm.out.points.forEach((p, i) => expect(p.values[5]).toBeCloseTo(m[i]! - (i ? m[i - 1]! : 0)));
  });
  it("paid subscriptions by how they started; churn rate counts product-change replacements", () => {
    const pn = series("actives_new");
    expect(pn.out.points[2]!.values).toEqual([3, 1, 1, 1, 0]);
    expect(pn.out.points[3]!.values).toEqual([1, 0, 0, 0, 1]);
    const ch = series("churn");
    expect(ch.out.points[2]!.values).toEqual([100, 2, 2]);
    expect(ch.out.points[4]!.values).toEqual([50, 4, 2]);
  });
  it("revenue with refunds on the refund date, proceeds, transactions, refunds and refund rate", () => {
    const rv = series("revenue");
    expect(rv.out.points.map((p) => p.values)).toEqual([[20, 2], [20, 3], [270, 4], [30, 3], [40, 2], [35, 6]]);
    expect(series("revenue", input(), req({ selectors: { revenue_type: "proceeds" } })).at("2026-03-01")).toBeCloseTo(270 * 0.7);
    expect(series("refunds").at("2026-02-01")).toBe(120);
    expect(series("refund_rate").out.points[1]!.values).toEqual([(1 / 3) * 100, 3, 1]);
    expect(series("non-subscription_purchases").at("2026-05-01")).toBe(1);
  });
  it("trials by day, new trials and trial movement", () => {
    const daily = req({ resolution: "day", rangeStart: T("2026-03-01"), rangeEnd: T("2026-03-10") });
    expect(series("trials", input(), daily).col()).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0]);
    expect(series("trials_new").col()).toEqual([0, 0, 1, 1, 0, 0]);
    expect(series("trials_movement").out.points[3]!.values).toEqual([1, 0, -1, 0]);
    const rate = series("trial_conversion_rate").out.points;
    expect(rate[2]!.values).toEqual([100, 1, 1, 0]);
    expect(rate[3]!.values).toEqual([0, 1, 0, 0]);
  });
  it("filters by product and segments by country, with an Other segment past the limit", () => {
    const def = chartDef("actives")!;
    const r = runChart(def, input(), req(), { filters: [{ name: "product", values: ["weekly"] }] });
    expect(r.output.kind === "series" && r.output.points.map((p) => p.values[0])).toEqual([0, 0, 0, 0, 0, 1]);
    const seg = runChart(def, input(), req(), { segment: "country", limit: 1 });
    expect(seg.segments!.map((s) => [s.id, s.isOther])).toEqual([["US", false], ["Other", true]]);
    const other = seg.segments![1]!.output;
    expect(other.kind === "series" && other.points.at(-1)!.values[0]).toBe(1);
  });
  it("subscription retention by paid start month", () => {
    const out = runChart(chartDef("subscription_retention")!, input(), req()).output;
    if (out.kind !== "cohort") throw new Error();
    const jan = out.rows[0]!.cells.map((c) => c.value);
    // A (6 paid periods) and F's first subscription (2): sizes, then period 0, 1, 2 …
    expect(jan.slice(0, 5)).toEqual([2, 100, 100, 50, 50]);
    expect(out.periods[0]!.unit).toBe("#");
    expect(out.periods[1]!.display_name).toBe("Period 0");
  });
});

describe("chart computation at scale", () => {
  it("reads per-customer and per-period slices, not the whole project per customer or per day", () => {
    // 20,000 customers with a trial (half convert), 20,000 paywall impressions and purchase starts, 365 daily periods.
    const txs: ChartTx[] = [];
    const sdkEvents: ChartInput["sdkEvents"] = [];
    for (let i = 0; i < 20_000; i++) {
      const start = T("2026-01-01") + (i % 170) * DAY;
      txs.push(tx(`c${i}`, "monthly", "trial", new Date(start).toISOString(), new Date(start + 7 * DAY).toISOString(), 0));
      if (i % 2) txs.push(tx(`c${i}`, "monthly", "renewal", new Date(start + 7 * DAY).toISOString(), new Date(start + 37 * DAY).toISOString(), 10));
      sdkEvents.push({ customerId: `c${i}`, appId: "ios", type: "paywall_impression", at: start - 1000, paywallId: "pw" }, { customerId: `c${i}`, appId: "ios", type: "paywall_purchase_initiated", at: start - 500, paywallId: "pw" });
    }
    const inp = input(txs, { sdkEvents });
    const daily = req({ resolution: "day", rangeStart: T("2026-01-01"), rangeEnd: T("2027-01-01") });
    const started = Date.now();
    for (const name of ["trial_conversion", "trial_cancellation", "paywall_conversion", "paywall_abandonment", "paywall_encounter", "revenue", "trials_movement", "customers_new"]) runChart(chartDef(name)!, inp, daily);
    runChart(chartDef("cohort_explorer")!, inp, req({ rangeStart: T("2026-01-01"), rangeEnd: T("2026-07-01"), selectors: { cohort_measure: "retained_subscriptions" } }));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(series("trial_conversion", inp, req()).at("2026-02-01", 2)).toBe(series("trials_new", inp, req()).at("2026-02-01")! / 2);
  }, 60_000);
});
