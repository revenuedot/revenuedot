// RevenueDot Enterprise (ee/LICENSE). Organization settings, General tab: name, licence, seats and billing, delete.
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, fmt } from "../../../apps/dashboard/src/lib/api";
import { ConfirmDialog, CopyField, Field, KeyValue, Tag, useToast } from "../../../apps/dashboard/src/components/ui";
import { base, errMsg, isAdmin, useEnterprise, type Overview } from "../lib";
import { FEATURE_LABEL, LockNote } from "../locked";

const PLAN_NAME: Record<string, string> = { none: "No plan", pro: "Pro", enterprise: "Enterprise" };

export function GeneralTab({ org }: { org: Overview }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const ent = useEnterprise();
  const admin = isAdmin(org);
  const owner = org.your_role === "owner";
  const [name, setName] = useState(org.name);
  const [seats, setSeats] = useState(org.seats.purchased?.toString() ?? "");
  const [billing, setBilling] = useState(org.billing_email ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dirty = name !== org.name || seats !== (org.seats.purchased?.toString() ?? "") || billing !== (org.billing_email ?? "");
  const save = async () => {
    setBusy(true); setError(null);
    const json: Record<string, unknown> = {};
    if (name !== org.name) json.name = name.trim();
    if (seats !== (org.seats.purchased?.toString() ?? "")) json.seats = seats.trim() ? Number(seats) : null;
    if (billing !== (org.billing_email ?? "")) json.billing_email = billing.trim() || null;
    try {
      await api(base(org.id), { method: "POST", json });
      await Promise.all([qc.invalidateQueries({ queryKey: ["org", org.id] }), qc.invalidateQueries({ queryKey: ["me"] })]);
      toast("Saved.");
    } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  const over = org.seats.purchased !== null && org.seats.used > org.seats.purchased;
  return (
    <div className="stack">
      <section className="panel">
        <div className="ph"><b>Organization</b></div>
        <form className="pb stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <Field label="Name" htmlFor="org-name"><input id="org-name" className="input" value={name} disabled={!admin} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Organization ID" htmlFor="org-id" hint="Used in REST API v2 paths: /v2/organizations/{id}."><CopyField value={org.id} label="organization ID" /></Field>
          <Field label="Seats bought" htmlFor="org-seats" hint={`${org.seats.used} in use: everyone who is a member or works on one of its projects.${owner ? "" : " Only owners change seats."}`} error={over ? `${org.seats.used - org.seats.purchased!} more in use than bought.` : null}>
            <input id="org-seats" className="input" type="number" min={1} inputMode="numeric" value={seats} disabled={!owner} onChange={(e) => setSeats(e.target.value)} placeholder="Not set" />
          </Field>
          <Field label="Billing email" htmlFor="org-billing" hint="Invoices and seat notices go here.">
            <input id="org-billing" className="input" type="email" value={billing} disabled={!owner} onChange={(e) => setBilling(e.target.value)} placeholder="billing@example.com" />
          </Field>
          {error && <div className="banner err" role="alert">{error}</div>}
          {admin && <div><button type="submit" className="btn btn-dark" disabled={!dirty || busy}>{busy ? "Saving…" : "Save changes"}</button></div>}
        </form>
      </section>

      {ent.data?.mode === "cloud" ? (
        <section className="panel">
          <div className="ph"><b>Plan</b><Tag tone={!org.plan || org.plan === "none" ? "muted" : "up"}>{PLAN_NAME[org.plan ?? "none"] ?? org.plan}</Tag></div>
          <div className="pb stack">
            <KeyValue rows={[
              ["Included", org.features.length ? <span className="hrow" key="f">{org.features.map((f) => <Tag key={f}>{FEATURE_LABEL[f] ?? f}</Tag>)}</span> : "None"],
              ...org.locked.map((l) => [FEATURE_LABEL[l.feature] ?? l.feature, <span key={l.feature}><LockNote plan={l.plan} /></span>] as [string, ReactNode]),
            ]} />
            <p className="section-sub">An organization has the plan of its best-paying owner. Owners change their own plan in Account settings, Billing.</p>
          </div>
        </section>
      ) : (
      <section className="panel">
        <div className="ph"><b>RevenueDot Enterprise licence</b>{ent.data && <Tag tone={ent.data.mode === "licensed" ? "up" : ent.data.mode === "development" ? "info" : "down"}>{ent.data.mode}</Tag>}</div>
        <div className="pb stack">
          {ent.data && <KeyValue rows={[
            ["Licensed to", ent.data.licensee ?? (ent.data.mode === "development" ? "Development mode" : "—")],
            ["Expires", ent.data.expires_at ? fmt.date(ent.data.expires_at) : "—"],
            ["Features", <span className="hrow" key="f">{ent.data.features.map((f) => <Tag key={f}>{FEATURE_LABEL[f] ?? f}</Tag>)}</span>],
          ]} />}
          {ent.data?.message && <p className="section-sub">{ent.data.message}</p>}
          {org.locked.length > 0 && <KeyValue rows={org.locked.map((l) => [FEATURE_LABEL[l.feature] ?? l.feature, <span key={l.feature}><LockNote plan={l.plan} /></span>] as [string, ReactNode])} />}
          <p className="section-sub">The server reads the key from <code className="mono">REVENUEDOT_LICENSE_KEY</code>. Talk to <a href="mailto:sales@revenuedot.app" style={{ textDecoration: "underline" }}>sales@revenuedot.app</a> to change features or seats.</p>
        </div>
      </section>
      )}

      {owner && (
        <section className="panel danger">
          <div className="ph"><b>Delete organization</b></div>
          <div className="pb hrow between">
            <p className="section-sub">Removes the organization, its roles, single sign-on, SCIM tokens and its own audit log. Move every project out first; projects and their data are never deleted here.</p>
            <button type="button" className="btn btn-danger" disabled={org.project_count > 0} title={org.project_count > 0 ? "Move the projects out first" : undefined} onClick={() => setDeleting(true)}>Delete organization</button>
          </div>
        </section>
      )}
      {deleting && (
        <ConfirmDialog title={`Delete ${org.name}?`} confirmLabel="Delete organization" danger onClose={() => setDeleting(false)} onConfirm={async () => {
          await api(base(org.id), { method: "DELETE" });
          await qc.invalidateQueries({ queryKey: ["me"] });
          toast(`${org.name} deleted.`);
          nav("/organizations");
        }}>Single sign-on, SCIM, custom roles and the organization audit log are deleted. This cannot be undone.</ConfirmDialog>
      )}
    </div>
  );
}
