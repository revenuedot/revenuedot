// Every SEO page in one place: the page templates, hubs, related links, sitemap, llms.txt and OG images read from here.
import type { ChartPage, ComparePage, IntegrationPage, Landing } from "./types";
import { FEATURES } from "./features";
import { STORES } from "./stores";
import { SDK_PAGES } from "./sdk-pages";
import { SOLUTIONS } from "./solutions";
import { INTEGRATIONS_A } from "./integrations-a";
import { INTEGRATIONS_B } from "./integrations-b";
import { CHARTS_A } from "./charts-a";
import { CHARTS_B } from "./charts-b";
import { COMPARE, ALTERNATIVE_PAGE } from "./compare";
import { ALTERNATIVES, ALTERNATIVES_INTRO } from "./alternatives";
import { GLOSSARY } from "./glossary";
import { ERRORS } from "./errors";
import { GUIDES } from "./guides";
import { CHARTS as CATALOG, GROUPS, type ChartDef } from "../../../../packages/core/src/charts/catalog";

export { ALTERNATIVE_PAGE, ALTERNATIVES, ALTERNATIVES_INTRO, GROUPS };

export const SECTIONS = {
  features: { name: "Features", path: "/features", label: "Feature" },
  stores: { name: "Stores", path: "/stores", label: "Store" },
  sdks: { name: "SDKs", path: "/sdks", label: "SDK" },
  solutions: { name: "Solutions", path: "/solutions", label: "Solution" },
} as const;

export const LANDINGS: Landing[] = [...FEATURES, ...STORES, ...SDK_PAGES, ...SOLUTIONS];
export const landingPath = (l: Landing) => `/${l.section}/${l.slug}`;

export const INTEGRATIONS: IntegrationPage[] = [...INTEGRATIONS_A, ...INTEGRATIONS_B].sort((a, b) => a.name.localeCompare(b.name));
export const integrationPath = (i: IntegrationPage) => `/integrations/${i.slug}`;
export const INTEGRATION_CATEGORIES: Record<string, string> = {
  core: "Webhooks and data",
  data: "Webhooks and data",
  analytics: "Product analytics",
  attribution: "Attribution and ads measurement",
  marketing: "Messaging and marketing",
  support: "Customer support",
  ads: "Ad monetization",
};

export type ChartFull = ChartPage & { def: ChartDef };
const byName = new Map(CATALOG.map((c) => [c.name, c]));
export const CHART_PAGES: ChartFull[] = [...CHARTS_A, ...CHARTS_B]
  .filter((c) => byName.has(c.name))
  .map((c) => ({ ...c, def: byName.get(c.name)! }))
  .sort((a, b) => CATALOG.indexOf(a.def) - CATALOG.indexOf(b.def));
export const chartPath = (c: ChartPage) => `/charts/${c.slug}`;
export const chartByName = (name: string) => CHART_PAGES.find((c) => c.name === name);

export const COMPARISONS: ComparePage[] = COMPARE;
export const comparePath = (c: ComparePage) => `/compare/${c.slug}`;

export const TOOLS = [
  { path: "/tools/app-store-fee-calculator", title: "App Store and Google Play fee calculator", card: "What you keep from a subscription after Apple's or Google's commission and your backend's fee." },
  { path: "/tools/subscription-revenue-calculator", title: "Subscription revenue calculator", card: "Project MRR, ARR and LTV over 12 months from installs, trial and paid conversion, price and churn." },
  { path: "/tools/revenuecat-fee-calculator", title: "RevenueCat fee calculator", card: "RevenueCat's fee at your revenue, next to Adapty, Qonversion, Superwall and RevenueDot." },
];

