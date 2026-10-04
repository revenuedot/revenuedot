import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { DeliveryDrawer } from "../../components/DeliveryDrawer";
import { Icon } from "../../components/icons";
import {
  Check, CodeBlock, ConfirmDialog, Dialog, EVENT_TONE, Field, KeyValue, Menu, PageHead, Segmented, StatusLine, Switch, Tag, useProjectId, useToast,
} from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg, useApps, useSetupHealth, useWebhooks, withStates, type Delivery, type Webhook } from "./data";

/**
 * Webhooks (/projects/:projectId/integrations/webhooks): list, the create/edit form (RevenueCat's fields: name, URL,
 * Authorization header value, environment, events filtered by app and by event type), the signing secret shown once,
 * each webhook's delivery log with Retry and "Send test event", and a switch that pauses deliveries (`enabled`, ours).
 * GAPS vs RevenueCat: rotating the signing secret (delete and re-create the webhook to get a new one).
 */

export const EVENT_TYPES: [string, string][] = [
  ["initial_purchase", "A new subscription starts, including free trials."],
  ["renewal", "A subscription renews, or a trial converts to paid."],
  ["cancellation", "Auto-renew is turned off, or a purchase is refunded."],
  ["uncancellation", "Auto-renew is turned back on before the subscription ends."],
  ["non_renewing_purchase", "A one-time purchase or consumable."],
  ["expiration", "Access ends."],
  ["billing_issue", "A renewal payment fails."],
  ["product_change", "An upgrade, downgrade or crossgrade."],
  ["subscription_paused", "A Google Play subscription is paused."],
  ["subscription_extended", "The store pushes the expiry date out."],
  ["refund_reversed", "Apple reverses a refund."],
  ["transfer", "Purchases move to another app user ID."],
  ["invoice_issuance", "An invoice is issued for a web subscription."],
  ["temporary_entitlement_grant", "Temporary access while a store is down."],
  ["virtual_currency_transaction", "An in-app currency balance changes."],
  ["experiment_enrollment", "A customer joins an experiment."],
  ["purchase_redeemed", "A web purchase is redeemed in the app."],
  ["subscriber_alias", "Two app user IDs are merged (older projects)."],
  ["price_increase_consent_required", "A price increase needs the customer's consent."],
  ["price_increase_consent_approved", "The customer accepts a price increase."],
  ["test", "Sent by the Send test event button (always delivered)."],
  ["funnel_viewed", "A visitor opens a web funnel (RevenueDot; only when selected)."],
  ["funnel_step_completed", "A visitor completes a funnel step (RevenueDot; only when selected)."],
  ["funnel_purchase", "A visitor buys through a web funnel (RevenueDot; only when selected)."],
  ["paywall_impression", "A paywall is shown to a customer (only when selected)."],
  ["paywall_close", "The customer closes a paywall (only when selected)."],
  ["paywall_cancel", "The customer dismisses the store's payment sheet on a paywall (only when selected)."],
  ["paywall_exit_offer", "An exit offer is shown on a paywall (only when selected)."],
  ["paywall_component_interacted", "The customer changes a paywall control: a tab, package, button or sheet (only when selected)."],
  ["paywall_purchase_initiated", "The customer taps buy on a paywall (only when selected)."],
  ["paywall_purchase_error", "A purchase started on a paywall fails (only when selected)."],
];

/** The event list in three groups: purchase events, then the opt-in funnel and paywall events (RevenueDot's own types). */
const EVENT_GROUPS: { title: string; sub?: string; types: [string, string][] }[] = [
  { title: "Purchase events", types: EVENT_TYPES.filter(([t]) => !/^(funnel|paywall)_/.test(t)) },
  { title: "Web funnel events", sub: "RevenueDot's own types, sent only when selected.", types: EVENT_TYPES.filter(([t]) => t.startsWith("funnel_")) },
  { title: "Paywall events", sub: "What customers do on paywalls the SDK shows. Sent only when selected, with no revenue.", types: EVENT_TYPES.filter(([t]) => t.startsWith("paywall_")) },
];

const label = (t: string) => t.toUpperCase();
const envLabel = (e: Webhook["environment"]) => (e === "production" ? "Production" : e === "sandbox" ? "Sandbox" : "Production and sandbox");

