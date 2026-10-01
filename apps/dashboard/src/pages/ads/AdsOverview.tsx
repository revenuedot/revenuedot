import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { DataTable, Panel, Segmented, Sparkline, Switch, Tabs, Tag, useProjectId, type Column } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { Legend, Plot, type Series } from "../charts/plot";
import { errMsg, useApps } from "../setup/data";
import { FORMAT_LABEL, v2, type AdsOverview as Overview, type Breakdown } from "./data";

/**
 * Ads Overview (/projects/:projectId/ads; prd/ads/PRD.md): ad revenue from the SDKs' ad events in US dollars, next to
 * subscription revenue for the same period. Cards with the change from the previous period, a daily chart (one
 * measure at a time), and tables by network, format, placement, ad unit and mediator. Before the first ad event,
 * RevenueCat's three onboarding steps (frame 17): add the SDK adapter, explore ad analytics, connect AdMob.
 */

const PERIODS = [
  { value: "7d", label: "7D", words: "7 days" }, { value: "28d", label: "28D", words: "28 days" },
  { value: "90d", label: "90D", words: "90 days" }, { value: "12m", label: "12M", words: "12 months" },
] as const;
type Period = (typeof PERIODS)[number]["value"];
type Measure = "revenue" | "impressions" | "ecpm";
type Dim = "network" | "format" | "placement" | "ad_unit" | "mediator";
const GUIDE = "https://revenuedot.app/docs/guides/ads";

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : fmt.usd(n, true));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(n * 100 < 10 ? 1 : 0)}%`);

function Delta({ now, before, words, money }: { now: number | null; before: number | null; words: string; money?: boolean }) {
  if (now === null || before === null || before === 0) return null;
  const p = ((now - before) / Math.abs(before)) * 100;
  return <span className={`d ${p > 0 ? "up" : p < 0 ? "down" : ""}`} title={`${money ? usd(before) : fmt.int(before)} in the ${words} before`}>{`${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`}</span>;
}

function Onboarding({ pid }: { pid: string }) {
  const steps = [
    { n: 1, title: "Add the SDK ad adapter", text: "Track revenue from the ads you show in your iOS or Android app with the RevenueCat SDK's ad tracking: AdMob, AppLovin MAX, ironSource and other mediation platforms. Your app keeps its SDK; ad events reach RevenueDot through the same proxy URL.", action: <a className="btn btn-line" href={`${GUIDE}#track-ad-events`} target="_blank" rel="noreferrer">Learn more</a> },
    { n: 2, title: "Explore your ad analytics", text: "When events arrive, this page shows ad revenue, impressions and eCPM by network, format and placement, next to your subscription revenue. The Charts page has eCPM, fill rate, clicks and ad-monetized customers over time.", action: <Link className="btn btn-line" to={`/projects/${pid}/charts/ad_revenue`}>Open ad charts</Link> },
    { n: 3, title: "AdMob users: connect your account", text: "Optional. Connect AdMob to load your ad unit names and formats, and verify rewarded ads on the server so rewards cannot be faked.", action: <Link className="btn btn-dark" to={`/projects/${pid}/integrations/admob`}>Connect AdMob</Link> },
  ];
  return (
    <section className="setup" aria-label="Start tracking ad revenue">
      <div className="setup-h">
        <div>
          <h2>Start tracking in-app ad revenue</h2>
          <p>Measure revenue from the ads in your app across every ad network, and see which formats and placements earn the most.</p>
        </div>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {steps.map((s) => (
          <li key={s.n} className={`step${s.n === 1 ? " next" : ""}`}>
            <span className="n" aria-hidden>{s.n}</span>
            <div style={{ minWidth: 0 }}><h3>{s.title}</h3><p>{s.text}</p></div>
            <div className="go">{s.action}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Cards({ o, words, pid }: { o: Overview; words: string; pid: string }) {
  const t = o.totals, p = o.previous;
  const spark = (k: "ad_revenue" | "impressions" | "ecpm" | "clicks" | "subscription_revenue") => o.series.map((x) => x[k] ?? 0);
  const cards = [
    { id: "ad_revenue", label: "Ad revenue", icon: "dollar", value: <>{usd(t.ad_revenue)}</>, delta: <Delta now={t.ad_revenue} before={p.ad_revenue} words={words} money />, meta: `last ${words}`, spark: spark("ad_revenue"), chart: "ad_revenue" },
    { id: "impressions", label: "Impressions", icon: "eye", value: <>{fmt.int(t.impressions)}</>, delta: <Delta now={t.impressions} before={p.impressions} words={words} />, meta: `last ${words}`, spark: spark("impressions"), chart: "ad_impressions" },
    { id: "ecpm", label: "eCPM", icon: "ads", value: <>{usd(t.ecpm)}</>, delta: <Delta now={t.ecpm} before={p.ecpm} words={words} money />, meta: "revenue per 1,000 impressions", spark: spark("ecpm"), chart: "ad_rpm" },
    { id: "clicks", label: "Clicks", icon: "arrow", value: <>{fmt.int(t.clicks)}</>, delta: <Delta now={t.clicks} before={p.clicks} words={words} />, meta: `CTR ${pct(t.ctr)}`, spark: spark("clicks"), chart: "ad_clicks" },
    { id: "share", label: "Ad share of revenue", icon: "analytics", value: <>{pct(t.ad_share)}</>, delta: null, meta: `of ${usd(t.total_revenue)} total`, spark: o.series.map((x) => (x.ad_revenue + x.subscription_revenue > 0 ? x.ad_revenue / (x.ad_revenue + x.subscription_revenue) : 0)), chart: null },
    { id: "subscription_revenue", label: "Subscription revenue", icon: "overview", value: <>{usd(t.subscription_revenue)}</>, delta: <Delta now={t.subscription_revenue} before={p.subscription_revenue} words={words} money />, meta: `last ${words}`, spark: spark("subscription_revenue"), chart: "revenue" },
  ];
  return (
    <section className="grid" aria-label="Ad metrics">
      {cards.map((c) => (
        <article className="m" key={c.id} data-metric={c.id}>
          <div className="lab">{c.chart ? <Link to={`/projects/${pid}/charts/${c.chart}`} className="ul" title={`Open the ${c.label} chart`}>{c.label}</Link> : <span>{c.label}</span>}<Icon name={c.icon} /></div>
          <div className="v">{c.value}</div>
          <div className="meta">{c.delta}<span>{c.meta}</span></div>
          {c.spark.length > 1 ? <Sparkline values={c.spark} /> : <span style={{ height: 44 }} />}
        </article>
      ))}
    </section>
  );
}

function Trend({ o }: { o: Overview }) {
  const [measure, setMeasure] = useState<Measure>("revenue");
  const periods = useMemo(() => o.series.map((s, i) => {
    const d = new Date(`${s.date}T00:00:00Z`);
    return { start: d.getTime(), label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), long: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }), incomplete: i === o.series.length - 1 };
  }), [o.series]);
  const series: Series[] = measure === "revenue"
    ? [{ key: "ad", label: "Ad revenue", values: o.series.map((x) => x.ad_revenue) }, { key: "sub", label: "Subscription revenue", values: o.series.map((x) => x.subscription_revenue) }]
    : measure === "impressions" ? [{ key: "imp", label: "Impressions", values: o.series.map((x) => x.impressions) }]
      : [{ key: "ecpm", label: "eCPM", values: o.series.map((x) => x.ecpm) }];
  const money = measure !== "impressions";
  return (
    <Panel title="Daily" link={<Segmented label="Measure" value={measure} onChange={setMeasure} options={[{ value: "revenue", label: "Revenue" }, { value: "impressions", label: "Impressions" }, { value: "ecpm", label: "eCPM" }]} />}>
      <Legend series={series} />
      <Plot periods={periods} series={series} kind={measure === "impressions" ? "bar" : "line"} integer={!money}
        format={(v) => (v === null ? "—" : money ? usd(v) : fmt.int(v))}
        formatTick={(v) => { const s = Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : `${+v.toFixed(2)}`; return money ? `$${s}` : s; }}
        ariaLabel={`${series.map((s) => s.label).join(" and ")} by day. The values are in the tables below.`} />
    </Panel>
  );
}

const DIMS: { value: Dim; label: string; key: keyof Overview }[] = [
  { value: "network", label: "Network", key: "by_network" }, { value: "format", label: "Format", key: "by_format" }, { value: "placement", label: "Placement", key: "by_placement" },
  { value: "ad_unit", label: "Ad unit", key: "by_ad_unit" }, { value: "mediator", label: "Mediator", key: "by_mediator" },
];

function Breakdowns({ o, pid }: { o: Overview; pid: string }) {
  const [dim, setDim] = useState<Dim>("network");
  const rows = o[DIMS.find((d) => d.value === dim)!.key] as Breakdown[];
  const label = (r: Breakdown) => {
    if (!r.key) return <span className="subtle">{dim === "placement" ? "No placement" : "Unknown"}</span>;
    if (dim === "format") return FORMAT_LABEL[r.key] ?? r.key;
    if (dim === "ad_unit") return <>{r.name ?? <span className="mono">{r.key}</span>}{r.name && <span className="cellsub mono">{r.key}</span>}</>;
    return r.key;
  };
  const cols: Column<Breakdown>[] = [
    { key: "k", header: DIMS.find((d) => d.value === dim)!.label, render: label },
    { key: "rev", header: "Ad revenue", align: "right", render: (r) => usd(r.ad_revenue), className: "num" },
    { key: "share", header: "Share", align: "right", render: (r) => pct(r.share), className: "num" },
    { key: "imp", header: "Impressions", align: "right", render: (r) => fmt.int(r.impressions), className: "num" },
    { key: "ecpm", header: "eCPM", align: "right", render: (r) => usd(r.ecpm), className: "num" },
    { key: "clicks", header: "Clicks", align: "right", render: (r) => fmt.int(r.clicks), className: "num" },
  ];
  return (
    <section className="panel">
      <div className="ph wrap"><b>Breakdown</b>{dim === "ad_unit" && !o.ad_units_loaded && <Link className="link" to={`/projects/${pid}/integrations/admob`}>Connect AdMob for ad unit names →</Link>}</div>
      <div style={{ padding: "0 16px" }}><Tabs label="Breakdown" idBase="ads-dim" value={dim} onChange={setDim} tabs={DIMS.map((d) => ({ value: d.value, label: d.label }))} /></div>
      <div role="tabpanel" id={`ads-dim-${dim}-panel`} aria-labelledby={`ads-dim-${dim}`}>
        <DataTable columns={cols} rows={rows} rowKey={(r) => r.key || "(none)"} empty={<div className="pb section-sub">No ad events in this period.</div>} />
      </div>
    </section>
  );
}

export function AdsOverviewPage() {
  const pid = useProjectId();
  const [sp, setSp] = useSearchParams();
  const env = sp.get("environment") === "sandbox" ? "sandbox" : "production";
  const period = PERIODS.find((p) => p.value === sp.get("period")) ?? PERIODS[1];
  const appId = sp.get("app") ?? "";
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v === null || v === "") n.delete(k); else n.set(k, v); setSp(n, { replace: true }); };
  const apps = useApps(pid);
  const q = useQuery({
    queryKey: ["ads_overview", pid, env, period.value, appId],
    queryFn: () => api<Overview>(`${v2(pid)}/ads/overview?range=${period.value}&environment=${env}${appId ? `&app_id=${encodeURIComponent(appId)}` : ""}`),
    enabled: !!pid, refetchInterval: 60_000,
  });
  const o = q.data;
  const onboarding = o && !o.has_ad_events;
  return (
    <Shell title="Ads" crumbs={<><b>Ads</b> <span>/</span> <b>Overview</b></>}>
      <div className="page">
        <div className="head">
          <div>
            <h1>Ads <Tag tone="info">Beta</Tag></h1>
            <p>Revenue from the ads in your app across every ad network, in US dollars next to subscription revenue{onboarding ? "." : ` · last ${period.words} compared with the ${period.words} before.`}</p>
          </div>
          <div className="actions">
            {!onboarding && <Segmented label="Period" value={period.value as Period} options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} onChange={(v) => set("period", v === "28d" ? null : v)} />}
            {!onboarding && (apps.data?.length ?? 0) > 1 && (
              <select className="select" aria-label="App" value={appId} onChange={(e) => set("app", e.target.value)} style={{ width: 180 }}>
                <option value="">All apps</option>
                {apps.data!.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
            <Switch label="Sandbox data" checked={env === "sandbox"} onChange={(v) => set("environment", v ? "sandbox" : null)} />
          </div>
        </div>
        {q.isError && <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>The ad numbers could not be loaded: {errMsg(q.error)}</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>}
        {q.isLoading && <div className="panel pb" aria-busy="true"><span className="sk line" /></div>}
        {onboarding && <Onboarding pid={pid} />}
        {o && !onboarding && (
          <>
            {o.totals.impressions === 0 && o.totals.ad_revenue === 0 && (
              <div className="banner" role="status">No {env === "sandbox" ? "sandbox" : "production"} ad events in the last {period.words}{env === "production" ? ". Ad events from TestFlight, Xcode and the Test Store are sandbox data." : "."}</div>
            )}
            {o.unconverted.length > 0 && (
              <div className="banner" role="status">Revenue in {o.unconverted.map((u) => `${u.currency} (${u.amount.toFixed(2)})`).join(", ")} could not be converted to US dollars and is not counted.</div>
            )}
            <Cards o={o} words={period.words} pid={pid} />
            <Trend o={o} />
            <Breakdowns o={o} pid={pid} />
            <p className="fn">Ad revenue comes from the SDK's ad revenue events, converted to US dollars at each day's rate. Impressions are displayed ads. <Link className="link-u" to={`/projects/${pid}/ads/rewards`}>Rewarded ads</Link> · <a className="link-u" href={GUIDE} target="_blank" rel="noreferrer">How ad revenue is measured</a></p>
          </>
        )}
      </div>
    </Shell>
  );
}
