/**
 * Compiles a `PaywallDesign` (schema.ts) into the components JSON the RevenueCat SDKs render. The model picks sections,
 * copy, icons and colours; this file owns the layout, the price on every plan card (the billed amount is the largest
 * price, as Apple requires), the free-trial switches (`intro_offer` overrides) and readable colours: every text colour is
 * moved until it reaches 4.5:1 against what is behind it, in light and in dark mode. Whatever the design says, the
 * output passes `validatePaywall` (tested over the evaluation briefs).
 */
import { DocBuilder, FILL, FIT, PILL, ZERO, colorBg, fixed, pad, rounded, scheme, sz, type Json, type PaywallDoc } from "../build.js";
import { PAYWALL_ICONS } from "../icons.js";
import { cleanHex, isDark, luminance, mix, readable, withAlpha, worstContrast } from "./color.js";
import type { DesignPlanItem, PaywallDesign, SectionName } from "./schema.js";

export interface CompileOptions {
  /** `{origin}/assets/icons`. */
  iconBaseUrl: string;
  /** Countdown end dates are counted from this time (ms). Default: now. */
  now?: number;
  /** Free trial length for the preview of plans marked `trial` (days). Default 7. */
  trialDays?: number;
}
export interface Compiled {
  doc: PaywallDoc;
  name: string;
  /** What the compiler changed (colours moved for contrast, sections dropped …), for the developer. */
  fixes: string[];
  /** Plans with a free trial and its length (ISO 8601), so the dashboard preview shows the trial on those plans only. */
  previewTrials: Record<string, string>;
}

/** One colour scheme of the paywall (light or dark), already made readable. */
interface Pal {
  /** Background stops (one for a solid background). */
  bg: string[];
  base: string;
  fg: string; muted: string; accent: string; onAccent: string; accentText: string; icon: string;
  card: string; border: string; selBg: string; tint: string; tintIcon: string; line: string; star: string;
}

const ICON_OK = (n: string) => Object.hasOwn(PAYWALL_ICONS, n);
const icon = (n: string, fallback = "check") => (ICON_OK(n) ? n : fallback);
const RADIUS = { square: 6, soft: 12, round: 18 } as const;

function palette(d: PaywallDesign, dark: boolean, fixes: Set<string>): Pal {
  const t = d.theme;
  const same = t.dark_mode === "same" || t.appearance === "dark";
  const stops = (t.background?.colors ?? []).map((c) => cleanHex(c, "")).filter(Boolean).slice(0, 3);
  let bg = stops.length ? (t.background.style === "solid" ? [stops[0]!] : stops) : [t.appearance === "dark" ? "#0b0b0f" : "#ffffff"];
  let accent = cleanHex(t.accent, t.appearance === "dark" ? "#ffffff" : "#111111");
  let fg = cleanHex(t.text, t.appearance === "dark" ? "#ffffff" : "#111111");
  let muted = cleanHex(t.secondary_text, mix(fg, bg[0]!, 0.4));
  let card = cleanHex(t.card, mix(fg, bg[0]!, 0.94));
  let border = cleanHex(t.card_border, mix(fg, bg[0]!, 0.82));
  let onAccent = cleanHex(t.on_accent, isDark(accent) ? "#ffffff" : "#111111");
  if (dark && !same) {
    // A dark version of a light design: near-black ground tinted with the accent, light text, the same accent.
    const ground = mix("#0b0b0f", accent, 0.06);
    bg = bg.length > 1 ? bg.map((_, i) => mix(ground, accent, 0.04 * i)) : [ground];
    fg = "#f5f5f7"; muted = "#a1a1aa"; card = mix("#1a1a1f", accent, 0.05); border = "#2e2e35";
    if (luminance(accent) < 0.06) { accent = "#f5f5f7"; onAccent = "#111111"; }
  }
  const base = bg[Math.floor((bg.length - 1) / 2)]!;
  const grounds = [...bg, card];
  const fix = (what: string, from: string, to: string) => { if (from !== to) fixes.add(`Adjusted the ${what} colour${dark && !same ? " in dark mode" : ""} so it reads at 4.5:1.`); return to; };
  fg = fix("text", fg, readable(fg, grounds));
  muted = fix("secondary text", muted, readable(muted, grounds));
  onAccent = fix("button text", onAccent, readable(onAccent, [accent]));
  // The selected plan: a tint of the accent on the card, kept light (or dark) enough for both texts.
  let selBg = mix(accent, card, isDark(card) ? 0.82 : 0.9);
  if (worstContrast(fg, [selBg]) < 4.5 || worstContrast(muted, [selBg]) < 4.5) selBg = card;
  const tint = mix(accent, base, isDark(base) ? 0.8 : 0.86);
  return {
    bg, base, fg, muted, accent, onAccent, card, border, selBg, tint,
    // Accent as text (eyebrows): only when it reads; icons need 3:1 (non-text contrast).
    accentText: worstContrast(accent, bg) >= 4.5 ? accent : fg,
    icon: worstContrast(accent, grounds) >= 3 ? accent : fg,
    tintIcon: readable(accent, [tint], 3),
    line: mix(accent, base, isDark(base) ? 0.55 : 0.6),
    star: readable(isDark(base) ? mix("#fde68a", accent, 0.3) : "#f59e0b", bg, 3),
  };
}

