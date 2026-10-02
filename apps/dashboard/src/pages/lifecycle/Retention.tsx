/**
 * Lifecycle / Retention: /projects/:projectId/lifecycle/retention
 * RevenueCat's "Retention Offers" page: two tabs and a Sandbox data switch.
 * - Apple Retention Messaging API (per App Store app): messages, default messages per product and locale, real-time rules,
 *   the real-time URL, "Sync to Apple" per environment. Apple grants access to this API on request.
 * - Customer Center: offers shown when a customer cancels ("Cancellation Retention Discount") or asks for a refund
 *   ("Refunds Retention Discount"), each linking store products to a store offer id.
 * API: GET/POST /apps/{id}/retention_messaging (+ /actions/sync), GET/POST /retention_offers, POST/DELETE /retention_offers/{id}.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { ConfirmDialog, CopyField, DataTable, Dialog, EmptyState, Field, Menu, PageHead, Panel, StatusLine, Switch, Tabs, Tag, useProjectId, useSandboxParam, useToast } from "../../components/ui";
import { errMsg, productName, useApps, useProducts, v2, type App, type Product } from "../catalog/lib";
import { MESSAGE_KINDS, type AppleEnv, type Messaging, type RetentionMessage, type RetentionOffer } from "./lib";

type Tab = "apple" | "customer_center";
const APPLE_TYPES = new Set(["app_store", "mac_app_store"]);
const APPROVAL_URL = "https://developer.apple.com/contact/request/retention-messaging-api/";

export function RetentionPage() {
  const [sp, setSp] = useSearchParams();
  const tab: Tab = sp.get("tab") === "customer_center" ? "customer_center" : "apple";
  const [sandbox, setSandbox] = useSandboxParam();
  return (
    <Shell title="Retention">
      <div className="page">
        <PageHead title="Retention Offers" sub="Decide what customers see at the moments they are about to leave, such as cancelling or asking for a refund, to keep more of them." />
        <Tabs label="Retention" idBase="retention" value={tab} onChange={(t) => { const n = new URLSearchParams(sp); n.set("tab", t); setSp(n, { replace: true }); }}
          tabs={[{ value: "apple", label: "Apple Retention Messaging API" }, { value: "customer_center", label: "Customer Center" }]}
          right={<Switch checked={sandbox} onChange={setSandbox} label="Sandbox data" />} />
        <div role="tabpanel" id={`retention-${tab}-panel`} aria-labelledby={`retention-${tab}`} className="stack">
          {tab === "apple" ? <AppleTab env={sandbox ? "sandbox" : "production"} /> : <CustomerCenterTab />}
        </div>
      </div>
    </Shell>
  );
}

// ---------- Apple Retention Messaging ----------

function AppleTab({ env }: { env: AppleEnv }) {
  const pid = useProjectId();
  const apps = useApps(pid);
  const appleApps = (apps.data ?? []).filter((a) => APPLE_TYPES.has(a.type));
  const [appId, setAppId] = useState<string>("");
  useEffect(() => { if (!appId && appleApps[0]) setAppId(appleApps[0].id); }, [appId, appleApps]);
  const intro = <p className="section-sub">Show a message or an offer natively on iOS when a customer is about to cancel in their App Store subscription settings. Apple asks RevenueDot which message to show, and falls back to the default message.</p>;
  if (apps.isError) return <div className="banner err" role="alert">Apps could not be loaded: {errMsg(apps.error)}</div>;
  if (apps.isLoading) return <div className="panel pb" aria-busy="true"><span className="sk line" /></div>;
  if (!appleApps.length) return <>{intro}<EmptyState title="No App Store app yet" text="Apple's Retention Messaging API works per App Store app. Add your App Store app with its In-App Purchase key first." action={<Link className="btn btn-dark" to={`/projects/${pid}/apps`}>Open Apps</Link>} /></>;
  return (
    <>
      {intro}
      <div className="banner" role="note">
        <Icon name="apple" />
        <span>Apple must approve your developer account for the Retention Messaging API before it accepts these calls. Until then, syncing fails with an Apple error. <a className="link-u" href={APPROVAL_URL} target="_blank" rel="noreferrer">Request access from Apple</a>.</span>
      </div>
      {appleApps.length > 1 && (
        <Field label="App Store app" htmlFor="rm-app">
          <select id="rm-app" className="select" style={{ maxWidth: 360 }} value={appId} onChange={(e) => setAppId(e.target.value)}>{appleApps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </Field>
      )}
      {appId && <AppMessaging key={appId} app={appleApps.find((a) => a.id === appId)!} env={env} />}
    </>
  );
}

function AppMessaging({ app, env }: { app: App; env: AppleEnv }) {
  const pid = useProjectId();
  const toast = useToast();
  const qc = useQueryClient();
  const key = ["retention-messaging", pid, app.id];
  const q = useQuery({ queryKey: key, queryFn: () => api<Messaging>(`${v2(pid)}/apps/${app.id}/retention_messaging`) });
  const products = useProducts(pid);
  const appProducts = (products.data ?? []).filter((p) => p.app_id === app.id);
  const [dialog, setDialog] = useState<"message" | null>(null);
  const [confirm, setConfirm] = useState<RetentionMessage | null>(null);
  const [syncing, setSyncing] = useState<AppleEnv | null>(null);
  const [sync, setSync] = useState<{ environment: AppleEnv; errors: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [def, setDef] = useState({ product: "", locale: "en-US", message: "" });
  const [rule, setRule] = useState({ product: "", message: "" });

  const save = async (patch: Partial<Pick<Messaging, "enabled" | "messages" | "defaults" | "rules">>, ok: string) => {
    setErr(null);
    try {
      const body: Record<string, unknown> = { ...patch };
      if (patch.messages) body.messages = patch.messages.map(({ id, kind, header, body: b, alternate_product_id, promotional_offer_id }) => ({ id, kind, header, body: b, alternate_product_id: alternate_product_id ?? null, promotional_offer_id: promotional_offer_id ?? null }));
      if (patch.defaults) body.defaults = patch.defaults.map(({ product_id, locale, message_id }) => ({ product_id, locale, message_id }));
      const res = await api<Messaging>(`${v2(pid)}/apps/${app.id}/retention_messaging`, { method: "POST", json: body });
      qc.setQueryData(key, res); toast(ok); return true;
    } catch (e) { setErr(errMsg(e)); return false; }
  };
  const runSync = async (environment: AppleEnv) => {
    setSyncing(environment); setErr(null); setSync(null);
    try {
      const res = await api<Messaging>(`${v2(pid)}/apps/${app.id}/retention_messaging/actions/sync`, { method: "POST", json: { environment } });
      qc.setQueryData(key, res); setSync(res.sync ?? { environment, errors: [] });
    } catch (e) { setSync({ environment, errors: [errMsg(e)] }); }
    setSyncing(null);
  };

  if (q.isError) return <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>{errMsg(q.error)}</span><button type="button" className="btn btn-line" onClick={() => q.refetch()}>Retry</button></div>;
  if (!q.data) return <div className="panel pb" aria-busy="true"><span className="sk line" /></div>;
  const m = q.data;
  const msgName = (id: string) => m.messages.find((x) => x.id === id)?.header ?? id;
  const textMessages = m.messages.filter((x) => x.kind === "text");
  const envLabel = env === "sandbox" ? "sandbox" : "production";
  const registered = m.realtime_url_configured?.[env];

  return (
    <>
      <Panel title={app.name} link={<Switch checked={m.enabled} onChange={(v) => void save({ enabled: v }, v ? "Retention messages are on" : "Retention messages are off")} label="Answer Apple's real-time requests" />}>
        <div className="stack tight">
          {m.has_in_app_purchase_key
            ? <StatusLine tone="ok">The In-App Purchase key is set; RevenueDot can upload messages and sign promotional offers.</StatusLine>
            : <StatusLine tone="bad">No In-App Purchase key yet: syncing to Apple and signing promotional offers need it. <Link className="link-u" to={`/projects/${pid}/apps/${app.id}`}>Add it in the app's settings</Link></StatusLine>}
          {m.app_apple_id
            ? <StatusLine tone="ok">Apple ID of the app: <span className="mono">{m.app_apple_id}</span>. RevenueDot only answers Apple's requests for this app.</StatusLine>
            : <AppleIdForm pid={pid} appId={app.id} appType={app.type} onSaved={() => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ["catalog", pid] }); }} />}
          <StatusLine tone={m.stats.requests ? "live" : "idle"}>
            <span data-testid="rm-requests">{fmt.int(m.stats.requests)} request{m.stats.requests === 1 ? "" : "s"} from Apple, {fmt.int(m.stats.answered)} answered with a message</span>
            {m.stats.last_request_at ? <span className="subtle"> · last {fmt.ago(m.stats.last_request_at)} ({m.stats.last_environment?.toLowerCase() ?? "unknown"})</span> : <span className="subtle"> · none yet in either environment</span>}
          </StatusLine>
        </div>
      </Panel>

      <Panel title="Messages" link={<button type="button" className="btn btn-line" onClick={() => setDialog("message")}><Icon name="plus" />New message</button>} flush>
        <DataTable rowKey={(x) => x.id} rows={m.messages} empty={<div className="pnote">No messages yet. A message has a header of up to 66 characters and a body of up to 144.</div>} columns={[
          { key: "h", header: "Message", className: "wrap", render: (x) => <span><b style={{ fontWeight: 600 }}>{x.header}</b><span className="cellsub">{x.body}</span></span> },
          { key: "k", header: "Kind", render: (x) => <span>{MESSAGE_KINDS.find((k) => k.value === x.kind)?.label}{x.alternate_product_id && <span className="cellsub mono">{x.alternate_product_id}</span>}{x.promotional_offer_id && <span className="cellsub mono">{x.promotional_offer_id}</span>}</span> },
          { key: "s", header: `Apple (${envLabel})`, render: (x) => x.error ? <span title={x.error}><Tag tone="down">Failed</Tag></span> : x.uploaded?.includes(env) ? <Tag tone="up">Uploaded</Tag> : <Tag tone="muted">Not uploaded</Tag> },
          { key: "menu", header: "", align: "right", render: (x) => <Menu label={`Actions for ${x.header}`} items={[
            { label: "Copy message ID", icon: "copy", onSelect: () => { void navigator.clipboard?.writeText(x.id).catch(() => undefined); toast("Message ID copied"); } },
            "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setConfirm(x) },
          ]} /> },
        ]} />
      </Panel>

      <div className="cols">
        <Panel title="Default messages">
          <div className="stack tight">
            <p className="section-sub">Apple shows the default when the real-time answer is late or empty. One per product and locale; text messages only.</p>
            {m.defaults.length > 0 && (
              <div className="tbl"><table className="compact"><thead><tr><th>Product</th><th>Locale</th><th>Message</th><th /></tr></thead><tbody>
                {m.defaults.map((d, i) => (
                  <tr key={`${d.product_id}-${d.locale}`}><td className="mono" style={{ fontSize: 12 }}>{d.product_id}</td><td className="mono" style={{ fontSize: 12 }}>{d.locale}</td><td>{msgName(d.message_id)}</td>
                    <td className="amt"><button type="button" className="ib" aria-label={`Remove default for ${d.product_id} ${d.locale}`} onClick={() => void save({ defaults: m.defaults.filter((_, j) => j !== i) }, "Default removed")}><Icon name="trash" /></button></td></tr>
                ))}
              </tbody></table></div>
            )}
            <form className="inline-row" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (!def.product || !def.message) { setErr("Pick a product and a text message for the default."); return; } if (await save({ defaults: [...m.defaults, { product_id: def.product, locale: def.locale.trim(), message_id: def.message }] }, "Default message added")) setDef({ ...def, product: "" }); }}>
              <Field label="Product" htmlFor="rm-def-p"><select id="rm-def-p" className="select" value={def.product} onChange={(e) => setDef({ ...def, product: e.target.value })}><option value="">Choose…</option>{appProducts.map((p) => <option key={p.id} value={p.store_identifier}>{p.store_identifier}</option>)}</select></Field>
              <Field label="Locale" htmlFor="rm-def-l"><input id="rm-def-l" className="input mono" value={def.locale} onChange={(e) => setDef({ ...def, locale: e.target.value })} /></Field>
              <Field label="Text message" htmlFor="rm-def-m"><select id="rm-def-m" className="select" value={def.message} onChange={(e) => setDef({ ...def, message: e.target.value })}><option value="">Choose…</option>{textMessages.map((x) => <option key={x.id} value={x.id}>{x.header}</option>)}</select></Field>
              <button type="submit" className="btn btn-line">Add default</button>
            </form>
          </div>
        </Panel>
        <Panel title="Real-time rules">
          <div className="stack tight">
            <p className="section-sub">When Apple asks, the first rule whose product matches picks the message. A rule for "Any product" catches the rest.</p>
            {m.rules.length > 0 && (
              <div className="tbl"><table className="compact"><thead><tr><th>#</th><th>Product</th><th>Message</th><th /></tr></thead><tbody>
                {m.rules.map((r, i) => (
                  <tr key={i}><td className="mono" style={{ fontSize: 12 }}>{i + 1}</td><td className="mono" style={{ fontSize: 12 }}>{r.product_id ?? "Any product"}</td><td>{msgName(r.message_id)}</td>
                    <td className="amt"><button type="button" className="ib" aria-label={`Remove rule ${i + 1}`} onClick={() => void save({ rules: m.rules.filter((_, j) => j !== i) }, "Rule removed")}><Icon name="trash" /></button></td></tr>
                ))}
              </tbody></table></div>
            )}
            <form className="inline-row" onSubmit={async (e: FormEvent) => { e.preventDefault(); if (!rule.message) { setErr("Pick the message the rule answers with."); return; } if (await save({ rules: [...m.rules, { product_id: rule.product || null, message_id: rule.message }] }, "Rule added")) setRule({ product: "", message: "" }); }}>
              <Field label="When the product is" htmlFor="rm-rule-p"><select id="rm-rule-p" className="select" value={rule.product} onChange={(e) => setRule({ ...rule, product: e.target.value })}><option value="">Any product</option>{appProducts.map((p) => <option key={p.id} value={p.store_identifier}>{p.store_identifier}</option>)}</select></Field>
              <Field label="Show" htmlFor="rm-rule-m"><select id="rm-rule-m" className="select" value={rule.message} onChange={(e) => setRule({ ...rule, message: e.target.value })}><option value="">Choose a message…</option>{m.messages.map((x) => <option key={x.id} value={x.id}>{x.header}</option>)}</select></Field>
              <button type="submit" className="btn btn-line">Add rule</button>
            </form>
          </div>
        </Panel>
      </div>

      <Panel title="Real-time URL and sync">
        <div className="stack">
          <div className="field"><span style={{ font: "600 12px/16px var(--font)", color: "var(--fg-2)" }}>Real-time URL</span><CopyField value={m.realtime_url} label="real-time URL" /><span className="hint">Apple calls this URL when a customer opens the cancel screen. Syncing registers it with Apple.</span></div>
          <StatusLine tone={registered ? "ok" : "idle"}>{registered ? `Registered with Apple (${envLabel}) on ${fmt.dateTime(registered)}.` : `Not registered with Apple (${envLabel}) yet.`}</StatusLine>
          <div className="hrow">
            <button type="button" className="btn btn-dark" disabled={!!syncing} onClick={() => runSync("sandbox")}>{syncing === "sandbox" ? "Syncing…" : "Sync to Apple (sandbox)"}</button>
            <button type="button" className="btn btn-line" disabled={!!syncing} onClick={() => runSync("production")}>{syncing === "production" ? "Syncing…" : "Sync to Apple (production)"}</button>
          </div>
          <p className="subtle" style={{ margin: 0, fontSize: 12 }}>A sync uploads new messages, sets the default messages and registers the real-time URL. Each step reports its own result. Apple asks you to pass its performance test in sandbox before production.</p>
          {sync && (sync.errors.length
            ? <div className="banner err" role="alert"><div className="stack tight"><b>Sync to Apple ({sync.environment}) finished with {sync.errors.length} problem{sync.errors.length === 1 ? "" : "s"}:</b><ul className="notes">{sync.errors.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div>
            : <div className="banner ok" role="status">Synced to Apple ({sync.environment}).</div>)}
        </div>
      </Panel>
      {err && <div className="banner err" role="alert">{err}</div>}

      {dialog === "message" && <MessageDialog products={appProducts} onClose={() => setDialog(null)} onSave={(msg) => save({ messages: [...m.messages, msg] }, "Message added")} />}
      {confirm && (
        <ConfirmDialog title="Delete this message?" confirmLabel="Delete message" danger onClose={() => setConfirm(null)} onConfirm={async () => {
          const res = await api<Messaging>(`${v2(pid)}/apps/${app.id}/retention_messaging`, { method: "POST", json: {
            messages: m.messages.filter((x) => x.id !== confirm.id).map(({ id, kind, header, body, alternate_product_id, promotional_offer_id }) => ({ id, kind, header, body, alternate_product_id: alternate_product_id ?? null, promotional_offer_id: promotional_offer_id ?? null })),
            defaults: m.defaults.filter((d) => d.message_id !== confirm.id).map(({ product_id, locale, message_id }) => ({ product_id, locale, message_id })),
            rules: m.rules.filter((r) => r.message_id !== confirm.id),
          } });
          qc.setQueryData(key, res); toast("Message deleted");
        }}><p>Defaults and rules that use <b>{confirm.header}</b> are removed too. Apple keeps a message it already received, but RevenueDot stops answering with it.</p></ConfirmDialog>
      )}
    </>
  );
}

/** A v4 UUID; crypto.randomUUID only exists on https and localhost, and self-hosted dashboards may be plain http. */
function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Apple sends the app's Apple ID (appAppleId) with every real-time request; RevenueDot checks it against this value. */
function AppleIdForm({ pid, appId, appType, onSaved }: { pid: string; appId: string; appType: string; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6,12}$/.test(v.trim())) { setErr("The Apple ID is the number in App Store Connect > App Information, e.g. 1234567890."); return; }
    setBusy(true); setErr(null);
    try { await api(`${v2(pid)}/apps/${appId}`, { method: "POST", json: { [appType === "mac_app_store" ? "mac_app_store" : "app_store"]: { app_apple_id: v.trim() } } }); toast("Apple ID saved"); onSaved(); }
    catch (x) { setErr(errMsg(x)); }
    setBusy(false);
  }
  return (
    <form className="stack tight" onSubmit={submit} noValidate>
      <StatusLine tone="bad">Add the app's Apple ID: Apple sends it with each request, and RevenueDot answers only when it matches.</StatusLine>
      <div className="inline-row">
        <Field label="Apple ID of the app" htmlFor="rm-apple-id" hint="App Store Connect > your app > App Information > Apple ID." error={err}>
          <input id="rm-apple-id" className="input mono" inputMode="numeric" style={{ maxWidth: 240 }} value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ""))} placeholder="1234567890" />
        </Field>
        <button type="submit" className="btn btn-line" disabled={busy}>{busy ? "Saving…" : "Save Apple ID"}</button>
      </div>
    </form>
  );
}

