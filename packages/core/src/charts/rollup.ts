import { chartDef, type ChartDef, type MeasureDef } from "./catalog.js";
import { computeChart, Frame, Prepared, type ChartOutput, type ChartRequest, type SeriesPoint } from "./compute.js";
import type { ChartInput } from "./model.js";
import { DAY, dayStart } from "./time.js";
import { CHART_CODE_FINGERPRINT } from "./fingerprint.generated.js";

/**
 * Daily chart rollups (prd/charts/PRD.md "Daily rollups"): each day's values of the charts whose numbers add up over
 * days or are read at a day's end, computed by the same chart code at day resolution and kept per project and
 * environment, in USD. A request with no filter, no segment and USD is answered from them: flows are summed over the
 * days of each period, snapshots read on the period's last day, and rates rebuilt from their parts. Anything else
 * (filters, segments, other currencies, cohort charts) is computed live.
 *
 * ROLLUP_VERSION is a hash of the source files that compute the numbers (scripts/chart-fingerprint.mjs): stored rollups
 * made by other code are rebuilt.
 */

type Agg =
  | { kind: "sum" }
  | { kind: "stock" }
  | { kind: "custom"; combine: (days: Row[], w: [number, number], get: (chart: string, d: Row) => (number | null)[]) => (number | null)[] };
interface RollupChart { name: string; selector?: string; agg: Agg }
/** One day's stored values: `chart` or `chart:selectorValue` → the measures' values. */
export type RollupDay = Record<string, (number | null)[]>;
interface Row { day: number; data: RollupDay }

const rate = (a: number, b: number) => (b > 0 ? (a / b) * 100 : null);
const sumAt = (rows: Row[], key: string, i: number, get: (chart: string, d: Row) => (number | null)[]) => rows.reduce((s, r) => s + (get(key, r)[i] ?? 0), 0);

/** The charts kept in rollups and how their days combine into a period. */
const CHARTS: RollupChart[] = [
  { name: "revenue", selector: "revenue_type", agg: { kind: "sum" } },
  { name: "mrr", agg: { kind: "stock" } },
  { name: "arr", agg: { kind: "stock" } },
  { name: "mrr_movement", agg: { kind: "sum" } },
  { name: "non-subscription_purchases", agg: { kind: "sum" } },
  { name: "ad_revenue", agg: { kind: "sum" } },
  { name: "ad_impressions", agg: { kind: "sum" } },
  { name: "ad_clicks", agg: { kind: "sum" } },
  { name: "actives", agg: { kind: "stock" } },
  { name: "actives_movement", agg: { kind: "sum" } },
  { name: "actives_new", agg: { kind: "sum" } },
  { name: "subscription_status", selector: "status_measure", agg: { kind: "stock" } },
  { name: "trials", agg: { kind: "stock" } },
  { name: "trials_movement", agg: { kind: "sum" } },
  { name: "trials_new", agg: { kind: "sum" } },
  { name: "customers_new", agg: { kind: "sum" } },
  { name: "refunds", agg: { kind: "sum" } },
  // Rates: their parts add up; the rate is computed again from the sums.
  { name: "refund_rate", agg: { kind: "custom", combine: (rows, _w, g) => { const paid = sumAt(rows, "refund_rate", 1, g), refunded = sumAt(rows, "refund_rate", 2, g); return [rate(refunded, paid), paid, refunded]; } } },
  { name: "churn", agg: { kind: "custom", combine: (rows, w, g) => {
    // Actives at the start of the period are the first day's; churned subscriptions add up.
    const first = rows.find((r) => r.day === dayStart(w[0]));
    const atStart = first ? g("churn", first)[1] ?? 0 : 0;
    const churned = sumAt(rows, "churn", 2, g);
    return [rate(churned, atStart), atStart, churned];
  } } },
  { name: "ad_rpm", agg: { kind: "custom", combine: (rows, _w, g) => { const rev = sumAt(rows, "ad_rpm", 1, g), imp = sumAt(rows, "ad_rpm", 2, g); return [imp ? (rev / imp) * 1000 : null, rev, imp]; } } },
  { name: "ad_fill_rate", agg: { kind: "custom", combine: (rows, _w, g) => { const total = sumAt(rows, "ad_fill_rate", 1, g), loaded = sumAt(rows, "ad_fill_rate", 2, g); return [rate(loaded, total), total, loaded]; } } },
  { name: "ad_ctr", agg: { kind: "custom", combine: (rows, _w, g) => { const clicks = sumAt(rows, "ad_ctr", 1, g), imp = sumAt(rows, "ad_ctr", 2, g); return [rate(clicks, imp), clicks, imp]; } } },
  // A day's value is that day's customers with ad revenue; a period's is their sum over its days ÷ the number of days.
  { name: "ad_monetized_customers", agg: { kind: "custom", combine: (rows, w, g) => (w[1] > w[0] ? [sumAt(rows, "ad_monetized_customers", 0, g) / Math.max(1, Math.ceil((w[1] - w[0]) / DAY))] : [null]) } },
  // Ad revenue ÷ daily ad users, both summed over the period's days.
  { name: "ad_arpdau", agg: { kind: "custom", combine: (rows, _w, g) => { const rev = sumAt(rows, "ad_revenue", 0, g), dau = sumAt(rows, "ad_monetized_customers", 0, g); return [dau > 0 ? rev / dau : null]; } } },
];
const BY_NAME = new Map(CHARTS.map((c) => [c.name, c]));
export const ROLLUP_VERSION = CHART_CODE_FINGERPRINT;
export const ROLLUP_CHARTS = CHARTS.map((c) => c.name);
export const isRollupChart = (name: string) => BY_NAME.has(name);

