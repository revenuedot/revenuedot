/**
 * Onboarding and growth emails to RevenueDot Cloud accounts (prd/onboarding-emails/PRD.md). Brand emails from RevenueDot,
 * built for skimming: an eyebrow, a short heading, one or two short lines, a visual (a playable video cover or a real
 * dashboard screenshot), numbered steps of one line each, one button, a "Good to know" box. In DESIGN.md's tokens: white,
 * near-black ink, grey hairlines, square corners. Copy uses a tiny inline markup: **bold**, `code` and [label](url).
 * Every link to our own hosts gets UTM tags.
 */
import { esc, type Rendered } from "./templates.js";

const INK = "#0A0A0A", FG2 = "#525252", FG3 = "#737373", BORDER = "#E5E5E5", PANEL = "#F7F7F7", GOLD = "#F7B500";
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
 * `ready`: the video has its /watch page and cover live; until then the email shows its screenshot instead.
 */
export const VIDEOS: Record<VideoId, { title: string; length: string; slug: string; youtube?: string; ready: boolean }> = {
  "first-purchase": { title: "Your first purchase in 5 minutes", length: "1:18", slug: "revenuedot-first-purchase", ready: true },
  "connect-your-app": { title: "Connect your app to RevenueDot", length: "1:15", slug: "revenuedot-connect-your-app", ready: false },
  "switch-from-revenuecat": { title: "Switch from RevenueCat without losing a renewal", length: "1:40", slug: "revenuedot-switch-from-revenuecat", ready: false },
  "paywalls-and-experiments": { title: "Build a paywall and test it", length: "1:30", slug: "revenuedot-paywalls-and-experiments", ready: false },
  "chatgpt-demo": { title: "Run your subscriptions from ChatGPT", length: "1:27", slug: "revenuedot-chatgpt-demo", ready: true },
};
export const videoUrl = (id: VideoId) => VIDEOS[id].youtube ?? `${SITE}/watch/${VIDEOS[id].slug}`;
export const videoCover = (id: VideoId) => `${SITE}/email/${VIDEOS[id].slug}.jpg`;

/** Dashboard screenshots framed for email (apps/site/scripts/email-shots.mjs), 1200×675 in apps/site/public/email/shots/. */
export type Shot = "checklist" | "overview" | "customers" | "apps" | "app-store" | "forwarding" | "api-keys" | "paywall-templates" | "experiments" | "recovery" | "team" | "charts";
export const shotUrl = (s: Shot) => `${SITE}/email/shots/${s}.jpg`;
/** What each screenshot shows, for readers whose email client blocks images. */
const SHOT_ALT: Record<Shot, string> = {
  checklist: "The setup checklist on the RevenueDot Overview", overview: "The RevenueDot Overview with revenue, MRR and trials",
  customers: "The Customers list in RevenueDot", apps: "The Apps page in RevenueDot with each app's status",
  "app-store": "An App Store app's setup checklist in RevenueDot", forwarding: "The field that forwards store notifications to RevenueCat",
  "api-keys": "The API keys page in RevenueDot", "paywall-templates": "Paywall templates in RevenueDot",
  experiments: "Experiment templates in RevenueDot", recovery: "Payment recovery in RevenueDot", team: "Project members and roles in RevenueDot",
  charts: "A revenue chart in RevenueDot",
};

export type StepId =
  | "welcome" | "verify_reminder" | "first_purchase" | "checkin" | "connect_app" | "ai_setup" | "store_keys" | "go_live" | "need_hand" | "last_call"
  | "switch_plan" | "import_help" | "side_by_side" | "forwarding_check" | "cutover"
  | "first_sale" | "standard_welcome" | "standard_canceled"
  | "paywalls" | "experiments" | "recovery" | "team" | "how_going" | "assistant"
  | "pricing_explainer" | "upgrade_nudge" | "upgrade_personal" | "enterprise"
  | "referral" | "referral_joined" | "went_quiet" | "teammate_welcome";

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
  verifyUrl?: string;
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
}

