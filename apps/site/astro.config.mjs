import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://revenuedot.app",
  output: "static",
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "always" },
  compressHTML: true,
  // The shared design tokens live at the repo root (design/tokens.css).
  vite: { server: { fs: { allow: ["../.."] } } },
});
