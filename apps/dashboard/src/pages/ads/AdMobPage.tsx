import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { ConfirmDialog, CopyField, DataTable, Disclosure, Field, KeyValue, PageHead, Panel, StatusLine, useProjectId, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { errMsg } from "../setup/data";
import { FORMAT_LABEL, useAdMob, v2, type AdMobConnection } from "./data";

/**
 * Google AdMob (/projects/:projectId/integrations/admob; prd/ads/PRD.md): connect with Google OAuth to load the
 * account's ad units (names and formats on the Ads Overview, ad unit picker in reward rules), refresh, disconnect.
 * The OAuth client is the server's (REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID/_SECRET) or the project's own.
 */

const GUIDE = "https://revenuedot.app/docs/guides/ads#admob";

function OwnClient({ pid, a, onDone }: { pid: string; a: AdMobConnection; onDone: (url: string) => void }) {
  const [id, setId] = useState(a.client_id ?? "");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<{ message: string; param?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api<{ url: string }>(`${v2(pid)}/ads/admob/connect`, { method: "POST", json: { client_id: id.trim() || null, client_secret: secret.trim() || null } });
      onDone(r.url);
    } catch (x) { const b = (x as { body?: { param?: string } }).body; setErr({ message: errMsg(x), param: b?.param }); } finally { setBusy(false); }
  }
  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Your own Google OAuth client">
      <p className="section-sub">In Google Cloud, create an OAuth client of type Web application, enable the AdMob API, and add this redirect URI.</p>
      <CopyField value={a.redirect_uri} label="redirect URI" />
      <Field label="Client ID" htmlFor="g-id" error={err?.param === "client_id" ? err.message : null}><input id="g-id" className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" /></Field>
      <Field label="Client secret" htmlFor="g-secret" error={err?.param === "client_secret" ? err.message : null} hint={a.client_secret.configured ? <>Saved: <span className="mono">{a.client_secret.hint}</span>. Leave empty to keep it.</> : undefined}>
        <input id="g-secret" className="input mono" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={a.client_secret.configured ? "Unchanged" : "GOCSPX-…"} />
      </Field>
      {err && !err.param && <div className="banner err" role="alert">{err.message}</div>}
      <div className="hrow"><button type="submit" className="btn btn-dark" disabled={busy || !id.trim()}>{busy ? "Opening Google…" : "Save and connect with Google"}</button></div>
    </form>
  );
}

