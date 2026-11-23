// Seven pages that answer "X alternative", "X pricing" and "open-source RevenueCat" searches (company rank plan, items
// 2, 3 and 5): /adapty-alternative, /superwall-alternative, /qonversion-alternative, /apphud-alternative,
// /pricing/adapty, /pricing/superwall and /open-source-revenuecat. Rules: apps/site/CONTENT.md.
// Vendor prices were checked against each vendor's own pricing page on 2026-11-22; GitHub numbers come from
// `gh api repos/<owner>/<repo>` on the same day. Imports use .ts so scripts/og.mjs can load this file in plain Node.
import type { Block, Source } from "./types";
import type { Faq } from "../site";
import { cloudBill, usd } from "../lib/pricing.ts";

export const CHECKED = "November 2026";
export const CHECKED_DAY = "2026-11-22";

const src = (label: string, url: string): Source => ({ label, url });
const link = (s: Source) => `[${s.label}](${s.url})`;
const sourcesLine = (list: Source[]) => `Sources, checked ${CHECKED}: ${list.map(link).join(", ")}.`;

// ---- Sources ---------------------------------------------------------------------------------------------------------
const AD_PRICING = src("Adapty pricing page", "https://adapty.io/pricing/");
const AD_SEC = src("Adapty security and compliance", "https://adapty.io/security-and-compliance/");
const AD_DOCS = src("Adapty docs index", "https://adapty.io/docs/llms.txt");
const AD_GH = src("Adapty iOS SDK on GitHub (MIT)", "https://github.com/adaptyteam/AdaptySDK-iOS");
const SW_PRICING = src("Superwall pricing page", "https://superwall.com/pricing");
const SW_FAQ = src("Superwall pricing FAQ", "https://superwall.com/docs/support/faq/2801653905-how-does-superwalls-pricing-work");
const SW_LLMS = src("Superwall llms.txt", "https://superwall.com/llms.txt");
const SW_A2W = src("Superwall App-to-Web Checkout", "https://superwall.com/features/app-to-web-checkout");
const SW_GDPR = src("Superwall GDPR page", "https://superwall.com/legal/gdpr");
const SW_GH = src("Superwall iOS SDK on GitHub (MIT)", "https://github.com/superwall/Superwall-iOS");
const QO_PRICING = src("Qonversion pricing page", "https://qonversion.io/pricing");
const QO_DOCS = src("Qonversion docs index", "https://documentation.qonversion.io/llms.txt");
const QO_MCP = src("Qonversion MCP server docs", "https://documentation.qonversion.io/docs/mcp-server");
const QO_GH = src("Qonversion iOS SDK on GitHub (MIT)", "https://github.com/qonversion/qonversion-ios-sdk");
const AP_PRICING = src("Apphud pricing page", "https://apphud.com/pricing");
const AP_DATA = src("Apphud data protection page", "https://apphud.com/data-protection");
const AP_WEB = src("Apphud web payments docs", "https://docs.apphud.com/docs/web-payments");
const AP_MCP = src("Apphud MCP docs", "https://docs.apphud.com/docs/mcp");
const AP_GH = src("Apphud iOS SDK on GitHub (MIT)", "https://github.com/apphud/ApphudSDK");
const RC_PRICING = src("RevenueCat pricing page", "https://www.revenuecat.com/pricing/");
const RD_PRICING = src("RevenueDot pricing", "/pricing");

// ---- RevenueDot cells (facts from src/lib/pricing.ts and the merged product) -------------------------------------------
const RD = {
  source: "Open source: server and dashboard AGPL-3.0, SDK forks, CLI and MCP server MIT",
  where: "RevenueDot Cloud",
  sdk: "The stock RevenueCat SDKs with one proxy line, or RevenueDot's forks of all ten",
  price: "Pro: $0 until $10K a month, then 0.5% above $10K, never more than $999",
  stores: "App Store, Google Play, Amazon Appstore, Samsung Galaxy Store, Roku, Stripe and Paddle",
  web: "Stripe checkout, purchase links, funnels and web discounts",
  paywalls: "Visual editor, 10 templates, AI generator, localization; single-screen paywalls",
  experiments: "Audiences, placements and offering A/B tests with chance to win",
  charts: "43 charts with filters, segments and CSV export",
  integrations: "36 integrations, webhooks and scheduled exports to S3, R2, GCS or Azure",
  compliance: "No SOC 2 report yet",
  maturity: "Launched in 2026; far less production history",
  mcp: "Hosted MCP server at mcp.revenuedot.app",
};

const LEVELS = [10_000, 100_000, 1_000_000];
const rd = (m: number) => usd(cloudBill(m));

/** A fee table at $10K, $100K and $1M a month: vendor cells next to RevenueDot Pro. */
function feeTable(head: string, cell: (m: number) => string, caption: string): NonNullable<Block["table"]> {
  return {
    head: ["Monthly tracked revenue", head, "RevenueDot Pro"],
    rows: LEVELS.map((m) => [usd(m), cell(m), rd(m)]),
    caption,
  };
}

const MOVE_STEPS = (vendor: string) => [
  { name: "Set up RevenueDot", text: `Create an account on RevenueDot Cloud, add your App Store and Google Play credentials, and recreate your products, entitlements and offerings. Point the stores' server notifications at RevenueDot.` },
  { name: "Swap the SDK", text: `Replace the ${vendor} SDK with the RevenueDot SDK. Its code says \`import RevenueCat\` because it is built from RevenueCat's MIT SDK, and it needs no RevenueCat account.` },
  { name: "Run both, then switch", text: `Ship the release and keep ${vendor} running for a billing cycle. Active subscribers reappear as their store receipts reach RevenueDot. Compare entitlements, then turn ${vendor} off.` },
];

export type VendorPage = {
  path: string;
  /** Breadcrumb and card name. */
  name: string;
  parents?: { name: string; path: string }[];
  label: string;
  /** The H1. */
  title: string;
  metaTitle: string;
  metaDescription: string;
  card: string;
  /** Answer-first lede, 40 to 70 words, with a number. */
  answer: string;
  secondary?: { href: string; label: string };
  blocks: Block[];
  /** Pricing pages: the calculator, rendered after this many blocks. */
  calc?: { after: number; vendor: string; plans: { id: string; label: string; fee: number; from: number; rate: number; min?: number }[]; share?: boolean; note: string; sources: Source[] };
  faq: Faq[];
  related: string[];
  /** The social card: a caption and rows of name and amount. */
  og: { cap: string; rows: [string, string][] };
};

