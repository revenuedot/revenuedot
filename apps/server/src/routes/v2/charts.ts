import { eq } from "drizzle-orm";
import {
  AD_REVENUE_VALUE, addMonths, ATTRIBUTION_DIMS, chartDef, customAttributeDim, customAttributeKey, DEFAULT_WEEK_START, dimLabel, NO_ATTRIBUTION, dimValues, floorTo,
  isCustomAttributeDim, isoDay, isPeriodDim, periodDimLabel, RESOLUTIONS, runChart, supportsDim, type ChartDef, type ChartFilter, type ChartOutput, type ChartRequest, type Dim, type MeasureDef, type Resolution,
} from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { chartFromRollups } from "../../services/charts/rollups.js";
import { chartSources, customAttributeOptions, loadChartInput } from "../../services/charts/load.js";
import { annotationsBetween, rcAnnotation } from "../../services/charts/annotations.js";
import { paramError, scope, V2Error, type V2Context, type V2Router } from "./common.js";

/**
 * Charts, wire-compatible with RevenueCat's API v2 `get-chart-data` and `get-chart-options`
 * (GET /v2/projects/{project_id}/charts/{chart_name} and …/options). Definitions and shapes: prd/charts/PRD.md;
 * computation: packages/core/src/charts. RevenueDot extension: `environment=sandbox`.
 */
const DAY = 86_400_000;
export const CURRENCIES = ["USD", "EUR", "GBP", "AUD", "CAD", "JPY", "BRL", "KRW", "CNY", "MXN", "SEK", "PLN", "NZD", "CHF"];
const MAX_PERIODS = 1000;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DOCS = "https://revenuedot.app/docs/guides/charts";
const STORE_LABEL: Record<string, string> = { app_store: "App Store", mac_app_store: "Mac App Store", play_store: "Google Play", amazon: "Amazon", stripe: "Stripe", rc_billing: "Web", test_store: "Test Store", paddle: "Paddle", roku: "Roku", galaxy: "Galaxy Store", external: "External" };

function chart(c: V2Context): ChartDef {
  const def = chartDef(c.req.param("chart_name") ?? "");
  if (!def) throw new V2Error(404, "resource_missing", `Chart not found. Charts: see ${DOCS}.`, "chart_name");
  return def;
}

