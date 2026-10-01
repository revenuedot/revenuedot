/**
 * Paywalls: /projects/:projectId/paywalls. The list, and three ways to start (RevenueCat's flow, frames 11 and 12 of
 * company/docs/research/contact-sheets/revenuecat): a template from the gallery, an empty paywall, or "Generate with AI".
 * The gallery is Gallery.tsx, the editor Editor.tsx, the AI dialog AiDialog.tsx. Spec: prd/paywalls/PRD.md.
 */
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { blankPaywall } from "@revenuedot/core";
import { api, fmt } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { DataTable, Dialog, Field, PageHead, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, v2, type Offering } from "../catalog/lib";
import { AiDialog } from "./AiDialog";
import { packageIds, status, useAi, useOfferingsWithPackages, usePaywalls, useTemplates, type Paywall } from "./lib";

function Phones() {
  return (
    <svg width="120" height="92" viewBox="0 0 120 92" aria-hidden className="pw-phones">
      <g fill="var(--panel)" stroke="var(--fg-3)" strokeWidth="1.25">
        <rect x="18" y="16" width="34" height="66" transform="rotate(-12 35 49)" />
        <rect x="68" y="16" width="34" height="66" transform="rotate(12 85 49)" />
        <rect x="43" y="8" width="34" height="70" />
      </g>
      <path d="M55 70h10" stroke="var(--fg-3)" strokeWidth="1.25" />
      <rect x="57" y="20" width="6" height="6" fill="var(--accent)" />
    </svg>
  );
}

/** A primary button that opens a short menu under it. */
export function DropButton({ label, items, className = "btn btn-dark" }: { label: string; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", out); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}<Icon name="updown" /></button>
      {open && (
        <div className="menu" role="menu" aria-label={label} style={{ left: "auto", right: 0, width: 220 }}>
          {items.map((it) => <button key={it.label} type="button" role="menuitem" disabled={it.disabled} onClick={() => { setOpen(false); it.onSelect(); }}>{it.icon && <Icon name={it.icon} />}<span>{it.label}</span></button>)}
        </div>
      )}
    </span>
  );
}

/** Picks the offering for a new paywall (offerings that have none yet). */
export function OfferingField({ offerings, value, onChange, id = "pw-offering" }: { offerings: Offering[]; value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <Field label="Offering" htmlFor={id} hint="The paywall shows this offering's packages. Each offering has one paywall.">
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {offerings.map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.lookup_key}){o.is_current ? " · default" : ""}</option>)}
      </select>
    </Field>
  );
}

export function PaywallsPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const pws = usePaywalls(pid);
  const offs = useOfferingsWithPackages(pid);
  const ai = useAi(pid);
  const tpl = useTemplates(pid);
  const [scratch, setScratch] = useState(false);
  const aiOpen = sp.get("ai") === "1";
  const setAi = (v: boolean) => { const n = new URLSearchParams(sp); if (v) n.set("ai", "1"); else n.delete("ai"); setSp(n, { replace: true }); };
  const [offering, setOffering] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const free = (offs.data ?? []).filter((o) => !(pws.data ?? []).some((p) => p.offering_id === o.id));
  const chosen = free.find((o) => o.id === offering) ?? free[0];
  const createBlank = async () => {
    if (!chosen) return;
    setBusy(true); setErr(null);
    try {
      const doc = blankPaywall({ packages: packageIds(chosen), iconBaseUrl: tpl.data?.icon_base_url });
      const p = await api<Paywall>(`${v2(pid)}/paywalls`, { method: "POST", json: { offering_id: chosen.id, name: `${chosen.display_name} paywall`, ...doc } });
      toast("Paywall created"); nav(`/projects/${pid}/paywalls/${p.id}`);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const rows = (pws.data ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  const canAi = !!ai.data?.available;
  const starts = [
    { key: "template", icon: "layers", title: "Use a template", text: "Ten layouts built on 2026 conversion research. Pick one, then make it yours.", action: <Link className="btn btn-dark" to={`/projects/${pid}/paywalls/templates`}>Select template</Link> },
    { key: "scratch", icon: "plus", title: "Start from scratch", text: "A headline, your offering's packages and a purchase button, ready to build on.", action: <button type="button" className="btn btn-line" onClick={() => setScratch(true)}>Create paywall</button> },
    ...(canAi ? [{ key: "ai", icon: "spark", title: "Generate with AI", text: "Describe your app and the offer; get a paywall you can edit.", action: <button type="button" className="btn btn-line" onClick={() => setAi(true)}>Generate paywall</button> }] : []),
  ];
  return (
    <Shell title="Paywalls">
      <div className="page">
        <PageHead title="Paywalls" sub="Native paywalls your app shows with RevenueCatUI's PaywallView. Change them here without an app release."
          actions={rows.length ? <>
            {canAi && <button type="button" className="btn btn-line" onClick={() => setAi(true)}><Icon name="spark" />Generate with AI</button>}
            <DropButton label="New paywall" items={[
              { label: "From a template", icon: "layers", onSelect: () => nav(`/projects/${pid}/paywalls/templates`) },
              { label: "From scratch", icon: "plus", onSelect: () => setScratch(true) },
            ]} />
          </> : undefined} />
        {pws.isError ? <div className="banner err" role="alert">Paywalls could not be loaded: {errMsg(pws.error)}</div> : pws.isLoading ? <div className="panel pb subtle">Loading…</div> : !rows.length ? (
          <section className="panel pw-empty" aria-label="Start a paywall">
            <div className="pw-empty-h"><Phones /><h2>No paywalls yet</h2><p>A paywall is the screen that sells your offering. Apps that show PaywallView pick up what you publish here on their next launch.</p></div>
            <div className="pw-starts" style={{ gridTemplateColumns: `repeat(${starts.length}, minmax(0, 1fr))` }}>
              {starts.map((s) => (
                <div key={s.key} className="pw-start">
                  <span className="pw-start-i"><Icon name={s.icon} /></span>
                  <h3>{s.title}</h3><p>{s.text}</p>
                  <div>{s.action}</div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <DataTable rowKey={(p) => p.id} rows={rows} onRowClick={(p) => nav(`/projects/${pid}/paywalls/${p.id}`)} columns={[
            { key: "name", header: "Name", render: (p) => p.name ?? <span className="subtle">Untitled</span> },
            { key: "offering", header: "Offering", render: (p) => p.offering ? <code>{p.offering.lookup_key}</code> : <span className="subtle">None</span> },
            { key: "status", header: "Status", render: (p) => { const [t, tone] = status(p); return <Tag tone={tone}>{t}</Tag>; } },
            { key: "published", header: "Published", render: (p) => fmt.date(p.published_at) },
          ]} />
        )}
      </div>
      {scratch && (
        <Dialog title="New paywall" onClose={() => setScratch(false)} footer={<>
          <button type="button" className="btn btn-line" onClick={() => setScratch(false)}>Cancel</button>
          <button type="button" className="btn btn-dark" disabled={busy || !chosen} onClick={createBlank}>{busy ? "Creating…" : "Create"}</button>
        </>}>
          {!free.length ? <p className="muted" style={{ margin: 0 }}>Every offering already has a paywall. <Link className="ul" to={`/projects/${pid}/product-catalog/offerings`}>Create an offering</Link> first.</p>
            : <OfferingField offerings={free} value={chosen?.id ?? ""} onChange={setOffering} />}
          {err && <div className="banner err" role="alert">{err}</div>}
        </Dialog>
      )}
      {aiOpen && canAi && <AiDialog pid={pid} offerings={free} onClose={() => setAi(false)} />}
    </Shell>
  );
}
