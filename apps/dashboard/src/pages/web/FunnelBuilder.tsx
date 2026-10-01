/**
 * The funnel builder: /projects/:projectId/funnels/:funnelId (prd/web-billing/PRD.md §5).
 * Build tab: the steps (add each type, reorder by drag or the arrows, duplicate, delete, select), the live preview — the
 * same renderFunnelPage the public page uses, in preview mode, re-rendered 150ms after each change — and the properties of
 * the selected step plus the theme. validateFunnel's publish rules list the problems; Publish stays off until there are
 * none. Analytics tab: views, checkouts, purchases, conversion and revenue, each step's drop-off, and views per day.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { renderFunnelPage, validateFunnel, FUNNEL_LIMITS, type FunnelDoc, type FunnelStep, type FunnelStepType, type FunnelTheme } from "@revenuedot/core/funnels";
import { Shell } from "../../components/Shell";
import { Icon } from "../../components/icons";
import { Check, ConfirmDialog, CopyButton, Menu, Segmented, Tabs, Tag, useProjectId, useToast, type MenuItem } from "../../components/ui";
import { api, fmt } from "../../lib/api";
import { v2 } from "../catalog/lib";
import { DropButton } from "../paywalls/Paywalls";
import { PagePreview, ThemeEditor, apiError } from "./parts";
import { useRefreshWeb, type Funnel, type FunnelAnalytics, type PreviewData } from "./lib";

const TYPE_LABEL: Record<FunnelStepType, string> = { question: "Question", info: "Info", email: "Email", paywall: "Paywall", success: "Success" };
const TYPE_GLYPH: Record<FunnelStepType, string> = { question: "?", info: "i", email: "@", paywall: "$", success: "✓" };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

const freeId = (base: string, taken: Set<string>) => {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
};

function newStep(type: FunnelStepType, taken: Set<string>): FunnelStep {
  const id = freeId(type, taken);
  switch (type) {
    case "question": return { id, type, title: "New question", subtitle: null, options: [{ id: "a", label: "First answer" }, { id: "b", label: "Second answer" }], multiple: false };
    case "info": return { id, type, title: "Good to know", subtitle: null, body: "Tell visitors why this works for people like them.", button_label: "Continue" };
    case "email": return { id, type, title: "Where should we send your plan?", subtitle: null, placeholder: "you@example.com", required: true };
    case "paywall": return { id, type, title: "Choose your plan", subtitle: "Cancel anytime.", features: [], allow_codes: true, button_label: "Continue" };
    case "success": return { id, type, title: "You are in", subtitle: null, body: "Open the app to start. Your purchase is waiting there.", show_redemption: true };
  }
}

/** Keyed by the funnel, so another funnel starts from its own draft. */
export function FunnelBuilderPage() {
  const { funnelId = "" } = useParams();
  return <Builder key={funnelId} funnelId={funnelId} />;
}

