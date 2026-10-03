/**
 * The AI paywall designer as one pipeline (prd/paywalls/PRD.md §3), used by `POST /paywalls/generate` (the dashboard's
 * "Generate with AI") and scripts/paywall-ai/try.ts. Steps, each reported to `onStep`:
 *   brief      the model reads the description into a `PaywallBrief` (strict JSON schema)
 *   packages   the brief is matched to the offering's packages (no model call)
 *   draft      the model designs the paywall as a `PaywallDesign` (strict JSON schema)
 *   check      deterministic fixes, compile to components, `validatePaywall` and the checker
 *   fix        up to `maxFixRounds` repair rounds with the checker's issues (skipped when the draft is clean)
 *   translate  extra languages, when asked (skipped otherwise; a failed translation keeps the paywall untranslated)
 * The result always passes `validatePaywall`; if it would not, the run fails instead of returning it.
 */
import type { PaywallDoc } from "../build.js";
import { validatePaywall } from "../validate.js";
import { checkDesign, varsIn, type DesignIssue } from "./check.js";
import { compileDesign, type Compiled } from "./compile.js";
import { normalizeDesign } from "./normalize.js";
import { briefMessages, designSystemPrompt, designUserMessage, fixUserMessage, lifetimeIds, translateMessages, type DesignerInput } from "./prompt.js";
import { STANDARD_PACKAGES, briefSchema, designSchema, translationSchema, type PaywallBrief, type PaywallDesign, type TranslationSet } from "./schema.js";
import { planLabel } from "../gallery.js";

/** A model that answers in a JSON schema (services/paywall-ai.ts on the server; a fake in tests). */
export interface JsonModel {
  json(req: { name: string; system: string; user: string; schema: Record<string, unknown>; maxTokens?: number; signal?: AbortSignal }): Promise<{ value: unknown; usage?: { input: number; output: number } }>;
}

export type StepId = "brief" | "packages" | "draft" | "check" | "fix" | "translate";
export const STEP_LABELS: Record<StepId, string> = {
  brief: "Understanding the brief", packages: "Picking packages", draft: "Drafting the paywall", check: "Checking prices, contrast and the brief", fix: "Fixing what the check found", translate: "Translating",
};
export interface StepEvent { id: StepId; status: "running" | "done" | "skipped" | "error"; detail?: string }

export interface DesignerResult {
  name: string;
  doc: PaywallDoc;
  design: PaywallDesign;
  brief: PaywallBrief;
  /** What was changed automatically or in repair rounds, for the developer. */
  fixes: string[];
  /** Checker warnings left in the final paywall. */
  warnings: DesignIssue[];
  /** The model's notes for the developer plus the pipeline's own (missing plans, sample prices …). */
  notes: string[];
  previewTrials: Record<string, string>;
  /** Repair rounds that ran (0: the first draft passed the check). */
  rounds: number;
  /** Errors the checker found in the first draft (after the deterministic fixes). */
  firstDraftErrors: DesignIssue[];
  calls: number;
  usage: { input: number; output: number };
}

export interface RunOptions {
  iconBaseUrl: string;
  now?: number;
  onStep?: (e: StepEvent) => void | Promise<void>;
  signal?: AbortSignal;
  maxFixRounds?: number;
}