// ---- /adapty-alternative -------------------------------------------------------------------------------------------
const ADAPTY_ALT: VendorPage = {
  path: "/adapty-alternative",
  name: "Adapty alternative",
  label: "Adapty alternative",
  title: "The open-source Adapty alternative that is free until $10K a month",
  metaTitle: "Adapty Alternative: Open Source, Free to $10K",
  metaDescription: "An open-source Adapty alternative: $0 until $10K a month, then 0.5%, capped at $999. Fees at $10K, $100K and $1M and 11 features, checked November 2026.",
  card: "Adapty charges 1% of all revenue past $5K. RevenueDot is open source, $0 to $10K a month, capped at $999.",
  answer:
    "RevenueDot is an open-source Adapty alternative. Adapty charges **1% of all monthly revenue once you pass $5,000**: $1,000 at $100,000 a month. RevenueDot Pro costs $0 until your apps make $10,000 a month, then 0.5% of revenue above that, never more than $999: $450 at $100,000. Adapty is stronger on onboarding flows and holds SOC 2 Type II.",
  secondary: { href: "/blog/migrate-from-adapty", label: "Migrate from Adapty" },
  blocks: [
    {
      h2: "How much does Adapty cost next to RevenueDot?",
      label: "Fees",
      paras: [
        "Adapty's Pro plan is free while you earn under $5,000 a month. Once you cross $5,000 in a rolling 30 days, it bills 1% of each month's full tracked revenue, and its FAQ says billing continues even if revenue later falls below $5,000. Revenue is counted in USD before the stores take their cut.",
      ],
      table: feeTable("Adapty Pro", (m) => usd(m > 5_000 ? m * 0.01 : 0), `Adapty add-ons and Enterprise are not included. ${sourcesLine([AD_PRICING, RD_PRICING])}`),
    },
    {
      h2: "How do Adapty and RevenueDot compare feature by feature?",
      label: "Features",
      table: {
        head: ["", "Adapty", "RevenueDot"],
        rows: [
          ["Source code", "SDKs open source (MIT); the backend is Adapty's hosted service", RD.source],
          ["Where it runs", "Adapty's cloud; US or EU data residency on Enterprise", RD.where],
          ["Client SDK", "Adapty's own SDKs", RD.sdk],
          ["Price", "Free under $5K a month, then 1% of all tracked revenue", RD.price],
          ["Add-on fees", "Refund Saver 0.2% of revenue, Ads Manager 3.5% of ad spend, Mail 20% of extra revenue, attribution priced on request", "None"],
          ["Stores and web", "App Store, Google Play, web payments through Stripe and Paddle", RD.stores],
          ["Paywalls", "Flow and paywall builder with onboarding flows, templates and an AI generator", RD.paywalls],
          ["A/B tests", "A/B tests with custom splits and unlimited variants", RD.experiments],
          ["Analytics", "Revenue, MRR, churn, cohorts and predicted LTV", RD.charts],
          ["Integrations", "Attribution, analytics and messaging integrations, webhooks, S3 export", RD.integrations],
          ["Compliance", "SOC 2 Type II and GDPR on every plan", RD.compliance],
        ],
        caption: sourcesLine([AD_PRICING, AD_SEC, AD_DOCS, AD_GH]),
      },
    },
    {
      h2: "Where is Adapty stronger than RevenueDot?",
      label: "Honest view",
      bullets: [
        "**Compliance.** Adapty lists SOC 2 Type II and a 99.99% uptime SLA on every plan, per its [pricing page](https://adapty.io/pricing/). RevenueDot has no SOC 2 report yet.",
        "**Onboarding flows.** Adapty's builder combines onboarding screens and paywalls. RevenueDot's paywalls are single-screen.",
        "**Track record.** Adapty has years of production traffic. RevenueDot launched in 2026.",
        "**Paddle web payments and payout advances** through Adapty Finance, from 2.5% per advance.",
      ],
    },
    {
      h2: "How do I move from Adapty to RevenueDot?",
      label: "Switch",
      paras: ["RevenueDot's importer reads RevenueCat projects, not Adapty ones, so the move from Adapty is an SDK swap with a side-by-side run. The full walkthrough is in [Migrate from Adapty](/blog/migrate-from-adapty)."],
      steps: MOVE_STEPS("Adapty"),
    },
  ],
  faq: [
    { q: "What is the best Adapty alternative?", a: "For a lower bill and open source, RevenueDot: $0 until your apps make $10,000 a month, then 0.5% of revenue above that, capped at $999. Qonversion charges 0.8% of all revenue past $7,000. RevenueCat charges 1% of all revenue from $2,500. Adapty itself charges 1% of all revenue past $5,000." },
    { q: "Is RevenueDot cheaper than Adapty?", a: "Yes, above $5,000 a month. At $10,000 Adapty costs $100 and RevenueDot $0. At $100,000 Adapty costs $1,000 and RevenueDot $450. At $1,000,000 Adapty costs $10,000 and RevenueDot $999, before Adapty's add-ons." },
    { q: "Does Adapty keep charging if my revenue drops below $5,000?", a: "Yes. Adapty's pricing FAQ says that once billing starts, it continues even if revenue later falls below $5,000. RevenueDot Pro charges nothing in any month your apps make $10,000 or less." },
    { q: "Is Adapty open source?", a: "Only its SDKs, which are MIT licensed on GitHub. The backend is Adapty's hosted service. RevenueDot's server and dashboard are open source under AGPL-3.0." },
    { q: "Can I move from Adapty to RevenueDot without losing subscribers?", a: "Yes. You recreate products and offerings, point store notifications at RevenueDot, swap the SDK, and run both for a billing cycle. Active subscribers reappear as their store receipts reach RevenueDot." },
  ],
  related: ["/pricing/adapty", "/compare/revenuedot-vs-adapty", "/blog/migrate-from-adapty", "/open-source-revenuecat", "/cheaper-revenuecat-alternatives", "/pricing"],
  og: { cap: "Monthly bill at $100,000", rows: [["Adapty", "$1,000"], ["RevenueDot Pro", "$450"]] },
};

