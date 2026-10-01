import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell, useMe } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { ConfirmDialog, CopyButton, Dialog, Field, Menu, PageHead, Switch, Tabs, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { AuditLogs } from "./AuditLogs";
import { base, errMsg, type Collaborator, type ProjectSettings as Project, type TransferBehavior } from "./data";

/**
 * Project settings (/projects/:projectId/settings/:tab): General (name, project ID, transfer behaviour for purchases
 * seen on several app user IDs with an optional sandbox behaviour, sandbox testing access, delete), Collaborators, and
 * Audit logs (who changed what, with a date filter), and Domains and AI features as later-tier tabs.
 * Collaborators: members with roles (admin, developer, viewer), invites by email with resend and revoke (prd/account-email).
 * GAPS vs RevenueCat (frame 28): the Operations, Growth and Support roles, transfer of project ownership,
 * limiting sandbox testing access to allowed testers, and the Brand, Blocked customers and Verified Metrics tabs.
 */

const BEHAVIORS: { value: TransferBehavior; label: string; text: string }[] = [
  { value: "transfer", label: "Transfer to new App User ID", text: "The purchase moves to the app user ID that sent it last. The previous owner loses access. This is the usual choice and RevenueCat's default." },
  { value: "transfer_if_no_active", label: "Transfer if there are no active subscriptions", text: "The purchase moves only when the previous owner has no active subscription left. Otherwise the new app user ID is refused." },
  { value: "keep", label: "Keep with original App User ID", text: "The purchase stays with the first app user ID. Restoring on another account fails with \"receipt already in use\"." },
  { value: "share", label: "Share between App User IDs (legacy)", text: "Both app user IDs are merged into one customer and share access. Only for apps that relied on this older behaviour." },
];

type Tab = "general" | "collaborators" | "audit-logs" | "domains" | "ai";
const TABS: { value: Tab; label: string; badge?: string }[] = [
  { value: "general", label: "General" }, { value: "collaborators", label: "Collaborators" },
  { value: "audit-logs", label: "Audit logs" }, { value: "domains", label: "Domains", badge: "SOON" }, { value: "ai", label: "AI features", badge: "SOON" },
];

function BehaviorSelect({ id, value, onChange }: { id: string; value: TransferBehavior; onChange: (v: TransferBehavior) => void }) {
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as TransferBehavior)}>
      {BEHAVIORS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
    </select>
  );
}

