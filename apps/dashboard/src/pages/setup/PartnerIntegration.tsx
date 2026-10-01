import { Fragment, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ADJUST_STEPS, INTEGRATION_EVENTS, STEP_LABELS, defaultEventName, type Concept, type IntegrationKind } from "@revenuedot/core/integrations";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Check, CodeBlock, ConfirmDialog, Dialog, Disclosure, EVENT_TONE, Field, KeyValue, Menu, PageHead, Segmented, StatusLine, Switch, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg, useApps, useIntegrations, useIntegrationTypes, type Integration, type IntegrationDelivery, type IntegrationType } from "./data";
import { IntercomInboxPanel } from "./SupportApps";
import { AppleAdsPanel } from "../ads/AppleAdsPanel";

/**
 * One partner integration (/projects/:projectId/integrations/:type): Slack, Segment, Amplitude, Mixpanel, PostHog,
 * Firebase, BigQuery, AppsFlyer, Adjust or Meta. The form is drawn from the catalogue (GET …/integrations/catalog);
 * saved secrets show only their last characters. Connected integrations have a deliveries switch, "Send test event",
 * event name overrides, and the delivery log with the request, the partner's answer, Retry and "Replay failed".
 * GAPS vs RevenueCat: one integration per type in this page (the API allows several); no per-event toggles beyond the
 * event-type filter of the API.
 */

type Env = "both" | "production" | "sandbox";
const STATUS_TONE: Record<IntegrationDelivery["status"], "up" | "info" | "down" | "muted"> = { delivered: "up", pending: "info", failed: "down", skipped: "muted" };