export class DesignerError extends Error {
  constructor(message: string, readonly step: StepId, readonly retryable = true) { super(message); }
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const s = (x: unknown, d = "") => (typeof x === "string" ? x : d);
const n = (x: unknown, d = 0) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const a = <T>(x: unknown, f: (y: any) => T | null): T[] => (Array.isArray(x) ? x.map(f).filter((y): y is T => y !== null) : []);
const oneOf = <T extends string>(x: unknown, all: readonly T[], d: T): T => (all.includes(x as T) ? (x as T) : d);
const LOCALE = /^[a-z]{2,3}(_[A-Za-z]{2,4})?(_[A-Z]{2})?$/;

/** The longest subscription first, then shorter ones, then lifetime. */
function defaultOrder(packages: string[], lifetime: Set<string>): string[] {
  const rank = (id: string) => (lifetime.has(id) ? 100 : /annual|year/i.test(id) ? 0 : /six/i.test(id) ? 1 : /three/i.test(id) ? 2 : /two/i.test(id) ? 3 : /month/i.test(id) ? 4 : /week/i.test(id) ? 5 : 50);
  return [...packages].sort((x, y) => rank(x) - rank(y));
}

export function coerceBrief(raw: unknown, i: DesignerInput, packages: string[]): PaywallBrief {
  const r = isObj(raw) ? raw : {};
  const pk = (x: unknown) => (typeof x === "string" && packages.includes(x) ? x : null);
  const plans = isObj(r.plans) ? r.plans : {};
  const lifetime = lifetimeIds(i.offering);
  let order = [...new Set(a(plans.order, pk))];
  if (!order.length) {
    // Subscriptions first; lifetime only when there is nothing else.
    const subs = defaultOrder(packages, lifetime).filter((p) => !lifetime.has(p));
    order = (subs.length ? subs : defaultOrder(packages, lifetime)).slice(0, i.offering.offering ? 3 : 2);
  }
  const selected = pk(plans.selected) && order.includes(plans.selected) ? plans.selected as string : order[0]!;
  const look = isObj(r.look) ? r.look : {};
  const locale = i.locale || (typeof r.locale === "string" && LOCALE.test(r.locale) ? r.locale : "en_US");
  const extra = [...new Set([...a(r.extra_locales, (x) => (typeof x === "string" && LOCALE.test(x) ? x : null)), ...(i.locales ?? [])])].filter((l) => l !== locale).slice(0, 6);
  const disc = isObj(r.discount) ? r.discount : {};
  const ben = isObj(r.benefits) ? r.benefits : {};
  return {
    app_name: i.appName?.trim() || s(r.app_name).trim().slice(0, 80),
    locale, extra_locales: extra, tone: s(r.tone).slice(0, 80),
    plans: {
      order, selected,
      trial_packages: [...new Set(a(plans.trial_packages, pk))].filter((p) => order.includes(p) && !lifetime.has(p)),
      trial_days: Math.max(0, Math.min(365, Math.round(n(plans.trial_days)))),
      missing: a(plans.missing, (x) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 60) : null)).slice(0, 5),
    },
    discount: { percent: Math.max(0, Math.min(95, Math.round(n(disc.percent)))), package_id: pk(disc.package_id) ?? "", limited_time: disc.limited_time === true },
    benefits: { count: Math.max(0, Math.min(8, Math.round(n(ben.count)))), named: a(ben.named, (x) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 80) : null)).slice(0, 8) },
    look: {
      appearance: oneOf(look.appearance, ["light", "dark", "unspecified"] as const, "unspecified"), gradient: look.gradient === true,
      colors: a(look.colors, (x) => (typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x) ? x : null)).slice(0, 4), description: s(look.description).slice(0, 120),
    },
    sections: [...new Set(a(r.sections, (x) => (["trial_timeline", "social_proof", "countdown", "comparison", "pages"].includes(x) ? x : null)))] as PaywallBrief["sections"],
    facts: a(r.facts, (x) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 120) : null)).slice(0, 5),
  };
}

