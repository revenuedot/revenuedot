/**
 * The editor's properties panel: one section per component type the SDK renders (text, image, icon, stack, button,
 * package, purchase button, sticky footer, timeline, tabs and their buttons and toggle, carousel, video, countdown, web
 * view), the "when selected" and "intro offer" overrides, and light and dark colours. Every change goes through
 * `edit(id, mutate)`, which the editor turns into one undo step.
 */
import { cloneElement, isValidElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { PAYWALL_ICONS, PAYWALL_ICON_NAMES, TYPE_LABEL, imageUrls, freshId, type Json, type PaywallDoc } from "@revenuedot/core";
import { Icon } from "../../components/icons";
import { errMsg } from "../catalog/lib";
import { IconGlyph } from "./render";
import { uploadImage, useMedia, type MediaAsset } from "./lib";

export interface PropsApi {
  pid: string;
  doc: PaywallDoc;
  locale: string;
  packages: { id: string; label: string }[];
  /** Mutates a copy of the component with this id (or of a stack inside it) and commits one undo step; `merge` coalesces typing. */
  edit: (id: string, fn: (c: Json, doc: PaywallDoc) => void, merge?: string) => void;
  /** Sets a string in the current locale (or every locale when `all`). */
  setString: (key: string, value: string, merge?: string) => void;
  iconBase: string;
}

// ---- Fields -----------------------------------------------------------------------------------------------------------

let n = 0;
const uid = (p: string) => `${p}-${++n}`;
function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  const [id] = useState(() => uid("pf"));
  return <div className="pf-row"><label htmlFor={id}>{label}</label><div className="pf-ctl" data-for={id}>{withId(children, id)}</div>{hint && <span className="pf-hint">{hint}</span>}</div>;
}
/** Gives the first input of a row the label's id. */
function withId(children: ReactNode, id: string): ReactNode {
  if (isValidElement(children) && typeof children.type === "string" && !(children.props as { id?: string }).id) return cloneElement(children as ReactElement<{ id?: string }>, { id });
  return children;
}
function Num({ value, onChange, min, max, step = 1, id, label }: { value: number | undefined | null; onChange: (v: number) => void; min?: number; max?: number; step?: number; id?: string; label?: string }) {
  return <input id={id} aria-label={label} className="input pf-num" type="number" value={value ?? ""} min={min} max={max} step={step} onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(v)) onChange(v); }} />;
}
function Sel<T extends string>({ value, options, onChange, id, label }: { value: T | undefined; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; id?: string; label?: string }) {
  return <select id={id} aria-label={label} className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value as T)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
}
function Seg<T extends string>({ value, options, onChange, label }: { value: T | undefined; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return <div className="seg pf-seg" role="group" aria-label={label}>{options.map(([v, l]) => <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>;
}
const toHex6 = (info: Json | undefined) => (info?.type === "hex" && typeof info.value === "string" ? info.value.slice(0, 7) : "#000000");
/** A colour scheme editor: light, and an optional dark value. */
function ColorField({ scheme, onChange, label, allowNone }: { scheme: Json | null | undefined; onChange: (s: Json | null) => void; label: string; allowNone?: boolean }) {
  const light = scheme?.light, dark = scheme?.dark;
  const alpha = (info: Json | undefined) => (info?.type === "hex" && typeof info.value === "string" && info.value.length === 9 ? info.value.slice(7) : "ff");
  const set = (which: "light" | "dark", hex: string) => onChange({ ...(scheme ?? {}), light: scheme?.light ?? { type: "hex", value: "#000000ff" }, [which]: { type: "hex", value: `${hex}${alpha(which === "light" ? light : dark)}` } });
  const gradient = light && light.type !== "hex";
  return (
    <div className="pf-color">
      {!scheme && allowNone ? <button type="button" className="btn btn-line pf-sm" onClick={() => onChange({ light: { type: "hex", value: "#ffffffff" } })}>Add {label.toLowerCase()}</button> : gradient ? <span className="subtle">Gradient (edit in JSON)</span> : <>
        <span className="pf-sw"><input type="color" aria-label={`${label}, light`} value={toHex6(light)} onChange={(e) => set("light", e.target.value)} /><code>{toHex6(light)}</code></span>
        {dark ? (
          <span className="pf-sw"><input type="color" aria-label={`${label}, dark`} value={toHex6(dark)} onChange={(e) => set("dark", e.target.value)} /><code>{toHex6(dark)}</code>
            <button type="button" className="ib pf-x" aria-label={`Remove dark ${label.toLowerCase()}`} onClick={() => { const { dark: _d, ...rest } = scheme!; onChange(rest); }}><Icon name="close" /></button></span>
        ) : <button type="button" className="linkbtn" onClick={() => set("dark", toHex6(light))}>+ Dark</button>}
        {allowNone && <button type="button" className="ib pf-x" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => onChange(null)}><Icon name="trash" /></button>}
      </>}
    </div>
  );
}
const SIZE_TYPES = [["fit", "Fit"], ["fill", "Fill"], ["fixed", "Fixed"]] as const;
function SizeField({ size, onChange }: { size: Json | undefined; onChange: (s: Json) => void }) {
  const one = (k: "width" | "height") => {
    const v = size?.[k] ?? { type: "fit", value: null };
    return (
      <span className="pf-size">
        <Sel label={k === "width" ? "Width" : "Height"} value={v.type === "relative" ? "fill" : v.type} options={SIZE_TYPES} onChange={(t) => onChange({ ...(size ?? {}), width: size?.width ?? { type: "fill", value: null }, height: size?.height ?? { type: "fit", value: null }, [k]: t === "fixed" ? { type: "fixed", value: 100 } : { type: t, value: null } })} />
        {v.type === "fixed" && <Num label={`${k} in points`} value={v.value} min={0} onChange={(x) => onChange({ ...size, [k]: { type: "fixed", value: Math.max(0, Math.round(x)) } })} />}
      </span>
    );
  };
  return <div className="pf-pair"><span className="pf-mini">W</span>{one("width")}<span className="pf-mini">H</span>{one("height")}</div>;
}
function BoxField({ value, onChange, label }: { value: Json | undefined; onChange: (v: Json) => void; label: string }) {
  const v = value ?? {};
  return (
    <div className="pf-box" role="group" aria-label={label}>
      {(["top", "trailing", "bottom", "leading"] as const).map((k) => <Num key={k} label={`${label} ${k}`} value={v[k] ?? 0} onChange={(x) => onChange({ top: 0, bottom: 0, leading: 0, trailing: 0, ...v, [k]: x })} />)}
    </div>
  );
}

// ---- Shared sections --------------------------------------------------------------------------------------------------

function Section({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return <details className="pf-sec" open={open}><summary>{title}</summary><div className="pf-body">{children}</div></details>;
}

/** Layout, background, border, shape and shadow of a stack (also the inner stack of packages and buttons). */
function StackSections({ s, api, title = "Layout", selectedState }: { s: Json; api: PropsApi; title?: string; selectedState?: boolean }) {
  const e = (fn: (x: Json) => void, merge?: string) => api.edit(s.id, fn, merge);
  const d = s.dimension ?? { type: "vertical", alignment: "center", distribution: "start" };
  const aligns = d.type === "vertical" ? [["leading", "Leading"], ["center", "Center"], ["trailing", "Trailing"]] as const
    : d.type === "horizontal" ? [["top", "Top"], ["center", "Center"], ["bottom", "Bottom"]] as const
    : [["top_leading", "Top leading"], ["top", "Top"], ["top_trailing", "Top trailing"], ["leading", "Leading"], ["center", "Center"], ["trailing", "Trailing"], ["bottom_leading", "Bottom leading"], ["bottom", "Bottom"], ["bottom_trailing", "Bottom trailing"]] as const;
  const bg = s.background;
  const bgKind = !bg ? "none" : bg.type === "color" ? (bg.value?.light?.type === "linear" ? "gradient" : "color") : bg.type;
  const corner = s.shape?.type === "pill" ? -1 : s.shape?.corners?.top_leading ?? 0;
  const sel = (s.overrides ?? []).find((o: Json) => o.conditions?.some((c: Json) => c.type === "selected"));
  const setSel = (fn: (p: Json) => void) => e((x) => {
    x.overrides = (x.overrides ?? []).filter((o: Json) => o !== undefined);
    let o = x.overrides.find((o: Json) => o.conditions?.some((c: Json) => c.type === "selected"));
    if (!o) { o = { conditions: [{ type: "selected" }], properties: {} }; x.overrides.push(o); }
    fn(o.properties);
    if (!Object.keys(o.properties).length) x.overrides = x.overrides.filter((y: Json) => y !== o);
    if (!x.overrides.length) delete x.overrides;
  });
  return (
    <>
      <Section title={title}>
        <Row label="Direction"><Seg label="Direction" value={d.type} options={[["vertical", "Vertical"], ["horizontal", "Horizontal"], ["zlayer", "Overlay"]]} onChange={(t) => e((x) => { x.dimension = t === "zlayer" ? { type: "zlayer", alignment: "center" } : { type: t, alignment: "center", distribution: x.dimension?.distribution ?? "start" }; })} /></Row>
        <Row label="Alignment"><Sel label="Alignment" value={d.alignment} options={aligns} onChange={(v) => e((x) => { x.dimension = { ...x.dimension, alignment: v }; })} /></Row>
        {d.type !== "zlayer" && <Row label="Distribution"><Sel label="Distribution" value={d.distribution} options={[["start", "Start"], ["center", "Center"], ["end", "End"], ["space_between", "Space between"], ["space_around", "Space around"], ["space_evenly", "Space evenly"]]} onChange={(v) => e((x) => { x.dimension = { ...x.dimension, distribution: v }; })} /></Row>}
        <Row label="Spacing"><Num label="Spacing" value={s.spacing ?? 0} min={0} onChange={(v) => e((x) => { x.spacing = v; }, `sp${s.id}`)} /></Row>
        <Row label="Size"><SizeField size={s.size} onChange={(v) => e((x) => { x.size = v; })} /></Row>
        <Row label="Padding"><BoxField label="Padding" value={s.padding} onChange={(v) => e((x) => { x.padding = v; }, `pd${s.id}`)} /></Row>
        <Row label="Margin"><BoxField label="Margin" value={s.margin} onChange={(v) => e((x) => { x.margin = v; }, `mg${s.id}`)} /></Row>
      </Section>
      <Section title="Style">
        <Row label="Background"><Sel label="Background" value={bgKind} options={[["none", "None"], ["color", "Colour"], ["gradient", "Gradient"], ["image", "Image"]]} onChange={(k) => e((x) => {
          x.background = k === "none" ? null : k === "color" ? { type: "color", value: { light: { type: "hex", value: "#f5f5f5ff" } } }
            : k === "gradient" ? { type: "color", value: { light: { type: "linear", degrees: 180, points: [{ color: "#ffffffff", percent: 0 }, { color: "#e5e5e5ff", percent: 100 }] } } }
            : { type: "image", value: { light: imageUrls(`${api.iconBase}/image.png`, 96, 96) }, fit_mode: "fill" };
        })} /></Row>
        {bgKind === "color" && <Row label="Colour"><ColorField label="Background" scheme={bg.value} onChange={(v) => e((x) => { x.background = v ? { type: "color", value: v } : null; })} /></Row>}
        {bgKind === "gradient" && <GradientField value={bg.value.light} onChange={(g) => e((x) => { x.background = { type: "color", value: { light: g } }; }, `gr${s.id}`)} />}
        {bgKind === "image" && <Row label="Image"><AssetPicker api={api} value={bg.value?.light?.original} onPick={(url, w, h) => e((x) => { x.background = { ...x.background, value: { light: imageUrls(url, w, h) } }; })} /></Row>}
        <Row label="Corners"><span className="pf-pair">
          <Seg label="Shape" value={corner === -1 ? "pill" : "rect"} options={[["rect", "Radius"], ["pill", "Pill"]]} onChange={(v) => e((x) => { x.shape = v === "pill" ? { type: "pill" } : { type: "rectangle", corners: { top_leading: 12, top_trailing: 12, bottom_leading: 12, bottom_trailing: 12 } }; })} />
          {corner !== -1 && <Num label="Corner radius" value={corner} min={0} onChange={(r) => e((x) => { x.shape = r ? { type: "rectangle", corners: { top_leading: r, top_trailing: r, bottom_leading: r, bottom_trailing: r } } : undefined; if (!r) delete x.shape; }, `cr${s.id}`)} />}
        </span></Row>
        <Row label="Border"><span className="pf-pair">
          <Num label="Border width" value={s.border?.width ?? 0} min={0} step={0.5} onChange={(w) => e((x) => { if (!w) delete x.border; else x.border = { color: x.border?.color ?? { light: { type: "hex", value: "#e5e5e5ff" } }, width: w }; }, `bw${s.id}`)} />
          {s.border && <ColorField label="Border" scheme={s.border.color} onChange={(c) => e((x) => { x.border = { ...x.border, color: c }; })} />}
        </span></Row>
        <Row label="Shadow"><span className="pf-pair">
          <Num label="Shadow radius" value={s.shadow?.radius ?? 0} min={0} onChange={(r) => e((x) => { if (!r) delete x.shadow; else x.shadow = { color: x.shadow?.color ?? { light: { type: "hex", value: "#00000022" } }, radius: r, x: 0, y: Math.round(r / 3) }; }, `sh${s.id}`)} />
        </span></Row>
        <BadgeField s={s} api={api} />
      </Section>
      {selectedState && (
        <Section title="When selected">
          <Row label="Border"><span className="pf-pair">
            <Num label="Selected border width" value={sel?.properties?.border?.width ?? 0} min={0} step={0.5} onChange={(w) => setSel((p) => { if (!w) delete p.border; else p.border = { color: p.border?.color ?? { light: { type: "hex", value: "#111111ff" } }, width: w }; })} />
            {sel?.properties?.border && <ColorField label="Selected border" scheme={sel.properties.border.color} onChange={(c) => setSel((p) => { p.border = { ...p.border, color: c }; })} />}
          </span></Row>
          <Row label="Background"><ColorField allowNone label="Selected background" scheme={sel?.properties?.background?.value ?? null} onChange={(c) => setSel((p) => { if (c) p.background = { type: "color", value: c }; else delete p.background; })} /></Row>
        </Section>
      )}
    </>
  );
}
function GradientField({ value, onChange }: { value: Json; onChange: (g: Json) => void }) {
  const pts: Json[] = value.points ?? [];
  return (
    <>
      <Row label="Angle"><Num label="Gradient angle" value={value.degrees ?? 180} min={0} max={360} onChange={(d) => onChange({ ...value, degrees: Math.round(d) })} /></Row>
      {pts.map((p, i) => (
        <Row key={i} label={i === 0 ? "From" : "To"}><span className="pf-pair">
          <input type="color" aria-label={`Gradient colour ${i + 1}`} value={(p.color ?? "#000000").slice(0, 7)} onChange={(e) => onChange({ ...value, points: pts.map((q, j) => (j === i ? { ...q, color: `${e.target.value}ff` } : q)) })} />
          <Num label={`Gradient stop ${i + 1}`} value={p.percent} min={0} max={100} onChange={(v) => onChange({ ...value, points: pts.map((q, j) => (j === i ? { ...q, percent: Math.round(v) } : q)) })} />
        </span></Row>
      ))}
    </>
  );
}
function BadgeField({ s, api }: { s: Json; api: PropsApi }) {
  const b = s.badge;
  const t = b?.stack?.components?.[0];
  return (
    <Row label="Badge">
      {!b ? <button type="button" className="btn btn-line pf-sm" onClick={() => api.edit(s.id, (x, doc) => {
        const key = freshId(null, "l");
        doc.components_localizations[doc.default_locale]![key] = "BEST VALUE";
        x.badge = { style: "overlay", alignment: "top_trailing", stack: {
          id: freshId(doc, "s"), type: "stack", dimension: { type: "vertical", alignment: "center", distribution: "center" }, size: { width: { type: "fit", value: null }, height: { type: "fit", value: null } }, spacing: 0,
          padding: { top: 3, bottom: 3, leading: 8, trailing: 8 }, margin: { top: 0, bottom: 0, leading: 0, trailing: 14 }, background: { type: "color", value: { light: { type: "hex", value: "#111111ff" } } }, shape: { type: "pill" },
          components: [{ id: freshId(doc, "t"), type: "text", text_lid: key, color: { light: { type: "hex", value: "#ffffffff" } }, font_size: 11, font_weight: "bold", horizontal_alignment: "center", size: { width: { type: "fit", value: null }, height: { type: "fit", value: null } }, padding: { top: 0, bottom: 0, leading: 0, trailing: 0 }, margin: { top: 0, bottom: 0, leading: 0, trailing: 0 } }],
        } };
      })}>Add badge</button> : (
        <div className="pf-stackcol">
          {t?.type === "text" && <input className="input" aria-label="Badge text" value={String(api.doc.components_localizations[api.locale]?.[t.text_lid] ?? api.doc.components_localizations[api.doc.default_locale]?.[t.text_lid] ?? "")} onChange={(e) => api.setString(t.text_lid, e.target.value, `bd${s.id}`)} />}
          <span className="pf-pair">
            <Sel label="Badge style" value={b.style} options={[["overlay", "Overlay"], ["edge_to_edge", "Edge to edge"], ["nested", "Nested"]]} onChange={(v) => api.edit(s.id, (x) => { x.badge.style = v; })} />
            <Sel label="Badge position" value={b.alignment} options={[["top_leading", "Top leading"], ["top", "Top"], ["top_trailing", "Top trailing"], ["bottom", "Bottom"]]} onChange={(v) => api.edit(s.id, (x) => { x.badge.alignment = v; })} />
          </span>
          <span className="pf-pair"><ColorField label="Badge background" scheme={b.stack?.background?.value} onChange={(c) => api.edit(s.id, (x) => { x.badge.stack.background = c ? { type: "color", value: c } : null; })} />
            <button type="button" className="ib pf-x" aria-label="Remove badge" onClick={() => api.edit(s.id, (x) => { delete x.badge; })}><Icon name="trash" /></button></span>
        </div>
      )}
    </Row>
  );
}

/** Media assets of the project: pick one, or upload. */
export function AssetPicker({ api, value, onPick }: { api: PropsApi; value?: string; onPick: (url: string, w: number, h: number) => void }) {
  const media = useMedia(api.pid);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const url = (a: MediaAsset) => `${a.asset_base_url}/${a.object_name}`;
  return (
    <div className="pf-assets">
      <div className="pf-thumbs" role="listbox" aria-label="Media assets">
        {(media.data ?? []).map((a) => (
          <button key={a.id} type="button" role="option" aria-selected={value === url(a)} title={a.original_name} className={value === url(a) ? "on" : undefined}
            onClick={() => onPick(url(a), a.original_width ?? 1200, a.original_height ?? 800)}><img src={url(a)} alt={a.original_name} /></button>
        ))}
        <button type="button" className="pf-up" aria-label="Upload image" disabled={busy} onClick={() => file.current?.click()}><Icon name="plus" /></button>
      </div>
      <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Image file" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = "";
        if (!f) return;
        setBusy(true); setErr(null);
        try { const a = await uploadImage(api.pid, f); await media.refetch(); onPick(url(a), a.original_width ?? 1200, a.original_height ?? 800); } catch (x) { setErr(errMsg(x)); }
        setBusy(false);
      }} />
      <input className="input mono" aria-label="Image URL" placeholder="https://…" value={value ?? ""} onChange={(e) => /^https?:\/\/\S+$/.test(e.target.value) && onPick(e.target.value, 1200, 800)} />
      {err && <span className="pf-err">{err}</span>}
    </div>
  );
}
function IconPicker({ value, onPick }: { value: string; onPick: (n: string) => void }) {
  return (
    <div className="pf-icons" role="listbox" aria-label="Icons">
      {PAYWALL_ICON_NAMES.map((name) => (
        <button key={name} type="button" role="option" aria-selected={value === name} title={PAYWALL_ICONS[name]!.label} aria-label={PAYWALL_ICONS[name]!.label} className={value === name ? "on" : undefined} onClick={() => onPick(name)}>
          <IconGlyph name={name} color="currentColor" size={18} />
        </button>
      ))}
    </div>
  );
}

function TextSections({ t, api }: { t: Json; api: PropsApi }) {
  const e = (fn: (x: Json) => void, merge?: string) => api.edit(t.id, fn, merge);
  const def = api.doc.components_localizations[api.doc.default_locale] ?? {};
  const cur = api.doc.components_localizations[api.locale] ?? {};
  const value = cur[t.text_lid] ?? "";
  const intro = (t.overrides ?? []).find((o: Json) => o.conditions?.some((c: Json) => c.type === "intro_offer") && o.properties?.text_lid);
  return (
    <>
      <Section title="Text">
        <Row label={api.locale === api.doc.default_locale ? "Text" : `Text (${api.locale})`} hint={api.locale !== api.doc.default_locale && !(t.text_lid in cur) ? `Not translated: shows “${String(def[t.text_lid] ?? "")}”.` : "Variables: {{ product.price_per_period }}, {{ product.offer_period_with_unit }} …"}>
          <textarea className="textarea pf-text" rows={3} value={String(value)} placeholder={String(def[t.text_lid] ?? "")} onChange={(ev) => api.setString(t.text_lid, ev.target.value, `tx${t.id}${api.locale}`)} />
        </Row>
        <Row label="Intro offer" hint="Shown instead when the selected package has a free trial.">
          {intro ? (
            <span className="pf-stackcol">
              <textarea className="textarea pf-text" rows={2} aria-label="Intro offer text" value={String(cur[intro.properties.text_lid] ?? "")} placeholder={String(def[intro.properties.text_lid] ?? "")} onChange={(ev) => api.setString(intro.properties.text_lid, ev.target.value, `ti${t.id}${api.locale}`)} />
              <button type="button" className="linkbtn" onClick={() => e((x) => { x.overrides = x.overrides.filter((o: Json) => !(o.conditions?.some((c: Json) => c.type === "intro_offer") && o.properties?.text_lid)); if (!x.overrides.length) delete x.overrides; })}>Remove</button>
            </span>
          ) : <button type="button" className="btn btn-line pf-sm" onClick={() => api.edit(t.id, (x, doc) => { const k = freshId(null, "l"); doc.components_localizations[doc.default_locale]![k] = "Start free trial"; x.overrides = [...(x.overrides ?? []), { conditions: [{ type: "intro_offer" }], properties: { text_lid: k } }]; })}>Add intro offer text</button>}
        </Row>
      </Section>
      <Section title="Font">
        <Row label="Size"><Num label="Font size" value={typeof t.font_size === "number" ? t.font_size : 16} min={6} max={120} onChange={(v) => e((x) => { x.font_size = v; }, `fs${t.id}`)} /></Row>
        <Row label="Weight"><Sel label="Font weight" value={t.font_weight} options={[["light", "Light"], ["regular", "Regular"], ["medium", "Medium"], ["semibold", "Semibold"], ["bold", "Bold"], ["extra_bold", "Extra bold"], ["black", "Black"]]} onChange={(v) => e((x) => { x.font_weight = v; delete x.font_weight_int; })} /></Row>
        <Row label="Alignment"><Seg label="Text alignment" value={t.horizontal_alignment} options={[["leading", "Left"], ["center", "Center"], ["trailing", "Right"]]} onChange={(v) => e((x) => { x.horizontal_alignment = v; })} /></Row>
        <Row label="Colour"><ColorField label="Text colour" scheme={t.color} onChange={(c) => c && e((x) => { x.color = c; })} /></Row>
        <Row label="Background"><ColorField allowNone label="Text background" scheme={t.background_color} onChange={(c) => e((x) => { if (c) x.background_color = c; else delete x.background_color; })} /></Row>
        <Row label="Font name" hint="A font uploaded to the project, or a system font name."><input className="input" value={t.font_name ?? ""} onChange={(ev) => e((x) => { if (ev.target.value) x.font_name = ev.target.value; else delete x.font_name; }, `fn${t.id}`)} /></Row>
      </Section>
      <Section title="Layout">
        <Row label="Size"><SizeField size={t.size} onChange={(v) => e((x) => { x.size = v; })} /></Row>
        <Row label="Padding"><BoxField label="Padding" value={t.padding} onChange={(v) => e((x) => { x.padding = v; }, `pd${t.id}`)} /></Row>
        <Row label="Margin"><BoxField label="Margin" value={t.margin} onChange={(v) => e((x) => { x.margin = v; }, `mg${t.id}`)} /></Row>
      </Section>
    </>
  );
}

function urlString(api: PropsApi, key: string | undefined) { return key ? String(api.doc.components_localizations[api.doc.default_locale]?.[key] ?? "") : ""; }

/** The panel for the selected component. */
export function Props({ c, api, inPackage }: { c: Json; api: PropsApi; inPackage: boolean }) {
  const e = (fn: (x: Json) => void, merge?: string) => api.edit(c.id, fn, merge);
  const head = (
    <div className="pf-head">
      <div><span className="label">{TYPE_LABEL[c.type] ?? c.type}</span> <code className="subtle">{c.id}</code></div>
      {c.type !== "tab_control" && c.type !== "tab_control_toggle" && c.type !== "tab_control_button" && (
        <label className="check pf-vis"><input type="checkbox" checked={c.visible !== false} onChange={(ev) => e((x) => { if (ev.target.checked) delete x.visible; else x.visible = false; })} />Visible</label>
      )}
    </div>
  );
  let body: ReactNode = null;
  switch (c.type) {
    case "text": body = <TextSections t={c} api={api} />; break;
    case "stack": body = <StackSections s={c} api={api} selectedState={inPackage} />; break;
    case "image": {
      const src = c.source?.light;
      body = (
        <>
          <Section title="Image">
            <Row label="Light"><AssetPicker api={api} value={src?.original} onPick={(url, w, h) => e((x) => { x.source = { ...x.source, light: imageUrls(url, w, h) }; })} /></Row>
            <Row label="Dark" hint="Optional: shown in dark mode.">{c.source?.dark ? <span className="pf-pair"><code className="pf-trunc">{c.source.dark.original}</code><button type="button" className="ib pf-x" aria-label="Remove dark image" onClick={() => e((x) => { delete x.source.dark; })}><Icon name="trash" /></button></span>
              : <AssetPicker api={api} onPick={(url, w, h) => e((x) => { x.source = { ...x.source, dark: imageUrls(url, w, h) }; })} />}</Row>
            <Row label="Fit"><Seg label="Fit" value={c.fit_mode} options={[["fit", "Fit"], ["fill", "Fill"]]} onChange={(v) => e((x) => { x.fit_mode = v; })} /></Row>
            <Row label="Size"><SizeField size={c.size} onChange={(v) => e((x) => { x.size = v; })} /></Row>
            <Row label="Mask"><span className="pf-pair">
              <Sel label="Mask" value={c.mask_shape?.type ?? "none"} options={[["none", "None"], ["rectangle", "Rounded"], ["circle", "Circle"]]} onChange={(v) => e((x) => { if (v === "none") delete x.mask_shape; else x.mask_shape = v === "circle" ? { type: "circle" } : { type: "rectangle", corners: { top_leading: 16, top_trailing: 16, bottom_leading: 16, bottom_trailing: 16 } }; })} />
              {c.mask_shape?.type === "rectangle" && <Num label="Mask radius" value={c.mask_shape.corners?.top_leading ?? 0} min={0} onChange={(r) => e((x) => { x.mask_shape = { type: "rectangle", corners: { top_leading: r, top_trailing: r, bottom_leading: r, bottom_trailing: r } }; }, `mk${c.id}`)} />}
            </span></Row>
            <Row label="Overlay"><ColorField allowNone label="Colour overlay" scheme={c.color_overlay} onChange={(v) => e((x) => { if (v) x.color_overlay = v; else delete x.color_overlay; })} /></Row>
            <Row label="Padding"><BoxField label="Padding" value={c.padding} onChange={(v) => e((x) => { x.padding = v; }, `pd${c.id}`)} /></Row>
            <Row label="Margin"><BoxField label="Margin" value={c.margin} onChange={(v) => e((x) => { x.margin = v; }, `mg${c.id}`)} /></Row>
          </Section>
        </>
      );
      break;
    }
    case "icon": body = (
      <Section title="Icon">
        <Row label="Icon"><IconPicker value={c.icon_name} onPick={(name) => e((x) => { x.icon_name = name; x.base_url = api.iconBase; x.formats = { svg: `${name}.svg`, png: `${name}.png`, heic: `${name}.png`, webp: `${name}.png` }; })} /></Row>
        <Row label="Size"><Num label="Icon size" value={c.size?.width?.value ?? 20} min={8} max={200} onChange={(v) => e((x) => { x.size = { width: { type: "fixed", value: Math.round(v) }, height: { type: "fixed", value: Math.round(v) } }; }, `is${c.id}`)} /></Row>
        <Row label="Colour"><ColorField label="Icon colour" scheme={c.color} onChange={(v) => v && e((x) => { x.color = v; })} /></Row>
        <Row label="Background"><span className="pf-pair">
          <Sel label="Icon background" value={c.icon_background ? c.icon_background.shape?.type ?? "circle" : "none"} options={[["none", "None"], ["circle", "Circle"], ["rectangle", "Rounded"]]} onChange={(v) => e((x) => {
            if (v === "none") x.icon_background = null;
            else x.icon_background = { color: x.icon_background?.color ?? { light: { type: "hex", value: "#f0f0f0ff" } }, shape: v === "circle" ? { type: "circle" } : { type: "rectangle", corners: { top_leading: 8, top_trailing: 8, bottom_leading: 8, bottom_trailing: 8 } } };
          })} />
          {c.icon_background && <ColorField label="Icon background" scheme={c.icon_background.color} onChange={(v) => v && e((x) => { x.icon_background = { ...x.icon_background, color: v }; })} />}
        </span></Row>
        <Row label="Padding"><BoxField label="Padding" value={c.padding} onChange={(v) => e((x) => { x.padding = v; }, `pd${c.id}`)} /></Row>
      </Section>
    ); break;
    case "package": body = (
      <>
        <Section title="Package">
          <Row label="Package" hint={api.packages.length ? "From the paywall's offering." : "Attach the paywall to an offering to bind packages."}>
            <Sel label="Package" value={c.package_id} options={[...api.packages.map((p) => [p.id, `${p.label} (${p.id})`] as const), ...(api.packages.some((p) => p.id === c.package_id) ? [] : [[c.package_id, `${c.package_id} (not in the offering)`] as const])]} onChange={(v) => e((x) => { x.package_id = v; })} />
          </Row>
          <Row label="Selected"><label className="check"><input type="checkbox" checked={!!c.is_selected_by_default} onChange={(ev) => api.edit(c.id, (x, doc) => {
            if (ev.target.checked) { const walk = (y: unknown): void => { if (Array.isArray(y)) return y.forEach(walk); if (y && typeof y === "object") { const o = y as Json; if (o.type === "package") o.is_selected_by_default = false; Object.values(o).forEach(walk); } }; walk(doc.components_config); }
            x.is_selected_by_default = ev.target.checked;
          })} />Selected when the paywall opens</label></Row>
        </Section>
        <StackSections s={c.stack} api={api} title="Card layout" selectedState />
      </>
    ); break;
    case "purchase_button": body = (
      <>
        <Section title="Purchase">
          <Row label="Method" hint={c.method?.type !== "in_app_checkout" ? "Web checkout opens the web purchase flow; check the store rules first." : "The store's purchase sheet for the selected package."}>
            <Sel label="Purchase method" value={c.method?.type ?? "in_app_checkout"} options={[["in_app_checkout", "In-app purchase"], ["web_checkout", "Web checkout"], ["web_product_selection", "Web product selection"]]} onChange={(v) => e((x) => { x.action = v; x.method = v === "in_app_checkout" ? { type: v } : { type: v, auto_dismiss: true, open_method: "in_app_browser" }; })} />
          </Row>
        </Section>
        <StackSections s={c.stack} api={api} title="Button layout" />
      </>
    ); break;
    case "button": {
      const a = c.action ?? {};
      const kind = a.type === "navigate_to" ? a.destination : a.type;
      body = (
        <>
          <Section title="Action">
            <Row label="Does"><Sel label="Button action" value={kind} options={[["restore_purchases", "Restore purchases"], ["navigate_back", "Close the paywall"], ["terms", "Open terms"], ["privacy_policy", "Open privacy policy"], ["url", "Open a URL"], ["customer_center", "Open Customer Center"], ["offer_code", "Redeem an offer code"]]}
              onChange={(v) => api.edit(c.id, (x, doc) => {
                if (v === "restore_purchases" || v === "navigate_back") x.action = { type: v };
                else if (v === "customer_center" || v === "offer_code") x.action = { type: "navigate_to", destination: v };
                else { const k = x.action?.url?.url_lid ?? freshId(null, "l"); doc.components_localizations[doc.default_locale]![k] ??= "https://"; x.action = { type: "navigate_to", destination: v, url: { url_lid: k, method: "in_app_browser" } }; }
              })} /></Row>
            {a.url && <Row label="URL"><input className="input mono" value={urlString(api, a.url.url_lid)} onChange={(ev) => api.setString(a.url.url_lid, ev.target.value, `u${c.id}`)} /></Row>}
            {a.url && <Row label="Opens in"><Sel label="Opens in" value={a.url.method} options={[["in_app_browser", "In-app browser"], ["external_browser", "External browser"], ["deep_link", "Deep link"]]} onChange={(v) => e((x) => { x.action.url.method = v; })} /></Row>}
          </Section>
          <StackSections s={c.stack} api={api} title="Button layout" />
        </>
      );
      break;
    }
    case "sticky_footer": body = <StackSections s={c.stack} api={api} title="Footer layout" />; break;
    case "timeline": {
      const items: Json[] = c.items ?? [];
      const strings = api.doc.components_localizations[api.locale] ?? {};
      body = (
        <>
          <Section title="Steps">
            {items.map((it, i) => (
              <div key={i} className="pf-item">
                <div className="pf-item-h"><span className="label">Step {i + 1}</span>
                  <span>
                    <button type="button" className="ib" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => e((x) => { const [m] = x.items.splice(i, 1); x.items.splice(i - 1, 0, m); })}><Icon name="up" /></button>
                    <button type="button" className="ib" aria-label={`Remove step ${i + 1}`} disabled={items.length < 2} onClick={() => e((x) => { x.items.splice(i, 1); })}><Icon name="trash" /></button>
                  </span>
                </div>
                <input className="input" aria-label={`Step ${i + 1} title`} value={String(strings[it.title.text_lid] ?? "")} onChange={(ev) => api.setString(it.title.text_lid, ev.target.value, `tt${c.id}${i}`)} />
                {it.description && <input className="input" aria-label={`Step ${i + 1} description`} value={String(strings[it.description.text_lid] ?? "")} onChange={(ev) => api.setString(it.description.text_lid, ev.target.value, `td${c.id}${i}`)} />}
                <select className="select" aria-label={`Step ${i + 1} icon`} value={it.icon?.icon_name} onChange={(ev) => e((x) => { const n2 = ev.target.value; x.items[i].icon = { ...x.items[i].icon, icon_name: n2, formats: { svg: `${n2}.svg`, png: `${n2}.png`, heic: `${n2}.png`, webp: `${n2}.png` } }; })}>
                  {PAYWALL_ICON_NAMES.map((name) => <option key={name} value={name}>{PAYWALL_ICONS[name]!.label}</option>)}
                </select>
              </div>
            ))}
            <button type="button" className="btn btn-line pf-sm" onClick={() => api.edit(c.id, (x, doc) => {
              const last = JSON.parse(JSON.stringify(x.items[x.items.length - 1])) as Json;
              const loc = doc.components_localizations[doc.default_locale]!;
              for (const part of [last.title, last.description, last.icon]) if (part) part.id = freshId(doc, part.type[0]);
              last.title.text_lid = freshId(null, "l"); loc[last.title.text_lid] = "New step";
              if (last.description) { last.description.text_lid = freshId(null, "l"); loc[last.description.text_lid] = "What happens"; }
              x.items.push(last);
            })}><Icon name="plus" />Add step</button>
          </Section>
          <Section title="Layout">
            <Row label="Step spacing"><Num label="Step spacing" value={c.item_spacing ?? 16} min={0} onChange={(v) => e((x) => { x.item_spacing = v; }, `is${c.id}`)} /></Row>
            <Row label="Gutter"><Num label="Gutter" value={c.column_gutter ?? 12} min={0} onChange={(v) => e((x) => { x.column_gutter = v; }, `cg${c.id}`)} /></Row>
            <Row label="Icon aligns"><Seg label="Icon alignment" value={c.icon_alignment ?? "title"} options={[["title", "Title"], ["title_and_description", "Title and text"]]} onChange={(v) => e((x) => { x.icon_alignment = v; })} /></Row>
            <Row label="Line colour"><ColorField label="Connector" scheme={items[0]?.connector?.color} onChange={(v) => v && e((x) => { for (const it of x.items) it.connector = { width: it.connector?.width ?? 4, margin: it.connector?.margin ?? { top: 2, bottom: 2, leading: 0, trailing: 0 }, color: v }; })} /></Row>
            <Row label="Icon colour"><ColorField label="Step icon background" scheme={items[0]?.icon?.icon_background?.color} onChange={(v) => v && e((x) => { for (const it of x.items) it.icon.icon_background = { shape: { type: "circle" }, ...(it.icon.icon_background ?? {}), color: v }; })} /></Row>
          </Section>
        </>
      );
      break;
    }
    case "tabs": {
      const tabs: Json[] = c.tabs ?? [];
      body = (
        <Section title="Tabs">
          {tabs.map((t, i) => (
            <Row key={t.id} label={`Tab ${i + 1}`}><span className="pf-pair">
              <input className="input" aria-label={`Tab ${i + 1} name`} value={t.name ?? ""} onChange={(ev) => api.edit(c.id, (x, doc) => {
                x.tabs[i].name = ev.target.value;
                // The tab button's first text shows the name.
                const btnText = (s: Json): Json | null => { for (const k of s?.components ?? []) { if (k.type === "text") return k; const r = btnText(k.stack ?? k); if (r) return r; } return null; };
                const btn = (x.control?.stack?.components ?? []).find((b: Json) => b.tab_id === t.id);
                const tx = btn ? btnText(btn.stack) : null;
                if (tx) doc.components_localizations[api.locale] = { ...(doc.components_localizations[api.locale] ?? {}), [tx.text_lid]: ev.target.value };
              }, `tn${c.id}${i}`)} />
              <button type="button" className="ib" aria-label={`Remove tab ${i + 1}`} disabled={tabs.length < 2} onClick={() => e((x) => { x.tabs.splice(i, 1); x.control.stack.components = x.control.stack.components.filter((b: Json) => b.tab_id !== t.id); if (x.default_tab_id === t.id) x.default_tab_id = x.tabs[0].id; })}><Icon name="trash" /></button>
            </span></Row>
          ))}
          <Row label="Opens on"><Sel label="Default tab" value={c.default_tab_id} options={tabs.map((t) => [t.id, t.name ?? t.id] as const)} onChange={(v) => e((x) => { x.default_tab_id = v; })} /></Row>
          <Row label="Control" hint="A toggle switches between the first two tabs.">
            <Seg label="Tab control" value={c.control?.type ?? "buttons"} options={[["buttons", "Buttons"], ["toggle", "Toggle"]]} onChange={(v) => api.edit(c.id, (x, doc) => {
              if (v === x.control.type) return;
              if (v === "toggle") {
                x.control = { type: "toggle", stack: { ...x.control.stack, components: [{ id: freshId(doc, "g"), type: "tab_control_toggle", thumb_color_on: { light: { type: "hex", value: "#ffffffff" } }, thumb_color_off: { light: { type: "hex", value: "#ffffffff" } }, track_color_on: { light: { type: "hex", value: "#111111ff" } }, track_color_off: { light: { type: "hex", value: "#d4d4d4ff" } } }] } };
              } else {
                const mk = (t: Json) => { const k = freshId(null, "l"); doc.components_localizations[doc.default_locale]![k] = t.name ?? t.id; return { id: freshId(doc, "k"), type: "tab_control_button", tab_id: t.id, stack: { id: freshId(doc, "s"), type: "stack", components: [{ id: freshId(doc, "t"), type: "text", text_lid: k, color: { light: { type: "hex", value: "#111111ff" } }, font_size: 14, font_weight: "semibold", horizontal_alignment: "center", size: { width: { type: "fit", value: null }, height: { type: "fit", value: null } }, padding: { top: 0, bottom: 0, leading: 0, trailing: 0 }, margin: { top: 0, bottom: 0, leading: 0, trailing: 0 } }], dimension: { type: "vertical", alignment: "center", distribution: "center" }, size: { width: { type: "fill", value: null }, height: { type: "fit", value: null } }, spacing: 0, padding: { top: 8, bottom: 8, leading: 8, trailing: 8 }, margin: { top: 0, bottom: 0, leading: 0, trailing: 0 }, background: null, shape: { type: "rectangle", corners: { top_leading: 8, top_trailing: 8, bottom_leading: 8, bottom_trailing: 8 } }, overrides: [{ conditions: [{ type: "selected" }], properties: { background: { type: "color", value: { light: { type: "hex", value: "#ffffffff" } } } } }] } }; };
                x.control = { type: "buttons", stack: { ...x.control.stack, dimension: { type: "horizontal", alignment: "center", distribution: "start" }, components: x.tabs.map(mk) } };
              }
            })} />
          </Row>
          <button type="button" className="btn btn-line pf-sm" onClick={() => api.edit(c.id, (x, doc) => {
            const id = freshId(doc, "x");
            const k = freshId(null, "l"); doc.components_localizations[doc.default_locale]![k] = `Tab ${x.tabs.length + 1}`;
            const copy = JSON.parse(JSON.stringify(x.tabs[x.tabs.length - 1].stack)) as Json;
            const reid = (y: unknown) => { if (Array.isArray(y)) return y.forEach(reid); if (y && typeof y === "object") { const o = y as Json; if (typeof o.type === "string" && typeof o.id === "string") o.id = freshId(doc, o.id); Object.values(o).forEach(reid); } };
            reid(copy);
            x.tabs.push({ id, name: `Tab ${x.tabs.length + 1}`, stack: copy });
            if (x.control.type === "buttons" && x.control.stack.components[0]) {
              const b = JSON.parse(JSON.stringify(x.control.stack.components[0])) as Json; reid(b); b.tab_id = id;
              const t0 = (s: Json): Json | null => { for (const q of s.components ?? []) { if (q.type === "text") return q; const r = t0(q); if (r) return r; } return null; };
              const tx = t0(b.stack); if (tx) tx.text_lid = k;
              x.control.stack.components.push(b);
            }
          })}><Icon name="plus" />Add tab</button>
        </Section>
      );
      break;
    }
    case "tab_control_button": body = <StackSections s={c.stack} api={api} title="Tab button" selectedState />; break;
    case "tab_control_toggle": body = (
      <Section title="Toggle">
        <Row label="Track on"><ColorField label="Track on" scheme={c.track_color_on} onChange={(v) => v && e((x) => { x.track_color_on = v; })} /></Row>
        <Row label="Track off"><ColorField label="Track off" scheme={c.track_color_off} onChange={(v) => v && e((x) => { x.track_color_off = v; })} /></Row>
        <Row label="Thumb on"><ColorField label="Thumb on" scheme={c.thumb_color_on} onChange={(v) => v && e((x) => { x.thumb_color_on = v; })} /></Row>
        <Row label="Thumb off"><ColorField label="Thumb off" scheme={c.thumb_color_off} onChange={(v) => v && e((x) => { x.thumb_color_off = v; })} /></Row>
      </Section>
    ); break;
    case "tab_control": body = <Section title="Tab control"><p className="subtle pf-note">Marks where the tab buttons show in this tab. Style the buttons on the Tabs component's “Tab control” group.</p></Section>; break;
    case "carousel": body = (
      <Section title="Carousel">
        <Row label="Pages"><span className="pf-pair"><b>{c.pages?.length ?? 0}</b>
          <button type="button" className="btn btn-line pf-sm" onClick={() => api.edit(c.id, (x, doc) => {
            const copy = JSON.parse(JSON.stringify(x.pages[x.pages.length - 1])) as Json;
            const reid = (y: unknown) => { if (Array.isArray(y)) return y.forEach(reid); if (y && typeof y === "object") { const o = y as Json; if (typeof o.type === "string" && typeof o.id === "string") o.id = freshId(doc, o.id); for (const [k, v] of Object.entries(o)) { if (k === "text_lid" && typeof v === "string") { const nk = freshId(null, "l"); for (const t of Object.values(doc.components_localizations)) if (v in t) t[nk] = t[v]!; o[k] = nk; } else reid(v); } } };
            reid(copy); x.pages.push(copy);
          })}><Icon name="plus" />Add page</button>
          <button type="button" className="btn btn-line pf-sm" disabled={(c.pages?.length ?? 0) < 2} onClick={() => e((x) => { x.pages.pop(); x.initial_page_index = Math.min(x.initial_page_index, x.pages.length - 1); })}>Remove last</button>
        </span></Row>
        <Row label="Peek"><Num label="Page peek" value={c.page_peek ?? 0} min={0} max={80} onChange={(v) => e((x) => { x.page_peek = Math.round(v); }, `pk${c.id}`)} /></Row>
        <Row label="Spacing"><Num label="Page spacing" value={c.page_spacing ?? 0} min={0} onChange={(v) => e((x) => { x.page_spacing = Math.round(v); }, `ps${c.id}`)} /></Row>
        <Row label="Loop"><label className="check"><input type="checkbox" checked={!!c.loop} onChange={(ev) => e((x) => { x.loop = ev.target.checked; })} />Back to the first page after the last</label></Row>
        <Row label="Auto-advance" hint="Seconds per page; 0 turns it off."><Num label="Seconds per page" value={c.auto_advance ? c.auto_advance.ms_time_per_page / 1000 : 0} min={0} max={60} onChange={(v) => e((x) => { if (!v) delete x.auto_advance; else x.auto_advance = { ms_time_per_page: Math.round(v * 1000), ms_transition_time: 400, transition_type: "slide" }; }, `aa${c.id}`)} /></Row>
        <Row label="Dots"><span className="pf-pair">
          <Sel label="Page control position" value={c.page_control?.position ?? "none"} options={[["none", "Hidden"], ["bottom", "Bottom"], ["top", "Top"]]} onChange={(v) => e((x) => {
            if (v === "none") delete x.page_control;
            else x.page_control = { spacing: 6, padding: { top: 10, bottom: 10, leading: 0, trailing: 0 }, margin: { top: 0, bottom: 0, leading: 0, trailing: 0 }, default: { width: 6, height: 6, color: { light: { type: "hex", value: "#d4d4d4ff" } } }, active: { width: 18, height: 6, color: { light: { type: "hex", value: "#111111ff" } } }, ...(x.page_control ?? {}), position: v };
          })} />
          {c.page_control && <ColorField label="Active dot" scheme={c.page_control.active?.color} onChange={(v) => v && e((x) => { x.page_control.active = { ...x.page_control.active, color: v }; })} />}
        </span></Row>
      </Section>
    ); break;
    case "countdown": {
      const local = (() => { const d = new Date(c.style?.date ?? Date.now()); return Number.isNaN(d.getTime()) ? "" : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); })();
      body = (
        <Section title="Countdown">
          <Row label="Ends at" hint="Your local time; stored in UTC."><input className="input" type="datetime-local" value={local} onChange={(ev) => { const t = Date.parse(ev.target.value); if (!Number.isNaN(t)) e((x) => { x.style = { type: "date", date: new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z") }; }); }} /></Row>
          <Row label="Counts from"><Seg label="Counts from" value={c.count_from} options={[["days", "Days"], ["hours", "Hours"], ["minutes", "Minutes"]]} onChange={(v) => e((x) => { x.count_from = v; })} /></Row>
          <p className="subtle pf-note">Texts inside can use {"{{ count_days_with_zero }}"}, {"{{ count_hours_with_zero }}"}, {"{{ count_minutes_with_zero }}"} and {"{{ count_seconds_with_zero }}"}.</p>
          <Row label="After it ends">{c.end_stack ? <button type="button" className="linkbtn" onClick={() => e((x) => { delete x.end_stack; })}>Remove the “ended” content</button>
            : <button type="button" className="btn btn-line pf-sm" onClick={() => api.edit(c.id, (x, doc) => { const copy = JSON.parse(JSON.stringify(x.countdown_stack)); const reid = (y: unknown) => { if (Array.isArray(y)) return y.forEach(reid); if (y && typeof y === "object") { const o = y as Json; if (typeof o.type === "string" && typeof o.id === "string") o.id = freshId(doc, o.id); Object.values(o).forEach(reid); } }; reid(copy); x.end_stack = copy; })}>Add “ended” content</button>}</Row>
        </Section>
      );
      break;
    }
    case "video": {
      const src = c.source?.light ?? {};
      body = (
        <Section title="Video">
          <Row label="URL" hint="An MP4 or HLS URL the device can stream."><input className="input mono" placeholder="https://…" value={src.url ?? ""} onChange={(ev) => e((x) => { x.source = { ...x.source, light: { ...x.source.light, url: ev.target.value } }; }, `vu${c.id}`)} /></Row>
          <Row label="Poster" hint="Shown while the video loads.">{c.fallback_source ? <span className="pf-pair"><code className="pf-trunc">{c.fallback_source.light.original}</code><button type="button" className="ib pf-x" aria-label="Remove poster" onClick={() => e((x) => { delete x.fallback_source; })}><Icon name="trash" /></button></span>
            : <AssetPicker api={api} onPick={(url, w, h) => e((x) => { x.fallback_source = { light: imageUrls(url, w, h) }; })} />}</Row>
          <Row label="Playback"><span className="pf-stackcol">
            {(["auto_play", "loop", "mute_audio", "show_controls"] as const).map((k) => <label key={k} className="check"><input type="checkbox" checked={!!c[k]} onChange={(ev) => e((x) => { x[k] = ev.target.checked; })} />{{ auto_play: "Autoplay", loop: "Loop", mute_audio: "Muted", show_controls: "Show controls" }[k]}</label>)}
          </span></Row>
          <Row label="Fit"><Seg label="Fit" value={c.fit_mode} options={[["fit", "Fit"], ["fill", "Fill"]]} onChange={(v) => e((x) => { x.fit_mode = v; })} /></Row>
          <Row label="Size"><SizeField size={c.size} onChange={(v) => e((x) => { x.size = v; })} /></Row>
        </Section>
      );
      break;
    }
    case "web_view": body = (
      <Section title="Web view">
        <Row label="URL" hint="A resolved https URL. The SDK shows it inside the paywall."><input className="input mono" placeholder="https://…" value={c.url ?? ""} onChange={(ev) => e((x) => { x.url = ev.target.value; }, `wu${c.id}`)} /></Row>
        <Row label="Size"><SizeField size={c.size} onChange={(v) => e((x) => { x.size = v; })} /></Row>
      </Section>
    ); break;
    default: body = <p className="subtle pf-note">This component has no editor yet. Change it in the JSON tab.</p>;
  }
  return <div className="pf" aria-label={`${TYPE_LABEL[c.type] ?? c.type} properties`}>{head}{body}</div>;
}