function Builder({ funnelId }: { funnelId: string }) {
  const pid = useProjectId();
  const nav = useNavigate();
  const toast = useToast();
  const refresh = useRefreshWeb(pid);
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("tab") === "analytics" ? "analytics" : "build";
  const f = useQuery({ queryKey: ["web", pid, "funnel", funnelId], queryFn: () => api<Funnel>(`${v2(pid)}/funnels/${funnelId}`), enabled: !!funnelId });
  const pd = useQuery({ queryKey: ["web", pid, "funnel-preview", funnelId], queryFn: () => api<PreviewData>(`${v2(pid)}/funnels/${funnelId}/preview_data`), enabled: !!funnelId });
  const [draft, setDraft] = useState<FunnelDoc | null>(null);
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);
  const edits = useRef(0);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "unpublish" | null>(null);

  useEffect(() => {
    if (!f.data || draft) return;
    setDraft(clone(f.data.draft)); setName(f.data.name); setSel(f.data.draft.steps[0]?.id ?? null);
  }, [f.data, draft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const selRef = useRef(sel);
  selRef.current = sel;
  const shown = useDebounced(draft, 150);
  const html = useMemo(() => {
    if (!shown || !pd.data) return "";
    try { return renderFunnelPage({ funnel: shown, look: pd.data.look, packages: pd.data.packages, mode: "preview", startStepId: selRef.current }); }
    catch (e) { return `<!doctype html><p style="font:14px system-ui;padding:24px;color:#C2410C">The preview cannot show this draft: ${String(e instanceof Error ? e.message : e).replace(/</g, "&lt;")}</p>`; }
  }, [shown, pd.data]);
  const problems = useMemo(() => (draft ? validateFunnel(draft, { forPublish: true }) : []), [draft]);
  const saveProblems = useMemo(() => (draft ? validateFunnel(draft) : []), [draft]);

  const change = (fn: (d: FunnelDoc) => void) => {
    setDraft((cur) => { if (!cur) return cur; const n = clone(cur); fn(n); return n; });
    setDirty(true); edits.current++; setErr(null);
  };
  const editStep = (id: string, patch: Partial<FunnelStep>) => change((d) => { const s = d.steps.find((x) => x.id === id); if (s) Object.assign(s, patch); });
  const add = (type: FunnelStepType) => {
    if (!draft) return;
    if (draft.steps.length >= FUNNEL_LIMITS.steps) { toast(`A funnel can have at most ${FUNNEL_LIMITS.steps} steps.`); return; }
    const s = newStep(type, new Set(draft.steps.map((x) => x.id)));
    change((d) => {
      // Success goes last; anything else after the selected step, but before the success step.
      const i = d.steps.findIndex((x) => x.id === sel);
      const succ = d.steps.findIndex((x) => x.type === "success");
      let at = type === "success" ? d.steps.length : i >= 0 ? i + 1 : d.steps.length;
      if (type !== "success" && succ >= 0 && at > succ) at = succ;
      d.steps.splice(at, 0, s);
    });
    setSel(s.id);
  };
  const move = (from: number, to: number) => change((d) => { if (to < 0 || to >= d.steps.length) return; const [s] = d.steps.splice(from, 1); d.steps.splice(to, 0, s!); });
  const duplicate = (id: string) => {
    if (!draft) return;
    const src = draft.steps.find((x) => x.id === id);
    if (!src) return;
    const copy = { ...clone(src), id: freeId(`${src.id.slice(0, 34)}-copy`, new Set(draft.steps.map((x) => x.id))) } as FunnelStep;
    change((d) => { d.steps.splice(d.steps.findIndex((x) => x.id === id) + 1, 0, copy); });
    setSel(copy.id);
  };
  const remove = (id: string) => {
    if (!draft) return;
    const i = draft.steps.findIndex((x) => x.id === id);
    change((d) => {
      d.steps = d.steps.filter((x) => x.id !== id);
      for (const s of d.steps) if (s.type === "question") s.options = s.options.map((o) => (o.next === id ? { id: o.id, label: o.label } : o));
    });
    const rest = draft.steps.filter((x) => x.id !== id);
    setSel(rest[Math.min(i, rest.length - 1)]?.id ?? null);
  };

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    if (saveProblems.length) { setErr(`Fix this before saving: ${saveProblems[0]!.path} ${saveProblems[0]!.message}.`); return false; }
    const at = edits.current;
    const doc: FunnelDoc = clone(draft);
    for (const s of doc.steps) if (s.type === "paywall" && s.features) s.features = s.features.map((x) => x.trim()).filter(Boolean);
    try {
      await api<Funnel>(`${v2(pid)}/funnels/${funnelId}`, { method: "PATCH", json: { name: name.trim() || f.data?.name, draft: doc } });
      if (edits.current === at) setDirty(false);
      await f.refetch(); await refresh();
      return true;
    } catch (e) { setErr(apiError(e).message); return false; }
  };
  const run = async (what: string, fn: () => Promise<void>) => { setBusy(what); try { await fn(); } finally { setBusy(null); } };
  const saveDraft = () => run("save", async () => { if (await save()) toast("Draft saved."); });
  const publish = () => run("publish", async () => {
    if (problems.length) { setErr(`Fix ${problems.length} problem${problems.length === 1 ? "" : "s"} before publishing.`); return; }
    if (dirty && !(await save())) return;
    try {
      await api(`${v2(pid)}/funnels/${funnelId}/actions/publish`, { method: "POST" });
      await f.refetch(); await refresh();
      toast("Published. The public page shows this version now.");
    } catch (e) { setErr(apiError(e).message); }
  });

  const data = f.data;
  const published = data?.status === "published";
  const selected = draft?.steps.find((s) => s.id === sel) ?? null;
  const menu: (MenuItem | "-")[] = [
    ...(published ? [{ label: "Unpublish", icon: "archive", onSelect: () => setConfirm("unpublish") } as MenuItem] : []),
    { label: "Open public page", icon: "arrow", disabled: !published, hint: published ? undefined : "Publish first", onSelect: () => data && window.open(data.url, "_blank", "noopener") },
    "-", { label: "Delete funnel", icon: "trash", danger: true, onSelect: () => setConfirm("delete") },
  ];

  return (
    <Shell title={name || "Funnel"} crumbs={<><Link className="cat-crumb-up" to={`/projects/${pid}/funnels`}>Funnels</Link> <span className="cat-crumb-up">/</span> <b className="cat-crumb">{name || "Funnel"}</b></>}>
      <div className="pe fb">
        <div className="pe-head">
          <div className="pe-title">
            <input className="pe-name" aria-label="Funnel name" maxLength={120} value={name} placeholder="Untitled funnel" onChange={(e) => { setName(e.target.value); setDirty(true); edits.current++; }} />
            {data && (
              <div className="pe-meta">
                <Tag tone={published ? "up" : "muted"}>{published ? "Published" : "Draft"}</Tag>
                {(dirty || data.has_unpublished_changes) && <Tag tone="gold">{dirty ? "Unsaved changes" : "Unpublished changes"}</Tag>}
                <span className="fb-url">
                  <code title={data.url}>{data.url}</code>
                  <CopyButton value={data.url} label="Copy public URL" />
                  {published && <a className="ib" href={data.url} target="_blank" rel="noreferrer" aria-label="Open public page" title="Open public page"><Icon name="arrow" /></a>}
                </span>
              </div>
            )}
          </div>
          <div className="pe-actions">
            <button type="button" className="btn btn-line" disabled={!!busy || !draft} onClick={saveDraft}>{busy === "save" ? "Saving…" : "Save draft"}</button>
            {published && !dirty && !data?.has_unpublished_changes
              ? <button type="button" className="btn btn-line" disabled={!!busy} onClick={() => setConfirm("unpublish")}>Unpublish</button>
              : <button type="button" className="btn btn-dark" disabled={!!busy || !draft || problems.length > 0} title={problems.length ? "Fix the problems first" : undefined} onClick={publish}>{busy === "publish" ? "Publishing…" : published ? "Publish changes" : "Publish"}</button>}
            {data && <Menu label="Funnel actions" items={menu} />}
          </div>
        </div>
        {err && <div className="banner err" role="alert"><span style={{ flex: 1 }}>{err}</span><button type="button" className="ib" aria-label="Dismiss" onClick={() => setErr(null)}><Icon name="close" /></button></div>}
        <Tabs label="Funnel" idBase="fb" value={tab} onChange={(v) => { const n = new URLSearchParams(sp); if (v === "analytics") n.set("tab", "analytics"); else n.delete("tab"); setSp(n, { replace: true }); }}
          tabs={[{ value: "build", label: "Build" }, { value: "analytics", label: "Analytics" }]} />
        {f.isError ? <div className="banner err" role="alert">The funnel could not be loaded: {apiError(f.error).message}</div>
          : !draft || !data ? <div className="panel pb subtle">Loading…</div>
          : tab === "analytics" ? <Analytics pid={pid} funnelId={funnelId} published={published} />
          : (
            <div className="fb-grid" role="tabpanel" id="fb-build-panel" aria-labelledby="fb-build">
              <div className="fb-left">
                <StepList steps={draft.steps} sel={sel} onSel={setSel} onAdd={add} onMove={move} onDuplicate={duplicate} onRemove={remove} />
                <section className="panel pe-problems" aria-label="Problems">
                  <div className="pe-ph"><span className="label">{problems.length ? `${problems.length} problem${problems.length === 1 ? "" : "s"}` : "Ready to publish"}</span><Icon name={problems.length ? "warn" : "check"} /></div>
                  {problems.length ? (
                    <ul>{problems.map((p, i) => {
                      const m = /^steps\[(\d+)\]/.exec(p.path);
                      const step = m ? draft.steps[Number(m[1])] : undefined;
                      return <li key={i}><span>{step ? <b>{step.title || step.id}: </b> : null}{p.message} <code className="subtle">{p.path}</code></span>{step && <button type="button" className="linkbtn" onClick={() => setSel(step.id)}>Go to</button>}</li>;
                    })}</ul>
                  ) : <p className="subtle pf-note">Every step is valid, a paywall comes before the success step, and the success step is last.</p>}
                </section>
              </div>
              <section className="fb-stage" aria-label="Preview">
                {html ? <PagePreview html={html} step={sel} /> : <div className="wb-phone"><div className="wb-phone-screen subtle fb-wait">{pd.isError ? "The preview data could not be loaded." : "Loading preview…"}</div></div>}
                <p className="subtle pe-cap">{pd.data && !pd.data.app_id ? "Connect Stripe to show real plans." : "Live preview with your web prices. Codes and payments run on the public page only."}</p>
              </section>
              <section className="panel pe-props" aria-label="Properties">
                <div className="pf">
                  {selected ? <StepProps key={selected.id} step={selected} steps={draft.steps} data={pd.data} onChange={(p) => editStep(selected.id, p)} />
                    : <p className="subtle pf-note">Select a step to edit it.</p>}
                  <details className="pf-sec" open={!selected}>
                    <summary>Theme</summary>
                    <div className="pf-body">
                      <ThemeEditor idBase="fb-theme" theme={draft.theme} presets={pd.data?.presets ?? []} onChange={(t: FunnelTheme) => change((d) => { d.theme = t; })} />
                    </div>
                  </details>
                </div>
              </section>
            </div>
          )}
      </div>
      {confirm === "delete" && <ConfirmDialog title="Delete this funnel?" confirmLabel="Delete funnel" danger onClose={() => setConfirm(null)} onConfirm={async () => {
        await api(`${v2(pid)}/funnels/${funnelId}`, { method: "DELETE" }); setDirty(false); await refresh(); toast("Funnel deleted."); nav(`/projects/${pid}/funnels`);
      }}><p>Its public page stops working at once. Purchases made through it stay with their customers.</p></ConfirmDialog>}
      {confirm === "unpublish" && <ConfirmDialog title="Unpublish this funnel?" confirmLabel="Unpublish" danger onClose={() => setConfirm(null)} onConfirm={async () => {
        await api(`${v2(pid)}/funnels/${funnelId}/actions/unpublish`, { method: "POST" }); await f.refetch(); await refresh(); toast("Unpublished. The public page now answers Page not found.");
      }}><p>Visitors see a "Page not found" page. Your draft stays here.</p></ConfirmDialog>}
    </Shell>
  );
}

