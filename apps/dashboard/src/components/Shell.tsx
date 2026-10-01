import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Icon, Mark } from "./icons";

export interface Me {
  user: { id: string; email: string; name: string | null; email_verified: boolean; alert_emails: boolean };
  account?: { edition: string; plan: string; email_verification_required: boolean };
  projects: { id: string; name: string; role: string }[];
}
export const useMe = (enabled = true) => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me"), retry: false, enabled });

type Item = { label: string; to?: string; icon?: string; soon?: boolean; children?: Item[] };

/** RevenueCat's sidebar information architecture, in order. `soon` marks Tier 2/3 areas. */
const NAV: Item[] = [
  { label: "Overview", to: "overview", icon: "overview" },
  { label: "Analytics", icon: "analytics", children: [{ label: "Charts", to: "charts" }, { label: "Benchmarks", to: "benchmarks", soon: true }] },
  { label: "Customers", to: "customers", icon: "customers" },
  { label: "Product catalog", icon: "catalog", children: [
    { label: "Offerings", to: "product-catalog/offerings" }, { label: "Products", to: "product-catalog/products" },
    { label: "Entitlements", to: "product-catalog/entitlements" }, { label: "In-app currencies", to: "product-catalog/virtual-currencies" },
    { label: "Web discounts", to: "web-discounts", soon: true },
  ] },
  { label: "Paywalls", to: "paywalls", icon: "paywalls" },
  { label: "Targeting", to: "targeting", icon: "targeting" },
  { label: "Experiments", to: "experiments", icon: "experiments" },
  { label: "Funnels", to: "funnels", icon: "funnels", soon: true },
  { label: "Ads", icon: "ads", children: [{ label: "Overview", to: "ads", soon: true }, { label: "Rewards", to: "ads/rewards", soon: true }] },
  { label: "Lifecycle", icon: "lifecycle", children: [
    { label: "Customer Center", to: "lifecycle/customer-center" }, { label: "Support", to: "lifecycle/support" },
    { label: "Retention", to: "lifecycle/retention" }, { label: "Refund control", to: "lifecycle/refund-control" },
    { label: "Win-back", to: "lifecycle/winback" },
  ] },
];
const FOOT: Item[] = [
  { label: "Apps", to: "apps", icon: "apps" }, { label: "Web", to: "web", icon: "web", soon: true },
  { label: "API keys", to: "api-keys", icon: "key" }, { label: "Integrations", to: "integrations", icon: "integrations" },
  { label: "Project settings", to: "settings", icon: "settings" },
];

function NavItem({ item, base }: { item: Item; base: string }) {
  const loc = useLocation();
  const childActive = item.children?.some((c) => c.to && loc.pathname.startsWith(`${base}/${c.to}`));
  const [open, setOpen] = useState<boolean>(!!childActive || item.label === "Product catalog");
  useEffect(() => { if (childActive) setOpen(true); }, [childActive]);
  if (item.children) {
    return (
      <>
        <button className="it" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={item.icon!} />{item.label}<Icon name="chev" className="i chev" />
        </button>
        {open && <div className="sub">{item.children.map((c) => <NavItem key={c.label} item={c} base={base} />)}</div>}
      </>
    );
  }
  return (
    <NavLink to={`${base}/${item.to}`} className={({ isActive }) => `it${isActive ? " active" : ""}`} end={item.to === "overview"}>
      {item.icon && <Icon name={item.icon} />}{item.label}{item.soon && <span className="soon">SOON</span>}
    </NavLink>
  );
}

function ProjectSwitcher({ me, current }: { me: Me; current: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const p = me.projects.find((x) => x.id === current);
  return (
    <div ref={ref} style={{ flex: 1, minWidth: 0, position: "relative" }}>
      <button className="proj" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} style={{ width: "100%" }}>
        <span className="ic">{(p?.name ?? "?").slice(0, 1).toUpperCase()}</span><b>{p?.name ?? "Select a project"}</b><Icon name="updown" className="i" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {me.projects.map((x) => <button key={x.id} role="menuitem" type="button" onClick={() => { setOpen(false); nav(`/projects/${x.id}/overview`); }}>{x.name}</button>)}
          <hr />
          <button role="menuitem" type="button" onClick={() => { setOpen(false); nav("/projects/new"); }}><Icon name="plus" />New project</button>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); nav("/account"); }}><Icon name="settings" />Account settings</button>
          <button role="menuitem" type="button" onClick={async () => { await api("/auth/logout", { method: "POST" }); qc.clear(); nav("/login"); }}><Icon name="logout" />Sign out</button>
        </div>
      )}
    </div>
  );
}

