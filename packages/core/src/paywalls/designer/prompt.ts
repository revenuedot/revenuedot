/**
 * Prompts for the AI paywall designer (prd/paywalls/PRD.md §3). Three calls, each answered in a strict JSON schema
 * (schema.ts): read the brief, design the paywall, and (when asked) translate it. A repair call sends the checker's
 * issues back with the previous design.
 */
import type { PaywallBrief, PaywallDesign } from "./schema.js";
import type { DesignIssue } from "./check.js";

export const PAYWALL_AI_MAX_PROMPT = 2000;

/** What the designer knows about one package of the offering. */
export interface PackageFacts {
  id: string;
  label: string;
  /** The package's first product, when it has one. */
  product: {
    store_identifier: string; name: string | null; type: string;
    /** ISO 8601 period, null for one-time products. */
    duration: string | null;
    /** Test Store price, when set. */
    price: { amount: number; currency: string } | null;
  } | null;
}
export interface OfferingFacts {
  /** Null: the project has no offering (or none was picked); the packages are standard ones with sample prices. */
  offering: { id: string; lookup_key: string; display_name: string } | null;
  packages: PackageFacts[];
}
export interface DesignerInput {
  prompt: string;
  appName?: string;
  /** Up to three hex colours: accent, background, text. */
  brandColors?: string[];
  /** The locale the request asks for (overrides the brief's language). */
  locale?: string;
  /** Extra locales asked for in the request. */
  locales?: string[];
  offering: OfferingFacts;
  /** "Try again": a different take on the same brief. */
  variation?: number;
  /** Refine: change the previous design as described. */
  refine?: { design: PaywallDesign; instruction: string };
}

/** Sample prices for packages without a Test Store price (the dashboard preview uses the same ones). */
export function samplePrice(id: string): { amount: number; currency: string; duration: string | null } {
  if (/life/i.test(id)) return { amount: 99.99, currency: "USD", duration: null };
  if (/annual|year/i.test(id)) return { amount: 39.99, currency: "USD", duration: "P1Y" };
  if (/week/i.test(id)) return { amount: 2.99, currency: "USD", duration: "P1W" };
  if (/six/i.test(id)) return { amount: 24.99, currency: "USD", duration: "P6M" };
  if (/three/i.test(id)) return { amount: 14.99, currency: "USD", duration: "P3M" };
  if (/two/i.test(id)) return { amount: 11.99, currency: "USD", duration: "P2M" };
  return { amount: 6.99, currency: "USD", duration: "P1M" };
}

const MONTHS: Record<string, number> = { D: 1 / 30, W: 7 / 30, M: 1, Y: 12 };
/** Months in an ISO 8601 period of one unit (P1Y → 12); null when unknown. */
export function periodMonths(iso: string | null | undefined): number | null {
  const m = /^P(\d+)([DWMY])$/.exec(iso ?? "");
  return m ? Number(m[1]) * MONTHS[m[2]!]! : null;
}
const PERIOD_WORDS: Record<string, string> = { P1W: "every week", P1M: "every month", P2M: "every 2 months", P3M: "every 3 months", P6M: "every 6 months", P1Y: "every year" };

/** Price, period and per-month price of each package: real where the Test Store has a price, sample otherwise. */
export function packagePrices(o: OfferingFacts) {
  return o.packages.map((p) => {
    const sample = samplePrice(p.id);
    const real = p.product?.price ?? null;
    const duration = p.product ? (p.product.type === "subscription" ? p.product.duration ?? sample.duration : null) : sample.duration;
    const amount = real?.amount ?? sample.amount;
    const months = periodMonths(duration);
    return { id: p.id, amount, currency: real?.currency ?? sample.currency, sample: !real, duration, perMonth: months ? amount / months : null };
  });
}

function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount); } catch { return `${currency} ${amount.toFixed(2)}`; }
}

/** The offering as the model reads it: packages, products, prices and how much each saves per month. */
export function offeringSummary(o: OfferingFacts): string {
  const prices = packagePrices(o);
  const top = Math.max(...prices.map((p) => p.perMonth ?? 0));
  const lines = o.packages.map((p, i) => {
    const pr = prices[i]!;
    const what = pr.duration ? `subscription billed ${PERIOD_WORDS[pr.duration] ?? pr.duration}` : "one-time purchase (lifetime)";
    const save = pr.perMonth && top > 0 && pr.perMonth < top ? `, ${Math.round((1 - pr.perMonth / top) * 100)}% cheaper per month than the most expensive plan` : "";
    const per = pr.perMonth && pr.duration !== "P1M" ? ` (${money(pr.perMonth, pr.currency)} a month)` : "";
    const product = p.product ? `product ${p.product.store_identifier}${p.product.name ? ` "${p.product.name}"` : ""}, ` : "";
    return `- ${p.id} "${p.label}": ${product}${what}, ${pr.sample ? "sample price " : "price "}${money(pr.amount, pr.currency)}${per}${save}.`;
  });
  const head = o.offering
    ? `The offering "${o.offering.display_name}" (${o.offering.lookup_key}) has these packages, in the developer's order:`
    : "The project has no offering yet, so the paywall uses standard package ids with sample prices (the developer binds real products later). Available packages:";
  return [head, ...lines, "Trial lengths and intro offers are set in the stores, so they are not listed here: take them from the description."].join("\n");
}

