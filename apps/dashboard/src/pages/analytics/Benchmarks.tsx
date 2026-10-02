import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell, useMe } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { aiBase, useAiStatus, type Conversation, type PendingMessage } from "../ai/data";
import "./analytics.css";

/**
 * Benchmarks (/projects/:projectId/benchmarks; prd/attribution-benchmarks-insights §2), RevenueDot Cloud only: the
 * project's last 12 months against the peer percentiles of apps that share anonymized data, by category, platform and
 * country. Sharing is off until an admin turns it on; only sharing projects see peers; a group needs 10 apps.
 */

interface MetricDef { id: string; display_name: string; description: string; unit: "%" | "$"; better: "higher" | "lower" | "neutral"; min_sample: number; sample_label: string; chart: { name: string; selectors?: Record<string, string> } | null }
interface Peers { projects: number; p10: number | null; p25: number; p50: number; p75: number; p90: number | null }
interface MetricRow { metric: string; value: number | null; sample: number; peers: Peers | null; percentile: number | null; standing: "top_quarter" | "above_median" | "below_median" | "bottom_quarter" | null; definition: MetricDef }
interface Category { id: string; display_name: string }
export interface Benchmarks {
  available: boolean; reason?: string;
  settings?: { share: boolean; category: string | null; shared_at: number | null };
  last_computed_at?: number | null; next_run_at?: number; k_anonymity?: number; window?: { start_date: string; end_date: string };
  categories?: Category[]; peer_group?: { category: string; platform: string; country: string; projects: number | null } | null;
  own_computed_at?: number | null; metrics?: MetricRow[]; opportunity?: string | null; options?: { countries: string[]; platforms: string[] } | null;
}

const PLATFORM_LABEL: Record<string, string> = { all: "All platforms", ios: "iOS", android: "Android" };
let regions: Intl.DisplayNames | null | undefined;
const countryName = (c: string) => { if (regions === undefined) { try { regions = new Intl.DisplayNames(["en"], { type: "region" }); } catch { regions = null; } } try { return regions?.of(c) ?? c; } catch { return c; } };
/** A YYYY-MM-DD day as it is in UTC ("Sep 30, 2026"), whatever the browser's time zone. */
const utcDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const utcTime = (ms: number) => `${new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${new Date(ms).toISOString().slice(11, 16)} UTC`;
const fmtValue = (v: number | null, unit: "%" | "$") => (v === null ? "—" : unit === "%" ? `${v.toFixed(1)}%` : fmt.usd(v, true));
const STAND: Record<NonNullable<MetricRow["standing"]>, { label: string; tone: "up" | "down" | "muted" }> = {
  top_quarter: { label: "Top quarter", tone: "up" }, above_median: { label: "Above median", tone: "muted" }, below_median: { label: "Below median", tone: "muted" }, bottom_quarter: { label: "Bottom quarter", tone: "down" },
};
const chartHref = (pid: string, d: MetricDef, w?: { start_date: string; end_date: string }) => {
  if (!d.chart) return null;
  const q = new URLSearchParams({ range: "custom", start: w?.start_date ?? "", end: w?.end_date ?? "", res: "month" });
  if (d.chart.selectors) q.set("sel", JSON.stringify(d.chart.selectors));
  return `/projects/${pid}/charts/${d.chart.name}?${q}`;
};

