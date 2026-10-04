import { describe, expect, it } from "vitest";
import {
  chartContributors, chartDef, customAttributeDim, dimValues, offerTypeOf, runChart, supportsDim,
  type ChartInput, type ChartRequest, type ChartTx,
} from "../src/index.js";

// Renewal cycle, offer type and custom attribute dimensions (prd/charts/PRD.md "Renewal cycle and offer type").
const DAY = 86_400_000;
const T = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
const NOW = T("2026-06-30T12:00:00Z");
let n = 0;
const tx = (customerId: string, productId: string, kind: ChartTx["kind"], at: string, expires: string | null, usd: number, o: Partial<ChartTx> = {}): ChartTx => ({
  id: `t${n++}`, customerId, appId: "ios", store: "app_store", storeTransactionId: o.storeTransactionId ?? `${customerId}-${at}`, productId, kind,
  at: T(at), expiresAt: expires ? T(expires) : null, usd, country: "US", ...o,
});
const months = (c: string, from: string, count: number, usd = 10, first: Partial<ChartTx> = {}) => {
  const out: ChartTx[] = [];
  let d = new Date(T(from));
  for (let i = 0; i < count; i++) {
    const e = new Date(d); e.setUTCMonth(e.getUTCMonth() + 1);
    out.push(tx(c, "monthly", i === 0 ? "purchase" : "renewal", d.toISOString(), e.toISOString(), usd, i === 0 ? first : {}));
    d = e;
  }
  return out;
};

/**
 * A: monthly $10 from Jan 1, six paid periods (cycles 1, 2, 3, 4, 5+, 5+), active now.
 * B: free trial Mar 1–8, converts Mar 8 (cycle 1), renews Apr 8 (cycle 2), lapses May 8. Cycle 2 refunded Apr 20.
 * I: introductory $1 month Feb 1 (cycle 1), $10 Mar 1 (cycle 2), lapses Apr 1.
 * P: promotional offer $5 month Apr 1, active until May 1.
 * H: one-time purchase $30 May 5 (no renewal cycle).
 */
function ledger(): ChartTx[] {
  return [
    ...months("A", "2026-01-01", 6),
    tx("B", "monthly", "trial", "2026-03-01", "2026-03-08", 0), tx("B", "monthly", "renewal", "2026-03-08", "2026-04-08", 10),
    tx("B", "monthly", "renewal", "2026-04-08", "2026-05-08", 10, { storeTransactionId: "B2" }), tx("B", "monthly", "refund", "2026-04-20", null, -10, { storeTransactionId: "B2" }),
    ...months("I", "2026-02-01", 2, 10, { offerType: "introductory", usd: 1 }),
    tx("P", "monthly", "purchase", "2026-04-01", "2026-05-01", 5, { offerType: "promotional" }),
    tx("H", "coins", "one_time", "2026-05-05", null, 30),
  ];
}
const ATTRS: Record<string, Record<string, string | null>> = { A: { source: "web" }, B: { source: "ios" }, I: { source: "web" }, P: {}, H: { source: "ios" } };
function input(txs = ledger()): ChartInput {
  const first = new Map<string, number>();
  for (const t of txs) first.set(t.customerId, Math.min(first.get(t.customerId) ?? Infinity, t.at));
  return {
    now: NOW, txs,
    customers: [...first].map(([id, at]) => ({ id, firstSeen: at, country: "US", platform: "iOS", appVersion: "1.0", attributes: ATTRS[id] })),
    products: [{ appId: "ios", storeIdentifier: "monthly", type: "subscription", duration: "P1M" }, { appId: "ios", storeIdentifier: "coins", type: "consumable", duration: null }],
    subStates: [], lifecycle: [], sdkEvents: [], refundEvents: [], activity: [], fx: () => 1,
  };
}
const req = (o: Partial<ChartRequest> = {}): ChartRequest => ({ resolution: "month", rangeStart: T("2026-01-01"), rangeEnd: T("2026-07-01"), expand: false, selectors: {}, ...o });
const values = (name: string, filters: { name: string; values: string[]; exclude?: boolean }[] = [], i = 0, inp = input()) => {
  const o = runChart(chartDef(name)!, inp, req(), { filters: filters as never }).output;
  if (o.kind !== "series") throw new Error("not a series");
  return Object.fromEntries(o.points.map((p) => [new Date(p.start).toISOString().slice(0, 7), p.values[i]]));
};
const cycle = (...v: string[]) => [{ name: "subscription_renewal_cycle_group", values: v }];
const offer = (...v: string[]) => [{ name: "offer_type", values: v }];

