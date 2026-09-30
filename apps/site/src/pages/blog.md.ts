// /blog.md: blog/README.md from the docs repo, the post list as Markdown.
import type { APIRoute } from "astro";
import { getEntry } from "astro:content";
import { markdownTwin, markdownResponse } from "../lib/markdown-twin";

export const GET: APIRoute = async () => {
  const entry = (await getEntry("blog", "blog/README"))!;
  return markdownResponse(markdownTwin("blog/README.md", entry.data, entry.body ?? "", "/blog"));
};
