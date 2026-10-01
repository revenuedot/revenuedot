// Captures one dashboard screenshot per chart and per integration for /charts/* and /integrations/* from the seeded
// e2e server. Start it first: (cd apps/dashboard && npx vite build && PORT=5500 npx tsx e2e/server.ts)
//   node --experimental-strip-types apps/site/scripts/capture-seo.mjs [charts|integrations]
// Then compress: the PNGs are quantized with sharp (see the end of this file). Delete captures of empty charts.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../dashboard/package.json"));
const { chromium } = require("@playwright/test");
const D = path.join(here, "../src/data");
const charts = [...(await import(`${D}/charts-a.ts`)).CHARTS_A, ...(await import(`${D}/charts-b.ts`)).CHARTS_B];
const ints = [...(await import(`${D}/integrations-a.ts`)).INTEGRATIONS_A, ...(await import(`${D}/integrations-b.ts`)).INTEGRATIONS_B];
const out = path.join(here, "../src/assets/screens");
const only = process.argv[2];
const base = process.env.RD_DASHBOARD ?? "http://localhost:5500";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
const page = await ctx.newPage();
await page.goto(`${base}/login`);
await page.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
await page.getByLabel("Password").fill("e2e-password-1");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL(/\/projects\/[^/]+\//);
const pid = page.url().match(/\/projects\/([^/]+)\//)[1];
const shoot = async (url, file) => {
  await page.goto(`${base}/projects/${pid}/${url}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(900);
  mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  console.log("wrote", file);
};
if (!only || only === "charts") for (const c of charts) await shoot(`charts/${c.name}`, `${out}/charts/${c.slug}.png`);
if (!only || only === "integrations") for (const i of ints) {
  const url = i.kind === "webhooks" ? "integrations/webhooks" : i.kind === "data-exports" ? "integrations/exports" : `integrations/${i.kind}`;
  await shoot(url, `${out}/integrations/${i.slug}.png`);
}
if (only && !["charts", "integrations"].includes(only)) await shoot(only, `${out}/probe.png`);
await browser.close();
const sharp = createRequire(path.join(here, "../package.json"))("sharp");
for (const d of ["charts", "integrations"]) for (const f of readdirSync(path.join(out, d))) {
  const p = path.join(out, d, f);
  writeFileSync(p, await sharp(readFileSync(p)).png({ palette: true, quality: 92, effort: 8 }).toBuffer());
}
