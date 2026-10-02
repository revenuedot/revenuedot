/*
 * The web preview of a paywall: renders the components JSON the SDKs get, with the layout rules RevenueCatUI uses
 * (purchases-ios RevenueCatUI/Templates/V2): stacks are flexboxes (vertical, horizontal) or overlays (zlayer); sizes are
 * fit, fill, fixed or relative; the sticky footer is pinned under a scrolling body; overrides apply for the selected
 * package, the selected tab and intro-offer eligibility; colours switch between light and dark; `{{ product.* }}` and
 * countdown variables are filled with the offering's real products where known (Test Store price, duration) and sample
 * prices otherwise (preview-values.ts). Used by the gallery thumbnails and the editor, so both show exactly
 * the JSON that is published.
 */
import { Component as ReactComponent, createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PAYWALL_ICONS, type Json, type PaywallDoc } from "@revenuedot/core";
import { productValues, type PreviewProduct } from "./preview-values";

export interface PreviewState { dark: boolean; locale: string; intro: boolean }
interface Ctx {
  strings: Record<string, unknown>;
  dark: boolean;
  intro: boolean;
  selectedPkg: string | null;
  setSelectedPkg: (id: string) => void;
  tabs: Record<string, string>;
  setTab: (tabsId: string, tabId: string) => void;
  now: number;
  /** Editor: the selected component id, and a click handler that selects. */
  focus?: string | null;
  onPick?: (id: string) => void;
  /** Inside a package: its id (for variables) and whether it is the selected one. */
  pkg: string | null;
  pkgSelected: boolean;
  tabSelected: boolean;
  /** Inside a countdown: remaining milliseconds. */
  remaining: number | null;
  /** The active tab control of the enclosing tabs component, rendered where `tab_control` sits. */
  control: (() => ReactNode) | null;
  /** Real products of the offering's packages (Test Store price, duration, name); samples fill the rest. */
  prices?: Record<string, PreviewProduct>;
  /** Every package identifier in the paywall, for `product.relative_discount`. */
  packages: string[];
  /** The previewed locale: price and period words follow it, as on devices. */
  locale: string;
}
const C = createContext<Ctx | null>(null);
const useC = () => useContext(C)!;

// ---- Values ---------------------------------------------------------------------------------------------------------

/** Named colours of the project's Brand presets (`ui_config.app.colors`), for `{ "type": "alias" }` colours. Set by the editor. */
let ALIASES: Record<string, { light: Json; dark: Json }> = {};
export function setColorAliases(a: Record<string, { light: Json; dark: Json }>) { ALIASES = a; }

function color(scheme: unknown, dark: boolean): string | undefined {
  const s = scheme as Json | undefined;
  if (!s || typeof s !== "object") return undefined;
  const info = (dark && s.dark) || s.light;
  return colorInfo(info, dark);
}
function colorInfo(info: Json | undefined, dark = false): string | undefined {
  if (!info) return undefined;
  // Like the SDKs: an alias takes the preset's light or dark side; an unknown alias draws nothing.
  if (info.type === "alias" && typeof info.value === "string") { const a = ALIASES[info.value]; return a ? colorInfo(dark ? a.dark : a.light) : "transparent"; }
  if (info.type === "hex" && typeof info.value === "string") return hexCss(info.value);
  if ((info.type === "linear" || info.type === "radial") && Array.isArray(info.points)) {
    const stops = info.points.map((p: Json) => `${hexCss(p.color)} ${p.percent}%`).join(", ");
    return info.type === "linear" ? `linear-gradient(${info.degrees ?? 180}deg, ${stops})` : `radial-gradient(circle, ${stops})`;
  }
  return undefined;
}
function hexCss(v: string) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v ?? "");
  if (!m) return "transparent";
  if (!m[2]) return `#${m[1]}`;
  return `rgba(${parseInt(m[1]!.slice(0, 2), 16)}, ${parseInt(m[1]!.slice(2, 4), 16)}, ${parseInt(m[1]!.slice(4, 6), 16)}, ${(parseInt(m[2], 16) / 255).toFixed(3)})`;
}
const px = (n: unknown) => (typeof n === "number" ? `${n}px` : undefined);
const box = (p: Json | undefined) => (p ? `${p.top ?? 0}px ${p.trailing ?? 0}px ${p.bottom ?? 0}px ${p.leading ?? 0}px` : undefined);
const radius = (shape: Json | undefined) => {
  if (!shape) return undefined;
  if (shape.type === "pill" || shape.type === "circle") return "9999px";
  const c = shape.corners;
  return c ? `${c.top_leading ?? 0}px ${c.top_trailing ?? 0}px ${c.bottom_trailing ?? 0}px ${c.bottom_leading ?? 0}px` : undefined;
};
const WEIGHT: Record<string, number> = { thin: 100, extra_light: 200, light: 300, regular: 400, medium: 500, semibold: 600, bold: 700, extra_bold: 800, black: 900 };
const NAMED: Record<string, number> = { heading_xxl: 40, heading_xl: 34, heading_l: 28, heading_m: 24, heading_s: 20, heading_xs: 16, body_xl: 18, body_l: 17, body_m: 15, body_s: 13 };

