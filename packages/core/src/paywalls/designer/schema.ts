/**
 * The AI paywall designer's two structured answers (prd/paywalls/PRD.md §3), as TypeScript types and as strict JSON
 * schemas (OpenAI structured outputs, Workers AI `response_format`, Anthropic tool input):
 *
 * 1. `PaywallBrief`: what the developer asked for, read out of their description (plan order, highlighted plan, trial,
 *    discount, benefits, look, languages). The checker holds the design to it.
 * 2. `PaywallDesign`: the paywall itself as typed sections (hero, benefits, trial timeline, plans, footer …) and a theme.
 *    `compileDesign` (compile.ts) turns it into the components JSON the SDK renders, so every design compiles to a valid
 *    paywall; the model chooses content, order and look, the compiler owns layout, price variables and contrast.
 *
 * Every object lists all its properties as required and allows no others (strict mode); "none" is an empty string or 0.
 */
import { PAYWALL_ICON_NAMES } from "../icons.js";

export type Hex = string;
export type SectionName = "hero" | "benefits" | "trial_timeline" | "social_proof" | "countdown" | "comparison" | "pages" | "note" | "plans";
export const SECTION_NAMES: SectionName[] = ["hero", "benefits", "trial_timeline", "social_proof", "countdown", "comparison", "pages", "note", "plans"];

export interface PaywallBrief {
  /** The app's name from the description or the form; "" when unknown. */
  app_name: string;
  /** Language of the copy as a locale id (en_US, es_ES, de_DE …): the description's language unless it asks for another. */
  locale: string;
  /** More languages asked for ("also in German and Spanish"), as locale ids. */
  extra_locales: string[];
  /** Two to six words: the audience and tone. */
  tone: string;
  plans: {
    /** Package ids to show, top to bottom (left to right). */
    order: string[];
    /** The package selected by default (the one the brief highlights). */
    selected: string;
    /** Packages the brief says have the free trial. */
    trial_packages: string[];
    /** Free trial length in days from the brief; 0 when none is mentioned. */
    trial_days: number;
    /** Plans the brief asks for that the offering does not have (e.g. "lifetime"). */
    missing: string[];
  };
  discount: { percent: number; package_id: string; limited_time: boolean };
  benefits: { count: number; named: string[] };
  look: { appearance: "light" | "dark" | "unspecified"; gradient: boolean; colors: Hex[]; description: string };
  /** Sections the description explicitly asks for. */
  sections: Array<"trial_timeline" | "social_proof" | "countdown" | "comparison" | "pages">;
  /** Numbers the developer gave that the copy may use (ratings, user counts, awards). Never invented. */
  facts: string[];
}

export interface DesignTheme {
  appearance: "light" | "dark";
  background: { style: "solid" | "linear_gradient" | "radial_gradient"; colors: Hex[]; angle: number };
  accent: Hex;
  on_accent: Hex;
  text: Hex;
  secondary_text: Hex;
  card: Hex;
  card_border: Hex;
  corners: "square" | "soft" | "round";
  /** "same": the paywall looks the same in dark mode; "adapt": a dark version is derived for dark mode. */
  dark_mode: "same" | "adapt";
}
export interface DesignHero {
  art: "icon_glow" | "icon_tile" | "icon_plain" | "none";
  icon: string;
  decoration: "stars" | "sparkles" | "none";
  eyebrow: string;
  title: string;
  subtitle: string;
  align: "center" | "leading";
}
export interface DesignBenefits { style: "list" | "cards" | "grid"; title: string; items: { icon: string; title: string; description: string }[] }
export interface DesignTimeline { title: string; items: { moment: "today" | "reminder" | "trial_end" | "custom"; icon: string; title: string; description: string }[] }
export interface DesignSocialProof { rating: number; rating_label: string; quote: string; author: string }
export interface DesignCountdown { label: string; hours: number; ended_text: string }
export interface DesignComparison { free_label: string; pro_label: string; rows: { feature: string; free: boolean; pro: boolean }[] }
export interface DesignPages { pages: { icon: string; title: string; body: string }[] }
export interface DesignPlanItem { package_id: string; title: string; subtitle: string; trial_subtitle: string; badge: string; trial: boolean }
export interface DesignPlans { layout: "list" | "cards"; title: string; items: DesignPlanItem[]; selected: string }
export interface DesignFooter { cta: string; cta_trial: string; reassurance: string; disclosure: string; disclosure_trial: string; restore: string }

