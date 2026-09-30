// Builds the site, runs the checks, then deploys dist/ to Cloudflare (revenuedot.app and www.revenuedot.app) with the
// `cf` CLI (config: cloudflare.config.ts).
//   pnpm --filter site run deploy            (note "run": `pnpm deploy` is a built-in pnpm command)
//   pnpm --filter site run deploy -- --dry-run   builds and validates the upload without publishing
// Needs Node 22.18 or newer and `cf auth login` with access to the Circo Cloudflare account. The build reads the docs
// repo (../../../docs, or DOCS_DIR). Set PUBLIC_CF_WEB_ANALYTICS_TOKEN to include the cookieless analytics beacon.
// `cf build` would run `astro build` without the Pagefind step, so this runs the site's own build and then packages
// dist/ with the Cloudflare Vite plugin (vite.config.ts) and deploys that output with --prebuilt.
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cwd = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "5a8f4d72ace5f438725e1dfd1b0380ff",
  // No containers here. Without this the packaging step waits on `docker image ls` when Docker is installed but not running.
  WRANGLER_DOCKER_BIN: process.env.WRANGLER_DOCKER_BIN ?? "false",
};
const run = (cmd) => execSync(cmd, { cwd, stdio: "inherit", env });
const extra = process.argv.slice(2).filter((a) => a !== "--").join(" ");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`cf needs Node 22.18 or newer to load cloudflare.config.ts (this is ${process.version}).`);
  process.exit(1);
}

run("pnpm run build");
run("pnpm run check");
if (!process.env.PUBLIC_CF_WEB_ANALYTICS_TOKEN) console.warn("Note: PUBLIC_CF_WEB_ANALYTICS_TOKEN is unset, so the build has no analytics beacon.");
run("pnpm exec cf-vite build");
run(`pnpm exec cf deploy --prebuilt ${extra}`.trim());
