/**
 * Repairs paywall components JSON into something the SDK decodes: the AI generator's output, JSON pasted into the
 * editor, or an old draft. It accepts a lenient form of the SDK schema (inline `text` instead of `text_lid`, plain hex
 * colours, `"fill"` sizes, numbers for padding, `direction` for stacks, a short `{ components, footer }` document) and
 * fills every required field with a default. The result always passes `validatePaywall` when the input had at least one
 * recognisable component; `fixes` lists what was changed, for the user.
 */
import { DocBuilder, FILL, FIT, PILL, ZERO, colorBg, fixed, hex8, imageUrls, pad, rounded, scheme, sz, type Json, type PaywallDoc } from "./build.js";
import { PAYWALL_ICONS } from "./icons.js";
import { COMPONENT_TYPES } from "./validate.js";

export interface RepairOptions {
  /** Package identifiers of the offering, in display order. Package components are bound to these. */
  packages?: string[];
  /** Base URL of the built-in icons (`{origin}/assets/icons`). */
  iconBaseUrl: string;
  locale?: string;
  colors?: { background?: string; text?: string; accent?: string };
}
export interface Repaired { doc: PaywallDoc; fixes: string[]; name: string | null }

const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : d);
const int = (x: unknown, d: number) => Math.round(num(x, d));

const WEIGHTS: Record<number, string> = { 100: "thin", 200: "extra_light", 300: "light", 400: "regular", 500: "medium", 600: "semibold", 700: "bold", 800: "extra_bold", 900: "black" };
const WEIGHT_NAMES = new Set(Object.values(WEIGHTS));
const NAMED_SIZES: Record<string, number> = { heading_xxl: 40, heading_xl: 34, heading_l: 28, heading_m: 24, heading_s: 20, heading_xs: 16, body_xl: 18, body_l: 17, body_m: 15, body_s: 13, title: 28, headline: 28, subtitle: 17, body: 15, caption: 13, small: 12, large: 20 };
const ICON_ALIASES: Record<string, string> = {
  checkmark: "check", tick: "check", "check-circle": "check_circle", checkcircle: "check_circle", close: "x", cross: "x", "x-mark": "x", sparkle: "sparkles", magic: "wand",
  "lock-open": "unlock", notification: "bell", premium: "crown", pro: "crown", security: "shield", privacy: "shield", bolt: "zap", lightning: "zap", fast: "zap", love: "heart",
  present: "gift", time: "clock", timer: "clock", date: "calendar", backup: "cloud", unlimited: "infinity", stats: "chart", analytics: "chart", growth: "trending_up",
  people: "users", team: "users", community: "users", person: "user", offline: "download", photo: "camera", photos: "camera", audio: "music", sound: "music", learn: "book",
  language: "globe", world: "globe", night: "moon", sleep: "moon", day: "sun", streak: "flame", fire: "flame", goal: "target", focus: "target", nature: "leaf", calm: "leaf",
  meditation: "leaf", workout: "dumbbell", fitness: "dumbbell", gym: "dumbbell", voice: "mic", picture: "image", discount: "percent", sale: "tag", price: "tag", ads: "no_ads",
  "no-ads": "no_ads", noads: "no_ads", "ad-free": "no_ads", sync: "sync", devices: "devices", phone: "devices", listen: "headphones", award: "trophy", achievement: "trophy",
};
export function iconName(x: unknown): string {
  const s = isStr(x) ? x.trim().toLowerCase().replace(/\.(png|svg|heic|webp)$/, "").replace(/[\s-]+/g, "_") : "";
  if (PAYWALL_ICONS[s]) return s;
  const a = ICON_ALIASES[s] ?? ICON_ALIASES[s.replace(/_/g, "-")] ?? ICON_ALIASES[s.replace(/_/g, "")];
  if (a) return a;
  const partial = Object.keys(PAYWALL_ICONS).find((k) => s && (s.includes(k) || k.includes(s)));
  return partial ?? "check";
}

class R {
  readonly b: DocBuilder;
  readonly fixes: string[] = [];
  readonly seen = new Set<string>();
  readonly strings: Record<string, string>;
  readonly fg: string; readonly bg: string; readonly accent: string; readonly muted: string;
  packagesUsed: string[] = [];
  purchaseButtons = 0;
  constructor(readonly o: RepairOptions, strings: Record<string, unknown>) {
    this.b = new DocBuilder(o.locale ?? "en_US", "r");
    this.strings = Object.fromEntries(Object.entries(strings).filter(([, v]) => isStr(v))) as Record<string, string>;
    this.bg = hex8(o.colors?.background) ? o.colors!.background! : "#ffffff";
    this.fg = hex8(o.colors?.text) ? o.colors!.text! : luminance(this.bg) > 0.5 ? "#111111" : "#ffffff";
    // An accent that disappears on the background (black on navy) becomes the text colour.
    const accent = hex8(o.colors?.accent) ? o.colors!.accent! : luminance(this.bg) > 0.5 ? "#111111" : "#ffffff";
    this.accent = Math.abs(luminance(accent) - luminance(this.bg)) < 0.25 ? this.fg : accent;
    this.muted = mix(this.fg, this.bg, 0.4);
  }
  fix(msg: string) { if (!this.fixes.includes(msg)) this.fixes.push(msg); }
  id(x: Json, prefix: string) {
    let id = isStr(x.id) && x.id.trim() ? x.id.trim() : "";
    if (!id || this.seen.has(id)) { if (id) this.fix("Gave duplicate component ids new ids."); id = this.b.id(prefix); while (this.seen.has(id)) id = this.b.id(prefix); }
    this.seen.add(id);
    return id;
  }
  /** A text value or key: an existing key stays, inline text becomes a new key. */
  key(x: Json, fallback = ""): string {
    if (isStr(x.text_lid) && x.text_lid in this.strings) return x.text_lid;
    const inline = [x.text, x.value, x.label, x.title, x.string, isStr(x.text_lid) ? x.text_lid : undefined].find((v) => isStr(v) && v.trim() !== "");
    const k = this.b.str(isStr(inline) ? inline : fallback);
    this.strings[k] = this.b.strings[k]!;
    if (isStr(x.text_lid) && !(x.text_lid in this.strings)) this.fix("Turned text ids without a string into texts.");
    return k;
  }
  urlKey(v: unknown): string {
    if (isObj(v) && isStr(v.url_lid) && v.url_lid in this.strings) return v.url_lid;
    const raw = isStr(v) ? v : isObj(v) ? (v.url ?? v.url_lid) : null;
    const url = isStr(raw) && /^https?:\/\//.test(raw) ? raw : "https://example.com";
    const k = this.b.str(url); this.strings[k] = url;
    return k;
  }
}

