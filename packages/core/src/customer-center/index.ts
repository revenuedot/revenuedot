/**
 * Customer Center configuration (prd/customer-center/PRD.md): the stored, editable document, its validation, and the
 * exact shape the RevenueCat SDKs decode from `GET /v1/customercenter/{app_user_id}` (purchases-ios
 * `CustomerCenterConfigResponse`, purchases-android `CustomerCenterConfigData`). Pure code: the server adds the stored
 * overrides and the Retention offers, the dashboard uses the same functions for its preview.
 *
 * The stored document is the SDK shape plus a few editor-only fields that never reach the SDK:
 * - `title_localizations` / `subtitle_localizations` on screens, paths, surveys, survey options and promotional offers:
 *   `{ "<language>": "text" }`, picked by the customer's language.
 * - `localization.custom_strings`: `{ "<language>": { "<string key>": "text" } }` over the built-in strings.
 */
import { CC_STRINGS } from "./strings.js";
import { CC_BUILTIN } from "./translations.js";

export { CC_STRINGS } from "./strings.js";
export { CC_BUILTIN } from "./translations.js";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

// ---------- Languages ----------

/** The 33 languages the Customer Center localizes into. Codes match the SDK locale prefix (`zh_Hans`, `zh_Hant`). */
export const CC_LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" }, { code: "ar", name: "Arabic" }, { code: "ca", name: "Catalan" }, { code: "zh_Hans", name: "Chinese" },
  { code: "hr", name: "Croatian" }, { code: "cs", name: "Czech" }, { code: "da", name: "Danish" }, { code: "nl", name: "Dutch" },
  { code: "fi", name: "Finnish" }, { code: "fr", name: "French" }, { code: "de", name: "German" }, { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" }, { code: "hi", name: "Hindi" }, { code: "hu", name: "Hungarian" }, { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" }, { code: "ja", name: "Japanese" }, { code: "ko", name: "Korean" }, { code: "ms", name: "Malay" },
  { code: "no", name: "Norwegian" }, { code: "pl", name: "Polish" }, { code: "pt", name: "Portuguese" }, { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" }, { code: "sk", name: "Slovak" }, { code: "es", name: "Spanish" }, { code: "sv", name: "Swedish" },
  { code: "th", name: "Thai" }, { code: "zh_Hant", name: "Traditional Chinese" }, { code: "tr", name: "Turkish" }, { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" },
];
const LANGS = new Set(CC_LANGUAGES.map((l) => l.code));

/** The Customer Center language for one locale id ("de_DE", "pt-BR", "zh_Hant_TW", "nb"), or null when unsupported. */
export function ccLanguageOf(locale: string): string | null {
  const l = locale.trim().replace(/-/g, "_");
  if (!l) return null;
  if (/^zh(_|$)/i.test(l)) return /^zh_(Hant|TW|HK|MO)/i.test(l) ? "zh_Hant" : "zh_Hans";
  const base = l.split("_")[0]!.toLowerCase();
  const alias: Record<string, string> = { nb: "no", nn: "no", iw: "he", in: "id" };
  const code = alias[base] ?? base;
  return LANGS.has(code) ? code : null;
}

/**
 * The language and locale to answer with, from the SDK's `X-Preferred-Locales` header ("de_DE,en_US"): the first
 * preferred locale with a supported language; English and the configured locale when none matches.
 */
export function pickCcLocale(preferred: string | string[] | null | undefined, fallbackLocale = "en_US"): { language: string; locale: string } {
  const list = (Array.isArray(preferred) ? preferred : (preferred ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  for (const p of list) {
    const language = ccLanguageOf(p);
    if (language) return { language, locale: p.replace(/-/g, "_") };
  }
  return { language: ccLanguageOf(fallbackLocale) ?? "en", locale: fallbackLocale };
}

// ---------- Paths ----------

export const CC_PATH_TYPES = ["MISSING_PURCHASE", "REFUND_REQUEST", "CHANGE_PLANS", "CANCEL", "CUSTOM_URL", "CUSTOM_ACTION"] as const;
export type CcPathType = (typeof CC_PATH_TYPES)[number];
/** Types a screen can hold several of; the others appear at most once per screen. */
export const CC_REPEATABLE_PATHS = new Set<CcPathType>(["CUSTOM_URL", "CUSTOM_ACTION"]);

/** Editor wording per path type: the menu label, what the button does, and the button text a new path starts with. */
export const CC_PATH_INFO: Record<CcPathType, { label: string; description: string; title: string }> = {
  MISSING_PURCHASE: { label: "Missing Purchase", description: "Restores purchases from the store account, for customers who paid but do not see their purchase.", title: "Missing purchase" },
  REFUND_REQUEST: { label: "Refund Request", description: "Opens the store's refund request sheet on iOS. Can show a promotional offer first.", title: "Request a refund" },
  CHANGE_PLANS: { label: "Change Plans", description: "Lets the customer switch to another plan of the same subscription group in the store.", title: "Change plans" },
  CANCEL: { label: "Manage", description: "Opens the store's subscription management, where the customer can cancel. Can ask why first with a feedback survey, and show a promotional offer to keep them.", title: "Cancel subscription" },
  CUSTOM_URL: { label: "Custom URL", description: "Opens a web page or deep link, in the app or in the browser.", title: "Visit our website" },
  CUSTOM_ACTION: { label: "Custom Action", description: "Calls your app with an action identifier, so the app can run its own flow (for example open a chat).", title: "Custom action" },
};

export const CC_DEFAULT_SURVEY = { title: "Why are you cancelling?", options: ["Too expensive", "Don't use the app", "Bought by mistake"] };

export const CC_COLOR_KEYS = ["accent_color", "text_color", "background_color", "button_text_color", "button_background_color"] as const;

/**
 * A promotional offer on a path or survey option: a reference to an offer set up under Lifecycle > Retention
 * (`{ retention_offer_id }`, resolved by the server when the SDK loads the configuration), or an offer of its own.
 * `null` on a Manage or Refund Request path means "no offer", so the Retention offers for that trigger are not added.
 */
export interface CcOfferRef { retention_offer_id: string }
export interface CcPromotionalOffer {
  title: string; subtitle?: string;
  /** Store product identifier → store offer identifier (App Store promotional offer id or Google Play offer id). */
  product_mapping: Record<string, string>;
  ios_offer_id?: string; android_offer_id?: string; eligible?: boolean;
  cross_product_promotions?: Record<string, { store_offer_identifier: string; target_product_id: string }>;
  title_localizations?: Record<string, string>; subtitle_localizations?: Record<string, string>;
}
export interface CcSurveyOption { id: string; title: string; promotional_offer?: CcPromotionalOffer | CcOfferRef | null; title_localizations?: Record<string, string> }
export interface CcPath {
  id: string; type: CcPathType | string; title: string;
  url?: string; open_method?: "IN_APP" | "EXTERNAL"; action_identifier?: string;
  feedback_survey?: { title: string; options: CcSurveyOption[]; title_localizations?: Record<string, string> } | null;
  promotional_offer?: CcPromotionalOffer | CcOfferRef | null;
  refund_window?: string;
  title_localizations?: Record<string, string>;
}
export interface CcScreen { type: "MANAGEMENT" | "NO_ACTIVE"; title: string; subtitle?: string; paths: CcPath[]; offering?: Json; title_localizations?: Record<string, string>; subtitle_localizations?: Record<string, string> }
export type CcColors = Partial<Record<(typeof CC_COLOR_KEYS)[number], string>>;
export interface CcConfig {
  appearance: { light: CcColors; dark: CcColors };
  screens: { MANAGEMENT: CcScreen; NO_ACTIVE: CcScreen };
  localization: { locale: string; localized_strings: Record<string, string>; custom_strings?: Record<string, Record<string, string>> };
  support: Json & { email: string };
  change_plans: unknown[];
}

/** A path id that is not in `taken`. */
export function newCcId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const id = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
    if (!used.has(id)) return id;
  }
}

/** A new path of a type, with its default button text (and the default survey for Manage). */
export function newCcPath(type: CcPathType, taken: Iterable<string>): CcPath {
  const ids = [...taken];
  const p: CcPath = { id: newCcId("path", ids), type, title: CC_PATH_INFO[type].title };
  if (type === "CUSTOM_URL") { p.url = ""; p.open_method = "EXTERNAL"; }
  if (type === "CUSTOM_ACTION") p.action_identifier = "";
  if (type === "CANCEL") p.feedback_survey = { title: CC_DEFAULT_SURVEY.title, options: CC_DEFAULT_SURVEY.options.map((title) => ({ id: newCcId("option", ids), title })) };
  return p;
}

// ---------- Default and merge ----------

/** The English strings sent to every SDK (the SDK has its own English text for every other key). */
const BASE_STRINGS: Record<string, string> = {
  no_thanks: "No, thanks", restore_purchases: "Restore purchases", cancel: "Cancel", contact_support: "Contact support",
  manage_subscription: "Manage your subscription", check_past_purchases: "Check past purchases", dismiss: "Dismiss", done: "Done",
  no_subscriptions_found: "No subscriptions found", default_subject: "Support request", default_body: "Please describe your issue or question.",
};

/** The configuration a project starts with. Path ids are stable: the SDK reports them in its Customer Center events. */
export function defaultCustomerCenter(supportEmail: string): CcConfig {
  const path = (id: string, title: string, type: CcPathType): CcPath => ({ id, title, type });
  return {
    appearance: { light: {}, dark: {} },
    screens: {
      MANAGEMENT: {
        type: "MANAGEMENT", title: "Manage subscription", subtitle: "Choose what you want to do.",
        paths: [
          path("path_cancel", "Cancel subscription", "CANCEL"),
          path("path_refund", "Request a refund", "REFUND_REQUEST"),
          path("path_missing", "Missing purchase", "MISSING_PURCHASE"),
        ],
      },
      NO_ACTIVE: {
        type: "NO_ACTIVE", title: "No active subscriptions", subtitle: "We could not find an active subscription for this account.",
        paths: [path("path_missing_none", "Restore purchases", "MISSING_PURCHASE")],
      },
    },
    localization: { locale: "en_US", localized_strings: { ...BASE_STRINGS } },
    support: { email: supportEmail, should_warn_customer_to_update: false, display_purchase_history_link: true, display_user_details_section: true, display_virtual_currencies: false },
    change_plans: [],
  };
}

/** Objects merge key by key; arrays and scalars replace; null removes nothing (it is stored as given). */
export function mergeConfig(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? mergeConfig(base[k] as Json, v) : v;
  return out;
}

// ---------- Validation ----------

const TICKET_CUSTOMERS = ["active", "not_active", "all", "none"];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PATH_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTION_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const STRING_KEY = /^[A-Za-z0-9_.-]{1,100}$/;
const isUrl = (v: unknown) => { if (!isStr(v) || !v.trim() || /\s/.test(v)) return false; try { return /^[a-z][a-z0-9+.-]*:$/i.test(new URL(v).protocol); } catch { return false; } };

class Problems {
  list: string[] = [];
  add(path: string, msg: string) { this.list.push(`${path}: ${msg}`); }
  text(path: string, v: unknown, { min = 1, max, required = true }: { min?: number; max: number; required?: boolean }) {
    if (v === undefined || v === null) { if (required) this.add(path, "is required."); return; }
    if (!isStr(v)) { this.add(path, "must be text."); return; }
    if (v.trim().length < min) this.add(path, min === 1 ? "cannot be empty." : `needs at least ${min} characters.`);
    else if ([...v].length > max) this.add(path, `can be at most ${max} characters.`);
  }
  localizations(path: string, v: unknown, max: number) {
    if (v === undefined || v === null) return;
    if (!isObj(v)) { this.add(path, "must be an object of language → text."); return; }
    for (const [lang, t] of Object.entries(v)) {
      if (!LANGS.has(lang)) this.add(`${path}.${lang}`, `is not a supported language (${[...LANGS].join(", ")}).`);
      else this.text(`${path}.${lang}`, t, { max, min: 0 });
    }
  }
}

function checkOffer(p: Problems, at: string, o: unknown) {
  if (o === undefined || o === null) return;
  if (!isObj(o)) { p.add(at, "must be an object."); return; }
  if (o.retention_offer_id !== undefined) {
    if (!isStr(o.retention_offer_id) || !o.retention_offer_id.trim()) p.add(`${at}.retention_offer_id`, "needs the id of a Retention offer.");
    else if (Object.keys(o).length > 1) p.add(at, "is either a reference to a Retention offer (retention_offer_id) or an offer of its own, not both.");
    return;
  }
  p.text(`${at}.title`, o.title, { max: 100 });
  p.text(`${at}.subtitle`, o.subtitle, { max: 300, min: 0, required: false });
  p.localizations(`${at}.title_localizations`, o.title_localizations, 100);
  p.localizations(`${at}.subtitle_localizations`, o.subtitle_localizations, 300);
  if (!isObj(o.product_mapping) || !Object.keys(o.product_mapping).length) p.add(`${at}.product_mapping`, "needs at least one product with its store offer id.");
  else for (const [prod, offer] of Object.entries(o.product_mapping)) {
    if (!prod.trim() || prod.length > 255) p.add(`${at}.product_mapping`, "has an empty or too long product identifier.");
    if (!isStr(offer) || !offer.trim() || offer.length > 255) p.add(`${at}.product_mapping.${prod}`, "needs the store offer id.");
  }
  for (const k of ["ios_offer_id", "android_offer_id"] as const) if (o[k] !== undefined && !isStr(o[k])) p.add(`${at}.${k}`, "must be text.");
  if (o.eligible !== undefined && typeof o.eligible !== "boolean") p.add(`${at}.eligible`, "must be true or false.");
  if (o.cross_product_promotions !== undefined) {
    if (!isObj(o.cross_product_promotions)) p.add(`${at}.cross_product_promotions`, "must be an object.");
    else for (const [k, x] of Object.entries(o.cross_product_promotions)) {
      if (!isObj(x) || !isStr(x.store_offer_identifier) || !isStr(x.target_product_id)) p.add(`${at}.cross_product_promotions.${k}`, "needs store_offer_identifier and target_product_id.");
    }
  }
}

function checkPath(p: Problems, at: string, x: unknown, seen: { ids: Set<string>; types: Set<string> }) {
  if (!isObj(x)) { p.add(at, "must be an object."); return; }
  if (!isStr(x.id) || !PATH_ID.test(x.id)) p.add(`${at}.id`, "needs 1 to 64 letters, digits, _ or -.");
  else if (seen.ids.has(x.id)) p.add(`${at}.id`, `"${x.id}" is used twice on this screen.`);
  else seen.ids.add(x.id);
  const type = x.type as CcPathType;
  if (!CC_PATH_TYPES.includes(type)) { p.add(`${at}.type`, `must be one of ${CC_PATH_TYPES.join(", ")}.`); return; }
  if (!CC_REPEATABLE_PATHS.has(type)) {
    if (seen.types.has(type)) p.add(`${at}.type`, `${CC_PATH_INFO[type].label} can appear only once per screen.`);
    seen.types.add(type);
  }
  p.text(`${at}.title`, x.title, { max: 100 });
  p.localizations(`${at}.title_localizations`, x.title_localizations, 100);
  if (type === "CUSTOM_URL") {
    if (!isUrl(x.url)) p.add(`${at}.url`, "needs a full URL, such as https://example.com/help or myapp://support.");
    else if ((x.url as string).length > 2000) p.add(`${at}.url`, "can be at most 2000 characters.");
    if (x.open_method !== undefined && x.open_method !== "IN_APP" && x.open_method !== "EXTERNAL") p.add(`${at}.open_method`, "must be IN_APP or EXTERNAL.");
  } else if (x.url !== undefined && x.url !== null) p.add(`${at}.url`, "is only used by Custom URL paths.");
  if (type === "CUSTOM_ACTION") {
    if (!isStr(x.action_identifier) || !ACTION_ID.test(x.action_identifier)) p.add(`${at}.action_identifier`, "needs 1 to 100 letters, digits, _ . : or -, the identifier your app handles.");
  } else if (x.action_identifier !== undefined && x.action_identifier !== null) p.add(`${at}.action_identifier`, "is only used by Custom Action paths.");
  if (x.feedback_survey !== undefined && x.feedback_survey !== null) {
    const s = x.feedback_survey;
    if (type !== "CANCEL") p.add(`${at}.feedback_survey`, "is only shown on the Manage (cancel) path.");
    else if (!isObj(s)) p.add(`${at}.feedback_survey`, "must be an object.");
    else {
      p.text(`${at}.feedback_survey.title`, s.title, { max: 200 });
      p.localizations(`${at}.feedback_survey.title_localizations`, s.title_localizations, 200);
      if (!Array.isArray(s.options) || !s.options.length) p.add(`${at}.feedback_survey.options`, "needs at least one option.");
      else if (s.options.length > 10) p.add(`${at}.feedback_survey.options`, "can have at most 10 options.");
      else {
        const ids = new Set<string>();
        s.options.forEach((o: unknown, i: number) => {
          const oat = `${at}.feedback_survey.options[${i}]`;
          if (!isObj(o)) { p.add(oat, "must be an object."); return; }
          if (!isStr(o.id) || !PATH_ID.test(o.id)) p.add(`${oat}.id`, "needs 1 to 64 letters, digits, _ or -.");
          else if (ids.has(o.id)) p.add(`${oat}.id`, `"${o.id}" is used twice.`);
          else ids.add(o.id);
          p.text(`${oat}.title`, o.title, { max: 100 });
          p.localizations(`${oat}.title_localizations`, o.title_localizations, 100);
          checkOffer(p, `${oat}.promotional_offer`, o.promotional_offer);
        });
      }
    }
  }
  if (x.promotional_offer !== undefined && x.promotional_offer !== null) {
    if (type !== "CANCEL" && type !== "REFUND_REQUEST") p.add(`${at}.promotional_offer`, "is only shown on the Manage and Refund Request paths.");
    else checkOffer(p, `${at}.promotional_offer`, x.promotional_offer);
  }
  if (x.refund_window !== undefined && !isStr(x.refund_window)) p.add(`${at}.refund_window`, "must be text (an ISO 8601 duration or \"forever\").");
}

/**
 * Problems with a configuration (the stored overrides merged over the default), as "field: message" lines.
 * Empty when the SDKs can show it as configured.
 */
export function validateCustomerCenter(config: unknown): string[] {
  const p = new Problems();
  if (!isObj(config)) return ["customer_center: must be an object."];
  const c = config;
  if (c.support !== undefined) {
    if (!isObj(c.support)) p.add("support", "must be an object.");
    else {
      const s = c.support;
      if (!isStr(s.email) || !EMAIL.test(s.email.trim())) p.add("support.email", "enter the email address customers should write to.");
      for (const k of ["should_warn_customer_to_update", "display_purchase_history_link", "display_user_details_section", "display_virtual_currencies"]) {
        if (s[k] !== undefined && typeof s[k] !== "boolean") p.add(`support.${k}`, "must be true or false.");
      }
      const t = s.support_tickets;
      if (t !== undefined && t !== null) {
        if (!isObj(t)) p.add("support.support_tickets", "must be an object.");
        else {
          if (t.allow_creation !== undefined && typeof t.allow_creation !== "boolean") p.add("support.support_tickets.allow_creation", "must be true or false.");
          if (t.customer_type !== undefined && !TICKET_CUSTOMERS.includes(t.customer_type as string)) p.add("support.support_tickets.customer_type", `must be one of ${TICKET_CUSTOMERS.join(", ")}.`);
          if (t.customer_details !== undefined && (!isObj(t.customer_details) || Object.values(t.customer_details).some((v) => typeof v !== "boolean"))) p.add("support.support_tickets.customer_details", "must be an object of field → true or false.");
        }
      }
    }
  }
  if (c.appearance !== undefined) {
    if (!isObj(c.appearance)) p.add("appearance", "must be an object.");
    else for (const mode of ["light", "dark"]) {
      const m = c.appearance[mode];
      if (m === undefined || m === null) continue;
      if (!isObj(m)) { p.add(`appearance.${mode}`, "must be an object."); continue; }
      for (const k of CC_COLOR_KEYS) {
        const v = m[k];
        if (v !== undefined && v !== null && v !== "" && (!isStr(v) || !HEX.test(v))) p.add(`appearance.${mode}.${k}`, "must be a hex colour such as #1A1A1A.");
      }
    }
  }
  if (c.screens !== undefined) {
    if (!isObj(c.screens)) p.add("screens", "must be an object.");
    else for (const [key, s] of Object.entries(c.screens)) {
      const at = `screens.${key}`;
      if (key !== "MANAGEMENT" && key !== "NO_ACTIVE") { p.add(at, "only MANAGEMENT and NO_ACTIVE screens exist."); continue; }
      if (!isObj(s)) { p.add(at, "must be an object."); continue; }
      if (s.type !== undefined && s.type !== key) p.add(`${at}.type`, `must be ${key}.`);
      p.text(`${at}.title`, s.title, { max: 200 });
      p.text(`${at}.subtitle`, s.subtitle, { max: 500, min: 0, required: false });
      p.localizations(`${at}.title_localizations`, s.title_localizations, 200);
      p.localizations(`${at}.subtitle_localizations`, s.subtitle_localizations, 500);
      if (s.offering !== undefined && s.offering !== null) {
        const o = s.offering;
        if (!isObj(o) || (o.type !== "CURRENT" && o.type !== "SPECIFIC")) p.add(`${at}.offering`, "needs type CURRENT or SPECIFIC.");
        else if (o.type === "SPECIFIC" && (!isStr(o.offering_id) || !o.offering_id)) p.add(`${at}.offering.offering_id`, "is required for a specific offering.");
      }
      if (!Array.isArray(s.paths)) p.add(`${at}.paths`, "must be a list.");
      else if (s.paths.length > 20) p.add(`${at}.paths`, "can have at most 20 paths.");
      else {
        const seen = { ids: new Set<string>(), types: new Set<string>() };
        s.paths.forEach((x: unknown, i: number) => checkPath(p, `${at}.paths[${i}]`, x, seen));
      }
    }
  }
  if (c.localization !== undefined) {
    if (!isObj(c.localization)) p.add("localization", "must be an object.");
    else {
      const l = c.localization;
      if (l.locale !== undefined && (!isStr(l.locale) || !/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/.test(l.locale))) p.add("localization.locale", "must be a locale such as en_US.");
      if (l.localized_strings !== undefined) {
        if (!isObj(l.localized_strings)) p.add("localization.localized_strings", "must be an object of key → text.");
        else for (const [k, v] of Object.entries(l.localized_strings)) if (!isStr(v)) p.add(`localization.localized_strings.${k}`, "must be text.");
      }
      if (l.custom_strings !== undefined && l.custom_strings !== null) {
        if (!isObj(l.custom_strings)) p.add("localization.custom_strings", "must be an object of language → strings.");
        else for (const [lang, strings] of Object.entries(l.custom_strings)) {
          const at = `localization.custom_strings.${lang}`;
          if (!LANGS.has(lang)) { p.add(at, "is not a supported language."); continue; }
          if (!isObj(strings)) { p.add(at, "must be an object of key → text."); continue; }
          if (Object.keys(strings).length > 500) p.add(at, "can have at most 500 strings.");
          for (const [k, v] of Object.entries(strings)) {
            if (!STRING_KEY.test(k)) p.add(`${at}.${k}`, "the key needs letters, digits, _ . or -.");
            else p.text(`${at}.${k}`, v, { max: 1000 });
          }
        }
      }
    }
  }
  if (c.change_plans !== undefined && !Array.isArray(c.change_plans)) p.add("change_plans", "must be a list.");
  return p.list;
}

// ---------- The SDK response ----------

export interface SdkOptions {
  /** The SDK's `X-Preferred-Locales` header, most preferred first. */
  preferredLocales?: string | string[] | null;
}

const builtinString = (lang: string, key: string) => CC_BUILTIN[lang]?.strings[key];
const builtinPhrase = (lang: string, text: string) => CC_BUILTIN[lang]?.phrases[text];

/** Text in the customer's language: the configured translation, else the built-in translation of a default text, else as written. */
function localized(o: Json, field: "title" | "subtitle", lang: string): string | undefined {
  const raw = o[field];
  if (!isStr(raw)) return undefined;
  const own = o[`${field}_localizations`];
  if (isObj(own) && isStr(own[lang]) && own[lang]) return own[lang] as string;
  if (lang === "en") return raw;
  return builtinPhrase(lang, raw) ?? raw;
}

function sdkOffer(o: unknown, lang: string): Json | null {
  if (!isObj(o) || !isObj(o.product_mapping)) return null;
  const mapping = Object.fromEntries(Object.entries(o.product_mapping).filter(([k, v]) => k && isStr(v) && v));
  const first = Object.values(mapping)[0] ?? "";
  const out: Json = {
    ios_offer_id: isStr(o.ios_offer_id) ? o.ios_offer_id : first,
    android_offer_id: isStr(o.android_offer_id) ? o.android_offer_id : first,
    eligible: typeof o.eligible === "boolean" ? o.eligible : true,
    title: localized(o, "title", lang) ?? "",
    subtitle: localized(o, "subtitle", lang) ?? "",
    product_mapping: mapping,
  };
  if (isObj(o.cross_product_promotions)) out.cross_product_promotions = o.cross_product_promotions;
  return out;
}

function sdkPath(x: unknown, lang: string): Json | null {
  if (!isObj(x) || !isStr(x.id) || !x.id || !isStr(x.title) || !CC_PATH_TYPES.includes(x.type as CcPathType)) return null;
  const out: Json = { id: x.id, title: localized(x, "title", lang), type: x.type };
  if (x.type === "CUSTOM_URL") {
    if (!isUrl(x.url)) return null;
    out.url = x.url;
    out.open_method = x.open_method === "IN_APP" ? "IN_APP" : "EXTERNAL";
  }
  if (x.type === "CUSTOM_ACTION") {
    if (!isStr(x.action_identifier) || !x.action_identifier) return null;
    out.action_identifier = x.action_identifier;
  }
  if (x.type === "CANCEL" || x.type === "REFUND_REQUEST") {
    const offer = sdkOffer(x.promotional_offer, lang);
    if (offer) out.promotional_offer = offer;
  }
  if (x.type === "CANCEL" && isObj(x.feedback_survey) && Array.isArray(x.feedback_survey.options)) {
    const s = x.feedback_survey;
    const options = (s.options as unknown[]).filter((o): o is Json => isObj(o) && isStr(o.id) && !!o.id && isStr(o.title)).map((o) => {
      const opt: Json = { id: o.id, title: localized(o, "title", lang) };
      const offer = sdkOffer(o.promotional_offer, lang);
      if (offer) opt.promotional_offer = offer;
      return opt;
    });
    if (options.length) out.feedback_survey = { title: localized(s, "title", lang) ?? "", options };
  }
  if (isStr(x.refund_window)) out.refund_window = x.refund_window;
  return out;
}

function sdkColors(m: unknown): Json {
  const out: Json = {};
  if (isObj(m)) for (const k of CC_COLOR_KEYS) if (isStr(m[k]) && HEX.test(m[k] as string)) out[k] = m[k];
  return out;
}

/** Support settings with only the keys and values the SDKs decode (Android's ticket enum is strict). */
function sdkSupport(s: Json): Json {
  const out: Json = { email: isStr(s.email) ? s.email : "" };
  for (const k of ["should_warn_customer_to_update", "display_purchase_history_link", "display_user_details_section", "display_virtual_currencies"]) if (typeof s[k] === "boolean") out[k] = s[k];
  const t = s.support_tickets;
  if (isObj(t)) {
    // Both SDKs read snake_case keys (app_user_id, ip); the Support page stores camelCase (appUserId).
    const snake = (k: string) => (k === "ipAddress" ? "ip" : k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    const details = isObj(t.customer_details) ? Object.fromEntries(Object.entries(t.customer_details).filter(([, v]) => typeof v === "boolean").map(([k, v]) => [snake(k), v])) : {};
    out.support_tickets = {
      allow_creation: t.allow_creation === true,
      customer_type: TICKET_CUSTOMERS.includes(t.customer_type as string) ? t.customer_type : "not_active",
      customer_details: details,
    };
  }
  return out;
}

/**
 * The `customer_center` object of `GET /v1/customercenter/{id}`, in the customer's language. Only fields the SDKs
 * decode are sent; a path the SDK could not act on (a Custom URL without a URL) is left out, and anything missing or
 * of the wrong type falls back to the default, so a stored configuration can never make the SDK fail to decode.
 */
export function sdkCustomerCenter(config: Json, opts: SdkOptions = {}): Json {
  const dflt = defaultCustomerCenter("support@example.com") as unknown as Json;
  const loc = isObj(config.localization) ? config.localization : {};
  const { language: lang, locale } = pickCcLocale(opts.preferredLocales, isStr(loc.locale) && loc.locale ? loc.locale : "en_US");

  const screens: Json = {};
  const cfgScreens = isObj(config.screens) ? config.screens : {};
  for (const key of ["MANAGEMENT", "NO_ACTIVE"] as const) {
    const s = isObj(cfgScreens[key]) ? cfgScreens[key] as Json : (dflt.screens as Json)[key] as Json;
    const base = (dflt.screens as Json)[key] as Json;
    const title = isStr(s.title) && s.title.trim() ? localized(s, "title", lang)! : localized(base, "title", lang)!;
    const out: Json = { type: key, title, paths: (Array.isArray(s.paths) ? s.paths : []).map((p) => sdkPath(p, lang)).filter(Boolean) };
    if (isStr(s.subtitle) && s.subtitle.trim()) out.subtitle = localized(s, "subtitle", lang);
    if (isObj(s.offering) && (s.offering.type === "CURRENT" || (s.offering.type === "SPECIFIC" && isStr(s.offering.offering_id)))) {
      out.offering = { type: s.offering.type, ...(isStr(s.offering.offering_id) ? { offering_id: s.offering.offering_id } : {}), ...(isStr(s.offering.button_text) ? { button_text: s.offering.button_text } : {}) };
    }
    screens[key] = out;
  }

  const english = { ...BASE_STRINGS, ...(isObj(loc.localized_strings) ? Object.fromEntries(Object.entries(loc.localized_strings).filter(([, v]) => isStr(v))) as Record<string, string> : {}) };
  const custom = isObj(loc.custom_strings) && isObj(loc.custom_strings[lang]) ? Object.fromEntries(Object.entries(loc.custom_strings[lang] as Json).filter(([, v]) => isStr(v))) as Record<string, string> : {};
  const strings: Record<string, string> = lang === "en" ? { ...english, ...custom } : { ...english, ...(CC_BUILTIN[lang]?.strings ?? {}), ...custom };

  const support = sdkSupport(isObj(config.support) ? config.support : dflt.support as Json);
  return {
    appearance: { light: sdkColors(isObj(config.appearance) ? config.appearance.light : null), dark: sdkColors(isObj(config.appearance) ? config.appearance.dark : null) },
    screens,
    localization: { locale, localized_strings: strings },
    support,
    change_plans: Array.isArray(config.change_plans) ? config.change_plans : [],
  };
}

/** The text a language shows for one predefined string: the custom string, the built-in translation, or the SDK's English. */
export function ccStringFor(config: Json, lang: string, key: string): { value: string; source: "custom" | "built-in" | "default" } {
  const loc = isObj(config.localization) ? config.localization : {};
  const custom = isObj(loc.custom_strings) && isObj(loc.custom_strings[lang]) ? (loc.custom_strings[lang] as Json)[key] : undefined;
  if (isStr(custom)) return { value: custom, source: "custom" };
  if (lang !== "en" && builtinString(lang, key)) return { value: builtinString(lang, key)!, source: "built-in" };
  const english = isObj(loc.localized_strings) && isStr(loc.localized_strings[key]) ? loc.localized_strings[key] as string : BASE_STRINGS[key];
  return { value: english ?? CC_STRINGS[key] ?? "", source: "default" };
}

// ---------- Promotional offer references ----------

const isRef = (o: unknown): o is CcOfferRef => isObj(o) && isStr(o.retention_offer_id);

/** Calls `fn` for every promotional offer slot (paths and survey options) with its location. */
function eachOffer(config: Json, fn: (o: unknown, at: string) => unknown, write: boolean): Json {
  const screens = isObj(config.screens) ? config.screens : {};
  const out: Json = {};
  for (const [key, s] of Object.entries(screens)) {
    if (!isObj(s) || !Array.isArray(s.paths)) { out[key] = s; continue; }
    out[key] = {
      ...s,
      paths: s.paths.map((x: unknown, i: number) => {
        if (!isObj(x)) return x;
        const at = `screens.${key}.paths[${i}]`;
        const path: Json = { ...x };
        if ("promotional_offer" in x) { const v = fn(x.promotional_offer, `${at}.promotional_offer`); if (write) path.promotional_offer = v; }
        if (isObj(x.feedback_survey) && Array.isArray(x.feedback_survey.options)) {
          path.feedback_survey = {
            ...x.feedback_survey,
            options: x.feedback_survey.options.map((o: unknown, j: number) => {
              if (!isObj(o) || !("promotional_offer" in o)) return o;
              const v = fn(o.promotional_offer, `${at}.feedback_survey.options[${j}].promotional_offer`);
              return write ? { ...o, promotional_offer: v } : o;
            }),
          };
        }
        return path;
      }),
    };
  }
  return write ? { ...config, screens: out } : config;
}

/** The Retention offer ids a configuration references, with where ("screens.MANAGEMENT.paths[2].promotional_offer"). */
export function ccOfferRefs(config: Json): { id: string; at: string }[] {
  const refs: { id: string; at: string }[] = [];
  eachOffer(config, (o, at) => { if (isRef(o)) refs.push({ id: o.retention_offer_id, at }); }, false);
  return refs;
}

/**
 * Replaces each `{ retention_offer_id }` with the offer `resolve` returns (SDK shape), or removes it (`null`, "no offer")
 * when the offer was deleted or switched off. Offers of their own and `null` stay as they are.
 */
export function resolveCcOfferRefs(config: Json, resolve: (id: string) => Json | null): Json {
  return eachOffer(config, (o) => (isRef(o) ? resolve(o.retention_offer_id) : o), true);
}
