// Checks the built site (dist/): every internal link and asset resolves (with #anchors on other pages too), every
// page has a unique title and description, one h1, a canonical URL, OG and Twitter images, and JSON-LD that parses
// with the types we expect. Docs: every /docs and /blog page has its .md twin, the llms files link only to pages that
// exist, the Pagefind index is built, and every revenuedot.app/docs or /blog URL written anywhere in the sibling
// repos of the workspace (examples, docs, SDK forks, this monorepo) resolves or is redirected.
//   pnpm --filter site build && pnpm --filter site check
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
const redirectRules = readFileSync(path.join(dist, "_redirects"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
const redirects = redirectRules.map((r) => r[0]);

/** Resolves an internal URL path the way Cloudflare static assets does (drop-trailing-slash, .html). */
function resolves(p) {
  // Cloudflare's default html_handling (auto-trailing-slash) sends /docs/ to /docs when docs.html exists.
  const clean = decodeURI(p.split("#")[0].split("?")[0]).replace(/(.)\/$/, "$1");
  if (clean === "/" ) return existsSync(path.join(dist, "index.html"));
  const f = path.join(dist, clean);
  if (existsSync(f) && statSync(f).isFile()) return true;
  if (existsSync(f + ".html")) return true;
  if (existsSync(path.join(f, "index.html"))) return true;
  return redirects.some((r) => r === clean || (r.endsWith("/*") && clean.startsWith(r.slice(0, -1))));
}

/** The HTML file behind an internal path, if it is a page. */
function pageFile(p) {
  const clean = decodeURI(p.split("#")[0].split("?")[0]).replace(/\/$/, "") || "/";
  const f = clean === "/" ? path.join(dist, "index.html") : path.join(dist, clean + ".html");
  return existsSync(f) ? f : null;
}
const idCache = new Map();
/** A link's #fragment exists on the page it points to (pages we do not render, or redirects, are skipped). */
function anchorOk(p) {
  const hash = p.split("#")[1];
  if (!hash) return true;
  const f = pageFile(p);
  if (!f) return true;
  if (!idCache.has(f)) idCache.set(f, new Set([...readFileSync(f, "utf8").matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return idCache.get(f).has(decodeURIComponent(hash));
}

const titles = new Map();
const descriptions = new Map();
const expectTypes = {
  "/": ["Organization", "WebSite", "SoftwareApplication", "FAQPage"],
  "/pricing": ["Organization", "SoftwareApplication", "FAQPage", "BreadcrumbList"],
  "/revenuecat-alternative": ["Organization", "WebPage", "SoftwareApplication", "FAQPage", "BreadcrumbList"],
  "/revenuecat-alternatives": ["Organization", "WebPage", "ItemList", "FAQPage", "BreadcrumbList"],
  "/migrate-from-revenuecat": ["Organization", "HowTo", "FAQPage", "BreadcrumbList"],
  "/in-app-purchases": ["Organization", "WebPage", "HowTo", "FAQPage", "BreadcrumbList"],
  "/add-in-app-purchases": ["Organization", "WebPage", "HowTo", "FAQPage", "BreadcrumbList"],
  "/do-i-need-revenuecat": ["Organization", "WebPage", "FAQPage", "BreadcrumbList"],
  "/cheaper-revenuecat-alternatives": ["Organization", "WebPage", "HowTo", "FAQPage", "BreadcrumbList"],
  "/revenuecat-mcp": ["Organization", "WebPage", "HowTo", "FAQPage", "BreadcrumbList"],
};
const typesFor = (route) =>
  expectTypes[route] ??
  (route === "/docs" || route.startsWith("/docs/") ? ["Organization", "TechArticle", "BreadcrumbList"]
    : route.startsWith("/blog/") ? ["Organization", "BlogPosting", "BreadcrumbList"]
    : /^\/(features|stores|sdks|solutions|integrations|charts|compare)$/.test(route) ? ["Organization", "WebPage", "ItemList", "BreadcrumbList"]
    : /^\/(features|stores|sdks|solutions|compare)\//.test(route) ? ["Organization", "WebPage", "FAQPage", "BreadcrumbList"]
    : route.startsWith("/integrations/") ? ["Organization", "WebPage", "HowTo", "FAQPage", "BreadcrumbList"]
    : route.startsWith("/charts/") ? ["Organization", "TechArticle", "FAQPage", "BreadcrumbList"]
    : route === "/404" ? ["Organization"] : ["Organization", "BreadcrumbList"]);
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
    const og = html.match(/<meta property="og:image" content="https:\/\/revenuedot\.app(\/[^"]+)"/)?.[1];
    if (og && !existsSync(path.join(dist, og))) fail(route, `og:image ${og} is not in dist (run node --experimental-strip-types scripts/og.mjs)`);
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
        // Site FAQs render as <summary>; blog FAQs are "### Question" headings.
        const headings = [...html.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/#$/, "").trim());
        for (const q of node.mainEntity ?? []) if (!html.includes(`<summary>${q.name.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;")}</summary>`) && !html.includes(`<summary>${q.name}</summary>`) && !headings.includes(q.name)) fail(route, `FAQ question not visible: ${q.name}`);
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
  for (const t of typesFor(route)) if (!types.has(t)) fail(route, `missing JSON-LD ${t}`);

  // Internal links and assets (outside inline scripts, whose template strings are not links)
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  for (const m of markup.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:|#)/.test(u)) {
      if (u.startsWith(SITE)) {
        links++;
        const { pathname, hash } = new URL(u);
        if (!resolves(pathname)) fail(route, `broken absolute link ${u}`);
        else if (!anchorOk(pathname + hash)) fail(route, `missing anchor ${u}`);
      }
      continue;
    }
    links++;
    const target = u.startsWith("/") ? u : path.posix.join(path.posix.dirname(route), u);
    if (!resolves(target)) fail(route, `broken link ${u}`);
    else if (!anchorOk(target)) fail(route, `missing anchor ${u}`);
  }
  for (const m of markup.matchAll(/srcset="([^"]+)"/g)) for (const part of m[1].split(",")) {
    const u = part.trim().split(/\s+/)[0];
    links++;
    if (!resolves(u)) fail(route, `broken srcset ${u}`);
  }
  // Anchor targets on the same page
  for (const m of markup.matchAll(/href="#([^"]+)"/g)) if (!html.includes(`id="${m[1]}"`)) fail(route, `missing anchor #${m[1]}`);
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
if (!llms.includes(`${SITE}/llms-full.txt`)) fail("llms.txt", "does not link llms-full.txt");

// Every revenuedot.app URL in a text file resolves, with its anchor.
const urlRe = /https:\/\/revenuedot\.app(\/[A-Za-z0-9_.\/#%-]*)?/g;
const checkUrls = (where, text) => {
  for (const m of text.matchAll(urlRe)) {
    const p = (m[1] ?? "/").replace(/[.,;:]+$/, "");
    if (!resolves(p)) fail(where, `broken link ${SITE}${p}`);
    else if (!anchorOk(p)) fail(where, `missing anchor ${SITE}${p}`);
  }
};

// Markdown twins and llms files
const textFiles = files.filter((f) => /\.(md|txt)$/.test(f));
for (const f of textFiles) checkUrls("/" + path.relative(dist, f), readFileSync(f, "utf8"));
for (const f of htmlFiles) {
  const r = "/" + path.relative(dist, f).replace(/\\/g, "/").replace(/\.html$/, "");
  if (!(r === "/docs" || r.startsWith("/docs/") || r === "/blog" || r.startsWith("/blog/"))) continue;
  const twin = path.join(dist, r + ".md");
  if (!existsSync(twin)) { fail(r, "no .md twin"); continue; }
  const md = readFileSync(twin, "utf8");
  if (!md.startsWith("---\ntitle: ") || !md.includes(`\nurl: ${SITE}${r}\n`)) fail(r + ".md", "missing frontmatter with title and url");
  if (/\]\((?!https?:|mailto:|#)[^)]+\)/.test(md.replace(/```[\s\S]*?```/g, ""))) fail(r + ".md", "has a relative link");
}
for (const f of ["llms-full.txt", "llms/api.txt"]) if (!existsSync(path.join(dist, f))) fail(f, "missing");
if (!existsSync(path.join(dist, "pagefind/pagefind.js"))) fail("pagefind", "search index not built (pnpm build runs pagefind)");
for (const [from, to] of redirectRules) if (to?.startsWith("/") && !resolves(to.split("#")[0])) fail("_redirects", `${from} points to missing ${to}`);

// revenuedot.app/docs and /blog URLs used anywhere in the workspace (the sibling repos of this monorepo).
const workspace = path.resolve(dist, "../../../..");
const repos = process.env.CHECK_WORKSPACE === "0" ? [] : readdirSync(workspace).filter((d) => !d.startsWith(".") && existsSync(path.join(workspace, d, ".git")));
let workspaceUrls = 0;
for (const repo of repos) {
  let out = "";
  try {
    out = execFileSync("git", ["-C", path.join(workspace, repo), "grep", "--untracked", "-I", "-hoE", "https?://revenuedot\\.app/(docs|blog)[A-Za-z0-9_./#%-]*", "--", ".", ":!**/dist/**", ":!**/.cloudflare/**"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.status !== 1) fail(repo, `git grep failed: ${e.message}`);
    continue;
  }
  for (const u of new Set(out.split("\n").filter(Boolean))) {
    const p = u.replace(/^https?:\/\/revenuedot\.app/, "").replace(/[.,;:]+$/, "").replace(/#$/, "");
    workspaceUrls++;
    if (!resolves(p)) fail(`workspace ${repo}`, `revenuedot.app${p} does not resolve (add the page or a line in public/_redirects)`);
    else if (!anchorOk(p)) fail(`workspace ${repo}`, `revenuedot.app${p}: missing anchor`);
  }
}

console.log(`${htmlFiles.length} pages, ${links} internal links and assets, ${ldBlocks} JSON-LD blocks, ${locs.length} sitemap URLs, ${textFiles.length} Markdown and llms files, ${workspaceUrls} docs URLs from ${repos.length} workspace repos`);
if (errors.length) { console.error(errors.map((e) => "  ✗ " + e).join("\n")); process.exit(1); }
console.log("✓ all checks passed");
