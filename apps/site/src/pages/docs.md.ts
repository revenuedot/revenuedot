// /docs.md: the docs index as Markdown, every section and page with its description.
import type { APIRoute } from "astro";
import { docsNav } from "../lib/docs";
import { SITE_URL } from "../lib/docs-source.mjs";
import { markdownResponse } from "../lib/markdown-twin";

export const GET: APIRoute = async () => {
  const nav = await docsNav();
  const lines = [
    "---",
    'title: "RevenueDot documentation"',
    'description: "Every page of the RevenueDot docs: quickstart, concepts, SDK guides, store setup, migrating from RevenueCat, the API reference and the help center."',
    `url: ${SITE_URL}/docs`,
    "---",
    "",
    "# RevenueDot documentation",
    "",
    "RevenueDot is an open-source backend for in-app purchases and subscriptions that works with the RevenueCat SDK. Start free on RevenueDot Cloud (https://app.revenuedot.app/signup), or self-host it with Docker and Postgres. Each link below is the page's Markdown.",
    "",
  ];
  for (const s of nav) {
    lines.push(`## ${s.title}`, "", s.blurb, "");
    for (const i of s.items) lines.push(`- [${i.title}](${SITE_URL}${i.href}.md): ${i.description}`);
    lines.push("");
  }
  lines.push(`Full text for AI assistants: ${SITE_URL}/llms-full.txt`, "");
  return markdownResponse(lines.join("\n"));
};
