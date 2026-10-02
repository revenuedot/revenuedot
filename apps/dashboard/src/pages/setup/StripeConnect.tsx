/**
 * "Connect with Stripe" (prd/web-billing/PRD.md §8): the Stripe app's connection to the developer's own Stripe account
 * through RevenueDot's Stripe Connect platform, and the page Stripe sends the developer back to (/connect/stripe).
 * States: unavailable (the server has no platform keys: the button is disabled and says why), not connected, connected
 * (account, mode, onboarding), disconnected (in RevenueDot or in Stripe). The restricted-key form stays on the app page.
 * API: GET /v2/projects/:id/apps/:app_id/stripe_connect, POST …/actions/start, …/finish, …/disconnect.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, fmt } from "../../lib/api";
import { Icon } from "../../components/icons";
import { ConfirmDialog, Segmented, StatusLine, useToast } from "../../components/ui";

export interface StripeConnectState {
  object: "stripe_connect"; app_id: string; available: boolean; unavailable_reason: string | null; modes: ("live" | "test")[];
  status: "not_connected" | "connected" | "disconnected"; method: "oauth" | "account_link" | null; mode: "live" | "test" | null; account: string | null;
  charges_enabled: boolean | null; details_submitted: boolean | null; connected_at: number | null; disconnected_at: number | null; disconnect_reason: string | null;
  restricted_key_configured: boolean; webhook_url: string; application_fee: null;
}

const STORAGE = "rd_stripe_connect";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const path = (pid: string, appId: string) => `/v2/projects/${pid}/apps/${appId}/stripe_connect`;

export function useStripeConnect(pid: string, appId: string, enabled = true) {
  return useQuery({ queryKey: ["stripe_connect", pid, appId], enabled: enabled && !!pid && !!appId, queryFn: () => api<StripeConnectState>(path(pid, appId)) });
}

/** Starts Stripe's OAuth (or onboarding) and leaves the page; the nonce stays in this tab for the callback. */
export async function startStripeConnect(pid: string, appId: string, o: { method: "oauth" | "account_link"; mode: "live" | "test"; email?: string | null }) {
  const r = await api<{ url: string; nonce: string; state: string }>(`${path(pid, appId)}/actions/start`, { method: "POST", json: { method: o.method, mode: o.mode, ...(o.email ? { email: o.email } : {}) } });
  try { sessionStorage.setItem(STORAGE, JSON.stringify({ state: r.state, nonce: r.nonce, pid, appId, method: o.method, mode: o.mode })); } catch { /* private mode: the callback says to start again */ }
  window.location.assign(r.url);
}

export function StripeConnectPanel({ pid, appId, email, onChange }: { pid: string; appId: string; email?: string | null; onChange?: () => void }) {
  const q = useStripeConnect(pid, appId);
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<"live" | "test">("live");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const s = q.data;
  useEffect(() => { if (s?.modes.length && !s.modes.includes(mode)) setMode(s.modes[0]!); }, [s, mode]);
  const go = async (method: "oauth" | "account_link") => {
    setBusy(method); setErr(null);
    try { await startStripeConnect(pid, appId, { method, mode, email }); } catch (e) { setErr(errText(e)); setBusy(null); }
  };

  if (q.isLoading) return <div className="sc-box" aria-busy="true"><span className="sk line" /></div>;
  if (q.isError || !s) return <div className="banner err" role="alert">Stripe Connect could not be loaded: {errText(q.error)} <button type="button" className="linkish" onClick={() => q.refetch()}>Try again</button></div>;

  if (s.status === "connected") {
    const onboarding = s.charges_enabled === false;
    return (
      <div className="sc-box" data-state="connected" aria-label="Stripe Connect">
        <StatusLine tone={onboarding ? "idle" : "ok"}>
          Connected with Stripe Connect to <span className="mono">{s.account}</span> in <b>{s.mode === "test" ? "test" : "live"} mode</b>{s.connected_at ? <> since {fmt.date(s.connected_at)}</> : null}.
        </StatusLine>
        <p className="section-sub">Payments go straight to your Stripe account and Stripe's fees are yours. RevenueDot takes no fee on them. Events from your account reach RevenueDot through Stripe Connect, so there is no webhook to set up.</p>
        {onboarding && (
          <div className="banner warn" role="status">
            <span style={{ flex: 1 }}>Your Stripe account cannot take payments yet. Finish setting it up in Stripe.</span>
            {/* Stripe makes onboarding links only for accounts created through the platform; an account linked with OAuth finishes in its own dashboard. */}
            {s.method === "account_link"
              ? <button type="button" className="btn btn-dark" disabled={!!busy || !s.available} onClick={() => go("account_link")}>{busy === "account_link" ? "Opening Stripe…" : "Finish setup in Stripe"}</button>
              : <a className="btn btn-dark" href="https://dashboard.stripe.com/account/onboarding" target="_blank" rel="noreferrer">Open the Stripe Dashboard</a>}
          </div>
        )}
        {!s.available && <p className="banner err" role="alert">{s.unavailable_reason} Until then, Stripe calls for this app fail.</p>}
        {err && <div className="banner err" role="alert">{err}</div>}
        <div className="hrow"><button type="button" className="btn btn-line" onClick={() => setConfirm(true)}><Icon name="close" />Disconnect</button></div>
        {confirm && (
          <ConfirmDialog title="Disconnect your Stripe account?" confirmLabel="Disconnect" danger onClose={() => setConfirm(false)} onConfirm={async () => {
            const r = await api<StripeConnectState & { warning: string | null }>(`${path(pid, appId)}/actions/disconnect`, { method: "POST" });
            await qc.invalidateQueries({ queryKey: ["stripe_connect", pid, appId] });
            onChange?.();
            toast(r.warning ?? "Stripe account disconnected");
          }}><p>RevenueDot stops reading purchases and creating checkouts in this Stripe account. Purchases already recorded stay. You can connect again, or paste a restricted key.</p></ConfirmDialog>
        )}
      </div>
    );
  }

  return (
    <div className="sc-box" data-state={s.available ? s.status : "unavailable"} aria-label="Stripe Connect">
      {s.status === "disconnected" && !s.restricted_key_configured && (
        <div className="banner warn" role="status">{s.disconnect_reason ?? "Disconnected"}{s.disconnected_at ? ` on ${fmt.date(s.disconnected_at)}` : ""}. Connect again to keep selling on the web.</div>
      )}
      <div className="sc-row">
        <div>
          <b>Connect with Stripe</b>
          <p className="section-sub" style={{ margin: "4px 0 0" }}>Sign in to Stripe and allow RevenueDot. No keys to copy and no webhook to set up. Payments go straight to your account, and RevenueDot takes no fee on them.</p>
        </div>
        <div className="sc-actions">
          {s.available && s.modes.length > 1 && <Segmented label="Stripe mode" value={mode} onChange={setMode} options={[{ value: "live", label: "Live" }, { value: "test", label: "Test" }]} />}
          <button type="button" className="btn btn-dark" disabled={!s.available || !!busy} aria-describedby={!s.available ? "sc-why" : undefined} onClick={() => go("oauth")}>
            <Icon name="link" />{busy === "oauth" ? "Opening Stripe…" : "Connect with Stripe"}
          </button>
        </div>
      </div>
      {!s.available
        ? <p id="sc-why" className="sc-why" role="note">{s.unavailable_reason}</p>
        : <p className="section-sub" style={{ margin: 0 }}>No Stripe account yet? <button type="button" className="linkish" disabled={!!busy} onClick={() => go("account_link")}>{busy === "account_link" ? "Opening Stripe…" : "Create one through RevenueDot"}</button>.</p>}
      {err && <div className="banner err" role="alert">{err}</div>}
    </div>
  );
}

