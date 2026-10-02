import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Segmented, Tag, useProjectId } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import "./analytics.css";

/**
 * Revenue by campaign (/projects/:projectId/attribution; prd/attribution-benchmarks-insights §1): new customers of a
 * date range grouped by media source, campaign, ad group or keyword, with what they paid on day 0, by day 7, by day 30
 * and to date. A Spend column (typed in, kept in this browser) gives ROAS. Each row opens the Revenue chart and the
 * Customers list filtered to it.
 */

type GroupBy = "media_source" | "campaign" | "ad_group" | "keyword";
interface Row {
  key: string; label: string; customers: number; trial_starts: number; paying_customers: number; conversion_to_paying: number | null;
  revenue_day_0: number; revenue_day_7: number; revenue_day_30: number; revenue_to_date: number; revenue_per_customer: number | null;
  revenue_per_paying_customer: number | null; day_7_incomplete: boolean; day_30_incomplete: boolean;
}
interface Report { group_by: GroupBy; start_date: string; end_date: string; media_source: string | null; media_sources: string[]; rows: Row[]; total: Row }

const GROUPS: { value: GroupBy; label: string; filter: string; field: string }[] = [
  { value: "media_source", label: "Media source", filter: "media_source", field: "mediaSource" },
  { value: "campaign", label: "Campaign", filter: "campaign", field: "campaign" },
  { value: "ad_group", label: "Ad group", filter: "ad_group", field: "adGroup" },
  { value: "keyword", label: "Keyword", filter: "keyword", field: "keyword" },
];
const RANGES = [{ value: "30d", label: "30D", days: 30 }, { value: "90d", label: "90D", days: 90 }, { value: "12m", label: "12M", days: 365 }, { value: "custom", label: "Custom", days: 0 }] as const;
type RangeId = (typeof RANGES)[number]["value"];
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const NONE = "No attribution";
const DOCS = "https://revenuedot.app/docs/guides/attribution";

const utcDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : fmt.usd(n, true));
const roas = (rev: number, spend: number | undefined) => (spend && spend > 0 ? `${((rev / spend) * 100).toFixed(0)}%` : "—");

