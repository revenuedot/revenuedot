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
const LOGO_URL = "https://revenuedot.app/brand/revenuedot-lockup-black@2x.png";
export const SITE = "https://revenuedot.app";
export const BOOKING_URL = "https://calendar.google.com/calendar/appointments/schedules/AcZssZ0IxzgwYNVDGggPF9qelyDSh51L5UzFNcrDE2u3eMTwqpLfGsrRxjx2TxY-WyehZVX1ns8MhQWg";

/** The sender. The Cloud binding must allow this address (cloudflare.config.ts); replies reach the team's inbox. */
export const JOURNEY_FROM = "RevenueDot <hello@mail.revenuedot.app>";
export const JOURNEY_REPLY_TO = "hello@revenuedot.app";

export type VideoId = "first-purchase" | "connect-your-app" | "switch-from-revenuecat" | "paywalls-and-experiments" | "chatgpt-demo";

/**
 * Tutorial videos shown as a playable cover. `youtube` wins once the video is published there; until then the cover opens
 * the video's page on revenuedot.app. Covers (1200×675 JPEG, play button and length drawn in) live in apps/site/public/email/.
 * `ready`: the video has its /watch page and cover live; until then the picture block shows nothing for it.
 */
export const VIDEOS: Record<VideoId, { title: string; length: string; slug: string; youtube?: string; ready: boolean }> = {
  "first-purchase": { title: "Your first purchase in 5 minutes", length: "1:18", slug: "revenuedot-first-purchase", ready: true },
  "connect-your-app": { title: "Connect your app to RevenueDot", length: "1:17", slug: "revenuedot-connect-your-app", ready: true },
  "switch-from-revenuecat": { title: "Switch from RevenueCat without losing a renewal", length: "1:34", slug: "revenuedot-switch-from-revenuecat", ready: true },
  "paywalls-and-experiments": { title: "Build a paywall and test it", length: "1:04", slug: "revenuedot-paywalls-and-experiments", ready: true },
  "chatgpt-demo": { title: "Run your subscriptions from ChatGPT", length: "1:27", slug: "revenuedot-chatgpt-demo", ready: true },
};
export const videoUrl = (id: VideoId) => VIDEOS[id].youtube ?? `${SITE}/watch/${VIDEOS[id].slug}`;
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
  | "welcome" | "verify_reminder" | "first_purchase" | "checkin" | "connect_app" | "ai_setup" | "store_keys" | "go_live" | "need_hand" | "last_call"
  | "switch_plan" | "import_help" | "side_by_side" | "forwarding_check" | "cutover"
  | "first_sale" | "standard_welcome" | "standard_canceled"
  | "paywalls" | "experiments" | "recovery" | "team" | "how_going" | "assistant"
  | "pricing_explainer" | "upgrade_nudge" | "upgrade_personal" | "enterprise"
  | "referral" | "went_quiet" | "teammate_welcome" | "sandbox_only";

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
  sale?: { product: string; amount: string | null; country: string | null } | null;
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
  welcome: (c) => ({
    look: "rich",
    subject: "Welcome to RevenueDot",
    preheader: "Your account is ready. Here's how to get your first purchase working today.",
    heading: c.first ? `Welcome to RevenueDot, ${c.first}` : "Welcome to RevenueDot",
    blocks: [
      { t: "lead", text: "RevenueDot runs your app's in-app purchases and subscriptions. It checks every purchase with Apple and Google, keeps each customer's access in sync across devices, sends webhooks to your backend and charts your revenue." },
      { t: "p", text: "It works with the RevenueCat SDK, so if you've used RevenueCat before, there's nothing new to learn. Here's where you are:" },
      { t: "progress", current: "test" },
      { t: "h2", text: "Where do you want to start?" },
      { t: "cards", items: [
        { title: "I'm new to in-app purchases", text: "Make a test purchase in 5 minutes with the built-in Test Store. You don't need an App Store or Google Play account yet.", link: { label: "Start the quickstart", url: c.pathUrl?.("new") ?? docs("getting-started/quickstart") } },
        { title: "I'm moving from RevenueCat", text: "Keep the SDK your app ships, import your customers, and run both side by side until the numbers match.", link: { label: "Plan your switch", url: c.pathUrl?.("revenuecat") ?? docs("migrate") } },
      ] },
      { t: "picture", video: "first-purchase", caption: "The whole first purchase, from an empty project to an active subscriber." },
      { t: "callout", text: "**Cloud is free until your apps make $10,000 a month.** That includes paywalls, experiments, more than 40 charts, webhooks and integrations, for unlimited apps and teammates. No card needed." },
    ],
  }),

  verify_reminder: (c) => ({
    look: "rich",
    subject: "Confirm your email to create secret API keys",
    preheader: "A fresh link that works for 24 hours.",
    heading: "Confirm your email address",
    blocks: [
      { t: "lead", text: "Your account works, but two things wait for a confirmed email: **secret API keys** for your server and the REST API, and **inviting teammates**." },
      { t: "p", text: "Your first confirmation link has expired, so here is a new one. It works for 24 hours." },
      { t: "button", label: "Confirm my email", url: c.verifyUrl ?? `${c.app}/` },
      { t: "p", text: "If you didn't create a RevenueDot account, you can ignore this email and nothing will happen." },
    ],
  }),

  first_purchase: (c) => ({
    look: "rich",
    subject: "Your first test purchase takes 5 minutes",
    preheader: "No App Store account and no code. Here's exactly what to set up and click.",
    eyebrow: "Getting started",
    heading: "Make your first test purchase",
    blocks: [
      { t: "progress", current: "test" },
      { t: "lead", text: "The fastest way to understand RevenueDot is to buy something. The built-in **Test Store** behaves like the App Store: a purchase creates a customer, unlocks access and fires the same webhooks a real sale does." },
      { t: "picture", video: "first-purchase" },
      { t: "h2", text: "What you'll set up" },
      { t: "defs", items: [
        { term: "A Test Store app", text: "A store that needs no Apple or Google account. Add it under **Apps**." },
        { term: "A product", text: "What the customer buys, such as `pro_monthly`, a subscription that lasts a month." },
        { term: "An entitlement", text: "The access your app checks, such as `pro`. Attach the product to it." },
        { term: "An offering", text: "The set of products your paywall shows. Add one called `default` and make it current." },
      ] },
      { t: "h2", text: "Then buy it" },
      { t: "p", text: "On **Overview**, click **Make a test purchase**, keep the user `test_user_1` and click **Purchase**. Open **Customers** and then `test_user_1`: the `pro` entitlement is active for a month, and every event is listed." },
      { t: "callout", text: `Prefer the terminal? [One script](${docs("getting-started/quickstart")}#2-add-a-test-store-app-a-product-and-an-entitlement) creates the app, three products, the \`pro\` entitlement and a \`default\` offering for you.` },
      { t: "button", label: "Make a test purchase", url: dash(c, "/overview") },
    ],
  }),

  checkin: (c) => ({
    look: "note",
    subject: "What are you building?",
    preheader: "Tell us your stack and we'll send the shortest setup path.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: `${proj(c)} doesn't have an app in it yet, so we wanted to check in. Setup looks different for a Swift app, a Flutter app and an Expo app, and very different if you're moving from RevenueCat.` },
      { t: "p", text: "Reply with your platform and whether you use RevenueCat today, and we'll send back the exact steps for your stack. One line is enough." },
    ],
  }),

  connect_app: (c) => ({
    look: "rich",
    subject: c.testPurchase ? "Your test purchase worked. Now connect your app" : "Connect your app to RevenueDot",
    preheader: "Two settings in the RevenueCat SDK, with code for iOS, Android, React Native and Flutter.",
    eyebrow: "Getting started",
    heading: c.testPurchase ? "Your test purchase worked" : "Connect your app",
    blocks: [
      { t: "progress", current: "app" },
      { t: "lead", text: `${c.testPurchase ? "That purchase ran through the same steps a real App Store sale does. " : ""}Next, connect your real app: you use the official RevenueCat SDK and change two settings, the server address and, on iOS and Android, the signature check. You don't need a RevenueCat account.` },
      { t: "picture", video: "connect-your-app" },
      { t: "h2", text: "Copy the code for your platform" },
      { t: "code", label: "iOS · Swift", text: 'Purchases.proxyURL = URL(\n  string: "https://api.revenuedot.app")!\nPurchases.configure(with:\n  .init(withAPIKey: "test_...")\n  .with(entitlementVerificationMode:\n    .disabled)\n  .build())' },
      { t: "code", label: "Android · Kotlin", text: 'import com.revenuecat.purchases\n  .EntitlementVerificationMode.DISABLED\n\nPurchases.proxyURL =\n  URL("https://api.revenuedot.app")\nPurchases.configure(\n  PurchasesConfiguration\n    .Builder(context, "test_...")\n    .entitlementVerificationMode(\n      DISABLED)\n    .build())' },
      { t: "code", label: "React Native · Expo", text: 'await Purchases.setProxyURL(\n  "https://api.revenuedot.app");\nPurchases.configure({\n  apiKey: "test_...",\n});' },
      { t: "code", label: "Flutter", text: "await Purchases.setProxyURL(\n  'https://api.revenuedot.app');\nawait Purchases.configure(\n  PurchasesConfiguration('test_...'));" },
      { t: "h2", text: "How you'll know it worked" },
      { t: "p", text: "Open the app once. Within a minute the customer appears in **Customers**, and the SDK version shows on the app's page under **Apps**." },
      { t: "callout", tone: "warn", text: "**Test keys only work in debug builds.** A `test_` key in a release build stops the app on purpose. Release builds use your App Store (`appl_`) or Google Play (`goog_`) key." },
      { t: "button", label: "Get your test key", url: dash(c, "/api-keys"), secondary: { label: "Full SDK guides", url: docs("sdks") } },
    ],
  }),

  ai_setup: (c) => ({
    look: "rich",
    subject: "Set up RevenueDot from Claude Code, Cursor or Codex",
    preheader: "One prompt, and your coding agent follows the same quickstart you would.",
    eyebrow: "Getting started",
    heading: "Let your coding agent do the setup",
    blocks: [
      { t: "lead", text: "If an AI agent writes most of your code, it can add purchases too. RevenueDot's docs ship an `llms.txt` file written for agents, so they follow the same quickstart you would." },
      { t: "code", label: "Paste this into your agent", text: "Add in-app purchases with RevenueDot.\nRead https://revenuedot.app/llms.txt\nand follow the quickstart." },
      { t: "h2", text: "What a good run looks like" },
      { t: "list", items: [
        "It installs the RevenueCat SDK for your platform.",
        "It points the SDK at RevenueDot and turns the signature check off where needed.",
        "It loads your current offering and checks the `pro` entitlement before unlocking paid features.",
      ] },
      { t: "callout", text: "**Want the agent to manage RevenueDot too?** Connect `https://mcp.revenuedot.app/mcp` and it can create products, look up customers and check your setup. Anything that moves money waits for your approval." },
      { t: "button", label: "Open the quickstart", url: docs("getting-started/quickstart"), secondary: { label: "Agent skills", url: "https://github.com/revenuedot/agent-skills" } },
    ],
  }),

  store_keys: (c) => ({
    look: "rich",
    subject: "Your app is connected. Next: the App Store and Google Play",
    preheader: "Store credentials let RevenueDot check every purchase and hear about renewals and refunds.",
    eyebrow: "Getting started",
    heading: "Your app reached RevenueDot",
    blocks: [
      { t: "progress", current: "store" },
      { t: "lead", text: c.sdk ? `Your ${c.sdk.platform} app (SDK ${c.sdk.version}) just talked to RevenueDot for the first time.` : "Your app just talked to RevenueDot for the first time." },
      { t: "p", text: "Now connect your stores. With store credentials, RevenueDot checks every purchase with Apple and Google, and hears about renewals, refunds and billing problems the moment they happen, even when nobody opens the app." },
      { t: "picture", shot: "app-store", href: dash(c, "/apps"), caption: "Each app's page shows exactly what's still missing." },
      { t: "h2", text: "App Store" },
      { t: "ol", items: [
        "In App Store Connect, open **Users and Access → Integrations → In-App Purchase** and generate a key.",
        "Download the `.p8` file (Apple lets you download it only once) and note the **Key ID** and **Issuer ID**.",
        "In RevenueDot, open the app, add the file and both IDs, and click **Check credentials**.",
        "Paste the app's notification URL into **App Store Server Notifications**, as both the Production and Sandbox URL, Version 2.",
      ] },
      { t: "h2", text: "Google Play" },
      { t: "p", text: `Add a service account with access to your app, then point real-time developer notifications at RevenueDot. The [Google Play guide](${docs("guides/google-play")}) walks through both.` },
      { t: "button", label: "Add store credentials", url: dash(c, "/apps"), secondary: { label: "App Store guide", url: docs("guides/app-store") } },
    ],
  }),

  go_live: (c) => ({
    look: "rich",
    subject: "Before you ship: your go-live checklist",
    preheader: "Four checks that catch most launch problems.",
    eyebrow: "Getting started",
    heading: "Ready for real customers?",
    blocks: [
      { t: "progress", current: "live" },
      { t: "lead", text: "Your store is connected. Most launch-day problems come from one of these four, so tick them off before you submit your release." },
      { t: "checklist", items: [
        { title: "Credentials pass", text: "Each store app shows a valid result for **Check credentials**." },
        { title: "Store notifications arrive", text: "The app's status reads **Ready**, and App Store Connect sends both Production and Sandbox notifications to RevenueDot, Version 2." },
        { title: "Release builds use store keys", text: "`appl_` or `goog_`, never a `test_` key, and no secret `sk_` key anywhere in the app." },
        { title: "Product IDs match the store exactly", text: "Google Play subscriptions are written as `subscriptionId:basePlanId`." },
      ] },
      { t: "picture", shot: "apps", href: dash(c, "/apps"), caption: "Apps shows each store's status at a glance." },
      { t: "callout", text: "**Try the whole flow in the sandbox first.** A sandbox purchase from a TestFlight or internal-testing build shows up in **Customers**, in the **Sandbox** list." },
      { t: "button", label: "Check your apps", url: dash(c, "/apps"), secondary: { label: "The full checklist", url: `${docs("guides/going-to-production")}#stores` } },
    ],
  }),

  need_hand: (c) => ({
    look: "note",
    subject: "Want help with your setup?",
    preheader: "Book 15 minutes with our team, or reply with where you got stuck.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: c.migrating
        ? "Your RevenueCat data is in, but the side-by-side run hasn't started yet. Forwarding store notifications is the fiddliest part of the switch, and we're happy to set it up with you."
        : "In-app purchases have a lot of moving parts: SDK keys, store credentials, notifications. If something's in the way, we'd like to help." },
      { t: "p", text: `[Book 15 minutes with our team](${BOOKING_URL}) and we'll ${c.migrating ? "set up forwarding" : "get your app connected"} on the call. Or reply with where you got stuck; a screenshot of the error helps.` },
    ],
  }),

  last_call: (c) => ({
    look: "note",
    subject: "Your project is ready whenever you are",
    preheader: "This is our last setup email. Your project stays free.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: `${c.migrating ? (c.importedOn ? "Your side-by-side run hasn't started yet" : "Your RevenueCat import hasn't run yet") : "Your app hasn't connected to RevenueDot yet"}, so this is our last setup email. ${proj(c)} stays free and ready, and you can [pick up where you left off](${dash(c, "/overview")}) any time.` },
      { t: "p", text: "If something didn't work, or RevenueDot is missing something you need, we'd really like to know. Reply with one line; it goes straight to the people who build it." },
    ],
  }),

  switch_plan: (c) => ({
    look: "rich",
    subject: "How to switch from RevenueCat safely, step by step",
    preheader: "Import, run both side by side, then switch. Your app keeps its SDK the whole time.",
    eyebrow: "Switching from RevenueCat",
    heading: "Your switch, step by step",
    blocks: [
      { t: "lead", text: "A safe switch takes a few hours of work spread over a week or two. Your app keeps the RevenueCat SDK, and RevenueCat keeps running until you turn it off, so there's no big-bang moment." },
      { t: "picture", video: "switch-from-revenuecat" },
      { t: "timeline", items: [
        { when: "Day 1", title: "Import", text: "One command copies your apps, products, offerings, customers and purchase history. Running it twice changes nothing." },
        { when: "Day 1 or 2", title: "Run both side by side", text: "Forward store notifications so RevenueCat and RevenueDot both see every renewal. Your app still talks to RevenueCat." },
        { when: "Your next release", title: "Point the SDK at RevenueDot", text: "Set the server address and turn the signature check off, then call `syncPurchases()` once on first launch." },
        { when: "When it matches", title: "Turn RevenueCat off", text: "Once `import verify` shows no differences and few users still run the old version." },
      ] },
      { t: "code", label: "The import", text: "npx revenuedot import \\\n  --from-revenuecat \\\n  --rc-project <your project id> \\\n  --to https://api.revenuedot.app" },
      { t: "p", text: "It asks for a RevenueCat v2 secret key and a RevenueDot secret key, so confirm your email first." },
      { t: "h2", text: "Questions teams ask" },
      { t: "faq", items: [
        { q: "Will our customers notice?", a: "They shouldn't. The app keeps the same SDK and the same products; only the server it talks to changes. Older app versions keep using RevenueCat until you turn it off." },
        { q: "What if the numbers don't match?", a: "Keep RevenueCat on, run `npx revenuedot import verify`, and reply to this email. We'll look at it with you." },
        { q: "Can we leave later?", a: "Yes. RevenueDot is open source, and one command, `npx revenuedot move`, copies your whole project to a RevenueDot server you run yourself." },
      ] },
      { t: "button", label: "Start the import", url: docs("migrate/importer"), secondary: { label: "See what you'd save", url: `${SITE}/tools/revenuecat-fee-calculator` } },
    ],
  }),

  import_help: (c) => ({
    look: "note",
    subject: "Want help with the RevenueCat import?",
    preheader: "Book 15 minutes and we'll run it with you.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: `${proj(c)} doesn't have your RevenueCat data in it yet. The import is one command, but it needs two secret keys and a project ID, and it's easier with someone who has done it before.` },
      { t: "p", text: `[Book 15 minutes with our team](${BOOKING_URL}) and we'll run it together. If you already tried and saw an error, reply with it and we'll take a look.` },
    ],
  }),

  side_by_side: (c) => ({
    look: "rich",
    subject: "Your RevenueCat data is in. Now run both side by side",
    preheader: "Forward store notifications, then point a test build at RevenueDot.",
    eyebrow: "Switching from RevenueCat",
    heading: "Your import is done",
    blocks: [
      ...(c.importedCustomers ? [{ t: "stat", value: c.importedCustomers.toLocaleString("en-US"), label: `customers imported into ${proj(c)}, with their purchase history` } as Block] : []),
      { t: "lead", text: "Next, run RevenueCat and RevenueDot side by side. Both see every renewal, and your production app keeps talking to RevenueCat until you're ready." },
      { t: "checklist", items: [
        { title: "Forward store notifications", text: "On each app's page, paste RevenueCat's notification URL into **Forward notifications to RevenueCat**, then point App Store Connect and Google Play at RevenueDot." },
        { title: "Track new purchases", text: "Turn on **Track new purchases from server-to-server notifications** for each app." },
        { title: "Point a test build at RevenueDot", text: "The server address, and the signature check turned off." },
        { title: "Compare for a week", text: "`npx revenuedot import verify` lists every difference between the two." },
      ] },
      { t: "picture", shot: "forwarding", href: dash(c, "/apps"), caption: "The forwarding field on each app's page." },
      { t: "button", label: "Set up the side-by-side run", url: docs("migrate/dual-run"), secondary: { label: "What differs from RevenueCat", url: docs("migrate/what-differs") } },
    ],
  }),

  forwarding_check: (c) => ({
    look: "rich",
    subject: "No store notifications have reached RevenueDot yet",
    preheader: "Turn on forwarding to RevenueCat first, then point the stores at RevenueDot.",
    eyebrow: "Switching from RevenueCat",
    heading: "RevenueDot can't see renewals yet",
    blocks: [
      { t: "lead", text: `Your import finished${c.importedOn ? ` on ${c.importedOn}` : ""}, but no App Store or Google Play notification has arrived since. Without them, RevenueDot only learns about renewals, refunds and cancellations when a customer opens the app.` },
      { t: "callout", tone: "warn", text: "**Do these in this order.** If the stores point at RevenueDot before forwarding is on, RevenueCat stops hearing about renewals." },
      { t: "ol", items: [
        "On each app's page in RevenueDot, paste RevenueCat's notification URL into **Forward notifications to RevenueCat or your own server**.",
        "In App Store Connect, set RevenueDot's notification URL as the Production and Sandbox URL, Version 2.",
        "In Google Cloud, add a second Pub/Sub push subscription that points at RevenueDot.",
      ] },
      { t: "picture", shot: "forwarding", href: dash(c, "/apps") },
      { t: "button", label: "Open your apps", url: dash(c, "/apps"), secondary: { label: "Forwarding guide", url: docs("migrate/dual-run") } },
    ],
  }),

  cutover: (c) => ({
    look: "rich",
    subject: c.bills && c.bills.revenuecat > c.bills.revenuedot ? `Ready to turn RevenueCat off? You'd save ${usd((c.bills.revenuecat - c.bills.revenuedot) * 12)} a year` : "Ready to turn RevenueCat off?",
    preheader: c.bills ? `At your last 7 days' pace: ${usd(c.bills.revenuedot)} a month on RevenueDot, ${usd(c.bills.revenuecat)} on RevenueCat.` : "Your cutover checklist.",
    eyebrow: "Switching from RevenueCat",
    heading: "A week of live sales on RevenueDot",
    blocks: [
      ...(c.bills && c.bills.revenuecat > c.bills.revenuedot ? [{ t: "stat", value: usd((c.bills.revenuecat - c.bills.revenuedot) * 12), label: "a year saved at your last 7 days' pace", tone: "up" } as Block] : []),
      ...(c.bills ? [{ t: "table", head: ["", "A month", "A year"], rows: [["RevenueCat", usd(c.bills.revenuecat), usd(c.bills.revenuecat * 12)], ["RevenueDot Cloud", usd(c.bills.revenuedot), usd(c.bills.revenuedot * 12)]],
        note: `Based on ${usd(c.projected ?? 0)} a month (${usd(c.last7 ?? 0)} in the last 7 days). RevenueCat charges 1% of all revenue once you pass $2,500 a month; RevenueDot 0.5% above $10,000, capped at $999.` } as Block] : []),
      { t: "p", text: `${proj(c)} has recorded live sales on RevenueDot for a week. Before you turn RevenueCat off:` },
      { t: "checklist", items: [
        { title: "The numbers match", text: "`npx revenuedot import verify` shows no differences." },
        { title: "Few users run the old version", text: "Older versions still talk to RevenueCat, so wait until most users have updated." },
        { title: "Move your webhooks in the same hour", text: "Point your backend's webhooks at RevenueDot in the hour you turn RevenueCat's off." },
      ] },
      { t: "p", text: "Then stop forwarding, and turn RevenueCat off." },
      { t: "button", label: "Open the cutover checklist", url: docs("migrate/cutover-checklist") },
    ],
  }),

  first_sale: (c) => (c.migrating ? {
    look: "rich",
    subject: `RevenueDot just saw ${proj(c)}'s first live sale`,
    preheader: "Store notifications are reaching RevenueDot. Next, compare both sides.",
    eyebrow: "Switching from RevenueCat",
    heading: "Your first live sale is in",
    blocks: [
      ...(c.sale ? [{ t: "receipt", title: "First live sale", rows: [["Product", c.sale.product], ...(c.sale.amount ? [["Amount", c.sale.amount] as [string, string]] : []), ...(c.sale.country ? [["Country", c.sale.country] as [string, string]] : [])] } as Block] : []),
      { t: "lead", text: "Store notifications are reaching RevenueDot, so it now sees sales as they happen, alongside RevenueCat." },
      { t: "p", text: "Let both run for a few days, then compare them with `npx revenuedot import verify`. When there are no differences for a week, you're ready to switch." },
      { t: "button", label: "How to compare", url: `${docs("migrate/importer")}#check-the-result-with-import-verify` },
    ],
  } : {
    look: "rich",
    subject: "You just made your first real sale",
    preheader: c.sale ? `${c.sale.product}${c.sale.amount ? ` for ${c.sale.amount}` : ""}${c.sale.country ? ` from ${c.sale.country}` : ""}.` : "Your first production purchase came through RevenueDot.",
    heading: "Your first real sale",
    blocks: [
      ...(c.sale ? [{ t: "receipt", title: `${proj(c)} · first sale`, rows: [["Product", c.sale.product], ...(c.sale.amount ? [["Amount", c.sale.amount] as [string, string]] : []), ...(c.sale.country ? [["Customer in", c.sale.country] as [string, string]] : [])] } as Block] : []),
      { t: "lead", text: `Congratulations. A real customer just paid for what you built, and ${proj(c)} is live.` },
      { t: "progress", current: "live" },
      { t: "h2", text: "Make the next hundred sales easier" },
      { t: "cards", items: [
        { title: "A paywall you can change", text: "Start from a tested template and change it from the dashboard after one app release.", link: { label: "Paywall templates", url: dash(c, "/paywalls/templates") } },
        { title: "Save failed renewals", text: "Email customers whose card was declined a link to fix it, in your app's name.", link: { label: "Payment recovery", url: dash(c, "/lifecycle/payment-recovery") } },
      ] },
      { t: "button", label: "See it on your dashboard", url: dash(c, "/overview") },
    ],
  }),

  standard_welcome: (c) => ({
    look: "rich",
    subject: "You're on Cloud Standard",
    preheader: "0.5% above $10,000 a month, never more than $999. The rate never rises.",
    heading: "Thank you for upgrading",
    blocks: [
      { t: "receipt", title: "Your plan", rows: [["Plan", "Cloud Standard"], ["Under $10,000 a month", "$0"], ["Above $10,000", "0.5%"], ["Never more than", "$999 a month"], ["First invoice", "1st of next month"]] },
      { t: "lead", text: "The rate never rises, and there's no proration: each month you're billed on what your apps tracked." },
      { t: "h2", text: "What Standard adds" },
      { t: "cards", items: [
        { title: "Single sign-on", text: "SAML or OpenID Connect for your team, and you can require it.", link: { label: "Set up SSO", url: docs("guides/single-sign-on") } },
        { title: "Organizations and roles", text: "Group projects into organizations, and give people custom roles." },
        { title: "Email support", text: "A first reply within 2 business days. Reply to any of our emails to reach us." },
      ] },
      { t: "button", label: "See billing and invoices", url: `${c.app}/account/billing` },
    ],
  }),

  standard_canceled: (c) => ({
    look: "note",
    subject: "What made you leave Standard?",
    preheader: "One click helps. Your apps keep working on Cloud Free.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: "Your account is back on Cloud Free. Your apps, customers and data are unchanged, and nothing stops working." },
      { t: "p", text: "Could you tell us what made you leave? One click is enough:" },
      { t: "choices", items: ["It costs too much", "A feature is missing", "Something didn't work", "We moved to another tool", "We're just pausing"].map((label) => ({ label, url: c.feedbackUrl?.("cancel", label) ?? mailto(`Why I left Standard: ${label}`) })) },
      { t: "p", text: "Or reply with more detail. Every answer reaches the people who build RevenueDot." },
    ],
  }),

  paywalls: (c) => ({
    look: "rich",
    subject: "Hard paywall or free first? What the data says",
    preheader: "Hard-paywall apps convert about five times more users. Here's when free first still wins.",
    eyebrow: "Grow your revenue",
    heading: "Hard paywall or free first?",
    blocks: [
      { t: "lead", text: `Quick question: does ${proj(c)} ask for a subscription before people use it (a hard paywall), or let them use a free version first (freemium)?` },
      { t: "p", text: "There's no universal answer, but across the median app the numbers are hard to ignore:" },
      { t: "table", head: ["", "Hard paywall", "Freemium"], rows: [["Paying by day 35", "10.7%", "2.1%"], ["Revenue per install, day 60", "$3.09", "$0.38"], ["Yearly subscribers after a year", "27%", "28%"], ["Refund rate", "5.8%", "3.4%"]],
        note: "Medians from RevenueCat's State of Subscription Apps 2026 (refunds: 2025 edition)." },
      { t: "p", text: "Free first still wins when your growth comes from the free tier, such as users who invite friends or share what they make. For most other apps, the offer belongs in the first session: about 89% of trials start on install day." },
      { t: "p", text: "The hard paywall's cost is refunds, so make the terms impossible to miss. For example, a trial timeline: **Today: full access. Day 2: we remind you. Day 3: you're charged $39.99 a year.**" },
      { t: "picture", video: "paywalls-and-experiments", caption: "Build that paywall from a template, then test it." },
      { t: "callout", text: "**One release first.** Your app needs one update that shows paywalls with RevenueCatUI's `PaywallView` (iOS SDK 5.83 or later). After that, every change reaches your app on its next launch." },
      { t: "button", label: "Pick a paywall template", url: dash(c, "/paywalls/templates"), secondary: { label: "Read the full comparison", url: `${SITE}/blog/hard-paywall-vs-freemium` } },
    ],
  }),

  experiments: (c) => ({
    look: "rich",
    subject: "Annual first or monthly first?",
    preheader: "The plan you select by default shapes what people buy. An experiment settles which one is right for you.",
    eyebrow: "Grow your revenue",
    heading: "Annual first or monthly first?",
    blocks: [
      { t: "lead", text: `Quick question: on ${proj(c)}'s paywall, which plan is selected when it opens, annual or monthly?` },
      { t: "p", text: "The default shapes both how many people start and how much each one pays, and the right answer differs from app to app. That's what an experiment settles: RevenueDot shows each version to part of your new customers and tells you which earns more." },
      { t: "p", text: "Example: **Annual first** against **Monthly first**, each shown to half of your new customers until both have enough data." },
      { t: "h2", text: "Three tests worth running first" },
      { t: "cards", items: [
        { title: "Plan order", text: "The same plans in another order; the first is the one selected. Judged on how many start a purchase." },
        { title: "Trial length", text: "Each plan swapped for a store product with another trial length, which you create in App Store Connect or Google Play first. Judged on how many end up paying." },
        { title: "Paywall design", text: "A copy of your paywall to change freely. Judged on how many start a purchase." },
      ] },
      { t: "p", text: "Results show the lift with a confidence interval and the chance each version wins, and RevenueDot tells you when a test has enough customers to read." },
      { t: "picture", shot: "experiments", href: dash(c, "/experiments"), caption: "Each test starts from a template that fills in its metrics." },
      { t: "button", label: "Start an experiment", url: dash(c, "/experiments/new"), secondary: { label: "How experiments work", url: docs("guides/experiments") } },
    ],
  }),

  recovery: (c) => ({
    look: "rich",
    subject: "What happens when a subscriber's card fails?",
    preheader: "When a renewal fails, email the customer a link to fix their payment, in your app's name.",
    eyebrow: "Grow your revenue",
    heading: "Save renewals that fail",
    blocks: [
      { t: "lead", text: `Quick question: what happens today when a ${proj(c)} subscriber's card fails at renewal?` },
      { t: "p", text: "Usually the card expired or the bank said no, and the customer never chose to leave. Apple and Google retry the charge for a while. RevenueDot can also ask the customer to fix it, with an email in your app's name." },
      { t: "picture", art: "recovery-email", href: dash(c, "/lifecycle/payment-recovery"), caption: "What your customer receives, from your app's name. You can edit every word." },
      { t: "h2", text: "How it works" },
      { t: "defs", items: [
        { term: "A case opens", text: "The moment a store reports a billing problem: App Store billing retry, Google Play grace period or account hold, or a Stripe past-due." },
        { term: "Emails go out", text: "Three by default, on days 0, 3 and 7, each with a link to fix the payment. You can change the days and words, and add up to five." },
        { term: "You see what came back", text: "A case counts as recovered when the subscription renews within the recovery window, 30 days by default, with the revenue it saved." },
      ] },
      { t: "callout", text: "Emails go only to customers with an email address on file, set as the `$email` attribute from your app or backend." },
      { t: "button", label: "Turn on payment recovery", url: dash(c, "/lifecycle/payment-recovery") },
    ],
  }),

  team: (c) => ({
    look: "rich",
    subject: `Invite your team to ${proj(c)}`,
    preheader: "Seats are free, and each person gets the access they need.",
    eyebrow: "Grow your revenue",
    heading: "Bring your team in",
    blocks: [
      { t: "lead", text: `${proj(c)} has one person in it so far. Seats are free and unlimited, so bring in whoever touches revenue, with the access they need and nothing more.` },
      { t: "cards", items: [
        { title: "Developer", text: "For engineers. Apps, products, customers and integrations, but no secret keys or member changes." },
        { title: "Viewer", text: "For founders, growth and finance. Every chart and customer, with no way to change anything." },
        { title: "Admin", text: "For whoever owns the account. Everything, including keys and members." },
      ] },
      { t: "picture", shot: "team", href: dash(c, "/settings/collaborators") },
      { t: "button", label: "Invite a teammate", url: dash(c, "/settings/collaborators") },
    ],
  }),

  how_going: (c) => ({
    look: "note",
    subject: "A quick question about RevenueDot",
    preheader: "One click: how likely are you to recommend RevenueDot?",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: `${proj(c)} has been selling through RevenueDot since ${c.liveSince ?? "your first sale"}. Thank you for building on us.` },
      { t: "rating", question: "How likely are you to recommend RevenueDot to another developer?", low: "Not likely", high: "Very likely", url: (n) => c.feedbackUrl?.("nps", String(n)) ?? mailto(`My score: ${n}`) },
      { t: "p", text: "If there's one thing you'd change, reply and tell us. We read every answer." },
    ],
  }),

  assistant: (c) => ({
    look: "rich",
    subject: "Ask ChatGPT or Claude about your subscriptions",
    preheader: "Look up customers, grant access and check your setup in plain words.",
    eyebrow: "Grow your revenue",
    heading: "Run your subscriptions from chat",
    blocks: [
      { t: "lead", text: "Connect RevenueDot to ChatGPT, Claude or Cursor, and handle the everyday work in plain words." },
      { t: "picture", video: "chatgpt-demo" },
      { t: "h2", text: "Things you can ask" },
      { t: "prompts", items: ["Why didn't user_42 get Pro?", "Give this customer 7 days of Pro.", "Which webhooks failed today?", "How did MRR change this week?"] },
      { t: "h2", text: "You decide what it may do" },
      { t: "defs", items: [
        { term: "Read only", text: "Catalog, customers, events, transactions, webhooks and metrics." },
        { term: "Read and change", text: "Also create products and offerings, grant access and manage webhooks." },
        { term: "Money actions", text: "A separate switch for refunds, cancellations and extensions. Each one still asks you first." },
      ] },
      { t: "code", label: "Connector URL", text: "https://mcp.revenuedot.app/mcp" },
      { t: "button", label: "Connect an assistant", url: docs("guides/connect-ai-assistants") },
    ],
  }),

  pricing_explainer: (c) => ({
    look: "rich",
    subject: "Your apps passed $5,000 this month. Here's how your bill works",
    preheader: "Cloud is free under $10,000 a month. Here's exactly what it costs as you grow.",
    eyebrow: "Billing",
    heading: "No surprises on your bill",
    blocks: [
      { t: "stat", value: usd(c.tracked ?? 0), label: `tracked so far in ${c.month ?? "this month"}`, tone: "up" },
      { t: "lead", text: "Congratulations on the growth. Cloud stays free until your apps track $10,000 in a month. Above that, Cloud Standard costs 0.5% of the revenue above $10,000, and never more than $999 a month." },
      ...(c.priceRows ? [{ t: "table", head: ["Monthly revenue", "RevenueDot", "RevenueCat"], rows: c.priceRows.map(([r, rd, rc]) => [usd(r), usd(rd), usd(rc)] as [string, string, string]),
        note: "Tracked revenue is store revenue before Apple and Google take their cut. RevenueCat charges 1% of all revenue once you pass $2,500 a month." } as Block] : []),
      { t: "p", text: "You can add a card now and pay nothing: Standard is $0 until you pass $10,000, and your apps keep working on either plan." },
      { t: "button", label: "See plans and usage", url: `${c.app}/account/billing` },
    ],
  }),

  upgrade_nudge: (c) => ({
    look: "rich",
    subject: "Your apps outgrew Cloud Free",
    preheader: c.bills ? `On ${usd(c.overTracked ?? 0)} a month, Standard costs ${usd(c.bills.revenuedot)}.` : "0.5% above $10,000, capped at $999 a month.",
    eyebrow: "Billing",
    heading: "Time to move to Cloud Standard",
    blocks: [
      { t: "lead", text: `Your apps tracked **${usd(c.overTracked ?? 0)}** in ${c.overMonth ?? "a month"}, past Cloud Free's $10,000. Your apps keep working either way; Standard is the plan built for apps your size.` },
      ...(c.bills ? [{ t: "table", head: [`At ${usd(c.overTracked ?? 0)} a month`, "A month", "A year"], rows: [["RevenueCat", usd(c.bills.revenuecat), usd(c.bills.revenuecat * 12)], ["RevenueDot Standard", usd(c.bills.revenuedot), usd(c.bills.revenuedot * 12)]] } as Block] : []),
      { t: "h2", text: "What changes when you upgrade" },
      { t: "list", items: ["Single sign-on, organizations and custom roles for your team.", "Email support with a first reply within 2 business days.", "A bill that's capped at $999 a month, with a rate that never rises."] },
      { t: "p", text: "Billing starts on the 1st of next month, with no proration. Checkout takes your company name and tax ID for invoices." },
      { t: "button", label: "Upgrade to Standard", url: `${c.app}/account/billing` },
    ],
  }),

  upgrade_personal: (c) => ({
    look: "note",
    subject: "Anything in the way of upgrading?",
    preheader: "If checkout or invoices are a problem, reply and we'll sort it out.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: `Your apps passed $10,000 in tracked revenue in ${c.overMonth ?? "a recent month"} (${usd(c.overTracked ?? 0)}), and the account is still on Cloud Free. Congratulations on the growth.` },
      { t: "p", text: `If something is in the way of [upgrading to Standard](${c.app}/account/billing), such as your company name and tax ID on invoices, a different billing email, or a question about how the bill works, reply and tell us. We'll sort it out.` },
    ],
  }),

  enterprise: (c) => ({
    look: "rich",
    subject: "An SLA and a named engineer for your apps",
    preheader: `Your apps tracked ${usd(c.tracked ?? 0)} this month. Here's what Enterprise adds at that size.`,
    eyebrow: "Enterprise",
    heading: "Built for apps your size",
    blocks: [
      { t: "stat", value: usd(c.tracked ?? 0), label: "tracked so far this month", tone: "up" },
      { t: "lead", text: "At this size, a failed purchase costs real money every minute, and procurement starts asking about contracts. That's what our Enterprise plan is for." },
      { t: "cards", items: [
        { title: "Uptime SLA", text: "99.9% a month on the purchase path, with service credits." },
        { title: "A named engineer", text: "Faster support, including for purchases that fail at any hour." },
        { title: "Your paperwork", text: "A DPA, security reviews and questionnaires, done with your team." },
        { title: "Your own cloud", text: "Run RevenueDot yourself under a commercial licence, with every Enterprise feature." },
      ] },
      { t: "button", label: "Book a call", url: BOOKING_URL },
    ],
  }),

  referral: (c) => ({
    look: "rich",
    subject: "Know a team paying RevenueCat 1%?",
    preheader: "Share your link with a founder who should switch. We'll help them move.",
    eyebrow: "Share RevenueDot",
    heading: "Know a team that should switch?",
    blocks: [
      { t: "lead", text: `${proj(c)} has been selling through RevenueDot since ${c.liveSince ?? "your first sale"}. If you know a founder still paying 1% of revenue for subscriptions, send them your link.` },
      ...(c.referralUrl ? [{ t: "copy", label: "Your link", text: c.referralUrl } as Block] : []),
      { t: "h2", text: "What they get" },
      { t: "list", items: ["Free until their apps make $10,000 a month, then 0.5% above that, capped at $999.", "The same RevenueCat SDK they ship today, pointed at RevenueDot.", "Our team's help with the import and the side-by-side run."] },
      ...(c.referralUrl ? [{ t: "button", label: "Share on X", url: `https://x.com/intent/post?text=${encodeURIComponent(`I run my app's subscriptions on @revenuedot: open source, works with the RevenueCat SDK, free up to $10K a month. ${c.referralUrl}`)}`, secondary: { label: "Share on LinkedIn", url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(c.referralUrl)}` } } as Block] : []),
    ],
  }),

  sandbox_only: (c) => ({
    look: "note",
    subject: "Your sandbox purchases work. Is your release live yet?",
    preheader: "Everything's connected. Here's what usually holds up the first real sale.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: `${proj(c)}'s store is connected and its sandbox purchases come through, but no real sale has arrived yet. Usually that just means the release with RevenueDot is still waiting for App Review.` },
      { t: "p", text: `If it's already live, check two things: the release build uses your store key (\`appl_\` or \`goog_\`), not the \`test_\` one, and your products are approved in the store. You can see what has arrived so far in [Customers](${dash(c, "/customers")}).` },
      { t: "p", text: "If anything looks off, reply and we'll take a look with you." },
    ],
  }),

  went_quiet: (c) => ({
    look: "note",
    subject: `Is everything OK with ${proj(c)}?`,
    preheader: "Your app hasn't reached RevenueDot for a week.",
    blocks: [
      { t: "p", text: hi(c) },
      { t: "p", text: `${proj(c)}'s app hasn't talked to RevenueDot for a week${c.lastSaleAt ? `, and its last sale was on ${c.lastSaleAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}` : ""}. That can mean a paused app, a release that changed the server address, or a problem on our side.` },
      { t: "p", text: `If something broke, reply and we'll look into it within one business day. You can also check each app's status on the [Apps page](${dash(c, "/apps")}). If you moved to something else, we'd be grateful to hear why.` },
    ],
  }),

  teammate_welcome: (c) => ({
    look: "rich",
    subject: `You're in ${proj(c)} on RevenueDot`,
    preheader: "Where things are, in one minute.",
    heading: `Welcome to ${proj(c)}`,
    blocks: [
      { t: "lead", text: `${c.inviter ? `${c.inviter} added you` : "You were added"} to ${proj(c)} on RevenueDot, where the app's purchases, subscribers and revenue live. Here's where to find things.` },
      { t: "picture", shot: "overview", href: dash(c, "/overview") },
      { t: "cards", items: [
        { title: "Overview", text: "Revenue, MRR, trials and new customers, compared with the period before." },
        { title: "Customers", text: "Anyone by app user ID, email or transaction ID, with their full history." },
        { title: "Charts", text: "More than 40 charts, from MRR to trial conversion and cohorts." },
        { title: "Paywalls and experiments", text: "The screens customers buy on, and the tests running on them." },
      ] },
      { t: "button", label: "Open the project", url: dash(c, "/overview") },
    ],
  }),
};

/** Steps whose footer says they stop once the app is live. */
const ONBOARDING = new Set<StepId>(["sandbox_only", "welcome", "verify_reminder", "first_purchase", "checkin", "connect_app", "ai_setup", "store_keys", "go_live", "need_hand", "last_call", "switch_plan", "import_help", "side_by_side", "forwarding_check"]);

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
        return row(box(label(`Your setup · ${done} of ${items.length} done`) +
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
          ? `<a href="${esc(href)}" style="color:${INK};text-decoration:none;">&#9654;&nbsp; <strong style="font-weight:700;">Watch: ${esc(VIDEOS[v].title)}</strong> <span style="font-family:${MONO};font-size:12px;color:${FG3};">${VIDEOS[v].length}</span></a>${b.caption ? `<br><span style="color:${FG3};">${h(b.caption)}</span>` : ""}`
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
          (x.link ? `<p style="margin:10px 0 0;font-size:14px;line-height:20px;"><a href="${esc(tag(x.link.url, s))}" style="color:${INK};font-weight:700;text-decoration:none;">${esc(x.link.label)} &rarr;</a></p>` : "") +
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
      case "prompts": return row(b.items.map((x) => `<p style="margin:0 0 8px;"><span style="display:inline-block;background:${PANEL};border:1px solid ${BORDER};border-radius:16px;padding:7px 14px;font-size:14px;line-height:20px;color:${INK};">&ldquo;${esc(x)}&rdquo;</span></p>`).join(""), 14);
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
        `<p style="margin:4px 0 0;font-size:12px;line-height:18px;color:${FG3};">0 = ${esc(b.low)} &middot; 10 = ${esc(b.high)}</p>`);
      case "choices": return row(b.items.map((x) => `<p style="margin:0 0 8px;"><a href="${esc(tag(x.url, s))}" style="display:inline-block;border:1px solid ${INK};padding:10px 16px;font-size:14px;line-height:20px;font-weight:600;color:${INK};text-decoration:none;">${esc(x.label)}</a></p>`).join(""), 14);
      case "button": return row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${INK};"><a href="${esc(tag(b.url, s))}" style="display:inline-block;padding:15px 26px;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(b.label)} &rarr;</a></td></tr></table>` +
        (b.secondary ? `<p style="margin:14px 0 0;font-size:14px;line-height:20px;"><a href="${esc(tag(b.secondary.url, s))}" style="color:${INK};text-decoration:underline;text-underline-offset:2px;">${esc(b.secondary.label)}</a></p>` : ""), 30);
    }
  };

  const blockText = (b: Block): string[] => {
    switch (b.t) {
      case "lead": case "p": return [t(b.text), ""];
      case "h2": return [b.text.toUpperCase(), ""];
      case "progress": return [progressItems(b.current).map((x) => `[${x.done ? "x" : " "}] ${x.label}`).join("\n"), ""];
      case "picture": { const v = b.video && VIDEOS[b.video].ready ? b.video : null; return v ? [`Watch: ${VIDEOS[v].title} (${VIDEOS[v].length}): ${tag(videoUrl(v), s)}`, ""] : []; }
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
    `<br><br>RevenueDot &middot; ${flink("Docs", `${SITE}/docs`)} &middot; ${flink("Blog", `${SITE}/blog`)} &middot; ${flink("GitHub", "https://github.com/revenuedot/revenuedot")}</td></tr></table></td></tr></table></body></html>`;

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
    sale: c.sale ? { product: plain(c.sale.product) ?? "a product", amount: plain(c.sale.amount), country: plain(c.sale.country) } : c.sale,
  };
  return render(safe, EMAILS[safe.step](safe));
}

export const STEP_IDS = Object.keys(EMAILS) as StepId[];
