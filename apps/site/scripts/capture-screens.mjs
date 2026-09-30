// Captures real dashboard screenshots for the site from the seeded e2e server.
//   pnpm --filter @revenuedot/dashboard build && pnpm --filter @revenuedot/dashboard e2e:server   (port 5199)
//   node apps/site/scripts/capture-screens.mjs
// Uses the e2e seed account from apps/dashboard/e2e/README.md. Writes PNGs to apps/site/src/assets/screens/.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../dashboard/package.json"));
const { chromium } = require("@playwright/test");

const base = process.env.RD_DASHBOARD ?? "http://localhost:5199";
const email = process.env.RD_EMAIL ?? "e2e@revenuedot.test";
const password = process.env.RD_PASSWORD ?? "e2e-password-1";
const out = path.join(here, "../src/assets/screens");
mkdirSync(out, { recursive: true });

const shots = [
  { name: "overview", path: "overview" },
  { name: "customers", path: "customers" },
  { name: "offerings", path: "product-catalog/offerings" },
];

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/projects\/[^/]+\//);
  const projectId = page.url().match(/\/projects\/([^/]+)\//)[1];
  for (const s of shots) {
    if (scheme === "dark" && s.name !== "overview") continue;
    await page.goto(`${base}/projects/${projectId}/${s.path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    const file = path.join(out, `${s.name}-${scheme}.png`);
    await page.screenshot({ path: file });
    console.log("wrote", file);
  }
  // Customer detail: open the first customer in the list.
  if (scheme === "light") {
    await page.goto(`${base}/projects/${projectId}/customers`);
    await page.waitForLoadState("networkidle");
    await page.locator("table tbody tr", { hasText: "iOS" }).filter({ hasText: "$39.99" }).first().click();
    await page.waitForURL(/\/customers\/.+/);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    const file = path.join(out, "customer-light.png");
    await page.screenshot({ path: file });
    console.log("wrote", file);
  }
  await ctx.close();
}
await browser.close();
