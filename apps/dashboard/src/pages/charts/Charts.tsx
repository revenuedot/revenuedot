/*
 * Charts: every built-in chart (prd/charts/PRD.md), grouped in a rail the way RevenueCat's chart list is, with one
 * reusable chart page. Data: GET /v2/projects/{id}/charts/{chart} and …/options (RevenueCat's shape). The state lives in
 * the URL (range, resolution, segment, filters, selectors, sandbox, chart type, measure, tab), so a chart view is a link
 * you can share with your team.
 *
 * Saved charts (a named view) are listed on top of the rail; "Compare" draws the window of the same length just before the
 * current one as a dashed line. The page (prd/charts/PRD.md "The chart page") also has the chart type menu, the
 * Summary, Customers and Annotations tabs under the chart, annotation markers and "+" on a selected day or range,
 * Refresh, Ask AI (RevenueDot AI with the chart mentioned) and the "…" menu with Export CSV and Share preview.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { addPeriods, CHART_TYPE_LABEL, CHART_TYPES, CHARTS, chartTypeFor, defaultChartType, GROUPS, chartDef, groupLabel, isStackedType, measureGroups, type ChartDef, type ChartType, type Resolution } from "@revenuedot/core";
import { Shell, useMe } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Dialog, Field, Menu, Segmented, Switch, Tabs, Tag, useProjectId, useToast } from "../../components/ui";
import { api, type List } from "../../lib/api";
import { currencyDigits, currencySymbol, getDisplay } from "../../lib/prefs";
import { DateField } from "../../components/DateField";
import { Legend, Plot, seriesColor, type PlotAnnotation, type Series } from "./plot";
import { AnnotationDialog, AnnotationsTab, CustomersTab, ShareDialog, annotationsKey, customersKey, useAnnotations, whenText, type Annotation } from "./extras";
import { PlanSlot } from "../../components/PlanRequired";

interface Measure { id: string; display_name: string; description: string; unit: "$" | "#" | "%"; decimal_precision: number; chartable: boolean; tabulable: boolean }
interface SeriesMeta { id?: string; display_name: string; unit?: string; scale?: string; is_total?: boolean; is_other?: boolean; decimal_precision?: number }
interface ChartData {
  display_name: string; description: string; display_type: string; resolution: string; yaxis_currency: string; start_date: number; end_date: number;
  measures: Measure[]; values: { cohort: number; measure?: number; segment?: number; period?: number; value: number | null; incomplete?: boolean; predicted?: boolean }[];
  segments: SeriesMeta[] | null; periods?: SeriesMeta[] | null; summary: Record<string, Record<string, number | null>>; user_selectors: Record<string, string> | null;
  last_computed_at: number;
}
interface Options {
  resolutions: { id: string; display_name: string }[];
  segments: { id: string; display_name: string; group_display_name?: string }[];
  filters: { id: string; display_name: string; group_display_name?: string; options: { id: string; display_name: string }[] }[];
  user_selectors: Record<string, { default: string; display_name: string; options: { id: string; display_name: string }[] }> | null;
}

interface SavedChart { id: string; name: string; chart_name: string; view: Record<string, string | boolean>; created_at: number }
const useSaved = (pid: string) => useQuery({ queryKey: ["saved-charts", pid], enabled: !!pid, queryFn: () => api<List<SavedChart>>(`/v2/projects/${pid}/saved_charts?limit=200`) });
/** The URL of a saved chart: its view becomes the page's query parameters. */
function savedHref(pid: string, s: SavedChart) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(s.view)) { if (k === "compare") { if (v) q.set("cmp", "1"); } else if (typeof v === "string" && v) q.set(k, v); }
  q.set("saved", s.id);
  return `/projects/${pid}/charts/${s.chart_name}?${q}`;
}

const DAY = 86_400_000;
const RANGES = [
  { value: "7d", label: "7D", days: 7 }, { value: "30d", label: "30D", days: 30 }, { value: "90d", label: "90D", days: 90 },
  { value: "12m", label: "12M", days: 365 }, { value: "custom", label: "Custom", days: 0 },
] as const;
type RangeId = (typeof RANGES)[number]["value"];
const RESOLUTIONS = [["day", "Daily"], ["week", "Weekly"], ["month", "Monthly"], ["quarter", "Quarterly"], ["year", "Yearly"]] as const;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A URL parameter's JSON, or the fallback when it is missing, malformed or the wrong shape (a hand-edited link). */
function parseJson<T>(v: string | null, fallback: T, ok: (x: unknown) => boolean): T {
  if (!v) return fallback;
  try { const x: unknown = JSON.parse(v); return ok(x) ? (x as T) : fallback; } catch { return fallback; }
}
const isFilters = (x: unknown) => Array.isArray(x) && x.every((f) => !!f && typeof f.name === "string" && Array.isArray(f.values) && f.values.every((v: unknown) => typeof v === "string"));
const isSelectors = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x) && Object.values(x).every((v) => typeof v === "string");

