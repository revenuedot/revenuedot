/**
 * Lifecycle / Win-back: /projects/:projectId/lifecycle/winback (campaigns) and /winback/new, /winback/:campaignId (editor).
 * A campaign emails subscribers who churned an offer: who (churned between N and M days ago, products, stores, a saved
 * audience), what (subject, heading, body, button), where the button leads (the store's subscription page, or a custom
 * https link), and when (once a day at a UTC hour). RevenueDot has no web checkout yet, so there are no web purchase links.
 * API: /winback_campaigns, /winback_campaigns/{id}, .../actions/preview, .../actions/send_test, .../actions/run.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell, useMe } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Check, ConfirmDialog, DataTable, Dialog, EmptyState, Field, Panel, Tag, useProjectId, useToast } from "../../components/ui";
import { countNote, money, pollWhileCounting, relative, storeLabel } from "../../lib/customers";
import { errMsg, useApps, useProducts, v2 } from "../catalog/lib";
import { CAMPAIGN_STATUS, type Audience, type WinbackCampaign } from "./lib";

const base = (pid: string) => `/projects/${pid}/lifecycle/winback`;
const SUB = "Bring churned subscribers back by emailing them an offer.";

function Head({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="head">
      <div><h1>{title}<span className="beta">BETA</span></h1><p>{SUB}</p></div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function WinbackListPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["winback", pid], enabled: !!pid, queryFn: async () => (await api<List<WinbackCampaign>>(`${v2(pid)}/winback_campaigns`)).items });
  const rows = q.data ?? [];
  return (
    <Shell title="Win-back">
      <div className="page">
        <Head title="Win-back campaigns" actions={rows.length ? <Link className="btn btn-dark" to={`${base(pid)}/new`}><Icon name="plus" />Create campaign</Link> : undefined} />
        {q.isError ? <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>Campaigns could not be loaded: {errMsg(q.error)}</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>
          : q.isLoading ? <div className="panel pb" aria-busy="true"><span className="sk line" /></div>
          : !rows.length ? (
            <EmptyState title="Create your first win-back campaign" text="Start re-engaging churned subscribers and recovering revenue. RevenueDot emails each customer once per campaign, with an unsubscribe link, and counts who comes back."
              action={<Link className="btn btn-dark" to={`${base(pid)}/new`}><Icon name="plus" />Create campaign</Link>} />
          ) : (
            <DataTable rowKey={(c) => c.id} rows={rows} onRowClick={(c) => nav(`${base(pid)}/${c.id}`)} columns={[
              { key: "n", header: "Campaign", render: (c) => <span><Link to={`${base(pid)}/${c.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>{c.name}</Link><span className="cellsub">Churned {c.audience.churned_min_days}–{c.audience.churned_max_days} days ago · {String(c.send_hour_utc).padStart(2, "0")}:00 UTC</span></span> },
              { key: "s", header: "Status", render: (c) => <Tag tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Tag> },
              { key: "sent", header: "Sent", align: "right", render: (c) => fmt.int(c.stats?.sent) },
              { key: "o", header: "Opened", align: "right", render: (c) => c.track_opens ? fmt.int(c.stats?.opened) : <span className="subtle" title="Open tracking is off">—</span> },
              { key: "cl", header: "Clicked", align: "right", render: (c) => fmt.int(c.stats?.clicked) },
              { key: "r", header: "Reactivated", align: "right", render: (c) => fmt.int(c.stats?.reactivated) },
              { key: "rev", header: "Revenue", align: "right", render: (c) => money(c.stats?.reactivated_revenue_in_usd ?? 0) },
            ]} />
          )}
      </div>
    </Shell>
  );
}

type Form = Pick<WinbackCampaign, "name" | "audience" | "email" | "offer" | "send_hour_utc" | "track_opens">;
const DEFAULT_FORM: Form = {
  name: "Win back lapsed subscribers",
  audience: { churned_min_days: 3, churned_max_days: 60, product_ids: [], stores: [], audience_id: null },
  email: { subject: "Your Pro features are waiting", heading: "Come back to Pro", body: "Your subscription ended, but everything you made is still here.\n\nResubscribe today and pick up where you left off.", button_label: "See my offer", sender_name: "" },
  offer: { type: "store", url: null }, send_hour_utc: 16, track_opens: false,
};
const formOf = (c: WinbackCampaign): Form => ({ name: c.name, audience: c.audience, email: { ...c.email, sender_name: c.email.sender_name ?? "" }, offer: { type: c.offer.type, url: c.offer.url ?? null }, send_hour_utc: c.send_hour_utc, track_opens: c.track_opens });
const STORE_CHOICES = ["app_store", "mac_app_store", "play_store", "amazon", "stripe"];

interface Preview { eligible: number; is_approximate: boolean; is_counting: boolean; counted_at: number | null; sample: { app_user_id: string; email: string; churned_at: number; product_id: string; store: string }[] }

export function WinbackEditor() {
  const pid = useProjectId();
  const { campaignId } = useParams();
  const isNew = !campaignId || campaignId === "new";
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe();
  const projectName = me.data?.projects.find((p) => p.id === pid)?.name ?? "Your app";
  const key = ["winback-campaign", pid, campaignId];
  const q = useQuery({ queryKey: key, enabled: !isNew && !!pid, queryFn: () => api<WinbackCampaign>(`${v2(pid)}/winback_campaigns/${campaignId}`) });
  const products = useProducts(pid);
  const apps = useApps(pid);
  const auds = useQuery({ queryKey: ["audiences", pid], enabled: !!pid, queryFn: async () => (await api<List<Audience>>(`${v2(pid)}/audiences`)).items });
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"test" | "send" | "delete" | null>(null);
  // Load the campaign into the form when it first arrives or its saved content changes, not when only its stats refresh.
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const f = formOf(q.data);
    const json = JSON.stringify(f);
    if (json !== loaded.current) { loaded.current = json; setForm(f); }
  }, [q.data]);
  const dirty = isNew || (!!q.data && JSON.stringify(form) !== JSON.stringify(formOf(q.data)));
  const preview = useQuery({
    queryKey: ["winback-preview", pid, campaignId, q.data?.updated_at ?? q.data?.created_at, q.data?.last_run_at], enabled: !isNew && !!q.data,
    queryFn: () => api<Preview>(`${v2(pid)}/winback_campaigns/${campaignId}/actions/preview`, { method: "POST" }),
    refetchInterval: (query) => pollWhileCounting(query.state.data?.is_counting),
  });

  const subProducts = useMemo(() => [...new Set((products.data ?? []).filter((p) => p.type === "subscription" && (apps.data ?? []).some((a) => a.id === p.app_id && a.type !== "test_store")).map((p) => p.store_identifier))], [products.data, apps.data]);
  const stores = useMemo(() => STORE_CHOICES.filter((s) => (apps.data ?? []).some((a) => a.type === s)), [apps.data]);
  const setA = (patch: Partial<Form["audience"]>) => setForm((f) => ({ ...f, audience: { ...f.audience, ...patch } }));
  const setE = (patch: Partial<Form["email"]>) => setForm((f) => ({ ...f, email: { ...f.email, ...patch } }));
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const validate = () => {
    const a = form.audience;
    if (!form.name.trim()) return "Name the campaign.";
    if (!Number.isInteger(a.churned_min_days) || !Number.isInteger(a.churned_max_days) || a.churned_min_days < 0 || a.churned_max_days > 730 || a.churned_max_days <= a.churned_min_days) return "The churn window needs whole days, with the second number larger (up to 730).";
    if (!form.email.subject.trim() || !form.email.heading.trim() || !form.email.body.trim() || !form.email.button_label.trim()) return "Fill in the subject, heading, body and button label.";
    if (form.offer.type === "url" && !/^https:\/\/\S+\.\S+/.test(form.offer.url ?? "")) return "The custom link must start with https://.";
    return null;
  };
  const body = (extra: Record<string, unknown> = {}) => ({
    name: form.name.trim(), audience: form.audience,
    email: { subject: form.email.subject.trim(), heading: form.email.heading.trim(), body: form.email.body.trim(), button_label: form.email.button_label.trim(), sender_name: form.email.sender_name?.trim() || null },
    offer: form.offer.type === "url" ? { type: "url", url: form.offer.url?.trim() } : { type: "store" }, send_hour_utc: form.send_hour_utc, track_opens: form.track_opens, ...extra,
  });
  async function save(e?: FormEvent) {
    e?.preventDefault();
    const v = validate();
    if (v) { setErr(v); return null; }
    setBusy("save"); setErr(null);
    try {
      const res = await api<WinbackCampaign>(isNew ? `${v2(pid)}/winback_campaigns` : `${v2(pid)}/winback_campaigns/${campaignId}`, { method: "POST", json: body() });
      await qc.invalidateQueries({ queryKey: ["winback", pid] });
      if (isNew) { toast("Campaign saved as a draft"); nav(`${base(pid)}/${res.id}`, { replace: true }); }
      else { await qc.invalidateQueries({ queryKey: key }); toast("Campaign saved"); }
      setBusy(null);
      return res;
    } catch (x) { setErr(errMsg(x)); setBusy(null); return null; }
  }
  const setStatus = async (status: "active" | "paused") => {
    setBusy("status"); setErr(null);
    try {
      await api(`${v2(pid)}/winback_campaigns/${campaignId}`, { method: "POST", json: dirty ? body({ status }) : { status } });
      await Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ["winback", pid] })]);
      toast(status === "active" ? `Campaign started: it sends every day at ${String(form.send_hour_utc).padStart(2, "0")}:00 UTC` : "Campaign paused");
    } catch (x) { setErr(errMsg(x)); }
    setBusy(null);
  };

  const c = q.data;
  const st = c?.stats;
  const paragraphs = form.email.body.split(/\n{2,}/).filter((p) => p.trim());

  return (
    <Shell title={c?.name ?? "New campaign"} crumbs={<><Link className="cat-crumb-up" to={base(pid)}>Win-back</Link> <span className="crumb-sep">/</span> <b>{isNew ? "New campaign" : c?.name ?? ""}</b></>}>
      <div className="page">
        <Head title={isNew ? "New win-back campaign" : c?.name ?? "Win-back campaign"} actions={!isNew && c ? (
          <>
            <Tag tone={CAMPAIGN_STATUS[c.status].tone}>{CAMPAIGN_STATUS[c.status].label}</Tag>
            {c.status === "active"
              ? <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => setStatus("paused")}>Pause</button>
              : <button type="button" className="btn btn-dark" disabled={!!busy} onClick={() => setStatus("active")}>{c.status === "paused" ? "Resume" : "Start"}</button>}
            <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => setDialog("test")}><Icon name="send" />Send test</button>
            <button type="button" className="btn btn-line" disabled={!!busy || c.status !== "active"} title={c.status !== "active" ? "Start the campaign first" : undefined} onClick={() => setDialog("send")}>Send now</button>
          </>
        ) : undefined} />

        {!isNew && q.isError ? <div className="banner err" role="alert">The campaign could not be loaded: {errMsg(q.error)} <Link className="link-u" to={base(pid)}>Back to campaigns</Link></div>
          : !isNew && !c ? <div className="panel pb" aria-busy="true"><span className="sk line" /></div> : (
          <>
            {st && (
              <div className="stats" aria-label="Campaign results">
                <div><span className="label">Sent</span><b>{fmt.int(st.sent)}</b></div>
                <div><span className="label">Opened</span><b>{c?.track_opens ? fmt.int(st.opened) : "—"}</b></div>
                <div><span className="label">Clicked</span><b>{fmt.int(st.clicked)}</b></div>
                <div><span className="label">Reactivated</span><b>{fmt.int(st.reactivated)}</b></div>
                <div><span className="label">Revenue</span><b>{money(st.reactivated_revenue_in_usd)}</b></div>
              </div>
            )}
            <form className="two" onSubmit={save} noValidate>
              <div className="col">
                <Panel title="Campaign">
                  <Field label="Name" htmlFor="wb-name"><input id="wb-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
                </Panel>
                <Panel title="Audience">
                  <div className="stack">
                    <div className="inline-row" style={{ alignItems: "center" }}>
                      <span style={{ fontSize: 13 }}>Subscribers whose last subscription ended between</span>
                      <input aria-label="Churned at least (days ago)" className="input mono" style={{ width: 72 }} inputMode="numeric" value={form.audience.churned_min_days} onChange={(e) => setA({ churned_min_days: Number(e.target.value.replace(/\D/g, "") || 0) })} />
                      <span style={{ fontSize: 13 }}>and</span>
                      <input aria-label="Churned at most (days ago)" className="input mono" style={{ width: 72 }} inputMode="numeric" value={form.audience.churned_max_days} onChange={(e) => setA({ churned_max_days: Number(e.target.value.replace(/\D/g, "") || 0) })} />
                      <span style={{ fontSize: 13 }}>days ago</span>
                    </div>
                    <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Only production subscribers with no active subscription and an email address saved as the $email attribute, who have not unsubscribed. Each customer gets this campaign's email once.</p>
                    <fieldset className="cond-g" style={{ alignItems: "stretch" }}>
                      <legend>Products (none ticked: all)</legend>
                      {subProducts.length ? <div className="checks">{subProducts.map((p) => <Check key={p} checked={form.audience.product_ids.includes(p)} onChange={() => setA({ product_ids: toggleIn(form.audience.product_ids, p) })} label={<span className="mono" style={{ fontSize: 12 }}>{p}</span>} />)}</div>
                        : <p className="subtle" style={{ margin: 0, fontSize: 12 }}>No store subscription products yet.</p>}
                    </fieldset>
                    {stores.length > 0 && (
                      <fieldset className="cond-g" style={{ alignItems: "stretch" }}>
                        <legend>Stores (none ticked: all)</legend>
                        <div className="checks">{stores.map((s) => <Check key={s} checked={form.audience.stores.includes(s)} onChange={() => setA({ stores: toggleIn(form.audience.stores, s) })} label={storeLabel(s)} />)}</div>
                      </fieldset>
                    )}
                    <Field label="Saved audience" htmlFor="wb-aud" hint="Optional: only customers who are also in this audience.">
                      <select id="wb-aud" className="select" value={form.audience.audience_id ?? ""} onChange={(e) => setA({ audience_id: e.target.value || null })}><option value="">Anyone</option>{(auds.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                    </Field>
                  </div>
                </Panel>
                <Panel title="Email">
                  <div className="form-grid">
                    <Field label="Subject" htmlFor="wb-subject"><input id="wb-subject" className="input" maxLength={150} value={form.email.subject} onChange={(e) => setE({ subject: e.target.value })} /></Field>
                    <Field label="Sender name" htmlFor="wb-sender" hint={`Empty: ${projectName}`}><input id="wb-sender" className="input" maxLength={80} value={form.email.sender_name ?? ""} onChange={(e) => setE({ sender_name: e.target.value })} placeholder={projectName} /></Field>
                    <div className="full"><Field label="Heading" htmlFor="wb-heading"><input id="wb-heading" className="input" maxLength={150} value={form.email.heading} onChange={(e) => setE({ heading: e.target.value })} /></Field></div>
                    <div className="full"><Field label="Body" htmlFor="wb-body" hint="Plain text. A blank line starts a new paragraph."><textarea id="wb-body" className="textarea" style={{ fontFamily: "var(--font)", fontSize: 13, minHeight: 120 }} maxLength={4000} value={form.email.body} onChange={(e) => setE({ body: e.target.value })} /></Field></div>
                    <Field label="Button label" htmlFor="wb-button"><input id="wb-button" className="input" maxLength={40} value={form.email.button_label} onChange={(e) => setE({ button_label: e.target.value })} /></Field>
                  </div>
                </Panel>
                <Panel title="Offer">
                  <div className="stack tight">
                    <div className="radio-row" role="radiogroup" aria-label="Where the button leads">
                      <label><input type="radio" name="wb-offer" checked={form.offer.type === "store"} onChange={() => setForm({ ...form, offer: { type: "store", url: form.offer.url } })} />Store subscription page</label>
                      <label><input type="radio" name="wb-offer" checked={form.offer.type === "url"} onChange={() => setForm({ ...form, offer: { type: "url", url: form.offer.url ?? "" } })} />Custom link</label>
                    </div>
                    {form.offer.type === "store" ? (
                      <ul className="notes">
                        <li><b>App Store:</b> opens the customer's subscriptions page in their Apple account, where Apple shows the win-back offers they are eligible for. Set those offers up in App Store Connect.</li>
                        <li><b>Google Play:</b> opens the Play Store subscription page of the product they had.</li>
                        <li>Web checkout links come later, with RevenueDot's web purchases.</li>
                      </ul>
                    ) : (
                      <Field label="Link" htmlFor="wb-url" hint="An https page of yours, e.g. a landing page with a discount code."><input id="wb-url" className="input mono" value={form.offer.url ?? ""} onChange={(e) => setForm({ ...form, offer: { type: "url", url: e.target.value } })} placeholder="https://example.com/comeback" /></Field>
                    )}
                  </div>
                </Panel>
                <Panel title="Schedule">
                  <div className="stack tight">
                    <Field label="Send every day at" htmlFor="wb-hour" hint="Active campaigns email new matches once a day, at most 500 a day.">
                      <select id="wb-hour" className="select" style={{ maxWidth: 200 }} value={form.send_hour_utc} onChange={(e) => setForm({ ...form, send_hour_utc: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00 UTC</option>)}</select>
                    </Field>
                    <Check checked={form.track_opens} onChange={(v) => setForm({ ...form, track_opens: v })} label="Track opens" hint="Adds a 1×1 image. Many mail apps block or preload images, so open counts are rough. Clicks are always counted." />
                  </div>
                </Panel>
                {err && <div className="banner err" role="alert">{err}</div>}
                <div className="hrow">
                  <button type="submit" className="btn btn-dark" disabled={!!busy || !dirty}>{busy === "save" ? "Saving…" : isNew ? "Save draft" : "Save"}</button>
                  {!isNew && dirty && <button type="button" className="btn btn-line" onClick={() => c && setForm(formOf(c))}>Discard changes</button>}
                  {!isNew && <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setDialog("delete")}><Icon name="trash" />Delete</button>}
                </div>
              </div>

              <div className="col">
                <Panel title="Who gets it" link={!isNew ? <button type="button" className="btn btn-line" disabled={preview.isFetching} onClick={() => preview.refetch()}>{preview.isFetching ? "Counting…" : "Preview"}</button> : undefined}>
                  {isNew ? <p className="subtle" style={{ margin: 0, fontSize: 13 }}>Save the draft to see who would get this email.</p>
                    : preview.isError ? <div className="banner err" role="alert">{errMsg(preview.error)}</div>
                    : !preview.data ? <span className="sk line" />
                    : (
                      <div className="stack tight">
                        {preview.data.is_counting
                          ? <p style={{ margin: 0 }} data-testid="wb-eligible"><b style={{ fontSize: 16 }}>Counting…</b> <span className="muted">{countNote(true, null)}</span></p>
                          : <p style={{ margin: 0 }} data-testid="wb-eligible"><b className="num" style={{ fontSize: 22 }}>{fmt.int(preview.data.eligible)}</b> <span className="muted">customer{preview.data.eligible === 1 ? "" : "s"} would get this email now{dirty ? " (as last saved)" : ""}.{countNote(false, preview.data.counted_at) ? ` ${countNote(false, preview.data.counted_at)}` : ""}</span></p>}
                        {preview.data.sample.length > 0 && (
                          <div className="tbl"><table className="compact"><thead><tr><th>Customer</th><th>Churned</th></tr></thead><tbody>
                            {preview.data.sample.map((s) => <tr key={s.app_user_id}><td><Link className="mono" style={{ fontSize: 12 }} to={`/projects/${pid}/customers/${encodeURIComponent(s.app_user_id)}`}>{s.app_user_id}</Link><span className="cellsub">{s.email}</span></td><td><span className="subtle">{relative(s.churned_at)}</span><span className="cellsub mono">{s.product_id}</span></td></tr>)}
                          </tbody></table></div>
                        )}
                      </div>
                    )}
                </Panel>
                <div className="mailprev" aria-label="Email preview">
                  <div className="mh"><span>From <b>{form.email.sender_name?.trim() || projectName}</b></span><span>Subject <b>{form.email.subject || "—"}</b></span></div>
                  <div className="mb">
                    <h3>{form.email.heading || "Heading"}</h3>
                    {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
                    <span className="btn btn-dark">{form.email.button_label || "Button"}</span>
                  </div>
                  <div className="mf">You received this because you subscribed to {form.email.sender_name?.trim() || projectName}. Unsubscribe</div>
                </div>
              </div>
            </form>

            {c?.recent_sends && c.recent_sends.length > 0 && (
              <Panel title="Recent sends" flush>
                <DataTable rowKey={(s) => s.id} rows={c.recent_sends} columns={[
                  { key: "e", header: "Email", render: (s) => s.email },
                  { key: "s", header: "Sent", render: (s) => <span className="subtle" title={fmt.dateTime(s.sent_at)}>{relative(s.sent_at)}</span> },
                  { key: "o", header: "Opened", render: (s) => s.opened_at ? relative(s.opened_at) : <span className="subtle">—</span> },
                  { key: "c", header: "Clicked", render: (s) => s.clicked_at ? relative(s.clicked_at) : <span className="subtle">—</span> },
                  { key: "st", header: "Status", render: (s) => s.error ? <span title={s.error}><Tag tone="down">Failed</Tag></span> : s.unsubscribed_at ? <Tag tone="muted">Unsubscribed</Tag> : <Tag tone="up">Sent</Tag> },
                ]} />
              </Panel>
            )}
          </>
        )}
      </div>
      {dialog === "test" && <SendTestDialog pid={pid} campaignId={campaignId!} defaultEmail={me.data?.user.email ?? ""} beforeSend={dirty ? save : undefined} onClose={() => setDialog(null)} />}
      {dialog === "send" && c && (
        <ConfirmDialog title="Send this campaign now?" confirmLabel={dirty ? "Save and send now" : "Send now"} onClose={() => setDialog(null)} onConfirm={async () => {
          // Customers get a campaign once: the email that goes out must be the one on screen.
          if (dirty && !(await save())) throw new Error("The changes could not be saved, so nothing was sent. Fix the form and try again.");
          const r = await api<{ sent: number; failed: number; skipped: number }>(`${v2(pid)}/winback_campaigns/${campaignId}/actions/run`, { method: "POST" });
          await qc.invalidateQueries({ queryKey: key }); await qc.invalidateQueries({ queryKey: ["winback", pid] });
          toast(`Sent ${r.sent} email${r.sent === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}`);
        }}><p>{preview.data ? `${fmt.int(preview.data.eligible)} customers match right now.` : "Everyone who matches right now gets the email."} Each customer gets this campaign once, so the daily run will skip them.</p></ConfirmDialog>
      )}
      {dialog === "delete" && c && (
        <ConfirmDialog title="Delete this campaign?" confirmLabel="Delete campaign" danger onClose={() => setDialog(null)} onConfirm={async () => {
          await api(`${v2(pid)}/winback_campaigns/${campaignId}`, { method: "DELETE" });
          await qc.invalidateQueries({ queryKey: ["winback", pid] }); toast("Campaign deleted"); nav(base(pid));
        }}><p>Its send log and results are deleted. Links in emails already sent stop working.</p></ConfirmDialog>
      )}
    </Shell>
  );
}

function SendTestDialog({ pid, campaignId, defaultEmail, beforeSend, onClose }: { pid: string; campaignId: string; defaultEmail: string; beforeSend?: () => Promise<unknown>; onClose: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState(defaultEmail);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setErr("Enter an email address."); return; }
    setBusy(true); setErr(null);
    try {
      if (beforeSend && !(await beforeSend())) { setBusy(false); setErr("Save the campaign first: fix the errors on the page."); return; }
      await api(`${v2(pid)}/winback_campaigns/${campaignId}/actions/send_test`, { method: "POST", json: { email: email.trim() } });
      toast(`Test email sent to ${email.trim()}`); onClose();
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title="Send a test email" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="wb-test" className="btn btn-dark" disabled={busy}>{busy ? "Sending…" : "Send test"}</button>
    </>}>
      <form id="wb-test" onSubmit={submit} noValidate className="stack tight">
        <Field label="Send to" htmlFor="wb-test-to" hint="The test uses the saved campaign. Its links are samples and are not tracked."><input id="wb-test-to" className="input" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