/** A design with every field present and of the right type (strict providers already answer this way). */
export function coerceDesign(raw: unknown, brief: PaywallBrief, packages: string[]): PaywallDesign {
  const r = isObj(raw) ? raw : {};
  const t = isObj(r.theme) ? r.theme : {};
  const bg = isObj(t.background) ? t.background : {};
  const str = (x: unknown) => s(x).trim();
  const icon = (x: unknown) => s(x, "check");
  const sec = <T>(x: unknown, f: (y: Record<string, any>) => T): T | null => (isObj(x) ? f(x) : null);
  const plans = isObj(r.plans) ? r.plans : {};
  const footer = isObj(r.footer) ? r.footer : {};
  return {
    name: str(r.name) || "AI paywall", locale: str(r.locale) || brief.locale,
    theme: {
      appearance: oneOf(t.appearance, ["light", "dark"] as const, "light"),
      background: { style: oneOf(bg.style, ["solid", "linear_gradient", "radial_gradient"] as const, "solid"), colors: a(bg.colors, (x) => (typeof x === "string" ? x : null)).slice(0, 3), angle: n(bg.angle, 180) },
      accent: s(t.accent, "#111111"), on_accent: s(t.on_accent, "#ffffff"), text: s(t.text, "#111111"), secondary_text: s(t.secondary_text, "#555555"),
      card: s(t.card, "#f4f4f5"), card_border: s(t.card_border, "#e4e4e7"), corners: oneOf(t.corners, ["square", "soft", "round"] as const, "soft"),
      dark_mode: oneOf(t.dark_mode, ["same", "adapt"] as const, "adapt"),
    },
    close_button: oneOf(r.close_button, ["leading", "trailing", "none"] as const, "leading"),
    order: a(r.order, (x) => (typeof x === "string" ? x : null)) as PaywallDesign["order"],
    hero: sec(r.hero, (h) => ({ art: oneOf(h.art, ["icon_glow", "icon_tile", "icon_plain", "none"] as const, "none"), icon: icon(h.icon), decoration: oneOf(h.decoration, ["stars", "sparkles", "none"] as const, "none"), eyebrow: str(h.eyebrow), title: str(h.title), subtitle: str(h.subtitle), align: oneOf(h.align, ["center", "leading"] as const, "center") })),
    benefits: sec(r.benefits, (b) => ({ style: oneOf(b.style, ["list", "cards", "grid"] as const, "list"), title: str(b.title), items: a(b.items, (x) => (isObj(x) ? { icon: icon(x.icon), title: str(x.title), description: str(x.description) } : null)).filter((x) => x.title).slice(0, 8) })),
    trial_timeline: sec(r.trial_timeline, (x) => ({ title: str(x.title), items: a(x.items, (y) => (isObj(y) ? { moment: oneOf(y.moment, ["today", "reminder", "trial_end", "custom"] as const, "custom"), icon: icon(y.icon), title: str(y.title), description: str(y.description) } : null)).slice(0, 5) })),
    social_proof: sec(r.social_proof, (x) => ({ rating: Math.max(0, Math.min(5, n(x.rating))), rating_label: str(x.rating_label), quote: str(x.quote), author: str(x.author) })),
    countdown: sec(r.countdown, (x) => ({ label: str(x.label), hours: Math.max(1, Math.round(n(x.hours, 48))), ended_text: str(x.ended_text) })),
    comparison: sec(r.comparison, (x) => ({ free_label: str(x.free_label) || "Free", pro_label: str(x.pro_label) || "Pro", rows: a(x.rows, (y) => (isObj(y) ? { feature: str(y.feature), free: y.free === true, pro: y.pro !== false } : null)).slice(0, 8) })),
    pages: sec(r.pages, (x) => ({ pages: a(x.pages, (y) => (isObj(y) ? { icon: icon(y.icon), title: str(y.title), body: str(y.body) } : null)).slice(0, 4) })),
    note: sec(r.note, (x) => (str(x.text) ? { text: str(x.text) } : { text: "" })),
    plans: {
      layout: oneOf(plans.layout, ["list", "cards"] as const, "list"), title: str(plans.title),
      items: a(plans.items, (x) => (isObj(x) && packages.includes(x.package_id) ? { package_id: x.package_id as string, title: str(x.title) || planLabel(x.package_id), subtitle: str(x.subtitle), trial_subtitle: str(x.trial_subtitle), badge: str(x.badge), trial: x.trial === true } : null)),
      selected: s(plans.selected),
    },
    footer: {
      cta: str(footer.cta) || "Continue", cta_trial: str(footer.cta_trial), reassurance: str(footer.reassurance),
      disclosure: str(footer.disclosure), disclosure_trial: str(footer.disclosure_trial), restore: str(footer.restore) || "Restore purchases",
    },
    notes: a(r.notes, (x) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 200) : null)).slice(0, 3),
  };
}

