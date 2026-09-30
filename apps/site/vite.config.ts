// Packages the Astro build for `cf build` / `cf deploy` (config: cloudflare.config.ts). Astro does not read this file;
// `pnpm run build` produces dist/, which becomes the Worker's static assets (including _headers and _redirects).
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({ publicDir: "dist", plugins: [cloudflare()] });
