// RevenueDot Enterprise (ee/LICENSE). The organization settings layout: the dashboard's sidebar and top bar, with the
// organization's sections in place of a project's. Spec: prd/enterprise/PRD.md §11.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Icon, Mark } from "../../apps/dashboard/src/components/icons";
import { useMe } from "../../apps/dashboard/src/components/Shell";
import { useEnterprise, type Overview } from "./lib";

export const TABS = [
  { value: "general", label: "General", icon: "settings" },
  { value: "members", label: "Members", icon: "customers" },
  { value: "projects", label: "Projects", icon: "apps" },
  { value: "roles", label: "Roles", icon: "key", feature: "custom_roles" },
  { value: "sso", label: "Single sign-on", icon: "auth", feature: "sso" },
  { value: "scim", label: "SCIM provisioning", icon: "refresh", feature: "scim" },
  { value: "data-location", label: "Data location", icon: "globe", feature: "data_location" },
  { value: "audit-log", label: "Audit log", icon: "docs" },
  { value: "exports", label: "Compliance exports", icon: "archive", feature: "compliance_exports" },
] as const;
export type Tab = (typeof TABS)[number]["value"];

function OrgSwitcher({ current }: { current: Overview | undefined }) {
  const me = useMe();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const orgs = me.data?.enterprise?.organizations ?? [];
  return (
    <div ref={ref} style={{ flex: 1, minWidth: 0, position: "relative" }}>
      <button className="proj" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} style={{ width: "100%" }}>
        <span className="ic">{(current?.name ?? "O").slice(0, 1).toUpperCase()}</span><b>{current?.name ?? "Organizations"}</b><Icon name="updown" className="i" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {orgs.map((o) => <button key={o.id} role="menuitem" type="button" onClick={() => { setOpen(false); nav(`/organizations/${o.id}/general`); }}>{o.name}</button>)}
          <hr />
          <button role="menuitem" type="button" onClick={() => { setOpen(false); nav("/organizations?new=1"); }}><Icon name="plus" />New organization</button>
          {me.data?.projects[0] && <button role="menuitem" type="button" onClick={() => { setOpen(false); nav(`/projects/${me.data!.projects[0]!.id}/overview`); }}><Icon name="arrow" />Back to projects</button>}
        </div>
      )}
    </div>
  );
}

export function OrgShell({ org, title, children }: { org?: Overview; title: string; children: ReactNode }) {
  const me = useMe();
  const ent = useEnterprise();
  const nav = useNavigate();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  useEffect(() => { document.title = `${title} · ${org?.name ?? "Organization"} · RevenueDot`; }, [title, org?.name]);
  useEffect(() => { if (me.isError) nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true }); }, [me.isError, nav, loc.pathname, loc.search]);
  const features = new Set(ent.data?.features ?? org?.features ?? []);
  const tabs = TABS.filter((t) => !("feature" in t) || features.has(t.feature));
  const home = me.data?.projects[0] ? `/projects/${me.data.projects[0].id}/overview` : "/";
  return (
    <div className="shell">
      {menu && <button type="button" className="side-scrim" aria-label="Close menu" onClick={() => setMenu(false)} />}
      <aside className={`side${menu ? " open" : ""}`} aria-label="Sidebar" id="sidebar">
        <div className="brand">
          <Link to={home} aria-label="RevenueDot home"><Mark /></Link>
          <OrgSwitcher current={org} />
        </div>
        <nav className="nav" aria-label="Organization">
          {org && tabs.map((t) => (
            <NavLink key={t.value} to={`/organizations/${org.id}/${t.value}`} className={({ isActive }) => `it${isActive ? " active" : ""}`}><Icon name={t.icon} />{t.label}</NavLink>
          ))}
        </nav>
        <div className="nav-foot"><Link className="it" to={home}><Icon name="arrow" />Back to projects</Link></div>
      </aside>
      <div className="main">
        <header className="top">
          <button type="button" className="ib menu-btn" aria-label="Menu" aria-controls="sidebar" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
          <nav className="crumb" aria-label="Breadcrumb"><span>{org?.name ?? "Organizations"}</span> <span>/</span> <b>{title}</b></nav>
          <div className="top-r"><a className="ib" href="https://revenuedot.app/docs/guides/enterprise" target="_blank" rel="noreferrer" aria-label="Docs"><Icon name="docs" /></a></div>
        </header>
        {ent.data && ent.data.mode !== "licensed" && (
          <div className="verify-banner" role="status">
            <span>{ent.data.mode === "development" ? "Development licence: for development and testing only, not for production use (ee/LICENSE)." : `RevenueDot Enterprise is off: ${ent.data.message ?? "the licence is not valid"}.`}</span>
          </div>
        )}
        {ent.data?.mode === "licensed" && ent.data.message && <div className="verify-banner" role="status"><span>{ent.data.message}</span></div>}
        <div className="scroll">{children}</div>
      </div>
    </div>
  );
}
