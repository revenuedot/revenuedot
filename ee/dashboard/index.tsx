// RevenueDot Enterprise (ee/LICENSE). Organization settings, loaded by the dashboard's extension point
// (apps/dashboard/src/extensions.tsx) under /organizations. Spec: prd/enterprise/PRD.md §11.
import { useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type List } from "../../apps/dashboard/src/lib/api";
import { EmptyState, Field, PageHead, useToast } from "../../apps/dashboard/src/components/ui";
import { OrgShell, TABS, type Tab } from "./shell";
import { base, errMsg, useOrg, type Org } from "./lib";
import { GeneralTab } from "./pages/General";
import { MembersTab } from "./pages/Members";
import { ProjectsTab } from "./pages/Projects";
import { RolesTab } from "./pages/Roles";
import { SsoTab } from "./pages/Sso";
import { ScimTab } from "./pages/Scim";
import { DataLocationTab } from "./pages/DataLocation";
import { AuditLogTab } from "./pages/AuditLog";
import { ExportsTab } from "./pages/Exports";

function CreateOrg({ first }: { first: boolean }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim()) { setError("Enter a name."); return; }
    setBusy(true); setError(null);
    try {
      const o = await api<Org>("/v2/organizations", { method: "POST", json: { name: name.trim() } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["me"] }), qc.invalidateQueries({ queryKey: ["orgs"] })]);
      toast(`${o.name} created.`);
      nav(`/organizations/${o.id}/projects`);
    } catch (e) { setError(errMsg(e)); setBusy(false); }
  };
  return (
    <section className="panel">
      <div className="ph"><b>{first ? "Create your organization" : "New organization"}</b></div>
      <form className="pb stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <p className="section-sub">An organization owns projects and holds single sign-on, SCIM, custom roles, data location and audit settings. You become its owner, then move your projects in.</p>
        <Field label="Organization name" htmlFor="org-name"><input id="org-name" className="input" value={name} autoFocus onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="e.g. Acme Inc." /></Field>
        {error && <div className="banner err" role="alert">{error}</div>}
        <div><button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button></div>
      </form>
    </section>
  );
}

function OrgIndex() {
  const [params] = useSearchParams();
  const list = useQuery({ queryKey: ["orgs"], queryFn: async () => (await api<List<Org>>("/v2/organizations")).items, retry: false });
  const nav = useNavigate();
  if (list.data?.length === 1 && !params.get("new")) return <Navigate to={`/organizations/${list.data[0]!.id}/general`} replace />;
  return (
    <OrgShell title="Organizations">
      <div className="page narrow">
        <PageHead title="Organizations" sub="Group projects under one organization with single sign-on, SCIM, custom roles and compliance controls." />
        {list.isError && <div className="banner err" role="alert">{errMsg(list.error)}</div>}
        {!!list.data?.length && (
          <div className="cards">
            {list.data.map((o) => (
              <button key={o.id} type="button" className="card" onClick={() => nav(`/organizations/${o.id}/general`)}>
                <div className="card-h"><span className="mono-tile">{o.name.slice(0, 1).toUpperCase()}</span><b>{o.name}</b></div>
                <p>{o.project_count} project{o.project_count === 1 ? "" : "s"} · {o.member_count} member{o.member_count === 1 ? "" : "s"} · you are {o.your_role}</p>
              </button>
            ))}
          </div>
        )}
        {list.data && <CreateOrg first={!list.data.length} />}
        {list.isLoading && <EmptyState title="Loading…" />}
      </div>
    </OrgShell>
  );
}

function OrgPage() {
  const { orgId = "", tab = "general" } = useParams();
  const org = useOrg(orgId);
  const t = (TABS.some((x) => x.value === tab) ? tab : "general") as Tab;
  const title = TABS.find((x) => x.value === t)!.label;
  return (
    <OrgShell org={org.data} title={title}>
      <div className="page narrow">
        <PageHead title={title} sub={org.data ? `${org.data.name} · you are ${org.data.your_role}` : undefined} />
        {org.isLoading && <div className="panel pb subtle">Loading…</div>}
        {org.isError && <div className="banner err" role="alert">The organization could not be loaded: {errMsg(org.error)}</div>}
        {org.data && (
          <div role="region" aria-label={title}>
            {t === "general" && <GeneralTab org={org.data} />}
            {t === "members" && <MembersTab org={org.data} />}
            {t === "projects" && <ProjectsTab org={org.data} />}
            {t === "roles" && <RolesTab org={org.data} />}
            {t === "sso" && <SsoTab org={org.data} />}
            {t === "scim" && <ScimTab org={org.data} />}
            {t === "data-location" && <DataLocationTab org={org.data} />}
            {t === "audit-log" && <AuditLogTab org={org.data} />}
            {t === "exports" && <ExportsTab org={org.data} />}
          </div>
        )}
      </div>
    </OrgShell>
  );
}

export default function EnterpriseApp() {
  return (
    <Routes>
      <Route index element={<OrgIndex />} />
      <Route path=":orgId" element={<OrgRedirect />} />
      <Route path=":orgId/:tab" element={<OrgPage />} />
    </Routes>
  );
}

function OrgRedirect() {
  const { orgId = "" } = useParams();
  return <Navigate to={`/organizations/${orgId}/general`} replace />;
}

export { base };
