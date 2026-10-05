/**
 * Onboarding and growth emails to RevenueDot Cloud accounts (prd/onboarding-emails/PRD.md). Brand emails from RevenueDot.
 * Each email is built for its own goal from a set of blocks: a setup tracker, a video or screenshot, a receipt card, a big
 * number, feature cards, a checklist, a timeline, questions and answers, code, a rating scale, one-click choices. Two looks:
 * "rich" (logo, heading, blocks) for guides and announcements, and "note" (plain paragraphs signed by the team) for
 * check-ins that want a reply. In DESIGN.md's tokens: white, near-black ink, grey hairlines, square corners, the gold dot.
 * Copy uses a tiny inline markup: **bold**, `code` and [label](url). Links to our own hosts get UTM tags.
 */
import { esc, type Rendered } from "./templates.js";

const INK = "#0A0A0A", FG2 = "#4A4A4A", FG3 = "#737373", BORDER = "#E5E5E5", PANEL = "#F7F7F7", GOLD = "#F7B500", UP = "#587A27", DOWN = "#C2410C";
const FONT = "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const LOGO_URL = "https://revenuedot.app/brand/revenuedot-lockup-black%402x.png";
export const SITE = "https://revenuedot.app";

/** The sender. The Cloud binding must allow this address (cloudflare.config.ts); replies reach the team's inbox. */
export const JOURNEY_FROM = "RevenueDot <hello@mail.revenuedot.app>";
export const JOURNEY_REPLY_TO = "hello@revenuedot.app";

export type VideoId = "first-purchase" | "connect-your-app" | "switch-from-revenuecat" | "paywalls-and-experiments" | "chatgpt-demo";

/**
 * Tutorial videos shown as a playable cover. The cover opens the video's page on revenuedot.app; `youtube` is the same
 * video on our channel, offered as a small secondary link next to the title. Covers (1200×675 JPEG, play button and length drawn in) live in apps/site/public/email/.
 * `ready`: the video has its /watch page and cover live; until then the picture block shows nothing for it.
 */
export const VIDEOS: Record<VideoId, { title: string; length: string; slug: string; youtube: string; ready: boolean }> = {
  "first-purchase": { youtube: "https://www.youtube.com/watch?v=1YLygdbWOKM", title: "Your first purchase in 5 minutes", length: "1:18", slug: "revenuedot-first-purchase", ready: true },
  "connect-your-app": { youtube: "https://www.youtube.com/watch?v=M_D0YodECkU", title: "Connect your app to RevenueDot", length: "1:17", slug: "revenuedot-connect-your-app", ready: true },
  "switch-from-revenuecat": { youtube: "https://www.youtube.com/watch?v=Smjskzwwo7o", title: "Switch from RevenueCat without losing a renewal", length: "1:34", slug: "revenuedot-switch-from-revenuecat", ready: true },
  "paywalls-and-experiments": { youtube: "https://www.youtube.com/watch?v=daXVK_4XD8I", title: "Build a paywall and test it", length: "1:04", slug: "revenuedot-paywalls-and-experiments", ready: true },
  "chatgpt-demo": { youtube: "https://www.youtube.com/watch?v=bq8JAlei4x8", title: "Run your subscriptions from ChatGPT", length: "1:27", slug: "revenuedot-chatgpt-demo", ready: true },
};
export const videoUrl = (id: VideoId) => `${SITE}/watch/${VIDEOS[id].slug}`;
export const videoCover = (id: VideoId) => `${SITE}/email/${VIDEOS[id].slug}.jpg`;

/** Dashboard screenshots (apps/site/scripts/email-shots.mjs) and renders of our own emails (scripts/email-art.ts). */
export type Shot = "checklist" | "overview" | "customers" | "apps" | "app-store" | "forwarding" | "api-keys" | "paywall-templates" | "experiments" | "recovery" | "team" | "charts";
export type Art = "recovery-email";
const SHOT_ALT: Record<Shot, string> = {
  checklist: "The setup checklist on the RevenueDot Overview", overview: "The RevenueDot Overview with revenue, MRR and trials",
  customers: "The Customers list in RevenueDot", apps: "The Apps page in RevenueDot with each app's status",
  "app-store": "An App Store app's setup checklist in RevenueDot", forwarding: "The field that forwards store notifications to RevenueCat",
  "api-keys": "The API keys page in RevenueDot", "paywall-templates": "Paywall templates in RevenueDot",
  experiments: "Experiment templates in RevenueDot", recovery: "Payment recovery in RevenueDot", team: "Project members and roles in RevenueDot",
  charts: "A revenue chart in RevenueDot",
};
const ART_ALT: Record<Art, string> = { "recovery-email": "The payment recovery email your customer receives, in your app's name" };
const shotUrl = (s: Shot) => `${SITE}/email/shots/${s}.jpg`;
const artUrl = (a: Art) => `${SITE}/email/art/${a}.jpg`;

export type StepId =
  | "welcome" | "verify_reminder" | "connect_app" | "store_keys" | "paywall" | "need_hand" | "side_by_side" | "cutover"
  | "first_sale" | "standard_welcome" | "teammate_welcome";

