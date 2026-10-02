// RevenueDot Enterprise (ee/LICENSE). Organization settings, Projects tab: move projects in and out, and give project
// members built-in or custom roles.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type List } from "../../../apps/dashboard/src/lib/api";
import { ConfirmDialog, Dialog, EmptyState, Field, Menu, Tag, useToast } from "../../../apps/dashboard/src/components/ui";
import { useMe } from "../../../apps/dashboard/src/components/Shell";
import { Icon } from "../../../apps/dashboard/src/components/icons";
import { SOURCE_LABEL, base, errMsg, isAdmin, roleOptions, useOrgProjects, useRoles, type OrgProject, type Overview, type ProjectMember } from "../lib";

function AddProject({ org, inOrg, onClose }: { org: Overview; inOrg: Set<string>; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const choices = (me.data?.projects ?? []).filter((p) => p.role === "admin" && !inOrg.has(p.id));
  const [pid, setPid] = useState(choices[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true); setError(null);
    try {
      await api(`${base(org.id)}/projects`, { method: "POST", json: { project_id: pid } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["org-projects", org.id] }), qc.invalidateQueries({ queryKey: ["org", org.id] }), qc.invalidateQueries({ queryKey: ["me"] })]);
      toast("Project moved into the organization.");
      onClose();
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title="Move a project into this organization" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy || !pid} onClick={add}>{busy ? "Moving…" : "Move project"}</button>
    </>}>
      {choices.length ? (
        <div className="stack">
          <Field label="Project" htmlFor="add-project" hint="Projects where you are an admin. Its people become organization members, and organization owners and admins become its admins.">
            <select id="add-project" className="select" value={pid} onChange={(e) => setPid(e.target.value)}>{choices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </Field>
          <p className="section-sub">The project's data stays where it is stored today. Its region is shown on the Data location tab.</p>
        </div>
      ) : <p className="section-sub">You are not an admin of any project outside this organization.</p>}
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}

function ProjectMembers({ org, project, onClose }: { org: Overview; project: OrgProject; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles(org.id, org.features.includes("custom_roles"));
  const key = ["org-project-members", org.id, project.id];
  const list = useQuery({ queryKey: key, queryFn: async () => (await api<List<ProjectMember>>(`${base(org.id)}/projects/${project.id}/members`)).items });
  const canEdit = isAdmin(org) || project.your_role === "admin";
  const options = roleOptions(roles.data, project.id);
  const set = async (m: ProjectMember, role: string) => {
    try {
      const r = await api<{ role_name: string }>(`${base(org.id)}/projects/${project.id}/members/${encodeURIComponent(m.user_id)}`, { method: "POST", json: { role } });
      await qc.invalidateQueries({ queryKey: key });
      toast(`${m.email} is now ${r.role_name}.`);
    } catch (e) { toast(errMsg(e)); await qc.invalidateQueries({ queryKey: key }); }
  };
  return (
    <Dialog title={`${project.name}: members and roles`} onClose={onClose} footer={<button type="button" className="btn btn-line" onClick={onClose}>Done</button>}>
      {list.isLoading && <p className="subtle">Loading…</p>}
      {list.isError && <div className="banner err" role="alert">{errMsg(list.error)}</div>}
      {list.data && (
        <div className="tbl members">
          <table>
            <thead><tr><th>Member</th><th>Role</th><th className="hide-sm">Managed by</th></tr></thead>
            <tbody>{list.data.map((m) => (
              <tr key={m.user_id}>
                <td><b>{m.name ?? m.email}</b><div className="subtle">{m.email}</div></td>
                <td>{canEdit
                  ? <select className="select" aria-label={`Role of ${m.email} in ${project.name}`} value={m.role} onChange={(e) => void set(m, e.target.value)}>
                      {!options.some((o) => o.value === m.role) && <option value={m.role}>{m.role_name}</option>}
                      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  : <Tag>{m.role_name}</Tag>}</td>
                <td className="hide-sm">{SOURCE_LABEL[m.source] ?? m.source}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="section-sub">Invite new people from the project's Collaborators settings; change their role here. Roles set by hand stay as they are when single sign-on or SCIM groups change.</p>
    </Dialog>
  );
}

export function ProjectsTab({ org }: { org: Overview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const projects = useOrgProjects(org.id);
  const [adding, setAdding] = useState(false);
  const [members, setMembers] = useState<OrgProject | null>(null);
  const [removing, setRemoving] = useState<OrgProject | null>(null);
  const admin = isAdmin(org);
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Projects</b>{admin && <button type="button" className="btn btn-dark" onClick={() => setAdding(true)}><Icon name="plus" />Move a project in</button>}</div>
        {projects.isLoading && <div className="pb subtle">Loading…</div>}
        {projects.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(projects.error)}</div></div>}
        {projects.data && !projects.data.length && <div className="pb"><EmptyState title="No projects yet" text="Move a project you administer into the organization. Its apps, customers and data stay as they are." /></div>}
        {!!projects.data?.length && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Project</th><th className="hide-sm">Region</th><th className="hide-sm">Members</th><th>Your role</th><th aria-label="Actions" /></tr></thead>
              <tbody>{projects.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.your_role ? <Link to={`/projects/${p.id}/overview`}><b>{p.name}</b></Link> : <b>{p.name}</b>}<div className="subtle mono">{p.id}</div></td>
                  <td className="hide-sm">{p.region_name}</td>
                  <td className="hide-sm mono">{p.member_count}</td>
                  <td>{p.your_role ? <Tag>{p.your_role}</Tag> : <span className="subtle">No access</span>}</td>
                  <td className="actions-cell"><Menu label={`Actions for ${p.name}`} items={[
                    { label: "Members and roles", icon: "customers", onSelect: () => setMembers(p) },
                    ...(admin ? ["-" as const, { label: "Move out of the organization", icon: "trash", danger: true, onSelect: () => setRemoving(p) }] : []),
                  ]} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      {adding && <AddProject org={org} inOrg={new Set(projects.data?.map((p) => p.id) ?? [])} onClose={() => setAdding(false)} />}
      {members && <ProjectMembers org={org} project={members} onClose={() => setMembers(null)} />}
      {removing && (
        <ConfirmDialog title={`Move ${removing.name} out of ${org.name}?`} confirmLabel="Move out" danger onClose={() => setRemoving(null)} onConfirm={async () => {
          await api(`${base(org.id)}/projects/${removing.id}`, { method: "DELETE" });
          await Promise.all([qc.invalidateQueries({ queryKey: ["org-projects", org.id] }), qc.invalidateQueries({ queryKey: ["org", org.id] })]);
          toast(`${removing.name} left the organization.`);
        }}>Everyone keeps their access, but custom roles become Viewer, and single sign-on enforcement, SCIM groups and audit retention no longer apply to it.</ConfirmDialog>
      )}
    </div>
  );
}