export interface PaywallDesign {
  name: string;
  locale: string;
  theme: DesignTheme;
  close_button: "leading" | "trailing" | "none";
  order: SectionName[];
  hero: DesignHero | null;
  benefits: DesignBenefits | null;
  trial_timeline: DesignTimeline | null;
  social_proof: DesignSocialProof | null;
  countdown: DesignCountdown | null;
  comparison: DesignComparison | null;
  pages: DesignPages | null;
  note: { text: string } | null;
  plans: DesignPlans;
  footer: DesignFooter;
  /** One to three short notes for the developer (what to check, what the offering lacks). */
  notes: string[];
}

export interface TranslationSet { locales: { locale: string; strings: { key: string; text: string }[] }[] }

// ---- JSON schema --------------------------------------------------------------------------------------------------

type S = Record<string, unknown>;
const str = (description?: string): S => ({ type: "string", ...(description ? { description } : {}) });
const num = (description?: string): S => ({ type: "number", ...(description ? { description } : {}) });
const int = (description?: string): S => ({ type: "integer", ...(description ? { description } : {}) });
const bool = (description?: string): S => ({ type: "boolean", ...(description ? { description } : {}) });
const en = (values: readonly string[], description?: string): S => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const arr = (items: S, description?: string): S => ({ type: "array", items, ...(description ? { description } : {}) });
const hex = (description?: string): S => ({ type: "string", pattern: "^#[0-9a-fA-F]{6}$", ...(description ? { description } : {}) });
/** A strict object: every property required, nothing else allowed. */
export function obj(properties: Record<string, S>, description?: string): S {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}) };
}
const nullable = (o: S): S => ({ anyOf: [o, { type: "null" }] });

export interface SchemaOptions {
  /** Package ids the paywall may use (the offering's, or the standard ones when there is no offering). */
  packages: string[];
  /** Icon names (default: the built-in set). */
  icons?: string[];
}

/** Standard package ids, for a paywall made before the offering exists. */
export const STANDARD_PACKAGES = ["$rc_weekly", "$rc_monthly", "$rc_two_month", "$rc_three_month", "$rc_six_month", "$rc_annual", "$rc_lifetime"];

export function briefSchema(o: SchemaOptions): S {
  const pkg = (d?: string) => en(o.packages, d);
  return obj({
    app_name: str("The app's name, or \"\" when not given."),
    locale: str("Locale id of the language the paywall should be written in, e.g. en_US, es_ES, de_DE, fr_FR, pt_BR, ja_JP."),
    extra_locales: arr(str(), "Additional languages explicitly asked for, as locale ids; [] when none."),
    tone: str("Two to six words: audience and tone."),
    plans: obj({
      order: arr(pkg(), "The packages to show, in display order. Follow the description; when it is silent, the longest subscription first."),
      selected: en(["", ...o.packages], "The package highlighted and selected by default."),
      trial_packages: arr(pkg(), "Packages that have the free trial according to the description; [] when no trial is mentioned."),
      trial_days: int("Free trial length in days from the description; 0 when not mentioned."),
      missing: arr(str(), "Plans the description asks for that are not among the available packages."),
    }),
    discount: obj({ percent: int("Discount percentage the description states; 0 when none."), package_id: en(["", ...o.packages]), limited_time: bool() }),
    benefits: obj({ count: int("How many benefits the description asks for; 0 when it does not say."), named: arr(str(), "Benefits the description names, in its words.") }),
    look: obj({
      appearance: en(["light", "dark", "unspecified"]),
      gradient: bool("True when the description asks for a gradient or a look that needs one (sky, sunset, aurora …)."),
      colors: arr(hex(), "Colours the description names or implies, as #rrggbb."),
      description: str("The requested look in a few words."),
    }),
    sections: arr(en(["trial_timeline", "social_proof", "countdown", "comparison", "pages"]), "Sections the description explicitly asks for."),
    facts: arr(str(), "Ratings, user counts or awards the description states; [] when none."),
  });
}