/** What a step's copy may use. Everything optional is filled only for the steps that need it. */
export interface JourneyCtx {
  step: StepId;
  /** Dashboard origin, e.g. https://app.revenuedot.app */
  app: string;
  first: string | null;
  projectId: string | null;
  projectName: string | null;
  unsubscribeUrl: string;
  /** Records the reader's path (welcome email), then opens the guide for it. */
  pathUrl?: (path: "new" | "revenuecat") => string;
  /** Opens a page that records a one-click answer (a rating, a reason) after the reader confirms it. */
  feedbackUrl?: (kind: "nps" | "cancel", value: string) => string;
  verifyUrl?: string;
  /** Where the account is in setup, for the tracker. */
  progress?: { testPurchase: boolean; app: boolean; store: boolean; live: boolean };
  testPurchase?: boolean;
  sdk?: { platform: string; version: string } | null;
  sale?: { product: string; amount: string | null; country: string | null; existing?: boolean } | null;
  /** The project has an app (any store), so this is more than an empty sign-up. */
  appCreated?: boolean;
  /** Store notifications have reached RevenueDot (since the RevenueCat import, for switchers). */
  notificationsSeen?: boolean;
  importedCustomers?: number | null;
  /** This month's tracked revenue (USD) and its name ("October"). */
  tracked?: number;
  month?: string;
  /** What RevenueDot Standard and RevenueCat charge at given monthly revenues: [revenue, RevenueDot, RevenueCat]. */
  priceRows?: [number, number, number][];
  /** A month at the last 7 days' pace (last7 × 30 / 7), and the 7 days' production revenue. */
  projected?: number;
  last7?: number;
  /** The month that passed Cloud Free's $10,000, and its tracked revenue. */
  overMonth?: string;
  overTracked?: number;
  /** The first RevenueCat import's date, "October 2". */
  importedOn?: string;
  /** A month's bill on each: at the last 7 days' pace for the cutover, on the month that passed $10,000 for the upgrade. */
  bills?: { revenuedot: number; revenuecat: number };
  /** Moving from RevenueCat (chose that path, or imported). */
  migrating?: boolean;
  /** The first live sale's date, "September 12". */
  liveSince?: string;
  lastSaleAt?: Date | null;
  referralUrl?: string;
  inviter?: string | null;
  /** The recipient, for the footer's "This landed in …" line. */
  to?: string;
}

/** The building blocks an email is made of. */
type Block =
  | { t: "lead"; text: string }
  | { t: "p"; text: string }
  | { t: "h2"; text: string }
  | { t: "progress"; current: "test" | "app" | "store" | "live" }
  | { t: "picture"; video?: VideoId; shot?: Shot; art?: Art; href?: string; caption?: string }
  | { t: "stat"; value: string; label: string; tone?: "up" }
  | { t: "receipt"; title: string; rows: [string, string][] }
  | { t: "cards"; items: { title: string; text: string; link?: { label: string; url: string } }[] }
  | { t: "defs"; items: { term: string; text: string }[] }
  | { t: "checklist"; items: { title: string; text: string }[] }
  | { t: "ol"; items: string[] }
  | { t: "list"; items: string[] }
  | { t: "timeline"; items: { when: string; title: string; text: string }[] }
  | { t: "faq"; items: { q: string; a: string }[] }
  | { t: "prompts"; items: string[] }
  | { t: "code"; label: string; text: string }
  | { t: "table"; head: [string, string, string]; rows: [string, string, string][]; note?: string }
  | { t: "callout"; text: string; tone?: "tip" | "warn" }
  | { t: "copy"; label: string; text: string }
  | { t: "rating"; question: string; low: string; high: string; url: (n: number) => string }
  | { t: "choices"; items: { label: string; url: string }[] }
  | { t: "button"; label: string; url: string; secondary?: { label: string; url: string } };

interface JourneyMail {
  subject: string;
  preheader: string;
  look: "rich" | "note";
  eyebrow?: string;
  heading?: string;
  blocks: Block[];
}

// ---------- helpers ----------

export const usd = (n: number, cents = false) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

/** Adds UTM tags to links on our own hosts (site, docs, dashboard); other links stay as they are. */
export function tag(url: string, step: StepId): string {
  try {
    const u = new URL(url);
    if (!/(^|\.)revenuedot\.app$/.test(u.hostname) && u.hostname !== "localhost") return url;
    if (u.pathname.startsWith("/auth/")) return url;
    u.searchParams.set("utm_source", "revenuedot");
    u.searchParams.set("utm_medium", "email");
    u.searchParams.set("utm_campaign", "journeys");
    u.searchParams.set("utm_content", step);
    return u.toString();
  } catch { return url; }
}

/** **bold**, `code` and [label](url) to HTML (escaped first) or to plain text. */
function inline(s: string, step: StepId, mode: "html" | "text"): string {
  if (mode === "text") return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, l: string, u: string) => `${l} (${tag(u, step)})`);
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, `<strong style="font-weight:700;color:${INK};">$1</strong>`)
    .replace(/`([^`]+)`/g, `<code style="font-family:${MONO};font-size:13px;background:${PANEL};border:1px solid ${BORDER};padding:1px 5px;">$1</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, l: string, u: string) => `<a href="${tag(u.replace(/&amp;/g, "&"), step).replace(/&/g, "&amp;")}" style="color:${INK};text-decoration:underline;text-underline-offset:2px;">${l}</a>`);
}

const hi = (c: JourneyCtx) => (c.first ? `Hi ${c.first},` : "Hi there,");
const proj = (c: JourneyCtx) => c.projectName ?? "your project";
const dash = (c: JourneyCtx, path: string) => (c.projectId ? `${c.app}/projects/${c.projectId}${path}` : `${c.app}/`);
const docs = (path: string) => `${SITE}/docs/${path}`;
const mailto = (subject: string) => `mailto:hello@revenuedot.app?subject=${encodeURIComponent(subject)}`;

// ---------- the emails ----------

