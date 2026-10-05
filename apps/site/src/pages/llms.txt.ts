import type { APIRoute } from "astro";
import { SITE } from "../site";
import { CARD_RULE, STATUS_PRICE } from "../lib/pricing";
import { llmsFile, textResponse, videosSection, withStatus } from "../lib/llms";
import { TOOLS, ALTERNATIVES, CHART_PAGES, COMPARISONS, INTEGRATIONS, LANDINGS, SECTIONS, chartPath, comparePath, integrationPath, landingPath } from "../data";
import { plain } from "../lib/md";
import { GLOSSARY } from "../data/glossary";
import { ERRORS } from "../data/errors";

// llms.txt (https://llmstxt.org): the docs repo's llms.txt, the canonical index of every docs page, with its links
// pointed at the .md twins on this site, plus a "Website" section (inserted before "Optional") for the marketing pages.
export const GET: APIRoute = () => {
  const u = (p: string) => new URL(p, SITE.url).href;
  const site = [
    "## Website",
    "",
    `- [Sign up for RevenueDot Cloud](${SITE.signup}): start for free; Pro costs $0 until your apps make $10,000 a month`,
    `- [Home](${u("/")}): what RevenueDot is, what it does for any app with in-app purchases, and how to start for free or switch from RevenueCat`,
    `- [Pricing](${u("/pricing")}): two plans, Pro and Enterprise. ${STATUS_PRICE} ${CARD_RULE}`,
    `- [Add in-app purchases to your app](${u("/add-in-app-purchases")}): for first-time builders; install the RevenueDot SDK, no RevenueCat account needed, a prompt for Claude Code or Cursor`,
    `- [In-app purchases: how they work](${u("/in-app-purchases")}): types, Apple and Google fees, store rules and what a backend does`,
    `- [Do I need RevenueCat for an iOS-only app?](${u("/do-i-need-revenuecat")}): when StoreKit 2 is enough and when you need a backend, with a decision table`,
    `- [Migrate from RevenueCat](${u("/migrate-from-revenuecat")}): importer, side-by-side run, the proxy line for every SDK`,
    `- [RevenueCat MCP server, official and open source](${u("/revenuecat-mcp")}): what RevenueCat's docs say about its MCP server, and RevenueDot's open-source one with 38 tools, OAuth scopes and config for Claude Code, Claude, Codex, Cursor, ChatGPT and Windsurf`,
    `- [Run it on your own servers](${u("/self-host")}): Docker and Postgres setup, the AGPL-3.0 license and when you need an Enterprise license`,
    `- [The open-source RevenueCat alternative](${u("/revenuecat-alternative")}): keep the RevenueCat SDK, change one line, own your data`,
    `- [Best RevenueCat alternatives in 2026](${u("/revenuecat-alternatives")}): ${ALTERNATIVES.map((a) => a.name).join(", ")}, with sources`,
    `- [Cheaper RevenueCat alternatives](${u("/cheaper-revenuecat-alternatives")}): RevenueCat, Adapty, Qonversion, Superwall, Apphud and RevenueDot priced at $10K, $100K and $1M a month, with sources`,
    `- [Changelog](${u("/changelog")}): what shipped`,
    `- [Security](${u("/security")}): report vulnerabilities to ${SITE.email.security}`,
    `- [Licensing and trademarks](${u("/legal/licensing")})`,
    "",
    videosSection("## Videos"),
    "## Free tools",
    "",
    ...TOOLS.map((t) => `- [${t.title}](${u(t.path)}): ${t.card}`),
    "",
    "## Comparisons",
    "",
    ...COMPARISONS.map((c) => `- [${c.title}](${u(comparePath(c))}): ${plain(c.card)}`),
    "",
    ...(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).flatMap((k) => [
      `## ${SECTIONS[k].name}`,
      "",
      ...LANDINGS.filter((l) => l.section === k).map((l) => `- [${l.title}](${u(landingPath(l))}): ${plain(l.card)}`),
      "",
    ]),
    "## Integrations",
    "",
    ...INTEGRATIONS.map((i) => `- [${i.title}](${u(integrationPath(i))}): ${plain(i.card)}`),
    "",
    "## SDK error codes",
    "",
    ...[...ERRORS].sort((a, b) => a.code - b.code).map((e) => `- [${e.swift} (code ${e.code})](${u(`/errors/${e.slug}`)}): ${plain(e.answer)}`),
    "",
    "## Glossary",
    "",
    ...GLOSSARY.map((g) => `- [${g.term}](${u(`/glossary/${g.slug}`)}): ${plain(g.answer)}`),
    "",
    "## Subscription metrics (charts)",
    "",
    ...CHART_PAGES.map((c) => `- [${c.def.display_name}](${u(chartPath(c))}): ${plain(c.answer)}`),
    "",
    "",
  ].join("\n");
  const docs = withStatus(llmsFile("llms.txt")).trimEnd() + "\n";
  const at = docs.indexOf("\n## Optional\n");
  return textResponse(at < 0 ? `${docs}\n${site}` : `${docs.slice(0, at + 1)}${site}${docs.slice(at + 1)}`);
};
