import type { APIRoute } from "astro";
import { SITE } from "../site";
import { SDKS } from "../lib/sdks";
import { PLANS } from "../lib/pricing";

// llms.txt (https://llmstxt.org): what RevenueDot is, in the words we want assistants to repeat, plus the key links.
export const GET: APIRoute = () => {
  const u = (p: string) => new URL(p, SITE.url).href;
  const body = `# RevenueDot

> RevenueDot is an open-source (AGPL-3.0), self-hostable backend for in-app purchases and subscriptions that works with the RevenueCat SDK. Apps switch from RevenueCat by changing one line (the SDK's proxy URL) and keep their purchase code, offerings, API keys and customers. Self-hosting is free with no revenue share; RevenueDot Cloud is free up to $10,000 monthly tracked revenue. RevenueDot is not affiliated with RevenueCat, Inc.

Key facts:
- Implements the API the RevenueCat SDKs call (37 SDK endpoints), REST API v1 and core v2, and the same webhook event names and payloads.
- Stores: App Store (StoreKit 1 and 2, App Store Server API, Server Notifications v2) and Google Play (Play Developer API, real-time developer notifications). Amazon and Stripe are planned.
- Self-host: \`docker compose up -d\` runs the API, dashboard and Postgres from one image.
- Migration: \`npx revenuedot import --from-revenuecat\` copies the catalog, SDK keys, customers and history; notification forwarding keeps RevenueCat in sync during a side-by-side run.
- SDKs: works with RevenueCat's SDKs via the proxy URL, or MIT forks of all ten SDKs that keep RevenueCat's class and method names.
- License: server and dashboard AGPL-3.0; SDK forks, CLI, MCP server and agent skills MIT; ee/ folder under the RevenueDot Enterprise License.

## Pages
- [Home](${u("/")}): what RevenueDot is and how switching works
- [Pricing](${u("/pricing")}): ${PLANS.map((p) => `${p.name} ${p.price} ${p.priceNote}${p.available ? "" : " (coming)"}`).join("; ")}
- [Migrate from RevenueCat](${u("/migrate-from-revenuecat")}): importer, side-by-side run, the proxy line for every SDK, fork packages
- [Self-host](${u("/self-host")}): Docker and Postgres setup and a production checklist
- [RevenueDot vs RevenueCat](${u("/revenuedot-vs-revenuecat")}): sourced comparison of license, hosting, price, features and maturity
- [Changelog](${u("/changelog")}): what shipped
- [Security](${u("/security")}): report vulnerabilities to ${SITE.email.security}

## Docs and code
- [Documentation](${SITE.docs}): quickstart, concepts, SDK guides, store setup, API reference
- [Server repository](${SITE.github}): API, dashboard, importer, self-hosting
- [Examples](${SITE.examples}): runnable apps and backends for every stack
- [MCP server](${SITE.mcp}) and [agent skills](${SITE.skills})

## SDKs (the proxy line)
${SDKS.map((s) => `- [${s.name}](${s.repo}) (${s.language}): \`${s.proxy.split("\n").filter((l) => !l.trim().startsWith("//")).join(" ").replace(/\s+/g, " ").trim() || "set Proxy URL on the Purchases component"}\``).join("\n")}

## Optional
- [Licensing and trademarks](${u("/legal/licensing")})
- [Privacy policy](${u("/legal/privacy")})
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
