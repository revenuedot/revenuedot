/**
 * The AI paywall designer's checker (prd/paywalls/PRD.md §3): what a reviewer would catch before shipping a paywall.
 * Errors go back to the model for a repair round; warnings are fixed when a round runs anyway and are shown to the
 * developer otherwise.
 * - The SDK contract: `validatePaywall` on the compiled components.
 * - Prices: only SDK variables, never typed amounts; trial variables only in trial wording (they are empty without a
 *   trial); what is charged after the trial is the regular price ("starts at free" is the classic bug); discount
 *   variables only where they are not empty.
 * - The brief: plan order, selected plan, trial plans, discount, number and names of benefits, app name, look, brand
 *   colours, language, the sections asked for, no invented ratings.
 * - Icons that mean what the text says; copy that fits a phone; text contrast of 4.5:1 in light and dark mode.
 */
import { forEachComponent, type Json, type PaywallDoc } from "../build.js";
import { validatePaywall } from "../validate.js";
import { parseHex, worstContrast } from "./color.js";
import { packagePrices, type OfferingFacts } from "./prompt.js";
import type { PaywallBrief, PaywallDesign } from "./schema.js";

export interface DesignIssue { severity: "error" | "warning"; code: string; message: string }
export interface CheckInput {
  design: PaywallDesign;
  doc: PaywallDoc;
  brief: PaywallBrief | null;
  offering: OfferingFacts;
  appName?: string;
  brandColors?: string[];
}

/** Every variable the SDKs replace (purchases-ios VariableHandlerV2). */
export const SDK_VARIABLES = new Set([
  "product.currency_code", "product.currency_symbol", "product.periodly", "product.price", "product.price_per_period", "product.price_per_period_abbreviated",
  "product.price_per_day", "product.price_per_week", "product.price_per_month", "product.price_per_year", "product.period", "product.period_abbreviated",
  "product.period_in_days", "product.period_in_weeks", "product.period_in_months", "product.period_in_years", "product.period_with_unit",
  "product.offer_price", "product.offer_price_per_day", "product.offer_price_per_week", "product.offer_price_per_month", "product.offer_price_per_year",
  "product.offer_price_with_zero", "product.offer_price_with_zero_per_day", "product.offer_price_with_zero_per_week", "product.offer_price_with_zero_per_month",
  "product.offer_price_with_zero_per_year", "product.offer_period", "product.offer_period_abbreviated", "product.offer_period_in_days",
  "product.offer_period_in_weeks", "product.offer_period_in_months", "product.offer_period_in_years", "product.offer_period_with_unit", "product.offer_end_date",
  "product.secondary_offer_price", "product.secondary_offer_period", "product.secondary_offer_period_abbreviated", "product.relative_discount", "product.store_product_name",
  "count_days_with_zero", "count_days_without_zero", "count_hours_with_zero", "count_hours_without_zero", "count_minutes_with_zero", "count_minutes_without_zero",
  "count_seconds_with_zero", "count_seconds_without_zero",
]);
const BILLED = ["product.price", "product.price_per_period", "product.price_per_period_abbreviated"];
export const varsIn = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)\s*(?:\|\s*\w+\s*)?\}\}/g)].map((m) => m[1]!);
const isOffer = (v: string) => v.startsWith("product.offer_") || v.startsWith("product.secondary_offer");
const MONEY = /(?:[$€£¥₹₩]\s?\d)|(?:\d+(?:[.,]\d{1,2})?\s?(?:USD|EUR|GBP|\$|€|£|zł|kr)\b)|(?:\d+[.,]\d{2}\b)/;
const NUMBERS_AS_PROOF = /\b\d+(?:[.,]\d+)?\s*(?:k|K|M|million|millions|thousand|\+)?\s*(?:users|people|members|downloads|ratings|reviews|customers|subscribers|stars|★)/i;

