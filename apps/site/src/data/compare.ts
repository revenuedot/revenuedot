// Comparison pages: RevenueDot vs RevenueCat, Adapty, Qonversion, Superwall and Apphud, plus three vendor-vs-vendor pages
// with RevenueDot as the third column, and the singular /revenuecat-alternative page. Rules: apps/site/CONTENT.md.
// Every cell about another vendor is backed by a source in its row. Vendor facts checked October 2026.
import type { Block, ComparePage, Source } from "./types";
import type { Faq } from "../site";

const CHECKED = "October 2026";
const SIGNUP = "https://app.revenuedot.app/signup";

const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

// ---- Sources -------------------------------------------------------------------------------------------------------
const src = (label: string, url: string): Source => ({ label, url });

const RC_PRICING = src("RevenueCat pricing page", "https://www.revenuecat.com/pricing/");
const RC_STAFF = src("RevenueCat staff on how the 1% is charged (Nov 2023)", "https://community.revenuecat.com/general-questions-7/questions-about-pro-plan-payments-3618");
const RC_HOME = src("RevenueCat homepage", "https://www.revenuecat.com/");
const RC_SEC = src("RevenueCat security and compliance", "https://www.revenuecat.com/security-and-compliance/");
const RC_GDPR = src("RevenueCat GDPR page", "https://www.revenuecat.com/gdpr/");
const RC_LICENSE = src("RevenueCat iOS SDK license (MIT)", "https://github.com/RevenueCat/purchases-ios/blob/main/LICENSE");
const RC_QUICKSTART = src("RevenueCat SDK quickstart (platforms)", "https://www.revenuecat.com/docs/getting-started/quickstart");
const RC_WEB = src("RevenueCat web docs (Stripe, Paddle)", "https://www.revenuecat.com/docs/web/overview");
const RC_STRIPE = src("RevenueCat Stripe Billing docs", "https://www.revenuecat.com/docs/web/integrations/stripe");
const RC_INTEGRATIONS = src("RevenueCat integrations docs", "https://www.revenuecat.com/docs/integrations/third-party-integrations");
const RC_EXPORTS = src("RevenueCat scheduled data exports", "https://www.revenuecat.com/docs/integrations/scheduled-data-exports");
const RC_CC = src("RevenueCat Customer Center docs", "https://www.revenuecat.com/docs/tools/customer-center");
const RC_DOCS_INDEX = src("RevenueCat docs index (virtual currency, offerings)", "https://www.revenuecat.com/docs/llms.txt");
const RC_PLATFORMS = src("RevenueCat platform resources (Amazon, Galaxy Store, Paddle, Stripe)", "https://www.revenuecat.com/docs/platform-resources/llms.txt");
const RC_AI = src("RevenueCat AI toolkit docs", "https://www.revenuecat.com/docs/tools/ai-toolkit");

const AD_PRICING = src("Adapty pricing page", "https://adapty.io/pricing/");
const AD_SEC = src("Adapty security and compliance", "https://adapty.io/security-and-compliance/");
const AD_MIGRATE = src("Adapty migration guide from RevenueCat", "https://adapty.io/docs/migration-from-revenuecat");
const AD_DOCS = src("Adapty docs index", "https://adapty.io/docs/llms.txt");
const AD_GH = src("Adapty iOS SDK on GitHub (MIT)", "https://github.com/adaptyteam/AdaptySDK-iOS");
const AD_BLOG = src("Adapty on its 2026 pricing change", "https://adapty.io/blog/adapty-new-pricing-2026/");

const QO_PRICING = src("Qonversion pricing page", "https://qonversion.io/pricing");
const QO_DOCS = src("Qonversion docs index", "https://documentation.qonversion.io/llms.txt");
const QO_STRIPE = src("Qonversion Stripe integration docs", "https://documentation.qonversion.io/docs/stripe-integration");
const QO_MCP = src("Qonversion MCP server docs", "https://documentation.qonversion.io/docs/mcp-server");
const QO_MIGRATE = src("Qonversion guide to migrating from RevenueCat", "https://documentation.qonversion.io/docs/migrating-from-revenuecat-to-qonversion");
const QO_GH = src("Qonversion iOS SDK on GitHub (MIT)", "https://github.com/qonversion/qonversion-ios-sdk");
const QO_VS_RC = src("Qonversion's RevenueCat comparison", "https://qonversion.io/revenuecat-alternative");

const SW_PRICING = src("Superwall pricing page", "https://superwall.com/pricing");
const SW_FAQ = src("Superwall pricing FAQ", "https://superwall.com/docs/support/faq/2801653905-how-does-superwalls-pricing-work");
const SW_BLOG = src("Superwall on its October 2025 pricing change", "https://superwall.com/blog/superwalls-new-pricing-more-aligned-generous-and-transparent");
const SW_LLMS = src("Superwall llms.txt (coverage and limits)", "https://superwall.com/llms.txt");
const SW_A2W = src("Superwall App-to-Web Checkout", "https://superwall.com/features/app-to-web-checkout");
const SW_GDPR = src("Superwall GDPR page", "https://superwall.com/legal/gdpr");
const SW_GH = src("Superwall iOS SDK on GitHub (MIT)", "https://github.com/superwall/Superwall-iOS");

const AP_PRICING = src("Apphud pricing page", "https://apphud.com/pricing");
const AP_DATA = src("Apphud data protection page", "https://apphud.com/data-protection");
const AP_WEB = src("Apphud web payments docs (Stripe, Paddle)", "https://docs.apphud.com/docs/web-payments");
const AP_DOCS = src("Apphud docs index", "https://docs.apphud.com/llms.txt");
const AP_MCP = src("Apphud public MCP docs", "https://docs.apphud.com/docs/mcp");
const AP_GH = src("Apphud iOS SDK on GitHub (MIT)", "https://github.com/apphud/ApphudSDK");

// ---- Evidence crops ------------------------------------------------------------------------------------------------
// Dated screenshots of the cited pages (src/data/evidence.ts), as "Vendor/page/claim" keys. Each row names the crops that
// show its vendor facts; components/Evidence.astro renders them under the row, and the build fails on an unknown key.
const E = {
  rcHero: "RevenueCat/home/hero",
  rcApps: "RevenueCat/home/apps-and-revenue",
  rcPaywall: "RevenueCat/home/paywall-templates",
  rcRefund: "RevenueCat/home/refund-handling",
  rcPrice: "RevenueCat/pricing/free-to-2500-then-1-percent",
  rcGrowth: "RevenueCat/pricing/growth-tools-1-percent",
  rcFeatures: "RevenueCat/pricing/features",
  rcSupport: "RevenueCat/pricing/support",
  rcEnterprise: "RevenueCat/pricing/enterprise",
  rcSoc2: "RevenueCat/security-and-compliance/soc2",
  rcGdpr: "RevenueCat/gdpr/processor",
  rcStaff: "RevenueCat/community-pro-plan-payments/staff-reply-1-percent-of-whole-mtr",
  rcMit: "RevenueCat/github-purchases-ios-license/mit",
  rcSdks: "RevenueCat/docs-quickstart/platforms",
  rcWeb: "RevenueCat/docs-web-overview/stripe-paddle-billing",
  rcStripe: "RevenueCat/docs-web-stripe/unlock-entitlements",
  rcIntegrations: "RevenueCat/docs-third-party-integrations/categories",
  rcExports: "RevenueCat/docs-scheduled-data-exports/destinations",
  rcCC: "RevenueCat/docs-customer-center/self-service-ui",
  rcVirtual: "RevenueCat/docs-llms-txt/virtual-currency",
  rcStores: "RevenueCat/docs-platform-resources-llms-txt/amazon-galaxy",
  rcAi: "RevenueCat/docs-ai-toolkit/toolkit",
  adHero: "Adapty/home/hero",
  adPrice: "Adapty/pricing/free-under-5k-then-1-percent",
  adAddons: "Adapty/pricing/add-ons",
  adTools: "Adapty/pricing/templates-and-ab-tests",
  adResidency: "Adapty/pricing/soc2-and-residency",
  adCounts: "Adapty/pricing/faq-what-counts",
  adWhen: "Adapty/pricing/faq-when-1-percent",
  adMigration: "Adapty/pricing/faq-migration",
  adSoc2: "Adapty/security-and-compliance/soc2-type-ii",
  adLimits: "Adapty/docs-migration-from-revenuecat/limits",
  adWeb: "Adapty/docs-llms-txt/stripe-paddle",
  adMit: "Adapty/github-adaptysdk-ios/mit-license",
  adBlog: "Adapty/blog-new-pricing-2026/free-to-5000",
  qoHero: "Qonversion/home/hero",
  qoPrice: "Qonversion/pricing/free-to-7k-then-0-8-percent",
  qoTotal: "Qonversion/pricing/faq-total-tracked-revenue",
  qoPlan: "Qonversion/pricing/plan-includes",
  qoCompliance: "Qonversion/pricing/compliance-and-support",
  qoSdks: "Qonversion/docs-llms-txt/sdks-and-stores",
  qoStripe: "Qonversion/docs-stripe-integration/stripe",
  qoMcp: "Qonversion/docs-mcp-server/mcp-server",
  qoGuide: "Qonversion/docs-migrating-from-revenuecat/guide",
  qoMit: "Qonversion/github-qonversion-ios-sdk/mit-license",
  qoVsRc: "Qonversion/revenuecat-alternative/free-tier-comparison",
  swHero: "Superwall/home/hero",
  swInfra: "Superwall/pricing/infrastructure-free",
  swIndie: "Superwall/pricing/indie-10k-then-1-percent",
  swAttributed: "Superwall/pricing/attributed-revenue-only",
  swSql: "Superwall/pricing/sql-query-api",
  swAgent: "Superwall/pricing/migration-agent",
  swMar: "Superwall/docs-pricing-faq/mar-definition",
  swBlogDate: "Superwall/blog-new-pricing/date",
  swBlogIndie: "Superwall/blog-new-pricing/indie-free-to-10k",
  swLimits: "Superwall/llms-txt/coverage-and-limits",
  swEditorMcp: "Superwall/llms-txt/editor-mcp",
  swA2W: "Superwall/features-app-to-web-checkout/stripe-checkout",
  swGdpr: "Superwall/legal-gdpr/processor",
  swMit: "Superwall/github-superwall-ios/mit-license",
  apHero: "Apphud/home/hero",
  apPlans: "Apphud/pricing/free-10k-pro-expert",
  apOverage: "Apphud/pricing/overage-rates",
  apGrace: "Apphud/pricing/grace-period",
  apSeats: "Apphud/pricing/seats-and-webhooks",
  apData: "Apphud/data-protection/eu-and-us",
  apWeb: "Apphud/docs-web-payments/stripe-paddle",
  apS3: "Apphud/docs-llms-txt/web-payments-and-s3",
  apMcp: "Apphud/docs-mcp/public-mcp",
  apMit: "Apphud/github-apphudsdk/mit-license",
  stCard: "Stripe/pricing/card-fee",
  stIntl: "Stripe/pricing/international-cards",
  stBilling: "Stripe/billing-pricing/0-7-percent",
  stCheckout: "Stripe/docs-checkout-quickstart/hosted-page",
  stAnalytics: "Stripe/docs-billing-analytics/mrr-churn",
  appleGuideline: "Apple/app-review-guidelines/3-1-1-in-app-purchase",
  appleSbp: "Apple/subscriptions/small-business-program",
  gFees: "Google/play-service-fees/service-fees",
  gPolicy: "Google/play-payments-policy/billing-system",
  rdPlans: "RevenueDot/pricing/plans",
  rdLicense: "RevenueDot/github-revenuedot/license",
};

// ---- Price maths ---------------------------------------------------------------------------------------------------
// Monthly tracked revenue (MTR) levels shown on every price table.
const LEVELS = [5_000, 10_000, 50_000, 250_000, 1_000_000];
const rcBill = (m: number) => (m >= 2_500 ? m * 0.01 : 0); // 1% of ALL tracked revenue once at $2,500 (pricing FAQ, staff reply)
const adaptyBill = (m: number) => (m > 5_000 ? m * 0.01 : 0); // 1% of all revenue once past $5K (pricing FAQ)
const qonversionBill = (m: number) => (m > 7_000 ? m * 0.008 : 0); // 0.8% of ALL tracked revenue once past $7K (pricing FAQ)
const cloudBill = (m: number) => Math.min(999, Math.max(0, m - 10_000) * 0.005); // Cloud Standard: 0.5% above $10K, capped at $999
const apphudPro = (m: number) => 49 + (Math.max(0, m - 5_000) / 1_000) * 9.99; // Pro: $49 incl. $5K, then $9.99 per extra $1,000

type Col = { head: string; cell: (m: number) => string };
const COL_RC: Col = { head: "RevenueCat", cell: (m) => usd(rcBill(m)) };
const COL_ADAPTY: Col = { head: "Adapty", cell: (m) => usd(adaptyBill(m)) };
const COL_QONVERSION: Col = { head: "Qonversion", cell: (m) => usd(qonversionBill(m)) };
const COL_SUPERWALL: Col = { head: "Superwall (upper bound)", cell: (m) => (m > 10_000 ? "$0 to " + usd(m * 0.01) : "$0") };
const COL_APPHUD: Col = {
  head: "Apphud",
  cell: (m) => (m <= 10_000 ? "$0 (Free plan)" : m >= 100_000 ? usd(apphudPro(m)) + " at the Pro list rate" : usd(apphudPro(m)) + " (Pro)"),
};
const COL_CLOUD: Col = { head: "RevenueDot Cloud", cell: (m) => usd(cloudBill(m)) };
const COL_SELF: Col = { head: "RevenueDot self-host", cell: () => "$0 + servers" };

const priceTable = (intro: string, cols: Col[], sources: Source[], evidence: string[], levels = LEVELS): NonNullable<ComparePage["price"]> => ({
  intro,
  head: ["Monthly tracked revenue", ...cols.map((c) => c.head)],
  rows: levels.map((m) => [usd(m), ...cols.map((c) => c.cell(m))]),
  sources,
  evidence,
});

const RD_RATE =
  "RevenueDot Cloud is free up to $10,000 a month. Above that, Cloud Standard charges 0.5% of the revenue above $10,000, capped at $999 a month. Self-hosting has no revenue share, only your own server costs.";

// ---- RevenueDot cells reused across pages ----------------------------------------------------------------------------
const RD = {
  license: "Open source. The server and dashboard are AGPL-3.0; the SDK forks, CLI and MCP server are MIT",
  where: "RevenueDot Cloud (free up to $10K a month), or your own servers with Docker and Postgres",
  sdk: "Works with the stock RevenueCat SDKs (set the proxy URL), plus hard forks of all ten SDKs on GitHub",
  stores: "App Store, Google Play, Amazon Appstore, Samsung Galaxy Store, Roku, Stripe and Paddle",
  web: "Hosted Stripe checkout, purchase links, funnels, web discounts and custom pay domains",
  paywalls: "Template gallery (10 templates), visual editor, AI generator, localization, no app release needed",
  experiments: "Audiences, targeting rules with placements and schedules, and offering A/B experiments with chance to win",
  charts: "43 charts with filters, segments, 14 display currencies and CSV export",
  integrations: "36 integrations, plus webhooks and scheduled data exports (CSV or Parquet to S3, R2, GCS, Azure or email)",
  api: "REST API v1, and all 128 operations of RevenueCat's v2 API are routed",
  lifecycle: "Refund Control, win-back campaigns and a Customer Center, all included",
  mcp: "Hosted MCP server at mcp.revenuedot.app, for ChatGPT, Claude and other assistants",
  compliance: "No certification yet. Self-hosting inherits your own controls",
  maturity: "New: launched in 2026, with far less production history",
  support: "GitHub and email on every plan; Enterprise adds help within 1 hour when purchases fail and a named engineer",
};

export const RD_MIGRATION_RC: Block = {
  h2: "How migration from RevenueCat works",
  label: "Migration",
  paras: ["RevenueDot answers the same API the RevenueCat SDKs call, so the move is an import, a side-by-side run and a one-line release. Nothing in your purchase code changes."],
  steps: [
    { name: "Import", text: "Create a free Cloud account, then run `npx revenuedot import --from-revenuecat` with a read-only RevenueCat secret key. It copies apps, SDK keys, products, offerings, customers and purchase history, and it is safe to re-run." },
    { name: "Run side by side", text: "Point App Store and Google Play server notifications at RevenueDot. RevenueDot forwards each one to RevenueCat, so both systems stay current while you compare them." },
    { name: "Switch", text: "Ship a release that sets the SDK's proxy URL to `https://api.revenuedot.app`, then turn RevenueCat off once most active users have updated." },
  ],
};


