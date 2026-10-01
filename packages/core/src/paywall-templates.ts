/**
 * Paywall templates: builds paywall components (the JSON the RevenueCat SDKs render as "Paywalls V2") from a few
 * fields, so a paywall can be made without a visual editor. The shapes follow a paywall exported from RevenueCat's own
 * editor (purchases-ios Tests/TestingApps/PaywallFixtures/Resources/reported_tabs.json): every stack has id, type,
 * dimension, size, spacing, padding and margin; text points at a localization id (`text_lid`); packages wrap a stack and
 * name an offering package by its identifier; the purchase button sits in a sticky footer.
 */

export type PaywallTemplate = "classic" | "hero" | "minimal";

export interface PaywallTemplateInput {
  template: PaywallTemplate;
  headline: string;
  subheadline?: string;
  features?: string[];
  /** Package identifiers of the offering, in display order, with the label shown for each ("Monthly", "Yearly ..."). */
  packages: { id: string; label: string }[];
  /** The package selected when the paywall opens. Default: the first. */
  selectedPackage?: string;
  cta?: string;
  restoreLabel?: string;
  /** Colours as #rrggbb. */
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  /** Hero image URL (template "hero"). */
  imageUrl?: string;
}

const hex = (c: string, alpha = "ff") => {
  const v = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  return `#${(v?.[1] ?? "000000").toLowerCase()}${v?.[2] ?? alpha}`;
};
const color = (c: string, alpha?: string) => ({ light: { type: "hex", value: hex(c, alpha) } });
const zero = { bottom: 0, leading: 0, top: 0, trailing: 0 };
const pad = (v: number, h = v) => ({ bottom: v, leading: h, top: v, trailing: h });
const fill = { type: "fill", value: null };
const fit = { type: "fit", value: null };

/** Short stable ids: the editor uses 10 hex characters; ours are derived from a counter so output is deterministic. */
function ids() {
  let n = 0;
  return (prefix: string) => `${prefix}${(++n).toString(16).padStart(10 - prefix.length, "0")}`.slice(0, 10);
}

export function buildPaywall(input: PaywallTemplateInput) {
  const id = ids();
  const loc: Record<string, string> = {};
  const lid = (text: string) => { const k = id("l"); loc[k] = text; return k; };
  const fg = input.textColor ?? (input.template === "hero" ? "#ffffff" : "#111111");
  const bg = input.backgroundColor ?? (input.template === "hero" ? "#111111" : "#ffffff");
  const accent = input.accentColor ?? "#f7b500";
  const accentText = isLight(accent) ? "#111111" : "#ffffff";
  const muted = mix(fg, bg, 0.35);

  const stack = (components: unknown[], o: { type?: "vertical" | "horizontal" | "zlayer"; align?: string; distribution?: string; spacing?: number; padding?: object; width?: object; height?: object; background?: string; shape?: object; border?: object; overrides?: unknown[] } = {}) => ({
    id: id("s"), type: "stack", components,
    dimension: { type: o.type ?? "vertical", alignment: o.align ?? "center", distribution: o.distribution ?? "start" },
    size: { width: o.width ?? fill, height: o.height ?? fit }, spacing: o.spacing ?? 0,
    padding: o.padding ?? zero, margin: zero,
    background: o.background ? { type: "color", value: color(o.background) } : null,
    ...(o.shape ? { shape: o.shape } : {}), ...(o.border ? { border: o.border } : {}), ...(o.overrides ? { overrides: o.overrides } : {}),
  });
  const text = (value: string, o: { size?: number; weight?: string; align?: string; color?: string; width?: object } = {}) => ({
    id: id("t"), type: "text", text_lid: lid(value), color: color(o.color ?? fg), font_size: o.size ?? 16, font_weight: o.weight ?? "regular",
    horizontal_alignment: o.align ?? "center", size: { width: o.width ?? fit, height: fit }, padding: zero, margin: zero,
  });

  const top: unknown[] = [];
  if (input.template === "hero" && input.imageUrl) {
    top.push({ id: id("i"), type: "image", fit_mode: "fill", size: { width: fill, height: { type: "fixed", value: 220 } }, margin: zero, padding: zero,
      source: { light: { original: input.imageUrl, heic: input.imageUrl, heic_low_res: input.imageUrl, webp: input.imageUrl, webp_low_res: input.imageUrl, width: 1200, height: 800 } } });
  }
  top.push(text(input.headline, { size: input.template === "minimal" ? 24 : 30, weight: "bold" }));
  if (input.subheadline) top.push(text(input.subheadline, { size: 16, color: muted }));
  const features = (input.features ?? []).filter((f) => f.trim());
  if (features.length && input.template !== "minimal") {
    top.push(stack(features.map((f) => text(`✓  ${f}`, { size: 16, align: "leading", width: fill })), { spacing: 10, padding: pad(4, 8), align: "leading" }));
  }

  const selected = input.selectedPackage ?? input.packages[0]?.id;
  const radius = { top_leading: 12, top_trailing: 12, bottom_leading: 12, bottom_trailing: 12 };
  const pkgs = input.packages.map((p) => ({
    id: id("p"), type: "package", package_id: p.id, is_selected_by_default: p.id === selected,
    stack: stack([
      text(p.label, { size: 16, weight: "semibold", align: "leading", width: fill }),
      text("{{ product.price_per_period }}", { size: 15, align: "trailing" }),
    ], {
      type: "horizontal", distribution: "space_between", padding: pad(14, 16), spacing: 12, shape: { type: "rectangle", corners: radius },
      border: { color: color(mix(fg, bg, 0.75)), width: 1 },
      overrides: [{ conditions: [{ type: "selected" }], properties: { border: { color: color(accent), width: 2 } } }],
    }),
  }));

  const main = stack([...top, stack(pkgs, { spacing: 10, padding: pad(0, 0) })], { spacing: 18, padding: pad(24, 20), height: fill });
  const footer = {
    id: id("f"), type: "footer",
    stack: stack([
      { id: id("b"), type: "purchase_button", action: "in_app_checkout", method: { type: "in_app_checkout" },
        stack: stack([text(input.cta ?? "Continue", { size: 17, weight: "semibold", color: accentText })], { padding: pad(15, 16), background: accent, shape: { type: "pill" } }) },
      { id: id("r"), type: "button", action: { type: "restore_purchases" },
        stack: stack([text(input.restoreLabel ?? "Restore purchases", { size: 13, color: muted })], { width: fit }) },
    ], { spacing: 12, padding: pad(16, 20), background: bg }),
  };
  return {
    components_config: { base: { background: { type: "color", value: color(bg) }, stack: main, sticky_footer: footer } },
    components_localizations: { en_US: loc },
    default_locale: "en_US",
  };
}

function rgb(c: string): [number, number, number] {
  const v = hex(c).slice(1, 7);
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
/** `a` moved toward `b` by `t` (0..1). */
function mix(a: string, b: string, t: number) {
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
function isLight(c: string) {
  const [r, g, b] = rgb(c);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}
