// RevenueDot Enterprise (ee/LICENSE). Organization settings, SCIM tab: bearer tokens, the base URL, and identity
// provider group → project role mappings (used by SCIM groups and SSO group claims alike).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmt, type List } from "../../../apps/dashboard/src/lib/api";
import { ConfirmDialog, CopyField, Dialog, EmptyState, Field, Menu, Tag, useToast } from "../../../apps/dashboard/src/components/ui";
import { Icon } from "../../../apps/dashboard/src/components/icons";
import { base, errMsg, isAdmin, roleOptions, useOrgProjects, useRoles, type Mapping, type Overview } from "../lib";

interface Token { id: string; name: string; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null }
interface Group { id: string; display_name: string; member_count: number }

function NewToken({ org, onClose }: { org: Overview; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("Okta");
  const [created, setCreated] = useState<{ token: string; base_url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ token: string; base_url: string }>(`${base(org.id)}/scim/tokens`, { method: "POST", json: { name: name.trim() || "SCIM" } });
      await qc.invalidateQueries({ queryKey: ["scim-tokens", org.id] });
      setCreated(r);
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  if (created) return (
    <Dialog title="Copy your SCIM token" onClose={onClose} footer={<button type="button" className="btn btn-dark" onClick={onClose}>I copied it</button>}>
      <div className="stack">
        <div className="banner warn">This is the only time the token is shown. Paste it into your identity provider now.</div>
        <Field label="SCIM base URL (tenant URL)" htmlFor="scim-url"><CopyField value={created.base_url} label="SCIM base URL" /></Field>
        <Field label="Bearer token (secret token)" htmlFor="scim-token"><CopyField value={created.token} label="SCIM token" /></Field>
        <p className="section-sub">Okta: Provisioning, Integration, SCIM connector base URL, unique identifier <code className="mono">userName</code>, authentication mode HTTP Header. Entra ID: Provisioning, Tenant URL and Secret Token.</p>
      </div>
    </Dialog>
  );
  return (
    <Dialog title="New SCIM token" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create token"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <Field label="Name" htmlFor="scim-name" hint="Which identity provider uses it."><input id="scim-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <button type="submit" hidden />
      </form>
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}

function NewMapping({ org, groups, onClose }: { org: Overview; groups: Group[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const projects = useOrgProjects(org.id);
  const roles = useRoles(org.id, org.features.includes("custom_roles"));
  const [group, setGroup] = useState("");
  const [project, setProject] = useState("");
  const [role, setRole] = useState("viewer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pid = project || projects.data?.[0]?.id || "";
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ memberships_changed: number }>(`${base(org.id)}/role_mappings`, { method: "POST", json: { group: group.trim(), project_id: pid, role } });
      await qc.invalidateQueries({ queryKey: ["role-mappings", org.id] });
      toast(`Mapping saved; ${r.memberships_changed} membership${r.memberships_changed === 1 ? "" : "s"} changed.`);
      onClose();
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title="Map a group to a role" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy || !group.trim() || !pid} onClick={save}>{busy ? "Saving…" : "Save mapping"}</button>
    </>}>
      <div className="stack">
        <Field label="Group name" htmlFor="map-group" hint="A SCIM group's display name or a value of the SSO groups attribute. Matched without regard to case.">
          <input id="map-group" className="input" list="scim-groups" autoFocus value={group} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. RevenueDot Support" />
          <datalist id="scim-groups">{groups.map((g) => <option key={g.id} value={g.display_name} />)}</datalist>
        </Field>
        <Field label="Project" htmlFor="map-project"><select id="map-project" className="select" value={pid} onChange={(e) => setProject(e.target.value)}>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Role" htmlFor="map-role" hint="Someone in several mapped groups gets the highest role: Admin, Developer, custom roles, then Viewer.">
          <select id="map-role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>{roleOptions(roles.data, pid).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        </Field>
        {error && <div className="banner err" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}

export function ScimTab({ org }: { org: Overview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const admin = isAdmin(org);
  const tokens = useQuery({ queryKey: ["scim-tokens", org.id], queryFn: async () => (await api<List<Token>>(`${base(org.id)}/scim/tokens`)).items, enabled: admin });
  const groups = useQuery({ queryKey: ["scim-groups", org.id], queryFn: async () => (await api<List<Group>>(`${base(org.id)}/scim/groups`)).items, enabled: admin });
  const mappings = useQuery({ queryKey: ["role-mappings", org.id], queryFn: async () => (await api<List<Mapping>>(`${base(org.id)}/role_mappings`)).items });
  const [creating, setCreating] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<unknown> } | null>(null);
  if (!admin) return <EmptyState title="Owners and admins manage provisioning" />;
  const live = tokens.data?.filter((t) => !t.revoked_at) ?? [];
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Tokens</b><button type="button" className="btn btn-dark" onClick={() => setCreating(true)}><Icon name="plus" />New token</button></div>
        <div className="pb stack">
          <p className="section-sub">Your identity provider creates, updates and deactivates members through SCIM 2.0. Deactivating someone there removes their access to every project of {org.name} and signs them out at once. Members must be on a verified domain (Single sign-on tab).</p>
          <Field label="SCIM base URL" htmlFor="scim-base"><CopyField value={`${window.location.origin}/scim/v2`} label="SCIM base URL" /></Field>
        </div>
        {!!live.length && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Name</th><th className="hide-sm">Token</th><th>Last used</th><th aria-label="Actions" /></tr></thead>
              <tbody>{live.map((t) => (
                <tr key={t.id}>
                  <td><b>{t.name}</b><div className="subtle">Created {fmt.date(t.created_at)}</div></td>
                  <td className="hide-sm"><code>{t.prefix}…</code></td>
                  <td>{fmt.ago(t.last_used_at)}</td>
                  <td className="actions-cell"><Menu label={`Actions for ${t.name}`} items={[{ label: "Revoke", icon: "trash", danger: true, onSelect: () => setConfirm({ title: `Revoke ${t.name}?`, body: "The identity provider can no longer provision with it. Members it created keep their access.", label: "Revoke token", run: async () => { await api(`${base(org.id)}/scim/tokens/${t.id}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["scim-tokens", org.id] }); toast(`${t.name} revoked.`); } }) }]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="ph"><b>Group role mappings</b><button type="button" className="btn btn-line" onClick={() => setMapping(true)}><Icon name="plus" />Map a group</button></div>
        <div className="pb stack">
          <p className="section-sub">Members of a group get the role in the project. Leaving the group removes what it gave; roles you set by hand stay. {groups.data?.length ? `${groups.data.length} SCIM group${groups.data.length === 1 ? "" : "s"} so far.` : ""}</p>
        </div>
        {mappings.data && !mappings.data.length && <div className="pb"><EmptyState title="No mappings yet" /></div>}
        {!!mappings.data?.length && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Group</th><th>Project</th><th>Role</th><th aria-label="Actions" /></tr></thead>
              <tbody>{mappings.data.map((m) => (
                <tr key={m.id}>
                  <td><b>{m.group}</b></td><td>{m.project_name ?? m.project_id}</td><td><Tag>{m.role_name}</Tag></td>
                  <td className="actions-cell"><Menu label={`Actions for ${m.group}`} items={[{ label: "Delete mapping", icon: "trash", danger: true, onSelect: () => setConfirm({ title: `Delete the ${m.group} mapping?`, body: "Memberships it gave are removed now.", label: "Delete mapping", run: async () => { await api(`${base(org.id)}/role_mappings/${m.id}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["role-mappings", org.id] }); } }) }]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      {creating && <NewToken org={org} onClose={() => setCreating(false)} />}
      {mapping && <NewMapping org={org} groups={groups.data ?? []} onClose={() => setMapping(false)} />}
      {confirm && <ConfirmDialog title={confirm.title} confirmLabel={confirm.label} danger onConfirm={confirm.run} onClose={() => setConfirm(null)}>{confirm.body}</ConfirmDialog>}
    </div>
  );
}