interface Attempt { design: PaywallDesign; compiled: Compiled; issues: DesignIssue[]; fixes: string[] }

export async function runDesigner(input: DesignerInput, model: JsonModel, o: RunOptions): Promise<DesignerResult> {
  const maxRounds = o.maxFixRounds ?? 2;
  const usage = { input: 0, output: 0 };
  let calls = 0;
  const step = async (e: StepEvent) => { await o.onStep?.(e); };
  const ask = async (name: string, system: string, user: string, schema: Record<string, unknown>, maxTokens: number, at: StepId) => {
    if (o.signal?.aborted) throw new DesignerError("Cancelled.", at, false);
    calls++;
    try {
      const r = await model.json({ name, system, user, schema, maxTokens, signal: o.signal });
      if (r.usage) { usage.input += r.usage.input; usage.output += r.usage.output; }
      return r.value;
    } catch (e) {
      if (o.signal?.aborted) throw new DesignerError("Cancelled.", at, false);
      throw new DesignerError(e instanceof Error ? e.message : String(e), at);
    }
  };
  const packages = input.offering.packages.length ? input.offering.packages.map((p) => p.id) : STANDARD_PACKAGES;
  const offering = input.offering.packages.length ? input.offering : { offering: null, packages: STANDARD_PACKAGES.map((id) => ({ id, label: planLabel(id), product: null })) };
  const inp: DesignerInput = { ...input, offering };

  // 1. The brief.
  await step({ id: "brief", status: "running" });
  let brief: PaywallBrief;
  if (input.refine) {
    brief = coerceBrief({}, inp, packages);
  } else {
    const bm = briefMessages(inp);
    brief = coerceBrief(await ask("paywall_brief", bm.system, bm.user, briefSchema({ packages }), 1500, "brief"), inp, packages);
  }
  await step({ id: "brief", status: "done", detail: [brief.app_name, brief.tone, brief.look.description].filter(Boolean).join(" · ").slice(0, 140) || undefined });

  // 2. Packages.
  await step({ id: "packages", status: "running" });
  const label = (id: string) => offering.packages.find((p) => p.id === id)?.label ?? planLabel(id);
  const pkgDetail = brief.plans.order.map((p) => `${label(p)}${p === brief.plans.selected ? " (selected" : ""}${brief.plans.trial_packages.includes(p) ? `${p === brief.plans.selected ? ", " : " ("}${brief.plans.trial_days ? `${brief.plans.trial_days}-day ` : ""}free trial)` : p === brief.plans.selected ? ")" : ""}`).join(" · ");
  const notes: string[] = [];
  if (!input.offering.packages.length) {
    notes.push(input.offering.offering
      ? `The offering "${input.offering.offering.display_name}" has no packages yet, so the paywall uses standard packages with sample prices. Add packages to the offering to bind real products.`
      : "This project has no offering with packages yet, so the preview uses sample prices. Create an offering and pick it here to see real prices.");
  }
  if (brief.plans.missing.length) notes.push(`The brief asks for ${brief.plans.missing.join(", ")}, but the offering has no such package. Add it in the product catalog, then try again.`);
  await step({ id: "packages", status: "done", detail: pkgDetail });

  // 3. The draft.
  const system = designSystemPrompt();
  const base = designUserMessage(inp, brief);
  const lifetime = lifetimeIds(offering);
  const evaluate = (raw: unknown): Attempt => {
    const coerced = coerceDesign(raw, brief, packages);
    const norm = normalizeDesign(coerced, { brief, packages, brandColors: input.brandColors, locale: input.locale, lifetime });
    const compiled = compileDesign(norm.design, { iconBaseUrl: o.iconBaseUrl, now: o.now, trialDays: brief.plans.trial_days || 7, lifetime });
    const issues = checkDesign({ design: norm.design, doc: compiled.doc, brief, offering, appName: input.appName, brandColors: input.brandColors });
    return { design: norm.design, compiled, issues, fixes: [...norm.fixes, ...compiled.fixes] };
  };
  await step({ id: "draft", status: "running" });
  let best = evaluate(await ask("paywall_design", system, base, designSchema({ packages }), 6000, "draft"));
  await step({ id: "draft", status: "done", detail: best.design.hero?.title || best.design.name });

  // 4. Check.
  await step({ id: "check", status: "running" });
  const errors = (x: Attempt) => x.issues.filter((i) => i.severity === "error");
  const firstDraftErrors = errors(best);
  const allFixes = new Set(best.fixes);
  await step({ id: "check", status: "done", detail: firstDraftErrors.length ? `${firstDraftErrors.length} problem${firstDraftErrors.length === 1 ? "" : "s"} to fix` : best.issues.length ? `Passed, ${best.issues.length} suggestion${best.issues.length === 1 ? "" : "s"}` : "Passed" });

  // 5. Repair rounds: errors always; warnings once when there is nothing worse.
  let rounds = 0;
  if (errors(best).length || best.issues.length) {
    await step({ id: "fix", status: "running", detail: best.issues.slice(0, 3).map((i) => i.message).join(" ").slice(0, 200) });
    while (rounds < maxRounds && (errors(best).length || (rounds === 0 && best.issues.length))) {
      rounds++;
      const next = evaluate(await ask("paywall_design", system, fixUserMessage(base, best.design, best.issues), designSchema({ packages }), 6000, "fix"));
      const score = (x: Attempt) => errors(x).length * 10 + x.issues.length;
      // Only an accepted round counts: what a rejected attempt changed is not in the result.
      if (score(next) <= score(best)) {
        for (const i of best.issues) if (!next.issues.some((j) => j.message === i.message)) allFixes.add(fixedLabel(i));
        for (const f of next.fixes) allFixes.add(f);
        best = next;
      }
    }
    const left = errors(best).length;
    await step({ id: "fix", status: "done", detail: left ? `${left} problem${left === 1 ? "" : "s"} left after ${rounds} round${rounds === 1 ? "" : "s"}` : `Fixed in ${rounds} round${rounds === 1 ? "" : "s"}` });
  } else {
    await step({ id: "fix", status: "skipped", detail: "Nothing to fix" });
  }

  // 6. Translations.
  const doc = best.compiled.doc;
  if (brief.extra_locales.length) {
    await step({ id: "translate", status: "running", detail: brief.extra_locales.join(", ") });
    const source = Object.fromEntries(Object.entries(doc.components_localizations[doc.default_locale] ?? {}).filter(([, v]) => typeof v === "string" && translatable(v))) as Record<string, string>;
    const tm = translateMessages(source, doc.default_locale, brief.extra_locales);
    try {
      const raw = await ask("paywall_translations", tm.system, tm.user, translationSchema(), 8000, "translate");
      const done = mergeTranslations(doc, raw as TranslationSet, brief.extra_locales);
      await step({ id: "translate", status: "done", detail: done.map((d) => `${d.locale} (${d.translated}/${d.total})`).join(", ") });
    } catch (e) {
      // The paywall is finished; a failed translation leaves it in its own language instead of failing the run.
      if (e instanceof DesignerError && !e.retryable) throw e;
      notes.push(`Translating into ${brief.extra_locales.join(", ")} failed, so the paywall is only in ${doc.default_locale}. Add the languages in the Localizations tab.`);
      await step({ id: "translate", status: "error", detail: e instanceof Error ? e.message.slice(0, 200) : undefined });
    }
  } else {
    await step({ id: "translate", status: "skipped" });
  }

  const v = validatePaywall(doc, { packages });
  if (!v.valid) throw new DesignerError(`The generated paywall is not valid (${v.errors[0]!.path}: ${v.errors[0]!.message}). Try again.`, "check");
  const remainingErrors = errors(best);
  return {
    name: best.compiled.name, doc, design: best.design, brief,
    fixes: [...allFixes].filter(Boolean),
    warnings: [...remainingErrors, ...best.issues.filter((i) => i.severity === "warning")],
    notes: [...notes, ...best.design.notes].slice(0, 5),
    previewTrials: best.compiled.previewTrials, rounds, firstDraftErrors, calls, usage,
  };
}