/** /connect/stripe: Stripe sends the developer back here with `code` and `state` (or `error`), or from onboarding with `state`. */
export function StripeConnectCallback() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [msg, setMsg] = useState<{ title: string; text: string; back?: string } | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const q = new URLSearchParams(window.location.search);
    const state = q.get("state") ?? "";
    let saved: { state: string; nonce: string; pid: string; appId: string; mode: "live" | "test"; method: "oauth" | "account_link" } | null = null;
    try { saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? "null"); } catch { saved = null; }
    const [pid = "", appId = ""] = state.split(".");
    const back = pid && appId ? `/projects/${pid}/apps/${appId}` : "/";
    if (q.get("error")) {
      try { sessionStorage.removeItem(STORAGE); } catch { /* ignore */ }
      setMsg({ title: "Stripe was not connected", text: q.get("error") === "access_denied" ? "You cancelled on Stripe's page. Nothing changed." : q.get("error_description") ?? q.get("error")!, back });
      return;
    }
    if (!saved || saved.state !== state) {
      setMsg({ title: "Start again from the app's page", text: "This Stripe sign-in was started in another tab or browser, or it has already been used.", back });
      return;
    }
    (async () => {
      try {
        if (q.get("refresh") === "1") { await startStripeConnect(saved!.pid, saved!.appId, { method: "account_link", mode: saved!.mode }); return; }
        await api(`/v2/projects/${saved!.pid}/apps/${saved!.appId}/stripe_connect/actions/finish`, { method: "POST", json: { state, nonce: saved!.nonce, ...(q.get("code") ? { code: q.get("code") } : {}) } });
        try { sessionStorage.removeItem(STORAGE); } catch { /* ignore */ }
        await qc.invalidateQueries({ queryKey: ["stripe_connect", saved!.pid, saved!.appId] });
        toast("Stripe account connected");
        nav(`/projects/${saved!.pid}/apps/${saved!.appId}#credentials`, { replace: true });
      } catch (e) {
        const signedOut = e instanceof ApiError && e.status === 401;
        setMsg({ title: signedOut ? "Sign in to finish connecting" : "Stripe was not connected", text: signedOut ? "Your session ended. Sign in, then connect again from the app's page." : errText(e), back: signedOut ? "/login" : back });
      }
    })();
  }, [nav, qc, toast]);
  return (
    <div className="auth-wrap" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="panel pb" style={{ maxWidth: 460, width: "100%" }} role={msg ? "alert" : "status"} aria-live="polite">
        {msg ? (
          <>
            <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>{msg.title}</h1>
            <p className="section-sub">{msg.text}</p>
            {msg.back && <Link className="btn btn-dark" to={msg.back}>{msg.back === "/login" ? "Sign in" : "Back to the app"}</Link>}
          </>
        ) : <p style={{ margin: 0 }}>Connecting your Stripe account…</p>}
      </div>
    </div>
  );
}