function IntegrationForm({ pid, spec, current, onSaved }: { pid: string; spec: IntegrationType; current?: Integration; onSaved: (i: Integration) => void }) {
  const qc = useQueryClient();
  const apps = useApps(pid);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...(current?.settings ?? {}) }));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const [env, setEnv] = useState<Env>(current ? current.environment ?? "both" : spec.default_environment ?? "both");
  const [appId, setAppId] = useState(current?.app_id ?? "");
  const [names, setNames] = useState<Record<string, string>>(current?.event_names ?? {});
  const [error, setError] = useState<{ message: string; param?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = spec.type as IntegrationKind;
  const steps = (INTEGRATION_EVENTS[kind] === "all" ? [] : INTEGRATION_EVENTS[kind] as Concept[]).filter((c) => c !== "test");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const settings: Record<string, unknown> = {};
    for (const f of spec.fields) {
      if (f.type === "secret") {
        if (secrets[f.key]?.trim()) settings[f.key] = secrets[f.key]!.trim();
        else if (clear[f.key]) settings[f.key] = null;
        else if (!current && f.required) { setError({ message: `${f.label} is required.`, param: `settings.${f.key}` }); document.getElementById(`f-${f.key}`)?.focus(); return; }
        continue;
      }
      const v = values[f.key];
      if (v === undefined) continue;
      settings[f.key] = v === "" ? null : v;
    }
    const json: Record<string, unknown> = { settings, environment: env === "both" ? null : env, app_id: appId || null };
    if (spec.event_names) json.event_names = Object.fromEntries(Object.entries(names).filter(([, v]) => v.trim()));
    if (!current) json.type = spec.type;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Integration>(`${base(pid)}/integrations/partners${current ? `/${current.id}` : ""}`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["integrations", pid] });
      setSecrets({}); setClear({});
      onSaved(saved);
    } catch (err) {
      const b = (err as { body?: { message?: string; param?: string } }).body;
      setError({ message: errMsg(err), param: b?.param });
      if (b?.param) document.getElementById(`f-${b.param.replace(/^settings\./, "").split(".")[0]}`)?.focus();
    } finally { setBusy(false); }
  }

  const shown = spec.fields.filter((f) => !f.when || values[f.when.key] === f.when.value);
  const fieldErr = (key: string) => (error?.param === `settings.${key}` || error?.param?.startsWith(`settings.${key}.`) ? error.message : null);
  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={`${spec.name} settings`}>
      <section className="panel">
        <div className="ph"><b>Connection</b><a className="link" href={spec.docs_url} target="_blank" rel="noreferrer">Setup guide →</a></div>
        <div className="pb stack">
          {shown.map((f) => {
            const id = `f-${f.key}`;
            if (f.type === "boolean") return <Check key={f.key} checked={values[f.key] === true} onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))} label={f.label} hint={f.hint} />;
            if (f.type === "select") {
              return (
                <Field key={f.key} label={f.label} htmlFor={id} hint={f.hint} error={fieldErr(f.key)}>
                  <select id={id} className="select" value={String(values[f.key] ?? f.options![0]!.value)} onChange={(e) => setValues((x) => ({ ...x, [f.key]: e.target.value }))}>
                    {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
              );
            }
            if (f.type === "tokens") {
              const tokens = (values[f.key] ?? {}) as Record<string, string>;
              return (
                <fieldset key={f.key} id={id} tabIndex={-1} className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className="flabel">{f.label}</legend>
                  {f.hint && <span className="section-sub">{f.hint}</span>}
                  <div className="cols">
                    {(ADJUST_STEPS as Concept[]).filter((c) => c !== "test").map((c) => (
                      <Field key={c} label={STEP_LABELS[c]} htmlFor={`tok-${c}`}>
                        <input id={`tok-${c}`} className="input mono" value={tokens[c] ?? ""} placeholder="abc123" onChange={(e) => setValues((x) => ({ ...x, [f.key]: { ...((x[f.key] ?? {}) as Record<string, string>), [c]: e.target.value } }))} />
                      </Field>
                    ))}
                  </div>
                  {fieldErr(f.key) && <span className="form-err" role="alert">{error!.message}</span>}
                </fieldset>
              );
            }
            if (f.type === "secret") {
              const saved = current?.secrets[f.key];
              return (
                <Fragment key={f.key}>
                  <Field label={f.label} htmlFor={id} error={fieldErr(f.key)} hint={saved?.configured ? <>Saved: <span className="mono">{saved.hint}</span>. Leave empty to keep it.</> : f.hint}>
                    {f.key.endsWith("_json")
                      ? <textarea id={id} className="input mono" rows={4} value={secrets[f.key] ?? ""} placeholder={saved?.configured ? "Unchanged" : '{ "type": "service_account", … }'} onChange={(e) => setSecrets((x) => ({ ...x, [f.key]: e.target.value }))} />
                      : <input id={id} className="input mono" type="password" autoComplete="off" value={secrets[f.key] ?? ""} placeholder={saved?.configured ? "Unchanged" : f.placeholder} onChange={(e) => setSecrets((x) => ({ ...x, [f.key]: e.target.value }))} />}
                  </Field>
                  {saved?.configured && !f.required && <Check checked={!!clear[f.key]} disabled={!!secrets[f.key]?.trim()} onChange={(v) => setClear((x) => ({ ...x, [f.key]: v }))} label={`Remove the saved ${f.label.toLowerCase()}`} />}
                </Fragment>
              );
            }
            return (
              <Field key={f.key} label={f.label} htmlFor={id} hint={f.hint} error={fieldErr(f.key)}>
                <input id={id} className="input mono" value={String(values[f.key] ?? "")} placeholder={f.placeholder} onChange={(e) => setValues((x) => ({ ...x, [f.key]: e.target.value }))} />
              </Field>
            );
          })}
        </div>
      </section>
      {!spec.connection && <section className="panel">
        <div className="ph"><b>Which events</b></div>
        <div className="pb stack">
          <div className="field">
            <span className="flabel">Environment</span>
            <Segmented label="Environment" value={env} onChange={setEnv} options={[{ value: "both", label: "Both" }, { value: "production", label: "Production" }, { value: "sandbox", label: "Sandbox" }]} />
            <span className="hint">Sandbox events come from TestFlight, Xcode, Google Play license testers and the Test Store.</span>
          </div>
          <Field label="App" htmlFor="f-app" hint="Send events from every app in the project, or from one app only.">
            <select id="f-app" className="select" value={appId} onChange={(e) => setAppId(e.target.value)}>
              <option value="">All apps</option>
              {apps.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          {spec.event_names && (
            <Disclosure title="Event names" sub="Defaults match RevenueCat's, so existing dashboards keep working. Override any of them.">
              <div className="cols">
                {steps.map((c) => (
                  <Field key={c} label={STEP_LABELS[c]} htmlFor={`name-${c}`}>
                    <input id={`name-${c}`} className="input mono" value={names[c] ?? ""} placeholder={defaultEventName(kind, c) ?? ""} onChange={(e) => setNames((x) => ({ ...x, [c]: e.target.value }))} />
                  </Field>
                ))}
              </div>
            </Disclosure>
          )}
        </div>
      </section>}
      {error && !fieldErr(error.param?.replace(/^settings\./, "").split(".")[0] ?? "") && <div className="banner err" role="alert">{error.message}</div>}
      <div className="hrow"><button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : current ? "Save changes" : `Connect ${spec.name}`}</button></div>
    </form>
  );
}

