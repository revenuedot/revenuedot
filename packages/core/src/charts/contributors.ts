import type { ChartDef, Dim, MeasureDef } from "./catalog.js";
import { chartHelpers as H, Frame, Prepared, selectorDays, type ChartRequest } from "./compute.js";
import type { ChartInput, Sub } from "./model.js";
import { restrict, runChart, type ChartFilter } from "./run.js";
import { DAY, dayStart } from "./time.js";

/**
 * The customers behind a chart (the Customers tab under every chart, prd/charts/PRD.md "Customers tab"). Each chart lists
 * the customers its numbers come from, read from the same prepared rows and helpers as the chart (compute.ts), with each
 * customer's share of one of the chart's measures. Those values add up to the chart: over the range for flows and
 * cohorts (`sum: "total"`), at the last period for snapshots (`sum: "last"`).
 */
export interface Contributor {
  customerId: string;
  /** The customer's latest contribution in the range (ms): a purchase, a paid start, the cohort date … */
  at: number;
  /** Their part of `measure` (see `sum`). 0 for customers who contributed to an earlier snapshot only. */
  value: number;
  store: string | null;
  productId: string | null;
  /** The segment's value when the chart is segmented ("Other" rows have `segmentOther`). */
  segment?: string;
  segmentOther?: boolean;
}
export interface ContributorsResult {
  measure: MeasureDef | null;
  sum: "total" | "last";
  /** What `at` is, in the chart's words: "Purchased", "First seen", "Trial started" … */
  dateLabel: string;
  rows: Contributor[];
  /** The part of the chart that belongs to no customer: ad events from app user ids the server never saw (`sum: "total"`). */
  unattributed: number;
}

type Win = [number, number];
interface Acc { add(customerId: string | null, at: number, value: number, store?: string | null, productId?: string | null): void; rows(): Contributor[]; unattributed(): number }

function acc(): Acc {
  const m = new Map<string, Contributor>();
  let none = 0;
  return {
    add(customerId, at, value, store = null, productId = null) {
      if (!customerId) { none += value; return; }
      const c = m.get(customerId);
      if (!c) { m.set(customerId, { customerId, at, value, store, productId }); return; }
      c.value += value;
      // The latest contribution names the store and product; rows without one (ad events, cohorts) keep the earlier one.
      if (at >= c.at) { c.at = at; if (store || productId) { c.store = store; c.productId = productId; } }
      else if (!c.store && !c.productId) { c.store = store; c.productId = productId; }
    },
    rows: () => [...m.values()],
    unattributed: () => none,
  };
}

const synthetic = (id: string, display_name: string, unit: "$" | "#", description: string): MeasureDef =>
  ({ id, display_name, description, unit, decimal_precision: unit === "$" ? 2 : 0, chartable: false, tabulable: true, flow: true });

interface Spec { measure: (def: ChartDef, sel: Record<string, string>) => MeasureDef | null; sum: "total" | "last"; dateLabel: string | ((sel: Record<string, string>) => string); run: (d: Prepared, f: Frame, sel: Record<string, string>, a: Acc) => void }

const byId = (id: string) => (def: ChartDef) => def.measures.find((x) => x.id === id) ?? null;
const windows = (f: Frame): Win[] => f.buckets.map((b) => f.window(b));

/** Stock charts: every subscription that gives access (paid, or a trial) at the end of a period; values at the last one. */
function snapshot(d: Prepared, f: Frame, a: Acc, kind: "paid" | "trial", value: (p: { monthly: number }) => number) {
  const trial = kind === "trial";
  const pick = (s: Sub, at: number) => (trial ? d.trialAt(s, at) : d.paidAt(s, at));
  const ats = f.buckets.map((b) => f.snapshot(b));
  const last = ats.length - 1;
  for (const s of d.subs) {
    let v = 0, hit = false;
    ats.forEach((at, i) => { const p = pick(s, at); if (p) { hit = true; if (i === last) v += value(p); } });
    if (hit) a.add(s.customerId, (trial ? s.trialStart : s.paidStart) ?? s.start, v, s.store, s.productId);
  }
}