function useSpend(key: string) {
  const read = () => { try { return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, number>; } catch { return {}; } };
  const [spend, setSpend] = useState<Record<string, number>>(read);
  useEffect(() => { setSpend(read()); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (row: string, v: number | null) => {
    setSpend((cur) => {
      const next = { ...cur };
      if (v === null || !Number.isFinite(v) || v <= 0) delete next[row]; else next[row] = v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private window: kept for this visit only */ }
      return next;
    });
  };
  return [spend, set] as const;
}

function SpendInput({ value, onChange, label }: { value: number | undefined; onChange: (v: number | null) => void; label: string }) {
  const [draft, setDraft] = useState(value ? String(value) : "");
  useEffect(() => { setDraft(value ? String(value) : ""); }, [value]);
  return (
    <input className="input spend" inputMode="decimal" aria-label={label} placeholder="$0" value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
      onBlur={() => onChange(draft.trim() ? Number(draft) : null)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

function csv(rows: Row[], total: Row, groupColumn: string, spend: Record<string, number>) {
  // The total's ROAS: revenue of the rows with spend ÷ their spend.
  const spent = rows.filter((r) => (spend[r.key] ?? 0) > 0);
  const paidTotal: Row = { ...total, revenue_to_date: spent.reduce((a, r) => a + r.revenue_to_date, 0), revenue_day_7: spent.reduce((a, r) => a + r.revenue_day_7, 0), revenue_day_30: spent.reduce((a, r) => a + r.revenue_day_30, 0) };
  const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /^[=+\-@]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = [groupColumn, "new_customers", "trial_starts", "paying_customers", "conversion_to_paying_pct", "revenue_day_0", "revenue_day_7", "revenue_day_30", "revenue_to_date", "revenue_per_customer", "spend", "roas_to_date_pct", "roas_day_7_pct", "roas_day_30_pct"];
  const line = (r: Row, sp?: number) => [r.label, r.customers, r.trial_starts, r.paying_customers, r.conversion_to_paying, r.revenue_day_0, r.revenue_day_7, r.revenue_day_30, r.revenue_to_date, r.revenue_per_customer,
    sp ?? "", sp ? ((r.revenue_to_date / sp) * 100).toFixed(1) : "", sp ? ((r.revenue_day_7 / sp) * 100).toFixed(1) : "", sp ? ((r.revenue_day_30 / sp) * 100).toFixed(1) : ""].map(cell).join(",");
  const totalSpend = spent.reduce((a, r) => a + spend[r.key]!, 0) || undefined;
  const totalLine = line(total, totalSpend).split(",");
  if (totalSpend) { const roasOf = (v: number) => ((v / totalSpend) * 100).toFixed(1); totalLine.splice(11, 3, roasOf(paidTotal.revenue_to_date), roasOf(paidTotal.revenue_day_7), roasOf(paidTotal.revenue_day_30)); }
  return [head.join(","), ...rows.map((r) => line(r, spend[r.key])), totalLine.join(",")].join("\r\n") + "\r\n";
}

export function AttributionPage() {
  const pid = useProjectId();
  const [sp, setSp] = useSearchParams();
  const groupBy = (GROUPS.find((g) => g.value === sp.get("group_by"))?.value ?? "campaign") as GroupBy;
  const group = GROUPS.find((g) => g.value === groupBy)!;
  const range = (RANGES.find((r) => r.value === sp.get("range"))?.value ?? (sp.get("start") ? "custom" : "30d")) as RangeId;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const preset = RANGES.find((r) => r.value === range)!;
  const end = range === "custom" ? sp.get("end") ?? iso(today) : iso(today);
  const start = range === "custom" ? sp.get("start") ?? iso(today - 29 * DAY) : iso(today - (preset.days - 1) * DAY);
  const media = sp.get("media_source");
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") n.delete(k); else n.set(k, v); } setSp(n, { replace: true }); };

  const query = new URLSearchParams({ group_by: groupBy, start_date: start, end_date: end });
  if (media !== null) query.set("media_source", media);
  const q = useQuery({ queryKey: ["attribution", pid, query.toString()], enabled: !!pid, placeholderData: keepPreviousData, queryFn: () => api<Report>(`/v2/projects/${pid}/attribution/report?${query}`) });
  const [spend, setSpend] = useSpend(`rd-attr-spend:${pid}:${groupBy}:${media ?? ""}:${start}:${end}`);
  const r = q.data;
  // ROAS in the totals compares spend with the revenue of the rows that have spend (organic customers cost nothing).
  const paid = useMemo(() => {
    const rows = (r?.rows ?? []).filter((x) => (spend[x.key] ?? 0) > 0);
    const sum = (k: "revenue_to_date" | "revenue_day_7" | "revenue_day_30") => rows.reduce((a, x) => a + x[k], 0);
    return { spend: rows.reduce((a, x) => a + spend[x.key]!, 0), toDate: sum("revenue_to_date"), day7: sum("revenue_day_7"), day30: sum("revenue_day_30") };
  }, [r, spend]);
  const totalSpend = paid.spend;

  const chartHref = (row: Row) => {
    const filters = [...(media !== null && groupBy !== "media_source" ? [{ name: "media_source", values: [media === NONE ? "" : media] }] : []), { name: group.filter, values: [row.key] }];
    return `/projects/${pid}/charts/revenue?range=custom&start=${start}&end=${end}&res=${preset.days > 120 || range === "custom" ? "month" : "day"}&filters=${encodeURIComponent(JSON.stringify(filters))}`;
  };
  const customersHref = (row: Row) => {
    const cond = row.key === "" ? { field: group.field, operator: "isEmpty" } : { field: group.field, operator: "is", value: row.key };
    const conds = [...(media !== null && groupBy !== "media_source" ? [media === NONE ? { field: "mediaSource", operator: "isEmpty" } : { field: "mediaSource", operator: "is", value: media }] : []), cond,
      { field: "firstSeenAt", operator: "between", value: `${start},${end}T23:59:59Z` }];
    return `/projects/${pid}/customers?filter=${encodeURIComponent(JSON.stringify({ groups: [{ conditions: conds }] }))}`;
  };
  const download = () => {
    if (!r) return;
    const blob = new Blob([csv(r.rows, r.total, groupBy, spend)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `revenue-by-${groupBy}-${start}-${end}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const noAttribution = r && r.media_sources.length === 0;
  const incomplete7 = r?.rows.some((x) => x.day_7_incomplete), incomplete30 = r?.rows.some((x) => x.day_30_incomplete);

  return (
    <Shell title="Attribution" crumbs={<><b>Analytics</b> <span className="crumb-sep">/</span> <b>Attribution</b></>}>
      <div className="page attr">
        <div className="head">
          <div>
            <h1>Revenue by campaign</h1>
            <p>New customers from {utcDay(start)} to {utcDay(end)} (UTC) by where they came from, and what they paid since. Production, USD.</p>
          </div>
          <div className="actions">
            <button type="button" className="btn btn-line" disabled={!r?.rows.length} onClick={download}><Icon name="docs" />CSV</button>
          </div>
        </div>
        <div className="ctools" role="group" aria-label="Report controls">
          <Segmented label="Date range" value={range} options={RANGES.map((x) => ({ value: x.value, label: x.label }))}
            onChange={(v) => set({ range: v === "30d" ? null : v, start: v === "custom" ? start : null, end: v === "custom" ? end : null })} />
          {range === "custom" && <>
            <input className="input dt" type="date" aria-label="Start date" value={start} max={end} onChange={(e) => set({ range: "custom", start: e.target.value })} />
            <span className="subtle">to</span>
            <input className="input dt" type="date" aria-label="End date" value={end} min={start} onChange={(e) => set({ range: "custom", end: e.target.value })} />
          </>}
          <select className="select sm" aria-label="Group by" value={groupBy} onChange={(e) => set({ group_by: e.target.value === "campaign" ? null : e.target.value })}>
            {GROUPS.map((g) => <option key={g.value} value={g.value}>By {g.label.toLowerCase()}</option>)}
          </select>
          {groupBy !== "media_source" && (
            <select className="select sm" aria-label="Media source" value={media ?? ""} onChange={(e) => set({ media_source: e.target.value || null })}>
              <option value="">All media sources</option>
              {(r?.media_sources ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              <option value={NONE}>{NONE}</option>
            </select>
          )}
        </div>

        {q.isError && <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>The report could not be loaded: {(q.error as Error).message}</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>}
        {q.isLoading && <div className="panel pb" aria-busy="true"><span className="sk line" /></div>}
        {noAttribution && (
          <div className="banner" role="status">
            <span style={{ flex: 1 }}>No customer has attribution yet. It arrives from the SDK's attribution attributes (<span className="mono">$mediaSource</span>, <span className="mono">$campaign</span> …), from Apple Search Ads through the AdServices token, and from AppsFlyer, Adjust or Branch through the SDK.</span>
            <a className="btn btn-line" href={DOCS} target="_blank" rel="noreferrer">How to send it</a>
          </div>
        )}
        {r && (
          <>
            <section className="grid attr-cards" aria-label="Totals">
              <article className="m"><div className="lab">New customers</div><div className="v">{fmt.int(r.total.customers)}</div><div className="meta"><span>{fmt.int(r.total.paying_customers)} paying · {r.total.conversion_to_paying === null ? "—" : `${r.total.conversion_to_paying}%`}</span></div></article>
              <article className="m"><div className="lab">Revenue to date</div><div className="v">{usd(r.total.revenue_to_date)}</div><div className="meta"><span>{usd(r.total.revenue_per_customer)} per customer</span></div></article>
              <article className="m"><div className="lab">ROAS to date</div><div className="v">{roas(paid.toDate, totalSpend)}</div><div className="meta"><span>{totalSpend ? `${usd(paid.toDate)} from ${usd(totalSpend)} spend` : "Type spend in the table"}</span></div></article>
            </section>
            {!r.rows.length ? (
              <div className="empty"><h3>No new customers in this range</h3><p>Pick a longer range, or check that the app's SDK points at RevenueDot.</p></div>
            ) : (
              <div className="panel tbl attr-tbl">
                <table>
                  <thead>
                    <tr>
                      <th>{group.label}</th><th className="amt">New customers</th><th className="amt">Trials</th><th className="amt">Paying</th><th className="amt">Conv.</th>
                      <th className="amt">Day 0</th><th className="amt">Day 7</th><th className="amt">Day 30</th><th className="amt">To date</th><th className="amt">Per customer</th>
                      <th className="amt">Spend</th><th className="amt">ROAS</th><th className="amt">Day 7 ROAS</th><th className="amt">Day 30 ROAS</th><th aria-label="Open" />
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row) => (
                      <tr key={row.key || "(none)"} data-row={row.label}>
                        <td className="lbl">{row.key === "" ? <span className="subtle">{NONE}</span> : row.label}</td>
                        <td className="amt num">{fmt.int(row.customers)}</td><td className="amt num">{fmt.int(row.trial_starts)}</td><td className="amt num">{fmt.int(row.paying_customers)}</td>
                        <td className="amt num">{row.conversion_to_paying === null ? "—" : `${row.conversion_to_paying}%`}</td>
                        <td className="amt num">{usd(row.revenue_day_0)}</td>
                        <td className="amt num">{usd(row.revenue_day_7)}{row.day_7_incomplete && <sup title="Some customers' first 7 days have not ended">*</sup>}</td>
                        <td className="amt num">{usd(row.revenue_day_30)}{row.day_30_incomplete && <sup title="Some customers' first 30 days have not ended">*</sup>}</td>
                        <td className="amt num"><b>{usd(row.revenue_to_date)}</b></td><td className="amt num">{usd(row.revenue_per_customer)}</td>
                        <td className="amt"><SpendInput label={`Spend for ${row.label}`} value={spend[row.key]} onChange={(v) => setSpend(row.key, v)} /></td>
                        <td className="amt num">{roas(row.revenue_to_date, spend[row.key])}</td><td className="amt num">{roas(row.revenue_day_7, spend[row.key])}</td><td className="amt num">{roas(row.revenue_day_30, spend[row.key])}</td>
                        <td className="amt go">
                          <Link to={chartHref(row)} className="ib" aria-label={`Revenue chart for ${row.label}`} title="Revenue chart"><Icon name="analytics" /></Link>
                          <Link to={customersHref(row)} className="ib" aria-label={`Customers from ${row.label}`} title="Customers"><Icon name="customers" /></Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="lbl"><b>Total</b></td><td className="amt num">{fmt.int(r.total.customers)}</td><td className="amt num">{fmt.int(r.total.trial_starts)}</td><td className="amt num">{fmt.int(r.total.paying_customers)}</td>
                      <td className="amt num">{r.total.conversion_to_paying === null ? "—" : `${r.total.conversion_to_paying}%`}</td>
                      <td className="amt num">{usd(r.total.revenue_day_0)}</td><td className="amt num">{usd(r.total.revenue_day_7)}</td><td className="amt num">{usd(r.total.revenue_day_30)}</td>
                      <td className="amt num"><b>{usd(r.total.revenue_to_date)}</b></td><td className="amt num">{usd(r.total.revenue_per_customer)}</td>
                      <td className="amt num">{totalSpend ? usd(totalSpend) : "—"}</td><td className="amt num">{roas(paid.toDate, totalSpend)}</td>
                      <td className="amt num">{roas(paid.day7, totalSpend)}</td><td className="amt num">{roas(paid.day30, totalSpend)}</td><td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="fn">
              {(incomplete7 || incomplete30) && <>* Still growing: some customers' first {incomplete7 ? "7" : "30"} days have not ended. </>}
              Revenue is purchases and renewals minus refunds, in US dollars at the purchase date, ads excluded. Spend stays in this browser. <Tag>Beta</Tag>{" "}
              <a className="link-u" href={DOCS} target="_blank" rel="noreferrer">How attribution works</a>
            </p>
          </>
        )}
      </div>
    </Shell>
  );
}
