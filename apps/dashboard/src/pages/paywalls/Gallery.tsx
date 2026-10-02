/**
 * The template gallery: /projects/:projectId/paywalls/templates (RevenueCat's "Select template", frame 12): filters on
 * the left (screens, purchase method, packages, tiers) and live previews rendered from the same components JSON the SDK
 * gets, with the chosen offering's packages. Choosing one creates the paywall on the server (`template_id`) and opens
 * the editor. Templates: packages/core/src/paywalls/gallery.ts.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PAYWALL_TEMPLATES, type GalleryTemplate } from "@revenuedot/core";
import { api } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { Dialog, Field, Tag, useProjectId, useToast } from "../../components/ui";
import { useMe } from "../../components/Shell";
import { errMsg, v2 } from "../catalog/lib";
import { Phone } from "./render";
import { OfferingField } from "./Paywalls";
import { packageIds, useOfferingsWithPackages, usePaywalls, usePreviewProducts, useTemplates, type Paywall } from "./lib";

const PACKAGES = [["any", "Any"], ["1", "1"], ["2", "2"], ["3", "3 or more"]] as const;
const TIERS = [["any", "Any"], ["1", "1"], ["2", "2 or more"]] as const;

export function GalleryPage() {
  const pid = useProjectId();
  const nav = useNavigate();
  const toast = useToast();
  const me = useMe();
  const [sp, setSp] = useSearchParams();
  const offs = useOfferingsWithPackages(pid);
  const pws = usePaywalls(pid);
  const meta = useTemplates(pid);
  const projectName = me.data?.projects.find((p) => p.id === pid)?.name ?? "";
  // Filters live in state (so checkboxes update at once) and are mirrored into the URL, so a filtered gallery is a link.
  const DEF: Record<string, string> = { screens: "single,multiple", method: "in_app,web", packages: "any", tiers: "any", offering: "" };
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(Object.keys(DEF).map((k) => [k, sp.get(k) ?? DEF[k]!])));
  const set = (k: string, v: string | null) => {
    const next = { ...f, [k]: v ?? DEF[k]! };
    setF(next);
    const n = new URLSearchParams();
    for (const [key, val] of Object.entries(next)) if (val !== DEF[key]) n.set(key, val);
    setSp(n, { replace: true });
  };
  const screens = f.screens!.split(",").filter(Boolean);
  const method = f.method!.split(",").filter(Boolean);
  const pk = f.packages!, tiers = f.tiers!;
  const toggle = (k: "screens" | "method", list: string[], v: string) => set(k, list.includes(v) ? list.filter((x) => x !== v).join(",") : [...list, v].join(","));
  const free = (offs.data ?? []).filter((o) => !(pws.data ?? []).some((p) => p.offering_id === o.id));
  const previewOff = (offs.data ?? []).find((o) => o.id === f.offering) ?? free.find((o) => o.is_current) ?? free[0] ?? offs.data?.[0];
  const packages = packageIds(previewOff);
  const preview = usePreviewProducts(pid, previewOff);
  const shown = PAYWALL_TEMPLATES.filter((t) =>
    screens.includes(t.screens > 1 ? "multiple" : "single") && method.includes(t.purchase_method)
    && (pk === "any" || (pk === "3" ? t.packages >= 3 : t.packages === Number(pk))) && (tiers === "any" || (tiers === "2" ? t.tiers >= 2 : t.tiers === 1)));
  const docs = useMemo(() => new Map(PAYWALL_TEMPLATES.map((t) => [t.id, t.build({ packages: packages.length ? packages : undefined, appName: projectName || undefined, iconBaseUrl: meta.data?.icon_base_url })])),
    [JSON.stringify(packages), projectName, meta.data?.icon_base_url]); // eslint-disable-line react-hooks/exhaustive-deps

  const [pick, setPick] = useState<GalleryTemplate | null>(null);
  const [form, setForm] = useState({ offering: "", app: "", accent: "", terms: "", privacy: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    if (!pick) return;
    const off = free.find((o) => o.id === form.offering) ?? (previewOff && free.includes(previewOff) ? previewOff : free[0]);
    setBusy(true); setErr(null);
    try {
      const opts: Record<string, string> = {};
      if (form.app.trim()) opts.app_name = form.app.trim();
      if (form.accent) opts.accent_color = form.accent;
      if (form.terms.trim()) opts.terms_url = form.terms.trim();
      if (form.privacy.trim()) opts.privacy_url = form.privacy.trim();
      const p = await api<Paywall>(`${v2(pid)}/paywalls`, { method: "POST", json: { template_id: pick.id, ...(off ? { offering_id: off.id } : {}), name: `${pick.name}${off ? ` · ${off.display_name}` : ""}`, template_options: opts } });
      toast(`Created from “${pick.name}”`); nav(`/projects/${pid}/paywalls/${p.id}`);
    } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const open = (t: GalleryTemplate) => { setPick(t); setErr(null); setForm({ offering: (previewOff && free.includes(previewOff) ? previewOff.id : free[0]?.id) ?? "", app: projectName, accent: "", terms: "", privacy: "" }); };

  return (
    <Shell title="Templates" crumbs={<><Link className="cat-crumb-up" to={`/projects/${pid}/paywalls`}>Paywalls</Link> <span className="cat-crumb-up">/</span> <b className="cat-crumb">Select template</b></>}>
      <div className="pw-gallery">
        <aside className="pw-filters" aria-label="Filters">
          <fieldset><legend className="label">Number of screens</legend>
            <label className="check"><input type="checkbox" checked={screens.includes("single")} onChange={() => toggle("screens", screens, "single")} />Single screen</label>
            <label className="check"><input type="checkbox" checked={screens.includes("multiple")} onChange={() => toggle("screens", screens, "multiple")} />Multiple screens</label>
          </fieldset>
          <fieldset><legend className="label">Purchase method</legend>
            <label className="check"><input type="checkbox" checked={method.includes("in_app")} onChange={() => toggle("method", method, "in_app")} />In-app purchase</label>
            <label className="check"><input type="checkbox" checked={method.includes("web")} onChange={() => toggle("method", method, "web")} />Web purchase</label>
          </fieldset>
          <Field label="Number of packages" htmlFor="f-pk"><select id="f-pk" className="select" value={pk} onChange={(e) => set("packages", e.target.value === "any" ? null : e.target.value)}>{PACKAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Number of tiers" htmlFor="f-tiers"><select id="f-tiers" className="select" value={tiers} onChange={(e) => set("tiers", e.target.value === "any" ? null : e.target.value)}>{TIERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          {(offs.data?.length ?? 0) > 0 && (
            <Field label="Preview with offering" htmlFor="f-off" hint="Previews use its packages.">
              <select id="f-off" className="select" value={previewOff?.id ?? ""} onChange={(e) => set("offering", e.target.value)}>{offs.data!.map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}</select>
            </Field>
          )}
          <p className="subtle pw-count" aria-live="polite">{shown.length} of {PAYWALL_TEMPLATES.length} templates</p>
        </aside>
        <div className="pw-grid-wrap">
          <div className="head"><div><h1>Select template</h1><p>Each layout comes from a measured 2026 result. {preview.ready && preview.anyReal ? "Prices are your products' Test Store prices, with sample values where a product has none" : "Prices show as sample values here"}; the app shows the store's local prices.</p></div></div>
          {!shown.length ? <div className="empty"><b>No template matches these filters.</b><button type="button" className="btn btn-line" onClick={() => { setF({ ...DEF }); setSp(new URLSearchParams(), { replace: true }); }}>Clear filters</button></div> : (
            <ul className="pw-cards" aria-label="Templates">
              {shown.map((t) => (
                <li key={t.id} className="pw-card">
                  <button type="button" className="pw-card-prev" aria-label={`Use template ${t.name}`} onClick={() => open(t)}>
                    <Phone doc={docs.get(t.id)!} width={172} live={false} label={`${t.name} preview`} prices={preview.prices} />
                    <span className="pw-card-cta">Use template</span>
                  </button>
                  <div className="pw-card-b">
                    <div className="pw-card-t"><b>{t.name}</b>{t.screens > 1 && <Tag>{t.screens} pages</Tag>}{t.purchase_method === "web" && <Tag tone="info">Web</Tag>}{t.tiers > 1 && <Tag tone="gold">{t.tiers} tiers</Tag>}</div>
                    <p>{t.description}</p>
                    <p className="pw-card-ev" title={t.evidence}>{t.evidence}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {pick && (
        <Dialog title={`Use “${pick.name}”`} onClose={() => setPick(null)} footer={<>
          <button type="button" className="btn btn-line" onClick={() => setPick(null)}>Cancel</button>
          <button type="button" className="btn btn-dark" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create paywall"}</button>
        </>}>
          {free.length ? <OfferingField offerings={free} value={form.offering} onChange={(v) => setForm({ ...form, offering: v })} />
            : <p className="muted" style={{ margin: 0 }}>Every offering already has a paywall, so this one starts without an offering. Attach one before publishing.</p>}
          <Field label="App name" htmlFor="t-app"><input id="t-app" className="input" value={form.app} onChange={(e) => setForm({ ...form, app: e.target.value })} /></Field>
          <Field label="Accent colour" htmlFor="t-accent" hint="Leave as is to keep the template's colour.">
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}><input id="t-accent" type="color" value={form.accent || "#111111"} onChange={(e) => setForm({ ...form, accent: e.target.value })} />{form.accent && <button type="button" className="linkbtn" onClick={() => setForm({ ...form, accent: "" })}>Reset</button>}</span>
          </Field>
          <div className="two">
            <Field label="Terms URL" htmlFor="t-terms" hint="Apple requires links to both."><input id="t-terms" className="input" type="url" placeholder="https://" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} /></Field>
            <Field label="Privacy URL" htmlFor="t-privacy"><input id="t-privacy" className="input" type="url" placeholder="https://" value={form.privacy} onChange={(e) => setForm({ ...form, privacy: e.target.value })} /></Field>
          </div>
          {err && <div className="banner err" role="alert">{err}</div>}
        </Dialog>
      )}
    </Shell>
  );
}