/** Light and dark values of one role. */
type Two = [string, string];

class Compiler {
  readonly b: DocBuilder;
  readonly icons: string;
  readonly fixes = new Set<string>();
  readonly L: Pal; readonly D: Pal;
  readonly r: number;
  constructor(readonly d: PaywallDesign, readonly o: CompileOptions) {
    this.b = new DocBuilder(d.locale || "en_US", "a");
    this.icons = o.iconBaseUrl.replace(/\/+$/, "");
    this.L = palette(d, false, this.fixes);
    this.D = palette(d, true, this.fixes);
    this.r = RADIUS[d.theme.corners] ?? 12;
  }
  two(k: keyof Pal): Two { return [this.L[k] as string, this.D[k] as string]; }
  text(v: string, role: keyof Pal, o: Parameters<DocBuilder["text"]>[1] = {}) {
    const [l, dk] = this.two(role);
    return this.b.text(v, { color: l, colorDark: dk === l ? null : dk, ...o });
  }
  intro(v: string, trial: string, role: keyof Pal, o: Parameters<DocBuilder["text"]>[1] = {}) {
    if (!trial.trim() || trial.trim() === v.trim()) return this.text(v, role, o);
    const [l, dk] = this.two(role);
    return this.b.textIntro(v, trial, { color: l, colorDark: dk === l ? null : dk, ...o });
  }
  ic(name: string, role: keyof Pal, o: { size?: number; bg?: keyof Pal; shape?: "circle" | "rectangle"; padding?: Json; margin?: Json } = {}) {
    const [l, dk] = this.two(role);
    const c = this.b.icon(this.icons, icon(name), { size: o.size ?? 20, color: l, colorDark: dk === l ? null : dk, padding: o.padding, margin: o.margin });
    if (o.bg) {
      const [bl, bd] = this.two(o.bg);
      c.icon_background = { color: scheme(bl, bd === bl ? null : bd), shape: o.shape === "rectangle" ? { type: "rectangle", corners: { top_leading: Math.round(this.r * 0.7), top_trailing: Math.round(this.r * 0.7), bottom_leading: Math.round(this.r * 0.7), bottom_trailing: Math.round(this.r * 0.7) } } : { type: "circle" } };
    }
    return c;
  }
  bgOf(role: keyof Pal) { const [l, dk] = this.two(role); return colorBg(l, dk === l ? null : dk); }
  border(role: keyof Pal, width: number) { const [l, dk] = this.two(role); return { color: scheme(l, dk === l ? null : dk), width }; }
  get align(): "center" | "leading" { return this.d.hero?.align === "leading" ? "leading" : "center"; }

