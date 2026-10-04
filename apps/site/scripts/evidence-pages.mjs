// Every vendor source URL cited in src/data/compare.ts and src/data/alternatives.ts, grouped by vendor, with the crop that
// proves each claim. crop: { claim, text (locator and verify string), verify?, alt, caption, selector?, pre?, minH?, maxH?,
// extraTop?, extraBottom? }. "click" lists FAQ questions to expand before the shot.
const p = (vendor, page, url, extra = {}) => ({ vendor, page, url, ...extra });
const c = (claim, text, alt, caption, extra = {}) => ({ claim, text, alt, caption, ...extra });

export const PAGES = [
  // ---- RevenueCat ------------------------------------------------------------------------------------------------
  p("revenuecat", "home", "https://www.revenuecat.com/", {
    crops: [
      c("hero", "Build and grow your app business", "RevenueCat homepage hero: the headline 'Build and grow your app business' with the Start for free button and the stats row.", "Homepage hero", { minH: 620, maxH: 1100 }),
      c("apps-and-revenue", "Revenue processed", "RevenueCat homepage stats: apps supported, API requests daily and revenue processed.", "The homepage cites 149K+ apps supported and $17B+ revenue processed", { verify: "$17B+", minH: 220, extraTop: 40 }),
      c("paywall-templates", "Launch faster with pre-built, configurable templates", "RevenueCat homepage section on paywalls: pre-built configurable templates and a layer-driven editor.", "Remotely configurable paywall editor with pre-built templates", { minH: 360 }),
      c("refund-handling", "Automate refund handling.", "RevenueCat homepage section 'Automate refund handling' describing automatic management of Apple refund requests.", "Automated Apple refund handling", { minH: 360 }),
    ],
  }),
  p("revenuecat", "pricing", "https://www.revenuecat.com/pricing/", {
    crops: [
      c("free-to-2500-then-1-percent", "Pay nothing for up to $2,500 in monthly tracked revenue", "RevenueCat pricing: the Pro card says 'Pay nothing for up to $2,500 in monthly tracked revenue. Then pay 1% of what you track once you hit $2,500 in MTR.'", "Free to $2,500 monthly tracked revenue, then 1% of what you track", { minH: 380, maxH: 800 }),
      c("growth-tools-1-percent", "Only pay 1% of MTR on what you track", "RevenueCat pricing: Growth Tools section with 'Only pay 1% of MTR on what you track'.", "Growth Tools charge 1% only on what they track", { minH: 420 }),
      c("features", "Dashboard and reporting for 40+ key", "RevenueCat pricing 'All features included' grid: paywall editor with pre-built templates, A/B testing, segmentation, 40+ metrics, REST API, webhooks and support forums.", "Paywall editor with templates, A/B testing, 40+ metrics and a REST API", { minH: 760, maxH: 1300 }),
      c("support", "Email and technical support forums", "RevenueCat pricing feature list line 'Email and technical support forums'.", "Email and technical support forums", { minH: 260 }),
      c("enterprise", "Custom SLAs for high-volume apps", "RevenueCat pricing Enterprise card: custom pricing, volume discounts, dedicated support and custom SLAs.", "Enterprise adds dedicated support and custom SLAs", { minH: 300 }),
    ],
  }),
  p("revenuecat", "security-and-compliance", "https://www.revenuecat.com/security-and-compliance/", {
    crops: [c("soc2", "audited annually by an independent CPA firm", "RevenueCat security page: SOC 2 Type II, audited annually, report available under NDA; GDPR and global privacy.", "SOC 2 Type II with the report under NDA, and GDPR", { verify: "SOC 2 Type II", minH: 400, extraTop: 60 })],
  }),
  p("revenuecat", "gdpr", "https://www.revenuecat.com/gdpr/", {
    crops: [c("processor", "RevenueCat is considered a", "RevenueCat GDPR page: RevenueCat is a processor of end-user data; no hosting region is named.", "GDPR processor; no hosting region named", { verify: "processor", minH: 320 })],
  }),
  p("revenuecat", "community-pro-plan-payments", "https://community.revenuecat.com/general-questions-7/questions-about-pro-plan-payments-3618", {
    crops: [c("staff-reply-1-percent-of-whole-mtr", "pricing will still be 1% of your whole MTR", "RevenueCat community thread: staff reply 'We won't start charging you until you hit 2500 in MTR, but pricing will still be 1% of your whole MTR, so $25.'", "Staff reply: 1% of the whole MTR once you reach $2,500", { minH: 520, extraTop: 160 })],
  }),
  p("revenuecat", "github-purchases-ios-license", "https://github.com/RevenueCat/purchases-ios/blob/main/LICENSE", {
    crops: [c("mit", "Permission is hereby granted", "GitHub file view of the purchases-ios LICENSE: MIT License text.", "The iOS SDK is MIT licensed", { verify: "MIT License", minH: 420, extraTop: 120 })],
  }),
  p("revenuecat", "docs-quickstart", "https://www.revenuecat.com/docs/getting-started/quickstart", {
    crops: [c("platforms", "Choose your mobile app platform", "RevenueCat SDK quickstart: install step with the platform tabs Swift, Obj-C, Kotlin, Kotlin MP, Java, Flutter, React Native, Capacitor, Cordova and Unity.", "SDKs for every mobile platform", { minH: 820, maxH: 1200 })],
  }),
  p("revenuecat", "docs-web-overview", "https://www.revenuecat.com/docs/web/overview", {
    crops: [c("stripe-paddle-billing", "Paddle Billing: Your Paddle Billing catalog", "RevenueCat Web docs overview: RevenueCat Billing (Stripe as gateway), Stripe Billing and Paddle Billing options.", "Web Billing with Stripe and Paddle", { minH: 300, extraTop: 140 })],
  }),
  p("revenuecat", "docs-web-stripe", "https://www.revenuecat.com/docs/web/integrations/stripe", {
    crops: [c("unlock-entitlements", "unlock entitlements on mobile", "RevenueCat Stripe Billing docs: sell Stripe products through hosted Web Purchase Links, the Web SDK, and unlock entitlements on mobile.", "Stripe Billing purchases unlock entitlements in the mobile app", { minH: 360, extraTop: 120 })],
  }),
  p("revenuecat", "docs-third-party-integrations", "https://www.revenuecat.com/docs/integrations/third-party-integrations", {
    crops: [c("categories", "Customer Engagement and Retention", "RevenueCat third-party integrations docs: categories for customer engagement, data and product analytics, with the integration list.", "Engagement and analytics integrations", { minH: 700, maxH: 1300, extraTop: 80 })],
  }),
  p("revenuecat", "docs-scheduled-data-exports", "https://www.revenuecat.com/docs/integrations/scheduled-data-exports", {
    crops: [c("destinations", "Azure Blob Storage", "RevenueCat scheduled data exports docs: CSV or Parquet files delivered to Amazon S3, Google Cloud Storage, Azure Blob Storage or email.", "Scheduled exports as CSV or Parquet to S3, GCS, Azure or email", { verify: "Parquet", minH: 360, extraTop: 220 })],
  }),
  p("revenuecat", "docs-customer-center", "https://www.revenuecat.com/docs/tools/customer-center", {
    crops: [c("self-service-ui", "Customer Center is a self-service UI", "RevenueCat Customer Center docs: a self-service UI added to the app, available on Pro and Enterprise plans.", "A no-code Customer Center", { minH: 320 })],
  }),
  p("revenuecat", "docs-llms-txt", "https://www.revenuecat.com/docs/llms.txt", {
    pre: true,
    crops: [c("virtual-currency", "virtual currency", "RevenueCat docs index (llms.txt): the Products & Offerings section covers offerings, product configuration and virtual currency.", "Virtual currency and offerings in the docs", { pre: true, minH: 300 })],
  }),
  p("revenuecat", "docs-platform-resources-llms-txt", "https://www.revenuecat.com/docs/platform-resources/llms.txt", {
    pre: true,
    crops: [c("amazon-galaxy", "Connect the Galaxy Store to RevenueCat", "RevenueCat platform resources index: Amazon Platform Resources and Galaxy Store setup pages.", "Amazon Appstore and Samsung Galaxy Store support", { pre: true, verify: "Amazon Platform Resources", minH: 360, extraTop: 320 })],
  }),
  p("revenuecat", "docs-ai-toolkit", "https://www.revenuecat.com/docs/tools/ai-toolkit", {
    crops: [c("toolkit", "Plugins, skills, an MCP server, and a CLI", "RevenueCat AI toolkit docs: plugins, skills, an MCP server and a CLI for coding agents.", "An AI toolkit with plugins, skills, an MCP server and a CLI", { minH: 460 })],
  }),

  // ---- Adapty ---------------------------------------------------------------------------------------------------
  p("adapty", "home", "https://adapty.io/", {
    crops: [c("hero", "Scale your app business. Run subscriptions", "Adapty homepage hero: 'RevenueOS for subscription apps' with Book a demo and Start for free buttons.", "Homepage hero", { minH: 620, maxH: 1100, extraTop: 120 })],
  }),
  p("adapty", "pricing", "https://adapty.io/pricing/", {
    click: ["What counts toward my monthly revenue?", "When do I start paying the 1%?", "How hard is it to migrate from another provider"],
    crops: [
      c("free-under-5k-then-1-percent", "Of monthly revenue after you pass", "Adapty pricing plan cards: Pro is free while you earn under $5K/month, then 1% of monthly revenue after you pass $5K/month; Enterprise is custom pricing.", "Free under $5K a month, then 1% of monthly revenue", { verify: "$5K/month", minH: 400, maxH: 900 }),
      c("add-ons", "3.5%", "Adapty pricing add-ons: Refund Saver 0.2%, Ads Manager 3.5% of ad spend, Mail 20%, payout acceleration 2.5% and attribution $0.03 per install, each free up to $5K.", "Add-on fees: Refund Saver 0.2%, Ads Manager 3.5%, Mail 20%, attribution $0.03", { verify: "0.2%", minH: 520, maxH: 1100 }),
      c("templates-and-ab-tests", "custom traffic splits, unlimited variants", "Adapty pricing feature list: 50+ templates and AI generator, A/B tests with custom traffic splits, unlimited variants and early winner predictions.", "A/B tests with unlimited variants; 50+ templates", { minH: 420, extraTop: 160 }),
      c("soc2-and-residency", "Data residency in the US or EU", "Adapty pricing Enterprise section: 24/7 support in a dedicated Slack channel, data residency in the US or EU, SOC2 certified.", "US or EU data residency on Enterprise; SOC 2", { minH: 360, extraTop: 120 }),
      c("faq-what-counts", "What counts toward my monthly revenue?", "Adapty pricing FAQ, expanded: what counts toward monthly revenue and when the 1% starts.", "Revenue is counted before store fees; the 1% starts after $5K", { minH: 420, extraBottom: 200 }),
      c("faq-migration", "How hard is it to migrate from another provider", "Adapty pricing FAQ, expanded: how hard it is to migrate from RevenueCat, Superwall or in-house.", "What Adapty says about migrating from RevenueCat", { minH: 320, extraBottom: 160 }),
    ],
  }),
  p("adapty", "security-and-compliance", "https://adapty.io/security-and-compliance/", {
    crops: [c("soc2-type-ii", "An independent CPA firm examines our security", "Adapty security and compliance page: SOC 2 Type II attestation with the report available under NDA, and GDPR (EU and UK).", "SOC 2 Type II and GDPR", { verify: "SOC 2 Type II", minH: 360, extraTop: 80 })],
  }),
  p("adapty", "docs-migration-from-revenuecat", "https://adapty.io/docs/migration-from-revenuecat", {
    crops: [c("limits", "Refund and billing-issue history isn", "Adapty migration guide from RevenueCat: promotional or manually granted entitlements import as profiles without transactions; refund and billing-issue history is not carried over verbatim.", "Promotional entitlements and refund history do not come across", { verify: "promotional", minH: 320, extraTop: 120 })],
  }),
  p("adapty", "docs-llms-txt", "https://adapty.io/docs/llms.txt", {
    pre: true,
    crops: [c("stripe-paddle", "Validate Paddle purchase", "Adapty docs index: API operations for validating Stripe and Paddle purchases.", "Web payments through Stripe and Paddle", { pre: true, verify: "Paddle", minH: 320, extraTop: 160 })],
  }),
  p("adapty", "github-adaptysdk-ios", "https://github.com/adaptyteam/AdaptySDK-iOS", {
    crops: [c("mit-license", "Adapty is available under the MIT license", "GitHub README of AdaptySDK-iOS: 'Adapty is available under the MIT license.'", "The iOS SDK is MIT licensed", { minH: 280 })],
  }),
  p("adapty", "blog-new-pricing-2026", "https://adapty.io/blog/adapty-new-pricing-2026/", {
    crops: [c("free-to-5000", "Starting today, Adapty is free until you hit $5,000", "Adapty blog post on its 2026 pricing: free until $5,000 in monthly tracked revenue, then 1% of revenue; Pro and Enterprise plans.", "Free to $5,000 a month, then 1% of revenue", { minH: 360, extraTop: 100 })],
  }),

  // ---- Qonversion -----------------------------------------------------------------------------------------------
  p("qonversion", "home", "https://qonversion.io/", {
    crops: [c("hero", "Skip the drama", "Qonversion homepage hero: 'Ship subscriptions. Skip the drama.' with Start Free and Contact Sales.", "Homepage hero", { minH: 620, maxH: 1100, extraTop: 100 })],
  }),
  p("qonversion", "pricing", "https://qonversion.io/pricing", {
    crops: [
      c("free-to-7k-then-0-8-percent", "Pro is 0.8% of tracked revenue", "Qonversion pricing headline: 'Pro is 0.8% of tracked revenue — and you pay nothing until you pass $7K MTR.'", "Free to $7K MTR, then 0.8% of tracked revenue", { minH: 380, maxH: 900 }),
      c("faq-total-tracked-revenue", "Your bill becomes 0.8% of your total tracked revenue", "Qonversion pricing FAQ: 'Your bill becomes 0.8% of your total tracked revenue — not just the amount above $7K. At $8K MTR that's $64 a month; at $50K it's $400.'", "0.8% of all tracked revenue, not only the part above $7K", { minH: 300, extraTop: 80 }),
      c("plan-includes", "Unlimited apps & seats", "Qonversion pricing Pro plan list: all analytics with LTV and cohorts, Refund Keeper, unlimited apps and seats; Enterprise with an uptime SLA.", "One Pro plan with every feature, unlimited apps and seats; Refund Keeper included", { minH: 460, extraTop: 200 }),
      c("compliance-and-support", "CCPA Compliance", "Qonversion pricing feature table: GDPR compliance, CCPA compliance, 24/7 priority support, unlimited seats, apps and projects.", "GDPR and CCPA listed; 24/7 priority support; no SOC 2 listed", { minH: 360, extraTop: 160 }),
    ],
  }),
  p("qonversion", "docs-llms-txt", "https://documentation.qonversion.io/llms.txt", {
    pre: true,
    crops: [c("sdks-and-stores", "Install the Qonversion SDK for iOS, Android, Flutter", "Qonversion docs index: SDKs for iOS, Android, Flutter, React Native, Unity, Cordova, Capacitor, Web and macOS; products map Apple, Google, Stripe or Paddle.", "SDKs for nine platforms; App Store, Google Play, Stripe and Paddle", { pre: true, minH: 520, extraBottom: 200 })],
  }),
  p("qonversion", "docs-stripe-integration", "https://documentation.qonversion.io/docs/stripe-integration", {
    crops: [c("stripe", "Qonversion supports Stripe web payments", "Qonversion Stripe integration docs: connect a Stripe account to manage cross-platform subscribers and track web payments.", "Stripe web payments", { minH: 320, extraTop: 120 })],
  }),
  p("qonversion", "docs-mcp-server", "https://documentation.qonversion.io/docs/mcp-server", {
    crops: [c("mcp-server", "Qonversion provides a remote MCP server", "Qonversion MCP server docs: a remote MCP server at mcp.qonversion.io that lets AI assistants access project data, in beta.", "An MCP server for project data", { minH: 360, extraTop: 120 })],
  }),
  p("qonversion", "docs-migrating-from-revenuecat", "https://documentation.qonversion.io/docs/migrating-from-revenuecat-to-qonversion", {
    crops: [c("guide", "Migrating from RevenueCat", "Qonversion docs: the written guide 'Migrating from RevenueCat'.", "A written guide for moving from RevenueCat", { selector: "h1", minH: 480 })],
  }),
  p("qonversion", "github-qonversion-ios-sdk", "https://github.com/qonversion/qonversion-ios-sdk", {
    crops: [c("mit-license", "Qonversion SDK is available under the MIT license", "GitHub README of qonversion-ios-sdk: 'Qonversion SDK is available under the MIT license.'", "The iOS SDK is MIT licensed", { minH: 280 })],
  }),
  p("qonversion", "revenuecat-alternative", "https://qonversion.io/revenuecat-alternative", {
    crops: [c("free-tier-comparison", "Free tier up to $7K MTR", "Qonversion's RevenueCat comparison page: free tier up to $7K MTR, then 0.8% of tracked revenue versus RevenueCat's 1%.", "$7K free tier and 0.8% versus RevenueCat's $2.5K and 1%", { minH: 420, maxH: 900 })],
  }),

  // ---- Superwall ------------------------------------------------------------------------------------------------
  p("superwall", "home", "https://superwall.com/", {
    crops: [c("hero", "Grow your revenue with world class monetization", "Superwall homepage hero: 'AI powered monetization stack for mobile apps' with the annual revenue, paywall views and customer stats.", "Homepage hero", { minH: 620, maxH: 1100, extraTop: 160 })],
  }),
  p("superwall", "pricing", "https://superwall.com/pricing", {
    crops: [
      c("infrastructure-free", "Subscription infrastructure, free at any scale", "Superwall pricing headline: subscription infrastructure (entitlements, purchase APIs, webhooks, SQL access) is free on every plan; only the paywall product is billed.", "Infrastructure free at any scale; only paywall revenue is billed", { minH: 300, maxH: 700 }),
      c("indie-10k-then-1-percent", "Up to $10k MAR, then 1% of total MAR", "Superwall pricing plan cards: Indie free up to $10k MAR then 1% of total MAR; Startup $49 a month + 1% of MAR; Scale $199 a month + 1% of MAR; Enterprise.", "Indie free to $10K MAR, then 1%; Startup $49 and Scale $199 a month", { minH: 700, maxH: 1300 }),
      c("attributed-revenue-only", "Subscriptions purchased outside Superwall are free", "Superwall pricing: 1% of revenue, paywall-attributed only; subscriptions purchased outside Superwall are free; no per-event or webhook fees.", "Billed only on paywall-attributed revenue", { minH: 360, extraTop: 160 }),
      c("sql-query-api", "Row-level-security-protected SQL access", "Superwall pricing: the Query API gives SQL access to subscription data, included on every plan.", "Row-level SQL access on the Query API", { minH: 300, extraTop: 80 }),
      c("migration-agent", "A coding agent performs the SDK swap", "Superwall pricing: a coding agent performs the SDK swap, history port, entitlement port and webhook configuration in under an hour.", "An automated agent ports an app from RevenueCat in under an hour", { minH: 300, extraTop: 80 }),
    ],
  }),
  p("superwall", "docs-pricing-faq", "https://superwall.com/docs/support/faq/2801653905-how-does-superwalls-pricing-work", {
    crops: [c("mar-definition", "MAR is Monthly Attributed Revenue", "Superwall pricing FAQ: new MAR-based pricing with Indie $0, Startup $49, Scale $199; under $10k MAR is free; MAR is only revenue attributed to a Superwall paywall.", "MAR is only revenue attributed to a Superwall paywall", { minH: 520, extraTop: 360 })],
  }),
  p("superwall", "blog-new-pricing", "https://superwall.com/blog/superwalls-new-pricing-more-aligned-generous-and-transparent", {
    crops: [
      c("date", "October 29, 2025", "Superwall blog post header dated October 29, 2025 announcing the new pricing.", "The pricing change was announced on October 29, 2025", { minH: 300, extraTop: 60 }),
      c("indie-free-to-10k", "Once you cross $10K MAR, we take a 1% fee on total MAR", "Superwall blog: the Indie plan is 100% free up to $10K in Monthly Attributed Revenue; past $10K MAR the fee is 1% on total MAR.", "Free to $10K MAR, then 1% of total MAR", { minH: 320, extraTop: 160 }),
    ],
  }),
  p("superwall", "llms-txt", "https://superwall.com/llms.txt", {
    pre: true,
    crops: [
      c("coverage-and-limits", "does not run virtual-currency", "Superwall llms.txt: coverage is the App Store, Google Play and Stripe; SDKs for iOS, Android, React Native, Flutter, Expo, Unity and Web; it does not run virtual currency, does not track ad revenue, and does not support Amazon or Roku.", "No virtual currency, no ad revenue, no Amazon or Roku", { pre: true, minH: 420, extraTop: 160 }),
      c("editor-mcp", "an editor MCP server for building live paywalls", "Superwall llms.txt: agent tooling with open-source skills, an editor MCP server and SQL access via the Query API.", "An editor MCP server for coding agents", { pre: true, minH: 240 }),
    ],
  }),
  p("superwall", "features-app-to-web-checkout", "https://superwall.com/features/app-to-web-checkout", {
    crops: [c("stripe-checkout", "Send U.S. iOS users from your paywall to a Stripe checkout", "Superwall App-to-Web Checkout page: a paywall button opens a Stripe checkout in Safari and links the purchase back to the app.", "App-to-Web Checkout with Stripe", { minH: 400, extraTop: 120 })],
  }),
  p("superwall", "legal-gdpr", "https://superwall.com/legal/gdpr", {
    crops: [c("processor", "Superwall is considered a", "Superwall GDPR page: Superwall is a processor; it links a Data Processing Addendum; no SOC 2 report or hosting region is named.", "GDPR processor with a DPA; no SOC 2 or hosting region named", { verify: "processor", minH: 360, extraTop: 60 })],
  }),
  p("superwall", "github-superwall-ios", "https://github.com/superwall/Superwall-iOS", {
    crops: [c("mit-license", "MIT license", "GitHub repository page of Superwall-iOS with the MIT license shown in the About sidebar.", "The iOS SDK is MIT licensed", { minH: 420 })],
  }),

  // ---- Apphud ---------------------------------------------------------------------------------------------------
  p("apphud", "home", "https://apphud.com/", {
    crops: [c("hero", "Skyrocket your app growth", "Apphud homepage hero: 'Skyrocket your app growth with a revenue data suite' for iOS and Android.", "Homepage hero", { minH: 620, maxH: 1100, extraTop: 80 })],
  }),
  p("apphud", "pricing", "https://apphud.com/pricing", {
    crops: [
      c("free-10k-pro-expert", "$10,000 MTR included", "Apphud pricing plan cards: Free with $10,000 MTR included and 1 seat; Pro with $5,000 MTR included and 5 seats; Expert with $5,000 MTR included and 10 seats.", "Free with $10K MTR; Pro and Expert include $5K", { minH: 760, maxH: 1300 }),
      c("overage-rates", "$9.99 per additional $1,000 MTR on Pro plan", "Apphud pricing FAQ: $9.99 per additional $1,000 MTR on Pro, $11.99 on Expert; MTR is revenue in USD before Apple's cut and sandbox purchases are not counted.", "$9.99 per extra $1,000 on Pro, $11.99 on Expert", { verify: "$11.99", minH: 320, extraTop: 160 }),
      c("grace-period", "After grace period is over we will still handle IAP purchases", "Apphud pricing FAQ on a Free plan over $10,000: a 7-day grace period, then purchases are handled but renewals are not tracked and dashboard access ends.", "Over the free limit: 7-day grace period, then renewals stop being tracked", { minH: 300, extraTop: 120 }),
      c("seats-and-webhooks", "Server-to-server webhooks", "Apphud pricing feature table: server-to-server webhooks, on-demand raw data exports and seats (1, 5, 10) per plan.", "Webhooks and exports on Expert and above; 1, 5 or 10 seats", { verify: "10 seats", minH: 420, extraTop: 160, extraBottom: 160 }),
    ],
  }),
  p("apphud", "data-protection", "https://apphud.com/data-protection", {
    crops: [c("eu-and-us", "located in EU and US", "Apphud data protection page: data is stored in infrastructure located in the EU and US.", "Data stored in the EU and US", { minH: 300, extraTop: 80 })],
  }),
  p("apphud", "docs-web-payments", "https://docs.apphud.com/docs/web-payments", {
    crops: [c("stripe-paddle", "Connect Stripe or Paddle to accept web payments", "Apphud web payments docs: connect Stripe or Paddle to accept web payments in Apphud Flows.", "Web payments through Stripe or Paddle", { minH: 400, extraTop: 60 })],
  }),
  p("apphud", "docs-llms-txt", "https://docs.apphud.com/llms.txt", {
    pre: true,
    crops: [c("web-payments-and-s3", "Connect Stripe or Paddle to accept web payments in your Apphud Flows", "Apphud docs index: Amazon S3 export and web payments through Stripe or Paddle for Flows.", "Stripe and Paddle for Flows; Amazon S3 export", { pre: true, verify: "Amazon S3", minH: 360, extraTop: 220 })],
  }),
  p("apphud", "docs-mcp", "https://docs.apphud.com/docs/mcp", {
    crops: [c("public-mcp", "Apphud exposes a public MCP server", "Apphud docs: a public MCP server lets AI assistants read analytics, inspect customers and manage paywalls.", "A public MCP server", { minH: 320, extraTop: 100 })],
  }),
  p("apphud", "github-apphudsdk", "https://github.com/apphud/ApphudSDK", {
    crops: [c("mit-license", "MIT license", "GitHub repository page of ApphudSDK with the MIT license shown in the About sidebar.", "The iOS SDK is MIT licensed", { minH: 420 })],
  }),

  // ---- Stripe ---------------------------------------------------------------------------------------------------
  p("stripe", "pricing", "https://stripe.com/pricing", {
    crops: [
      c("card-fee", "2.9% + 30¢", "Stripe pricing: 2.9% + 30¢ per successful card charge.", "2.9% + 30¢ per successful US card charge", { minH: 420, maxH: 900 }),
      c("international-cards", "for international cards", "Stripe pricing: an additional 1.5% for international cards.", "1.5% more for international cards", { verify: "1.5%", minH: 300, extraTop: 120 }),
    ],
  }),
  p("stripe", "billing-pricing", "https://stripe.com/billing/pricing", {
    crops: [c("0-7-percent", "of Billing volume", "Stripe Billing pricing: 0.7% of Billing volume on the pay-as-you-go plan.", "Stripe Billing costs 0.7% of volume", { verify: "0.7%", minH: 400, extraTop: 160 })],
  }),
  p("stripe", "docs-checkout-quickstart", "https://docs.stripe.com/checkout/quickstart", {
    crops: [c("hosted-page", "get redirected to a payment page hosted by Stripe", "Stripe Checkout quickstart: customers are redirected to a prebuilt payment page hosted by Stripe.", "Checkout is a Stripe-hosted payment page", { minH: 360, extraTop: 120 })],
  }),
  p("stripe", "docs-billing-analytics", "https://docs.stripe.com/billing/subscriptions/analytics", {
    crops: [c("mrr-churn", "Stripe Billing analytics and downloadable reports", "Stripe Billing analytics docs: MRR, churn and active subscriber metrics for Stripe subscriptions, with downloadable reports.", "Billing analytics for Stripe subscriptions only", { verify: "MRR", minH: 520 })],
  }),

  // ---- Apple ----------------------------------------------------------------------------------------------------
  p("apple", "app-review-guidelines", "https://developer.apple.com/app-store/review/guidelines/", {
    crops: [c("3-1-1-in-app-purchase", "3.1.1 In-App Purchase:", "Apple App Review Guidelines 3.1.1: apps that unlock features or functionality must use in-app purchase.", "Guideline 3.1.1 requires in-app purchase for digital unlocks", { minH: 360, extraBottom: 120 })],
  }),
  p("apple", "subscriptions", "https://developer.apple.com/app-store/subscriptions/", {
    crops: [
      c("85-percent-after-one-year", "85% net revenue after one year", "Apple auto-renewable subscriptions page: 70% in the first year, then 85% after one year of paid service.", "70% in year one, 85% after one year", { minH: 360, extraBottom: 100 }),
      c("small-business-program", "App Store Small Business Program, you receive 85%", "Apple subscriptions page: Small Business Program members receive 85% of the subscription price at each billing cycle.", "85% (a 15% fee) under the Small Business Program", { minH: 260, extraTop: 60 }),
    ],
  }),
  p("apple", "storekit-in-app-purchase", "https://developer.apple.com/documentation/storekit/in-app_purchase", {
    crops: [c("overview", "With the Apple In-App Purchase API, you can offer customers", "Apple StoreKit In-App Purchase documentation overview.", "StoreKit in-app purchase docs", { minH: 400, extraTop: 160 })],
  }),
  p("apple", "app-store-server-notifications", "https://developer.apple.com/documentation/appstoreservernotifications", {
    crops: [c("overview", "App Store Server Notifications is a server-to-server service", "Apple App Store Server Notifications documentation: a server-to-server service sending real-time notifications for in-app purchase events.", "App Store Server Notifications", { minH: 400, extraTop: 160 })],
  }),
  p("apple", "github-app-store-server-library-node", "https://github.com/apple/app-store-server-library-node", {
    crops: [c("readme", "The Node.js server library for the App Store Server API", "GitHub README of Apple's app-store-server-library-node.", "Apple's App Store Server Library for Node.js", { minH: 360, extraTop: 80 })],
  }),

  // ---- Google ---------------------------------------------------------------------------------------------------
  p("google", "play-service-fees", "https://support.google.com/googleplay/android-developer/answer/112622?hl=en", {
    crops: [c("service-fees", "15% for automatically renewing subscription products", "Google Play service fees help page: 15% for the first $1M of revenue a year, 30% above that, and 15% for automatically renewing subscriptions regardless of revenue.", "Google Play charges 15% on subscriptions", { minH: 420, extraTop: 220 })],
  }),
  p("google", "play-payments-policy", "https://support.google.com/googleplay/android-developer/answer/9858738", {
    crops: [c("billing-system", "must use Google Play's billing system as the method of payment", "Google Play Payments policy: apps charging for in-app features, digital content or goods must use Google Play's billing system.", "Digital purchases must use Google Play's billing system", { minH: 460, extraBottom: 160 })],
  }),
  p("google", "play-billing-integrate", "https://developer.android.com/google/play/billing/integrate", {
    crops: [c("guide", "This document describes how to integrate the Google Play Billing Library", "Google Play Billing Library integration guide: how to integrate the library to start selling products.", "Play Billing Library integration guide", { minH: 480, extraTop: 140 })],
  }),

  // ---- Purchasely -----------------------------------------------------------------------------------------------
  p("purchasely", "home", "https://www.purchasely.com/", { crops: [c("hero", "Purchasely", "Purchasely homepage hero: 'Turn app users into subscribers' with a Talk to sales button.", "Homepage hero", { selector: "h1", minH: 620, maxH: 1100, extraTop: 120 })] }),
  p("purchasely", "pricing", "https://www.purchasely.com/pricing", { crops: [c("no-public-price", "Talk to sales", "Purchasely /pricing serves the homepage: 'Turn app users into subscribers' with a Talk to sales button and no prices.", "No public pricing; the page directs to sales", { selector: "h1", minH: 620, maxH: 1100, extraTop: 120 })] }),
  p("purchasely", "docs", "https://docs.purchasely.com/", { crops: [c("docs-home", "Purchasely", "Purchasely documentation home page.", "Purchasely docs", { selector: "h1", minH: 520 })] }),
  p("purchasely", "github-purchasely-ios", "https://github.com/Purchasely/Purchasely-iOS", { crops: [c("about", "About", "GitHub repository page of Purchasely-iOS; the About sidebar shows no recognized license.", "No recognized license on GitHub", { selector: "h2:has-text('About')", minH: 480, extraBottom: 100 })] }),

  // ---- IAPHUB ---------------------------------------------------------------------------------------------------
  p("iaphub", "home", "https://www.iaphub.com/", { crops: [c("hero", "IAPHUB", "IAPHUB homepage hero.", "Homepage hero", { selector: "h1", minH: 620, maxH: 1100, extraTop: 120 })] }),
  p("iaphub", "pricing", "https://www.iaphub.com/pricing", { crops: [c("plans", "of MTR (min $59/month)", "IAPHUB pricing plans: Sandbox free, Basic $29 a month until $10k/month, Pro 0.7% of MTR with a $59 monthly minimum (0.6% promotional rate before Nov 15, 2026).", "Basic $29 a month; Pro 0.7% with a $59 minimum", { verify: "0.7%", minH: 700, maxH: 1300 })] }),
  p("iaphub", "github-iaphub-ios-sdk", "https://github.com/iaphub/iaphub-ios-sdk", { crops: [c("mit-license", "MIT license", "GitHub repository page of iaphub-ios-sdk with the MIT license in the About sidebar.", "The iOS SDK is MIT licensed", { minH: 420 })] }),

  // ---- Nami ML --------------------------------------------------------------------------------------------------
  p("nami", "pricing", "https://www.nami.ml/pricing", { crops: [c("enterprise-only", "Annual, shaped to your volume and surfaces", "Nami ML pricing page: 'Enterprise pricing', a single Custom plan priced annually by volume and surfaces, with Book a demo and Talk to sales.", "Enterprise only, custom annual contracts, no list price", { verify: "Custom", minH: 620, maxH: 1100, extraTop: 320 })] }),

  // ---- RevenueDot (our own pages cited on the alternatives list) --------------------------------------------------
  p("revenuedot", "pricing", "https://revenuedot.app/pricing", { crops: [c("plans", "$999", "RevenueDot pricing: Cloud Free up to $10,000 a month, Cloud Standard 0.5% above $10,000 capped at $999 a month, self-hosting free.", "Cloud free to $10K; Standard 0.5% capped at $999; self-host free", { verify: "0.5%", minH: 700, maxH: 1300 })] }),
  p("revenuedot", "github-revenuedot", "https://github.com/revenuedot/revenuedot", { crops: [c("license", "AGPL-3.0", "GitHub repository page of revenuedot/revenuedot with the AGPL-3.0 license in the About sidebar.", "Server and dashboard under AGPL-3.0", { minH: 420 })] }),
];
