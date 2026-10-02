import { useEffect, type ReactNode } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Shell, useMe, type Me } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { PageHead } from "../../components/ui";
import { ApiError } from "../../lib/api";
import "./account.css";

/**
 * Account settings (prd/account-settings/PRD.md): RevenueCat's six sections at /account/*, in the dashboard shell with
 * their own left navigation instead of the project's. The project switcher stays, so people can go back.
 */
export const SECTIONS = [
  { id: "general", label: "General", icon: "user" },
  { id: "billing", label: "Billing", icon: "dollar" },
  { id: "security", label: "Security", icon: "shield" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "interface", label: "Interface", icon: "palette" },
  { id: "date-and-region", label: "Date and region", icon: "globe" },
] as const;
export type SectionId = (typeof SECTIONS)[number]["id"];

export const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong. Try again.");

/** The project the dashboard showed last, for the sidebar's switcher and the way back. */
export function lastProject(me: Me | undefined) {
  let last = "";
  try { last = localStorage.getItem("rd-last-project") ?? ""; } catch { /* ignore */ }
  return me?.projects.find((p) => p.id === last) ?? me?.projects[0] ?? null;
}

function AccountNav({ back }: { back: { id: string; name: string } | null }) {
  return (
    <>
      <nav className="nav" aria-label="Account settings">
        {back && <Link className="it acct-back" to={`/projects/${back.id}/overview`}><Icon name="back" /><span>Back to {back.name}</span></Link>}
        <div className="acct-nav-h">Account settings</div>
        {SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/account/${s.id}`} className={({ isActive }) => `it${isActive ? " active" : ""}`}><Icon name={s.icon} />{s.label}</NavLink>
        ))}
      </nav>
      <div className="nav-foot"><a className="it" href="https://revenuedot.app/docs/guides/account-settings" target="_blank" rel="noreferrer"><Icon name="docs" />Account settings guide</a></div>
    </>
  );
}

export function AccountLayout({ section, sub, children, actions }: { section: SectionId; sub?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const me = useMe();
  const nav = useNavigate();
  const label = SECTIONS.find((s) => s.id === section)!.label;
  const back = lastProject(me.data);
  useEffect(() => { if (me.isError) nav(`/login?next=${encodeURIComponent(`/account/${section}`)}`, { replace: true }); }, [me.isError, nav, section]);
  return (
    <Shell title={label} root="Account" projectId={back?.id ?? ""} sidebar={<AccountNav back={back} />} crumbs={<b>{label}</b>}>
      <div className="page narrow acct" data-section={section}>
        <PageHead title={label} sub={sub ?? me.data?.user.email} actions={actions} />
        {me.data ? children : <div className="subtle" aria-busy="true">Loading…</div>}
      </div>
    </Shell>
  );
}

/** A section panel: title, an optional muted line, then rows. */
export function Section({ title, sub, children, id, tone, action }: { title: string; sub?: ReactNode; children: ReactNode; id?: string; tone?: "danger"; action?: ReactNode }) {
  return (
    <section className={`panel acct-sec${tone === "danger" ? " danger" : ""}`} aria-labelledby={id ? `${id}-h` : undefined} id={id}>
      <div className="ph"><b id={id ? `${id}-h` : undefined}>{title}</b>{action}</div>
      {sub && <p className="acct-sub">{sub}</p>}
      <div className="acct-body">{children}</div>
    </section>
  );
}

/** One labelled row in a section: label and help on the left, the control on the right (stacked on phones). */
export function Row({ label, help, children, htmlFor }: { label: ReactNode; help?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="acct-row">
      <div className="acct-row-l">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="acct-label">{label}</span>}{help && <span className="hint">{help}</span>}</div>
      <div className="acct-row-r">{children}</div>
    </div>
  );
}