const keyOf = (c: RollupChart, sel: Record<string, string>) => (c.selector ? `${c.name}:${sel[c.selector]}` : c.name);
const defaults = (def: ChartDef) => Object.fromEntries(def.selectors.map((s) => [s.id, s.default]));

/**
 * The first day with purchases, lifecycle or SDK events (`activity`), and the first day any customer was seen
 * (`customers`), as UTC day starts. Before the first activity day only New Customers can have a value.
 */
export function firstDays(input: ChartInput): { activity: number | null; customers: number | null } {
  let a = Infinity, c = Infinity;
  for (const x of input.txs) a = Math.min(a, x.at);
  for (const e of input.sdkEvents) a = Math.min(a, e.at);
  for (const e of input.lifecycle) a = Math.min(a, e.at);
  for (const x of input.customers) c = Math.min(c, x.firstSeen);
  return { activity: Number.isFinite(a) ? dayStart(a) : null, customers: Number.isFinite(c) ? dayStart(c) : null };
}
/** The first day with any data. */
export function firstDataDay(input: ChartInput): number | null {
  const f = firstDays(input);
  const t = Math.min(f.activity ?? Infinity, f.customers ?? Infinity);
  return Number.isFinite(t) ? t : null;
}
/** A day whose every value is 0 or empty: not stored, since a missing day reads as one (chartFromRollup). */
export const isEmptyDay = (d: RollupDay) => Object.values(d).every((v) => v.every((x) => x === null || x === 0));

/**
 * Computes the rollup of every day in [from, to) (UTC day starts) from the project's rows, with every selector value
 * of the charts that have one. The current day holds its values up to `input.now`.
 */
export function computeRollupDays(input: ChartInput, from: number, to: number, prepared: Prepared = new Prepared(input)): Map<number, RollupDay> {
  const out = new Map<number, RollupDay>();
  if (to <= from) return out;
  for (let d = from; d < to; d += DAY) out.set(d, {});
  for (const [d, n] of newCustomerDays(prepared, from, to)) out.get(d)!.customers_new = [n];
  for (const v of out.values()) v.customers_new ??= [0];
  // Every other chart from the first day with purchases, lifecycle or SDK events: before it they are all zero.
  const first = Math.max(from, firstDays(input).activity ?? to);
  if (first >= to) return out;
  const req: ChartRequest = { resolution: "day", rangeStart: first, rangeEnd: to, expand: false, selectors: {} };
  const frame = new Frame(req, input.now, Math.ceil((to - first) / DAY) + 1);
  for (const c of CHARTS) {
    if (c.name === "customers_new") continue;
    const def = chartDef(c.name)!;
    const values = c.selector ? def.selectors.find((s) => s.id === c.selector)!.options.map((o) => o.id) : [null];
    for (const v of values) {
      const sel = { ...defaults(def), ...(c.selector && v !== null ? { [c.selector]: v } : {}) };
      const o = computeChart(def, prepared, frame, sel);
      if (o.kind !== "series") continue;
      for (const p of o.points) { const d = out.get(p.start); if (d) d[keyOf(c, sel)] = p.values; }
    }
  }
  return out;
}

/**
 * Adds one group of customers' days (computeRollupDays of their rows) into `acc`. Every stored value is a sum over
 * customers (amounts, counts, a rate's parts), so the days of disjoint groups add up to the days of all of them; a rate
 * itself is recomputed from its summed parts by finishRollupDays.
 */
