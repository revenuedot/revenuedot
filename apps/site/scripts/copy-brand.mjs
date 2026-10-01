// Copies favicons and the social card from brand/kit into public/ so the brand kit stays the single source.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const kit = path.join(here, "../../../brand");
const pub = path.join(here, "../public");
mkdirSync(pub, { recursive: true });
const files = {
  "kit/favicon/favicon.ico": "favicon.ico",
  "kit/favicon/favicon.svg": "favicon.svg",
  "kit/favicon/favicon-32.png": "favicon-32.png",
  "kit/favicon/apple-touch-icon.png": "apple-touch-icon.png",
  "kit/favicon/android-chrome-192.png": "android-chrome-192.png",
  "kit/favicon/android-chrome-512.png": "android-chrome-512.png",
  "kit-social/revenuedot.png": "og.png",
};
for (const [from, to] of Object.entries(files)) copyFileSync(path.join(kit, from), path.join(pub, to));
console.log(`copied ${Object.keys(files).length} brand files into public/`);

// Blog images live next to the posts in the docs repo (blog/assets/<post>/...) and are served from /blog/assets.
const docs = path.resolve(here, "..", process.env.DOCS_DIR ?? "../../../docs");
const blogAssets = path.join(docs, "blog/assets");
rmSync(path.join(pub, "blog"), { recursive: true, force: true });
if (existsSync(blogAssets)) {
  cpSync(blogAssets, path.join(pub, "blog/assets"), { recursive: true });
  console.log("copied blog/assets into public/blog/assets");
}