const two = (n: number) => String(Math.max(0, n)).padStart(2, "0");
function fill(text: string, c: Ctx): string {
  return text.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g, (all, key: string, fn?: string) => {
    let v: string | undefined;
    if (key.startsWith("count_")) {
      const ms = Math.max(0, c.remaining ?? 0);
      const d = Math.floor(ms / 86_400_000), h = Math.floor(ms / 3_600_000) % 24, m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
      const map: Record<string, string> = { count_days_with_zero: two(d), count_days_without_zero: String(d), count_hours_with_zero: two(h), count_hours_without_zero: String(h), count_minutes_with_zero: two(m), count_minutes_without_zero: String(m), count_seconds_with_zero: two(s), count_seconds_without_zero: String(s) };
      v = map[key];
    } else v = productValues(c.pkg ?? c.selectedPkg, c.prices, c.packages, c.locale)[key];
    // Own keys only: `{{ constructor }}` must stay as typed, not print Object's source.
    if (typeof v !== "string") return all;
    return fn === "uppercase" ? v.toUpperCase() : fn === "lowercase" ? v.toLowerCase() : fn === "capitalize" ? v.replace(/^./, (x) => x.toUpperCase()) : v;
  });
}
/** **bold**, *italic*, ~~struck~~ and [links](url), the Markdown the SDK renders in texts. */
function markdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<b key={i++}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("~~")) out.push(<s key={i++}>{t.slice(2, -2)}</s>);
    else if (t.startsWith("[")) out.push(<u key={i++}>{t.slice(1, t.indexOf("]"))}</u>);
    else out.push(<i key={i++}>{t.slice(1, -1)}</i>);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The component with its overrides applied for the current state. */
function resolve(c: Json, ctx: Ctx): Json {
  if (!Array.isArray(c.overrides) || !c.overrides.length) return c;
  let out = c;
  for (const o of c.overrides as Json[]) {
    const ok = (o.conditions ?? []).every((k: Json) => {
      switch (k.type) {
        case "selected": return ctx.pkgSelected || ctx.tabSelected;
        case "intro_offer": return ctx.intro;
        case "intro_offer_condition": return (k.operator === "!=") !== (ctx.intro === k.value);
        case "promo_offer": return false;
        case "compact": return true;
        case "medium": case "expanded": return false;
        case "selected_package_condition": { const inList = (k.packages ?? []).includes(ctx.selectedPkg); return k.operator === "not in" ? !inList : inList; }
        default: return false;
      }
    });
    if (ok) out = { ...out, ...o.properties };
  }
  return out;
}

// ---- Layout ---------------------------------------------------------------------------------------------------------

