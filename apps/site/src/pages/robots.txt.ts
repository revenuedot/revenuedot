import type { APIRoute } from "astro";
import { SITE } from "../site";

// Everyone, including AI crawlers and AI answer engines, may read the whole site.
const AI = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended", "CCBot", "Meta-ExternalAgent", "Amazonbot", "DuckAssistBot", "cohere-ai", "MistralAI-User", "Bytespider"];

export const GET: APIRoute = () =>
  new Response(
    [
      "User-agent: *",
      "Allow: /",
      "",
      ...AI.flatMap((a) => [`User-agent: ${a}`, "Allow: /", ""]),
      `Sitemap: ${SITE.url}/sitemap.xml`,
      "",
    ].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
