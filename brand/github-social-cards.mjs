// Renders the 1280x640 GitHub social preview cards (repo Settings → Social preview) in the dark card style the SDK forks use.
//   node brand/github-social-cards.mjs      writes brand/github-cards/<repo>.png; needs the dashboard and site node_modules (Playwright, fonts)
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "apps/dashboard/package.json"));
const { chromium } = require("@playwright/test");
const site = path.join(repo, "apps/site");
const b64 = (p) => readFileSync(p).toString("base64");
const font = `data:font/woff2;base64,${b64(path.join(site, "node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2"))}`;
const mono = `data:font/woff2;base64,${b64(path.join(site, "node_modules/@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2"))}`;
const mark = readFileSync(path.join(repo, "brand/kit/mark/revenuedot-mark-white.svg"), "utf8");

const CARDS = {
  revenuedot: ["The open-source RevenueCat alternative", "Open-source SDKs, server, paywalls, experiments and web checkout for subscription apps. Works with the RevenueCat SDK: switch with one line."],
  docs: ["RevenueDot docs", "Guides, API reference, SDK guides, migration from RevenueCat, self-hosting, help center, blog and llms.txt. Every page says what works today."],
  examples: ["RevenueDot examples", "36 runnable apps, webhook backends and self-host recipes: SwiftUI, Compose, Flutter, React Native, Next.js, Node, Python, Go, Rust, Ruby, Java and more."],
  mcp: ["RevenueDot MCP server", "38 tools for Claude, ChatGPT, Cursor and other agents: offerings, customers, entitlements, webhooks. Hosted at mcp.revenuedot.app."],
  "agent-skills": ["RevenueDot agent skills", "The Claude, ChatGPT and Codex plugin: add subscriptions, migrate from RevenueCat, self-host, support playbook and a weekly revenue check."],
};

const html = (name, title, sub) => `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Manrope;src:url(${font}) format("woff2");font-weight:200 800}
@font-face{font-family:"Geist Mono";src:url(${mono}) format("woff2");font-weight:500}
*{margin:0;box-sizing:border-box}body{width:1280px;height:640px;background:#0A0A0A;color:#fff;font-family:Manrope,sans-serif;position:relative;overflow:hidden}
.grid{position:absolute;inset:0;background-image:radial-gradient(#262626 1px,transparent 1px);background-size:28px 28px;background-position:14px 14px;opacity:.55;-webkit-mask-image:linear-gradient(90deg,transparent 35%,#000 100%)}
.brand{position:absolute;left:88px;top:84px;display:flex;align-items:center;gap:18px}
.brand svg{width:48px;height:48px}.brand span{font:700 50px/1 Manrope;letter-spacing:-.03em}
.h{position:absolute;left:88px;top:${title.length > 26 ? 272 : 330}px;width:1000px;font:700 72px/1.05 Manrope;letter-spacing:-.045em}
.s{position:absolute;left:88px;top:${title.length > 26 ? 428 : 436}px;width:1010px;font:400 27px/1.4 Manrope;color:#A3A3A3}
.f{position:absolute;left:88px;bottom:66px;font:500 22px/1 "Geist Mono",monospace;color:#737373}.f b{color:#F7B500;font-weight:500}
</style><div class="grid"></div><div class="brand">${mark}<span>RevenueDot</span></div><div class="h">${title}</div><div class="s">${sub}</div><div class="f">github.com/revenuedot/<b>${name}</b></div>`;

const out = path.join(repo, "brand/github-cards"); mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
for (const [name, [title, sub]] of Object.entries(CARDS)) {
  await page.setContent(html(name, title, sub));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log("wrote brand/github-cards/" + name + ".png");
}
await browser.close();
