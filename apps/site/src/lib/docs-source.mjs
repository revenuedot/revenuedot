// Where the revenuedot/docs repo lives at build time, and how its files map to URLs on revenuedot.app.
// Plain JS so astro.config.mjs (the Markdown plugin) and the pages share one mapping.
import { existsSync } from "node:fs";
import path from "node:path";

export const SITE_URL = "https://revenuedot.app";
export const DOCS_REPO = "https://github.com/revenuedot/docs";
const RAW = "https://raw.githubusercontent.com/revenuedot/docs/main/";

/** Absolute path of the docs repo. astro.config.mjs resolves it once (DOCS_DIR, default ../../../docs from apps/site). */
export function docsDir() {
  return process.env.REVENUEDOT_DOCS_DIR_RESOLVED ?? path.resolve(process.cwd(), process.env.DOCS_DIR ?? "../../../docs");
}

/** Fails the build with instructions when the docs repo is not checked out. */
export function assertDocsDir(dir = docsDir()) {
  for (const sub of ["docs", "api", "blog", "llms.txt"]) {
    if (!existsSync(path.join(dir, sub))) {
      throw new Error(
        `RevenueDot docs not found: ${path.join(dir, sub)} is missing.\n` +
          `The site renders /docs and /blog from the revenuedot/docs repo. Clone it next to this monorepo:\n` +
          `  git clone https://github.com/revenuedot/docs ../docs   (from the monorepo root)\n` +
          `or set DOCS_DIR to its path (relative to apps/site).`,
      );
    }
  }
  return dir;
}

/** URL path of a docs-repo Markdown page (docs/x/y.md → /docs/x/y, README.md → its folder), or null for other files. */
export function pagePath(rel) {
  const r = rel.replace(/\\/g, "/");
  if (r === "README.md") return "/docs";
  let out;
  if (r.startsWith("docs/")) out = "/docs/" + r.slice(5);
  else if (r.startsWith("api/")) out = "/docs/api/" + r.slice(4);
  else if (r.startsWith("blog/")) out = "/blog/" + r.slice(5);
  else return null;
  if (!out.endsWith(".md")) return null;
  return out.replace(/\.md$/, "").replace(/\/README$/, "");
}

/** URL path for any docs-repo file: pages, their .md twins, the OpenAPI document and the llms files; else GitHub. */
export function fileUrl(rel, { md = false, dir = docsDir() } = {}) {
  const r = rel.replace(/\\/g, "/").replace(/\/$/, "");
  const page = pagePath(r);
  if (page) return md ? `${page}.md` : page;
  if (r === "api/openapi.yaml") return "/docs/api/openapi.yaml";
  if (r === "llms.txt" || r === "llms-full.txt" || /^llms\/[a-z0-9-]+\.txt$/.test(r)) return `/${r}`;
  if (!/\.[a-z0-9]+$/i.test(r) && existsSync(path.join(dir, r, "README.md"))) return fileUrl(`${r}/README.md`, { md, dir });
  const isDir = !/\.[a-z0-9]+$/i.test(r);
  return `${DOCS_REPO}/${isDir ? "tree" : "blob"}/main/${r}`;
}

/**
 * Rewrites one link found in docs-repo file `fromRel`. Relative links become site URLs (absolute when `absolute`);
 * links to the docs repo on GitHub become site URLs too. Returns null when the link should stay as it is.
 */
export function rewriteHref(fromRel, href, { md = false, absolute = false, dir = docsDir() } = {}) {
  if (!href || href.startsWith("#") || href.startsWith("/") || /^(mailto|tel|data):/i.test(href)) return null;
  const hashAt = href.indexOf("#");
  const target = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  let rel;
  if (/^https?:/i.test(target)) {
    const m = /^https:\/\/(?:github\.com\/revenuedot\/docs\/(?:blob|tree)\/main\/|raw\.githubusercontent\.com\/revenuedot\/docs\/main\/)(.*)$/.exec(target);
    if (!m) return null;
    rel = m[1];
  } else {
    rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel.replace(/\\/g, "/")), target));
    if (rel.startsWith("../")) {
      // A sibling repo in the workspace (../revenuedot/x): link to it on GitHub.
      const [, repo, ...rest] = rel.split("/");
      return `https://github.com/revenuedot/${repo}${rest.length ? `/blob/main/${rest.join("/")}` : ""}${hash}`;
    }
  }
  const url = fileUrl(rel, { md, dir });
  return (absolute && url.startsWith("/") ? SITE_URL + url : url) + hash;
}

/** Rewrites every Markdown link outside fenced code in a docs-repo file (for the .md twins). */
export function rewriteMarkdownLinks(fromRel, body, opts = {}) {
  let fence = null;
  return body
    .split("\n")
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return line;
      }
      if (fence) return line;
      return line.replace(/(\]\()([^)\s]+)(\))/g, (m, open, href, close) => {
        const out = rewriteHref(fromRel, href, opts);
        return out ? `${open}${out}${close}` : m;
      });
    })
    .join("\n");
}

/** Points the generated llms files at revenuedot.app instead of raw GitHub: pages → .md twins, llms files → site root. */
export function rewriteLlmsText(text, dir = docsDir()) {
  return text.replace(
    /https:\/\/(?:raw\.githubusercontent\.com\/revenuedot\/docs\/main\/|github\.com\/revenuedot\/docs\/blob\/main\/)([A-Za-z0-9_./-]+[A-Za-z0-9_/-])/g,
    (m, rel) => {
      const url = fileUrl(rel, { md: true, dir });
      return url.startsWith("/") ? SITE_URL + url : m;
    },
  );
}
