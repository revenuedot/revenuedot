/*
 * Customers: search and browse. Data: GET /v2/projects/{id}/customers (RevenueCat's list and exact-match search,
 * newest first) plus our /customer_summaries extension for revenue and entitlement names per row.
 *
 * GAPS versus RevenueCat's customer list (not captured in the contact sheets; from its docs):
 * - Customer lists and filters (by entitlement, country, store, attribute): later tier (Audiences).
 * - CSV export of the list: later tier (scheduled exports).
 * - Search matches whole values only (app user ID, $email, store transaction ID), like RevenueCat's API search.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "../components/Shell";
import { Icon } from "../components/icons";
import { DataTable, EmptyState, PageHead, Tag, useProjectId, type Column } from "../components/ui";
import { api, fmt, type List } from "../lib/api";
import { flag, isAnonymous, money, relative, type Customer, type CustomerSummary } from "../lib/customers";

const LIMIT = 25;

export function Customers() {
  const pid = useProjectId();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const q = sp.get("q")?.trim() ?? "";
  const after = sp.get("after");
  const [draft, setDraft] = useState(q);
  // Cursors of the pages before this one, so "Previous" works without the API paging backwards.
  const [trail, setTrail] = useState<(string | null)[]>([]);
  useEffect(() => { setDraft(q); }, [q]);
  useEffect(() => { if (!after) setTrail([]); }, [after]);

  const qs = new URLSearchParams({ limit: String(LIMIT) });
  if (q) qs.set("search", q);
  if (after) qs.set("starting_after", after);
  const list = useQuery({ queryKey: ["customers", pid, q, after], queryFn: () => api<List<Customer>>(`/v2/projects/${pid}/customers?${qs}`), placeholderData: (p) => p });
  const ids = list.data?.items.map((c) => c.id) ?? [];
  const summaries = useQuery({
    queryKey: ["customer_summaries", pid, ids], enabled: ids.length > 0,
    queryFn: () => api<List<CustomerSummary>>(`/v2/projects/${pid}/customer_summaries?ids=${ids.map(encodeURIComponent).join(",")}`),
  });
  const sum = new Map(summaries.data?.items.map((s) => [s.id, s]) ?? []);

  const search = (e: FormEvent) => {
    e.preventDefault();
    const n = new URLSearchParams();
    if (draft.trim()) n.set("q", draft.trim());
    setSp(n);
  };
  const go = (cursor: string | null, back = false) => {
    const n = new URLSearchParams(sp);
    if (cursor) n.set("after", cursor); else n.delete("after");
    setTrail((t) => (back ? t.slice(0, -1) : [...t, after]));
    setSp(n);
  };
  const nextCursor = list.data?.next_page ? new URL(list.data.next_page, window.location.origin).searchParams.get("starting_after") : null;
  const page = trail.length + 1;
  const to = (c: Customer) => `/projects/${pid}/customers/${encodeURIComponent(c.id)}`;

  const cols: Column<Customer>[] = [
    { key: "id", header: "App user ID", render: (c) => (
      <span className="idcell" style={{ maxWidth: 300 }}>
        <Link to={to(c)} title={c.id} className="mono" style={{ fontSize: 12 }} onClick={(e) => e.stopPropagation()}>{c.id}</Link>
        {isAnonymous(c.id) && <span className="soon" style={{ marginLeft: 8 }} title="Anonymous ID created by the SDK before log in">ANON</span>}
      </span>
    ) },
    { key: "country", header: "Country", render: (c) => {
      const cc = sum.get(c.id)?.country ?? c.last_seen_country;
      return cc ? <span><span className="flag" aria-hidden>{flag(cc)}</span>{cc.toUpperCase()}</span> : <span className="subtle">—</span>;
    } },
    { key: "platform", header: "Platform", render: (c) => <span className="muted">{c.last_seen_platform ? (c.last_seen_platform.toLowerCase() === "ios" ? "iOS" : c.last_seen_platform[0]!.toUpperCase() + c.last_seen_platform.slice(1)) : "—"}{c.last_seen_app_version && <span className="subtle mono" style={{ marginLeft: 6, fontSize: 12 }}>{c.last_seen_app_version}</span>}</span> },
    { key: "ents", header: "Active entitlements", render: (c) => {
      const s = sum.get(c.id);
      if (!s) return summaries.isLoading ? <span className="sk line" style={{ width: 60 }} /> : <span className="subtle">—</span>;
      return s.active_entitlements.length ? <span className="ents">{s.active_entitlements.map((e) => <Tag key={e.entitlement_id} tone={e.source === "promotional" ? "gold" : "up"}>{e.lookup_key}</Tag>)}</span> : <span className="subtle">None</span>;
    } },
    { key: "rev", header: "Revenue", align: "right", render: (c) => {
      const s = sum.get(c.id);
      if (!s) return summaries.isLoading ? <span className="sk line" style={{ width: 50, marginLeft: "auto" }} /> : "—";
      if (!s.total_revenue_in_usd && s.sandbox_revenue_in_usd) return <span className="sbx" title="Sandbox purchases only: not counted as revenue">{money(s.sandbox_revenue_in_usd)}</span>;
      return money(s.total_revenue_in_usd);
    } },
    { key: "first", header: "First seen", render: (c) => <span className="subtle" title={fmt.dateTime(c.first_seen_at)}>{fmt.date(c.first_seen_at)}</span> },
    { key: "last", header: "Last seen", render: (c) => <span className="subtle" title={fmt.dateTime(c.last_seen_at)}>{relative(c.last_seen_at)}</span> },
  ];

  return (
    <Shell title="Customers">
      <div className="page">
        <PageHead title="Customers" sub="Everyone who has opened your app with the SDK, newest first. Open a customer to see purchases, entitlements and history." />
        <form className="searchbar" role="search" onSubmit={search}>
          <label htmlFor="cust-q" className="sr">Search customers</label>
          <input id="cust-q" className="input mono" placeholder="App user ID, email or store transaction ID" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="btn btn-dark"><Icon name="search" />Search</button>
          {q && <button type="button" className="btn btn-ghost" onClick={() => setSp(new URLSearchParams())}>Clear</button>}
        </form>
        {q && <p className="subtle" style={{ margin: "-12px 0 0", fontSize: 12 }}>Searching whole values: an exact app user ID or alias, an email saved as the $email attribute, or a store transaction ID.</p>}

        {list.isError ? (
          <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>Could not load customers: {(list.error as Error).message}.</span><button type="button" className="btn btn-line" onClick={() => list.refetch()}>Retry</button></div>
        ) : list.isLoading ? (
          <div className="panel" aria-busy="true"><div className="pb" style={{ display: "grid", gap: 18 }}>{Array.from({ length: 6 }, (_, i) => <span key={i} className="sk line" style={{ width: `${95 - i * 7}%` }} />)}</div></div>
        ) : (
          <>
            <div aria-busy={list.isFetching} style={{ opacity: list.isPlaceholderData ? 0.6 : 1, transition: "opacity var(--fast) var(--ease)" }}>
              <DataTable columns={cols} rows={list.data!.items} rowKey={(c) => c.id} onRowClick={(c) => nav(to(c))}
                empty={q ? (
                  <EmptyState title={`No customer matches "${q}"`} text="Search needs the whole value: a full app user ID, an email address saved as $email, or a store transaction ID. Partial matches are not supported." action={<button type="button" className="btn btn-line" onClick={() => setSp(new URLSearchParams())}>Clear search</button>} />
                ) : after ? (
                  <EmptyState title="No more customers" text="You reached the end of the list." action={<button type="button" className="btn btn-line" onClick={() => setSp(new URLSearchParams())}>Back to the first page</button>} />
                ) : (
                  <EmptyState title="No customers yet" text="A customer appears the first time your app calls RevenueDot through the SDK, or when you make a test purchase from the Overview." action={<Link className="btn btn-dark" to={`/projects/${pid}/overview`}>Open the setup checklist</Link>} />
                )} />
            </div>
            {list.data!.items.some((c) => { const x = sum.get(c.id); return x && !x.total_revenue_in_usd && x.sandbox_revenue_in_usd; }) && (
              <p className="subtle" style={{ margin: "-12px 0 0", fontSize: 12 }}><span className="sbx">Blue amounts</span> are sandbox purchases. They are not counted as revenue.</p>
            )}
            {(page > 1 || nextCursor) && list.data!.items.length > 0 && (
              <nav className="pager" aria-label="Pages">
                <button type="button" className="btn btn-line" disabled={!after} onClick={() => go(trail[trail.length - 1] ?? null, true)}>← Previous</button>
                <span className="subtle mono" style={{ fontSize: 12 }} aria-live="polite">{after && !trail.length ? "" : `Page ${page}`}</span>
                <button type="button" className="btn btn-line" disabled={!nextCursor} onClick={() => go(nextCursor)}>Next →</button>
              </nav>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
