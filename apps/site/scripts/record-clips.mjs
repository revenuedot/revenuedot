// Records the short silent product clips in public/clips from the seeded e2e dashboard, with a visible cursor.
// Start the e2e server first (see capture-seo.mjs), then:
//   node apps/site/scripts/record-clips.mjs [charts|paywalls|funnels|integrations]
// and encode each: ffmpeg -ss 0.6 -i raw/<name>.webm -an -vf "scale=1280:-2,fps=24" -c:v libx264 -preset slow -crf 30
//   -pix_fmt yuv420p -movflags +faststart public/clips/<name>.mp4  (poster: a frame at 2.5s as public/clips/<name>.webp).
// The funnels clip needs a funnel: create one from the starter in the dashboard first.
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../dashboard/package.json"));
const { chromium } = require("@playwright/test");
const base = process.env.RD_DASHBOARD ?? "http://localhost:5500";
const raw = path.join(here, "../.clips-raw");
const only = process.argv[2];
mkdirSync(raw, { recursive: true });
const CURSOR = `(() => { const c = document.createElement('div'); c.id='__c'; c.style.cssText='position:fixed;z-index:2147483647;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(10,10,10,.85);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.2);pointer-events:none;transition:transform .12s'; document.addEventListener('DOMContentLoaded',()=>document.body.appendChild(c)); if(document.body) document.body.appendChild(c); addEventListener('mousemove',e=>{c.style.left=e.clientX+'px';c.style.top=e.clientY+'px'}); addEventListener('mousedown',()=>c.style.transform='scale(.7)'); addEventListener('mouseup',()=>c.style.transform='scale(1)'); })()`;
const browser = await chromium.launch();
async function session() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  const p = await ctx.newPage();
  await p.goto(`${base}/login`);
  await p.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
  await p.getByLabel("Password").fill("e2e-password-1");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/\/projects\/[^/]+\//);
  const pid = p.url().match(/\/projects\/([^/]+)\//)[1];
  const state = await ctx.storageState();
  await ctx.close();
  return { pid, state };
}
const { pid, state } = await session();
async function clip(name, fn) {
  if (only && only !== name) return;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", storageState: state, recordVideo: { dir: `${raw}/${name}`, size: { width: 1280, height: 800 } } });
  await ctx.addInitScript(CURSOR);
  const p = await ctx.newPage();
  const go = async (path) => { await p.goto(`${base}/projects/${pid}/${path}`); await p.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {}); await p.mouse.move(640, 400); await p.waitForTimeout(700); };
  const click = async (loc) => { await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); const b = await loc.boundingBox({ timeout: 3000 }).catch(() => null); if (!b) return; await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 }); await p.waitForTimeout(250); await p.mouse.down(); await p.mouse.up(); await loc.click({ timeout: 3000 }).catch(() => {}); await p.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {}); await p.waitForTimeout(1100); };
  await fn(p, go, click);
  await p.waitForTimeout(600);
  await ctx.close();
  const f = readdirSync(`${raw}/${name}`).find((x) => x.endsWith(".webm"));
  renameSync(`${raw}/${name}/${f}`, `${raw}/${name}.webm`); rmSync(`${raw}/${name}`, { recursive: true });
  console.log("recorded", name);
}
await clip("charts", async (p, go, click) => {
  await go("charts/mrr");
  for (const n of ["Revenue", "Active Subscriptions", "Trial Conversion Funnel", "Subscription Status", "MRR Movement"]) await click(p.getByRole("link", { name: n, exact: true }).first());
});
await clip("paywalls", async (p, go, click) => {
  await go("paywalls/templates");
  await p.mouse.move(400, 500, { steps: 10 }); await p.waitForTimeout(500);
  await click(p.getByRole("button", { name: "Use template Trial timeline" }));
  await click(p.getByRole("button", { name: "Create paywall" }));
  await p.waitForTimeout(1500);
  for (const t of [/Unlock|How your free trial/, /Yearly/]) { const l = p.getByText(t).first(); if (await l.count()) await click(l); }
  for (const t of ["Dark", "Light"]) { const b = p.getByRole("button", { name: t, exact: true }).first(); if (await b.count()) await click(b); }
});
await clip("funnels", async (p, go, click) => {
  await go("funnels");
  await click(p.getByText("Onboarding funnel").first());
  for (const t of ["Your plan is ready", "Where should we", "Unlock your full", "You are in", "What do you want"]) await click(p.getByText(t).first());
});
await clip("integrations", async (p, go, click) => {
  await go("integrations");
  await p.mouse.wheel(0, 400); await p.waitForTimeout(1000);
  await click(p.getByRole("link", { name: /Amplitude/ }).first());
  await p.mouse.wheel(0, 500); await p.waitForTimeout(1200);
});
await browser.close();
