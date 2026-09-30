// Screenshots every page of the built site at desktop (1440) and phone (390) width, and fails on horizontal scroll.
//   pnpm --filter site build && pnpm --filter site preview   (port 4322)
//   node apps/site/scripts/shoot-site.mjs [--dark]
// Writes to apps/site/screenshots/ (gitignored).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../dashboard/package.json"));
const { chromium } = require("@playwright/test");

const base = process.env.SITE_URL ?? "http://localhost:4322";
const dark = process.argv.includes("--dark");
const out = path.join(here, "../screenshots");
mkdirSync(out, { recursive: true });
const sitemap = readFileSync(path.join(here, "../dist/sitemap.xml"), "utf8");
const paths = [...sitemap.matchAll(/<loc>https:\/\/revenuedot\.app([^<]*)<\/loc>/g)].map((m) => m[1] || "/").concat("/404");

const browser = await chromium.launch();
let failures = 0;
for (const [label, width, height] of [["desktop", 1440, 900], ["mobile", 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: label === "mobile" ? 2 : 1, colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  for (const p of paths) {
    await page.goto(base + (p === "/404" ? "/this-page-does-not-exist" : p), { waitUntil: "networkidle" });
    // Scroll through once so lazy images load before the full-page capture.
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } window.scrollTo(0, 0); });
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll("body *")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > w + 1 && !el.closest("details:not([open]) > :not(summary), .table-wrap, pre, .code");
      }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);
      return { scroll: document.documentElement.scrollWidth > w, wide, bg: getComputedStyle(document.body).backgroundColor };
    });
    const name = `${label}${dark ? "-dark" : ""}${p === "/" ? "-home" : p.replaceAll("/", "-")}.png`;
    await page.screenshot({ path: path.join(out, name), fullPage: true });
    const wantBg = dark ? "rgb(10, 10, 10)" : "rgb(255, 255, 255)";
    if (overflow.bg !== wantBg) { failures++; console.log(`BACKGROUND ${label} ${p} is ${overflow.bg}, want ${wantBg}`); }
    if (overflow.scroll || overflow.wide.length) { failures++; console.log(`OVERFLOW ${label} ${p}`, overflow.wide.join(", ")); }
    else console.log(`ok ${label} ${p}`);
  }
  await ctx.close();
}
await browser.close();
console.log(failures ? `${failures} page(s) overflow` : "no horizontal scroll on any page");
process.exit(failures ? 1 : 0);
