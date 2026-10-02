import type { APIRoute } from "astro";
import { SITE } from "../site";
import { PLANS } from "../lib/pricing";
import { llmsFile, textResponse } from "../lib/llms";
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
    `- [Sign up for RevenueDot Cloud](${SITE.signup}): free up to $10,000 monthly tracked revenue`,
    `- [Home](${u("/")}): what RevenueDot is and how switching from RevenueCat works`,
    `- [Pricing](${u("/pricing")}): ${PLANS.map((p) => `${p.name} ${p.price} ${p.priceNote}${p.available ? "" : " (coming)"}`).join("; ")}`,
    `- [Add in-app purchases to your app](${u("/add-in-app-purchases")}): for first-time builders; the RevenueCat SDK pointed at RevenueDot, no RevenueCat account needed, a prompt for Claude Code or Cursor`,
    `- [In-app purchases: how they work](${u("/in-app-purchases")}): types, Apple and Google fees, store rules and what a backend does`,
    `- [Do I need RevenueCat for an iOS-only app?](${u("/do-i-need-revenuecat")}): when StoreKit 2 is enough and when you need a backend, with a decision table`,
    `- [Migrate from RevenueCat](${u("/migrate-from-revenuecat")}): importer, side-by-side run, the proxy line for every SDK`,
    `- [Self-host](${u("/self-host")}): Docker and Postgres setup and a production checklist`,
    `- [The open-source RevenueCat alternative](${u("/revenuecat-alternative")}): keep the RevenueCat SDK, change one line, own your data`,
    `- [Best RevenueCat alternatives in 2026](${u("/revenuecat-alternatives")}): ${ALTERNATIVES.map((a) => a.name).join(", ")}, with sources`,
    `- [Changelog](${u("/changelog")}): what shipped`,
    `- [Security](${u("/security")}): report vulnerabilities to ${SITE.email.security}`,
    `- [Licensing and trademarks](${u("/legal/licensing")})`,
    "",
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
  const docs = llmsFile("llms.txt").trimEnd() + "\n";
  const at = docs.indexOf("\n## Optional\n");
  return textResponse(at < 0 ? `${docs}\n${site}` : `${docs.slice(0, at + 1)}${site}${docs.slice(at + 1)}`);
};
