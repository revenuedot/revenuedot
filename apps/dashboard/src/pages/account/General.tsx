import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut, useMe, type Me } from "../../components/Shell";
import { Dialog, Field, Tag, useToast } from "../../components/ui";
import { api, ApiError, fmt } from "../../lib/api";
import { AccountLayout, Row, Section, errText } from "./AccountLayout";

/**
 * General (RevenueCat: Settings → General): name, email with a verified change, Stripe accounts (placeholder until
 * Connect with Stripe lands), log out and log out everywhere, and the danger zone.
 */
export function AccountGeneralPage() {
  const me = useMe();
  return (
    <AccountLayout section="general">
      {me.data && <>
        <Profile me={me.data} />
        {me.data.account?.features?.stripe_connect && <StripeAccounts />}
        <SignOut />
        <DangerZone me={me.data} />
      </>}
    </AccountLayout>
  );
}

function Profile({ me }: { me: Me }) {
  const qc = useQueryClient();
  const toast = useToast();
  const u = me.user;
  const [name, setName] = useState(u.name ?? "");
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  useEffect(() => { setName(u.name ?? ""); }, [u.name]);
  const saveName = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api<{ user: Me["user"] }>("/auth/me", { method: "POST", json: { name: name.trim() || null } });
      qc.setQueryData<Me>(["me"], (m) => (m ? { ...m, user: { ...m.user, ...r.user } } : m));
      toast("Name saved.");
    } catch (e) { toast(errText(e)); } finally { setBusy(false); }
  };
  const cancelChange = async () => {
    try { await api("/auth/email/change", { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["me"] }); toast("Email change cancelled."); } catch (e) { toast(errText(e)); }
  };
  return (
    <Section title="Profile" id="profile">
      <Row label="Your name" help="Shown to your teammates and in invites you send." htmlFor="account-name">
        <div className="acct-inline">
          <input id="account-name" className="input" autoComplete="name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }} />
          <button type="button" className="btn btn-line" disabled={busy || name.trim() === (u.name ?? "")} onClick={saveName}>Save</button>
        </div>
      </Row>
      <Row label="Email" help="Where sign-in links, alerts and summaries go. A change takes effect when you confirm it from the new address.">
        <div className="acct-inline"><span className="acct-value" data-email>{u.email}</span>{u.email_verified ? <Tag tone="up">Verified</Tag> : me.account?.email_verification_required ? <Tag tone="down">Not confirmed</Tag> : null}</div>
        {u.pending_email && (
          <div className="banner warn" role="status" data-pending-email>
            <span>Waiting for confirmation: we sent a link to <b>{u.pending_email.email}</b>. It expires {fmt.dateTime(u.pending_email.expires_at)}.</span>
            <button type="button" className="btn btn-line" onClick={cancelChange}>Cancel change</button>
          </div>
        )}
        <div className="acct-actions"><button type="button" className="btn btn-line" onClick={() => setChanging(true)}>Change email</button></div>
      </Row>
      {changing && <ChangeEmail me={me} onClose={() => setChanging(false)} />}
    </Section>
  );
}