const adTypes: Record<string, string[]> = {
  ad_revenue: ["rc_ads_ad_revenue"], ad_monetized_customers: ["rc_ads_ad_revenue"], ad_arpdau: ["rc_ads_ad_revenue"],
  ad_rpm: ["rc_ads_ad_revenue", "rc_ads_ad_displayed"], ad_impressions: ["rc_ads_ad_displayed"], ad_clicks: ["rc_ads_ad_opened"],
  ad_ctr: ["rc_ads_ad_displayed", "rc_ads_ad_opened"], ad_fill_rate: ["rc_ads_ad_loaded", "rc_ads_ad_failed_to_load"],
};
const adValue = (chart: string, type: string, revenue: number) =>
  chart === "ad_impressions" ? 1 : chart === "ad_clicks" || chart === "ad_ctr" ? (type === "rc_ads_ad_opened" ? 1 : 0) : chart === "ad_fill_rate" ? 1 : type === "rc_ads_ad_revenue" ? revenue : 0;
const AD_REVENUE = synthetic("ad_revenue", "Ad Revenue", "$", "Ad revenue the SDK reported for the customer.");
// Ad Monetized Customers averages, over each period's days, the customers with ad revenue that day: a customer's part
// is the days they had some, which add up to the sum of the daily counts (the chart's value × the period's days).
const MONETIZED_DAYS = synthetic("monetized_days", "Monetized Days", "#", "Days with at least one ad revenue event. The chart's value for a period is the sum of these over its days, divided by the number of days.");
const ads = (chart: string): Spec => ({
  // ARPDAU is a ratio with no measure that adds up: its tab lists ad revenue, the ratio's numerator.
  measure: (def) => ({ ad_revenue: byId("ad_revenue")(def), ad_rpm: byId("ad_revenue")(def), ad_impressions: byId("impressions")(def), ad_clicks: byId("clicks")(def), ad_ctr: byId("clicks")(def), ad_fill_rate: byId("requests")(def), ad_monetized_customers: MONETIZED_DAYS } as Record<string, MeasureDef | null>)[chart] ?? AD_REVENUE,
  sum: "total", dateLabel: "Latest ad event",
  run: (d, f, _sel, a) => {
    const types = new Set(adTypes[chart]);
    for (const w of windows(f)) {
      // compute.ts counts a customer once per UTC day with ad revenue; events without a customer are not counted.
      const days = new Set<string>();
      for (const e of H.within(d.sdkByTime, H.atOf, w)) {
        if (!types.has(e.type)) continue;
        if (chart === "ad_monetized_customers") {
          if (!e.customerId) continue;
          const k = `${e.customerId}|${dayStart(e.at)}`;
          a.add(e.customerId, e.at, days.has(k) ? 0 : 1);
          days.add(k);
        } else a.add(e.customerId, e.at, adValue(chart, e.type, (e.revenueUsd ?? 0) * d.input.fx(e.at)));
      }
    }
  },
});

/** New customers by cohort date, each once per period their cohort date falls in. */
function cohortCustomers(d: Prepared, f: Frame, each: (id: string, at: number) => void) {
  const sorted = [...d.cohortDate].sort((x, y) => x[1] - y[1]);
  for (const w of windows(f)) for (const [id, at] of H.within(sorted, ([, t]) => t, w)) each(id, at);
}
const cohort = (measureId: string, value: (d: Prepared, id: string, at: number, sel: Record<string, string>) => number): Spec => ({
  measure: byId(measureId), sum: "total", dateLabel: "First seen",
  run: (d, f, sel, a) => cohortCustomers(d, f, (id, at) => a.add(id, at, value(d, id, at, sel))),
});