function MessageDialog({ products, onClose, onSave }: { products: Product[]; onClose: () => void; onSave: (m: RetentionMessage) => Promise<boolean> }) {
  const [kind, setKind] = useState<RetentionMessage["kind"]>("text");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [alt, setAlt] = useState("");
  const [offer, setOffer] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const len = (s: string) => [...s].length;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!header.trim() || len(header) > 66) { setErr("The header needs 1 to 66 characters."); return; }
    if (!body.trim() || len(body) > 144) { setErr("The body needs 1 to 144 characters."); return; }
    if (kind === "switch_plan" && !alt) { setErr("Pick the product to suggest."); return; }
    if (kind === "promotional_offer" && !offer.trim()) { setErr("Enter the App Store promotional offer ID."); return; }
    setBusy(true); setErr(null);
    const ok = await onSave({ id: uuid(), kind, header: header.trim(), body: body.trim(), alternate_product_id: kind === "switch_plan" ? alt : null, promotional_offer_id: kind === "promotional_offer" ? offer.trim() : null });
    setBusy(false);
    if (ok) onClose();
  }
  return (
    <Dialog title="New message" onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="rm-msg" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Add message"}</button>
    </>}>
      <form id="rm-msg" onSubmit={submit} noValidate className="stack tight">
        <Field label="Kind" htmlFor="rm-kind" hint={MESSAGE_KINDS.find((k) => k.value === kind)?.help}>
          <select id="rm-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as RetentionMessage["kind"])}>{MESSAGE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}</select>
        </Field>
        <Field label="Header" htmlFor="rm-header">
          <input id="rm-header" className="input" autoFocus value={header} onChange={(e) => setHeader(e.target.value)} placeholder="Before you go" />
          <span className={`counter${len(header) > 66 ? " over" : ""}`} aria-live="polite">{len(header)}/66</span>
        </Field>
        <Field label="Body" htmlFor="rm-body">
          <textarea id="rm-body" className="textarea" style={{ fontFamily: "var(--font)", fontSize: 13 }} rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Your scans stay synced across devices while you are subscribed." />
          <span className={`counter${len(body) > 144 ? " over" : ""}`} aria-live="polite">{len(body)}/144</span>
        </Field>
        {kind === "switch_plan" && (
          <Field label="Alternate product" htmlFor="rm-alt" hint="A product in the same subscription group, e.g. a cheaper plan.">
            <select id="rm-alt" className="select" value={alt} onChange={(e) => setAlt(e.target.value)}><option value="">Choose…</option>{products.map((p) => <option key={p.id} value={p.store_identifier}>{productName(p)} ({p.store_identifier})</option>)}</select>
          </Field>
        )}
        {kind === "promotional_offer" && (
          <Field label="Promotional offer ID" htmlFor="rm-offer" hint="The offer's reference ID in App Store Connect.">
            <input id="rm-offer" className="input mono" value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="pro_monthly_50off" />
          </Field>
        )}
        <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Apple keeps an uploaded message as it is. To change one later, add a new message.</p>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}