// ---- 1. RevenueDot vs RevenueCat ------------------------------------------------------------------------------------
const VS_REVENUECAT: ComparePage = {
  slug: "revenuedot-vs-revenuecat",
  kind: "vs",
  columns: ["RevenueDot", "RevenueCat"],
  title: "RevenueDot vs RevenueCat: open source, same SDK, free on Cloud to $10K",
  metaTitle: "RevenueDot vs RevenueCat: Open Source Alternative",
  metaDescription: "RevenueDot vs RevenueCat compared: price, stores, paywalls, charts, web billing and data ownership. Same SDK, open source, free on Cloud to $10K a month.",
  card: "Same SDK, open source, free to $10K a month. Where RevenueCat is still ahead.",
  answer:
    "RevenueDot is an open-source backend that the stock RevenueCat SDKs already talk to, so you keep your app code and change one URL. It covers App Store, Google Play, Amazon and Stripe, 43 charts, paywalls, experiments and 36 integrations. RevenueCat is the mature choice, with SOC 2 and years of production traffic. RevenueDot costs less: free to $10K a month, against RevenueCat's 1% of all revenue from $2,500.",
  choose: [
    {
      name: "RevenueDot",
      reasons: [
        "You want to keep the RevenueCat SDK in your app and stop paying 1% of every tracked dollar once you pass $2,500 a month.",
        "You want the option to self-host, so receipts, customers and purchase history sit in your own Postgres, in your own region.",
        "You want to read and change the code that grants access, and export everything with plain SQL.",
        "You want paywalls, experiments, charts, web checkout and win-back without a second vendor or a revenue share on top.",
        "You are comfortable adopting a young open-source project and reporting what you find.",
      ],
    },
    {
      name: "RevenueCat",
      reasons: [
        "You need a service with years of live purchase traffic behind it today. RevenueCat says it supports 149K+ apps.",
        "You need a vendor with a SOC 2 Type II report now.",
        "You sell through Paddle, Roku or the Samsung Galaxy Store and need a backend proven on live purchases there: RevenueDot supports them but has tested them only against copies of those stores' APIs.",
        "You depend on paywall depth beyond single-screen paywalls, such as multi-step flows, which RevenueDot has not built.",
        "You would rather pay a vendor than run or watch anything yourself.",
      ],
    },
  ],
  rows: [
    {
      topic: "Server license",
      cells: [RD.license, "The hosted service is closed source; its SDKs are open source (MIT)"],
      sources: [RC_LICENSE, RC_PRICING],
      evidence: [E.rcMit, E.rdLicense],
    },
    {
      topic: "Where it runs",
      cells: [RD.where, "RevenueCat's cloud; no self-host option is listed"],
      sources: [RC_PRICING, RC_HOME],
      evidence: [E.rcHero],
      visual: "self-host",
    },
    {
      topic: "Client SDKs",
      cells: [RD.sdk, "Its own open-source SDKs for all platforms"],
      sources: [RC_QUICKSTART, RC_LICENSE],
      evidence: [E.rcSdks, E.rcMit],
    },
    {
      topic: "Price",
      cells: [
        "Cloud free to $10K a month; Standard 0.5% above that, capped at $999. Self-host $0",
        "Free to $2,500 monthly tracked revenue, then 1% of all tracked revenue, not only the part above $2,500",
      ],
      sources: [RC_PRICING, RC_STAFF],
      evidence: [E.rcPrice, E.rcStaff, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "Stores",
      cells: [RD.stores, "App Store, Google Play, Amazon, Samsung Galaxy Store, Stripe and Paddle"],
      sources: [RC_PLATFORMS, RC_WEB],
      evidence: [E.rcStores, E.rcWeb],
    },
    {
      topic: "Web billing and funnels",
      cells: [RD.web, "Web Billing with Stripe and Paddle, web purchase links and no-code web-to-app funnels"],
      sources: [RC_WEB, RC_STRIPE, RC_PRICING],
      evidence: [E.rcWeb, E.rcStripe],
      visual: "web-checkout",
    },
    {
      topic: "Paywalls",
      cells: [RD.paywalls, "Remotely configurable paywall editor with pre-built templates"],
      sources: [RC_PRICING, RC_HOME],
      evidence: [E.rcPaywall, E.rcFeatures],
      visual: "paywalls",
    },
    {
      topic: "Targeting and experiments",
      cells: [RD.experiments, "Targeting by audience and placement, and A/B testing with remote configuration"],
      sources: [RC_PRICING],
      evidence: [E.rcFeatures],
      visual: "experiments",
    },
    {
      topic: "Charts and analytics",
      cells: [RD.charts, "Dashboard and reporting for 40+ metrics"],
      sources: [RC_PRICING],
      evidence: [E.rcFeatures],
      visual: "charts",
    },
    {
      topic: "Integrations, webhooks and exports",
      cells: [
        RD.integrations,
        "Integrations for engagement, analytics and app tools, MMP and ad-network integrations, webhooks, and scheduled exports (CSV or Parquet to S3, GCS, Azure or email)",
      ],
      sources: [RC_INTEGRATIONS, RC_EXPORTS],
      evidence: [E.rcIntegrations, E.rcExports],
      visual: "integrations",
    },
    {
      topic: "Refunds, win-back and support UI",
      cells: [RD.lifecycle, "Automated Apple refund handling, win-back tools and a no-code Customer Center"],
      sources: [RC_HOME, RC_CC],
      evidence: [E.rcRefund, E.rcCC],
      visual: "customer-center",
    },
    {
      topic: "REST API",
      cells: [RD.api, "REST API v1 and v2"],
      sources: [RC_PRICING],
      evidence: [E.rcFeatures],
    },
    {
      topic: "AI assistants",
      cells: [RD.mcp, "An AI toolkit with plugins, skills, an MCP server and a CLI"],
      sources: [RC_AI],
      evidence: [E.rcAi],
      visual: "ai",
    },
    {
      topic: "Compliance and data location",
      cells: [RD.compliance, "SOC 2 Type II (report under NDA) and GDPR; its security and GDPR pages name no hosting region"],
      sources: [RC_SEC, RC_GDPR],
      evidence: [E.rcSoc2, E.rcGdpr],
    },
    {
      topic: "Maturity",
      cells: [RD.maturity, "Mature: its homepage cites 149K+ apps and $17B+ revenue processed"],
      sources: [RC_HOME],
      evidence: [E.rcApps],
    },
    {
      topic: "Support",
      cells: [RD.support, "Email and technical support forums; dedicated support and custom SLAs on Enterprise"],
      sources: [RC_PRICING],
      evidence: [E.rcSupport, E.rcEnterprise],
    },
  ],
  price: priceTable(
    "Formulas: RevenueCat charges 1% of all monthly tracked revenue once you reach $2,500, so $10,000 costs $100, not $75. " +
      RD_RATE +
      " Enterprise plans on either side are custom and not shown.",
    [COL_RC, COL_CLOUD, COL_SELF],
    [RC_PRICING, RC_STAFF],
    [E.rcPrice, E.rcStaff, E.rdPlans],
  ),
  blocks: [
    RD_MIGRATION_RC,
    {
      h2: "What stays the same when you switch",
      paras: ["The point of RevenueDot is that the part of your app that touches purchases does not move."],
      bullets: [
        "**Your app code.** `Purchases.configure`, offerings, purchases, restores and `CustomerInfo` stay as they are. Only the proxy URL changes.",
        "**Your backend.** Webhook event names and payloads, the Authorization header and REST API v1 and v2 responses match RevenueCat's published formats.",
        "**Your customers.** App user IDs, aliases, attributes, active entitlements and purchase history come across with the importer, so nobody loses access on switch day.",
        "**Your SDK keys.** The importer copies the public SDK key strings, so builds already in the stores keep working.",
      ],
    },
    {
      h2: "Where RevenueCat is still ahead",
      paras: ["A fair comparison names the gaps. These are the ones that decide the choice for some teams."],
      bullets: [
        "**Track record.** RevenueCat has run live store traffic for years. RevenueDot launched in 2026. Running both side by side during a migration lets you compare them before you switch.",
        "**Compliance.** RevenueCat publishes SOC 2 Type II. RevenueDot has no certification; if you self-host, your own controls apply.",
        "**Store coverage.** Both cover the App Store, Google Play, Amazon, Stripe, Paddle, Roku and the Samsung Galaxy Store. RevenueDot's Paddle, Roku and Galaxy Store support has not run a real store purchase yet.",
        "**Importer maturity.** The importer is tested against fixtures checked against RevenueCat's OpenAPI files, not yet against a real RevenueCat project. Run it with `--dry-run` first.",
      ],
    },
  ],
  faq: [
    {
      q: "Is RevenueDot a RevenueCat alternative?",
      a: "Yes. RevenueDot is an open-source backend for in-app purchases that implements the API the RevenueCat SDKs call. You keep the RevenueCat SDK, set its proxy URL to RevenueDot, and keep your offerings, entitlements and customers. It runs on RevenueDot Cloud, free up to $10,000 a month, or on your own servers.",
    },
    {
      q: "Is RevenueDot cheaper than RevenueCat?",
      a: "Yes at every size above $2,500 a month. RevenueCat charges 1% of all tracked revenue once you reach $2,500: $500 a month at $50,000. RevenueDot Cloud is free to $10,000, and Cloud Standard is 0.5% of revenue above that, capped at $999: about $200 at $50,000. Self-hosting has no revenue share.",
    },
    {
      q: "Does RevenueCat charge 1% on all revenue or only above $2,500?",
      a: "On all of it. RevenueCat's pricing page says you pay nothing up to $2,500 in monthly tracked revenue, then 1% of what you track, and its FAQ gives $25 for $2,500. A RevenueCat staff reply says the charge is 1% of your whole MTR, so $3,000 costs $30, not $5.",
    },
    {
      q: "Can I switch from RevenueCat without changing my app code?",
      a: "Almost. You change one line, the SDK's proxy URL, before `configure`. With the stock SDK you also turn off its response-signature check, or you use a RevenueDot SDK fork, which verifies RevenueDot's signatures. Purchases, restores, offerings and CustomerInfo code stay as they are.",
    },
    {
      q: "Does RevenueDot have paywalls, experiments and charts like RevenueCat?",
      a: "Yes. RevenueDot has a paywall template gallery, a visual editor and an AI generator, audience targeting with A/B experiments, 43 charts, 36 integrations, web checkout and funnels, Refund Control and win-back. Its paywalls are single-screen today, and multi-step paywall flows are not built.",
    },
    {
      q: "Does RevenueDot have SOC 2 like RevenueCat?",
      a: "No. RevenueCat publishes a SOC 2 Type II report under NDA. RevenueDot has no certification yet. If you self-host, your purchase data stays in your own Postgres and your own controls apply, which some compliance teams prefer.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "customer-center"],
  video: "https://www.youtube.com/watch?v=zbXBbXJ-Ltw",
  related: ["/compare/revenuecat-vs-superwall-vs-revenuedot", "/compare/revenuedot-vs-adapty", "/compare/revenuedot-vs-superwall", "/revenuecat-alternatives", "/migrate-from-revenuecat", "/self-host"],
};

// ---- 2. RevenueDot vs Adapty ----------------------------------------------------------------------------------------
const VS_ADAPTY: ComparePage = {
  slug: "revenuedot-vs-adapty",
  kind: "vs",
  columns: ["RevenueDot", "Adapty"],
  title: "RevenueDot vs Adapty: open source and self-hostable vs hosted paywall tooling",
  metaTitle: "RevenueDot vs Adapty: Price, Features, Self-Hosting",
  metaDescription: "RevenueDot vs Adapty compared: price at $5K to $1M a month, paywalls, A/B tests, web payments, SOC 2 and self-hosting. Sourced and checked October 2026.",
  card: "Open source and self-hostable, or a hosted growth suite with SOC 2. The honest split.",
  answer:
    "Choose Adapty if you want a hosted growth suite with SOC 2 Type II, an AI flow and paywall builder, and a $5K free tier. Choose RevenueDot if you want an open-source backend you can self-host, the same RevenueCat SDK you may already use, and a bill that stops at $999 a month. Adapty charges 1% of all revenue once you pass $5K. RevenueDot Cloud is free to $10K.",
  choose: [
    {
      name: "RevenueDot",
      reasons: [
        "You already use, or want, the RevenueCat SDK, and you want to switch backends by changing one URL.",
        "You want to self-host and keep purchase data in your own Postgres. Adapty lists no self-host option.",
        "You want webhooks, exports, charts and refund tools included, with no add-on fees.",
        "You want to read the code that grants access to your subscribers.",
      ],
    },
    {
      name: "Adapty",
      reasons: [
        "You need SOC 2 Type II today, or US or EU data residency, which Adapty offers on its Enterprise plan.",
        "You want a builder for paywalls and onboarding flows, with 50+ templates, an AI generator and unlimited A/B test variants.",
        "You want web payments through Paddle as well as Stripe.",
        "You want hands-on migration help and a dedicated success manager on a paid contract.",
      ],
    },
  ],
  rows: [
    {
      topic: "Source code",
      cells: [RD.license, "Open-source SDKs (MIT); the backend runs as Adapty's hosted service"],
      sources: [AD_PRICING, AD_GH],
      evidence: [E.adMit, E.rdLicense],
    },
    {
      topic: "Where it runs",
      cells: [RD.where, "Adapty's cloud; its pricing and docs list no self-host option"],
      sources: [AD_PRICING, AD_DOCS],
      evidence: [E.adHero],
      visual: "self-host",
    },
    {
      topic: "Client SDK",
      cells: [RD.sdk, "Adapty's own SDKs: iOS, Android, React Native, Flutter, FlutterFlow, Kotlin Multiplatform, Capacitor, Unity"],
      sources: [AD_PRICING, AD_DOCS],
      evidence: [E.adMit],
    },
    {
      topic: "Price",
      cells: [
        "Cloud free to $10K a month; Standard 0.5% above that, capped at $999. Self-host $0",
        "Free under $5K a month, then 1% of that month's revenue, counted before store fees",
      ],
      sources: [AD_PRICING, AD_BLOG],
      evidence: [E.adPrice, E.adWhen, E.adBlog, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "Add-on fees",
      cells: [
        "None. Refund Control, win-back, exports and webhooks are included",
        "Refund Saver 0.2% of revenue after $5K; Ads Manager 3.5% of ad spend; Mail 20% revenue share; payout acceleration 2.5%; attribution $0.03 per attributed install",
      ],
      sources: [AD_PRICING],
      evidence: [E.adAddons],
    },
    {
      topic: "Stores and web",
      cells: [RD.stores + "; web checkout and funnels through Stripe", "App Store and Google Play, plus web payments through Stripe and Paddle; no Amazon Appstore in its docs"],
      sources: [AD_PRICING, AD_DOCS],
      evidence: [E.adWeb],
      visual: "web-checkout",
    },
    {
      topic: "Paywalls and flows",
      cells: [RD.paywalls + ". Paywalls are single-screen", "Drag-and-drop flow and paywall builder, 50+ templates, AI generator, video, timers, quizzes and localization"],
      sources: [AD_PRICING],
      evidence: [E.adTools],
      visual: "paywalls",
    },
    {
      topic: "Targeting and A/B tests",
      cells: [RD.experiments, "A/B tests with custom traffic splits, unlimited variants and early winner predictions; segments by attributes or behavior"],
      sources: [AD_PRICING],
      evidence: [E.adTools],
      visual: "experiments",
    },
    {
      topic: "Analytics",
      cells: [RD.charts, "Revenue, MRR, churn, ARPU, 10+ conversion metrics, cohorts and predicted LTV"],
      sources: [AD_PRICING],
      visual: "charts",
    },
    {
      topic: "Integrations and exports",
      cells: [RD.integrations, "Integrations with attribution, analytics and messaging tools, webhooks, and cloud data export to Amazon S3"],
      sources: [AD_PRICING, AD_DOCS],
      evidence: [E.adTools],
      visual: "integrations",
    },
    {
      topic: "Compliance and data location",
      cells: [RD.compliance, "SOC 2 Type II and GDPR; US or EU data residency on Enterprise only"],
      sources: [AD_SEC, AD_PRICING],
      evidence: [E.adSoc2, E.adResidency],
    },
    {
      topic: "Migration from RevenueCat",
      cells: ["Importer for RevenueCat projects; no Adapty importer yet", "Adapty says a migration typically takes a few days to a week; promotional entitlements and refund history do not come across"],
      sources: [AD_PRICING, AD_MIGRATE],
      evidence: [E.adMigration, E.adLimits],
      visual: "importer",
    },
    {
      topic: "Support",
      cells: [RD.support, "Community and email for Pro, live chat for paid customers, a dedicated Slack channel and success manager on Enterprise"],
      sources: [AD_PRICING],
    },
  ],
  price: priceTable(
    "Formulas: Adapty charges 1% of all monthly revenue once you pass $5K, measured before store fees. " +
      RD_RATE +
      " Adapty add-ons and Enterprise are not included.",
    [COL_ADAPTY, COL_CLOUD, COL_SELF],
    [AD_PRICING],
    [E.adPrice, E.adWhen, E.rdPlans],
  ),
  blocks: [
    {
      h2: "How moving from Adapty to RevenueDot works",
      label: "Migration",
      paras: [
        "RevenueDot's importer reads RevenueCat projects, not Adapty ones, so there is no one-command import from Adapty yet. The move is an SDK swap, and active subscribers reappear as their store receipts reach RevenueDot.",
      ],
      steps: [
        { name: "Set up the project", text: "Create a free Cloud account, add your App Store and Google Play credentials, and rebuild your products, entitlements and offerings. Point store server notifications at RevenueDot." },
        { name: "Swap the SDK", text: "Replace the Adapty SDK with the RevenueCat SDK, or a RevenueDot fork, and set the proxy URL to `https://api.revenuedot.app`." },
        { name: "Let customers re-sync", text: "On first launch, the app posts each customer's store receipt, so active subscribers are recognized. Run both backends in parallel for a billing cycle before you turn Adapty off." },
      ],
    },
    {
      h2: "Where the two products differ most",
      paras: ["Both are priced on tracked revenue, and both run a free tier. The real differences are where your data lives and how the bill behaves."],
      bullets: [
        "**Hosting.** Adapty is a hosted service with optional EU or US residency on Enterprise. RevenueDot runs on Cloud or on your own servers.",
        "**The bill.** Adapty's 1% applies to the whole month once you pass $5K, plus add-ons. RevenueDot Cloud Standard is 0.5% above $10K, capped at $999.",
        "**SDK.** Adapty uses its own SDK, so your purchase code changes. RevenueDot keeps the RevenueCat SDK.",
        "**Compliance.** Adapty holds SOC 2 Type II. RevenueDot does not yet.",
      ],
    },
    {
      h2: "What Adapty does that RevenueDot does not yet",
      bullets: [
        "Multi-step flows that combine onboarding and paywalls. RevenueDot's paywalls are single-screen.",
        "Paddle web payments, and payout acceleration for App Store and Google Play proceeds.",
        "Predicted LTV and AI-suggested pricing experiments, which Adapty sells as part of its platform.",
      ],
    },
  ],
  faq: [
    {
      q: "Is Adapty cheaper than RevenueDot?",
      a: "No, not above $5K a month. Adapty is free under $5K a month, then 1% of all revenue: $500 at $50,000. RevenueDot Cloud is free to $10,000, and Cloud Standard is 0.5% above that, capped at $999: about $200 at $50,000. Adapty also charges extra for add-ons such as Refund Saver and attribution.",
    },
    {
      q: "Can I self-host Adapty?",
      a: "Adapty's pricing page and docs list no self-host option; it runs as a hosted service, with US or EU data residency on its Enterprise plan. RevenueDot can be self-hosted with Docker and Postgres, so purchase data stays in your own database.",
    },
    {
      q: "Does Adapty have SOC 2?",
      a: "Yes. Adapty says an independent CPA firm issues a SOC 2 Type II attestation for its security, availability and confidentiality controls, available under NDA. RevenueDot has no SOC 2 report yet.",
    },
    {
      q: "Is Adapty or RevenueDot better for paywall A/B testing?",
      a: "Adapty is deeper today: custom traffic splits, unlimited variants and early winner predictions. RevenueDot runs offering experiments with deterministic enrollment and reports conversion, revenue and chance to win, and it works with the RevenueCat SDK's offerings.",
    },
    {
      q: "Can I migrate from Adapty to RevenueDot?",
      a: "Yes, but by SDK swap, not by importer. RevenueDot's importer reads RevenueCat projects only. You recreate products and offerings, point store notifications at RevenueDot, change the SDK and let customers re-sync from their store receipts.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "web-checkout"],
  video: "https://www.youtube.com/watch?v=OpVzL6kBMn4",
  related: ["/compare/revenuedot-vs-revenuecat", "/compare/revenuecat-vs-adapty", "/revenuecat-alternatives", "/migrate-from-revenuecat", "/pricing", "/self-host"],
};

// ---- 3. RevenueDot vs Qonversion ------------------------------------------------------------------------------------
const VS_QONVERSION: ComparePage = {
  slug: "revenuedot-vs-qonversion",
  kind: "vs",
  columns: ["RevenueDot", "Qonversion"],
  title: "RevenueDot vs Qonversion: open source and self-hostable vs a hosted 0.8% plan",
  metaTitle: "RevenueDot vs Qonversion: Price, Features, Self-Hosting",
  metaDescription: "RevenueDot vs Qonversion compared: price at $5K to $1M a month, stores, paywall builder, A/B tests, MCP and self-hosting. Sourced, checked October 2026.",
  card: "A hosted 0.8% plan with everything included, or an open-source backend you can self-host.",
  answer:
    "Qonversion is a hosted service with one plan: free to $7K a month, then 0.8% of all tracked revenue, with every feature included. It is cheaper than RevenueCat's 1%, but it is closed and you must change SDKs. RevenueDot is open source, self-hostable and works with the RevenueCat SDK you may already ship. Its Cloud is free to $10K, and Cloud Standard stops at $999 a month.",
  choose: [
    {
      name: "RevenueDot",
      reasons: [
        "You want the RevenueCat SDK to stay in your app, so a switch is one URL and not a rewrite.",
        "You want to self-host and own the database, or read the code that decides who has access.",
        "You sell on Amazon Appstore, which RevenueDot supports and Qonversion's docs do not list.",
        "You want a bill that stops at $999 a month, instead of 0.8% with no ceiling.",
      ],
    },
    {
      name: "Qonversion",
      reasons: [
        "You want one hosted plan with every feature included, unlimited apps and seats, and no tiers.",
        "You want the lowest published percentage among the hosted vendors: 0.8% of tracked revenue.",
        "You sell on the web through Paddle as well as Stripe.",
        "You want 24/7 priority support on the standard plan, not only on an enterprise contract.",
      ],
    },
  ],
  rows: [
    {
      topic: "Source code",
      cells: [RD.license, "Open-source SDKs (MIT); the backend is Qonversion's hosted service"],
      sources: [QO_GH, QO_PRICING],
      evidence: [E.qoMit, E.rdLicense],
    },
    {
      topic: "Where it runs",
      cells: [RD.where, "Qonversion's cloud; no self-host option is listed in its docs"],
      sources: [QO_PRICING, QO_DOCS],
      evidence: [E.qoHero],
      visual: "self-host",
    },
    {
      topic: "Client SDK",
      cells: [RD.sdk, "Qonversion's own SDKs: iOS, Android, Flutter, React Native, Unity, Cordova, Capacitor, Web and macOS"],
      sources: [QO_DOCS],
      evidence: [E.qoSdks],
    },
    {
      topic: "Price",
      cells: [
        "Cloud free to $10K a month; Standard 0.5% above that, capped at $999. Self-host $0",
        "Free to $7K a month in tracked revenue, then 0.8% of all of it, not only the part above $7K",
      ],
      sources: [QO_PRICING],
      evidence: [E.qoPrice, E.qoTotal, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "Plans and add-ons",
      cells: ["Cloud Free, Cloud Standard and Enterprise, plus free self-hosting; every plan has the full open-source core", "One Pro plan with every feature, unlimited apps and seats; Enterprise adds contract terms, an SLA and a success manager"],
      sources: [QO_PRICING],
      evidence: [E.qoPlan],
    },
    {
      topic: "Stores and web",
      cells: [RD.stores + "; web checkout and funnels through Stripe", "App Store, Google Play, Stripe and Paddle; no Amazon Appstore in its docs"],
      sources: [QO_DOCS, QO_STRIPE],
      evidence: [E.qoSdks, E.qoStripe],
      visual: "web-checkout",
    },
    {
      topic: "Paywalls",
      cells: [RD.paywalls, "No-Code Paywall Builder 2.0 with remote paywall management and localization"],
      sources: [QO_PRICING, QO_DOCS],
      evidence: [E.qoPlan],
      visual: "paywalls",
    },
    {
      topic: "Targeting and experiments",
      cells: [RD.experiments, "A/B experiments on paywalls, pricing and onboarding, with advanced segmentation"],
      sources: [QO_PRICING],
      evidence: [E.qoPlan],
      visual: "experiments",
    },
    {
      topic: "Analytics",
      cells: [RD.charts, "LTV, cohorts, MRR and ARR charts, conversion charts, attribution filtering and grouping"],
      sources: [QO_PRICING],
      evidence: [E.qoPlan],
      visual: "charts",
    },
    {
      topic: "Integrations, webhooks and exports",
      cells: [RD.integrations, "Attribution, analytics and marketing integrations, Apple Search Ads, webhooks, raw data export and scheduled reports to Amazon S3 or Google Cloud Storage"],
      sources: [QO_PRICING, QO_DOCS],
      evidence: [E.qoPlan],
      visual: "integrations",
    },
    {
      topic: "Refund tools",
      cells: ["Refund Control, included", "Refund Keeper, included in Pro"],
      sources: [QO_PRICING],
      evidence: [E.qoPlan],
      visual: "refunds",
    },
    {
      topic: "AI assistants",
      cells: [RD.mcp, "An MCP server that connects AI assistants to your project data"],
      sources: [QO_MCP],
      evidence: [E.qoMcp],
      visual: "ai",
    },
    {
      topic: "Compliance",
      cells: [RD.compliance, "Lists GDPR and CCPA compliance; no SOC 2 is listed on its pricing page"],
      sources: [QO_PRICING],
      evidence: [E.qoCompliance],
    },
    {
      topic: "Support",
      cells: [RD.support, "24/7 priority support on Pro; a success manager and onboarding engineer on Enterprise"],
      sources: [QO_PRICING],
      evidence: [E.qoCompliance],
    },
  ],
  price: priceTable(
    "Formulas: Qonversion charges 0.8% of all monthly tracked revenue once you pass $7K, so $8K costs $64 and $50K costs $400. " +
      RD_RATE +
      " Enterprise plans are custom and not shown.",
    [COL_QONVERSION, COL_CLOUD, COL_SELF],
    [QO_PRICING],
    [E.qoPrice, E.qoTotal, E.rdPlans],
  ),
  blocks: [
    {
      h2: "How moving from Qonversion to RevenueDot works",
      label: "Migration",
      paras: [
        "RevenueDot's importer reads RevenueCat projects, not Qonversion ones, so the move from Qonversion is an SDK swap with a side-by-side run. You rebuild the catalog once and let customers re-sync from their store receipts.",
      ],
      steps: [
        { name: "Set up the project", text: "Create a free Cloud account, add your store credentials, and recreate products, entitlements and offerings. Point App Store and Google Play notifications at RevenueDot." },
        { name: "Swap the SDK", text: "Replace the Qonversion SDK with the RevenueCat SDK, or a RevenueDot fork, and set the proxy URL to `https://api.revenuedot.app`." },
        { name: "Run both for a cycle", text: "Keep Qonversion's webhooks flowing to your backend while RevenueDot's run in parallel. Compare entitlements, then turn Qonversion off." },
      ],
    },
    {
      h2: "How the 0.8% rate behaves as you grow",
      paras: [
        "Qonversion's rate is the lowest published among the hosted vendors, but it applies to your whole tracked revenue once you pass $7K, with no ceiling. At $250,000 a month that is $2,000. RevenueDot Cloud Standard is 0.5% above $10K, capped at $999, and self-hosting has no rate at all.",
        "Qonversion's pricing page says the bill follows your revenue month to month, so a month at or under $7K is free whatever came before.",
      ],
    },
    {
      h2: "What Qonversion does that RevenueDot does not yet",
      bullets: [
        "Paddle as a web payment provider.",
        "Scale it already runs at: its pricing page cites $1B+ in served revenue and 99.99% API uptime (its own figures).",
        "24/7 priority support on the standard plan.",
      ],
    },
  ],
  faq: [
    {
      q: "Is Qonversion cheaper than RevenueCat?",
      a: "Yes. Qonversion is free to $7K a month, then 0.8% of all tracked revenue: $400 at $50,000. RevenueCat is free to $2,500, then 1% of all tracked revenue: $500 at $50,000. RevenueDot Cloud is free to $10,000, and Cloud Standard is 0.5% above that, capped at $999.",
    },
    {
      q: "Is Qonversion open source?",
      a: "Only its SDKs. The iOS SDK on GitHub is MIT licensed, but the backend is Qonversion's hosted service. RevenueDot's server and dashboard are open source under AGPL-3.0 and can be self-hosted.",
    },
    {
      q: "Can I self-host Qonversion?",
      a: "Qonversion's docs and pricing page list no self-host option. RevenueDot runs on Docker and Postgres, so you can keep receipts, customers and purchase history in your own database.",
    },
    {
      q: "Does Qonversion charge on all revenue once I pass $7K?",
      a: "Yes. Its FAQ says the bill becomes 0.8% of your total tracked revenue, not just the amount above $7K: $64 at $8K and $400 at $50K. Months at or under $7K are free.",
    },
    {
      q: "Can I move from Qonversion to RevenueDot?",
      a: "Yes, by SDK swap. RevenueDot's importer reads RevenueCat projects only, so you recreate products and offerings, point store notifications at RevenueDot and let customers re-sync from their store receipts. Run both for a billing cycle first.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "refunds"],
  video: "https://www.youtube.com/watch?v=OpVzL6kBMn4",
  related: ["/compare/revenuedot-vs-revenuecat", "/compare/revenuecat-vs-qonversion", "/revenuecat-alternatives", "/migrate-from-revenuecat", "/pricing"],
};

// ---- 4. RevenueDot vs Superwall -------------------------------------------------------------------------------------
const VS_SUPERWALL: ComparePage = {
  slug: "revenuedot-vs-superwall",
  kind: "vs",
  columns: ["RevenueDot", "Superwall"],
  title: "RevenueDot vs Superwall: a purchase backend with paywalls vs a paywall platform",
  metaTitle: "RevenueDot vs Superwall: Price, Paywalls, Self-Hosting",
  metaDescription: "RevenueDot vs Superwall compared: free infrastructure vs paywall fees, stores, paywall editor, A/B tests, self-hosting. Sourced and checked October 2026.",
  card: "Superwall bills only on paywall revenue. RevenueDot is open source and self-hostable.",
  answer:
    "Superwall is a paywall platform whose subscription infrastructure is free, and it bills 1% only on revenue that flows through its own paywalls, once that passes $10K a month. RevenueDot is a full open-source backend with paywalls included, for apps that use the RevenueCat SDK. Choose Superwall for paywall experiments and web checkout. Choose RevenueDot to self-host and to keep the RevenueCat SDK.",
  choose: [
    {
      name: "RevenueDot",
      reasons: [
        "You want to keep the RevenueCat SDK and change one URL, not adopt a new SDK.",
        "You want to self-host and own the database. Superwall's pages describe no self-host option.",
        "You want a bill that does not depend on which paywall a purchase came through.",
        "You need Amazon Appstore, in-app currency or ad revenue reporting, which Superwall says it does not cover.",
      ],
    },
    {
      name: "Superwall",
      reasons: [
        "Paywall design and experiments are your main need, and you want the deepest tools for them.",
        "Your revenue mostly comes through purchases you do not run on Superwall paywalls, so you would pay little or nothing.",
        "You want its App-to-Web Checkout, which sends US iOS users from a paywall to Stripe checkout.",
        "You want SQL access to subscription data on its Query API and agent tooling for building paywalls.",
      ],
    },
  ],
  rows: [
    {
      topic: "What it is",
      cells: ["A purchase backend with paywalls, charts and lifecycle tools, built to work with the RevenueCat SDK", "A paywall platform with free subscription infrastructure: entitlements, purchase APIs, webhooks and SQL access"],
      sources: [SW_PRICING, SW_LLMS],
      evidence: [E.swInfra, E.swHero],
    },
    {
      topic: "Source code",
      cells: [RD.license, "Open-source SDKs (MIT) for all platforms; the backend is a hosted service"],
      sources: [SW_GH, SW_LLMS],
      evidence: [E.swMit, E.rdLicense],
    },
    {
      topic: "Where it runs",
      cells: [RD.where, "Superwall's cloud; no self-host option is described on its pricing or docs pages"],
      sources: [SW_PRICING, SW_LLMS],
      evidence: [E.swHero],
      visual: "self-host",
    },
    {
      topic: "Client SDK",
      cells: [RD.sdk, "Superwall's own SDKs: iOS, Android, React Native, Flutter, Expo, Unity, Web, Kotlin Multiplatform and Capacitor"],
      sources: [SW_PRICING, SW_LLMS],
      evidence: [E.swLimits],
    },
    {
      topic: "Price",
      cells: [
        "Cloud free to $10K a month; Standard 0.5% above that, capped at $999. Self-host $0",
        "Infrastructure free. Paywalls free up to $10K of paywall-attributed revenue a month, then 1% of all of it; Startup adds $49 a month and Scale $199",
      ],
      sources: [SW_PRICING, SW_FAQ, SW_BLOG],
      evidence: [E.swIndie, E.swMar, E.swBlogIndie, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "What the bill counts",
      cells: ["All tracked revenue above $10K", "Only revenue attributed to a Superwall paywall; purchases made outside its paywalls are not billed"],
      sources: [SW_PRICING, SW_FAQ],
      evidence: [E.swAttributed, E.swMar],
    },
    {
      topic: "Stores and web",
      cells: [RD.stores + "; web checkout and funnels through Stripe", "App Store, Google Play and Stripe, including web checkout and App-to-Web; no Amazon or Roku"],
      sources: [SW_LLMS, SW_A2W],
      evidence: [E.swLimits, E.swA2W],
      visual: "web-checkout",
    },
    {
      topic: "Paywalls",
      cells: [RD.paywalls + ". Paywalls are single-screen", "Paywall editor, template gallery, localization, AI paywall builder and an editor MCP server for coding agents"],
      sources: [SW_PRICING, SW_LLMS],
      evidence: [E.swIndie, E.swEditorMcp],
      visual: "paywalls",
    },
    {
      topic: "Targeting and experiments",
      cells: [RD.experiments, "Paywall A/B testing, audiences, campaigns and placements"],
      sources: [SW_PRICING],
      evidence: [E.swIndie],
      visual: "experiments",
    },
    {
      topic: "Analytics and data access",
      cells: [RD.charts + "; SQL against your own Postgres when self-hosted", "Charts and conversion stats, plus row-level SQL access on its Query API"],
      sources: [SW_PRICING, SW_FAQ],
      evidence: [E.swSql],
      visual: "charts",
    },
    {
      topic: "In-app currency and ad revenue",
      cells: ["In-app currencies with a ledger, and an ads overview with AdMob rewards", "Says it does not run virtual-currency systems and does not track ad revenue"],
      sources: [SW_LLMS],
      evidence: [E.swLimits],
    },
    {
      topic: "Webhooks and integrations",
      cells: [RD.integrations, "Webhooks and integrations on every plan, standardized across App Store, Google Play and Stripe"],
      sources: [SW_PRICING, SW_LLMS],
      evidence: [E.swIndie],
      visual: "integrations",
    },
    {
      topic: "Compliance and data location",
      cells: [RD.compliance, "Acts as a data processor under GDPR with a DPA; its GDPR page names no hosting region and no SOC 2 report"],
      sources: [SW_GDPR],
      evidence: [E.swGdpr],
    },
    {
      topic: "Migration from RevenueCat",
      cells: ["Importer for RevenueCat projects; keep the SDK, change the URL", "Says an automated agent swaps the SDK and ports history, entitlements and webhooks; your app uses Superwall's SDK afterward"],
      sources: [SW_PRICING],
      evidence: [E.swAgent],
      visual: "importer",
    },
  ],
  price: priceTable(
    "Formulas: Superwall's bill depends on how much revenue flows through its paywalls. The upper bound shown assumes every dollar converts through a Superwall paywall, billed at 1% of that revenue once it passes $10K a month; if none does, the cost is $0. Startup adds $49 and Scale adds $199 a month. " +
      RD_RATE,
    [COL_SUPERWALL, COL_CLOUD, COL_SELF],
    [SW_PRICING, SW_FAQ],
    [E.swIndie, E.swAttributed, E.rdPlans],
  ),
  blocks: [
    {
      h2: "How moving from Superwall to RevenueDot works",
      label: "Migration",
      paras: [
        "RevenueDot's importer reads RevenueCat projects, not Superwall ones. If you use Superwall paywalls on top of the RevenueCat SDK, RevenueDot's own paywall editor replaces them. If Superwall is your purchase backend, the move is an SDK swap.",
      ],
      steps: [
        { name: "Set up the project", text: "Create a free Cloud account, add your store credentials, and recreate products, entitlements and offerings. Point App Store and Google Play notifications at RevenueDot." },
        { name: "Rebuild the paywalls", text: "Pick a gallery template or generate one with the AI generator, then publish it. It renders in the RevenueCat SDK's paywall view without an app release." },
        { name: "Swap the SDK", text: "Replace the Superwall SDK with the RevenueCat SDK, or a RevenueDot fork, set the proxy URL to `https://api.revenuedot.app`, and run both in parallel before you cut over." },
      ],
    },
    {
      h2: "Two different pricing ideas",
      paras: [
        "Superwall's October 2025 change made subscription infrastructure free and bills only paywall-attributed revenue. If you barely use its paywalls, you may pay nothing. If most of your revenue converts through them, you pay 1% of that revenue from $10K.",
        "RevenueDot bills nothing up to $10K and plans 0.5% above that with a $999 cap, whichever paywall a purchase came through. Self-hosting has no fee at all.",
      ],
    },
    {
      h2: "Where Superwall is stronger",
      bullets: [
        "Paywall and experiment depth: campaigns, audiences, placements and an AI paywall builder with an editor MCP server.",
        "App-to-Web Checkout that moves US iOS users to a Stripe checkout and links the purchase back.",
        "A free subscription layer, so a team that only needs entitlements and webhooks pays nothing at any scale.",
      ],
    },
  ],
  faq: [
    {
      q: "Is Superwall free?",
      a: "Partly. Superwall says its subscription infrastructure, meaning entitlements, purchase APIs, webhooks and SQL access, is free at any scale. Its paywall product is free up to $10K a month of paywall-attributed revenue, then 1% of that revenue. Startup and Scale plans add $49 and $199 a month.",
    },
    {
      q: "Can I self-host Superwall?",
      a: "Superwall's pricing page and docs describe no self-host option. Its SDKs are open source on GitHub, but the backend is a hosted service. RevenueDot can be self-hosted with Docker and Postgres.",
    },
    {
      q: "Is Superwall cheaper than RevenueCat?",
      a: "Often, if only part of your revenue goes through its paywalls. RevenueCat charges 1% of all tracked revenue from $2,500: $500 at $50,000. Superwall bills 1% only on paywall-attributed revenue above $10K, so $50,000 with half through its paywalls costs about $250.",
    },
    {
      q: "Does Superwall replace RevenueCat?",
      a: "It can. Superwall now runs entitlements and purchase APIs for the App Store, Google Play and Stripe, so you can use it as your only backend, with its own SDK. It does not cover Amazon or Roku, in-app currency or ad revenue, according to its own docs.",
    },
    {
      q: "Can I use Superwall paywalls with RevenueDot?",
      a: "RevenueDot has its own paywall gallery, editor and AI generator, and it also lists Superwall as an integration partner for events. If you keep Superwall paywalls on top of the RevenueCat SDK, RevenueDot still serves the purchase backend.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "web-checkout", "charts"],
  video: "https://www.youtube.com/watch?v=lkwX_kc0NS8",
  related: ["/compare/revenuecat-vs-superwall-vs-revenuedot", "/compare/revenuedot-vs-revenuecat", "/compare/revenuecat-vs-superwall", "/revenuecat-alternatives", "/migrate-from-revenuecat", "/pricing"],
};

// ---- 5. RevenueDot vs Apphud ----------------------------------------------------------------------------------------
const VS_APPHUD: ComparePage = {
  slug: "revenuedot-vs-apphud",
  kind: "vs",
  columns: ["RevenueDot", "Apphud"],
  title: "RevenueDot vs Apphud: open source and self-hostable vs plan-based hosted pricing",
  metaTitle: "RevenueDot vs Apphud: Price, Features, Self-Hosting",
  metaDescription: "RevenueDot vs Apphud compared: Free, Pro and Expert plans against RevenueDot's cap, stores, web funnels, webhooks and self-hosting. Checked October 2026.",
  card: "Flat plans plus per-$1,000 overage, or open source with a cap at $999.",
  answer:
    "Apphud charges by plan: Free with $10K of tracked revenue, Pro at $49 a month, Expert at $59, each with extra revenue billed at $9.99 or $11.99 per $1,000. RevenueDot Cloud is free to $10K and Cloud Standard is 0.5% above that, capped at $999. Apphud suits small apps that want web funnels and flat plans. RevenueDot suits teams that want open source, self-hosting and the RevenueCat SDK.",
  choose: [
    {
      name: "RevenueDot",
      reasons: [
        "You want to keep the RevenueCat SDK in your app and switch by changing one URL.",
        "You want webhooks, exports, experiments and seats without moving up a plan to turn them on.",
        "You want to self-host, or cap your bill at $999 a month.",
        "You sell above $100K a month and want a published price, not an Enterprise quote.",
      ],
    },
    {
      name: "Apphud",
      reasons: [
        "You are small, you want flat monthly plans, and the free plan's $10K of tracked revenue is enough.",
        "You want no-code web funnels (Flows) with Stripe or Paddle, and Figma-to-paywall screens.",
        "You want data stored in the EU and US, as its data protection page says.",
        "You like plan-based pricing with a known fee and overage per $1,000.",
      ],
    },
  ],
  rows: [
    {
      topic: "Source code",
      cells: [RD.license, "Open-source SDKs (MIT); the backend is Apphud's hosted service"],
      sources: [AP_GH, AP_PRICING],
      evidence: [E.apMit, E.rdLicense],
    },
    {
      topic: "Where it runs",
      cells: [RD.where, "Apphud's cloud, with data stored in the EU and US; no self-host option is listed"],
      sources: [AP_DATA, AP_PRICING],
      evidence: [E.apData],
      visual: "self-host",
    },
    {
      topic: "Client SDK",
      cells: [RD.sdk, "Apphud's own SDKs for iOS, Android, Flutter and React Native"],
      sources: [AP_GH, AP_DOCS],
      evidence: [E.apMit],
    },
    {
      topic: "Price",
      cells: [
        "Cloud free to $10K a month; Standard 0.5% above that, capped at $999. Self-host $0",
        "Free with $10K of tracked revenue; Pro $49 a month with $5K included, then $9.99 per extra $1,000; Expert $59 with $5K included, then $11.99 per $1,000; Enterprise from $100K",
      ],
      sources: [AP_PRICING],
      evidence: [E.apPlans, E.apOverage, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "What counts as revenue",
      cells: ["Monthly tracked revenue in USD, before store fees; sandbox purchases are not counted", "Revenue in USD reported to Apphud before Apple's cut; sandbox purchases are not counted"],
      sources: [AP_PRICING],
    },
    {
      topic: "Free plan over the limit",
      cells: ["Cloud Free keeps working; above $10K, Cloud Standard is 0.5% of the revenue above $10K", "After $10K, a 7-day grace period; then purchases are still handled, but renewals are not tracked and dashboard access ends"],
      sources: [AP_PRICING],
      evidence: [E.apGrace],
    },
    {
      topic: "Stores and web",
      cells: [RD.stores + "; web checkout and funnels through Stripe", "iOS and Android, plus no-code web funnels (Flows) paid through Stripe or Paddle"],
      sources: [AP_PRICING, AP_WEB],
      evidence: [E.apWeb, E.apS3],
      visual: "web-checkout",
    },
    {
      topic: "Paywalls",
      cells: [RD.paywalls, "Visual screen builder and paywall screens built from Figma designs"],
      sources: [AP_PRICING],
      visual: "paywalls",
    },
    {
      topic: "Experiments and rules",
      cells: [RD.experiments, "Price experiments; placements in experiments and Rules on Pro and above"],
      sources: [AP_PRICING],
      evidence: [E.apPlans],
      visual: "experiments",
    },
    {
      topic: "Webhooks and exports",
      cells: [RD.integrations + ", on every plan", "Server-to-server webhooks and daily data exports on Expert and above; integrations with 20+ tools; Amazon S3 export"],
      sources: [AP_PRICING, AP_DOCS],
      evidence: [E.apSeats, E.apS3],
      visual: "integrations",
    },
    {
      topic: "Analytics",
      cells: [RD.charts, "Revenue analytics with cohorts and churn analysis on every plan; saved charts on Pro; LTV predictions on Expert"],
      sources: [AP_PRICING],
      evidence: [E.apPlans],
      visual: "charts",
    },
    {
      topic: "Seats",
      cells: ["Unlimited team members with roles", "1 seat on Free, 5 on Pro, 10 on Expert, unlimited on Enterprise"],
      sources: [AP_PRICING],
      evidence: [E.apSeats],
    },
    {
      topic: "AI assistants",
      cells: [RD.mcp, "A public MCP server"],
      sources: [AP_MCP],
      evidence: [E.apMcp],
      visual: "ai",
    },
    {
      topic: "Compliance",
      cells: [RD.compliance, "GDPR and CCPA; its data protection page lists no SOC 2"],
      sources: [AP_DATA],
      evidence: [E.apData],
    },
  ],
  price: priceTable(
    "Formulas: Apphud's Free plan includes $10K of tracked revenue. Above that, Pro costs $49 plus $9.99 for each $1,000 above the $5K it includes; the table assumes the overage prorates. Expert costs $10 more a month and $2 more per $1,000. From $100K Apphud quotes Enterprise, so those cells show the Pro list rate only. " +
      RD_RATE,
    [COL_APPHUD, COL_CLOUD, COL_SELF],
    [AP_PRICING],
    [E.apPlans, E.apOverage, E.rdPlans],
  ),
  blocks: [
    {
      h2: "How moving from Apphud to RevenueDot works",
      label: "Migration",
      paras: [
        "RevenueDot's importer reads RevenueCat projects, not Apphud ones. The move from Apphud is an SDK swap with a side-by-side run, and customers re-sync from their store receipts.",
      ],
      steps: [
        { name: "Set up the project", text: "Create a free Cloud account, add your store credentials, and recreate products, entitlements and offerings. Point App Store and Google Play notifications at RevenueDot." },
        { name: "Swap the SDK", text: "Replace the Apphud SDK with the RevenueCat SDK, or a RevenueDot fork, and set the proxy URL to `https://api.revenuedot.app`." },
        { name: "Run both for a cycle", text: "Keep Apphud's webhooks running while RevenueDot's run alongside. Compare entitlements, then turn Apphud off." },
      ],
    },
    {
      h2: "How Apphud's plans change the bill",
      paras: [
        "Apphud mixes a flat fee with a rate per $1,000. Pro at $50,000 a month costs about $499 and Expert about $599, so the rate is near 1% and 1.2% at that size. Some features sit behind the plan: server-to-server webhooks and daily exports need Expert.",
        "RevenueDot has one feature set. Webhooks, exports and experiments are included on every plan, including Cloud Free and self-host.",
      ],
    },
    {
      h2: "Where Apphud is stronger",
      bullets: [
        "No-code web funnels (Flows) with Stripe or Paddle, and paywall screens from Figma designs.",
        "A flat, predictable plan fee for small apps that stay within the included revenue.",
        "A published Enterprise tier with premium support and a dedicated support manager from $100K a month.",
      ],
    },
  ],
  faq: [
    {
      q: "How much does Apphud cost?",
      a: "Apphud's Free plan includes $10,000 of monthly tracked revenue. Pro costs $49 a month with $5,000 included, then $9.99 per extra $1,000. Expert costs $59 with $5,000 included, then $11.99 per $1,000. Enterprise starts at $100,000 and is quoted. Annual plans save 15%.",
    },
    {
      q: "Is Apphud cheaper than RevenueCat?",
      a: "At small sizes, yes. Apphud's Free plan covers $10K a month, while RevenueCat charges $100 at $10,000. At $50,000, Apphud Pro costs about $499 and RevenueCat $500, so they are close. RevenueDot Cloud is free to $10,000 and plans a $999 cap.",
    },
    {
      q: "Can I self-host Apphud?",
      a: "Apphud's pricing page and docs list no self-host option; its data is stored in the EU and US. RevenueDot can be self-hosted with Docker and Postgres, so purchase data stays in your own database.",
    },
    {
      q: "What happens if I go over Apphud's free plan?",
      a: "Apphud gives a 7-day grace period. After that it still handles in-app purchases, but it stops tracking renewals and you lose dashboard access until you upgrade.",
    },
    {
      q: "Can I migrate from Apphud to RevenueDot?",
      a: "Yes, by SDK swap. RevenueDot's importer reads RevenueCat projects only, so you recreate products and offerings, point store notifications at RevenueDot and let customers re-sync from their store receipts. Run both for a billing cycle before you cut over.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "web-checkout"],
  video: "https://www.youtube.com/watch?v=zbXBbXJ-Ltw",
  related: ["/compare/revenuedot-vs-revenuecat", "/compare/revenuedot-vs-adapty", "/revenuecat-alternatives", "/migrate-from-revenuecat", "/pricing"],
};

// ---- 6. RevenueCat vs Adapty (RevenueDot third) -----------------------------------------------------------------------
const VERSUS_RC_ADAPTY: ComparePage = {
  slug: "revenuecat-vs-adapty",
  kind: "versus",
  columns: ["RevenueCat", "Adapty", "RevenueDot"],
  title: "RevenueCat vs Adapty: price, features and the open-source third option",
  metaTitle: "RevenueCat vs Adapty: Price and Features Compared",
  metaDescription: "RevenueCat vs Adapty compared on price at $5K to $1M a month, stores, paywalls, A/B tests and SOC 2, with open-source RevenueDot as a third option.",
  card: "A fair head-to-head: RevenueCat's breadth against Adapty's free tier and growth tools.",
  answer:
    "RevenueCat is the safer default: more stores, including Amazon and Samsung Galaxy Store, a longer integration list and the longest track record. Adapty suits growth teams: a $5K free tier against RevenueCat's $2,500, an AI flow and paywall builder, and unlimited A/B variants. Both hold SOC 2 Type II, and both charge 1% of all revenue past the free limit. RevenueDot is the open-source third option.",
  choose: [
    {
      name: "RevenueCat",
      reasons: [
        "You want the widest store coverage: App Store, Google Play, Amazon, Samsung Galaxy Store, Stripe and Paddle.",
        "You want the largest base of users and integrations behind the SDK. Its homepage cites 149K+ apps.",
        "You use its Growth Tools, which bill 1% only on conversions from paywalls, funnels and tests.",
      ],
    },
    {
      name: "Adapty",
      reasons: [
        "Your revenue sits between $2,500 and $5K a month, where Adapty is free and RevenueCat charges.",
        "You want a flow and paywall builder with 50+ templates, an AI generator and unlimited A/B test variants.",
        "You want US or EU data residency, which Adapty offers on Enterprise.",
      ],
    },
    {
      name: "RevenueDot",
      reasons: [
        "You want to keep the RevenueCat SDK, and self-host or own your purchase database.",
        "You want a free tier up to $10K a month and a bill capped at $999.",
        "You accept a young project in return for open source and no revenue share when self-hosted.",
      ],
    },
  ],
  rows: [
    {
      topic: "Free tier and rate",
      cells: [
        "Free to $2,500 monthly tracked revenue, then 1% of all tracked revenue",
        "Free under $5K a month, then 1% of that month's revenue",
        "Cloud free to $10K; Standard 0.5% above that, capped at $999. Self-host $0",
      ],
      sources: [RC_PRICING, RC_STAFF, AD_PRICING],
      evidence: [E.rcPrice, E.rcStaff, E.adPrice, E.adWhen, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "What revenue counts",
      cells: [
        "Tracked revenue in USD before the platform cut, including renewals and one-time purchases",
        "Revenue in USD tracked in the billing month, before Apple, Google or Stripe take their share",
        "Tracked revenue in USD, before store fees; sandbox purchases are not counted",
      ],
      sources: [RC_PRICING, AD_PRICING],
      evidence: [E.rcPrice, E.adCounts],
    },
    {
      topic: "Other plans and fees",
      cells: [
        "Growth Tools: 1% only on conversions from paywalls, funnels and tests. Enterprise is custom",
        "Add-ons: Refund Saver 0.2%, Ads Manager 3.5% of ad spend, Mail 20% revenue share, attribution $0.03 per install. Enterprise is custom",
        "No add-on fees",
      ],
      sources: [RC_PRICING, AD_PRICING],
      evidence: [E.rcGrowth, E.rcEnterprise, E.adAddons],
    },
    {
      topic: "Stores and web",
      cells: [
        "App Store, Google Play, Amazon, Samsung Galaxy Store, Stripe and Paddle",
        "App Store and Google Play, plus web payments through Stripe and Paddle",
        RD.stores,
      ],
      sources: [RC_PLATFORMS, RC_WEB, AD_PRICING],
      evidence: [E.rcStores, E.rcWeb, E.adWeb],
    },
    {
      topic: "Paywalls",
      cells: [
        "Remotely configurable paywall editor with pre-built templates",
        "Drag-and-drop flow and paywall builder, 50+ templates, AI generator and localization",
        RD.paywalls,
      ],
      sources: [RC_PRICING, AD_PRICING],
      evidence: [E.rcPaywall, E.adTools],
      visual: "paywalls",
    },
    {
      topic: "Targeting and A/B tests",
      cells: [
        "Targeting by audience and placement; A/B testing with remote configuration",
        "Custom traffic splits, unlimited variants and early winner predictions",
        RD.experiments,
      ],
      sources: [RC_PRICING, AD_PRICING],
      evidence: [E.rcFeatures, E.adTools],
      visual: "experiments",
    },
    {
      topic: "Analytics",
      cells: ["40+ metrics", "Revenue, MRR, churn, ARPU, cohorts and predicted LTV", RD.charts],
      sources: [RC_PRICING, AD_PRICING],
      evidence: [E.rcFeatures],
      visual: "charts",
    },
    {
      topic: "Integrations and exports",
      cells: [
        "Engagement, analytics, MMP and ad-network integrations, webhooks, and CSV or Parquet exports to S3, GCS, Azure or email",
        "Integrations with attribution, analytics and messaging tools, webhooks, and export to Amazon S3",
        RD.integrations,
      ],
      sources: [RC_INTEGRATIONS, RC_EXPORTS, AD_PRICING, AD_DOCS],
      evidence: [E.rcIntegrations, E.rcExports],
      visual: "integrations",
    },
    {
      topic: "Refund tools",
      cells: ["Automated Apple refund handling", "Refund Saver, a paid add-on", "Refund Control, included"],
      sources: [RC_HOME, AD_PRICING],
      evidence: [E.rcRefund, E.adAddons],
      visual: "refunds",
    },
    {
      topic: "Compliance",
      cells: ["SOC 2 Type II and GDPR", "SOC 2 Type II and GDPR", RD.compliance],
      sources: [RC_SEC, AD_SEC],
      evidence: [E.rcSoc2, E.adSoc2],
    },
    {
      topic: "Data location",
      cells: [
        "Its security and GDPR pages name no hosting region",
        "US or EU data residency on Enterprise only",
        "Cloud runs on Cloudflare's network; a self-hosted server lives in the region you choose",
      ],
      sources: [RC_SEC, RC_GDPR, AD_PRICING],
      evidence: [E.rcGdpr, E.adResidency],
    },
    {
      topic: "Open source and self-hosting",
      cells: [
        "Open-source SDKs (MIT); the service is hosted by RevenueCat",
        "Open-source SDKs (MIT); the service is hosted by Adapty",
        "Server under AGPL-3.0, SDK forks under MIT; self-hostable",
      ],
      sources: [RC_LICENSE, AD_GH, AD_PRICING],
      evidence: [E.rcMit, E.adMit, E.rdLicense],
    },
    {
      topic: "Switching cost",
      cells: [
        "The reference SDK; other vendors build importers for it",
        "Its own SDK, so purchase code changes. A migration from RevenueCat typically takes a few days to a week, Adapty says",
        "Keeps the RevenueCat SDK, so purchase code does not change",
      ],
      sources: [RC_LICENSE, AD_PRICING, AD_MIGRATE],
      evidence: [E.adMigration, E.adLimits],
      visual: "importer",
    },
    {
      topic: "Support",
      cells: [
        "Email and support forums; dedicated support on Enterprise",
        "Community and email, live chat for paid customers, 24/7 Slack on Enterprise",
        RD.support,
      ],
      sources: [RC_PRICING, AD_PRICING],
      evidence: [E.rcSupport],
    },
  ],
  price: priceTable(
    "Formulas: RevenueCat charges 1% of all monthly tracked revenue once you reach $2,500. Adapty charges 1% of the month's revenue once you pass $5K. " +
      RD_RATE +
      " Add-ons and Enterprise plans are not included.",
    [COL_RC, COL_ADAPTY, COL_CLOUD, COL_SELF],
    [RC_PRICING, RC_STAFF, AD_PRICING],
    [E.rcPrice, E.rcStaff, E.adPrice, E.adWhen, E.rdPlans],
  ),
  blocks: [
    {
      h2: "The 1% fee behaves the same on both",
      paras: [
        "RevenueCat and Adapty both charge 1% of all revenue once you cross the free limit, not only the part above it. At $10,000 a month that is $100 on either, because both measure revenue before the stores take their cut.",
        "The difference is the doorstep. Adapty is free until $5K, RevenueCat starts at $2,500, so an app earning $4,000 a month pays RevenueCat $40 and Adapty nothing.",
      ],
    },
    {
      h2: "Where each one wins",
      bullets: [
        "**RevenueCat:** more stores, a long integration list, the biggest user base and community, and open-source SDKs.",
        "**Adapty:** a higher free tier, a flow builder that joins onboarding and paywalls, deeper A/B testing and an EU or US data region on Enterprise.",
        "**Both:** SOC 2 Type II, GDPR compliance, a paywall editor, web payments and revenue analytics.",
      ],
    },
    {
      h2: "Where RevenueDot fits",
      paras: [
        "RevenueDot is not a third SDK. It is a backend that speaks the RevenueCat SDK's API, so you can leave RevenueCat's servers and keep RevenueCat's SDK. It is open source, can be self-hosted and has a free tier up to $10K a month. It is newer than both and has no SOC 2 report yet.",
        "[Start free on RevenueDot Cloud](" + SIGNUP + ") or read the [migration guide](/migrate-from-revenuecat).",
      ],
    },
  ],
  faq: [
    {
      q: "Is Adapty cheaper than RevenueCat?",
      a: "Slightly. Adapty is free under $5K a month and RevenueCat under $2,500, and both charge 1% of all revenue after that. So Adapty is cheaper between $2,500 and $5K, and equal above $5K. Adapty adds extra fees for some add-ons such as Refund Saver and attribution.",
    },
    {
      q: "Is Adapty better than RevenueCat?",
      a: "It depends on the job. Adapty has a higher free tier, an AI flow and paywall builder and unlimited A/B variants. RevenueCat has more stores (Amazon, Samsung Galaxy Store, Paddle), a larger integration list and a bigger base of apps. Both are SOC 2 Type II.",
    },
    {
      q: "Can I migrate from RevenueCat to Adapty?",
      a: "Yes. Adapty says a migration typically takes a few days to a week. You export RevenueCat data as CSV, get Google purchase tokens from RevenueCat support, and Adapty imports them. Promotional entitlements and refund history do not come across.",
    },
    {
      q: "Do RevenueCat and Adapty charge on all revenue?",
      a: "Yes, once you pass the free limit. RevenueCat's pricing FAQ gives $25 for $2,500 of tracked revenue, and a staff reply confirms 1% of the whole figure. Adapty's FAQ says that once you cross $5K you pay 1% of that amount, and 1% of each month's revenue after.",
    },
    {
      q: "Is there an open-source alternative to both?",
      a: "Yes. RevenueDot is an open-source (AGPL-3.0) backend that implements the RevenueCat SDK's API. It can be self-hosted, runs on Cloud free to $10,000 a month, and lets you keep the RevenueCat SDK. It is newer and has no SOC 2 report yet.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "importer"],
  video: "https://www.youtube.com/watch?v=OpVzL6kBMn4",
  related: ["/compare/revenuedot-vs-revenuecat", "/compare/revenuedot-vs-adapty", "/compare/revenuecat-vs-superwall", "/revenuecat-alternatives", "/pricing"],
};

// ---- 7. RevenueCat vs Superwall (RevenueDot third) ----------------------------------------------------------------------
const VERSUS_RC_SUPERWALL: ComparePage = {
  slug: "revenuecat-vs-superwall",
  kind: "versus",
  columns: ["RevenueCat", "Superwall", "RevenueDot"],
  title: "RevenueCat vs Superwall: price, paywalls and the open-source third option",
  metaTitle: "RevenueCat vs Superwall: Price and Features Compared",
  metaDescription: "RevenueCat vs Superwall compared: 1% of all revenue vs 1% of paywall revenue, stores, paywall tools and SOC 2, with open-source RevenueDot as the third option.",
  card: "RevenueCat bills on all tracked revenue. Superwall bills on paywall revenue. A fair look.",
  answer:
    "RevenueCat and Superwall now overlap: both run entitlements and purchase APIs. Superwall's infrastructure is free and it bills 1% only on revenue from its own paywalls once that passes $10K a month, so it often costs less. RevenueCat has more stores, SOC 2 Type II and a longer record. Superwall has the deeper paywall tooling. RevenueDot is the open-source third option, with the RevenueCat SDK.",
  choose: [
    {
      name: "RevenueCat",
      reasons: [
        "You sell on Amazon, Samsung Galaxy Store or Paddle, which Superwall's docs say it does not cover.",
        "You want SOC 2 Type II and an established vendor behind your purchase path.",
        "You want in-app currency and ad-revenue reporting from the same vendor.",
      ],
    },
    {
      name: "Superwall",
      reasons: [
        "Paywall design and experiments drive your revenue, and you want the deepest tools for them.",
        "Most of your revenue comes from outside its paywalls, so you would pay little or nothing.",
        "You want App-to-Web Checkout and SQL access to your subscription data.",
      ],
    },
    {
      name: "RevenueDot",
      reasons: [
        "You want to keep the RevenueCat SDK, and self-host or own your purchase database.",
        "You want paywalls, experiments and charts included, with no billing split by paywall.",
        "You accept a young project in return for open source and a $999 cap.",
      ],
    },
  ],
  rows: [
    {
      topic: "What it is",
      cells: [
        "A subscription backend with paywalls, experiments, charts and support tools",
        "A paywall platform with free subscription infrastructure: entitlements, purchase APIs, webhooks and SQL access",
        "An open-source backend that speaks the RevenueCat SDK's API, with paywalls and charts included",
      ],
      sources: [RC_HOME, SW_PRICING],
      evidence: [E.rcHero, E.swInfra],
    },
    {
      topic: "Free tier and rate",
      cells: [
        "Free to $2,500 monthly tracked revenue, then 1% of all tracked revenue",
        "Infrastructure free at any scale; paywalls free up to $10K of paywall-attributed revenue, then 1% of all of it",
        "Cloud free to $10K; Standard 0.5% above that, capped at $999. Self-host $0",
      ],
      sources: [RC_PRICING, RC_STAFF, SW_PRICING, SW_FAQ],
      evidence: [E.rcPrice, E.rcStaff, E.swIndie, E.swMar, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "What the bill counts",
      cells: [
        "All revenue RevenueCat tracks, before the platform cut",
        "Only revenue attributed to a Superwall paywall",
        "All tracked revenue above $10K",
      ],
      sources: [RC_PRICING, SW_PRICING],
      evidence: [E.rcPrice, E.swAttributed],
    },
    {
      topic: "Paid tiers",
      cells: ["Pro, Growth Tools and Enterprise", "Indie $0, Startup $49 a month, Scale $199 a month, plus 1% of attributed revenue; Enterprise is custom", "Cloud Standard at 0.5% above $10K, capped at $999; Enterprise is custom"],
      sources: [RC_PRICING, SW_PRICING],
      evidence: [E.rcGrowth, E.swIndie],
    },
    {
      topic: "Stores and web",
      cells: [
        "App Store, Google Play, Amazon, Samsung Galaxy Store, Stripe and Paddle",
        "App Store, Google Play and Stripe, with App-to-Web checkout; no Amazon or Roku",
        RD.stores,
      ],
      sources: [RC_PLATFORMS, RC_WEB, SW_LLMS, SW_A2W],
      evidence: [E.rcStores, E.rcWeb, E.swLimits, E.swA2W],
    },
    {
      topic: "Paywalls and experiments",
      cells: [
        "Paywall editor with templates, targeting and A/B testing",
        "Paywall editor, template gallery, A/B testing, audiences, campaigns, placements and an AI paywall builder",
        RD.paywalls + "; " + RD.experiments,
      ],
      sources: [RC_PRICING, SW_PRICING, SW_LLMS],
      evidence: [E.rcFeatures, E.swIndie, E.swEditorMcp],
      visual: "paywalls",
    },
    {
      topic: "Analytics and data access",
      cells: [
        "40+ metrics and scheduled exports to S3, GCS, Azure or email",
        "Charts, conversion stats and row-level SQL access on its Query API",
        RD.charts + "; SQL on your own Postgres when self-hosted",
      ],
      sources: [RC_PRICING, RC_EXPORTS, SW_PRICING],
      evidence: [E.rcFeatures, E.rcExports, E.swSql],
      visual: "charts",
    },
    {
      topic: "In-app currency and ad revenue",
      cells: [
        "Virtual currency in its docs and revenue reporting for in-app ads",
        "Says it does not run virtual-currency systems and does not track ad revenue",
        "In-app currencies with a ledger, and an ads overview with AdMob rewards",
      ],
      sources: [RC_PRICING, RC_DOCS_INDEX, SW_LLMS],
      evidence: [E.rcVirtual, E.swLimits],
    },
    {
      topic: "Integrations",
      cells: [
        "Engagement, analytics, MMP and ad-network integrations, plus webhooks",
        "Integrations and webhooks on every plan",
        RD.integrations,
      ],
      sources: [RC_INTEGRATIONS, SW_PRICING],
      evidence: [E.rcIntegrations, E.swIndie],
      visual: "integrations",
    },
    {
      topic: "Compliance and data location",
      cells: [
        "SOC 2 Type II and GDPR; no hosting region named",
        "GDPR processor with a DPA; no SOC 2 report or hosting region named on its GDPR page",
        RD.compliance,
      ],
      sources: [RC_SEC, RC_GDPR, SW_GDPR],
      evidence: [E.rcSoc2, E.rcGdpr, E.swGdpr],
    },
    {
      topic: "Open source and self-hosting",
      cells: [
        "Open-source SDKs (MIT); hosted service",
        "Open-source SDKs (MIT); hosted service",
        "Server under AGPL-3.0, SDK forks under MIT; self-hostable",
      ],
      sources: [RC_LICENSE, SW_GH, SW_LLMS],
      evidence: [E.rcMit, E.swMit, E.rdLicense],
    },
    {
      topic: "Switching cost",
      cells: [
        "The reference SDK",
        "Its own SDK. Superwall says an automated agent ports an app from RevenueCat in under an hour",
        "Keeps the RevenueCat SDK, so purchase code does not change",
      ],
      sources: [RC_LICENSE, SW_PRICING],
      evidence: [E.swAgent],
      visual: "importer",
    },
  ],
  price: priceTable(
    "Formulas: RevenueCat charges 1% of all monthly tracked revenue once you reach $2,500. Superwall's upper bound assumes every dollar converts through a Superwall paywall, billed at 1% of it once it passes $10K, with $0 if none does; Startup and Scale add $49 and $199 a month. " +
      RD_RATE,
    [COL_RC, COL_SUPERWALL, COL_CLOUD, COL_SELF],
    [RC_PRICING, RC_STAFF, SW_PRICING, SW_FAQ],
    [E.rcPrice, E.rcStaff, E.swIndie, E.swAttributed, E.rdPlans],
  ),
  blocks: [
    {
      h2: "Two ways to meter the same revenue",
      paras: [
        "RevenueCat counts everything it tracks. Superwall counts only what its paywalls convert. For an app with $50,000 a month in which half the purchases come through Superwall paywalls, RevenueCat costs $500 and Superwall about $250. If every purchase comes through its paywalls, both cost $500.",
        "Superwall also makes the subscription layer free at any scale. A team that wants entitlements, webhooks and SQL access, and builds its own paywalls, can pay nothing.",
      ],
    },
    {
      h2: "What each does that the other does not",
      bullets: [
        "**RevenueCat:** Amazon, Samsung Galaxy Store and Paddle, virtual currency and ad-revenue reporting, and a SOC 2 Type II report.",
        "**Superwall:** deeper paywall and campaign tools, App-to-Web Checkout, and SQL access to subscription data on every plan.",
        "**Neither:** self-hosting. Both are hosted services with open-source SDKs.",
      ],
    },
    {
      h2: "Where RevenueDot fits",
      paras: [
        "RevenueDot keeps the RevenueCat SDK and replaces the hosted backend with one you can run yourself, or use on Cloud free to $10K a month. It includes paywalls, experiments, in-app currencies and charts. It is newer than both and has no SOC 2 report yet.",
        "[Start free on RevenueDot Cloud](" + SIGNUP + ").",
      ],
    },
  ],
  faq: [
    {
      q: "Is Superwall cheaper than RevenueCat?",
      a: "Often, when part of your revenue skips its paywalls. Superwall's infrastructure is free and it bills 1% only on paywall-attributed revenue above $10K a month. RevenueCat bills 1% of all tracked revenue from $2,500. If every purchase goes through a Superwall paywall, the bills are about equal above $10K.",
    },
    {
      q: "Can Superwall replace RevenueCat?",
      a: "For the App Store, Google Play and Stripe, yes. Superwall runs entitlements, purchase APIs and webhooks, and says an automated agent can port an app from RevenueCat. It does not cover Amazon or Roku, in-app currency or ad revenue, and your app switches to Superwall's SDK.",
    },
    {
      q: "Can I use Superwall and RevenueCat together?",
      a: "Yes. RevenueCat lists Superwall as an integration, so apps often keep RevenueCat for purchases and run Superwall paywalls on top. Superwall also offers its own purchase backend, so you can use it alone.",
    },
    {
      q: "Does Superwall have SOC 2?",
      a: "Its GDPR page names no SOC 2 report or hosting region, and we found no SOC 2 statement on its public pages in October 2026. RevenueCat publishes SOC 2 Type II. Ask Superwall directly if your buyers require it.",
    },
    {
      q: "Is there an open-source alternative to RevenueCat and Superwall?",
      a: "Yes. RevenueDot is an open-source backend (AGPL-3.0) that works with the RevenueCat SDK, has a paywall gallery, editor and AI generator, and can be self-hosted. Its Cloud is free to $10,000 a month. It is newer and has no SOC 2 report yet.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "web-checkout"],
  video: "https://www.youtube.com/watch?v=lkwX_kc0NS8",
  related: ["/compare/revenuecat-vs-superwall-vs-revenuedot", "/compare/revenuedot-vs-revenuecat", "/compare/revenuedot-vs-superwall", "/compare/revenuecat-vs-adapty", "/revenuecat-alternatives", "/pricing"],
};

// ---- 8. RevenueCat vs Qonversion (RevenueDot third) ---------------------------------------------------------------------
const VERSUS_RC_QONVERSION: ComparePage = {
  slug: "revenuecat-vs-qonversion",
  kind: "versus",
  columns: ["RevenueCat", "Qonversion", "RevenueDot"],
  title: "RevenueCat vs Qonversion: price, features and the open-source third option",
  metaTitle: "RevenueCat vs Qonversion: Price and Features Compared",
  metaDescription: "RevenueCat vs Qonversion compared on price at $5K to $1M a month, stores, paywalls, A/B tests and compliance, with open-source RevenueDot as the third option.",
  card: "RevenueCat's reach against Qonversion's 0.8% all-in plan, with an open-source option.",
  answer:
    "Qonversion is cheaper and simpler: free to $7K a month, then 0.8% of all tracked revenue, with every feature included. RevenueCat charges 1% from $2,500, but it has more stores, SOC 2 Type II and a far larger base of apps. Pick Qonversion for cost and an all-in-one plan, and RevenueCat for track record and breadth. RevenueDot is the open-source option that works with RevenueCat's SDK.",
  choose: [
    {
      name: "RevenueCat",
      reasons: [
        "You sell on Amazon or Samsung Galaxy Store, which Qonversion's docs do not list.",
        "You want SOC 2 Type II and the largest community of apps behind your purchase path.",
        "You want its Growth Tools, which bill 1% only on conversions from tools you use.",
      ],
    },
    {
      name: "Qonversion",
      reasons: [
        "You want the lowest published hosted rate, 0.8%, with every feature in one plan.",
        "You want unlimited apps and seats and 24/7 priority support without a tier upgrade.",
        "Your revenue is between $2,500 and $7K a month, where Qonversion is free and RevenueCat charges.",
      ],
    },
    {
      name: "RevenueDot",
      reasons: [
        "You want to keep the RevenueCat SDK, and self-host or own your purchase database.",
        "You want a free tier up to $10K a month and a bill capped at $999.",
        "You accept a young project in return for open source and no revenue share when self-hosted.",
      ],
    },
  ],
  rows: [
    {
      topic: "Free tier and rate",
      cells: [
        "Free to $2,500 monthly tracked revenue, then 1% of all tracked revenue",
        "Free to $7K a month, then 0.8% of all tracked revenue",
        "Cloud free to $10K; Standard 0.5% above that, capped at $999. Self-host $0",
      ],
      sources: [RC_PRICING, RC_STAFF, QO_PRICING],
      evidence: [E.rcPrice, E.rcStaff, E.qoPrice, E.qoTotal, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "Plans",
      cells: [
        "Pro, Growth Tools and Enterprise",
        "One Pro plan with every feature, unlimited apps and seats; Enterprise for contract terms and an SLA",
        "Cloud Standard at 0.5% above $10K, capped at $999; Enterprise is custom",
      ],
      sources: [RC_PRICING, QO_PRICING],
      evidence: [E.rcGrowth, E.qoPlan],
    },
    {
      topic: "Stores and web",
      cells: [
        "App Store, Google Play, Amazon, Samsung Galaxy Store, Stripe and Paddle",
        "App Store, Google Play, Stripe and Paddle",
        RD.stores,
      ],
      sources: [RC_PLATFORMS, RC_WEB, QO_DOCS],
      evidence: [E.rcStores, E.rcWeb, E.qoSdks],
    },
    {
      topic: "Paywalls",
      cells: [
        "Remotely configurable paywall editor with pre-built templates",
        "No-Code Paywall Builder 2.0 with remote management and localization",
        RD.paywalls,
      ],
      sources: [RC_PRICING, QO_PRICING],
      evidence: [E.rcPaywall, E.qoPlan],
      visual: "paywalls",
    },
    {
      topic: "Targeting and A/B tests",
      cells: [
        "Targeting by audience and placement; A/B testing with remote configuration",
        "A/B experiments on paywalls, pricing and onboarding, with segmentation",
        RD.experiments,
      ],
      sources: [RC_PRICING, QO_PRICING],
      evidence: [E.rcFeatures, E.qoPlan],
      visual: "experiments",
    },
    {
      topic: "Analytics",
      cells: ["40+ metrics", "LTV, cohorts, MRR and ARR, conversion charts and attribution filtering", RD.charts],
      sources: [RC_PRICING, QO_PRICING],
      evidence: [E.rcFeatures, E.qoPlan],
      visual: "charts",
    },
    {
      topic: "Integrations and exports",
      cells: [
        "Engagement, analytics, MMP and ad-network integrations, webhooks, and CSV or Parquet exports to S3, GCS, Azure or email",
        "Attribution, analytics and marketing integrations, webhooks, raw data export and scheduled reports",
        RD.integrations,
      ],
      sources: [RC_INTEGRATIONS, RC_EXPORTS, QO_PRICING, QO_DOCS],
      evidence: [E.rcIntegrations, E.rcExports, E.qoPlan],
      visual: "integrations",
    },
    {
      topic: "Refund tools",
      cells: ["Automated Apple refund handling", "Refund Keeper, included", "Refund Control, included"],
      sources: [RC_HOME, QO_PRICING],
      evidence: [E.rcRefund, E.qoPlan],
      visual: "refunds",
    },
    {
      topic: "AI assistants",
      cells: ["An AI toolkit with plugins, skills, an MCP server and a CLI", "An MCP server for project data", RD.mcp],
      sources: [RC_AI, QO_MCP],
      evidence: [E.rcAi, E.qoMcp],
      visual: "ai",
    },
    {
      topic: "Compliance",
      cells: ["SOC 2 Type II and GDPR", "GDPR and CCPA; no SOC 2 listed on its pricing page", RD.compliance],
      sources: [RC_SEC, QO_PRICING],
      evidence: [E.rcSoc2, E.qoCompliance],
    },
    {
      topic: "Open source and self-hosting",
      cells: [
        "Open-source SDKs (MIT); hosted service",
        "Open-source SDKs (MIT); hosted service",
        "Server under AGPL-3.0, SDK forks under MIT; self-hostable",
      ],
      sources: [RC_LICENSE, QO_GH, QO_PRICING],
      evidence: [E.rcMit, E.qoMit, E.rdLicense],
    },
    {
      topic: "Switching cost",
      cells: [
        "The reference SDK",
        "Its own SDK, with a written guide for moving from RevenueCat",
        "Keeps the RevenueCat SDK, so purchase code does not change",
      ],
      sources: [RC_LICENSE, QO_MIGRATE, QO_VS_RC],
      evidence: [E.qoGuide, E.qoVsRc],
      visual: "importer",
    },
    {
      topic: "Support",
      cells: [
        "Email and support forums; dedicated support on Enterprise",
        "24/7 priority support on Pro",
        RD.support,
      ],
      sources: [RC_PRICING, QO_PRICING],
      evidence: [E.rcSupport, E.qoCompliance],
    },
  ],
  price: priceTable(
    "Formulas: RevenueCat charges 1% of all monthly tracked revenue once you reach $2,500. Qonversion charges 0.8% of all tracked revenue once you pass $7K. " +
      RD_RATE +
      " Enterprise plans are custom and not shown.",
    [COL_RC, COL_QONVERSION, COL_CLOUD, COL_SELF],
    [RC_PRICING, RC_STAFF, QO_PRICING],
    [E.rcPrice, E.rcStaff, E.qoPrice, E.qoTotal, E.rdPlans],
  ),
  blocks: [
    {
      h2: "What the difference costs you",
      paras: [
        "Both vendors bill the whole amount once you pass the free limit. At $50,000 a month RevenueCat costs $500 and Qonversion $400. At $1,000,000 a month it is $10,000 against $8,000. RevenueDot Cloud Standard stops at $999, and self-hosting has no fee.",
      ],
    },
    {
      h2: "Where each one wins",
      bullets: [
        "**RevenueCat:** more stores, SOC 2 Type II, a larger integration list and the biggest base of apps and developers.",
        "**Qonversion:** a lower rate, a free tier $4,500 higher than RevenueCat's, one plan with every feature and 24/7 priority support.",
        "**Both:** open-source SDKs, a paywall builder, A/B tests, webhooks, raw exports and Stripe web payments.",
      ],
    },
    {
      h2: "Where RevenueDot fits",
      paras: [
        "RevenueDot keeps the RevenueCat SDK, so leaving RevenueCat's servers does not mean a new SDK. It is open source, can be self-hosted and includes paywalls, experiments and 43 charts. It is newer than both and has no SOC 2 report yet.",
        "[Start free on RevenueDot Cloud](" + SIGNUP + ") or read the [migration guide](/migrate-from-revenuecat).",
      ],
    },
  ],
  faq: [
    {
      q: "Is Qonversion cheaper than RevenueCat?",
      a: "Yes. Qonversion is free to $7K a month, then 0.8% of all tracked revenue. RevenueCat is free to $2,500, then 1%. At $50,000 a month that is $400 against $500. Both count revenue before the stores take their cut.",
    },
    {
      q: "Is Qonversion a good RevenueCat alternative?",
      a: "For cost and an all-in-one plan, yes: every feature is in one plan, with unlimited apps and seats. It lacks Amazon Appstore support in its docs and lists no SOC 2 report on its pricing page. RevenueCat has the larger track record and wider store coverage.",
    },
    {
      q: "Can I migrate from RevenueCat to Qonversion?",
      a: "Yes. Qonversion publishes a step-by-step guide for moving from RevenueCat, and says migration takes one to two days with support. You change SDKs, so purchase code changes. RevenueDot instead keeps the RevenueCat SDK and changes one URL.",
    },
    {
      q: "Does Qonversion charge on all revenue past $7K?",
      a: "Yes. Its FAQ says the bill is 0.8% of your total tracked revenue, not only the amount above $7K: $64 at $8K and $400 at $50K. A month at or under $7K is free.",
    },
    {
      q: "Is there an open-source alternative to RevenueCat and Qonversion?",
      a: "Yes. RevenueDot is an open-source backend (AGPL-3.0) that implements the RevenueCat SDK's API and can be self-hosted. Its Cloud is free to $10,000 a month, and Cloud Standard is 0.5% above that, capped at $999. It is newer and has no SOC 2 report yet.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "refunds"],
  video: "https://www.youtube.com/watch?v=OpVzL6kBMn4",
  related: ["/compare/revenuedot-vs-revenuecat", "/compare/revenuedot-vs-qonversion", "/compare/revenuecat-vs-adapty", "/revenuecat-alternatives", "/pricing"],
};

// ---- 9. RevenueCat vs Stripe (RevenueDot third) -------------------------------------------------------------------------
// Different jobs: Stripe charges cards on the web; RevenueCat manages store purchases and can sell on the web through Stripe.
const STRIPE_PRICING = src("Stripe pricing page", "https://stripe.com/pricing");
const STRIPE_BILLING = src("Stripe Billing pricing", "https://stripe.com/billing/pricing");
const STRIPE_CHECKOUT = src("Stripe Checkout docs", "https://docs.stripe.com/checkout/quickstart");
const STRIPE_ANALYTICS = src("Stripe Billing analytics docs", "https://docs.stripe.com/billing/subscriptions/analytics");
const APPLE_GUIDELINES = src("Apple App Review Guidelines 3.1", "https://developer.apple.com/app-store/review/guidelines/");
const APPLE_SUBS = src("Apple: auto-renewable subscriptions", "https://developer.apple.com/app-store/subscriptions/");
const GOOGLE_FEES = src("Google Play service fees", "https://support.google.com/googleplay/android-developer/answer/112622?hl=en");
const GOOGLE_PAYMENTS = src("Google Play Payments policy", "https://support.google.com/googleplay/android-developer/answer/9858738");
// Stripe on web sales of a $9.99 monthly plan: 2.9% + 30c per US card charge, plus 0.7% Stripe Billing.
const stripeFee = (m: number) => m * (0.029 + 0.007) + (m / 9.99) * 0.3;

const VERSUS_RC_STRIPE: ComparePage = {
  slug: "revenuecat-vs-stripe",
  kind: "versus",
  columns: ["RevenueCat", "Stripe", "RevenueDot"],
  title: "RevenueCat vs Stripe: in-app purchases, web billing and fees compared",
  metaTitle: "RevenueCat vs Stripe: Which One Does Your App Need?",
  metaDescription:
    "RevenueCat vs Stripe: Stripe charges cards on the web, RevenueCat runs App Store and Google Play purchases. When to use each, the store rules and fees, sourced.",
  card: "Stripe charges cards on the web; RevenueCat runs store purchases. When you need each, and how they work together.",
  answer:
    "RevenueCat and Stripe do different jobs, and many apps use both. Stripe charges cards on your website. RevenueCat manages in-app purchases that Apple and Google charge, and can sell on the web through Stripe so a web purchase unlocks access in the app. Inside an iOS app, digital features must be sold with in-app purchase, though US storefront apps may link to a web checkout. RevenueDot is the open-source option for RevenueCat's job.",
  choose: [
    {
      name: "RevenueCat",
      reasons: [
        "You sell subscriptions inside iOS and Android apps and want a mature hosted backend with a SOC 2 report.",
        "You want App Store, Google Play and web purchases to unlock one entitlement.",
        "You also sell through Paddle or the Samsung Galaxy Store.",
      ],
    },
    {
      name: "Stripe",
      reasons: [
        "You sell a web app or SaaS, where no app store takes part in the payment.",
        "You sell physical goods or services used outside the app, which Apple says must not use in-app purchase.",
        "You already run your own backend for accounts and access, and only need payments.",
      ],
    },
    {
      name: "RevenueDot",
      reasons: [
        "You want RevenueCat's job done by an open-source server that works with the RevenueCat SDK.",
        "You want web checkout on your own Stripe account to unlock the same entitlement as the stores.",
        "You want it free up to $10K a month, or on your own servers.",
      ],
    },
  ],
  rows: [
    {
      topic: "What it is",
      cells: [
        "A hosted backend for in-app purchases and subscriptions on the App Store, Google Play and the web",
        "A payment processor and billing system for cards and other payment methods",
        "An open-source backend for in-app purchases and subscriptions that works with the RevenueCat SDK",
      ],
      sources: [RC_HOME, STRIPE_PRICING],
      evidence: [E.rcHero, E.stCheckout],
    },
    {
      topic: "Who charges the customer",
      cells: [
        "Apple or Google for store purchases. On the web, Stripe or Paddle; RevenueCat Billing uses Stripe as the payment gateway",
        "Stripe charges the card and pays out to you",
        "Apple, Google or Amazon for store purchases. On the web, your own Stripe account",
      ],
      sources: [RC_WEB, STRIPE_PRICING],
      evidence: [E.rcWeb, E.stCard],
    },
    {
      topic: "Digital features inside an iOS or Android app",
      cells: [
        "Yes, through each store's in-app purchase system",
        "Not as the in-app payment. Apple requires in-app purchase to unlock features; US storefront apps may link to a web checkout",
        "Yes, through each store's in-app purchase system",
      ],
      sources: [APPLE_GUIDELINES, GOOGLE_PAYMENTS],
      evidence: [E.appleGuideline, E.gPolicy],
    },
    {
      topic: "Web checkout",
      cells: [
        "Web Billing, Stripe Billing or Paddle, with web purchase links, web paywalls and funnels",
        "Checkout, Billing, a customer portal and invoices",
        RD.web + ", on your own Stripe account",
      ],
      sources: [RC_WEB, RC_STRIPE, STRIPE_CHECKOUT],
      evidence: [E.rcWeb, E.stCheckout],
      visual: "web-checkout",
    },
    {
      topic: "Unlocks access in the mobile app",
      cells: [
        "Yes. Web purchases unlock entitlements in the app, with redemption links for buyers who are not signed in",
        "No. Your own backend maps the Stripe customer to the app user and grants access",
        "Yes. A Stripe purchase unlocks the same entitlement as App Store and Google Play, with redemption links",
      ],
      sources: [RC_WEB, RC_STRIPE, STRIPE_CHECKOUT],
      evidence: [E.rcStripe, E.stCheckout],
      visual: "redemption-links",
    },
    {
      topic: "App Store and Google Play purchases",
      cells: [
        "Validates them and handles the stores' server notifications",
        "Does not process App Store or Google Play purchases",
        "Validates them and handles the stores' server notifications",
      ],
      sources: [RC_QUICKSTART, STRIPE_PRICING],
      evidence: [E.rcSdks],
    },
    {
      topic: "Fees",
      cells: [
        "Free to $2,500 monthly tracked revenue, then 1% of all of it. RevenueCat Web adds no RevenueCat fee; Stripe's fees still apply",
        "2.9% + 30¢ per successful US card charge, 1.5% more for international cards, and 0.7% of volume for Stripe Billing",
        "Cloud free to $10K a month; Standard 0.5% above, capped at $999. Self-host $0. Stripe's fees still apply on web sales",
      ],
      sources: [RC_PRICING, RC_WEB, STRIPE_PRICING, STRIPE_BILLING],
      evidence: [E.rcPrice, E.stCard, E.stIntl, E.stBilling, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "Subscription analytics",
      cells: [
        "MRR, churn, trials and more across stores and the web",
        "Billing analytics for Stripe subscriptions only",
        RD.charts + ", across stores and Stripe",
      ],
      sources: [RC_PRICING, STRIPE_ANALYTICS],
      evidence: [E.rcFeatures, E.stAnalytics],
      visual: "charts",
    },
    {
      topic: "Open source",
      cells: [
        "Open-source SDKs (MIT); the service is hosted by RevenueCat",
        "A hosted service",
        "Server under AGPL-3.0, SDK forks under MIT; self-hostable",
      ],
      sources: [RC_LICENSE, STRIPE_PRICING],
      evidence: [E.rcMit, E.rdLicense],
    },
  ],
  price: {
    intro:
      "Each column is a separate fee. Store purchases pay Apple or Google, web sales pay Stripe, and RevenueCat or RevenueDot charges on top of either. The store column uses 15%, the rate for Apple's Small Business Program and Google Play subscriptions. The Stripe column assumes $9.99 monthly plans sold on the web: 2.9% + 30¢ per US card charge plus 0.7% for Stripe Billing. " +
      RD_RATE,
    head: ["Monthly revenue", "Store fee (15%)", "RevenueCat", "Stripe (web, $9.99 plans)", "RevenueDot Cloud"],
    rows: LEVELS.map((m) => [usd(m), usd(m * 0.15), usd(rcBill(m)), usd(stripeFee(m)), usd(cloudBill(m))]),
    sources: [APPLE_SUBS, GOOGLE_FEES, RC_PRICING, STRIPE_PRICING, STRIPE_BILLING],
    evidence: [E.appleSbp, E.gFees, E.rcPrice, E.stCard, E.stBilling, E.rdPlans],
  },
  blocks: [
    {
      h2: "When to use Stripe and when to use in-app purchase",
      label: "Store rules",
      paras: [
        "Apple's App Review Guideline 3.1.1 says that to unlock features or functionality within your app, such as subscriptions or premium content, you must use in-app purchase. Physical goods and services used outside the app must use another method, such as Apple Pay or a card ([Apple](https://developer.apple.com/app-store/review/guidelines/)). Google Play's [Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738) requires Google Play's billing system for digital goods, with exceptions for physical goods and alternative billing programs in some countries.",
        "On the United States storefront, iOS apps may now link to a web checkout. Our guide to [selling iOS subscriptions on the web with Stripe](/blog/web-checkout-for-ios-apps-stripe) covers the court rulings and the fee math.",
      ],
      table: {
        head: ["What you sell", "Inside an iOS app", "Inside an Android app", "On your website"],
        rows: [
          ["Subscriptions or premium features", "In-app purchase. US storefront apps may also link to web checkout", "Google Play Billing, with alternative programs in some countries", "Stripe"],
          ["Credits, coins or AI usage", "In-app purchase", "Google Play Billing", "Stripe"],
          ["Physical goods or services used outside the app", "Apple Pay or a card, not in-app purchase", "Your own payment processor", "Stripe"],
        ],
        caption: "Rules checked October 2026. They change by country and by court ruling, so read Apple's and Google's current policy before you ship.",
      },
    },
    {
      h2: "How a Stripe purchase unlocks access in the app",
      label: "Web to app",
      paras: ["RevenueCat and RevenueDot both connect a Stripe purchase on your website to the app. The flow is the same in both."],
      steps: [
        { name: "The customer pays on the web", text: "A link in the app, an ad or an email opens a checkout page that creates a Stripe Checkout Session on your Stripe account." },
        { name: "The backend records the purchase", text: "Stripe's `checkout.session.completed` webhook reaches the backend, which records the purchase like any store purchase and sends your webhooks." },
        { name: "The purchase moves to the app user", text: "If the link carried the app user ID, the purchase lands on that user. If not, a redemption link opens the app and moves the purchase to the signed-in customer." },
        { name: "The app sees the entitlement", text: "The SDK's customer info shows the same `pro` entitlement that an App Store or Google Play purchase would unlock." },
      ],
    },
    {
      h2: "What you keep from a $9.99 subscription",
      label: "Per sale",
      table: {
        head: ["Channel", "Fee on $9.99", "You keep"],
        rows: [
          ["App Store, 30% (first year)", "$3.00", "$6.99"],
          ["App Store or Google Play, 15%", "$1.50", "$8.49"],
          ["Stripe card, 2.9% + 30¢", "$0.59", "$9.40"],
          ["Stripe card plus Billing at 0.7%", "$0.66", "$9.33"],
        ],
        caption: "Before tax. On the web you also handle sales tax or VAT, refunds and chargebacks. Sources: [Apple](https://developer.apple.com/app-store/subscriptions/), [Google Play](https://support.google.com/googleplay/android-developer/answer/112622?hl=en), [Stripe](https://stripe.com/pricing). Try other prices in the [App Store and Google Play fee calculator](/tools/app-store-fee-calculator).",
      },
    },
    {
      h2: "Where RevenueDot fits",
      paras: [
        "RevenueDot does RevenueCat's job with an open-source server: App Store, Google Play, Amazon Appstore and Stripe purchases in one customer record, with the RevenueCat SDK in your app. Web checkout runs on your own Stripe account with a restricted key, and [purchase links](/features/purchase-links), [funnels](/features/funnels) and redemption links come included. Connect with Stripe (sign in to Stripe instead of pasting a key) is not available on RevenueDot Cloud yet.",
        "It is newer than RevenueCat and has no SOC 2 report. [Start free on RevenueDot Cloud](" + SIGNUP + ") or read about [web checkout](/features/web-billing).",
      ],
    },
  ],
  faq: [
    {
      q: "Can I use Stripe instead of in-app purchases in my iOS app?",
      a: "Not for features unlocked inside the app. Apple's guideline 3.1.1 requires in-app purchase for that. On the US storefront you may link from the app to a web checkout that uses Stripe. Physical goods and services must use a method other than in-app purchase, such as Stripe.",
    },
    {
      q: "Does RevenueCat work with Stripe?",
      a: "Yes. RevenueCat can use your Stripe account as its web billing engine, import Stripe Billing purchases and unlock entitlements in the app for them. Its own RevenueCat Billing also uses Stripe as the payment gateway. RevenueCat says its web features add no RevenueCat fee beyond its normal price.",
    },
    {
      q: "Is RevenueCat cheaper than Stripe?",
      a: "They charge for different things. Stripe takes 2.9% + 30¢ per US card charge on web sales. RevenueCat charges 1% of all tracked revenue from $2,500 a month, on top of the store's or Stripe's fee. An app that sells on the web through RevenueCat pays both.",
    },
    {
      q: "Do I need RevenueCat if I already use Stripe for my web app?",
      a: "Only if you add an iOS or Android app that sells digital features. Those sales go through the stores' in-app purchase, and a backend such as RevenueCat or RevenueDot joins them with your Stripe customers so one account has one set of access.",
    },
    {
      q: "Can RevenueDot sell subscriptions with Stripe?",
      a: "Yes. RevenueDot connects to your own Stripe account with a restricted key and offers hosted checkout, purchase links, funnels, web discounts and redemption links. A Stripe purchase unlocks the same entitlement as an App Store or Google Play purchase.",
    },
  ],
  checked: CHECKED,
  seeIt: ["web-checkout", "redemption-links", "charts", "funnels"],
  video: "https://www.youtube.com/watch?v=hcvvo6Sag0Q",
  related: ["/stores/stripe", "/features/web-billing", "/blog/web-checkout-for-ios-apps-stripe", "/in-app-purchases", "/tools/app-store-fee-calculator", "/compare/revenuedot-vs-revenuecat"],
};

// ---- 10. RevenueCat vs Superwall vs RevenueDot (three-way) ------------------------------------------------------------
// The query "RevenueCat vs Superwall vs RevenueDot" had no page anywhere on the web in October 2026, so AI answers guessed
// RevenueDot was a typo. Every vendor cell repeats a sourced cell from pages 1, 4 and 7 above.
const THREE_LEVELS = [10_000, 100_000, 1_000_000];
const THREE_WAY_RC_SUPERWALL: ComparePage = {
  slug: "revenuecat-vs-superwall-vs-revenuedot",
  kind: "versus",
  columns: ["RevenueCat", "Superwall", "RevenueDot"],
  short: "RevenueCat vs Superwall vs RevenueDot",
  title: "RevenueCat vs Superwall vs RevenueDot: price, paywalls and self-hosting compared",
  metaTitle: "RevenueCat vs Superwall vs RevenueDot (2026)",
  metaDescription:
    "RevenueCat vs Superwall vs RevenueDot: what each costs at $10K, $100K and $1M a month, stores, paywalls, SOC 2 and self-hosting, with a source for every claim.",
  card: "All three in one table: 1% of all revenue, 1% of paywall revenue, or 0.5% capped at $999.",
  answer:
    "All three run entitlements and purchases for the App Store and Google Play; they differ on price and where they run. RevenueCat charges 1% of all tracked revenue from $2,500 a month and has SOC 2 and the longest record. Superwall's infrastructure is free and it bills 1% only on revenue from its own paywalls above $10K. RevenueDot is open source, keeps the RevenueCat SDK, is free on Cloud to $10K with a $999 cap, and can be self-hosted.",
  choose: [
    {
      name: "RevenueCat",
      reasons: [
        "You sell on Amazon, Samsung Galaxy Store or Paddle, which Superwall's docs say it does not cover and RevenueDot has not yet run on live purchases for Paddle and Galaxy Store.",
        "You want SOC 2 Type II and an established vendor behind your purchase path.",
        "You want in-app currency and ad-revenue reporting from the same vendor, with years of production history.",
      ],
    },
    {
      name: "Superwall",
      reasons: [
        "Paywall design and experiments drive your revenue, and you want the deepest tools for them.",
        "Most of your revenue comes from outside its paywalls, so you would pay little or nothing.",
        "You want App-to-Web Checkout and SQL access to your subscription data.",
      ],
    },
    {
      name: "RevenueDot",
      reasons: [
        "You want to keep the RevenueCat SDK, and self-host or own your purchase database.",
        "You want paywalls, experiments and charts included, with no billing split by paywall and a bill that never passes $999 a month on Cloud.",
        "You accept a young project in return for open source: first release v2026.10.03, running next to RevenueCat in a production app since October 2, 2026.",
      ],
    },
  ],
  rows: [
    {
      topic: "What it is",
      cells: [
        "A subscription backend with paywalls, experiments, charts and support tools",
        "A paywall platform with free subscription infrastructure: entitlements, purchase APIs, webhooks and SQL access",
        "An open-source backend that speaks the RevenueCat SDK's API, with paywalls and charts included",
      ],
      sources: [RC_HOME, SW_PRICING],
      evidence: [E.rcHero, E.swInfra],
    },
    {
      topic: "Free tier and rate",
      cells: [
        "Free to $2,500 monthly tracked revenue, then 1% of all tracked revenue",
        "Infrastructure free at any scale; paywalls free up to $10K of paywall-attributed revenue, then 1% of all of it",
        "Cloud free to $10K; Standard 0.5% above that, capped at $999. Self-host $0",
      ],
      sources: [RC_PRICING, RC_STAFF, SW_PRICING, SW_FAQ],
      evidence: [E.rcPrice, E.rcStaff, E.swIndie, E.swMar, E.rdPlans],
      visual: "cloud-billing",
    },
    {
      topic: "What the bill counts",
      cells: ["All revenue RevenueCat tracks, before the platform cut", "Only revenue attributed to a Superwall paywall", "All tracked revenue above $10K"],
      sources: [RC_PRICING, SW_PRICING],
      evidence: [E.rcPrice, E.swAttributed],
    },
    {
      topic: "Bill at $100,000 a month",
      cells: [usd(rcBill(100_000)), COL_SUPERWALL.cell(100_000) + ", depending on how much converts through its paywalls", usd(cloudBill(100_000)) + " on Cloud; $0 self-hosted"],
      sources: [RC_PRICING, RC_STAFF, SW_PRICING, SW_FAQ],
      evidence: [E.rcStaff, E.swMar, E.rdPlans],
    },
    {
      topic: "Paid tiers",
      cells: ["Pro, Growth Tools and Enterprise", "Indie $0, Startup $49 a month, Scale $199 a month, plus 1% of attributed revenue; Enterprise is custom", "Cloud Standard at 0.5% above $10K, capped at $999; Enterprise is custom"],
      sources: [RC_PRICING, SW_PRICING],
      evidence: [E.rcGrowth, E.swIndie],
    },
    {
      topic: "Client SDK",
      cells: ["The reference SDK, open source (MIT)", "Its own SDKs: iOS, Android, React Native, Flutter, Expo, Unity, Web, Kotlin Multiplatform and Capacitor", RD.sdk],
      sources: [RC_LICENSE, SW_PRICING, SW_LLMS],
      evidence: [E.rcMit, E.swLimits],
    },
    {
      topic: "Where it runs",
      cells: ["RevenueCat's cloud; no self-host option is listed", "Superwall's cloud; no self-host option is described on its pricing or docs pages", RD.where],
      sources: [RC_PRICING, RC_HOME, SW_PRICING, SW_LLMS],
      evidence: [E.rcHero, E.swHero],
      visual: "self-host",
    },
    {
      topic: "Stores and web",
      cells: [
        "App Store, Google Play, Amazon, Samsung Galaxy Store, Stripe and Paddle",
        "App Store, Google Play and Stripe, with App-to-Web checkout; no Amazon or Roku",
        RD.stores,
      ],
      sources: [RC_PLATFORMS, RC_WEB, SW_LLMS, SW_A2W],
      evidence: [E.rcStores, E.rcWeb, E.swLimits, E.swA2W],
    },
    {
      topic: "Paywalls and experiments",
      cells: [
        "Paywall editor with templates, targeting and A/B testing",
        "Paywall editor, template gallery, A/B testing, audiences, campaigns, placements and an AI paywall builder",
        RD.paywalls + ". Paywalls are single-screen; " + RD.experiments,
      ],
      sources: [RC_PRICING, SW_PRICING, SW_LLMS],
      evidence: [E.rcFeatures, E.swIndie, E.swEditorMcp],
      visual: "paywalls",
    },
    {
      topic: "Analytics and data access",
      cells: [
        "40+ metrics and scheduled exports to S3, GCS, Azure or email",
        "Charts, conversion stats and row-level SQL access on its Query API",
        RD.charts + "; SQL on your own Postgres when self-hosted",
      ],
      sources: [RC_PRICING, RC_EXPORTS, SW_PRICING],
      evidence: [E.rcFeatures, E.rcExports, E.swSql],
      visual: "charts",
    },
    {
      topic: "Integrations",
      cells: ["Engagement, analytics, MMP and ad-network integrations, plus webhooks", "Integrations and webhooks on every plan", RD.integrations],
      sources: [RC_INTEGRATIONS, SW_PRICING],
      evidence: [E.rcIntegrations, E.swIndie],
      visual: "integrations",
    },
    {
      topic: "In-app currency and ad revenue",
      cells: [
        "Virtual currency in its docs and revenue reporting for in-app ads",
        "Says it does not run virtual-currency systems and does not track ad revenue",
        "In-app currencies with a ledger, and an ads overview with AdMob rewards",
      ],
      sources: [RC_PRICING, RC_DOCS_INDEX, SW_LLMS],
      evidence: [E.rcVirtual, E.swLimits],
    },
    {
      topic: "Compliance and data location",
      cells: [
        "SOC 2 Type II and GDPR; no hosting region named",
        "GDPR processor with a DPA; no SOC 2 report or hosting region named on its GDPR page",
        RD.compliance,
      ],
      sources: [RC_SEC, RC_GDPR, SW_GDPR],
      evidence: [E.rcSoc2, E.rcGdpr, E.swGdpr],
    },
    {
      topic: "Open source and self-hosting",
      cells: ["Open-source SDKs (MIT); hosted service", "Open-source SDKs (MIT); hosted service", "Server under AGPL-3.0, SDK forks under MIT; self-hostable"],
      sources: [RC_LICENSE, SW_GH, SW_LLMS],
      evidence: [E.rcMit, E.swMit, E.rdLicense],
    },
    {
      topic: "Maturity",
      cells: ["Mature: its homepage cites 149K+ apps and $17B+ revenue processed", "Hosted service with open-source SDKs; its pricing model changed in October 2025", RD.maturity],
      sources: [RC_HOME, SW_BLOG, SW_PRICING],
      evidence: [E.rcApps, E.swBlogDate],
    },
    {
      topic: "Switching cost from RevenueCat",
      cells: ["None: it is the reference", "Its own SDK. Superwall says an automated agent ports an app from RevenueCat in under an hour", "Keeps the RevenueCat SDK, so purchase code does not change; an importer copies the project"],
      sources: [RC_LICENSE, SW_PRICING],
      evidence: [E.swAgent],
      visual: "importer",
    },
  ],
  price: priceTable(
    "Formulas: RevenueCat charges 1% of all monthly tracked revenue once you reach $2,500, so $10,000 costs $100. Superwall's upper bound assumes every dollar converts through a Superwall paywall, billed at 1% of it once it passes $10K, with $0 if none does; Startup and Scale add $49 and $199 a month. " +
      RD_RATE +
      " Enterprise plans are custom and not shown.",
    [COL_RC, COL_SUPERWALL, COL_CLOUD, COL_SELF],
    [RC_PRICING, RC_STAFF, SW_PRICING, SW_FAQ],
    [E.rcPrice, E.rcStaff, E.swIndie, E.swAttributed, E.rdPlans],
    THREE_LEVELS,
  ),
  blocks: [
    {
      h2: "Three pricing models, one sentence each",
      paras: [
        "**RevenueCat** counts every dollar it tracks: nothing up to $2,500 a month, then 1% of all of it, with no ceiling, so $1,000,000 a month costs $10,000.",
        "**Superwall** gives the subscription layer away and counts only purchases that convert through its paywalls: nothing up to $10,000 of that revenue, then 1% of it, plus $49 or $199 a month on the Startup and Scale plans.",
        "**RevenueDot** counts every dollar above $10,000 a month at 0.5% and stops at $999, so $1,000,000 a month costs $999 on Cloud and $0 self-hosted.",
      ],
    },
    {
      h2: "Where each one is weaker",
      bullets: [
        "**RevenueCat:** the only one of the three with no price cap and no free tier past $2,500, and no way to run it yourself.",
        "**Superwall:** your app moves to Superwall's SDK, it does not cover Amazon or Roku, and its GDPR page names no SOC 2 report.",
        "**RevenueDot:** launched in 2026 with no SOC 2 report yet, paywalls are single-screen, and its Paddle, Roku and Galaxy Store support has not run a real store purchase.",
      ],
    },
    {
      h2: "Using two of them together",
      paras: [
        "RevenueCat lists Superwall as an integration, so many apps keep RevenueCat for purchases and run Superwall paywalls on top; Superwall now also offers its own purchase backend. RevenueDot lists Superwall as an integration partner for events too, so Superwall paywalls on the RevenueCat SDK keep working when the SDK points at RevenueDot.",
        "RevenueDot and RevenueCat can run side by side: RevenueDot forwards each store notification to RevenueCat, so both stay current while you compare them. That is how RevenueDot has run in a production app next to RevenueCat since October 2, 2026.",
      ],
    },
    RD_MIGRATION_RC,
  ],
  faq: [
    {
      q: "Which is cheapest: RevenueCat, Superwall or RevenueDot?",
      a: "Self-hosted RevenueDot, at $0. On hosted plans, RevenueDot Cloud is free to $10,000 a month and never more than $999: $450 at $100,000 and $999 at $1,000,000. RevenueCat costs $1,000 and $10,000 at those levels. Superwall costs between $0 and the same as RevenueCat, depending on how much revenue converts through its paywalls.",
    },
    {
      q: "Is RevenueDot a typo for RevenueCat?",
      a: "No. RevenueDot is a separate product: an open-source backend (AGPL-3.0) that answers the same API the RevenueCat SDKs call, so an app keeps the RevenueCat SDK and points it at RevenueDot. Its first release is v2026.10.03, and it has run next to RevenueCat in a production app since October 2, 2026.",
    },
    {
      q: "Can Superwall replace RevenueCat?",
      a: "For the App Store, Google Play and Stripe, yes. Superwall runs entitlements, purchase APIs and webhooks, and says an automated agent can port an app from RevenueCat. It does not cover Amazon or Roku, in-app currency or ad revenue, and your app switches to Superwall's SDK.",
    },
    {
      q: "Which of the three can I self-host?",
      a: "Only RevenueDot. Its server and dashboard are open source under AGPL-3.0 and run with Docker and Postgres on your own servers. RevenueCat and Superwall are hosted services; only their SDKs are open source, and neither pricing page lists a self-host option.",
    },
    {
      q: "Which of the three has SOC 2?",
      a: "RevenueCat, which publishes a SOC 2 Type II report under NDA. Superwall's GDPR page names no SOC 2 report, and RevenueDot has no certification yet. If you self-host RevenueDot, your own controls apply.",
    },
    {
      q: "Do I have to change my app code to switch?",
      a: "To Superwall, yes: you replace the RevenueCat SDK with Superwall's. To RevenueDot, one line: set the SDK's proxy URL to `https://api.revenuedot.app` before `configure`, or use a RevenueDot SDK fork. Purchases, restores, offerings and CustomerInfo code stay as they are.",
    },
  ],
  checked: CHECKED,
  seeIt: ["paywalls", "experiments", "charts", "dual-run"],
  video: "https://www.youtube.com/watch?v=lkwX_kc0NS8",
  related: ["/cheaper-revenuecat-alternatives", "/compare/revenuecat-vs-superwall", "/compare/revenuedot-vs-revenuecat", "/compare/revenuedot-vs-superwall", "/revenuecat-alternatives", "/migrate-from-revenuecat"],
};

/** The fee table on /cheaper-revenuecat-alternatives: every vendor with a sourced price, at $10K, $100K and $1M a month. */
export const CHEAPER_FEES = priceTable(
  "",
  [COL_RC, COL_ADAPTY, COL_QONVERSION, COL_SUPERWALL, COL_APPHUD, COL_CLOUD, COL_SELF],
  [RC_PRICING, RC_STAFF, AD_PRICING, QO_PRICING, SW_PRICING, SW_FAQ, AP_PRICING],
  [E.rcPrice, E.rcStaff, E.adPrice, E.qoPrice, E.qoTotal, E.swIndie, E.swAttributed, E.apPlans, E.apOverage, E.rdPlans],
  THREE_LEVELS,
);

export const COMPARE: ComparePage[] = [
  VS_REVENUECAT,
  VS_ADAPTY,
  VS_QONVERSION,
  VS_SUPERWALL,
  VS_APPHUD,
  VERSUS_RC_ADAPTY,
  VERSUS_RC_SUPERWALL,
  VERSUS_RC_QONVERSION,
  VERSUS_RC_STRIPE,
  THREE_WAY_RC_SUPERWALL,
];

// ---- /revenuecat-alternative (singular): "RevenueCat alternative", "open source RevenueCat alternative", "self-hosted RevenueCat" ----
export const ALTERNATIVE_PAGE: {
  title: string;
  metaTitle: string;
  metaDescription: string;
  answer: string;
  points: { title: string; text: string }[];
  blocks: Block[];
  faq: Faq[];
} = {
  title: "The open-source, self-hostable RevenueCat alternative",
  metaTitle: "RevenueCat Alternative: Open Source and Self-Hosted",
  metaDescription: "The open-source RevenueCat alternative: RevenueDot works with the RevenueCat SDK, runs free on Cloud to $10K a month, and can be self-hosted. Sourced.",
  answer:
    "The best open-source RevenueCat alternative is RevenueDot. It is an AGPL-3.0 backend that the stock RevenueCat SDKs already talk to, so you change one URL and keep your app code. Use RevenueDot Cloud, free up to $10K a month, or self-host with Docker and Postgres. It has no SOC 2 report and no years of live traffic yet. For a hosted option with a different SDK, look at Adapty, Qonversion or Superwall.",
  points: [
    { title: "Keep the RevenueCat SDK", text: "Set one proxy URL. Offerings, purchases, restores and CustomerInfo code stays as it is, and so do your webhooks and REST calls." },
    { title: "Free on Cloud up to $10K a month", text: "RevenueCat charges 1% of all tracked revenue from $2,500. RevenueDot Cloud is free to $10K, with a cap of $999 a month above that." },
    { title: "Self-host with Docker and Postgres", text: "Run the AGPL-3.0 server on your own infrastructure. Receipts, customers and purchase history live in your own database, with no revenue share." },
    { title: "The features you pay RevenueCat for", text: "43 charts, paywalls with a visual editor, experiments, web checkout, 36 integrations, Refund Control and win-back, in one dashboard." },
  ],
  blocks: [
    {
      h2: "Why teams leave RevenueCat",
      paras: ["Three reasons come up again and again: the bill, who owns the data, and how hard it is to leave."],
      bullets: [
        "**The cost cliff.** RevenueCat is free to $2,500 monthly tracked revenue, then charges 1% of all of it, before the stores take their cut. That is $500 a month at $50,000 and $10,000 at $1,000,000. Its [pricing FAQ](https://www.revenuecat.com/pricing/) gives $25 for $2,500, and [a staff reply](https://community.revenuecat.com/general-questions-7/questions-about-pro-plan-payments-3618) confirms the 1% covers the whole amount.",
        "**Data ownership.** Your subscribers' purchase history sits in RevenueCat's hosted service. You can pull it through the REST API and [scheduled exports](https://www.revenuecat.com/docs/integrations/scheduled-data-exports), but it is not in a database you run. RevenueCat's [security page](https://www.revenuecat.com/security-and-compliance/) names no hosting region.",
        "**Lock-in.** The SDK, the entitlement model, the webhook shapes and your paywalls all point at one vendor. Adapty's [migration guide](https://adapty.io/docs/migration-from-revenuecat) notes that Google purchase tokens come from RevenueCat support, and that promotional entitlements and refund history do not move.",
      ],
      evidence: [E.rcPrice, E.rcStaff, E.rcGdpr, E.adLimits],
    },
    {
      h2: "How RevenueDot keeps the RevenueCat SDK",
      paras: [
        "RevenueDot is a server that answers the same API the RevenueCat SDKs call, so your app keeps the SDK and talks to a different host. The SDKs have a proxy URL setting built for this. RevenueDot also publishes hard forks of all ten SDKs that default to its host and verify its response signatures.",
      ],
      code: {
        title: "One line on iOS",
        label: "Swift",
        code: `// Before Purchases.configure
Purchases.proxyURL = URL(string: "https://api.revenuedot.app")!
Purchases.configure(withAPIKey: "appl_...")`,
      },
    },
    {
      h2: "Moving from RevenueCat takes an afternoon of setup and one release",
      label: "Migration",
      paras: ["The work is an import, a side-by-side run and a release. The app change is one line."],
      steps: [
        { name: "Import your project", text: "Create a free [Cloud account](" + SIGNUP + "), then run `npx revenuedot import --from-revenuecat` with a read-only RevenueCat secret key. It copies apps, SDK keys, products, offerings, customers and history. Use `--dry-run` first." },
        { name: "Run both side by side", text: "Point App Store and Google Play server notifications at RevenueDot, which forwards each one to RevenueCat so both stay current." },
        { name: "Ship the one-line change", text: "Set the proxy URL in your next release, watch the dashboard fill, and turn RevenueCat off when most active users have updated." },
      ],
      visual: "importer",
    },
    {
      h2: "What is different from RevenueCat",
      bullets: [
        "**Younger.** RevenueDot launched in 2026. RevenueCat has years of live traffic.",
        "**No SOC 2 yet.** RevenueCat publishes SOC 2 Type II. If you self-host RevenueDot, your own controls apply.",
        "**Newest stores not proven live.** RevenueDot supports the same stores, but its Paddle, Roku and Galaxy Store support has only run against copies of those stores' APIs.",
        "**Single-screen paywalls.** RevenueDot's paywall editor builds single-screen paywalls; multi-step flows are not built yet.",
      ],
    },
  ],
  faq: [
    {
      q: "What is the best open-source alternative to RevenueCat?",
      a: "RevenueDot. Its server and dashboard are AGPL-3.0, its SDK forks are MIT, and it works with the stock RevenueCat SDKs, so you keep your app code. It runs on RevenueDot Cloud, free up to $10,000 a month, or on your own servers. It is newer than RevenueCat and has no SOC 2 report yet.",
    },
    {
      q: "Can I self-host RevenueCat?",
      a: "No. RevenueCat's service runs only in RevenueCat's cloud; only its SDKs are open source. To self-host in-app purchase infrastructure that works with the RevenueCat SDK, run RevenueDot with Docker and Postgres on your own servers.",
    },
    {
      q: "Is there a free RevenueCat alternative?",
      a: "Yes. RevenueDot Cloud is free up to $10,000 of monthly tracked revenue, and self-hosting is free with no limit, under AGPL-3.0. Superwall also offers free subscription infrastructure and bills 1% only on revenue from its own paywalls above $10K a month.",
    },
    {
      q: "Do I have to change my app to leave RevenueCat?",
      a: "With RevenueDot, one line: set the SDK's proxy URL before `configure`. With the stock SDK you also turn off its response-signature check, or you use a RevenueDot SDK fork. With Adapty, Qonversion, Superwall or Apphud you replace the SDK and rewrite your purchase code.",
    },
    {
      q: "How do I migrate from RevenueCat without losing subscribers?",
      a: "Import your project with a read-only RevenueCat key, which copies customers, entitlements and history. Then point store notifications at RevenueDot, which forwards them to RevenueCat so both stay current, and ship the proxy change. Current access is imported, so no subscriber loses access on switch day.",
    },
    {
      q: "Is RevenueDot as reliable as RevenueCat?",
      a: "Not yet proven. RevenueCat has years of live purchase traffic and a SOC 2 Type II report. RevenueDot launched in 2026. Running both side by side during a migration lets you compare them before you switch.",
    },
  ],
};
