// /revenuecat-alternatives: the best RevenueCat alternatives in 2026. Rules: apps/site/CONTENT.md.
// Every fact about another vendor links a public source. Vendor facts checked October 2026.
import type { Alternative, Source } from "./types";

const src = (label: string, url: string): Source => ({ label, url });

export const ALTERNATIVES_INTRO: { answer: string; faq: { q: string; a: string }[]; checked: string } = {
  answer:
    "The best RevenueCat alternative depends on what you want to change. RevenueDot is best if you want open source, a hosted plan that is free until your app makes $10,000 a month, and to keep the RevenueCat SDK. Adapty and Qonversion are the closest hosted alternatives, with paywall builders and A/B tests. Superwall is best for paywall experiments and bills only on paywall revenue. Apphud suits small apps on flat plans. Building in-house suits one-platform apps with simple products.",
  faq: [
    {
      q: "What is the cheapest RevenueCat alternative?",
      a: "For most apps, RevenueDot: RevenueDot Cloud is free until your app makes $10,000 a month, then 0.5% of the revenue above that, never more than $999 a month. Superwall makes subscription infrastructure free and bills 1% only on paywall revenue above $10K. Qonversion is free to $7K, then 0.8% of all revenue. Adapty is free under $5K, then 1%. RevenueCat is free to $2,500, then 1% of all revenue.",
    },
    {
      q: "Is there an open-source alternative to RevenueCat?",
      a: "Yes. RevenueDot's server and dashboard are open source under AGPL-3.0, and it works with the RevenueCat SDKs. Adapty, Qonversion, Apphud and Superwall publish open-source SDKs on GitHub, but their backends are hosted services, not open source.",
    },
    {
      q: "Which RevenueCat alternative lets me keep the RevenueCat SDK?",
      a: "RevenueDot. It answers the API the RevenueCat SDKs call, so you set the SDK's proxy URL and keep your purchase code. Adapty, Qonversion, Superwall, Apphud and Purchasely each have their own SDK, so switching to them means replacing the SDK and rewriting purchase code.",
    },
    {
      q: "Is Glassfy still a RevenueCat alternative?",
      a: "No. Glassfy announced that its services would end in December 2024, so it is no longer an option. Qonversion and Adapty published migration guides for former Glassfy customers.",
    },
  ],
  checked: "October 2026",
};

