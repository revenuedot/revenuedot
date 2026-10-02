import { chartTypeFor, measureGroups, stackPeriod, type ChartDef, type ChartType, type ChartView } from "@revenuedot/core";
import { Raster, encodePng, hex } from "../og-png.js";

/**
 * Share preview (prd/charts/PRD.md "Share preview"): a public picture of one chart view. The snapshot is made from the
 * chart API's own answer when the link is created, so a link shows exactly the numbers the page showed, and holds only
 * what the picture needs: series labels and values, summary values, the measure, dates and the view's description.
 * No customer data. Renderers: an SVG plot (themed with CSS variables on the page, light colours alone), a 1200×630 PNG
 * for link previews (services/og-png.ts), and the HTML page.
 */

export interface ChartSnapshot {
  v: 1;
  chart: string;
  title: string;
  description: string;
  project: string;
  type: ChartType | "cohort";
  resolution: string;
  start_date: string;
  end_date: string;
  currency: string;
  environment: "production" | "sandbox";
  computed_at: number;
  /** "Country: United States, Germany", "By country", "Revenue type: Proceeds" … */
  context: string[];
  measure: { name: string; unit: "$" | "#" | "%"; precision: number };
  periods: { start: number; label: string; long: string; incomplete: boolean }[];
  series: { label: string; values: (number | null)[]; other?: boolean }[];
  stats: { label: string; kind: "latest" | "total" | "average"; value: number | null; unit: "$" | "#" | "%"; precision: number }[];
  cohort?: { columns: { name: string; unit: "$" | "#" | "%"; precision: number }[]; rows: { label: string; cells: (number | null)[] }[] };
}

interface Measure { id: string; display_name: string; unit: "$" | "#" | "%"; decimal_precision: number; chartable: boolean; tabulable: boolean }
interface SeriesMeta { display_name: string; unit?: "$" | "#" | "%"; decimal_precision?: number; is_total?: boolean; is_other?: boolean }
/** The chart API's answer (RevenueCat's ChartData), as far as a snapshot reads it. */
export interface ChartBody {
  display_name: string; description: string; resolution: string; yaxis_currency: string; start_date: number; end_date: number;
  measures: Measure[]; values: { cohort: number; measure?: number; segment?: number; period?: number; value: number | null; incomplete?: boolean }[];
  segments: SeriesMeta[] | null; periods?: SeriesMeta[] | null; summary: Record<string, Record<string, number | null>>; user_selectors: Record<string, string> | null;
}
export interface ChartOptionsBody {
  segments: { id: string; display_name: string }[];
  filters: { id: string; display_name: string; options: { id: string; display_name: string }[] }[];
  user_selectors: Record<string, { display_name: string; options: { id: string; display_name: string }[] }> | null;
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function periodLabel(startMs: number, res: string) {
  const d = new Date(startMs);
  const m = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const y = String(d.getUTCFullYear());
  const long = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: "UTC" });
  if (res === "day") return { label: `${m} ${d.getUTCDate()}`, long: long({ month: "short", day: "numeric", year: "numeric" }) };
  if (res === "week") return { label: `${m} ${d.getUTCDate()}`, long: `Week of ${long({ month: "short", day: "numeric", year: "numeric" })}` };
  if (res === "month") return { label: `${m} '${y.slice(2)}`, long: long({ month: "long", year: "numeric" }) };
  if (res === "quarter") return { label: `Q${Math.floor(d.getUTCMonth() / 3) + 1} '${y.slice(2)}`, long: `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}` };
  return { label: y, long: y };
}

