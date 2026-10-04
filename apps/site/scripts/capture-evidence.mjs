// Evidence pack: dated screenshots of the vendor pages cited in src/data/compare.ts and src/data/alternatives.ts.
//   node apps/site/scripts/capture-evidence.mjs --full --crops [--only vendor[/page],...] [--date YYYY-MM-DD]
// Full pages: 1280 px wide at 1x, split every 4,000 CSS px. Crops: 2x, at most 1,600 px wide, around the element that holds
// the claim text (see evidence-pages.mjs). Cookie banners are declined or hidden. Then run gen-evidence.mjs to rebuild
// src/data/evidence.ts. Uses @playwright/test and sharp from the workspace.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PAGES } from "./evidence-pages.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const SITE = path.resolve(here, "..");
const OUT = path.join(SITE, "src/assets/evidence");
const SCRATCH = process.env.EVIDENCE_SCRATCH ?? path.join(SITE, ".evidence-scratch");
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const DATE = flag("--date") ?? "2026-10-04";
const require = createRequire(path.join(here, "../../dashboard/package.json"));
const { chromium } = require("@playwright/test");
const sharp = createRequire(path.join(SITE, "package.json"))("sharp");

const doFull = args.includes("--full");
const doCrops = args.includes("--crops");
const only = flag("--only") ? new Set(flag("--only").split(",")) : null;
mkdirSync(path.join(SCRATCH, "text"), { recursive: true });

const norm = (s) => s.replace(/\s+/g, " ").replace(/[’‘]/g, "'").toLowerCase();

async function shrink(fp, maxW, quality) {
  const img = sharp(fp);
  const meta = await img.metadata();
  const pipeline = meta.width > maxW ? img.resize({ width: maxW }) : img;
  writeFileSync(fp, await pipeline.png({ palette: true, quality, compressionLevel: 9, effort: 7 }).toBuffer());
}

const HIDE_CSS = `*, *::before, *::after { animation: none !important; transition: none !important; }`;

async function dismissCookies(page) {
  // Prefer declining. Then hide anything fixed or sticky that looks like a consent box.
  const decline = /^(reject all|reject all cookies|decline|decline all|reject|necessary only|only necessary|use necessary cookies only|refuse|refuse all|deny|deny all|no, thanks|no thanks|reject non-essential|essential only|only essential)$/i;
  for (const frame of page.frames()) {
    try {
      const buttons = frame.locator("button, a[role=button], [role=button], input[type=button]");
      const n = await buttons.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 200); i++) {
        const b = buttons.nth(i);
        const t = ((await b.innerText().catch(() => "")) || "").trim();
        if (decline.test(t) && (await b.isVisible().catch(() => false))) { await b.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(400); }
      }
    } catch {}
  }
  await page.evaluate(() => {
    const pat = /cookie|consent|onetrust|cookiebot|cky-|gdpr-banner|cc-window|cc-banner|usercentrics|termly|iubenda|osano|hs-eu-cookie/i;
    for (const el of document.querySelectorAll("body *")) {
      const id = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
      if (!pat.test(id)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.position === "sticky") el.style.setProperty("display", "none", "important");
    }
  }).catch(() => {});
}