// ---- /superwall-alternative ----------------------------------------------------------------------------------------
const SUPERWALL_ALT: VendorPage = {
  path: "/superwall-alternative",
  name: "Superwall alternative",
  label: "Superwall alternative",
  title: "The open-source Superwall alternative with paywalls included",
  metaTitle: "Superwall Alternative: Open Source, Capped at $999",
  metaDescription: "An open-source Superwall alternative with paywalls and a purchase backend: $0 until $10K a month, capped at $999. Fees and features, checked November 2026.",
  card: "Superwall bills 1% of paywall revenue past $10K. RevenueDot includes paywalls and caps the bill at $999.",
  answer:
    "RevenueDot is an open-source Superwall alternative with paywalls, experiments and the purchase backend in one product. Superwall's infrastructure is free, and its paywalls cost **1% of paywall-attributed revenue past $10,000 a month**: up to $1,000 at $100,000. RevenueDot Pro costs $0 until your apps make $10,000 a month, then 0.5% above that, never more than $999. Superwall's paywall tools are deeper.",
  secondary: { href: "/blog/migrate-from-superwall", label: "Migrate from Superwall" },
  blocks: [
    {
      h2: "How much does Superwall cost next to RevenueDot?",
      label: "Fees",
      paras: [
        "Superwall bills one thing: revenue that converts through a Superwall paywall. Entitlements, purchase APIs, receipt validation, webhooks and SQL access are free at any scale. The Indie plan is free up to $10,000 of paywall revenue a month, then 1%. Startup costs $49 a month and Scale $199, each plus 1%. If no purchase goes through its paywalls, Superwall costs $0.",
      ],
      table: feeTable(
        "Superwall Indie (range)",
        (m) => (m > 10_000 ? `$0 to ${usd(m * 0.01)}` : "$0"),
        `The Superwall range runs from no revenue through its paywalls to all of it. ${sourcesLine([SW_PRICING, SW_FAQ, RD_PRICING])}`,
      ),
    },
    {
      h2: "How do Superwall and RevenueDot compare feature by feature?",
      label: "Features",
      table: {
        head: ["", "Superwall", "RevenueDot"],
        rows: [
          ["What it is", "A paywall platform with free subscription infrastructure", "A purchase backend with paywalls, charts and refund tools"],
          ["Source code", "SDKs open source (MIT); the backend is a hosted service", RD.source],
          ["Client SDK", "Superwall's own SDKs", RD.sdk],
          ["Price", "Infrastructure free; paywalls free to $10K of paywall revenue, then 1%; Startup $49 and Scale $199 a month plus 1%", RD.price],
          ["What the bill counts", "Only revenue through Superwall paywalls", "All tracked revenue above $10K"],
          ["Stores and web", "App Store, Google Play and Stripe, with App-to-Web checkout", RD.stores],
          ["Paywalls", "Editor, templates, localization, AI builder and an editor MCP server", RD.paywalls],
          ["Experiments", "A/B/n tests, audiences, campaigns and placements", RD.experiments],
          ["Data access", "Charts plus read-only SQL through its Query API", RD.charts],
          ["In-app currency and ad revenue", "Says it runs no virtual currency and does not track ad revenue", "In-app currencies with a ledger, and an ads overview"],
          ["Compliance", "GDPR data processor with a DPA; no SOC 2 on its GDPR page", RD.compliance],
        ],
        caption: sourcesLine([SW_PRICING, SW_LLMS, SW_A2W, SW_GDPR, SW_GH]),
      },
    },
    {
      h2: "Where is Superwall stronger than RevenueDot?",
      label: "Honest view",
      bullets: [
        "**Paywall depth.** Campaigns, audiences, placements, Demand Score and an AI paywall builder with an editor MCP server.",
        "**App-to-Web Checkout** that sends US iOS users from a paywall to Stripe checkout, per its [feature page](https://superwall.com/features/app-to-web-checkout).",
        "**A $0 bill for teams that only need entitlements and webhooks**, at any scale, because Superwall bills only paywall revenue.",
        "**Track record.** Superwall has years of production paywall traffic. RevenueDot launched in 2026.",
      ],
    },
    {
      h2: "How do I move from Superwall to RevenueDot?",
      label: "Switch",
      paras: ["If Superwall renders paywalls on top of a purchase backend, RevenueDot's paywall editor replaces them. If Superwall is your purchase backend too, the move is an SDK swap. The full walkthrough is in [Migrate from Superwall](/blog/migrate-from-superwall)."],
      steps: MOVE_STEPS("Superwall"),
    },
  ],
  faq: [
    { q: "What is the best Superwall alternative?", a: "If you want paywalls and the purchase backend in one open-source product, RevenueDot: $0 until your apps make $10,000 a month, then 0.5% of revenue above that, capped at $999. RevenueCat and Adapty also sell paywalls, at 1% of all revenue from $2,500 and $5,000." },
    { q: "Is Superwall free?", a: "Partly. Superwall says entitlements, purchase APIs, webhooks and SQL access are free on every plan. Its paywalls are free up to $10,000 a month of paywall-attributed revenue on the Indie plan, then 1% of that revenue. Startup costs $49 a month and Scale $199, each plus 1%." },
    { q: "Is RevenueDot cheaper than Superwall?", a: "It depends on how much revenue goes through Superwall's paywalls. If none does, Superwall costs $0. If all of it does, Superwall costs $1,000 at $100,000 a month and $10,000 at $1,000,000, while RevenueDot costs $450 and $999." },
    { q: "Does RevenueDot have a paywall editor like Superwall?", a: "Yes. RevenueDot has a visual paywall editor, 10 templates, an AI generator, localization and offering A/B tests, and paywalls change without an app release. Its paywalls are single-screen, and Superwall's experiment tools go further." },
    { q: "Does Superwall support Amazon Appstore?", a: "No. Superwall's llms.txt lists the App Store, Google Play and Stripe. RevenueDot supports the App Store, Google Play, Amazon Appstore, Samsung Galaxy Store, Roku, Stripe and Paddle." },
  ],
  related: ["/pricing/superwall", "/compare/revenuedot-vs-superwall", "/blog/migrate-from-superwall", "/compare/revenuecat-vs-superwall-vs-revenuedot", "/open-source-revenuecat", "/features/paywalls"],
  og: { cap: "Monthly bill at $100,000", rows: [["Superwall", "$0 to $1,000"], ["RevenueDot Pro", "$450"]] },
};

