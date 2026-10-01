import type { APIRoute } from "astro";
import { SITE } from "../site";
import { PLANS } from "../lib/pricing";
import { llmsFile, textResponse } from "../lib/llms";

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
    `- [Migrate from RevenueCat](${u("/migrate-from-revenuecat")}): importer, side-by-side run, the proxy line for every SDK`,
    `- [Self-host](${u("/self-host")}): Docker and Postgres setup and a production checklist`,
    `- [RevenueDot vs RevenueCat](${u("/revenuedot-vs-revenuecat")}): sourced comparison of license, hosting, price, features and maturity`,
    `- [Changelog](${u("/changelog")}): what shipped`,
    `- [Security](${u("/security")}): report vulnerabilities to ${SITE.email.security}`,
    `- [Licensing and trademarks](${u("/legal/licensing")})`,
    "",
    "",
  ].join("\n");
  const docs = llmsFile("llms.txt").trimEnd() + "\n";
  const at = docs.indexOf("\n## Optional\n");
  return textResponse(at < 0 ? `${docs}\n${site}` : `${docs.slice(0, at + 1)}${site}${docs.slice(at + 1)}`);
};
