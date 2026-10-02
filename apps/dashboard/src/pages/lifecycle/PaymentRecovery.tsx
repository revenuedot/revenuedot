/**
 * Lifecycle / Payment recovery: /projects/:projectId/lifecycle/payment-recovery (prd/payment-recovery/PRD.md).
 * Subscribers whose payment failed (a billing issue on any store) get emails from the app with a link to fix the payment;
 * a renewal within the window recovers the subscription. The page shows what is at risk now, the emails sent, what came
 * back (attributed to the emails, and on its own) and every case, with the settings in a dialog.
 * API: GET/POST /payment_recovery, GET /payment_recovery/stats, GET /payment_recovery/cases, POST …/actions/send_test, …/actions/run.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell, useMe } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Check, DataTable, Dialog, EmptyState, Field, PageHead, Panel, Segmented, Switch, Tabs, Tag, useProjectId, useSandboxParam, useToast, KeyValue } from "../../components/ui";
import { money, relative, storeLabel } from "../../lib/customers";
import { errMsg, v2 } from "../catalog/lib";

interface Step { day: number; subject: string; heading: string; body: string; button_label: string }
interface Settings { enabled: boolean; steps: Step[]; window_days: number; include_sandbox: boolean; sender_name: string | null; default_steps: Step[] }
interface Stats {
  at_risk: { count: number; revenue_in_usd: number }; opened: number; messages_sent: number; clicked: number;
  recovered: { count: number; revenue_in_usd: number }; recovered_without_message: { count: number; revenue_in_usd: number }; lost: { count: number };
  recovery_rate: number | null; by_store: { store: string; at_risk: number; recovered: number; recovered_revenue_in_usd: number; recovered_without_message: number; lost: number }[];
}
interface Case {
  id: string; app_user_id: string; store: string; product_id: string; environment: "production" | "sandbox"; status: "open" | "recovered" | "lost";
  detected_at: number; grace_period_expires_at: number | null; at_risk_in_usd: number | null; email: string | null; messages_sent: number; next_message_at: number | null;
  last_message_at: number | null; clicked_at: number | null; unsubscribed_at: number | null; skip_reason: string | null; resolved_at: number | null;
  recovered_revenue_in_usd: number | null; attributed: boolean; lost_reason: string | null;
}

const PERIODS = [{ value: "7", label: "7D" }, { value: "28", label: "28D" }, { value: "90", label: "90D" }] as const;
type Period = (typeof PERIODS)[number]["value"];
type Filter = "open" | "recovered" | "lost" | "all";

const unsubscribed = (c: Case) => !!c.unsubscribed_at || c.skip_reason === "unsubscribed";

function caseTag(c: Case) {
  if (c.status === "recovered") return <Tag tone="up">{c.attributed ? "Recovered" : "Recovered on its own"}</Tag>;
  if (c.status === "lost") return <Tag tone="muted">{c.lost_reason === "refunded" ? "Refunded" : "Lost"}</Tag>;
  if (c.skip_reason === "no_email") return <Tag tone="gold">No email</Tag>;
  if (c.skip_reason === "issue_cleared") return <Tag tone="muted">Waiting for renewal</Tag>;
  return <Tag tone="down">Billing issue</Tag>;
}

/** The case's state, plus "Unsubscribed" whenever the customer used the unsubscribe link, open or closed. */
function statusTag(c: Case) {
  return <span className="hrow" style={{ gap: 6, flexWrap: "wrap" }}>{caseTag(c)}{unsubscribed(c) && <span title={c.unsubscribed_at ? `Unsubscribed ${fmt.dateTime(c.unsubscribed_at)}` : "Unsubscribed from recovery emails"}><Tag tone="gold">Unsubscribed</Tag></span>}</span>;
}