function WebhookForm({ pid, hook }: { pid: string; hook?: Webhook }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const apps = useApps(pid);
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState(hook?.url ?? "");
  const [auth, setAuth] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [clearAuth, setClearAuth] = useState(false);
  const [env, setEnv] = useState<"both" | "production" | "sandbox">(hook?.environment ?? "both");
  const [appId, setAppId] = useState(hook?.app_id ?? "");
  const [mode, setMode] = useState<"all" | "some">(hook?.event_types.length ? "some" : "all");
  const [types, setTypes] = useState<string[]>(hook?.event_types ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const insecure = /^http:\/\//i.test(url.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Name the webhook, for example Backend production.";
    let u: URL | null = null;
    try { u = new URL(url.trim()); } catch { /* below */ }
    if (!u || !/^https?:$/.test(u.protocol)) errs.url = "Enter the full URL of your endpoint, starting with https://.";
    if (mode === "some" && !types.length) errs.types = "Pick at least one event, or choose All events.";
    setErrors(errs);
    if (Object.keys(errs).length) { document.getElementById(`wh-${Object.keys(errs)[0]}`)?.focus(); return; }
    const json: Record<string, unknown> = {
      name: name.trim(), url: url.trim(), environment: env === "both" ? null : env, app_id: appId || null, event_types: mode === "all" ? [] : types,
    };
    if (auth.trim()) json.authorization_header = auth.trim();
    else if (clearAuth) json.authorization_header = null;
    setBusy(true);
    try {
      const w = await api<Webhook>(`${base(pid)}/integrations/webhooks${hook ? `/${hook.id}` : ""}`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["webhooks", pid] });
      await qc.invalidateQueries({ queryKey: ["webhook", pid, w.id] });
      if (!hook && w.signing_secret) setSecret({ id: w.id, secret: w.signing_secret });
      else { toast("Webhook saved."); nav(`/projects/${pid}/integrations/webhooks/${w.id}`); }
    } catch (err) { setErrors({ form: errMsg(err) }); } finally { setBusy(false); }
  }

  const verify = `import crypto from "node:crypto";

// Express: app.post("/revenuedot", express.raw({ type: "application/json" }), handler)
function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(t)) < 300;
  return fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
// verify(req.body.toString(), req.get("X-RevenueCat-Webhook-Signature"), process.env.WEBHOOK_SECRET)`;

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <section className="panel">
        <div className="ph"><b>Endpoint</b></div>
        <div className="pb stack">
          <Field label="Name" htmlFor="wh-name" error={errors.name}>
            <input id="wh-name" className="input" maxLength={255} value={name} placeholder="Backend production" aria-invalid={!!errors.name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Webhook URL" htmlFor="wh-url" error={errors.url} hint={insecure ? "Plain http is fine for testing, but use https in production: event data includes customer IDs and prices." : "RevenueDot sends a POST with the event as JSON. Answer with HTTP 200 within 60 seconds."}>
            <input id="wh-url" className="input mono" inputMode="url" value={url} placeholder="https://api.example.com/webhooks/revenuedot" aria-invalid={!!errors.url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Authorization header value" htmlFor="wh-auth" hint={hook ? "Leave empty to keep the value that is saved, if any." : "Optional. Sent as the Authorization header on every request, for example Bearer <token>."}>
            <div className="hrow" style={{ flexWrap: "nowrap" }}>
              <input id="wh-auth" className="input mono" type={showAuth ? "text" : "password"} autoComplete="off" value={auth} placeholder={hook ? "Unchanged" : "Bearer my-webhook-token"} onChange={(e) => setAuth(e.target.value)} />
              <button type="button" className="ib" aria-label={showAuth ? "Hide value" : "Show value"} aria-pressed={showAuth} onClick={() => setShowAuth(!showAuth)}><Icon name={showAuth ? "eyeoff" : "eye"} /></button>
            </div>
          </Field>
          {hook && <Check checked={clearAuth} disabled={!!auth.trim()} onChange={setClearAuth} label="Remove the saved Authorization header" />}
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Which events</b></div>
        <div className="pb stack">
          <div className="field">
            <span className="flabel" id="wh-env-l">Environment</span>
            <Segmented label="Environment" value={env} onChange={setEnv} options={[{ value: "both", label: "Both" }, { value: "production", label: "Production" }, { value: "sandbox", label: "Sandbox" }]} />
            <span className="hint">Sandbox events come from TestFlight, Xcode, Google Play license testers and the Test Store.</span>
          </div>
          <Field label="App" htmlFor="wh-app" hint="Send events from every app in the project, or from one app only.">
            <select id="wh-app" className="select" value={appId} onChange={(e) => setAppId(e.target.value)}>
              <option value="">All apps</option>
              {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <div className="field">
            <span className="flabel">Event types</span>
            <Segmented label="Event types" value={mode} onChange={setMode} options={[{ value: "all", label: "All events" }, { value: "some", label: "Only selected events" }]} />
          </div>
          {mode === "some" && (
            <fieldset className="stack tight" id="wh-types" tabIndex={-1} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="sr">Event types to send</legend>
              <div className="hrow"><button type="button" className="btn btn-ghost" onClick={() => setTypes(EVENT_TYPES.map(([t]) => t))}>Select all</button><button type="button" className="btn btn-ghost" onClick={() => setTypes([])}>Clear</button><span className="subtle mono">{types.length} of {EVENT_TYPES.length}</span></div>
              {EVENT_GROUPS.map((g) => (
                <div key={g.title} className="stack tight" role="group" aria-label={g.title}>
                  <span className="flabel">{g.title}</span>
                  {g.sub && <span className="hint">{g.sub}</span>}
                  <div className="cols">
                    {g.types.map(([t, text]) => (
                      <Check key={t} checked={types.includes(t)} label={<span className="mono">{label(t)}</span>} hint={text}
                        onChange={(v) => setTypes((x) => (v ? [...x, t] : x.filter((y) => y !== t)))} />
                    ))}
                  </div>
                </div>
              ))}
              {errors.types && <span className="form-err" role="alert">{errors.types}</span>}
            </fieldset>
          )}
        </div>
      </section>

      {errors.form && <div className="banner err" role="alert">{errors.form}</div>}
      <div className="hrow">
        <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : hook ? "Save changes" : "Add webhook"}</button>
        <Link className="btn btn-line" to={hook ? `/projects/${pid}/integrations/webhooks/${hook.id}` : `/projects/${pid}/integrations/webhooks`}>Cancel</Link>
      </div>

      {secret && (
        <Dialog title="Copy the signing secret now" onClose={() => nav(`/projects/${pid}/integrations/webhooks/${secret.id}`)}
          footer={<button type="button" className="btn btn-dark" onClick={() => nav(`/projects/${pid}/integrations/webhooks/${secret.id}`)}>I have copied it</button>}>
          <div className="banner warn">This is the only time the secret is shown. Store it with your server's secrets.</div>
          <CodeBlock label="Signing secret" code={secret.secret} />
          <p className="section-sub">Every request carries <span className="mono">X-RevenueCat-Webhook-Signature: t=…,v1=…</span>, an HMAC-SHA256 of <span className="mono">t.body</span> with this secret. Handlers written for RevenueCat's signature work unchanged. To check it yourself:</p>
          <CodeBlock label="Node.js" code={verify} />
        </Dialog>
      )}
    </form>
  );
}