function DeleteProject({ p, onClose }: { p: Project; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed.trim() === p.name;
  const go = async () => {
    setBusy(true); setError(null);
    try {
      await api(base(p.id), { method: "DELETE" });
      qc.removeQueries({ predicate: (q) => q.queryKey.includes(p.id) });
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast(`${p.name} deleted.`);
      nav("/");
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title={`Delete ${p.name}?`} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-danger" disabled={!ok || busy} onClick={go}>{busy ? "Deleting…" : "Delete project"}</button>
    </>}>
      <div className="confirm">
        <p>This permanently deletes the project's apps, SDK keys, products, offerings, customers, purchase history, webhooks and API keys. Apps using its keys stop working at once.</p>
        <p>This cannot be undone.</p>
      </div>
      <Field label={`Type ${p.name} to confirm`} htmlFor="confirm-name">
        <input id="confirm-name" className="input" autoComplete="off" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      </Field>
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}

function General({ p }: { p: Project }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(p.name);
  const [behavior, setBehavior] = useState<TransferBehavior>(p.transfer_behavior);
  const [sandboxOn, setSandboxOn] = useState(p.sandbox_transfer_behavior !== null);
  const [sandbox, setSandbox] = useState<TransferBehavior>(p.sandbox_transfer_behavior ?? p.transfer_behavior);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const sandboxValue = sandboxOn ? sandbox : null;
  const dirty = name.trim() !== p.name || behavior !== p.transfer_behavior || sandboxValue !== p.sandbox_transfer_behavior;
  const reset = () => { setName(p.name); setBehavior(p.transfer_behavior); setSandboxOn(p.sandbox_transfer_behavior !== null); setSandbox(p.sandbox_transfer_behavior ?? p.transfer_behavior); setError(null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => reset(), [p]);

  const save = async () => {
    if (!name.trim()) { setError("The project needs a name."); document.getElementById("project-name")?.focus(); return; }
    setSaving(true);
    try {
      const r = await api<Project>(base(p.id), { method: "POST", json: { name: name.trim(), transfer_behavior: behavior, sandbox_transfer_behavior: sandboxValue } });
      qc.setQueryData(["project", p.id], r);
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast("Project settings saved.");
    } catch (e) { toast(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>General settings</b></div>
        <div className="pb stack">
          <Field label="Project name" htmlFor="project-name" hint="Used to identify the project in the dashboard." error={error}>
            <input id="project-name" className="input" maxLength={100} value={name} aria-invalid={!!error} onChange={(e) => { setName(e.target.value); setError(null); }} />
          </Field>
          <Field label="Project ID" htmlFor="project-id" hint="Used in REST API v2 paths: /v2/projects/{project_id}/…">
            <div className="copyfield" id="project-id"><code>{p.id}</code><CopyButton value={p.id} label="Copy project ID" /></div>
          </Field>
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Handling multiple app user IDs</b></div>
        <div className="pb stack">
          <p className="section-sub">What happens when a purchase that belongs to one signed-in app user ID is restored or posted again by a different one. This happens when someone restores purchases while signed in to a new account, or a lapsed customer subscribes again under a new ID.</p>
          <Field label="Transferring purchases seen on multiple app user IDs" htmlFor="behavior" hint={BEHAVIORS.find((b) => b.value === behavior)!.text}>
            <BehaviorSelect id="behavior" value={behavior} onChange={setBehavior} />
          </Field>
          <Switch checked={sandboxOn} onChange={(v) => { setSandboxOn(v); if (v) setSandbox(behavior); }} label="Use a different behavior for sandbox" />
          {sandboxOn && (
            <Field label="Sandbox behavior" htmlFor="sandbox-behavior" hint={`Applies to sandbox and Test Store purchases. ${BEHAVIORS.find((b) => b.value === sandbox)!.text}`}>
              <BehaviorSelect id="sandbox-behavior" value={sandbox} onChange={setSandbox} />
            </Field>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="ph"><b>Sandbox testing access</b><Tag tone="muted">Later release</Tag></div>
        <div className="pb stack">
          <p className="section-sub">Who can unlock entitlements and in-app currency with sandbox purchases.</p>
          <Field label="Allow testing entitlements for" htmlFor="sandbox-access" hint="Everyone can test today. Limiting sandbox access to allowed testers comes in a later release.">
            <select id="sandbox-access" className="select" disabled value="anybody"><option value="anybody">Anybody</option></select>
          </Field>
        </div>
      </section>

      <section className="panel danger">
        <div className="ph"><b>Delete project</b></div>
        <div className="pb hrow between">
          <p className="section-sub">Removes the project, its apps, customers and all data for every collaborator. This cannot be undone.</p>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}><Icon name="trash" />Delete project</button>
        </div>
      </section>

      {dirty && (
        <div className="unsaved" role="region" aria-label="Unsaved changes">
          <span>You have unsaved changes.</span>
          <div className="actions">
            <button type="button" className="btn btn-line" disabled={saving} onClick={reset}>Discard</button>
            <button type="button" className="btn btn-dark" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </div>
      )}
      {deleting && <DeleteProject p={p} onClose={() => setDeleting(false)} />}
    </div>
  );
}

interface Invite { object: "invite"; id: string; email: string; role: Role; status: "pending" | "expired"; created_at: number; last_sent_at: number; expires_at: number; email_sent?: boolean }
type Role = "admin" | "developer" | "viewer";
const ROLES: { value: Role; label: string; text: string }[] = [
  { value: "admin", label: "Admin", text: "Everything, including inviting and removing people, secret API keys and deleting the project." },
  { value: "developer", label: "Developer", text: "Apps, catalog, customers and integrations. Cannot create secret API keys or manage members." },
  { value: "viewer", label: "Viewer", text: "Sees everything, changes nothing." },
];
/** API v2 names the viewer role read_only, as RevenueCat does. */
const roleOf = (apiRole: string): Role => (apiRole === "read_only" || apiRole === "viewer" ? "viewer" : apiRole === "developer" ? "developer" : "admin");
const roleLabel = (r: string) => ROLES.find((x) => x.value === roleOf(r))?.label ?? r;

function InviteDialog({ pid, onClose }: { pid: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("developer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("Enter a valid email address."); document.getElementById("invite-email")?.focus(); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<Invite>(`${base(pid)}/invites`, { method: "POST", json: { email: email.trim(), role } });
      await qc.invalidateQueries({ queryKey: ["invites", pid] });
      toast(r.email_sent === false ? `Invite saved for ${r.email}, but the email could not be sent. Try Resend.` : `Invite sent to ${r.email}.`);
      onClose();
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title="Invite to this project" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={send}>{busy ? "Sending…" : "Send invite"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Field label="Email" htmlFor="invite-email" hint="They get a link that works for 7 days. People without an account create one from it.">
          <input id="invite-email" className="input" type="email" autoComplete="off" autoFocus value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} />
        </Field>
        <Field label="Role" htmlFor="invite-role" hint={ROLES.find((r) => r.value === role)!.text}>
          <select id="invite-role" className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </Field>
        <button type="submit" hidden />
      </form>
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}

function Collaborators({ pid }: { pid: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<unknown> } | null>(null);
  const list = useQuery({ queryKey: ["collaborators", pid], queryFn: async () => (await api<List<Collaborator>>(`${base(pid)}/collaborators`)).items });
  const invites = useQuery({ queryKey: ["invites", pid], queryFn: async () => (await api<List<Invite>>(`${base(pid)}/invites`)).items });
  const myRole = me.data?.projects.find((p) => p.id === pid)?.role;
  const isAdmin = myRole === "admin";
  const verifyFirst = !!me.data?.account?.email_verification_required;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["collaborators", pid] }), qc.invalidateQueries({ queryKey: ["invites", pid] })]);
  const setRole = async (c: Collaborator, role: Role) => {
    try {
      await api(`${base(pid)}/collaborators/${encodeURIComponent(c.id)}`, { method: "POST", json: { role } });
      await refresh();
      if (c.id === me.data?.user.id) await qc.invalidateQueries({ queryKey: ["me"] });
      toast(`${c.name ?? c.email} is now ${roleLabel(role).toLowerCase() === "admin" ? "an admin" : `a ${roleLabel(role).toLowerCase()}`}.`);
    } catch (e) { toast(errMsg(e)); await refresh(); }
  };
  const remove = (c: Collaborator) => {
    const self = c.id === me.data?.user.id;
    setConfirm({
      title: self ? "Leave this project?" : `Remove ${c.name ?? c.email}?`,
      body: self ? "You lose access to this project at once. An admin can invite you again." : `${c.email} loses access to this project at once. You can invite them again later.`,
      label: self ? "Leave project" : "Remove",
      run: async () => {
        await api(`${base(pid)}/collaborators/${encodeURIComponent(c.id)}`, { method: "DELETE" });
        if (self) { await qc.invalidateQueries({ queryKey: ["me"] }); nav("/"); return; }
        await refresh(); toast(`${c.email} was removed.`);
      },
    });
  };
  const resend = async (i: Invite) => {
    try { const r = await api<Invite>(`${base(pid)}/invites/${i.id}/actions/resend`, { method: "POST" }); await refresh(); toast(r.email_sent === false ? "The email could not be sent. Try again." : `Invite sent again to ${i.email}.`); }
    catch (e) { toast(errMsg(e)); }
  };
  const revoke = (i: Invite) => setConfirm({
    title: `Revoke the invite for ${i.email}?`, body: "The link in their email stops working. You can invite them again later.", label: "Revoke invite",
    run: async () => { await api(`${base(pid)}/invites/${i.id}`, { method: "DELETE" }); await refresh(); toast(`Invite for ${i.email} revoked.`); },
  });
  const inviteButton = (
    <button type="button" className="btn btn-dark" disabled={!isAdmin || verifyFirst} title={!isAdmin ? "Only admins can invite people" : verifyFirst ? "Confirm your email address first" : undefined} onClick={() => setInviting(true)}>
      <Icon name="userplus" />Invite
    </button>
  );
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Members</b>{inviteButton}</div>
        {list.isLoading && <div className="pb subtle">Loading…</div>}
        {list.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(list.error)}</div></div>}
        {list.data && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Name</th><th className="hide-sm">Email</th><th>Role</th><th className="hide-sm">Joined</th><th aria-label="Actions" /></tr></thead>
              <tbody>{list.data.map((c) => {
                const self = c.id === me.data?.user.id;
                return (
                  <tr key={c.id}>
                    <td><b>{c.name ?? c.email}</b>{self && <span className="subtle"> (you)</span>}</td>
                    <td className="hide-sm">{c.email}</td>
                    <td>{isAdmin
                      ? <select className="select" aria-label={`Role of ${c.email}`} value={roleOf(c.role)} onChange={(e) => void setRole(c, e.target.value as Role)}>{ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
                      : <Tag tone={roleOf(c.role) === "admin" ? "gold" : "muted"}>{roleLabel(c.role)}</Tag>}</td>
                    <td className="hide-sm">{fmt.date(c.accepted_at)}</td>
                    <td className="actions-cell">{(isAdmin || self) && <Menu label={`Actions for ${c.email}`} items={[{ label: self ? "Leave project" : "Remove from project", icon: "trash", danger: true, onSelect: () => remove(c) }]} />}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>

      {!!invites.data?.length && (
        <section className="panel">
          <div className="ph"><b>Pending invites</b></div>
          <div className="tbl members">
            <table>
              <thead><tr><th>Email</th><th>Role</th><th className="hide-sm">Status</th><th className="hide-sm">Sent</th><th aria-label="Actions" /></tr></thead>
              <tbody>{invites.data.map((i) => (
                <tr key={i.id}>
                  <td><b>{i.email}</b>{i.status === "expired" && <span className="show-sm"> <Tag tone="down">Expired</Tag></span>}</td>
                  <td>{roleLabel(i.role)}</td>
                  <td className="hide-sm"><Tag tone={i.status === "expired" ? "down" : "info"}>{i.status === "expired" ? "Expired" : "Pending"}</Tag></td>
                  <td className="hide-sm">{fmt.date(i.last_sent_at)}</td>
                  <td className="actions-cell">{isAdmin && <Menu label={`Actions for the invite to ${i.email}`} items={[
                    { label: "Resend invite", icon: "refresh", onSelect: () => void resend(i) },
                    { label: "Revoke invite", icon: "trash", danger: true, onSelect: () => revoke(i) },
                  ]} />}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="ph"><b>Roles</b></div>
        <div className="pb stack">
          {ROLES.map((r) => <p key={r.value} className="section-sub"><b>{r.label}.</b> {r.text}</p>)}
          {!isAdmin && <p className="section-sub">Only admins can invite people and change roles.</p>}
          {isAdmin && verifyFirst && <p className="section-sub">Confirm your email address (see the banner at the top) to invite people.</p>}
        </div>
      </section>
      {inviting && <InviteDialog pid={pid} onClose={() => setInviting(false)} />}
      {confirm && <ConfirmDialog title={confirm.title} confirmLabel={confirm.label} danger onConfirm={confirm.run} onClose={() => setConfirm(null)}>{confirm.body}</ConfirmDialog>}
    </div>
  );
}

const SOON_TEXT: Record<string, [string, string]> = {
  domains: ["Domains", "Serve purchase links and web paywalls from your own domain."],
  ai: ["AI features", "Ask questions about your revenue and customers in plain language."],
};

export function ProjectSettingsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const { tab = "general" } = useParams();
  const project = useQuery({ queryKey: ["project", pid], queryFn: () => api<Project>(base(pid)), enabled: !!pid });
  const t = (TABS.some((x) => x.value === tab) ? tab : "general") as Tab;
  return (
    <Shell title="Project settings">
      <div className="page narrow">
        <PageHead title="Project settings" />
        <Tabs label="Project settings" idBase="settings" value={t} tabs={TABS} onChange={(v) => nav(`/projects/${pid}/settings/${v}`)} />
        <div role="tabpanel" id={`settings-${t}-panel`} aria-labelledby={`settings-${t}`}>
          {t === "general" && (
            <>
              {project.isLoading && <div className="panel pb subtle">Loading…</div>}
              {project.isError && <div className="banner err" role="alert">The project could not be loaded: {errMsg(project.error)}</div>}
              {project.data && <General p={project.data} />}
            </>
          )}
          {t === "collaborators" && <Collaborators pid={pid} />}
          {t === "audit-logs" && <AuditLogs pid={pid} />}
          {SOON_TEXT[t] && <div className="empty"><h3>{SOON_TEXT[t]![0]} comes in a later release</h3><p>{SOON_TEXT[t]![1]}</p></div>}
        </div>
      </div>
    </Shell>
  );
}