/** Builds the snapshot from the chart and options answers and the view (chart type, measure group). */
export function buildSnapshot(def: ChartDef, body: ChartBody, options: ChartOptionsBody, view: ChartView, project: string, now: number): ChartSnapshot {
  const base = {
    v: 1 as const, chart: def.name, title: body.display_name, description: def.description, project, resolution: body.resolution,
    start_date: iso(body.start_date), end_date: iso(body.end_date), currency: body.yaxis_currency, environment: view.env === "sandbox" ? "sandbox" as const : "production" as const, computed_at: now,
  };
  const context: string[] = [];
  let filters: { name: string; values: string[] }[] = [];
  try { const f = JSON.parse(view.filters ?? "[]"); if (Array.isArray(f)) filters = f; } catch { /* the chart API rejected a bad one already */ }
  for (const f of filters) {
    const o = options.filters.find((x) => x.id === f.name);
    context.push(`${o?.display_name ?? f.name}: ${f.values.map((v) => o?.options.find((x) => x.id === v)?.display_name ?? (v || "Unknown")).join(", ")}`);
  }
  if (view.segment) context.push(`By ${(options.segments.find((s) => s.id === view.segment)?.display_name ?? view.segment).toLowerCase()}`);
  for (const [k, v] of Object.entries(body.user_selectors ?? {})) {
    const s = options.user_selectors?.[k];
    const d = def.selectors.find((x) => x.id === k);
    if (s && d && v !== d.default) context.push(`${s.display_name}: ${s.options.find((o) => o.id === v)?.display_name ?? v}`);
  }
  const lookup = new Map<string, number | null>();
  for (const v of body.values) lookup.set(`${v.cohort}|${v.segment ?? ""}|${v.measure ?? ""}|${v.period ?? ""}`, v.value);
  const at = (cohort: number, o: { segment?: number; measure?: number; period?: number }) => lookup.get(`${cohort}|${o.segment ?? ""}|${o.measure ?? ""}|${o.period ?? ""}`) ?? null;

  if (body.periods) {
    const cohorts = [...new Set(body.values.map((v) => v.cohort))].sort((a, b) => a - b);
    const columns = body.periods.map((p) => ({ name: p.display_name, unit: p.unit ?? "#", precision: p.decimal_precision ?? 0 }));
    return {
      ...base, type: "cohort", context, measure: { name: body.measures[0]?.display_name ?? body.display_name, unit: body.measures[0]?.unit ?? "#", precision: body.measures[0]?.decimal_precision ?? 0 },
      periods: [], series: [], stats: [],
      cohort: { columns, rows: cohorts.map((c) => ({ label: periodLabel(c * 1000, body.resolution).long, cells: body.periods!.map((_, k) => at(c, { period: k })) })) },
    };
  }
  const starts = [...new Set(body.values.map((v) => v.cohort))].sort((a, b) => a - b);
  const incomplete = new Set(body.values.filter((v) => v.incomplete).map((v) => v.cohort));
  const periods = starts.map((s) => ({ start: s * 1000, ...periodLabel(s * 1000, body.resolution), incomplete: incomplete.has(s) }));
  const segmented = !!body.segments;
  const groups = measureGroups(body.measures, segmented);
  const gi = Number(view.m ?? 0);
  const group = groups[Number.isInteger(gi) && gi >= 0 && gi < groups.length ? gi : 0] ?? [];
  const sel = group[0] ?? 0;
  const values = (seg: number | undefined, m: number) => starts.map((s) => at(s, { segment: seg, measure: m }));
  const series = segmented
    ? body.segments!.map((s, i) => ({ label: s.display_name, values: values(i, sel), ...(s.is_other ? { other: true } : {}), total: s.is_total })).filter((s) => !s.total).map(({ total: _t, ...s }) => s)
    : group.map((j) => ({ label: body.measures[j]!.display_name, values: values(undefined, j) }));
  const m = body.measures[sel];
  const stats = body.measures.filter((x) => x.tabulable).slice(0, 4).map((x) => {
    const j = body.measures.indexOf(x);
    const kind: "latest" | "total" | "average" = def.shape === "stock" ? "latest" : x.display_name in (body.summary.total ?? {}) && x.unit !== "%" ? "total" : "average";
    const latestSeg = segmented ? body.segments!.findIndex((s) => s.is_total) : -1;
    const value = kind === "latest" ? [...values(latestSeg >= 0 ? latestSeg : undefined, j)].reverse().find((v) => v !== null) ?? null
      : (kind === "total" ? body.summary.total : body.summary.average)?.[x.display_name] ?? null;
    return { label: x.display_name, kind, value, unit: x.unit, precision: x.decimal_precision };
  });
  return {
    ...base, type: chartTypeFor(def, view.type, series.length, segmented), context,
    measure: { name: m?.display_name ?? body.display_name, unit: m?.unit ?? "#", precision: m?.decimal_precision ?? 0 }, periods, series, stats,
  };
}