export function AdMobPage() {
  const pid = useProjectId();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const q = useAdMob(pid);
  const a = q.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const failure = sp.get("admob_error");
  useEffect(() => {
    if (sp.get("connected")) { toast("AdMob is connected. Ad units are loaded."); const n = new URLSearchParams(sp); n.delete("connected"); setSp(n, { replace: true }); }
  }, [sp, setSp, toast]);
  const go = (url: string) => { window.location.assign(url); };
  const connect = async () => {
    setBusy("connect");
    try { go((await api<{ url: string }>(`${v2(pid)}/ads/admob/connect`, { method: "POST", json: {} })).url); } catch (e) { toast(errMsg(e)); setBusy(null); }
  };
  const refresh = async () => {
    setBusy("refresh");
    try { await api(`${v2(pid)}/ads/admob/refresh`, { method: "POST" }); await qc.invalidateQueries({ queryKey: ["admob", pid] }); toast("Ad units reloaded."); } catch (e) { toast(errMsg(e)); await qc.invalidateQueries({ queryKey: ["admob", pid] }); } finally { setBusy(null); }
  };
  const crumbs = <><Link to={`/projects/${pid}/integrations`}>Integrations</Link> <span>/</span> <b>Google AdMob</b></>;
  return (
    <Shell title="Google AdMob" crumbs={crumbs}>
      <div className="page narrow">
        <PageHead title="Google AdMob" sub="Load your AdMob ad units so the Ads Overview shows their names and formats, and verify rewarded ads on the server."
          actions={a?.connected ? <>
            <button type="button" className="btn btn-line" disabled={busy === "refresh"} onClick={refresh}><Icon name="refresh" />{busy === "refresh" ? "Loading…" : "Refresh now"}</button>
            <button type="button" className="btn btn-line" onClick={() => setDisconnecting(true)}>Disconnect</button>
          </> : undefined} />
        {failure && <div className="banner err" role="alert" style={{ alignItems: "center" }}><span style={{ flex: 1 }}>{failure}</span><button type="button" className="btn btn-ghost" onClick={() => { const n = new URLSearchParams(sp); n.delete("admob_error"); setSp(n, { replace: true }); }}>Dismiss</button></div>}
        {q.isError && <div className="banner err" role="alert">{errMsg(q.error)}</div>}
        {q.isLoading && <div className="panel pb" aria-busy="true"><span className="sk line" /></div>}
        {a && (
          <>
            <KeyValue rows={[
              ["Status", a.connected
                ? (a.last_sync_error ? <StatusLine tone="bad">Connected · last load failed: {a.last_sync_error}</StatusLine> : <StatusLine tone="ok">Connected · {fmt.int(a.ad_units.length)} ad unit{a.ad_units.length === 1 ? "" : "s"}</StatusLine>)
                : <StatusLine tone="idle">Not connected</StatusLine>],
              ...(a.connected ? [
                ["AdMob account", <span className="mono">{a.accounts.map((x) => x.id).join(", ") || "—"}</span>] as [string, ReactNode],
                ["Last loaded", a.last_sync_at ? `${fmt.ago(a.last_sync_at)} · refreshed daily` : "—"] as [string, ReactNode],
              ] : []),
              ["OAuth client", a.oauth_client === "server" ? "RevenueDot's" : a.oauth_client === "project" ? <span className="mono">{a.client_id}</span> : "None yet"],
            ]} />
            {!a.connected && (
              <Panel title="Connect your AdMob account" link={<a className="link" href={GUIDE} target="_blank" rel="noreferrer">Setup guide →</a>}>
                <div className="stack">
                  <p className="section-sub">You sign in with Google and allow read-only access to AdMob. RevenueDot stores the refresh token encrypted and only lists your apps and ad units.</p>
                  {a.oauth_client
                    ? <div className="hrow"><button type="button" className="btn btn-dark" disabled={busy === "connect"} onClick={connect}>{busy === "connect" ? "Opening Google…" : "Connect with Google"}</button></div>
                    : <div className="banner" role="status">This server has no Google OAuth client. Add your own below, or set REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID and REVENUEDOT_GOOGLE_OAUTH_CLIENT_SECRET on the server.</div>}
                </div>
              </Panel>
            )}
            <Disclosure title="Use your own Google OAuth client" sub="Optional on RevenueDot Cloud; needed on a self-hosted server without one." defaultOpen={!a.oauth_client}>
              <OwnClient pid={pid} a={a} onDone={go} />
            </Disclosure>
            {a.connected && (
              <Panel title="Ad units" flush>
                <DataTable rows={a.ad_units} rowKey={(u) => u.ad_unit_id}
                  columns={[
                    { key: "name", header: "Name", render: (u) => u.name },
                    { key: "id", header: "Ad unit ID", render: (u) => <span className="mono">{u.ad_unit_id}</span> },
                    { key: "format", header: "Format", render: (u) => (u.format ? FORMAT_LABEL[u.format] ?? u.format : "—") },
                    { key: "app", header: "AdMob app", render: (u) => <span className="mono subtle">{u.app_id ?? "—"}</span> },
                  ]}
                  empty={<div className="pb section-sub">No ad units in this AdMob account.</div>} />
              </Panel>
            )}
            <Panel title="Rewarded ads">
              <div className="stack">
                <p className="section-sub">Paste this callback URL into each rewarded ad unit's server-side verification settings in AdMob. Reward rules decide what each verified reward grants.</p>
                <CopyField value={a.ssv_callback_url} label="AdMob callback URL" />
                <div className="hrow"><Link className="btn btn-line" to={`/projects/${pid}/ads/rewards`}>Set up rewards</Link></div>
              </div>
            </Panel>
          </>
        )}
      </div>
      {disconnecting && (
        <ConfirmDialog title="Disconnect AdMob?" confirmLabel="Disconnect" danger onClose={() => setDisconnecting(false)}
          onConfirm={async () => { await api(`${v2(pid)}/ads/admob`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["admob", pid] }); toast("AdMob disconnected."); }}>
          <p>RevenueDot deletes the Google tokens and the loaded ad units. Ad revenue from the SDK and rewarded-ad verification keep working.</p>
        </ConfirmDialog>
      )}
    </Shell>
  );
}
