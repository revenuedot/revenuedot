import { DATAFAST } from "./datafast";

// Site-wide constants. Change a fact here and every page, JSON-LD block and llms.txt follows.
export const SITE = {
  name: "RevenueDot",
  url: "https://revenuedot.app",
  tagline: "In-app purchases and subscriptions for every app",
  description:
    "RevenueDot is an open-source backend for in-app purchases and subscriptions on the App Store, Google Play, Amazon, Stripe and the web. It checks every purchase, keeps each customer's access in sync and runs your paywalls and revenue charts. Start free on RevenueDot Cloud. Apps on RevenueCat switch by changing one line.",
  github: "https://github.com/revenuedot/revenuedot",
  org: "https://github.com/revenuedot",
  docs: "https://github.com/revenuedot/docs",
  docsBlog: "https://github.com/revenuedot/docs/tree/main/blog",
  examples: "https://github.com/revenuedot/examples",
  mcp: "https://github.com/revenuedot/mcp",
  skills: "https://github.com/revenuedot/agent-skills",
  apiHost: "https://api.revenuedot.app",
  // RevenueDot Cloud: where people sign up and sign in. Every page's main call to action points here.
  app: "https://app.revenuedot.app",
  signup: "https://app.revenuedot.app/signup",
  // Kai's Google Calendar booking page (kai@circo.so, "RevenueDot: 30 min with Kai", weekdays 9 to 5 Pacific, Google Meet).
  booking: "https://calendar.google.com/calendar/appointments/schedules/AcZssZ0IxzgwYNVDGggPF9qelyDSh51L5UzFNcrDE2u3eMTwqpLfGsrRxjx2TxY-WyehZVX1ns8MhQWg",
  login: "https://app.revenuedot.app/login",
  // The ElevenLabs voice agent's Twilio number (worker/agent.ts). It answers any time and passes messages to sales.
  phone: { display: "+1 (628) 296-1014", tel: "+16282961014" },
  email: {
    hello: "hello@revenuedot.app",
    sales: "sales@revenuedot.app",
    security: "security@revenuedot.app",
    legal: "legal@revenuedot.app",
  },
  ogImage: "/og.png",
  ogImageAlt: "RevenueDot: in-app purchases and subscriptions for every app",
  // Cookieless Cloudflare Web Analytics. Set PUBLIC_CF_WEB_ANALYTICS_TOKEN at build time to turn it on; unset = no beacon.
  analyticsToken: (import.meta.env.PUBLIC_CF_WEB_ANALYTICS_TOKEN as string | undefined) || "",
  datafast: DATAFAST,
  // Date competitor prices were last checked against their public pricing pages.
  pricesChecked: "October 2026",
} as const;

// Main navigation: what RevenueDot is (features, solutions by case), what it costs, how to build with it. Switching
// from RevenueCat is one solution among several, reached from Solutions, the home page and the footer.
export const NAV = [
  { href: "/features", label: "Features" },
  { href: "/solutions", label: "Solutions" },
  { href: "/sdks", label: "SDKs" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
  { href: "/migrate-from-revenuecat", label: "Switch from RevenueCat" },
] as const;

export const FOOTER = [
  {
    title: "Product",
    links: [
      { href: "https://app.revenuedot.app/signup", label: "Start free on Cloud" },
      { href: "https://app.revenuedot.app/login", label: "Sign in" },
      { href: "/features", label: "Features" },
      { href: "/features/paywalls", label: "Paywalls" },
      { href: "/features/web-billing", label: "Web checkout" },
      { href: "/charts", label: "Subscription charts" },
      { href: "/integrations", label: "Integrations" },
      { href: "/tools", label: "Free tools" },
      { href: "/glossary", label: "Glossary" },
      { href: "/pricing", label: "Pricing" },
      { href: "/contact-sales", label: "Contact sales" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Start",
    links: [
      { href: "/add-in-app-purchases", label: "Add in-app purchases" },
      { href: "/solutions/existing-apps", label: "Move your own purchase code" },
      { href: "/migrate-from-revenuecat", label: "Switch from RevenueCat" },
      { href: "/solutions/ai-built-apps", label: "Build with an AI coding tool" },
      { href: "/solutions/web-to-app", label: "Sell on the web" },
      { href: "/solutions", label: "All solutions" },
    ],
  },
  {
    title: "Compare",
    links: [
      { href: "/revenuecat-alternative", label: "RevenueCat alternative" },
      { href: "/revenuecat-alternatives", label: "RevenueCat alternatives" },
      { href: "/compare/revenuedot-vs-revenuecat", label: "RevenueDot vs RevenueCat" },
      { href: "/compare/revenuedot-vs-adapty", label: "RevenueDot vs Adapty" },
      { href: "/compare/revenuedot-vs-superwall", label: "RevenueDot vs Superwall" },
      { href: "/compare/revenuedot-vs-qonversion", label: "RevenueDot vs Qonversion" },
      { href: "/compare/revenuecat-vs-stripe", label: "RevenueCat vs Stripe" },
      { href: "/compare", label: "All comparisons" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/in-app-purchases", label: "In-app purchases guide" },
      { href: "/do-i-need-revenuecat", label: "Do I need RevenueCat?" },
      { href: "/docs", label: "Docs" },
      { href: "/revenuecat-mcp", label: "MCP server" },
      { href: "/sdks", label: "SDKs" },
      { href: "/stores", label: "Stores" },
      { href: "/errors", label: "SDK error codes" },
      { href: "/blog", label: "Blog" },
      { href: "/watch", label: "Videos" },
      { href: "https://github.com/revenuedot/revenuedot", label: "GitHub" },
      { href: "https://github.com/revenuedot/examples", label: "Examples" },
      { href: "/llms.txt", label: "llms.txt" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/legal/terms", label: "Terms" },
      { href: "/legal/privacy", label: "Privacy" },
      { href: "/legal/cookies", label: "Cookies" },
      { href: "/legal/dpa", label: "DPA summary" },
      { href: "/legal/acceptable-use", label: "Acceptable use" },
      { href: "/security", label: "Security" },
      { href: "/legal/licensing", label: "Licensing and trademarks" },
    ],
  },
] as const;

export type Faq = { q: string; a: string };
export type Crumb = { name: string; path: string };
