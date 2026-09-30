// revenuedot.app marketing site: static assets on Cloudflare Workers (no Worker script), deployed with the `cf` CLI.
// Deploy only after approval: pnpm --filter site run deploy. vite.config.ts hands the Astro build (dist/) to cf as the
// Worker's static assets. www.revenuedot.app redirects to the apex with a zone redirect rule (docs/cloud.md).
import { defineConfig } from "cf/config";

export default defineConfig({
  // The Circo account. Every `cf` command run from this folder targets it unless CLOUDFLARE_ACCOUNT_ID says otherwise.
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "5a8f4d72ace5f438725e1dfd1b0380ff",
  worker: {
    name: "revenuedot-site",
    compatibilityDate: "2026-09-01",
    assets: { htmlHandling: "drop-trailing-slash", notFoundHandling: "404-page" },
    domains: ["revenuedot.app", "www.revenuedot.app"],
  },
});