/* ---------- steps ---------- */

function StepList({ steps, sel, onSel, onAdd, onMove, onDuplicate, onRemove }: {
  steps: FunnelStep[]; sel: string | null; onSel: (id: string) => void; onAdd: (t: FunnelStepType) => void;
  onMove: (from: number, to: number) => void; onDuplicate: (id: string) => void; onRemove: (id: string) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const onDrop = (e: DragEvent, i: number) => { e.preventDefault(); if (drag !== null && drag !== i) onMove(drag, i); setDrag(null); setOver(null); };
  return (
    <section className="panel fb-steps" aria-label="Steps">
      <div className="pe-ph"><span className="label">Steps · {steps.length}</span>
        <DropButton label="Add step" className="btn btn-line pe-add" items={(Object.keys(TYPE_LABEL) as FunnelStepType[]).map((t) => ({ label: TYPE_LABEL[t], onSelect: () => onAdd(t) }))} />
      </div>
      <ol className="fb-rows">
        {steps.map((s, i) => (
          <li key={s.id} className={`fb-row${s.id === sel ? " on" : ""}${drag === i ? " dragging" : ""}${over === i && drag !== null && drag !== i ? (drag < i ? " drop-after" : " drop-before") : ""}`}
            draggable onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.id); }}
            onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragLeave={() => setOver((o) => (o === i ? null : o))} onDrop={(e) => onDrop(e, i)} onDragEnd={() => { setDrag(null); setOver(null); }}>
            <button type="button" className="fb-pick" aria-current={s.id === sel ? "step" : undefined} onClick={() => onSel(s.id)}>
              <span className="fb-n mono">{i + 1}</span>
              <span className="fb-glyph" aria-hidden>{TYPE_GLYPH[s.type]}</span>
              <span className="fb-t"><b>{s.title || <span className="subtle">Untitled</span>}</b><small>{TYPE_LABEL[s.type]} · <span className="mono">{s.id}</span></small></span>
            </button>
            <span className="fb-acts">
              <button type="button" className="ib" aria-label={`Move ${s.title} up`} disabled={i === 0} onClick={() => onMove(i, i - 1)}><Icon name="up" /></button>
              <button type="button" className="ib" aria-label={`Move ${s.title} down`} disabled={i === steps.length - 1} onClick={() => onMove(i, i + 1)}><Icon name="down" /></button>
              <button type="button" className="ib" aria-label={`Duplicate ${s.title}`} onClick={() => onDuplicate(s.id)}><Icon name="duplicate" /></button>
              <button type="button" className="ib" aria-label={`Delete ${s.title}`} disabled={steps.length <= 1} onClick={() => onRemove(s.id)}><Icon name="trash" /></button>
            </span>
          </li>
        ))}
      </ol>
      <p className="subtle pe-keys">Drag a step or use the arrows to reorder.</p>
    </section>
  );
}