function Deliveries({ pid, integration }: { pid: string; integration: Integration }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<"all" | IntegrationDelivery["status"]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const id = integration.id;
  const q = useInfiniteQuery({
    queryKey: ["integration_deliveries", pid, id, status],
    queryFn: ({ pageParam }) => api<List<IntegrationDelivery>>(pageParam ?? `${base(pid)}/integrations/partners/${id}/deliveries?limit=25${status === "all" ? "" : `&status=${status}`}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_page,
    refetchInterval: (s) => (s.state.data?.pages.some((p) => p.items.some((d) => d.status === "pending")) ? 2000 : 15_000),
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["integration_deliveries", pid, id] });
  const retry = async (d: IntegrationDelivery) => {
    setBusy(d.id);
    try { await api(`${base(pid)}/integrations/partners/${id}/deliveries/${d.id}/retry`, { method: "POST" }); toast("Retry queued."); await refresh(); } catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  };
  const replay = async () => {
    setBusy("replay");
    try {
      const r = await api<{ queued: number }>(`${base(pid)}/integrations/partners/${id}/actions/replay`, { method: "POST", json: { status: "failed_and_skipped" } });
      toast(r.queued ? `${r.queued} ${r.queued === 1 ? "delivery" : "deliveries"} queued again.` : "Nothing to replay.");
      await refresh();
    } catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <section className="panel">
      <div className="ph wrap">
        <b>Deliveries</b>
        <span className="hrow">
          <Segmented label="Delivery status" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "delivered", label: "Delivered" }, { value: "failed", label: "Failed" }, { value: "skipped", label: "Skipped" }, { value: "pending", label: "Pending" }]} />
          <button type="button" className="btn btn-line" disabled={busy === "replay"} onClick={replay}>{busy === "replay" ? "Replaying…" : "Replay failed"}</button>
          <button type="button" className="ib" aria-label="Refresh deliveries" onClick={() => q.refetch()}><Icon name="refresh" /></button>
        </span>
      </div>
      {q.isLoading && <div className="pb subtle">Loading deliveries…</div>}
      {q.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(q.error)}</div></div>}
      {q.data && !rows.length && <div className="pb section-sub">{status === "all" ? "No deliveries yet. Send a test event, or make a purchase, and it shows up here within seconds." : `No ${status} deliveries.`}</div>}
      {!!rows.length && (
        <div className="tbl">
          <table>
            <thead><tr><th>Event</th><th>Sent as</th><th>Status</th><th>Attempts</th><th>Response</th><th>Created</th><th aria-label="Actions" /></tr></thead>
            <tbody>{rows.map((d) => (
              <Fragment key={d.id}>
                <tr>
                  <td><Tag tone={EVENT_TONE[d.event_type] ?? "muted"}>{d.event_type}</Tag><span className="cellsub mono" title={d.event_id}>{d.event_id.slice(0, 8)}…</span></td>
                  <td className="mono">{d.sent_as ?? "—"}</td>
                  <td><Tag tone={STATUS_TONE[d.status]}>{d.status}</Tag>{d.last_error && d.status !== "delivered" && <span className="cellsub">{d.last_error}</span>}</td>
                  <td className="num">{d.attempts}</td>
                  <td className="num">{d.response_status ?? (d.attempts ? "No answer" : "—")}{d.response_ms !== null && <span className="subtle"> · {d.response_ms} ms</span>}</td>
                  <td title={fmt.dateTime(d.created_at)}>{fmt.ago(d.created_at)}</td>
                  <td className="amt"><span className="hrow" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
                    {d.request && <button type="button" className="btn btn-ghost" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? "Hide" : "Details"}</button>}
                    {d.status !== "delivered" && d.status !== "pending" && <button type="button" className="btn btn-line" disabled={busy === d.id} onClick={() => retry(d)}>{busy === d.id ? "Retrying…" : "Retry"}</button>}
                  </span></td>
                </tr>
                {open === d.id && (
                  <tr><td colSpan={7}><div className="stack tight" style={{ padding: "8px 0" }}>
                    <CodeBlock label="Request" code={`${d.request}\n\n${d.request_body ?? ""}`} />
                    <CodeBlock label={`Response${d.response_status ? ` · HTTP ${d.response_status}` : ""}`} code={d.response_body || "(empty)"} />
                  </div></td></tr>
                )}
              </Fragment>
            ))}</tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && <div className="pb"><button type="button" className="btn btn-line" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.isFetchingNextPage ? "Loading…" : "Load more"}</button></div>}
    </section>
  );
}

export function PartnerIntegrationPage() {
  const pid = useProjectId();
  const { type = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const types = useIntegrationTypes(pid);
  const list = useIntegrations(pid);
  const spec = types.data?.find((t) => t.type === type);
  const current = list.data?.find((i) => i.type === type);
  const [testing, setTesting] = useState(false);
  const [testUser, setTestUser] = useState("");
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);
  const crumbs = <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> <b>{spec?.name ?? type}</b></>;
  useEffect(() => { setTestUser(""); }, [type]);

  const setEnabled = async (enabled: boolean) => {
    if (!current) return;
    setToggling(true);
    try {
      await api(`${base(pid)}/integrations/partners/${current.id}`, { method: "POST", json: { enabled } });
      await qc.invalidateQueries({ queryKey: ["integrations", pid] });
      toast(enabled ? `${spec?.name} is on.` : `${spec?.name} is off. Events are not sent until you turn it back on.`);
    } catch (e) { toast(errMsg(e)); } finally { setToggling(false); }
  };
  const sendTest = async () => {
    if (!current) return;
    setSending(true);
    try {
      await api(`${base(pid)}/integrations/partners/${current.id}/test`, { method: "POST", json: testUser.trim() ? { app_user_id: testUser.trim() } : {} });
      setTesting(false);
      toast("Test event queued. It shows in the deliveries within a few seconds.");
      await qc.invalidateQueries({ queryKey: ["integration_deliveries", pid, current.id] });
    } catch (e) { toast(errMsg(e)); } finally { setSending(false); }
  };
  const del = async () => {
    if (!current) return;
    await api(`${base(pid)}/integrations/partners/${current.id}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: ["integrations", pid] });
    toast(`${spec?.name} disconnected.`);
    nav(`/projects/${pid}/integrations`);
  };

  return (
    <Shell title={spec?.name ?? "Integration"} crumbs={crumbs}>
      <div className="page narrow">
        {(types.isLoading || list.isLoading) && <div className="panel pb subtle">Loading…</div>}
        {types.data && !spec && <div className="empty"><h3>No integration called {type}</h3><Link className="btn btn-line" to={`/projects/${pid}/integrations`}>Back to integrations</Link></div>}
        {spec && list.data && (
          <>
            <PageHead title={spec.name} sub={spec.description} actions={current ? <>
              {!spec.connection && <button type="button" className="btn btn-dark" disabled={!current.enabled} title={current.enabled ? undefined : "Turn the integration on to send a test event"} onClick={() => setTesting(true)}><Icon name="send" />Send test event</button>}
              <Menu label="More actions" items={[{ label: `Disconnect ${spec.name}`, icon: "trash", danger: true, onSelect: () => setDeleting(true) }]} />
            </> : undefined} />
            {current && (
              <>
                {!current.enabled && <div className="banner" role="status">{spec.name} is off. New events are not queued; failed deliveries wait until you turn it back on.</div>}
                <KeyValue rows={[
                  ["Deliveries", <span key="en" className="hrow"><Switch checked={current.enabled} onChange={(v) => { if (!toggling) void setEnabled(v); }} label={current.enabled ? "On" : "Off"} /></span>],
                  ["Status", current.status.consecutive_failures ? <StatusLine tone="bad">Failing · {current.status.last_error}</StatusLine> : current.status.last_delivered_at ? <StatusLine tone="ok">Delivered {fmt.ago(current.status.last_delivered_at)}</StatusLine> : <StatusLine tone="idle">Nothing sent yet</StatusLine>],
                  ["Integration ID", <span className="mono">{current.id}</span>],
                ]} />
              </>
            )}
            {spec.api === "webhook" && <div className="banner" role="status">{spec.name} publishes no event API of its own. RevenueDot posts RevenueCat's webhook body to the URL {spec.name} gives you, which is how {spec.name} connects to RevenueCat too.</div>}
            {spec.type === "intercom_inbox" && <IntercomInboxPanel pid={pid} />}
            <IntegrationForm key={current?.id ?? "new"} pid={pid} spec={spec} current={current} onSaved={() => toast(current ? "Saved." : spec.connection ? `${spec.name} is connected.` : `${spec.name} is connected. Send a test event to check it.`)} />
            {current && !spec.connection && <Deliveries pid={pid} integration={current} />}
            {spec.type === "apple_search_ads" && <AppleAdsPanel pid={pid} canSync={!!current?.secrets.private_key?.configured} />}
          </>
        )}
      </div>
      {testing && current && spec && (
        <Dialog title="Send a test event" onClose={() => setTesting(false)}
          footer={<><button type="button" className="btn btn-line" onClick={() => setTesting(false)}>Cancel</button><button type="button" className="btn btn-dark" disabled={sending} onClick={sendTest}>{sending ? "Sending…" : "Send test event"}</button></>}>
          <p className="section-sub">RevenueDot sends a TEST event to {spec.name} now. Attribution partners need the customer's device ids, so enter an app user ID whose attributes include them.</p>
          <Field label="App user ID (optional)" htmlFor="test-user"><input id="test-user" className="input mono" value={testUser} onChange={(e) => setTestUser(e.target.value)} placeholder="$RCAnonymousID:… or your user id" /></Field>
        </Dialog>
      )}
      {deleting && current && spec && (
        <ConfirmDialog title={`Disconnect ${spec.name}?`} confirmLabel="Disconnect" danger onConfirm={del} onClose={() => setDeleting(false)}>
          <p>RevenueDot stops sending events to {spec.name} and deletes the saved keys and the delivery log. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}
