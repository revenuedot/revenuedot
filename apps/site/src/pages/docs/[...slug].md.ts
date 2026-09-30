// The Markdown twin of every docs page: /docs/<path>.md next to /docs/<path>.
import type { APIRoute } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";
import { docSlug } from "../../lib/docs";
import { pagePath } from "../../lib/docs-source.mjs";
import { markdownTwin, markdownResponse } from "../../lib/markdown-twin";

export async function getStaticPaths() {
  const entries = await getCollection("docs");
  return entries.map((entry) => ({ params: { slug: docSlug(entry.id) }, props: { entry } }));
}

export const GET: APIRoute = ({ props }) => {
  const { entry } = props as { entry: CollectionEntry<"docs"> };
  return markdownResponse(markdownTwin(`${entry.id}.md`, entry.data, entry.body ?? "", pagePath(`${entry.id}.md`)!));
};