// ---- /qonversion-alternative ---------------------------------------------------------------------------------------
const QONVERSION_ALT: VendorPage = {
  path: "/qonversion-alternative",
  name: "Qonversion alternative",
  label: "Qonversion alternative",
  title: "The open-source Qonversion alternative capped at $999 a month",
  metaTitle: "Qonversion Alternative: Open Source, Capped at $999",
  metaDescription: "An open-source Qonversion alternative: $0 until $10K a month, then 0.5%, never more than $999. Fees at $10K, $100K and $1M, checked November 2026.",
  card: "Qonversion charges 0.8% of all revenue past $7K. RevenueDot is open source and caps the bill at $999.",
  answer:
    "RevenueDot is an open-source Qonversion alternative. Qonversion charges **0.8% of all tracked revenue once you pass $7,000 a month**, with no ceiling: $800 at $100,000 and $8,000 at $1,000,000. RevenueDot Pro costs $0 until your apps make $10,000 a month, then 0.5% above that, never more than $999. Qonversion has more years in production and 24/7 support on its standard plan.",
  secondary: { href: "/blog/migrate-from-qonversion", label: "Migrate from Qonversion" },
  blocks: [
    {
      h2: "How much does Qonversion cost next to RevenueDot?",
      label: "Fees",
      paras: [
        "Qonversion has one Pro plan with every feature. It is free at or under $7,000 of monthly tracked revenue. Above that, the bill is 0.8% of your total tracked revenue, not only the part above $7,000: $64 at $8,000. Any month you finish at or under $7,000 is free.",
      ],
      table: feeTable("Qonversion Pro", (m) => usd(m > 7_000 ? m * 0.008 : 0), `Qonversion Enterprise is negotiated and not shown. ${sourcesLine([QO_PRICING, RD_PRICING])}`),
    },
    {
      h2: "How do Qonversion and RevenueDot compare feature by feature?",
      label: "Features",
      table: {
        head: ["", "Qonversion", "RevenueDot"],
        rows: [
          ["Source code", "SDKs open source (MIT); the backend is Qonversion's hosted service", RD.source],
          ["Where it runs", "Qonversion's cloud", RD.where],
          ["Client SDK", "Qonversion's own SDKs", RD.sdk],
          ["Price", "Free at or under $7K a month, then 0.8% of all tracked revenue, no ceiling", RD.price],
          ["Plans", "One Pro plan with every feature, unlimited apps and seats", "Pro with every feature, unlimited apps and teammates"],
          ["Stores and web", "App Store, Google Play, Stripe and Paddle", RD.stores],
          ["Paywalls", "No-Code Paywall Builder with remote changes and localization", RD.paywalls],
          ["Experiments", "A/B experiments on paywalls, pricing and onboarding", RD.experiments],
          ["Analytics", "LTV, cohorts, MRR and ARR, conversion charts", RD.charts],
          ["Refund tools", "Refund Keeper, included", "Refund Control, included"],
          ["AI assistants", "An MCP server for project data", RD.mcp],
        ],
        caption: sourcesLine([QO_PRICING, QO_DOCS, QO_MCP, QO_GH]),
      },
    },
    {
      h2: "Where is Qonversion stronger than RevenueDot?",
      label: "Honest view",
      bullets: [
        "**Support.** Qonversion includes priority support on its standard Pro plan, per its [pricing page](https://qonversion.io/pricing). RevenueDot Pro includes email support with a first reply within 2 business days.",
        "**Track record.** Qonversion has years of production traffic. RevenueDot launched in 2026.",
        "**A lower rate than RevenueCat or Adapty:** 0.8% of tracked revenue against their 1%, with every feature in one plan.",
      ],
    },
    {
      h2: "How do I move from Qonversion to RevenueDot?",
      label: "Switch",
      paras: ["RevenueDot's importer reads RevenueCat projects, not Qonversion ones, so the move is an SDK swap with a side-by-side run. The full walkthrough is in [Migrate from Qonversion](/blog/migrate-from-qonversion)."],
      steps: MOVE_STEPS("Qonversion"),
    },
  ],
  faq: [
    { q: "What is the best Qonversion alternative?", a: "For open source and a capped bill, RevenueDot: $0 until your apps make $10,000 a month, then 0.5% of revenue above that, never more than $999. RevenueCat charges 1% of all revenue from $2,500 and Adapty 1% past $5,000." },
    { q: "How much does Qonversion cost?", a: "Qonversion is free at or under $7,000 of monthly tracked revenue. Above that it charges 0.8% of all tracked revenue: $64 at $8,000, $400 at $50,000 and $8,000 at $1,000,000. Enterprise is negotiated." },
    { q: "Is RevenueDot cheaper than Qonversion?", a: "Yes, at every level above $7,000. At $10,000 Qonversion costs $80 and RevenueDot $0. At $100,000 Qonversion costs $800 and RevenueDot $450. At $1,000,000 Qonversion costs $8,000 and RevenueDot $999." },
    { q: "Is Qonversion open source?", a: "Only its SDKs, which are MIT licensed on GitHub. The backend is Qonversion's hosted service. RevenueDot's server and dashboard are open source under AGPL-3.0." },
  ],
  related: ["/compare/revenuedot-vs-qonversion", "/blog/migrate-from-qonversion", "/compare/revenuecat-vs-qonversion", "/open-source-revenuecat", "/cheaper-revenuecat-alternatives", "/pricing"],
  og: { cap: "Monthly bill at $100,000", rows: [["Qonversion", "$800"], ["RevenueDot Pro", "$450"]] },
};

