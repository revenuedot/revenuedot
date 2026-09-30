/**
 * New offering (/product-catalog/offerings/new) and edit offering (/offerings/:offeringId/edit).
 * Mirrors RevenueCat's form: Identifier (immutable) and Display name, then Packages / Metadata / Paywall tabs, package cards
 * with a reserved-identifier select, a description and one product select per app with an inline "New product", and a
 * Save bar pinned to the bottom. Saving calls the v2 API step by step and records each step, so a retry after a failure
 * never creates anything twice.
 *
 * GAPS versus RevenueCat's dashboard (later tiers):
 * - Paywall tab: paywalls are Tier 2, so the tab is disabled.
 * - Google Play eligibility (a legacy product for SDK < 6 next to a new one for SDK >= 6) is kept but not editable here;
 *   set it through the API (`attach_products` with `eligibility_criteria`). Such apps show the attached products read-only.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, EmptyState, Field, Tabs, useProjectId, useToast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { AppName, CatalogCrumbs, LoadError, LoadingRows, NewProductDialog } from "./parts";
import {
  PACKAGE_TYPES, catalogKey, count, customPackageError, errMsg, isConflict, lookupKeyError, productName, useApps, useProducts, useRefreshCatalog, v2,
  type App, type Offering, type Package, type PackageProduct, type Product,
} from "./lib";

interface Draft {
  uid: string;
  id?: string;
  /** A reserved `$rc_` key, "custom", or "" before one is chosen. */
  ident: string;
  custom: string;
  description: string;
  /** app id -> product id ("" = no product). */
  products: Record<string, string>;
  /** Apps with several products in this package (Google SDK eligibility). Left untouched. */
  locked: Record<string, PackageProduct[]>;
  /** What the server has, once the package exists. */
  orig?: { description: string; position: number; products: Record<string, string> };
}
type PkgErr = { ident?: string; description?: string };
type Tab = "packages" | "metadata" | "paywall";

let uidSeq = 0;
const uid = () => `d${++uidSeq}`;
const keyOf = (d: Draft) => (d.ident === "custom" ? d.custom.trim() : d.ident);

function draftFrom(p: Package): Draft {
  const byApp = new Map<string, PackageProduct[]>();
  for (const x of p.products?.items ?? []) byApp.set(x.product.app_id, [...(byApp.get(x.product.app_id) ?? []), x]);
  const products: Record<string, string> = {};
  const locked: Record<string, PackageProduct[]> = {};
  for (const [app, list] of byApp) { if (list.length === 1) products[app] = list[0]!.product.id; else locked[app] = list; }
  const preset = PACKAGE_TYPES.some((t) => t.key === p.lookup_key);
  return { uid: uid(), id: p.id, ident: preset ? p.lookup_key : "custom", custom: preset ? "" : p.lookup_key, description: p.display_name, products, locked, orig: { description: p.display_name, position: p.position, products: { ...products } } };
}

/** Metadata text -> object. Empty means no metadata. */
export function parseMetadata(text: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!text.trim()) return { value: null, error: null };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { value: null, error: "Metadata must be a JSON object, for example {\"color\": \"gold\"}." };
    return { value: v as Record<string, unknown>, error: null };
  } catch (e) { return { value: null, error: `Invalid JSON: ${(e as Error).message}` }; }
}
export const metadataText = (m: Record<string, unknown> | null | undefined) => (m && Object.keys(m).length ? JSON.stringify(m, null, 2) : "");

/** JSON editor for offering metadata, with Format and live validation. */
export function MetadataEditor({ id, value, onChange, error }: { id: string; value: string; onChange: (v: string) => void; error?: string | null }) {
  const parsed = parseMetadata(value);
  const shown = error ?? parsed.error;
  return (
    <div className="field">
      <div className="cat-jsonbar">
        <label htmlFor={id}>Metadata (JSON)</label>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="cat-note" aria-live="polite">{shown ? null : value.trim() ? <span className="up">Valid JSON object</span> : "No metadata"}</span>
          <button type="button" className="btn btn-line" disabled={!!parsed.error || !value.trim()} onClick={() => onChange(JSON.stringify(parsed.value, null, 2))}>Format</button>
        </span>
      </div>
      <textarea id={id} className={`textarea cat-json${shown ? " cat-bad" : ""}`} spellCheck={false} placeholder={'{\n  "paywall_title": "Go Pro",\n  "highlight_package": "$rc_annual"\n}'}
        value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!shown} aria-describedby={`${id}-help`} />
      <span className="hint" id={`${id}-help`}>Free-form data your app reads from the offering, e.g. paywall copy or which package to highlight. The SDK exposes it as <code>offering.metadata</code>.</span>
      {shown && <span className="err" role="alert">{shown}</span>}
    </div>
  );
}

