// RevenueDot Enterprise (ee/LICENSE). Organization settings, Roles tab: custom roles built from API v2 scopes.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../apps/dashboard/src/lib/api";
import { Check, ConfirmDialog, Dialog, EmptyState, Field, Menu, Tag, useToast } from "../../../apps/dashboard/src/components/ui";
import { Icon } from "../../../apps/dashboard/src/components/icons";
import { BUILTIN, base, errMsg, isAdmin, useOrgProjects, useRoles, type CustomRole, type Overview, type ScopeGroup } from "../lib";

function RoleEditor({ org, role, onClose }: { org: Overview; role: CustomRole | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalogue = useQuery({ queryKey: ["org-scopes", org.id], queryFn: async () => (await api<{ groups: ScopeGroup[] }>(`${base(org.id)}/scopes`)).groups });
  const projects = useOrgProjects(org.id);
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [scopes, setScopes] = useState<Set<string>>(new Set(role?.scopes ?? []));
  const [project, setProject] = useState(role?.project_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (s: string, on: boolean) => {
    const next = new Set(scopes);
    if (on) next.add(s); else next.delete(s);
    // Write includes read: ticking a write scope ticks its read scope too.
    if (on && s.endsWith(":read_write")) next.add(s.replace(/:read_write$/, ":read"));
    if (!on && s.endsWith(":read")) next.delete(s.replace(/:read$/, ":read_write"));
    setScopes(next);
  };
  const save = async () => {
    if (!name.trim()) { setError("Enter a name."); return; }
    setBusy(true); setError(null);
    const json = { name: name.trim(), description: description.trim() || null, scopes: [...scopes], ...(role?.member_count ? {} : { project_id: project || null }) };
    try {
      await api(role ? `${base(org.id)}/roles/${role.id}` : `${base(org.id)}/roles`, { method: "POST", json });
      await qc.invalidateQueries({ queryKey: ["org-roles", org.id] });
      toast(role ? `${json.name} saved.` : `${json.name} created.`);
      onClose();
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title={role ? `Edit ${role.name}` : "New custom role"} onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={save}>{busy ? "Saving…" : role ? "Save role" : "Create role"}</button>
    </>}>
      <div className="stack">
        <Field label="Name" htmlFor="role-name"><input id="role-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support agent" /></Field>
        <Field label="Description" htmlFor="role-desc"><input id="role-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who gets this role and why" /></Field>
        <Field label="Where it can be used" htmlFor="role-project" hint={role?.member_count ? "A role in use keeps its project." : "Every project of the organization, or one project only."}>
          <select id="role-project" className="select" value={project} disabled={!!role?.member_count} onChange={(e) => setProject(e.target.value)}>
            <option value="">Every organization project</option>
            {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name} only</option>)}
          </select>
        </Field>
        {catalogue.data?.map((g) => (
          <fieldset key={g.group} className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ font: "600 11px/16px var(--font)", textTransform: "uppercase", letterSpacing: ".05em", color: "var(--fg-3)", marginBottom: 6 }}>{g.group}</legend>
            {g.scopes.map((s) => <Check key={s.scope} checked={scopes.has(s.scope)} onChange={(on) => toggle(s.scope, on)} label={s.label} hint={<code className="mono">{s.scope}</code>} />)}
          </fieldset>
        ))}
        <p className="section-sub">Inviting people, changing roles and secret API keys stay with the built-in Admin role.</p>
        {error && <div className="banner err" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}

export function RolesTab({ org }: { org: Overview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles(org.id);
  const projects = useOrgProjects(org.id);
  const [editing, setEditing] = useState<CustomRole | "new" | null>(null);
  const [deleting, setDeleting] = useState<CustomRole | null>(null);
  const admin = isAdmin(org);
  const projectName = (id: string | null) => (id ? projects.data?.find((p) => p.id === id)?.name ?? id : "Every project");
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Custom roles</b>{admin && <button type="button" className="btn btn-dark" onClick={() => setEditing("new")}><Icon name="plus" />New role</button>}</div>
        {roles.isLoading && <div className="pb subtle">Loading…</div>}
        {roles.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(roles.error)}</div></div>}
        {roles.data && !roles.data.length && <div className="pb"><EmptyState title="No custom roles yet" text="Give people exactly the access they need, for example a support agent who can refund subscriptions but cannot edit the catalog." /></div>}
        {!!roles.data?.length && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Role</th><th className="hide-sm">Used in</th><th>Permissions</th><th className="hide-sm">Members</th><th aria-label="Actions" /></tr></thead>
              <tbody>{roles.data.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.name}</b>{r.description && <div className="subtle">{r.description}</div>}</td>
                  <td className="hide-sm">{projectName(r.project_id)}</td>
                  <td><span className="mono">{r.scopes.length}</span> <span className="subtle">scope{r.scopes.length === 1 ? "" : "s"}</span></td>
                  <td className="hide-sm mono">{r.member_count}</td>
                  <td className="actions-cell">{admin && <Menu label={`Actions for ${r.name}`} items={[
                    { label: "Edit", icon: "edit", onSelect: () => setEditing(r) },
                    { label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting(r) },
                  ]} />}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="ph"><b>Built-in roles</b></div>
        <div className="pb stack">
          {BUILTIN.map((b) => <p key={b.value} className="section-sub"><b>{b.label}.</b> {b.text}</p>)}
          <p className="section-sub">Assign roles to people on the Projects tab (Members and roles), or map identity provider groups to roles on the SCIM tab.</p>
        </div>
      </section>
      {editing && <RoleEditor org={org} role={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog title={`Delete ${deleting.name}?`} confirmLabel="Delete role" danger onClose={() => setDeleting(null)} onConfirm={async () => {
          await api(`${base(org.id)}/roles/${deleting.id}`, { method: "DELETE" });
          await qc.invalidateQueries({ queryKey: ["org-roles", org.id] });
          toast(`${deleting.name} deleted.`);
        }}>{deleting.member_count ? <>{deleting.member_count} {deleting.member_count === 1 ? "person has" : "people have"} this role; they become <Tag>Viewer</Tag>.</> : "Nobody has this role."} Group mappings that give it are removed.</ConfirmDialog>
      )}
    </div>
  );
}
