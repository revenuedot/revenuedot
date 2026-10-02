import type { ChartDef } from "./catalog.js";
import { DAY } from "./time.js";

/**
 * A chart view as the Charts page keeps it in its URL and saved charts and share links keep it in `view`
 * (prd/charts/PRD.md): range, dates, resolution, segment, filters, selectors, environment, compare, chart type and the
 * measure group. The page and the server read it the same way through these functions.
 */
export interface ChartView {
  range?: string; start?: string; end?: string; res?: string; segment?: string; filters?: string; sel?: string;
  env?: "production" | "sandbox"; compare?: boolean; type?: string; m?: string;
}

export const CHART_TYPES = ["line", "stacked_area", "column", "stacked_column", "percent_column"] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const CHART_TYPE_LABEL: Record<ChartType, string> = {
  line: "Line", stacked_area: "Stacked area", column: "Column", stacked_column: "Stacked column", percent_column: "100% stacked column",
};
export const isStackedType = (t: ChartType) => t === "stacked_area" || t === "stacked_column" || t === "percent_column";

/** The type a chart opens with: line charts as lines; bar charts as columns, stacked when segmented or stacked by design. */
export function defaultChartType(def: Pick<ChartDef, "display_type">, segmented: boolean): ChartType {
  if (def.display_type === "line") return "line";
  return def.display_type === "stacked_bar" || segmented ? "stacked_column" : "column";
}

/** The type to draw: the requested one when it can be drawn, else its unstacked twin (stacking needs two series). */
export function chartTypeFor(def: Pick<ChartDef, "display_type">, requested: string | null | undefined, seriesCount: number, segmented: boolean): ChartType {
  const want = (CHART_TYPES as readonly string[]).includes(requested ?? "") ? (requested as ChartType) : defaultChartType(def, segmented);
  if (seriesCount > 1 || !isStackedType(want)) return want;
  return want === "stacked_area" ? "line" : "column";
}

export const RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "12m": 365 };
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * The API query of a view on a given day: presets end today (UTC) and start N−1 days before; "custom" uses its dates.
 * Cohort tables default to 12 months, other charts to 30 days; long ranges default to months.
 */
export function viewQuery(def: Pick<ChartDef, "shape">, v: ChartView, now: number): Record<string, string> {
  const cohortTable = def.shape === "cohort_table";
  const range = v.range && (v.range === "custom" || v.range in RANGE_DAYS) ? v.range : cohortTable ? "12m" : "30d";
  const today = Math.floor(now / DAY) * DAY;
  const days = RANGE_DAYS[range] ?? 30;
  const end = range === "custom" ? v.end ?? iso(today) : iso(today);
  const start = range === "custom" ? v.start ?? iso(today - 29 * DAY) : iso(today - (days - 1) * DAY);
  const q: Record<string, string> = { resolution: v.res ?? (cohortTable || days > 120 ? "month" : "day"), start_date: start, end_date: end, environment: v.env === "sandbox" ? "sandbox" : "production" };
  if (v.segment) { q.segment = v.segment; q.limit_num_segments = "5"; }
  if (v.filters && v.filters !== "[]") q.filters = v.filters;
  if (v.sel && v.sel !== "{}") q.selectors = v.sel;
  return q;
}

/**
 * Which measures are plotted together. Never two y axes: chartable measures are grouped by unit and one group is shown
 * at a time; a segmented chart plots one measure, split by segment. Returns measure indexes per group.
 */
export function measureGroups(measures: { unit: string; chartable: boolean }[], segmented: boolean): number[][] {
  const chartable = measures.map((m, i) => ({ m, i })).filter((x) => x.m.chartable);
  if (segmented) return chartable.map((x) => [x.i]);
  return [...new Set(chartable.map((x) => x.m.unit))].map((u) => chartable.filter((x) => x.m.unit === u).map((x) => x.i));
}
export const groupLabel = (measures: { display_name: string; unit: string }[], g: number[]) =>
  g.length === 1 ? measures[g[0]!]!.display_name : measures[g[0]!]!.unit === "%" ? "Rates" : measures[g[0]!]!.unit === "$" ? "Amounts" : "Counts";

/**
 * Stacks one period's values for a stacked type: positives up from zero, negatives down. For the 100% column each value
 * becomes its share of the period's total of absolute values. Returns [from, to] per series, in plotted units.
 */
export function stackPeriod(values: (number | null | undefined)[], percent: boolean): ([number, number] | null)[] {
  const abs = values.reduce<number>((s, v) => s + Math.abs(v ?? 0), 0);
  let pos = 0, neg = 0;
  return values.map((raw) => {
    if (raw === null || raw === undefined) return null;
    const v = percent ? (abs > 0 ? (raw / abs) * 100 : 0) : raw;
    const from = v >= 0 ? pos : neg;
    const to = from + v;
    if (v >= 0) pos = to; else neg = to;
    return [from, to];
  });
}