/** Customers by their first trial start in each period (Trial Conversion Rate, Trial Cancellation Rate). */
function trialCohort(d: Prepared, f: Frame, each: (first: Sub, mine: Sub[]) => void) {
  const all = H.trialStarters(d).sort((x, y) => x.at - y.at);
  for (const w of windows(f)) {
    const subs = H.within(all, H.atOf, w).map((x) => x.item);
    const byCustomer = new Map<string, Sub[]>();
    for (const s of subs) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
    for (const s of H.oncePerCustomer(subs)) each(s, byCustomer.get(s.customerId)!);
  }
}

/** Customer–paywall pairs by first impression (the paywall charts). */
function paywallPairs(d: Prepared, f: Frame, each: (p: ReturnType<typeof H.pairs>[number]) => void) {
  const all = H.pairs(d).sort((x, y) => x.first - y.first);
  for (const w of windows(f)) for (const p of H.within(all, (x) => x.first, w)) each(p);
}

const moves = (measureId: string, dateLabel: string, value: (x: Prepared["moves"][number]) => number | null): Spec => ({
  measure: byId(measureId), sum: "total", dateLabel,
  run: (d, f, _sel, a) => {
    for (const w of windows(f)) for (const x of H.within(d.movesByTime, H.atOf, w)) {
      const v = value(x);
      if (v !== null) a.add(x.sub.customerId, x.at, v, x.sub.store, x.sub.productId);
    }
  },
});