export function designSchema(o: SchemaOptions): S {
  const icon = en(o.icons ?? PAYWALL_ICON_NAMES);
  const pkg = en(o.packages);
  const theme = obj({
    appearance: en(["light", "dark"]),
    background: obj({
      style: en(["solid", "linear_gradient", "radial_gradient"]),
      colors: arr(hex(), "One colour for solid, two or three for a gradient (top to bottom)."),
      angle: int("Gradient angle in degrees: 180 is top to bottom."),
    }),
    accent: hex("Button and highlight colour."),
    on_accent: hex("Text colour on the accent (button label)."),
    text: hex("Main text colour."),
    secondary_text: hex("Secondary text colour."),
    card: hex("Background of plan cards and benefit cards."),
    card_border: hex("Border of unselected plan cards."),
    corners: en(["square", "soft", "round"]),
    dark_mode: en(["same", "adapt"], "same: keep this look in dark mode (dark designs, strong brand looks); adapt: derive a dark version."),
  });
  return obj({
    name: str("A short internal name for the paywall."),
    locale: str("Locale id of the copy, e.g. en_US."),
    theme,
    close_button: en(["leading", "trailing", "none"]),
    order: arr(en(SECTION_NAMES), "Sections top to bottom; must include plans; every non-null section appears once."),
    hero: nullable(obj({
      art: en(["icon_glow", "icon_tile", "icon_plain", "none"]),
      icon,
      decoration: en(["stars", "sparkles", "none"]),
      eyebrow: str("A short label above the title, or \"\"."),
      title: str(),
      subtitle: str("One sentence, or \"\"."),
      align: en(["center", "leading"]),
    })),
    benefits: nullable(obj({
      style: en(["list", "cards", "grid"]),
      title: str("A heading above the benefits, or \"\"."),
      items: arr(obj({ icon, title: str(), description: str("A few words, or \"\".") })),
    })),
    trial_timeline: nullable(obj({
      title: str("e.g. \"How your free trial works\", or \"\"."),
      items: arr(obj({ moment: en(["today", "reminder", "trial_end", "custom"]), icon, title: str(), description: str() })),
    })),
    social_proof: nullable(obj({ rating: num("Star rating the developer gave, or 0."), rating_label: str(), quote: str(), author: str() })),
    countdown: nullable(obj({ label: str(), hours: int("How long the offer runs from now, in hours."), ended_text: str() })),
    comparison: nullable(obj({ free_label: str(), pro_label: str(), rows: arr(obj({ feature: str(), free: bool(), pro: bool() })) })),
    pages: nullable(obj({ pages: arr(obj({ icon, title: str(), body: str() })) })),
    note: nullable(obj({ text: str() })),
    plans: obj({
      layout: en(["list", "cards"], "list: full-width rows; cards: side by side (2 or 3 plans with short titles)."),
      title: str("A heading above the plans, or \"\"."),
      items: arr(obj({
        package_id: pkg,
        title: str("Plan name, e.g. Yearly."),
        subtitle: str("One short line with price variables, e.g. {{ product.price_per_month }}/month, billed yearly."),
        trial_subtitle: str("The line when this plan has a free trial, e.g. {{ product.offer_period_with_unit }} free, then {{ product.price_per_period }}; or \"\"."),
        badge: str("A short badge, e.g. SAVE {{ product.relative_discount }} or BEST VALUE; or \"\"."),
        trial: bool("True when this plan has the free trial."),
      })),
      selected: pkg,
    }),
    footer: obj({
      cta: str("Button label without a trial, e.g. Continue."),
      cta_trial: str("Button label when the selected plan has a free trial, e.g. Start my free week."),
      reassurance: str("e.g. No commitment, cancel anytime. Or \"\"."),
      disclosure: str("Renewal line with price variables, e.g. {{ product.price_per_period }}, renews automatically. Cancel anytime."),
      disclosure_trial: str("The renewal line when the selected plan has a free trial."),
      restore: str("Label of the restore purchases button."),
    }),
    notes: arr(str(), "Zero to three short notes for the developer."),
  });
}

export function translationSchema(): S {
  return obj({ locales: arr(obj({ locale: str(), strings: arr(obj({ key: str(), text: str() })) })) });
}