/**
 * Breadcrumbs never run under the top-bar icons: the trail takes the space left of them, stays on one line, and the
 * project name and middle crumbs shrink to an ellipsis first; the current page shrinks a third as fast and keeps at least 3em.
 * Separators (the bare "/" spans pages pass in) never shrink.
 */
const CRUMB_CSS = `
.top .crumb{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap}
.top .top-r{flex:none}
.top .crumb>*{flex:0 3 auto;min-width:1.6em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.top .crumb>.crumb-project{min-width:2.5em}
.top .crumb>.crumb-sep,.top .crumb>span:not(.crumb-project){flex:none;min-width:0;overflow:visible}
.top .crumb>b:last-child{flex-shrink:1;min-width:3em}
`;

export function Shell({ title, crumbs, children, actions }: { title: string; crumbs?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const { projectId = "" } = useParams();
  const me = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const base = `/projects/${projectId}`;
  const [q, setQ] = useState("");
  // Below 900px the sidebar is a sheet opened from the top bar; it closes whenever the page changes.
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  const projectName = me.data?.projects.find((p) => p.id === projectId)?.name ?? "Project";
  useEffect(() => { document.title = `${title} · RevenueDot`; }, [title]);
  // Signed out: sign in, then come back to this exact page.
  useEffect(() => { if (me.isError) nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true }); }, [me.isError, nav, loc.pathname, loc.search]);
  const toggleTheme = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("rd-theme", root.dataset.theme); } catch { /* ignore */ }
  };
  return (
    <div className="shell">
      {menu && <button type="button" className="side-scrim" aria-label="Close menu" onClick={() => setMenu(false)} />}
      <aside className={`side${menu ? " open" : ""}`} aria-label="Sidebar" id="sidebar">
        <div className="brand">
          <Link to={`${base}/overview`} aria-label="RevenueDot home"><Mark /></Link>
          {me.data && <ProjectSwitcher me={me.data} current={projectId} />}
        </div>
        <nav className="nav" aria-label="Project">{NAV.map((i) => <NavItem key={i.label} item={i} base={base} />)}</nav>
        <div className="nav-foot">{FOOT.map((i) => <NavItem key={i.label} item={i} base={base} />)}</div>
      </aside>
      <div className="main">
        <header className="top">
          <style>{CRUMB_CSS}</style>
          <button type="button" className="ib menu-btn" aria-label="Menu" aria-controls="sidebar" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="menu" /></button>
          <nav className="crumb" aria-label="Breadcrumb">
            <span className="crumb-project" title={projectName}>{projectName}</span> <span className="crumb-sep">/</span> {crumbs ?? <b>{title}</b>}
          </nav>
          <div className="top-r">
            <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`${base}/customers?q=${encodeURIComponent(q.trim())}`); }}>
              <Icon name="search" /><input aria-label="Search customers" placeholder="Search customers, transactions, IDs" value={q} onChange={(e) => setQ(e.target.value)} /><kbd>⌘K</kbd>
            </form>
            <a className="ib" href="https://github.com/revenuedot/revenuedot#readme" target="_blank" rel="noreferrer" aria-label="Docs"><Icon name="docs" /></a>
            <button className="ib" type="button" aria-label="Toggle light and dark" onClick={toggleTheme}><Icon name="moon" /></button>
            {actions}
          </div>
        </header>
        {me.data?.account?.email_verification_required && <VerifyBanner email={me.data.user.email} />}
        <div className="scroll">{children}</div>
      </div>
    </div>
  );
}

/** RevenueDot Cloud: shown until the account's email is confirmed (secret API keys and invites wait for it). */
function VerifyBanner({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
  const send = async () => {
    setState("sending");
    try { await api("/auth/email/verify/resend", { method: "POST" }); setState("sent"); } catch (e) { setState(e instanceof Error ? e.message : "The email could not be sent."); }
  };
  return (
    <div className="verify-banner" role="status">
      <span>Confirm your email address. We sent a link to <b>{email}</b>; you need it to create secret API keys and invite people.</span>
      {state === "sent" ? <span className="subtle">Sent. Check your inbox.</span>
        : <button type="button" className="btn btn-line" disabled={state === "sending"} onClick={send}>{state === "sending" ? "Sending…" : "Send a new link"}</button>}
      {state !== "idle" && state !== "sending" && state !== "sent" && <span className="err" role="alert">{state}</span>}
    </div>
  );
}

export function Copy({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="copy">
      <span>{label ?? value}</span>
      <button type="button" aria-label={`Copy ${value}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); } catch { /* ignore */ } }}>
        <Icon name={done ? "check" : "copy"} className="i" />
      </button>
    </span>
  );
}
