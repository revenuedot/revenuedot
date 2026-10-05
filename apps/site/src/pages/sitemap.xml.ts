import type { APIRoute } from "astro";
import { SITE } from "../site";
import { docsNav, blogPosts, lastModified } from "../lib/docs";
import { seoPaths } from "../data";
import { VIDEOS, WATCH, playerUrl } from "../lib/videos.mjs";

// Every static .astro page except the 404 (derived from the file tree, so a new page is listed automatically),
// plus every docs page and blog post from the docs repo with its last commit date.
const pages = Object.keys(import.meta.glob("./**/*.astro"))
  .map((f) => f.replace(/^\.\//, "/").replace(/\.astro$/, "").replace(/\/index$/, ""))
  .map((p) => p || "/")
  .filter((p) => p !== "/404" && !p.includes("["))
  .sort();
const LASTMOD = "2026-10-01";
const priority = (p: string) => (p === "/" ? "1.0" : p.startsWith("/legal") || p === "/security" ? "0.3" : "0.8");

const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Google video sitemap entry for a /watch page: the player, the MP4, the poster, the length and the publication date.
const videoTag = (name: string) => {
  const w = WATCH[name];
  return `<video:video><video:thumbnail_loc>${SITE.url}/videos/${name}.webp</video:thumbnail_loc><video:title>${xml(w.heading)}</video:title><video:description>${xml(w.summary)}</video:description><video:content_loc>${SITE.url}/videos/${name}.mp4</video:content_loc><video:player_loc>${xml(playerUrl(name))}</video:player_loc><video:duration>${w.seconds}</video:duration><video:publication_date>${w.date}</video:publication_date></video:video>`;
};

export const GET: APIRoute = async () => {
  const entries: { path: string; lastmod: string; priority: string; video?: string }[] = pages.map((p) => ({ path: p, lastmod: LASTMOD, priority: priority(p) }));
  for (const name of Object.keys(WATCH)) if (VIDEOS[name]) entries.push({ path: `/watch/${name}`, lastmod: WATCH[name].date, priority: "0.6", video: videoTag(name) });
  for (const p of seoPaths()) if (!entries.some((e) => e.path === p.path)) entries.push({ path: p.path, lastmod: LASTMOD, priority: "0.8" });
  for (const s of await docsNav()) for (const i of s.items) entries.push({ path: i.href, lastmod: lastModified(`${i.id}.md`) ?? LASTMOD, priority: "0.7" });
  for (const p of await blogPosts()) entries.push({ path: p.href, lastmod: lastModified(`${p.entry.id}.md`) ?? (p.date || LASTMOD), priority: "0.6" });
  const urls = entries
    .map((e) => `  <url><loc>${new URL(e.path, SITE.url).href}</loc><lastmod>${e.lastmod}</lastmod><priority>${e.priority}</priority>${e.video ?? ""}</url>`)
    .join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n${urls}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