function ChangeEmail({ me, onClose }: { me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tfa = !!me.user.two_factor?.enabled;
  const go = async () => {
    if (busy) return;
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("Enter a valid email address."); return; }
    setBusy(true); setError(null);
    try {
      await api("/auth/email/change", { method: "POST", json: { new_email: email.trim(), password, ...(tfa ? { code } : {}) } });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast(`We sent a confirmation link to ${email.trim()}.`);
      onClose();
    } catch (e) { setError(errText(e)); setBusy(false); }
  };
  return (
    <Dialog title="Change email" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy || !email || (me.user.has_password !== false && !password) || (tfa && !code)} onClick={go}>{busy ? "Sending…" : "Send confirmation link"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <p className="section-sub">We email a link to the new address. Your account keeps <b>{me.user.email}</b> until you open it, and we tell {me.user.email} about the change.</p>
        <Field label="New email" htmlFor="new-email"><input id="new-email" className="input" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} /></Field>
        {me.user.has_password !== false && <Field label="Current password" htmlFor="ce-password"><input id="ce-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} /></Field>}
        {tfa && <Field label="Two-factor code" htmlFor="ce-code" hint="From your authenticator app."><input id="ce-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={11} value={code} onChange={(e) => { setCode(e.target.value); setError(null); }} /></Field>}
        {error && <div className="banner err" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

interface StripeAccount { app: { id: string; name: string }; project: { id: string; name: string }; account: string | null; mode: "live" | "test"; method: string | null; charges_enabled: boolean | null; details_submitted: boolean | null; connected_at: number | null }
interface StripeAccounts { available: boolean; unavailable_reason: string | null; items: StripeAccount[]; connectable_apps: { app: { id: string; name: string }; project: { id: string; name: string } }[] }

/**
 * Account-level Stripe accounts (RevenueCat: General → Stripe accounts): every account connected with Connect with Stripe
 * to a Stripe app in the person's projects. Connecting and disconnecting happen on the app's page (prd/web-billing §8).
 */
function StripeAccounts() {
  const q = useQuery({ queryKey: ["stripe-accounts"], queryFn: () => api<StripeAccounts>("/auth/stripe_accounts") });
  const d = q.data;
  const target = d?.connectable_apps[0];
  return (
    <Section title="Stripe accounts" id="stripe-accounts" sub="Stripe accounts connected to apps in your projects with Connect with Stripe."
      action={target && d?.available ? <Link className="btn btn-line" to={`/projects/${target.project.id}/apps/${target.app.id}`}>Connect Stripe</Link> : undefined}>
      {q.isError ? <div className="acct-pad"><div className="banner err" role="alert">{errText(q.error)}</div></div> : !d ? <div className="acct-empty">Loading…</div> : d.items.length ? (
        <div className="tbl"><table>
          <thead><tr><th>Account</th><th>App</th><th>Mode</th><th>Status</th><th>Connected</th><th aria-label="Actions" /></tr></thead>
          <tbody>{d.items.map((a) => (
            <tr key={a.app.id} data-stripe-account={a.app.id}>
              <td className="id">{a.account ?? "—"}</td>
              <td>{a.app.name} <span className="subtle">· {a.project.name}</span></td>
              <td>{a.mode === "live" ? <Tag tone="up">Live</Tag> : <Tag tone="info">Test</Tag>}</td>
              <td>{a.charges_enabled === false || a.details_submitted === false ? "Onboarding unfinished" : "Ready"}{a.method === "account_link" ? <span className="subtle"> · created through RevenueDot</span> : null}</td>
              <td>{a.connected_at ? fmt.date(a.connected_at) : "—"}</td>
              <td className="actions-cell"><Link className="btn btn-line" to={`/projects/${a.project.id}/apps/${a.app.id}`}>Manage</Link></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : (
        <div className="acct-empty">{d.available
          ? target ? "No Stripe account is connected yet. Connect Stripe opens a Stripe app's page, where you sign in to Stripe." : "No Stripe account is connected. Add a Stripe app to a project (Apps → Add app → Stripe), then connect it."
          : d.unavailable_reason}</div>
      )}
    </Section>
  );
}

function SignOut() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const out = async (all: boolean) => {
    setBusy(all ? "all" : "one");
    try { await signOut(qc, "/login", () => api(all ? "/auth/logout/all" : "/auth/logout", { method: "POST" })); } catch (e) { toast(errText(e)); setBusy(null); }
  };
  return (
    <Section title="Sign out" id="sign-out">
      <Row label="This browser" help="Sign out here. Other browsers stay signed in.">
        <div className="acct-actions"><button type="button" className="btn btn-line" disabled={!!busy} onClick={() => out(false)}>{busy === "one" ? "Signing out…" : "Log out"}</button></div>
      </Row>
      <Row label="Every browser" help={<>Signs out every session, this one included. To pick sessions one by one, use <Link className="link-u" to="/account/security">Security</Link>.</>}>
        <div className="acct-actions"><button type="button" className="btn btn-line" disabled={!!busy} onClick={() => out(true)}>{busy === "all" ? "Signing out…" : "Log out of all sessions"}</button></div>
      </Row>
    </Section>
  );
}

interface Deletion { allowed: boolean; type?: string; message?: string; projects?: { id: string; name: string; reason: string; members: number }[]; projects_deleted?: { id: string; name: string }[]; projects_left?: { id: string; name: string }[] }

function DangerZone({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Danger zone" id="danger" tone="danger">
      <Row label="Delete account" help="Deletes your account, its sessions and keys, and the projects only you are in. Projects that other people use stay with them.">
        <div className="acct-actions"><button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>Delete account</button></div>
      </Row>
      {open && <DeleteAccount me={me} onClose={() => setOpen(false)} />}
    </Section>
  );
}

function DeleteAccount({ me, onClose }: { me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const check = useQuery({ queryKey: ["account-deletion"], queryFn: () => api<Deletion>("/auth/account/delete"), staleTime: 0, gcTime: 0 });
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tfa = !!me.user.two_factor?.enabled;
  const d = check.data;
  const ok = !!d?.allowed && typed.trim().toLowerCase() === me.user.email && (me.user.has_password === false || !!password) && (!tfa || !!code);
  const go = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const json = { email: typed.trim(), password: password || undefined, ...(tfa ? (/^\d{6}$/.test(code.replace(/\s/g, "")) ? { code } : { recovery_code: code }) : {}) };
      await signOut(qc, "/login?deleted=1", () => api("/auth/account/delete", { method: "POST", json }));
    } catch (e) {
      setError(errText(e));
      if (e instanceof ApiError && e.status === 409) void check.refetch();
      setBusy(false);
    }
  };
  return (
    <Dialog title="Delete your account?" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      {d?.allowed && <button type="button" className="btn btn-danger" disabled={!ok || busy} onClick={go}>{busy ? "Deleting…" : "Delete account"}</button>}
    </>}>
      {check.isLoading ? <div className="subtle">Checking your projects…</div> : check.isError ? <div className="banner err" role="alert">{errText(check.error)}</div> : d && !d.allowed ? (
        <div className="stack" data-deletion="blocked">
          <div className="banner warn" role="alert">{d.message}</div>
          {d.projects?.length ? (
            <ul className="plain-list">
              {d.projects.map((p) => (
                <li key={p.id}><b>{p.name}</b> · {p.members} members · {p.reason === "owner" ? "you own it" : "you are its only admin"} · <Link className="link-u" to={`/projects/${p.id}/settings/${p.reason === "owner" ? "general" : "collaborators"}`} onClick={onClose}>{p.reason === "owner" ? "Transfer ownership" : "Manage collaborators"}</Link></li>
              ))}
            </ul>
          ) : d.type === "billing_active" ? <p><Link className="link-u" to="/account/billing" onClick={onClose}>Open billing</Link></p> : null}
        </div>
      ) : d ? (
        <form className="stack" data-deletion="allowed" onSubmit={(e) => { e.preventDefault(); if (ok) void go(); }}>
          <div className="confirm">
            <p>This permanently deletes your account, sessions, two-factor settings, notification choices and the OAuth keys you gave to AI assistants. It cannot be undone.</p>
            {d.projects_deleted?.length ? <p>These projects have no other members and are deleted with everything in them: <b>{d.projects_deleted.map((p) => p.name).join(", ")}</b>.</p> : <p>No project is deleted: every project you are in has other members.</p>}
            {d.projects_left?.length ? <p>You leave: {d.projects_left.map((p) => p.name).join(", ")}.</p> : null}
          </div>
          <Field label={`Type ${me.user.email} to confirm`} htmlFor="delete-email"><input id="delete-email" className="input" autoComplete="off" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>
          {me.user.has_password !== false && <Field label="Password" htmlFor="delete-password"><input id="delete-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>}
          {tfa && <Field label="Two-factor code or recovery code" htmlFor="delete-code"><input id="delete-code" className="input mono" autoComplete="one-time-code" maxLength={11} value={code} onChange={(e) => setCode(e.target.value)} /></Field>}
          {error && <div className="banner err" role="alert">{error}</div>}
          <button type="submit" hidden />
        </form>
      ) : null}
    </Dialog>
  );
}
