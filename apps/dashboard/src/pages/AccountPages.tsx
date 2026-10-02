import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { signOut, useMe, type Me } from "../components/Shell";
import { Mark } from "../components/icons";
import { TwoFactorStep } from "../components/TwoFactorStep";

/**
 * Pages reached from emails and the sign-in page (prd/account-email/PRD.md): forgot password, reset password,
 * verify email, accept an invite, and account settings (the "Notification settings" link in every email).
 */

const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.");

function Card({ title, sub, children, onSubmit, label }: { title: string; sub?: ReactNode; children: ReactNode; onSubmit?: (e: FormEvent) => void; label?: string }) {
  useEffect(() => { document.title = `${title} · RevenueDot`; }, [title]);
  const body = (
    <>
      <Mark size={36} />
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {children}
    </>
  );
  return (
    <main className="auth">
      {onSubmit ? <form className="auth-card" onSubmit={onSubmit} noValidate aria-label={label ?? title}>{body}</form> : <section className="auth-card" aria-label={label ?? title}>{body}</section>}
    </main>
  );
}

async function homePath(qc: ReturnType<typeof useQueryClient>) {
  const me = await qc.fetchQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"), staleTime: 0 });
  return me.projects[0] ? `/projects/${me.projects[0].id}/overview` : "/projects/new";
}

export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    setBusy(true); setError(null);
    try { await api("/auth/password/forgot", { method: "POST", json: { email: email.trim() } }); setSent(email.trim()); }
    catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  if (sent) {
    return (
      <Card title="Check your email" sub={<>If an account uses <b>{sent}</b>, we sent it a link to reset the password.</>}>
        <p className="section-sub">The link works once and expires in 1 hour. It can take a minute to arrive; check your spam folder too.</p>
        <p className="section-sub">Running your own server without email set up? The link is in the server log, or reset the password with <code className="mono">revenuedot admin reset-password</code>.</p>
        <button type="button" className="btn btn-line btn-lg" onClick={() => setSent(null)}>Use a different email</button>
        <p><Link to="/login" style={{ textDecoration: "underline" }}>Back to sign in</Link></p>
      </Card>
    );
  }
  return (
    <Card title="Reset your password" sub="Enter the email you sign in with. We will send you a link to choose a new password." onSubmit={submit}>
      <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} /></div>
      {error && <div className="banner err" role="alert">{error}</div>}
      <button className="btn btn-dark btn-lg" type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
      <p><Link to="/login" style={{ textDecoration: "underline" }}>Back to sign in</Link></p>
    </Card>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const qc = useQueryClient();
  const check = useQuery({
    queryKey: ["reset-check", token], retry: false, enabled: !!token, staleTime: Infinity,
    queryFn: () => api<{ valid: boolean; email?: string; message?: string }>("/auth/password/check", { method: "POST", json: { token } }),
  });
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The address, kept before the cache is cleared: the link check answers "used" once the reset went through.
  const [email, setEmail] = useState("");
  /**
   * Signed in: a full page load of the home page, so nothing of an earlier session (cached data, the display
   * preferences that follow the ["me"] query) is left in memory.
   */
  const enter = async () => { window.location.replace(await homePath(qc)); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (pw.length < 8) { setError("Use at least 8 characters for your password."); return; }
    if (pw !== pw2) { setError("The two passwords are different."); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ two_factor_required?: boolean; challenge?: string }>("/auth/password/reset", { method: "POST", json: { token, password: pw } });
      setEmail(check.data?.email ?? "");
      qc.clear();
      // Two-factor on: the link proved the inbox, the code proves the phone (prd/account-settings §3).
      if (r?.two_factor_required && r.challenge) { setChallenge(r.challenge); return; }
      await enter();
    } catch (err) { setError(errText(err)); setBusy(false); }
  };
  if (challenge) {
    return <TwoFactorStep challenge={challenge} title="One more step" note="Your new password is saved. Enter the 6-digit code from your authenticator app to sign in."
      onDone={() => { void enter(); }} onRestart={(m) => nav(`/login?email=${encodeURIComponent(email)}`, { replace: true, state: { message: m } })} />;
  }
  if (!token || check.data?.valid === false || check.isError) {
    return (
      <Card title="This link does not work" sub={check.data?.message ?? "The reset link is incomplete. Copy the whole link from the email, or ask for a new one."}>
        <Link className="btn btn-dark btn-lg" to="/forgot-password">Send a new link</Link>
        <p><Link to="/login" style={{ textDecoration: "underline" }}>Back to sign in</Link></p>
      </Card>
    );
  }
  if (check.isLoading) return <Card title="Reset your password" sub="Checking the link…"><span /></Card>;
  return (
    <Card title="Choose a new password" sub={<>For <b>{check.data?.email}</b>. You will be signed out on every other device.</>} onSubmit={submit}>
      <input type="email" autoComplete="username" value={check.data?.email ?? ""} readOnly hidden />
      <div className="field"><label htmlFor="new-password">New password</label><input id="new-password" className="input" type="password" autoComplete="new-password" autoFocus required minLength={8} value={pw} onChange={(e) => { setPw(e.target.value); setError(null); }} /><span className="hint">At least 8 characters.</span></div>
      <div className="field"><label htmlFor="new-password-2">Repeat the new password</label><input id="new-password-2" className="input" type="password" autoComplete="new-password" required value={pw2} onChange={(e) => { setPw2(e.target.value); setError(null); }} /></div>
      {error && <div className="banner err" role="alert">{error}</div>}
      <button className="btn btn-dark btn-lg" type="submit" disabled={busy}>{busy ? "Saving…" : "Set password and sign in"}</button>
    </Card>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const qc = useQueryClient();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (!token) { setState({ ok: false, message: "The link is incomplete. Copy the whole link from the email." }); return; }
    api<{ email: string }>("/auth/email/verify", { method: "POST", json: { token } })
      .then((r) => { setState({ ok: true, message: `${r.email} is confirmed.` }); void qc.invalidateQueries({ queryKey: ["me"] }); })
      .catch((e) => setState({ ok: false, message: errText(e) }));
  }, [token, qc]);
  if (!state) return <Card title="Confirming your email" sub="One moment…"><span /></Card>;
  return (
    <Card title={state.ok ? "Email confirmed" : "This link does not work"} sub={state.message}>
      {state.ok
        ? <p className="section-sub">You can now create secret API keys, invite your team and get alerts when something breaks.</p>
        : <p className="section-sub">Sign in and use “Send a new link” in the banner at the top of the dashboard.</p>}
      <Link className="btn btn-dark btn-lg" to="/">Open the dashboard</Link>
    </Card>
  );
}

