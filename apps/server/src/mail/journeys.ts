/**
 * Onboarding and growth emails to RevenueDot Cloud accounts (prd/onboarding-emails/PRD.md). Two looks:
 * - "guide": the logo, a heading, short paragraphs, numbered steps, a video cover that opens the full video, one button,
 *   a few useful links, Kai's sign-off. In DESIGN.md's tokens: white, near-black ink, grey hairlines, square corners.
 * - "letter": a plain personal note from Kai (no logo, no button), for check-ins that ask for a reply.
 * Copy uses a tiny inline markup: **bold**, `code` and [label](url). Every link to our own hosts gets UTM tags.
 */
import { esc, type Rendered } from "./templates.js";

const INK = "#0A0A0A", FG2 = "#525252", FG3 = "#737373", BORDER = "#E5E5E5", PANEL = "#FAFAFA";
const FONT = "Manrope, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const LOGO_URL = "https://revenuedot.app/brand/revenuedot-lockup-black@2x.png";
export const SITE = "https://revenuedot.app";
export const BOOKING_URL = "https://calendar.google.com/calendar/appointments/schedules/AcZssZ0IxzgwYNVDGggPF9qelyDSh51L5UzFNcrDE2u3eMTwqpLfGsrRxjx2TxY-WyehZVX1ns8MhQWg";

/** The sender: a person, so replies reach one. The binding must allow this address (cloudflare.config.ts). */
export const JOURNEY_FROM = "Kai from RevenueDot <kai@mail.revenuedot.app>";
export const JOURNEY_REPLY_TO = "hello@revenuedot.app";

export type VideoId = "first-purchase" | "connect-your-app" | "switch-from-revenuecat" | "paywalls-and-experiments" | "chatgpt-demo";

/**
 * Tutorial videos shown as a playable cover. `youtube` wins once the video is published there; until then the cover opens
 * the video's page on revenuedot.app. Covers (1200×675 JPEG, play button and length drawn in) live in apps/site/public/email/.
 */
export const VIDEOS: Record<VideoId, { title: string; length: string; slug: string; youtube?: string; ready: boolean }> = {
  "first-purchase": { title: "Your first purchase in 5 minutes", length: "1:30", slug: "revenuedot-first-purchase", ready: false },
  "connect-your-app": { title: "Connect your app to RevenueDot", length: "1:30", slug: "revenuedot-connect-your-app", ready: false },
  "switch-from-revenuecat": { title: "Switch from RevenueCat without losing a renewal", length: "1:40", slug: "revenuedot-switch-from-revenuecat", ready: false },
  "paywalls-and-experiments": { title: "Build a paywall and test it", length: "1:30", slug: "revenuedot-paywalls-and-experiments", ready: false },
  "chatgpt-demo": { title: "Run your subscriptions from ChatGPT", length: "1:27", slug: "revenuedot-chatgpt-demo", ready: true },
};
/** `ready`: the video has its /watch page and cover live. An email whose video is not ready simply shows none. */
export const videoUrl = (id: VideoId) => VIDEOS[id].youtube ?? `${SITE}/watch/${VIDEOS[id].slug}`;
export const videoCover = (id: VideoId) => `${SITE}/email/${VIDEOS[id].slug}.jpg`;

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
  /** A month's bill on each: at the current pace for the cutover, on the revenue so far for the upgrade emails. */
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
  look: "guide" | "letter";
  heading?: string;
  paragraphs: string[];
  steps?: { title: string; text?: string }[];
  /** Plain bullets (no numbers). */
  bullets?: string[];
  code?: { label: string; text: string };
  table?: { head: [string, string, string]; rows: [string, string, string][]; note?: string };
  video?: VideoId;
  button?: { label: string; url: string };
  /** A box with something to copy (a referral link). */
  copyBox?: { label: string; text: string };
  links?: { label: string; url: string }[];
  /** After the button and links, before the sign-off. */
  after?: string[];
  ps?: string;
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
    .replace(/\*\*(.+?)\*\*/g, `<strong style="font-weight:600;color:${INK};">$1</strong>`)
    .replace(/`([^`]+)`/g, `<code style="font-family:${MONO};font-size:13px;background:${PANEL};border:1px solid ${BORDER};padding:1px 5px;">$1</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, l: string, u: string) => `<a href="${tag(u.replace(/&amp;/g, "&"), step).replace(/&/g, "&amp;")}" style="color:${INK};text-decoration:underline;text-underline-offset:2px;">${l}</a>`);
}

const hi = (c: JourneyCtx) => (c.first ? `Hi ${c.first},` : "Hi there,");
const proj = (c: JourneyCtx) => c.projectName ?? "your project";
const dash = (c: JourneyCtx, path: string) => (c.projectId ? `${c.app}/projects/${c.projectId}${path}` : `${c.app}/`);
const docs = (path: string) => `${SITE}/docs/${path}`;

// ---------- the emails ----------