// ---------- Customer Center offers ----------

const SECTIONS: { trigger: RetentionOffer["trigger"]; title: string; text: string }[] = [
  { trigger: "cancel", title: "Cancellation Retention Discount", text: "Offered when a customer taps Cancel in the Customer Center." },
  { trigger: "refund", title: "Refunds Retention Discount", text: "Offered when a customer asks for a refund in the Customer Center." },
];
const STORES: { value: RetentionOffer["store"]; label: string; types: string[] }[] = [
  { value: "app_store", label: "App Store", types: ["app_store", "mac_app_store"] },
  { value: "play_store", label: "Google Play", types: ["play_store"] },
];

function CustomerCenterTab() {
  const pid = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["retention-offers", pid], enabled: !!pid, queryFn: async () => (await api<List<RetentionOffer>>(`${v2(pid)}/retention_offers`)).items });
  const apps = useApps(pid);
  const products = useProducts(pid);
  const [creating, setCreating] = useState<RetentionOffer["trigger"] | null>(null);
  const [deleting, setDeleting] = useState<RetentionOffer | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["retention-offers", pid] });
  const toggle = async (o: RetentionOffer, active: boolean) => {
    try { await api(`${v2(pid)}/retention_offers/${o.id}`, { method: "POST", json: { active } }); await refresh(); toast(active ? `${o.name} is on` : `${o.name} is off`); }
    catch (e) { toast(errMsg(e)); }
  };
  return (
    <>
      <p className="section-sub">The Customer Center in your app shows these offers before a customer cancels or asks for a refund. The SDK presents the store's promotional offer for the product the customer owns.</p>
      {q.isError && <div className="banner err" role="alert">Offers could not be loaded: {errMsg(q.error)}</div>}
      {SECTIONS.map((s) => {
        const rows = (q.data ?? []).filter((o) => o.trigger === s.trigger);
        return (
          <Panel key={s.trigger} title={s.title} flush link={<button type="button" className="btn btn-line" aria-label={`New offer: ${s.title}`} onClick={() => setCreating(s.trigger)}><Icon name="plus" />New offer</button>}>
            {q.isLoading ? <div className="pb" aria-busy="true"><span className="sk line" /></div> : (
              <DataTable rowKey={(o) => o.id} rows={rows} empty={<div className="pnote">{s.text} No offer yet.</div>} columns={[
                { key: "n", header: "Offer", className: "wrap", render: (o) => <span><b style={{ fontWeight: 600 }}>{o.name}</b><span className="cellsub">{o.title}{o.subtitle ? ` · ${o.subtitle}` : ""}</span></span> },
                { key: "s", header: "Store", render: (o) => STORES.find((x) => x.value === o.store)?.label ?? o.store },
                { key: "p", header: "Products → offer IDs", className: "wrap", render: (o) => <span className="stack tight" style={{ gap: 2 }}>{Object.entries(o.product_mapping).map(([p, id]) => <span key={p} className="mono" style={{ fontSize: 12 }}>{p} <span className="subtle">→</span> {id}</span>)}</span> },
                { key: "a", header: "Active", render: (o) => <Switch checked={o.active} onChange={(v) => void toggle(o, v)} label={o.active ? "On" : "Off"} /> },
                { key: "m", header: "", align: "right", render: (o) => <Menu label={`Actions for ${o.name}`} items={[{ label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting(o) }]} /> },
              ]} />
            )}
          </Panel>
        );
      })}
      {creating && <OfferDialog trigger={creating} apps={apps.data ?? []} products={products.data ?? []} onClose={() => setCreating(null)} onSaved={async () => { await refresh(); toast("Offer created"); }} />}
      {deleting && <ConfirmDialog title="Delete this offer?" confirmLabel="Delete offer" danger onClose={() => setDeleting(null)} onConfirm={async () => { await api(`${v2(pid)}/retention_offers/${deleting.id}`, { method: "DELETE" }); await refresh(); toast("Offer deleted"); }}><p>The Customer Center stops showing <b>{deleting.name}</b> the next time it loads its configuration.</p></ConfirmDialog>}
    </>
  );
}