// ---- 1. Reading the brief ------------------------------------------------------------------------------------------

export function briefMessages(i: DesignerInput): { system: string; user: string } {
  const system = `You read a developer's description of the paywall they want for their mobile app and write down exactly what they asked for, as JSON in the given schema. Do not design anything yet and do not add wishes they did not express.

Rules:
- plans.order: the packages to show, in the order the description gives ("lead with yearly, monthly as the alternative" = yearly then monthly). When it does not say, list the subscriptions from the longest period to the shortest, then lifetime; leave out packages that clearly do not fit the description (for "a single plan", only that plan).
- plans.selected: the plan the description leads with or highlights; otherwise the first of plans.order.
- plans.trial_packages and trial_days: only what the description says ("7-day free trial on the yearly plan" = the yearly package and 7). A trial mentioned without a plan applies to plans.selected.
- plans.missing: plans it asks for that no available package provides (e.g. "lifetime" when there is no lifetime package).
- benefits.count: the number it asks for ("list 3 benefits" = 3), else the number of benefits it names, else 0. benefits.named: the benefits it names, in its words.
- look: appearance dark for "dark", "night", "black", "midnight" looks; light for "light", "white", "bright", "airy"; gradient true for gradients, skies, sunsets, auroras, glows. colors: the colours named or clearly implied, as hex.
- locale: the language of the description (es_ES for Spanish, de_DE for German, fr_FR, it_IT, pt_BR, ja_JP, ko_KR, zh_Hans, nl_NL, ru_RU …) unless it asks for another language; en_US for English.
- extra_locales: further languages it asks for ("also in German and Spanish" = de_DE, es_ES).
- discount: only a discount the description itself states ("50% off yearly"); savings that follow from the prices are not a discount, so leave percent 0.
- facts: only numbers the developer states (ratings, user counts, awards).`;
  const lines = [
    `Description: ${i.prompt.trim().slice(0, PAYWALL_AI_MAX_PROMPT)}`,
    i.appName?.trim() ? `App name (from the form): ${i.appName.trim().slice(0, 80)}` : "",
    i.brandColors?.length ? `Brand colours (from the form): ${i.brandColors.slice(0, 3).join(", ")}` : "",
    i.locale ? `The paywall must be written in the locale ${i.locale}.` : "",
    i.locales?.length ? `Also translate it into: ${i.locales.join(", ")}.` : "",
    "",
    offeringSummary(i.offering),
  ].filter((x) => x !== "");
  return { system, user: lines.join("\n") };
}

// ---- 2. Designing ---------------------------------------------------------------------------------------------------

/** What each built-in icon shows, so the model picks by meaning. */
export const ICON_MEANINGS: Record<string, string> = {
  check: "done, included", check_circle: "included, guaranteed", x: "not included, close", star: "favourite, premium, rating",
  sparkles: "AI, magic, new, delight", lock: "locked, privacy (never for access you get)", unlock: "unlocked, full access today",
  bell: "reminder, notification", crown: "premium, pro, VIP", shield: "safety, protection, parental control", shield_check: "secure, private, verified",
  zap: "fast, instant, energy", heart: "love, health, care, support the team", gift: "gift, bonus, free trial", clock: "time, minutes a day, history",
  calendar: "a day or date, billing day, plan", calendar_check: "schedule done, streaks, trial end", cloud: "cloud backup, storage", infinity: "unlimited, lifetime, forever",
  chart: "statistics, insights", trending_up: "progress, growth, results", users: "family, team, community, sharing", user: "profile, personal",
  download: "offline, downloads, export", camera: "photos, camera", music: "music, sounds, soundscapes", book: "lessons, stories, reading, courses",
  globe: "languages, travel, worldwide, web", moon: "sleep, night, dark mode", sun: "morning, energy, day", flame: "streaks, burn, intensity, hot",
  target: "goals, focus", leaf: "calm, nature, mindfulness, healthy", dumbbell: "workouts, strength, fitness", mic: "voice, speaking, podcasts, recording",
  image: "pictures, wallpapers, gallery", wand: "magic edits, AI tools, presets", percent: "discount, savings", tag: "price, sale, deal",
  no_ads: "no ads", sync: "sync across devices", devices: "phone, tablet and computer", headphones: "audio, listening, sleep stories, guided sessions",
  trophy: "achievements, rewards, challenges", credit_card: "payment, billing, the day you are charged", chat: "conversation, speaking practice, chat, support",
  pencil: "writing, notes, editing", search: "search, find anything", wind: "breathing, air, calm", sliders: "adjustments, filters, settings, controls",
  layers: "layers, templates, projects", smile: "kids, fun, happiness", file_text: "documents, notes, PDFs, export", palette: "colours, themes, design, creativity",
  rocket: "launch, boost, growth, speed",
};