export function addRollupDays(acc: Map<number, RollupDay>, part: Map<number, RollupDay>): void {
  for (const [day, data] of part) {
    if (isEmptyDay(data)) continue;
    const into = acc.get(day);
    if (!into) { acc.set(day, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, [...v]]))); continue; }
    for (const [k, v] of Object.entries(data)) {
      const a = into[k];
      if (!a) { into[k] = [...v]; continue; }
      for (let i = 0; i < Math.max(a.length, v.length); i++) {
        const x = a[i] ?? null, y = v[i] ?? null;
        a[i] = x === null && y === null ? null : (x ?? 0) + (y ?? 0);
      }
    }
  }
}

/** The rate charts' values of each day again from their summed parts (after addRollupDays), as one computation gives them. */
export function finishRollupDays(acc: Map<number, RollupDay>): Map<number, RollupDay> {
  const get = (chart: string, r: Row) => r.data[chart] ?? [0, 0, 0];
  for (const [day, data] of acc) {
    const row = { day, data };
    for (const c of CHARTS) if (c.agg.kind === "custom" && data[c.name]) data[c.name] = c.agg.combine([row], [day, day + DAY], get);
  }
  return acc;
}

/** New Customers per day in [from, to), from each customer's cohort date as the chart counts them (days with none left out). */
export function newCustomerDays(prepared: Prepared, from: number, to: number): Map<number, number> {
  const nc = new Map<number, number>();
  for (const t of prepared.cohortDate.values()) if (t >= from && t < to && t <= prepared.now) nc.set(dayStart(t), (nc.get(dayStart(t)) ?? 0) + 1);
  return nc;
}

/** The stored keys a chart reads for these selectors (ARPDAU reads Ad Revenue and Ad Monetized Customers). */
export function rollupKeys(def: ChartDef, selectors: Record<string, string>): string[] {
  const c = BY_NAME.get(def.name);
  if (!c) return [];
  const sel = { ...defaults(def), ...selectors };
  return def.name === "ad_arpdau" ? ["ad_revenue", "ad_monetized_customers"] : [keyOf(c, sel)];
}

/** An empty input: the measures a chart reports for its selectors, without rows. */
const empty = (now: number): ChartInput => ({ now, txs: [], customers: [], products: [], subStates: [], lifecycle: [], sdkEvents: [], refundEvents: [], activity: [], fx: () => 1 });

/**
 * A chart's output from stored days, or null when the rollups cannot answer it (not a rollup chart). `days` must hold
 * every day the request's periods touch that has data; a missing day counts as a day without data.
 */
export function chartFromRollup(def: ChartDef, req: ChartRequest, now: number, days: Map<number, RollupDay>): ChartOutput | null {
  const c = BY_NAME.get(def.name);
  if (!c) return null;
  const sel = { ...defaults(def), ...req.selectors };
  const frame = new Frame(req, now);
  // Periods that start after now have no days yet (Churn reads the actives at a future start): computed live.
  if (frame.buckets.some((b) => b.start > now)) return null;
  // The measures (and names) exactly as the live computation reports them for these selectors.
  const shape = computeChart(def, new Prepared(empty(now)), new Frame({ ...req, rangeStart: req.rangeStart, rangeEnd: req.rangeStart + DAY }, now), sel);
  if (shape.kind !== "series") return null;
  const measures: MeasureDef[] = shape.measures;
  const zero = (n: number) => Array.from({ length: n }, () => 0);
  const get = (chart: string, r: Row): (number | null)[] => {
    const cc = BY_NAME.get(chart)!;
    const v = r.data[keyOf(cc, sel)];
    return v ?? zero(chart === def.name ? measures.length : 3);
  };
  const daysIn = ([a, b]: [number, number]) => {
    const rows: Row[] = [];
    for (let d = dayStart(a); d < b; d += DAY) rows.push({ day: d, data: days.get(d) ?? {} });
    return rows;
  };
  const points: SeriesPoint[] = frame.buckets.map((b) => {
    if (c.agg.kind === "stock") {
      const day = dayStart(frame.snapshot(b));
      return { start: b.start, values: get(def.name, { day, data: days.get(day) ?? {} }), incomplete: frame.stockIncomplete(b) };
    }
    const w = frame.window(b);
    const rows = w[1] > w[0] ? daysIn(w) : [];
    const values = c.agg.kind === "sum"
      ? measures.map((_, i) => rows.reduce((s, r) => s + (get(def.name, r)[i] ?? 0), 0))
      : c.agg.combine(rows, w, get);
    return { start: b.start, values, incomplete: frame.clipped(b) };
  });
  return { kind: "series", measures, points };
}