  background(): Json {
    const t = this.d.theme;
    const one = (p: Pal) => p.bg.length === 1 ? { type: "hex", value: `${p.bg[0]}ff` }
      : t.background.style === "radial_gradient"
        ? { type: "radial", points: p.bg.map((c, i) => ({ color: `${c}ff`, percent: Math.round((i / (p.bg.length - 1)) * 100) })) }
        : { type: "linear", degrees: Math.round(Number.isFinite(t.background.angle) ? t.background.angle : 180), points: p.bg.map((c, i) => ({ color: `${c}ff`, percent: Math.round((i / (p.bg.length - 1)) * 100) })) };
    const l = one(this.L), dk = one(this.D);
    return { type: "color", value: { light: l, ...(JSON.stringify(l) !== JSON.stringify(dk) ? { dark: dk } : {}) } };
  }

  topBar(): Json | null {
    if (this.d.close_button === "none") return null;
    const close = this.b.button({ type: "navigate_back" }, this.b.stack([this.ic("x", "muted", { size: 16 })], { size: sz(FIT, FIT), padding: pad(6) }), "Close");
    return this.b.stack([close], { dir: "horizontal", distribution: this.d.close_button === "trailing" ? "end" : "start", size: sz(FILL, FIT), name: "Top bar" });
  }

  hero(): Json[] {
    const h = this.d.hero;
    if (!h) return [];
    const out: Json[] = [];
    const al = this.align;
    if (h.art === "icon_glow") {
      const [la, da] = this.two("accent");
      const glow = this.b.stack([], {
        size: sz(fixed(156), fixed(156)), shape: PILL,
        background: { type: "color", value: { light: { type: "radial", points: [{ color: withAlpha(la, 0.42), percent: 0 }, { color: withAlpha(la, 0), percent: 70 }] }, ...(la !== da ? { dark: { type: "radial", points: [{ color: withAlpha(da, 0.42), percent: 0 }, { color: withAlpha(da, 0), percent: 70 }] } } : {}) } },
      });
      const core = this.ic(h.icon, "onAccent", { size: 34, bg: "accent", shape: "circle", padding: pad(21) });
      const layers: Json[] = [glow, core];
      if (h.decoration !== "none") {
        const glyph = h.decoration === "stars" ? "star" : "sparkles";
        const spots: [string, Json, number][] = [
          ["top_leading", { top: 16, leading: 34, bottom: 0, trailing: 0 }, 13], ["top_trailing", { top: 34, trailing: 30, bottom: 0, leading: 0 }, 10],
          ["bottom_leading", { bottom: 24, leading: 58, top: 0, trailing: 0 }, 9], ["top_trailing", { top: 6, trailing: 84, bottom: 0, leading: 0 }, 8],
          ["bottom_trailing", { bottom: 14, trailing: 52, top: 0, leading: 0 }, 12], ["top_leading", { top: 70, leading: 12, bottom: 0, trailing: 0 }, 7],
        ];
        for (const [align, margin, size] of spots) layers.push(this.b.stack([this.ic(glyph, "star", { size, margin })], { dir: "zlayer", align, size: sz(FILL, FILL) }));
      }
      out.push(this.b.stack(layers, { dir: "zlayer", align: "center", size: sz(FILL, fixed(156)), name: "Hero art" }));
    } else if (h.art === "icon_tile") {
      const tile = this.ic(h.icon, "onAccent", { size: 32, bg: "accent", shape: "rectangle", padding: pad(16) });
      out.push(al === "center" ? this.b.stack([tile], { size: sz(FILL, FIT) }) : this.b.stack([tile], { dir: "horizontal", distribution: "start", size: sz(FILL, FIT) }));
    } else if (h.art === "icon_plain") {
      const glyph = this.ic(h.icon, "icon", { size: 44 });
      out.push(al === "center" ? this.b.stack([glyph], { size: sz(FILL, FIT) }) : this.b.stack([glyph], { dir: "horizontal", distribution: "start", size: sz(FILL, FIT) }));
    }
    const words: Json[] = [];
    if (h.eyebrow.trim()) words.push(this.text(h.eyebrow.trim(), "accentText", { size: 13, weight: "bold", align: al }));
    words.push(this.text(h.title.trim() || this.d.name, "fg", { size: h.title.length > 32 ? 26 : 30, weight: "bold", align: al }));
    if (h.subtitle.trim()) words.push(this.text(h.subtitle.trim(), "muted", { size: 16, align: al }));
    out.push(this.b.stack(words, { spacing: 8, align: al, size: sz(FILL, FIT), name: "Headline" }));
    return out;
  }