type Dir = "vertical" | "horizontal" | "zlayer";
/** CSS for a component's width and height inside a parent of direction `dir`. */
function sizing(size: Json | undefined, dir: Dir, intrinsic?: { w: number; h: number }): CSSProperties {
  const s: CSSProperties = {};
  const w = size?.width, h = size?.height;
  if (w?.type === "fixed") { s.width = w.value; s.flex = dir === "horizontal" ? "none" : undefined; }
  else if (w?.type === "fill") { if (dir === "horizontal") { s.flex = "1 1 0"; s.minWidth = 0; } else { s.alignSelf = "stretch"; s.width = dir === "zlayer" ? "100%" : undefined; } }
  else if (w?.type === "relative") s.width = `${(w.value ?? 1) * 100}%`;
  else { s.maxWidth = "100%"; if (dir === "horizontal") s.flex = "0 1 auto"; }
  if (h?.type === "fixed") s.height = h.value;
  else if (h?.type === "fill") { if (dir === "vertical") { s.flex = `1 1 ${s.flex ? "0" : "auto"}`; s.minHeight = 0; } else s.alignSelf = s.alignSelf ?? "stretch"; if (dir === "zlayer") s.height = "100%"; }
  else if (h?.type === "relative") s.height = `${(h.value ?? 1) * 100}%`;
  if (intrinsic && w?.type !== "fixed" && h?.type !== "fixed") s.aspectRatio = `${intrinsic.w} / ${intrinsic.h}`;
  return s;
}
const JUSTIFY: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", space_between: "space-between", space_around: "space-around", space_evenly: "space-evenly" };
const ALIGN: Record<string, string> = { leading: "flex-start", center: "center", trailing: "flex-end", top: "flex-start", bottom: "flex-end" };
const Z: Record<string, [string, string]> = {
  center: ["center", "center"], leading: ["center", "start"], trailing: ["center", "end"], top: ["start", "center"], bottom: ["end", "center"],
  top_leading: ["start", "start"], top_trailing: ["start", "end"], bottom_leading: ["end", "start"], bottom_trailing: ["end", "end"],
};

function backgroundCss(bg: Json | null | undefined, dark: boolean): CSSProperties {
  if (!bg) return {};
  if (bg.type === "color") { const v = color(bg.value, dark); return v?.includes("gradient") ? { backgroundImage: v } : { backgroundColor: v }; }
  if (bg.type === "image") {
    const src = (dark && bg.value?.dark) || bg.value?.light;
    const overlay = bg.color_overlay ? color(bg.color_overlay, dark) : null;
    return { backgroundImage: `${overlay ? `linear-gradient(${overlay}, ${overlay}), ` : ""}url("${src?.original}")`, backgroundSize: bg.fit_mode === "fit" ? "contain" : "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat" };
  }
  return { backgroundColor: "#00000022" };
}
function decor(c: Json, dark: boolean): CSSProperties {
  const shadows: string[] = [];
  if (c.shadow) shadows.push(`${c.shadow.x ?? 0}px ${c.shadow.y ?? 0}px ${c.shadow.radius ?? 0}px ${color(c.shadow.color, dark) ?? "transparent"}`);
  if (c.border && c.border.width) shadows.push(`inset 0 0 0 ${c.border.width}px ${color(c.border.color, dark) ?? "transparent"}`);
  return { borderRadius: radius(c.shape), boxShadow: shadows.length ? shadows.join(", ") : undefined };
}

/** A rendered component; in the editor a click selects the innermost one. `onPress` runs first (capture), even when a child is clicked. */
function Pickable({ c, style, children, className, tag = "div", onPress }: { c: Json; style: CSSProperties; children?: ReactNode; className?: string; tag?: "div" | "span"; onPress?: () => void }) {
  const ctx = useC();
  const T = tag;
  const focused = ctx.focus && c.id === ctx.focus;
  return (
    <T className={`pwr-c${focused ? " pwr-focus" : ""}${className ? ` ${className}` : ""}`} data-pw-id={c.id} data-pw-type={c.type} style={style}
      onClickCapture={onPress ? () => onPress() : undefined}
      onClick={(e) => { if (ctx.onPick && c.id) { e.stopPropagation(); ctx.onPick(c.id); } }}>{children}</T>
  );
}