interface InviteInfo { email: string; role: string; project: { id: string; name: string }; invited_by: { name: string | null; email: string } | null; expires_at: number; account_exists: boolean }
const ROLE_LABEL: Record<string, string> = { admin: "Admin", developer: "Developer", viewer: "Viewer" };

export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const qc = useQueryClient();
  // Ask /auth/config first: /auth/me answers 401 to a signed-out visitor (most invitees), which the browser logs as an error.
  const config = useQuery({ queryKey: ["auth-config"], queryFn: () => api<{ signed_in?: boolean }>("/auth/config"), retry: false });
  const me = useMe(config.data?.signed_in === true);
  const info = useQuery({ queryKey: ["invite", token], retry: false, enabled: !!token, queryFn: () => api<InviteInfo>(`/auth/invites/${encodeURIComponent(token)}`) });
  const [form, setForm] = useState({ name: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const here = `/invite?token=${encodeURIComponent(token)}`;

  if (!token || info.isError) {
    return (
      <Card title="This invite does not work" sub={info.error ? errText(info.error) : "The invite link is incomplete. Copy the whole link from the email."}>
        <p className="section-sub">Ask the person who invited you to send a new invite.</p>
        <Link className="btn btn-dark btn-lg" to="/">Open the dashboard</Link>
      </Card>
    );
  }
  if (info.isLoading || config.isLoading || me.isLoading || !info.data) return <Card title="Your invite" sub="Loading…"><span /></Card>;
  const i = info.data;
  const who = i.invited_by ? (i.invited_by.name || i.invited_by.email) : "A teammate";
  const sub = <>{who} invited <b>{i.email}</b> to <b>{i.project.name}</b> as {ROLE_LABEL[i.role] ?? i.role}.</>;
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ["me"] }); nav(`/projects/${i.project.id}/overview`, { replace: true }); }
    catch (err) { setError(errText(err)); setBusy(false); }
  };
  const signedIn = me.data?.user;
  if (signedIn) {
    if (signedIn.email !== i.email) {
      return (
        <Card title={`Join ${i.project.name}`} sub={sub}>
          <div className="banner warn" role="status">You are signed in as {signedIn.email}. This invite is for {i.email}.</div>
          <button type="button" className="btn btn-dark btn-lg" onClick={() => { void signOut(qc, i.account_exists ? `/login?next=${encodeURIComponent(here)}&email=${encodeURIComponent(i.email)}` : here); }}>Sign in as {i.email}</button>
        </Card>
      );
    }
    return (
      <Card title={`Join ${i.project.name}`} sub={sub}>
        {error && <div className="banner err" role="alert">{error}</div>}
        <button type="button" className="btn btn-dark btn-lg" disabled={busy} onClick={() => go(() => api(`/auth/invites/${encodeURIComponent(token)}/accept`, { method: "POST" }))}>{busy ? "Joining…" : "Accept invite"}</button>
      </Card>
    );
  }
  if (i.account_exists) {
    return (
      <Card title={`Join ${i.project.name}`} sub={sub}>
        <p className="section-sub">You already have a RevenueDot account. Sign in as {i.email} to accept.</p>
        <Link className="btn btn-dark btn-lg" to={`/login?next=${encodeURIComponent(here)}&email=${encodeURIComponent(i.email)}`}>Sign in to accept</Link>
      </Card>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.password.length < 8) { setError("Use at least 8 characters for your password."); return; }
    void go(() => api("/auth/signup", { method: "POST", json: { email: i.email, password: form.password, name: form.name || undefined, invite_token: token } }));
  };
  return (
    <Card title={`Join ${i.project.name}`} sub={sub} onSubmit={submit} label="Create your account">
      <div className="field"><label htmlFor="invite-email">Email</label><input id="invite-email" className="input" type="email" autoComplete="username" value={i.email} readOnly /></div>
      <div className="field"><label htmlFor="invite-name">Your name</label><input id="invite-name" className="input" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div className="field"><label htmlFor="invite-password">Password</label><input id="invite-password" className="input" type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={(e) => { setForm({ ...form, password: e.target.value }); setError(null); }} /><span className="hint">At least 8 characters.</span></div>
      {error && <div className="banner err" role="alert">{error}</div>}
      <button className="btn btn-dark btn-lg" type="submit" disabled={busy}>{busy ? "Creating account…" : "Create account and join"}</button>
      <p>Already have an account with another email? Ask for an invite to that address.</p>
    </Card>
  );
}