export function OfferingEditor() {
  const pid = useProjectId();
  const { offeringId: routeId } = useParams();
  const editing = !!routeId;
  const existing = useQuery({
    queryKey: [...catalogKey(pid), "offering", routeId],
    queryFn: () => api<Offering>(`${v2(pid)}/offerings/${routeId}?expand=package.product`),
    enabled: editing, staleTime: 0,
  });
  const apps = useApps(pid);
  const products = useProducts(pid);
  const base = `/projects/${pid}/product-catalog/offerings`;
  const title = editing ? (existing.data ? `Edit ${existing.data.lookup_key}` : "Edit offering") : "New offering";
  const crumbs = <CatalogCrumbs pid={pid} section="Offerings" sectionTo="offerings" current={editing ? existing.data?.lookup_key ?? "…" : "New offering"} />;
  const failed = existing.isError ? existing : apps.isError ? apps : products.isError ? products : null;
  const loading = (editing && existing.isLoading) || apps.isLoading || products.isLoading;
  return (
    <Shell title={title} crumbs={crumbs}>
      {failed ? <div className="page cat-detail"><LoadError error={failed.error} retry={() => failed.refetch()} /></div>
        : loading ? <div className="page cat-detail"><LoadingRows label="Loading offering" rows={4} /></div>
        : <EditorForm key={routeId ?? "new"} pid={pid} base={base} initial={editing ? existing.data! : null} apps={apps.data!} products={products.data!} title={title} />}
    </Shell>
  );
}

