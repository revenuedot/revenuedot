import type { APIRoute } from "astro";
import { SITE } from "../site";

// Every .astro page except the 404, derived from the file tree so a new page is listed automatically.
const pages = Object.keys(import.meta.glob("./**/*.astro"))
  .map((f) => f.replace(/^\.\//, "/").replace(/\.astro$/, "").replace(/\/index$/, "/"))
  .filter((p) => p !== "/404")
  .sort();
const LASTMOD = "2026-09-30";
const priority = (p: string) => (p === "/" ? "1.0" : p.startsWith("/legal") || p === "/security" ? "0.3" : "0.8");

export const GET: APIRoute = () => {
  const urls = pages
    .map((p) => `  <url><loc>${new URL(p, SITE.url).href}</loc><lastmod>${LASTMOD}</lastmod><priority>${priority(p)}</priority></url>`)
    .join("\n");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
