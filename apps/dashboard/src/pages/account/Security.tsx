import { useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { encode } from "uqr";
import { useMe, type Me } from "../../components/Shell";
import { ConfirmDialog, CopyButton, Dialog, Field, Tag, useToast } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { AccountLayout, Row, Section, errText } from "./AccountLayout";

/**
 * Security (RevenueCat: Settings → Security): update password, two-factor authentication with an authenticator app
 * and recovery codes, signed-in sessions, and active OAuth tokens (AI assistants connected through OAuth).
 */
export function AccountSecurityPage() {
  const me = useMe();
  return (
    <AccountLayout section="security">
      {me.data && <>
        <Password me={me.data} />
        <TwoFactor me={me.data} />
        <Sessions />
        <OAuthTokens />
      </>}
    </AccountLayout>
  );
}

function Password({ me }: { me: Me }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next.length < 8) { setError("Use at least 8 characters for your new password."); return; }
    if (f.next !== f.again) { setError("The two new passwords are different."); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ sessions_revoked: number }>("/auth/password/change", { method: "POST", json: { current_password: f.current, new_password: f.next } });
      setF({ current: "", next: "", again: "" });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
      toast(r.sessions_revoked ? `Password updated. ${r.sessions_revoked} other session${r.sessions_revoked === 1 ? " was" : "s were"} signed out.` : "Password updated.");
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  if (me.user.has_password === false) {
    return (
      <Section title="Password" id="password">
        <Row label="Password" help="This account signs in with single sign-on and has no password."><span className="acct-note">Use “Forgot password?” on the sign-in page to set one, if your organization allows password sign-in.</span></Row>
      </Section>
    );
  }
  return (
    <Section title="Update password" id="password" sub={me.user.password_changed_at ? `Last changed ${fmt.date(me.user.password_changed_at)}. Changing it signs out every other session.` : "Changing it signs out every other session."}>
      <form className="acct-pad" onSubmit={submit} noValidate aria-label="Update password">
        <input type="email" autoComplete="username" value={me.user.email} readOnly hidden />
        <Field label="Current password" htmlFor="pw-current"><input id="pw-current" className="input" type="password" autoComplete="current-password" value={f.current} onChange={(e) => { setF({ ...f, current: e.target.value }); setError(null); }} /></Field>
        <Field label="New password" htmlFor="pw-new" hint="At least 8 characters."><input id="pw-new" className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => { setF({ ...f, next: e.target.value }); setError(null); }} /></Field>
        <Field label="New password again" htmlFor="pw-again"><input id="pw-again" className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => { setF({ ...f, again: e.target.value }); setError(null); }} /></Field>
        {error && <div className="banner err" role="alert">{error}</div>}
        <div className="acct-actions"><button type="submit" className="btn btn-dark" disabled={busy || !f.current || !f.next || !f.again}>{busy ? "Updating…" : "Update password"}</button></div>
      </form>
    </Section>
  );
}