// ---- /apphud-alternative -------------------------------------------------------------------------------------------
const apphudPro = (m: number) => Math.max(49, m * 0.0099);
const APPHUD_ALT: VendorPage = {
  path: "/apphud-alternative",
  name: "Apphud alternative",
  label: "Apphud alternative",
  title: "The open-source Apphud alternative with every feature on one plan",
  metaTitle: "Apphud Alternative: Open Source, Every Feature",
  metaDescription: "An open-source Apphud alternative with webhooks on every plan: $0 until $10K a month, then 0.5%, capped at $999. Fees and features, checked November 2026.",
  card: "Apphud Pro is 0.99% of all revenue with a $49 minimum. RevenueDot has one plan and caps the bill at $999.",
  answer:
    "RevenueDot is an open-source Apphud alternative. Apphud is free up to $10,000 a month, then Pro costs **0.99% of all tracked revenue, at least $49 a month**: $990 at $100,000. Server-to-server webhooks need its Expert plan at 1.19%. RevenueDot Pro costs $0 until your apps make $10,000 a month, then 0.5% above that, never more than $999, with every feature included.",
  blocks: [
    {
      h2: "How much does Apphud cost next to RevenueDot?",
      label: "Fees",
      paras: [
        "Apphud costs $0 up to $10,000 of monthly tracked revenue, with one seat. Pro costs 0.99% of all tracked revenue, at least $49 a month, with 5 seats. Expert costs 1.19%, at least $59, with 10 seats and server-to-server webhooks. Enterprise is for apps over $100,000 a month and is quoted. Paid plans are free in any month your revenue drops below $1,000.",
      ],
      table: feeTable(
        "Apphud",
        (m) => (m <= 10_000 ? "$0 (Free)" : m > 100_000 ? `Enterprise, quoted (${usd(apphudPro(m))} at the Pro rate)` : `${usd(apphudPro(m))} (Pro)`),
        `Expert costs 1.19% instead of 0.99%: $1,190 at $100,000. ${sourcesLine([AP_PRICING, RD_PRICING])}`,
      ),
    },
    {
      h2: "How do Apphud and RevenueDot compare feature by feature?",
      label: "Features",
      table: {
        head: ["", "Apphud", "RevenueDot"],
        rows: [
          ["Source code", "SDKs open source (MIT); the backend is Apphud's hosted service", RD.source],
          ["Where it runs", "Apphud's cloud, with data stored in the EU and US", RD.where],
          ["Client SDK", "Apphud's own SDKs", RD.sdk],
          ["Price", "Free to $10K; Pro 0.99% of all revenue, at least $49; Expert 1.19%, at least $59", RD.price],
          ["Past the free limit", "A 14-day grace period, then dashboard access ends until you upgrade", "Nothing stops; Pro charges 0.5% above $10K"],
          ["Webhooks", "Server-to-server webhooks on Expert and above", "Webhooks on every account"],
          ["Seats", "1 on Free, 5 on Pro, 10 on Expert", "Unlimited teammates with roles"],
          ["Stores and web", "iOS and Android, web funnels through Stripe or Paddle", RD.stores],
          ["Paywalls", "Visual screen builder and screens from Figma designs", RD.paywalls],
          ["Analytics", "Revenue analytics, cohorts and churn; LTV predictions on Expert", RD.charts],
          ["AI assistants", "A public MCP server", RD.mcp],
        ],
        caption: sourcesLine([AP_PRICING, AP_DATA, AP_WEB, AP_MCP, AP_GH]),
      },
    },
    {
      h2: "Where is Apphud stronger than RevenueDot?",
      label: "Honest view",
      bullets: [
        "**A free plan up to $10,000 a month**, the same limit as RevenueDot Pro and higher than RevenueCat's $2,500 or Adapty's $5,000.",
        "**No-code web funnels** (Flows) paid through Stripe or Paddle, and paywall screens built from Figma designs.",
        "**Data stored in the EU and US**, per its [data protection page](https://apphud.com/data-protection).",
        "**Track record.** Apphud has years of production traffic. RevenueDot launched in 2026.",
      ],
    },
    {
      h2: "How do I move from Apphud to RevenueDot?",
      label: "Switch",
      paras: ["RevenueDot's importer reads RevenueCat projects, not Apphud ones, so the move from Apphud is an SDK swap with a side-by-side run."],
      steps: MOVE_STEPS("Apphud"),
    },
  ],
  faq: [
    { q: "What is the best Apphud alternative?", a: "For open source and one plan with every feature, RevenueDot: $0 until your apps make $10,000 a month, then 0.5% of revenue above that, capped at $999. Qonversion charges 0.8% of all revenue past $7,000 with every feature in one plan." },
    { q: "How much does Apphud cost?", a: "Apphud costs $0 up to $10,000 of monthly tracked revenue. Pro costs 0.99% of all tracked revenue, at least $49 a month. Expert costs 1.19%, at least $59. Enterprise is for apps over $100,000 a month and is quoted." },
    { q: "Is RevenueDot cheaper than Apphud?", a: "Above $10,000 a month, yes. At $50,000 Apphud Pro costs $495 and RevenueDot $200. At $100,000 Apphud Pro costs $990 and RevenueDot $450. Up to $10,000 both cost $0." },
    { q: "What happens if I go over Apphud's free limit?", a: "Apphud gives a 14-day grace period with full dashboard access. After that, receipt validation and purchase processing keep working, but dashboard access ends until you upgrade." },
  ],
  related: ["/compare/revenuedot-vs-apphud", "/open-source-revenuecat", "/cheaper-revenuecat-alternatives", "/revenuecat-alternatives", "/features/webhooks", "/pricing"],
  og: { cap: "Monthly bill at $100,000", rows: [["Apphud Pro", "$990"], ["RevenueDot Pro", "$450"]] },
};