/** /account opens the first section of Account settings (pages/account, prd/account-settings/PRD.md). */
export function AccountPage() {
  return <Navigate to="/account/general" replace />;
}

/**
 * The link in the "Confirm your new email" message (prd/account-settings §1). Works in any browser, signed in or not.
 * The account moves only when the person clicks: mail scanners that open links and run their scripts must not confirm
 * a change to an address nobody checked (a typo would hand the account to whoever owns it).
 */
export function ConfirmEmailPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const qc = useQueryClient();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(token ? null : { ok: false, message: "The link is incomplete. Copy the whole link from the email." });
  const [busy, setBusy] = useState(false);
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const r = await api<{ email: string }>("/auth/email/change/confirm", { method: "POST", json: { token } });
      setState({ ok: true, message: `Your account now uses ${r.email}. Sign in with it from now on.` });
      void qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) { setState({ ok: false, message: errText(err) }); }
  };
  if (!state) {
    return (
      <Card title="Confirm your new email" sub="Your RevenueDot account moves to the address this link was sent to. Until you confirm, it keeps the old one." onSubmit={confirm}>
        <button className="btn btn-dark btn-lg" type="submit" disabled={busy}>{busy ? "Confirming…" : "Confirm new email"}</button>
      </Card>
    );
  }
  return (
    <Card title={state.ok ? "Email changed" : "This link does not work"} sub={state.message}>
      {!state.ok && <p className="section-sub">Start the change again from Account settings → General.</p>}
      <Link className="btn btn-dark btn-lg" to={state.ok ? "/" : "/account/general"}>{state.ok ? "Open the dashboard" : "Open Account settings"}</Link>
    </Card>
  );
}