function EditorForm({ pid, base, initial, apps, products, title }: { pid: string; base: string; initial: Offering | null; apps: App[]; products: Product[]; title: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefreshCatalog(pid);
  const [offeringId, setOfferingId] = useState<string | null>(initial?.id ?? null);
  const [key, setKey] = useState(initial?.lookup_key ?? "");
  const [name, setName] = useState(initial?.display_name ?? "");
  const [meta, setMeta] = useState(metadataText(initial?.metadata));
  const [head, setHead] = useState({ name: initial?.display_name ?? "", meta: metadataText(initial?.metadata) });
  const [drafts, setDrafts] = useState<Draft[]>(() => [...(initial?.packages?.items ?? [])].sort((a, b) => a.position - b.position).map(draftFrom));
  const [removed, setRemoved] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("packages");
  const [errors, setErrors] = useState<{ key?: string; name?: string; meta?: string; pkgs: Record<string, PkgErr> }>({ pkgs: {} });
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newProductFor, setNewProductFor] = useState<{ uid: string; app: string } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const snapshot = (s: { key: string; name: string; meta: string; drafts: Draft[]; removed: string[] }) =>
    JSON.stringify([s.key, s.name, s.meta, s.removed, s.drafts.map((d) => [d.id, keyOf(d), d.description, d.products])]);
  const [clean, setClean] = useState(() => snapshot({ key, name, meta, drafts, removed }));
  const dirty = snapshot({ key, name, meta, drafts, removed }) !== clean;
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const byApp = useMemo(() => {
    const m = new Map<string, Product[]>();
    for (const p of [...products].sort((a, b) => a.created_at - b.created_at)) m.set(p.app_id, [...(m.get(p.app_id) ?? []), p]);
    return m;
  }, [products]);

  const update = (u: string, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.uid === u ? { ...d, ...patch } : d)));
  const clearPkgErr = (u: string, k: keyof PkgErr) => setErrors((e) => ({ ...e, pkgs: { ...e.pkgs, [u]: { ...e.pkgs[u], [k]: undefined } } }));
  const addPackage = () => { setDrafts((ds) => [...ds, { uid: uid(), ident: "", custom: "", description: "", products: {}, locked: {} }]); setTab("packages"); };
  const removePackage = (d: Draft) => { setDrafts((ds) => ds.filter((x) => x.uid !== d.uid)); if (d.id) setRemoved((r) => [...r, d.id!]); };
  const move = (u: string, to: number) => setDrafts((ds) => {
    const i = ds.findIndex((d) => d.uid === u);
    if (i < 0 || to < 0 || to >= ds.length || to === i) return ds;
    const out = [...ds]; const [x] = out.splice(i, 1); out.splice(to, 0, x!); return out;
  });

  function validate(): boolean {
    const e: typeof errors = { pkgs: {} };
    if (!offeringId) { const ke = lookupKeyError(key.trim(), "offering"); if (ke) e.key = ke; }
    if (!name.trim()) e.name = "Enter a display name.";
    const pm = parseMetadata(meta);
    if (pm.error) e.meta = pm.error;
    const seen = new Map<string, string>();
    for (const d of drafts) {
      const pe: PkgErr = {};
      if (!d.ident) pe.ident = "Choose an identifier.";
      else if (d.ident === "custom" && !d.id) { const ce = customPackageError(d.custom.trim()); if (ce) pe.ident = ce; }
      const k = keyOf(d);
      if (k && seen.has(k)) pe.ident = "Another package in this offering already uses this identifier.";
      if (k) seen.set(k, d.uid);
      if (!d.description.trim()) pe.description = "Enter a description.";
      if (pe.ident || pe.description) e.pkgs[d.uid] = pe;
    }
    setErrors(e);
    const ok = !e.key && !e.name && !e.meta && !Object.keys(e.pkgs).length;
    if (!ok) {
      if (e.key || e.name) firstInput.current?.focus();
      else if (e.meta && !Object.keys(e.pkgs).length) setTab("metadata");
      else setTab("packages");
      setFormErr("Fix the highlighted fields, then save again.");
    }
    return ok;
  }

  async function save() {
    setFormErr(null);
    if (!validate()) return;
    setSaving(true);
    const work = drafts.map((d) => ({ ...d, products: { ...d.products }, orig: d.orig ? { ...d.orig, products: { ...d.orig.products } } : undefined }));
    let off = offeringId;
    let gone = [...removed];
    const metaValue = parseMetadata(meta).value;
    try {
      if (!off) {
        try {
          const o = await api<Offering>(`${v2(pid)}/offerings`, { method: "POST", json: { lookup_key: key.trim(), display_name: name.trim(), metadata: metaValue } });
          off = o.id; setOfferingId(o.id); setHead({ name, meta });
        } catch (e) {
          if (isConflict(e)) { setErrors((x) => ({ ...x, key: "An offering with this identifier already exists. Identifiers are unique per project." })); firstInput.current?.focus(); throw new Error("An offering with this identifier already exists."); }
          throw e;
        }
      } else if (name !== head.name || meta !== head.meta) {
        await api(`${v2(pid)}/offerings/${off}`, { method: "POST", json: { display_name: name.trim(), metadata: metaValue } });
        setHead({ name, meta });
      }
      for (const id of [...gone]) {
        await api(`${v2(pid)}/packages/${id}`, { method: "DELETE" });
        gone = gone.filter((x) => x !== id);
      }
      for (const [i, d] of work.entries()) {
        const desc = d.description.trim();
        if (!d.id) {
          try {
            const p = await api<Package>(`${v2(pid)}/offerings/${off}/packages`, { method: "POST", json: { lookup_key: keyOf(d), display_name: desc, position: i } });
            d.id = p.id; d.orig = { description: desc, position: i, products: {} };
          } catch (e) {
            if (isConflict(e)) { setErrors((x) => ({ ...x, pkgs: { ...x.pkgs, [d.uid]: { ident: "This offering already has a package with this identifier." } } })); setTab("packages"); }
            throw e;
          }
        } else if (d.orig!.description !== desc || d.orig!.position !== i) {
          await api(`${v2(pid)}/packages/${d.id}`, { method: "POST", json: { display_name: desc, position: i } });
          d.orig = { ...d.orig!, description: desc, position: i };
        }
        const detach: string[] = []; const attach: string[] = [];
        for (const a of apps) {
          const want = d.products[a.id] ?? "", had = d.orig!.products[a.id] ?? "";
          if (want !== had) { if (had) detach.push(had); if (want) attach.push(want); }
        }
        if (detach.length) await api(`${v2(pid)}/packages/${d.id}/actions/detach_products`, { method: "POST", json: { product_ids: detach } });
        if (attach.length) await api(`${v2(pid)}/packages/${d.id}/actions/attach_products`, { method: "POST", json: { products: attach.map((product_id) => ({ product_id, eligibility_criteria: "all" })) } });
        d.orig = { ...d.orig!, products: { ...d.products } };
      }
      await refresh();
      setClean(snapshot({ key, name, meta, drafts: work, removed: [] }));
      toast(initial ? "Offering saved" : `Offering ${key.trim()} created`);
      nav(`${base}/${off}`);
    } catch (e) {
      setFormErr(`Not saved: ${errMsg(e)}${off && !initial ? " The offering exists now; saving again finishes the rest." : ""}`);
      if (off) void refresh();
    } finally {
      setDrafts(work); setRemoved(gone); setSaving(false);
    }
  }

  const onDrop = (e: DragEvent, target: string) => {
    e.preventDefault();
    if (drag) move(drag.from, drafts.findIndex((d) => d.uid === target));
    setDrag(null);
  };
  const cancel = () => (dirty ? setConfirmLeave(true) : nav(initial ? `${base}/${initial.id}` : base));
  const summary = `${count(drafts.length, "package")} · ${count(drafts.reduce((n, d) => n + Object.values(d.products).filter(Boolean).length, 0), "product")}`;

  return (
    <div className="cat-editor">
      <div className="page cat-detail">
        <div className="cat-titlerow"><h1>{title}</h1></div>
        <form style={{ display: "flex", flexDirection: "column", gap: 16 }} onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate id="offering-form">
          <Field label="Identifier" htmlFor="of-key" error={errors.key} hint={offeringId ? "Identifiers cannot be changed. Duplicate the offering to use a new one." : "Used to access the offering via the SDK. It cannot be changed later."}>
            <input id="of-key" ref={initial ? undefined : firstInput} className="input mono" autoFocus={!initial} spellCheck={false} autoComplete="off" placeholder="e.g. default or sale" value={key} disabled={!!offeringId}
              onChange={(e) => { setKey(e.target.value); setErrors((x) => ({ ...x, key: undefined })); }} aria-invalid={!!errors.key} />
          </Field>
          <Field label="Display name" htmlFor="of-name" error={errors.name} hint="A name for this offering. The SDK exposes it as the offering's description.">
            <input id="of-name" ref={initial ? firstInput : undefined} className="input" placeholder="e.g. The standard set of packages" value={name}
              onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: undefined })); }} aria-invalid={!!errors.name} />
          </Field>
        </form>

        <Tabs label="Offering sections" idBase="of" value={tab} onChange={setTab}
          tabs={[{ value: "packages", label: "Packages" }, { value: "metadata", label: "Metadata" }, { value: "paywall", label: "Paywall", disabled: true, badge: "SOON" }]}
          right={tab === "packages" ? <button type="button" className="btn btn-ghost" onClick={addPackage} aria-label="New package"><Icon name="plus" /><span className="cat-hide-sm">New package</span></button> : undefined} />

        {tab === "packages" && (
          <div role="tabpanel" id="of-packages-panel" aria-labelledby="of-packages" className="cat-pkgs">
            <p className="cat-lead">A package is a set of equivalent products across your apps, such as the monthly plan on iOS and on Android. Choose one product per app; the SDK only shows an app the packages that have a product for it.</p>
            {!drafts.length ? (
              <EmptyState title="No packages" text="Add a package for each plan you sell, such as Monthly and Annual." action={<button type="button" className="btn btn-dark" onClick={addPackage}><Icon name="plus" />Add package</button>} />
            ) : drafts.map((d, i) => {
              const pe = errors.pkgs[d.uid] ?? {};
              const idBase = `pk-${d.uid}`;
              return (
                <section key={d.uid} className={`cat-pkg${drag?.from === d.uid ? " cat-drag" : ""}${drag?.over === d.uid && drag.from !== d.uid ? " cat-over" : ""}`} aria-label={`Package ${i + 1}`}
                  onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== d.uid) setDrag({ ...drag, over: d.uid }); } }} onDrop={(e) => onDrop(e, d.uid)}>
                  <div className="cat-pkg-h">
                    <button type="button" className="cat-grip" draggable aria-label={`Reorder package ${i + 1}. Use the up and down arrow keys.`} title="Drag to reorder"
                      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", d.uid); const card = e.currentTarget.closest(".cat-pkg"); if (card) e.dataTransfer.setDragImage(card, 16, 16); setDrag({ from: d.uid, over: null }); }}
                      onDragEnd={() => setDrag(null)}
                      onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(d.uid, i + (e.key === "ArrowUp" ? -1 : 1)); requestAnimationFrame(() => (document.querySelector(`[data-grip="${d.uid}"]`) as HTMLElement | null)?.focus()); } }}
                      data-grip={d.uid}><Icon name="grip" /></button>
                    <div className="cat-pkg-fields">
                      <Field label="Identifier *" htmlFor={`${idBase}-id`} error={pe.ident} hint={d.id ? "Package identifiers cannot be changed." : d.ident && d.ident !== "custom" ? <code>{d.ident}</code> : undefined}>
                        <select id={`${idBase}-id`} className="select" value={d.ident} disabled={!!d.id} aria-invalid={!!pe.ident}
                          onChange={(e) => {
                            const v = e.target.value; const label = PACKAGE_TYPES.find((t) => t.key === v)?.label;
                            update(d.uid, { ident: v, ...(label && !d.description.trim() ? { description: label } : {}) }); clearPkgErr(d.uid, "ident");
                          }}>
                          <option value="" disabled>Select an option</option>
                          {PACKAGE_TYPES.map((t) => <option key={t.key} value={t.key} disabled={drafts.some((x) => x.uid !== d.uid && keyOf(x) === t.key)}>{t.label}</option>)}
                          <option value="custom">Custom</option>
                        </select>
                        {d.ident === "custom" && <input className="input mono" aria-label="Custom package identifier" placeholder="e.g. annual_intro" value={d.custom} disabled={!!d.id} style={{ marginTop: 6 }}
                          onChange={(e) => { update(d.uid, { custom: e.target.value }); clearPkgErr(d.uid, "ident"); }} />}
                      </Field>
                      <Field label="Description *" htmlFor={`${idBase}-desc`} error={pe.description}>
                        <input id={`${idBase}-desc`} className="input" placeholder="Package description" value={d.description} aria-invalid={!!pe.description}
                          onChange={(e) => { update(d.uid, { description: e.target.value }); clearPkgErr(d.uid, "description"); }} />
                      </Field>
                    </div>
                    <button type="button" className="ib" aria-label={`Remove package ${keyOf(d) || i + 1}`} title="Remove package" onClick={() => removePackage(d)}><Icon name="trash" /></button>
                  </div>
                  <div className="cat-pkg-prods">
                    <div className="cat-lab"><span>Products</span><span>One per app</span></div>
                    {!apps.length ? (
                      <div className="cat-prow"><span className="cat-none">No apps yet. <Link className="cat-lnk" to={`/projects/${pid}/apps`}>Add an app</Link> to attach products.</span></div>
                    ) : apps.map((a) => {
                      const list = byApp.get(a.id) ?? [];
                      const locked = d.locked[a.id];
                      return (
                        <div className="cat-prow" key={a.id}>
                          <AppName app={a} />
                          {locked ? (
                            <span className="cat-none">{locked.map((x) => `${productName(x.product)} (${x.eligibility_criteria})`).join(", ")}. Set through the API.</span>
                          ) : (
                            <span className="cat-pick">
                              {list.length > 0 && (
                                <select className="select" aria-label={`Product for ${a.name}`} value={d.products[a.id] ?? ""} onChange={(e) => update(d.uid, { products: { ...d.products, [a.id]: e.target.value } })}>
                                  <option value="">No product</option>
                                  {list.map((p) => <option key={p.id} value={p.id}>{p.display_name && p.display_name !== p.store_identifier ? `${p.display_name} · ${p.store_identifier}` : p.store_identifier}{p.state === "inactive" ? " (inactive)" : ""}</option>)}
                                </select>
                              )}
                              <button type="button" className="btn btn-ghost" onClick={() => setNewProductFor({ uid: d.uid, app: a.id })}><Icon name="plus" />New product</button>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
        {tab === "metadata" && (
          <div role="tabpanel" id="of-metadata-panel" aria-labelledby="of-metadata">
            <MetadataEditor id="of-meta" value={meta} onChange={(v) => { setMeta(v); setErrors((x) => ({ ...x, meta: undefined })); }} error={errors.meta} />
          </div>
        )}
      </div>

      <div className="cat-savebar">
        <div className="cat-in">
          <span className={`cat-msg${formErr ? " cat-err" : ""}`} role={formErr ? "alert" : "status"}>{formErr ?? (dirty ? `Unsaved changes · ${summary}` : summary)}</span>
          <button type="button" className="btn btn-line" onClick={cancel} disabled={saving}>Cancel</button>
          <button type="submit" form="offering-form" className="btn btn-dark" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>

      {newProductFor && (
        <NewProductDialog pid={pid} apps={apps} appId={newProductFor.app} onClose={() => setNewProductFor(null)}
          onCreated={(p) => setDrafts((ds) => ds.map((x) => (x.uid === newProductFor.uid ? { ...x, products: { ...x.products, [p.app_id]: p.id } } : x)))} />
      )}
      {confirmLeave && (
        <ConfirmDialog title="Discard changes?" confirmLabel="Discard changes" danger onClose={() => setConfirmLeave(false)} onConfirm={() => nav(initial ? `${base}/${initial.id}` : offeringId ? `${base}/${offeringId}` : base)}>
          <p>Your changes to this offering are not saved.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
