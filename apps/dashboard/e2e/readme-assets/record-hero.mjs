// Records the README hero tour (Overview → MRR chart → paywall editor → experiment results) at 1280x800 with a cursor.
// SCHEME=dark records the dark twin (the dashboard follows the browser's colour scheme) into hero-dark.webm.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const base = process.env.RD_DASHBOARD ?? "http://localhost:5500";
const scratch = process.env.OUT ?? new URL("../../.readme-assets", import.meta.url).pathname;
const ids = JSON.parse(readFileSync(`${scratch}/ids.json`, "utf8"));
const scheme = process.env.SCHEME === "dark" ? "dark" : "light";
const out = scheme === "dark" ? "hero-dark" : "hero";
const raw = `${scratch}/${out}-raw`;
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
const CURSOR = `(() => { const c = document.createElement('div'); c.id='__c'; c.style.cssText='position:fixed;z-index:2147483647;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(10,10,10,.85);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.2);pointer-events:none;transition:transform .12s'; document.addEventListener('DOMContentLoaded',()=>document.body.appendChild(c)); if(document.body) document.body.appendChild(c); addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'}); addEventListener('mousedown',()=>c.style.transform='scale(.7)'); addEventListener('mouseup',()=>c.style.transform='scale(1)'); })()`;
const browser = await chromium.launch();
const login = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
{
  const p = await login.newPage();
  await p.goto(`${base}/login`);
  await p.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
  await p.getByLabel("Password").fill("e2e-password-1");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/\/projects\/[^/]+\//);
}
const state = await login.storageState();
await login.close();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, storageState: state, recordVideo: { dir: raw, size: { width: 1280, height: 800 } } });
await ctx.addInitScript(CURSOR);
const p = await ctx.newPage();
const pid = ids.pid;
const move = async (x, y, steps = 24) => { await p.mouse.move(x, y, { steps }); };
const click = async (loc, after = 900) => {
  await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  const b = await loc.boundingBox({ timeout: 3000 }).catch(() => null);
  if (!b) { console.log("no box for", await loc.toString()); return; }
  await move(b.x + b.width / 2, b.y + b.height / 2, 14);
  await p.waitForTimeout(160);
  await p.mouse.down(); await p.mouse.up();
  await p.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await p.waitForTimeout(after);
};
// 1. Overview: settle, glide across the KPI cards.
await p.goto(`${base}/projects/${pid}/overview`);
await p.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
await move(520, 420, 2);
await p.waitForTimeout(600);
await move(760, 300, 22);
await p.waitForTimeout(200);
await move(1120, 300, 22);
await p.waitForTimeout(350);
// 2. A chart: Analytics → Charts, then MRR.
await click(p.getByRole("button", { name: "Analytics" }).first(), 350);
await click(p.getByRole("link", { name: "Charts", exact: true }).first(), 800);
await click(p.getByRole("link", { name: "MRR", exact: true }).first(), 1100);
// 3. The paywall editor: open the paywall, pick a layer, switch its colour scheme.
await click(p.getByRole("link", { name: "Paywalls", exact: true }).first(), 800);
await click(p.locator("table tbody tr").first(), 1200);
const headline = p.getByRole("figure", { name: "Paywall preview" }).getByText(/How your free trial works/).first();
if (await headline.count()) await click(headline, 700);
for (const t of [scheme === "dark" ? "Light" : "Dark"]) { const b = p.getByRole("button", { name: t, exact: true }).first(); if (await b.count()) await click(b, 650); }
// 4. Experiment results.
await click(p.getByRole("link", { name: "Experiments", exact: true }).first(), 800);
await click(p.locator("table tbody tr", { hasText: "Annual plan first" }).first().or(p.getByText("Annual plan first on the paywall").first()), 500);
await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
await p.getByLabel("Environment").selectOption("sandbox").catch(() => {});
await p.waitForTimeout(400);
await p.evaluate(() => { const el = document.querySelector("#xp-results"); ((el?.closest(".card, section")) ?? el)?.scrollIntoView({ behavior: "smooth", block: "start" }); });
await move(700, 560, 24);
await p.waitForTimeout(1500);
await ctx.close();
const f = readdirSync(raw).find((x) => x.endsWith(".webm"));
renameSync(`${raw}/${f}`, `${scratch}/${out}.webm`);
console.log("recorded", `${scratch}/${out}.webm`);
await browser.close();