/** Values by cohort, segment, measure and period: one lookup per table cell instead of a scan. */
function valueIndex(body: ChartData) {
  const m = new Map<string, ChartData["values"][number]>();
  for (const v of body.values) m.set(`${v.cohort}|${v.segment ?? ""}|${v.measure ?? ""}|${v.period ?? ""}`, v);
  return (cohort: number, o: { segment?: number; measure?: number; period?: number }) => m.get(`${cohort}|${o.segment ?? ""}|${o.measure ?? ""}|${o.period ?? ""}`);
}

/** Value formatting by unit: money in the chart's currency, percentages with one decimal, counts with separators. */
function formatter(unit: string, currency: string, precision = 2) {
  return (v: number | null) => {
    if (v === null || v === undefined) return "—";
    // In the currency's own minor units: ¥12,345, not ¥12,345.00.
    if (unit === "$") { const cd = currencyDigits(currency); return v.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: Math.min(precision, cd), maximumFractionDigits: cd === 0 ? 0 : Math.max(cd, precision) }); }
    if (unit === "%") return `${v.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
    return v.toLocaleString("en-US", { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 });
  };
}
function tickFormatter(unit: string, currency: string) {
  return (v: number) => {
    const s = Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : `${+v.toFixed(2)}`;
    if (unit === "$") return `${currencySymbol({ ...getDisplay(), currency })}${s}`;
    return unit === "%" ? `${s}%` : s;
  };
}
function periodLabels(start: number, res: string) {
  const d = new Date(start);
  const m = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const y = String(d.getUTCFullYear());
  if (res === "day") return { label: `${m} ${d.getUTCDate()}`, long: d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) };
  if (res === "week") return { label: `${m} ${d.getUTCDate()}`, long: `Week of ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` };
  if (res === "month") return { label: `${m} '${y.slice(2)}`, long: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
  if (res === "quarter") return { label: `Q${Math.floor(d.getUTCMonth() / 3) + 1} '${y.slice(2)}`, long: `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}` };
  return { label: y, long: y };
}