/** One case: what happened, when, and which emails went out. */
function CaseDialog({ pid, c, onClose }: { pid: string; c: Case; onClose: () => void }) {
  const at = (ms: number | null) => (ms ? fmt.dateTime(ms) : "—");
  return (
    <Dialog title="Recovery case" onClose={onClose} footer={<>
      <Link className="btn btn-line" to={`/projects/${pid}/customers/${encodeURIComponent(c.app_user_id)}`}>Open customer</Link>
      <button type="button" className="btn btn-dark" onClick={onClose}>Done</button>
    </>}>
      <div className="hrow" style={{ gap: 6, flexWrap: "wrap" }}>{statusTag(c)}{c.environment === "sandbox" && <Tag tone="info">Sandbox</Tag>}</div>
      {unsubscribed(c) && <div className="banner" role="status"><span><b>Unsubscribed{c.unsubscribed_at ? ` ${fmt.dateTime(c.unsubscribed_at)}` : ""}.</b> {c.email ?? "This customer"} gets no more recovery emails.{c.status === "open" && " The store keeps retrying the payment."}</span></div>}
      <KeyValue rows={[
        ["Customer", <span key="c"><span className="mono">{c.app_user_id}</span>{c.email && <span className="subtle"> · {c.email}</span>}</span>],
        ["Store and product", <span key="s">{storeLabel(c.store)} · <span className="mono">{c.product_id}</span></span>],
        ["Payment failed", at(c.detected_at)],
        ["Grace period ends", at(c.grace_period_expires_at)],
        ["Emails sent", <span key="m" className="mono">{c.messages_sent}</span>],
        ["Last email", at(c.last_message_at)],
        ["Next email", c.status === "open" && !unsubscribed(c) ? at(c.next_message_at) : "—"],
        ["Link clicked", at(c.clicked_at)],
        ["Unsubscribed", c.unsubscribed_at ? at(c.unsubscribed_at) : unsubscribed(c) ? "Yes, from another case's email" : "—"],
        [c.status === "open" ? "At risk" : "Recovered revenue", <span key="r" className="mono">{c.status === "open" ? money(c.at_risk_in_usd ?? 0) : c.status === "recovered" ? money(c.recovered_revenue_in_usd ?? 0) : "—"}</span>],
        ["Closed", at(c.resolved_at)],
      ]} />
    </Dialog>
  );
}

