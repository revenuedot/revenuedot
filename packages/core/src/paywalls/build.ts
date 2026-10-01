/**
 * Builders for paywall components (the JSON the RevenueCat SDKs render as "Paywalls V2"). Every builder returns a
 * component with all the fields the SDK's decoder requires (see prd/paywalls/PRD.md and validate.ts), so anything made
 * here decodes. Texts go through `DocBuilder.str`, which stores the string in the localization table and returns its key.
 */

export type Json = Record<string, any>;

export interface PaywallDoc {
  components_config: { base: { stack: Json; sticky_footer?: Json | null; background: Json } };
  components_localizations: Record<string, Record<string, string>>;
  default_locale: string;
}

/** "#rgb", "#rrggbb" or "#rrggbbaa" (with or without "#") → "#rrggbbaa", or null. */
export function hex8(c: unknown): string | null {
  if (typeof c !== "string") return null;
  const s = c.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return `#${[...s].map((x) => x + x).join("")}ff`;
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}ff`;
  if (/^[0-9a-f]{8}$/.test(s)) return `#${s}`;
  return null;
}
export const colorInfo = (c: string) => ({ type: "hex", value: hex8(c) ?? "#000000ff" });
/** A colour scheme: light, and dark when it differs. */
export const scheme = (light: string, dark?: string | null) => ({ light: colorInfo(light), ...(dark ? { dark: colorInfo(dark) } : {}) });
export const gradient = (degrees: number, stops: [string, number][], dark?: [string, number][]) => {
  const pts = (s: [string, number][]) => s.map(([color, percent]) => ({ color: hex8(color) ?? "#000000ff", percent: Math.round(percent) }));
  return { light: { type: "linear", degrees: Math.round(degrees), points: pts(stops) }, ...(dark ? { dark: { type: "linear", degrees: Math.round(degrees), points: pts(dark) } } : {}) };
};
export const ZERO = { top: 0, bottom: 0, leading: 0, trailing: 0 };
export const pad = (v: number, h = v, b = v, t = h) => ({ top: v, bottom: b, leading: h, trailing: t });
export const FILL = { type: "fill", value: null };
export const FIT = { type: "fit", value: null };
export const fixed = (n: number) => ({ type: "fixed", value: Math.max(0, Math.round(n)) });
export const relative = (n: number) => ({ type: "relative", value: n });
export const sz = (width: Json = FILL, height: Json = FIT) => ({ width, height });
export const corners = (r: number) => ({ top_leading: r, top_trailing: r, bottom_leading: r, bottom_trailing: r });
export const rounded = (r: number) => ({ type: "rectangle", corners: corners(r) });
export const PILL = { type: "pill" };
export const border = (color: string, width = 1, dark?: string) => ({ color: scheme(color, dark), width });
export const shadow = (color: string, radius: number, x = 0, y = 0) => ({ color: scheme(color), radius, x, y });
export const colorBg = (light: string, dark?: string | null) => ({ type: "color", value: scheme(light, dark) });
export const imageUrls = (url: string, width: number, height: number) => ({ original: url, heic: url, heic_low_res: url, webp: url, webp_low_res: url, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });

export type Align = "leading" | "center" | "trailing";
export type VAlign = "top" | "center" | "bottom";
export type Distribution = "start" | "center" | "end" | "space_between" | "space_around" | "space_evenly";
export type Weight = "thin" | "extra_light" | "light" | "regular" | "medium" | "semibold" | "bold" | "extra_bold" | "black";

export interface StackOpts {
  dir?: "vertical" | "horizontal" | "zlayer";
  /** Vertical: leading/center/trailing; horizontal: top/center/bottom; zlayer: any two-dimension alignment. */
  align?: string;
  distribution?: Distribution;
  spacing?: number;
  padding?: Json; margin?: Json; size?: Json;
  bg?: string | null; bgDark?: string | null; background?: Json | null;
  shape?: Json; border?: Json; shadow?: Json; badge?: Json; overrides?: Json[]; name?: string; scroll?: boolean;
}
export interface TextOpts {
  size?: number; weight?: Weight; align?: Align; color?: string; colorDark?: string | null; width?: Json; height?: Json;
  padding?: Json; margin?: Json; bg?: string; overrides?: Json[]; name?: string; font?: string;
}

