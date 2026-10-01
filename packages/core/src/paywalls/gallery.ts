/**
 * The paywall template gallery: ten layouts built from the 2026 conversion research
 * (company/docs/research/paywall-onboarding-2026.md, summarised in prd/paywalls/PRD.md). Every template is a function of
 * the offering's packages, the app name and brand colours, and returns paywall components the SDK decodes (the contract
 * tests decode each one with the iOS SDK's own models). Prices are `{{ product.* }}` variables, so the device shows the
 * customer's local price; texts that mention a trial switch to their trial wording with an `intro_offer` override.
 */
import { DocBuilder, FILL, FIT, PILL, colorBg, fixed, gradient, pad, rounded, scheme, sz, type Json, type PaywallDoc } from "./build.js";

export interface TemplateInput {
  appName?: string;
  /** The offering's packages in display order. Default: `$rc_annual` and `$rc_monthly`. */
  packages?: { id: string; label?: string }[];
  colors?: { accent?: string; background?: string; text?: string };
  /** Hero image (feature_hero) with its pixel size. */
  imageUrl?: string; imageWidth?: number; imageHeight?: number;
  /** Where the built-in icons are served: `{origin}/assets/icons`. */
  iconBaseUrl?: string;
  termsUrl?: string; privacyUrl?: string;
  locale?: string;
  /** The countdown template ends two days after this time (milliseconds). Default: now. */
  now?: number;
}

export interface TemplateMeta {
  id: string; name: string; description: string;
  /** Pages the customer sees before buying (a carousel of value pages counts as several). */
  screens: number;
  purchase_method: "in_app" | "web";
  /** Packages the layout shows (it adapts to the offering). */
  packages: number;
  tiers: number;
  tags: string[];
  /** The measured result this layout is built on. */
  evidence: string;
}
export interface GalleryTemplate extends TemplateMeta { build(input?: TemplateInput): PaywallDoc }

export const DEFAULT_ICON_BASE = "https://api.revenuedot.app/assets/icons";
const DEFAULT_PACKAGES: { id: string; label?: string }[] = [{ id: "$rc_annual" }, { id: "$rc_monthly" }];

/** A readable name for a package identifier. */
export function planLabel(id: string): string {
  const m: Record<string, string> = { $rc_annual: "Yearly", $rc_monthly: "Monthly", $rc_weekly: "Weekly", $rc_lifetime: "Lifetime", $rc_six_month: "6 months", $rc_three_month: "3 months", $rc_two_month: "2 months" };
  if (m[id]) return m[id]!;
  if (/annual|year/i.test(id)) return "Yearly";
  if (/month/i.test(id)) return "Monthly";
  if (/week/i.test(id)) return "Weekly";
  if (/life/i.test(id)) return "Lifetime";
  return id.replace(/^\$rc_/, "").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}
const isAnnual = (id: string) => /annual|year/i.test(id);