/** Strings of a design with where they appear (`trial`: shown only while the selected plan has a free trial). */
interface Copy { where: string; text: string; trial: boolean; kind: "title" | "subtitle" | "benefit" | "desc" | "cta" | "badge" | "line" | "small" }
export function designCopy(d: PaywallDesign): Copy[] {
  const out: Copy[] = [];
  const add = (where: string, text: string | undefined, kind: Copy["kind"], trial = false) => { if (text?.trim()) out.push({ where, text: text.trim(), trial, kind }); };
  if (d.hero) { add("hero.eyebrow", d.hero.eyebrow, "small"); add("hero.title", d.hero.title, "title"); add("hero.subtitle", d.hero.subtitle, "subtitle"); }
  d.benefits?.items.forEach((b, i) => { add(`benefits.items[${i}].title`, b.title, "benefit"); add(`benefits.items[${i}].description`, b.description, "desc"); });
  if (d.benefits) add("benefits.title", d.benefits.title, "subtitle");
  if (d.trial_timeline) {
    add("trial_timeline.title", d.trial_timeline.title, "subtitle", true);
    d.trial_timeline.items.forEach((t, i) => { add(`trial_timeline.items[${i}].title`, t.title, "benefit", true); add(`trial_timeline.items[${i}].description`, t.description, "desc", true); });
  }
  if (d.social_proof) { add("social_proof.rating_label", d.social_proof.rating_label, "small"); add("social_proof.quote", d.social_proof.quote, "line"); add("social_proof.author", d.social_proof.author, "small"); }
  if (d.countdown) { add("countdown.label", d.countdown.label, "small"); add("countdown.ended_text", d.countdown.ended_text, "line"); }
  if (d.comparison) { add("comparison.free_label", d.comparison.free_label, "small"); add("comparison.pro_label", d.comparison.pro_label, "small"); d.comparison.rows.forEach((r, i) => add(`comparison.rows[${i}].feature`, r.feature, "benefit")); }
  d.pages?.pages.forEach((p, i) => { add(`pages.pages[${i}].title`, p.title, "title"); add(`pages.pages[${i}].body`, p.body, "line"); });
  if (d.note) add("note.text", d.note.text, "line");
  add("plans.title", d.plans.title, "subtitle");
  d.plans.items.forEach((p, i) => {
    add(`plans.items[${i}].title`, p.title, "benefit"); add(`plans.items[${i}].subtitle`, p.subtitle, "small");
    add(`plans.items[${i}].trial_subtitle`, p.trial_subtitle, "small", true); add(`plans.items[${i}].badge`, p.badge, "badge");
  });
  add("footer.cta", d.footer.cta, "cta"); add("footer.cta_trial", d.footer.cta_trial, "cta", true); add("footer.reassurance", d.footer.reassurance, "line");
  add("footer.disclosure", d.footer.disclosure, "small"); add("footer.disclosure_trial", d.footer.disclosure_trial, "small", true); add("footer.restore", d.footer.restore, "small");
  return out;
}

/** Longest comfortable length per kind of text (English; other languages get a third more). */
const MAX: Record<Copy["kind"], number> = { title: 44, subtitle: 110, benefit: 40, desc: 80, cta: 26, badge: 18, line: 120, small: 140 };

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\{\{[^}]*\}\}/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
const STOP = new Set(["the", "and", "for", "with", "your", "you", "all", "any", "our", "app", "unlimited", "access", "more", "get", "new", "full", "free", "pro", "premium", "plus"]);
/** Whether a benefit the brief names shows up among the design's benefits (word overlap, light stemming). */
function mentions(named: string, texts: string[]): boolean {
  const stem = (w: string) => w.replace(/(ings|ing|ies|es|s|ed)$/, "");
  const want = words(named).filter((w) => !STOP.has(w)).map(stem);
  if (!want.length) return true;
  const have = new Set(texts.flatMap(words).map(stem));
  return want.some((w) => have.has(w) || [...have].some((h) => h.length > 3 && (h.startsWith(w) || w.startsWith(h))));
}
const dist = (a: string, b: string) => { const x = parseHex(a), y = parseHex(b); return x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 999; };

/** Icons that fit a timeline moment. */
const MOMENT_ICONS: Record<string, string[]> = {
  today: ["unlock", "sparkles", "check", "check_circle", "star", "gift", "zap", "crown", "rocket", "heart"],
  reminder: ["bell"],
  trial_end: ["credit_card", "calendar", "calendar_check", "tag", "star", "crown", "check_circle"],
};
/** Benefit words and the icons that show them; a generic icon on such a benefit is a warning. */
const MEANINGS: [RegExp, string[]][] = [
  [/offline|download/, ["download"]], [/sleep|night|bedtime|dream/, ["moon", "headphones", "book"]], [/breath/, ["wind", "leaf"]],
  [/stor(y|ies)/, ["book", "headphones", "moon"]], [/\bads?\b|ad-free/, ["no_ads"]], [/sync|devices/, ["sync", "devices", "cloud"]],
  [/photo|camera|picture/, ["camera", "image", "wand", "sparkles"]], [/language|translat|speak/, ["globe", "chat", "mic"]],
  [/family|team|share|collaborat/, ["users"]], [/workout|exercise|training|strength/, ["dumbbell", "flame", "target", "trophy"]],
  [/progress|stats|insight|analytic/, ["chart", "trending_up"]], [/backup|cloud/, ["cloud"]], [/remind/, ["bell"]],
  [/music|sound/, ["music", "headphones"]], [/note|write|writing/, ["pencil", "file_text"]], [/search/, ["search"]],
];
const GENERIC = new Set(["check", "check_circle", "star"]);

