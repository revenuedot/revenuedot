/**
 * One experiment (prd/experiments/PRD.md §5): /projects/:projectId/experiments/:experimentId. Status and actions (start,
 * pause, resume, stop, edit, duplicate, delete), the setup, the notes, and results: environment and filters, the
 * guidance, every metric per variant with its 95% interval, lift and chance to beat the control, a daily chart per
 * metric with its table, and CSV exports.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EXPERIMENT_METRICS } from "@revenuedot/core";
import { api, fmt } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, Disclosure, KeyValue, Menu, PageHead, Panel, Tag, useProjectId, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { describeRules } from "../../components/conditions";
import { errMsg, v2 } from "../catalog/lib";
import { Legend, Plot, type Series } from "../charts/plot";
import { Markdown } from "./Markdown";
import { formatMetric, metric, pct0, signedPct, STATUS_TONE, statusLabel, typeName, useAudiences, useOfferingsFull, type Experiment, type Results, type VariantResult } from "./lib";

export function ExperimentDetail() {
  const pid = useProjectId();
  const { experimentId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const x = useQuery({ queryKey: ["experiment", pid, experimentId], queryFn: () => api<Experiment>(`${v2(pid)}/experiments/${experimentId}`) });
  const offs = useOfferingsFull(pid);
  const auds = useAudiences(pid);
  const [confirm, setConfirm] = useState<ReactNode>(null);
  const e = x.data;
  const offName = (id: string | null) => (id ? offs.data?.find((o) => o.id === id)?.lookup_key ?? `${id} (deleted)` : "—");
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["experiment", pid, experimentId] }), qc.invalidateQueries({ queryKey: ["experiments", pid] }), qc.invalidateQueries({ queryKey: ["experiment-results", pid, experimentId] })]);
  const act = async (action: "start" | "pause" | "stop") => {
    try {
      await api(`${v2(pid)}/experiments/${experimentId}/actions/${action}`, { method: "POST" });
      await refresh();
      toast(action === "start" ? (e?.status === "paused" ? "Resumed: new customers join again" : "Experiment running: customers join from their next offerings request") : action === "pause" ? "Paused: nobody new joins; enrolled customers keep their variant" : "Experiment stopped");
    } catch (err) { toast(errMsg(err)); }
  };
  const duplicate = async () => {
    if (!e) return;
    try {
      const copy = await api<Experiment>(`${v2(pid)}/experiments`, { method: "POST", json: {
        name: `${e.name} (copy)`.slice(0, 256), type: e.type, primary_metric: e.primary_metric, secondary_metrics: e.secondary_metrics, notes: e.notes, enrollment: e.enrollment,
        track_paywall_views: e.track_paywall_views, audience_id: e.audience_id, audience_rules: e.audience_rules, enrollment_percent: e.enrollment_percent,
        variants: e.variants.map((v) => ({ name: v.name, offering_id: v.offering_id, placements: v.placements })),
      } });
      await qc.invalidateQueries({ queryKey: ["experiments", pid] });
      toast("Copied as a new draft");
      nav(`/projects/${pid}/experiments/${copy.id}/edit`);
    } catch (err) { toast(errMsg(err)); }
  };
  const audience = e ? (e.audience_rules ? describeRules(e.audience_rules) : e.audience_id ? auds.data?.find((a) => a.id === e.audience_id)?.name ?? e.audience_id : "Everyone") : "";
  const actions = e && (
    <div className="xp-row">
      {(e.status === "draft" || e.status === "paused") && <button type="button" className="btn btn-dark" onClick={() => void act("start")}>{e.status === "draft" ? "Start" : "Resume"}</button>}
      {e.status === "running" && <button type="button" className="btn btn-line" onClick={() => void act("pause")}>Pause</button>}
      {(e.status === "running" || e.status === "paused") && <button type="button" className="btn btn-line" onClick={() => setConfirm(
        <ConfirmDialog title="Stop this experiment?" confirmLabel="Stop experiment" danger onClose={() => setConfirm(null)} onConfirm={() => act("stop")}>
          <p>Enrolled customers get the usual offering on their next request. Results keep updating, but a stopped experiment cannot run again.</p>
        </ConfirmDialog>)}>Stop</button>}
      <Menu label="More actions" items={[
        { label: "Edit", icon: "edit", onSelect: () => nav(`/projects/${pid}/experiments/${experimentId}/edit`) },
        { label: "Duplicate as a draft", icon: "duplicate", onSelect: () => void duplicate() },
        "-",
        { label: "Delete", icon: "trash", danger: true, disabled: e.status === "running", hint: e.status === "running" ? "Stop it first" : undefined, onSelect: () => setConfirm(
          <ConfirmDialog title="Delete this experiment?" confirmLabel="Delete" danger onClose={() => setConfirm(null)} onConfirm={async () => { await api(`${v2(pid)}/experiments/${experimentId}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["experiments", pid] }); nav(`/projects/${pid}/experiments`); }}>
            <p>Its enrollments and results are deleted. Customers in it go back to the usual offering.</p>
          </ConfirmDialog>) },
      ]} />
    </div>
  );
  return (
    <Shell title={e?.name ?? "Experiment"} crumbs={<><Link className="cat-crumb-up" to={`/projects/${pid}/experiments`}>Experiments</Link> <span className="cat-crumb-up">/</span> <b className="cat-crumb">{e?.name ?? ""}</b></>}>
      <div className="page">
        {x.isError ? <div className="banner err" role="alert">{errMsg(x.error)}</div> : !e ? <div className="panel pb subtle">Loading…</div> : (
          <>
            <PageHead title={e.name} sub={<><Tag tone={STATUS_TONE[e.status]}>{statusLabel(e.status)}</Tag> <span className="subtle">{typeName(e.type)} · priority {e.priority} · {fmt.int(e.enrolled_customers ?? 0)} customers enrolled</span></>} actions={actions} />
            <div className="two xp-top">
              <Panel title="Setup">
                <KeyValue rows={[
                  ["Primary metric", metric(e.primary_metric).name],
                  ["Secondary metrics", e.secondary_metrics.length ? e.secondary_metrics.map((m) => metric(m).name).join(", ") : "None"],
                  ["Who can join", `${e.enrollment === "new" ? "New customers" : "New and existing customers"}, ${e.enrollment_percent}% of the audience`],
                  ["Audience", audience],
                  ["Paywall views", e.track_paywall_views ? "Tracked" : "Not tracked"],
                  ["Dates", e.started_at ? `Started ${fmt.dateTime(e.started_at)}${e.paused_at ? `, paused ${fmt.dateTime(e.paused_at)}` : ""}${e.stopped_at ? `, stopped ${fmt.dateTime(e.stopped_at)}` : ""}` : `Created ${fmt.dateTime(e.created_at)}, not started`],
                ]} />
              </Panel>
              <Panel title="Variants" flush>
                <ul className="xp-vlist">
                  {e.variants.map((v, i) => (
                    <li key={v.id}><i className="key" style={{ background: `var(--series-${i + 1})` }} /><b>{v.id.toUpperCase()} · {v.name}</b><code>{offName(v.offering_id)}</code>
                      {Object.entries(v.placements).map(([k, o]) => <small key={k}><code>{k}</code> → {o ? <code>{offName(o)}</code> : "no paywall"}</small>)}</li>
                  ))}
                </ul>
              </Panel>
            </div>
            {e.notes.trim() && <Panel title="Notes"><Markdown text={e.notes} /></Panel>}
            {e.status === "draft" ? (
              <div className="banner" role="status"><Icon name="experiments" /><span>Results appear once the experiment starts and customers join. <Link className="ul" to={`/projects/${pid}/experiments/${e.id}/edit`}>Review the setup</Link> or start it.</span></div>
            ) : <ResultsPanel pid={pid} e={e} />}
          </>
        )}
      </div>
      {confirm}
    </Shell>
  );
}

function ResultsPanel({ pid, e }: { pid: string; e: Experiment }) {
  const [env, setEnv] = useState<"production" | "sandbox">("production");
  const [platform, setPlatform] = useState("");
  const [country, setCountry] = useState("");
  const [paywall, setPaywall] = useState<"" | "all" | "viewed" | "not_viewed">("");
  const query = new URLSearchParams({ environment: env, ...(platform ? { platform } : {}), ...(country ? { country } : {}), ...(paywall ? { paywall } : {}) }).toString();
  const res = useQuery({ queryKey: ["experiment-results", pid, e.id, query], queryFn: () => api<Results>(`${v2(pid)}/experiments/${e.id}/results?${query}`), placeholderData: (p) => p });
  const r = res.data;
  const shown = useMemo(() => [e.primary_metric, ...e.secondary_metrics.filter((m) => m !== e.primary_metric)], [e]);
  const rest = EXPERIMENT_METRICS.map((m) => m.id).filter((m) => !shown.includes(m));
  const [chartMetric, setChartMetric] = useState(e.primary_metric);
  const variants = r?.variants.items ?? [];
  const exportUrl = (kind: "summary" | "daily") => `${v2(pid)}/experiments/${e.id}/results/export?kind=${kind}&${query}`;
  const g = r?.guidance;
  const tone = !g ? "" : g.leader && g.enough_data && g.leader.chance_to_beat_control >= 0.95 ? "ok" : g.enough_data ? "" : "warn";

  return (
    <section className="panel" aria-labelledby="xp-results">
      <div className="ph"><b id="xp-results">Results</b>
        <span className="link xp-tools">
          <Menu label="Export CSV" text="Export CSV" icon="download" items={[
            { label: "Summary per variant (CSV)", icon: "download", onSelect: () => { window.location.href = exportUrl("summary"); } },
            { label: "Every metric by day (CSV)", icon: "download", onSelect: () => { window.location.href = exportUrl("daily"); } },
          ]} />
        </span>
      </div>
      <div className="xp-filters">
        <label><span className="label">Environment</span><select aria-label="Environment" className="select" value={env} onChange={(ev) => setEnv(ev.target.value as typeof env)}><option value="production">Production</option><option value="sandbox">Sandbox</option></select></label>
        <label><span className="label">Platform</span><select aria-label="Platform" className="select" value={platform} onChange={(ev) => setPlatform(ev.target.value)}><option value="">All platforms</option>{(r?.filter_options.platforms ?? []).map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label><span className="label">Country</span><select aria-label="Country" className="select" value={country} onChange={(ev) => setCountry(ev.target.value)}><option value="">All countries</option>{(r?.filter_options.countries ?? []).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label><span className="label">Paywall</span><select aria-label="Paywall views" className="select" value={paywall || r?.filters.paywall || "all"} onChange={(ev) => setPaywall(ev.target.value as typeof paywall)}>
          <option value="all">All customers</option><option value="viewed">Viewed a paywall</option><option value="not_viewed">Did not view a paywall</option></select></label>
        {res.isFetching && <span className="subtle">Updating…</span>}
      </div>
      {res.isError ? <div className="pb"><div className="banner err" role="alert">{errMsg(res.error)}</div></div> : !r ? <div className="pb subtle">Loading…</div> : (
        <>
          <div className="pb xp-stack">
            <div className={`banner ${tone}`} role="status" data-testid="xp-guidance"><Icon name={tone === "ok" ? "check" : "hourglass"} /><span>{g!.message}</span></div>
            <div className="kpis xp-kpis" style={{ gridTemplateColumns: `repeat(${variants.length}, minmax(0, 1fr))` }}>
              {variants.map((v, i) => (
                <div key={v.id} className="kpi">
                  <div className="lab"><span><i className="key" style={{ background: `var(--series-${i + 1})` }} /> {v.id.toUpperCase()} · {v.name}</span></div>
                  <div className="v">{fmt.int(v.customers)}</div>
                  <div className="meta">customers{e.track_paywall_views ? ` · ${fmt.int(v.paywall_viewers)} viewed a paywall` : ""} · <code>{v.offering_id ?? "—"}</code></div>
                </div>
              ))}
            </div>
          </div>
          <MetricTable ids={shown} variants={variants} primary={e.primary_metric} control={r.control_variant_id} />
          <div className="pb">
            <Disclosure title="All metrics" sub={`${rest.length} more: counts, totals and the other rates`}>
              <MetricTable ids={rest} variants={variants} primary={e.primary_metric} control={r.control_variant_id} />
            </Disclosure>
          </div>
          <SeriesChart r={r} metricId={chartMetric} onMetric={setChartMetric} />
        </>
      )}
    </section>
  );
}

function MetricTable({ ids, variants, primary, control }: { ids: string[]; variants: VariantResult[]; primary: string; control: string }) {
  return (
    <div className="tbl xp-mt">
      <table>
        <thead><tr><th>Metric</th>{variants.map((v) => <th key={v.id}>{v.id.toUpperCase()} · {v.name}</th>)}</tr></thead>
        <tbody>
          {ids.map((id) => {
            const m = metric(id);
            return (
              <tr key={id} data-metric={id}>
                <th scope="row"><b>{m.name}</b>{id === primary && <> <Tag tone="gold">Primary</Tag></>}<small>{m.description}</small></th>
                {variants.map((v) => {
                  const x = v.metrics[id];
                  const good = (n: number | null | undefined) => (n === null || n === undefined ? "" : (m.better === "higher" ? n > 0 : n < 0) ? "up" : n === 0 ? "" : "down");
                  return (
                    <td key={v.id}>
                      <span className="xp-val">{formatMetric(id, x?.value)}</span>
                      {x?.lower !== undefined && x?.lower !== null && <small className="mono">95%: {formatMetric(id, x.lower)} to {formatMetric(id, x.upper)}</small>}
                      {(m.kind === "rate") && x?.denominator !== undefined && <small className="mono">{fmt.int(x.numerator)} of {fmt.int(x.denominator)}</small>}
                      {v.id !== control && x?.chance_to_beat_control !== undefined && (
                        <>
                          <small className={`mono ${good(x.lift)}`}>Lift {signedPct(x.lift)}{x.lift_lower !== null && x.lift_lower !== undefined ? ` (${signedPct(x.lift_lower)} to ${signedPct(x.lift_upper)})` : ""}</small>
                          <small className="mono"><b>{pct0(x.chance_to_beat_control)}</b> chance to beat the control</small>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SeriesChart({ r, metricId, onMetric }: { r: Results; metricId: string; onMetric: (m: string) => void }) {
  const variants = r.variants.items;
  const m = metric(metricId);
  const periods = r.series.days.map((d, i) => {
    const date = new Date(d);
    return { start: d, label: date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), long: date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }), incomplete: i === r.series.days.length - 1 };
  });
  const series: Series[] = variants.map((v) => ({ key: v.id, label: `${v.id.toUpperCase()} · ${v.name}`, values: r.series.values[metricId]?.[v.id] ?? [] }));
  const tick = (v: number) => (m.unit === "%" ? `${Math.round(v * 100)}%` : m.unit === "$" ? `$${v >= 1000 ? `${Math.round(v / 100) / 10}k` : v.toFixed(v < 10 ? 2 : 0)}` : v.toLocaleString("en-US"));
  return (
    <div className="xp-chart">
      <div className="xp-chart-h">
        <b>Over time</b>
        <select aria-label="Chart metric" className="select" value={metricId} onChange={(e) => onMetric(e.target.value)}>
          {EXPERIMENT_METRICS.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <span className="subtle">Cumulative, as of the end of each day (UTC)</span>
      </div>
      {periods.length < 1 ? <p className="pb subtle">No days yet.</p> : (
        <>
          <Legend series={series} />
          <Plot periods={periods} series={series} kind="line" integer={m.unit === "#"} format={(v) => formatMetric(metricId, v)} formatTick={tick}
            ariaLabel={`${m.name} by day for ${series.map((s) => s.label).join(", ")}. Values are in the table below.`} />
          <Disclosure title="Daily values" sub={`${periods.length} day${periods.length === 1 ? "" : "s"}`}>
            <div className="tbl ctable">
              <table>
                <thead><tr><th>Day</th>{series.map((s) => <th key={s.key} className="amt">{s.label}</th>)}</tr></thead>
                <tbody>{periods.map((p, i) => <tr key={p.start}><td>{p.long}</td>{series.map((s) => <td key={s.key} className="amt mono">{formatMetric(metricId, s.values[i])}</td>)}</tr>).reverse()}</tbody>
              </table>
            </div>
          </Disclosure>
        </>
      )}
    </div>
  );
}