export function PaymentRecoveryPage() {
  const pid = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const [period, setPeriod] = useState<Period>("28");
  const [sandbox, setSandbox] = useSandboxParam();
  const [filter, setFilter] = useState<Filter>("open");
  const [open, setOpen] = useState<Case | null>(null);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const env = sandbox ? "sandbox" : "production";
  const settings = useQuery({ queryKey: ["recovery-settings", pid], enabled: !!pid, queryFn: () => api<Settings>(`${v2(pid)}/payment_recovery`) });
  const stats = useQuery({ queryKey: ["recovery-stats", pid, period, env], enabled: !!pid, queryFn: () => api<Stats>(`${v2(pid)}/payment_recovery/stats?days=${period}&environment=${env}`) });
  const cases = useQuery({
    queryKey: ["recovery-cases", pid, env, filter], enabled: !!pid,
    queryFn: async () => (await api<List<Case>>(`${v2(pid)}/payment_recovery/cases?environment=${env}&limit=50${filter === "all" ? "" : `&status=${filter}`}`)).items,
  });
  const s = settings.data;
  const st = stats.data;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["recovery-stats", pid] }), qc.invalidateQueries({ queryKey: ["recovery-cases", pid] }), qc.invalidateQueries({ queryKey: ["recovery-settings", pid] })]);
  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api<{ sent: number; failed: number; skipped: number }>(`${v2(pid)}/payment_recovery/actions/run`, { method: "POST" });
      await refresh();
      toast(r.sent || r.failed ? `Sent ${r.sent} email${r.sent === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}` : "Nothing is due right now");
    } catch (e) { toast(errMsg(e)); }
    setRunning(false);
  };

  return (
    <Shell title="Payment recovery">
      <div className="page">
        <PageHead title="Payment recovery" sub="Email subscribers whose payment failed a link to fix it, and count the revenue that comes back." actions={<>
          <Segmented label="Period" value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p.value, label: p.label }))} />
          <Switch label="Sandbox data" checked={sandbox} onChange={setSandbox} />
          {s && (s.enabled
            ? <><Tag tone="up">Emails on</Tag><button type="button" className="btn btn-line" disabled={running} onClick={runNow}><Icon name="send" />{running ? "Sending…" : "Send due emails"}</button><button type="button" className="btn btn-line" onClick={() => setEditing(true)}><Icon name="settings" />Settings</button></>
            : <button type="button" className="btn btn-dark" onClick={() => setEditing(true)}>Turn on</button>)}
        </>} />

        {settings.isError && <div className="banner err" role="alert">Settings could not be loaded: {errMsg(settings.error)} <button type="button" className="linkish" onClick={() => settings.refetch()}>Try again</button></div>}
        {s && !s.enabled && (
          <div className="banner warn" role="status">
            <span style={{ flex: 1 }}>Recovery emails are off. Billing issues are still tracked below, and renewals count as recovered on their own.</span>
            <button type="button" className="btn btn-dark" onClick={() => setEditing(true)}>Turn on</button>
          </div>
        )}

        <div className="pr-grid" aria-label="Payment recovery results" aria-busy={stats.isLoading}>
          <div>
            <span className="label">At risk now</span>
            <span className="num" data-testid="pr-at-risk">{st ? fmt.int(st.at_risk.count) : "—"}</span>
            <span className="pr-sub"><b>{st ? money(st.at_risk.revenue_in_usd) : "—"}</b> in failed renewals</span>
          </div>
          <div>
            <span className="label">Emails sent</span>
            <span className="num" data-testid="pr-sent">{st ? fmt.int(st.messages_sent) : "—"}</span>
            <span className="pr-sub"><b>{st ? fmt.int(st.clicked) : "—"}</b> clicked the link</span>
          </div>
          <div>
            <span className="label">Recovered</span>
            <span className="num" data-testid="pr-recovered">{st ? fmt.int(st.recovered.count) : "—"}</span>
            <span className="pr-sub">Recovery rate <b>{st?.recovery_rate === null || st?.recovery_rate === undefined ? "—" : `${Math.round(st.recovery_rate * 100)}%`}</b></span>
          </div>
          <div>
            <span className="label">Recovered revenue</span>
            <span className="num" data-testid="pr-revenue">{st ? money(st.recovered.revenue_in_usd) : "—"}</span>
            <span className="pr-sub"><b>{st ? money(st.recovered_without_message.revenue_in_usd) : "—"}</b> came back on its own</span>
          </div>
        </div>
        {stats.isError && <div className="banner err" role="alert">The numbers could not be loaded: {errMsg(stats.error)} <button type="button" className="linkish" onClick={() => stats.refetch()}>Try again</button></div>}

        <Panel title="Subscribers in billing retry" flush link={<Segmented label="Show cases" value={filter} onChange={setFilter} options={[{ value: "open", label: "At risk" }, { value: "recovered", label: "Recovered" }, { value: "lost", label: "Lost" }, { value: "all", label: "All" }]} />}>
          {cases.isError ? <div className="pb"><div className="banner err" role="alert">Cases could not be loaded: {errMsg(cases.error)} <button type="button" className="linkish" onClick={() => cases.refetch()}>Try again</button></div></div>
            : cases.isLoading ? <div className="pb" aria-busy="true"><span className="sk line" /></div>
            : (
              <DataTable rowKey={(c) => c.id} rows={cases.data ?? []} onRowClick={setOpen} empty={
                <div className="pb"><EmptyState title={filter === "open" ? "No failed payments right now" : "Nothing here yet"} text={filter === "open" ? `When a ${sandbox ? "sandbox " : ""}renewal fails on any store, the subscriber shows up here with the emails they got.` : "Cases move here when a subscriber's payment goes through or the recovery window ends."} /></div>
              } columns={[
                { key: "c", header: "Customer", render: (c) => <span><Link className="mono" style={{ fontSize: 12 }} to={`/projects/${pid}/customers/${encodeURIComponent(c.app_user_id)}`} onClick={(e) => e.stopPropagation()}>{c.app_user_id}</Link><span className="cellsub">{c.email ?? "No email yet"}</span></span> },
                { key: "s", header: "Store", render: (c) => <span><span>{storeLabel(c.store)}</span><span className="cellsub mono">{c.product_id}</span></span> },
                { key: "d", header: "Since", render: (c) => <span title={fmt.dateTime(c.detected_at)}>{relative(c.detected_at)}{c.grace_period_expires_at && <span className="cellsub">Grace ends {fmt.date(c.grace_period_expires_at)}</span>}</span> },
                { key: "m", header: "Emails", align: "right", render: (c) => <span className="mono">{c.messages_sent}{c.clicked_at ? <span className="cellsub">clicked</span> : c.next_message_at && c.status === "open" ? <span className="cellsub" title={fmt.dateTime(c.next_message_at)}>next {fmt.date(c.next_message_at)}</span> : null}</span> },
                { key: "st", header: "Status", render: statusTag },
                { key: "r", header: "Revenue", align: "right", render: (c) => <span className="mono">{c.status === "recovered" ? money(c.recovered_revenue_in_usd ?? 0) : c.status === "open" ? <span className="subtle">{money(c.at_risk_in_usd ?? 0)} at risk</span> : "—"}</span> },
              ]} />
            )}
        </Panel>
        {open && <CaseDialog pid={pid} c={open} onClose={() => setOpen(null)} />}

        <Panel title="How money is counted">
          <ul className="pr-how">
            <li>A case opens when a renewal fails: App Store billing retry or grace period, Google Play grace period or account hold, Stripe past due, Amazon grace.</li>
            <li><b>Recovered</b> means the same subscription renewed within {s?.window_days ?? 30} days, after at least one email. That revenue is what RevenueDot recovered.</li>
            <li><b>Came back on its own</b> means it renewed before any email went out, or with emails off. A case with no renewal in the window is lost.</li>
            <li>While a case is open, the app's Customer Center opens the same link from "Manage subscription".</li>
          </ul>
        </Panel>
      </div>
      {editing && s && <SettingsDialog pid={pid} settings={s} onClose={() => setEditing(false)} onSaved={async (on) => { await refresh(); toast(on ? "Payment recovery is on" : "Payment recovery settings saved"); }} />}
    </Shell>
  );
}