/** The QR code of an otpauth:// URI, drawn as one SVG path (uqr, MIT). Dark modules on white whatever the theme. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const d = useMemo(() => {
    const qr = encode(text, { ecc: "M", border: 2 });
    let p = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => { if (on) p += `M${x} ${y}h1v1h-1z`; }));
    return { p, size: qr.size };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${d.size} ${d.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={d.size} height={d.size} fill="#FFFFFF" /><path d={d.p} fill="#0A0A0A" />
    </svg>
  );
}

function TwoFactor({ me }: { me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const tf = me.user.two_factor;
  const [dialog, setDialog] = useState<null | "setup" | "codes" | "off">(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["me"] });
  return (
    <Section title="Two-factor authentication" id="two-factor" sub="Sign-in asks for a code from an app on your phone after your password. Single sign-on sessions use your identity provider instead.">
      <Row label="Authenticator app" help="Google Authenticator, 1Password, Authy or any app that reads a TOTP QR code.">
        <div className="acct-inline" data-two-factor={tf?.enabled ? "on" : "off"}>
          {tf?.enabled ? <Tag tone="up">On</Tag> : <Tag>Off</Tag>}
          {tf?.enabled && tf.enabled_at && <span className="acct-note">Since {fmt.date(tf.enabled_at)}</span>}
        </div>
        <div className="acct-actions">
          {tf?.enabled
            ? <button type="button" className="btn btn-line" onClick={() => setDialog("off")}>Turn off</button>
            : <button type="button" className="btn btn-dark" onClick={() => setDialog("setup")}>Set up</button>}
        </div>
      </Row>
      {tf?.enabled && (
        <Row label="Recovery codes" help="Each signs you in once without your phone. Keep them in a password manager.">
          <div className="acct-inline"><span className="acct-value mono" data-codes-left>{tf.recovery_codes_left} of 10 left</span>{tf.recovery_codes_left <= 3 && <Tag tone="down">Running low</Tag>}</div>
          <div className="acct-actions"><button type="button" className="btn btn-line" onClick={() => setDialog("codes")}>Make new codes</button></div>
        </Row>
      )}
      {dialog === "setup" && <SetupTwoFactor me={me} onClose={() => { setDialog(null); void refresh(); }} />}
      {dialog === "codes" && <CodeDialog title="Make new recovery codes" action="Make new codes" path="/auth/2fa/recovery_codes" intro="Your old recovery codes stop working. Enter a code from your authenticator app to continue."
        onDone={(r) => { void refresh(); return r.recovery_codes as string[]; }} onClose={() => setDialog(null)} />}
      {dialog === "off" && <CodeDialog title="Turn off two-factor authentication" action="Turn off" danger path="/auth/2fa/disable" intro="Sign-in will need only your password. Enter a code from your authenticator app, or a recovery code."
        onDone={() => { void refresh(); toast("Two-factor authentication is off."); return null; }} onClose={() => setDialog(null)} />}
    </Section>
  );
}

function RecoveryCodes({ codes, email }: { codes: string[]; email: string }) {
  const text = `RevenueDot recovery codes for ${email}\nEach code works once.\n\n${codes.join("\n")}\n`;
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "revenuedot-recovery-codes.txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="stack tight">
      <ul className="tfa-codes" aria-label="Recovery codes" data-recovery-codes>{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="acct-actions"><CopyButton value={codes.join("\n")} label="Copy codes" text /><button type="button" className="btn btn-line" onClick={download}>Download</button></div>
      <p className="acct-note">These codes are shown only now. Each works once, in place of a code from your phone.</p>
    </div>
  );
}

function SetupTwoFactor({ me, onClose }: { me: Me; onClose: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<"password" | "scan" | "codes">(me.user.has_password === false ? "scan" : "password");
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try { setSetup(await api("/auth/2fa/setup", { method: "POST", json: { password } })); setStep("scan"); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  const verify = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ recovery_codes: string[] }>("/auth/2fa/enable", { method: "POST", json: { code: code.replace(/\s/g, "") } });
      setCodes(r.recovery_codes); setStep("codes"); toast("Two-factor authentication is on.");
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  const footer = step === "password"
    ? <><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="button" className="btn btn-dark" disabled={busy || !password} onClick={() => start()}>{busy ? "Checking…" : "Continue"}</button></>
    : step === "scan"
      ? <><button type="button" className="btn btn-line" onClick={onClose}>Cancel</button><button type="button" className="btn btn-dark" disabled={busy || code.replace(/\s/g, "").length !== 6 || !setup} onClick={() => verify()}>{busy ? "Checking…" : "Turn on"}</button></>
      : <button type="button" className="btn btn-dark" onClick={onClose}>I saved my codes</button>;
  return (
    <Dialog title="Set up two-factor authentication" onClose={busy || step === "codes" ? () => {} : onClose} footer={footer}>
      <div className="tfa-steps">
        {step === "password" && (
          <form className="stack" onSubmit={start} aria-label="Confirm your password">
            <p className="section-sub">Confirm it is you. Then scan a QR code with your authenticator app.</p>
            <input type="email" autoComplete="username" value={me.user.email} readOnly hidden />
            <Field label="Password" htmlFor="tfa-password"><input id="tfa-password" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} /></Field>
            {error && <div className="banner err" role="alert">{error}</div>}
            <button type="submit" hidden />
          </form>
        )}
        {step === "scan" && !setup && (
          <div className="stack"><button type="button" className="btn btn-dark" disabled={busy} onClick={() => start()}>Create a QR code</button>{error && <div className="banner err" role="alert">{error}</div>}</div>
        )}
        {step === "scan" && setup && (
          <form className="stack" onSubmit={verify} aria-label="Scan and verify">
            <div className="tfa-qr">
              <div className="qr"><QrCode text={setup.otpauth_url} label="QR code for your authenticator app" /></div>
              <div className="stack tight">
                <p className="section-sub">1. Scan the code with your authenticator app, or enter this key by hand:</p>
                <div className="acct-inline"><code className="tfa-secret" data-secret>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code><CopyButton value={setup.secret} label="Copy key" /></div>
                <p className="acct-note">Account: {me.user.email} · Issuer: RevenueDot · 6 digits every 30 seconds.</p>
              </div>
            </div>
            <Field label="2. Enter the 6-digit code it shows" htmlFor="tfa-code"><input id="tfa-code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={7} autoFocus value={code} onChange={(e) => { setCode(e.target.value.replace(/[^\d ]/g, "")); setError(null); }} /></Field>
            {error && <div className="banner err" role="alert">{error}</div>}
            <button type="submit" hidden />
          </form>
        )}
        {step === "codes" && (
          <div className="stack">
            <div className="banner ok" role="status">Two-factor authentication is on. Save these 10 recovery codes now.</div>
            <RecoveryCodes codes={codes} email={me.user.email} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Asks for a code (TOTP or recovery), calls `path`, and shows new recovery codes when the call returns them. */
