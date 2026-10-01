/**
 * The visual paywall editor: /projects/:projectId/paywalls/:paywallId (prd/paywalls/PRD.md §2).
 * Left: the component tree (add, remove, duplicate, reorder by drag or keys, nest and un-nest). Middle: the phone preview
 * of the exact JSON (light/dark, locale, selected package, intro offer); clicking a component selects it. Right: the
 * properties of the selection. Tabs switch to the localizations table and the raw JSON. Undo and redo cover every change;
 * Save draft keeps it, Publish validates on the server first; versions can be saved and restored.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as RKeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ADDABLE_TYPES, PAYWALL_LOCALES, TYPE_LABEL, applyOp, childGroups, componentLabel, locate, newComponent, roots, validatePaywall,
  type AddableType, type Json, type Op, type PaywallDoc, type PaywallIssue,
} from "@revenuedot/core";
import { api, type List } from "../../lib/api";
import { Shell } from "../../components/Shell";
import { ConfirmDialog, Dialog, Field, Menu, Switch, Tabs, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { errMsg, v2 } from "../catalog/lib";
import { Phone, stringsFor } from "./render";
import { Props, type PropsApi } from "./Props";
import { AiDialog } from "./AiDialog";
import { DropButton } from "./Paywalls";
import { docOf, packageIds, status, useAi, useOfferingsWithPackages, useTemplates, type Paywall } from "./lib";

type View = "design" | "localizations" | "json";
interface History { past: PaywallDoc[]; future: PaywallDoc[]; mergeKey: string | null; mergeAt: number }
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export function PaywallEditor() {
  const pid = useProjectId();
  const { paywallId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const pw = useQuery({ queryKey: ["paywall", pid, paywallId], queryFn: () => api<Paywall>(`${v2(pid)}/paywalls/${paywallId}?expand=components&expand=offering`), enabled: !!paywallId });
  const offs = useOfferingsWithPackages(pid);
  const tpl = useTemplates(pid);
  const ai = useAi(pid);
  const [doc, setDoc] = useState<PaywallDoc | null>(null);
  const [name, setName] = useState("");
  const [rev, setRev] = useState(0);
  const [dirty, setDirty] = useState(false);
  const hist = useRef<History>({ past: [], future: [], mergeKey: null, mergeAt: 0 });
  const [, force] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<View>("design");
  const [locale, setLocale] = useState("en_US");
  const [dark, setDark] = useState(false);
  const [intro, setIntro] = useState(true);
  const [pkgPreview, setPkgPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "unpublish" | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  // The phone fits the window's height (390 × 844 points scaled), between 260 and 360 pixels wide.
  const [vh, setVh] = useState(() => window.innerHeight);
  useEffect(() => { const r = () => setVh(window.innerHeight); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  const phoneW = Math.round(Math.max(260, Math.min(360, ((vh - 270) * 390) / 844)));

  // Load once; later refetches (after save) do not overwrite local edits.
  useEffect(() => {
    if (!pw.data || doc) return;
    const d = docOf(pw.data);
    if (d) { setDoc(d); setLocale(d.default_locale); setSel(d.components_config.base.stack?.id ?? null); }
    setName(pw.data.name ?? ""); setRev(pw.data.revision);
  }, [pw.data, doc]);

  const offering = offs.data?.find((o) => o.id === pw.data?.offering_id) ?? null;
  const packages = packageIds(offering);
  const iconBase = tpl.data?.icon_base_url ?? `${location.origin}/assets/icons`;
  const validation = useMemo(() => (doc ? validatePaywall(doc, { packages: packages.length ? packages.map((p) => p.id) : undefined }) : null), [doc, JSON.stringify(packages)]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One undo step; `merge` coalesces quick successive edits of the same field (typing). */
  const commit = useCallback((next: PaywallDoc, merge?: string, select?: string | null) => {
    setDoc((cur) => {
      if (!cur) return next;
      const h = hist.current;
      const now = Date.now();
      if (!(merge && h.mergeKey === merge && now - h.mergeAt < 1200)) { h.past.push(cur); if (h.past.length > 100) h.past.shift(); }
      h.future = []; h.mergeKey = merge ?? null; h.mergeAt = now;
      return next;
    });
    setDirty(true);
    if (select !== undefined) setSel(select);
    force((x) => x + 1);
  }, []);
  const undo = useCallback(() => { const h = hist.current; if (!h.past.length || !doc) return; h.future.push(doc); setDoc(h.past.pop()!); h.mergeKey = null; setDirty(true); force((x) => x + 1); }, [doc]);
  const redo = useCallback(() => { const h = hist.current; if (!h.future.length || !doc) return; h.past.push(doc); setDoc(h.future.pop()!); h.mergeKey = null; setDirty(true); force((x) => x + 1); }, [doc]);
  const op = useCallback((o: Op) => { if (!doc) return; const r = applyOp(doc, o); if (r) commit(r.doc, undefined, r.select); }, [doc, commit]);

  const propsApi: PropsApi | null = doc ? {
    pid, doc, locale, packages, iconBase,
    edit: (id, fn, merge) => { const next = clone(doc); const at = locate(next, id); if (!at) return; fn(at.component, next); commit(next, merge); },
    setString: (key, value, merge) => { const next = clone(doc); next.components_localizations[locale] = { ...(next.components_localizations[locale] ?? {}), [key]: value }; commit(next, merge); },
  } : null;

  const add = (type: AddableType) => {
    if (!doc) return;
    const next = clone(doc);
    const c = newComponent(type, { doc: next, iconBaseUrl: iconBase, packages: packages.map((p) => p.id) });
    const target = sel ? locate(next, sel) : null;
    const inside = !!target && childGroups(target.component).length > 0 && !["tabs", "carousel", "countdown"].includes(target.component.type);
    const r = applyOp(next, { kind: "insert", component: c, targetId: sel, position: inside ? "inside" : "after" });
    if (r) commit(r.doc, undefined, c.id); else toast(type === "sticky_footer" ? "The paywall already has a sticky footer." : "Select where to add it.");
  };

  // Keyboard: undo/redo anywhere outside text fields; tree keys in the tree.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async (): Promise<boolean> => {
    if (!doc || !pw.data) return false;
    setErr(null);
    try {
      const r = await api<Paywall>(`${v2(pid)}/paywalls/${paywallId}`, { method: "PATCH", json: { revision: rev, components_config: doc.components_config, components_localizations: doc.components_localizations, default_locale: doc.default_locale, name: name.trim() || null } });
      setRev(r.revision); setDirty(false);
      await qc.invalidateQueries({ queryKey: ["paywalls", pid] });
      return true;
    } catch (e) { setErr(errMsg(e)); return false; }
  };
  const run = async (what: string, fn: () => Promise<void>) => { setBusy(what); try { await fn(); } finally { setBusy(null); } };
  const saveDraft = () => run("save", async () => { if (await save()) { toast("Draft saved"); await pw.refetch(); } });
  const publish = () => run("publish", async () => {
    if (!doc) return;
    if (validation && !validation.valid) { setProblemsOpen(true); setErr(`Fix ${validation.errors.length} problem${validation.errors.length === 1 ? "" : "s"} before publishing: ${validation.errors[0]!.message}`); return; }
    if (!pw.data?.offering_id) { setErr("Attach the paywall to an offering before publishing it."); return; }
    if ((dirty || !pw.data.components?.draft) && !(await save())) return;
    try {
      await api(`${v2(pid)}/paywalls/${paywallId}/actions/publish`, { method: "POST" });
      await pw.refetch(); await qc.invalidateQueries({ queryKey: ["paywalls", pid] });
      toast("Published. Apps get it on their next offerings fetch.");
    } catch (e) { setErr(errMsg(e)); }
  });
  const attach = (offeringId: string) => run("attach", async () => {
    try {
      await api(`${v2(pid)}/paywalls/${paywallId}/actions/attach_offering`, { method: "POST", json: { offering_id: offeringId } });
      await pw.refetch(); toast("Offering attached");
    } catch (e) { setErr(errMsg(e)); }
  });

  const p = pw.data;
  const strings = doc ? stringsFor(doc, locale) : {};
  const selected = doc && sel ? locate(doc, sel) : null;
  const inPackage = !!(doc && sel && (() => { let found = false; const walk = (c: Json, inside: boolean): void => { if (c.id === sel) found = found || inside; for (const g of childGroups(c)) { if (g.stack.id === sel && (inside || c.type === "package" || c.type === "tab_control_button")) found = true; for (const k of g.stack.components ?? []) walk(k, inside || c.type === "package" || c.type === "tab_control_button"); } }; roots(doc).forEach((r) => walk(r, false)); return found; })());
  const locales = doc ? Object.keys(doc.components_localizations) : [];
  const problems = validation ? [...validation.errors.map((x) => ({ ...x, level: "error" as const })), ...validation.warnings.map((x) => ({ ...x, level: "warning" as const }))] : [];
  const free = (offs.data ?? []).filter((o) => o.id === p?.offering_id);

  const menu: (MenuItem | "-")[] = [
    { label: "Save a version…", icon: "archive", onSelect: () => setVersionsOpen(true) },
    { label: "Duplicate", icon: "copy", onSelect: async () => { const d = await api<Paywall>(`${v2(pid)}/paywalls/${paywallId}/actions/duplicate`, { method: "POST", json: {} }); toast("Duplicated"); nav(`/projects/${pid}/paywalls/${d.id}`); } },
    ...(p?.published_at ? [{ label: "Unpublish", icon: "archive", onSelect: () => setConfirm("unpublish") } as MenuItem] : []),
    "-", { label: "Delete", icon: "trash", danger: true, onSelect: () => setConfirm("delete") },
  ];

  return (
    <Shell title={name || "Paywall"} crumbs={<><Link className="cat-crumb-up" to={`/projects/${pid}/paywalls`}>Paywalls</Link> <span className="cat-crumb-up">/</span> <b className="cat-crumb">{name || "Paywall"}</b></>}>
      <div className="pe">
        <div className="pe-head">
          <div className="pe-title">
            <input className="pe-name" aria-label="Paywall name" value={name} placeholder="Untitled paywall" onChange={(e) => { setName(e.target.value); setDirty(true); }} />
            <div className="pe-meta">
              {p && (() => { const [t, tone] = status(p); return <Tag tone={dirty ? "gold" : tone}>{dirty ? "Unsaved changes" : t}</Tag>; })()}
              {offering ? <span className="subtle">Offering <code>{offering.lookup_key}</code> · {packages.length} package{packages.length === 1 ? "" : "s"}</span>
                : p && <span className="pe-attach"><span className="subtle">No offering.</span>
                  <select className="select sm" aria-label="Attach to offering" value="" onChange={(e) => e.target.value && attach(e.target.value)}>
                    <option value="">Attach to…</option>
                    {(offs.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.display_name}</option>)}
                  </select></span>}
            </div>
          </div>
          <div className="pe-actions">
            <button type="button" className="ib" aria-label="Undo" title="Undo (⌘Z)" disabled={!hist.current.past.length} onClick={undo}><Icon name="undo" /></button>
            <button type="button" className="ib" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!hist.current.future.length} onClick={redo}><Icon name="redo" /></button>
            {ai.data?.available && <button type="button" className="btn btn-line" onClick={() => setAiOpen(true)}><Icon name="spark" />Generate with AI</button>}
            <button type="button" className="btn btn-line" disabled={!!busy || !doc} onClick={saveDraft}>{busy === "save" ? "Saving…" : "Save draft"}</button>
            <button type="button" className="btn btn-dark" disabled={!!busy || !doc} onClick={publish}>{busy === "publish" ? "Publishing…" : "Publish"}</button>
            {p && <Menu label="Paywall actions" items={menu} />}
          </div>
        </div>
        {err && <div className="banner err" role="alert"><span style={{ flex: 1 }}>{err}</span><button type="button" className="ib" aria-label="Dismiss" onClick={() => setErr(null)}><Icon name="close" /></button></div>}
        <Tabs label="Editor" idBase="pe" value={view} onChange={setView} tabs={[{ value: "design", label: "Design" }, { value: "localizations", label: `Localizations · ${locales.length}` }, { value: "json", label: "JSON" }]}
          right={<div className="pe-tools" role="toolbar" aria-label="Preview">
            <select className="select sm" aria-label="Locale" value={locale} onChange={(e) => setLocale(e.target.value)}>{locales.map((l) => <option key={l} value={l}>{l}{doc && l === doc.default_locale ? " (default)" : ""}</option>)}</select>
            <div className="seg" role="group" aria-label="Appearance"><button type="button" aria-pressed={!dark} onClick={() => setDark(false)}>Light</button><button type="button" aria-pressed={dark} onClick={() => setDark(true)}>Dark</button></div>
            <Switch checked={intro} onChange={setIntro} label="Intro offer" />
            <button type="button" className={`btn btn-line pe-prob${validation && !validation.valid ? " bad" : ""}`} aria-expanded={problemsOpen} onClick={() => setProblemsOpen(!problemsOpen)}>
              <Icon name={validation && !validation.valid ? "warn" : "check"} />{problems.length ? `${problems.length} problem${problems.length === 1 ? "" : "s"}` : "No problems"}
            </button>
          </div>} />
        {problemsOpen && <Problems items={problems} onGo={(id) => { setSel(id); setView("design"); }} onClose={() => setProblemsOpen(false)} />}
        {pw.isError ? <div className="banner err" role="alert">The paywall could not be loaded: {errMsg(pw.error)}</div>
          : !doc || !propsApi ? <div className="panel pb subtle">{pw.data && !docOf(pw.data) ? "This paywall has no components." : "Loading…"}</div>
          : view === "design" ? (
            <div className="pe-grid">
              <section className="panel pe-tree" aria-label="Layers">
                <div className="pe-ph"><span className="label">Layers</span>
                  <DropButton label="Add" className="btn btn-line pe-add" items={ADDABLE_TYPES.map((t) => ({ label: TYPE_LABEL[t]!, onSelect: () => add(t), disabled: t === "sticky_footer" && !!doc.components_config.base.sticky_footer }))} />
                </div>
                <Tree doc={doc} strings={strings} sel={sel} onSel={setSel} op={op} />
              </section>
              <section className="pe-stage" aria-label="Preview">
                <div className="pe-pkgs" role="group" aria-label="Preview package">
                  {packages.length > 0 && <>
                    <span className="label">Selected</span>
                    <select className="select sm" aria-label="Selected package in preview" value={pkgPreview ?? ""} onChange={(e) => setPkgPreview(e.target.value || null)}>
                      <option value="">Default</option>{packages.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                  </>}
                </div>
                <div className="pwr-pick"><Phone doc={doc} width={phoneW} state={{ dark, locale, intro }} focus={sel} onPick={setSel} selectedPkg={pkgPreview} onSelectPkg={setPkgPreview} /></div>
                <p className="subtle pe-cap">Sample prices. Devices show the store's local price.</p>
              </section>
              <section className="panel pe-props" aria-label="Properties">
                {selected ? <Props key={selected.component.id} c={selected.component} api={propsApi} inPackage={inPackage} />
                  : <Background doc={doc} api={propsApi} commit={commit} />}
              </section>
            </div>
          ) : view === "localizations" ? <Localizations doc={doc} commit={commit} />
          : <JsonView pid={pid} doc={doc} offeringId={p?.offering_id ?? null} commit={commit} />}
      </div>
      {aiOpen && <AiDialog pid={pid} offerings={free} fixedOffering={offering} onClose={() => setAiOpen(false)} onApply={(d, n) => { commit(d, undefined, d.components_config.base.stack.id); if (n && !name) setName(n); toast("AI draft applied. Undo brings back the previous one."); }} />}
      {versionsOpen && <Versions pid={pid} paywallId={paywallId} onClose={() => setVersionsOpen(false)} beforeSave={async () => (dirty ? save() : true)}
        onRestored={async () => { const r = await pw.refetch(); const d = r.data ? docOf(r.data) : null; if (d) { commit(d); setRev(r.data!.revision); setDirty(false); } toast("Version restored into the draft"); }} />}
      {confirm === "delete" && <ConfirmDialog title="Delete this paywall?" confirmLabel="Delete paywall" danger onClose={() => setConfirm(null)} onConfirm={async () => {
        await api(`${v2(pid)}/paywalls/${paywallId}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["paywalls", pid] }); setDirty(false); toast("Paywall deleted"); nav(`/projects/${pid}/paywalls`);
      }}><p>Apps stop showing it on their next offerings fetch. This cannot be undone.</p></ConfirmDialog>}
      {confirm === "unpublish" && <ConfirmDialog title="Unpublish this paywall?" confirmLabel="Unpublish" danger onClose={() => setConfirm(null)} onConfirm={async () => {
        await api(`${v2(pid)}/paywalls/${paywallId}/actions/unpublish`, { method: "POST" }); await pw.refetch(); toast("Unpublished");
      }}><p>Apps stop receiving it. Your content stays as a draft.</p></ConfirmDialog>}
    </Shell>
  );
}

/** Paywall background (shown when nothing is selected). */
function Background({ doc, api: p, commit }: { doc: PaywallDoc; api: PropsApi; commit: (d: PaywallDoc) => void }) {
  const bg = doc.components_config.base.background;
  const v = bg?.type === "color" && bg.value?.light?.type === "hex" ? bg.value.light.value.slice(0, 7) : "#ffffff";
  const dv = bg?.type === "color" && bg.value?.dark?.type === "hex" ? bg.value.dark.value.slice(0, 7) : null;
  const set = (light: string, dark: string | null) => { const n = clone(doc); n.components_config.base.background = { type: "color", value: { light: { type: "hex", value: `${light}ff` }, ...(dark ? { dark: { type: "hex", value: `${dark}ff` } } : {}) } }; commit(n); };
  return (
    <div className="pf">
      <div className="pf-head"><div><span className="label">Paywall</span></div></div>
      <details className="pf-sec" open><summary>Background</summary><div className="pf-body">
        <div className="pf-row"><label htmlFor="pw-bg">Light</label><div className="pf-ctl"><input id="pw-bg" type="color" value={v} onChange={(e) => set(e.target.value, dv)} /></div></div>
        <div className="pf-row"><label htmlFor="pw-bg-d">Dark</label><div className="pf-ctl"><input id="pw-bg-d" type="color" value={dv ?? "#0a0a0a"} onChange={(e) => set(v, e.target.value)} /></div></div>
      </div></details>
      <p className="subtle pf-note">Select a layer or click the preview to edit a component. {p.packages.length} package{p.packages.length === 1 ? "" : "s"} in the offering.</p>
    </div>
  );
}

function Problems({ items, onGo, onClose }: { items: (PaywallIssue & { level: "error" | "warning" })[]; onGo: (id: string) => void; onClose: () => void }) {
  return (
    <section className="panel pe-problems" aria-label="Problems">
      <div className="pe-ph"><span className="label">Problems</span><button type="button" className="ib" aria-label="Close problems" onClick={onClose}><Icon name="close" /></button></div>
      {!items.length ? <p className="subtle pf-note">Nothing to fix. Every component decodes in the SDK.</p> : (
        <ul>
          {items.map((x, i) => (
            <li key={i} className={x.level}>
              <Tag tone={x.level === "error" ? "down" : "muted"}>{x.level === "error" ? "Error" : "Warning"}</Tag>
              <span>{x.message} <code className="subtle">{x.path}</code></span>
              {x.component_id && <button type="button" className="linkbtn" onClick={() => onGo(x.component_id!)}>Go to</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Tree ---------------------------------------------------------------------------------------------------------------

interface Row { id: string; depth: number; c: Json; label: string; type: string; group?: string; movable: boolean; container: boolean }
function flatten(doc: PaywallDoc, strings: Record<string, unknown>): Row[] {
  const out: Row[] = [];
  const visit = (c: Json, depth: number, movable: boolean) => {
    out.push({ id: c.id, depth, c, label: componentLabel(c, strings), type: c.type, movable, container: childGroups(c).length > 0 });
    for (const g of childGroups(c)) {
      if (g.label && g.stack.id !== c.id) {
        out.push({ id: g.stack.id, depth: depth + 1, c: g.stack, label: g.label, type: "stack", group: g.label, movable: false, container: true });
        for (const k of g.stack.components ?? []) visit(k, depth + 2, true);
      } else for (const k of g.stack.components ?? []) visit(k, depth + 1, true);
    }
  };
  const base = doc.components_config.base;
  visit({ ...base.stack, name: base.stack.name ?? "Content" }, 0, false);
  if (base.sticky_footer) visit({ ...base.sticky_footer, type: "sticky_footer" }, 0, false);
  return out;
}
const GLYPH: Record<string, string> = {
  text: "T", image: "▣", icon: "★", stack: "▤", button: "◉", package: "▭", purchase_button: "$", sticky_footer: "▁", timeline: "⋮", tabs: "⇆", tab_control: "⇆",
  tab_control_button: "◧", tab_control_toggle: "◑", carousel: "◫", video: "▶", countdown: "◷", web_view: "◎", footer: "▁",
};

function Tree({ doc, strings, sel, onSel, op }: { doc: PaywallDoc; strings: Record<string, unknown>; sel: string | null; onSel: (id: string) => void; op: (o: Op) => void }) {
  const rows = flatten(doc, strings);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: "before" | "after" | "inside" } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(sel ?? "")}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);
  const onKey = (e: RKeyboardEvent) => {
    const i = rows.findIndex((r) => r.id === sel);
    const r = rows[i];
    if (e.key === "ArrowDown" && !e.altKey) { e.preventDefault(); const n = rows[Math.min(rows.length - 1, i + 1)]; if (n) onSel(n.id); }
    else if (e.key === "ArrowUp" && !e.altKey) { e.preventDefault(); const n = rows[Math.max(0, i - 1)]; if (n) onSel(n.id); }
    else if (!r?.movable) return;
    else if (e.key === "ArrowDown" && e.altKey) { e.preventDefault(); op({ kind: "move", id: r.id, delta: 1 }); }
    else if (e.key === "ArrowUp" && e.altKey) { e.preventDefault(); op({ kind: "move", id: r.id, delta: -1 }); }
    else if (e.key === "ArrowRight" && e.altKey) { e.preventDefault(); op({ kind: "into", id: r.id }); }
    else if (e.key === "ArrowLeft" && e.altKey) { e.preventDefault(); op({ kind: "out", id: r.id }); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); op({ kind: "remove", id: r.id }); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); op({ kind: "duplicate", id: r.id }); }
  };
  const posOf = (e: DragEvent, r: Row): "before" | "after" | "inside" => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - b.top) / b.height;
    if (r.container && y > 0.3 && y < 0.7) return "inside";
    if (!r.movable) return "inside";
    return y < 0.5 ? "before" : "after";
  };
  return (
    <div ref={ref} className="pe-rows" role="tree" aria-label="Components" tabIndex={0} onKeyDown={onKey}>
      {rows.map((r) => (
        <div key={`${r.id}${r.group ?? ""}`} data-row={r.id} role="treeitem" aria-level={r.depth + 1} aria-selected={sel === r.id}
          className={`pe-row${sel === r.id ? " on" : ""}${r.group ? " grp" : ""}${drop?.id === r.id ? ` drop-${drop.pos}` : ""}${drag === r.id ? " dragging" : ""}`}
          style={{ paddingLeft: 8 + r.depth * 14 }} draggable={r.movable}
          onClick={() => onSel(r.id)}
          onDragStart={(e) => { setDrag(r.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); }}
          onDragEnd={() => { setDrag(null); setDrop(null); }}
          onDragOver={(e) => { if (!drag || drag === r.id) return; e.preventDefault(); const pos = posOf(e, r); if (drop?.id !== r.id || drop.pos !== pos) setDrop({ id: r.id, pos }); }}
          onDragLeave={() => setDrop((d) => (d?.id === r.id ? null : d))}
          onDrop={(e) => { e.preventDefault(); if (drag && drop) op({ kind: "moveTo", id: drag, targetId: drop.id, position: drop.pos }); setDrag(null); setDrop(null); }}>
          {r.depth > 0 && Array.from({ length: r.depth }, (_, i) => <i key={i} className="pe-guide" style={{ left: 14 + i * 14 }} />)}
          <span className="pe-glyph" aria-hidden>{GLYPH[r.type] ?? "·"}</span>
          <span className="pe-label">{r.group ? <b>{r.label}</b> : <>{r.label || <span className="subtle">{TYPE_LABEL[r.type]}</span>}</>}</span>
          {!r.group && <span className="pe-type">{TYPE_LABEL[r.type] ?? r.type}</span>}
          {r.movable && (
            <span className="pe-acts" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="ib" aria-label={`Move ${r.label || r.type} up`} onClick={() => op({ kind: "move", id: r.id, delta: -1 })}><Icon name="up" /></button>
              <button type="button" className="ib" aria-label={`Move ${r.label || r.type} down`} onClick={() => op({ kind: "move", id: r.id, delta: 1 })}><Icon name="down" /></button>
              <button type="button" className="ib" aria-label={`Duplicate ${r.label || r.type}`} onClick={() => op({ kind: "duplicate", id: r.id })}><Icon name="copy" /></button>
              <button type="button" className="ib" aria-label={`Remove ${r.label || r.type}`} onClick={() => op({ kind: "remove", id: r.id })}><Icon name="trash" /></button>
            </span>
          )}
        </div>
      ))}
      <p className="subtle pe-keys">Drag to reorder or drop into a container. Keys: ↑ ↓ select, ⌥↑ ⌥↓ move, ⌥→ into the stack above, ⌥← out, ⌘D duplicate, ⌫ remove.</p>
    </div>
  );
}

// ---- Localizations ----------------------------------------------------------------------------------------------------

function Localizations({ doc, commit }: { doc: PaywallDoc; commit: (d: PaywallDoc, merge?: string) => void }) {
  const locales = Object.keys(doc.components_localizations);
  const def = doc.default_locale;
  const used = useMemo(() => {
    const keys: string[] = [];
    const walk = (x: unknown) => { if (Array.isArray(x)) return x.forEach(walk); if (x && typeof x === "object") for (const [k, v] of Object.entries(x as Json)) { if ((k === "text_lid" || k === "url_lid") && typeof v === "string") { if (!keys.includes(v)) keys.push(v); } else walk(v); } };
    walk(doc.components_config);
    return keys;
  }, [doc.components_config]);
  const [adding, setAdding] = useState("");
  const missing = (l: string) => used.filter((k) => !(k in (doc.components_localizations[l] ?? {}))).length;
  const set = (l: string, k: string, v: string) => { const n = clone(doc); n.components_localizations[l] = { ...(n.components_localizations[l] ?? {}), [k]: v }; commit(n, `loc${l}${k}`); };
  const addLocale = (l: string) => { if (!l || doc.components_localizations[l]) return; const n = clone(doc); n.components_localizations[l] = {}; commit(n); setAdding(""); };
  const remove = (l: string) => { const n = clone(doc); delete n.components_localizations[l]; commit(n); };
  const makeDefault = (l: string) => { const n = clone(doc); n.components_localizations[l] = { ...n.components_localizations[def], ...n.components_localizations[l] }; n.default_locale = l; commit(n); };
  return (
    <section className="panel pe-loc" aria-label="Localizations">
      <div className="pe-ph">
        <span className="label">{used.length} strings · {locales.length} languages</span>
        <span className="pe-attach">
          <select className="select sm" aria-label="Add language" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a language…</option>
            {PAYWALL_LOCALES.filter(([id]) => !locales.includes(id)).map(([id, n]) => <option key={id} value={id}>{n} ({id})</option>)}
          </select>
          <button type="button" className="btn btn-line" disabled={!adding} onClick={() => addLocale(adding)}><Icon name="plus" />Add</button>
        </span>
      </div>
      <div className="tbl pe-loc-t">
        <table className="compact">
          <thead><tr><th scope="col">Key</th>{locales.map((l) => (
            <th key={l} scope="col"><span className="pe-lh">{l}{l === def ? <Tag>Default</Tag> : <>{missing(l) > 0 && <Tag tone="gold">{missing(l)} missing</Tag>}
              <button type="button" className="linkbtn" onClick={() => makeDefault(l)}>Make default</button>
              <button type="button" className="ib" aria-label={`Remove ${l}`} onClick={() => remove(l)}><Icon name="trash" /></button></>}</span></th>
          ))}</tr></thead>
          <tbody>
            {used.map((k) => (
              <tr key={k}>
                <th scope="row"><code>{k}</code></th>
                {locales.map((l) => {
                  const v = doc.components_localizations[l]?.[k];
                  return <td key={l}><textarea className={`textarea pe-cell${v === undefined ? " miss" : ""}`} rows={1} aria-label={`${k} in ${l}`} value={typeof v === "string" ? v : ""} placeholder={l === def ? "" : String(doc.components_localizations[def]?.[k] ?? "")} onChange={(e) => set(l, k, e.target.value)} /></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="subtle pf-note">Empty cells show the default language's text in the app. Variables such as {"{{ product.price_per_period }}"} stay as they are in every language; the SDK fills in the period words for the device's language.</p>
    </section>
  );
}

// ---- JSON ----------------------------------------------------------------------------------------------------------------

function JsonView({ pid, doc, offeringId, commit }: { pid: string; doc: PaywallDoc; offeringId: string | null; commit: (d: PaywallDoc) => void }) {
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2));
  const [msg, setMsg] = useState<{ tone: "err" | "ok"; text: string; fixes?: string[] } | null>(null);
  useEffect(() => { setText(JSON.stringify(doc, null, 2)); }, [doc]);
  const parse = (): PaywallDoc | null => {
    try { const x = JSON.parse(text); if (!x?.components_config) throw new Error("The JSON needs components_config, components_localizations and default_locale."); return { components_config: x.components_config, components_localizations: x.components_localizations ?? {}, default_locale: x.default_locale ?? "en_US" }; }
    catch (e) { setMsg({ tone: "err", text: errMsg(e) }); return null; }
  };
  const apply = () => { const d = parse(); if (d) { commit(d); setMsg({ tone: "ok", text: "Applied. Undo brings back the previous version." }); } };
  const repair = async () => {
    const d = parse(); if (!d) return;
    try {
      const r = await api<{ valid: boolean; fixes: string[] } & PaywallDoc>(`${v2(pid)}/paywalls/validate`, { method: "POST", json: { ...d, repair: true, ...(offeringId ? { offering_id: offeringId } : {}) } });
      commit({ components_config: r.components_config, components_localizations: r.components_localizations, default_locale: r.default_locale });
      setMsg({ tone: r.valid ? "ok" : "err", text: r.valid ? "Repaired: the paywall decodes in the SDK." : "Repaired, but problems remain.", fixes: r.fixes });
    } catch (e) { setMsg({ tone: "err", text: errMsg(e) }); }
  };
  return (
    <section className="panel pe-json" aria-label="Components JSON">
      <div className="pe-ph"><span className="label">What the SDK receives after you publish</span>
        <span className="pe-attach"><button type="button" className="btn btn-line" onClick={repair}>Repair</button><button type="button" className="btn btn-dark" onClick={apply}>Apply</button></span></div>
      {msg && <div className={`banner${msg.tone === "err" ? " err" : ""}`} role="status"><span>{msg.text}{msg.fixes?.length ? <ul>{msg.fixes.map((f) => <li key={f}>{f}</li>)}</ul> : null}</span></div>}
      <textarea className="textarea mono pe-code" aria-label="Paywall JSON" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </section>
  );
}

// ---- Versions -----------------------------------------------------------------------------------------------------------

function Versions({ pid, paywallId, onClose, onRestored, beforeSave }: { pid: string; paywallId: string; onClose: () => void; onRestored: () => void; beforeSave: () => Promise<boolean> }) {
  const list = useQuery({ queryKey: ["paywall-versions", pid, paywallId], queryFn: () => api<List<{ id: string; name: string; revision: number; created_at: number }>>(`${v2(pid)}/paywalls/${paywallId}/versions?limit=100`) });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim()) { setErr("Name the version."); return; }
    setBusy(true); setErr(null);
    try { if (await beforeSave()) { await api(`${v2(pid)}/paywalls/${paywallId}/versions`, { method: "POST", json: { name: name.trim() } }); setName(""); await list.refetch(); } } catch (e) { setErr(errMsg(e)); }
    setBusy(false);
  };
  const restore = async (id: string) => {
    setBusy(true); setErr(null);
    try { await api(`${v2(pid)}/paywalls/${paywallId}/versions/${id}/actions/restore`, { method: "POST" }); onRestored(); onClose(); } catch (e) { setErr(errMsg(e)); setBusy(false); }
  };
  const items = (list.data?.items ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  return (
    <Dialog title="Versions" onClose={onClose} footer={<button type="button" className="btn btn-line" onClick={onClose}>Close</button>}>
      <Field label="Save the current draft as" htmlFor="ver-name"><span className="pe-attach"><input id="ver-name" className="input" value={name} maxLength={255} placeholder="Before the spring sale" onChange={(e) => setName(e.target.value)} /><button type="button" className="btn btn-dark" disabled={busy} onClick={save}>Save version</button></span></Field>
      {err && <div className="banner err" role="alert">{err}</div>}
      {!items.length ? <p className="subtle" style={{ margin: 0 }}>No saved versions yet.</p> : (
        <ul className="pe-versions" aria-label="Saved versions">
          {items.map((v) => <li key={v.id}><b>{v.name}</b><span className="subtle mono">rev {v.revision} · {new Date(v.created_at).toLocaleString()}</span><button type="button" className="btn btn-line" disabled={busy} onClick={() => restore(v.id)}>Restore</button></li>)}
        </ul>
      )}
    </Dialog>
  );
}