interface Theme { bg: string; bgDark: string; fg: string; fgDark: string; muted: string; mutedDark: string; accent: string; onAccent: string; card: string; cardDark: string; line: string; lineDark: string; selBg: string; selBgDark: string }
function theme(input: TemplateInput, base: Partial<Theme> = {}): Theme {
  const accent = input.colors?.accent ?? base.accent ?? "#111111";
  const bg = input.colors?.background ?? base.bg ?? "#ffffff";
  const dark = luminance(bg) < 0.4;
  const fg = input.colors?.text ?? base.fg ?? (dark ? "#ffffff" : "#111111");
  return {
    bg, bgDark: base.bgDark ?? (dark ? bg : "#0a0a0a"), fg, fgDark: base.fgDark ?? "#fafafa",
    muted: mix(fg, bg, 0.42), mutedDark: "#a3a3a3", accent, onAccent: luminance(accent) > 0.6 ? "#111111" : "#ffffff",
    card: base.card ?? mix(fg, bg, 0.96), cardDark: base.cardDark ?? (dark ? mix("#ffffff", bg, 0.9) : "#171717"),
    line: mix(fg, bg, 0.84), lineDark: "#2a2a2a", selBg: mix(accent, bg, 0.92), selBgDark: mix(accent, "#0a0a0a", 0.82),
  };
}
function rgb(c: string): [number, number, number] { const v = c.replace("#", "").slice(0, 6).padEnd(6, "0"); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) || 0) as [number, number, number]; }
function luminance(c: string) { const [r, g, b] = rgb(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }
function mix(a: string, b: string, t: number) { const [x, y] = [rgb(a), rgb(b)]; return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, "0")).join("")}`; }

/** Shared pieces. */
class Kit {
  readonly b: DocBuilder;
  readonly icons: string;
  readonly app: string;
  readonly pk: { id: string; label: string }[];
  constructor(readonly input: TemplateInput, readonly t: Theme) {
    this.b = new DocBuilder(input.locale ?? "en_US");
    this.icons = (input.iconBaseUrl ?? DEFAULT_ICON_BASE).replace(/\/+$/, "");
    this.app = input.appName?.trim() || "Premium";
    const list = input.packages?.length ? input.packages : DEFAULT_PACKAGES;
    this.pk = list.map((p) => ({ id: p.id, label: p.label?.trim() || planLabel(p.id) }));
  }
  /** Annual first; then the rest in offering order. */
  plans(n: number) {
    const sorted = [...this.pk.filter((p) => isAnnual(p.id)), ...this.pk.filter((p) => !isAnnual(p.id))];
    return sorted.slice(0, Math.max(1, n));
  }
  text(v: string, o: Parameters<DocBuilder["text"]>[1] = {}) { return this.b.text(v, { color: this.t.fg, colorDark: this.t.fgDark, ...o }); }
  muted(v: string, o: Parameters<DocBuilder["text"]>[1] = {}) { return this.b.text(v, { size: 15, color: this.t.muted, colorDark: this.t.mutedDark, ...o }); }
  title(v: string, size = 28, align: "leading" | "center" = "center") { return this.text(v, { size, weight: "bold", align }); }
  icon(name: string, o: Parameters<DocBuilder["icon"]>[2] = {}) { return this.b.icon(this.icons, name, o); }
  topBar() {
    return this.b.stack([this.b.close(this.icons, this.t.muted)], { dir: "horizontal", distribution: "start", size: sz(FILL, FIT), name: "Top bar" });
  }
  features(items: [string, string][], o: { iconColor?: string } = {}) {
    return this.b.stack(items.map(([icon, text]) => this.b.stack([
      this.icon(icon, { size: 22, color: o.iconColor ?? this.t.accent }),
      this.text(text, { size: 16, align: "leading" }),
    ], { dir: "horizontal", spacing: 12, align: "center" })), { spacing: 14, align: "leading", padding: pad(4, 4), name: "Features" });
  }
  /** A plan card: name and a smaller line on the left, the billed price (the largest price, as Apple requires) on the right. */
  plan(p: { id: string; label: string }, selected: boolean, o: { badge?: string; sub?: string; compact?: boolean } = {}) {
    const t = this.t, b = this.b;
    const sub = o.sub ?? (isAnnual(p.id) ? "{{ product.price_per_month }}/month, billed yearly" : /life/i.test(p.id) ? "Pay once, keep forever" : "Billed {{ product.periodly }}, cancel anytime");
    const left = b.stack([
      this.text(p.label, { size: 17, weight: "semibold", align: "leading" }),
      this.muted(sub, { size: 13, align: "leading" }),
    ], { spacing: 2, align: "leading", size: sz(FILL, FIT) });
    const right = this.text(/life/i.test(p.id) ? "{{ product.price }}" : "{{ product.price_per_period_abbreviated }}", { size: 17, weight: "bold", align: "trailing", width: FIT });
    const badge = o.badge ? { style: "overlay", alignment: "top_trailing", stack: b.stack([b.text(o.badge, { size: 11, weight: "bold", color: t.onAccent, width: FIT })], { size: sz(FIT, FIT), padding: pad(3, 8), bg: t.accent, shape: PILL, margin: { top: 0, bottom: 0, leading: 0, trailing: 14 } }) } : undefined;
    const card = b.stack(o.compact ? [this.text(p.label, { size: 15, weight: "semibold" }), this.text("{{ product.price_per_period_abbreviated }}", { size: 17, weight: "bold" }), this.muted(isAnnual(p.id) ? "{{ product.price_per_month }}/mo" : "{{ product.periodly }}", { size: 12 })] : [left, right], {
      dir: o.compact ? "vertical" : "horizontal", distribution: "space_between", spacing: o.compact ? 4 : 12, padding: o.compact ? pad(18, 10) : pad(16, 16),
      size: sz(FILL, FIT), bg: t.bg, bgDark: t.bgDark, shape: rounded(14), border: { color: scheme(t.line, t.lineDark), width: 1.5 }, badge,
      overrides: [{ conditions: [{ type: "selected" }], properties: { border: { color: scheme(t.accent), width: 2.5 }, background: colorBg(t.selBg, t.selBgDark) } }],
    });
    return b.pkg(p.id, selected, card, p.label);
  }
  plansList(n: number, o: { badge?: boolean; horizontal?: boolean } = {}) {
    const list = this.plans(n);
    return this.b.stack(list.map((p, i) => this.plan(p, i === 0, { badge: o.badge !== false && i === 0 && isAnnual(p.id) && list.length > 1 ? "SAVE {{ product.relative_discount }}" : undefined, compact: o.horizontal })), {
      dir: o.horizontal ? "horizontal" : "vertical", spacing: o.horizontal ? 10 : 12, name: "Plans", size: sz(FILL, FIT), padding: o.horizontal ? pad(8, 0, 0) : pad(6, 0, 0),
    });
  }
  cta(o: { label?: string; trial?: string; method?: "in_app_checkout" | "web_checkout" } = {}) {
    const t = this.t, b = this.b;
    const label = o.label ?? "Continue";
    const text = o.trial === undefined ? b.textIntro(label, "Start free trial", { size: 17, weight: "semibold", color: t.onAccent }) : b.text(label, { size: 17, weight: "semibold", color: t.onAccent });
    return b.purchase(b.stack([text], { padding: pad(16, 16), bg: t.accent, shape: PILL, size: sz(FILL, FIT) }), o.method ?? "in_app_checkout");
  }
  /** "No commitment", the disclosure line, and Restore · Terms · Privacy. */
  fine(o: { reassure?: boolean } = {}) {
    const t = this.t, b = this.b;
    const links: Json[] = [b.restore("Restore", t.muted, 12)];
    if (this.input.termsUrl) links.push(b.link("Terms", "terms", this.input.termsUrl, t.muted));
    if (this.input.privacyUrl) links.push(b.link("Privacy", "privacy_policy", this.input.privacyUrl, t.muted));
    return [
      ...(o.reassure === false ? [] : [this.muted("No commitment, cancel anytime", { size: 13 })]),
      b.textIntro("{{ product.price_per_period }}. Renews automatically. Cancel anytime in Settings.", "{{ product.offer_period_with_unit }} free, then {{ product.price_per_period }}. Cancel anytime in Settings.", { size: 11, color: t.muted, colorDark: t.mutedDark }),
      b.stack(links, { dir: "horizontal", spacing: 18, distribution: "center", size: sz(FILL, FIT), name: "Links" }),
    ];
  }
  footer(extra: Json[] = [], o: { method?: "in_app_checkout" | "web_checkout"; label?: string; reassure?: boolean } = {}) {
    return this.b.footer(this.b.stack([...extra, this.cta({ method: o.method, label: o.label }), ...this.fine({ reassure: o.reassure })], {
      spacing: 10, padding: pad(14, 20, 10), bg: this.t.bg, bgDark: this.t.bgDark, name: "Footer",
    }));
  }
  main(components: Json[], o: { spacing?: number; padding?: Json } = {}) {
    return this.b.stack(components, { spacing: o.spacing ?? 20, padding: o.padding ?? pad(12, 20, 24), size: sz(FILL, FILL), distribution: "start", scroll: true, name: "Content" });
  }
  done(main: Json, footer: Json | null, bg?: Json) { return this.b.doc(main, footer, bg ?? colorBg(this.t.bg, this.t.bgDark)); }
  heroIcon(name: string, size = 64) {
    return this.icon(name, { size: Math.round(size * 0.5), color: this.t.onAccent, bg: this.t.accent, bgShape: "rectangle", padding: pad(Math.round(size * 0.25)) });
  }
}

const twoDaysAfter = (now?: number) => new Date(Math.floor(((now ?? Date.now()) + 2 * 86_400_000) / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export const PAYWALL_TEMPLATES: GalleryTemplate[] = [
  {
    id: "trial_timeline", name: "Trial timeline", description: "Explains the free trial day by day, then two plans with yearly selected.",
    screens: 1, purchase_method: "in_app", packages: 2, tiers: 1, tags: ["trial", "timeline"], evidence: "A “how your free trial works” timeline: +23% trial starts and 55% fewer complaints (Blinkist).",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#111111" }));
      const tl = k.b.timeline([
        { icon: "unlock", title: "Today", description: `Get full access to ${k.app} and everything in it.` },
        { icon: "bell", title: "Before it ends", description: "We remind you that your trial is ending." },
        { icon: "star", title: "After {{ product.offer_period_with_unit }}", description: "You are charged {{ product.price_per_period }}. Cancel anytime before." },
      ], { baseUrl: k.icons, color: k.t.fg, muted: k.t.muted, accent: k.t.accent, iconColor: k.t.onAccent });
      return k.done(k.main([k.topBar(), k.title("How your free trial works"), tl, k.plansList(2)]), k.footer());
    },
  },
  {
    id: "annual_two_plan", name: "Annual first", description: "Benefits, then yearly and monthly with yearly selected and a savings badge.",
    screens: 1, purchase_method: "in_app", packages: 2, tiers: 1, tags: ["annual", "features"], evidence: "Yearly pre-selected moved the yearly share of purchases from 37% to 63% (Superwall).",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#2563eb" }));
      return k.done(k.main([
        k.topBar(), k.b.stack([k.heroIcon("crown")], { size: sz(FILL, FIT) }),
        k.title(`Unlock ${k.app}`), k.muted("Everything you need, with no limits.", { size: 16 }),
        k.features([["check_circle", "Unlimited access to every feature"], ["no_ads", "No ads, ever"], ["sync", "Sync across all your devices"], ["shield_check", "Private and secure"]]),
        k.plansList(2),
      ]), k.footer());
    },
  },
  {
    id: "feature_hero", name: "Feature hero", description: "A full-width image on top, five benefits with icons, plans side by side.",
    screens: 1, purchase_method: "in_app", packages: 2, tiers: 1, tags: ["image", "features"], evidence: "Opening on value with 3–5 benefit lines and icons is the 2026 default for top-grossing apps.",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#16a34a" }));
      const hero = input.imageUrl
        ? k.b.image(input.imageUrl, input.imageWidth ?? 1200, input.imageHeight ?? 800, { size: sz(FILL, fixed(240)), fit: "fill", name: "Hero image" })
        : k.b.stack([k.icon("sparkles", { size: 72, color: "#ffffff" })], { size: sz(FILL, fixed(240)), distribution: "center", background: { type: "color", value: gradient(160, [[k.t.accent, 0], [mix(k.t.accent, "#000000", 0.45), 100]]) }, name: "Hero" });
      const top = k.b.stack([hero, k.b.stack([k.b.close(k.icons, "#ffffff")], { size: sz(FILL, FIT), dir: "horizontal", padding: pad(12, 14) })], { dir: "zlayer", align: "top_leading", size: sz(FILL, FIT) });
      const body = k.b.stack([
        k.title(`Get the most out of ${k.app}`, 26),
        k.features([["zap", "Faster results"], ["infinity", "Unlimited projects"], ["cloud", "Backup and sync"], ["users", "Share with your family"], ["heart", "Support an independent team"]]),
        k.plansList(2, { horizontal: true }),
      ], { spacing: 18, padding: pad(20, 20, 24) });
      return k.done(k.b.stack([top, body], { size: sz(FILL, FILL), scroll: true, name: "Content" }), k.footer());
    },
  },
  {
    id: "comparison", name: "Free vs Pro", description: "A short comparison of the free plan and Pro, then two plans.",
    screens: 1, purchase_method: "in_app", packages: 2, tiers: 1, tags: ["comparison", "table"], evidence: "Keep the table short: a simple paywall beat a long feature-comparison chart by 111% (Superwall).",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#7c3aed" }));
      const b = k.b, t = k.t;
      const cell = (v: boolean | string) => typeof v === "string" ? k.text(v, { size: 13, weight: "semibold", width: fixed(56) })
        : b.stack([k.icon(v ? "check" : "x", { size: 18, color: v ? t.accent : t.muted })], { size: sz(fixed(56), FIT) });
      const row = (label: string, free: boolean | string, pro: boolean | string, head = false) => b.stack([
        k.text(label, { size: head ? 13 : 15, weight: head ? "semibold" : "regular", align: "leading", color: head ? t.muted : t.fg }), cell(free), cell(pro),
      ], { dir: "horizontal", spacing: 8, padding: pad(11, 14), size: sz(FILL, FIT) });
      const table = b.stack([
        row("Feature", "Free", "Pro", true), row("Basic tools", true, true), row("Unlimited exports", false, true), row("Cloud sync", false, true), row("No ads", false, true), row("Priority support", false, true),
      ], { spacing: 0, shape: rounded(14), border: { color: scheme(t.line, t.lineDark), width: 1 }, bg: t.card, bgDark: t.cardDark, name: "Comparison" });
      return k.done(k.main([k.topBar(), k.title(`${k.app} Pro`), k.muted("See what you get when you upgrade."), table, k.plansList(2)]), k.footer());
    },
  },
  {
    id: "minimal", name: "Minimal", description: "A headline, your plans and one button.",
    screens: 1, purchase_method: "in_app", packages: 3, tiers: 1, tags: ["minimal"], evidence: "Native-looking, simple paywalls beat heavily designed ones; plain plan names add 10% (Superwall).",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#111111" }));
      return k.done(k.main([k.topBar(), k.b.stack([], { size: sz(FILL, fixed(24)) }), k.title(`Go further with ${k.app}`, 30), k.muted("Pick a plan. Change or cancel anytime.", { size: 16 }), k.plansList(3, { badge: false })], { spacing: 18 }), k.footer([], { reassure: false }));
    },
  },
  {
    id: "onboarding_pages", name: "Story pages", description: "Three swipeable pages of value before the plans, like the last steps of onboarding.",
    screens: 3, purchase_method: "in_app", packages: 2, tiers: 1, tags: ["multi-page", "onboarding", "carousel"], evidence: "Paywalls of 2–3 pages converted 12.41% against 9.07% for one page, +37% over 40M views (Superwall 2026).",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#ea580c" }));
      const page = (icon: string, title: string, body: string) => k.b.stack([
        k.heroIcon(icon, 88), k.title(title, 26), k.muted(body, { size: 16 }),
      ], { spacing: 16, padding: pad(28, 24), distribution: "center", size: sz(FILL, fixed(340)), bg: k.t.card, bgDark: k.t.cardDark, shape: rounded(20) });
      const pages = [
        page("target", "Your plan is ready", `${k.app} built it from your answers. Here is what changes.`),
        page("trending_up", "See progress in weeks", "People who follow their plan for 30 days are three times more likely to reach their goal."),
        page("calendar_check", "Try it free", "Full access during your trial. We remind you before it ends."),
      ];
      return k.done(k.main([k.topBar(), k.b.carousel(pages, { peek: 0, spacing: 12, dot: k.t.line, dotActive: k.t.accent }), k.plansList(2)], { spacing: 16 }), k.footer());
    },
  },
  {
    id: "countdown_offer", name: "Limited offer", description: "A countdown to the end of an offer, one plan, a strong button. Dark.",
    screens: 1, purchase_method: "in_app", packages: 1, tiers: 1, tags: ["offer", "countdown", "discount"], evidence: "A discounted offer after a cancelled purchase made 17% of total revenue, with half the refunds (Superwall).",
    build(input = {}) {
      const k = new Kit(input, theme(input, { bg: "#0b0b0f", bgDark: "#0b0b0f", fg: "#ffffff", fgDark: "#ffffff", accent: "#f7b500", card: "#17171d", cardDark: "#17171d" }));
      const b = k.b, t = k.t;
      const unit = (v: string, label: string) => b.stack([k.text(v, { size: 28, weight: "bold" }), k.muted(label, { size: 11 })], { spacing: 2, padding: pad(10, 4), size: sz(fixed(68), FIT), bg: t.card, bgDark: t.cardDark, shape: rounded(12) });
      const clock = b.countdown(twoDaysAfter(input.now), b.stack([
        unit("{{ count_days_with_zero }}", "DAYS"), unit("{{ count_hours_with_zero }}", "HOURS"), unit("{{ count_minutes_with_zero }}", "MIN"), unit("{{ count_seconds_with_zero }}", "SEC"),
      ], { dir: "horizontal", spacing: 8, distribution: "center" }), b.stack([k.text("This offer has ended", { size: 15, weight: "semibold" })], {}), "days");
      const p = k.plans(1)[0]!;
      const offer = b.pkg(p.id, true, b.stack([
        k.text(p.label, { size: 17, weight: "semibold" }),
        b.textIntro("{{ product.price_per_period }}", "{{ product.offer_price }} for {{ product.offer_period_with_unit }}, then {{ product.price_per_period }}", { size: 15, color: t.muted, colorDark: t.mutedDark }),
      ], { spacing: 4, padding: pad(18, 16), shape: rounded(14), border: { color: scheme(t.accent), width: 2 }, bg: t.card, bgDark: t.cardDark }), p.label);
      const tagline = b.stack([b.text("LIMITED TIME OFFER", { size: 12, weight: "bold", color: "#111111", width: FIT })], { size: sz(FIT, FIT), padding: pad(5, 12), bg: t.accent, shape: PILL });
      return k.done(k.main([
        k.topBar(), b.stack([tagline], { size: sz(FILL, FIT) }), k.title(`Save on ${k.app} Pro`, 32), k.muted("The best price of the year, for a short time only.", { size: 16 }),
        clock, offer,
      ], { spacing: 18 }), k.footer([], { label: "Claim offer" }));
    },
  },
  {
    id: "tiers_tabs", name: "Tiers", description: "Two tiers in tabs (Plus and Pro), each with its own benefits and two plans.",
    screens: 1, purchase_method: "in_app", packages: 4, tiers: 2, tags: ["tiers", "tabs"], evidence: "Tiers let a customer pick a level first and a period second; tabs keep both on one screen.",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#0f766e" }));
      const all = k.pk;
      const half = Math.max(1, Math.ceil(all.length / 2));
      const plus = all.length >= 2 ? all.slice(0, half) : all, pro = all.length >= 2 ? all.slice(half) : all;
      const tierPlans = (list: typeof all) => k.b.stack(
        [...list.filter((p) => isAnnual(p.id)), ...list.filter((p) => !isAnnual(p.id))].map((p, i) => k.plan(p, i === 0, { badge: i === 0 && isAnnual(p.id) && list.length > 1 ? "BEST VALUE" : undefined })),
        { spacing: 12, name: "Plans" });
      const tabs = k.b.tabs([
        { id: "plus", label: "Plus", content: [k.features([["check", "Unlimited projects"], ["check", "No ads"], ["check", "Sync on 2 devices"]]), tierPlans(plus.length ? plus : all)] },
        { id: "pro", label: "Pro", content: [k.features([["check", "Everything in Plus"], ["check", "Unlimited devices"], ["check", "Advanced tools and exports"], ["check", "Priority support"]]), tierPlans(pro.length ? pro : all)] },
      ], { selectedBg: k.t.bg, selectedFg: k.t.fg, fg: k.t.muted, trackBg: mix(k.t.fg, k.t.bg, 0.92), defaultTab: "pro" });
      return k.done(k.main([k.topBar(), k.title(`Choose your ${k.app}`), tabs], { spacing: 18 }), k.footer());
    },
  },
  {
    id: "social_proof", name: "Reviews", description: "Rating, a user count and one real review, then two plans.",
    screens: 1, purchase_method: "in_app", packages: 2, tiers: 1, tags: ["reviews", "social proof"], evidence: "Real reviews with price anchoring: +17% revenue per user; with one strong statistic, +72% install-to-trial (RevenueCat).",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#db2777" }));
      const b = k.b, t = k.t;
      const stars = b.stack(Array.from({ length: 5 }, () => k.icon("star", { size: 20, color: "#f5a524" })), { dir: "horizontal", spacing: 4, distribution: "center" });
      const review = b.stack([
        k.text("“I use it every day. Worth every cent.”", { size: 16, weight: "medium" }),
        k.muted("Alex, App Store review", { size: 13 }),
      ], { spacing: 8, padding: pad(16, 16), bg: t.card, bgDark: t.cardDark, shape: rounded(14) });
      return k.done(k.main([
        k.topBar(), stars, k.muted("4.8 average from 10,000+ ratings", { size: 13 }), k.title(`Join 1 million people on ${k.app} Pro`, 26), review, k.plansList(2),
      ], { spacing: 16 }), k.footer());
    },
  },
  {
    id: "web_checkout", name: "Web checkout", description: "Benefits and plans; the button opens web checkout instead of the store sheet.",
    screens: 1, purchase_method: "web", packages: 2, tiers: 1, tags: ["web", "checkout"], evidence: "Web checkout keeps the store fee; use it only where the store rules allow external purchases.",
    build(input = {}) {
      const k = new Kit(input, theme(input, { accent: "#111111" }));
      return k.done(k.main([
        k.topBar(), k.b.stack([k.heroIcon("globe")], {}), k.title(`${k.app} on every device`), k.muted("Subscribe once on the web and use it everywhere."),
        k.features([["devices", "Phone, tablet and computer"], ["sync", "Your data in sync"], ["tag", "Our best price"]]), k.plansList(2),
      ]), k.footer([], { method: "web_checkout", label: "Continue to checkout" }));
    },
  },
];

export function paywallTemplate(id: string): GalleryTemplate | null { return PAYWALL_TEMPLATES.find((t) => t.id === id) ?? null; }
/** Template metadata without the builder, for listings. */
export const paywallTemplateList = (): TemplateMeta[] => PAYWALL_TEMPLATES.map(({ build: _b, ...m }) => m);

/** An empty paywall: a scrolling stack with a title, the offering's packages and a sticky purchase button. */
export function blankPaywall(input: TemplateInput = {}): PaywallDoc {
  const k = new Kit(input, theme(input));
  return k.done(k.main([k.topBar(), k.title("Your headline"), k.plansList(2, { badge: false })]), k.footer([], { reassure: false }));
}

