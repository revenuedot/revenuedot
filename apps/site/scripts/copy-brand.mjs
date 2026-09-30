// Copies favicons and the social card from brand/kit into public/ so the brand kit stays the single source.
import { copyFileSync, mkdirSync } from "node:fs";
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
