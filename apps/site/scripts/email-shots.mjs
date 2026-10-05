// Product screenshots for the onboarding emails (prd/onboarding-emails/PRD.md): the real dashboard on the seeded e2e server,
// framed in a browser window on a light ground, 1200x675 JPEG in public/email/shots/<name>.jpg.
//   pnpm --filter @revenuedot/dashboard build && PORT=5231 pnpm --filter @revenuedot/dashboard e2e:server
//   RD_DASHBOARD=http://localhost:5231 node apps/site/scripts/email-shots.mjs [name ...]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(here, "../../dashboard/package.json"))("@playwright/test");
const base = process.env.RD_DASHBOARD ?? "http://localhost:5199";
const out = path.join(here, "../public/email/shots");
mkdirSync(out, { recursive: true });
const only = new Set(process.argv.slice(2));

/** Each shot: the account, the page, an optional click to reach a detail page, and the part of the window to keep. */
// `clip`: the part of the 1440x900 window (CSS pixels) that matters, about 1.81:1 so it fills the frame.
const SHOTS = [
  { name: "checklist", account: "fresh", path: "overview", clip: { x: 240, y: 70, width: 1000, height: 552 } },
  { name: "overview", path: "overview", clip: { x: 236, y: 56, width: 1100, height: 608 } },
  { name: "customers", path: "customers", clip: { x: 236, y: 56, width: 1100, height: 608 } },
  { name: "apps", path: "apps", clip: { x: 236, y: 56, width: 1100, height: 608 } },
  { name: "app-store", path: "apps", open: (p) => p.locator("table tbody tr, a", { hasText: /App Store/ }).first(), clip: { x: 430, y: 60, width: 900, height: 497 } },
  { name: "api-keys", path: "api-keys", clip: { x: 236, y: 56, width: 900, height: 497 } },
  { name: "paywall-templates", path: "paywalls/templates", clip: { x: 500, y: 150, width: 940, height: 519 } },
  { name: "experiments", path: "experiments", clip: { x: 236, y: 56, width: 960, height: 530 } },
  { name: "recovery", path: "lifecycle/payment-recovery", clip: { x: 236, y: 56, width: 1100, height: 608 } },
  { name: "team", path: "settings/collaborators", clip: { x: 360, y: 56, width: 900, height: 497 } },
  { name: "charts", path: "charts", clip: { x: 236, y: 56, width: 1100, height: 608 } },
];
const ACCOUNTS = { seeded: "e2e@revenuedot.test", fresh: "fresh@revenuedot.test" };

const browser = await chromium.launch();
const shotPage = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1 });
for (const account of ["seeded", "fresh"]) {
  const list = SHOTS.filter((s) => (s.account ?? "seeded") === account && (!only.size || only.has(s.name)));
  if (!list.length) continue;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(`${base}/login`);
  await page.getByLabel("Email", { exact: true }).fill(ACCOUNTS[account]);
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/projects\/[^/]+\//);
  const projectId = page.url().match(/\/projects\/([^/]+)\//)[1];
  for (const s of list) {
    await page.goto(`${base}/projects/${projectId}/${s.path}`);
    await page.waitForLoadState("networkidle");
    if (s.open) { await s.open(page).click(); await page.waitForLoadState("networkidle"); }
    await page.waitForTimeout(700);
    const png = await page.screenshot({ type: "png", clip: s.clip });
    // The frame: a window holding the clipped part of the dashboard, on a light ground, running off the bottom edge.
    await shotPage.setContent(`<!doctype html><html><head><style>
      *{margin:0;box-sizing:border-box}body{width:1200px;height:675px;overflow:hidden;background:#F2F2F2}
      .win{position:absolute;left:60px;top:48px;width:1080px;border:1px solid #DADADA;background:#fff;box-shadow:0 24px 60px rgba(0,0,0,.10)}
      .bar{height:30px;border-bottom:1px solid #E5E5E5;display:flex;gap:7px;align-items:center;padding:0 12px;background:#FAFAFA}
      .bar i{width:10px;height:10px;border-radius:50%;background:#D4D4D4;display:block}
      .shot{display:block;width:1080px;height:auto}
    </style></head><body><div class="win"><div class="bar"><i></i><i></i><i></i></div>
      <img class="shot" src="data:image/png;base64,${png.toString("base64")}"></div></body></html>`, { waitUntil: "load" });
    const file = path.join(out, `${s.name}.jpg`);
    await shotPage.screenshot({ path: file, type: "jpeg", quality: 84 });
    console.log("wrote", file);
  }
  await ctx.close();
}
await browser.close();
