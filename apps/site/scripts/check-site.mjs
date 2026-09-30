// Checks the built site (dist/): every internal link and asset resolves, every page has a unique title and
// description, one h1, a canonical URL, OG and Twitter images, and JSON-LD that parses with the types we expect.
//   pnpm --filter site build && pnpm --filter site check
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const SITE = "https://revenuedot.app";
const errors = [];
const fail = (page, msg) => errors.push(`${page}: ${msg}`);

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(dist);
const htmlFiles = files.filter((f) => f.endsWith(".html"));
const redirects = readFileSync(path.join(dist, "_redirects"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)[0]);

/** Resolves an internal URL path the way Cloudflare static assets does (drop-trailing-slash, .html). */
function resolves(p) {
  const clean = decodeURI(p.split("#")[0].split("?")[0]);
  if (clean === "/" ) return existsSync(path.join(dist, "index.html"));
  const f = path.join(dist, clean);
  if (existsSync(f) && statSync(f).isFile()) return true;
  if (existsSync(f + ".html")) return true;
  if (existsSync(path.join(f, "index.html"))) return true;
  return redirects.some((r) => r === clean || (r.endsWith("/*") && clean.startsWith(r.slice(0, -1))));
}

const titles = new Map();
const descriptions = new Map();
const expectTypes = {
  "/": ["Organization", "WebSite", "SoftwareApplication", "FAQPage"],
  "/pricing": ["Organization", "SoftwareApplication", "FAQPage", "BreadcrumbList"],
  "/revenuedot-vs-revenuecat": ["Organization", "FAQPage", "BreadcrumbList"],
  "/migrate-from-revenuecat": ["Organization", "HowTo", "FAQPage", "BreadcrumbList"],
};
let links = 0;
let ldBlocks = 0;

