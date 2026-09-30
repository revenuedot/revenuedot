import type { APIRoute } from "astro";
import { SITE } from "../site";
import { docsNav, blogPosts, lastModified } from "../lib/docs";

// Every static .astro page except the 404 (derived from the file tree, so a new page is listed automatically),
// plus every docs page and blog post from the docs repo with its last commit date.
const pages = Object.keys(import.meta.glob("./**/*.astro"))
  .map((f) => f.replace(/^\.\//, "/").replace(/\.astro$/, "").replace(/\/index$/, ""))
  .map((p) => p || "/")
  .filter((p) => p !== "/404" && !p.includes("["))
  .sort();
const LASTMOD = "2026-09-30";
const priority = (p: string) => (p === "/" ? "1.0" : p.startsWith("/legal") || p === "/security" ? "0.3" : "0.8");

export const GET: APIRoute = async () => {
  const entries: { path: string; lastmod: string; priority: string }[] = pages.map((p) => ({ path: p, lastmod: LASTMOD, priority: priority(p) }));
  for (const s of await docsNav()) for (const i of s.items) entries.push({ path: i.href, lastmod: lastModified(`${i.id}.md`) ?? LASTMOD, priority: "0.7" });
  for (const p of await blogPosts()) entries.push({ path: p.href, lastmod: lastModified(`${p.entry.id}.md`) ?? (p.date || LASTMOD), priority: "0.6" });
  const urls = entries
    .map((e) => `  <url><loc>${new URL(e.path, SITE.url).href}</loc><lastmod>${e.lastmod}</lastmod><priority>${e.priority}</priority></url>`)
    .join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
