/*
 * Customers: /projects/:projectId/customers?list=<all|active|sandbox|non_subscription|expired|audience id>&q=<search>&sort=<column>&direction=<asc|desc>
 * RevenueCat's customer lists: a rail of audiences (built-in lists, saved audiences, "New audience"), four summary cards,
 * a filter bar (search, conditions from the audience builder, "Save audience", "Export all") and the customer table.
 * Data: GET /v2/projects/{id}/customer_lists (rows and summary) and /customer_lists/export (CSV), GET/POST /audiences.
 * Lists scan the 10,000 most recently seen customers. Search matches part of an app user ID or email; a whole store
 * transaction ID still finds its customer through RevenueCat's exact search (GET /customers?search=).
 * Column headers sort the list (the default is last seen, newest first); the eye button masks IDs and emails on screen.
 */
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../components/Shell";
import { Icon } from "../components/icons";
import { DataTable, Dialog, EmptyState, Field, PageHead, Tag, useProjectId, useToast, type Column } from "../components/ui";
import { ConditionBuilder, describeRules, incomplete, toRules, useFieldSuggestions, type Condition, type Groups, type Rules } from "../components/conditions";
import { api, fmt, type List } from "../lib/api";
import { countNote, isAnonymous, money, pollWhileCounting, relative, shortId, storeLabel, type Customer } from "../lib/customers";
import { errMsg, v2 } from "./catalog/lib";
import type { Audience } from "./lifecycle/lib";

const LIMIT = 25;
const SORTABLE = ["id", "subscription_status", "auto_renewal_status", "first_seen_at", "last_seen_at", "spent_in_usd"] as const;
type SortKey = (typeof SORTABLE)[number];
/** The API's order without `sort`: last seen, newest first. */
const DEFAULT_SORT: { key: SortKey; direction: "asc" | "desc" } = { key: "last_seen_at", direction: "desc" };
const HIDE_KEY = "rd-hide-customer-ids";
const BUILT_IN: { id: string; label: string; cond: Condition | null; note?: string }[] = [
  { id: "all", label: "All customers", cond: null },
  { id: "active", label: "Active subscribers", cond: { field: "status", operator: "isAnyOf", value: "active,trialing" }, note: "Subscription status is active or trialing (sandbox purchases count too)" },
  { id: "sandbox", label: "Sandbox", cond: { field: "hasMadeSandboxPurchase", operator: "is", value: "true" } },
  { id: "non_subscription", label: "Non-subscription", cond: { field: "hasMadeNonSubscriptionPurchase", operator: "is", value: "true" } },
  { id: "expired", label: "Expired", cond: { field: "status", operator: "is", value: "expired" } },
];

interface Row {
  id: string; customer_uuid: string; email: string | null; subscription_status: "active" | "trialing" | "grace_period" | "billing_issue" | "expired" | "none";
  auto_renewal_status: "on" | "off" | null; first_seen_at: number; last_seen_at: number; spent_in_usd: number;
  latest_purchase: { product_id: string; store: string; purchased_at: number; environment: "production" | "sandbox" } | null; country: string | null; platform: string | null;
}
interface ListResp extends List<Row> { summary: { customers: number; trialing_subscribers: number; paid_subscribers: number; total_revenue_in_usd: number; is_approximate: boolean; is_counting: boolean; counted_at: number | null } }
const STATUS: Record<Row["subscription_status"], { label: string; tone: "up" | "down" | "info" | "muted" }> = {
  active: { label: "Active", tone: "up" }, trialing: { label: "Trial", tone: "info" }, grace_period: { label: "Grace period", tone: "down" },
  billing_issue: { label: "Billing issue", tone: "down" }, expired: { label: "Expired", tone: "muted" }, none: { label: "None", tone: "muted" },
};

/** An audience has at most 20 groups (the API's limit). */
const MAX_GROUPS = 20;