export function WebhookNew() {
  const pid = useProjectId();
  const crumbs = <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> <Link to={`/projects/${pid}/integrations/webhooks`}>Webhooks</Link> <span>/</span> <b>New</b></>;
  return (
    <Shell title="New webhook" crumbs={crumbs}>
      <div className="page narrow">
        <PageHead title="New webhook" sub="RevenueDot posts each purchase event to your URL within seconds. Failed deliveries retry after 5, 10, 20, 40 and 80 minutes." />
        <WebhookForm pid={pid} />
      </div>
    </Shell>
  );
}

const useHook = (pid: string, id: string) => useQuery({ queryKey: ["webhook", pid, id], queryFn: async () => (await withStates(pid, [await api<Webhook>(`${base(pid)}/integrations/webhooks/${encodeURIComponent(id)}`)]))[0]!, enabled: !!id, retry: false });

export function WebhookEdit() {
  const pid = useProjectId();
  const { webhookId = "" } = useParams();
  const hook = useHook(pid, webhookId);
  const crumbs = <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> <Link to={`/projects/${pid}/integrations/webhooks`}>Webhooks</Link> <span>/</span> <b>Edit</b></>;
  return (
    <Shell title="Edit webhook" crumbs={crumbs}>
      <div className="page narrow">
        <PageHead title={hook.data ? `Edit ${hook.data.name}` : "Edit webhook"} />
        {hook.isLoading && <div className="panel pb subtle">Loading…</div>}
        {hook.isError && <div className="banner err" role="alert">{errMsg(hook.error)}</div>}
        {hook.data && <WebhookForm pid={pid} hook={hook.data} />}
      </div>
    </Shell>
  );
}

