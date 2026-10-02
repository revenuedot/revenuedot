// RevenueDot Enterprise (ee/LICENSE). Organization settings, Members tab.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, fmt, type List } from "../../../apps/dashboard/src/lib/api";
import { ConfirmDialog, Dialog, Field, Menu, Tag, useToast } from "../../../apps/dashboard/src/components/ui";
import { useMe } from "../../../apps/dashboard/src/components/Shell";
import { Icon } from "../../../apps/dashboard/src/components/icons";
import { ORG_ROLE_TEXT, SOURCE_LABEL, base, errMsg, isAdmin, type Member, type Overview } from "../lib";

const ROLES = ["owner", "admin", "member"] as const;
const roleName = (r: string) => r[0]!.toUpperCase() + r.slice(1);

function AddMember({ org, onClose }: { org: Overview; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true); setError(null);
    try {
      const m = await api<Member>(`${base(org.id)}/members`, { method: "POST", json: { email: email.trim(), role } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["org-members", org.id] }), qc.invalidateQueries({ queryKey: ["org", org.id] })]);
      toast(`${m.email} added.`);
      onClose();
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <Dialog title="Add a member" onClose={busy ? () => {} : onClose} footer={<>
      <button type="button" className="btn btn-line" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" disabled={busy || !email.trim()} onClick={add}>{busy ? "Adding…" : "Add member"}</button>
    </>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Field label="Email" htmlFor="member-email" hint="Someone who already has a RevenueDot account. People on your verified domains join by themselves through single sign-on or SCIM.">
          <input id="member-email" className="input" type="email" autoFocus value={email} onChange={(e) => { setEmail(e.target.value); setError(null); }} />
        </Field>
        <Field label="Organization role" htmlFor="member-role" hint={ORG_ROLE_TEXT[role]}>
          <select id="member-role" className="select" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            {ROLES.filter((r) => r !== "owner" || org.your_role === "owner").map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
          </select>
        </Field>
        <button type="submit" hidden />
      </form>
      {error && <div className="banner err" role="alert">{error}</div>}
    </Dialog>
  );
}

export function MembersTab({ org }: { org: Overview }) {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const admin = isAdmin(org);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Member | null>(null);
  const list = useQuery({ queryKey: ["org-members", org.id], queryFn: async () => (await api<List<Member>>(`${base(org.id)}/members`)).items });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["org-members", org.id] }), qc.invalidateQueries({ queryKey: ["org", org.id] })]);
  const setRole = async (m: Member, role: string) => {
    try { await api(`${base(org.id)}/members/${encodeURIComponent(m.user_id)}`, { method: "POST", json: { role } }); await refresh(); toast(`${m.email} is now ${role === "admin" ? "an admin" : `a ${role}`}.`); }
    catch (e) { toast(errMsg(e)); await refresh(); }
  };
  const canEdit = (m: Member) => admin && (m.role !== "owner" || org.your_role === "owner");
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Members</b>{admin && <button type="button" className="btn btn-dark" onClick={() => setAdding(true)}><Icon name="userplus" />Add member</button>}</div>
        {list.isLoading && <div className="pb subtle">Loading…</div>}
        {list.isError && <div className="pb"><div className="banner err" role="alert">{errMsg(list.error)}</div></div>}
        {list.data && (
          <div className="tbl members">
            <table>
              <thead><tr><th>Name</th><th>Role</th><th className="hide-sm">Joined through</th><th className="hide-sm">Sign-in</th><th aria-label="Actions" /></tr></thead>
              <tbody>{list.data.map((m) => {
                const self = m.user_id === me.data?.user.id;
                return (
                  <tr key={m.user_id}>
                    <td><b>{m.name ?? m.email}</b>{self && <span className="subtle"> (you)</span>}<div className="subtle">{m.email}</div></td>
                    <td>{canEdit(m)
                      ? <select className="select" aria-label={`Organization role of ${m.email}`} value={m.role} onChange={(e) => void setRole(m, e.target.value)}>{ROLES.filter((r) => r !== "owner" || org.your_role === "owner").map((r) => <option key={r} value={r}>{roleName(r)}</option>)}</select>
                      : <Tag tone={m.role === "owner" ? "gold" : "muted"}>{roleName(m.role)}</Tag>}
                      {!m.active && <> <Tag tone="down">Deactivated</Tag></>}</td>
                    <td className="hide-sm">{SOURCE_LABEL[m.source] ?? m.source}{m.sso_groups.length > 0 && <div className="subtle" title={m.sso_groups.join(", ")}>Groups: {m.sso_groups.slice(0, 3).join(", ")}{m.sso_groups.length > 3 ? "…" : ""}</div>}</td>
                    <td className="hide-sm">{m.last_sso_at ? <>SSO {fmt.ago(m.last_sso_at)}</> : "—"}{m.password_sign_in && <div className="subtle">Has a password</div>}</td>
                    <td className="actions-cell">{(canEdit(m) || self) && <Menu label={`Actions for ${m.email}`} items={[{ label: self ? "Leave organization" : "Remove from organization", icon: "trash", danger: true, onSelect: () => setConfirm(m) }]} />}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="ph"><b>Organization roles</b></div>
        <div className="pb stack">{Object.entries(ORG_ROLE_TEXT).map(([r, t]) => <p key={r} className="section-sub"><b>{roleName(r)}.</b> {t}</p>)}</div>
      </section>
      {adding && <AddMember org={org} onClose={() => setAdding(false)} />}
      {confirm && (
        <ConfirmDialog title={confirm.user_id === me.data?.user.id ? "Leave this organization?" : `Remove ${confirm.email}?`} confirmLabel={confirm.user_id === me.data?.user.id ? "Leave" : "Remove"} danger onClose={() => setConfirm(null)} onConfirm={async () => {
          await api(`${base(org.id)}/members/${encodeURIComponent(confirm.user_id)}`, { method: "DELETE" });
          if (confirm.user_id === me.data?.user.id) { await qc.invalidateQueries({ queryKey: ["me"] }); nav("/"); return; }
          await refresh(); toast(`${confirm.email} was removed.`);
        }}>They lose access to every project of {org.name} at once, including projects they were added to by hand.</ConfirmDialog>
      )}
    </div>
  );
}