/** The hairline track: the 25th–75th band, the median tick, the 10th and 90th marks, and the project as the gold square. */
function Track({ peers, value, unit }: { peers: Peers; value: number | null; unit: "%" | "$" }) {
  const iqr = Math.max(peers.p75 - peers.p25, Math.abs(peers.p50) * 0.1, 0.01);
  let lo = Math.min(peers.p10 ?? peers.p25 - iqr * 0.75, value ?? Infinity);
  let hi = Math.max(peers.p90 ?? peers.p75 + iqr * 0.75, value ?? -Infinity);
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  lo = Math.max(0, lo);
  if (unit === "%") hi = Math.min(100, hi);
  const x = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo || 1)) * 100))}%`;
  return (
    <div>
      <div className="bm-track" role="img" aria-label={`Peers: 25th percentile ${fmtValue(peers.p25, unit)}, median ${fmtValue(peers.p50, unit)}, 75th ${fmtValue(peers.p75, unit)}${value !== null ? `; you ${fmtValue(value, unit)}` : ""}`}>
        <span className="rail" />
        {peers.p10 !== null && peers.p90 !== null && <span className="dec" style={{ left: x(peers.p10), width: `calc(${x(peers.p90)} - ${x(peers.p10)})` }} />}
        <span className="band" style={{ left: x(peers.p25), width: `calc(${x(peers.p75)} - ${x(peers.p25)})` }} />
        <span className="med" style={{ left: x(peers.p50) }} />
        {value !== null && <span className="you" style={{ left: x(value) }} />}
      </div>
      <div className="bm-scale"><span>{fmtValue(lo, unit)}</span><span>{fmtValue(hi, unit)}</span></div>
    </div>
  );
}

/** Sharing on or off and the category: on the Benchmarks page before sharing, and in Project settings → Benchmarks. */
export function BenchmarkSharing({ pid, compact }: { pid: string; compact?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = me.data?.projects.find((p) => p.id === pid)?.role === "admin";
  const s = useQuery({ queryKey: ["benchmark-settings", pid], enabled: !!pid, queryFn: () => api<{ available: boolean; share: boolean; category: string | null; shared_at: number | null }>(`/v2/projects/${pid}/benchmarks/settings`) });
  const cats = useQuery({ queryKey: ["benchmarks", pid, "categories"], enabled: !!pid, queryFn: () => api<Benchmarks>(`/v2/projects/${pid}/benchmarks`) });
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s.data?.category) setCategory(s.data.category); }, [s.data?.category]);
  if (!s.data) return s.isError ? <div className="banner err" role="alert">{(s.error as Error).message}</div> : <div className="panel pb" aria-busy="true"><span className="sk line" /></div>;
  if (!s.data.available) return <div className="banner" role="status">Benchmarks are a RevenueDot Cloud feature. A self-hosted server shares nothing.</div>;
  const save = async (share: boolean) => {
    if (share && !category) { toast("Pick your app's category first."); return; }
    setBusy(true);
    try {
      await api(`/v2/projects/${pid}/benchmarks/settings`, { method: "POST", json: { share, category: category || null } });
      await qc.invalidateQueries({ queryKey: ["benchmark-settings", pid] });
      await qc.invalidateQueries({ queryKey: ["benchmarks", pid] });
      toast(share ? "Sharing is on. Your own numbers appear in a moment; peers join at the next nightly run." : "Sharing is off. Your values were removed from the benchmarks.");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save."); } finally { setBusy(false); }
  };
  return (
    <section className="panel" aria-label="Benchmark sharing">
      <div className="ph"><b>Share anonymized benchmarks</b>{s.data.share ? <Tag tone="up">On</Tag> : <Tag>Off</Tag>}</div>
      <div className="pb" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {!compact && <p style={{ margin: 0, fontSize: 13, color: "var(--fg-2)" }}>Compare trial conversion, churn, refunds, LTV, ARPU and prices with apps like yours. Only projects that share see peer numbers.</p>}
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: "22px", color: "var(--fg-2)" }}>
          <li>Off by default. Nothing about this project is shared until an admin turns this on.</li>
          <li>RevenueDot shares only percentiles of groups with at least 10 apps. No app, customer or exact count is ever shown to anyone.</li>
          <li>Turning it off removes this project's values from every group at once.</li>
          <li>Only RevenueDot Cloud computes benchmarks; self-hosted servers never share.</li>
        </ul>
        <div className="bm-share">
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label">App category</span>
            <select className="select" aria-label="App category" value={category} disabled={!isAdmin || busy} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Pick a category…</option>
              {(cats.data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select>
          </label>
          {isAdmin ? (
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              {s.data.share && <button type="button" className="btn btn-line" disabled={busy} onClick={() => save(false)}>Stop sharing</button>}
              <button type="button" className="btn btn-dark" disabled={busy || (s.data.share && category === s.data.category)} onClick={() => save(true)}>{s.data.share ? "Save category" : "Share and compare"}</button>
            </div>
          ) : <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Only a project admin can change this.</p>}
        </div>
      </div>
    </section>
  );
}

export function BenchmarksPage() {
  const pid = useProjectId();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const ai = useAiStatus(pid);
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v === null || v === "" ) n.delete(k); else n.set(k, v); setSp(n, { replace: true }); };
  const query = new URLSearchParams();
  for (const k of ["category", "platform", "country"]) { const v = sp.get(k); if (v) query.set(k, v); }
  const q = useQuery({ queryKey: ["benchmarks", pid, query.toString()], enabled: !!pid, placeholderData: keepPreviousData, queryFn: () => api<Benchmarks>(`/v2/projects/${pid}/benchmarks?${query}`),
    // Right after turning sharing on, the project's own numbers are being computed: look again shortly.
    refetchInterval: (x) => (x.state.data?.settings?.share && !x.state.data.own_computed_at ? 3000 : false) });
  const b = q.data;
  const share = !!b?.settings?.share;
  const group = b?.peer_group;
  const catLabel = (id: string | undefined) => (id === "all" ? "All categories" : b?.categories?.find((c) => c.id === id)?.display_name ?? id ?? "");
  const withPeers = (b?.metrics ?? []).filter((m) => m.peers);
  const opp = b?.metrics?.find((m) => m.metric === b.opportunity);
  const askAi = async (text: string) => {
    try {
      const conv = await api<Conversation>(`${aiBase(pid)}/conversations`, { method: "POST", json: {} });
      await qc.invalidateQueries({ queryKey: ["ai-conversations", pid] });
      nav(`/projects/${pid}/ai/${conv.id}`, { state: { pending: { text, files: [] } satisfies PendingMessage } });
    } catch (e) { toast(e instanceof Error ? e.message : "RevenueDot AI could not start."); }
  };

  return (
    <Shell title="Benchmarks" crumbs={<><b>Analytics</b> <span className="crumb-sep">/</span> <b>Benchmarks</b></>}>
      <div className="page">
        <div className="head">
          <div>
            <h1>Benchmarks <Tag tone="info">Beta</Tag></h1>
            <p>{share && b?.window ? `Your last 12 months (${utcDay(b.window.start_date)} to ${utcDay(b.window.end_date)}) against apps that share anonymized data. Production, USD.` : "See how your subscription metrics compare with similar apps."}</p>
          </div>
          {share && (
            <div className="actions">
              <select className="select sm" aria-label="Category" value={group?.category ?? ""} onChange={(e) => set("category", e.target.value)}>
                <option value="all">All categories</option>
                {(b?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
              </select>
              <select className="select sm" aria-label="Platform" value={group?.platform ?? "all"} onChange={(e) => set("platform", e.target.value === "all" ? null : e.target.value)}>
                {(b?.options?.platforms ?? ["all", "ios", "android"]).map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p] ?? p}</option>)}
              </select>
              <select className="select sm" aria-label="Country" value={group?.country ?? "all"} onChange={(e) => set("country", e.target.value === "all" ? null : e.target.value)}>
                <option value="all">All countries</option>
                {(b?.options?.countries ?? []).map((c) => <option key={c} value={c}>{countryName(c)}</option>)}
              </select>
            </div>
          )}
        </div>

        {q.isError && <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>Benchmarks could not be loaded: {(q.error as Error).message}</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>}
        {q.isLoading && <div className="panel pb" aria-busy="true"><span className="sk line" /></div>}
        {b && !b.available && <div className="empty"><h3>Benchmarks are a RevenueDot Cloud feature</h3><p>A self-hosted server computes nothing and shares nothing. Your charts have every metric for your own app.</p><Link className="btn btn-line" to={`/projects/${pid}/charts`}>Open charts</Link></div>}
        {b?.available && !share && <BenchmarkSharing pid={pid} />}

        {b?.available && share && (
          <>
            {!b.own_computed_at && <div className="banner" role="status" aria-busy="true">Computing your numbers for the last 12 months. This takes a moment.</div>}
            {b.own_computed_at && !withPeers.length && (
              <div className="banner warn" role="status" style={{ alignItems: "center" }}>
                <span style={{ flex: 1 }}>
                  {b.last_computed_at === null
                    ? `Peer numbers arrive after the next nightly run (${utcTime(b.next_run_at ?? 0)}).`
                    : `Fewer than ${b.k_anonymity ?? 10} apps share data in ${catLabel(group?.category)} · ${PLATFORM_LABEL[group?.platform ?? "all"]} · ${group?.country === "all" ? "all countries" : countryName(group?.country ?? "")}, so no peer numbers are shown for this group.`}
                </span>
                {b.last_computed_at !== null && group && (group.category !== "all" || group.platform !== "all" || group.country !== "all") && <button type="button" className="btn btn-line" onClick={() => setSp(new URLSearchParams({ category: "all" }), { replace: true })}>Compare with all apps</button>}
              </div>
            )}
            {opp && opp.peers && (
              <div className="bm-opp" data-testid="opportunity">
                <span className="dot" aria-hidden />
                <span className="t"><b>Your biggest opportunity: {opp.definition.display_name.toLowerCase()}.</b> You are at {fmtValue(opp.value, opp.definition.unit)}; the median app is at {fmtValue(opp.peers.p50, opp.definition.unit)} (about the {ordinal(opp.percentile ?? 50)} percentile).</span>
                {chartHref(pid, opp.definition, b.window) && <Link className="btn btn-line" to={chartHref(pid, opp.definition, b.window)!}>Open the chart</Link>}
                {ai.data?.available && <button type="button" className="btn btn-dark" onClick={() => askAi(`My ${opp.definition.display_name.toLowerCase()} is ${fmtValue(opp.value, opp.definition.unit)} while the median of similar apps is ${fmtValue(opp.peers!.p50, opp.definition.unit)}. Use get-benchmarks and my charts to suggest how to improve it.`)}><Icon name="spark" />Ask RevenueDot AI</button>}
              </div>
            )}
            <section className="panel" aria-label="Metrics against peers">
              <div className="ph wrap"><b>{catLabel(group?.category)} · {PLATFORM_LABEL[group?.platform ?? "all"]} · {group?.country === "all" ? "All countries" : countryName(group?.country ?? "")}</b>
                <span className="subtle" style={{ fontSize: 12 }}>{group?.projects ? `${group.projects}+ apps` : "No peer group"}{b.last_computed_at ? ` · updated ${utcTime(b.last_computed_at)}` : ""}</span></div>
              <div className="bm-rows">
                {(b.metrics ?? []).map((m) => {
                  const d = m.definition;
                  const href = chartHref(pid, d, b.window);
                  const st = m.standing ? STAND[m.standing] : null;
                  return (
                    <div className="bm-row" key={m.metric} data-metric={m.metric}>
                      <div>
                        <h3>{href ? <Link to={href}>{d.display_name}</Link> : d.display_name}</h3>
                        <p>{d.description}</p>
                      </div>
                      <div className="bm-you">{fmtValue(m.value, d.unit)}<small>{m.value === null ? `needs ${fmt.int(d.min_sample)} ${d.sample_label}` : `${fmt.int(m.sample)} ${d.sample_label}`}</small></div>
                      <div className="bm-track-cell">
                        {m.peers ? <>
                          <Track peers={m.peers} value={m.value} unit={d.unit} />
                          <div className="bm-pct">{m.peers.p10 !== null && <span>P10 {fmtValue(m.peers.p10, d.unit)}</span>}<span>P25 {fmtValue(m.peers.p25, d.unit)}</span><span>Median {fmtValue(m.peers.p50, d.unit)}</span><span>P75 {fmtValue(m.peers.p75, d.unit)}</span>{m.peers.p90 !== null && <span>P90 {fmtValue(m.peers.p90, d.unit)}</span>}</div>
                        </> : <span className="bm-none">No peer group with 10 or more apps for this metric yet.</span>}
                      </div>
                      <div className="bm-stand">
                        {st && d.better !== "neutral" && <Tag tone={st.tone}>{st.label}</Tag>}
                        {m.percentile !== null && <div>{d.better === "neutral" ? (m.percentile >= 50 ? "Higher than" : "Lower than") + ` ${m.percentile >= 50 ? m.percentile : 100 - m.percentile}% of apps` : `${ordinal(m.percentile)} percentile${d.better === "lower" ? " (lower is better)" : ""}`}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="bm-key" aria-hidden><span><i className="band" />Middle half of apps (25th to 75th percentile)</span><span><i className="med" />Median</span><span><i className="you" />You</span></div>
            </section>
            <p className="fn">Benchmarks use the same definitions as Charts, over the last 12 complete months, with sandbox purchases excluded. Groups need at least {b.k_anonymity ?? 10} apps; app counts are rounded down to a multiple of 5. <Link className="link-u" to={`/projects/${pid}/settings/benchmarks`}>Sharing settings</Link></p>
          </>
        )}
      </div>
    </Shell>
  );
}

function ordinal(n: number) {
  const r = Math.round(n), s = r % 100 >= 11 && r % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][r % 10] ?? "th";
  return `${r}${s}`;
}