// ---- Formatting ------------------------------------------------------------------------------------------------------
export function formatValue(v: number | null, unit: string, currency: string, precision = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (unit === "$") {
    try { return v.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: Math.min(precision, 2), maximumFractionDigits: Math.max(2, precision) }); } catch { return `${v.toFixed(2)} ${currency}`; }
  }
  if (unit === "%") return `${v.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
  return v.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 });
}
export function formatTick(v: number, unit: string, currency: string): string {
  const s = Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : `${+v.toFixed(2)}`;
  if (unit === "$") return `${currency === "USD" ? "$" : `${currency} `}${s}`;
  return unit === "%" ? `${s}%` : s;
}
function niceTicks(min: number, max: number, count = 4, integer = false): number[] {
  if (min === max) { max = min === 0 ? 1 : min > 0 ? min * 1.2 : 0; if (min > 0) min = 0; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((x) => x * mag).find((s) => s >= raw) ?? raw;
  if (integer) step = Math.max(1, Math.ceil(step));
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Where every mark goes, shared by the SVG and PNG renderers. */
interface Layout {
  x: (i: number) => number; band: number; y: (v: number) => number; ticks: number[]; zero: number;
  /** [from, to] per series per period for stacked types; null otherwise. */
  stacks: ([number, number] | null)[][] | null;
  unit: string;
}
function layout(s: ChartSnapshot, box: { L: number; T: number; W: number; H: number }): Layout {
  const n = s.periods.length;
  const stacked = s.type === "stacked_area" || s.type === "stacked_column" || s.type === "percent_column";
  const stacks = stacked ? s.periods.map((_, i) => stackPeriod(s.series.map((x) => x.values[i]), s.type === "percent_column")) : null;
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    if (stacks) for (const r of stacks[i]!) { if (r) { lo = Math.min(lo, r[0], r[1]); hi = Math.max(hi, r[0], r[1]); } }
    else for (const x of s.series) { const v = x.values[i]; if (v !== null && v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  }
  const unit = s.type === "percent_column" ? "%" : s.measure.unit;
  const integer = unit === "#" && s.series.every((x) => x.values.every((v) => v === null || Number.isInteger(v)));
  const ticks = niceTicks(lo, hi, 4, integer);
  const a = ticks[0]!, b = ticks[ticks.length - 1]!;
  const band = box.W / Math.max(1, n);
  const y = (v: number) => box.T + box.H - ((v - a) / ((b - a) || 1)) * box.H;
  return { x: (i) => box.L + band * i + band / 2, band, y, ticks, zero: y(0), stacks, unit };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const LIGHT = { fg: "#0A0A0A", fg2: "#525252", fg3: "#737373", border: "#E5E5E5", border2: "#F0F0F0", panel: "#FFFFFF", accent: "#F7B500", series: ["#2A78D6", "#EB6834", "#1BAF7A", "#4A3AA7", "#E87BA4"] };
type Palette = { fg: string; fg3: string; border: string; border2: string; panel: string; accent: string; series: (i: number, other?: boolean) => string };
const cssPalette: Palette = { fg: "var(--fg)", fg3: "var(--fg-3)", border: "var(--border)", border2: "var(--border-2)", panel: "var(--panel)", accent: "var(--accent)", series: (i, o) => (o ? "var(--fg-3)" : `var(--series-${(i % 5) + 1})`) };
const hexPalette: Palette = { ...LIGHT, series: (i, o) => (o ? LIGHT.fg3 : LIGHT.series[i % 5]!) };

/** The plot as SVG markup: grid, mono axis labels, then lines, areas or columns in the design tokens' rules. */
export function plotSvg(s: ChartSnapshot, w: number, h: number, css: boolean): string {
  const p = css ? cssPalette : hexPalette;
  const L = 72, R = 16, T = 14, B = 30;
  const box = { L, T, W: w - L - R, H: h - T - B };
  const g = layout(s, box);
  const n = s.periods.length;
  const single = s.series.length === 1;
  const color = (i: number) => (single ? p.fg : p.series(i, s.series[i]?.other));
  const out: string[] = [];
  const mono = `font-family="Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="${p.fg3}"`;
  for (const t of g.ticks) out.push(`<line x1="${L}" x2="${w - R}" y1="${g.y(t).toFixed(1)}" y2="${g.y(t).toFixed(1)}" stroke="${t === 0 ? p.border : p.border2}" stroke-width="1"/><text x="${L - 10}" y="${g.y(t).toFixed(1)}" dy="0.32em" text-anchor="end" ${mono}>${esc(formatTick(t, g.unit, s.currency))}</text>`);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(box.W / 92))));
  s.periods.forEach((per, i) => { if ((i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2)) out.push(`<text x="${g.x(i).toFixed(1)}" y="${h - 10}" text-anchor="middle" ${mono}>${esc(per.label)}</text>`); });
  if (s.type === "line") {
    s.series.forEach((x, si) => {
      let solid = "", dashed = "", prev: [number, number] | null = null;
      x.values.forEach((v, i) => {
        if (v === null || v === undefined) { prev = null; return; }
        const pt: [number, number] = [g.x(i), g.y(v)];
        if (prev) { const seg = `M${prev[0].toFixed(1)} ${prev[1].toFixed(1)}L${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`; if (s.periods[i]!.incomplete) dashed += seg; else solid += seg; }
        prev = pt;
      });
      if (solid) out.push(`<path d="${solid}" fill="none" stroke="${color(si)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (dashed) out.push(`<path d="${dashed}" fill="none" stroke="${single ? p.accent : color(si)}" stroke-width="2" stroke-dasharray="4 4"/>`);
      const lastI = x.values.length - 1, lastV = x.values[lastI];
      if (single && lastV !== null && lastV !== undefined) out.push(`<rect x="${(g.x(lastI) - 4).toFixed(1)}" y="${(g.y(lastV) - 4).toFixed(1)}" width="8" height="8" fill="${p.accent}"/>`);
      if (n === 1 && lastV !== null && lastV !== undefined && !single) out.push(`<rect x="${(g.x(0) - 4).toFixed(1)}" y="${(g.y(lastV) - 4).toFixed(1)}" width="8" height="8" fill="${color(si)}"/>`);
    });
  } else if (s.type === "stacked_area") {
    s.series.forEach((_, si) => {
      const top: string[] = [], bottom: string[] = [];
      g.stacks!.forEach((st, i) => { const r = st[si] ?? [st.slice(0, si).reverse().find((q) => q)?.[1] ?? 0, st.slice(0, si).reverse().find((q) => q)?.[1] ?? 0]; top.push(`${g.x(i).toFixed(1)} ${g.y(r[1]).toFixed(1)}`); bottom.unshift(`${g.x(i).toFixed(1)} ${g.y(r[0]).toFixed(1)}`); });
      if (top.length) out.push(`<path d="M${top.join("L")}L${bottom.join("L")}Z" fill="${color(si)}" fill-opacity="0.85" stroke="${p.panel}" stroke-width="1"/>`);
    });
  } else {
    const barW = Math.max(2, Math.min(24, (g.band * 0.62) / (s.type === "column" && !single ? s.series.length : 1)));
    s.periods.forEach((per, i) => {
      const faded = per.incomplete ? ' opacity="0.55"' : "";
      if (g.stacks) {
        g.stacks[i]!.forEach((r, si) => {
          if (!r || r[0] === r[1]) return;
          const top = Math.min(g.y(r[0]), g.y(r[1])), hh = Math.abs(g.y(r[0]) - g.y(r[1])), gap = s.series.length > 1 && hh > 3 ? 1 : 0;
          out.push(`<rect x="${(g.x(i) - barW / 2).toFixed(1)}" y="${(top + gap).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, hh - 2 * gap).toFixed(1)}" fill="${color(si)}"${faded}/>`);
        });
      } else {
        s.series.forEach((x, si) => {
          const v = x.values[i];
          if (v === null || v === undefined) return;
          const cur = single && per.incomplete && i === n - 1;
          const bx = single ? g.x(i) - barW / 2 : g.x(i) - (barW * s.series.length + 2 * (s.series.length - 1)) / 2 + si * (barW + 2);
          out.push(`<rect x="${bx.toFixed(1)}" y="${Math.min(g.zero, g.y(v)).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.abs(g.zero - g.y(v)).toFixed(1)}" fill="${cur ? p.accent : color(si)}"${cur ? "" : faded}/>`);
        });
      }
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(`${s.title}: ${s.series.map((x) => x.label).join(", ")}`)}">${out.join("")}</svg>`;
}

/** A cohort table as an SVG heat table (Subscription Retention, Cohort and Prediction Explorer). */
function cohortSvg(s: ChartSnapshot, w: number, h: number, css: boolean): string {
  const p = css ? cssPalette : hexPalette;
  const c = s.cohort!;
  const cols = Math.min(c.columns.length, 9), rows = Math.min(c.rows.length, 12);
  const labelW = 170, cw = (w - labelW) / Math.max(1, cols), rh = Math.min(34, (h - 30) / Math.max(1, rows + 1));
  const vals = c.rows.flatMap((r) => r.cells.slice(1, cols)).filter((v): v is number => v !== null);
  const max = Math.max(0, ...vals);
  const out: string[] = [];
  const text = (x: number, y: number, t: string, anchor = "end", fill = p.fg) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dy="0.32em" font-family="Geist Mono, ui-monospace, monospace" font-size="12" fill="${fill}">${esc(t)}</text>`;
  c.columns.slice(0, cols).forEach((col, k) => out.push(text(labelW + cw * (k + 1) - 8, rh / 2, col.name, "end", p.fg3)));
  c.rows.slice(-rows).forEach((r, i) => {
    const y = rh * (i + 1);
    out.push(`<line x1="0" x2="${w}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${p.border2}"/>`);
    out.push(text(0, y + rh / 2, r.label, "start"));
    r.cells.slice(0, cols).forEach((v, k) => {
      if (k > 0 && v !== null && max > 0) out.push(`<rect x="${(labelW + cw * k).toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="${rh.toFixed(1)}" fill="${p.fg}" fill-opacity="${(0.04 + 0.32 * (v / max)).toFixed(3)}"/>`);
      out.push(text(labelW + cw * (k + 1) - 8, y + rh / 2, v === null ? "" : formatValue(v, c.columns[k]!.unit, s.currency, c.columns[k]!.precision)));
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(s.title)}">${out.join("")}</svg>`;
}

const headline = (s: ChartSnapshot) => s.stats[0] ?? null;
const rangeText = (s: ChartSnapshot) => {
  const f = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${f(s.start_date)} – ${f(s.end_date)}`;
};
const contextLine = (s: ChartSnapshot) => [s.project, rangeText(s), s.resolution === "day" ? "Daily" : `${s.resolution[0]!.toUpperCase()}${s.resolution.slice(1)}ly`.replace("Dayly", "Daily"), ...s.context, ...(s.environment === "sandbox" ? ["Sandbox data"] : [])].join(" · ");

/** The 1200×630 card as SVG with real fonts (…/chart.svg). */
export function cardSvg(s: ChartSnapshot): string {
  const st = headline(s);
  const plot = s.type === "cohort" ? cohortSvg(s, 1072, 360, false) : plotSvg(s, 1072, 360, false);
  const legend = s.series.length > 1 ? s.series.slice(0, 6).map((x, i) => `<rect x="${64 + i * 176}" y="575" width="10" height="10" fill="${x.other ? LIGHT.fg3 : LIGHT.series[i % 5]}"/><text x="${80 + i * 176}" y="584" font-size="15" fill="${LIGHT.fg2}">${esc(x.label.length > 18 ? `${x.label.slice(0, 17)}…` : x.label)}</text>`).join("") : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#FFFFFF"/>
<g font-family="Manrope, ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
<rect x="64" y="52" width="12" height="12" fill="${LIGHT.accent}"/>
<text x="88" y="63" font-size="15" font-weight="600" letter-spacing="1.6" fill="${LIGHT.fg3}">${esc(s.project.toUpperCase())}</text>
<text x="64" y="118" font-size="44" font-weight="600" letter-spacing="-1.5" fill="${LIGHT.fg}">${esc(s.title)}</text>
<text x="64" y="150" font-size="17" fill="${LIGHT.fg3}">${esc(contextLine(s).replace(`${s.project} · `, ""))}</text>
${st ? `<text x="1136" y="96" text-anchor="end" font-size="15" font-weight="600" letter-spacing="1.2" fill="${LIGHT.fg3}">${esc(`${st.label} · ${st.kind}`.toUpperCase())}</text><text x="1136" y="146" text-anchor="end" font-size="44" font-weight="600" letter-spacing="-1.5" fill="${LIGHT.fg}">${esc(formatValue(st.value, st.unit, s.currency, st.precision))}</text>` : ""}
<g transform="translate(64 190)">${plot.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g>
${legend}
<text x="1136" y="590" text-anchor="end" font-size="18" font-weight="600" letter-spacing="-0.5" fill="${LIGHT.fg}">RevenueDot</text>
</g>
</svg>`;
}

/** The 1200×630 link preview as PNG (no fonts on Workers: the pixel font of og-png.ts). */
export async function cardPng(s: ChartSnapshot): Promise<Uint8Array> {
  const W = 1200, H = 630, M = 64;
  const ink = hex("#0A0A0A"), fg3 = hex("#737373"), border = hex("#E5E5E5"), gold = hex("#F7B500"), white = hex("#FFFFFF");
  const r = new Raster(W, H, white);
  r.rect(M, M - 8, 14, 14, gold);
  r.text(M + 28, M - 8, Raster.fit(s.project.toUpperCase(), 2, 640), 2, fg3);
  r.text(M, M + 24, Raster.fit(s.title.toUpperCase(), 6, 700), 6, ink);
  r.text(M, M + 82, Raster.fit(`${rangeText(s)}${s.context.length ? ` · ${s.context.join(" · ")}` : ""}${s.environment === "sandbox" ? " · SANDBOX" : ""}`.toUpperCase(), 2, W - 2 * M), 2, fg3);
  const st = headline(s);
  if (st) {
    const label = Raster.fit(`${st.label} · ${st.kind}`.toUpperCase(), 2, 360);
    r.text(W - M - Raster.textWidth(label, 2), M - 8, label, 2, fg3);
    const v = formatValue(st.value, st.unit, s.currency, st.precision).replace(/−/g, "-");
    const scale = Raster.textWidth(v, 6) <= 380 ? 6 : 4;
    r.text(W - M - Raster.textWidth(v, scale), M + 24, v, scale, ink);
  }
  const top = 200, bottom = H - M - 30, left = M, right = W - M;
  r.rect(left, top, right - left, 1, border); r.rect(left, bottom, right - left, 1, border);
  r.rect(left - 6, top - 6, 13, 2, ink); r.rect(left - 6, top - 6, 2, 13, ink); r.rect(right - 7, bottom + 5, 13, 2, ink); r.rect(right + 4, bottom - 6, 2, 13, ink);
  const colorOf = (i: number) => (s.series.length === 1 ? ink : s.series[i]?.other ? fg3 : hex(LIGHT.series[i % 5]!));
  if (s.type === "cohort") {
    const c = s.cohort!;
    const rows = c.rows.slice(-8), cols = Math.min(c.columns.length, 12);
    const vals = rows.flatMap((x) => x.cells.slice(1, cols)).filter((v): v is number => v !== null);
    const max = Math.max(0, ...vals);
    const cw = (right - left) / Math.max(1, cols), rh = (bottom - top - 8) / Math.max(1, rows.length);
    rows.forEach((row, i) => row.cells.slice(0, cols).forEach((v, k) => {
      if (k === 0 || v === null || max <= 0) return;
      const t = 0.08 + 0.7 * (v / max);
      r.rect(left + cw * k + 1, top + 4 + rh * i + 1, cw - 2, rh - 2, [Math.round(255 - (255 - 10) * t), Math.round(255 - (255 - 10) * t), Math.round(255 - (255 - 10) * t)]);
    }));
  } else if (s.periods.length) {
    const g = layout(s, { L: left + 8, T: top + 12, W: right - left - 16, H: bottom - top - 24 });
    if (g.ticks.includes(0)) r.rect(left, g.zero, right - left, 1, border);
    const n = s.periods.length;
    if (s.type === "line") {
      s.series.forEach((x, si) => {
        for (let i = 1; i < n; i++) { const a = x.values[i - 1], b = x.values[i]; if (a === null || a === undefined || b === null || b === undefined) continue; r.line(g.x(i - 1), g.y(a), g.x(i), g.y(b), 4, s.series.length === 1 && s.periods[i]!.incomplete ? gold : colorOf(si)); }
      });
      const last = s.series.length === 1 ? s.series[0]!.values[n - 1] : null;
      if (last !== null && last !== undefined) r.rect(g.x(n - 1) - 7, g.y(last) - 7, 14, 14, gold);
    } else if (s.type === "stacked_area") {
      // Fill column by column between the stacked edges, interpolated between periods.
      const x0 = g.x(0), x1 = g.x(n - 1);
      for (let px = Math.floor(x0); px <= Math.ceil(x1); px++) {
        const f = n > 1 ? ((px - x0) / (x1 - x0)) * (n - 1) : 0;
        const i = Math.max(0, Math.min(n - 1, Math.floor(f))), j = Math.min(n - 1, i + 1), t = f - i;
        s.series.forEach((_, si) => {
          const a = g.stacks![i]![si], b = g.stacks![j]![si];
          if (!a || !b) return;
          const from = a[0] + (b[0] - a[0]) * t, to = a[1] + (b[1] - a[1]) * t;
          r.rect(px, Math.min(g.y(from), g.y(to)), 1, Math.abs(g.y(from) - g.y(to)), colorOf(si));
        });
      }
    } else {
      const barW = Math.max(3, Math.min(36, (g.band * 0.62) / (s.type === "column" && s.series.length > 1 ? s.series.length : 1)));
      for (let i = 0; i < n; i++) {
        if (g.stacks) g.stacks[i]!.forEach((rg, si) => { if (rg && rg[0] !== rg[1]) r.rect(g.x(i) - barW / 2, Math.min(g.y(rg[0]), g.y(rg[1])) + 1, barW, Math.max(1, Math.abs(g.y(rg[0]) - g.y(rg[1])) - 2), colorOf(si)); });
        else s.series.forEach((x, si) => {
          const v = x.values[i];
          if (v === null || v === undefined) return;
          const bx = s.series.length === 1 ? g.x(i) - barW / 2 : g.x(i) - (barW * s.series.length + 2 * (s.series.length - 1)) / 2 + si * (barW + 2);
          r.rect(bx, Math.min(g.zero, g.y(v)), barW, Math.max(1, Math.abs(g.zero - g.y(v))), s.series.length === 1 && s.periods[i]!.incomplete && i === n - 1 ? gold : colorOf(si));
        });
      }
    }
    // Legend for several series.
    if (s.series.length > 1) {
      let lx = M;
      s.series.slice(0, 6).forEach((x, si) => {
        const label = Raster.fit(x.label.toUpperCase(), 2, 150);
        r.rect(lx, H - M - 4, 12, 12, colorOf(si));
        r.text(lx + 20, H - M - 3, label, 2, fg3);
        lx += 20 + Raster.textWidth(label, 2) + 28;
      });
    }
  }
  const brand = "REVENUEDOT";
  r.text(W - M - Raster.textWidth(brand, 2), H - M - 3, brand, 2, ink);
  return encodePng(r);
}

/** The public page: the chart, its summary values and the values table; Open Graph tags; no scripts. */
export function shareHtml(s: ChartSnapshot, url: string): string {
  const title = `${s.title} · ${s.project}`;
  const st = headline(s);
  const desc = `${st ? `${st.label}: ${formatValue(st.value, st.unit, s.currency, st.precision)}. ` : ""}${contextLine(s)}.`;
  const stats = s.stats.map((x) => `<div class="stat"><span class="label">${esc(x.label)} · ${x.kind}</span><b>${esc(formatValue(x.value, x.unit, s.currency, x.precision))}</b></div>`).join("");
  const legend = s.series.length > 1 ? `<ul class="legend">${s.series.map((x, i) => `<li><i style="background:${x.other ? "var(--fg-3)" : `var(--series-${(i % 5) + 1})`}"></i>${esc(x.label)}</li>`).join("")}</ul>` : "";
  const plot = s.type === "cohort" ? cohortSvg(s, 1040, Math.min(460, 34 * (Math.min(12, s.cohort!.rows.length) + 1) + 4), true) : plotSvg(s, 1040, 320, true);
  const fmt = (v: number | null) => formatValue(v, s.measure.unit, s.currency, s.measure.precision);
  const table = s.type === "cohort"
    ? `<table><thead><tr><th>Cohort</th>${s.cohort!.columns.map((c) => `<th class="n">${esc(c.name)}</th>`).join("")}</tr></thead><tbody>${s.cohort!.rows.map((r) => `<tr><th>${esc(r.label)}</th>${r.cells.map((v, k) => `<td class="n">${v === null ? "" : esc(formatValue(v, s.cohort!.columns[k]!.unit, s.currency, s.cohort!.columns[k]!.precision))}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<table><thead><tr><th>${esc(s.series.length > 1 ? s.measure.name : "Period")}</th>${s.periods.map((p) => `<th class="n" title="${esc(p.long)}">${esc(p.label)}${p.incomplete ? "*" : ""}</th>`).join("")}</tr></thead><tbody>${s.series.map((x) => `<tr><th>${esc(x.label)}</th>${x.values.map((v) => `<td class="n">${esc(fmt(v))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const computed = new Date(s.computed_at).toISOString().replace("T", " ").slice(0, 16);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="robots" content="noindex">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(url)}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(url)}/og.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#fff;--panel:#fff;--fg:#0A0A0A;--fg-2:#525252;--fg-3:#737373;--border:#E5E5E5;--border-2:#F0F0F0;--accent:#F7B500;--series-1:#2A78D6;--series-2:#EB6834;--series-3:#1BAF7A;--series-4:#4A3AA7;--series-5:#E87BA4;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0A0A0A;--panel:#111111;--fg:#FAFAFA;--fg-2:#A3A3A3;--fg-3:#8A8A8A;--border:#262626;--border-2:#1C1C1C;--series-1:#3987E5;--series-2:#D95926;--series-3:#199E70;--series-4:#9085E9;--series-5:#D55181}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:500 14px/20px Manrope,-apple-system,system-ui,sans-serif;letter-spacing:-.005em}
main{max-width:1100px;margin:0 auto;padding:48px 16px}
.badge{display:inline-flex;align-items:center;gap:8px;font:600 11px/16px Manrope,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-3)}.dot{width:8px;height:8px;background:var(--accent)}
h1{margin:8px 0 4px;font-size:28px;line-height:34px;font-weight:600;letter-spacing:-.035em}.ctx{color:var(--fg-2);margin:0 0 24px}
.panel{position:relative;border:1px solid var(--border);background:var(--panel)}
.panel:before,.panel:after{content:"";position:absolute;width:9px;height:9px;border:0 solid var(--fg)}.panel:before{top:-5px;left:-5px;border-top-width:1px;border-left-width:1px}.panel:after{bottom:-5px;right:-5px;border-bottom-width:1px;border-right-width:1px}
.stats{display:flex;flex-wrap:wrap;border-bottom:1px solid var(--border)}.stat{padding:14px 16px;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:2px;min-width:180px}.stat:last-child{border-right:0}
.label{font:600 11px/16px Manrope,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-3)}.stat b{font:600 22px/30px Manrope,system-ui,sans-serif;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:14px;list-style:none;margin:0;padding:12px 16px 0;font-size:12px;color:var(--fg-2)}.legend li{display:inline-flex;align-items:center;gap:6px}.legend i{width:10px;height:10px;display:inline-block}
.plot{overflow-x:auto;padding:8px 0}.plot svg{display:block;width:100%;min-width:600px;height:auto}
.tbl{overflow-x:auto;border-top:1px solid var(--border)}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:8px 12px;border-bottom:1px solid var(--border-2);text-align:left;white-space:nowrap}
thead th{font:600 11px/16px Manrope,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-3)}td.n,th.n{text-align:right;font-family:"Geist Mono",ui-monospace,monospace}tbody th{font-weight:500}
footer{margin-top:20px;color:var(--fg-3);font:400 12px/18px "Geist Mono",ui-monospace,monospace;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}footer a{color:var(--fg-2)}
@media (max-width:640px){.stat{min-width:50%;border-right:0;border-bottom:1px solid var(--border-2)}h1{font-size:24px;line-height:30px}}
</style></head><body><main>
<div class="badge"><span class="dot"></span>Shared from RevenueDot</div>
<h1>${esc(s.title)}</h1><p class="ctx">${esc(contextLine(s))}</p>
<section class="panel" aria-label="${esc(s.title)} chart">${stats ? `<div class="stats">${stats}</div>` : ""}${legend}<div class="plot">${plot}</div><div class="tbl">${table}</div></section>
<footer><span>Computed ${esc(computed)} UTC${s.periods.some((p) => p.incomplete) ? " · * the period was not over yet" : ""}</span><a href="https://revenuedot.app">revenuedot.app</a></footer>
</main></body></html>`;
}

/** A small page for a link that was revoked or never existed. */
export function goneHtml(revoked: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${revoked ? "Link revoked" : "Not found"} · RevenueDot</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#0a0a0a;font:500 15px/1.5 Manrope,ui-sans-serif,system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}}main{padding:16px;max-width:520px}h1{font-size:22px;margin:0 0 8px}p{color:#737373;margin:0}</style>
</head><body><main><h1>${revoked ? "This link was revoked." : "This link does not exist."}</h1><p>${revoked ? "The person who shared this chart turned the link off." : "Check the address, or ask for a new link."}</p></main></body></html>`;
}