/** A past-tense line for an issue a repair round fixed. */
function fixedLabel(i: DesignIssue): string {
  const m: Record<string, string> = {
    plans_order: "Put the plans in the brief's order.", plans_selected: "Selected the plan the brief highlights.", plans_trial: "Marked the free trial on the right plans.",
    variable_trial: "Moved trial wording out of texts that show without a trial.", offer_price_charge: "Fixed a price that said the trial price where the regular price is charged.",
    price_literal: "Replaced typed prices with price variables.", disclosure_price: "Added the billed price to the renewal line.", disclosure_trial: "Added the trial length and price to the trial renewal line.",
    timeline_missing: "Added the free trial timeline.", timeline_charge: "Said what is charged when the trial ends.", app_name: "Used the app name in the copy.",
    benefit_count: "Matched the number of benefits to the brief.", benefit_named: "Included the benefits the brief names.", discount: "Showed the brief's discount.",
    look: "Matched the look the brief asks for.", locale: "Wrote the paywall in the brief's language.", icon_meaning: "Chose icons that match their text.",
    copy_long: "Shortened copy that was too long for a phone.", invented_proof: "Removed numbers the brief did not give.", discount_empty: "Moved the savings badge to the plan that saves.",
    section_missing: "Added the sections the brief asks for.", contrast: "Fixed text contrast.", cta_trial: "Added the free trial button label.", lifetime_period: "Fixed the lifetime plan's wording.",
    trial_days: "Matched the trial days to the brief.", variable_unknown: "Replaced variables the SDK does not know.",
  };
  return m[i.code] ?? "Fixed a problem the check found.";
}