export const ALTERNATIVES: Alternative[] = [
  {
    name: "RevenueDot",
    url: "https://revenuedot.app",
    bestFor: "Teams that want to keep the RevenueCat SDK and cap their bill at $999 a month.",
    summary:
      "An open-source backend for in-app purchases and subscriptions that implements the API the RevenueCat SDKs call. You change the SDK's proxy URL and keep your app code, then run it on RevenueDot Cloud. It includes 43 charts, paywalls with a visual editor, experiments, web checkout, 36 integrations, Refund Control and win-back.",
    pricing: "Pro is free until your app makes $10,000 a month in tracked revenue, then 0.5% of revenue above $10,000, capped at $999 a month.",
    openSource: "Yes. Server and dashboard are AGPL-3.0; SDK forks, CLI and MCP server are MIT.",
    selfHost: "Not needed: RevenueDot Cloud is hosted for you.",
    pros: [
      "Keeps the RevenueCat SDK, so switching is one URL and no purchase-code rewrite.",
      "Free until your app makes $10K a month in tracked revenue, then 0.5%, with a cap of $999 a month.",
      "Open source: the server and dashboard code is on GitHub under AGPL-3.0.",
      "Importer for RevenueCat projects and side-by-side forwarding of store notifications.",
    ],
    cons: [
      "New: launched in 2026, so it has far less production history than RevenueCat.",
      "No SOC 2 report yet.",
      "Fewer stores than RevenueCat (no Paddle or Samsung Galaxy Store) and single-screen paywalls only.",
    ],
    sources: [
      src("RevenueDot pricing", "https://revenuedot.app/pricing"),
      src("RevenueDot on GitHub", "https://github.com/revenuedot/revenuedot"),
    ],
    evidence: ["RevenueDot/github-revenuedot/license"],
    visual: "paywalls",
    clip: "charts",
    compare: "/compare/revenuedot-vs-revenuecat",
  },
  {
    name: "Adapty",
    url: "https://adapty.io",
    bestFor: "Growth teams that want a hosted paywall and flow builder with deep A/B testing and SOC 2 Type II.",
    summary:
      "A hosted subscription backend with a drag-and-drop flow and paywall builder, 50+ templates, an AI generator, A/B tests with unlimited variants, web payments through Stripe and Paddle, and revenue analytics. Open-source SDKs cover iOS, Android, React Native, Flutter, Unity and more.",
    pricing: "Free while you earn under $5K a month, then 1% of that month's revenue, counted before store fees. Add-ons cost extra: Refund Saver 0.2%, Ads Manager 3.5% of ad spend, Mail 20% revenue share, attribution $0.03 per attributed install. Enterprise is custom.",
    openSource: "SDKs only (MIT). The backend is a hosted service.",
    selfHost: "No self-host option is listed.",
    pros: [
      "Higher free tier than RevenueCat: $5K against $2,500.",
      "SOC 2 Type II, and US or EU data residency on Enterprise.",
      "Flow and paywall builder with an AI generator, and A/B tests with custom traffic splits.",
      "Documented migration from RevenueCat; Adapty says it typically takes a few days to a week.",
    ],
    cons: [
      "Its own SDK, so purchase code changes.",
      "1% applies to all of the month's revenue past $5K, plus add-on fees.",
      "Promotional entitlements and refund history do not migrate from RevenueCat.",
    ],
    sources: [
      src("Adapty pricing page", "https://adapty.io/pricing/"),
      src("Adapty security and compliance", "https://adapty.io/security-and-compliance/"),
      src("Adapty migration guide from RevenueCat", "https://adapty.io/docs/migration-from-revenuecat"),
      src("Adapty iOS SDK on GitHub (MIT)", "https://github.com/adaptyteam/AdaptySDK-iOS"),
    ],
    evidence: ["Adapty/home/hero", "Adapty/pricing/free-under-5k-then-1-percent", "Adapty/pricing/faq-migration"],
    compare: "/compare/revenuedot-vs-adapty",
  },
  {
    name: "Superwall",
    url: "https://superwall.com",
    bestFor: "Teams whose growth comes from paywall design and experiments, and who want free subscription infrastructure.",
    summary:
      "A paywall platform that also runs subscription infrastructure: entitlements, purchase APIs, webhooks and SQL access are free. It adds a paywall editor, template gallery, A/B testing, audiences, campaigns, App-to-Web Checkout with Stripe and an AI paywall builder. It supports the App Store, Google Play and Stripe.",
    pricing: "Infrastructure is free at any scale. The paywall product is free up to $10K a month of paywall-attributed revenue, then 1% of that revenue. Startup adds $49 a month and Scale $199. Enterprise is custom.",
    openSource: "SDKs only (MIT). The backend is a hosted service.",
    selfHost: "No self-host option is described.",
    pros: [
      "You are billed only on revenue that converts through its own paywalls.",
      "Deep paywall, experiment and campaign tools, with agent skills and an editor MCP server.",
      "App-to-Web Checkout moves US iOS users to Stripe and links the purchase back.",
    ],
    cons: [
      "Its own SDK, so purchase code changes.",
      "Says it does not support Amazon or Roku, run virtual-currency systems or track ad revenue.",
      "Its GDPR page names no SOC 2 report or hosting region.",
    ],
    sources: [
      src("Superwall pricing page", "https://superwall.com/pricing"),
      src("Superwall llms.txt (coverage and limits)", "https://superwall.com/llms.txt"),
      src("Superwall on its October 2025 pricing change", "https://superwall.com/blog/superwalls-new-pricing-more-aligned-generous-and-transparent"),
      src("Superwall iOS SDK on GitHub (MIT)", "https://github.com/superwall/Superwall-iOS"),
    ],
    evidence: ["Superwall/home/hero", "Superwall/pricing/indie-10k-then-1-percent", "Superwall/pricing/attributed-revenue-only"],
    compare: "/compare/revenuedot-vs-superwall",
  },
  {
    name: "Qonversion",
    url: "https://qonversion.io",
    bestFor: "Teams that want one hosted plan with every feature included and the lowest published percentage.",
    summary:
      "A hosted subscription backend with a no-code paywall builder, A/B experiments, LTV and cohort analytics, Refund Keeper, raw data export and an MCP server. It supports the App Store, Google Play, Stripe and Paddle, with unlimited apps and seats.",
    pricing: "Free up to $7K a month in tracked revenue, then 0.8% of all tracked revenue, not only the part above $7K. Enterprise is custom.",
    openSource: "SDKs only (MIT). The backend is a hosted service.",
    selfHost: "No self-host option is listed in its docs.",
    pros: [
      "Lowest published hosted rate, 0.8%, and a $7K free tier.",
      "Every feature in one plan, with unlimited apps and seats and 24/7 priority support.",
      "Written migration guide from RevenueCat; it says most apps finish in one to two days.",
    ],
    cons: [
      "Its own SDK, so purchase code changes.",
      "No Amazon Appstore in its docs, and no SOC 2 listed on its pricing page.",
      "The 0.8% has no ceiling, so $1,000,000 a month costs $8,000.",
    ],
    sources: [
      src("Qonversion pricing page", "https://qonversion.io/pricing"),
      src("Qonversion docs index", "https://documentation.qonversion.io/llms.txt"),
      src("Qonversion's RevenueCat comparison", "https://qonversion.io/revenuecat-alternative"),
      src("Qonversion iOS SDK on GitHub (MIT)", "https://github.com/qonversion/qonversion-ios-sdk"),
    ],
    evidence: ["Qonversion/home/hero", "Qonversion/pricing/free-to-7k-then-0-8-percent", "Qonversion/pricing/faq-total-tracked-revenue"],
    compare: "/compare/revenuedot-vs-qonversion",
  },
  {
    name: "Apphud",
    url: "https://apphud.com",
    bestFor: "Small apps that want flat monthly plans and no-code web funnels.",
    summary:
      "A hosted subscription backend with revenue analytics, experiments, rules, a visual screen builder, paywall screens from Figma designs, and no-code web funnels (Flows) paid through Stripe or Paddle. Data is stored in the EU and US.",
    pricing: "Free with $10K of monthly tracked revenue. Pro is $49 a month with $5K included, then $9.99 per extra $1,000. Expert is $59 with $5K included, then $11.99 per $1,000. Enterprise starts at $100K and is quoted.",
    openSource: "SDKs only (MIT). The backend is a hosted service.",
    selfHost: "No self-host option is listed.",
    pros: [
      "A free plan with $10K of tracked revenue, a higher limit than RevenueCat or Adapty.",
      "No-code web funnels with Stripe or Paddle, and a public MCP server.",
      "Data stored in the EU and US, according to its data protection page.",
    ],
    cons: [
      "Plan gating: server-to-server webhooks and daily exports need Expert.",
      "Past the free limit, renewals stop being tracked after a 7-day grace period.",
      "Its own SDK, and its data protection page lists no SOC 2.",
    ],
    sources: [
      src("Apphud pricing page", "https://apphud.com/pricing"),
      src("Apphud data protection page", "https://apphud.com/data-protection"),
      src("Apphud web payments docs", "https://docs.apphud.com/docs/web-payments"),
      src("Apphud iOS SDK on GitHub (MIT)", "https://github.com/apphud/ApphudSDK"),
    ],
    evidence: ["Apphud/home/hero", "Apphud/pricing/free-10k-pro-expert", "Apphud/pricing/overage-rates"],
    compare: "/compare/revenuedot-vs-apphud",
  },
  {
    name: "Purchasely",
    url: "https://www.purchasely.com",
    bestFor: "Larger consumer brands that want a sales-led paywall and lifecycle platform with SOC 2.",
    summary:
      "A hosted platform for paywalls, A/B tests, audience targeting and lifecycle campaigns, with receipt validation and entitlements handled for the App Store, Google Play and Stripe web funnels. SDKs cover iOS, Android, Flutter, React Native and Cordova.",
    pricing: "No public pricing. The site directs you to talk to sales.",
    openSource: "No open-source backend. The iOS SDK repository shows no recognized license on GitHub.",
    selfHost: "No self-host option is described.",
    pros: [
      "SOC 2 certified, according to its homepage.",
      "Screen Composer for paywalls, with A/B tests and segmentation, and no app release needed.",
      "Customers include Headspace, The Times, Busuu and PhotoRoom, according to its homepage.",
    ],
    cons: [
      "No published price and no free tier, which makes it hard to compare.",
      "Its own SDK, so purchase code changes.",
      "Sales-led, which suits larger teams more than indie developers.",
    ],
    sources: [
      src("Purchasely homepage", "https://www.purchasely.com/"),
      src("Purchasely /pricing (serves the homepage, no prices)", "https://www.purchasely.com/pricing"),
      src("Purchasely docs", "https://docs.purchasely.com/"),
      src("Purchasely iOS SDK on GitHub", "https://github.com/Purchasely/Purchasely-iOS"),
    ],
    evidence: ["Purchasely/home/hero", "Purchasely/pricing/no-public-price"],
  },
  {
    name: "IAPHUB",
    url: "https://www.iaphub.com",
    bestFor: "Small teams that want a low flat fee and web billing through Stripe.",
    summary:
      "A hosted in-app purchase service with SDKs for iOS, Android, React Native, Flutter and .NET, receipt validation, cross-platform sync, webhooks and Stripe web billing. Its SDKs are open source.",
    pricing: "Sandbox is free. Basic is $29 a month up to $10K a month of revenue. Pro is 0.7% of monthly tracked revenue with a $59 monthly minimum; the page offers 0.6% for Pro plans started before Nov 15, 2026.",
    openSource: "SDKs only (MIT). The backend is a hosted service.",
    selfHost: "No self-host option is listed.",
    pros: [
      "Low published rate, 0.6% to 0.7% on Pro, and a flat $29 entry plan.",
      "Web billing through Stripe and a full API on Pro.",
    ],
    cons: [
      "A smaller project: its iOS SDK repository has far fewer stars than the larger vendors' and was last updated in December 2025.",
      "Paid from the first real transaction: the free plan is sandbox only.",
      "We found no paywall builder or experiments on its homepage or pricing page.",
    ],
    sources: [
      src("IAPHUB homepage", "https://www.iaphub.com/"),
      src("IAPHUB pricing page", "https://www.iaphub.com/pricing"),
      src("IAPHUB iOS SDK on GitHub (MIT)", "https://github.com/iaphub/iaphub-ios-sdk"),
    ],
    evidence: ["IAPHUB/home/hero", "IAPHUB/pricing/plans"],
  },
  {
    name: "Nami ML",
    url: "https://www.nami.ml",
    bestFor: "Large consumer apps and connected-TV apps that want a sales-led paywall and experiment platform.",
    summary:
      "A hosted platform for no-code paywall pages, experiments, subscriber flows and insights, with integrations for StoreKit, Google Play and Stripe. SDKs cover Apple, Android, web, React Native and connected TV.",
    pricing: "Enterprise only, on custom annual contracts. No list prices and no free tier. Pricing depends on subscriber scale, surfaces and impression volume.",
    openSource: "No open-source backend is described.",
    selfHost: "No self-host option is described.",
    pros: [
      "Built for scale: it targets apps with 100K+ active subscribers.",
      "Covers iOS, Android, web and connected TV.",
      "Flat fees for seats, environments and integrations, per its pricing page.",
    ],
    cons: [
      "No free tier and no published price, so it does not suit indie developers.",
      "Annual contracts.",
    ],
    sources: [src("Nami ML pricing page", "https://www.nami.ml/pricing")],
    evidence: ["Nami ML/pricing/enterprise-only"],
  },
  {
    name: "Build it in-house (StoreKit 2, Play Billing and your own server)",
    url: "https://developer.apple.com/documentation/storekit/in-app_purchase",
    bestFor: "Apps with one platform, simple products and engineers who will maintain the billing code for years.",
    summary:
      "You use StoreKit 2 and Google Play Billing in the app and run your own server that verifies purchases, listens to App Store Server Notifications and Google's Real-time Developer Notifications, and keeps each user's entitlement in your database. Apple publishes an open-source App Store Server Library in Swift, Java, Python and Node.js to help.",
    pricing: "No vendor fee and no revenue share. You pay for engineering time and servers.",
    openSource: "Your code is yours. Apple's App Store Server Library is MIT.",
    selfHost: "Yes, by definition.",
    pros: [
      "No revenue share and full control of the data and the logic.",
      "No third party on the purchase path.",
    ],
    cons: [
      "You own every store edge case: Google expects purchases to be acknowledged within three days or it refunds them, and Apple recommends checking status with its server API as well as notifications.",
      "You build and maintain cross-platform identity, refunds, grace periods, analytics and paywalls yourself.",
      "Each store changes its billing APIs on its own schedule, and you must keep up.",
    ],
    sources: [
      src("Google Play Billing integration guide", "https://developer.android.com/google/play/billing/integrate"),
      src("Apple App Store Server Notifications", "https://developer.apple.com/documentation/appstoreservernotifications"),
      src("Apple App Store Server Library (Node.js)", "https://github.com/apple/app-store-server-library-node"),
      src("Apple StoreKit in-app purchase docs", "https://developer.apple.com/documentation/storekit/in-app_purchase"),
    ],
    evidence: ["Apple/storekit-in-app-purchase/overview", "Apple/app-store-server-notifications/overview", "Google/play-billing-integrate/guide"],
  },
];