const EMAILS: Record<StepId, (c: JourneyCtx) => JourneyMail> = {
  // Everyone, five minutes after sign-up. Written for someone adding purchases for the first time; switching is one link.
  welcome: (c) => ({
    look: "rich",
    subject: "Welcome to RevenueDot",
    preheader: "Make your first test purchase in about five minutes. No App Store account needed.",
    heading: c.first ? `Welcome to RevenueDot, ${c.first}` : "Welcome to RevenueDot",
    blocks: [
      { t: "lead", text: "RevenueDot runs your app's in-app purchases and subscriptions on the App Store, Google Play and the web. It checks every purchase with the store, unlocks paid features in your app and shows you the revenue." },
      { t: "picture", video: "first-purchase", shot: "checklist", caption: "A first purchase, from an empty project to a paying test customer." },
      { t: "p", text: "Start with a test purchase from the dashboard. It needs no App Store or Google Play account, and Cloud is free until your apps make $10,000 a month." },
      { t: "button", label: "Make your first test purchase", url: dash(c, "/overview"), secondary: { label: "Switching from RevenueCat? Start here", url: c.pathUrl?.("revenuecat") ?? docs("migrate") } },
    ],
  }),

  verify_reminder: (c) => ({
    look: "rich",
    subject: "Confirm your email to create secret API keys",
    preheader: "A fresh link that works for 24 hours.",
    heading: "Confirm your email",
    blocks: [
      { t: "lead", text: "Please confirm your email address. RevenueDot needs it before you can create secret API keys or invite teammates. The link works for 24 hours." },
      { t: "button", label: "Confirm my email", url: c.verifyUrl ?? `${c.app}/` },
    ],
  }),

  // Building an app, or already selling with your own code: no app has called RevenueDot yet.
  connect_app: (c) => ({
    look: "rich",
    subject: c.testPurchase ? "Your test purchase worked. Next, add RevenueDot to your app" : "Add RevenueDot to your app",
    preheader: "Install the RevenueDot SDK for your platform and add your API key.",
    heading: c.testPurchase ? "Your test purchase worked" : "Add RevenueDot to your app",
    blocks: [
      { t: "lead", text: "Next, install the RevenueDot SDK in your app and add your API key, so it can load your products, show a paywall and unlock paid features." },
      { t: "list", items: [
        ...(c.progress?.store ? ["**Already selling?** Turn on **Track new purchases from server-to-server notifications** on each app's page, so each current subscriber appears at their next renewal or change."] : []),
        `**Your platform:** iOS, Android, Flutter, React Native, Expo, Capacitor, Unity and the web each have a [setup page](${docs("sdks")}).`,
        `**Your API key:** copy it from [API keys](${dash(c, "/api-keys")}) in the dashboard.`,
        `**Using an AI coding tool?** Point it at [revenuedot.app/llms.txt](${SITE}/llms.txt) and ask it to add RevenueDot.`,
      ] },
      { t: "picture", shot: "api-keys", href: dash(c, "/api-keys"), caption: "Your keys, ready to copy." },
      { t: "button", label: "Add RevenueDot to my app", url: docs("getting-started/connect-your-app") },
    ],
  }),

  // Any case: an app has called RevenueDot, but no store is connected.
  store_keys: (c) => ({
    look: "rich",
    subject: "Your app is connected. Next, connect your store",
    preheader: "Store credentials let RevenueDot check every purchase and hear about renewals and refunds.",
    heading: "Your app is connected",
    blocks: [
      { t: "lead", text: `${c.sdk ? `Your ${c.sdk.platform} app` : "Your app"} is talking to RevenueDot. Next, connect your store, so RevenueDot can check every purchase and hear about renewals and refunds even when nobody opens the app.` },
      { t: "picture", shot: "app-store", href: dash(c, "/apps"), caption: "Each app's page shows what is still missing." },
      { t: "list", items: [
        `**App Store:** add an In-App Purchase key, then paste RevenueDot's notification URL into App Store Connect. The [App Store guide](${docs("guides/app-store")}) shows both.`,
        `**Google Play:** add a service account and turn on real-time notifications. The [Google Play guide](${docs("guides/google-play")}) covers both.`,
        `**Products already in the store?** [Import them](${docs("guides/import-products")}) instead of typing them again.`,
      ] },
      { t: "button", label: "Connect my store", url: dash(c, "/apps") },
    ],
  }),

  // Building an app: store connected, no paywall yet, no sale yet.
  paywall: (c) => ({
    look: "rich",
    subject: "Add a paywall that sells",
    preheader: "Start from a template and change it from the dashboard, without a new release.",
    heading: "Add a paywall that sells",
    blocks: [
      { t: "lead", text: "Your store is connected. The paywall is the screen where people choose a plan and pay, so it decides how much your app earns." },
      { t: "picture", video: "paywalls-and-experiments", shot: "paywall-templates", href: dash(c, "/paywalls/templates") },
      { t: "list", items: [
        "**Start from a template** and change the words, plans and colors in the dashboard.",
        "**Add the paywall view from the RevenueDot SDK to your app once.** After that, your changes reach the app without a new release.",
        `**Want the details?** The [paywall guide](${docs("guides/paywalls")}) walks through it.`,
      ] },
      { t: "button", label: "Pick a paywall template", url: dash(c, "/paywalls/templates") },
    ],
  }),

  // One email to anyone stuck, written for the step they stalled on.
  need_hand: (c) => {
    const p = c.progress ?? { testPurchase: !!c.testPurchase, app: false, store: false, live: false };
    const stuck = (subject: string, preheader: string, blocks: Block[], label: string, url: string): JourneyMail =>
      ({ look: "rich", subject, preheader, heading: subject, blocks: [...blocks, { t: "button", label, url }] });
    if (c.migrating && !c.importedOn) return stuck("Bring your RevenueCat project over", "One command copies your catalog, customers and purchase history.", [
      { t: "lead", text: `One command copies your apps, products, offerings, customers and purchase history into ${proj(c)}. Running it twice changes nothing, and RevenueCat keeps working while you check the result.` },
      { t: "picture", video: "switch-from-revenuecat", shot: "customers" }], "Open the import guide", docs("migrate/importer"));
    if (c.migrating) return stuck("RevenueDot isn't hearing from your stores yet", "Set up forwarding so RevenueCat and RevenueDot both see every renewal.", [
      { t: "lead", text: `Your RevenueCat data is in ${proj(c)}, but no store notifications have reached RevenueDot since the import. Set RevenueCat's notification URL as the forwarding address on each app's page, then point the stores at RevenueDot, so neither side misses a renewal.` },
      { t: "picture", shot: "forwarding", href: dash(c, "/apps"), caption: "The forwarding field on each app's page." }], "Open the side-by-side guide", docs("migrate/dual-run"));
    if (p.app) return stuck("Connect your store to start selling", "Each app's page lists exactly what is missing.", [
      { t: "lead", text: "Your app talks to RevenueDot, but no store is connected yet, so RevenueDot can't check real purchases. Each app's page in the dashboard lists exactly what is missing, and the store guides walk through every field." },
      { t: "picture", shot: "app-store", href: dash(c, "/apps") }], "Connect my store", dash(c, "/apps"));
    if (p.testPurchase || p.store || c.appCreated) return stuck("Let your AI coding tool add RevenueDot", "Paste one prompt into Claude Code, Cursor or Codex.", [
      { t: "lead", text: `Your app hasn't connected to ${proj(c)} yet. If you use an AI coding tool, paste this prompt and it reads our setup guide and adds RevenueDot to your app:` },
      { t: "prompts", items: [`${p.store ? "Move my app's in-app purchases to RevenueDot" : "Add in-app purchases to my app with RevenueDot"}. Read https://revenuedot.app/llms.txt, follow the setup for my platform, and use the public API key I copy from the RevenueDot dashboard.`] },
      { t: "picture", shot: "api-keys", href: dash(c, "/api-keys"), caption: "Copy your public API key here." }], "Open the setup guide", docs("getting-started/connect-your-app"));
    return stuck("Your first test purchase takes five minutes", "No App Store or Google Play account needed.", [
      { t: "lead", text: `${proj(c)} is ready. A test purchase from the dashboard shows how RevenueDot works from start to finish, and it needs no App Store or Google Play account.` },
      { t: "picture", shot: "checklist", href: dash(c, "/overview"), caption: "Your setup checklist on the Overview." }], "Make a test purchase", dash(c, "/overview"));
  },


  // Switching from RevenueCat: the import is done.
  side_by_side: (c) => ({
    look: "rich",
    subject: "Your RevenueCat data is in. Next, run both side by side",
    preheader: "Forward store notifications to RevenueCat first, so neither side misses a renewal.",
    heading: "Your RevenueCat data is in",
    blocks: [
      ...(c.importedCustomers ? [{ t: "stat", value: c.importedCustomers.toLocaleString("en-US"), label: `customers imported into ${proj(c)}, with their purchase history` } as Block] : []),
      { t: "lead", text: "Next, run RevenueCat and RevenueDot side by side so both see every renewal. Your app keeps talking to RevenueCat until you ship the update. Do these in order:" },
      { t: "ol", items: ["Add each app's store credentials in RevenueDot.", "Forward store notifications to RevenueCat.", "Point the stores at RevenueDot.", "Compare both sides for a week. The guide shows how."] },
      { t: "picture", shot: "forwarding", href: dash(c, "/apps"), caption: "The forwarding field on each app's page." },
      { t: "button", label: "Open the side-by-side guide", url: docs("migrate/dual-run") },
    ],
  }),

  // Switching from RevenueCat: the app update talks to RevenueDot, and live sales have run for a week.
  cutover: (c) => {
    const rdM = Math.round(c.bills?.revenuedot ?? 0), rcM = Math.round(c.bills?.revenuecat ?? 0), save = (rcM - rdM) * 12;
    return {
      look: "rich",
      subject: c.bills && save > 0 ? `Ready to turn RevenueCat off? You could save ${usd(save)} a year` : "Ready to turn RevenueCat off?",
      preheader: c.bills ? `At your last 7 days' pace: ${usd(rdM)} a month on RevenueDot, ${usd(rcM)} at RevenueCat's list price.` : "Your cutover checklist.",
      heading: c.liveSince ? `Live sales on RevenueDot since ${c.liveSince}` : "Live sales on RevenueDot",
      blocks: [
        ...(c.bills && save > 0 ? [{ t: "stat", value: usd(save), label: `saved a year: ${usd(rdM)} a month on RevenueDot against ${usd(rcM)} at RevenueCat's list price, at your last 7 days' pace`, tone: "up" } as Block] : []),
        { t: "p", text: `${proj(c)} has recorded live sales on RevenueDot${c.liveSince ? ` since ${c.liveSince}` : ""}, and your app update is reaching your customers. Turn RevenueCat off when all three are true:` },
        { t: "picture", shot: "overview", href: dash(c, "/overview"), caption: "Revenue on RevenueDot, updated as sales come in." },
        { t: "checklist", items: [{ title: "The numbers match", text: "The comparison in the cutover checklist shows no differences." }, { title: "Most users have updated", text: "Older app versions still talk to RevenueCat." }, { title: "Webhooks move together", text: "Point your backend's webhooks at RevenueDot in the hour you turn RevenueCat's off." }] },
        { t: "button", label: "Open the cutover checklist", url: docs("migrate/cutover-checklist") },
      ],
    };
  },

  // The first live sale. Three cases: a brand-new app, an app that already sold before RevenueDot, and a switch.
  first_sale: (c) => {
    const rows: Block[] = c.sale ? [{ t: "receipt", title: `${proj(c)}: first sale on RevenueDot`, rows: [["Product", c.sale.product], ...(c.sale.amount ? [["Amount", c.sale.amount] as [string, string]] : []), ...(c.sale.country ? [["Customer in", c.sale.country] as [string, string]] : [])] }] : [];
    const preheader = c.sale ? `${c.sale.product}${c.sale.amount ? ` for ${c.sale.amount}` : ""}.` : "Store notifications are reaching RevenueDot.";
    const app = !!c.progress?.app;
    if (c.migrating) return {
      look: "rich", subject: `RevenueDot recorded its first ${proj(c)} sale`, preheader, heading: "Sales are reaching RevenueDot",
      blocks: [...rows, { t: "lead", text: app
        ? "RevenueDot now records sales alongside RevenueCat, and a build of your app talks to RevenueDot. Let both run for a few days, then compare them."
        : "Store notifications reach RevenueDot, so it records sales alongside RevenueCat. Next, ship the app update that points your app at RevenueDot. Older versions keep using RevenueCat until you turn it off." },
        { t: "picture", shot: "forwarding", href: dash(c, "/apps"), caption: "The forwarding field on each app's page." },
        app ? { t: "button", label: "How to compare", url: `${docs("migrate/importer")}#check-the-result-with-import-verify` }
          : { t: "button", label: "Plan the app update", url: docs("migrate/sdk-changes") }],
    };
    if (c.sale?.existing) return {
      look: "rich", subject: `RevenueDot recorded its first ${proj(c)} sale`, preheader, heading: "Sales are reaching RevenueDot",
      blocks: [...rows, { t: "lead", text: `Your store is sending purchases and renewals to RevenueDot, so revenue and subscribers for ${proj(c)} update as sales come in.` },
        { t: "picture", shot: "overview", href: dash(c, "/overview"), caption: "Your Overview." },
        { t: "button", label: "See it on your dashboard", url: dash(c, "/overview"), ...(app ? {} : { secondary: { label: "Next: add RevenueDot to your app", url: docs("getting-started/connect-your-app") } }) }],
    };
    return {
      look: "rich", subject: "You made your first real sale", preheader, heading: "Your first real sale",
      blocks: [...rows, { t: "lead", text: `Congratulations. A real customer paid for what you built, and ${proj(c)} is live.` },
        { t: "picture", shot: "overview", href: dash(c, "/overview"), caption: "Revenue, subscribers and trials update as sales come in." },
        { t: "button", label: "See it on your dashboard", url: dash(c, "/overview") }],
    };
  },

  standard_welcome: (c) => ({
    look: "rich",
    subject: "You're on Cloud Standard",
    preheader: "0.5% above $10,000 a month, never more than $999.",
    heading: "You're on Cloud Standard",
    blocks: [
      { t: "receipt", title: "Your plan", rows: [["Plan", "Cloud Standard"], ["Above $10,000 a month", "0.5%"], ["Never more than", "$999 a month"], ["First invoice", "1st of next month"]] },
      { t: "lead", text: "Thank you for upgrading. The rate never rises, and there's no proration. Standard adds single sign-on, organizations and custom roles for your team." },
      { t: "picture", shot: "team", href: `${c.app}/account/billing` },
      { t: "button", label: "See billing and invoices", url: `${c.app}/account/billing` },
    ],
  }),

  teammate_welcome: (c) => ({
    look: "rich",
    subject: `You're in ${proj(c)} on RevenueDot`,
    preheader: "Revenue, subscribers and every purchase, in one place.",
    heading: `Welcome to ${proj(c)}`,
    blocks: [
      { t: "lead", text: `${c.inviter ? `${c.inviter} added you` : "You were added"} to ${proj(c)} on RevenueDot, where the app's purchases, subscribers and revenue live.` },
      { t: "picture", shot: "overview", href: dash(c, "/overview") },
      { t: "list", items: ["**Overview:** revenue, subscribers and trials, compared with the period before.", "**Customers:** look anyone up by user ID, email or transaction ID.", "**Charts:** more than 40, from revenue to trial conversion."] },
      { t: "button", label: "Open the Overview", url: dash(c, "/overview") },
    ],
  }),
};