const EMAILS: Record<StepId, (c: JourneyCtx) => JourneyMail> = {
  welcome: (c) => ({
    look: "guide",
    subject: "Welcome to RevenueDot: pick your first step",
    preheader: "Make a test purchase in 5 minutes, or plan your switch from RevenueCat.",
    heading: c.first ? `Welcome, ${c.first}` : "Welcome to RevenueDot",
    paragraphs: [
      "Thanks for signing up. I'm Kai, the founder. Over the next few days I'll send you a few short emails while you set up, each with one next step. Reply any time, and a person will answer.",
      "Start with the path that fits you:",
    ],
    steps: [
      { title: `[New to in-app purchases](${c.pathUrl?.("new") ?? docs("getting-started/quickstart")})`, text: "Make a test purchase in 5 minutes with the built-in Test Store. You don't need an App Store or Google Play account yet." },
      { title: `[Already on RevenueCat](${c.pathUrl?.("revenuecat") ?? docs("migrate")})`, text: "Keep the SDK your app ships, import your customers, and run both side by side until the numbers match." },
    ],
    video: "first-purchase",
    button: { label: "Make a test purchase", url: c.pathUrl?.("new") ?? docs("getting-started/quickstart") },
    ps: "Cloud is free until your apps make $10,000 a month. No card needed.",
  }),

  verify_reminder: (c) => ({
    look: "guide",
    subject: "Confirm your email to create secret API keys",
    preheader: "A fresh link that works for 24 hours.",
    heading: "One click to finish your account",
    paragraphs: [
      `${hi(c)} your account works, but two things wait for a confirmed email: **secret API keys** and **inviting your team**. Your first link has expired, so here is a new one. It works for 24 hours.`,
    ],
    button: { label: "Confirm my email", url: c.verifyUrl ?? `${c.app}/` },
    after: ["If you didn't create a RevenueDot account, ignore this email and nothing happens."],
  }),

  first_purchase: (c) => ({
    look: "guide",
    subject: "Make your first test purchase in 5 minutes",
    preheader: "No App Store or Google Play account needed.",
    heading: "See it work before you write any code",
    paragraphs: [
      `${hi(c)} the quickest way to see RevenueDot work is the **Test Store**. It behaves like a real store, so you get a test customer, an active entitlement and webhooks, without opening App Store Connect.`,
    ],
    steps: [
      { title: "Add a Test Store app", text: "Then add a product such as `pro_monthly`." },
      { title: "Create an entitlement called `pro`", text: "Attach the product. This is the access your app checks." },
      { title: "Buy it", text: "Make the `default` offering current, then on **Overview** click **Make a test purchase**." },
    ],
    video: "first-purchase",
    button: { label: "Make a test purchase", url: dash(c, "/overview") },
    links: [
      { label: "The quickstart, step by step", url: docs("getting-started/quickstart") },
      { label: "Prefer a script? Seed everything with one command", url: `${docs("getting-started/quickstart")}#2-add-a-test-store-app-a-product-and-an-entitlement` },
    ],
    ps: "Stuck on a step? Reply with a screenshot and I'll help.",
  }),

  checkin: (c) => ({
    look: "letter",
    subject: c.first ? `Quick question, ${c.first}` : "Quick question about your app",
    preheader: "What are you building? One line is enough.",
    paragraphs: [
      hi(c),
      `${proj(c)} doesn't have an app in it yet, so I wanted to ask: what are you building?`,
      "Tell me your stack (Swift, Kotlin, Flutter, React Native or Expo) and whether you use RevenueCat today. I'll reply with the shortest path for your app. One line is enough.",
    ],
  }),

  connect_app: (c) => ({
    look: "guide",
    subject: c.testPurchase ? "It works. Now connect your app" : "Connect your app to RevenueDot",
    preheader: "Add the SDK, point it at RevenueDot, and start with your test key.",
    heading: c.testPurchase ? "Your test purchase worked" : "Connect your app",
    paragraphs: [
      c.testPurchase
        ? `${hi(c)} your test purchase went through: a customer, an active entitlement and its events. Next comes your real app.`
        : `${hi(c)} the next step is your real app.`,
      "RevenueDot works with the RevenueCat SDK, and you don't need a RevenueCat account. Add the SDK to your app, then point it at RevenueDot before you configure it:",
    ],
    code: { label: "iOS (Swift)", text: 'Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!\nPurchases.configure(with: Configuration.Builder(withAPIKey: "test_...").with(entitlementVerificationMode: .disabled).build())' },
    after: ["Flutter, Android, React Native and Unity use the same two settings; your guide below has the exact lines. Start with your `test_` key from **API keys**."],
    video: "connect-your-app",
    button: { label: "Get your API key", url: dash(c, "/api-keys") },
    links: [
      { label: "iOS", url: docs("sdks/ios") },
      { label: "Android", url: docs("sdks/android") },
      { label: "React Native and Expo", url: docs("sdks/react-native") },
      { label: "Flutter", url: docs("sdks/flutter") },
    ],
  }),

  ai_setup: (c) => ({
    look: "guide",
    subject: "Let your AI coding tool set up RevenueDot",
    preheader: "Claude Code, Cursor or Codex can add purchases to your app from one prompt.",
    heading: "Hand the setup to your AI tool",
    paragraphs: [
      `${hi(c)} if you build with Claude Code, Cursor or Codex, it can add purchases to your app for you. Our docs include an llms.txt file written for AI tools, so one prompt is enough.`,
      "Paste this into your coding tool:",
    ],
    code: { label: "Prompt", text: "Add in-app purchases with RevenueDot. Read https://revenuedot.app/llms.txt and follow the quickstart." },
    button: { label: "Open the 5-minute quickstart", url: docs("getting-started/quickstart") },
    links: [
      { label: "llms.txt for your tool", url: `${SITE}/llms.txt` },
      { label: "Agent skills on GitHub", url: "https://github.com/revenuedot/agent-skills" },
    ],
  }),

  store_keys: (c) => ({
    look: "guide",
    subject: "Your app reached RevenueDot. Next: the stores",
    preheader: "Add App Store and Google Play credentials so real purchases are checked.",
    heading: "Your app is talking to RevenueDot",
    paragraphs: [
      c.sdk
        ? `${hi(c)} your ${c.sdk.platform} app (SDK ${c.sdk.version}) just reached RevenueDot for the first time. Nice work.`
        : `${hi(c)} your app just reached RevenueDot for the first time. Nice work.`,
      "To check real purchases and hear about renewals, refunds and billing problems, RevenueDot needs your store credentials:",
    ],
    bullets: [
      "**App Store:** an In-App Purchase key (.p8), and RevenueDot's URL as your server notifications URL.",
      "**Google Play:** a service account, and real-time developer notifications.",
      "**Web:** connect Stripe in one click.",
    ],
    button: { label: "Add store credentials", url: dash(c, "/apps") },
    links: [
      { label: "App Store setup", url: docs("guides/app-store") },
      { label: "Google Play setup", url: docs("guides/google-play") },
      { label: "Test with sandbox purchases", url: docs("guides/sandbox-testing") },
    ],
  }),

  go_live: (c) => ({
    look: "guide",
    subject: "Your go-live checklist",
    preheader: "Four checks before real customers buy.",
    heading: "Ready for real customers?",
    paragraphs: [`${hi(c)} your store is connected. Before you ship, here are the four checks teams most often miss:`],
    steps: [
      { title: "**Check credentials** shows valid", text: "On each app's page in the dashboard." },
      { title: "Store notifications arrive", text: "The app's status shows **Ready**, and App Store Connect sends both Production and Sandbox notifications to RevenueDot, version 2." },
      { title: "Release builds use store keys", text: "`appl_` or `goog_`, never a `test_` key, and no secret `sk_` key in the app." },
      { title: "Product IDs match the store exactly", text: "Google Play subscriptions as `subscriptionId:basePlanId`." },
    ],
    button: { label: "Check your apps", url: dash(c, "/apps") },
    links: [
      { label: "The full checklist (Stores and Apps sections)", url: `${docs("guides/going-to-production")}#stores` },
      { label: "Sandbox testing", url: docs("guides/sandbox-testing") },
    ],
    ps: "When your first real sale comes in, I'll let you know.",
  }),

  need_hand: (c) => ({
    look: "letter",
    subject: "Want to set it up together?",
    preheader: "15 minutes on a call, or reply with where you got stuck.",
    paragraphs: [
      hi(c),
      c.migrating
        ? `Your RevenueCat data is in, but the side-by-side run isn't finished yet. [Book 15 minutes](${BOOKING_URL}) and we'll set up forwarding together.`
        : `Purchases are fiddly to set up, and I'm happy to help. [Book 15 minutes](${BOOKING_URL}) and we'll connect your app together on a call.`,
      "Or reply with where you got stuck (a screenshot helps) and I'll answer myself.",
    ],
  }),

  last_call: (c) => ({
    look: "letter",
    subject: "This is my last setup email",
    preheader: "Your project stays free and ready whenever you are.",
    paragraphs: [
      hi(c),
      `${c.migrating ? (c.importedOn ? "Your side-by-side run hasn't started yet" : "You haven't imported from RevenueCat yet") : "Your app hasn't connected to RevenueDot yet"}, so this is my last setup email. If the timing is wrong, that's fine: your project stays free and ready whenever you are.`,
      "If something didn't work, or RevenueDot is missing something you need, I'd really like to know. One line back helps me fix it for the next person.",
    ],
  }),

  switch_plan: (c) => ({
    look: "guide",
    subject: "Switch from RevenueCat in 3 steps",
    preheader: "Keep your SDK. Run both side by side until the numbers match.",
    heading: "Your plan to switch from RevenueCat",
    paragraphs: [`${hi(c)} here's the safe way to move, the one RevenueDot is built around. Your app keeps the RevenueCat SDK, and RevenueCat keeps running until you turn it off.`],
    steps: [
      { title: "Import", text: "One command copies apps, products, offerings, customers and purchase history: `npx revenuedot import --from-revenuecat --rc-project <your RevenueCat project id> --to https://api.revenuedot.app`. It asks for a RevenueCat v2 secret key and a RevenueDot secret key, so confirm your email first." },
      { title: "Run both", text: "Forward store notifications so RevenueCat and RevenueDot both see every renewal." },
      { title: "Switch", text: "Point the SDK at RevenueDot in your next release. Turn RevenueCat off once the numbers match." },
    ],
    video: "switch-from-revenuecat",
    button: { label: "Start the import", url: docs("migrate/importer") },
    links: [
      { label: "See what you'd save", url: `${SITE}/tools/revenuecat-fee-calculator` },
      { label: "The side-by-side run", url: docs("migrate/dual-run") },
      { label: "Cutover checklist", url: docs("migrate/cutover-checklist") },
    ],
    ps: "Moving more than $30,000 a month? Reply and I'll help you plan the switch myself.",
  }),

  import_help: (c) => ({
    look: "letter",
    subject: "Want to run the RevenueCat import together?",
    preheader: "15 minutes on a call, and your customers are in RevenueDot.",
    paragraphs: [
      hi(c),
      `${proj(c)} doesn't have your RevenueCat data in it yet. The import is one command, but it needs two keys and a few choices, so I'm happy to do it with you.`,
      `[Book 15 minutes](${BOOKING_URL}) and we'll run it together, or reply with any error you saw and I'll look at it.`,
    ],
  }),

  side_by_side: (c) => ({
    look: "guide",
    subject: "Your RevenueCat data is in. Now run both",
    preheader: "Forward store notifications, then point a test build at RevenueDot.",
    heading: "Your import is done",
    paragraphs: [
      c.importedCustomers
        ? `${hi(c)} ${c.importedCustomers.toLocaleString("en-US")} customers from RevenueCat are now in ${proj(c)}, with their purchase history.`
        : `${hi(c)} your RevenueCat customers are now in ${proj(c)}, with their purchase history.`,
      "Next, run both backends side by side, so nothing is lost while you switch:",
    ],
    steps: [
      { title: "Forward store notifications", text: "Apple and Google send to RevenueDot, and RevenueDot passes each one on to RevenueCat. Then turn on **Track new purchases from server-to-server notifications** for each app." },
      { title: "Point a test build at RevenueDot", text: "Two settings in the SDK: the RevenueDot URL, and the signature check turned off. Your production app stays on RevenueCat for now." },
      { title: "Compare for a week", text: "Active subscriptions and revenue should match. `npx revenuedot import verify` checks for you." },
    ],
    video: "switch-from-revenuecat",
    button: { label: "Set up the side-by-side run", url: docs("migrate/dual-run") },
    links: [
      { label: "What differs from RevenueCat", url: docs("migrate/what-differs") },
      { label: "Cutover checklist", url: docs("migrate/cutover-checklist") },
    ],
  }),

  forwarding_check: (c) => ({
    look: "guide",
    subject: "No store notifications have reached RevenueDot yet",
    preheader: "One setting in App Store Connect and Google Play finishes the side-by-side run.",
    heading: "Point the stores at RevenueDot",
    paragraphs: [
      `${hi(c)} your import finished${c.importedOn ? ` on ${c.importedOn}` : ""}, but no App Store or Google Play notification has reached ${proj(c)} since. Without them, RevenueDot can't see renewals, refunds or cancellations as they happen.`,
      "First, on each app's page in RevenueDot, paste RevenueCat's notification URL into **Forward notifications to RevenueCat or your own server**. Then set RevenueDot's notification URL in App Store Connect, and add a second Pub/Sub push subscription for Google Play. RevenueCat keeps getting every notification.",
    ],
    button: { label: "Set up forwarding", url: docs("migrate/dual-run") },
    links: [{ label: "Your apps' notification URLs", url: dash(c, "/apps") }],
    ps: "Stuck on the Google Play side? Reply and I'll walk you through it.",
  }),

  cutover: (c) => ({
    look: "guide",
    subject: "Ready to turn RevenueCat off?",
    preheader: c.bills ? `At your last 7 days' pace: ${usd(c.bills.revenuedot)} a month on RevenueDot, ${usd(c.bills.revenuecat)} on RevenueCat.` : "Your cutover checklist.",
    heading: "A week of live sales on RevenueDot",
    paragraphs: [`${hi(c)} ${proj(c)} has recorded live sales on RevenueDot for a week. Here's what each would charge for a month at your last 7 days' pace:`],
    table: c.bills ? {
      head: ["", "A month", "A year"],
      rows: [["RevenueCat", usd(c.bills.revenuecat), usd(c.bills.revenuecat * 12)], ["RevenueDot Cloud", usd(c.bills.revenuedot), usd(c.bills.revenuedot * 12)]],
      note: c.projected !== undefined ? `Based on ${usd(c.projected)} a month, from ${usd(c.last7 ?? 0)} in the last 7 days. RevenueCat charges 1% of all revenue once you pass $2,500 a month; RevenueDot 0.5% above $10,000, capped at $999.` : undefined,
    } : undefined,
    after: ["When `import verify` shows no differences and few users still run the old app version, move your webhooks to RevenueDot in the same hour you turn RevenueCat's off, stop forwarding, then turn RevenueCat off."],
    button: { label: "Open the cutover checklist", url: docs("migrate/cutover-checklist") },
    links: [{ label: "Check the numbers with import verify", url: `${docs("migrate/importer")}#check-the-result-with-import-verify` }],
    ps: "Reply if anything looks different between the two. I'll look at it with you.",
  }),

  first_sale: (c) => (c.migrating ? {
    look: "guide",
    subject: `RevenueDot just saw ${proj(c)}'s first live sale`,
    preheader: "Store notifications are reaching RevenueDot. Next, compare both sides.",
    heading: "Your first live sale on RevenueDot",
    paragraphs: [
      c.sale
        ? `${hi(c)} RevenueDot just recorded **${c.sale.product}**${c.sale.amount ? ` for **${c.sale.amount}**` : ""}${c.sale.country ? ` from ${c.sale.country}` : ""}, so store notifications are reaching it.`
        : `${hi(c)} RevenueDot just recorded ${proj(c)}'s first live sale, so store notifications are reaching it.`,
      "Next, compare both sides with `npx revenuedot import verify`. When they match for a week, you're ready to switch.",
    ],
    button: { label: "Check the numbers", url: `${docs("migrate/importer")}#check-the-result-with-import-verify` },
  } : {
    look: "guide",
    subject: "Your first real sale through RevenueDot",
    preheader: c.sale ? `${c.sale.product}${c.sale.amount ? ` for ${c.sale.amount}` : ""}${c.sale.country ? ` from ${c.sale.country}` : ""}. Congratulations.` : "Congratulations on your first sale.",
    heading: "Congratulations on your first sale",
    paragraphs: [
      c.sale
        ? `${hi(c)} ${proj(c)} just recorded its first production purchase through RevenueDot: **${c.sale.product}**${c.sale.amount ? ` for **${c.sale.amount}**` : ""}${c.sale.country ? ` from ${c.sale.country}` : ""}. That's a real customer paying for what you built.`
        : `${hi(c)} ${proj(c)} just recorded its first production purchase through RevenueDot. That's a real customer paying for what you built.`,
      "Over the next few weeks I'll send one short email each on paywalls, payment recovery and your team.",
    ],
    button: { label: "See the sale", url: dash(c, "/overview") },
  }),

  standard_welcome: (c) => ({
    look: "guide",
    subject: "Welcome to Cloud Standard",
    preheader: "0.5% above $10,000 a month, never more than $999. The rate never rises.",
    heading: "Thank you for upgrading",
    paragraphs: [
      `${hi(c)} you're on Cloud Standard. You pay $0 while your apps track under $10,000 a month, then 0.5% above that, never more than $999 a month. The rate never rises. Billing starts on the 1st of next month, with no proration.`,
      "Standard also includes:",
    ],
    bullets: [
      "**Single sign-on** with SAML or OpenID Connect, and required SSO for your team.",
      "**Organizations and custom roles** for every project.",
      "**Email support** with a first reply within 2 business days. Reply to this email to reach us.",
    ],
    button: { label: "See billing and invoices", url: `${c.app}/account/billing` },
    links: [{ label: "Set up single sign-on", url: docs("guides/single-sign-on") }, { label: "How Cloud billing works", url: docs("guides/cloud-billing") }],
  }),

  standard_canceled: (c) => ({
    look: "letter",
    subject: "Could you tell me why you left Standard?",
    preheader: "One line helps. Your apps keep working on Cloud Free.",
    paragraphs: [
      hi(c),
      "I saw that your account moved off Cloud Standard. Your apps keep working on Cloud Free, and nothing about your data changes.",
      "Could you tell me why, in one line? Price, a missing feature or a bug: whatever it was, I'd like to fix it.",
    ],
  }),

  paywalls: (c) => ({
    look: "guide",
    subject: "Edit your paywall from the dashboard",
    preheader: "Start from a template, edit it in the dashboard, publish.",
    heading: "Your paywall, editable any time",
    paragraphs: [
      `${hi(c)} the paywall is where customers decide to pay. With RevenueDot you edit it in the dashboard: start from a template, change the words and prices, preview light and dark, and publish.`,
      "Your app needs one release that shows paywalls with RevenueCatUI's `PaywallView` (iOS SDK 5.83 or later). After that, each change reaches your app on its next launch.",
    ],
    video: "paywalls-and-experiments",
    button: { label: "Pick a paywall template", url: dash(c, "/paywalls/templates") },
    links: [
      { label: "Paywall best practices for 2026", url: `${SITE}/blog/paywall-best-practices-2026` },
      { label: "The free trial timeline paywall", url: `${SITE}/blog/free-trial-timeline-paywall` },
    ],
  }),

  experiments: (c) => ({
    look: "guide",
    subject: "Annual first or monthly first? Test it",
    preheader: "Show new customers two offerings and see which earns more per customer.",
    heading: "Your next lift is one test away",
    paragraphs: [
      `${hi(c)} your paywall is live. The quickest next win is usually a test: annual plan first or monthly first, a longer trial, or a new headline.`,
      "RevenueDot splits new customers between two versions and shows the lift in revenue per customer, with a confidence interval and the chance each version wins.",
    ],
    video: "paywalls-and-experiments",
    button: { label: "Start an experiment", url: dash(c, "/experiments/new") },
    links: [
      { label: "How experiments work", url: docs("guides/experiments") },
      { label: "A guide to paywall A/B tests", url: `${SITE}/blog/paywall-ab-testing-guide` },
    ],
  }),

  recovery: (c) => ({
    look: "guide",
    subject: "Recover renewals that fail",
    preheader: "Email customers whose card was declined a link to fix it.",
    heading: "Save renewals that fail",
    paragraphs: [
      `${hi(c)} some renewals fail because a card expired or a bank said no. Those customers didn't mean to leave.`,
      "Turn on **Payment recovery** and RevenueDot emails each one who has an email address on file (the `$email` attribute) a link to fix their payment, in your app's name. You see how many came back and how much revenue they saved.",
    ],
    button: { label: "Turn on payment recovery", url: dash(c, "/lifecycle/payment-recovery") },
    links: [{ label: "How payment recovery works", url: docs("guides/payment-recovery") }, { label: "Win-back offers for churned customers", url: docs("guides/win-back-offers") }],
  }),

  team: (c) => ({
    look: "guide",
    subject: "Bring your team into RevenueDot",
    preheader: "Seats are free, and each person gets the role they need.",
    heading: "Invite your team",
    paragraphs: [`${hi(c)} ${proj(c)} has one person in it so far. Seats are free and unlimited, so bring in whoever touches revenue:`],
    bullets: [
      "**Developer** for engineers: apps, products, customers and integrations.",
      "**Viewer** for founders, growth and finance: every chart, no changes.",
      "**Admin** for whoever manages keys and members.",
    ],
    button: { label: "Invite a teammate", url: dash(c, "/settings/collaborators") },
  }),

  how_going: (c) => ({
    look: "letter",
    subject: `How is RevenueDot working for ${proj(c)}?`,
    preheader: "Two weeks live. One line back helps a lot.",
    paragraphs: [
      hi(c),
      `${proj(c)} has been selling through RevenueDot for two weeks. Thank you for trusting us with your purchases.`,
      "How is it going, and what's the one thing you'd change? One line back is plenty.",
    ],
  }),

  assistant: (c) => ({
    look: "guide",
    subject: "Ask ChatGPT or Claude about your subscriptions",
    preheader: "Look up customers, grant access and check your setup from chat.",
    heading: "Run your subscriptions from chat",
    paragraphs: [
      `${hi(c)} connect RevenueDot to ChatGPT, Claude or Cursor and ask in plain words: "Why didn't this customer get Pro?", "Grant them 7 days", "Which webhooks failed today?"`,
      "Paste `https://mcp.revenuedot.app/mcp` into your assistant's connector settings and sign in. It takes two minutes. You choose what the assistant may do, and refunds and cancellations always wait for your approval.",
    ],
    video: "chatgpt-demo",
    button: { label: "Connect an assistant", url: docs("guides/connect-ai-assistants") },
  }),

  pricing_explainer: (c) => ({
    look: "guide",
    subject: "How your RevenueDot bill works as you grow",
    preheader: `Your apps tracked ${usd(c.tracked ?? 0)} so far in ${c.month ?? "this month"}. Here's what Cloud costs from here.`,
    heading: "No surprises on your bill",
    paragraphs: [
      `${hi(c)} your apps have tracked **${usd(c.tracked ?? 0)}** so far in ${c.month ?? "this month"}. Congratulations on the growth.`,
      "Cloud is free while your store revenue, before Apple and Google take their cut, stays under $10,000 a month. Above that, Cloud Standard costs 0.5% of the revenue above $10,000, never more than $999 a month:",
    ],
    table: c.priceRows ? {
      head: ["Monthly revenue", "RevenueDot", "RevenueCat"],
      rows: c.priceRows.map(([r, rd, rc]) => [usd(r), usd(rd), usd(rc)]),
      note: "RevenueCat charges 1% of all revenue once you pass $2,500 a month.",
    } : undefined,
    after: ["Adding a card now costs nothing: Standard is $0 until you pass $10,000, and nothing about your apps changes."],
    button: { label: "Upgrade to Standard ($0 today)", url: `${c.app}/account/billing` },
  }),

  upgrade_nudge: (c) => ({
    look: "guide",
    subject: "Two minutes to move to Cloud Standard",
    preheader: c.bills ? `On ${usd(c.overTracked ?? 0)} a month: ${usd(c.bills.revenuedot)} on Standard.` : "0.5% above $10,000, capped at $999 a month.",
    heading: "Your apps outgrew Cloud Free",
    paragraphs: [
      `${hi(c)} your apps tracked **${usd(c.overTracked ?? 0)}** in ${c.overMonth ?? "a month"}, past Cloud Free's $10,000. Your apps keep working either way. Standard is the plan for apps your size.`,
      c.bills
        ? `On ${usd(c.overTracked ?? 0)} a month, your Standard bill would be **${usd(c.bills.revenuedot)}**. For comparison, RevenueCat would charge ${usd(c.bills.revenuecat)}. Billing starts on the 1st of next month, with no proration.`
        : "Standard is 0.5% of the revenue above $10,000, never more than $999 a month. Billing starts on the 1st of next month, with no proration.",
    ],
    button: { label: "Upgrade to Standard", url: `${c.app}/account/billing` },
    links: [{ label: "How Cloud billing works", url: docs("guides/cloud-billing") }],
    ps: "Need your company's name and tax ID on invoices? Checkout asks for both.",
  }),

  upgrade_personal: (c) => ({
    look: "letter",
    subject: c.first ? `${c.first}, anything blocking the upgrade?` : "Anything blocking the upgrade?",
    preheader: "If checkout or invoices are in the way, reply and I'll sort it out.",
    paragraphs: [
      hi(c),
      `Your apps passed $10,000 in tracked revenue in ${c.overMonth ?? "a recent month"} (${usd(c.overTracked ?? 0)}). Congratulations, that's a real milestone.`,
      "Is anything stopping you from moving to Cloud Standard? If something about checkout or invoices is in the way, reply and I'll sort it out.",
      `[Upgrade here](${c.app}/account/billing) when you're ready.`,
    ],
  }),

  enterprise: (c) => ({
    look: "letter",
    subject: "An SLA and a named engineer for your apps",
    preheader: "Our Enterprise plan, in one email.",
    paragraphs: [
      hi(c),
      `Your apps tracked ${usd(c.tracked ?? 0)} so far this month. At that size, teams usually want an uptime SLA on the purchase path, a named engineer, faster support and a DPA. That's our Enterprise plan.`,
      `Want to talk it through? [Pick a time here](${BOOKING_URL}).`,
    ],
  }),

  referral: (c) => ({
    look: "guide",
    subject: "Know a team paying RevenueCat 1%?",
    preheader: "Share your link. I'll help them switch myself.",
    heading: "Help a friend keep more of their revenue",
    paragraphs: [
      `${hi(c)} ${proj(c)} has been selling through RevenueDot since ${c.liveSince ?? "your first sale"}. Thank you for building on us.`,
      "If you know a founder still paying 1% of revenue for subscriptions, share your link with them, or post it on X. They keep the SDK their app already ships, and I'll help them plan the switch myself.",
    ],
    copyBox: c.referralUrl ? { label: "Your link", text: c.referralUrl } : undefined,
    button: c.referralUrl ? { label: "Share on X", url: `https://x.com/intent/post?text=${encodeURIComponent(`I run my app's subscriptions on @revenuedot: open source, works with the RevenueCat SDK, free up to $10K a month. ${c.referralUrl}`)}` } : undefined,
    links: c.referralUrl ? [{ label: "Share on LinkedIn", url: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(c.referralUrl)}` }] : [],
  }),

  referral_joined: (c) => ({
    look: "letter",
    subject: "Your friend just signed up for RevenueDot",
    preheader: "Thank you for sharing your link.",
    paragraphs: [
      hi(c),
      "Someone just created a RevenueDot account with your link. Thank you for sharing it.",
      "I'll make sure they get set up well. If they're moving from RevenueCat, tell them they can reply to any of my emails and I'll help.",
    ],
  }),

  went_quiet: (c) => ({
    look: "letter",
    subject: `Is everything OK with ${proj(c)}?`,
    preheader: "Your app hasn't reached RevenueDot for a week.",
    paragraphs: [
      hi(c),
      `${proj(c)}'s app hasn't reached RevenueDot for a week${c.lastSaleAt ? `, and its last sale was on ${c.lastSaleAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}` : ""}.`,
      "If something broke on our side, reply and I'll look at it within one business day. If you paused the app or moved to something else, could you tell me why in one line? It helps me make RevenueDot better.",
    ],
  }),

  teammate_welcome: (c) => ({
    look: "guide",
    subject: `You're in ${proj(c)} on RevenueDot`,
    preheader: "Where things are, in one minute.",
    heading: `Welcome to ${proj(c)}`,
    paragraphs: [`${hi(c)} ${c.inviter ? `${c.inviter} added you to` : "you joined"} ${proj(c)} on RevenueDot. Here's where things are:`],
    bullets: [
      "**Overview** shows revenue, MRR, trials and new customers at a glance.",
      "**Customers** finds anyone by app user ID, email or transaction ID.",
      "**Charts** has more than 40 charts, from MRR to trial conversion.",
    ],
    button: { label: "Open the project", url: dash(c, "/overview") },
    links: [{ label: "Connect an app to the project", url: docs("getting-started/connect-your-app") }, { label: "RevenueDot docs", url: `${SITE}/docs` }],
  }),
};

/** Steps whose footer says they stop once the app is live. */
const ONBOARDING = new Set<StepId>(["welcome", "verify_reminder", "first_purchase", "checkin", "connect_app", "ai_setup", "store_keys", "go_live", "need_hand", "last_call", "switch_plan", "import_help", "side_by_side", "forwarding_check"]);

// ---------- layout ----------

function render(c: JourneyCtx, m: JourneyMail): Rendered {
  const s = c.step;
  const t = (x: string) => inline(x, s, "text");
  const h = (x: string) => inline(x, s, "html");
  const footerReason = ONBOARDING.has(s)
    ? "You're getting this because you signed up for RevenueDot Cloud. Setup emails stop once your app is live."
    : "You're getting this because you have a RevenueDot Cloud account.";
  // Fills the inbox preview after the preheader, so the start of the body never shows there.
  const pad = "&#8203;&nbsp;".repeat(Math.max(0, 110 - m.preheader.length));
  const prefs = tag(`${c.app}/account/notifications`, s);

  if (m.look === "letter") {
    // A personal note: plain paragraphs, no logo or button, so it reads and renders like an email from a person.
    const p = (x: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};word-break:break-word;">${/^https?:\/\/\S+$/.test(x) ? `<a href="${esc(tag(x, s))}" style="color:${INK};">${esc(x.length > 70 ? x.replace(/^(https?:\/\/[^/]+\/).*/, "$1…") : x)}</a>` : h(x)}</p>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(m.subject)}</title></head>` +
      `<body style="margin:0;padding:0;background:#FFFFFF;"><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(m.preheader)}${pad}</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:24px 16px;">` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT};"><tr><td>` +
      m.paragraphs.map(p).join("") +
      `<p style="margin:0 0 4px;font-size:15px;line-height:24px;color:${INK};">Kai</p><p style="margin:0 0 28px;font-size:13px;line-height:20px;color:${FG2};">Founder, RevenueDot</p>` +
      `<p style="margin:0;font-size:12px;line-height:18px;color:${FG3};">Don't want these? <a href="${esc(c.unsubscribeUrl)}" style="color:${FG3};">Unsubscribe</a></p>` +
      `</td></tr></table></td></tr></table></body></html>`;
    const text = [...m.paragraphs.map(t).flatMap((x) => [x, ""]), "Kai", "Founder, RevenueDot", "", `Don't want these? Unsubscribe: ${c.unsubscribeUrl}`].join("\n");
    return { subject: m.subject, text, html };
  }

  const P = (x: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};">${h(x)}</p>`;
  const small = (x: string) => `<p style="margin:0 0 14px;font-size:14px;line-height:22px;color:${FG2};">${h(x)}</p>`;
  const steps = m.steps?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;border-collapse:collapse;">` +
      m.steps.map((x, i) => `<tr><td valign="top" style="width:30px;padding:12px 0;border-top:1px solid ${BORDER};font-family:${MONO};font-size:13px;line-height:22px;color:${FG3};">${String(i + 1).padStart(2, "0")}</td>` +
        `<td valign="top" style="padding:12px 0;border-top:1px solid ${BORDER};"><p style="margin:0;font-size:15px;line-height:22px;font-weight:600;color:${INK};">${h(x.title)}</p>` +
        (x.text ? `<p style="margin:4px 0 0;font-size:14px;line-height:22px;color:${FG2};">${h(x.text)}</p>` : "") + `</td></tr>`).join("") +
      `<tr><td colspan="2" style="border-top:1px solid ${BORDER};font-size:0;line-height:0;">&nbsp;</td></tr></table>`
    : "";
  const bullets = m.bullets?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">` +
      m.bullets.map((x) => `<tr><td valign="top" style="width:18px;padding:0 0 10px;"><span style="display:inline-block;width:6px;height:6px;background:${INK};margin-top:9px;"></span></td><td valign="top" style="padding:0 0 10px;font-size:15px;line-height:24px;color:${INK};">${h(x)}</td></tr>`).join("") +
      `</table>`
    : "";
  const code = m.code
    ? `<p style="margin:0 0 6px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${FG3};">${esc(m.code.label)}</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td style="background:${PANEL};border:1px solid ${BORDER};padding:12px 14px;font-family:${MONO};font-size:13px;line-height:20px;color:${INK};word-break:break-word;">${esc(m.code.text)}</td></tr></table>`
    : "";
  const table = m.table
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;border-collapse:collapse;">` +
      `<tr>${m.table.head.map((x, i) => `<td style="padding:0 0 8px;border-bottom:1px solid ${BORDER};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${FG3};${i ? "text-align:right;" : ""}">${esc(x)}</td>`).join("")}</tr>` +
      m.table.rows.map((r) => `<tr>${r.map((x, i) => `<td style="padding:10px 0;border-bottom:1px solid ${BORDER};font-size:14px;line-height:20px;color:${INK};${i ? `text-align:right;font-family:${MONO};` : ""}">${esc(x)}</td>`).join("")}</tr>`).join("") +
      `</table>` + (m.table.note ? `<p style="margin:0 0 20px;font-size:12px;line-height:18px;color:${FG3};">${h(m.table.note)}</p>` : `<div style="height:8px;"></div>`)
    : "";
  const video = m.video && VIDEOS[m.video].ready
    ? (() => {
      const v = VIDEOS[m.video], url = esc(tag(videoUrl(m.video), s));
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;"><tr><td style="border:1px solid ${BORDER};">` +
        `<a href="${url}" style="display:block;text-decoration:none;"><img src="${esc(videoCover(m.video))}" width="518" alt="Play the video: ${esc(v.title)} (${v.length})" style="display:block;width:100%;max-width:518px;height:auto;border:0;outline:none;background:${PANEL};font-family:${FONT};font-size:14px;color:${FG2};"></a>` +
        `</td></tr><tr><td style="padding:10px 0 0;font-size:13px;line-height:20px;color:${FG2};"><a href="${url}" style="color:${INK};font-weight:600;text-decoration:none;">&#9654;&nbsp; Watch: ${esc(v.title)}</a> <span style="color:${FG3};font-family:${MONO};font-size:12px;">${v.length}</span></td></tr></table>`;
    })()
    : "";
  const button = m.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;"><tr><td style="background:${INK};">` +
      `<a href="${esc(tag(m.button.url, s))}" style="display:inline-block;padding:13px 22px;font-family:${FONT};font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#FFFFFF;text-decoration:none;">${esc(m.button.label)} &rarr;</a></td></tr></table>`
    : "";
  const copyBox = m.copyBox
    ? `<p style="margin:0 0 6px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${FG3};">${esc(m.copyBox.label)}</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td style="border:1px solid ${INK};padding:12px 14px;font-family:${MONO};font-size:14px;line-height:20px;color:${INK};word-break:break-all;">${esc(m.copyBox.text)}</td></tr></table>`
    : "";
  const links = m.links?.length
    ? `<p style="margin:0 0 8px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${FG3};">Useful links</p>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">` +
      m.links.map((l) => `<tr><td style="padding:7px 0;border-top:1px solid ${BORDER};font-size:14px;line-height:20px;"><a href="${esc(tag(l.url, s))}" style="color:${INK};text-decoration:none;">${esc(l.label)} &rarr;</a></td></tr>`).join("") +
      `</table>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(m.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#FFFFFF;">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(m.preheader)}${pad}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;font-family:${FONT};">` +
    `<tr><td style="padding:0 0 28px;"><a href="${esc(tag(SITE, s))}"><img src="${LOGO_URL}" width="168" height="24" alt="RevenueDot" style="display:block;border:0;outline:none;font-family:${FONT};font-size:15px;font-weight:600;color:${INK};"></a></td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:28px 0 4px;">` +
    (m.heading ? `<h1 style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${INK};">${esc(m.heading)}</h1>` : "") +
    m.paragraphs.map(P).join("") + steps + bullets + code + table + (m.after ?? []).map(small).join("") + video + copyBox + button + links +
    (m.ps ? `<p style="margin:0 0 20px;font-size:14px;line-height:22px;color:${FG2};"><strong style="font-weight:600;color:${INK};">P.S.</strong> ${h(m.ps)}</p>` : "") +
    `<p style="margin:0;font-size:15px;line-height:24px;color:${INK};">Kai</p><p style="margin:0 0 28px;font-size:13px;line-height:20px;color:${FG2};">Founder, RevenueDot &middot; reply any time</p>` +
    `</td></tr>` +
    `<tr><td style="border-top:1px solid ${BORDER};padding:20px 0 0;font-size:12px;line-height:18px;color:${FG3};">` +
    `${esc(footerReason)}<br><a href="${esc(prefs)}" style="color:${FG3};">Email preferences</a> &middot; <a href="${esc(c.unsubscribeUrl)}" style="color:${FG3};">Unsubscribe</a>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = [
    ...(m.heading ? [m.heading, ""] : []),
    ...m.paragraphs.flatMap((x) => [t(x), ""]),
    ...(m.steps ?? []).flatMap((x, i) => [`${i + 1}. ${t(x.title)}${x.text ? `: ${t(x.text)}` : ""}`]),
    ...(m.steps?.length ? [""] : []),
    ...(m.bullets ?? []).map((x) => `- ${t(x)}`),
    ...(m.bullets?.length ? [""] : []),
    ...(m.code ? [`${m.code.label}:`, ...m.code.text.split("\n").map((l) => `    ${l}`), ""] : []),
    ...(m.table ? [...m.table.rows.map((r) => `${r[0]}: ${r[1]}${r[2] ? ` / ${r[2]}` : ""}`), ...(m.table.note ? [t(m.table.note)] : []), ""] : []),
    ...(m.after ?? []).flatMap((x) => [t(x), ""]),
    ...(m.video && VIDEOS[m.video].ready ? [`Watch: ${VIDEOS[m.video].title} (${VIDEOS[m.video].length}): ${tag(videoUrl(m.video), s)}`, ""] : []),
    ...(m.copyBox ? [`${m.copyBox.label}: ${m.copyBox.text}`, ""] : []),
    ...(m.button ? [`${m.button.label}: ${tag(m.button.url, s)}`, ""] : []),
    ...(m.links ?? []).map((l) => `${l.label}: ${tag(l.url, s)}`),
    ...(m.links?.length ? [""] : []),
    ...(m.ps ? [`P.S. ${t(m.ps)}`, ""] : []),
    "Kai", "Founder, RevenueDot (reply any time)", "", "--",
    footerReason, `Email preferences: ${prefs}`, `Unsubscribe: ${c.unsubscribeUrl}`,
  ].join("\n");
  return { subject: m.subject, text, html };
}

/** The email for one step. */
export function journeyEmail(c: JourneyCtx): Rendered {
  return render(c, EMAILS[c.step](c));
}

export const STEP_IDS = Object.keys(EMAILS) as StepId[];