const VARIABLES = `Price variables (the device shows the customer's local price; never write prices or currency amounts as numbers):
- {{ product.price_per_period }} = the billed price with its period, "$59.99/year". The amount charged. {{ product.price_per_period_abbreviated }} = "$59.99/yr".
- {{ product.price }} = the billed price alone, "$59.99" (the lifetime price for a lifetime plan).
- {{ product.price_per_month }} / {{ product.price_per_week }} / {{ product.price_per_day }} = the price spread over a month/week/day, "$4.99". Only for "just $4.99 a month" lines, never as the amount charged.
- {{ product.period }} = "year", {{ product.periodly }} = "yearly", {{ product.period_with_unit }} = "1 year".
- {{ product.relative_discount }} = "50%": how much cheaper per month this plan is than the most expensive plan. Empty on the most expensive plan, so only use it on the cheaper plan (a yearly badge "SAVE {{ product.relative_discount }}").
- Free trial / intro offer: {{ product.offer_period_with_unit }} = "7 days", {{ product.offer_period_in_days }} = "7", {{ product.offer_price }} = the intro price, which is the word "free" for a free trial. They are empty when the selected plan has no trial, so they belong ONLY in trial wording: cta_trial, trial_subtitle, disclosure_trial and the trial timeline. Never use {{ product.offer_price }} for what is charged after the trial ("starts at {{ product.offer_price }}" is wrong; "then {{ product.price_per_period }}" is right).
- A text outside a plan card refers to the plan that is selected.`;

export function designSystemPrompt(): string {
  const icons = Object.entries(ICON_MEANINGS).map(([k, v]) => `${k} (${v})`).join("; ");
  return `You are a senior paywall designer for subscription apps. You design one mobile paywall that converts well and follows the developer's brief to the letter, and answer with JSON in the given schema. The JSON is compiled into a native paywall by RevenueDot: you choose the sections, their order, the copy, the icons and the theme; the layout, spacing and price formatting are done for you.

Follow the brief exactly: the plans in the brief's order, the brief's selected plan, the trial on the plans it names, its discount, exactly the number of benefits it asks for and the benefits it names (in that order), the app name in the copy (the title or subtitle), its look, and its language for every text.

Sections (each at most once; order lists them top to bottom and must include plans):
- hero: art icon_glow (a glowing icon, for calm, night, premium and dreamy looks), icon_tile (a coloured tile, for bold and productive looks), icon_plain or none; decoration stars for night, sleep and space looks, sparkles for magic and AI looks, else none. title: the main promise in 2 to 6 words, with the app name when known ("Sleep deeper with Drift"). subtitle: one short sentence or "". eyebrow: a 1 to 3 word label or "".
- benefits: 3 to 5 concrete benefits (or exactly the number asked), each with the icon that shows its meaning; title 2 to 5 words, description "" or up to 8 words. style list (default), cards (roomy, premium) or grid (2 columns, for 4 short benefits).
- trial_timeline: include it whenever a plan has a free trial. Three items: today (icon unlock or sparkles: "Today", what they get now), reminder (icon bell: e.g. "Day 5" or "2 days before it ends": we remind you), trial_end (icon credit_card or calendar: "Day {{ product.offer_period_in_days }}" or "After {{ product.offer_period_with_unit }}": "You're charged {{ product.price_per_period }}. Cancel anytime before."). It shows only while the selected plan has a trial.
- social_proof: ONLY with ratings, user counts or reviews the developer gave (the brief's facts). Never invent them.
- countdown: only for limited-time offers.
- comparison: free versus paid, 3 to 5 short rows, only when asked or clearly useful.
- pages: 2 or 3 swipeable value pages, only when asked for an onboarding-style or multi-page paywall.
- note: one short extra line, rarely needed.
- plans: the brief's packages in order, selected = the brief's selected plan. title: the plan name in the paywall's language (Yearly, Monthly, Weekly, Lifetime …). subtitle: one short line, e.g. "{{ product.price_per_month }}/month, billed yearly" for yearly, "Billed monthly, cancel anytime" for monthly, "Pay once, yours forever" for lifetime. trial_subtitle: for a plan with the trial, "{{ product.offer_period_with_unit }} free, then {{ product.price_per_period }}"; else "". badge: on the plan that saves the most, "SAVE {{ product.relative_discount }}" (or the brief's discount, e.g. "50% OFF"); "BEST VALUE" or "" otherwise; never on the most expensive plan per month. layout list for 1 to 3 plans with subtitles; cards for 2 or 3 short plans side by side. The billed price is shown for you on every card.
- footer: cta "Continue" (or "Subscribe", "Get Pro" …), cta_trial when a plan has a trial ("Start free trial", "Try 7 days free"), reassurance "No commitment, cancel anytime" or "", disclosure "{{ product.price_per_period }}. Renews automatically. Cancel anytime in Settings.", disclosure_trial "{{ product.offer_period_with_unit }} free, then {{ product.price_per_period }}. Cancel anytime in Settings.", restore "Restore purchases". Translate them all when the paywall is not in English.

${VARIABLES}

Copy: short, concrete, warm; second person; no exclamation marks in a row; no claims about prices or savings the brief and the offering do not support; never invent ratings, user counts or awards. Titles at most about 40 characters, benefit titles about 30, descriptions about 60, buttons about 22.

Theme:
- One accent colour for buttons, selected plan and icons; everything else calm. Brand colours from the form win: the first is the accent, the second the background, the third the text.
- Every text must be readable: at least 4.5:1 contrast against what is behind it (text on background, on cards, and on_accent on the accent). Dark looks: appearance dark, near-black or deep coloured background, light text. Light looks: white or very light background, near-black text.
- Gradients: 2 or 3 colours of similar lightness (all dark or all light), angle 180 for top to bottom. A night sky: deep navy to indigo to violet (e.g. #070b1f, #141a3f, #2b1f55) with a soft lavender or gold accent and stars. A sunset: warm coral to peach. Use the look the brief asks for; plain white or near-black is a fine default.
- card: a surface slightly different from the background (on dark: a little lighter; on light: a light grey or tint). card_border: subtle.
- dark_mode: same for dark designs and strong brand looks; adapt for plain light designs.
- corners: round for friendly and calm apps, soft as the default, square for serious B2B tools.

Icons (use these names only): ${icons}.

notes: up to two short notes for the developer about things only they can do, e.g. that the free trial must be set up on the yearly product in App Store Connect and Google Play for the timeline and trial wording to show, or that the offering has no lifetime package. Savings badges and prices fill in by themselves, so never write notes about them. [] when there is nothing to say.`;
}