export function WebhookList() {
  const pid = useProjectId();
  const nav = useNavigate();
  const hooks = useWebhooks(pid);
  const apps = useApps(pid);
  const health = useSetupHealth(pid);
  const crumbs = <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> <b>Webhooks</b></>;
  const add = <Link className="btn btn-dark" to={`/projects/${pid}/integrations/webhooks/new`}><Icon name="plus" />Add webhook</Link>;
  return (
    <Shell title="Webhooks" crumbs={crumbs}>
      <div className="page">
        <PageHead title="Webhooks" sub="Your server gets a signed POST for every purchase event. Only HTTP 200 counts as delivered; anything else retries after 5, 10, 20, 40 and 80 minutes." actions={hooks.data?.length ? add : undefined} />
        {hooks.isLoading && <div className="panel pb subtle">Loading webhooks…</div>}
        {hooks.isError && <div className="banner err" role="alert">The webhooks could not be loaded: {errMsg(hooks.error)}</div>}
        {hooks.data && !hooks.data.length && (
          <div className="empty"><h3>No webhooks yet</h3><p>Add your server's URL to receive purchases, renewals, cancellations and refunds as they happen. The payload matches RevenueCat's, so existing handlers keep working.</p>{add}</div>
        )}
        {!!hooks.data?.length && (
          <div className="panel tbl">
            <table>
              <thead><tr><th>Name</th><th>URL</th><th>Environment</th><th>Apps</th><th>Events</th><th>Status</th></tr></thead>
              <tbody>{hooks.data.map((w) => {
                const failing = health.data?.webhooks.failing.find((f) => f.id === w.id);
                const go = () => nav(`/projects/${pid}/integrations/webhooks/${w.id}`);
                return (
                  <tr key={w.id} className="row" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === "Enter") go(); }}>
                    <td><b>{w.name}</b></td>
                    <td className="url" title={w.url}>{w.url}</td>
                    <td><Tag tone={w.environment === "sandbox" ? "info" : "muted"}>{w.environment ?? "Both"}</Tag></td>
                    <td>{w.app_id ? apps.data?.find((a) => a.id === w.app_id)?.name ?? w.app_id : "All apps"}</td>
                    <td>{w.event_types.length ? `${w.event_types.length} selected` : "All events"}</td>
                    <td>{w.enabled === false ? <StatusLine tone="idle">Paused</StatusLine> : failing ? <StatusLine tone="bad">Failing{failing.last_status ? ` (HTTP ${failing.last_status})` : ""}</StatusLine> : <StatusLine tone="ok">Healthy</StatusLine>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </div>
    </Shell>
  );
}

const STATUS_TONE: Record<Delivery["status"], "up" | "info" | "down"> = { delivered: "up", pending: "info", failed: "down" };

export function WebhookDetail() {
  const pid = useProjectId();
  const { webhookId = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const hook = useHook(pid, webhookId);
  const apps = useApps(pid);
  const [status, setStatus] = useState<"all" | Delivery["status"]>("all");
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [openDelivery, setOpenDelivery] = useState<Delivery | null>(null);
  const deliveries = useInfiniteQuery({
    queryKey: ["deliveries", pid, webhookId, status],
    queryFn: ({ pageParam }) => api<List<Delivery>>(pageParam ?? `${base(pid)}/webhooks/${encodeURIComponent(webhookId)}/deliveries?limit=25${status === "all" ? "" : `&status=${status}`}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_page,
    enabled: !!hook.data,
    refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some((d) => d.status === "pending")) ? 3000 : 20_000),
  });
  const rows = deliveries.data?.pages.flatMap((p) => p.items) ?? [];
  const crumbs = <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> <Link to={`/projects/${pid}/integrations/webhooks`}>Webhooks</Link> <span>/</span> <b>{hook.data?.name ?? "Webhook"}</b></>;
  useEffect(() => { if (hook.isError) toast(errMsg(hook.error)); }, [hook.isError, hook.error, toast]);

  const sendTest = async () => {
    setSending(true);
    try {
      await api(`${base(pid)}/integrations/webhooks/${webhookId}/test`, { method: "POST" });
      toast("Test event queued. It arrives within a few seconds.");
      await qc.invalidateQueries({ queryKey: ["deliveries", pid, webhookId] });
    } catch (e) { toast(errMsg(e)); } finally { setSending(false); }
  };
  const retry = async (d: Delivery) => {
    setRetrying(d.id);
    try {
      await api(`${base(pid)}/webhooks/${webhookId}/deliveries/${d.id}/retry`, { method: "POST" });
      toast("Retry queued.");
      await qc.invalidateQueries({ queryKey: ["deliveries", pid, webhookId] });
    } catch (e) { toast(errMsg(e)); } finally { setRetrying(null); }
  };
  const [toggling, setToggling] = useState(false);
  const setEnabled = async (enabled: boolean) => {
    setToggling(true);
    try {
      await api(`${base(pid)}/integrations/webhooks/${webhookId}`, { method: "POST", json: { enabled } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["webhook", pid, webhookId] }), qc.invalidateQueries({ queryKey: ["webhooks", pid] })]);
      toast(enabled ? "Deliveries resumed." : "Deliveries paused.");
    } catch (e) { toast(errMsg(e)); } finally { setToggling(false); }
  };
  const del = async () => {
    await api(`${base(pid)}/integrations/webhooks/${webhookId}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: ["webhooks", pid] });
    toast("Webhook deleted.");
    nav(`/projects/${pid}/integrations/webhooks`);
  };

  const w = hook.data;
  return (
    <Shell title={w?.name ?? "Webhook"} crumbs={crumbs}>
      <div className="page">
        {hook.isLoading && <div className="panel pb subtle">Loading…</div>}
        {hook.isError && <div className="empty"><h3>This webhook does not exist</h3><p>It may have been deleted.</p><Link className="btn btn-line" to={`/projects/${pid}/integrations/webhooks`}>Back to webhooks</Link></div>}
        {w && (
          <>
            <PageHead title={w.name} sub={<span className="mono">{w.url}</span>} actions={<>
              <button type="button" className="btn btn-dark" disabled={sending || w.enabled === false} title={w.enabled === false ? "Turn deliveries on to send a test event" : undefined} onClick={sendTest}><Icon name="send" />{sending ? "Sending…" : "Send test event"}</button>
              <Link className="btn btn-line" to={`/projects/${pid}/integrations/webhooks/${w.id}/edit`}><Icon name="edit" />Edit</Link>
              <Menu label="More actions" items={[{ label: "Delete webhook", icon: "trash", danger: true, onSelect: () => setDeleting(true) }]} />
            </>} />
            {w.enabled === false && <div className="banner" role="status">Deliveries are paused. New events are not sent to this URL; queued retries wait until you turn deliveries back on.</div>}
            <KeyValue rows={[
              ["Deliveries", <span key="en" className="hrow"><Switch checked={w.enabled !== false} onChange={(v) => { if (!toggling) void setEnabled(v); }} label={w.enabled === false ? "Paused" : "On"} /></span>],
              ["Environment", envLabel(w.environment)],
              ["Apps", w.app_id ? apps.data?.find((a) => a.id === w.app_id)?.name ?? w.app_id : "All apps"],
              ["Events", w.event_types.length ? <span className="hrow">{w.event_types.map((t) => <Tag key={t} tone={EVENT_TONE[label(t)] ?? "muted"}>{label(t)}</Tag>)}</span> : "All events"],
              ["Signature", <>Each request is signed with <span className="mono">X-RevenueCat-Webhook-Signature</span> using the secret shown when the webhook was created.</>],
              ["Created", fmt.dateTime(w.created_at)],
              ["Webhook ID", <span className="mono">{w.id}</span>],
            ]} />
            <section className="panel">
              <div className="ph wrap">
                <b>Deliveries</b>
                <span className="hrow">
                  <Segmented label="Delivery status" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "pending", label: "Pending" }, { value: "delivered", label: "Delivered" }, { value: "failed", label: "Failed" }]} />
                  <button type="button" className="ib" aria-label="Refresh deliveries" onClick={() => deliveries.refetch()}><Icon name="refresh" /></button>
                </span>
              </div>
              {deliveries.isLoading && <div className="pb subtle">Loading deliveries…</div>}
              {deliveries.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(deliveries.error)}</div></div>}
              {deliveries.data && !rows.length && <div className="pb section-sub">{status === "all" ? "No deliveries yet. Click Send test event, or make a purchase, and it shows up here within seconds." : `No ${status} deliveries.`}</div>}
              {!!rows.length && (
                <div className="tbl">
                  <table>
                    <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>Next attempt</th><th>Created</th><th aria-label="Actions" /></tr></thead>
                    <tbody>{rows.map((d) => (
                      <tr key={d.id} className="row" tabIndex={0} onClick={() => setOpenDelivery(d)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) setOpenDelivery(d); }}>
                        <td><Tag tone={EVENT_TONE[d.event_type] ?? "muted"}>{d.event_type}</Tag><span className="cellsub mono" title={d.event_id}>{d.event_id.slice(0, 8)}…</span></td>
                        <td><Tag tone={STATUS_TONE[d.status]}>{d.status}</Tag>{d.last_error && d.status !== "delivered" && <span className="cellsub">{d.last_error}</span>}</td>
                        <td className="num">{d.attempts}</td>
                        <td className="num">{d.response_status !== null ? `${d.response_status}` : d.attempts ? "No answer" : "—"}{d.response_ms !== null && <span className="subtle"> · {d.response_ms} ms</span>}</td>
                        <td>{d.next_attempt_at && d.status === "pending" ? (d.next_attempt_at <= Date.now() ? "Now" : fmt.dateTime(d.next_attempt_at)) : "—"}</td>
                        <td title={fmt.dateTime(d.created_at)}>{fmt.ago(d.created_at)}</td>
                        <td className="amt"><span className="hrow" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="btn btn-ghost" onClick={() => setOpenDelivery(d)}>Details</button>
                          {d.status !== "delivered" && <button type="button" className="btn btn-line" disabled={retrying === d.id} onClick={() => retry(d)}>{retrying === d.id ? "Retrying…" : "Retry"}</button>}
                        </span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {deliveries.hasNextPage && <div className="pb"><button type="button" className="btn btn-line" disabled={deliveries.isFetchingNextPage} onClick={() => deliveries.fetchNextPage()}>{deliveries.isFetchingNextPage ? "Loading…" : "Load more"}</button></div>}
            </section>
          </>
        )}
      </div>
      {deleting && w && (
        <ConfirmDialog title={`Delete ${w.name}?`} confirmLabel="Delete webhook" danger onConfirm={del} onClose={() => setDeleting(false)}>
          <p>RevenueDot stops sending events to <span className="mono">{w.url}</span> right away, and pending retries are dropped. This cannot be undone.</p>
        </ConfirmDialog>
      )}
      {openDelivery && (
        <DeliveryDrawer path={`${base(pid)}/webhooks/${encodeURIComponent(webhookId)}/deliveries/${openDelivery.id}`} title={`${openDelivery.event_type} · ${openDelivery.event_id.slice(0, 8)}…`}
          onClose={() => setOpenDelivery(null)} onRetry={() => retry(openDelivery)}
          canRetry={(x) => x.status !== "delivered" && !(x.status === "pending" && (x.next_attempt_at ?? 0) <= Date.now())} />
      )}
    </Shell>
  );
}