describe("renewal cycle and offer type", () => {
  it("offers the dimensions per chart like RevenueCat", () => {
    const has = (chart: string, d: string) => supportsDim(chartDef(chart)!, d);
    expect(has("revenue", "subscription_renewal_cycle_group") && has("revenue", "offer_type")).toBe(true);
    expect(has("arr", "subscription_renewal_cycle_group")).toBe(true);
    expect(has("arr", "offer_type")).toBe(false);
    expect(has("mrr", "offer_type") && has("actives", "offer_type") && has("trials_new", "offer_type")).toBe(true);
    expect(has("customers_new", "subscription_renewal_cycle_group")).toBe(false);
    expect(has("revenue", customAttributeDim("source")) && has("customers_new", customAttributeDim("source"))).toBe(true);
    expect(has("revenue", "custom_attribute:")).toBe(false);
  });

  it("maps ledger offer types", () => {
    expect(offerTypeOf("trial", null)).toBe("free_trial");
    expect(offerTypeOf("purchase", "unspecified")).toBe("promotional");
    expect(offerTypeOf("renewal", "win_back")).toBe("win_back");
    expect(offerTypeOf("renewal", null)).toBe("no_offer");
  });

  it("splits revenue by the cycle of each paid period, refunds by the refunded period", () => {
    expect(values("revenue", cycle("cycle_1"))).toEqual({ "2026-01": 10, "2026-02": 1, "2026-03": 10, "2026-04": 5, "2026-05": 0, "2026-06": 0 });
    // B's cycle 2 ($10 Apr 8) was refunded Apr 20: the refund lands in cycle 2 too.
    expect(values("revenue", cycle("cycle_2"))).toEqual({ "2026-01": 0, "2026-02": 10, "2026-03": 10, "2026-04": 0, "2026-05": 0, "2026-06": 0 });
    expect(values("revenue", cycle("cycle_5_plus"))).toEqual({ "2026-01": 0, "2026-02": 0, "2026-03": 0, "2026-04": 0, "2026-05": 10, "2026-06": 10 });
    expect(values("revenue", cycle(""))).toMatchObject({ "2026-05": 30 });
    expect(values("revenue", offer("introductory"))).toMatchObject({ "2026-02": 1, "2026-03": 0 });
  });

  it("segments add up to the total", () => {
    for (const dim of ["subscription_renewal_cycle_group", "offer_type"]) {
      const r = runChart(chartDef("revenue")!, input(), req(), { segment: dim as never });
      const total = r.output.kind === "series" ? r.output.points.map((p) => p.values[0]) : [];
      const sum = total.map((_, k) => r.segments!.reduce((s, x) => s + (x.output.kind === "series" ? x.output.points[k]!.values[0] ?? 0 : 0), 0));
      expect(sum.map((v) => Math.round(v * 100) / 100)).toEqual(total);
      expect(r.segments!.some((s) => s.isOther)).toBe(false);
    }
    expect(dimValues(input(), "subscription_renewal_cycle_group").sort()).toEqual(["", "cycle_1", "cycle_2", "cycle_3", "cycle_4", "cycle_5_plus", "trial"]);
    expect(dimValues(input(), "offer_type").sort()).toEqual(["free_trial", "introductory", "no_offer", "promotional"]);
  });

  it("counts snapshots by the period that gives access", () => {
    // End of March: A in cycle 3, B in cycle 1 (converted Mar 8), I in cycle 2.
    expect(values("mrr", cycle("cycle_1"))["2026-03"]).toBe(10);
    expect(values("actives", cycle("cycle_2", "cycle_3"))["2026-03"]).toBe(2);
    expect(values("actives", offer("introductory"))).toMatchObject({ "2026-02": 1, "2026-03": 0 });
    expect(values("mrr", offer("promotional"))).toMatchObject({ "2026-04": 5, "2026-05": 0 });
    expect(values("arr", cycle("cycle_4"))["2026-04"]).toBe(120);
    expect(values("trials_new", offer("free_trial"))["2026-03"]).toBe(1);
    expect(values("trials_new", offer("no_offer"))["2026-03"]).toBe(0);
    expect(values("trials", cycle("trial"))["2026-03"]).toBe(0);
  });

  it("tags movements with the period they start or end", () => {
    // New MRR in February: A renews (not new) and I starts on an introductory price.
    expect(values("mrr_movement", offer("introductory"))["2026-02"]).toBe(1);
    // I lapses Apr 1 at the end of cycle 2 (no offer); B lapses May 8 at the end of its refunded cycle 2 (cut Apr 20).
    expect(values("actives_movement", cycle("cycle_2"), 2)).toMatchObject({ "2026-04": -2 });
    expect(values("churn", cycle("cycle_2"), 2)["2026-04"]).toBe(2);
  });

  it("lists the same customers on the Customers tab", () => {
    const c = chartContributors(chartDef("mrr")!, input(), req(), { filters: cycle("cycle_1") as never });
    expect(c.rows.map((r) => r.customerId).sort()).toEqual(["A", "B", "I", "P"]);
    expect(c.rows.reduce((s, r) => s + r.value, 0)).toBe(0); // nobody is in cycle 1 at the end of June
  });
});

describe("custom attributes", () => {
  it("filters and segments by a custom attribute", () => {
    const dim = customAttributeDim("source");
    expect(values("revenue", [{ name: dim, values: ["web"] }])).toMatchObject({ "2026-02": 11, "2026-05": 10 });
    expect(values("revenue", [{ name: dim, values: [""] }])).toMatchObject({ "2026-04": 5, "2026-05": 0 });
    const r = runChart(chartDef("customers_new")!, input(), req(), { segment: dim as never });
    expect(r.segments!.map((s) => s.id).sort()).toEqual(["", "ios", "web"]);
    expect(dimValues(input(), dim)).toEqual(["ios", "web", ""]);
  });
});