/** Title, card text and label for every page that related links can point to. */
type Entry = { title: string; card: string; label: string };
const STATIC: Record<string, Entry> = {
  "/pricing": { title: "Pricing", card: "Free on RevenueDot Cloud up to $10K a month in tracked revenue, then 0.5%, never more than $999 a month.", label: "Pricing" },
  "/migrate-from-revenuecat": { title: "Migrate from RevenueCat", card: "Import everything, run both side by side, then switch with one line.", label: "Guide" },
  "/self-host": { title: "Run the server yourself", card: "Technical notes for running the open-source server yourself.", label: "Technical" },
  "/revenuecat-mcp": { title: "RevenueCat MCP server, official and open source", card: "RevenueCat's MCP server and RevenueDot's open-source one: 38 tools, OAuth, config for six clients.", label: "MCP" },
  "/revenuecat-alternative": { title: "The open-source RevenueCat alternative", card: "Keep the RevenueCat SDK, change one line, start free on Cloud.", label: "Alternative" },
  "/revenuecat-alternatives": { title: "Best RevenueCat alternatives in 2026", card: "RevenueDot, Adapty, Superwall, Qonversion, Apphud and more, compared with sources.", label: "Alternatives" },
  "/integrations": { title: "Integrations", card: "Send subscription events to 36 analytics, attribution, messaging and support tools.", label: "Hub" },
  "/charts": { title: "Subscription charts", card: "All 43 subscription charts, from MRR to trial conversion, defined and explained.", label: "Hub" },
  "/compare": { title: "Comparisons", card: "RevenueDot next to RevenueCat, Adapty, Superwall, Qonversion and Apphud.", label: "Hub" },
  "/features": { title: "Features", card: "Everything RevenueDot does, from receipts to paywalls and web checkout.", label: "Hub" },
  "/errors": { title: "RevenueCat SDK error codes", card: "Every SDK error code with causes, fixes and how to handle it in code.", label: "Hub" },
  "/glossary": { title: "Subscription app glossary", card: "In-app purchase and subscription terms explained, with Apple's and Google's sources.", label: "Hub" },
  "/tools": { title: "Free tools", card: "Free calculators for RevenueCat fees, store commission and subscription revenue.", label: "Hub" },
};
for (const t of TOOLS) STATIC[t.path] = { title: t.title, card: t.card, label: "Free tool" };
for (const g of GUIDES) STATIC[g.path] = { title: g.name, card: g.card, label: "Guide" };

export function entry(path: string): Entry | undefined {
  if (STATIC[path]) return STATIC[path];
  const l = LANDINGS.find((x) => landingPath(x) === path);
  if (l) return { title: l.name, card: l.card, label: l.label };
  const i = INTEGRATIONS.find((x) => integrationPath(x) === path);
  if (i) return { title: i.name, card: i.card, label: "Integration" };
  const c = CHART_PAGES.find((x) => chartPath(x) === path);
  if (c) return { title: c.def.display_name, card: c.answer.split(". ")[0] + ".", label: "Chart" };
  const g = GLOSSARY.find((x) => `/glossary/${x.slug}` === path);
  if (g) return { title: g.term, card: g.short, label: "Glossary" };
  const er = ERRORS.find((x) => `/errors/${x.slug}` === path);
  if (er) return { title: er.swift, card: er.name, label: `SDK error ${er.code}` };
  const v = COMPARISONS.find((x) => comparePath(x) === path);
  if (v) return { title: v.short ?? v.columns.slice(0, 2).join(" vs "), card: v.card, label: "Comparison" };
  return undefined;
}

/** Turns a related entry (a site path or a chart API name) into a link with its title and card, or drops it. */
export function related(items: string[]) {
  return items
    .map((r) => (r.startsWith("/") ? r : chartByName(r) ? chartPath(chartByName(r)!) : ""))
    .filter((p, i, a) => p && a.indexOf(p) === i)
    .map((p) => ({ href: p, ...(entry(p) ?? (p.startsWith("/docs") ? { title: ((t) => t.charAt(0).toUpperCase() + t.slice(1))(p.replace(/^\/docs\//, "").split("/").pop()!.replace(/-/g, " ")), card: "Read the docs.", label: "Docs" } : undefined)) }))
    .filter((r): r is { href: string; title: string; card: string; label: string } => !!r.title);
}

/** Every SEO page path, for the sitemap and llms.txt. */
export function seoPaths(): { path: string; title: string; card: string }[] {
  return [
    ...Object.entries(STATIC).filter(([p]) => !["/pricing", "/migrate-from-revenuecat", "/self-host"].includes(p)).map(([path, e]) => ({ path, title: e.title, card: e.card })),
    ...Object.entries(SECTIONS).filter(([k]) => k !== "features").map(([, s]) => ({ path: s.path, title: s.name, card: `${s.name} supported by RevenueDot.` })),
    ...LANDINGS.map((l) => ({ path: landingPath(l), title: l.title, card: l.card })),
    ...INTEGRATIONS.map((i) => ({ path: integrationPath(i), title: i.title, card: i.card })),
    ...CHART_PAGES.map((c) => ({ path: chartPath(c), title: c.title, card: c.answer })),
    ...COMPARISONS.map((c) => ({ path: comparePath(c), title: c.title, card: c.card })),
    ...GLOSSARY.map((g) => ({ path: `/glossary/${g.slug}`, title: g.term, card: g.short })),
    ...ERRORS.map((e) => ({ path: `/errors/${e.slug}`, title: `${e.swift} (code ${e.code})`, card: e.name })),
  ];
}