// ---- /pricing/adapty -----------------------------------------------------------------------------------------------
const ADAPTY_PRICING: VendorPage = {
  path: "/pricing/adapty",
  name: "Adapty pricing",
  parents: [{ name: "Pricing", path: "/pricing" }],
  label: `Adapty pricing · checked ${CHECKED}`,
  title: "Adapty pricing in 2026, explained",
  metaTitle: "Adapty Pricing 2026: Plans, Add-ons, Calculator",
  metaDescription: "Adapty pricing in 2026: free under $5K a month, then 1% of all revenue, plus add-ons. Bills at $10K, $100K and $1M, and a calculator. Checked November 2026.",
  card: "Free under $5K a month, then 1% of all revenue, plus add-ons. Worked bills and a calculator.",
  answer:
    "Adapty is free while you earn under $5,000 a month. After that it charges **1% of each month's full tracked revenue**, counted before store fees: $100 at $10,000, $1,000 at $100,000 and $10,000 at $1,000,000. Add-ons such as Refund Saver (0.2%) cost extra, and Enterprise is custom. RevenueDot Pro costs $0, $450 and $999 at the same levels.",
  secondary: { href: "/adapty-alternative", label: "See the Adapty alternative" },
  blocks: [
    {
      h2: "What are Adapty's plans in 2026?",
      label: "Plans",
      table: {
        head: ["Plan", "Price", "What it includes"],
        rows: [
          ["Pro", "$0 under $5K a month; then 1% of monthly tracked revenue", "Purchase infrastructure, flow and paywall builder, A/B tests, revenue analytics; email support, live chat once paying"],
          ["Enterprise", "Custom, after a call with sales", "Everything in Pro, plus white-glove migration, a dedicated Slack channel and success manager, custom exports, custom contract and SLAs, US or EU data residency"],
          ["Every plan", "", "SOC 2 Type II, GDPR and a 99.99% uptime SLA"],
        ],
        caption: sourcesLine([AD_PRICING]),
      },
    },
    {
      h2: "What do Adapty's add-ons cost?",
      label: "Add-ons",
      table: {
        head: ["Add-on", "Price", "Free up to"],
        rows: [
          ["Refund Saver", "0.2% of monthly revenue", "$5K a month"],
          ["Ads Manager", "3.5% of monthly ad spend", "$5K a month"],
          ["Attribution", "Custom", "$5K a month"],
          ["Adapty Finance", "From 2.5% per advance", "Not listed"],
          ["Adapty Mail", "20% of extra revenue", "Not listed"],
        ],
        caption: sourcesLine([AD_PRICING]),
      },
    },
    {
      h2: "How much will Adapty cost at $10K, $100K and $1M a month?",
      label: "Worked bills",
      paras: ["The table uses Adapty's rule as written: 1% of the month's full tracked revenue once you have crossed $5,000. It leaves out add-ons."],
      table: {
        head: ["Monthly tracked revenue", "Adapty Pro", "RevenueCat", "RevenueDot Pro"],
        rows: LEVELS.map((m) => [usd(m), usd(m * 0.01), usd(m * 0.01), rd(m)]),
        caption: sourcesLine([AD_PRICING, RC_PRICING, RD_PRICING]),
      },
    },
    {
      h2: "What counts toward Adapty's bill?",
      label: "The rules",
      bullets: [
        "**Revenue counted:** subscriptions, renewals and one-time purchases, in USD, before Apple, Google or Stripe take their cut.",
        "**When billing starts:** once you cross $5,000 of revenue in the last 30 days, you pay 1% of that amount.",
        "**After that:** Adapty bills 1% of each month's full tracked revenue, even if it later falls below $5,000.",
        "**If a payment fails:** the SDK and purchases keep working, but dashboard access is restricted until billing is fixed.",
      ],
      paras: [sourcesLine([AD_PRICING])],
    },
  ],
  calc: {
    after: 3,
    vendor: "Adapty",
    plans: [{ id: "pro", label: "Pro", fee: 0, from: 5_000.01, rate: 0.01 }],
    note: "Adapty Pro: 1% of the month's tracked revenue once you pass $5,000. Add-ons are not included.",
    sources: [AD_PRICING, RD_PRICING],
  },
  faq: [
    { q: "Is Adapty free?", a: "Adapty is free while you earn under $5,000 a month in tracked revenue. Once you cross $5,000 it charges 1% of each month's full revenue, and billing continues even if revenue later falls below $5,000." },
    { q: "Does Adapty charge 1% of all revenue or only above $5,000?", a: "All of it. Adapty's FAQ says that once you cross $5,000 you pay 1% of that amount, and from then on 1% of each month's full tracked revenue. At $10,000 that is $100." },
    { q: "Is Adapty cheaper than RevenueCat?", a: "Only below $5,000 a month. RevenueCat charges 1% of all revenue from $2,500 and Adapty from $5,000, so between $2,500 and $5,000 Adapty is free. Above $5,000 both cost 1%, before Adapty's add-ons." },
    { q: "What is the cheapest alternative to Adapty?", a: "RevenueDot Pro costs $0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month. Qonversion charges 0.8% of all revenue past $7,000." },
  ],
  related: ["/adapty-alternative", "/compare/revenuedot-vs-adapty", "/compare/revenuecat-vs-adapty", "/tools/revenuecat-fee-calculator", "/pricing/superwall", "/pricing"],
  og: { cap: "Adapty at $100,000 a month", rows: [["Adapty Pro", "$1,000"], ["RevenueCat", "$1,000"], ["RevenueDot Pro", "$450"]] },
};

