import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell, useMe } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { CopyButton, Dialog, Field, PageHead, Switch, Tabs, Tag, useProjectId, useToast } from "../../components/ui";
import { api, fmt, type List } from "../../lib/api";
import { base, errMsg, type Collaborator, type ProjectSettings as Project, type TransferBehavior } from "./data";

/**
 * Project settings (/projects/:projectId/settings/:tab): General (name, project ID, transfer behaviour for purchases
 * seen on several app user IDs with an optional sandbox behaviour, sandbox testing access, delete), Collaborators, and
 * Audit logs, Domains and AI features as later-tier tabs.
 * GAPS vs RevenueCat (frame 28): inviting collaborators by email and changing roles, transfer of project ownership,
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
  { value: "audit-logs", label: "Audit logs", badge: "SOON" }, { value: "domains", label: "Domains", badge: "SOON" }, { value: "ai", label: "AI features", badge: "SOON" },
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

function Collaborators({ pid }: { pid: string }) {
  const me = useMe();
  const list = useQuery({ queryKey: ["collaborators", pid], queryFn: async () => (await api<List<Collaborator>>(`${base(pid)}/collaborators`)).items });
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Collaborators</b><button type="button" className="btn btn-line" disabled title="Inviting by email comes in a later release"><Icon name="userplus" />Invite</button></div>
        {list.isLoading && <div className="pb subtle">Loading…</div>}
        {list.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(list.error)}</div></div>}
        {list.data && (
          <div className="tbl">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
              <tbody>{list.data.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name ?? "—"}</b>{c.id === me.data?.user.id && <span className="subtle"> (you)</span>}</td>
                  <td>{c.email}</td>
                  <td><Tag tone={c.role === "admin" ? "gold" : "muted"}>{c.role === "read_only" ? "Viewer" : "Admin"}</Tag></td>
                  <td>{fmt.date(c.accepted_at)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      <p className="section-sub">Inviting people by email and choosing their role (admin, developer, support, viewer) comes in a later release.</p>
    </div>
  );
}

const SOON_TEXT: Record<string, [string, string]> = {
  "audit-logs": ["Audit logs", "A record of who changed what in this project, with filters by person and date."],
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
          {SOON_TEXT[t] && <div className="empty"><h3>{SOON_TEXT[t]![0]} comes in a later release</h3><p>{SOON_TEXT[t]![1]}</p></div>}
        </div>
      </div>
    </Shell>
  );
}
