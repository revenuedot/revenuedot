import { describe, expect, it } from "vitest";
import {
  chartContributors, chartDef, CHARTS, contributorsMeasure, hasContributors, runChart,
  type ChartDef, type ChartInput, type ChartOutput, type ChartRequest, type ChartTx, type Contributor,
} from "../src/index.js";

/**
 * The Customers tab (prd/charts/PRD.md "Customers tab"): every chart lists the customers its numbers come from, and the
 * listed values add up to the chart: over the range for flows and cohorts, at the last period for snapshots.
 */
const DAY = 86_400_000;
const T = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
const NOW = T("2026-06-30T12:00:00Z");

let n = 0;
function tx(customerId: string, productId: string, kind: ChartTx["kind"], at: string, expires: string | null, usd: number, o: Partial<ChartTx> = {}): ChartTx {
  return { id: `t${n++}`, customerId, appId: "ios", store: "app_store", storeTransactionId: o.storeTransactionId ?? `${customerId}-${at}`, productId, kind, at: T(at), expiresAt: expires ? T(expires) : null, usd, country: "US", ...o };
}
const monthly = (c: string, from: string, periods: number, usd = 10, product = "monthly", o: Partial<ChartTx> = {}) => {
  const out: ChartTx[] = [];
  let d = new Date(T(from));
  for (let i = 0; i < periods; i++) {
    const e = new Date(d); e.setUTCMonth(e.getUTCMonth() + 1);
    out.push(tx(c, product, i === 0 ? "purchase" : "renewal", d.toISOString(), e.toISOString(), usd, o));
    d = e;
  }
  return out;
};

/** The ledger of charts.test.ts plus a Google Play cancellation, SDK events, activity days and Apple refund requests. */
function input(): ChartInput {
  const txs: ChartTx[] = [
    ...monthly("A", "2026-01-01", 6),
    tx("B", "monthly", "trial", "2026-03-01", "2026-03-08", 0), tx("B", "monthly", "renewal", "2026-03-08", "2026-04-08", 10), tx("B", "monthly", "renewal", "2026-04-08", "2026-05-08", 10),
    tx("C", "monthly", "trial", "2026-04-01", "2026-04-08", 0),
    tx("D", "annual", "purchase", "2026-02-15", "2027-02-15", 120, { storeTransactionId: "D1" }), tx("D", "annual", "refund", "2026-02-20", null, -120, { storeTransactionId: "D1" }),
    ...[0, 1, 2, 3, 4].map((i) => tx("E", "weekly", i ? "renewal" : "purchase", new Date(T("2026-06-01") + i * 7 * DAY).toISOString(), new Date(T("2026-06-01") + (i + 1) * 7 * DAY).toISOString(), 5, { country: "DE" })),
    ...monthly("F", "2026-01-10", 2), ...monthly("F", "2026-04-20", 1),
    tx("G", "monthly", "purchase", "2026-03-01", "2026-04-01", 10), tx("G", "annual", "purchase", "2026-03-15", "2027-03-15", 240),
    tx("H", "coins", "one_time", "2026-05-05", null, 30),
    ...monthly("P", "2026-05-02", 2, 8, "pro", { store: "play_store", appId: "android", country: "GB" }),
    tx("Q", "monthly", "trial", "2026-06-20", "2026-06-27", 0), tx("Q", "monthly", "renewal", "2026-06-27", "2026-07-27", 10),
  ];
  const first = new Map<string, number>();
  for (const t of txs) first.set(t.customerId, Math.min(first.get(t.customerId) ?? Infinity, t.at));
  first.set("X", T("2026-05-10")); // no purchase
  const ev = (customerId: string | null, type: string, at: string, o: Record<string, unknown> = {}) => ({ customerId, appId: "ios", type, at: T(at), ...o });
  return {
    now: NOW, txs,
    customers: [...first].map(([id, at]) => ({ id, firstSeen: at, country: id === "E" ? "DE" : id === "P" ? "GB" : "US", platform: id === "P" ? "Android" : "iOS", appVersion: "1.0" })),
    products: [
      { appId: "ios", storeIdentifier: "monthly", type: "subscription", duration: "P1M" }, { appId: "ios", storeIdentifier: "annual", type: "subscription", duration: "P1Y" },
      { appId: "ios", storeIdentifier: "weekly", type: "subscription", duration: "P1W" }, { appId: "ios", storeIdentifier: "coins", type: "consumable", duration: null },
      { appId: "android", storeIdentifier: "pro:monthly", type: "subscription", duration: "P1M" },
    ],
    subStates: [
      { customerId: "P", store: "play_store", appId: "android", productId: "pro", expiresAt: T("2026-07-02"), autoRenew: false, billingIssue: false, graceUntil: null, familyShared: false, offering: null, cancelSurveyReason: "CANCEL_SURVEY_REASON_COST_RELATED", unsubscribeAt: T("2026-06-10") },
      { customerId: "A", store: "app_store", appId: "ios", productId: "monthly", expiresAt: T("2026-07-01"), autoRenew: true, billingIssue: false, graceUntil: null, familyShared: false, offering: null, cancelSurveyReason: null, unsubscribeAt: null },
    ],
    lifecycle: [
      { customerId: "P", store: "play_store", productId: "pro", type: "CANCELLATION", at: T("2026-06-10") },
      { customerId: "C", store: "app_store", productId: "monthly", type: "CANCELLATION", at: T("2026-04-03") },
    ],
    sdkEvents: [
      ev("A", "rc_ads_ad_displayed", "2026-05-15T10:00:00Z"), ev("A", "rc_ads_ad_displayed", "2026-05-15T10:01:00Z"), ev("H", "rc_ads_ad_displayed", "2026-05-16T10:00:00Z"),
      ev("A", "rc_ads_ad_opened", "2026-05-15T10:02:00Z"), ev("A", "rc_ads_ad_loaded", "2026-05-15T10:00:00Z"), ev("H", "rc_ads_ad_failed_to_load", "2026-05-16T10:00:00Z"),
      ev("A", "rc_ads_ad_revenue", "2026-05-15T10:00:00Z", { revenueUsd: 0.02 }), ev("H", "rc_ads_ad_revenue", "2026-05-16T10:00:00Z", { revenueUsd: 0.05 }),
      ev("B", "paywall_impression", "2026-03-01T08:00:00Z", { paywallId: "pw" }), ev("X", "paywall_impression", "2026-05-10T09:00:00Z", { paywallId: "pw" }),
      ev("X", "paywall_purchase_initiated", "2026-05-10T09:01:00Z", { paywallId: "pw" }), ev("Q", "paywall_impression", "2026-06-20T09:00:00Z", { paywallId: "pw2" }),
      ev("C", "customer_center_survey_option_chosen", "2026-04-03T09:00:00Z", { surveyOptionId: "too_expensive" }), ev("A", "customer_center_survey_option_chosen", "2026-06-03T09:00:00Z", { surveyOptionId: "other" }),
    ],
    refundEvents: [{ transactionId: "D1", kind: "request", at: T("2026-02-18"), appId: "ios", store: "app_store", customerId: "D", usd: 120, purchasedAt: T("2026-02-15") }],
    activity: [{ customerId: "A", day: T("2026-05-15") }, { customerId: "A", day: T("2026-06-15") }, { customerId: "X", day: T("2026-05-10") }, { customerId: "H", day: T("2026-05-16") }],
    fx: () => 1,
  };
}
const req = (o: Partial<ChartRequest> = {}): ChartRequest => ({ resolution: "month", rangeStart: T("2026-01-01"), rangeEnd: T("2026-07-01"), expand: false, selectors: {}, ...o });