// ---- /pricing/superwall --------------------------------------------------------------------------------------------
const SUPERWALL_PRICING: VendorPage = {
  path: "/pricing/superwall",
  name: "Superwall pricing",
  parents: [{ name: "Pricing", path: "/pricing" }],
  label: `Superwall pricing · checked ${CHECKED}`,
  title: "Superwall pricing in 2026, explained",
  metaTitle: "Superwall Pricing 2026: Indie, Startup, Scale",
  metaDescription: "Superwall pricing in 2026: Indie $0, Startup $49, Scale $199, each plus 1% of paywall revenue. Bills at $10K, $100K and $1M, and a calculator. Checked Nov 2026.",
  card: "Indie $0, Startup $49, Scale $199, each plus 1% of paywall revenue. Worked bills and a calculator.",
  answer:
    "Superwall's subscription infrastructure is free at any scale, and its paywalls are billed **1% of the revenue that converts through a Superwall paywall**. Indie costs $0 up to $10,000 of paywall revenue a month, Startup $49 a month plus 1%, and Scale $199 plus 1%. If all your revenue goes through its paywalls, Indie costs $1,000 at $100,000. RevenueDot Pro costs $450 there.",
  secondary: { href: "/superwall-alternative", label: "See the Superwall alternative" },
  blocks: [
    {
      h2: "What are Superwall's plans in 2026?",
      label: "Plans",
      table: {
        head: ["Plan", "Price", "What it adds"],
        rows: [
          ["Indie", "$0 a month; up to $10K of paywall revenue, then 1%", "Charts, webhooks, integrations, IAP SDK, paywalls, campaigns, audiences, templates"],
          ["Startup", "$49 a month plus 1% of paywall revenue", "Surveys, localization, AI localization, collaborators"],
          ["Scale", "$199 a month plus 1% of paywall revenue", "Account manager, Demand Score, refund protection, transaction abandon, AI audiences, saved snippets"],
          ["Enterprise", "Custom flat-rate pricing", "Implementation support, Slack channel, monthly syncs, SSO, custom SLA, signed contract"],
          ["Every plan", "$0", "Entitlements, purchase APIs, receipt validation, webhooks and SQL access through the Query API"],
        ],
        caption: `The plan cards say "1% of MAR"; the same page says the fee is billed only on paywall-attributed revenue. ${sourcesLine([SW_PRICING, SW_FAQ])}`,
      },
    },
    {
      h2: "How much will Superwall cost at $10K, $100K and $1M a month?",
      label: "Worked bills",
      paras: ["Superwall's bill depends on how much revenue converts through its paywalls. The table shows both ends: none of it, and all of it on the Indie plan. Startup and Scale add $49 and $199 a month."],
      table: {
        head: ["Monthly tracked revenue", "Superwall, none through its paywalls", "Superwall Indie, all through its paywalls", "RevenueDot Pro"],
        rows: LEVELS.map((m) => [usd(m), "$0", usd(m > 10_000 ? m * 0.01 : 0), rd(m)]),
        caption: sourcesLine([SW_PRICING, SW_FAQ, RD_PRICING]),
      },
    },
    {
      h2: "What does Superwall bill, and what is free?",
      label: "The rules",
      bullets: [
        "**One meter:** revenue that converts through a Superwall-rendered paywall. Revenue its paywalls did not earn is not billed.",
        "**Free on every plan:** entitlements, purchase APIs, receipt validation, webhooks, revenue analytics and SQL access, with no per-event fees.",
        "**Imported subscribers** from a previous backend are never billed.",
        "**Superwall's own example:** $50,000 a month with half through its paywalls costs 1% of $25,000, or $250.",
      ],
      paras: [sourcesLine([SW_PRICING, SW_FAQ])],
    },
  ],
  calc: {
    after: 2,
    vendor: "Superwall",
    share: true,
    plans: [
      { id: "indie", label: "Indie ($0)", fee: 0, from: 10_000.01, rate: 0.01 },
      { id: "startup", label: "Startup ($49)", fee: 49, from: 0, rate: 0.01 },
      { id: "scale", label: "Scale ($199)", fee: 199, from: 0, rate: 0.01 },
    ],
    note: "Superwall: the plan fee plus 1% of paywall-attributed revenue; on Indie the 1% starts past $10,000. Its page does not say whether Startup and Scale keep the $10,000 allowance, so the calculator shows their upper bound.",
    sources: [SW_PRICING, SW_FAQ, RD_PRICING],
  },
  faq: [
    { q: "Is Superwall free?", a: "Its infrastructure is: entitlements, purchase APIs, webhooks and SQL access cost nothing on every plan. Paywalls are free on Indie up to $10,000 of paywall-attributed revenue a month, then 1% of that revenue." },
    { q: "How much is Superwall's Startup plan?", a: "$49 a month plus 1% of paywall-attributed revenue. It adds surveys, localization, AI localization and collaborators to Indie. Scale costs $199 a month plus 1%." },
    { q: "Does Superwall charge on all my revenue?", a: "No. Superwall bills only revenue that converts through a Superwall paywall. Its own example: $50,000 a month with half through its paywalls costs $250, and with none through its paywalls costs $0." },
    { q: "Is Superwall cheaper than RevenueDot?", a: "When little revenue goes through its paywalls, yes. When most does, no: with all revenue through its paywalls Superwall Indie costs $1,000 at $100,000 a month and $10,000 at $1,000,000, while RevenueDot Pro costs $450 and $999." },
  ],
  related: ["/superwall-alternative", "/compare/revenuedot-vs-superwall", "/compare/revenuecat-vs-superwall", "/tools/revenuecat-fee-calculator", "/pricing/adapty", "/pricing"],
  og: { cap: "Superwall at $100,000 a month", rows: [["None through its paywalls", "$0"], ["All through Indie", "$1,000"], ["RevenueDot Pro", "$450"]] },
};

// ---- /open-source-revenuecat ---------------------------------------------------------------------------------------
/** GitHub numbers from `gh api repos/<owner>/<repo>` on CHECKED_DAY. */
export const OSS_PROJECTS = [
  { name: "RevenueDot", repo: "revenuedot/revenuedot", license: "AGPL-3.0 (server); SDKs MIT", stars: 24, pushed: "2026-11-16", stores: "App Store, Google Play, Amazon, Galaxy Store, Roku, Stripe, Paddle", rcSdk: "Yes, one proxy line", hosted: "Yes, RevenueDot Cloud", what: "A full purchase backend with paywalls, experiments, 43 charts, 36 integrations, web checkout and a RevenueCat importer." },
  { name: "Wildberry", repo: "ProjWildBerry/wildberry", license: "MIT", stars: 212, pushed: "2025-03-18", stores: "App Store (Apple notifications in the code)", rcSdk: "No; RevenueCat API support is a TODO in its routes", hosted: "No", what: "A React dashboard and TypeScript backend for products, entitlements and offerings, set up with Docker." },
  { name: "OpenIAP and IAPKit", repo: "hyodotdev/openiap", license: "MIT", stars: 171, pushed: "2026-11-21", stores: "App Store and Google Play", rcSdk: "No; its own client libraries", hosted: "Yes, IAPKit at kit.openiap.dev", what: "A standard purchase API with libraries for Expo, React Native, Flutter, KMP, .NET MAUI and Godot, plus IAPKit for validation and entitlements." },
  { name: "Socketkit", repo: "anonrig/socketkit", license: "MPL-2.0", stars: 253, pushed: "2023-10-24", stores: "App Store (reads App Store Connect)", rcSdk: "No", hosted: "No", what: "Subscription analytics and competitor tracking for iOS apps; it reports revenue rather than granting access." },
  { name: "onesub", repo: "jeonghwanko/onesub", license: "MIT", stars: 17, pushed: "2026-11-09", stores: "App Store and Google Play", rcSdk: "No; built for react-native-iap", hosted: "No; you run it", what: "Node middleware that validates receipts, handles store webhooks and tracks subscription state for react-native-iap apps." },
  { name: "OpenRevenue", repo: "pepicrft/openrevenue", license: "MIT", stars: 5, pushed: "2026-03-01", stores: "App Store and Google Play", rcSdk: "Yes, per its README (work in progress)", hosted: "No; deploy to Cloudflare Workers", what: "A Cloudflare Workers backend that answers the core RevenueCat SDK endpoints; its README marks it work in progress." },
  { name: "Rovenue", repo: "hshalab/rovenue", license: "AGPL-3.0", stars: 0, pushed: "2026-08-04", stores: "App Store, Google Play and Stripe", rcSdk: "No; its own SDKs", hosted: "No; you run it", what: "Self-hosted subscriptions and credits with funnels, experiments and feature flags." },
  { name: "FreemiumKit", repo: "FlineDev/FreemiumKit", license: "Custom license; binary SDK, not open source", stars: 130, pushed: "2026-02-11", stores: "Apple platforms only", rcSdk: "No", hosted: "Yes, freemiumkit.app", what: "A closed StoreKit SDK with paywall screens for Apple platforms; the GitHub repo ships a binary under its own license." },
];
const gh = (repo: string) => `https://github.com/${repo}`;

