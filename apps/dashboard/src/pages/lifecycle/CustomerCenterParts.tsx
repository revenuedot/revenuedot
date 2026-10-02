/**
 * Customer Center editor parts (prd/customer-center/PRD.md): translations dialog, promotional offer picker, the
 * Appearance and Localization tabs, and the phone preview. The preview renders `sdkCustomerCenter`, the same function
 * the server uses for `GET /v1/customercenter/{id}`, so what it shows is what the SDK receives.
 */
import { useEffect, useMemo, useState } from "react";
import {
  CC_BUILTIN, CC_COLOR_KEYS, CC_LANGUAGES, CC_STRINGS, ccStringFor, resolveCcOfferRefs, sdkCustomerCenter,
  type CcConfig, type CcOfferRef, type CcPromotionalOffer,
} from "@revenuedot/core/customer-center";
import { Dialog, Field, Panel, Segmented, Tag } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { RetentionOffer } from "./lib";

type Json = Record<string, any>;
type Update = (fn: (c: CcConfig) => void) => void;
const LANG_NAME = Object.fromEntries(CC_LANGUAGES.map((l) => [l.code, l.name]));

// ---------- Translations ----------

/** "Edit translations" link and dialog for one text: a field per language, the built-in translation as placeholder. */
export function TranslateButton({ label, english, value, onSave }: { label: string; english: string; value: Record<string, string> | undefined; onSave: (v: Record<string, string> | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const n = Object.keys(value ?? {}).length;
  return (
    <>
      <button type="button" className="linkbtn label-link" aria-label={`Edit translations: ${label}`} onClick={() => setOpen(true)}>Edit translations{n ? ` (${n})` : ""}</button>
      {open && <TranslateDialog label={label} english={english} value={value} onClose={() => setOpen(false)} onSave={(v) => { onSave(v); setOpen(false); }} />}
    </>
  );
}

function TranslateDialog({ label, english, value, onSave, onClose }: { label: string; english: string; value: Record<string, string> | undefined; onSave: (v: Record<string, string> | undefined) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({ ...(value ?? {}) });
  const [filter, setFilter] = useState("");
  const langs = CC_LANGUAGES.filter((l) => l.code !== "en" && (!filter || l.name.toLowerCase().includes(filter.toLowerCase())));
  const save = () => {
    const clean = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    onSave(Object.keys(clean).length ? clean : undefined);
  };
  return (
    <Dialog title={`Translations: ${label}`} onClose={onClose} footer={<>
      <button type="button" className="btn btn-line" onClick={onClose}>Cancel</button>
      <button type="button" className="btn btn-dark" onClick={save}>Save translations</button>
    </>}>
      <div className="stack tight">
        <p className="section-sub">English: <b>{english || "—"}</b>. Empty languages show the built-in translation (when the text is a default one) or the English text.</p>
        <input className="input" aria-label="Filter languages" placeholder="Filter languages" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="cc-trans">
          {langs.map((l) => (
            <label key={l.code} className="cc-trans-row">
              <span>{l.name} <small className="mono subtle">{l.code}</small></span>
              <input className="input" aria-label={`${l.name} translation`} value={draft[l.code] ?? ""} placeholder={CC_BUILTIN[l.code]?.phrases[english] ?? english}
                onChange={(e) => setDraft((d) => ({ ...d, [l.code]: e.target.value }))} />
            </label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---------- Promotional offers ----------

type OfferValue = CcPromotionalOffer | CcOfferRef | null | undefined;
const isRef = (v: OfferValue): v is CcOfferRef => !!v && typeof (v as CcOfferRef).retention_offer_id === "string";
const STORE: Record<string, string> = { app_store: "App Store", play_store: "Google Play" };

/**
 * Picks a path's or survey answer's promotional offer: (paths only) the Retention offers for the trigger, none, one
 * Retention offer by reference, or an offer of its own with a product → store offer id mapping.
 */
export function OfferPicker({ idBase, label = "Promotional offer", value, onChange, offers, trigger, allowAuto, error }: {
  idBase: string; label?: string; value: OfferValue; onChange: (v: OfferValue) => void; offers: RetentionOffer[]; trigger: "cancel" | "refund"; allowAuto?: boolean; error?: string | null;
}) {
  const mode = value === undefined ? (allowAuto ? "auto" : "none") : value === null ? "none" : isRef(value) ? `ref:${value.retention_offer_id}` : "custom";
  const refMissing = isRef(value) && !offers.some((o) => o.id === value.retention_offer_id);
  const own = !isRef(value) && value ? value : null;
  const mapping = Object.entries(own?.product_mapping ?? {});
  const setOwn = (patch: Partial<CcPromotionalOffer>) => onChange({ ...(own ?? { title: "", product_mapping: {} }), ...patch });
  const sorted = [...offers].sort((a, b) => (a.trigger === trigger ? 0 : 1) - (b.trigger === trigger ? 0 : 1));
  return (
    <div className="stack tight">
      <select id={idBase} className="select" aria-label={label} value={mode} onChange={(e) => {
        const v = e.target.value;
        onChange(v === "auto" ? undefined : v === "none" ? (allowAuto ? null : undefined) : v === "custom" ? { title: "", subtitle: "", product_mapping: { "": "" } } : { retention_offer_id: v.slice(4) });
      }}>
        {allowAuto && <option value="auto">Active Retention offers for {trigger === "cancel" ? "cancellations" : "refunds"}</option>}
        <option value="none">No offer</option>
        {sorted.map((o) => <option key={o.id} value={`ref:${o.id}`}>{o.name} · {o.trigger === "cancel" ? "cancel" : "refund"} · {STORE[o.store] ?? o.store}{o.active ? "" : " (off)"}</option>)}
        {refMissing && <option value={mode}>Deleted offer</option>}
        <option value="custom">Offer of its own…</option>
      </select>
      {refMissing && <span className="err" role="alert">This Retention offer was deleted. Pick another one.</span>}
      {own && (
        <div className="cc-offer">
          <div className="form-grid">
            <Field label="Offer title" htmlFor={`${idBase}-title`}><input id={`${idBase}-title`} className="input" value={own.title} onChange={(e) => setOwn({ title: e.target.value })} /></Field>
            <Field label="Offer subtitle" htmlFor={`${idBase}-sub`}><input id={`${idBase}-sub`} className="input" value={own.subtitle ?? ""} onChange={(e) => setOwn({ subtitle: e.target.value })} /></Field>
          </div>
          <div className="label" style={{ margin: "8px 0 4px" }}>Products and store offer ids</div>
          {mapping.map(([prod, off], i) => (
            <div key={i} className="inline-row" style={{ marginBottom: 6 }}>
              <input className="input mono" aria-label={`Product id ${i + 1}`} placeholder="pro_monthly" value={prod}
                onChange={(e) => setOwn({ product_mapping: Object.fromEntries(mapping.map(([p, o], j) => (j === i ? [e.target.value, o] : [p, o]))) })} />
              <input className="input mono" aria-label={`Store offer id ${i + 1}`} placeholder="App Store or Google Play offer id" value={off}
                onChange={(e) => setOwn({ product_mapping: Object.fromEntries(mapping.map(([p, o], j) => (j === i ? [p, e.target.value] : [p, o]))) })} />
              <button type="button" className="ib" aria-label={`Remove product ${i + 1}`} disabled={mapping.length <= 1} onClick={() => setOwn({ product_mapping: Object.fromEntries(mapping.filter((_, j) => j !== i)) })}><Icon name="trash" /></button>
            </div>
          ))}
          <button type="button" className="btn btn-line" disabled={mapping.some(([p]) => !p)} onClick={() => setOwn({ product_mapping: { ...own.product_mapping, "": "" } })}><Icon name="plus" />Add product</button>
        </div>
      )}
      {error && <span className="err" role="alert">{error}</span>}
    </div>
  );
}

// ---------- Appearance ----------

const COLOR_LABEL: Record<string, string> = { accent_color: "Accent", text_color: "Text", background_color: "Background", button_text_color: "Button text", button_background_color: "Button background" };
const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function AppearanceTab({ cfg, update, offers }: { cfg: CcConfig; update: Update; offers: RetentionOffer[] }) {
  const [mode, setMode] = useState<"light" | "dark">("light");
  return (
    <div className="two cc-two">
      <div className="stack">
        <p className="section-sub">Colours the Customer Center uses in each mode. Empty colours keep the system default of the device.</p>
        {(["light", "dark"] as const).map((m) => (
          <Panel key={m} title={m === "light" ? "Light mode" : "Dark mode"}>
            <div className="cc-colors">
              {CC_COLOR_KEYS.map((k) => {
                const v = (cfg.appearance[m] as Record<string, string | undefined>)[k] ?? "";
                const bad = !!v && !HEX.test(v);
                const set = (nv: string) => update((c) => { const a = c.appearance[m] as Record<string, string | undefined>; if (nv) a[k] = nv; else delete a[k]; });
                return (
                  <div key={k} className="field cc-color">
                    <label className="label" htmlFor={`cc-${m}-${k}`}>{COLOR_LABEL[k]}</label>
                    <div className="inline-row">
                      <input type="color" className="cc-swatch" aria-label={`${m === "light" ? "Light" : "Dark"} ${COLOR_LABEL[k]} colour picker`} value={HEX.test(v) ? v.slice(0, 7) : "#000000"} onChange={(e) => set(e.target.value.toUpperCase())} />
                      <input id={`cc-${m}-${k}`} className="input mono" placeholder="System default" value={v} onChange={(e) => set(e.target.value.trim())} aria-invalid={bad} />
                      <button type="button" className="ib" aria-label={`Clear ${m} ${COLOR_LABEL[k]}`} disabled={!v} onClick={() => set("")}><Icon name="close" /></button>
                    </div>
                    {bad && <span className="err" role="alert">Use a hex colour such as #1A1A1A.</span>}
                  </div>
                );
              })}
            </div>
          </Panel>
        ))}
      </div>
      <div className="cc-side stack tight">
        <Segmented label="Preview mode" value={mode} onChange={setMode} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        <CcPhone cfg={cfg} offers={offers} dark={mode === "dark"} screen="MANAGEMENT" lang="en" width={280} />
      </div>
    </div>
  );
}

// ---------- Localization ----------

export function LocalizationTab({ cfg, update }: { cfg: CcConfig; update: Update }) {
  const [lang, setLang] = useState("en");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const custom = cfg.localization.custom_strings?.[lang] ?? {};
  const keys = Object.keys(CC_STRINGS);
  const list = keys.filter((k) => !search || k.includes(search.toLowerCase()) || CC_STRINGS[k]!.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => setPicked(new Set()), [lang]);
  const setCustom = (key: string, value: string | null) => update((c) => {
    const cs = (c.localization.custom_strings ??= {});
    const l = (cs[lang] ??= {});
    if (value === null) delete l[key]; else l[key] = value;
    if (!Object.keys(l).length) delete cs[lang];
    if (!Object.keys(cs).length) delete c.localization.custom_strings;
  });
  const counts = Object.fromEntries(Object.entries(cfg.localization.custom_strings ?? {}).map(([k, v]) => [k, Object.keys(v).length]));
  return (
    <div className="stack">
      <p className="section-sub">The Customer Center comes translated into {CC_LANGUAGES.length} languages and follows the customer's device language. Override any predefined text per language with a custom string.</p>
      <div className="inline-row">
        <Field label="Language" htmlFor="cc-lang">
          <select id="cc-lang" className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
            {CC_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}{counts[l.code] ? ` (${counts[l.code]} custom)` : ""}</option>)}
          </select>
        </Field>
      </div>
      <section className="panel" aria-label="Custom strings">
        <div className="ph"><b>Custom strings · {LANG_NAME[lang]}</b>
          <button type="button" className="btn btn-line" disabled={!picked.size} onClick={() => { for (const k of picked) setCustom(k, null); setPicked(new Set()); }}>Delete selected{picked.size ? ` (${picked.size})` : ""}</button>
        </div>
        {Object.keys(custom).length === 0 ? <div className="pb subtle" style={{ fontSize: 13 }}>No custom strings for {LANG_NAME[lang]}. Override a predefined string below.</div> : (
          <div className="tbl"><table>
            <thead><tr><th style={{ width: 32 }}><span className="sr">Select</span></th><th>Key</th><th>Text</th></tr></thead>
            <tbody>
              {Object.entries(custom).map(([k, v]) => (
                <tr key={k}>
                  <td><input type="checkbox" aria-label={`Select ${k}`} checked={picked.has(k)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} /></td>
                  <td className="mono" style={{ fontSize: 12 }}>{k}</td>
                  <td><input id={`cc-custom-${k}`} className="input" aria-label={`Custom text for ${k}`} value={v} onChange={(e) => setCustom(k, e.target.value)} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      <section className="panel" aria-label="Predefined strings">
        <div className="ph"><b>Predefined strings</b><input className="input cc-search" aria-label="Search strings" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="tbl"><table>
          <thead><tr><th>Key</th><th>{LANG_NAME[lang]} text</th><th /></tr></thead>
          <tbody>
            {list.map((k) => {
              const s = ccStringFor(cfg as unknown as Json, lang, k);
              return (
                <tr key={k}>
                  <td className="mono" style={{ fontSize: 12 }}>{k}</td>
                  <td>{s.value}{s.source !== "default" && <> <Tag tone={s.source === "custom" ? "gold" : "muted"}>{s.source}</Tag></>}</td>
                  <td className="amt">
                    {s.source === "custom"
                      ? <button type="button" className="btn btn-line" onClick={() => setCustom(k, null)}>Remove</button>
                      : <button type="button" className="btn btn-line" aria-label={`Override ${k}`} onClick={() => { setCustom(k, s.value); setTimeout(() => document.getElementById(`cc-custom-${k}`)?.focus(), 0); }}>Override</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}

// ---------- Preview ----------

/** The SDK shape the server would send, with Retention offers resolved from the list the page already loaded. */
function previewShape(cfg: CcConfig, offers: RetentionOffer[], lang: string): Json {
  const asOffer = (o: RetentionOffer) => ({ title: o.title, subtitle: o.subtitle, product_mapping: o.product_mapping });
  let c = resolveCcOfferRefs(cfg as unknown as Json, (id) => { const o = offers.find((x) => x.id === id && x.active); return o ? asOffer(o) : null; });
  const auto = (t: string) => { const o = offers.find((x) => x.active && x.trigger === t); return o ? asOffer(o) : undefined; };
  c = { ...c, screens: Object.fromEntries(Object.entries(c.screens as Json).map(([k, s]) => [k, { ...s, paths: (s.paths as Json[]).map((p) => {
    const t = p.type === "CANCEL" ? "cancel" : p.type === "REFUND_REQUEST" ? "refund" : null;
    return t && p.promotional_offer === undefined && auto(t) ? { ...p, promotional_offer: auto(t) } : p;
  }) }])) };
  return sdkCustomerCenter(c, { preferredLocales: lang === "en" ? "en_US" : lang });
}

type View = { kind: "home" } | { kind: "survey"; path: Json } | { kind: "offer"; offer: Json } | { kind: "done"; text: string };

export function CcPhone({ cfg, offers, dark, screen, lang, width = 300 }: { cfg: CcConfig; offers: RetentionOffer[]; dark: boolean; screen: "MANAGEMENT" | "NO_ACTIVE"; lang: string; width?: number }) {
  const sdk = useMemo(() => previewShape(cfg, offers, lang), [cfg, offers, lang]);
  const [view, setView] = useState<View>({ kind: "home" });
  useEffect(() => setView({ kind: "home" }), [screen, lang]);
  const W = 390, H = 844, scale = width / W;
  const colors = (sdk.appearance[dark ? "dark" : "light"] ?? {}) as Record<string, string>;
  const fg = colors.text_color ?? (dark ? "#FFFFFF" : "#111111");
  const bg = colors.background_color ?? (dark ? "#000000" : "#F2F2F7");
  const card = dark ? "rgba(255,255,255,.08)" : "#FFFFFF";
  const accent = colors.accent_color ?? fg;
  const btnBg = colors.button_background_color ?? fg;
  const btnFg = colors.button_text_color ?? bg;
  const str = (k: string) => (sdk.localization.localized_strings as Record<string, string>)[k] ?? CC_STRINGS[k] ?? k;
  const sc = sdk.screens[screen] as Json;
  const tap = (p: Json) => {
    if (p.type === "CANCEL" && p.feedback_survey) setView({ kind: "survey", path: p });
    else if (p.promotional_offer) setView({ kind: "offer", offer: p.promotional_offer });
    else setView({ kind: "done", text: p.type === "CUSTOM_URL" ? `Opens ${p.url} ${p.open_method === "IN_APP" ? "in the app" : "in the browser"}` : p.type === "CUSTOM_ACTION" ? `Calls your app with "${p.action_identifier}"` : p.type === "MISSING_PURCHASE" ? str("purchases_restoring") : p.type === "CANCEL" ? "Opens the store's subscription management" : p.type === "REFUND_REQUEST" ? "Opens the refund request sheet" : "Shows the plans of this subscription group" });
  };
  const row = (key: string, text: string, onClick?: () => void) => (
    <button key={key} type="button" className="cc-ph-row" style={{ color: accent, background: card }} onClick={onClick}>{text}<span aria-hidden style={{ color: fg, opacity: .35 }}>›</span></button>
  );
  return (
    <figure className="pwr-phone cc-phone" aria-label={`Customer Center preview, ${screen === "MANAGEMENT" ? "active subscription" : "no active subscription"}, ${dark ? "dark" : "light"} mode`} style={{ width: width + 16, margin: 0 }}>
      <div className="pwr-bezel" style={{ width: width + 16, height: H * scale + 16 }}>
        <div className="pwr-screen" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "top left", background: bg, color: fg, colorScheme: dark ? "dark" : "light" }}>
          <div className="pwr-body cc-ph-body">
            <div style={{ height: 54, flex: "none" }} aria-hidden />
            {view.kind !== "home" && <button type="button" className="cc-ph-back" style={{ color: accent }} onClick={() => setView({ kind: "home" })}>‹ {str("dismiss")}</button>}
            {view.kind === "home" && <>
              <h3 className="cc-ph-title" data-testid="cc-preview-title">{sc.title}</h3>
              {sc.subtitle && <p className="cc-ph-sub">{sc.subtitle}</p>}
              {screen === "MANAGEMENT" && (
                <div className="cc-ph-card" style={{ background: card }}>
                  <b>Pro</b><span style={{ opacity: .6 }}>{str("billing_cycle")}: 1 month · {str("current_price")}: $9.99</span>
                </div>
              )}
              <div className="cc-ph-list" data-testid="cc-preview-paths">{(sc.paths as Json[]).map((p) => row(p.id, p.title, () => tap(p)))}</div>
              {sdk.support.display_purchase_history_link && screen === "MANAGEMENT" && <div className="cc-ph-list">{row("history", str("screen_purchase_history_title"))}</div>}
              <div style={{ flex: 1 }} />
              <button type="button" className="cc-ph-btn" style={{ background: btnBg, color: btnFg }}>{str("contact_support")}</button>
            </>}
            {view.kind === "survey" && <>
              <h3 className="cc-ph-title">{view.path.feedback_survey.title}</h3>
              <div className="cc-ph-list">{(view.path.feedback_survey.options as Json[]).map((o) => row(o.id, o.title, () => (o.promotional_offer ? setView({ kind: "offer", offer: o.promotional_offer }) : setView({ kind: "done", text: "Opens the store's subscription management" }))))}</div>
            </>}
            {view.kind === "offer" && <>
              <div style={{ flex: 1 }} />
              <h3 className="cc-ph-title" style={{ textAlign: "center" }}>{view.offer.title}</h3>
              {view.offer.subtitle && <p className="cc-ph-sub" style={{ textAlign: "center" }}>{view.offer.subtitle}</p>}
              <p className="cc-ph-sub mono" style={{ textAlign: "center", fontSize: 13 }}>{Object.entries(view.offer.product_mapping as Record<string, string>).map(([p, o]) => `${p} → ${o}`).join(", ")}</p>
              <div style={{ flex: 1 }} />
              <button type="button" className="cc-ph-btn" style={{ background: btnBg, color: btnFg }}>{view.offer.title}</button>
              <button type="button" className="cc-ph-btn plain" style={{ color: accent }} onClick={() => setView({ kind: "home" })}>{str("no_thanks")}</button>
            </>}
            {view.kind === "done" && <><div style={{ flex: 1 }} /><p className="cc-ph-sub" style={{ textAlign: "center" }}>{view.text}</p><div style={{ flex: 1 }} /></>}
          </div>
          <div className="pwr-island" aria-hidden />
        </div>
      </div>
    </figure>
  );
}

export function PreviewDialog({ cfg, offers, onClose }: { cfg: CcConfig; offers: RetentionOffer[]; onClose: () => void }) {
  const [screen, setScreen] = useState<"MANAGEMENT" | "NO_ACTIVE">("MANAGEMENT");
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [lang, setLang] = useState("en");
  return (
    <Dialog title="Customer Center preview" onClose={onClose}>
      <div className="stack tight cc-preview">
        <div className="inline-row">
          <Segmented label="Customer" value={screen} onChange={setScreen} options={[{ value: "MANAGEMENT", label: "Active subscription" }, { value: "NO_ACTIVE", label: "No subscription" }]} />
          <Segmented label="Mode" value={mode} onChange={setMode} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          <select className="select sm" aria-label="Preview language" value={lang} onChange={(e) => setLang(e.target.value)}>
            {CC_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </div>
        <p className="subtle" style={{ margin: 0, fontSize: 12 }}>Shows the unsaved configuration as the SDK would receive it. Tap a path to follow it; the store's own sheets are not shown.</p>
        <div className="cc-preview-stage"><CcPhone cfg={cfg} offers={offers} dark={mode === "dark"} screen={screen} lang={lang} width={300} /></div>
      </div>
    </Dialog>
  );
}
