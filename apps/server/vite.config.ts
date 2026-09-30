// Builds the Cloudflare Worker for RevenueDot Cloud (config: cloudflare.config.ts). The dashboard is built by its own
// package (`pnpm --filter @revenuedot/dashboard build`); its dist/ is copied into the Worker's static assets.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "../dashboard/dist",
  plugins: [cloudflare()],
});