function rgb(c: string): [number, number, number] { const v = (hex8(c) ?? "#000000ff").slice(1, 7); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number]; }
function luminance(c: string) { const [r, g, b] = rgb(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
function mix(a: string, b: string, t: number) { const [x, y] = [rgb(a), rgb(b)]; return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`; }

function colorOf(r: R, v: unknown, fallback: string): Json {
  if (isStr(v)) { if (!hex8(v)) r.fix("Replaced colours that are not hex values."); return scheme(hex8(v) ? v : fallback); }
  if (isObj(v)) {
    if (isObj(v.light) || isStr(v.light)) {
      const one = (x: unknown, d: string): Json => {
        if (isStr(x)) return { type: "hex", value: hex8(x) ?? hex8(d)! };
        if (isObj(x) && x.type === "hex" && hex8(x.value)) return { type: "hex", value: hex8(x.value)! };
        if (isObj(x) && (x.type === "linear" || x.type === "radial") && Array.isArray(x.points) && x.points.length) {
          return { type: x.type, ...(x.type === "linear" ? { degrees: int(x.degrees, 180) } : {}), points: x.points.map((p: Json, i: number) => ({ color: hex8(p?.color) ?? hex8(d)!, percent: Math.max(0, Math.min(100, int(p?.percent, i * 100))) })) };
        }
        if (isObj(x) && x.type === "alias" && isStr(x.value)) return { type: "alias", value: x.value };
        r.fix("Replaced colours that are not hex values.");
        return { type: "hex", value: hex8(d)! };
      };
      return { light: one(v.light, fallback), ...(v.dark !== undefined && v.dark !== null ? { dark: one(v.dark, fallback) } : {}) };
    }
    if (v.type === "hex" || isStr(v.value)) return scheme(hex8(v.value) ? v.value : fallback);
  }
  return scheme(fallback);
}
function sizeOne(v: unknown, d: Json): Json {
  if (typeof v === "number") return fixed(v);
  if (isStr(v)) { if (v === "fill" || v === "fit") return { type: v, value: null }; if (/^\d+(\.\d+)?$/.test(v)) return fixed(Number(v)); if (/^\d+%$/.test(v)) return { type: "relative", value: Number(v.slice(0, -1)) / 100 }; return d; }
  if (isObj(v) && ["fit", "fill", "fixed", "relative"].includes(v.type)) {
    if (v.type === "fixed") return fixed(num(v.value, 0));
    if (v.type === "relative") return { type: "relative", value: num(v.value, 1) };
    return { type: v.type, value: null };
  }
  return d;
}
function sizeOf(x: Json, w: Json, h: Json): Json {
  const s = x.size;
  if (isObj(s)) return { width: sizeOne(s.width, w), height: sizeOne(s.height, h) };
  return { width: sizeOne(x.width, isStr(s) ? sizeOne(s, w) : w), height: sizeOne(x.height, h) };
}
function padOf(v: unknown, d: Json = ZERO): Json {
  if (typeof v === "number") return pad(v);
  if (Array.isArray(v)) { const [t = 0, r = t, bo = t, l = r] = v.map((n) => num(n, 0)); return { top: t, trailing: r, bottom: bo, leading: l }; }
  if (isObj(v)) {
    const h = num(v.horizontal, NaN), vv = num(v.vertical, NaN);
    return { top: num(v.top, Number.isNaN(vv) ? 0 : vv), bottom: num(v.bottom, Number.isNaN(vv) ? 0 : vv), leading: num(v.leading ?? v.left, Number.isNaN(h) ? 0 : h), trailing: num(v.trailing ?? v.right, Number.isNaN(h) ? 0 : h) };
  }
  return d;
}
function shapeOf(x: Json): Json | undefined {
  if (x.shape === "pill" || (isObj(x.shape) && x.shape.type === "pill")) return PILL;
  if (isObj(x.shape) && x.shape.type === "rectangle") {
    const c = x.shape.corners;
    return isObj(c) ? { type: "rectangle", corners: { top_leading: num(c.top_leading, 0), top_trailing: num(c.top_trailing, 0), bottom_leading: num(c.bottom_leading, 0), bottom_trailing: num(c.bottom_trailing, 0) } } : { type: "rectangle" };
  }
  const radius = x.corner_radius ?? x.radius ?? x.border_radius ?? x.cornerRadius;
  if (radius !== undefined) return rounded(num(radius, 0));
  return undefined;
}
function backgroundOf(r: R, v: unknown, fallback: string | null): Json | null {
  if (v === undefined || v === null) return fallback ? colorBg(fallback) : null;
  if (isStr(v)) return { type: "color", value: colorOf(r, v, fallback ?? r.bg) };
  if (isObj(v)) {
    if (v.type === "color") return { type: "color", value: colorOf(r, v.value, fallback ?? r.bg) };
    if (v.type === "image" && isObj(v.value)) {
      const img = imageSourceOf(v.value);
      if (img) return { type: "image", value: img, fit_mode: v.fit_mode === "fit" ? "fit" : "fill", ...(v.color_overlay ? { color_overlay: colorOf(r, v.color_overlay, "#00000066") } : {}) };
    }
    if (v.type === "video") return v; // passed through; validated after
    if (isObj(v.light) || isStr(v.light)) return { type: "color", value: colorOf(r, v, fallback ?? r.bg) };
  }
  r.fix("Replaced a background that is not a colour.");
  return fallback ? colorBg(fallback) : null;
}
function imageSourceOf(v: unknown): Json | null {
  const one = (x: unknown): Json | null => {
    if (isStr(x) && /^https?:\/\//.test(x)) return imageUrls(x, 1200, 800);
    if (isObj(x)) {
      const url = [x.original, x.url, x.heic, x.webp].find((u) => isStr(u) && /^https?:\/\//.test(u));
      if (!isStr(url)) return null;
      return { ...imageUrls(url, int(x.width, 1200), int(x.height, 800)), ...(isStr(x.original) ? { original: x.original } : {}), ...(isStr(x.heic) ? { heic: x.heic } : {}), ...(isStr(x.heic_low_res) ? { heic_low_res: x.heic_low_res } : {}) };
    }
    return null;
  };
  if (isObj(v) && (v.light !== undefined)) { const l = one(v.light); if (!l) return null; const d = v.dark ? one(v.dark) : null; return { light: l, ...(d ? { dark: d } : {}) }; }
  const l = one(v);
  return l ? { light: l } : null;
}
function dimensionOf(x: Json): Json {
  const d = isObj(x.dimension) ? x.dimension : {};
  const dirRaw = isStr(x.dimension) ? x.dimension : d.type ?? x.direction ?? x.axis ?? x.layout;
  const dir = dirRaw === "horizontal" || dirRaw === "row" ? "horizontal" : dirRaw === "zlayer" || dirRaw === "overlay" || dirRaw === "z" ? "zlayer" : "vertical";
  const alignRaw = d.alignment ?? x.alignment ?? x.align;
  const distRaw = d.distribution ?? x.distribution ?? x.justify;
  const dist = ["start", "center", "end", "space_between", "space_around", "space_evenly"].includes(distRaw) ? distRaw : "start";
  if (dir === "zlayer") return { type: "zlayer", alignment: ["center", "leading", "trailing", "top", "bottom", "top_leading", "top_trailing", "bottom_leading", "bottom_trailing"].includes(alignRaw) ? alignRaw : "center" };
  const allowed = dir === "vertical" ? ["leading", "center", "trailing"] : ["top", "center", "bottom"];
  const map: Record<string, string> = dir === "vertical" ? { left: "leading", start: "leading", right: "trailing", end: "trailing", top: "center", bottom: "center" } : { start: "top", end: "bottom", leading: "center", trailing: "center" };
  const align = allowed.includes(alignRaw) ? alignRaw : map[alignRaw] ?? "center";
  return { type: dir, alignment: align, distribution: dist };
}
function borderOf(r: R, v: unknown): Json | undefined {
  if (!isObj(v)) return undefined;
  return { color: colorOf(r, v.color, r.muted), width: num(v.width, 1) };
}
function shadowOf(r: R, v: unknown): Json | undefined {
  if (!isObj(v)) return undefined;
  return { color: colorOf(r, v.color, "#00000022"), radius: num(v.radius, 8), x: num(v.x, 0), y: num(v.y, 2) };
}
function weightOf(v: unknown): string {
  if (typeof v === "number") return WEIGHTS[Math.min(900, Math.max(100, Math.round(v / 100) * 100))] ?? "regular";
  if (isStr(v)) { const s = v.toLowerCase().replace(/[\s-]/g, "_"); if (WEIGHT_NAMES.has(s)) return s; if (s === "semi_bold" || s === "demibold") return "semibold"; if (s === "heavy") return "black"; if (s === "normal") return "regular"; if (/^\d+$/.test(s)) return weightOf(Number(s)); }
  return "regular";
}
function fontSizeOf(v: unknown, d: number): number | string {
  if (typeof v === "number" && v > 0) return v;
  if (isStr(v)) { if (/^\d+(\.\d+)?$/.test(v)) return Number(v); const n = NAMED_SIZES[v.toLowerCase()]; if (n) return n; }
  return d;
}
function overridesOf(r: R, v: unknown, kind: string): Json[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Json[] = [];
  for (const o of v) {
    if (!isObj(o) || !isObj(o.properties)) continue;
    const conditions = (Array.isArray(o.conditions) ? o.conditions : isStr(o.condition) ? [o.condition] : []).map((c: unknown) => (isStr(c) ? { type: c } : c)).filter((c: unknown) => isObj(c) && isStr(c.type));
    if (!conditions.length) continue;
    const p: Json = { ...o.properties };
    if (kind === "text") {
      if (isStr(p.text) || (isStr(p.text_lid) && !(p.text_lid in r.strings))) { p.text_lid = r.key(p); delete p.text; }
      if (p.font_size !== undefined) { const f = fontSizeOf(p.font_size, 16); p.font_size = typeof f === "number" ? f : 16; }
      if (p.font_weight !== undefined) p.font_weight = weightOf(p.font_weight);
    }
    for (const k of ["color", "background_color"]) if (p[k] !== undefined) p[k] = colorOf(r, p[k], r.fg);
    if (p.background !== undefined) p.background = backgroundOf(r, p.background, null);
    if (p.border !== undefined) p.border = borderOf(r, p.border);
    if (p.padding !== undefined) p.padding = padOf(p.padding);
    if (p.margin !== undefined) p.margin = padOf(p.margin);
    if (p.size !== undefined) p.size = sizeOf(p, FILL, FIT);
    out.push({ conditions, properties: p });
  }
  return out.length ? out : undefined;
}

function textC(r: R, x: Json, d: { size?: number; weight?: string; align?: string; color?: string } = {}): Json {
  const t: Json = {
    id: r.id(x, "t"), type: "text", ...(isStr(x.name) ? { name: x.name } : {}), text_lid: r.key(x),
    color: colorOf(r, x.color ?? x.text_color, d.color ?? r.fg), font_size: fontSizeOf(x.font_size ?? x.fontSize ?? x.size_pt, d.size ?? 16),
    font_weight: weightOf(x.font_weight ?? x.weight ?? d.weight), horizontal_alignment: ["leading", "center", "trailing"].includes(x.horizontal_alignment ?? x.align) ? (x.horizontal_alignment ?? x.align) : x.align === "left" ? "leading" : x.align === "right" ? "trailing" : d.align ?? "center",
    size: sizeOf(x, FILL, FIT), padding: padOf(x.padding), margin: padOf(x.margin),
  };
  if (isStr(x.font_name)) t.font_name = x.font_name;
  if (x.background_color !== undefined) t.background_color = colorOf(r, x.background_color, r.bg);
  if (typeof x.visible === "boolean") t.visible = x.visible;
  const ov = overridesOf(r, x.overrides, "text");
  if (ov) t.overrides = ov;
  return t;
}
function iconC(r: R, x: Json, d: { size?: number; color?: string } = {}): Json {
  const name = iconName(x.icon_name ?? x.icon ?? x.name);
  if (x.icon_name !== undefined && x.icon_name !== name) r.fix("Mapped icons to the built-in icon set.");
  const s = num(x.size_pt ?? (typeof x.size === "number" ? x.size : undefined), d.size ?? 20);
  const out: Json = {
    id: r.id(x, "n"), type: "icon", base_url: r.o.iconBaseUrl, icon_name: name,
    formats: { svg: `${name}.svg`, png: `${name}.png`, heic: `${name}.png`, webp: `${name}.png` },
    size: isObj(x.size) ? sizeOf(x, fixed(s), fixed(s)) : sz(fixed(s), fixed(s)), padding: padOf(x.padding), margin: padOf(x.margin),
    color: colorOf(r, x.color, d.color ?? r.fg), icon_background: null,
  };
  const ib = x.icon_background ?? (x.background_color ? { color: x.background_color } : null);
  if (isObj(ib)) out.icon_background = { color: colorOf(r, ib.color, r.accent), shape: isObj(ib.shape) && ib.shape.type === "rectangle" ? { type: "rectangle", corners: ib.shape.corners ?? undefined } : { type: "circle" } };
  return out;
}
function stackC(r: R, x: Json, d: { spacing?: number } = {}): Json {
  const kids = Array.isArray(x.components) ? x.components : Array.isArray(x.children) ? x.children : Array.isArray(x.items) && x.type === "stack" ? x.items : [];
  const s: Json = {
    id: r.id(x, "s"), type: "stack", ...(isStr(x.name) ? { name: x.name } : {}), components: kids.map((k: unknown) => comp(r, k)).filter(Boolean),
    dimension: dimensionOf(x), size: sizeOf(x, FILL, FIT), spacing: num(x.spacing ?? x.gap, d.spacing ?? 0),
    padding: padOf(x.padding), margin: padOf(x.margin), background: backgroundOf(r, x.background ?? x.background_color ?? x.bg, null),
  };
  const shp = shapeOf(x); if (shp) s.shape = shp;
  const br = borderOf(r, x.border); if (br) s.border = br;
  const sh = shadowOf(r, x.shadow); if (sh) s.shadow = sh;
  if (isObj(x.badge)) {
    const bs = isObj(x.badge.stack) ? x.badge.stack : { components: [{ type: "text", text: x.badge.text ?? x.badge.label ?? "Best value", font_size: 11, font_weight: "bold", color: x.badge.color ?? "#ffffff" }], padding: { top: 3, bottom: 3, leading: 8, trailing: 8 }, background: x.badge.background ?? r.accent, shape: "pill", size: { width: "fit", height: "fit" } };
    s.badge = { style: ["edge_to_edge", "overlay", "nested"].includes(x.badge.style) ? x.badge.style : "overlay", alignment: isStr(x.badge.alignment) ? x.badge.alignment : "top", stack: stackC(r, bs) };
  }
  if (x.overflow === "scroll") s.overflow = "scroll";
  if (typeof x.visible === "boolean") s.visible = x.visible;
  const ov = overridesOf(r, x.overrides, "stack"); if (ov) s.overrides = ov;
  return s;
}
/** A component's inner stack: `stack`, else `components`, else a text from `text`/`label`. */
function innerStack(r: R, x: Json, d: (label: string) => Json): Json {
  if (isObj(x.stack)) return stackC(r, x.stack);
  if (Array.isArray(x.components)) return stackC(r, { ...x, type: "stack", id: undefined, components: x.components });
  const label = [x.text, x.label, x.title].find((v) => isStr(v));
  return stackC(r, d(isStr(label) ? label : ""));
}
function packageCard(r: R, label: string): Json {
  return {
    direction: "horizontal", distribution: "space_between", padding: { top: 14, bottom: 14, leading: 16, trailing: 16 }, spacing: 12, corner_radius: 12,
    border: { color: mix(r.fg, r.bg, 0.75), width: 1 },
    components: [
      { type: "text", text: label || "{{ product.store_product_name }}", font_size: 16, font_weight: "semibold", align: "leading", size: { width: "fill", height: "fit" } },
      { type: "text", text: "{{ product.price_per_period_abbreviated }}", font_size: 15, align: "trailing", size: { width: "fit", height: "fit" } },
    ],
    overrides: [{ conditions: [{ type: "selected" }], properties: { border: { color: r.accent, width: 2 } } }],
  };
}
function packageC(r: R, x: Json): Json {
  const avail = r.o.packages ?? [];
  let id = isStr(x.package_id) ? x.package_id : isStr(x.package) ? x.package : isStr(x.package_identifier) ? x.package_identifier : "";
  if (avail.length && !avail.includes(id)) {
    const alias = /year|annual/i.test(id) ? avail.find((p) => /annual|year/i.test(p)) : /month/i.test(id) ? avail.find((p) => /month/i.test(p)) : /week/i.test(id) ? avail.find((p) => /week/i.test(p)) : /life/i.test(id) ? avail.find((p) => /life/i.test(p)) : undefined;
    const next = alias && !r.packagesUsed.includes(alias) ? alias : avail.find((p) => !r.packagesUsed.includes(p)) ?? avail[0]!;
    if (id) r.fix(`Bound package components to the offering's packages (${id} → ${next}).`);
    id = next;
  }
  if (!id) id = "$rc_monthly";
  r.packagesUsed.push(id);
  const label = [x.label, x.text, x.title].find((v) => isStr(v)) as string | undefined;
  const p: Json = {
    id: r.id(x, "p"), type: "package", package_id: id, is_selected_by_default: x.is_selected_by_default === true || x.selected === true,
    stack: isObj(x.stack) || Array.isArray(x.components) ? innerStack(r, x, () => ({})) : stackC(r, packageCard(r, label ?? "")),
  };
  if (isStr(x.name)) p.name = x.name;
  return p;
}
function purchaseC(r: R, x: Json): Json {
  r.purchaseButtons += 1;
  const m = isObj(x.method) ? x.method.type : isStr(x.method) ? x.method : isStr(x.action) ? x.action : "in_app_checkout";
  const method = ["in_app_checkout", "web_checkout", "web_product_selection"].includes(m) ? m : "in_app_checkout";
  const accentText = luminance(r.accent) > 0.6 ? "#111111" : "#ffffff";
  return {
    id: r.id(x, "u"), type: "purchase_button", action: method, method: method === "in_app_checkout" ? { type: method } : { type: method, auto_dismiss: true, open_method: "in_app_browser" },
    stack: innerStack(r, x, (label) => ({ padding: { top: 15, bottom: 15, leading: 16, trailing: 16 }, background: r.accent, shape: "pill", components: [{ type: "text", text: label || "Continue", font_size: 17, font_weight: "semibold", color: accentText }] })),
  };
}
function actionOf(r: R, a: unknown, x: Json): Json {
  const t = isObj(a) ? a.type : a;
  if (t === "restore_purchases" || t === "restore") return { type: "restore_purchases" };
  if (t === "navigate_back" || t === "close" || t === "dismiss" || t === "back") return { type: "navigate_back" };
  if (t === "navigate_to" || t === "open_url" || t === "url" || t === "terms" || t === "privacy" || t === "privacy_policy") {
    const dest0 = isObj(a) && isStr(a.destination) ? a.destination : t === "terms" ? "terms" : t === "privacy" || t === "privacy_policy" ? "privacy_policy" : "url";
    const dest = dest0 === "privacy" ? "privacy_policy" : dest0;
    if (dest === "customer_center" || dest === "offer_code") return { type: "navigate_to", destination: dest };
    if (!["terms", "privacy_policy", "url", "web_paywall_link"].includes(dest)) return { type: "navigate_back" };
    const urlSrc = isObj(a) ? (a.url ?? x.url) : x.url;
    return { type: "navigate_to", destination: dest, url: { url_lid: r.urlKey(urlSrc), method: isObj(urlSrc) && ["in_app_browser", "external_browser", "deep_link"].includes(urlSrc.method) ? urlSrc.method : "in_app_browser" } };
  }
  r.fix("Turned buttons with an unknown action into restore buttons.");
  return { type: "restore_purchases" };
}
function buttonC(r: R, x: Json): Json {
  const action = actionOf(r, x.action, x);
  const defLabel = action.type === "restore_purchases" ? "Restore purchases" : action.type === "navigate_back" ? "Close" : action.destination === "terms" ? "Terms" : action.destination === "privacy_policy" ? "Privacy" : "Learn more";
  return { id: r.id(x, "b"), type: "button", ...(isStr(x.name) ? { name: x.name } : {}), action, stack: innerStack(r, x, (label) => ({ size: { width: "fit", height: "fit" }, components: [{ type: "text", text: label || defLabel, font_size: 13, color: r.muted, size: { width: "fit", height: "fit" } }] })) };
}
function imageC(r: R, x: Json): Json | null {
  const src = imageSourceOf(x.source ?? x.url ?? x.src ?? x.image);
  if (!src) { r.fix("Removed images without a URL."); return null; }
  const out: Json = { id: r.id(x, "i"), type: "image", source: src, size: sizeOf(x, FILL, FIT), fit_mode: x.fit_mode === "fit" ? "fit" : "fill", padding: padOf(x.padding), margin: padOf(x.margin) };
  if (isObj(x.mask_shape) && ["rectangle", "circle", "concave", "convex"].includes(x.mask_shape.type)) out.mask_shape = x.mask_shape;
  else if (x.corner_radius !== undefined) out.mask_shape = rounded(num(x.corner_radius, 0));
  if (x.color_overlay !== undefined) out.color_overlay = colorOf(r, x.color_overlay, "#00000044");
  return out;
}
function timelineC(r: R, x: Json): Json | null {
  const items = Array.isArray(x.items) ? x.items : [];
  if (!items.length) { r.fix("Removed an empty timeline."); return null; }
  return {
    id: r.id(x, "l"), type: "timeline", icon_alignment: x.icon_alignment === "title_and_description" ? "title_and_description" : "title",
    item_spacing: num(x.item_spacing, 18), text_spacing: num(x.text_spacing, 4), column_gutter: num(x.column_gutter, 14), size: sizeOf(x, FILL, FIT), padding: padOf(x.padding), margin: padOf(x.margin),
    items: items.map((it: unknown) => {
      const i: Json = isObj(it) ? it : { title: String(it) };
      const title = isObj(i.title) ? textC(r, i.title, { size: 16, weight: "semibold", align: "leading" }) : textC(r, { text: i.title ?? i.text ?? "" }, { size: 16, weight: "semibold", align: "leading" });
      const desc = i.description === undefined || i.description === null ? null : isObj(i.description) ? textC(r, i.description, { size: 14, align: "leading", color: r.muted }) : textC(r, { text: String(i.description) }, { size: 14, align: "leading", color: r.muted });
      const ic = isObj(i.icon) ? iconC(r, i.icon, { size: 16, color: "#ffffff" }) : iconC(r, { icon_name: i.icon ?? "check", icon_background: { color: r.accent }, padding: 6 }, { size: 16, color: luminance(r.accent) > 0.6 ? "#111111" : "#ffffff" });
      if (!isObj(i.icon)) ic.icon_background = { color: scheme(r.accent), shape: { type: "circle" } };
      const conn = isObj(i.connector) ? { width: num(i.connector.width, 6), color: colorOf(r, i.connector.color, r.accent), margin: padOf(i.connector.margin, pad(2, 0)) } : { width: 6, color: scheme(mix(r.accent, r.bg, 0.5)), margin: pad(2, 0) };
      return { title, ...(desc ? { description: desc } : {}), icon: ic, connector: conn };
    }),
  };
}
function carouselC(r: R, x: Json): Json | null {
  const pages = (Array.isArray(x.pages) ? x.pages : []).map((p: unknown) => (isObj(p) ? stackC(r, p.type === "stack" || p.components ? p : { components: [p] }) : null)).filter(Boolean);
  if (!pages.length) { r.fix("Removed an empty carousel."); return null; }
  const pc = isObj(x.page_control) ? x.page_control : {};
  return {
    id: r.id(x, "r"), type: "carousel", size: sizeOf(x, FILL, FIT), padding: padOf(x.padding), margin: padOf(x.margin), background: backgroundOf(r, x.background, null),
    pages, page_alignment: ["top", "center", "bottom"].includes(x.page_alignment) ? x.page_alignment : "center", page_spacing: int(x.page_spacing, 12), page_peek: int(x.page_peek, 0),
    initial_page_index: Math.max(0, Math.min(pages.length - 1, int(x.initial_page_index, 0))), loop: x.loop === true,
    ...(isObj(x.auto_advance) ? { auto_advance: { ms_time_per_page: int(x.auto_advance.ms_time_per_page, 4000), ms_transition_time: int(x.auto_advance.ms_transition_time, 400), transition_type: x.auto_advance.transition_type === "fade" ? "fade" : "slide" } } : {}),
    page_control: {
      position: pc.position === "top" ? "top" : "bottom", spacing: int(pc.spacing, 6), padding: padOf(pc.padding, pad(10, 0)), margin: padOf(pc.margin),
      default: { width: int(pc.default?.width, 6), height: int(pc.default?.height, 6), color: colorOf(r, pc.default?.color, mix(r.fg, r.bg, 0.75)) },
      active: { width: int(pc.active?.width, 18), height: int(pc.active?.height, 6), color: colorOf(r, pc.active?.color, r.fg) },
    },
  };
}
function tabsC(r: R, x: Json): Json | null {
  const tabs = (Array.isArray(x.tabs) ? x.tabs : []).filter(isObj);
  if (!tabs.length) { r.fix("Removed tabs without any tab."); return null; }
  const out = tabs.map((t: Json, i: number) => {
    const id = isStr(t.id) && t.id ? t.id : `tab${i + 1}`;
    const st = isObj(t.stack) ? t.stack : { components: Array.isArray(t.components) ? t.components : [] };
    const fixed = stackC(r, st, { spacing: 14 });
    if (!fixed.components.some((c: Json) => c.type === "tab_control")) fixed.components.unshift({ id: r.b.id("c"), type: "tab_control" });
    return { id, name: isStr(t.name) ? t.name : isStr(t.label) ? t.label : `Tab ${i + 1}`, stack: fixed };
  });
  const ids = out.map((t: Json) => t.id);
  const ctl = isObj(x.control) && isObj(x.control.stack) ? stackC(r, x.control.stack) : stackC(r, {
    direction: "horizontal", spacing: 4, padding: 4, background: mix(r.fg, r.bg, 0.9), corner_radius: 10,
    components: out.map((t: Json) => ({ type: "tab_control_button", tab_id: t.id, stack: { padding: { top: 8, bottom: 8, leading: 8, trailing: 8 }, corner_radius: 8, components: [{ type: "text", text: t.name, font_size: 14, font_weight: "semibold", size: { width: "fit", height: "fit" } }], overrides: [{ conditions: [{ type: "selected" }], properties: { background: { type: "color", value: scheme(r.bg) } } }] } })),
  });
  return {
    id: r.id(x, "a"), type: "tabs", size: sizeOf(x, FILL, FIT), padding: padOf(x.padding), margin: padOf(x.margin),
    control: { type: isObj(x.control) && x.control.type === "toggle" ? "toggle" : "buttons", stack: ctl }, tabs: out,
    default_tab_id: ids.includes(x.default_tab_id) ? x.default_tab_id : ids[0],
  };
}
function countdownC(r: R, x: Json): Json {
  const raw = isObj(x.style) ? x.style.date : x.date ?? x.end ?? x.ends_at;
  const date = isStr(raw) && !Number.isNaN(Date.parse(raw)) ? new Date(Date.parse(raw)).toISOString().replace(/\.\d{3}Z$/, "Z") : new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  if (!isStr(raw) || Number.isNaN(Date.parse(raw))) r.fix("Gave a countdown without a valid end date one three days from now.");
  const cs = isObj(x.countdown_stack) ? stackC(r, x.countdown_stack) : stackC(r, { components: [{ type: "text", text: x.text ?? "Ends in {{ count_days_without_zero }}d {{ count_hours_with_zero }}:{{ count_minutes_with_zero }}:{{ count_seconds_with_zero }}", font_size: 15, font_weight: "semibold" }] });
  return { id: r.id(x, "d"), type: "countdown", style: { type: "date", date }, count_from: ["days", "hours", "minutes"].includes(x.count_from) ? x.count_from : "days", countdown_stack: cs, ...(isObj(x.end_stack) ? { end_stack: stackC(r, x.end_stack) } : {}), ...(isObj(x.fallback) ? { fallback: stackC(r, x.fallback) } : {}) };
}
function videoC(r: R, x: Json): Json | null {
  const src = isObj(x.source) && isObj(x.source.light) ? x.source.light : x;
  const url = [src.url, x.url, x.src].find((u) => isStr(u) && /^https?:\/\//.test(u));
  if (!isStr(url)) { r.fix("Removed videos without a URL."); return null; }
  const fb = imageSourceOf(x.fallback_source ?? x.poster);
  return { id: r.id(x, "v"), type: "video", source: { light: { width: int(src.width, 1080), height: int(src.height, 1920), url } }, ...(fb ? { fallback_source: fb } : {}), show_controls: x.show_controls === true, auto_play: x.auto_play !== false, loop: x.loop !== false, mute_audio: x.mute_audio !== false, size: sizeOf(x, FILL, FIT), fit_mode: x.fit_mode === "fit" ? "fit" : "fill", padding: padOf(x.padding), margin: padOf(x.margin) };
}
function webViewC(r: R, x: Json): Json | null {
  if (!isStr(x.url) || !/^https:\/\/[^/\s{}]+/.test(x.url)) { r.fix("Removed web views without an https URL."); return null; }
  return { id: r.id(x, "w"), type: "web_view", protocol_version: 1, url: x.url, size: sizeOf(x, FILL, fixed(240)) };
}
/** "features": a list of rows with an icon and a text, the most common paywall block. */
function featuresC(r: R, x: Json): Json {
  const items = (Array.isArray(x.items) ? x.items : Array.isArray(x.features) ? x.features : []).map((it: unknown) => (isObj(it) ? it : { text: String(it) }));
  return stackC(r, {
    spacing: 12, align: "leading", padding: { top: 4, bottom: 4, leading: 8, trailing: 8 },
    components: items.map((it: Json) => ({ direction: "horizontal", spacing: 12, align: "center", components: [{ type: "icon", icon_name: it.icon ?? "check_circle", color: r.accent, size_pt: 20 }, { type: "text", text: it.text ?? it.title ?? "", align: "leading", font_size: 16 }] })),
  });
}

function comp(r: R, raw: unknown): Json | null {
  if (isStr(raw)) return textC(r, { text: raw });
  if (!isObj(raw)) return null;
  let t = raw.type;
  if (!isStr(t)) t = raw.components ? "stack" : raw.text !== undefined ? "text" : raw.package_id ? "package" : null;
  const alias: Record<string, string> = { footer: "sticky_footer", purchase: "purchase_button", cta: "purchase_button", purchasebutton: "purchase_button", "purchase-button": "purchase_button", vstack: "stack", hstack: "stack", zstack: "stack", row: "stack", column: "stack", container: "stack", label: "text", title: "text", heading: "text", paragraph: "text", img: "image", picture: "image", tab: "tabs", slider: "carousel", pages: "carousel", timer: "countdown", webview: "web_view" };
  if (isStr(t) && alias[t.toLowerCase()]) {
    const was = t.toLowerCase();
    t = alias[was]!;
    if (was === "hstack" || was === "row") raw.direction ??= "horizontal";
    if (was === "zstack") raw.direction ??= "zlayer";
    if (was === "title" || was === "heading") { raw.font_size ??= 28; raw.font_weight ??= "bold"; }
  }
  switch (t) {
    case "text": return textC(r, raw);
    case "image": return imageC(r, raw);
    case "icon": return iconC(r, raw);
    case "stack": return stackC(r, raw);
    case "button": return buttonC(r, raw);
    case "package": return packageC(r, raw);
    case "purchase_button": return purchaseC(r, raw);
    case "sticky_footer": return { id: r.id(raw, "f"), type: "sticky_footer", stack: innerStack(r, raw, () => ({})) };
    case "timeline": return timelineC(r, raw);
    case "tabs": return tabsC(r, raw);
    case "tab_control": return { id: r.id(raw, "c"), type: "tab_control" };
    case "tab_control_button": return isStr(raw.tab_id) ? { id: r.id(raw, "k"), type: "tab_control_button", tab_id: raw.tab_id, stack: innerStack(r, raw, (l) => ({ components: [{ type: "text", text: l || raw.tab_id }] })) } : null;
    case "tab_control_toggle": return { id: r.id(raw, "g"), type: "tab_control_toggle", thumb_color_on: colorOf(r, raw.thumb_color_on, "#ffffff"), thumb_color_off: colorOf(r, raw.thumb_color_off, "#ffffff"), track_color_on: colorOf(r, raw.track_color_on, r.accent), track_color_off: colorOf(r, raw.track_color_off, mix(r.fg, r.bg, 0.8)) };
    case "carousel": return carouselC(r, raw);
    case "video": return videoC(r, raw);
    case "countdown": return countdownC(r, raw);
    case "web_view": return webViewC(r, raw);
    case "features": case "feature_list": case "benefits": return featuresC(r, raw);
    case "packages": case "plans": case "package_list": {
      const list = r.o.packages?.length ? r.o.packages : ["$rc_annual", "$rc_monthly"];
      const sel = isStr(raw.selected) ? raw.selected : list.find((p) => /annual|year/i.test(p)) ?? list[0];
      return stackC(r, { spacing: 10, components: list.map((p) => ({ type: "package", package_id: p, is_selected_by_default: p === sel })) });
    }
    case "spacer": return stackC(r, { size: { width: "fill", height: num(raw.height ?? raw.size, 16) } });
    default:
      if (isObj(raw.fallback)) return comp(r, raw.fallback);
      r.fix(`Removed components of unknown type${isStr(t) ? ` "${t}"` : ""}.`);
      return null;
  }
}

function findAll(x: unknown, type: string, out: Json[] = []): Json[] {
  if (Array.isArray(x)) { x.forEach((y) => findAll(y, type, out)); return out; }
  if (!isObj(x)) return out;
  if (x.type === type) out.push(x);
  for (const [k, v] of Object.entries(x)) if (k !== "overrides") findAll(v, type, out);
  return out;
}

/** Repairs a lenient paywall document into a valid one. */
export function repairPaywall(input: unknown, opts: RepairOptions): Repaired {
  const doc: Json = isObj(input) ? input : {};
  const locale = isStr(doc.default_locale) ? doc.default_locale : opts.locale ?? "en_US";
  const locs: Json = isObj(doc.components_localizations) ? doc.components_localizations : {};
  const base: Json = isObj(doc.components_config?.base) ? doc.components_config.base : {};
  const bgRaw = base.background ?? doc.background ?? doc.background_color ?? opts.colors?.background;
  const bgHex = isStr(bgRaw) && hex8(bgRaw) ? bgRaw : isObj(bgRaw) && bgRaw.type === "color" && hex8(bgRaw.value?.light?.value) ? `#${hex8(bgRaw.value.light.value)!.slice(1, 7)}` : undefined;
  const r = new R({ ...opts, locale, colors: { ...opts.colors, ...(bgHex ? { background: bgHex } : {}) } }, isObj(locs[locale]) ? locs[locale] : {});

  // The main stack: components_config.base.stack, or the short form's `components`.
  const rawStack = isObj(base.stack) ? base.stack : { components: Array.isArray(doc.components) ? doc.components : Array.isArray(doc.stack) ? doc.stack : [], spacing: 18, padding: { top: 24, bottom: 24, leading: 20, trailing: 20 } };
  const stack = stackC(r, { ...rawStack, size: rawStack.size ?? { width: "fill", height: "fill" } }, { spacing: 16 });
  // A sticky footer given inside the main components moves to base.sticky_footer.
  let footer: Json | null = null;
  const fIdx = stack.components.findIndex((c: Json) => c.type === "sticky_footer");
  if (fIdx >= 0) { footer = stack.components.splice(fIdx, 1)[0]!; r.fix("Moved the sticky footer out of the main stack."); }
  const rawFooter = isObj(base.sticky_footer) ? base.sticky_footer : Array.isArray(doc.footer) ? { components: doc.footer } : isObj(doc.footer) ? doc.footer : null;
  if (rawFooter) footer = { id: r.id(rawFooter, "f"), type: "sticky_footer", stack: stackC(r, isObj(rawFooter.stack) ? rawFooter.stack : { ...rawFooter, id: undefined, type: "stack", spacing: rawFooter.spacing ?? 12, padding: rawFooter.padding ?? { top: 16, bottom: 16, leading: 20, trailing: 20 } }) };

  // Packages: when there are none, add the offering's packages as a plan list at the end of the main stack.
  const all = [stack, footer];
  if (!findAll(all, "package").length) {
    const list = opts.packages?.length ? opts.packages : ["$rc_annual", "$rc_monthly"];
    const sel = list.find((p) => /annual|year/i.test(p)) ?? list[0]!;
    stack.components.push(stackC(r, { spacing: 10, components: list.map((p) => ({ type: "package", package_id: p, is_selected_by_default: p === sel })) }));
    r.fix("Added the offering's packages as a plan list.");
  } else {
    // Exactly one package selected by default per group of siblings.
    const pk = findAll(all, "package");
    if (!pk.some((p) => p.is_selected_by_default)) { (pk.find((p) => /annual|year/i.test(p.package_id)) ?? pk[0]!).is_selected_by_default = true; r.fix("Selected a package by default."); }
  }
  // A purchase button: when there is none, a sticky footer with one and a restore button.
  if (!findAll(all, "purchase_button").length) {
    const fs = footer?.stack ?? stackC(r, { spacing: 12, padding: { top: 16, bottom: 16, leading: 20, trailing: 20 }, background: r.bg });
    fs.components.unshift(purchaseC(r, { text: "Continue" }));
    if (!findAll(fs, "button").length) fs.components.push(buttonC(r, { action: "restore" }));
    footer = footer ?? { id: r.b.id("f"), type: "sticky_footer", stack: fs };
    r.fix("Added a purchase button.");
  }

  const strings: Record<string, unknown> = { ...(isObj(locs[locale]) ? locs[locale] : {}), ...r.b.strings };
  const localizations: Record<string, Record<string, unknown>> = { [locale]: strings };
  for (const [l, t] of Object.entries(locs)) if (l !== locale && isObj(t)) localizations[l] = t;
  // Drop strings nothing uses from the default locale only when they came from this repair.
  const background = backgroundOf(r, base.background ?? doc.background ?? doc.background_color, r.bg)!;
  const name = isStr(doc.name) ? doc.name : null;
  return {
    doc: { components_config: { base: { stack, ...(footer ? { sticky_footer: footer } : {}), background } }, components_localizations: localizations as PaywallDoc["components_localizations"], default_locale: locale },
    fixes: r.fixes, name,
  };
}

/** The component types the repair understands beyond the SDK's own (short forms for prompts and pasted JSON). */
export const LENIENT_TYPES = [...COMPONENT_TYPES, "features", "packages", "spacer"] as const;
