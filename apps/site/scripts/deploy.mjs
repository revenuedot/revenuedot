// Builds the site, runs the checks, then deploys dist/ to Cloudflare (revenuedot.app and www.revenuedot.app).
//   pnpm --filter site run deploy            (note "run": `pnpm deploy` is a built-in pnpm command)
//   pnpm --filter site run deploy -- --dry-run   builds and validates the upload without publishing
// Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) on the Circo Cloudflare account. Set PUBLIC_CF_WEB_ANALYTICS_TOKEN
// to include the cookieless analytics beacon.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd) => execSync(cmd, { cwd, stdio: "inherit" });
const extra = process.argv.slice(2).join(" ");

run("pnpm run build");
run("pnpm run check");
if (!process.env.PUBLIC_CF_WEB_ANALYTICS_TOKEN) console.warn("Note: PUBLIC_CF_WEB_ANALYTICS_TOKEN is unset, so the build has no analytics beacon.");
run(`pnpm exec wrangler deploy ${extra}`.trim());