const day = (name: string, v: string | undefined) => {
  if (v === undefined || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw paramError(`${name} must be a date such as 2026-01-31.`, name);
  return Date.parse(`${v}T00:00:00Z`);
};
const bool = (name: string, v: string | undefined, dflt: boolean) => {
  if (v === undefined || v === "") return dflt;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw paramError(`${name} must be true or false.`, name);
};
function json<T>(name: string, v: string | undefined, check: (x: unknown) => x is T): T | null {
  if (v === undefined || v === "") return null;
  let x: unknown;
  try { x = JSON.parse(v); } catch { throw paramError(`${name} is not valid JSON.`, name); }
  if (!check(x)) throw paramError(`${name} has the wrong shape.`, name);
  return x;
}

interface Parsed {
  realtime: boolean; def: ChartDef; req: ChartRequest; filters: ChartFilter[]; segment: Dim | null; limit: number | null; currency: string;
  sandbox: boolean; aggregate: ("average" | "total")[] | null; annotations: boolean; rangeStart: number; lastDay: number;
}

function parse(c: V2Context, now: Date): Parsed {
  const def = chart(c);
  const q = (k: string) => c.req.query(k);
  // RevenueDot extension: week_start (0 = Sunday … 6 = Saturday, or the day's name) sets the first day of weekly buckets.
  const wsRaw = (q("week_start") ?? "").trim().toLowerCase();
  let weekStart = DEFAULT_WEEK_START;
  if (wsRaw !== "") {
    const byName = WEEKDAYS.indexOf(wsRaw);
    const n = byName >= 0 ? byName : /^[0-6]$/.test(wsRaw) ? Number(wsRaw) : -1;
    if (n < 0) throw paramError("week_start must be 0 (Sunday) to 6 (Saturday), or a day such as monday.", "week_start");
    weekStart = n;
  }
  const resRaw = q("resolution");
  let resolution: Resolution = def.defaultResolution;
  if (resRaw !== undefined && resRaw !== "") {
    const r = /^\d$/.test(resRaw) ? RESOLUTIONS[Number(resRaw)] : RESOLUTIONS.find((x) => x === resRaw);
    if (!r) throw paramError(`resolution must be one of ${RESOLUTIONS.map((x, i) => `${i} (${x})`).join(", ")}.`, "resolution");
    resolution = r;
  }
  const today = Math.floor(now.getTime() / DAY) * DAY;
  const lastDay = day("end_date", q("end_date")) ?? today;
  const cohortTable = def.shape === "cohort_table";
  const rangeStart = day("start_date", q("start_date")) ?? (cohortTable ? addMonths(floorTo(lastDay, "month"), -11) : lastDay - 29 * DAY);
  if (lastDay < rangeStart) throw paramError("end_date must not be before start_date.", "end_date");
  const rangeEnd = lastDay + DAY;
  let n = 0;
  for (let s = floorTo(rangeStart, resolution, weekStart); s < rangeEnd && n <= MAX_PERIODS; s = addPeriodsSafe(s, resolution)) n++;
  if (n > MAX_PERIODS) throw paramError(`The range has more than ${MAX_PERIODS} ${resolution} periods. Use a shorter range or a coarser resolution.`, "start_date");

  const currency = (q("currency") ?? "USD").toUpperCase();
  if (!CURRENCIES.includes(currency)) throw paramError(`currency must be one of ${CURRENCIES.join(", ")}.`, "currency");
  const env = q("environment") ?? "production";
  if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");

  const filters = (json("filters", q("filters"), (x): x is { name: string; values: unknown[] }[] =>
    Array.isArray(x) && x.every((f) => f && typeof f === "object" && typeof (f as any).name === "string" && Array.isArray((f as any).values))) ?? []);
  const supported = () => [...def.dims, ...(def.customAttributes ? ["custom_attribute:<key>"] : [])].join(", ") || "none";
  for (const f of filters) {
    if (!supportsDim(def, f.name)) throw paramError(`Filter "${f.name}" is not supported by ${def.name}. Supported filters: ${supported()}.`, "filters");
  }
  const selectors = json("selectors", q("selectors"), (x): x is Record<string, string> => !!x && typeof x === "object" && !Array.isArray(x)) ?? {};
  for (const [k, v] of Object.entries(selectors)) {
    const s = def.selectors.find((x) => x.id === k);
    if (!s) throw paramError(`Selector "${k}" is not supported by ${def.name}. Supported selectors: ${def.selectors.map((x) => x.id).join(", ") || "none"}.`, "selectors");
    if (!s.options.some((o) => o.id === String(v))) throw paramError(`Selector "${k}" must be one of ${s.options.map((o) => o.id).join(", ")}.`, "selectors");
  }
  const segRaw = q("segment");
  let segment: Dim | null = null;
  if (segRaw) {
    if (!def.segmentable || !supportsDim(def, segRaw)) {
      throw paramError(def.segmentable ? `Segment "${segRaw}" is not supported by ${def.name}. Supported segments: ${supported()}.` : `${def.name} cannot be segmented.`, "segment");
    }
    segment = segRaw as Dim;
  }
  const limRaw = q("limit_num_segments");
  const limit = limRaw === undefined || limRaw === "" ? null : Number(limRaw);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw paramError("limit_num_segments must be a positive integer.", "limit_num_segments");
  const aggRaw = q("aggregate");
  const aggregate = aggRaw ? aggRaw.split(",").map((x) => x.trim()).filter(Boolean) : null;
  if (aggregate && (!aggregate.length || aggregate.some((a) => a !== "average" && a !== "total"))) throw paramError("aggregate must be average, total or both, comma separated.", "aggregate");
  // RevenueCat's `realtime` (default true): false lets the daily rollups answer (services/charts/rollups.ts).
  const realtime = bool("realtime", q("realtime"), true);
  return {
    realtime, def, filters: filters.map((f) => ({ name: f.name as Dim, values: f.values.map(String) })), segment, limit, currency, sandbox: env === "sandbox",
    aggregate: aggregate as Parsed["aggregate"], annotations: bool("include_annotations", q("include_annotations"), false), rangeStart, lastDay,
    req: { resolution, rangeStart, rangeEnd, expand: bool("expand_periods", q("expand_periods"), false), selectors: Object.fromEntries(Object.entries(selectors).map(([k, v]) => [k, String(v)])), weekStart },
  };
}
/** The custom attribute keys a request's filters and segment use, which the chart input must load. */
export const attributeKeysOf = (p: Pick<Parsed, "filters" | "segment">) =>
  [...new Set([...p.filters.map((f) => f.name), ...(p.segment ? [p.segment] : [])].filter(isCustomAttributeDim).map(customAttributeKey))];

function addPeriodsSafe(s: number, r: Resolution) { return r === "day" ? s + DAY : r === "week" ? s + 7 * DAY : addMonths(s, r === "month" ? 1 : r === "quarter" ? 3 : 12); }

const round = (v: number | null, m: Pick<MeasureDef, "unit" | "decimal_precision">) => {
  if (v === null || !Number.isFinite(v)) return null;
  const p = 10 ** Math.max(2, m.decimal_precision);
  return Math.round(v * p) / p;
};

/** ChartSeries metadata for a measure or a segment. */
const series = (display_name: string, m: Pick<MeasureDef, "description" | "unit" | "decimal_precision" | "chartable" | "tabulable">, extra: Record<string, unknown> = {}) => ({
  display_name, description: m.description, unit: m.unit, decimal_precision: m.decimal_precision, scale: m.unit === "%" ? "relative" : "absolute",
  chartable: m.chartable, tabulable: m.tabulable, is_total: false, is_other: false, ...extra,
});

function summaryOf(o: ChartOutput, ops: ("average" | "total")[]) {
  const out: Record<string, Record<string, number | null>> = {};
  if (o.kind === "cohort") {
    if (ops.includes("average")) {
      out.average = {};
      o.periods.forEach((p, k) => {
        const vals = o.rows.map((r) => r.cells[k]?.value).filter((v): v is number => v !== null && v !== undefined);
        out.average![p.display_name] = round(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, p);
      });
    }
    return out;
  }
  for (const op of ops) {
    out[op] = {};
    o.measures.forEach((m, j) => {
      const vals = o.points.map((p) => p.values[j]).filter((v): v is number => v !== null && v !== undefined);
      if (op === "total" && !m.flow) return;
      out[op]![m.display_name] = round(vals.length ? (op === "total" ? vals.reduce((a, b) => a + b, 0) : vals.reduce((a, b) => a + b, 0) / vals.length) : null, m);
    });
  }
  return out;
}

const secs = (ms: number) => Math.floor(ms / 1000);

export function chartRoutes(r: V2Router, deps: Deps) {
  const P = "/v2/projects/:project_id/charts/:chart_name";

  r.get(P, scope("charts_metrics:charts:read"), async (c) => {
    const now = deps.now();
    const p = parse(c, now);
    // With realtime=false, the daily rollups answer a request without filters or segments (services/charts/rollups.ts).
    const rolled = p.realtime ? null : await chartFromRollups(deps.db, { projectId: c.get("projectId"), sandbox: p.sandbox, def: p.def, req: p.req, now, currency: p.currency, filtered: p.filters.length > 0, segmented: !!p.segment });
    let run: { output: ChartOutput; segments: ReturnType<typeof runChart>["segments"] };
    if (rolled) run = { output: rolled.output, segments: null };
    else {
      const sources = { ...chartSources(p.def.name, { from: floorTo(p.rangeStart, p.req.resolution, p.req.weekStart), to: p.req.rangeEnd }), attributeKeys: attributeKeysOf(p) };
      const input = await loadChartInput(deps.db, { projectId: c.get("projectId"), sandbox: p.sandbox, now, currency: p.currency, fetch: deps.fetch ?? undefined, sources });
      run = runChart(p.def, input, p.req, { filters: p.filters, segment: p.segment, limit: p.limit });
    }
    c.header("x-revenuedot-chart-source", rolled ? "rollups" : "live");
    const o = run.output;
    const labels = p.segment ? await dimLabels(deps, c.get("projectId"), p.segment) : null;
    const measures = o.kind === "series" ? o.measures : [o.measure];
    const body: Record<string, unknown> = {
      object: "chart_data", category: p.def.group, display_type: p.def.display_type, display_name: p.def.display_name, description: p.def.description,
      documentation_link: `${DOCS}#${p.def.name}`, last_computed_at: (rolled?.computedAt ?? now).getTime(), start_date: p.rangeStart, end_date: p.lastDay,
      yaxis_currency: p.currency, filtering_allowed: p.def.dims.length > 0, segmenting_allowed: p.def.segmentable && p.def.dims.length > 0,
      resolution: p.req.resolution, values: [] as unknown[], summary: summaryOf(o, p.aggregate ?? ["average", "total"]),
      yaxis: measures[0]?.unit ?? "#", segments: null, segments_limit: p.limit,
      measures: measures.map((m) => ({ id: m.id, display_name: m.display_name, description: m.description, unit: m.unit, decimal_precision: m.decimal_precision, chartable: m.chartable, tabulable: m.tabulable })),
      user_selectors: p.def.selectors.length ? Object.fromEntries(p.def.selectors.map((s) => [s.id, p.req.selectors[s.id] ?? s.default])) : null,
    };
    if (p.annotations) body.annotations = (await annotationsBetween(deps.db, c.get("projectId"), isoDay(p.rangeStart), isoDay(p.lastDay))).map(rcAnnotation);
    if (o.kind === "cohort") {
      body.periods = o.periods.map((x) => ({ display_name: x.display_name, description: x.description, unit: x.unit, decimal_precision: x.decimal_precision, scale: x.scale, chartable: true, tabulable: true, is_total: false, is_other: false }));
      if (!p.aggregate) body.values = o.rows.flatMap((row) => row.cells.map((cell, k) => ({
        cohort: secs(row.start), period: k, value: round(cell.value, o.periods[k]!), incomplete: cell.incomplete, ...(cell.predicted ? { predicted: true } : {}),
      })));
      return c.json(body);
    }
    if (!run.segments) {
      if (!p.aggregate) body.values = o.points.flatMap((pt) => pt.values.map((v, j) => ({ cohort: secs(pt.start), measure: j, value: round(v, o.measures[j]!), incomplete: pt.incomplete })));
      return c.json(body);
    }
    const segs = [...run.segments.map((s) => ({ id: s.id, isOther: s.isOther, total: false, output: s.output })), { id: "Total", isOther: false, total: true, output: o }];
    const nested = o.measures.length > 1 ? o.measures.map((m) => series(m.display_name, m)) : null;
    body.segments = segs.map((s) => series(s.total ? "Total" : s.isOther ? "Other" : labels!(s.id), o.measures[0]!, { is_total: s.total, is_other: s.isOther, id: s.id, ...(nested ? { nested_measures: nested } : {}) }));
    // `measure` indexes the total's measures. Charts whose measures follow the data (one per survey option) can have
    // fewer in a segment: those are matched by id, and an option a segment never chose is 0.
    if (!p.aggregate) body.values = segs.flatMap((s, i) => {
      const so = s.output;
      if (so.kind !== "series") return [];
      const own = new Map(so.measures.map((m, j) => [m.id, j]));
      return so.points.flatMap((pt) => o.measures.map((m, k) => {
        const j = own.get(m.id);
        return { cohort: secs(pt.start), segment: i, measure: k, value: j === undefined ? (p.def.dynamicMeasures ? 0 : null) : round(pt.values[j] ?? null, m), incomplete: pt.incomplete };
      }));
    });
    return c.json(body);
  });

  r.get(`${P}/options`, scope("charts_metrics:charts:read"), async (c) => {
    const def = chart(c);
    const env = c.req.query("environment") ?? "production";
    if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
    const projectId = c.get("projectId");
    // The filter values come from the ledger, customers and the chart's SDK events; activity and refund requests add none.
    const sources = { ...chartSources(def.name, null), activity: null, refundRequests: false };
    const [input, custom] = await Promise.all([
      loadChartInput(deps.db, { projectId, sandbox: env === "sandbox", now: deps.now(), currency: "USD", fetch: null, sources }),
      def.customAttributes ? customAttributeOptions(deps.db, projectId) : Promise.resolve([]),
    ]);
    const options = await Promise.all(def.dims.map(async (d) => {
      const label = await dimLabels(deps, projectId, d);
      return dimValues(input, d).slice(0, 200).map((v) => ({ id: v, display_name: label(v) }));
    }));
    // Custom attributes: every key the project set, with its values across all customers (not one environment's).
    const dims: Dim[] = [...def.dims, ...custom.map((a) => customAttributeDim(a.key))];
    custom.forEach((a) => options.push(a.values.map((v) => ({ id: v, display_name: v === "" ? "Not set" : v }))));
    return c.json({
      object: "chart_options",
      resolutions: RESOLUTIONS.map((x, i) => ({ id: String(i), display_name: x })),
      segments: def.segmentable ? dims.map((d) => ({ object: "chart_segment_option", id: d, display_name: dimLabel(d).display_name, group_display_name: dimLabel(d).group })) : [],
      filters: dims.map((d, i) => ({ object: "chart_filter_option", id: d, display_name: dimLabel(d).display_name, group_display_name: dimLabel(d).group, options: options[i]! })),
      user_selectors: def.selectors.length ? Object.fromEntries(def.selectors.map((s) => [s.id, { default: s.default, display_name: s.display_name, options: s.options }])) : null,
    });
  });
}

const DURATION = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/;
function durationLabel(iso: string) {
  const m = DURATION.exec(iso);
  if (!m) return iso;
  const parts: string[] = [];
  const add = (n: string | undefined, unit: string) => { if (n && Number(n)) parts.push(`${Number(n)} ${unit}${Number(n) > 1 ? "s" : ""}`); };
  add(m[1], "year"); add(m[2], "month"); add(m[3], "week"); add(m[4], "day");
  return parts.join(" ") || iso;
}
let regions: Intl.DisplayNames | null | undefined;
const countryName = (code: string) => {
  if (regions === undefined) { try { regions = new Intl.DisplayNames(["en"], { type: "region" }); } catch { regions = null; } }
  try { return regions?.of(code) ?? code; } catch { return code; }
};

/** Human labels for a dimension's values: app, product, offering and paywall names from the project; countries in English. */
async function dimLabels(deps: Deps, projectId: string, dim: Dim): Promise<(v: string) => string> {
  const unknown = (v: string, f: (v: string) => string) => (v === "" ? "Unknown" : v === AD_REVENUE_VALUE ? "Ad revenue" : f(v));
  const { db } = deps;
  if (dim === "app") {
    const rows = await db.select({ id: schema.apps.id, name: schema.apps.name }).from(schema.apps).where(eq(schema.apps.projectId, projectId));
    const m = new Map(rows.map((x) => [x.id, x.name]));
    return (v) => unknown(v, (x) => m.get(x) ?? x);
  }
  if (dim === "product") {
    const rows = await db.select({ id: schema.products.storeIdentifier, name: schema.products.displayName }).from(schema.products).where(eq(schema.products.projectId, projectId));
    const m = new Map(rows.map((x) => [x.id, x.name ?? x.id]));
    return (v) => unknown(v, (x) => m.get(x) ?? x);
  }
  if (dim === "offering") {
    const rows = await db.select({ id: schema.offerings.lookupKey, name: schema.offerings.displayName }).from(schema.offerings).where(eq(schema.offerings.projectId, projectId));
    const m = new Map(rows.map((x) => [x.id, x.name]));
    return (v) => unknown(v, (x) => m.get(x) ?? x);
  }
  if (dim === "paywall") {
    const rows = await db.select({ id: schema.paywalls.id, name: schema.paywalls.name }).from(schema.paywalls).where(eq(schema.paywalls.projectId, projectId));
    const m = new Map(rows.map((x) => [x.id, x.name ?? x.id]));
    return (v) => unknown(v, (x) => m.get(x) ?? x);
  }
  if (dim === "store") return (v) => unknown(v, (x) => STORE_LABEL[x] ?? x);
  if (dim === "country") return (v) => unknown(v, countryName);
  if (dim === "product_duration") return (v) => unknown(v, durationLabel);
  if ((ATTRIBUTION_DIMS as string[]).includes(dim)) return (v) => (v === "" ? NO_ATTRIBUTION : v);
  if (isPeriodDim(dim)) return (v) => periodDimLabel(dim, v);
  if (isCustomAttributeDim(dim)) return (v) => (v === "" ? "Not set" : v);
  return (v) => unknown(v, (x) => x);
}

/** For the chart extensions (chart-extras.ts): the same parameters and labels as the chart itself. */
export { parse as parseChartQuery, dimLabels };