export function designUserMessage(i: DesignerInput, brief: PaywallBrief): string {
  const parts = [
    `Brief: ${i.prompt.trim().slice(0, PAYWALL_AI_MAX_PROMPT)}`,
    i.appName?.trim() ? `App name: ${i.appName.trim().slice(0, 80)}` : "",
    i.brandColors?.length ? `Brand colours (accent, background, text): ${i.brandColors.slice(0, 3).join(", ")}` : "",
    "",
    offeringSummary(i.offering),
    "",
    `What the brief asks for (read from it, follow it): ${JSON.stringify(brief)}`,
    `Write every text in ${brief.locale}.`,
  ];
  if (i.variation && i.variation > 0) {
    parts.push("", `This is take ${i.variation + 1} on the same brief: keep everything the brief asks for, but choose a clearly different hero, headline, benefit wording, section order or theme than an obvious first take.`);
  }
  if (i.refine) {
    parts.push("", `Start from this design and change only what the instruction asks; keep everything else the same:\n${JSON.stringify(i.refine.design)}`, `Instruction: ${i.refine.instruction.slice(0, 1000)}`);
  }
  return parts.filter((x, n, a) => !(x === "" && a[n - 1] === "")).join("\n");
}

/** The repair round: the previous design and what the checker found. */
export function fixUserMessage(base: string, design: PaywallDesign, issues: DesignIssue[]): string {
  return `${base}

Your previous design:
${JSON.stringify(design)}

The checker found these problems. Fix every one of them, keep everything else as it was, and answer with the whole corrected design:
${issues.map((x, n) => `${n + 1}. ${x.message}`).join("\n")}`;
}

// ---- 3. Translating -------------------------------------------------------------------------------------------------

export function translateMessages(strings: Record<string, string>, from: string, to: string[]): { system: string; user: string } {
  const system = `You translate the texts of a mobile app paywall. Answer with JSON in the given schema: one entry per target locale, with every key translated. Keep each text short and natural for an app store audience in that language. Copy every {{ ... }} variable exactly as it is (never translate or change what is inside the braces) and keep Markdown such as **bold**.`;
  const user = `Source locale: ${from}\nTarget locales: ${to.join(", ")}\nTexts (key: text):\n${Object.entries(strings).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}`;
  return { system, user };
}
