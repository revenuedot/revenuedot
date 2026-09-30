import { defineConfig } from "astro/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { satteri } from "@astrojs/markdown-satteri";
import { docsHastPlugins } from "./src/lib/docs-markdown.mjs";
import { assertDocsDir } from "./src/lib/docs-source.mjs";
import { codeTheme } from "./src/lib/code-theme.mjs";

// /docs and /blog are rendered from the revenuedot/docs repo, checked out next to this monorepo by default
// (~/Developer/revenuedot/docs). DOCS_DIR overrides the path, relative to apps/site.
const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, process.env.DOCS_DIR ?? "../../../docs");
process.env.REVENUEDOT_DOCS_DIR_RESOLVED = docs;
assertDocsDir(docs);

export default defineConfig({
  site: "https://revenuedot.app",
  output: "static",
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "always" },
  compressHTML: true,
  markdown: {
    processor: satteri({ hastPlugins: docsHastPlugins }),
    // Straight quotes, like GitHub, so heading anchors match the links written in the docs repo.
    smartypants: false,
    shikiConfig: { theme: codeTheme, wrap: false, langAlias: { cron: "text" } },
  },
  // The shared design tokens live at the repo root (design/tokens.css); the docs repo sits next to the monorepo.
  vite: { server: { fs: { allow: ["../..", docs] } } },
});