for (const file of htmlFiles) {
  const rel = "/" + path.relative(dist, file).replace(/\\/g, "/");
  const route = rel === "/index.html" ? "/" : rel.replace(/\.html$/, "");
  const html = readFileSync(file, "utf8");
  const is404 = route === "/404";

  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  if (!title) fail(route, "missing <title>");
  else if (title.length > 70) fail(route, `title is ${title.length} chars (max 70): ${title}`);
  if (!desc) fail(route, "missing meta description");
  else if (!is404 && desc.length < 70 || desc.length > 170) fail(route, `description is ${desc.length} chars (want 70-170)`);
  if (title) { if (titles.has(title)) fail(route, `duplicate title with ${titles.get(title)}`); titles.set(title, route); }
  if (desc) { if (descriptions.has(desc)) fail(route, `duplicate description with ${descriptions.get(desc)}`); descriptions.set(desc, route); }
  const h1s = (html.match(/<h1[\s>]/g) || []).length;
  if (h1s !== 1) fail(route, `${h1s} <h1> elements`);
  if (!/<html lang="en">/.test(html)) fail(route, "missing lang");
  if (!is404) {
    const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
    if (canonical !== SITE + (route === "/" ? "/" : route)) fail(route, `canonical is ${canonical}`);
    for (const m of ["og:title", "og:description", "og:image", "og:url"]) if (!html.includes(`property="${m}"`)) fail(route, `missing ${m}`);
    if (!html.includes('name="twitter:card" content="summary_large_image"')) fail(route, "missing twitter card");
  }

  // JSON-LD
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) fail(route, "no JSON-LD");
  const types = new Set();
  for (const b of blocks) {
    ldBlocks++;
    let data;
    try { data = JSON.parse(b); } catch (e) { fail(route, `JSON-LD does not parse: ${e.message}`); continue; }
    if (data["@context"] !== "https://schema.org") fail(route, "JSON-LD @context is not https://schema.org");
    for (const node of data["@graph"] ?? [data]) {
      if (!node["@type"]) fail(route, "JSON-LD node without @type");
      types.add(node["@type"]);
      if (node["@type"] === "FAQPage") {
        if (!node.mainEntity?.length) fail(route, "FAQPage without questions");
        for (const q of node.mainEntity ?? []) if (q["@type"] !== "Question" || !q.name || q.acceptedAnswer?.["@type"] !== "Answer" || !q.acceptedAnswer.text) fail(route, `bad FAQ entry: ${q.name}`);
        // Every FAQ question in JSON-LD must also be visible on the page.
        for (const q of node.mainEntity ?? []) if (!html.includes(`<summary>${q.name.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;")}</summary>`) && !html.includes(`<summary>${q.name}</summary>`)) fail(route, `FAQ question not visible: ${q.name}`);
      }
      if (node["@type"] === "BreadcrumbList") {
        node.itemListElement.forEach((it, i) => {
          if (it.position !== i + 1 || !it.name || !it.item?.startsWith(SITE)) fail(route, "bad breadcrumb item");
          if (!resolves(new URL(it.item).pathname)) fail(route, `breadcrumb target missing: ${it.item}`);
        });
      }
      if (node["@type"] === "SoftwareApplication") {
        if (!node.offers?.length) fail(route, "SoftwareApplication without offers");
        for (const o of node.offers ?? []) if (o["@type"] !== "Offer" || o.price === undefined || !o.priceCurrency) fail(route, "bad Offer");
        if (!node.applicationCategory || !node.operatingSystem) fail(route, "SoftwareApplication missing category or OS");
      }
      if (node["@type"] === "Organization" && (!node.name || !node.url || !node.logo)) fail(route, "Organization missing name, url or logo");
    }
  }
  for (const t of expectTypes[route] ?? (is404 ? ["Organization"] : ["Organization", "BreadcrumbList"])) if (!types.has(t)) fail(route, `missing JSON-LD ${t}`);

  // Internal links and assets
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|data:|#)/.test(u)) {
      if (u.startsWith(SITE)) { links++; if (!resolves(new URL(u).pathname)) fail(route, `broken absolute link ${u}`); }
      continue;
    }
    links++;
    const target = u.startsWith("/") ? u : path.posix.join(path.posix.dirname(route), u);
    if (!resolves(target)) fail(route, `broken link ${u}`);
  }
  for (const m of html.matchAll(/srcset="([^"]+)"/g)) for (const part of m[1].split(",")) {
    const u = part.trim().split(/\s+/)[0];
    links++;
    if (!resolves(u)) fail(route, `broken srcset ${u}`);
  }
  // Anchor targets on the same page
  for (const m of html.matchAll(/href="#([^"]+)"/g)) if (!html.includes(`id="${m[1]}"`)) fail(route, `missing anchor #${m[1]}`);
  if (/Circo/.test(html) && !route.startsWith("/legal") && route !== "/security") fail(route, "operator entity outside legal pages");
}

// Sitemap covers every page, and only pages that exist
const sitemap = readFileSync(path.join(dist, "sitemap.xml"), "utf8");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
for (const l of locs) if (!resolves(l)) fail("sitemap.xml", `lists missing page ${l}`);
for (const f of htmlFiles) {
  const r = "/" + path.relative(dist, f).replace(/\.html$/, "").replace(/^index$/, "");
  if (r !== "/404" && !locs.includes(r)) fail("sitemap.xml", `does not list ${r}`);
}
const robots = readFileSync(path.join(dist, "robots.txt"), "utf8");
if (!robots.includes("Sitemap: https://revenuedot.app/sitemap.xml") || /Disallow: \/\s/.test(robots)) fail("robots.txt", "bad robots.txt");
for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]) if (!robots.includes(`User-agent: ${bot}\nAllow: /`)) fail("robots.txt", `${bot} not allowed`);
const llms = readFileSync(path.join(dist, "llms.txt"), "utf8");
if (!llms.startsWith("# RevenueDot\n\n> ")) fail("llms.txt", "not in llms.txt format");
for (const m of llms.matchAll(/\]\((https:\/\/revenuedot\.app[^)]*)\)/g)) if (!resolves(new URL(m[1]).pathname)) fail("llms.txt", `broken link ${m[1]}`);

console.log(`${htmlFiles.length} pages, ${links} internal links and assets, ${ldBlocks} JSON-LD blocks, ${locs.length} sitemap URLs`);
if (errors.length) { console.error(errors.map((e) => "  ✗ " + e).join("\n")); process.exit(1); }
console.log("✓ all checks passed");