function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => { const s = v === null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function ChartRail({ pid, current, savedId }: { pid: string; current: string; savedId: string | null }) {
  const [q, setQ] = useState("");
  const saved = useSaved(pid);
  const qc = useQueryClient();
  const toast = useToast();
  const match = (c: ChartDef) => !q.trim() || c.display_name.toLowerCase().includes(q.trim().toLowerCase());
  const mine = (saved.data?.items ?? []).filter((s) => !q.trim() || s.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const remove = async (s: SavedChart) => {
    try { await api(`/v2/projects/${pid}/saved_charts/${s.id}`, { method: "DELETE" }); toast(`Removed “${s.name}”`); } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
    await qc.invalidateQueries({ queryKey: ["saved-charts", pid] });
  };
  return (
    <aside className="crail" aria-label="Charts">
      <div className="crail-s"><Icon name="search" /><input aria-label="Search charts" placeholder="Search charts" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <nav data-scroll="x">
        {mine.length > 0 && (
          <div className="crail-g" aria-label="Saved charts">
            <div className="label">Saved</div>
            {mine.map((s) => (
              <span key={s.id} className={`crail-i crail-sv${s.id === savedId ? " on" : ""}`}>
                <Link to={savedHref(pid, s)} aria-current={s.id === savedId ? "page" : undefined}>{s.name}</Link>
                <button type="button" className="ib" aria-label={`Remove saved chart ${s.name}`} onClick={() => remove(s)}><Icon name="close" /></button>
              </span>
            ))}
          </div>
        )}
        {GROUPS.map((g) => {
          const list = CHARTS.filter((c) => c.group === g.id && c.inRail && match(c));
          if (!list.length) return null;
          return (
            <div key={g.id} className="crail-g">
              <div className="label">{g.display_name}</div>
              {list.map((c) => (
                <Link key={c.name} to={`/projects/${pid}/charts/${c.name}`} className={`crail-i${c.name === current && !savedId ? " on" : ""}`} aria-current={c.name === current && !savedId ? "page" : undefined}>{c.display_name}</Link>
              ))}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

/** A dropdown of filter values for one dimension (multi-select), as a hairline popover. */
function FilterMenu({ options, value, onChange }: { options: Options["filters"]; value: { name: string; values: string[] }[]; onChange: (v: { name: string; values: string[] }[]) => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setDim] = useState<string>("");
  const dim = options.some((o) => o.id === picked) ? picked : options[0]?.id ?? "";
  const cur = options.find((o) => o.id === dim);
  const selected = value.find((f) => f.name === dim)?.values ?? [];
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    onChange([...value.filter((f) => f.name !== dim), ...(next.length ? [{ name: dim, values: next }] : [])]);
  };
  if (!options.length) return null;
  return (
    <div className="fmenu">
      <button type="button" className="btn btn-line" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><Icon name="funnels" />Filter{value.length ? ` (${value.length})` : ""}</button>
      {open && (
        <div className="fpop" role="dialog" aria-label="Filters" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          <div className="fdims" role="tablist" aria-label="Filter by">
            {options.map((o) => <button key={o.id} type="button" role="tab" aria-selected={o.id === dim} onClick={() => setDim(o.id)}>{o.display_name}{value.some((f) => f.name === o.id) && <i className="fdot" />}</button>)}
          </div>
          <div className="fvals">
            {!cur?.options.length ? <p className="subtle">No values in this project's data yet.</p> : cur.options.map((o) => (
              <label key={o.id} className="fval"><input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(o.id)} /><span>{o.display_name}</span></label>
            ))}
          </div>
          <div className="ffoot"><button type="button" className="linkbtn" onClick={() => onChange([])}>Clear all</button><button type="button" className="btn btn-dark" onClick={() => setOpen(false)}>Done</button></div>
        </div>
      )}
    </div>
  );
}

export function ChartsPage() {
  const pid = useProjectId();
  const { chartName } = useParams();
  const [sp] = useSearchParams();
  const def = chartName ? chartDef(chartName) : null;
  // The query (?environment=sandbox from another page's link) survives the redirect to the default chart.
  if (!chartName || !def) return <Navigate to={`/projects/${pid}/charts/revenue${sp.size ? `?${sp}` : ""}`} replace />;
  return <ChartView key={def.name} pid={pid} def={def} />;
}

type TabId = "summary" | "customers" | "annotations";

function ChartView({ pid, def }: { pid: string; def: ChartDef }) {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const role = me.data?.projects.find((x) => x.id === pid)?.role;
  const canWrite = !!role && role !== "viewer";
  const cohortTable = def.shape === "cohort_table";
  const range = (sp.get("range") as RangeId | null) ?? (cohortTable ? "12m" : "30d");
  const today = Math.floor(Date.now() / DAY) * DAY;
  const preset = RANGES.find((r) => r.value === range) ?? RANGES[1];
  const end = range === "custom" ? sp.get("end") ?? iso(today) : iso(today);
  const start = range === "custom" ? sp.get("start") ?? iso(today - 29 * DAY) : iso(today - (preset.days - 1) * DAY);
  const resolution = sp.get("res") ?? (cohortTable || preset.days > 120 ? "month" : "day");
  const segment = sp.get("segment") ?? "";
  const filters = parseJson<{ name: string; values: string[] }[]>(sp.get("filters"), [], isFilters);
  const selectors = parseJson<Record<string, string>>(sp.get("sel"), {}, isSelectors);
  // `?env=sandbox` (the chart's own links) or `?environment=sandbox` (the other pages' switch) opens sandbox data.
  const env = sp.get("env") === "sandbox" || sp.get("environment") === "sandbox" ? "sandbox" : "production";
  const compare = sp.get("cmp") === "1" && !cohortTable;
  const savedId = sp.get("saved");
  const tabs: TabId[] = cohortTable ? ["customers", "annotations"] : ["summary", "customers", "annotations"];
  const tab: TabId = tabs.includes(sp.get("tab") as TabId) ? (sp.get("tab") as TabId) : tabs[0]!;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") next.delete(k); else next.set(k, v); }
    setSp(next, { replace: true });
  };

  const options = useQuery({ queryKey: ["chart-options", pid, def.name, env], queryFn: () => api<Options>(`/v2/projects/${pid}/charts/${def.name}/options?environment=${env}`) });
  // Money in the person's display currency and weeks from their first day (Account settings → Date and region).
  const display = getDisplay();
  const query = new URLSearchParams({ resolution, start_date: start, end_date: end, environment: env });
  if (display.currency !== "USD") query.set("currency", display.currency);
  if (resolution === "week" && display.weekStart !== 1) query.set("week_start", String(display.weekStart));
  if (segment) { query.set("segment", segment); query.set("limit_num_segments", "5"); }
  if (filters.length) query.set("filters", JSON.stringify(filters));
  if (Object.keys(selectors).length) query.set("selectors", JSON.stringify(selectors));
  // The page reads the daily rollups when they are fresh (`realtime=false`); Refresh asks once for numbers computed from
  // the rows (`realtime=true`) and shows that answer, the comparison too, until the view changes.
  const base = query.toString();
  const [liveFor, setLiveFor] = useState<{ q: string; n: number } | null>(null);
  const [toastPending, setToastPending] = useState(false);
  const live = liveFor?.q === base;
  query.set("realtime", live ? "true" : "false");
  const data = useQuery({ queryKey: ["chart", pid, def.name, query.toString(), live ? liveFor!.n : 0], queryFn: () => api<ChartData>(`/v2/projects/${pid}/charts/${def.name}?${query}`), placeholderData: keepPreviousData });
  // Compare: the window of the same length that ends the day before this one starts, at the same resolution.
  // A hand-edited or saved URL can carry any start and end; iso() throws on an invalid date, so compare needs valid days.
  const startMs = Date.parse(`${start}T00:00:00Z`), span = Date.parse(`${end}T00:00:00Z`) - startMs;
  const canCompare = compare && Number.isFinite(startMs) && Number.isFinite(span) && span >= 0;
  const prevQuery = new URLSearchParams(query);
  if (canCompare) { prevQuery.set("end_date", iso(startMs - DAY)); prevQuery.set("start_date", iso(startMs - DAY - span)); }
  const prev = useQuery({ queryKey: ["chart", pid, def.name, prevQuery.toString(), live ? liveFor!.n : 0], enabled: canCompare, queryFn: () => api<ChartData>(`/v2/projects/${pid}/charts/${def.name}?${prevQuery}`) });
  const annotations = useAnnotations(pid, start, end);
  const saved = useSaved(pid);
  const savedNow = saved.data?.items.find((x) => x.id === savedId) ?? null;
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState<(Partial<Annotation> & { start_date: string; end_date: string }) | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const view = () => {
    const v: Record<string, string | boolean> = {};
    for (const k of ["range", "start", "end", "res", "segment", "filters", "sel", "type", "m"]) { const x = sp.get(k); if (x) v[k] = x; }
    if (env === "sandbox") v.env = "sandbox";
    if (compare) v.compare = true;
    return v;
  };
  useEffect(() => { document.title = `${savedNow?.name ?? def.display_name} · Charts · RevenueDot`; }, [def.display_name, savedNow?.name]);

  const body = data.data;
  const currency = body?.yaxis_currency ?? "USD";
  // What the plot shows: one measure group at a time, or one measure split by segment; the type it is drawn as.
  const segmented = !!body?.segments;
  const groups = body && !body.periods ? measureGroups(body.measures, segmented) : [];
  const mRaw = Number(sp.get("m") ?? 0);
  const gi = Number.isInteger(mRaw) && mRaw >= 0 && mRaw < groups.length ? mRaw : 0;
  const seriesCount = segmented ? body!.segments!.filter((x) => !x.is_total).length : groups[gi]?.length ?? 1;
  const chartType = chartTypeFor(def, sp.get("type"), seriesCount, segmented);
  const refresh = async () => {
    setLiveFor({ q: base, n: Date.now() });
    setToastPending(true);
    await Promise.all([["chart-options", pid, def.name], ["chart-customers", pid, def.name], annotationsKey(pid)].map((queryKey) => qc.invalidateQueries({ queryKey })));
  };
  // "Chart recomputed" once the live answer is here.
  useEffect(() => { if (!live && toastPending) setToastPending(false); }, [live, toastPending]);
  useEffect(() => {
    if (toastPending && live && data.isSuccess && !data.isFetching && (!canCompare || (prev.isSuccess && !prev.isFetching))) { setToastPending(false); toast("Chart recomputed"); }
  }, [toastPending, live, data.isSuccess, data.isFetching, canCompare, prev.isSuccess, prev.isFetching, toast]);
  const askAi = () => {
    const params = Object.fromEntries(query.entries());
    const label = def.display_name;
    nav(`/projects/${pid}/ai`, { state: { draft: { text: `@${label} What stands out in this chart for ${start} to ${end}, and why?`, mentions: [{ type: "chart", id: def.name, label, detail: "Chart", params }] } } });
  };
  const describe = [`${start} to ${end}`, RESOLUTIONS.find(([v]) => v === resolution)?.[1].toLowerCase() ?? resolution, filters.length ? `${filters.length} filter${filters.length > 1 ? "s" : ""}` : null, segment ? `by ${segment.replace(/_/g, " ")}` : null, env === "sandbox" ? "sandbox data" : null, cohortTable ? null : CHART_TYPE_LABEL[chartType].toLowerCase()].filter(Boolean).join(", ");
  const addAt = (from: string, to: string) => { setEditing({ start_date: from, end_date: to }); };
  const tabBar = (
    <Tabs label="Chart details" idBase="ctab" value={tab} onChange={(v) => set({ tab: v === tabs[0] ? null : v })}
      tabs={tabs.map((t) => ({ value: t, label: t === "summary" ? "Summary" : t === "customers" ? "Customers" : `Annotations${annotations.data?.length ? ` (${annotations.data.length})` : ""}` }))} />
  );
  const tabBody = tab === "customers" ? <CustomersTab pid={pid} chart={def.name} query={query.toString()} format={(unit) => formatter(unit, currency, 2)} />
    : tab === "annotations" ? <AnnotationsTab pid={pid} items={annotations.data} loading={annotations.isLoading} canWrite={canWrite} highlight={highlight} onNew={() => addAt(end < iso(today) ? end : iso(today), end < iso(today) ? end : iso(today))} onEdit={(a) => setEditing(a)} />
    : null;
  return (
    <Shell title={def.display_name} crumbs={<><Link to={`/projects/${pid}/charts`}>Charts</Link> <span className="crumb-sep">/</span> <b>{def.display_name}</b></>}>
      <div className="charts">
        <ChartRail pid={pid} current={def.name} savedId={savedId} />
        <div className="page cpage">
          <div className="head">
            <div><h1>{savedNow ? savedNow.name : def.display_name}</h1><p>{savedNow ? <><Tag>Saved</Tag> {def.display_name}. </> : null}{def.description}</p></div>
            <div className="actions">
              {!cohortTable && <Switch checked={compare} onChange={(v) => set({ cmp: v ? "1" : null })} label="Compare to previous period" />}
              <Switch checked={env === "sandbox"} onChange={(v) => set({ env: v ? "sandbox" : null, environment: null })} label="Sandbox data" />
              <button type="button" className="btn btn-line" onClick={refresh} disabled={data.isFetching} title={body ? `Computed ${new Date(body.last_computed_at).toLocaleTimeString()}` : undefined}><Icon name="refresh" />Refresh</button>
              <button type="button" className="btn btn-line" onClick={() => setSaving(true)}><Icon name="plus" />Save</button>
              <button type="button" className="btn btn-line" onClick={askAi}><Icon name="spark" className="i gold" />Ask AI</button>
              <Menu label="More chart actions" items={[
                { label: "Export CSV", icon: "download", disabled: !body, onSelect: () => body && downloadCsv(`${def.name}-${start}-${end}`, csvRows(body)) },
                { label: "Share preview", icon: "link", onSelect: () => setSharing(true) },
              ]} />
            </div>
          </div>
          <PlanSlot onSandbox={() => set({ env: "sandbox", environment: null })} />
          <div className="ctools" role="group" aria-label="Chart controls">
            <Segmented label="Date range" value={range} options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
              onChange={(v) => set({ range: v === (cohortTable ? "12m" : "30d") ? null : v, start: v === "custom" ? start : null, end: v === "custom" ? end : null, res: null })} />
            {range === "custom" && <>
              <DateField className="dt" label="Start date" value={start} max={end} onChange={(v) => set({ start: v })} />
              <span className="subtle">to</span>
              <DateField className="dt" label="End date" value={end} min={start} onChange={(v) => set({ end: v })} />
            </>}
            <select className="select sm" aria-label="Resolution" value={resolution} onChange={(e) => set({ res: e.target.value })}>
              {RESOLUTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {!cohortTable && (
              <select className="select sm ctype" aria-label="Chart type" value={chartType} title={seriesCount < 2 ? "Segment the chart to stack it" : undefined}
                onChange={(e) => set({ type: e.target.value === defaultChartType(def, segmented) ? null : e.target.value })}>
                {CHART_TYPES.map((t) => <option key={t} value={t} disabled={isStackedType(t) && seriesCount < 2}>{CHART_TYPE_LABEL[t]}</option>)}
              </select>
            )}
            <FilterMenu options={options.data?.filters ?? []} value={filters} onChange={(f) => set({ filters: f.length ? JSON.stringify(f) : null })} />
            {def.segmentable && (options.data?.segments.length ?? 0) > 0 && (
              <select className="select sm" aria-label="Segment" value={segment} onChange={(e) => set({ segment: e.target.value || null })}>
                <option value="">No segment</option>
                {/* Grouped as the API groups them: store and product, customer, attribution … */}
                {[...new Set(options.data!.segments.map((s) => s.group_display_name ?? ""))].map((g) => (
                  <optgroup key={g} label={g || "Segments"}>
                    {options.data!.segments.filter((s) => (s.group_display_name ?? "") === g).map((s) => <option key={s.id} value={s.id}>By {s.display_name.toLowerCase()}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
            {def.selectors.map((s) => (
              <select key={s.id} className="select sm" aria-label={s.display_name} value={selectors[s.id] ?? s.default}
                onChange={(e) => set({ sel: JSON.stringify({ ...selectors, [s.id]: e.target.value }) })}>
                {s.options.map((o) => <option key={o.id} value={o.id}>{s.display_name}: {o.display_name}</option>)}
              </select>
            ))}
          </div>
          {filters.length > 0 && (
            <div className="chips" aria-label="Active filters">
              {filters.map((f) => {
                const o = options.data?.filters.find((x) => x.id === f.name);
                const names = f.values.map((v) => o?.options.find((x) => x.id === v)?.display_name ?? (v || "Unknown"));
                return <span key={f.name} className="chip">{o?.display_name ?? f.name}: {names.join(", ")}<button type="button" aria-label={`Remove ${o?.display_name ?? f.name} filter`} onClick={() => set({ filters: JSON.stringify(filters.filter((x) => x.name !== f.name)) === "[]" ? null : JSON.stringify(filters.filter((x) => x.name !== f.name)) })}><Icon name="close" /></button></span>;
              })}
            </div>
          )}
          {env === "sandbox" && <div className="banner"><Tag tone="info">Sandbox</Tag><span>Showing sandbox and Test Store purchases only. Customer counts include every customer.</span></div>}
          {data.isError ? (
            <div className="banner err" role="alert"><span style={{ flex: 1 }}>Could not load the chart: {data.error instanceof Error ? data.error.message : "unknown error"}.</span><button type="button" className="btn btn-line" onClick={() => data.refetch()}>Retry</button></div>
          ) : !body ? (
            <section className="panel cpanel" aria-busy="true"><div className="sk" style={{ height: 300, margin: 16 }} /></section>
          ) : body.periods ? (
            <>
              <CohortTable body={body} />
              <section className="panel ctabs" aria-label={`${def.display_name} details`}>{tabBar}{tabBody}</section>
            </>
          ) : (
            <SeriesChart def={def} body={body} currency={currency} fetching={data.isFetching || (canCompare && prev.isFetching)} prev={canCompare ? prev.data ?? null : null}
              groups={groups} gi={gi} onPick={(i) => set({ m: i ? String(i) : null })} kind={chartType}
              annotations={annotations.data ?? []} onAnnotation={(id) => { setHighlight(id); set({ tab: "annotations" }); }}
              onAdd={canWrite ? addAt : undefined} tabBar={tabBar} tabBody={tabBody} />
          )}
          {def.name === "app_store_save_outcomes" && <p className="fn">RevenueDot does not use Apple's Retention Messaging API yet, so this chart stays at zero.</p>}
          <p className="fn">{body && <>Computed {new Date(body.last_computed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · </>}<a className="ul" href={`https://revenuedot.app/docs/guides/charts#${def.name}`} target="_blank" rel="noreferrer">How {def.display_name} is calculated →</a></p>
        </div>
      </div>
      {saving && <SaveChartDialog pid={pid} chart={def} initial={savedNow?.name ?? def.display_name} existing={savedNow} view={view()} onClose={() => setSaving(false)} onSaved={(s) => setSp(new URLSearchParams(savedHref(pid, s).split("?")[1]), { replace: true })} />}
      {sharing && <ShareDialog pid={pid} chart={def.name} title={def.display_name} view={view()} describe={describe} canWrite={canWrite} onClose={() => setSharing(false)} />}
      {editing && <AnnotationDialog pid={pid} initial={editing} onClose={() => setEditing(null)} />}
    </Shell>
  );
}

/** Time series: the measure picker, summary values, legend, plot with annotations, then the tabs (Summary is the table). */
function SeriesChart({ def, body, currency, fetching, prev, groups, gi, onPick, kind, annotations, onAnnotation, onAdd, tabBar, tabBody }: {
  def: ChartDef; body: ChartData; currency: string; fetching: boolean; prev?: ChartData | null; groups: number[][]; gi: number; onPick: (i: number) => void; kind: ChartType;
  annotations: Annotation[]; onAnnotation: (id: string) => void; onAdd?: (from: string, to: string) => void; tabBar: ReactNode; tabBody: ReactNode;
}) {
  const starts = useMemo(() => [...new Set(body.values.map((v) => v.cohort))].sort((a, b) => a - b), [body]);
  const incomplete = useMemo(() => { const inc = new Set(body.values.filter((v) => v.incomplete).map((v) => v.cohort)); return starts.map((s) => inc.has(s)); }, [body, starts]);
  const periods = starts.map((s, i) => ({ start: s * 1000, ...periodLabels(s * 1000, body.resolution), incomplete: incomplete[i]! }));
  // Never two y axes: chartable measures are grouped by unit and one group is plotted at a time. A segmented chart
  // plots one measure, split by segment.
  const segmented = !!body.segments;
  const group = groups[gi] ?? [];
  const sel = group[0] ?? 0;
  const lookup = useMemo(() => valueIndex(body), [body]);
  const at = (seg: number | undefined, measure: number) => starts.map((s) => lookup(s, { segment: seg, measure })?.value ?? null);
  let series: Series[];
  if (segmented) series = body.segments!.map((s, i) => ({ key: `s${i}`, label: s.display_name, values: at(i, sel), other: s.is_other })).filter((_, i) => !body.segments![i]!.is_total);
  else series = group.map((i) => ({ key: `m${i}`, label: body.measures[i]!.display_name, values: at(undefined, i) }));
  const oneAtATime = groups.length > 1;
  const unit = body.measures[sel]?.unit ?? "#";
  const fmt = (m: Measure) => formatter(m.unit, currency, m.decimal_precision);
  const plotFmt = formatter(unit, currency, body.measures[sel]?.decimal_precision ?? 2);
  // Table rows: every tabulable measure, or each segment of the plotted measure.
  const rows: { key: string; label: string; color?: string; values: (number | null)[]; format: (v: number | null) => string }[] = segmented
    ? body.segments!.map((s, i) => ({ key: `s${i}`, label: s.display_name, color: s.is_total ? undefined : seriesColor(i, { key: "", label: "", values: [], other: s.is_other }), values: at(i, sel), format: plotFmt }))
    : body.measures.map((m, j) => ({ key: `m${j}`, label: m.display_name, color: series.length > 1 ? (() => { const k = series.findIndex((s) => s.key === `m${j}`); return k >= 0 ? seriesColor(k, series[k]!) : undefined; })() : undefined, values: at(undefined, j), format: fmt(m) }));
  const total = body.summary?.total ?? {};
  const totalSeg = segmented ? body.segments!.findIndex((s) => s.is_total) : -1;
  const avg = body.summary?.average ?? {};
  // The previous period of the plotted measure, by position (segmented charts compare their total).
  const prevStarts = prev ? [...new Set(prev.values.map((v) => v.cohort))].sort((a, b) => a - b) : [];
  const prevLookup = prev ? valueIndex(prev) : null;
  const prevAt = (measure: number) => {
    if (!prev || !prevLookup) return null;
    const totalSeg = prev.segments ? prev.segments.findIndex((x) => x.is_total) : -1;
    return starts.map((_, i) => {
      const c = prevStarts[i];
      if (c === undefined) return null;
      if (!prev.segments) return prevLookup(c, { measure })?.value ?? null;
      if (totalSeg >= 0) return prevLookup(c, { segment: totalSeg, measure })?.value ?? null;
      const vals = prev.segments.map((_, si) => prevLookup(c, { segment: si, measure })?.value).filter((x): x is number => typeof x === "number");
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    });
  };
  const compareValues = prev ? prevAt(sel) : null;
  const prevStat = (m: Measure, kind: "latest" | "total" | "average") => {
    if (!prev) return null;
    const j = prev.measures.findIndex((x) => x.id === m.id);
    if (j < 0) return null;
    if (kind === "latest") return [...(prevAt(j) ?? [])].reverse().find((x) => x !== null) ?? null;
    return (kind === "total" ? prev.summary?.total : prev.summary?.average)?.[m.display_name] ?? null;
  };
  // Annotations by period: the period that holds each day (periods are UTC buckets of the chart's resolution).
  const res = body.resolution as Resolution;
  const ends = periods.map((p) => addPeriods(p.start, res));
  const indexOf = (day: string) => { const t = Date.parse(`${day}T00:00:00Z`); let k = -1; periods.forEach((p, i) => { if (p.start <= t) k = i; }); return t >= (ends[ends.length - 1] ?? 0) ? periods.length : k; };
  const plotNotes: PlotAnnotation[] = annotations.map((a) => ({ id: a.id, title: a.title, when: whenText(a), from: indexOf(a.start_date), to: indexOf(a.end_date) }))
    .map((a) => ({ ...a, from: Math.max(0, a.from), to: Math.min(periods.length - 1, a.to) })).filter((a) => a.to >= 0 && a.from <= a.to && a.from < periods.length);
  const add = onAdd ? (from: number, to: number) => {
    // The days of the periods drawn, clipped to the range of the data drawn (body's, not the page's: while a new range
    // loads, the plot still shows the previous answer).
    if (!periods[from] || ends[to] === undefined) return;
    const s = iso(Math.max(periods[from]!.start, body.start_date));
    const e = iso(Math.min(ends[to]! - DAY, body.end_date));
    onAdd(s, e < s ? s : e);
  } : undefined;
  return (
    <section className={`panel cpanel${fetching ? " busy" : ""}`} aria-label={`${def.display_name} chart`}>
      {oneAtATime && (
        <div className="cmeasure"><Segmented label="Measure" value={String(gi)} options={groups.map((g, i) => ({ value: String(i), label: groupLabel(body.measures, g) }))} onChange={(v) => onPick(Number(v))} /></div>
      )}
      <div className="cstats">
        {body.measures.filter((m) => m.tabulable).slice(0, 4).map((m) => {
          // Snapshots show the latest value, flows their total, rates their average.
          const j = body.measures.indexOf(m);
          // A segmented chart's latest value is its Total segment's (values carry a segment index there).
          const latest = def.shape === "stock" ? [...at(totalSeg >= 0 ? totalSeg : undefined, j)].reverse().find((x) => x !== null) ?? null : null;
          const kind = def.shape === "stock" ? "latest" : m.display_name in total && m.unit !== "%" ? "total" : "average";
          const v = kind === "latest" ? latest : kind === "total" ? total[m.display_name] ?? null : avg[m.display_name] ?? null;
          const pv = prevStat(m, kind);
          const delta = prev && v !== null && pv !== null && pv !== 0 ? ((v - pv) / Math.abs(pv)) * 100 : null;
          return (
            <div key={m.id}><span className="label">{m.display_name} · {kind}</span><b>{fmt(m)(v)}</b>
              {prev && <span className="cdelta" data-testid="compare-delta"><span className={delta === null ? "subtle" : delta >= 0 ? "up" : "down"}>{delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`}</span> vs {fmt(m)(pv)}</span>}
            </div>
          );
        })}
      </div>
      <Legend series={series} />
      {compareValues && kind !== "percent_column" && <ul className="legend" aria-label="Comparison"><li><i style={{ background: "transparent", border: "1px dashed var(--fg-3)" }} />Previous period · {body.measures[sel]?.display_name}</li></ul>}
      <Plot periods={periods} series={series} kind={kind} integer={unit === "#" && series.every((x) => x.values.every((v) => v === null || Number.isInteger(v)))} format={plotFmt} formatTick={tickFormatter(unit, currency)}
        compare={compareValues ? { label: "Previous period", values: compareValues } : null} annotations={plotNotes} onAnnotation={onAnnotation} onAddAnnotation={add}
        ariaLabel={`${def.display_name}: ${series.map((s) => s.label).join(", ")} by ${body.resolution}, drawn as ${CHART_TYPE_LABEL[kind].toLowerCase()}. Values are in the table below.`} />
      {tabBar}
      {tabBody ?? (
        <>
          <div className="tbl ctable" data-scroll="x">
            <table className="compact">
              <thead><tr><th scope="col">{segmented ? body.measures[sel]?.display_name : "Measure"}</th>{periods.map((p) => <th key={p.start} scope="col" className="amt" title={p.long}>{p.label}{p.incomplete ? "*" : ""}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{r.color && <i className="key" style={{ background: r.color }} />}{r.label}</th>
                    {r.values.map((v, i) => <td key={i} className={`amt${periods[i]?.incomplete ? " inc" : ""}`}>{r.format(v)}</td>)}
                  </tr>
                ))}
                {compareValues && (
                  <tr className="cprev">
                    <th scope="row">Previous period</th>
                    {compareValues.map((v, i) => <td key={i} className="amt subtle">{plotFmt(v)}</td>)}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {periods.some((p) => p.incomplete) && <div className="pfoot"><span>* Incomplete period: the data can still change.</span></div>}
        </>
      )}
    </section>
  );
}

function SaveChartDialog({ pid, chart, initial, existing, view, onClose, onSaved }: { pid: string; chart: ChartDef; initial: string; existing: SavedChart | null; view: Record<string, string | boolean>; onClose: () => void; onSaved: (s: SavedChart) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async (update: boolean) => {
    if (!name.trim()) { setErr("Name the chart."); return; }
    setBusy(true); setErr(null);
    try {
      const s = update && existing
        ? await api<SavedChart>(`/v2/projects/${pid}/saved_charts/${existing.id}`, { method: "PATCH", json: { name: name.trim(), view } })
        : await api<SavedChart>(`/v2/projects/${pid}/saved_charts`, { method: "POST", json: { name: name.trim(), chart_name: chart.name, view } });
      await qc.invalidateQueries({ queryKey: ["saved-charts", pid] });
      toast(update ? "Saved chart updated" : "Chart saved"); onSaved(s); onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return (
    <Dialog title={existing ? "Save chart" : "Save this chart"} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      {existing && <button type="button" className="btn btn-line" disabled={busy} onClick={() => go(false)}>Save as new</button>}
      <button type="button" className="btn btn-dark" disabled={busy} onClick={() => go(!!existing)}>{busy ? "Saving…" : existing ? "Update" : "Save"}</button>
    </>}>
      <Field label="Name" htmlFor="sc-name" hint={`${chart.display_name}, with the current range, resolution, segment, filters${view.compare ? " and comparison" : ""}.`}>
        <input id="sc-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(!!existing); }} />
      </Field>
      {err && <div className="banner err" role="alert">{err}</div>}
    </Dialog>
  );
}

function CohortTable({ body }: { body: ChartData }) {
  const periods = body.periods!;
  const cohorts = [...new Set(body.values.map((v) => v.cohort))].sort((a, b) => a - b);
  const lookup = useMemo(() => valueIndex(body), [body]);
  const cell = (c: number, k: number) => lookup(c, { period: k });
  const vals = body.values.filter((v) => (v.period ?? 0) > 0 && v.value !== null).map((v) => v.value as number);
  const max = vals.reduce((a, b) => Math.max(a, b), 0);
  const predicted = body.values.some((v) => v.predicted);
  return (
    <section className="panel cpanel" aria-label={`${body.display_name} table`}>
      <div className="tbl cohort">
        <table className="compact">
          <thead><tr><th scope="col">Cohort</th>{periods.map((p, k) => <th key={k} scope="col" className="amt">{p.display_name}</th>)}</tr></thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c}>
                <th scope="row">{periodLabels(c * 1000, body.resolution).long}</th>
                {periods.map((p, k) => {
                  const v = cell(c, k);
                  const f = formatter(p.unit ?? "#", body.yaxis_currency, p.decimal_precision ?? 2);
                  const shade = k > 0 && v?.value !== null && v?.value !== undefined && max > 0 ? 0.04 + 0.32 * (v.value / max) : 0;
                  return <td key={k} className={`amt${v?.incomplete ? " inc" : ""}${v?.predicted ? " pred" : ""}`} style={shade ? { background: `color-mix(in srgb, var(--fg) ${(shade * 100).toFixed(0)}%, var(--panel))` } : undefined}
                    title={v?.predicted ? "Predicted" : v?.incomplete ? "Incomplete: the cohort has not finished this period" : undefined}>{v?.value === null || !v ? "" : f(v.value)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pfoot"><span>{predicted ? "Italic values are predicted. " : ""}Underlined values are incomplete: the cohort has not finished that period.</span></div>
    </section>
  );
}

function csvRows(body: ChartData): (string | number | null)[][] {
  const day = (s: number) => iso(s * 1000);
  // Money columns in another display currency name it ("MRR (EUR)"); USD exports keep their plain headers.
  const head = (m: Measure) => (m.unit === "$" && body.yaxis_currency !== "USD" ? `${m.display_name} (${body.yaxis_currency})` : m.display_name);
  const lookup = valueIndex(body);
  if (body.periods) {
    const cohorts = [...new Set(body.values.map((v) => v.cohort))].sort((a, b) => a - b);
    return [["cohort", ...body.periods.map((p) => p.display_name)], ...cohorts.map((c) => [day(c), ...body.periods!.map((_, k) => lookup(c, { period: k })?.value ?? null)])];
  }
  const starts = [...new Set(body.values.map((v) => v.cohort))].sort((a, b) => a - b);
  if (body.segments) {
    const cols = body.segments.flatMap((s, i) => body.measures.map((m, j) => ({ name: `${s.display_name} · ${head(m)}`, i, j })));
    return [["period", ...cols.map((c) => c.name)], ...starts.map((s) => [day(s), ...cols.map((c) => lookup(s, { segment: c.i, measure: c.j })?.value ?? null)])];
  }
  return [["period", ...body.measures.map(head), "incomplete"], ...starts.map((s) => [day(s), ...body.measures.map((_, j) => lookup(s, { measure: j })?.value ?? null), body.measures.some((_, j) => lookup(s, { measure: j })?.incomplete) ? "true" : "false"])];
}