/** What the listed values must add up to, read from the chart's own output. */
function expected(def: ChartDef, out: ChartOutput, selectors: Record<string, string> = {}): number {
  const { measure, sum } = contributorsMeasure(def, selectors);
  if (out.kind === "cohort") return out.rows.reduce((s, r) => s + (r.cells[0]?.value ?? 0), 0);
  if (def.name === "subscription_status") { const last = out.points[out.points.length - 1]!; return last.values.reduce<number>((s, v) => s + (v ?? 0), 0); }
  if (def.name === "ad_monetized_customers" || def.name === "ad_arpdau") return expected(chartDef("ad_revenue")!, runChart(chartDef("ad_revenue")!, input(), req()).output);
  const j = out.measures.findIndex((m) => m.id === measure!.id);
  expect(j, `${def.name}: the chart has the measure ${measure!.id}`).toBeGreaterThanOrEqual(0);
  const vals = out.points.map((p) => p.values[j] ?? 0);
  return sum === "last" ? vals[vals.length - 1]! : vals.reduce((s, v) => s + v, 0);
}
const total = (rows: Contributor[]) => rows.reduce((s, r) => s + r.value, 0);

describe("chart contributors", () => {
  it("every chart lists its customers, and the values add up to the chart", () => {
    const inp = input();
    let nonEmpty = 0;
    for (const def of CHARTS) {
      expect(hasContributors(def.name), def.name).toBe(true);
      const r = def.shape === "cohort_table" ? req({ rangeStart: T("2026-01-01"), rangeEnd: T("2026-07-01") }) : req();
      const c = chartContributors(def, inp, r);
      if (def.name === "app_store_save_outcomes") { expect(c.rows).toEqual([]); expect(c.measure).toBeNull(); continue; }
      expect(c.measure, def.name).not.toBeNull();
      if (c.rows.length) nonEmpty++;
      const out = runChart(def, inp, r).output;
      expect(total(c.rows), def.name).toBeCloseTo(expected(def, out), 6);
      // Most recent first, each customer once.
      expect(c.rows.map((x) => x.at), def.name).toEqual([...c.rows.map((x) => x.at)].sort((a, b) => b - a));
      expect(new Set(c.rows.map((x) => x.customerId)).size, def.name).toBe(c.rows.length);
    }
    expect(nonEmpty).toBeGreaterThanOrEqual(CHARTS.length - 2);
  });

  it("revenue: purchases, renewals and one-time purchases minus refunds per customer; proceeds with the selector", () => {
    const c = chartContributors(chartDef("revenue")!, input(), req({ rangeStart: T("2026-02-01"), rangeEnd: T("2026-03-01") }));
    const by = Object.fromEntries(c.rows.map((r) => [r.customerId, r.value]));
    expect(by).toEqual({ A: 10, D: 0, F: 10 });
    expect(c.rows.find((r) => r.customerId === "D")).toMatchObject({ store: "app_store", productId: "annual", at: T("2026-02-20") });
    const p = chartContributors(chartDef("revenue")!, input(), req({ rangeStart: T("2026-02-01"), rangeEnd: T("2026-03-01"), selectors: { revenue_type: "proceeds" } }));
    expect(p.measure!.display_name).toBe("Proceeds");
    expect(p.rows.find((r) => r.customerId === "A")!.value).toBeCloseTo(7, 6);
    expect(c.dateLabel).toBe("Latest purchase");
  });

  it("MRR: everyone active at a period end in the range, valued at the last one", () => {
    const c = chartContributors(chartDef("mrr")!, input(), req({ rangeStart: T("2026-04-01"), rangeEnd: T("2026-07-01") }));
    const by = Object.fromEntries(c.rows.map((r) => [r.customerId, r.value]));
    // B lapsed May 8 and F on May 20: in the range, 0 at the end of June. G's annual is $20 a month.
    expect(by).toMatchObject({ A: 10, B: 0, E: 20, F: 0, G: 20, P: 8, Q: 10 });
    expect(c.sum).toBe("last");
    expect(c.rows.find((r) => r.customerId === "G")).toMatchObject({ productId: "annual", at: T("2026-03-15") });
  });

  it("new customers and initial conversion by cohort date", () => {
    const nc = chartContributors(chartDef("customers_new")!, input(), req({ rangeStart: T("2026-05-01"), rangeEnd: T("2026-07-01") }));
    expect(nc.rows.map((r) => r.customerId).sort()).toEqual(["E", "H", "P", "Q", "X"]);
    expect(nc.dateLabel).toBe("First seen");
    const ic = chartContributors(chartDef("initial_conversion")!, input(), req({ rangeStart: T("2026-05-01"), rangeEnd: T("2026-07-01"), selectors: { conversion_timeframe: "0_days" } }));
    expect(Object.fromEntries(ic.rows.map((r) => [r.customerId, r.value]))).toEqual({ E: 1, H: 1, P: 1, Q: 1, X: 0 });
  });

  it("filters by product and segments like the chart: per-segment values add up to each segment", () => {
    const def = chartDef("revenue")!;
    const f = chartContributors(def, input(), req(), { filters: [{ name: "product", values: ["weekly"] }] });
    // As on the chart, a product filter keeps ad revenue (it has no product): A and H are listed with their ad revenue only.
    expect(Object.fromEntries(f.rows.map((r) => [r.customerId, Math.round(r.value * 100) / 100]))).toEqual({ E: 25, A: 0.02, H: 0.05 });
    const seg = chartContributors(def, input(), req(), { segment: "country", limit: 1 });
    const run = runChart(def, input(), req(), { segment: "country", limit: 1 });
    for (const s of run.segments!) {
      const mine = seg.rows.filter((r) => (s.isOther ? r.segmentOther : r.segment === s.id && !r.segmentOther));
      expect(total(mine), s.id).toBeCloseTo(expected(def, s.output), 6);
    }
    expect(seg.rows.some((r) => r.segmentOther && r.segment === "Other")).toBe(true);
  });

  it("subscription status follows its measure selector; cohort explorer lists the cohort", () => {
    const st = chartContributors(chartDef("subscription_status")!, input(), req({ selectors: { status_measure: "mrr" } }));
    expect(st.measure).toMatchObject({ id: "mrr", unit: "$" });
    const ex = chartContributors(chartDef("cohort_explorer")!, input(), req({ selectors: { cohorting_date: "new_paying_customers" } }));
    expect(ex.measure!.display_name).toBe("New Paying Customers");
    expect(ex.rows.map((r) => r.customerId)).not.toContain("X");
    expect(ex.dateLabel).toBe("First payment");
  });
});
