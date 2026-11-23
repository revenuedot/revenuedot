// The date the marketing pages last changed: the last commit that touched apps/site (YYYY-MM-DD), so the sitemap's
// <lastmod>, each page's article:modified_time and the WebPage JSON-LD dateModified all carry the same real date.
// Docs pages and blog posts use their own file's last commit instead (lib/docs.ts lastModified). Outside a git checkout
// (a tarball build) it falls back to the build date.
import { execFileSync } from "node:child_process";

function lastSiteCommit(): string | undefined {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", "."], { cwd: process.cwd(), encoding: "utf8" }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

export const SITE_MODIFIED: string = lastSiteCommit() ?? new Date().toISOString().slice(0, 10);