async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await dismissCookies(page);
  await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
  // Scroll through to trigger lazy content, then back to the top.
  await page.evaluate(async () => {
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 90)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(800);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await dismissCookies(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
}

async function preparePre(page) {
  // Plain-text pages (llms.txt): wrap lines so they fit the viewport and can be located by text.
  await page.evaluate(() => {
    const pre = document.querySelector("pre");
    if (!pre) return;
    const lines = pre.textContent.split("\n");
    pre.textContent = "";
    pre.style.cssText = "white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;max-width:1200px;margin:16px;padding:0";
    for (const l of lines) { const d = document.createElement("div"); d.textContent = l || " "; d.className = "__line"; pre.appendChild(d); }
  });
}

async function cropRect(page, crop) {
  const { text, selector, minH = 320, maxH = 900, climb = 6 } = crop;
  let loc;
  if (selector) loc = page.locator(selector).first();
  else if (crop.pre) loc = page.locator(".__line", { hasText: text }).first();
  else loc = page.getByText(text, { exact: false }).first();
  if ((await loc.count()) === 0) return null;
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
  const r = await loc.evaluate((el, { minH, maxH, climb }) => {
    let node = el;
    let r = node.getBoundingClientRect();
    for (let i = 0; i < climb && node.parentElement && node.parentElement !== document.body; i++) {
      const p = node.parentElement;
      const pr = p.getBoundingClientRect();
      if (pr.height > maxH || pr.height === 0) break;
      node = p; r = pr;
      if (r.height >= minH) break;
    }
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height, cx: r.left + window.scrollX + r.width / 2, cy: r.top + window.scrollY + r.height / 2 };
  }, { minH, maxH, climb });
  let { x, y, w, h } = r;
  if (h < minH) { y = Math.max(0, r.cy - minH / 2); h = minH; }
  const minW = crop.minW ?? 760;
  if (w < minW) { x = Math.max(0, Math.min(1280 - minW, r.cx - minW / 2)); w = minW; }
  const pad = crop.pad ?? 20;
  x = Math.max(0, x - pad); y = Math.max(0, y - pad); w = Math.min(1280 - x, w + 2 * pad); h = h + 2 * pad;
  if (crop.extraTop) { const t = Math.min(crop.extraTop, y); y -= t; h += t; }
  if (crop.extraBottom) h += crop.extraBottom;
  return { x, y, width: w, height: h };
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: "light",
  locale: "en-US",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
const logPath = path.join(SCRATCH, "capture-log.json");
const prev = existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : [];
const results = [];
const save = () => writeFileSync(logPath, JSON.stringify([...prev.filter((e) => !results.some((r) => r.vendor === e.vendor && r.page === e.page)), ...results], null, 2));

for (const p of PAGES) {
  const key = `${p.vendor}/${p.page}`;
  if (only && !only.has(key) && !only.has(p.vendor)) continue;
  const dir = path.join(OUT, p.vendor);
  mkdirSync(dir, { recursive: true });
  const entry = { vendor: p.vendor, page: p.page, url: p.url, ok: false, full: [], crops: [], error: null };
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    entry.status = resp?.status();
    await settle(page);
    if (p.pre) await preparePre(page);
    for (const t of p.click ?? []) {
      const l = typeof t === "string" ? page.getByText(t, { exact: false }).first() : page.locator(t.selector).first();
      await l.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
      await l.click({ timeout: 4000 }).catch((e) => console.log("  click failed:", t, String(e).slice(0, 80)));
      await page.waitForTimeout(500);
    }
    if (p.click?.length) { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300); }
    const text = await page.evaluate(() => document.body.innerText);
    writeFileSync(path.join(SCRATCH, "text", `${p.vendor}--${p.page}.txt`), text);
    entry.title = await page.title();
    const H = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    entry.pageHeight = H;
    if (doFull) {
      const SEG = 4000;
      if (H <= SEG) {
        const f = `${p.page}-full-${DATE}.png`;
        await page.screenshot({ path: path.join(dir, f), fullPage: true });
        await shrink(path.join(dir, f), 1280, 85);
        entry.full.push(f);
      } else {
        let i = 1;
        for (let off = 0; off < H; off += SEG, i++) {
          const f = `${p.page}-full-${i}-${DATE}.png`;
          await page.screenshot({ path: path.join(dir, f), fullPage: true, clip: { x: 0, y: off, width: 1280, height: Math.min(SEG, H - off) } });
          await shrink(path.join(dir, f), 1280, 85);
          entry.full.push(f);
        }
      }
    }
    if (doCrops) {
      for (const c of p.crops ?? []) {
        const found = norm(text).includes(norm(c.verify ?? c.text));
        const rect = await cropRect(page, c).catch((e) => { entry.error = String(e).slice(0, 200); return null; });
        if (!rect) { entry.crops.push({ claim: c.claim, file: null, found, error: "locator not found" }); continue; }
        const f = `${p.page}-${c.claim}-${DATE}.png`;
        const fp = path.join(dir, f);
        await page.screenshot({ path: fp, fullPage: true, clip: rect });
        await shrink(fp, 1600, 92);
        entry.crops.push({ claim: c.claim, file: f, found, rect });
      }
    }
    entry.ok = true;
  } catch (e) {
    entry.error = String(e).slice(0, 300);
  }
  await page.close();
  console.log(`${entry.ok ? "ok " : "ERR"} ${key} ${entry.status ?? ""} h=${entry.pageHeight ?? "?"} ${entry.error ?? ""} ${entry.crops.map((c) => `${c.claim}:${c.file ? (c.found ? "ok" : "TEXT?") : "NOCROP"}`).join(" ")}`);
  results.push(entry);
  save();
}
await browser.close();