export function checkDesign(i: CheckInput): DesignIssue[] {
  const { design: d, doc, brief, offering } = i;
  const out: DesignIssue[] = [];
  const err = (code: string, message: string) => out.push({ severity: "error", code, message });
  const warn = (code: string, message: string) => out.push({ severity: "warning", code, message });
  const pkgIds = offering.packages.map((p) => p.id);
  const items = d.plans.items;
  const copy = designCopy(d);
  const lang = (brief?.locale ?? d.locale ?? "en_US").slice(0, 2);
  const stretch = lang === "en" ? 1 : 1.35;

  // ---- The SDK contract
  const v = validatePaywall(doc, { packages: pkgIds.length ? pkgIds : undefined });
  for (const e of v.errors.slice(0, 5)) err("invalid", `The compiled paywall is invalid at ${e.path}: ${e.message}`);

  // ---- Plans
  const ids = items.map((p) => p.package_id);
  if (new Set(ids).size !== ids.length) err("plans_duplicate", "plans.items lists a package twice; list each package once.");
  if (!ids.length) err("plans_empty", "plans.items is empty; list the brief's packages.");
  if (!ids.includes(d.plans.selected)) err("plans_selected", `plans.selected (${d.plans.selected}) is not one of plans.items.`);
  if (brief) {
    const want = brief.plans.order.filter((p) => pkgIds.includes(p));
    if (want.length && want.join(",") !== ids.join(",")) err("plans_order", `The plans must be exactly ${want.join(", ")} in this order (the brief's order); the design has ${ids.join(", ") || "none"}.`);
    if (brief.plans.selected && ids.includes(brief.plans.selected) && d.plans.selected !== brief.plans.selected) err("plans_selected", `plans.selected must be ${brief.plans.selected}, the plan the brief highlights.`);
    const trialWant = new Set(brief.plans.trial_packages.filter((p) => ids.includes(p)));
    for (const p of items) if (p.trial !== trialWant.has(p.package_id)) err("plans_trial", `${p.package_id} must have trial ${trialWant.has(p.package_id)}: the brief puts the free trial on ${[...trialWant].join(", ") || "no plan"}.`);
  }
  // relative_discount is empty on the plan that costs the most per month.
  const prices = packagePrices(offering);
  const top = Math.max(...prices.filter((p) => ids.includes(p.id)).map((p) => p.perMonth ?? 0));
  for (const p of items) {
    const pr = prices.find((x) => x.id === p.package_id);
    if (pr && pr.perMonth !== null && pr.perMonth >= top && `${p.badge} ${p.subtitle}`.includes("relative_discount")) err("discount_empty", `${p.package_id} is the most expensive plan per month, so {{ product.relative_discount }} is empty there; move the savings badge to a cheaper plan.`);
    if (/life/i.test(p.package_id) && /\{\{\s*product\.(period|periodly|price_per_period|price_per_month)/.test(`${p.subtitle} ${p.trial_subtitle}`)) err("lifetime_period", `${p.package_id} is a one-time purchase: its texts cannot use period variables (they are empty). Say "Pay once, yours forever".`);
  }
  if (d.plans.layout === "cards" && items.length > 3) warn("plans_cards", "Side-by-side cards fit at most 3 plans; use layout list.");
  if (d.plans.layout === "cards" && items.some((p) => p.title.length > 12)) warn("plans_cards", "Plan titles in side-by-side cards must be short (at most 12 characters); shorten them or use layout list.");

  // ---- Prices and variables
  const anyTrial = items.some((p) => p.trial);
  for (const c of copy) {
    for (const name of varsIn(c.text)) {
      if (!SDK_VARIABLES.has(name)) { err("variable_unknown", `${c.where} uses {{ ${name} }}, which the SDK does not know. Use only the listed variables.`); continue; }
      if (isOffer(name) && !c.trial) err("variable_trial", `${c.where} uses {{ ${name} }}, which is empty when the selected plan has no free trial. Trial wording belongs in cta_trial, trial_subtitle, disclosure_trial or the trial timeline.`);
      if (name.startsWith("count_") && !c.where.startsWith("countdown")) err("variable_countdown", `${c.where} uses {{ ${name} }}, which only works inside the countdown.`);
    }
    if (MONEY.test(c.text.replace(/\{\{[^}]*\}\}/g, ""))) err("price_literal", `${c.where} has a typed price ("${c.text}"). Use price variables such as {{ product.price_per_period }}; the device shows the local price.`);
    if (/\{\{\s*product\.offer_price(_with_zero)?\s*\}\}/.test(c.text) && (/(start|begin|charg|bill|renew|then|after|cobr|factur|luego|después|danach|ensuite|puis)/i.test(c.text.split(/\{\{\s*product\.offer_price/)[0]!.slice(-40)) || c.where.includes("trial_timeline.items") && d.trial_timeline?.items[Number(/\[(\d+)\]/.exec(c.where)?.[1])]?.moment === "trial_end")) {
      err("offer_price_charge", `${c.where} says "${c.text}": {{ product.offer_price }} is the trial price (the word "free"), not what is charged after the trial. Use {{ product.price_per_period }} for the amount charged.`);
    }
    // Measured as the customer sees it: a variable becomes about as long as its value ("$59.99/yr", "50%").
    const shown = c.text.replace(/\{\{[^}]*\}\}/g, "$59.99");
    if (shown.length > MAX[c.kind] * stretch) warn("copy_long", `${c.where} is ${shown.length} characters on screen ("${c.text.slice(0, 60)}"); keep it under ${Math.round(MAX[c.kind] * stretch)} so it fits a phone.`);
    if (/\{\{\s*product\.relative_discount/.test(c.text) && !c.where.startsWith("plans.items")) warn("discount_outside", `${c.where} uses {{ product.relative_discount }} outside a plan card, where it follows the selected plan and is empty on the most expensive one.`);
  }
  if (!varsIn(d.footer.disclosure).some((x) => BILLED.includes(x))) err("disclosure_price", `footer.disclosure must state the billed price with {{ product.price_per_period }} (Apple asks for the price and renewal terms).`);
  if (anyTrial) {
    if (!d.footer.cta_trial.trim()) err("cta_trial", "A plan has a free trial: footer.cta_trial must say so (e.g. Start free trial).");
    const dt = varsIn(d.footer.disclosure_trial);
    if (!dt.some((x) => x.startsWith("product.offer_period")) || !dt.some((x) => BILLED.includes(x))) err("disclosure_trial", "footer.disclosure_trial must give the trial length ({{ product.offer_period_with_unit }}) and what is charged after it ({{ product.price_per_period }}).");
    if (!d.trial_timeline?.items.length) err("timeline_missing", "A plan has a free trial: add the trial_timeline (today, reminder, trial_end).");
  }
  if (d.trial_timeline) {
    const end = d.trial_timeline.items.find((t) => t.moment === "trial_end");
    if (!end) err("timeline_end", "The trial timeline needs a trial_end item saying what is charged and when.");
    else if (!varsIn(`${end.title} ${end.description}`).some((x) => BILLED.includes(x))) err("timeline_charge", `The trial_end item must say what is charged with {{ product.price_per_period }} ("${end.title}: ${end.description}").`);
    for (const [n, t] of d.trial_timeline.items.entries()) {
      const fit = MOMENT_ICONS[t.moment];
      if (t.moment === "today" && t.icon === "lock") err("icon_meaning", `trial_timeline.items[${n}] (today, full access) uses the lock icon; use unlock or sparkles.`);
      else if (fit && !fit.includes(t.icon)) warn("icon_meaning", `trial_timeline.items[${n}] (${t.moment}) uses the ${t.icon} icon; use ${fit.slice(0, 3).join(" or ")}.`);
    }
    if (brief?.plans.trial_days) {
      for (const t of d.trial_timeline.items) {
        const m = /\b(?:day|día|tag|jour|giorno|dia|dag)\s+(\d{1,3})\b/i.exec(`${t.title} ${t.description}`);
        if (m && t.moment === "trial_end" && Number(m[1]) !== brief.plans.trial_days) err("trial_days", `The timeline says day ${m[1]}, but the trial is ${brief.plans.trial_days} days.`);
      }
    }
  }

  // ---- Icons on benefits
  d.benefits?.items.forEach((b, n) => {
    const text = `${b.title} ${b.description}`.toLowerCase();
    const hit = MEANINGS.find(([re]) => re.test(text));
    if (hit && GENERIC.has(b.icon) && !hit[1].includes(b.icon)) warn("icon_meaning", `benefits.items[${n}] ("${b.title}") uses the generic ${b.icon} icon; ${hit[1].join(" or ")} shows its meaning.`);
    if (b.icon === "lock" && /unlock|access|all /i.test(text)) warn("icon_meaning", `benefits.items[${n}] ("${b.title}") is about access; the lock icon reads as locked. Use unlock.`);
  });

  // ---- The brief
  const all = copy.filter((c) => !c.where.startsWith("footer.restore")).map((c) => c.text);
  const app = (i.appName?.trim() || brief?.app_name?.trim() || "");
  if (app && !all.some((t) => t.toLowerCase().includes(app.toLowerCase()))) err("app_name", `Use the app name "${app}" in the copy, ideally in the hero title or subtitle.`);
  if (brief) {
    if (brief.benefits.count > 0 && (d.benefits?.items.length ?? 0) !== brief.benefits.count) err("benefit_count", `The brief asks for ${brief.benefits.count} benefits; the design has ${d.benefits?.items.length ?? 0}.`);
    const benefitTexts = [...(d.benefits?.items.flatMap((b) => [b.title, b.description]) ?? []), ...(d.pages?.pages.flatMap((p) => [p.title, p.body]) ?? []), ...(d.comparison?.rows.map((r) => r.feature) ?? [])];
    for (const n of brief.benefits.named) if (!mentions(n, benefitTexts)) err("benefit_named", `The brief names the benefit "${n}"; it is not among the benefits.`);
    if (brief.discount.percent > 0) {
      const has = all.some((t) => t.includes(`${brief.discount.percent}`) || /relative_discount/.test(t));
      if (!has) err("discount", `The brief asks for ${brief.discount.percent}% off${brief.discount.package_id ? ` on ${brief.discount.package_id}` : ""}; show it (e.g. a "${brief.discount.percent}% OFF" badge on that plan).`);
    }
    for (const s of brief.sections) if (!d[s]) err("section_missing", `The brief asks for a ${s.replace(/_/g, " ")} section.`);
    if (brief.look.appearance !== "unspecified" && d.theme.appearance !== brief.look.appearance) err("look", `The brief asks for a ${brief.look.appearance} look; theme.appearance is ${d.theme.appearance}.`);
    if (brief.look.gradient && d.theme.background.style === "solid") err("look", `The brief asks for "${brief.look.description}": use a gradient background.`);
    if (d.locale.slice(0, 2) !== brief.locale.slice(0, 2)) err("locale", `Write the paywall in ${brief.locale} (design.locale is ${d.locale}).`);
    if (d.social_proof && !brief.facts.length && (d.social_proof.rating > 0 || NUMBERS_AS_PROOF.test(`${d.social_proof.rating_label} ${d.social_proof.quote}`))) err("invented_proof", "The brief gives no ratings, reviews or user counts: remove social_proof (never invent them).");
  }
  if (!brief?.facts.length) for (const c of copy) if (NUMBERS_AS_PROOF.test(c.text)) err("invented_proof", `${c.where} claims "${c.text}"; the brief gives no such numbers. Remove it.`);
  const bg0 = d.theme.background.colors[0] ?? "#ffffff";
  if (brief?.look.appearance === "dark" && (parseHex(bg0)?.slice(0, 3).reduce((a, b) => a + b, 0) ?? 0) > 3 * 110) err("look", "The brief asks for a dark look; the background is too light.");
  const stops = d.theme.background.colors;
  if (d.theme.background.style !== "solid" && stops.length > 1) {
    const lum = stops.map((c) => (parseHex(c)?.slice(0, 3).reduce((a, b) => a + b, 0) ?? 0) / 765);
    if (Math.max(...lum) - Math.min(...lum) > 0.45) warn("gradient", "The gradient mixes light and dark colours, so no text colour reads on all of it; keep the stops of similar lightness.");
  }
  const brand = (i.brandColors ?? []).filter((c) => parseHex(c));
  if (brand[0] && dist(brand[0], d.theme.accent) > 40) err("brand", `Use the brand accent ${brand[0]} as theme.accent (it is ${d.theme.accent}).`);
  if (brand[1] && dist(brand[1], bg0) > 40) err("brand", `Use the brand background ${brand[1]} as the first background colour.`);
  if (d.close_button === "none") warn("close", "Add a close button: a paywall without a way out is rejected by reviewers and annoys people.");

  // ---- Contrast of the compiled paywall (the compiler adjusts colours; this catches what it could not)
  for (const c of contrastProblems(doc).slice(0, 4)) err("contrast", c);
  return out;
}

// ---- Contrast over the compiled components ---------------------------------------------------------------------------

/** The colours of a colour scheme for one mode: one for hex, every stop for a gradient. */
function colorsOf(s: Json | undefined, dark: boolean): string[] {
  const info = s && ((dark && s.dark) || s.light);
  if (!info) return [];
  if (info.type === "hex" && typeof info.value === "string") return [info.value];
  if ((info.type === "linear" || info.type === "radial") && Array.isArray(info.points)) return info.points.map((p: Json) => p.color);
  return [];
}
function bgColors(bg: Json | null | undefined, dark: boolean): string[] {
  if (!bg || bg.type !== "color") return [];
  return colorsOf(bg.value, dark);
}

/** Texts below 4.5:1 (and icons below 3:1) against what is behind them, in light and in dark mode. */
export function contrastProblems(doc: PaywallDoc): string[] {
  const strings = doc.components_localizations[doc.default_locale] ?? {};
  const out: string[] = [];
  for (const dark of [false, true]) {
    const root = bgColors(doc.components_config.base.background, dark).map((c) => c.slice(0, 7));
    const walk = (node: unknown, behind: string[][]) => {
      if (Array.isArray(node)) { node.forEach((n) => walk(n, behind)); return; }
      if (!node || typeof node !== "object") return;
      const c = node as Json;
      if (typeof c.type !== "string") { for (const v of Object.values(c)) if (v && typeof v === "object") walk(v, behind); return; }
      let here = behind;
      // A stack's own background, and the backgrounds its overrides switch to (selected plan …): text must read on all.
      const own = [bgColors(c.background, dark), ...(Array.isArray(c.overrides) ? c.overrides.map((o: Json) => bgColors(o.properties?.background, dark)) : [])].filter((x) => x.length);
      const opaque = own.filter((x) => x.every((h) => !/^#[0-9a-f]{6}([0-9a-e][0-9a-f]|f[0-9a-e])$/i.test(h)));
      if (opaque.length) here = opaque.map((x) => x.map((h) => h.slice(0, 7)));
      if (c.type === "text") {
        const fgs = [colorsOf(c.color, dark), ...(Array.isArray(c.overrides) ? c.overrides.map((o: Json) => colorsOf(o.properties?.color, dark)) : [])].flat().map((h) => h.slice(0, 7));
        const value = strings[c.text_lid] ?? "";
        const grounds = [...here.flat(), ...(c.background_color ? colorsOf(c.background_color, dark) : [])];
        for (const fg of fgs) {
          const r = worstContrast(fg, grounds.length ? grounds : root);
          if (value.trim() && r < 4.5 - 1e-6) out.push(`The text "${value.slice(0, 50)}" has ${r.toFixed(1)}:1 contrast in ${dark ? "dark" : "light"} mode; it needs 4.5:1.`);
        }
      }
      if (c.type === "icon") {
        const ib = c.icon_background ? colorsOf(c.icon_background.color, dark) : [];
        const ground = ib.length ? ib.map((h) => h.slice(0, 7)) : here.flat();
        for (const fg of colorsOf(c.color, dark)) {
          const r = worstContrast(fg.slice(0, 7), ground.length ? ground : root);
          if (r < 3 - 1e-6) out.push(`The ${c.icon_name} icon has ${r.toFixed(1)}:1 contrast in ${dark ? "dark" : "light"} mode; icons need 3:1.`);
        }
      }
      for (const [k, v] of Object.entries(c)) if (k !== "overrides" && v && typeof v === "object") walk(v, here);
    };
    walk(doc.components_config.base.stack, [root]);
    if (doc.components_config.base.sticky_footer) walk(doc.components_config.base.sticky_footer, [root]);
  }
  return [...new Set(out)];
}

/** Every component id, for tests and the evaluation. */
export function componentCount(doc: PaywallDoc): number { let n = 0; forEachComponent(doc.components_config, () => { n++; }); return n; }