interface JourneyMail {
  subject: string;
  preheader: string;
  /** A small label above the heading: where this email sits ("Setup · step 2 of 5"). */
  eyebrow: string;
  heading: string;
  /** One or two short lines. */
  intro: string[];
  /** The picture: a video (its cover while it is ready, else the screenshot) or a screenshot. */
  visual?: { video?: VideoId; shot?: Shot; href?: string };
  steps?: { title: string; text?: string }[];
  code?: { label: string; text: string };
  table?: { head: [string, string, string]; rows: [string, string, string][]; note?: string };
  /** A box with something to copy (a referral link). */
  copyBox?: { label: string; text: string };
  button?: { label: string; url: string };
  /** "Good to know": one to three short lines. */
  tips?: string[];
  /** Up to three small links under the button. */
  links?: { label: string; url: string }[];
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

const proj = (c: JourneyCtx) => c.projectName ?? "your project";
const dash = (c: JourneyCtx, path: string) => (c.projectId ? `${c.app}/projects/${c.projectId}${path}` : `${c.app}/`);
const docs = (path: string) => `${SITE}/docs/${path}`;
const setup = (n: number) => `Setup · step ${n} of 5`;
const SWITCH = "Switching from RevenueCat";
const GROW = "Grow your revenue";
const BILLING = "Billing";

// ---------- the emails ----------

const EMAILS: Record<StepId, (c: JourneyCtx) => JourneyMail> = {
  welcome: (c) => ({
    subject: "Welcome to RevenueDot: pick your first step",
    preheader: "Make a test purchase in 5 minutes, or plan your switch from RevenueCat.",
    eyebrow: "Welcome",
    heading: c.first ? `Welcome, ${c.first}` : "Welcome to RevenueDot",
    intro: ["Your account is ready. Pick the path that fits you."],
    visual: { video: "first-purchase", shot: "checklist" },
    steps: [
      { title: `[New to in-app purchases →](${c.pathUrl?.("new") ?? docs("getting-started/quickstart")})`, text: "Make a test purchase in 5 minutes. No App Store account needed." },
      { title: `[Already on RevenueCat →](${c.pathUrl?.("revenuecat") ?? docs("migrate")})`, text: "Keep your SDK and run both side by side until the numbers match." },
    ],
    button: { label: "Make a test purchase", url: c.pathUrl?.("new") ?? docs("getting-started/quickstart") },
    tips: ["Cloud is **free** until your apps make $10,000 a month. No card needed."],
  }),

  verify_reminder: (c) => ({
    subject: "Confirm your email to create secret API keys",
    preheader: "A fresh link that works for 24 hours.",
    eyebrow: "Your account",
    heading: "Confirm your email",
    intro: ["Secret API keys and team invites need a confirmed email. Your first link expired, so here's a new one."],
    button: { label: "Confirm my email", url: c.verifyUrl ?? `${c.app}/` },
    tips: ["The link works for **24 hours**.", "Didn't sign up? Ignore this email and nothing happens."],
  }),

  first_purchase: (c) => ({
    subject: "Make your first test purchase in 5 minutes",
    preheader: "No App Store or Google Play account needed.",
    eyebrow: setup(1),
    heading: "Make your first test purchase",
    intro: ["The built-in **Test Store** works like a real store. See a customer, an entitlement and webhooks in 5 minutes."],
    visual: { video: "first-purchase", shot: "checklist" },
    steps: [
      { title: "Add a Test Store app", text: "Then a product, such as `pro_monthly`." },
      { title: "Create the `pro` entitlement", text: "Attach the product to it." },
      { title: "Buy it", text: "Make an offering current, then click **Make a test purchase**." },
    ],
    button: { label: "Make a test purchase", url: dash(c, "/overview") },
    links: [{ label: "Quickstart guide", url: docs("getting-started/quickstart") }, { label: "Seed it with one command", url: `${docs("getting-started/quickstart")}#2-add-a-test-store-app-a-product-and-an-entitlement` }],
  }),

  checkin: (c) => ({
    subject: "What are you building?",
    preheader: "Reply with your stack and we'll send the fastest setup path.",
    eyebrow: "Setup",
    heading: "What are you building?",
    intro: [`${proj(c)} has no app yet. Reply with your stack, and we'll send you the fastest setup path.`],
    visual: { shot: "checklist" },
    steps: [
      { title: "Your platform", text: "Swift, Kotlin, Flutter, React Native or Expo." },
      { title: "Your store", text: "App Store, Google Play or web." },
      { title: "RevenueCat today?", text: "Yes or no." },
    ],
    button: { label: "Reply with your stack", url: "mailto:hello@revenuedot.app?subject=What%20I'm%20building" },
  }),

  connect_app: (c) => ({
    subject: c.testPurchase ? "It works. Now connect your app" : "Connect your app to RevenueDot",
    preheader: "Add the SDK, point it at RevenueDot, and start with your test key.",
    eyebrow: setup(2),
    heading: c.testPurchase ? "It works. Now connect your app" : "Connect your app",
    intro: ["RevenueDot works with the RevenueCat SDK. You don't need a RevenueCat account."],
    visual: { video: "connect-your-app", shot: "api-keys" },
    steps: [
      { title: "Add the SDK to your app", text: "The RevenueCat SDK for your platform." },
      { title: "Point it at RevenueDot", text: "Set the URL and turn the signature check off." },
      { title: "Use your `test_` key", text: "Copy it from **API keys**." },
    ],
    code: { label: "iOS (Swift)", text: 'Purchases.proxyURL = URL(\n  string: "https://api.revenuedot.app")!\nPurchases.configure(with:\n  .init(withAPIKey: "test_...")\n  .with(entitlementVerificationMode:\n    .disabled)\n  .build())' },
    button: { label: "Get your API key", url: dash(c, "/api-keys") },
    links: [{ label: "iOS", url: docs("sdks/ios") }, { label: "Android", url: docs("sdks/android") }, { label: "React Native", url: docs("sdks/react-native") }, { label: "Flutter", url: docs("sdks/flutter") }],
  }),

  ai_setup: (c) => ({
    subject: "Let your AI coding tool set up RevenueDot",
    preheader: "Claude Code, Cursor or Codex can add purchases from one prompt.",
    eyebrow: setup(2),
    heading: "Let your AI tool do the setup",
    intro: ["Claude Code, Cursor and Codex can add purchases to your app. Our docs are written for them."],
    code: { label: "Paste this prompt", text: "Add in-app purchases with RevenueDot. Read https://revenuedot.app/llms.txt and follow the quickstart." },
    button: { label: "Open the quickstart", url: docs("getting-started/quickstart") },
    links: [{ label: "llms.txt", url: `${SITE}/llms.txt` }, { label: "Agent skills", url: "https://github.com/revenuedot/agent-skills" }],
  }),

  store_keys: (c) => ({
    subject: "Your app reached RevenueDot. Next: the stores",
    preheader: "Add App Store and Google Play credentials so real purchases are checked.",
    eyebrow: setup(3),
    heading: "Your app is connected",
    intro: [c.sdk ? `Your ${c.sdk.platform} app (SDK ${c.sdk.version}) just reached RevenueDot. Next, connect your stores.` : "Your app just reached RevenueDot. Next, connect your stores."],
    visual: { shot: "app-store" },
    steps: [
      { title: "App Store", text: "An In-App Purchase key (.p8) and the notifications URL." },
      { title: "Google Play", text: "A service account and real-time notifications." },
      { title: "Web", text: "Connect Stripe in one click." },
    ],
    button: { label: "Add store credentials", url: dash(c, "/apps") },
    links: [{ label: "App Store guide", url: docs("guides/app-store") }, { label: "Google Play guide", url: docs("guides/google-play") }],
  }),

  go_live: (c) => ({
    subject: "Your go-live checklist",
    preheader: "Four checks before real customers buy.",
    eyebrow: setup(4),
    heading: "Four checks before you ship",
    intro: ["Your store is connected. These are the checks teams miss most."],
    visual: { shot: "apps" },
    steps: [
      { title: "Credentials are valid", text: "**Check credentials** passes on each app." },
      { title: "Notifications arrive", text: "The app shows **Ready**." },
      { title: "Release builds use store keys", text: "`appl_` or `goog_`, never `test_` or `sk_`." },
      { title: "Product IDs match the store", text: "Play subscriptions as `subscriptionId:basePlanId`." },
    ],
    button: { label: "Check your apps", url: dash(c, "/apps") },
    links: [{ label: "Full checklist", url: `${docs("guides/going-to-production")}#stores` }, { label: "Sandbox testing", url: docs("guides/sandbox-testing") }],
  }),

  need_hand: (c) => ({
    subject: "Want help with the setup?",
    preheader: "Book 15 minutes with our team, or reply with where you got stuck.",
    eyebrow: c.migrating ? SWITCH : setup(2),
    heading: "Let's set it up together",
    intro: [c.migrating ? "Your data is in. We'll help you set up forwarding on a 15-minute call." : "We'll connect your app with you on a 15-minute call."],
    visual: { shot: c.migrating ? "apps" : "checklist" },
    button: { label: "Book 15 minutes", url: BOOKING_URL },
    tips: ["Prefer email? Reply with where you got stuck. A screenshot helps."],
  }),

  last_call: (c) => ({
    subject: "Your project is ready when you are",
    preheader: "This is our last setup email. Your project stays free.",
    eyebrow: c.migrating ? SWITCH : "Setup",
    heading: "Your project is ready when you are",
    intro: [`${c.migrating ? (c.importedOn ? "Your side-by-side run hasn't started" : "Your import hasn't started") : "Your app hasn't connected"} yet, so this is our last setup email. ${proj(c)} stays free and ready.`],
    visual: { shot: "checklist" },
    button: { label: "Pick up where you left off", url: dash(c, "/overview") },
    tips: ["Something didn't work, or something is missing? Reply and tell us. It helps us fix it."],
  }),

  switch_plan: (c) => ({
    subject: "Switch from RevenueCat in 3 steps",
    preheader: "Keep your SDK. Run both side by side until the numbers match.",
    eyebrow: SWITCH,
    heading: "Switch in 3 steps",
    intro: ["Your app keeps the RevenueCat SDK. RevenueCat keeps running until you turn it off."],
    visual: { video: "switch-from-revenuecat", shot: "customers" },
    steps: [
      { title: "Import", text: "One command copies products, customers and history." },
      { title: "Run both", text: "Forward store notifications so both see every renewal." },
      { title: "Switch", text: "Point the SDK at RevenueDot in your next release." },
    ],
    code: { label: "Import command", text: "npx revenuedot import \\\n  --from-revenuecat \\\n  --rc-project <your project id> \\\n  --to https://api.revenuedot.app" },
    button: { label: "Start the import", url: docs("migrate/importer") },
    tips: ["The import needs a **RevenueCat v2 secret key** and a **RevenueDot secret key**, so confirm your email first."],
    links: [{ label: "See what you'd save", url: `${SITE}/tools/revenuecat-fee-calculator` }, { label: "Side-by-side run", url: docs("migrate/dual-run") }],
  }),

  import_help: (c) => ({
    subject: "Want help with the RevenueCat import?",
    preheader: "Book 15 minutes and we'll run it with you.",
    eyebrow: SWITCH,
    heading: "We'll run the import with you",
    intro: [`${proj(c)} doesn't have your RevenueCat data yet. The import takes two keys and one command. We're happy to do it together.`],
    visual: { shot: "customers" },
    button: { label: "Book 15 minutes", url: BOOKING_URL },
    tips: ["Saw an error? Reply with it and we'll take a look."],
    links: [{ label: "Import guide", url: docs("migrate/importer") }],
  }),

  side_by_side: (c) => ({
    subject: "Your RevenueCat data is in. Now run both",
    preheader: "Forward store notifications, then point a test build at RevenueDot.",
    eyebrow: SWITCH,
    heading: "Your import is done",
    intro: [c.importedCustomers ? `**${c.importedCustomers.toLocaleString("en-US")} customers** are now in ${proj(c)}. Next, run both side by side.` : `Your customers are now in ${proj(c)}. Next, run both side by side.`],
    visual: { video: "switch-from-revenuecat", shot: "customers" },
    steps: [
      { title: "Forward notifications", text: "RevenueDot passes each one on to RevenueCat." },
      { title: "Track new purchases", text: "Turn it on for each app." },
      { title: "Point a test build here", text: "Production stays on RevenueCat for now." },
      { title: "Compare for a week", text: "`npx revenuedot import verify` checks for you." },
    ],
    button: { label: "Set up the side-by-side run", url: docs("migrate/dual-run") },
    links: [{ label: "What differs", url: docs("migrate/what-differs") }, { label: "Cutover checklist", url: docs("migrate/cutover-checklist") }],
  }),

  forwarding_check: (c) => ({
    subject: "No store notifications have reached RevenueDot yet",
    preheader: "Turn on forwarding to RevenueCat first, then point the stores at RevenueDot.",
    eyebrow: SWITCH,
    heading: "Point the stores at RevenueDot",
    intro: [`Your import finished${c.importedOn ? ` on ${c.importedOn}` : ""}, but no store notification has arrived since. RevenueDot can't see renewals without them.`],
    visual: { shot: "forwarding" },
    steps: [
      { title: "Forward to RevenueCat first", text: "Paste RevenueCat's URL on each app's page." },
      { title: "Then App Store Connect", text: "Set RevenueDot's notification URL." },
      { title: "Then Google Play", text: "Add a second Pub/Sub push subscription." },
    ],
    button: { label: "Open your apps", url: dash(c, "/apps") },
    tips: ["Do step 1 first. RevenueCat then keeps getting every notification."],
    links: [{ label: "Forwarding guide", url: docs("migrate/dual-run") }],
  }),

  cutover: (c) => ({
    subject: "Ready to turn RevenueCat off?",
    preheader: c.bills ? `At your last 7 days' pace: ${usd(c.bills.revenuedot)} a month on RevenueDot, ${usd(c.bills.revenuecat)} on RevenueCat.` : "Your cutover checklist.",
    eyebrow: SWITCH,
    heading: "Ready to turn RevenueCat off?",
    intro: [`${proj(c)} has had a week of live sales on RevenueDot. Here's a month at your last 7 days' pace:`],
    table: c.bills ? {
      head: ["", "A month", "A year"],
      rows: [["RevenueCat", usd(c.bills.revenuecat), usd(c.bills.revenuecat * 12)], ["RevenueDot Cloud", usd(c.bills.revenuedot), usd(c.bills.revenuedot * 12)]],
      note: c.projected !== undefined ? `Based on ${usd(c.projected)} a month (${usd(c.last7 ?? 0)} in the last 7 days). RevenueCat: 1% of all revenue past $2,500. RevenueDot: 0.5% above $10,000, capped at $999.` : undefined,
    } : undefined,
    visual: { video: "switch-from-revenuecat" },
    steps: [
      { title: "Check the numbers", text: "`import verify` shows no differences, and few users still run the old app version." },
      { title: "Move your webhooks", text: "In the same hour you turn RevenueCat's off." },
      { title: "Stop forwarding, then turn RevenueCat off" },
    ],
    button: { label: "Open the cutover checklist", url: docs("migrate/cutover-checklist") },
  }),

  first_sale: (c) => (c.migrating ? {
    subject: `RevenueDot just saw ${proj(c)}'s first live sale`,
    preheader: "Store notifications are reaching RevenueDot. Next, compare both sides.",
    eyebrow: SWITCH,
    heading: "Your first live sale is in",
    intro: [c.sale ? `**${c.sale.product}**${c.sale.amount ? ` for **${c.sale.amount}**` : ""}${c.sale.country ? ` from ${c.sale.country}` : ""}. Store notifications are reaching RevenueDot.` : "Store notifications are reaching RevenueDot."],
    visual: { shot: "overview" },
    button: { label: "Compare both sides", url: `${docs("migrate/importer")}#check-the-result-with-import-verify` },
    tips: ["Run `npx revenuedot import verify`. When it matches for a week, you're ready to switch."],
  } : {
    subject: "Your first real sale through RevenueDot",
    preheader: c.sale ? `${c.sale.product}${c.sale.amount ? ` for ${c.sale.amount}` : ""}${c.sale.country ? ` from ${c.sale.country}` : ""}. Congratulations.` : "Congratulations on your first sale.",
    eyebrow: setup(5),
    heading: "Your first real sale",
    intro: [c.sale ? `${proj(c)} just sold **${c.sale.product}**${c.sale.amount ? ` for **${c.sale.amount}**` : ""}${c.sale.country ? ` to a customer in ${c.sale.country}` : ""}. Congratulations.` : `${proj(c)} just made its first production sale. Congratulations.`],
    visual: { shot: "overview" },
    button: { label: "See the sale", url: dash(c, "/overview") },
    tips: ["Over the next few weeks we'll send one short tip each on **paywalls**, **payment recovery** and **your team**."],
  }),

  standard_welcome: (c) => ({
    subject: "Welcome to Cloud Standard",
    preheader: "0.5% above $10,000 a month, never more than $999. The rate never rises.",
    eyebrow: BILLING,
    heading: "You're on Cloud Standard",
    intro: ["Thank you for upgrading. Here's what you get."],
    steps: [
      { title: "A capped bill", text: "$0 under $10,000 a month, then 0.5%, never over $999." },
      { title: "Single sign-on", text: "SAML or OpenID Connect, and required SSO." },
      { title: "Organizations and custom roles", text: "For every project." },
      { title: "Email support", text: "First reply within 2 business days." },
    ],
    visual: { shot: "team" },
    button: { label: "See billing and invoices", url: `${c.app}/account/billing` },
    tips: ["Billing starts on the **1st of next month**, with no proration."],
    links: [{ label: "Set up SSO", url: docs("guides/single-sign-on") }],
  }),

  standard_canceled: (c) => ({
    subject: "Can you tell us why you left Standard?",
    preheader: "One line helps. Your apps keep working on Cloud Free.",
    eyebrow: BILLING,
    heading: "Your apps keep working",
    intro: ["Your account moved to **Cloud Free**. Your apps and data are unchanged."],
    steps: [{ title: "Tell us why", text: "Price, a missing feature or a bug. One line helps." }],
    button: { label: "Tell us why", url: "mailto:hello@revenuedot.app?subject=Why%20I%20left%20Standard" },
  }),

  paywalls: (c) => ({
    subject: "Edit your paywall from the dashboard",
    preheader: "Start from a template, edit it, publish.",
    eyebrow: GROW,
    heading: "Edit your paywall anytime",
    intro: ["The paywall is where customers decide to pay. Change it from the dashboard."],
    visual: { video: "paywalls-and-experiments", shot: "paywall-templates" },
    steps: [
      { title: "Pick a template", text: "Trial timeline, annual first and more." },
      { title: "Edit words and prices", text: "Preview in light and dark." },
      { title: "Publish", text: "Your app shows it on its next launch." },
    ],
    button: { label: "Pick a template", url: dash(c, "/paywalls/templates") },
    tips: ["Your app needs one release with RevenueCatUI's `PaywallView` (iOS SDK 5.83+). After that, no releases."],
    links: [{ label: "Paywall best practices", url: `${SITE}/blog/paywall-best-practices-2026` }],
  }),

  experiments: (c) => ({
    subject: "Annual first or monthly first? Test it",
    preheader: "Show new customers two offerings and see which earns more.",
    eyebrow: GROW,
    heading: "Your next lift is one test away",
    intro: ["Split new customers between two versions. See which earns more per customer."],
    visual: { video: "paywalls-and-experiments", shot: "experiments" },
    steps: [
      { title: "Pick a test", text: "Annual first, a longer trial, a new headline." },
      { title: "Start it", text: "New customers split between both versions." },
      { title: "Read the result", text: "Lift, confidence interval and chance to win." },
    ],
    button: { label: "Start an experiment", url: dash(c, "/experiments/new") },
    links: [{ label: "How experiments work", url: docs("guides/experiments") }],
  }),

  recovery: (c) => ({
    subject: "Recover renewals that fail",
    preheader: "Email customers whose card was declined a link to fix it.",
    eyebrow: GROW,
    heading: "Save renewals that fail",
    intro: ["Some renewals fail because a card expired. Those customers didn't mean to leave."],
    visual: { shot: "recovery" },
    steps: [
      { title: "Turn on payment recovery", text: "One switch." },
      { title: "We email a fix-it link", text: "In your app's name." },
      { title: "See what came back", text: "Customers and revenue saved." },
    ],
    button: { label: "Turn on payment recovery", url: dash(c, "/lifecycle/payment-recovery") },
    tips: ["Only customers with an email on file (the `$email` attribute) get the email."],
  }),

  team: (c) => ({
    subject: "Bring your team into RevenueDot",
    preheader: "Seats are free. Everyone gets the role they need.",
    eyebrow: GROW,
    heading: "Invite your team",
    intro: ["Seats are **free and unlimited**."],
    visual: { shot: "team" },
    steps: [
      { title: "Developer", text: "Apps, products, customers and integrations." },
      { title: "Viewer", text: "Every chart, no changes. Great for founders and finance." },
      { title: "Admin", text: "Keys and members." },
    ],
    button: { label: "Invite a teammate", url: dash(c, "/settings/collaborators") },
  }),

  how_going: (c) => ({
    subject: `How is RevenueDot working for ${proj(c)}?`,
    preheader: "One line back helps us a lot.",
    eyebrow: "Quick question",
    heading: "How is it going?",
    intro: [`${proj(c)} has been selling through RevenueDot since ${c.liveSince ?? "your first sale"}. Thank you.`],
    steps: [{ title: "What's one thing you'd change?", text: "One line back is plenty. We read every answer." }],
    button: { label: "Reply in one line", url: "mailto:hello@revenuedot.app?subject=How%20RevenueDot%20is%20going" },
  }),

  assistant: (c) => ({
    subject: "Ask ChatGPT or Claude about your subscriptions",
    preheader: "Look up customers, grant access and check your setup from chat.",
    eyebrow: GROW,
    heading: "Run your subscriptions from chat",
    intro: ["Ask in plain words: **\"Why didn't this customer get Pro?\"**"],
    visual: { video: "chatgpt-demo" },
    steps: [
      { title: "Copy the URL", text: "`https://mcp.revenuedot.app/mcp`" },
      { title: "Add it to your assistant", text: "ChatGPT, Claude or Cursor." },
      { title: "Sign in", text: "Choose what it may do. Refunds always wait for you." },
    ],
    button: { label: "Connect an assistant", url: docs("guides/connect-ai-assistants") },
  }),

  pricing_explainer: (c) => ({
    subject: "How your RevenueDot bill works as you grow",
    preheader: `Your apps tracked ${usd(c.tracked ?? 0)} so far in ${c.month ?? "this month"}. Here's what Cloud costs from here.`,
    eyebrow: BILLING,
    heading: "No surprises on your bill",
    intro: [`Your apps tracked **${usd(c.tracked ?? 0)}** so far in ${c.month ?? "this month"}. Cloud is free under $10,000 a month, then 0.5% above it.`],
    table: c.priceRows ? {
      head: ["Monthly revenue", "RevenueDot", "RevenueCat"],
      rows: c.priceRows.map(([r, rd, rc]) => [usd(r), usd(rd), usd(rc)]),
      note: "Revenue before Apple and Google take their cut. RevenueDot never charges more than $999 a month.",
    } : undefined,
    button: { label: "Upgrade for $0 today", url: `${c.app}/account/billing` },
    tips: ["Adding a card now costs nothing. Standard is $0 until you pass $10,000."],
  }),

  upgrade_nudge: (c) => ({
    subject: "Two minutes to move to Cloud Standard",
    preheader: c.bills ? `On ${usd(c.overTracked ?? 0)} a month: ${usd(c.bills.revenuedot)} on Standard.` : "0.5% above $10,000, capped at $999 a month.",
    eyebrow: BILLING,
    heading: "Your apps outgrew Cloud Free",
    intro: [`Your apps tracked **${usd(c.overTracked ?? 0)}** in ${c.overMonth ?? "a month"}. Cloud Free covers up to $10,000 a month, so Standard is your plan now. Your apps keep working either way.`],
    table: c.bills ? { head: ["On " + usd(c.overTracked ?? 0), "A month", "A year"], rows: [["RevenueCat", usd(c.bills.revenuecat), usd(c.bills.revenuecat * 12)], ["RevenueDot Standard", usd(c.bills.revenuedot), usd(c.bills.revenuedot * 12)]] } : undefined,
    button: { label: "Upgrade to Standard", url: `${c.app}/account/billing` },
    tips: ["Billing starts on the **1st of next month**, with no proration.", "Checkout takes your company name and tax ID for invoices."],
  }),

  upgrade_personal: (c) => ({
    subject: "Anything blocking the upgrade?",
    preheader: "If checkout or invoices are in the way, reply and we'll sort it out.",
    eyebrow: BILLING,
    heading: "Anything in the way?",
    intro: [`Your apps passed $10,000 in ${c.overMonth ?? "a recent month"} (${usd(c.overTracked ?? 0)}). Congratulations.`],
    steps: [{ title: "Checkout or invoices in the way?", text: "Reply and we'll sort it out." }],
    button: { label: "Upgrade to Standard", url: `${c.app}/account/billing` },
  }),

  enterprise: (c) => ({
    subject: "An SLA and a named engineer for your apps",
    preheader: "Our Enterprise plan, in one email.",
    eyebrow: "Enterprise",
    heading: "Built for apps your size",
    intro: [`Your apps tracked **${usd(c.tracked ?? 0)}** so far this month.`],
    steps: [
      { title: "Uptime SLA", text: "On the purchase path." },
      { title: "A named engineer", text: "And faster support." },
      { title: "DPA and security review", text: "Done with your team." },
    ],
    button: { label: "Book a call", url: BOOKING_URL },
  }),

  referral: (c) => ({
    subject: "Know a team paying RevenueCat 1%?",
    preheader: "Share your link. We'll help them switch.",
    eyebrow: "Share RevenueDot",
    heading: "Know a team paying 1%?",
    intro: [`${proj(c)} has sold through RevenueDot since ${c.liveSince ?? "your first sale"}. Share your link with a founder who should switch.`],
    copyBox: c.referralUrl ? { label: "Your link", text: c.referralUrl } : undefined,
    steps: [
      { title: "They keep their SDK", text: "And point it at RevenueDot." },
      { title: "We help them switch", text: "Import, side by side, cutover." },
    ],
    button: c.referralUrl ? { label: "Share on X", url: `https://x.com/intent/post?text=${encodeURIComponent(`I run my app's subscriptions on @revenuedot: open source, works with the RevenueCat SDK, free up to $10K a month. ${c.referralUrl}`)}` } : undefined,
    links: c.referralUrl ? [{ label: "Share on LinkedIn", url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(c.referralUrl)}` }] : [],
  }),

  referral_joined: (c) => ({
    subject: "Your friend just signed up for RevenueDot",
    preheader: "Thank you for sharing your link.",
    eyebrow: "Share RevenueDot",
    heading: "Your friend just joined",
    intro: ["Someone created a RevenueDot account with your link. Thank you."],
    steps: [{ title: "Moving from RevenueCat?", text: "They can reply to any of our emails for help." }],
    button: { label: "Share your link again", url: c.referralUrl ?? dash(c, "/overview") },
  }),

  went_quiet: (c) => ({
    subject: `Is everything OK with ${proj(c)}?`,
    preheader: "Your app hasn't reached RevenueDot for a week.",
    eyebrow: "Check-in",
    heading: "Is everything OK?",
    intro: [`${proj(c)}'s app hasn't reached RevenueDot for a week${c.lastSaleAt ? `. The last sale was on ${c.lastSaleAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}` : ""}.`],
    visual: { shot: "apps" },
    steps: [
      { title: "Something broke?", text: "Reply. We'll look within one business day." },
      { title: "Paused or moved on?", text: "Tell us why in one line." },
    ],
    button: { label: "Check your apps", url: dash(c, "/apps") },
  }),

  teammate_welcome: (c) => ({
    subject: `You're in ${proj(c)} on RevenueDot`,
    preheader: "Where things are, in one minute.",
    eyebrow: "Welcome",
    heading: `Welcome to ${proj(c)}`,
    intro: [`${c.inviter ? `${c.inviter} added you` : "You joined"}. Here's where things are.`],
    visual: { shot: "overview" },
    steps: [
      { title: "Overview", text: "Revenue, MRR, trials and new customers." },
      { title: "Customers", text: "Find anyone by user ID, email or transaction." },
      { title: "Charts", text: "More than 40 charts, from MRR to trial conversion." },
    ],
    button: { label: "Open the project", url: dash(c, "/overview") },
  }),
};

/** Steps whose footer says they stop once the app is live. */
const ONBOARDING = new Set<StepId>(["welcome", "verify_reminder", "first_purchase", "checkin", "connect_app", "ai_setup", "store_keys", "go_live", "need_hand", "last_call", "switch_plan", "import_help", "side_by_side", "forwarding_check"]);

// ---------- layout ----------

function render(c: JourneyCtx, m: JourneyMail): Rendered {
  const s = c.step;
  const t = (x: string) => inline(x, s, "text");
  const h = (x: string) => inline(x, s, "html");
  const reason = ONBOARDING.has(s)
    ? "You're getting this because you signed up for RevenueDot Cloud. Setup emails stop once your app is live."
    : "You're getting this because you have a RevenueDot Cloud account.";
  const prefs = tag(`${c.app}/account/notifications`, s);
  // Fills the inbox preview after the preheader, so the start of the body never shows there.
  const pad = "&#8203;&nbsp;".repeat(Math.max(0, 110 - m.preheader.length));
  const label = (x: string, color = FG3) => `<p style="margin:0 0 8px;font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${color};">${esc(x)}</p>`;

  // The picture: the video's cover while it is live, else the screenshot.
  const v = m.visual;
  const video = v?.video && VIDEOS[v.video].ready ? v.video : null;
  const pic = video
    ? { src: videoCover(video), href: tag(videoUrl(video), s), alt: `Play the video: ${VIDEOS[video].title} (${VIDEOS[video].length})`, caption: `&#9654;&nbsp; <strong style="color:${INK};font-weight:700;">Watch: ${esc(VIDEOS[video].title)}</strong> <span style="font-family:${MONO};font-size:12px;color:${FG3};">${VIDEOS[video].length}</span>` }
    : v?.shot ? { src: shotUrl(v.shot), href: tag(v.href ?? m.button?.url ?? `${c.app}/`, s), alt: SHOT_ALT[v.shot], caption: "" } : null;
  const visual = pic
    ? `<tr><td style="padding:0 0 ${pic.caption ? 10 : 24}px;"><a href="${esc(pic.href)}" style="display:block;text-decoration:none;"><img src="${esc(pic.src)}" width="520" alt="${esc(pic.alt)}" style="display:block;width:100%;max-width:520px;height:auto;border:1px solid ${BORDER};outline:none;background:${PANEL};font-family:${FONT};font-size:14px;color:${FG2};"></a></td></tr>` +
      (pic.caption ? `<tr><td style="padding:0 0 24px;font-size:14px;line-height:20px;color:${INK};"><a href="${esc(pic.href)}" style="color:${INK};text-decoration:none;">${pic.caption}</a></td></tr>` : "")
    : "";
  // One item is a bold line, not a list with a lone "1".
  const steps = m.steps?.length === 1
    ? `<tr><td style="padding:0 0 22px;"><p style="margin:0;font-size:16px;line-height:23px;font-weight:700;color:${INK};">${h(m.steps[0]!.title)}</p>` +
      (m.steps[0]!.text ? `<p style="margin:2px 0 0;font-size:14px;line-height:21px;color:${FG2};">${h(m.steps[0]!.text)}</p>` : "") + `</td></tr>`
    : m.steps?.length
    ? `<tr><td style="padding:0 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
      m.steps.map((x, i) => `<tr><td valign="top" style="width:40px;padding:0 0 14px;"><div style="width:26px;height:26px;background:${INK};color:#FFFFFF;font-family:${MONO};font-size:13px;line-height:26px;font-weight:600;text-align:center;">${i + 1}</div></td>` +
        `<td valign="top" style="padding:2px 0 14px;"><p style="margin:0;font-size:16px;line-height:22px;font-weight:700;color:${INK};">${h(x.title)}</p>` +
        (x.text ? `<p style="margin:2px 0 0;font-size:14px;line-height:21px;color:${FG2};">${h(x.text)}</p>` : "") + `</td></tr>`).join("") +
      `</table></td></tr>`
    : "";
  const code = m.code
    ? `<tr><td style="padding:0 0 22px;">${label(m.code.label)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${INK};padding:14px 16px;font-family:${MONO};font-size:12.5px;line-height:20px;color:#F5F5F5;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;">${esc(m.code.text)}</td></tr></table></td></tr>`
    : "";
  const table = m.table
    ? `<tr><td style="padding:0 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${BORDER};">` +
      `<tr>${m.table.head.map((x, i) => `<td style="padding:10px 14px;background:${PANEL};border-bottom:1px solid ${BORDER};font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${FG3};${i ? "text-align:right;" : ""}">${esc(x)}</td>`).join("")}</tr>` +
      m.table.rows.map((r, ri) => `<tr>${r.map((x, i) => `<td style="padding:11px 14px;${ri < m.table!.rows.length - 1 ? `border-bottom:1px solid ${BORDER};` : ""}font-size:15px;line-height:20px;color:${INK};${i ? `text-align:right;font-family:${MONO};` : "font-weight:600;"}">${esc(x)}</td>`).join("")}</tr>`).join("") +
      `</table>` + (m.table.note ? `<p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${FG3};">${h(m.table.note)}</p>` : "") + `</td></tr>`
    : "";
  const copyBox = m.copyBox
    ? `<tr><td style="padding:0 0 22px;">${label(m.copyBox.label)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:2px solid ${INK};padding:14px 16px;font-family:${MONO};font-size:15px;line-height:20px;font-weight:600;color:${INK};word-break:break-all;">${esc(m.copyBox.text)}</td></tr></table></td></tr>`
    : "";
  const button = m.button
    ? `<tr><td style="padding:4px 0 ${m.links?.length ? 14 : 28}px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${INK};">` +
      `<a href="${esc(tag(m.button.url, s))}" style="display:inline-block;padding:15px 26px;font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(m.button.label)} &rarr;</a></td></tr></table></td></tr>`
    : "";
  const links = m.links?.length
    ? `<tr><td style="padding:0 0 28px;font-size:14px;line-height:22px;color:${FG3};">` +
      m.links.map((l) => `<a href="${esc(tag(l.url, s))}" style="color:${INK};text-decoration:underline;text-underline-offset:2px;">${esc(l.label)}</a>`).join(` &nbsp;&middot;&nbsp; `) + `</td></tr>`
    : "";
  const tips = m.tips?.length
    ? `<tr><td style="padding:0 0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${PANEL};border-left:3px solid ${GOLD};padding:14px 16px;">` +
      label("Good to know") + m.tips.map((x) => `<p style="margin:0 0 4px;font-size:14px;line-height:21px;color:${INK};">${h(x)}</p>`).join("") + `</td></tr></table></td></tr>`
    : "";

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(m.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#FFFFFF;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(m.preheader)}${pad}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;"><tr><td align="center" style="padding:28px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">` +
    `<tr><td style="padding:0 0 28px;"><a href="${esc(tag(SITE, s))}"><img src="${LOGO_URL}" width="152" height="22" alt="RevenueDot" style="display:block;border:0;outline:none;font-family:${FONT};font-size:15px;font-weight:700;color:${INK};"></a></td></tr>` +
    `<tr><td style="padding:0 0 6px;">${label(m.eyebrow, FG3)}</td></tr>` +
    `<tr><td style="padding:0 0 12px;"><h1 style="margin:0;font-size:28px;line-height:34px;font-weight:700;letter-spacing:-0.03em;color:${INK};">${esc(m.heading)}</h1></td></tr>` +
    `<tr><td style="padding:0 0 22px;">${m.intro.map((x) => `<p style="margin:0 0 8px;font-size:16px;line-height:25px;color:${FG2};">${h(x)}</p>`).join("")}</td></tr>` +
    table + visual + steps + code + copyBox + button + links + tips +
    `<tr><td style="border-top:1px solid ${BORDER};padding:18px 0 0;font-size:13px;line-height:20px;color:${FG2};"><strong style="color:${INK};">Questions?</strong> Reply to this email and our team will help.</td></tr>` +
    `<tr><td style="padding:12px 0 0;font-size:12px;line-height:18px;color:${FG3};">${esc(reason)}<br>RevenueDot &middot; <a href="${esc(prefs)}" style="color:${FG3};">Email preferences</a> &middot; <a href="${esc(c.unsubscribeUrl)}" style="color:${FG3};">Unsubscribe</a></td></tr>` +
    `</table></td></tr></table></body></html>`;

  const text = [
    m.eyebrow.toUpperCase(), m.heading, "",
    ...m.intro.flatMap((x) => [t(x), ""]),
    ...(pic && video ? [`Watch: ${VIDEOS[video].title} (${VIDEOS[video].length}): ${pic.href}`, ""] : []),
    ...(m.steps ?? []).map((x, i) => `${i + 1}. ${t(x.title)}${x.text ? ` ${t(x.text)}` : ""}`),
    ...(m.steps?.length ? [""] : []),
    ...(m.code ? [`${m.code.label}:`, ...m.code.text.split("\n").map((l) => `    ${l}`), ""] : []),
    ...(m.table ? [...m.table.rows.map((r) => `${r[0]}: ${r[1]} a month, ${r[2]}`), ...(m.table.note ? [t(m.table.note)] : []), ""] : []),
    ...(m.copyBox ? [`${m.copyBox.label}: ${m.copyBox.text}`, ""] : []),
    ...(m.button ? [`${m.button.label}: ${tag(m.button.url, s)}`, ""] : []),
    ...(m.links ?? []).map((l) => `${l.label}: ${tag(l.url, s)}`),
    ...(m.links?.length ? [""] : []),
    ...(m.tips?.length ? ["Good to know:", ...m.tips.map((x) => `- ${t(x)}`), ""] : []),
    "Questions? Reply to this email and our team will help.", "", "--",
    reason, `Email preferences: ${prefs}`, `Unsubscribe: ${c.unsubscribeUrl}`,
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