/** Steps whose footer says they stop once the app is live. */
const ONBOARDING = new Set<StepId>(["welcome", "verify_reminder", "connect_app", "store_keys", "paywall", "need_hand", "side_by_side"]);

// ---------- layout ----------

function render(c: JourneyCtx, m: JourneyMail): Rendered {
  const s = c.step;
  const t = (x: string) => inline(x, s, "text");
  const h = (x: string) => inline(x, s, "html");
  const where = c.to ? `This landed in ${c.to} because you` : "You're getting this because you";
  const reason = ONBOARDING.has(s)
    ? `${where} signed up for RevenueDot Cloud. Setup emails stop once your app is live.`
    : `${where} have a RevenueDot Cloud account.`;
  const prefs = tag(`${c.app}/account/notifications`, s);
  const pad = "&#8203;&nbsp;".repeat(Math.max(0, 110 - m.preheader.length));
  const row = (inner: string, bottom = 22) => `<tr><td style="padding:0 0 ${bottom}px;">${inner}</td></tr>`;
  const label = (x: string) => `<p style="margin:0 0 8px;font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${FG3};">${esc(x)}</p>`;
  const box = (inner: string, style: string) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="${style}">${inner}</td></tr></table>`;

  const progressItems = (current: string) => {
    const p = c.progress ?? { testPurchase: false, app: false, store: false, live: false };
    return [
      { key: "account", label: "Account created", done: true }, { key: "test", label: "Test purchase", done: p.testPurchase },
      { key: "app", label: "App connected", done: p.app }, { key: "store", label: "Store connected", done: p.store },
      { key: "live", label: "First real sale", done: p.live },
    ].map((x) => ({ ...x, current: x.key === current && !x.done }));
  };

  const block = (b: Block): string => {
    switch (b.t) {
      case "lead": return row(`<p style="margin:0;font-size:17px;line-height:27px;color:${INK};">${h(b.text)}</p>`);
      case "p": return row(`<p style="margin:0;font-size:16px;line-height:26px;color:${FG2};">${h(b.text)}</p>`);
      case "h2": return row(`<h2 style="margin:6px 0 0;font-size:19px;line-height:26px;font-weight:700;letter-spacing:-0.01em;color:${INK};">${esc(b.text)}</h2>`, 14);
      case "progress": {
        const items = progressItems(b.current);
        const done = items.filter((x) => x.done).length;
        return row(box(label(`Your setup: ${done} of ${items.length} done`) +
          items.map((x) => `<p style="margin:0 0 6px;font-size:14px;line-height:20px;color:${x.done ? FG3 : INK};${x.current ? "font-weight:700;" : ""}">` +
            `<span style="display:inline-block;width:20px;color:${x.done ? UP : x.current ? GOLD : "#BDBDBD"};">${x.done ? "&#10003;" : x.current ? "&#9679;" : "&#9675;"}</span>` +
            `${esc(x.label)}${x.current ? `<span style="font-weight:500;color:${FG3};">&nbsp; &larr; next</span>` : ""}</p>`).join(""),
          `background:${PANEL};border:1px solid ${BORDER};padding:14px 16px 10px;`));
      }
      case "picture": {
        const v = b.video && VIDEOS[b.video].ready ? b.video : null;
        if (!v && !b.shot && !b.art) return "";
        const src = v ? videoCover(v) : b.art ? artUrl(b.art) : shotUrl(b.shot!);
        const href = tag(v ? videoUrl(v) : b.href ?? `${c.app}/`, s);
        const alt = v ? `Play the video: ${VIDEOS[v].title} (${VIDEOS[v].length})` : b.art ? ART_ALT[b.art] : SHOT_ALT[b.shot!];
        const caption = v
          ? `<a href="${esc(href)}" style="color:${INK};text-decoration:none;"><strong style="font-weight:700;">Watch: ${esc(VIDEOS[v].title)}</strong> <span style="font-family:${MONO};font-size:12px;color:${FG3};">${VIDEOS[v].length}</span></a> <a href="${esc(VIDEOS[v].youtube)}" style="font-size:12px;color:${FG3};text-decoration:underline;">on YouTube</a>${b.caption ? `<br><span style="color:${FG3};">${h(b.caption)}</span>` : ""}`
          : b.caption ? `<span style="color:${FG3};">${h(b.caption)}</span>` : "";
        return row(`<a href="${esc(href)}" style="display:block;text-decoration:none;"><img src="${esc(src)}" width="520" alt="${esc(alt)}" style="display:block;width:100%;max-width:520px;height:auto;border:1px solid ${BORDER};outline:none;background:${PANEL};font-family:${FONT};font-size:14px;color:${FG2};"></a>` +
          (caption ? `<p style="margin:10px 0 0;font-size:14px;line-height:20px;color:${INK};">${caption}</p>` : ""), 26);
      }
      case "stat": return row(`<p style="margin:0;font-size:44px;line-height:50px;font-weight:700;letter-spacing:-0.04em;color:${b.tone === "up" ? UP : INK};">${esc(b.value)}</p><p style="margin:4px 0 0;font-size:14px;line-height:20px;color:${FG3};">${h(b.label)}</p>`);
      case "receipt": return row(box(label(b.title) + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
        b.rows.map(([k, v], i) => `<tr><td style="padding:9px 0;${i ? `border-top:1px dashed ${BORDER};` : ""}font-size:14px;line-height:20px;color:${FG3};">${esc(k)}</td><td style="padding:9px 0;${i ? `border-top:1px dashed ${BORDER};` : ""}font-size:15px;line-height:20px;color:${INK};font-weight:700;text-align:right;">${esc(v)}</td></tr>`).join("") +
        `</table>`, `border:1px solid ${INK};border-top:4px solid ${GOLD};padding:16px 18px 8px;`));
      case "cards": {
        // Fluid columns: two side by side on desktop, stacked on a phone, without media queries.
        const card = (x: { title: string; text: string; link?: { label: string; url: string } }) =>
          `<div style="display:inline-block;width:100%;max-width:251px;vertical-align:top;margin:0 0 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:1px solid ${BORDER};padding:14px 16px;">` +
          `<p style="margin:0 0 6px;font-size:15px;line-height:21px;font-weight:700;color:${INK};">${h(x.title)}</p><p style="margin:0;font-size:14px;line-height:21px;color:${FG2};">${h(x.text)}</p>` +
          (x.link ? `<p style="margin:10px 0 0;font-size:14px;line-height:20px;"><a href="${esc(tag(x.link.url, s))}" style="color:${INK};font-weight:700;text-decoration:none;">${esc(x.link.label)}</a></p>` : "") +
          `</td></tr></table></div>`;
        return `<tr><td style="padding:0 0 10px;font-size:0;line-height:0;">` + b.items.map((x, i) => card(x) + (i % 2 === 0 && i < b.items.length - 1 ? `<div style="display:inline-block;width:18px;"></div>` : "")).join("") + `</td></tr>`;
      }
      case "defs": return row(b.items.map((x, i) => `<p style="margin:${i ? 14 : 0}px 0 0;font-size:15px;line-height:22px;font-weight:700;color:${INK};">${h(x.term)}</p><p style="margin:2px 0 0;font-size:15px;line-height:23px;color:${FG2};">${h(x.text)}</p>`).join(""));
      case "checklist": return row(b.items.map((x) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;"><tr>` +
        `<td valign="top" style="width:30px;padding:3px 0 0;"><div style="width:14px;height:14px;border:2px solid ${INK};"></div></td>` +
        `<td valign="top"><p style="margin:0;font-size:15px;line-height:22px;font-weight:700;color:${INK};">${h(x.title)}</p><p style="margin:2px 0 0;font-size:14px;line-height:22px;color:${FG2};">${h(x.text)}</p></td></tr></table>`).join(""), 12);
      case "ol": return row(`<ol style="margin:0;padding:0 0 0 22px;">` + b.items.map((x) => `<li style="margin:0 0 8px;padding-left:4px;font-size:15px;line-height:23px;color:${FG2};">${h(x)}</li>`).join("") + `</ol>`, 16);
      case "list": return row(`<ul style="margin:0;padding:0 0 0 20px;">` + b.items.map((x) => `<li style="margin:0 0 8px;padding-left:2px;font-size:15px;line-height:23px;color:${FG2};">${h(x)}</li>`).join("") + `</ul>`, 16);
      case "timeline": return row(b.items.map((x, i) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td valign="top" style="width:24px;border-left:2px solid ${i < b.items.length - 1 ? BORDER : "transparent"};"><div style="width:12px;height:12px;border-radius:50%;background:${i === 0 ? GOLD : INK};margin:4px 0 0 -7px;"></div></td>` +
        `<td valign="top" style="padding:0 0 ${i < b.items.length - 1 ? 18 : 0}px;"><p style="margin:0;font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${FG3};">${esc(x.when)}</p>` +
        `<p style="margin:2px 0 0;font-size:16px;line-height:22px;font-weight:700;color:${INK};">${h(x.title)}</p><p style="margin:3px 0 0;font-size:14px;line-height:22px;color:${FG2};">${h(x.text)}</p></td></tr></table>`).join(""));
      case "faq": return row(b.items.map((x, i) => `<div style="${i ? `border-top:1px solid ${BORDER};padding-top:14px;margin-top:14px;` : ""}"><p style="margin:0;font-size:15px;line-height:22px;font-weight:700;color:${INK};">${h(x.q)}</p><p style="margin:4px 0 0;font-size:15px;line-height:23px;color:${FG2};">${h(x.a)}</p></div>`).join(""));
      case "prompts": return row(b.items.map((x) => `<p style="margin:0 0 8px;"><span style="display:inline-block;background:${PANEL};border:1px solid ${BORDER};padding:10px 14px;font-size:14px;line-height:21px;color:${INK};">${esc(x)}</span></p>`).join(""), 14);
      case "code": return row(label(b.label) + box(esc(b.text), `background:${INK};padding:14px 16px;font-family:${MONO};font-size:12.5px;line-height:20px;color:#F5F5F5;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;`), 16);
      case "table": return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${BORDER};">` +
        `<tr>${b.head.map((x, i) => `<td style="padding:10px 14px;background:${PANEL};border-bottom:1px solid ${BORDER};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${FG3};${i ? "text-align:right;" : ""}">${esc(x)}</td>`).join("")}</tr>` +
        b.rows.map((r, ri) => `<tr>${r.map((x, i) => `<td style="padding:11px 14px;${ri < b.rows.length - 1 ? `border-bottom:1px solid ${BORDER};` : ""}font-size:15px;line-height:20px;color:${INK};${i ? `text-align:right;font-family:${MONO};` : "font-weight:600;"}">${esc(x)}</td>`).join("")}</tr>`).join("") +
        `</table>` + (b.note ? `<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${FG3};">${h(b.note)}</p>` : ""));
      case "callout": return row(box(`<p style="margin:0;font-size:14px;line-height:22px;color:${INK};">${h(b.text)}</p>`, `background:${b.tone === "warn" ? "#FFF6EF" : PANEL};border-left:3px solid ${b.tone === "warn" ? DOWN : GOLD};padding:14px 16px;`));
      case "copy": return row(label(b.label) + box(esc(b.text), `border:2px solid ${INK};padding:14px 16px;font-family:${MONO};font-size:15px;line-height:20px;font-weight:600;color:${INK};word-break:break-all;`));
      case "rating": return row(`<p style="margin:0 0 12px;font-size:16px;line-height:24px;font-weight:700;color:${INK};">${esc(b.question)}</p>` +
        // Inline boxes wrap onto a second line on a narrow phone instead of widening the email.
        `<p style="margin:0;font-size:0;line-height:0;">` + Array.from({ length: 11 }, (_, n) => `<a href="${esc(tag(b.url(n), s))}" style="display:inline-block;width:25px;height:34px;margin:0 2px 4px 0;border:1px solid ${INK};font-family:${MONO};font-size:13px;line-height:34px;text-align:center;color:${INK};text-decoration:none;">${n}</a>`).join("") + `</p>` +
        `<p style="margin:4px 0 0;font-size:12px;line-height:18px;color:${FG3};">0 = ${esc(b.low)} | 10 = ${esc(b.high)}</p>`);
      case "choices": return row(b.items.map((x) => `<p style="margin:0 0 8px;"><a href="${esc(tag(x.url, s))}" style="display:inline-block;border:1px solid ${INK};padding:10px 16px;font-size:14px;line-height:20px;font-weight:600;color:${INK};text-decoration:none;">${esc(x.label)}</a></p>`).join(""), 14);
      case "button": return row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${INK};"><a href="${esc(tag(b.url, s))}" style="display:inline-block;padding:15px 26px;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(b.label)}</a></td></tr></table>` +
        (b.secondary ? `<p style="margin:14px 0 0;font-size:14px;line-height:20px;"><a href="${esc(tag(b.secondary.url, s))}" style="color:${INK};text-decoration:underline;text-underline-offset:2px;">${esc(b.secondary.label)}</a></p>` : ""), 30);
    }
  };

  const blockText = (b: Block): string[] => {
    switch (b.t) {
      case "lead": case "p": return [t(b.text), ""];
      case "h2": return [b.text.toUpperCase(), ""];
      case "progress": return [progressItems(b.current).map((x) => `[${x.done ? "x" : " "}] ${x.label}`).join("\n"), ""];
      case "picture": { const v = b.video && VIDEOS[b.video].ready ? b.video : null; return v ? [`Watch: ${VIDEOS[v].title} (${VIDEOS[v].length}): ${tag(videoUrl(v), s)}`, `On YouTube: ${VIDEOS[v].youtube}`, ""] : []; }
      case "stat": return [`${b.value} ${t(b.label)}`, ""];
      case "receipt": return [b.title, ...b.rows.map(([k, v]) => `${k}: ${v}`), ""];
      case "cards": return [...b.items.map((x) => `${t(x.title)}: ${t(x.text)}${x.link ? ` ${x.link.label}: ${tag(x.link.url, s)}` : ""}`), ""];
      case "defs": return [...b.items.map((x) => `${t(x.term)}: ${t(x.text)}`), ""];
      case "checklist": return [...b.items.map((x) => `[ ] ${t(x.title)}: ${t(x.text)}`), ""];
      case "ol": return [...b.items.map((x, i) => `${i + 1}. ${t(x)}`), ""];
      case "list": return [...b.items.map((x) => `- ${t(x)}`), ""];
      case "timeline": return [...b.items.map((x) => `${x.when}, ${t(x.title)}: ${t(x.text)}`), ""];
      case "faq": return b.items.flatMap((x) => [t(x.q), t(x.a), ""]);
      case "prompts": return [...b.items.map((x) => `"${x}"`), ""];
      case "code": return [`${b.label}:`, ...b.text.split("\n").map((l) => `    ${l}`), ""];
      case "table": return [...b.rows.map((r) => `${r[0]}: ${r[1]}, ${r[2]}`), ...(b.note ? [t(b.note)] : []), ""];
      case "callout": return [t(b.text), ""];
      case "copy": return [`${b.label}: ${b.text}`, ""];
      case "rating": return [b.question, ...Array.from({ length: 11 }, (_, n) => `${n}: ${tag(b.url(n), s)}`), ""];
      case "choices": return [...b.items.map((x) => `${x.label}: ${tag(x.url, s)}`), ""];
      case "button": return [`${b.label}: ${tag(b.url, s)}`, ...(b.secondary ? [`${b.secondary.label}: ${tag(b.secondary.url, s)}`] : []), ""];
    }
  };

  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(m.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#FFFFFF;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(m.preheader)}${pad}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;"><tr><td align="center" style="padding:28px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">`;
  const flink = (label: string, url: string) => `<a href="${esc(tag(url, s))}" style="color:${FG3};">${label}</a>`;
  const foot = `<tr><td style="border-top:1px solid ${BORDER};padding:18px 0 0;font-size:12px;line-height:18px;color:${FG3};">${esc(reason)} ` +
    `If you'd rather not get these emails, <a href="${esc(c.unsubscribeUrl)}" style="color:${FG3};">unsubscribe</a> or change your <a href="${esc(prefs)}" style="color:${FG3};">email preferences</a>.` +
    `<br><br>RevenueDot | ${flink("Docs", `${SITE}/docs`)} | ${flink("Blog", `${SITE}/blog`)} | ${flink("GitHub", "https://github.com/revenuedot/revenuedot")}</td></tr></table></td></tr></table></body></html>`;

  let html: string;
  if (m.look === "note") {
    // A plain note from the team: no banner, paragraphs, a sign-off, the logo small at the bottom.
    html = head + m.blocks.map(block).join("") +
      `<tr><td style="padding:0 0 26px;"><p style="margin:0;font-size:16px;line-height:26px;color:${FG2};">The RevenueDot team</p></td></tr>` +
      `<tr><td style="padding:0 0 18px;"><img src="${LOGO_URL}" width="104" height="15" alt="RevenueDot" style="display:block;border:0;outline:none;font-family:${FONT};font-size:13px;font-weight:700;color:${INK};"></td></tr>` + foot;
  } else {
    html = head +
      `<tr><td style="padding:0 0 28px;"><a href="${esc(tag(SITE, s))}"><img src="${LOGO_URL}" width="152" height="22" alt="RevenueDot" style="display:block;border:0;outline:none;font-family:${FONT};font-size:15px;font-weight:700;color:${INK};"></a></td></tr>` +
      (m.eyebrow ? `<tr><td style="padding:0 0 8px;">${label(m.eyebrow)}</td></tr>` : "") +
      (m.heading ? `<tr><td style="padding:0 0 16px;"><h1 style="margin:0;font-size:28px;line-height:34px;font-weight:700;letter-spacing:-0.03em;color:${INK};">${esc(m.heading)}</h1></td></tr>` : "") +
      m.blocks.map(block).join("") +
      `<tr><td style="padding:0 0 22px;font-size:14px;line-height:22px;color:${FG2};"><strong style="color:${INK};">Questions?</strong> Just reply to this email. A person on our team reads every reply.</td></tr>` + foot;
  }

  const text = [
    ...(m.look === "rich" && m.heading ? [m.heading, ""] : []),
    ...m.blocks.flatMap(blockText),
    ...(m.look === "note" ? ["The RevenueDot team", ""] : ["Questions? Just reply to this email. A person on our team reads every reply.", ""]),
    "--", reason, `Email preferences: ${prefs}`, `Unsubscribe: ${c.unsubscribeUrl}`,
  ].join("\n");
  return { subject: m.subject, text, html };
}

/**
 * Values other people control (project, inviter and product names, SDK strings) lose web addresses and the characters
 * the copy's markup uses, so a project called "[Sign in](https://evil.example)" can never become a link in our email.
 */
const plain = (s: string | null | undefined) => (s == null ? s ?? null : s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, "").replace(/[[\]()*`\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || null);

/** The email for one step. */
export function journeyEmail(c: JourneyCtx): Rendered {
  const safe: JourneyCtx = {
    ...c, first: plain(c.first), projectName: plain(c.projectName), inviter: plain(c.inviter),
    sdk: c.sdk ? { platform: plain(c.sdk.platform) ?? "", version: plain(c.sdk.version) ?? "" } : c.sdk,
    sale: c.sale ? { product: plain(c.sale.product) ?? "a product", amount: plain(c.sale.amount), country: plain(c.sale.country), existing: c.sale.existing === true } : c.sale,
  };
  return render(safe, EMAILS[safe.step](safe));
}

export const STEP_IDS = Object.keys(EMAILS) as StepId[];