const SPECS: Record<string, Spec> = {
  revenue: {
    measure: (def, sel) => { const m = def.measures[0]!; return sel.revenue_type && sel.revenue_type !== "revenue" ? { ...m, display_name: sel.revenue_type === "proceeds" ? "Proceeds" : "Revenue (net of taxes)" } : m; },
    sum: "total", dateLabel: "Latest purchase",
    run: (d, f, sel, a) => {
      for (const w of windows(f)) {
        for (const t of H.within(d.txsByTime, H.atOf, w)) {
          if (t.kind !== "trial") a.add(t.customerId, t.at, d.money(t) * H.revenueTypeFactor(t, sel.revenue_type), t.store, t.productId);
        }
        if (d.adRevenueOk) for (const e of H.within(d.sdkByTime, H.atOf, w)) if (e.type === "rc_ads_ad_revenue") a.add(e.customerId, e.at, (e.revenueUsd ?? 0) * d.input.fx(e.at));
      }
    },
  },
  mrr: { measure: byId("mrr"), sum: "last", dateLabel: "Paid start", run: (d, f, _s, a) => snapshot(d, f, a, "paid", (p) => p.monthly) },
  arr: { measure: byId("arr"), sum: "last", dateLabel: "Paid start", run: (d, f, _s, a) => snapshot(d, f, a, "paid", (p) => p.monthly * 12) },
  actives: { measure: byId("actives"), sum: "last", dateLabel: "Paid start", run: (d, f, _s, a) => snapshot(d, f, a, "paid", () => 1) },
  trials: { measure: byId("trials"), sum: "last", dateLabel: "Trial started", run: (d, f, _s, a) => snapshot(d, f, a, "trial", () => 1) },
  subscription_status: {
    measure: (_def, sel) => {
      const what = sel.status_measure ?? "actives";
      return what === "mrr" ? synthetic("mrr", "MRR", "$", "Monthly value at the end of the last period.") : what === "arr" ? synthetic("arr", "ARR", "$", "MRR × 12 at the end of the last period.")
        : what === "trials" ? synthetic("trials", "Active Trials", "#", "Trials at the end of the last period.") : synthetic("actives", "Active Subscriptions", "#", "Paid subscriptions at the end of the last period.");
    },
    sum: "last", dateLabel: (sel) => (sel.status_measure === "trials" ? "Trial started" : "Paid start"),
    run: (d, f, sel, a) => {
      const what = sel.status_measure ?? "actives";
      snapshot(d, f, a, what === "trials" ? "trial" : "paid", (p) => (what === "mrr" ? p.monthly : what === "arr" ? p.monthly * 12 : 1));
    },
  },
  mrr_movement: moves("movement", "Latest change", (x) => (x.category === "paired_out" ? null : x.mrr)),
  actives_movement: moves("movement", "Latest change", (x) => (x.category === "new" || x.category === "resubscription" ? 1 : x.category === "churn" || x.category === "recovery" ? x.actives : null)),
  actives_new: moves("new_paid", "Paid start", (x) => (x.type === "trial_conversion" || x.type === "new" || x.type === "product_change" || x.type === "resubscription" ? 1 : null)),
  churn: moves("churned_actives", "Ended", (x) => (x.category === "churn" || x.category === "paired_out" || x.category === "recovery" ? -x.actives : null)),
  "non-subscription_purchases": {
    measure: byId("purchases"), sum: "total", dateLabel: "Purchased",
    run: (d, f, _s, a) => { for (const w of windows(f)) for (const t of H.within(d.txsByTime, H.atOf, w)) if (t.kind === "one_time") a.add(t.customerId, t.at, 1, t.store, t.productId); },
  },
  refund_rate: {
    measure: byId("transactions"), sum: "total", dateLabel: "Purchased",
    run: (d, f, _s, a) => { for (const w of windows(f)) for (const t of H.within(d.txsByTime, H.atOf, w)) if (H.PAID_KINDS.has(t.kind)) a.add(t.customerId, t.at, 1, t.store, t.productId); },
  },
  refunds: {
    measure: byId("refunded_revenue"), sum: "total", dateLabel: "Refunded",
    run: (d, f, _s, a) => { for (const w of windows(f)) for (const t of H.within(d.txsByTime, H.atOf, w)) if (t.kind === "refund" || t.kind === "refund_reversal") a.add(t.customerId, t.at, -d.money(t), t.store, t.productId); },
  },
  refund_request: {
    measure: byId("requests"), sum: "total", dateLabel: "Requested",
    run: (d, f, _s, a) => {
      for (const w of windows(f)) for (const r of d.input.refundEvents) if (r.kind === "request" && r.at >= w[0] && r.at < w[1]) a.add(r.customerId, r.at, 1, r.store, null);
    },
  },
  play_store_cancel_reasons: {
    measure: () => synthetic("cancellations", "Cancellations", "#", "Google Play subscriptions whose auto-renew was turned off in the period."), sum: "total", dateLabel: "Cancelled",
    run: (d, f, _s, a) => {
      for (const w of windows(f)) for (const e of d.input.lifecycle) if (e.type === "CANCELLATION" && e.store === "play_store" && e.at >= w[0] && e.at < w[1]) a.add(e.customerId, e.at, 1, e.store, e.productId);
    },
  },
  customer_center_survey_responses: {
    measure: () => synthetic("responses", "Responses", "#", "Survey answers in the period."), sum: "total", dateLabel: "Answered",
    run: (d, f, _s, a) => {
      for (const w of windows(f)) for (const e of H.within(d.sdkByTime, H.atOf, w)) if (e.type === "customer_center_survey_option_chosen") a.add(e.customerId, e.at, 1);
    },
  },
  app_store_save_outcomes: { measure: () => null, sum: "total", dateLabel: "Saved", run: () => {} },
  trials_new: {
    measure: byId("new_trials"), sum: "total", dateLabel: "Trial started",
    run: (d, f, _s, a) => { for (const w of windows(f)) for (const t of H.within(d.trialsByStart, (x) => x.start, w)) a.add(t.sub.customerId, t.start, 1, t.sub.store, t.sub.productId); },
  },
  trials_movement: {
    measure: byId("movement"), sum: "total", dateLabel: "Latest change",
    run: (d, f, _s, a) => {
      for (const w of windows(f)) {
        for (const t of H.within(d.trialsByStart, (x) => x.start, w)) a.add(t.sub.customerId, t.start, 1, t.sub.store, t.sub.productId);
        for (const t of H.within(d.trialsByEnd, (x) => x.end, w)) if (t.end <= d.now) a.add(t.sub.customerId, t.end, -1, t.sub.store, t.sub.productId);
      }
    },
  },
  customers_new: cohort("new_customers", () => 1),
  customers_active: {
    measure: byId("active_customers"), sum: "total", dateLabel: "Last active",
    run: (d, f, _s, a) => {
      for (const w of windows(f)) {
        const last = new Map<string, number>();
        for (const x of H.within(d.activityByTime, (y) => y.day, [w[0] - DAY + 1, w[1]])) last.set(x.customerId, Math.max(last.get(x.customerId) ?? 0, x.day));
        for (const [id, day] of last) a.add(id, day, 1);
      }
    },
  },
  initial_conversion: cohort("initial_conversions", (d, id, at, sel) => {
    const end = H.windowEnd(at, H.conversionDays(sel));
    return d.txsOf(id).some((t) => H.CONVERSION_KINDS.has(t.kind) && t.at < end) ? 1 : 0;
  }),
  conversion_to_paying: cohort("paying_customers", (d, id, at, sel) => (H.paidInWindow(d, id, H.windowEnd(at, H.conversionDays(sel))) ? 1 : 0)),
  trial_conversion: cohort("trials_started", (d, id) => (d.subsOf(id).some((s) => s.trialStart !== null) ? 1 : 0)),
  ltv_per_customer: cohort("revenue", (d, id, at, sel) => H.revenueIn(d, id, dayStart(at), H.windowEnd(at, H.lifetimeDays(sel)))),
  ltv_per_paying_customer: cohort("revenue", (d, id, at, sel) => H.revenueIn(d, id, dayStart(at), H.windowEnd(at, H.lifetimeDays(sel)))),
  paywall_encounter: cohort("customers", () => 1),
  trial_conversion_rate: {
    measure: byId("conversions"), sum: "total", dateLabel: "Trial started",
    run: (d, f, _s, a) => trialCohort(d, f, (s, mine) => a.add(s.customerId, s.trialStart!, mine.some((x) => x.paidStart !== null && x.trialEnd !== null && x.paidStart >= x.trialEnd - 1) ? 1 : 0, s.store, s.productId)),
  },
  trial_cancellation: {
    measure: byId("cancellations"), sum: "total", dateLabel: "Trial started",
    run: (d, f, sel, a) => {
      const limit = selectorDays(sel.cancellation_timeframe ?? "7_days") * DAY;
      trialCohort(d, f, (s) => {
        let v = 0;
        if (s.paidStart === null && (s.trialEnd ?? Infinity) <= d.now) { const opt = H.lastOptOut(d, s); if (opt !== null && opt - s.trialStart! <= limit) v = 1; }
        a.add(s.customerId, s.trialStart!, v, s.store, s.productId);
      });
    },
  },
  paywall_conversion: { measure: byId("initial_conversions"), sum: "total", dateLabel: "First paywall view", run: (d, f, _s, a) => paywallPairs(d, f, (p) => a.add(p.customerId, p.first, p.conversion ? 1 : 0)) },
  paywall_ltv: {
    measure: byId("revenue"), sum: "total", dateLabel: "First paywall view",
    run: (d, f, sel, a) => paywallPairs(d, f, (p) => a.add(p.customerId, p.first, p.conversion ? H.revenueIn(d, p.customerId, dayStart(p.first), H.windowEnd(p.first, H.lifetimeDays(sel))) : 0)),
  },
  paywall_abandonment: { measure: byId("viewers"), sum: "total", dateLabel: "First paywall view", run: (d, f, _s, a) => paywallPairs(d, f, (p) => a.add(p.customerId, p.first, 1)) },
  subscription_retention: {
    measure: () => synthetic("subscriptions", "Subscriptions", "#", "New paid subscriptions in the cohort."), sum: "total", dateLabel: "Paid start",
    run: (d, f, _s, a) => {
      const subs = d.subs.filter((s) => s.paidStart !== null).sort((x, y) => x.paidStart! - y.paidStart!);
      for (const w of windows(f)) for (const s of H.within(subs, (x) => x.paidStart!, w)) a.add(s.customerId, s.paidStart!, 1, s.store, s.productId);
    },
  },
  ...Object.fromEntries(["cohort_explorer", "prediction_explorer"].map((name) => [name, {
    measure: (_def: ChartDef, sel: Record<string, string>) => {
      const how = sel.cohorting_date ?? "new_customers";
      const label = ({ new_customers: "New Customers", initial_conversions: "Initial Conversions", new_paying_customers: "New Paying Customers" } as Record<string, string>)[how] ?? "Customers";
      return synthetic("customers", label, "#", "Customers in the cohort.");
    },
    sum: "total" as const,
    dateLabel: (sel: Record<string, string>) => ({ initial_conversions: "Initial conversion", new_paying_customers: "First payment" } as Record<string, string>)[sel.cohorting_date ?? ""] ?? "First seen",
    run: (d: Prepared, f: Frame, sel: Record<string, string>, a: Acc) => {
      const members = [...H.cohortMembers(d, sel.cohorting_date ?? "new_customers")].sort((x, y) => x[1] - y[1]);
      for (const w of windows(f)) for (const [id, at] of H.within(members, ([, t]) => t, w)) a.add(id, at, 1);
    },
  } satisfies Spec])),
  ...Object.fromEntries(Object.keys(adTypes).map((name) => [name, ads(name)])),
};