const OPEN_SOURCE: VendorPage = {
  path: "/open-source-revenuecat",
  name: "Open-source RevenueCat alternatives",
  label: `Open source · checked ${CHECKED_DAY}`,
  title: "Open-source RevenueCat alternatives, compared",
  metaTitle: "Open-Source RevenueCat Alternatives, Compared",
  metaDescription: "Every open-source RevenueCat alternative on GitHub: license, stars, last commit, stores and whether the RevenueCat SDK works unchanged. Checked 2026-11-22.",
  card: "Eight projects with license, stars, last commit, stores and RevenueCat SDK support, checked on GitHub.",
  answer:
    "RevenueCat's SDKs are open source under MIT, but its backend is not. We found **7 open-source projects on GitHub** that cover part of RevenueCat's job, plus one closed SDK people often list. Two of them answer the RevenueCat SDK unchanged: RevenueDot, with a hosted Cloud, and OpenRevenue, a work-in-progress Cloudflare Worker. RevenueDot is the only one that also imports a RevenueCat project and ships paywalls, charts and a hosted Cloud.",
  secondary: { href: "https://github.com/revenuedot/revenuedot", label: "RevenueDot on GitHub" },
  blocks: [
    {
      h2: "Which open-source RevenueCat alternatives exist?",
      label: "The table",
      paras: [`Stars and last commit dates come from the GitHub API on ${CHECKED_DAY}. "RevenueCat SDK unchanged" means an app keeps RevenueCat's SDK and points it at the project's server.`],
      table: {
        head: ["Project", "License", "Stars", "Last commit", "Stores", "RevenueCat SDK unchanged", "Hosted option"],
        rows: OSS_PROJECTS.map((p) => [`[${p.name}](${gh(p.repo)})`, p.license, String(p.stars), p.pushed, p.stores, p.rcSdk, p.hosted]),
        caption: `Sources: each project's GitHub repository, linked in the first column. Checked ${CHECKED_DAY}.`,
      },
    },
    {
      h2: "What does each project actually do?",
      label: "One line each",
      bullets: OSS_PROJECTS.map((p) => `**[${p.name}](${gh(p.repo)}).** ${p.what}`),
    },
    {
      h2: "Which ones work with the RevenueCat SDK unchanged?",
      label: "Drop-in",
      paras: [
        "Two. RevenueDot answers the same API the RevenueCat SDKs call, so an app on RevenueCat sets the SDK's proxy URL to `https://api.revenuedot.app` and changes nothing else. It also imports a RevenueCat project, runs beside RevenueCat while you compare, and has been in production next to RevenueCat since October 2, 2026.",
        "OpenRevenue answers the core RevenueCat SDK endpoints on Cloudflare Workers, and its README marks it work in progress. Every other project needs its own SDK or a library such as react-native-iap, so moving to it means rewriting purchase code.",
      ],
    },
    {
      h2: "Is RevenueDot open source, and can I run it myself?",
      label: "License",
      paras: [
        "Yes. The server and dashboard are AGPL-3.0, and the SDK forks, CLI and MCP server are MIT, all on [GitHub](https://github.com/revenuedot/revenuedot). You can run the server on your own servers; enterprise features there need an Enterprise license. See [running it yourself](/self-host).",
        "Most teams start on RevenueDot Cloud instead. Pro costs $0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month.",
      ],
    },
    {
      h2: "Where is RevenueCat still stronger?",
      label: "Honest view",
      bullets: [
        "**Years of production traffic** across the apps on its [homepage](https://www.revenuecat.com/). RevenueDot launched in 2026, and the other projects here are smaller still.",
        "**SOC 2 Type II**, per its [security page](https://www.revenuecat.com/security-and-compliance/). None of the open-source projects here list one.",
        "**Stars.** Socketkit and Wildberry have more GitHub stars than RevenueDot today, though neither has had a push in 2026.",
      ],
    },
  ],
  faq: [
    { q: "Is RevenueCat open source?", a: "Its SDKs are, under the MIT license, but the backend that validates purchases and runs the dashboard is RevenueCat's closed hosted service." },
    { q: "What is the best open-source RevenueCat alternative?", a: "RevenueDot is the only open-source project that works with the RevenueCat SDK unchanged and also ships paywalls, experiments, charts, integrations and a hosted Cloud. Its server is AGPL-3.0." },
    { q: "Can I self-host a RevenueCat alternative?", a: "Yes. RevenueDot, Wildberry, onesub, OpenRevenue and Rovenue all run on your own servers. RevenueDot's enterprise features on your own servers need an Enterprise license." },
    { q: "Is Wildberry still maintained?", a: "Its GitHub repository had its last push on March 18, 2025, as of November 22, 2026, and its RevenueCat API support is marked TODO in the code." },
    { q: "Is FreemiumKit open source?", a: "No. Its GitHub repository ships a binary SDK under FreemiumKit's own license, and the service runs at freemiumkit.app." },
  ],
  related: ["/revenuecat-alternative", "/self-host", "/revenuecat-alternatives", "/migrate-from-revenuecat", "/compare/revenuedot-vs-revenuecat", "/pricing"],
  og: { cap: "RevenueCat SDK works unchanged", rows: [["RevenueDot", "Yes"], ["OpenRevenue", "Yes (WIP)"], ["Wildberry", "No"], ["OpenIAP", "No"]] },
};

export const VENDOR_PAGES: VendorPage[] = [OPEN_SOURCE, ADAPTY_ALT, SUPERWALL_ALT, QONVERSION_ALT, APPHUD_ALT, ADAPTY_PRICING, SUPERWALL_PRICING];
export const vendorPage = (path: string) => {
  const p = VENDOR_PAGES.find((x) => x.path === path);
  if (!p) throw new Error(`No vendor page ${path}`);
  return p;
};