/** Collects localized strings and hands out unique ids while a paywall is built. */
export class DocBuilder {
  readonly strings: Record<string, string> = {};
  private n = 0;
  private keys = 0;
  constructor(readonly locale = "en_US", private readonly seed = "") {}

  /** A unique 10-character id. Deterministic for the same build, so templates diff cleanly. */
  id(prefix = "c") {
    this.n += 1;
    return `${prefix[0]}${`${this.seed}${this.n.toString(36)}`.padStart(9, "0").slice(-9)}`;
  }
  /** Stores a string and returns its localization key. */
  str(text: string) {
    this.keys += 1;
    const k = `l${`${this.seed}${this.keys.toString(36)}`.padStart(9, "0").slice(-9)}`;
    this.strings[k] = text;
    return k;
  }

  stack(components: Json[], o: StackOpts = {}): Json {
    const dir = o.dir ?? "vertical";
    const dimension = dir === "zlayer" ? { type: "zlayer", alignment: o.align ?? "center" }
      : { type: dir, alignment: o.align ?? (dir === "vertical" ? "center" : "center"), distribution: o.distribution ?? "start" };
    const background = o.background !== undefined ? o.background : o.bg ? colorBg(o.bg, o.bgDark) : null;
    return {
      id: this.id("s"), ...(o.name ? { name: o.name } : {}), type: "stack", components, dimension, size: o.size ?? sz(), spacing: o.spacing ?? 0,
      padding: o.padding ?? ZERO, margin: o.margin ?? ZERO, background,
      ...(o.shape ? { shape: o.shape } : {}), ...(o.border ? { border: o.border } : {}), ...(o.shadow ? { shadow: o.shadow } : {}),
      ...(o.badge ? { badge: o.badge } : {}), ...(o.scroll ? { overflow: "scroll" } : {}), ...(o.overrides?.length ? { overrides: o.overrides } : {}),
    };
  }
  text(value: string, o: TextOpts = {}): Json {
    return {
      id: this.id("t"), ...(o.name ? { name: o.name } : {}), type: "text", text_lid: this.str(value), color: scheme(o.color ?? "#111111", o.colorDark),
      font_size: o.size ?? 16, font_weight: o.weight ?? "regular", horizontal_alignment: o.align ?? "center",
      size: sz(o.width ?? FILL, o.height ?? FIT), padding: o.padding ?? ZERO, margin: o.margin ?? ZERO,
      ...(o.font ? { font_name: o.font } : {}), ...(o.bg ? { background_color: scheme(o.bg) } : {}), ...(o.overrides?.length ? { overrides: o.overrides } : {}),
    };
  }
  /** Text whose string changes when the selected package has an intro offer (a free trial). */
  textIntro(value: string, introValue: string, o: TextOpts = {}): Json {
    return this.text(value, { ...o, overrides: [...(o.overrides ?? []), { conditions: [{ type: "intro_offer" }], properties: { text_lid: this.str(introValue) } }] });
  }
  image(url: string, width: number, height: number, o: { size?: Json; fit?: "fit" | "fill"; mask?: Json; margin?: Json; padding?: Json; darkUrl?: string; overlay?: string; name?: string } = {}): Json {
    return {
      id: this.id("i"), ...(o.name ? { name: o.name } : {}), type: "image", source: { light: imageUrls(url, width, height), ...(o.darkUrl ? { dark: imageUrls(o.darkUrl, width, height) } : {}) },
      size: o.size ?? sz(FILL, FIT), fit_mode: o.fit ?? "fill", margin: o.margin ?? ZERO, padding: o.padding ?? ZERO,
      ...(o.mask ? { mask_shape: o.mask } : {}), ...(o.overlay ? { color_overlay: scheme(o.overlay) } : {}),
    };
  }
  icon(baseUrl: string, name: string, o: { size?: number; color?: string; colorDark?: string | null; bg?: string; bgShape?: "circle" | "rectangle"; padding?: Json; margin?: Json } = {}): Json {
    const s = o.size ?? 20;
    return {
      id: this.id("n"), type: "icon", base_url: baseUrl.replace(/\/+$/, ""), icon_name: name,
      formats: { svg: `${name}.svg`, png: `${name}.png`, heic: `${name}.png`, webp: `${name}.png` },
      size: sz(fixed(s), fixed(s)), padding: o.padding ?? ZERO, margin: o.margin ?? ZERO, color: scheme(o.color ?? "#111111", o.colorDark),
      icon_background: o.bg ? { color: scheme(o.bg), shape: o.bgShape === "rectangle" ? { type: "rectangle", corners: corners(8) } : { type: "circle" } } : null,
    };
  }
  button(action: Json, stack: Json, name?: string): Json {
    return { id: this.id("b"), ...(name ? { name } : {}), type: "button", action, stack };
  }
  restore(label: string, color: string, size = 13): Json {
    return this.button({ type: "restore_purchases" }, this.stack([this.text(label, { size, color, width: FIT })], { size: sz(FIT, FIT) }), "Restore");
  }
  close(baseUrl: string, color: string): Json {
    return this.button({ type: "navigate_back" }, this.stack([this.icon(baseUrl, "x", { size: 18, color })], { size: sz(FIT, FIT), padding: pad(6) }), "Close");
  }
  /** A link button to terms, privacy or any URL. The URL is a localized string, as the SDK requires. */
  link(label: string, destination: "terms" | "privacy_policy" | "url", url: string, color: string, size = 12): Json {
    return this.button({ type: "navigate_to", destination, url: { url_lid: this.str(url), method: "in_app_browser" } },
      this.stack([this.text(label, { size, color, width: FIT })], { size: sz(FIT, FIT) }), label);
  }
  pkg(packageId: string, selected: boolean, stack: Json, name?: string): Json {
    return { id: this.id("p"), ...(name ? { name } : {}), type: "package", package_id: packageId, is_selected_by_default: selected, stack };
  }
  purchase(stack: Json, method: "in_app_checkout" | "web_checkout" | "web_product_selection" = "in_app_checkout"): Json {
    return { id: this.id("u"), type: "purchase_button", action: method, method: method === "in_app_checkout" ? { type: method } : { type: method, auto_dismiss: true, open_method: "in_app_browser" }, stack };
  }
  footer(stack: Json): Json {
    return { id: this.id("f"), type: "sticky_footer", stack };
  }
  timeline(items: { icon: string; title: string; description?: string }[], o: { baseUrl: string; color: string; muted: string; accent: string; iconBg?: string; iconColor?: string }): Json {
    return {
      id: this.id("l"), type: "timeline", icon_alignment: "title", item_spacing: 18, text_spacing: 4, column_gutter: 14,
      size: sz(FILL, FIT), padding: ZERO, margin: ZERO,
      items: items.map((it) => ({
        title: this.text(it.title, { size: 16, weight: "semibold", align: "leading", color: o.color }),
        ...(it.description ? { description: this.text(it.description, { size: 14, align: "leading", color: o.muted }) } : {}),
        icon: this.icon(o.baseUrl, it.icon, { size: 16, color: o.iconColor ?? "#ffffff", bg: o.iconBg ?? o.accent, padding: pad(6) }),
        connector: { width: 6, color: scheme(o.iconBg ?? o.accent), margin: pad(2, 0) },
      })),
    };
  }
  carousel(pages: Json[], o: { peek?: number; spacing?: number; loop?: boolean; autoMs?: number; dot?: string; dotActive?: string; height?: number } = {}): Json {
    return {
      id: this.id("r"), type: "carousel", size: sz(FILL, o.height ? fixed(o.height) : FIT), padding: ZERO, margin: ZERO, background: null,
      pages, page_alignment: "center", page_spacing: o.spacing ?? 12, page_peek: o.peek ?? 0, initial_page_index: 0, loop: o.loop ?? false,
      ...(o.autoMs ? { auto_advance: { ms_time_per_page: o.autoMs, ms_transition_time: 400, transition_type: "slide" } } : {}),
      page_control: {
        position: "bottom", spacing: 6, padding: pad(10, 0), margin: ZERO,
        default: { width: 6, height: 6, color: scheme(o.dot ?? "#d4d4d4") }, active: { width: 18, height: 6, color: scheme(o.dotActive ?? "#111111") },
      },
    };
  }
  countdown(endIso: string, countdownStack: Json, endStack?: Json, countFrom: "days" | "hours" | "minutes" = "days"): Json {
    return { id: this.id("d"), type: "countdown", style: { type: "date", date: endIso }, count_from: countFrom, countdown_stack: countdownStack, ...(endStack ? { end_stack: endStack } : {}) };
  }
  /** Tabs: `control` holds the tab buttons; each tab's stack shows the control where `tab_control` sits. */
  tabs(tabs: { id: string; label: string; content: Json[] }[], o: { selectedBg: string; selectedFg: string; fg: string; trackBg: string; defaultTab?: string }): Json {
    const btn = (t: { id: string; label: string }) => ({
      id: this.id("k"), type: "tab_control_button", tab_id: t.id,
      stack: this.stack([this.text(t.label, { size: 14, weight: "semibold", color: o.fg, width: FIT, overrides: [{ conditions: [{ type: "selected" }], properties: { color: scheme(o.selectedFg) } }] })], {
        size: sz(FILL, FIT), padding: pad(8, 8), shape: rounded(8), overrides: [{ conditions: [{ type: "selected" }], properties: { background: colorBg(o.selectedBg) } }],
      }),
    });
    return {
      id: this.id("a"), type: "tabs", size: sz(FILL, FIT), padding: ZERO, margin: ZERO,
      control: { type: "buttons", stack: this.stack(tabs.map(btn), { dir: "horizontal", spacing: 4, padding: pad(4), bg: o.trackBg, shape: rounded(10) }) },
      tabs: tabs.map((t) => ({ id: t.id, name: t.label, stack: this.stack([{ id: this.id("c"), type: "tab_control" }, ...t.content], { spacing: 14 }) })),
      default_tab_id: o.defaultTab ?? tabs[0]?.id,
    };
  }
  video(url: string, width: number, height: number, o: { poster?: string; loop?: boolean; autoPlay?: boolean; mute?: boolean } = {}): Json {
    return {
      id: this.id("v"), type: "video", source: { light: { width, height, url } }, ...(o.poster ? { fallback_source: { light: imageUrls(o.poster, width, height) } } : {}),
      show_controls: false, auto_play: o.autoPlay ?? true, loop: o.loop ?? true, mute_audio: o.mute ?? true, size: sz(FILL, FIT), fit_mode: "fill", padding: ZERO, margin: ZERO,
    };
  }
  webView(url: string, height = 240): Json {
    return { id: this.id("w"), type: "web_view", protocol_version: 1, url, size: sz(FILL, fixed(height)) };
  }