/** Whether a chart lists its customers (every chart in the catalog does; App Store Save Outcomes lists none). */
export const hasContributors = (name: string) => name in SPECS;

/** The measure a chart's Customers tab shows, and what its values add up to. */
export function contributorsMeasure(def: ChartDef, selectors: Record<string, string> = {}) {
  const spec = SPECS[def.name];
  if (!spec) throw new Error(`No contributors for chart ${def.name}`);
  const sel = { ...Object.fromEntries(def.selectors.map((s) => [s.id, s.default])), ...selectors };
  return { measure: spec.measure(def, sel), sum: spec.sum, dateLabel: typeof spec.dateLabel === "function" ? spec.dateLabel(sel) : spec.dateLabel };
}

/**
 * The customers who contribute to a chart for one request: the chart's filters, then (when segmented) the same segments
 * as runChart, top `limit` by the chart's first measure and the rest as "Other", each customer once per segment.
 * Rows come most recent contribution first.
 */
export function chartContributors(def: ChartDef, input: ChartInput, req: ChartRequest, opts: { filters?: ChartFilter[]; segment?: Dim | null; limit?: number | null } = {}): ContributorsResult {
  const spec = SPECS[def.name];
  if (!spec) throw new Error(`No contributors for chart ${def.name}`);
  const { measure, sum, dateLabel } = contributorsMeasure(def, req.selectors);
  const sel = { ...Object.fromEntries(def.selectors.map((s) => [s.id, s.default])), ...req.selectors };
  const frame = new Frame(req, input.now);
  const compute = (inp: ChartInput) => { const a = acc(); spec.run(new Prepared(inp), frame, sel, a); return { rows: a.rows(), unattributed: a.unattributed() }; };
  const filtered = restrict(input, opts.filters ?? []);
  let rows: Contributor[];
  let unattributed: number;
  if (!opts.segment) ({ rows, unattributed } = compute(filtered));
  else {
    const dim = opts.segment;
    const segs = runChart(def, input, req, opts).segments ?? [];
    const top = segs.filter((s) => !s.isOther).map((s) => s.id);
    rows = segs.flatMap((s) => compute(restrict(filtered, [s.isOther ? { name: dim, values: top, exclude: true } : { name: dim, values: [s.id] }])).rows
      .map((r) => ({ ...r, segment: s.id, ...(s.isOther ? { segmentOther: true } : {}) })));
    // What belongs to no customer in the chart's Total (ad revenue from app users who never became customers).
    unattributed = compute(filtered).unattributed;
  }
  rows.sort((x, y) => y.at - x.at || (x.customerId < y.customerId ? -1 : x.customerId > y.customerId ? 1 : 0));
  return { measure, sum, dateLabel, rows, unattributed };
}