function OfferDialog({ trigger, apps, products, onClose, onSaved }: { trigger: RetentionOffer["trigger"]; apps: App[]; products: Product[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const pid = useProjectId();
  const [name, setName] = useState("");
  const [title, setTitle] = useState(trigger === "cancel" ? "Wait! Here's 50% off" : "Before you ask for a refund");
  const [subtitle, setSubtitle] = useState("");
  const [store, setStore] = useState<RetentionOffer["store"]>("app_store");
  const [rows, setRows] = useState<[string, string][]>([["", ""]]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const types = STORES.find((s) => s.value === store)!.types;
  const appIds = new Set(apps.filter((a) => types.includes(a.type)).map((a) => a.id));
  const choices = [...new Set(products.filter((p) => appIds.has(p.app_id) && p.type === "subscription").map((p) => p.store_identifier))];
  async function submit(e: FormEvent) {
    e.preventDefault();
    const mapping = rows.filter(([p, o]) => p && o.trim());
    if (!name.trim() || !title.trim()) { setErr("Name the offer and give it a title."); return; }
    if (!mapping.length) { setErr("Link at least one product to a store offer ID."); return; }
    if (new Set(mapping.map(([p]) => p)).size !== mapping.length) { setErr("Each product can have one offer ID: remove the repeated product."); return; }
    setBusy(true); setErr(null);
    try {
      await api(`${v2(pid)}/retention_offers`, { method: "POST", json: { trigger, name: name.trim(), title: title.trim(), subtitle: subtitle.trim(), store, product_mapping: Object.fromEntries(mapping.map(([p, o]) => [p, o.trim()])), active: true } });
      await onSaved(); onClose();
    } catch (x) { setErr(errMsg(x)); setBusy(false); }
  }
  return (
    <Dialog title={trigger === "cancel" ? "New cancellation offer" : "New refund offer"} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="submit" form="offer-form" className="btn btn-dark" disabled={busy}>{busy ? "Saving…" : "Create offer"}</button>
    </>}>
      <form id="offer-form" onSubmit={submit} noValidate className="stack tight">
        <Field label="Name" htmlFor="of-name" hint="Only you see this."><input id="of-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Half off for 3 months" /></Field>
        <Field label="Title" htmlFor="of-title"><input id="of-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Subtitle" htmlFor="of-sub"><input id="of-sub" className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Stay on Pro for half the price." /></Field>
        <Field label="Store" htmlFor="of-store"><select id="of-store" className="select" value={store} onChange={(e) => { setStore(e.target.value as RetentionOffer["store"]); setRows([["", ""]]); }}>{STORES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></Field>
        <div>
          <div className="label">Products and offers</div>
          <p className="subtle" style={{ margin: "2px 0 6px", fontSize: 12 }}>{store === "app_store" ? "The promotional offer ID from App Store Connect for each subscription." : "The offer ID from Google Play Console for each base plan."}</p>
          {!choices.length && <p className="form-err">This project has no {store === "app_store" ? "App Store" : "Google Play"} subscription products yet.</p>}
          {rows.map(([p, o], i) => (
            <div key={i} className="cond-r" style={{ marginBottom: 6 }}>
              <select aria-label={`Product ${i + 1}`} className="select" value={p} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}><option value="">Choose a product…</option>{choices.map((c) => <option key={c} value={c}>{c}</option>)}</select>
              <input aria-label={`Offer ID ${i + 1}`} className="input mono cond-v" placeholder="offer id" value={o} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
              <button type="button" className="ib" aria-label={`Remove product ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="trash" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => setRows([...rows, ["", ""]])}><Icon name="plus" />Add a product</button>
        </div>
        {err && <div className="banner err" role="alert">{err}</div>}
      </form>
    </Dialog>
  );
}