function Stack({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  if (!raw || typeof raw !== "object") return null;
  const c = resolve(raw, ctx);
  if (c.visible === false) return null;
  const d: Json = c.dimension ?? { type: "vertical", alignment: "center", distribution: "start" };
  const inner: CSSProperties = d.type === "zlayer"
    ? { display: "grid", alignItems: Z[d.alignment]?.[0] ?? "center", justifyItems: Z[d.alignment]?.[1] ?? "center" }
    : { display: "flex", flexDirection: d.type === "horizontal" ? "row" : "column", alignItems: ALIGN[d.alignment] ?? "center", justifyContent: JUSTIFY[d.distribution] ?? "flex-start", gap: c.spacing ?? 0 };
  const style: CSSProperties = {
    ...sizing(c.size, dir), ...inner, padding: box(c.padding), margin: box(c.margin), position: "relative",
    ...backgroundCss(c.background ?? (c.background_color ? { type: "color", value: c.background_color } : null), ctx.dark), ...decor(c, ctx.dark),
    overflow: c.shape && !c.badge ? "hidden" : c.overflow === "scroll" ? undefined : undefined,
  };
  return (
    <Pickable c={c} style={style}>
      {(Array.isArray(c.components) ? c.components : []).map((k: Json, i: number) => d.type === "zlayer" ? (
        // Overlay: every child in the same grid cell; children that fill stretch the cell.
        <div key={k?.id ?? i} style={{ gridArea: "1 / 1", display: "flex", flexDirection: "column", minWidth: 0, maxWidth: "100%", justifySelf: (k?.size ?? k?.stack?.size)?.width?.type === "fill" ? "stretch" : undefined, alignSelf: (k?.size ?? k?.stack?.size)?.height?.type === "fill" ? "stretch" : undefined }}>
          <Component c={k} dir="vertical" />
        </div>
      ) : <Component key={k?.id ?? i} c={k} dir={d.type} />)}
      {c.badge && <Badge b={c.badge} />}
    </Pickable>
  );
}
function Badge({ b }: { b: Json }) {
  const [v, h] = Z[b.alignment] ?? ["start", "center"];
  const style: CSSProperties = b.style === "edge_to_edge" || b.style === "nested"
    ? { position: "absolute", left: b.style === "edge_to_edge" ? 0 : undefined, right: b.style === "edge_to_edge" ? 0 : h === "end" ? 8 : undefined, top: v === "start" ? (b.style === "nested" ? 8 : 0) : undefined, bottom: v === "end" ? 0 : undefined, display: "flex", justifyContent: h === "end" ? "flex-end" : h === "start" ? "flex-start" : "center", zIndex: 2 }
    : { position: "absolute", top: v === "start" ? 0 : v === "end" ? "100%" : "50%", left: h === "start" ? 12 : h === "center" ? "50%" : undefined, right: h === "end" ? 0 : undefined, transform: `translate(${h === "center" ? "-50%" : "0"}, -50%)`, zIndex: 2 };
  return <div style={style}><Stack c={b.stack} dir="vertical" /></div>;
}

function Text({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  if (c.visible === false) return null;
  const s = ctx.strings[c.text_lid];
  const value = typeof s === "string" ? fill(s, ctx) : "";
  const size = typeof c.font_size === "number" ? c.font_size : NAMED[c.font_size] ?? 15;
  const align = c.horizontal_alignment === "leading" ? "left" : c.horizontal_alignment === "trailing" ? "right" : "center";
  const style: CSSProperties = {
    ...sizing(c.size, dir), padding: box(c.padding), margin: box(c.margin), color: color(c.color, ctx.dark), fontSize: size, lineHeight: 1.25,
    fontWeight: c.font_weight_int ?? WEIGHT[c.font_weight] ?? 400, textAlign: align, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
    fontFamily: c.font_name ? `"${c.font_name}", -apple-system, system-ui, sans-serif` : undefined,
    ...(c.background_color ? { background: color(c.background_color, ctx.dark) } : {}),
  };
  if (c.size?.width?.type === "fill" && dir !== "horizontal") style.width = "100%";
  return <Pickable c={c} style={style}>{value ? markdown(value) : <span className="pwr-empty">{typeof s === "string" ? "" : "Missing text"}</span>}</Pickable>;
}

function Image({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  if (c.visible === false) return null;
  const src = (ctx.dark && c.source?.dark) || c.source?.light;
  const shape = c.mask_shape;
  const style: CSSProperties = {
    ...sizing(c.size, dir, src ? { w: src.width, h: src.height } : undefined), padding: box(c.padding), margin: box(c.margin), overflow: "hidden", position: "relative",
    borderRadius: shape?.type === "circle" ? "50%" : radius(shape), ...decor({ border: c.border, shadow: c.shadow }, ctx.dark),
  };
  const overlay = c.color_overlay ? color(c.color_overlay, ctx.dark) : null;
  return (
    <Pickable c={c} style={style}>
      {src?.original ? <img src={src.original} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: c.fit_mode === "fit" ? "contain" : "cover", display: "block" }} /> : <div className="pwr-ph">Image</div>}
      {overlay && <div style={{ position: "absolute", inset: 0, background: overlay }} />}
    </Pickable>
  );
}

export function IconGlyph({ name, color: col, size }: { name: string; color: string; size: number | string }) {
  const d = PAYWALL_ICONS[name]?.d;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={col} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "block" }}>
      {d ? <path d={d} /> : <rect x="4" y="4" width="16" height="16" />}
    </svg>
  );
}
function Icon({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  if (c.visible === false) return null;
  // As in RevenueCatUI: `size` is the whole icon and the padding sits inside it, around the glyph.
  const w = c.size?.width?.type === "fixed" ? c.size.width.value : 24;
  const h = c.size?.height?.type === "fixed" ? c.size.height.value : w;
  const p = c.padding ?? {};
  const glyph = Math.max(0, Math.min(w - (p.leading ?? 0) - (p.trailing ?? 0), h - (p.top ?? 0) - (p.bottom ?? 0)));
  const bg = c.icon_background;
  const style: CSSProperties = {
    width: w, height: h, boxSizing: "border-box", padding: box(c.padding), margin: box(c.margin), flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
    ...(bg ? { background: color(bg.color, ctx.dark), borderRadius: bg.shape?.type === "circle" ? "50%" : radius(bg.shape) ?? 0 } : {}),
  };
  void dir;
  return <Pickable c={c} style={style}><IconGlyph name={c.icon_name} color={color(c.color, ctx.dark) ?? "#000"} size={glyph} /></Pickable>;
}

function Package({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  if (c.visible === false) return null;
  const selected = ctx.selectedPkg === c.package_id;
  const inner: Ctx = { ...ctx, pkg: c.package_id, pkgSelected: selected };
  return (
    <C.Provider value={inner}>
      <Pickable c={c} style={{ ...sizing(c.stack?.size, dir), display: "flex", flexDirection: "column", cursor: "pointer" }} onPress={() => ctx.setSelectedPkg(c.package_id)}>
        <Stack c={c.stack} dir="vertical" />
      </Pickable>
    </C.Provider>
  );
}
function Wrapper({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  if (c.visible === false || !c.stack) return null;
  return <Pickable c={c} style={{ ...sizing(c.stack.size, dir), display: "flex", flexDirection: "column", cursor: "pointer" }}><Stack c={c.stack} dir="vertical" /></Pickable>;
}

function Timeline({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  if (c.visible === false) return null;
  const items: Json[] = c.items ?? [];
  return (
    <Pickable c={c} style={{ ...sizing(c.size, dir), padding: box(c.padding), margin: box(c.margin), display: "flex", flexDirection: "column", gap: c.item_spacing ?? 16 }}>
      {items.map((it, i) => {
        const conn = it.connector;
        const iconW = it.icon?.size?.width?.value ?? 20;
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: `${iconW}px 1fr`, columnGap: c.column_gutter ?? 12, position: "relative" }}>
            {conn && i < items.length - 1 && <div style={{ position: "absolute", left: iconW / 2 - (conn.width ?? 4) / 2, top: iconW + (conn.margin?.top ?? 0), bottom: -(c.item_spacing ?? 16) - (conn.margin?.bottom ?? 0), width: conn.width ?? 4, background: color(conn.color, ctx.dark) }} />}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", zIndex: 1 }}><Icon c={it.icon} dir="vertical" /></div>
            <div style={{ display: "flex", flexDirection: "column", gap: c.text_spacing ?? 4, alignSelf: c.icon_alignment === "title_and_description" ? "center" : "start" }}>
              <Text c={it.title} dir="vertical" />
              {it.description && <Text c={it.description} dir="vertical" />}
            </div>
          </div>
        );
      })}
    </Pickable>
  );
}

function Tabs({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  const tabs: Json[] = c.tabs ?? [];
  const active = ctx.tabs[c.id] ?? c.default_tab_id ?? tabs[0]?.id;
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  // Switching tabs selects that tab's default package, as the SDK does.
  useEffect(() => {
    if (!tab) return;
    let def: string | null = null;
    JSON.stringify(tab.stack, (k, v) => { if (v && typeof v === "object" && v.type === "package" && v.is_selected_by_default && !def) def = v.package_id; return v; });
    if (def && def !== ctx.selectedPkg) ctx.setSelectedPkg(def);
  }, [tab?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (c.visible === false || !tab) return null;
  const control = () => (
    <C.Provider value={{ ...ctx, control: null }}>
      <TabControl stack={c.control?.stack} type={c.control?.type} tabsId={c.id} tabIds={tabs.map((t) => t.id)} active={active} />
    </C.Provider>
  );
  return (
    <C.Provider value={{ ...ctx, control }}>
      <Pickable c={c} style={{ ...sizing(c.size, dir), padding: box(c.padding), margin: box(c.margin), display: "flex", flexDirection: "column", ...backgroundCss(c.background, ctx.dark), ...decor(c, ctx.dark) }}>
        <Stack c={tab.stack} dir="vertical" />
      </Pickable>
    </C.Provider>
  );
}
const TabCtl = createContext<{ tabsId: string; tabIds: string[]; active: string } | null>(null);
function TabControl({ stack, tabsId, tabIds, active }: { stack: Json; type: string; tabsId: string; tabIds: string[]; active: string }) {
  if (!stack) return null;
  return <TabCtl.Provider value={{ tabsId, tabIds, active }}><Stack c={stack} dir="vertical" /></TabCtl.Provider>;
}
function TabButton({ c, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const t = useContext(TabCtl);
  const on = t?.active === c.tab_id;
  return (
    <C.Provider value={{ ...ctx, tabSelected: on }}>
      <Pickable c={c} style={{ ...sizing(c.stack?.size, dir), display: "flex", flexDirection: "column", cursor: "pointer" }} onPress={() => t && ctx.setTab(t.tabsId, c.tab_id)}>
        <Stack c={c.stack} dir="vertical" />
      </Pickable>
    </C.Provider>
  );
}
function TabToggle({ c }: { c: Json }) {
  const ctx = useC();
  const t = useContext(TabCtl);
  const on = !!t && t.active === t.tabIds[1];
  return (
    <Pickable c={c} style={{ width: 51, height: 31, borderRadius: 16, background: color(on ? c.track_color_on : c.track_color_off, ctx.dark), position: "relative", cursor: "pointer", flex: "none" }}
      onPress={() => t && ctx.setTab(t.tabsId, on ? t.tabIds[0]! : t.tabIds[1] ?? t.tabIds[0]!)}>
      <span style={{ position: "absolute", top: 2, left: on ? 22 : 2, width: 27, height: 27, borderRadius: "50%", background: color(on ? c.thumb_color_on : c.thumb_color_off, ctx.dark), transition: "left 150ms" }} />
    </Pickable>
  );
}

function Carousel({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  const pages: Json[] = c.pages ?? [];
  const [page, setPage] = useState(Math.min(c.initial_page_index ?? 0, Math.max(0, pages.length - 1)));
  const ref = useRef<HTMLDivElement>(null);
  const peek = c.page_peek ?? 0, gap = c.page_spacing ?? 0;
  useEffect(() => {
    const ms = c.auto_advance?.ms_time_per_page;
    if (!ms || pages.length < 2) return;
    const t = setInterval(() => setPage((p) => (p + 1 < pages.length ? p + 1 : c.loop ? 0 : p)), Math.max(1000, ms));
    return () => clearInterval(t);
  }, [c.auto_advance?.ms_time_per_page, pages.length, c.loop]);
  if (c.visible === false) return null;
  const pc = c.page_control;
  const dots = pc && pages.length > 1 ? (
    <div style={{ display: "flex", justifyContent: "center", gap: pc.spacing ?? 6, padding: box(pc.padding), margin: box(pc.margin), ...(pc.background_color ? { background: color(pc.background_color, ctx.dark) } : {}), borderRadius: radius(pc.shape) }}>
      {pages.map((_, i) => { const ind = i === page ? pc.active : pc.default; return <button key={i} type="button" aria-label={`Page ${i + 1}`} onClick={(e) => { e.stopPropagation(); setPage(i); }} style={{ width: ind?.width ?? 6, height: ind?.height ?? 6, borderRadius: 9999, background: color(ind?.color, ctx.dark), border: 0, padding: 0 }} />; })}
    </div>
  ) : null;
  return (
    <Pickable c={c} style={{ ...sizing(c.size, dir), padding: box(c.padding), margin: box(c.margin), display: "flex", flexDirection: "column", ...backgroundCss(c.background, ctx.dark), ...decor(c, ctx.dark), overflow: "hidden" }}>
      {pc?.position === "top" && dots}
      <div ref={ref} style={{ overflow: "hidden", padding: `0 ${peek}px` }}>
        <div style={{ display: "flex", gap, transform: `translateX(calc(${-page} * (100% + ${gap}px)))`, transition: "transform 300ms cubic-bezier(.23,1,.32,1)", alignItems: c.page_alignment === "top" ? "flex-start" : c.page_alignment === "bottom" ? "flex-end" : "center" }}>
          {pages.map((p, i) => <div key={p?.id ?? i} style={{ flex: "0 0 100%", minWidth: 0, display: "flex", flexDirection: "column" }}><Stack c={p} dir="vertical" /></div>)}
        </div>
      </div>
      {pc?.position !== "top" && dots}
    </Pickable>
  );
}

function Countdown({ c, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const end = Date.parse(c.style?.date ?? "");
  const remaining = Number.isNaN(end) ? 0 : end - ctx.now;
  const st = remaining <= 0 && c.end_stack ? c.end_stack : c.countdown_stack;
  return (
    <C.Provider value={{ ...ctx, remaining }}>
      <Pickable c={c} style={{ ...sizing(st?.size, dir), display: "flex", flexDirection: "column" }}>{st && <Stack c={st} dir="vertical" />}</Pickable>
    </C.Provider>
  );
}
function Video({ c: raw, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  const c = resolve(raw, ctx);
  if (c.visible === false) return null;
  const src = (ctx.dark && c.source?.dark) || c.source?.light;
  const poster = c.fallback_source?.light?.original;
  return (
    <Pickable c={c} style={{ ...sizing(c.size, dir, src ? { w: src.width, h: src.height } : undefined), padding: box(c.padding), margin: box(c.margin), overflow: "hidden", borderRadius: radius(c.mask_shape), background: "#000" }}>
      {src?.url ? <video src={src.url} poster={poster} muted={c.mute_audio !== false} autoPlay={c.auto_play !== false} loop={c.loop !== false} playsInline controls={!!c.show_controls} style={{ width: "100%", height: "100%", objectFit: c.fit_mode === "fit" ? "contain" : "cover", display: "block" }} /> : <div className="pwr-ph">Video: set a URL</div>}
    </Pickable>
  );
}
function WebView({ c, dir }: { c: Json; dir: Dir }) {
  return <Pickable c={c} style={{ ...sizing(c.size, dir), minHeight: 60 }}><div className="pwr-ph">{c.url ? `Web view · ${c.url}` : "Web view: set an https URL"}</div></Pickable>;
}

export function Component({ c, dir }: { c: Json; dir: Dir }) {
  const ctx = useC();
  if (!c || typeof c !== "object") return null;
  switch (c.type) {
    case "stack": return <Stack c={c} dir={dir} />;
    case "text": return <Text c={c} dir={dir} />;
    case "image": return <Image c={c} dir={dir} />;
    case "icon": return <Icon c={c} dir={dir} />;
    case "package": return <Package c={c} dir={dir} />;
    case "button": case "purchase_button": case "sticky_footer": return <Wrapper c={c} dir={dir} />;
    case "timeline": return <Timeline c={c} dir={dir} />;
    case "tabs": return <Tabs c={c} dir={dir} />;
    case "tab_control": return ctx.control ? <Pickable c={c} style={{ alignSelf: "stretch" }}>{ctx.control()}</Pickable> : null;
    case "tab_control_button": return <TabButton c={c} dir={dir} />;
    case "tab_control_toggle": return <TabToggle c={c} />;
    case "carousel": return <Carousel c={c} dir={dir} />;
    case "countdown": return <Countdown c={c} dir={dir} />;
    case "video": return <Video c={c} dir={dir} />;
    case "web_view": return <WebView c={c} dir={dir} />;
    default: return c.fallback ? <Component c={c.fallback} dir={dir} /> : null;
  }
}

/** The locale's strings, falling back key by key to the default locale (as the server serves them). */
export function stringsFor(doc: PaywallDoc, locale: string): Record<string, unknown> {
  const base = doc.components_localizations[doc.default_locale] ?? {};
  return { ...base, ...(doc.components_localizations[locale] ?? {}) };
}

/** Every package identifier in the paywall, in order of appearance. */
function packageList(doc: PaywallDoc): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    const o = x as Json;
    if (o.type === "package" && typeof o.package_id === "string" && !out.includes(o.package_id)) out.push(o.package_id);
    for (const v of Object.values(o)) walk(v);
  };
  walk(doc.components_config);
  return out;
}

/** The first package selected by default (or the first package), outside tabs. */
function defaultPackage(doc: PaywallDoc): string | null {
  let first: string | null = null, sel: string | null = null;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    const o = x as Json;
    if (o.type === "package") { first ??= o.package_id; if (o.is_selected_by_default && !sel) sel = o.package_id; }
    if (o.type === "tabs") { const t = (o.tabs ?? []).find((t: Json) => t.id === o.default_tab_id) ?? o.tabs?.[0]; if (t) walk(t.stack); return; }
    for (const [k, v] of Object.entries(o)) if (k !== "overrides") walk(v);
  };
  walk(doc.components_config);
  return sel ?? first;
}

export interface PhoneProps {
  doc: PaywallDoc;
  state?: Partial<PreviewState>;
  /** Width of the rendered phone in CSS pixels; the 390 × 844 screen is scaled to it. */
  width?: number;
  focus?: string | null;
  onPick?: (id: string) => void;
  /** Controlled selection of the package (editor toolbar). */
  selectedPkg?: string | null;
  onSelectPkg?: (id: string) => void;
  label?: string;
  /** Ticks the countdown every second (off for gallery thumbnails). */
  live?: boolean;
  /** The offering's real products by package identifier (previewProducts in preview-values.ts). */
  prices?: Record<string, PreviewProduct>;
}

/**
 * Shows `fallback` instead of unmounting the page when rendering malformed paywall JSON throws (React removes the whole
 * tree on an uncaught render error). Tries again whenever `reset` changes, so an undo or a fixed JSON brings it back.
 */
export class Guard extends ReactComponent<{ reset: unknown; fallback: (e: Error) => ReactNode; children: ReactNode }, { error: Error | null; reset: unknown }> {
  state = { error: null as Error | null, reset: this.props.reset };
  static getDerivedStateFromProps(p: { reset: unknown }, s: { reset: unknown }) { return p.reset !== s.reset ? { error: null, reset: p.reset } : null; }
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

/** A phone frame (390 × 844 points) rendering the paywall: scrolling body, sticky footer, safe areas. */
export function Phone(p: PhoneProps) {
  const width = p.width ?? 320;
  return (
    <Guard reset={p.doc} fallback={(e) => (
      <figure className="pwr-phone" aria-label={p.label ?? "Paywall preview"} style={{ width: width + 16, margin: 0 }}>
        <div className="pwr-ph" role="alert" style={{ width: width + 16, height: (844 * width) / 390 + 16 }}>The preview cannot show this JSON: {e.message}</div>
      </figure>
    )}><PhoneView {...p} /></Guard>
  );
}
function PhoneView({ doc, state = {}, width = 320, focus, onPick, selectedPkg, onSelectPkg, label = "Paywall preview", live = true, prices }: PhoneProps) {
  const W = 390, H = 844, scale = width / W;
  const [ownPkg, setOwnPkg] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);
  const dflt = useMemo(() => defaultPackage(doc), [doc]);
  const packages = useMemo(() => packageList(doc), [doc]);
  const pkg = selectedPkg !== undefined && selectedPkg !== null ? selectedPkg : ownPkg ?? dflt;
  const setPkg = (id: string) => { setOwnPkg(id); onSelectPkg?.(id); };
  const dark = !!state.dark;
  const ctx: Ctx = {
    strings: stringsFor(doc, state.locale ?? doc.default_locale), locale: state.locale ?? doc.default_locale ?? "en_US", dark, intro: state.intro ?? true, selectedPkg: pkg, setSelectedPkg: setPkg,
    tabs, setTab: (a, b) => setTabs((t) => ({ ...t, [a]: b })), now, focus, onPick, pkg: null, pkgSelected: false, tabSelected: false, remaining: null, control: null, prices, packages,
  };
  const base = doc.components_config?.base;
  const bg = backgroundCss(base?.background, dark);
  const footer = base?.sticky_footer;
  return (
    <figure className="pwr-phone" aria-label={label} style={{ width: width + 16, margin: 0 }}>
      <div className="pwr-bezel" style={{ width: width + 16, height: H * scale + 16 }}>
        <div className="pwr-screen" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "top left", ...bg, colorScheme: dark ? "dark" : "light" }}>
          <C.Provider value={ctx}>
            <div className="pwr-body">
              <div style={{ height: 47, flex: "none" }} aria-hidden />
              {base?.stack && <div className="pwr-root"><Stack c={base.stack} dir="vertical" /></div>}
            </div>
            {footer?.stack && <div className="pwr-footer"><Wrapper c={{ ...footer, type: "sticky_footer" }} dir="vertical" /><div style={{ height: 24, ...backgroundCss(footer.stack.background, dark) }} aria-hidden /></div>}
          </C.Provider>
          <div className="pwr-island" aria-hidden />
        </div>
      </div>
    </figure>
  );
}
