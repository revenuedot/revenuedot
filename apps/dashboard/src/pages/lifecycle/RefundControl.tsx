/**
 * Lifecycle / Refund Control: /projects/:projectId/lifecycle/refund-control
 * Policies decide how RevenueDot answers Apple's refund requests (consumption information, CONSUMPTION_REQUEST) within
 * Apple's 12-hour window; Google refunds and chargebacks are recorded for the cards. RevenueCat's flow: three cards,
 * four policy templates, an ordered list of policies (drag, or Move up / Move down), the default policy, Save / Cancel.
 * API: GET/POST /refund_control, GET /refund_control/stats, GET /refund_requests.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Check, DataTable, EmptyState, PageHead, Panel, Segmented, Tag, useProjectId, useToast } from "../../components/ui";
import { ConditionBuilder, fromRules, incomplete, toRules, type Groups } from "../../components/conditions";
import { money, relative, storeLabel } from "../../lib/customers";
import { errMsg, v2 } from "../catalog/lib";
import { PREFERENCES, pct, preferenceLabel, type Preference, type RefundControl, type RefundRequest, type RefundStats, type Template } from "./lib";

interface Draft { key: string; id?: string; name: string; template: Template; groups: Groups; preference: Preference; count: number | null }
interface State { consented: boolean; defaultPref: Preference; policies: Draft[] }

const TEMPLATES: { t: Template; title: string; text: string; icon: string; name: string }[] = [
  { t: "first_purchase_date", title: "First purchase date", text: "Set refund policies based on how long someone has been a customer.", icon: "hourglass", name: "First purchase date" },
  { t: "platform", title: "Platform", text: "Set policies based on the platform where the purchase was made.", icon: "apps", name: "Platform" },
  { t: "recent_renewal", title: "Recent renewal", text: "Set policies for customers who renewed or converted from a free trial in the last 24 hours.", icon: "refresh", name: "Recent renewal" },
  { t: "custom", title: "Create your own", text: "Build a custom policy using any customer condition.", icon: "edit", name: "Custom policy" },
];

const ANSWER: Record<string, { label: string; tone: "up" | "down" | "info" | "muted" }> = {
  sent: { label: "Sent", tone: "up" }, pending: { label: "Pending", tone: "info" }, skipped: { label: "Skipped", tone: "muted" },
  failed: { label: "Failed", tone: "down" }, expired: { label: "Expired", tone: "down" }, not_applicable: { label: "No answer needed", tone: "muted" },
  not_requested: { label: "Not asked", tone: "muted" },
};
const OUTCOME: Record<string, { label: string; tone: "up" | "down" | "muted" }> = { approved: { label: "Refunded", tone: "down" }, declined: { label: "Declined", tone: "up" }, pending: { label: "Waiting", tone: "muted" } };

let seq = 0;
const fromServer = (d: RefundControl): State => ({
  consented: d.settings.customer_consented, defaultPref: d.settings.default_preference,
  policies: d.policies.map((p) => ({ key: p.id, id: p.id, name: p.name, template: p.template, groups: fromRules(p.rules), preference: p.preference, count: p.customer_count })),
});
const fingerprint = (s: State) => JSON.stringify({ c: s.consented, d: s.defaultPref, p: s.policies.map((p) => [p.id ?? null, p.name.trim(), p.template, p.preference, toRules(p.groups)]) });

export function RefundControlPage() {
  const pid = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["refund-control", pid], enabled: !!pid, queryFn: () => api<RefundControl>(`${v2(pid)}/refund_control`) });
  const stats = useQuery({ queryKey: ["refund-stats", pid], enabled: !!pid, queryFn: () => api<RefundStats>(`${v2(pid)}/refund_control/stats?days=28&environment=production`) });
  const reqs = useQuery({ queryKey: ["refund-requests", pid], enabled: !!pid, queryFn: () => api<List<RefundRequest>>(`${v2(pid)}/refund_requests?limit=20`) });
  const [state, setState] = useState<State | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [amountSide, setAmountSide] = useState<"declined" | "approved">("declined");
  const [countSide, setCountSide] = useState<"declined" | "approved">("declined");
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const focusKey = useRef<string | null>(null);

  // A refetch that only refreshes customer counts keeps unsaved edits; a saved change from the server replaces them.
  const serverPrint = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const next = fromServer(q.data);
    const fp = fingerprint(next);
    setState((s) => {
      const keep = !!s && serverPrint.current === fp && fingerprint(s) !== fp;
      serverPrint.current = fp;
      if (!keep) return next;
      const counts = new Map(next.policies.map((p) => [p.id, p.count]));
      return { ...s!, policies: s!.policies.map((p) => (p.id && counts.has(p.id) ? { ...p, count: counts.get(p.id)! } : p)) };
    });
  }, [q.data]);
  const dirty = useMemo(() => !!(state && q.data && fingerprint(state) !== fingerprint(fromServer(q.data))), [state, q.data]);
  useEffect(() => {
    if (!focusKey.current) return;
    const el = document.getElementById(`policy-name-${focusKey.current}`) as HTMLInputElement | null;
    if (el) { el.scrollIntoView({ block: "center" }); el.focus(); el.select(); focusKey.current = null; }
  });

  const set = (patch: Partial<State>) => setState((s) => (s ? { ...s, ...patch } : s));
  const setPolicy = (key: string, patch: Partial<Draft>) => setState((s) => (s ? { ...s, policies: s.policies.map((p) => (p.key === key ? { ...p, ...patch } : p)) } : s));
  const move = (from: number, to: number) => setState((s) => {
    if (!s || from === to || to < 0 || to >= s.policies.length) return s;
    const list = [...s.policies];
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x!);
    return { ...s, policies: list };
  });
  const add = (t: (typeof TEMPLATES)[number]) => {
    if (!state || !q.data) return;
    const key = `new-${++seq}`;
    const taken = new Set(state.policies.map((p) => p.name));
    let name = t.name;
    for (let i = 2; taken.has(name); i++) name = `${t.name} ${i}`;
    focusKey.current = key;
    set({ policies: [...state.policies, { key, name, template: t.t, groups: fromRules(q.data.templates[t.t]), preference: "consumption_only", count: null }] });
  };

  async function save() {
    if (!state) return;
    if (state.policies.some((p) => !p.name.trim())) { setErr("Every policy needs a name."); return; }
    if (state.policies.some((p) => incomplete(p.groups))) { setErr("Fill in every condition's value, or remove the condition."); return; }
    setSaving(true); setErr(null);
    try {
      const res = await api<RefundControl>(`${v2(pid)}/refund_control`, { method: "POST", json: {
        settings: { default_preference: state.defaultPref, customer_consented: state.consented },
        policies: state.policies.map((p) => ({ ...(p.id ? { id: p.id } : {}), name: p.name.trim(), template: p.template, rules: toRules(p.groups), preference: p.preference })),
      } });
      qc.setQueryData(["refund-control", pid], res);
      toast("Refund policies saved");
    } catch (e) { setErr(errMsg(e)); }
    setSaving(false);
  }
  const cancel = () => { if (q.data) setState(fromServer(q.data)); setErr(null); };

  const onDragStart = (i: number) => (e: DragEvent) => {
    setDrag(i);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
    const card = (e.currentTarget as HTMLElement).closest(".policy");
    if (card) e.dataTransfer.setDragImage(card, 24, 20);
  };
  const onDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = drag ?? Number(e.dataTransfer.getData("text/plain"));
    if (Number.isInteger(from)) move(from, i);
    setDrag(null); setOver(null);
  };

  const s = stats.data;
  const approx = q.data?.counts_are_approximate;
  const countLabel = (n: number | null) => (n === null ? "Save to count" : `${approx ? "≈" : ""}${fmt.int(n)} customer${n === 1 ? "" : "s"}`);

  return (
    <Shell title="Refund Control">
      <div className="page">
        <PageHead title="Refund Control" sub="Set policies for how RevenueDot answers Apple refund requests and records Google Play chargebacks. Pick a default answer, then tailor it for specific groups of customers." />

        <section className="kpis n3" aria-label="Refunds in the last 28 days">
          <div className="kpi">
            <div className="lab">Refund rate</div>
            {stats.isLoading ? <span className="sk num" /> : <div className="v">{pct(s?.refund_rate)}</div>}
            <div className="meta">Last 28 days{s ? ` · ${fmt.int(s.requests.approved)} of ${fmt.int(s.requests.approved + s.requests.declined)} decided requests refunded` : ""}</div>
          </div>
          <div className="kpi">
            <div className="lab">Refund request amount<Segmented label="Refund request amount" value={amountSide} onChange={setAmountSide} options={[{ value: "declined", label: "Declined" }, { value: "approved", label: "Approved" }]} /></div>
            {stats.isLoading ? <span className="sk num" /> : <div className="v" data-testid="refund-amount">{money(s?.amount_in_usd[amountSide] ?? 0)}</div>}
            <div className="meta">Last 28 days</div>
          </div>
          <div className="kpi">
            <div className="lab">Refund requests<Segmented label="Refund requests" value={countSide} onChange={setCountSide} options={[{ value: "declined", label: "Declined" }, { value: "approved", label: "Approved" }]} /></div>
            {stats.isLoading ? <span className="sk num" /> : <div className="v" data-testid="refund-count">{fmt.int(s?.requests[countSide] ?? 0)}</div>}
            <div className="meta">Last 28 days{s?.requests.pending ? ` · ${fmt.int(s.requests.pending)} waiting for Apple` : ""}</div>
          </div>
        </section>
        {stats.isError && <div className="banner err" role="alert">The refund numbers could not be loaded: {errMsg(stats.error)}</div>}

        <div className="group-h"><h2>Refund policies</h2><p>Policies are checked from top to bottom; the first one a customer matches decides the answer. Drag a policy by its handle, or use the arrows, to change the order.</p></div>
        <div className="tpls">
          {TEMPLATES.map((t) => (
            <div key={t.t} className="card">
              <div className="card-h"><span className="mono-tile"><Icon name={t.icon} /></span><b>{t.title}</b></div>
              <p>{t.text}</p>
              <button type="button" className={`btn ${t.t === "custom" ? "btn-dark" : "btn-line"}`} aria-label={`Add policy: ${t.title}`} disabled={!state} onClick={() => add(t)}>Add policy</button>
            </div>
          ))}
        </div>

        {q.isError ? (
          <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>Refund policies could not be loaded: {errMsg(q.error)}</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>
        ) : !state ? (
          <div className="panel pb" aria-busy="true"><span className="sk line" /></div>
        ) : (
          <>
            {state.policies.length > 0 && (
              <ol className="policy-list" aria-label="Policies in priority order" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {state.policies.map((p, i) => (
                  <li key={p.key} className={`policy${drag === i ? " dragging" : ""}${over === i && drag !== null && drag !== i ? " over" : ""}`}
                    onDragOver={(e) => { if (drag === null) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== i) setOver(i); }}
                    onDragLeave={() => setOver((o) => (o === i ? null : o))} onDrop={onDrop(i)} aria-label={p.name || `Policy ${i + 1}`}>
                    <div className="policy-h">
                      <span className="ib grip" draggable onDragStart={onDragStart(i)} onDragEnd={() => { setDrag(null); setOver(null); }} title="Drag to reorder" aria-hidden><Icon name="grip" /></span>
                      <span className="pos">{i + 1}</span>
                      <input id={`policy-name-${p.key}`} className="input pname" aria-label={`Policy ${i + 1} name`} value={p.name} onChange={(e) => setPolicy(p.key, { name: e.target.value })} />
                      <span className="count" title={approx ? "Counted over the 10,000 most recently seen customers" : undefined}><Icon name="customers" />{countLabel(p.count)}</span>
                      <select className="select pref" aria-label={`Refund preference for ${p.name || `policy ${i + 1}`}`} value={p.preference} onChange={(e) => setPolicy(p.key, { preference: e.target.value as Preference })}>
                        {PREFERENCES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                      </select>
                      <button type="button" className="ib" aria-label={`Move ${p.name || `policy ${i + 1}`} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="up" /></button>
                      <button type="button" className="ib" aria-label={`Move ${p.name || `policy ${i + 1}`} down`} disabled={i === state.policies.length - 1} onClick={() => move(i, i + 1)}><Icon name="down" /></button>
                      <button type="button" className="ib" aria-label={`Delete ${p.name || `policy ${i + 1}`}`} onClick={() => set({ policies: state.policies.filter((x) => x.key !== p.key) })}><Icon name="trash" /></button>
                    </div>
                    <div className="policy-b">
                      <ConditionBuilder labelPrefix={`Policy ${i + 1}`} value={p.groups} onChange={(g) => setPolicy(p.key, { groups: g })} emptyText="No conditions: this policy applies to every customer that reaches it." />
                    </div>
                  </li>
                ))}
              </ol>
            )}

            <section className="policy default" aria-label="Default policy">
              <div className="policy-h">
                <span><b>Default policy</b> <span className="subtle">(applied if a customer matches no other policy)</span><br />
                  <span className="count"><Icon name="customers" />{q.data ? countLabel(q.data.default_policy.customer_count) : "—"}</span></span>
                <label className="field" style={{ flex: "0 1 300px", minWidth: 200 }}>
                  <span className="label">Refund preference</span>
                  <select className="select" aria-label="Default refund preference" value={state.defaultPref} onChange={(e) => set({ defaultPref: e.target.value as Preference })}>
                    {PREFERENCES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </select>
                </label>
              </div>
            </section>

            <Panel title="Consumption data consent">
              <div className="stack tight">
                <Check checked={state.consented} onChange={(v) => set({ consented: v })} label="Customers agreed to share consumption data with Apple"
                  hint="Apple requires this confirmation (customerConsented) with every answer. Without it RevenueDot sends nothing to Apple and records each request as skipped." />
                {!state.consented && <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Add the consent to your terms or privacy policy before you tick this box.</p>}
              </div>
            </Panel>
            {approx && <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Customer counts look at the 10,000 most recently seen customers.</p>}
          </>
        )}

        <Panel title="Recent refund requests" flush>
          {reqs.isError ? <div className="pb"><div className="banner err" role="alert">{errMsg(reqs.error)}</div></div>
            : reqs.isLoading ? <div className="pb" aria-busy="true"><span className="sk line" /></div>
            : (
              <DataTable rowKey={(r) => r.id} rows={reqs.data?.items ?? []}
                empty={<EmptyState title="No refund requests yet" text="Requests appear when Apple asks for consumption information or a store refunds a purchase. Answers go out within Apple's 12-hour window." />}
                columns={[
                  { key: "c", header: "Customer", className: "w2", render: (r) => r.app_user_id ? <span className="idcell"><Link className="mono" style={{ fontSize: 12 }} to={`/projects/${pid}/customers/${encodeURIComponent(r.app_user_id)}`}>{r.app_user_id}</Link></span> : <span className="subtle">Unknown</span> },
                  { key: "p", header: "Product", render: (r) => <span><span className="mono" style={{ fontSize: 12 }}>{r.product_id ?? "—"}</span><span className="cellsub">{storeLabel(r.store)}{r.environment === "sandbox" ? " · Sandbox" : ""}</span></span> },
                  { key: "a", header: "Amount", align: "right", render: (r) => money(r.amount_in_usd) },
                  { key: "pol", header: "Policy", className: "w2 rq-pol", render: (r) => <span>{r.policy_name ?? <span className="subtle">—</span>}<span className="cellsub">{r.preference ? preferenceLabel(r.preference) : ""}</span></span> },
                  { key: "ans", header: "Answer", render: (r) => { const a = ANSWER[r.consumption_status] ?? { label: r.consumption_status, tone: "muted" as const }; return <span title={r.last_error ?? undefined}><Tag tone={a.tone}>{a.label}</Tag></span>; } },
                  { key: "o", header: "Outcome", render: (r) => { const o = OUTCOME[r.outcome] ?? OUTCOME.pending!; return <Tag tone={o.tone}>{o.label}</Tag>; } },
                  { key: "t", header: "Requested", render: (r) => <span className="subtle" title={fmt.dateTime(r.requested_at)}>{relative(r.requested_at)}</span> },
                ]} />
            )}
        </Panel>

        {err && <div className="banner err" role="alert">{err}</div>}
        {dirty && (
          <div className="unsaved" role="region" aria-label="Unsaved changes">
            <span>You have unsaved changes to your refund policies.</span>
            <div className="actions">
              <button type="button" className="btn btn-line" disabled={saving} onClick={cancel}>Cancel</button>
              <button type="button" className="btn btn-dark" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