/* ---------- properties ---------- */

function Row({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return <div className="pf-row"><label htmlFor={id}>{label}</label><div className="pf-ctl">{children}</div>{hint && <span className="pf-hint">{hint}</span>}</div>;
}

function StepProps({ step: s, steps, data, onChange }: { step: FunnelStep; steps: FunnelStep[]; data: PreviewData | undefined; onChange: (p: Partial<FunnelStep>) => void }) {
  const others = steps.filter((x) => x.id !== s.id);
  const id = (k: string) => `fp-${k}`;
  return (
    <>
      <div className="pf-head"><div><span className="label">{TYPE_LABEL[s.type]} step</span></div><code className="subtle">{s.id}</code></div>
      <details className="pf-sec" open><summary>Content</summary><div className="pf-body">
        <Row id={id("title")} label="Title"><input id={id("title")} className="input pf-sm" maxLength={FUNNEL_LIMITS.title} value={s.title} onChange={(e) => onChange({ title: e.target.value })} /></Row>
        <Row id={id("subtitle")} label="Subtitle"><textarea id={id("subtitle")} className="input pf-text" maxLength={FUNNEL_LIMITS.text} value={s.subtitle ?? ""} onChange={(e) => onChange({ subtitle: e.target.value || null })} /></Row>
        {(s.type === "info" || s.type === "success") && (
          <Row id={id("body")} label="Body"><textarea id={id("body")} className="input pf-text" maxLength={FUNNEL_LIMITS.text} value={s.body ?? ""} onChange={(e) => onChange({ body: e.target.value || null } as Partial<FunnelStep>)} /></Row>
        )}
        {s.type === "info" && (
          <Row id={id("image")} label="Image URL" hint="Optional. An https image above the title.">
            <input id={id("image")} className="input pf-sm" inputMode="url" placeholder="https://…" value={s.image_url ?? ""} onChange={(e) => onChange({ image_url: e.target.value || null } as Partial<FunnelStep>)} />
          </Row>
        )}
        {s.type === "email" && <>
          <Row id={id("placeholder")} label="Placeholder"><input id={id("placeholder")} className="input pf-sm" maxLength={80} value={s.placeholder ?? ""} onChange={(e) => onChange({ placeholder: e.target.value || null } as Partial<FunnelStep>)} /></Row>
          <Check checked={s.required !== false} onChange={(v) => onChange({ required: v } as Partial<FunnelStep>)} label="Required" hint="Saved as $email and pre-filled on Stripe's checkout." />
        </>}
        {s.type === "success" && <Check checked={s.show_redemption !== false} onChange={(v) => onChange({ show_redemption: v } as Partial<FunnelStep>)} label="Show the redemption link" hint="The link that opens the app with the purchase, and store buttons." />}
        {s.type !== "success" && !(s.type === "question" && !s.multiple) && (
          <Row id={id("button")} label="Button"><input id={id("button")} className="input pf-sm" maxLength={40} placeholder="Continue" value={s.button_label ?? ""} onChange={(e) => onChange({ button_label: e.target.value || null } as Partial<FunnelStep>)} /></Row>
        )}
      </div></details>
      {s.type === "question" && <QuestionProps s={s} others={others} onChange={onChange} />}
      {s.type === "paywall" && <PaywallProps s={s} data={data} onChange={onChange} />}
    </>
  );
}

function QuestionProps({ s, others, onChange }: { s: Extract<FunnelStep, { type: "question" }>; others: FunnelStep[]; onChange: (p: Partial<FunnelStep>) => void }) {
  const setOpt = (i: number, p: { label?: string; next?: string | null }) => onChange({ options: s.options.map((o, j) => (j === i ? { ...o, ...p, ...(p.next === null ? { next: undefined } : {}) } : o)) } as Partial<FunnelStep>);
  const addOpt = () => {
    const taken = new Set(s.options.map((o) => o.id));
    let n = s.options.length + 1;
    while (taken.has(`opt-${n}`)) n++;
    onChange({ options: [...s.options, { id: `opt-${n}`, label: `Answer ${s.options.length + 1}` }] } as Partial<FunnelStep>);
  };
  return (
    <details className="pf-sec" open><summary>Answers</summary><div className="pf-body">
      {s.options.map((o, i) => (
        <div key={o.id} className="pf-item fb-opt">
          <div className="pf-item-h"><span className="pf-mini">Answer {i + 1}</span>
            <button type="button" className="ib pf-x" aria-label={`Remove answer ${i + 1}`} disabled={s.options.length <= 1} onClick={() => onChange({ options: s.options.filter((_, j) => j !== i) } as Partial<FunnelStep>)}><Icon name="close" /></button>
          </div>
          <input className="input pf-sm" aria-label={`Answer ${i + 1} label`} maxLength={80} value={o.label} onChange={(e) => setOpt(i, { label: e.target.value })} />
          <select className="select pf-sm" aria-label={`Answer ${i + 1} goes to`} value={o.next ?? ""} onChange={(e) => setOpt(i, { next: e.target.value || null })}>
            <option value="">Go to the next step</option>
            {others.map((x) => <option key={x.id} value={x.id}>Go to: {x.title || x.id}</option>)}
          </select>
        </div>
      ))}
      <button type="button" className="btn btn-line pf-sm" disabled={s.options.length >= FUNNEL_LIMITS.options} onClick={addOpt}><Icon name="plus" />Add answer</button>
      <Check checked={!!s.multiple} onChange={(v) => onChange({ multiple: v } as Partial<FunnelStep>)} label="Multiple choice" hint="Visitors pick several answers, then press the button. Paths apply to single choice only." />
      <Row id="fp-attr" label="Attribute" hint="Optional. The answer is saved on the customer as this attribute.">
        <input id="fp-attr" className="input pf-sm mono" spellCheck={false} placeholder="goal" value={s.attribute ?? ""} onChange={(e) => onChange({ attribute: e.target.value || null } as Partial<FunnelStep>)} />
      </Row>
    </div></details>
  );
}

function PaywallProps({ s, data, onChange }: { s: Extract<FunnelStep, { type: "paywall" }>; data: PreviewData | undefined; onChange: (p: Partial<FunnelStep>) => void }) {
  const pkgs = data?.packages[s.offering ?? ""] ?? [];
  const [features, setFeatures] = useState((s.features ?? []).join("\n"));
  const current = data?.offerings.find((o) => o.is_current);
  return (
    <details className="pf-sec" open><summary>Plans and offer</summary><div className="pf-body">
      <Row id="fp-offering" label="Offering" hint={pkgs.length ? `${pkgs.length} plan${pkgs.length === 1 ? "" : "s"} with web prices.` : "This offering has no web products yet."}>
        <select id="fp-offering" className="select pf-sm" value={s.offering ?? ""} onChange={(e) => onChange({ offering: e.target.value || null, highlight_package: null } as Partial<FunnelStep>)}>
          <option value="">Current offering{current ? ` (${current.display_name})` : ""}</option>
          {(data?.offerings ?? []).map((o) => <option key={o.id} value={o.lookup_key}>{o.display_name} · {o.web_packages} web</option>)}
        </select>
      </Row>
      <Row id="fp-highlight" label="Selected" hint="The plan selected when the step opens.">
        <select id="fp-highlight" className="select pf-sm" value={s.highlight_package ?? ""} onChange={(e) => onChange({ highlight_package: e.target.value || null } as Partial<FunnelStep>)}>
          <option value="">First plan</option>
          {pkgs.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.price}</option>)}
        </select>
      </Row>
      <Row id="fp-features" label="Features" hint={`One per line, at most ${FUNNEL_LIMITS.features}.`}>
        <textarea id="fp-features" className="input pf-text" value={features} onChange={(e) => { setFeatures(e.target.value); onChange({ features: e.target.value.split("\n").slice(0, FUNNEL_LIMITS.features) } as Partial<FunnelStep>); }} />
      </Row>
      <Row id="fp-discount" label="Discount" hint="Optional. Applied without a code.">
        <select id="fp-discount" className="select pf-sm" value={s.discount_id ?? ""} onChange={(e) => onChange({ discount_id: e.target.value || null } as Partial<FunnelStep>)}>
          <option value="">None</option>
          {(data?.discounts ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Row>
      <Check checked={!!s.allow_codes} onChange={(v) => onChange({ allow_codes: v } as Partial<FunnelStep>)} label="Allow discount codes" hint="Shows a field for codes from Web discounts." />
    </div></details>
  );
}

/* ---------- analytics ---------- */

const pct = (x: number) => `${(x * 100).toFixed(x >= 0.1 || x === 0 ? 0 : 1)}%`;

function Analytics({ pid, funnelId, published }: { pid: string; funnelId: string; published: boolean }) {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [measure, setMeasure] = useState<"views" | "purchases">("views");
  const a = useQuery({ queryKey: ["web", pid, "funnel-analytics", funnelId, days], queryFn: () => api<FunnelAnalytics>(`${v2(pid)}/funnels/${funnelId}/analytics?days=${days}`) });
  const d = a.data;
  const maxViewed = Math.max(1, ...(d?.steps.map((s) => s.viewed) ?? [1]));
  return (
    <div className="stack" role="tabpanel" id="fb-analytics-panel" aria-labelledby="fb-analytics">
      <div className="hrow between">
        <p className="section-sub">{published ? "Unique visitor sessions on the public page. Sandbox and live purchases both count." : "Publish the funnel to collect visits."}</p>
        <Segmented label="Period" value={days} onChange={setDays} options={[{ value: "7", label: "7D" }, { value: "30", label: "30D" }, { value: "90", label: "90D" }]} />
      </div>
      {a.isError && <div className="banner err" role="alert">Analytics could not be loaded: {apiError(a.error).message}</div>}
      <div className="stats fa-stats" aria-busy={a.isLoading}>
        {([["Views", d ? fmt.int(d.views) : "—"], ["Checkouts", d ? fmt.int(d.checkouts) : "—"], ["Purchases", d ? fmt.int(d.purchases) : "—"], ["Conversion", d ? pct(d.conversion) : "—"], ["Revenue", d ? fmt.usd(d.revenue_usd, true) : "—"]] as const).map(([k, v]) => (
          <div key={k}><span className="label">{k}</span><b className="num" data-metric={k.toLowerCase()}>{v}</b></div>
        ))}
      </div>
      <section className="panel" aria-labelledby="fa-steps-h">
        <div className="ph"><b id="fa-steps-h">Steps</b><span className="link">Last {days} days</span></div>
        <div className="tbl">
          <table aria-label="Step drop-off">
            <thead><tr><th>Step</th><th className="amt">Viewed</th><th className="amt">Completed</th><th className="fa-barcol">Completion</th><th className="amt">Drop-off</th></tr></thead>
            <tbody>
              {(d?.steps ?? []).map((s, i) => (
                <tr key={s.id}>
                  <td><b>{i + 1}. {s.title}</b><span className="cellsub">{TYPE_LABEL[s.type as FunnelStepType] ?? s.type}</span></td>
                  <td className="amt">{fmt.int(s.viewed)}</td>
                  <td className="amt">{fmt.int(s.completed)}</td>
                  <td className="fa-barcol"><span className="fa-bar" role="img" aria-label={`${s.completed} of ${s.viewed} completed`}><i className="v" style={{ width: `${(s.viewed / maxViewed) * 100}%` }} /><i className="c" style={{ width: `${(Math.min(s.completed, s.viewed || s.completed) / maxViewed) * 100}%` }} /></span></td>
                  <td className={`amt${s.drop_off > 0 ? " down" : ""}`}>{s.viewed ? pct(s.drop_off) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel" aria-labelledby="fa-daily-h">
        <div className="ph wrap"><b id="fa-daily-h">{measure === "views" ? "Views" : "Purchases"} per day</b>
          <Segmented label="Measure" value={measure} onChange={setMeasure} options={[{ value: "views", label: "Views" }, { value: "purchases", label: "Purchases" }]} />
        </div>
        <div className="pb">{d ? <DailyBars daily={d.daily} measure={measure} /> : <p className="subtle">Loading…</p>}</div>
      </section>
    </div>
  );
}

function DailyBars({ daily, measure }: { daily: FunnelAnalytics["daily"]; measure: "views" | "purchases" }) {
  const W = 720, H = 140, PAD = 22;
  const vals = daily.map((x) => x[measure]);
  const max = Math.max(1, ...vals);
  const bw = (W - PAD) / Math.max(1, vals.length);
  return (
    <figure className="fa-daily" aria-label={`${measure} per day`}>
      <svg viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none" role="img" aria-label={`${vals.reduce((a, b) => a + b, 0)} ${measure} in ${vals.length} days`}>
        {[0, 0.5, 1].map((t) => <line key={t} x1={PAD} x2={W} y1={H - t * (H - 8)} y2={H - t * (H - 8)} stroke="var(--border-2)" />)}
        <text x={0} y={12} className="ax">{max}</text><text x={0} y={H} className="ax">0</text>
        {vals.map((v, i) => {
          const h = (v / max) * (H - 8);
          return <rect key={daily[i]!.date} x={PAD + i * bw + bw * 0.15} y={H - h} width={Math.max(1, bw * 0.7)} height={h} fill={i === vals.length - 1 ? "var(--accent)" : "var(--fg)"}><title>{`${daily[i]!.date}: ${v}`}</title></rect>;
        })}
        <text x={PAD} y={H + 14} className="ax">{daily[0]?.date}</text>
        <text x={W} y={H + 14} className="ax" textAnchor="end">{daily[daily.length - 1]?.date}</text>
      </svg>
    </figure>
  );
}