function CodeDialog({ title, action, path, intro, onDone, onClose, danger }: { title: string; action: string; path: string; intro: string; danger?: boolean; onDone: (r: Record<string, unknown>) => string[] | null; onClose: () => void }) {
  const me = useMe();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const go = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    const c = code.trim();
    try {
      const r = await api<Record<string, unknown>>(path, { method: "POST", json: /^\d{6}$/.test(c.replace(/\s/g, "")) ? { code: c.replace(/\s/g, "") } : { recovery_code: c } });
      const fresh = onDone(r);
      if (fresh) setCodes(fresh); else onClose();
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  };
  return (
    <Dialog title={title} onClose={busy || codes ? () => {} : onClose} footer={codes ? <button type="button" className="btn btn-dark" onClick={onClose}>I saved my codes</button> : <>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className={`btn ${danger ? "btn-danger" : "btn-dark"}`} disabled={busy || code.trim().length < 6} onClick={() => go()}>{busy ? "Checking…" : action}</button>
    </>}>
      {codes ? <RecoveryCodes codes={codes} email={me.data?.user.email ?? ""} /> : (
        <form className="stack" onSubmit={go}>
          <p className="section-sub">{intro}</p>
          <Field label="Code" htmlFor="code-dialog" hint="A 6-digit code, or a recovery code such as abcde-fghjk."><input id="code-dialog" className="input mono" autoComplete="one-time-code" maxLength={11} autoFocus value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} /></Field>
          {error && <div className="banner err" role="alert">{error}</div>}
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

interface SessionRow { id: string; current: boolean; method: string; browser: string; os: string; ip: string | null; created_at: number; last_seen_at: number }
const METHOD: Record<string, string> = { password: "Password", two_factor: "Password and code", signup: "Sign-up", reset: "Password reset", invite: "Invite", email_change: "Email change", sso: "Single sign-on" };

function Sessions() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["sessions"], queryFn: () => api<{ items: SessionRow[] }>("/auth/sessions") });
  const [confirm, setConfirm] = useState<SessionRow | "others" | null>(null);
  const rows = q.data?.items ?? [];
  const others = rows.filter((r) => !r.current).length;
  return (
    <Section title="Sessions" id="sessions" sub="Browsers signed in to your account. Sign out any you do not recognise, then change your password."
      action={others > 0 ? <button type="button" className="btn btn-line" onClick={() => setConfirm("others")}>Sign out other sessions</button> : undefined}>
      {q.isError ? <div className="acct-pad"><div className="banner err" role="alert">{errText(q.error)}</div></div> : (
        <div className="tbl"><table>
          <thead><tr><th>Browser</th><th>Signed in with</th><th>IP address</th><th>Last active</th><th>Started</th><th aria-label="Actions" /></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id} data-session={s.current ? "current" : "other"}>
              <td><span className="acct-inline">{s.browser}{s.os ? ` on ${s.os}` : ""}{s.current && <Tag tone="gold">This browser</Tag>}</span></td>
              <td>{METHOD[s.method] ?? s.method}</td>
              <td className="id">{s.ip ?? "—"}</td>
              <td title={fmt.dateTime(s.last_seen_at)}>{s.current ? "Now" : fmt.ago(s.last_seen_at)}</td>
              <td>{fmt.date(s.created_at)}</td>
              <td className="actions-cell">{!s.current && <button type="button" className="btn btn-line" onClick={() => setConfirm(s)}>Sign out</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {confirm && <ConfirmDialog title={confirm === "others" ? "Sign out other sessions?" : "Sign out this session?"} confirmLabel="Sign out" danger
        onConfirm={async () => {
          const r = confirm === "others" ? await api<{ sessions_revoked: number }>("/auth/sessions/revoke_others", { method: "POST" }) : await api(`/auth/sessions/${confirm.id}`, { method: "DELETE" });
          await qc.invalidateQueries({ queryKey: ["sessions"] });
          toast(confirm === "others" ? `${(r as { sessions_revoked: number }).sessions_revoked} session${(r as { sessions_revoked: number }).sessions_revoked === 1 ? "" : "s"} signed out.` : "Session signed out.");
        }} onClose={() => setConfirm(null)}>
        <p>{confirm === "others" ? `Every other browser (${others}) is signed out at once. This one stays signed in.` : `${confirm.browser}${confirm.os ? ` on ${confirm.os}` : ""} is signed out at once.`}</p>
      </ConfirmDialog>}
    </Section>
  );
}

interface TokenRow { id: string; client: { id: string | null; name: string; url: string | null }; project: { id: string; name: string }; access: string; key_prefix: string; created_at: number; last_used_at: number | null }
const ACCESS: Record<string, string> = { read: "Read only", read_write: "Read and change", read_write_support: "Read, change and money actions" };

function OAuthTokens() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["oauth-tokens"], queryFn: () => api<{ items: TokenRow[] }>("/auth/oauth_tokens") });
  const [revoke, setRevoke] = useState<TokenRow | null>(null);
  const rows = q.data?.items ?? [];
  return (
    <Section title="Active OAuth tokens" id="oauth-tokens" sub="AI assistants and apps you connected with “Allow access” (ChatGPT, Claude, Cursor). Each has a key for one project; revoking it cuts the app off at once.">
      {q.isError ? <div className="acct-pad"><div className="banner err" role="alert">{errText(q.error)}</div></div> : !rows.length ? (
        <div className="acct-empty">{q.isLoading ? "Loading…" : "No app is connected. Connect one from your AI assistant with the RevenueDot connector."}</div>
      ) : (
        <div className="tbl"><table>
          <thead><tr><th>Client</th><th>URL</th><th>Project</th><th>Access</th><th>Created</th><th>Last used</th><th aria-label="Actions" /></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id} data-token={t.id}>
              <td><b>{t.client.name}</b></td>
              <td className="id">{t.client.url ?? "—"}</td>
              <td>{t.project.name}</td>
              <td>{ACCESS[t.access] ?? t.access}</td>
              <td>{fmt.date(t.created_at)}</td>
              <td>{t.last_used_at ? fmt.ago(t.last_used_at) : "Never"}</td>
              <td className="actions-cell"><button type="button" className="btn btn-line" onClick={() => setRevoke(t)}>Revoke</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {revoke && <ConfirmDialog title={`Revoke ${revoke.client.name}?`} confirmLabel="Revoke" danger onClose={() => setRevoke(null)}
        onConfirm={async () => { await api(`/auth/oauth_tokens/${revoke.id}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["oauth-tokens"] }); toast(`${revoke.client.name} can no longer use ${revoke.project.name}.`); }}>
        <p>{revoke.client.name} loses access to {revoke.project.name} at once. Connect it again from the app if you need it.</p>
      </ConfirmDialog>}
    </Section>
  );
}
