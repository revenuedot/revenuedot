// Site-wide constants. Change a fact here and every page, JSON-LD block and llms.txt follows.
export const SITE = {
  name: "RevenueDot",
  url: "https://revenuedot.app",
  tagline: "The open-source RevenueCat alternative",
  description:
    "RevenueDot is an open-source, self-hostable backend for in-app purchases and subscriptions that works with the RevenueCat SDK. Change one line, keep your app code, and pay nothing to self-host.",
  github: "https://github.com/revenuedot/revenuedot",
  org: "https://github.com/revenuedot",
  docs: "https://github.com/revenuedot/docs",
  docsBlog: "https://github.com/revenuedot/docs/tree/main/blog",
  examples: "https://github.com/revenuedot/examples",
  mcp: "https://github.com/revenuedot/mcp",
  skills: "https://github.com/revenuedot/agent-skills",
  apiHost: "https://api.revenuedot.app",
  email: {
    hello: "hello@revenuedot.app",
    security: "security@revenuedot.app",
    legal: "legal@revenuedot.app",
  },
  ogImage: "/og.png",
  ogImageAlt: "RevenueDot: the open-source RevenueCat alternative",
  // Cookieless Cloudflare Web Analytics. Set PUBLIC_CF_WEB_ANALYTICS_TOKEN at build time to turn it on; unset = no beacon.
  analyticsToken: (import.meta.env.PUBLIC_CF_WEB_ANALYTICS_TOKEN as string | undefined) || "",
  // Date competitor prices were last checked against their public pricing pages.
  pricesChecked: "September 2026",
} as const;

export const NAV = [
  { href: "/pricing", label: "Pricing" },
  { href: "/migrate-from-revenuecat", label: "Migrate" },
  { href: "/self-host", label: "Self-host" },
  { href: "/revenuedot-vs-revenuecat", label: "Compare" },
  { href: "/docs", label: "Docs" },
  { href: "/blog", label: "Blog" },
] as const;

export const FOOTER = [
  {
    title: "Product",
    links: [
      { href: "/pricing", label: "Pricing" },
      { href: "/migrate-from-revenuecat", label: "Migrate from RevenueCat" },
      { href: "/self-host", label: "Self-host" },
      { href: "/revenuedot-vs-revenuecat", label: "RevenueDot vs RevenueCat" },
      { href: "/changelog", label: "Changelog" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs", label: "Docs" },
      { href: "/blog", label: "Blog" },
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
