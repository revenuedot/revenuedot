/**
 * Lifecycle / Support: /projects/:projectId/lifecycle/support?tab=integrations|customer_center|tickets[&ticket=id]
 * RevenueCat's Support page has Integrations (Intercom, Zendesk) and the Customer Center's support settings; RevenueDot
 * adds the ticket list, because Customer Center tickets are stored and emailed by RevenueDot itself.
 * API: GET/POST /customer_center_config (support.email, support.support_tickets), GET /support_tickets, POST /support_tickets/{id},
 * and for help desks GET /customers/{id}/support_summary and GET /support_summaries?email= with a secret key.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Check, CodeBlock, DataTable, EmptyState, Field, KeyValue, PageHead, Panel, Segmented, Tabs, Tag, useProjectId, useToast } from "../../components/ui";
import { errMsg, v2 } from "../catalog/lib";
import { relative } from "../../lib/customers";
import type { SupportTicket } from "./lib";

type Tab = "integrations" | "customer_center" | "tickets";
const GUIDE = "https://revenuedot.app/docs/guides/support-integrations";

export function SupportPage() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("tab");
  const tab: Tab = raw === "customer_center" || raw === "tickets" || raw === "integrations" ? raw : sp.get("ticket") ? "tickets" : "integrations";
  const go = (t: Tab) => { const n = new URLSearchParams(); n.set("tab", t); setSp(n, { replace: true }); };
  return (
    <Shell title="Support">
      <div className="page">
        <PageHead title="Support" sub="Give your support team each customer's subscription details, and receive the tickets customers send from the Customer Center." />
        <Tabs label="Support" idBase="support" value={tab} onChange={go} tabs={[{ value: "integrations", label: "Integrations" }, { value: "customer_center", label: "Customer Center" }, { value: "tickets", label: "Tickets" }]} />
        <div role="tabpanel" id={`support-${tab}-panel`} aria-labelledby={`support-${tab}`} className="stack">
          {tab === "integrations" ? <Integrations /> : tab === "customer_center" ? <TicketSettings /> : <Tickets />}
        </div>
      </div>
    </Shell>
  );
}

function Integrations() {
  const pid = useProjectId();
  const origin = window.location.origin;
  const curl = `# By email: what Intercom and Zendesk know about a customer
curl "${origin}/v2/projects/${pid}/support_summaries?email=jane%40example.com" \\
  -H "Authorization: Bearer $REVENUEDOT_SECRET_KEY"

# By app user ID
curl "${origin}/v2/projects/${pid}/customers/USER_ID/support_summary" \\
  -H "Authorization: Bearer $REVENUEDOT_SECRET_KEY"`;
  return (
    <>
      <p className="section-sub">Show a customer's subscription status, entitlements, total spent, refunds and open tickets next to the conversation in your help desk.</p>
      <div className="cards">
        <div className="card">
          <div className="card-h"><span className="mono-tile">IC</span><b>Intercom</b></div>
          <p>Subscription data in the Intercom inbox: status, plan, renewal date, total spent and a link to the customer in RevenueDot, looked up by the contact's email.</p>
          <a className="btn btn-line" style={{ alignSelf: "flex-start" }} href={GUIDE} target="_blank" rel="noreferrer">Read the guide</a>
        </div>
        <div className="card">
          <div className="card-h"><span className="mono-tile">ZD</span><b>Zendesk</b></div>
          <p>A ticket sidebar app that shows the requester's entitlements, subscriptions, refunds and open Customer Center tickets.</p>
          <a className="btn btn-line" style={{ alignSelf: "flex-start" }} href={GUIDE} target="_blank" rel="noreferrer">Read the guide</a>
        </div>
      </div>
      <Panel title="Help desk endpoint">
        <div className="stack tight">
          <p className="section-sub">Both integrations call this endpoint with a secret API key that has the <code>customer_information:customers:read</code> permission. <Link className="link-u" to={`/projects/${pid}/api-keys`}>Create a key</Link>. Never put the key in an app.</p>
          <CodeBlock code={curl} label="Support summary" />
        </div>
      </Panel>
    </>
  );
}

const DETAILS: [string, string][] = [
  ["appUserId", "App user ID"], ["activeEntitlements", "Active entitlements"], ["country", "Country"], ["lastSeenAppVersion", "App version"],
  ["totalSpent", "Total spent"], ["userSince", "Customer since"], ["lastOpened", "Last opened"], ["deviceVersion", "Device"],
  ["email", "Email on file"], ["ipAddress", "IP address"], ["idfa", "IDFA"], ["idfv", "IDFV"], ["attConsent", "Tracking consent (ATT)"],
];
const DEFAULT_DETAILS: Record<string, boolean> = { appUserId: true, activeEntitlements: true, country: true, lastSeenAppVersion: true, totalSpent: true, userSince: true, lastOpened: true, deviceVersion: true };
type Cfg = Record<string, any>;

function TicketSettings() {
  const pid = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["customer-center", pid], enabled: !!pid, queryFn: () => api<{ customer_center: Cfg; overrides: Cfg | null }>(`${v2(pid)}/customer_center_config`) });
  const [email, setEmail] = useState("");
  const [allow, setAllow] = useState(true);
  const [who, setWho] = useState("all");
  const [details, setDetails] = useState<Record<string, boolean>>(DEFAULT_DETAILS);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const s = q.data?.customer_center?.support;
    if (!s) return;
    setEmail(s.email ?? "");
    const t = s.support_tickets;
    setAllow(t ? t.allow_creation === true : true);
    setWho(t?.customer_type ?? "all");
    setDetails({ ...DEFAULT_DETAILS, ...(t?.customer_details ?? {}) });
  }, [q.data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setErr("Enter the email address tickets should go to."); return; }
    setBusy(true); setErr(null);
    const o = q.data?.overrides ?? {};
    const overrides = { ...o, support: { ...(o.support ?? {}), email: email.trim(), support_tickets: { allow_creation: allow, customer_type: who, customer_details: Object.fromEntries(DETAILS.map(([k]) => [k, !!details[k]])) } } };
    try { await api(`${v2(pid)}/customer_center_config`, { method: "POST", json: { customer_center: overrides } }); await qc.invalidateQueries({ queryKey: ["customer-center", pid] }); toast("Support settings saved"); }
    catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  }
  if (q.isError) return <div className="banner err" role="alert">The Customer Center settings could not be loaded: {errMsg(q.error)}</div>;
  if (q.isLoading) return <div className="panel pb" aria-busy="true"><span className="sk line" /></div>;
  const off = !allow;
  return (
    <form className="panel pb stack" onSubmit={save} noValidate style={{ maxWidth: 880 }}>
      <Field label="Support email" htmlFor="sup-email" hint="Tickets are emailed here, with Reply-To set to the customer. The Contact support button in the Customer Center uses it too.">
        <input id="sup-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 420 }} />
      </Field>
      <Check checked={allow} onChange={setAllow} label="Let customers create tickets" hint="The Customer Center shows a form instead of opening the customer's mail app. RevenueDot stores each ticket and emails it to you." />
      <Field label="Who can create tickets" htmlFor="sup-who">
        <select id="sup-who" className="select" style={{ maxWidth: 420 }} disabled={off} value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="all">All customers</option><option value="active">Customers with an active subscription</option>
          <option value="not_active">Customers without an active subscription</option><option value="none">Nobody</option>
        </select>
      </Field>
      <fieldset className="cond-g" style={{ alignItems: "stretch" }} disabled={off}>
        <legend>Customer details in the ticket email</legend>
        <div className="checks">{DETAILS.map(([k, label]) => <Check key={k} checked={!!details[k]} disabled={off} onChange={(v) => setDetails({ ...details, [k]: v })} label={label} />)}</div>
      </fieldset>
      {err && <div className="banner err" role="alert">{err}</div>}
      <div className="hrow"><button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button><Link className="btn btn-ghost" to={`/projects/${pid}/lifecycle/customer-center`}>All Customer Center settings</Link></div>
    </form>
  );
}

function Tickets() {
  const pid = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [status, setStatus] = useState<"open" | "closed" | "all">("open");
  const selectedId = sp.get("ticket");
  const q = useInfiniteQuery({
    queryKey: ["support-tickets", pid, status], enabled: !!pid, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<List<SupportTicket>>(`${v2(pid)}/support_tickets?status=${status}&limit=100${pageParam ? `&starting_after=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.next_page ? new URL(last.next_page, window.location.origin).searchParams.get("starting_after") : null),
    placeholderData: (p) => p,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  // A ticket linked from its email may be older than the loaded pages: load it by id.
  const one = useQuery({ queryKey: ["support-ticket", pid, selectedId], enabled: !!selectedId && !rows.some((t) => t.id === selectedId), retry: false,
    queryFn: () => api<SupportTicket>(`${v2(pid)}/support_tickets/${encodeURIComponent(selectedId!)}`) });
  const sel = rows.find((t) => t.id === selectedId) ?? one.data ?? null;
  const pick = (t: SupportTicket | null) => { const n = new URLSearchParams(sp); n.set("tab", "tickets"); if (t) n.set("ticket", t.id); else n.delete("ticket"); setSp(n, { replace: true }); };
  const setTicket = async (t: SupportTicket, next: "open" | "closed") => {
    try {
      await api(`${v2(pid)}/support_tickets/${t.id}`, { method: "POST", json: { status: next } });
      await qc.invalidateQueries({ queryKey: ["support-tickets", pid] }); await qc.invalidateQueries({ queryKey: ["support-ticket", pid] });
      toast(next === "closed" ? "Ticket closed" : "Ticket reopened");
    } catch (e) { toast(errMsg(e)); }
  };
  const custLink = (t: SupportTicket) => <Link className="mono" style={{ fontSize: 12 }} to={`/projects/${pid}/customers/${encodeURIComponent(t.app_user_id)}`} onClick={(e) => e.stopPropagation()}>{t.app_user_id}</Link>;
  return (
    <>
      <div className="hrow between">
        <Segmented label="Ticket status" value={status} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }]} />
        <span className="subtle" style={{ fontSize: 12 }}>Customers send tickets from the Customer Center in your app.</span>
      </div>
      {q.isError ? <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>Tickets could not be loaded: {errMsg(q.error)}</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>
        : q.isLoading ? <div className="panel pb" aria-busy="true"><span className="sk line" /></div> : (
        <div className={sel ? "two" : undefined}>
          <div style={{ minWidth: 0, opacity: q.isPlaceholderData ? 0.6 : 1 }}>
            <DataTable rowKey={(t) => t.id} rows={rows} onRowClick={(t) => pick(t)}
              empty={<EmptyState title={status === "closed" ? "No closed tickets" : status === "open" ? "No open tickets" : "No tickets yet"} text="Turn on ticket creation in the Customer Center tab. Tickets customers send appear here and are emailed to your support address." />}
              columns={[
                // With a ticket open beside the table, the panel has the address and the Close button.
                { key: "d", header: "Date", render: (t) => <span className="subtle" title={fmt.dateTime(t.created_at)}>{relative(t.created_at)}</span> },
                { key: "e", header: "Customer", render: (t) => <span>{t.customer_email}<span className="cellsub">{custLink(t)}</span></span> },
                { key: "m", header: "Message", className: "wrap", render: (t) => <span className="excerpt">{t.description}</span> },
                ...(sel ? [] : [{ key: "to", header: "Emailed to", render: (t: SupportTicket) => t.emailed_to ? <span className="muted">{t.emailed_to}{!t.emailed && <span className="cellsub down">Not delivered</span>}</span> : <span className="subtle" title="No support email was set">—</span> }]),
                { key: "s", header: "Status", render: (t) => <Tag tone={t.status === "open" ? "info" : "muted"}>{t.status === "open" ? "Open" : "Closed"}</Tag> },
                ...(sel ? [] : [{ key: "a", header: "", align: "right" as const, render: (t) => <button type="button" className="btn btn-line" aria-label={`${t.status === "open" ? "Close" : "Reopen"} ticket from ${t.customer_email}`} onClick={(e) => { e.stopPropagation(); void setTicket(t, t.status === "open" ? "closed" : "open"); }}>{t.status === "open" ? "Close" : "Reopen"}</button> }]),
              ]} />
            {q.hasNextPage && <div className="hrow" style={{ marginTop: 12 }}><button type="button" className="btn btn-line" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Show older tickets"}</button></div>}
            {one.isError && selectedId && <div className="banner err" role="alert" style={{ marginTop: 12 }}>Ticket {selectedId} could not be loaded: {errMsg(one.error)}</div>}
          </div>
          {sel && (
            <Panel title="Ticket" link={<button type="button" className="linkbtn" onClick={() => pick(null)}>Close panel</button>}>
              <div className="stack">
                <p className="ticket-msg" aria-label="Full message">{sel.description}</p>
                <KeyValue rows={[
                  ["From", sel.customer_email], ["App user ID", custLink(sel)], ["Received", fmt.dateTime(sel.created_at)],
                  ["Emailed to", sel.emailed_to ? `${sel.emailed_to}${sel.emailed ? "" : " (not delivered)"}` : "No support email set"],
                  ["Status", sel.status === "open" ? "Open" : `Closed ${sel.closed_at ? fmt.dateTime(sel.closed_at) : ""}`],
                ]} />
                <div className="hrow">
                  <a className="btn btn-dark" href={`mailto:${encodeURIComponent(sel.customer_email)}?subject=${encodeURIComponent("Re: your support request")}`}>Reply by email</a>
                  <button type="button" className="btn btn-line" onClick={() => void setTicket(sel, sel.status === "open" ? "closed" : "open")}>{sel.status === "open" ? "Close ticket" : "Reopen ticket"}</button>
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