/** The current list's rules combined with the filter: (A1 or A2) and (F1 or F2) = A1F1 or A1F2 or A2F1 or A2F2. */
function combined(list: string, audiences: Audience[], filter: Rules): Rules {
  const b = BUILT_IN.find((x) => x.id === list);
  const base: Condition[][] = b ? (b.cond ? [[b.cond]] : []) : (audiences.find((a) => a.id === list)?.rules.groups.map((g) => g.conditions) ?? []);
  const f = filter.groups.map((g) => g.conditions);
  if (!base.length) return { groups: f.map((conditions) => ({ conditions })) };
  if (!f.length) return { groups: base.map((conditions) => ({ conditions })) };
  return { groups: base.flatMap((a) => f.map((x) => ({ conditions: [...a, ...x] }))) };
}

export function Customers() {
  const pid = useProjectId();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const list = sp.get("list") || "all";
  const q = sp.get("q")?.trim() ?? "";
  const after = sp.get("after");
  const sortKey = (SORTABLE as readonly string[]).includes(sp.get("sort") ?? "") ? sp.get("sort") as SortKey : null;
  const direction: "asc" | "desc" = sp.get("direction") === "desc" ? "desc" : "asc";
  // The order on screen: the URL's sort, else the API's default.
  const shown = sortKey ? { key: sortKey, direction } : DEFAULT_SORT;
  // Masks app user IDs and emails on screen (for screen sharing and demos); remembered in this browser only.
  const [hideIds, setHideIds] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; } });
  const toggleHide = () => {
    const next = !hideIds;
    setHideIds(next);
    try { if (next) localStorage.setItem(HIDE_KEY, "1"); else localStorage.removeItem(HIDE_KEY); } catch { /* storage blocked: this visit only */ }
  };
  const [draft, setDraft] = useState(q);
  const [filterOpen, setFilterOpen] = useState(() => !!sp.get("filter"));
  const suggestions = useFieldSuggestions(pid);
  // `?filter=<rules JSON>` opens the list already filtered (links from the Attribution page).
  const linked = (() => { try { const r = JSON.parse(sp.get("filter") ?? "null") as Rules | null; return r && Array.isArray(r.groups) ? r : null; } catch { return null; } })();
  const [groups, setGroups] = useState<Groups>(() => (linked ? linked.groups.map((g) => g.conditions.map((c) => ({ ...c }))) : []));
  const [applied, setApplied] = useState<Rules>(() => linked ?? { groups: [] });
  const [saving, setSaving] = useState(false);
  const [filterErr, setFilterErr] = useState<string | null>(null);
  // Cursors of the pages before this one, so "Previous" works without the API paging backwards.
  const [trail, setTrail] = useState<(string | null)[]>([]);
  // The box follows the URL when the search changes elsewhere (top bar, Clear, back), but never overwrites typing that
  // started after this page's own submit: the router can commit that URL change after the next keystrokes.
  const pushed = useRef<string | null>(null);
  useEffect(() => {
    if (pushed.current !== null && pushed.current === q) { pushed.current = null; return; }
    pushed.current = null;
    setDraft(q);
  }, [q]);
  useEffect(() => { if (!after) setTrail([]); }, [after]);

  const audiences = useQuery({ queryKey: ["audiences", pid], enabled: !!pid, queryFn: async () => (await api<List<Audience>>(`${v2(pid)}/audiences`)).items });
  const params = (paged: boolean) => {
    const p = new URLSearchParams({ list });
    if (applied.groups.length) p.set("rules", JSON.stringify(applied));
    if (q) p.set("search", q);
    if (sortKey) { p.set("sort", sortKey); p.set("direction", direction); }
    if (paged) { p.set("limit", String(LIMIT)); if (after) p.set("starting_after", after); }
    return p;
  };
  const res = useQuery({ queryKey: ["customer-list", pid, list, q, after, sortKey, direction, JSON.stringify(applied)], enabled: !!pid, placeholderData: (p) => p,
    refetchInterval: (query) => pollWhileCounting(query.state.data?.summary.is_counting),
    queryFn: () => api<ListResp>(`${v2(pid)}/customer_lists?${params(true)}`) });
  // A whole store transaction ID (or alias) that the list search does not cover: RevenueCat's exact search.
  const exact = useQuery({ queryKey: ["customer-exact", pid, q], enabled: !!q && res.data?.items.length === 0 && !after,
    queryFn: async () => (await api<List<Customer>>(`${v2(pid)}/customers?search=${encodeURIComponent(q)}&limit=1`)).items[0] ?? null });

  const setParams = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) if (v) n.set(k, v); else n.delete(k);
    n.delete("after");
    setSp(n);
  };
  const pickList = (id: string) => { setParams({ list: id === "all" ? null : id }); };
  const search = (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    if (next !== q) pushed.current = next;
    setParams({ q: next || null });
  };
  const [exporting, setExporting] = useState(false);
  // Fetched, not a plain download link: an error (a deleted audience, a bad filter) shows here instead of saving as a .csv.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await fetch(`${v2(pid)}/customer_lists/export?${params(false)}`, { credentials: "same-origin" });
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { message?: string } | null;
        throw new Error(body?.message ?? `Export failed (${r.status})`);
      }
      const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "customers.csv";
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (x) { toast(errMsg(x)); }
    setExporting(false);
  };
  // First click sorts dates and money newest or largest first, IDs A to Z, statuses active first; the next click flips it.
  // The default order (last seen, newest first) keeps a clean URL.
  const sortBy = (key: SortKey) => {
    const first = key === "id" || key === "subscription_status" || key === "auto_renewal_status" ? "asc" : "desc";
    const next = shown.key === key ? (shown.direction === "asc" ? "desc" : "asc") : first;
    const isDefault = key === DEFAULT_SORT.key && next === DEFAULT_SORT.direction;
    setTrail([]);
    setParams({ sort: isDefault ? null : key, direction: isDefault ? null : next });
  };
  const sortOf = (key: SortKey) => ({ direction: shown.key === key ? shown.direction : null, onSort: () => sortBy(key) });
  const go = (cursor: string | null, back = false) => {
    const n = new URLSearchParams(sp);
    if (cursor) n.set("after", cursor); else n.delete("after");
    setTrail((t) => (back ? t.slice(0, -1) : [...t, after]));
    setSp(n);
  };
  const apply = () => {
    if (incomplete(groups)) { setFilterErr("Fill in every condition's value, or remove the condition."); return; }
    setFilterErr(null); setApplied(toRules(groups)); setParams({});
  };
  const clearFilter = () => { setGroups([]); setApplied({ groups: [] }); setFilterErr(null); };
  const newAudience = () => { setFilterOpen(true); if (!groups.length) setGroups([[{ field: "country", operator: "is", value: "" }]]); setTimeout(() => document.querySelector<HTMLSelectElement>(".filter-panel select")?.focus(), 0); };

  const nextCursor = res.data?.next_page ? new URL(res.data.next_page, window.location.origin).searchParams.get("starting_after") : null;
  const page = trail.length + 1;
  const customerUrl = (id: string) => `/projects/${pid}/customers/${encodeURIComponent(id)}`;
  const to = (r: Row) => customerUrl(r.id);
  const open = (id: string) => (e: MouseEvent) => { e.stopPropagation(); nav(customerUrl(id)); };
  const s = res.data?.summary;
  const listName = BUILT_IN.find((b) => b.id === list)?.label ?? audiences.data?.find((a) => a.id === list)?.name ?? "Audience";
  const unknownList = res.isError && (res.error as { status?: number }).status === 404;

  const cols: Column<Row>[] = [
    { key: "id", header: "Customer", sort: sortOf("id"),
      // A toggle button keeps one name; aria-pressed says whether IDs are hidden.
      headerExtra: <button type="button" className="th-toggle" aria-pressed={hideIds} onClick={toggleHide} title="Hide app user IDs" aria-label="Hide app user IDs"><Icon name={hideIds ? "eyeoff" : "eye"} /></button>,
      // Hidden: a button, not a link, so the browser's link preview cannot show the ID in the URL.
      render: (r) => hideIds ? (
      <span className="idcell" style={{ maxWidth: 220 }}>
        <button type="button" className="masked" aria-label="Open customer (ID hidden)" onClick={open(r.id)}>••••••••••</button>
      </span>
    ) : (
      <span className="idcell" style={{ maxWidth: 220, flexDirection: "column", alignItems: "flex-start" }}>
        <span className="hrow" style={{ flexWrap: "nowrap", maxWidth: "100%" }}>
          <Link to={to(r)} title={r.id} className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }} onClick={(e) => e.stopPropagation()}>{isAnonymous(r.id) ? shortId(r.id) : r.id}</Link>
          {isAnonymous(r.id) && <span className="soon" title="Anonymous ID created by the SDK before log in">ANON</span>}
        </span>
        {r.email && <span className="cellsub" style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{r.email}</span>}
      </span>
    ) },
    // Below 1400px Auto-renewal and First seen move under Subscription status and Last seen, so the table fits from 1024px
    // up without scrolling sideways; wider screens show every column, each sortable.
    { key: "st", header: "Subscription status", className: "w2", sort: sortOf("subscription_status"), render: (r) => <><Tag tone={STATUS[r.subscription_status].tone}>{STATUS[r.subscription_status].label}</Tag>
      {r.auto_renewal_status && <span className="cellsub c-narrow">Auto-renewal {r.auto_renewal_status === "on" ? "on" : <span className="down">off</span>}</span>}</> },
    { key: "ar", header: "Auto-renewal", className: "c-wide", sort: sortOf("auto_renewal_status"), render: (r) => r.auto_renewal_status === "on" ? "On" : r.auto_renewal_status === "off" ? <span className="down">Off</span> : <span className="subtle">—</span> },
    { key: "first", header: "First seen", className: "c-wide", sort: sortOf("first_seen_at"), render: (r) => <span className="subtle" title={fmt.dateTime(r.first_seen_at)}>{fmt.date(r.first_seen_at)}</span> },
    { key: "last", header: "Last seen", className: "w2", sort: sortOf("last_seen_at"), render: (r) => <><span className="subtle" title={fmt.dateTime(r.last_seen_at)}>{relative(r.last_seen_at)}</span><span className="cellsub c-narrow" title={fmt.dateTime(r.first_seen_at)}>First {fmt.date(r.first_seen_at)}</span></> },
    { key: "spent", header: "Spent", align: "right", sort: sortOf("spent_in_usd"), render: (r) => money(r.spent_in_usd) },
    { key: "lp", header: "Latest purchase", className: "w2", render: (r) => r.latest_purchase ? (
      <span><span className="mono" style={{ fontSize: 12 }}>{r.latest_purchase.product_id}</span>
        <span className="cellsub">{relative(r.latest_purchase.purchased_at)} · {storeLabel(r.latest_purchase.store)}{r.latest_purchase.environment === "sandbox" ? <span className="sbx" style={{ marginLeft: 4 }}>Sandbox</span> : null}</span></span>
    ) : <span className="subtle">—</span> },
  ];

  return (
    <Shell title="Customers">
      <div className="page">
        <PageHead title="Customers" sub="Everyone who has opened your app with the SDK, most recently seen first. Click a column to sort by it. Pick a list, filter it, save it as an audience or export it." />
        <div className="integ cust">
          <nav className="rail" aria-label="Customer lists">
            {BUILT_IN.map((b) => <button key={b.id} type="button" aria-pressed={list === b.id} onClick={() => pickList(b.id)}>{b.label}</button>)}
            <span className="label">Audiences</span>
            {(audiences.data ?? []).map((a) => <button key={a.id} type="button" aria-pressed={list === a.id} onClick={() => pickList(a.id)} title={describeRules(a.rules)}><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span></button>)}
            <button type="button" className="rail-new" onClick={newAudience}><Icon name="plus" />New audience</button>
          </nav>

          <div className="stack" style={{ minWidth: 0 }}>
            <section className="kpis" aria-label={`${listName} summary`}>
              {[["Customers", s ? fmt.int(s.customers) : null], ["Trialing subscribers", s ? fmt.int(s.trialing_subscribers) : null], ["Paid subscribers", s ? fmt.int(s.paid_subscribers) : null], ["Total revenue", s ? money(s.total_revenue_in_usd) : null]].map(([label, v]) => (
                <div key={label} className="kpi" data-kpi={label}><div className="lab">{label}</div>{v === null ? <span className="sk num" /> : s?.is_counting ? <div className="v subtle" style={{ fontSize: 20, lineHeight: "36px" }}>Counting…</div> : <div className="v" style={{ fontSize: 28, lineHeight: "36px" }}>{v}</div>}</div>
              ))}
            </section>
            {countNote(s?.is_counting, s?.counted_at) && <p className="subtle" style={{ margin: "-8px 0 0", fontSize: 12 }} data-testid="count-note">{countNote(s?.is_counting, s?.counted_at)}</p>}

            <div className="filterbar">
              <form role="search" onSubmit={search}>
                <label className="isearch"><Icon name="search" /><span className="sr">Search customers</span><input placeholder="App user ID, email or store transaction ID" value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
                <button type="submit" className="btn btn-dark">Search</button>
                {q && <button type="button" className="btn btn-ghost" onClick={() => setParams({ q: null })}>Clear</button>}
              </form>
              <button type="button" className="btn btn-line" aria-expanded={filterOpen} aria-controls="cust-filter" onClick={() => setFilterOpen(!filterOpen)}>
                <Icon name="funnels" />Filter{applied.groups.length > 0 && <span className="soon" style={{ marginLeft: 0 }} aria-hidden data-testid="filter-count">{applied.groups.reduce((n, g) => n + g.conditions.length, 0)}</span>}
              </button>
              <button type="button" className="btn btn-line" onClick={() => setSaving(true)}>Save audience</button>
              <button type="button" className="btn btn-line" disabled={exporting} onClick={() => void exportCsv()}><Icon name="docs" />{exporting ? "Exporting…" : "Export all"}</button>
            </div>
            {filterOpen && (
              <div id="cust-filter" className="panel pb filter-panel stack tight">
                <ConditionBuilder value={groups} onChange={setGroups} emptyText="No conditions yet. Add one to narrow the list." suggestions={suggestions.data} />
                {filterErr && <div className="banner err" role="alert">{filterErr}</div>}
                <div className="hrow">
                  <button type="button" className="btn btn-dark" onClick={apply}>Apply filter</button>
                  {(groups.length > 0 || applied.groups.length > 0) && <button type="button" className="btn btn-ghost" onClick={clearFilter}>Clear filter</button>}
                  {applied.groups.length > 0 && <span className="subtle" style={{ fontSize: 12 }}>Showing: {describeRules(applied)}</span>}
                </div>
              </div>
            )}

            {unknownList ? (
              <EmptyState title="This audience no longer exists" text="It may have been deleted in Targeting." action={<button type="button" className="btn btn-line" onClick={() => pickList("all")}>Show all customers</button>} />
            ) : res.isError ? (
              <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>Could not load customers: {errMsg(res.error)}</span><button type="button" className="btn btn-line" onClick={() => res.refetch()}>Retry</button></div>
            ) : res.isLoading || !res.data ? (
              <div className="panel" aria-busy="true"><div className="pb" style={{ display: "grid", gap: 18 }}>{Array.from({ length: 6 }, (_, i) => <span key={i} className="sk line" style={{ width: `${95 - i * 7}%` }} />)}</div></div>
            ) : (
              <>
                <div aria-busy={res.isFetching} style={{ opacity: res.isPlaceholderData ? 0.6 : 1, transition: "opacity var(--fast) var(--ease)", pointerEvents: res.isPlaceholderData ? "none" : undefined }}>
                  <DataTable columns={cols} rows={res.data.items} rowKey={(r) => r.customer_uuid} onRowClick={(r) => nav(to(r))}
                    empty={q ? (
                      exact.data ? (
                        <EmptyState title={hideIds ? `"${q}" belongs to a customer` : `"${q}" belongs to ${exact.data.id}`} text="This customer is not in the current list, but the search matches their app user ID, an alias, their email or a whole store transaction ID."
                          action={hideIds ? <button type="button" className="btn btn-dark" onClick={open(exact.data.id)}>Open customer</button> : <Link className="btn btn-dark" to={customerUrl(exact.data.id)}>Open customer</Link>} />
                      ) : (
                        <EmptyState title={`No customer matches "${q}"`} text="Search matches part of an app user ID or an email saved as $email, or a whole store transaction ID." action={<button type="button" className="btn btn-line" onClick={() => setParams({ q: null })}>Clear search</button>} />
                      )
                    ) : after ? (
                      <EmptyState title="No more customers" text="You reached the end of the list." action={<button type="button" className="btn btn-line" onClick={() => setParams({})}>Back to the first page</button>} />
                    ) : applied.groups.length || list !== "all" ? (
                      <EmptyState title="Nobody in this list" text={applied.groups.length ? "No customer matches the filter. Change or clear it."
                        : list === "active" || list === "expired" || list === "non_subscription" ? "This list counts production purchases only. Test Store and other sandbox buyers are in the Sandbox list."
                        : "No customer matches this list yet."} />
                    ) : (
                      <EmptyState title="No customers yet" text="A customer appears the first time your app calls RevenueDot through the SDK, or when you make a test purchase from the Overview." action={<Link className="btn btn-dark" to={`/projects/${pid}/overview`}>Open the setup checklist</Link>} />
                    )} />
                </div>
                {(page > 1 || nextCursor) && res.data.items.length > 0 && (
                  <nav className="pager" aria-label="Pages">
                    <button type="button" className="btn btn-line" disabled={!after} onClick={() => go(trail[trail.length - 1] ?? null, true)}>← Previous</button>
                    <span className="subtle mono" style={{ fontSize: 12 }} aria-live="polite">{after && !trail.length ? "" : `Page ${page}`}</span>
                    <button type="button" className="btn btn-line" disabled={!nextCursor} onClick={() => go(nextCursor)}>Next →</button>
                  </nav>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {saving && <SaveAudienceDialog pid={pid} rules={combined(list, audiences.data ?? [], applied)} listNote={BUILT_IN.find((b) => b.id === list)?.note} hasSearch={!!q}
        onClose={() => setSaving(false)} onSaved={async (a) => { await qc.invalidateQueries({ queryKey: ["audiences", pid] }); clearFilter(); setFilterOpen(false); toast(`Audience "${a.name}" saved`); setParams({ list: a.id }); }} />}
    </Shell>
  );
}

function SaveAudienceDialog({ pid, rules, listNote, hasSearch, onClose, onSaved }: { pid: string; rules: Rules; listNote?: string; hasSearch: boolean; onClose: () => void; onSaved: (a: Audience) => Promise<void> }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tooMany = rules.groups.length > MAX_GROUPS;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (tooMany) return;
    if (!name.trim()) { setErr("Name the audience."); return; }
    setBusy(true); setErr(null);
    try { const a = await api<Audience>(`${v2(pid)}/audiences`, { method: "POST", json: { name: name.trim(), rules } }); await onSaved(a); onClose(); }
    catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title="Save audience" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="save-aud" className="btn btn-dark" disabled={busy || tooMany}>{busy ? "Saving…" : "Save audience"}</button>
    </>}>
      <form id="save-aud" onSubmit={submit} noValidate className="stack tight">
        <Field label="Name" htmlFor="save-aud-name"><input id="save-aud-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Lapsed in the US" /></Field>
        <div><div className="label">Conditions</div><p style={{ margin: "4px 0 0", fontSize: 13 }}>{describeRules(rules)}</p></div>
        {listNote && <p className="subtle" style={{ margin: 0, fontSize: 12 }}>The list is saved as a condition: {listNote}.</p>}
        {hasSearch && <p className="subtle" style={{ margin: 0, fontSize: 12 }}>The search text is not part of the audience.</p>}
        <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Audiences also work in Targeting, Experiments and Win-back.</p>
        {tooMany && <div className="banner err" role="alert">This list and filter combine into {rules.groups.length} groups of conditions; an audience holds at most {MAX_GROUPS}. Use fewer "or" groups.</div>}
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
