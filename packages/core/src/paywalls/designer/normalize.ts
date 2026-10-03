/**
 * Deterministic fixes applied to every design before it is checked: what the brief or the form decides exactly does
 * not need a model round. Plans follow the brief's order, selection and trial plans (plans the model left out are added); the form's brand colours are used
 * as given; social proof without facts from the developer is removed; sections are listed once.
 */
import { PAYWALL_ICON_NAMES } from "../icons.js";
import { planLabel } from "../gallery.js";
import { cleanHex, luminance, mix } from "./color.js";
import { SECTION_NAMES, type PaywallBrief, type PaywallDesign, type SectionName } from "./schema.js";

export interface NormalizeInput {
  brief: PaywallBrief | null; packages: string[]; brandColors?: string[]; locale?: string;
  /** One-time purchase packages (`lifetimeIds`): never a trial. */
  lifetime?: Set<string>;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function normalizeDesign(raw: PaywallDesign, i: NormalizeInput): { design: PaywallDesign; fixes: string[] } {
  const d = clone(raw);
  const fixes: string[] = [];
  const b = i.brief;
  // Shapes a lenient provider may get wrong.
  d.plans ??= { layout: "list", title: "", items: [], selected: "" };
  d.plans.items = (d.plans.items ?? []).filter((p) => p && i.packages.includes(p.package_id));
  d.footer ??= { cta: "Continue", cta_trial: "", reassurance: "", disclosure: "{{ product.price_per_period }}. Renews automatically. Cancel anytime.", disclosure_trial: "", restore: "Restore purchases" };
  d.notes = (d.notes ?? []).filter((n) => typeof n === "string" && n.trim()).slice(0, 3);
  const iconOk = (n: string) => PAYWALL_ICON_NAMES.includes(n);
  if (d.hero && !iconOk(d.hero.icon)) d.hero.icon = "sparkles";
  d.benefits?.items.forEach((x) => { if (!iconOk(x.icon)) x.icon = "check_circle"; });
  d.trial_timeline?.items.forEach((x) => { if (!iconOk(x.icon)) x.icon = x.moment === "reminder" ? "bell" : x.moment === "trial_end" ? "credit_card" : "unlock"; });
  d.pages?.pages.forEach((x) => { if (!iconOk(x.icon)) x.icon = "sparkles"; });

  if (b) {
    const want = b.plans.order.filter((p) => i.packages.includes(p));
    if (want.length) {
      const have = new Map(d.plans.items.map((p) => [p.package_id, p]));
      const life = i.lifetime ?? new Set<string>();
      const missing = want.filter((p) => !have.has(p));
      // A plan the brief asks for always shows, even when the model left it out.
      for (const p of missing) have.set(p, { package_id: p, title: planLabel(p), subtitle: life.has(p) ? "Pay once, yours forever" : "{{ product.price_per_period }}", trial_subtitle: "", badge: "", trial: false });
      if (missing.length) fixes.push("Added the plans the brief asks for.");
      const ordered = want.map((p) => have.get(p)!);
      if (ordered.map((p) => p.package_id).join() !== d.plans.items.map((p) => p.package_id).join()) {
        if (d.plans.items.some((p) => !want.includes(p.package_id))) fixes.push("Removed plans the brief does not ask for.");
        if (!missing.length && (ordered.length > 1 || d.plans.items.length > 1)) fixes.push("Put the plans in the brief's order.");
        d.plans.items = ordered;
      }
    }
    if (b.plans.selected && d.plans.items.some((p) => p.package_id === b.plans.selected) && d.plans.selected !== b.plans.selected) {
      d.plans.selected = b.plans.selected;
      fixes.push("Selected the plan the brief highlights.");
    }
    const trial = new Set(b.plans.trial_packages);
    for (const p of d.plans.items) {
      const t = trial.has(p.package_id) && !i.lifetime?.has(p.package_id);
      if (p.trial !== t) { p.trial = t; fixes.push("Marked the free trial on the plans the brief names."); }
      if (!t && p.trial_subtitle.trim()) { p.trial_subtitle = ""; }
    }
    if (d.social_proof && !b.facts.length) { d.social_proof = null; fixes.push("Removed social proof: the brief gives no ratings or reviews to quote."); }
    if (b.benefits.count > 0 && d.benefits && d.benefits.items.length > b.benefits.count) {
      d.benefits.items = d.benefits.items.slice(0, b.benefits.count);
      fixes.push(`Kept the ${b.benefits.count} benefits the brief asks for.`);
    }
    if (i.locale || b.locale) d.locale = i.locale || b.locale;
  }
  if (!d.plans.items.some((p) => p.package_id === d.plans.selected) && d.plans.items[0]) d.plans.selected = d.plans.items[0].package_id;

  // The form's brand colours are not a suggestion.
  const brand = (i.brandColors ?? []).map((c) => cleanHex(c, "")).filter(Boolean);
  if (brand.length) {
    const t = d.theme;
    if (brand[0] && t.accent.toLowerCase() !== brand[0]) { t.accent = brand[0]; t.on_accent = luminance(brand[0]) > 0.45 ? "#111111" : "#ffffff"; fixes.push("Used your brand accent colour."); }
    if (brand[1] && (t.background.colors[0] ?? "").toLowerCase() !== brand[1]) {
      t.background = { style: "solid", colors: [brand[1]], angle: 180 };
      t.appearance = luminance(brand[1]) < 0.2 ? "dark" : "light";
      t.card = mix(brand[1], t.appearance === "dark" ? "#ffffff" : "#000000", 0.06);
      t.card_border = mix(brand[1], t.appearance === "dark" ? "#ffffff" : "#000000", 0.16);
      fixes.push("Used your brand background colour.");
    }
    if (brand[2] && t.text.toLowerCase() !== brand[2]) { t.text = brand[2]; fixes.push("Used your brand text colour."); }
  }

  // Sections: listed once, only filled ones, plans always.
  const order: SectionName[] = [];
  for (const s of d.order ?? []) if (SECTION_NAMES.includes(s) && !order.includes(s) && (s === "plans" || d[s as keyof PaywallDesign])) order.push(s);
  if (!order.includes("plans")) order.push("plans");
  d.order = order;
  return { design: d, fixes: [...new Set(fixes)] };
}