  heading(v: string) { return v.trim() ? [this.text(v.trim(), "fg", { size: 19, weight: "bold", align: this.align })] : []; }

  benefits(): Json[] {
    const x = this.d.benefits;
    if (!x || !x.items.length) return [];
    const badge = (name: string) => this.ic(name, "tintIcon", { size: 18, bg: "tint", shape: this.d.theme.corners === "round" ? "circle" : "rectangle", padding: pad(8) });
    const words = (it: { title: string; description: string }, size = 16) => this.b.stack([
      this.text(it.title.trim(), "fg", { size, weight: "semibold", align: "leading" }),
      ...(it.description.trim() ? [this.text(it.description.trim(), "muted", { size: size - 2, align: "leading" })] : []),
    ], { spacing: 2, align: "leading", size: sz(FILL, FIT) });
    let body: Json;
    if (x.style === "grid" && x.items.length >= 2) {
      const cell = (it: (typeof x.items)[number]) => this.b.stack([badge(it.icon), words(it, 15)], { spacing: 10, align: "leading", padding: pad(14), size: sz(FILL, FILL), background: this.bgOf("card"), shape: rounded(this.r) });
      const rows: Json[] = [];
      for (let i = 0; i < x.items.length; i += 2) rows.push(this.b.stack(x.items.slice(i, i + 2).map(cell), { dir: "horizontal", spacing: 10, align: "top", size: sz(FILL, FIT) }));
      body = this.b.stack(rows, { spacing: 10, size: sz(FILL, FIT), name: "Benefits" });
    } else if (x.style === "cards") {
      body = this.b.stack(x.items.map((it) => this.b.stack([badge(it.icon), words(it)], { dir: "horizontal", spacing: 12, align: "center", padding: pad(14), size: sz(FILL, FIT), background: this.bgOf("card"), shape: rounded(this.r) })), { spacing: 10, size: sz(FILL, FIT), name: "Benefits" });
    } else {
      body = this.b.stack(x.items.map((it) => this.b.stack([badge(it.icon), words(it)], { dir: "horizontal", spacing: 14, align: "center", size: sz(FILL, FIT) })), { spacing: 14, align: "leading", padding: pad(2, 4), size: sz(FILL, FIT), name: "Benefits" });
    }
    return x.title.trim() ? [this.b.stack([...this.heading(x.title), body], { spacing: 12, size: sz(FILL, FIT) })] : [body];
  }

  timeline(): Json[] {
    const x = this.d.trial_timeline;
    if (!x || !x.items.length) return [];
    const [lf, df] = this.two("fg"), [lm, dm] = this.two("muted"), [ll, dl] = this.two("line");
    const tl = {
      id: this.b.id("l"), type: "timeline", icon_alignment: "title", item_spacing: 18, text_spacing: 3, column_gutter: 14, size: sz(FILL, FIT), padding: ZERO, margin: ZERO,
      items: x.items.map((it) => ({
        title: this.b.text(it.title.trim(), { size: 16, weight: "semibold", align: "leading", color: lf, colorDark: df === lf ? null : df }),
        ...(it.description.trim() ? { description: this.b.text(it.description.trim(), { size: 14, align: "leading", color: lm, colorDark: dm === lm ? null : dm }) } : {}),
        icon: this.ic(it.icon, "onAccent", { size: 16, bg: "accent", shape: "circle", padding: pad(6) }),
        connector: { width: 2, color: scheme(ll, dl === ll ? null : dl), margin: pad(4, 0) },
      })),
    };
    // Only while the selected plan has a free trial: hidden otherwise (a plan without one has nothing to explain).
    return [this.b.stack([...this.heading(x.title), tl], {
      spacing: 14, size: sz(FILL, FIT), name: "Trial timeline",
      overrides: [{ conditions: [{ type: "intro_offer" }], properties: { visible: true } }],
    })].map((s) => ({ ...s, visible: false }));
  }