/** Text worth translating: letters outside {{ variables }}, and not a URL. */
const translatable = (v: string) => !/^https?:/.test(v) && /\p{L}/u.test(v.replace(/\{\{[^}]*\}\}/g, ""));
/** zh_Hans and zh_Hans_CN match; zh_Hans and zh_Hant do not; es_ES and es_MX do. */
function sameLanguage(a: string, b: string): boolean {
  const parts = (l: string) => l.split(/[_-]/);
  const [la, ...ra] = parts(a), [lb, ...rb] = parts(b);
  if (la!.toLowerCase() !== lb!.toLowerCase()) return false;
  const script = (r: string[]) => r.find((x) => /^[A-Z][a-z]{3}$/.test(x)) ?? "";
  return script(ra) === script(rb);
}

/** Adds the translated strings that kept their variables; others fall back to the default locale on serve. */
export function mergeTranslations(doc: PaywallDoc, raw: TranslationSet | null | undefined, wanted: string[]): { locale: string; translated: number; total: number }[] {
  const source = doc.components_localizations[doc.default_locale] ?? {};
  const keys = Object.keys(source).filter((k) => typeof source[k] === "string" && translatable(source[k]!));
  const out: { locale: string; translated: number; total: number }[] = [];
  const sameVars = (x: string, y: string) => varsIn(x).sort().join("|") === varsIn(y).sort().join("|");
  for (const locale of wanted) {
    // An exact locale, else the same language and script (zh_Hans never fills zh_Hant).
    const entry = raw?.locales?.find((l) => l?.locale === locale) ?? raw?.locales?.find((l) => typeof l?.locale === "string" && sameLanguage(l.locale, locale));
    const table: Record<string, string> = {};
    for (const st of entry?.strings ?? []) {
      if (!st || typeof st.key !== "string" || typeof st.text !== "string" || !keys.includes(st.key) || !st.text.trim()) continue;
      if (!sameVars(source[st.key]!, st.text)) continue;
      table[st.key] = st.text.trim();
    }
    // Strings with no words outside their variables, and URLs, are copied as they are.
    for (const [k, v] of Object.entries(source)) if (!keys.includes(k)) table[k] = v;
    doc.components_localizations[locale] = table;
    out.push({ locale, translated: Object.keys(table).filter((k) => keys.includes(k)).length, total: keys.length });
  }
  return out;
}