  doc(stack: Json, footer: Json | null, background: Json): PaywallDoc {
    return {
      components_config: { base: { stack, ...(footer ? { sticky_footer: footer } : {}), background } },
      components_localizations: { [this.locale]: { ...this.strings } },
      default_locale: this.locale,
    };
  }
}

const SKIP = new Set(["overrides", "source", "fallback_source", "color", "background", "background_color", "border", "shadow", "size", "padding", "margin", "dimension", "formats", "icon_background", "action", "method", "style", "page_control", "shape", "mask_shape", "color_overlay"]);

/** Walks every component of a paywall (including timeline items, tabs, carousel pages, badges and overrides' stacks). */
export function forEachComponent(root: unknown, fn: (c: Json, parent: Json | null) => void, parent: Json | null = null) {
  if (Array.isArray(root)) { for (const x of root) forEachComponent(x, fn, parent); return; }
  if (!root || typeof root !== "object") return;
  const o = root as Json;
  const isComponent = typeof o.type === "string" && ("id" in o || ["stack", "text", "image", "icon", "button", "package", "purchase_button", "sticky_footer", "timeline", "tabs", "tab_control", "tab_control_button", "tab_control_toggle", "carousel", "video", "countdown", "web_view", "footer"].includes(o.type));
  if (isComponent) fn(o, parent);
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.has(k)) continue;
    if (v && typeof v === "object") forEachComponent(v, fn, isComponent ? o : parent);
  }
}

/** Every localization key a paywall uses: text ids, override text ids and URL ids. */
export function usedStringKeys(config: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x as Json)) {
      if ((k === "text_lid" || k === "url_lid" || k === "override_source_lid") && typeof v === "string") keys.add(v);
      else walk(v);
    }
  };
  walk(config);
  return keys;
}