  socialProof(): Json[] {
    const x = this.d.social_proof;
    if (!x) return [];
    const parts: Json[] = [];
    if (x.rating > 0) {
      const full = Math.max(0, Math.min(5, Math.round(x.rating)));
      parts.push(this.b.stack(Array.from({ length: 5 }, (_, i) => this.ic("star", i < full ? "star" : "muted", { size: 18 })), { dir: "horizontal", spacing: 4, distribution: "center", size: sz(FILL, FIT) }));
    }
    if (x.rating_label.trim()) parts.push(this.text(x.rating_label.trim(), "muted", { size: 13 }));
    if (x.quote.trim()) {
      parts.push(this.b.stack([
        this.text(`“${x.quote.trim().replace(/^["“]|["”]$/g, "")}”`, "fg", { size: 15, weight: "medium" }),
        ...(x.author.trim() ? [this.text(x.author.trim(), "muted", { size: 13 })] : []),
      ], { spacing: 6, padding: pad(14, 16), background: this.bgOf("card"), shape: rounded(this.r), size: sz(FILL, FIT) }));
    }
    return parts.length ? [this.b.stack(parts, { spacing: 8, size: sz(FILL, FIT), name: "Social proof" })] : [];
  }

  countdown(): Json[] {
    const x = this.d.countdown;
    if (!x) return [];
    const hours = Math.max(1, Math.min(24 * 30, Math.round(x.hours || 48)));
    const end = new Date(Math.floor(((this.o.now ?? Date.now()) + hours * 3_600_000) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const box = (v: string) => this.b.stack([this.text(v, "fg", { size: 24, weight: "bold" })], { padding: pad(8, 4), size: sz(fixed(58), FIT), background: this.bgOf("card"), shape: rounded(Math.min(this.r, 12)) });
    const colon = () => this.text(":", "muted", { size: 22, weight: "bold", width: FIT });
    const clock = this.b.stack([box("{{ count_hours_with_zero }}"), colon(), box("{{ count_minutes_with_zero }}"), colon(), box("{{ count_seconds_with_zero }}")], { dir: "horizontal", spacing: 6, distribution: "center", size: sz(FILL, FIT) });
    const cd = this.b.countdown(end, this.b.stack([clock], { size: sz(FILL, FIT) }), this.b.stack([this.text(x.ended_text.trim() || "This offer has ended", "muted", { size: 15, weight: "semibold" })], { size: sz(FILL, FIT) }), "hours");
    return [this.b.stack([...(x.label.trim() ? [this.text(x.label.trim(), "accentText", { size: 13, weight: "bold" })] : []), cd], { spacing: 8, size: sz(FILL, FIT), name: "Countdown" })];
  }

  comparison(): Json[] {
    const x = this.d.comparison;
    if (!x || !x.rows.length) return [];
    const cell = (v: boolean) => this.b.stack([this.ic(v ? "check" : "x", v ? "icon" : "muted", { size: 18 })], { size: sz(fixed(56), FIT) });
    const head = this.b.stack([this.text("", "muted", { size: 12 }), this.text(x.free_label.trim(), "muted", { size: 12, weight: "semibold", width: fixed(56) }), this.text(x.pro_label.trim(), "fg", { size: 12, weight: "bold", width: fixed(56) })], { dir: "horizontal", spacing: 6, padding: pad(10, 14, 4), size: sz(FILL, FIT) });
    const rows = x.rows.map((r) => this.b.stack([this.text(r.feature.trim(), "fg", { size: 15, align: "leading" }), cell(r.free), cell(r.pro)], { dir: "horizontal", spacing: 6, padding: pad(9, 14), size: sz(FILL, FIT) }));
    return [this.b.stack([head, ...rows], { size: sz(FILL, FIT), padding: pad(0, 0, 6), background: this.bgOf("card"), shape: rounded(this.r), name: "Comparison" })];
  }

  pages(): Json[] {
    const x = this.d.pages;
    if (!x || !x.pages.length) return [];
    const page = (p: { icon: string; title: string; body: string }) => this.b.stack([
      this.ic(p.icon, "onAccent", { size: 32, bg: "accent", shape: "rectangle", padding: pad(16) }),
      this.text(p.title.trim(), "fg", { size: 22, weight: "bold" }), this.text(p.body.trim(), "muted", { size: 15 }),
    ], { spacing: 12, padding: pad(24, 20), distribution: "center", size: sz(FILL, fixed(260)), background: this.bgOf("card"), shape: rounded(this.r + 4) });
    const [ll, ld] = this.two("line"), [al, ad] = this.two("accent");
    const car = this.b.carousel(x.pages.slice(0, 4).map(page), { spacing: 12, dot: ll, dotActive: al });
    if (ld !== ll || ad !== al) { car.page_control.default.color = scheme(ll, ld); car.page_control.active.color = scheme(al, ad); }
    return [car];
  }

  note(): Json[] {
    return this.d.note?.text.trim() ? [this.text(this.d.note.text.trim(), "muted", { size: 14, align: this.align })] : [];
  }

  plan(p: DesignPlanItem, selected: boolean, cards: boolean): Json {
    const b = this.b;
    const life = /life/i.test(p.package_id);
    const price = life ? "{{ product.price }}" : "{{ product.price_per_period_abbreviated }}";
    const badge = p.badge.trim() ? {
      style: "overlay", alignment: cards ? "top" : "top_trailing",
      stack: b.stack([this.text(p.badge.trim(), "onAccent", { size: 11, weight: "bold", width: FIT })], { size: sz(FIT, FIT), padding: pad(3, 9), background: this.bgOf("accent"), shape: PILL, margin: cards ? ZERO : { top: 0, bottom: 0, leading: 0, trailing: 14 } }),
    } : undefined;
    const [lA, dA] = this.two("accent"), [lS, dS] = this.two("selBg");
    const selected$ = [{ conditions: [{ type: "selected" }], properties: { border: { color: scheme(lA, dA === lA ? null : dA), width: 2 }, background: colorBg(lS, dS === lS ? null : dS) } }];
    const sub = p.subtitle.trim();
    if (cards) {
      return b.pkg(p.package_id, selected, b.stack([
        this.text(p.title.trim(), "fg", { size: 15, weight: "semibold" }),
        this.text(price, "fg", { size: 17, weight: "bold" }),
        ...(sub || p.trial_subtitle.trim() ? [this.intro(sub, p.trial_subtitle, "muted", { size: 12 })] : []),
      ], {
        spacing: 4, padding: pad(p.badge.trim() ? 20 : 16, 8, 14), distribution: "center", size: sz(FILL, FIT), background: this.bgOf("card"), shape: rounded(this.r),
        border: this.border("border", 1.5), badge, overrides: selected$,
      }), p.title.trim());
    }
    // The radio: an empty ring, filled with a check when the plan is selected.
    const check = { ...this.ic("check", "onAccent", { size: 14 }), visible: false, overrides: [{ conditions: [{ type: "selected" }], properties: { visible: true } }] };
    const [lB, dB] = this.two("border");
    const radio = b.stack([check], {
      size: sz(fixed(22), fixed(22)), shape: PILL, border: { color: scheme(lB, dB === lB ? null : dB), width: 2 },
      overrides: [{ conditions: [{ type: "selected" }], properties: { background: colorBg(lA, dA === lA ? null : dA), border: { color: scheme(lA, dA === lA ? null : dA), width: 2 } } }],
    });
    const left = b.stack([
      this.text(p.title.trim(), "fg", { size: 17, weight: "semibold", align: "leading" }),
      ...(sub || p.trial_subtitle.trim() ? [this.intro(sub, p.trial_subtitle, "muted", { size: 13, align: "leading" })] : []),
    ], { spacing: 2, align: "leading", size: sz(FILL, FIT) });
    return b.pkg(p.package_id, selected, b.stack([radio, left, this.text(price, "fg", { size: 17, weight: "bold", align: "trailing", width: FIT })], {
      dir: "horizontal", spacing: 12, align: "center", padding: pad(16, 14), size: sz(FILL, FIT), background: this.bgOf("card"), shape: rounded(this.r),
      border: this.border("border", 1.5), badge, overrides: selected$,
    }), p.title.trim());
  }

  plans(): Json[] {
    const x = this.d.plans;
    const seen = new Set<string>();
    const items = x.items.filter((p) => !seen.has(p.package_id) && seen.add(p.package_id));
    if (!items.length) return [];
    const sel = items.some((p) => p.package_id === x.selected) ? x.selected : items[0]!.package_id;
    const cards = x.layout === "cards" && items.length >= 2 && items.length <= 3;
    const list = this.b.stack(items.map((p) => this.plan(p, p.package_id === sel, cards)), {
      dir: cards ? "horizontal" : "vertical", spacing: cards ? 10 : 12, align: cards ? "top" : "center", size: sz(FILL, FIT), padding: pad(items.some((p) => p.badge.trim()) ? 8 : 0, 0, 0), name: "Plans",
    });
    return x.title.trim() ? [this.b.stack([...this.heading(x.title), list], { spacing: 12, size: sz(FILL, FIT) })] : [list];
  }

  footer(): Json {
    const f = this.d.footer, b = this.b;
    const label = this.intro(f.cta.trim() || "Continue", f.cta_trial, "onAccent", { size: 17, weight: "semibold" });
    const shape = this.d.theme.corners === "round" ? PILL : rounded(this.d.theme.corners === "square" ? 8 : 14);
    const cta = b.purchase(b.stack([label], { padding: pad(16, 16), background: this.bgOf("accent"), shape, size: sz(FILL, FIT) }));
    const parts: Json[] = [cta];
    if (f.reassurance.trim()) parts.push(this.text(f.reassurance.trim(), "muted", { size: 13 }));
    if (f.disclosure.trim() || f.disclosure_trial.trim()) parts.push(this.intro(f.disclosure.trim() || f.disclosure_trial.trim(), f.disclosure_trial, "muted", { size: 11 }));
    parts.push(b.stack([b.button({ type: "restore_purchases" }, b.stack([this.text(f.restore.trim() || "Restore purchases", "muted", { size: 12, width: FIT })], { size: sz(FIT, FIT) }), "Restore")], { dir: "horizontal", distribution: "center", size: sz(FILL, FIT), name: "Links" }));
    const solid = this.L.bg.length === 1;
    return b.footer(b.stack(parts, { spacing: 9, padding: pad(12, 20, 10), ...(solid ? { background: this.bgOf("base") } : {}), name: "Footer" }));
  }

  build(): Compiled {
    const make: Record<SectionName, () => Json[]> = {
      hero: () => this.hero(), benefits: () => this.benefits(), trial_timeline: () => this.timeline(), social_proof: () => this.socialProof(),
      countdown: () => this.countdown(), comparison: () => this.comparison(), pages: () => this.pages(), note: () => this.note(), plans: () => this.plans(),
    };
    const order: SectionName[] = [];
    for (const s of this.d.order ?? []) if (make[s] && !order.includes(s)) order.push(s);
    // Sections the design filled but left out of `order` go before the plans; the plans are always there.
    for (const s of ["hero", "benefits", "trial_timeline", "social_proof", "countdown", "comparison", "pages", "note"] as SectionName[]) {
      if (!order.includes(s) && this.d[s as keyof PaywallDesign]) { order.splice(order.includes("plans") ? order.indexOf("plans") : order.length, 0, s); this.fixes.add("Placed sections missing from the order above the plans."); }
    }
    if (!order.includes("plans")) order.push("plans");
    const top = this.topBar();
    const body: Json[] = [...(top ? [top] : [])];
    for (const s of order) body.push(...make[s]());
    const main = this.b.stack(body, { spacing: 20, padding: pad(top ? 8 : 28, 20, 24), size: sz(FILL, FILL), distribution: "start", scroll: true, name: "Content" });
    const doc = this.b.doc(main, this.footer(), this.background());
    const trial = `P${Math.max(1, Math.round(this.o.trialDays ?? 7))}D`;
    const previewTrials = Object.fromEntries(this.d.plans.items.filter((p) => p.trial && !/life/i.test(p.package_id)).map((p) => [p.package_id, trial]));
    return { doc, name: this.d.name?.trim() || "AI paywall", fixes: [...this.fixes], previewTrials };
  }
}

export function compileDesign(design: PaywallDesign, o: CompileOptions): Compiled {
  return new Compiler(design, o).build();
}