function SettingsDialog({ pid, settings, onClose, onSaved }: { pid: string; settings: Settings; onClose: () => void; onSaved: (on: boolean) => Promise<unknown> }) {
  const me = useMe();
  const toast = useToast();
  const projectName = me.data?.projects.find((p) => p.id === pid)?.name ?? "Your app";
  const [f, setF] = useState({ enabled: true, steps: settings.steps, window_days: settings.window_days, include_sandbox: settings.include_sandbox, sender_name: settings.sender_name ?? "" });
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState(me.data?.user.email ?? "");
  useEffect(() => { if (!testTo && me.data?.user.email) setTestTo(me.data.user.email); }, [me.data, testTo]);
  const step = f.steps[Math.min(sel, f.steps.length - 1)]!;
  const app = f.sender_name.trim() || projectName;
  const fill = (t: string) => t.replace(/\{app\}/g, app);
  const setStep = (patch: Partial<Step>) => setF((x) => ({ ...x, steps: x.steps.map((s, i) => (i === sel ? { ...s, ...patch } : s)) }));
  const validate = () => {
    for (const [i, s] of f.steps.entries()) {
      if (!s.subject.trim() || !s.heading.trim() || !s.body.trim() || !s.button_label.trim()) return `Fill in every field of email ${i + 1}.`;
      if (i > 0 && s.day <= f.steps[i - 1]!.day) return `Email ${i + 1} must go out on a later day than email ${i}.`;
    }
    if (f.steps[f.steps.length - 1]!.day >= f.window_days) return "The last email must go out before the recovery window ends.";
    return null;
  };
  async function save(e?: FormEvent) {
    e?.preventDefault();
    const v = validate();
    if (v) { setErr(v); return false; }
    setBusy(true); setErr(null);
    try {
      await api(`${v2(pid)}/payment_recovery`, { method: "POST", json: { ...f, sender_name: f.sender_name.trim() || null, steps: f.steps.map((s) => ({ ...s, subject: s.subject.trim(), heading: s.heading.trim(), body: s.body.trim(), button_label: s.button_label.trim() })) } });
      await onSaved(f.enabled);
      onClose();
      return true;
    } catch (x) { setErr(errMsg(x)); setBusy(false); return false; }
  }
  const sendTest = async () => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testTo.trim())) { setErr("Enter an email address for the test."); return; }
    setBusy(true); setErr(null);
    try {
      const v = validate();
      if (v) { setErr(v); setBusy(false); return; }
      // The email on screen, saved or not.
      await api(`${v2(pid)}/payment_recovery/actions/send_test`, { method: "POST", json: { email: testTo.trim(), content: { ...step, subject: step.subject.trim(), heading: step.heading.trim(), body: step.body.trim(), button_label: step.button_label.trim() }, sender_name: f.sender_name.trim() || null } });
      toast(`Test email sent to ${testTo.trim()}`);
    } catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  };
  return (
    <Dialog title="Payment recovery settings" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="pr-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </>}>
      <form id="pr-form" onSubmit={save} noValidate className="stack">
        <Check checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Send recovery emails" hint="From your app's name, with your Customer Center support address as Reply-To. Each email has an unsubscribe link." />
        <div className="cols">
          <Field label="Sender name" htmlFor="pr-sender" hint={`Empty: ${projectName}`}><input id="pr-sender" className="input" maxLength={80} value={f.sender_name} placeholder={projectName} onChange={(e) => setF({ ...f, sender_name: e.target.value })} /></Field>
          <Field label="Recovery window (days)" htmlFor="pr-window" hint="A renewal within this many days counts as recovered. 7 to 60.">
            <input id="pr-window" className="input mono" inputMode="numeric" value={f.window_days} onChange={(e) => setF({ ...f, window_days: Math.min(60, Number(e.target.value.replace(/\D/g, "") || 0)) })} />
          </Field>
        </div>
        <Check checked={f.include_sandbox} onChange={(v) => setF({ ...f, include_sandbox: v })} label="Also email sandbox subscribers" hint="For trying it with Stripe test mode or the Test Store. Production subscribers always get emails while recovery is on." />
        <div className="pr-step-h">
          <b style={{ fontSize: 13 }}>Emails</b>
          <span className="hrow">
            {f.steps.length < 5 && <button type="button" className="linkish" onClick={() => { setF((x) => ({ ...x, steps: [...x.steps, { ...x.steps[x.steps.length - 1]!, day: Math.min(x.window_days - 1, x.steps[x.steps.length - 1]!.day + 3) }] })); setSel(f.steps.length); }}>+ Add email</button>}
            <button type="button" className="linkish" onClick={() => { setF((x) => ({ ...x, steps: settings.default_steps })); setSel(0); }}>Reset to defaults</button>
          </span>
        </div>
        <Tabs label="Emails" idBase="pr-step" value={String(sel)} onChange={(v) => setSel(Number(v))} tabs={f.steps.map((s, i) => ({ value: String(i), label: `Day ${s.day}` }))} />
        <div className="pr-step" role="tabpanel" aria-labelledby={`pr-step-${sel}`}>
          <div className="cols">
            <Field label="Send on day" htmlFor="pr-day" hint="Days after the payment failed. Day 0 sends right away.">
              <input id="pr-day" className="input mono" inputMode="numeric" value={step.day} onChange={(e) => setStep({ day: Number(e.target.value.replace(/\D/g, "") || 0) })} />
            </Field>
            <Field label="Button label" htmlFor="pr-button"><input id="pr-button" className="input" maxLength={40} value={step.button_label} onChange={(e) => setStep({ button_label: e.target.value })} /></Field>
          </div>
          <Field label="Subject" htmlFor="pr-subject" hint="{app} is replaced with the sender name."><input id="pr-subject" className="input" maxLength={150} value={step.subject} onChange={(e) => setStep({ subject: e.target.value })} /></Field>
          <Field label="Heading" htmlFor="pr-heading"><input id="pr-heading" className="input" maxLength={150} value={step.heading} onChange={(e) => setStep({ heading: e.target.value })} /></Field>
          <Field label="Body" htmlFor="pr-body" hint="Plain text. A blank line starts a new paragraph."><textarea id="pr-body" className="textarea" style={{ fontFamily: "var(--font)", fontSize: 13, minHeight: 96 }} maxLength={4000} value={step.body} onChange={(e) => setStep({ body: e.target.value })} /></Field>
          {f.steps.length > 1 && <div><button type="button" className="btn btn-ghost" onClick={() => { setF((x) => ({ ...x, steps: x.steps.filter((_, i) => i !== sel) })); setSel(Math.max(0, sel - 1)); }}><Icon name="trash" />Remove this email</button></div>}
        </div>
        <div className="mailprev" aria-label="Email preview">
          <div className="mh"><span>From <b>{app}</b></span><span>Subject <b>{fill(step.subject) || "—"}</b></span></div>
          <div className="mb">
            <h3>{fill(step.heading) || "Heading"}</h3>
            {step.body.split(/\n{2,}/).filter((p) => p.trim()).map((p, i) => <p key={i}>{fill(p)}</p>)}
            <span className="btn btn-dark">{fill(step.button_label) || "Button"}</span>
          </div>
          <div className="mf">You received this because a payment for your {app} subscription failed. Unsubscribe</div>
        </div>
        <div className="hrow" style={{ alignItems: "flex-end" }}>
          <Field label="Send a test to" htmlFor="pr-test"><input id="pr-test" className="input" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field>
          <button type="button" className="btn btn-line" disabled={busy} onClick={sendTest}><Icon name="send" />Send test</button>
        </div>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
