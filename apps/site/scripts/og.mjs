// Social cards: one 1200x630 PNG per page in public/og/<path>.png, rendered from the same data the pages use.
// Each page type has its own visual: integrations show the two logos and the events, charts draw the chart's shape,
// comparisons show the monthly bill, landing pages crop the real dashboard capture, blog posts use the post's cover.
//   node --experimental-strip-types scripts/og.mjs [filter]      (needs Playwright; run from apps/site)
// Commit the PNGs: the build does not render them.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(here, "..");
const repo = path.join(site, "../..");
const require = createRequire(path.join(repo, "apps/dashboard/package.json"));
const { chromium } = require("@playwright/test");
const sharp = createRequire(path.join(site, "package.json"))("sharp");
const filter = process.argv[2] ?? "";

const D = path.join(site, "src/data");
const load = async (f, k) => (await import(pathToFileURL(path.join(D, f)).href))[k];
const [FEATURES, STORES, SDK_PAGES, SOLUTIONS, IA, IB, CA, CB, COMPARE, ALT_PAGE, ALTS] = await Promise.all([
  load("features.ts", "FEATURES"), load("stores.ts", "STORES"), load("sdk-pages.ts", "SDK_PAGES"), load("solutions.ts", "SOLUTIONS"),
  load("integrations-a.ts", "INTEGRATIONS_A"), load("integrations-b.ts", "INTEGRATIONS_B"),
  load("charts-a.ts", "CHARTS_A"), load("charts-b.ts", "CHARTS_B"), load("compare.ts", "COMPARE"), load("compare.ts", "ALTERNATIVE_PAGE"), load("alternatives.ts", "ALTERNATIVES"),
]);
const { CHARTS: CATALOG, GROUPS } = await import(pathToFileURL(path.join(repo, "packages/core/src/charts/catalog.ts")).href);

const file = (p) => pathToFileURL(p).href;
const font = file(path.join(site, "node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2"));
const mono = file(path.join(site, "node_modules/@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2"));
const lockup = readFileSync(path.join(repo, "brand/kit/wordmark/revenuedot-lockup-black.svg"), "utf8").replace(/ width="\d+" height="\d+"/, ' height="30"');
const mark = readFileSync(path.join(repo, "brand/kit/mark/revenuedot-mark-black.svg"), "utf8").replace(/ width="\d+" height="\d+"/, ' width="56" height="56"');
const logoFile = (f) => {
  for (const n of [f, f.replace(/\.svg$/, ".png")]) { const p = path.join(site, "src/assets/logos", n); if (existsSync(p)) return file(p); }
  return null;
};
const shotFile = (src) => {
  for (const p of [path.join(repo, "docs/assets", src), path.join(site, "src/assets", src)]) if (existsSync(p)) return file(p);
  return null;
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plain = (s) => s.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

const CSS = `
@font-face{font-family:Manrope;src:url(${font}) format("woff2");font-weight:200 800}
@font-face{font-family:"Geist Mono";src:url(${mono}) format("woff2");font-weight:500}
*{box-sizing:border-box;margin:0}
body{background:#fff}
[data-og-artboard]{position:relative;width:1200px;height:630px;background:#fff;color:#0A0A0A;font-family:Manrope,sans-serif;overflow:hidden}
.frame{position:absolute;inset:40px;border:1px solid #E5E5E5}
.frame:before,.frame:after{content:"";position:absolute;width:13px;height:13px;border:1.5px solid #0A0A0A}
.frame:before{top:-7px;left:-7px;border-right:0;border-bottom:0}.frame:after{bottom:-7px;right:-7px;border-left:0;border-top:0}
.brand{position:absolute;left:80px;top:78px;color:#0A0A0A}
.label{position:absolute;left:80px;top:150px;font:600 20px/1 Manrope;letter-spacing:.06em;text-transform:uppercase;color:#737373}
.h{position:absolute;left:80px;top:188px;width:540px;font:600 60px/1.04 Manrope;letter-spacing:-.04em}
.h.wide{width:1040px}
.foot{position:absolute;left:80px;bottom:78px;font:600 20px/1 Manrope;color:#525252;display:flex;align-items:center;gap:12px}
.dot{width:12px;height:12px;border-radius:50%;background:#F7B500}
.vis{position:absolute;right:80px;top:80px;bottom:80px;width:440px;display:flex;align-items:center;justify-content:center}
.tile{width:150px;height:150px;border:1px solid #E5E5E5;background:#fff;display:grid;place-items:center}
.tile img{width:84px;height:84px;object-fit:contain}
.wire{width:110px;height:2px;background:#E5E5E5;position:relative}.wire i{position:absolute;right:0;top:-6px;width:14px;height:14px;background:#F7B500}
.chips{position:absolute;left:0;right:0;bottom:6px;display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
.chip{font:500 18px/1 "Geist Mono";padding:9px 12px;border:1.5px solid currentColor}
.up{color:#5F822B}.info{color:#2F6F9F}.gold{color:#8A5A00}.down{color:#C2410C}
.cols{display:grid;gap:0;border:1px solid #E5E5E5;width:460px}
.cols div{display:flex;justify-content:space-between;align-items:baseline;padding:20px 24px;border-bottom:1px solid #E5E5E5;font:600 24px/1.15 Manrope}
.cols div:last-child{border-bottom:0}
.cols b{font:500 26px/1 "Geist Mono";white-space:nowrap;margin-left:16px}
.cols .rd{background:#FAFAFA}.cols .rd b{color:#0A0A0A}
.cap{font:600 18px/1 Manrope;letter-spacing:.06em;text-transform:uppercase;color:#737373;margin-bottom:14px}
.crop{width:520px;height:440px;border:1px solid #E5E5E5;overflow:hidden;position:absolute;right:40px;top:120px;border-right:0}
.crop img{width:1100px;height:auto;display:block}
.plat{position:absolute;right:120px;top:150px;width:110px;height:110px;border:1px solid #E5E5E5;background:#fff;display:grid;place-items:center;z-index:2}
.plat img{width:64px;height:64px;object-fit:contain}
.cover{position:absolute;inset:0;display:grid;place-items:center}
.cover img{width:1200px;height:675px;object-fit:cover}
`;

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div data-og-artboard>${body}</div></body></html>`;
const chrome = (label, title, wide = false) =>
  `<div class="frame"></div><div class="brand" data-og-safe>${lockup}</div><p class="label" data-og-safe>${esc(label)}</p><h1 class="h${wide ? " wide" : ""}" data-og-safe>${esc(title)}</h1><p class="foot"><span class="dot"></span>revenuedot.app</p>`;

// A deterministic series for a chart's shape, drawn as SVG in the tokens' colours.
function chartSvg(def) {
  const W = 440, H = 300, n = 14;
  let seed = [...def.name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const grid = [0, 1, 2, 3].map((i) => `<line x1="0" x2="${W}" y1="${20 + i * 80}" y2="${20 + i * 80}" stroke="#E5E5E5"/>`).join("");
  if (def.display_type === "cohort") {
    const rows = 6, cols = 7, cw = W / cols, ch = (H - 20) / rows;
    let cells = "";
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols - r; c++) {
      const v = Math.max(0.08, 1 - c * 0.13 - rnd() * 0.08);
      cells += `<rect x="${c * cw + 2}" y="${r * ch + 2}" width="${cw - 4}" height="${ch - 4}" fill="#0A0A0A" fill-opacity="${(v * 0.85).toFixed(2)}"/>`;
    }
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${cells}</svg>`;
  }
  const trend = def.group === "churn" ? -0.2 : 0.6;
  const vals = Array.from({ length: n }, (_, i) => 0.3 + (trend * i) / n / 1.4 + rnd() * 0.18);
  const max = Math.max(...vals) * 1.1, x = (i) => (i / (n - 1)) * (W - 20) + 10, y = (v) => H - 20 - (v / max) * (H - 50);
  if (def.display_type === "bar" || def.display_type === "stacked_bar") {
    const bw = (W - 20) / n - 8;
    const bars = vals.map((v, i) => {
      const top = y(v), last = i === n - 1;
      if (def.display_type === "stacked_bar") {
        const mid = top + (H - 20 - top) * 0.45;
        return `<rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${mid - top - 2}" fill="#2A78D6"/><rect x="${x(i) - bw / 2}" y="${mid}" width="${bw}" height="${H - 20 - mid}" fill="#EB6834"/>`;
      }
      return `<rect x="${x(i) - bw / 2}" y="${top}" width="${bw}" height="${H - 20 - top}" fill="${last ? "#F7B500" : "#0A0A0A"}"/>`;
    }).join("");
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${bars}</svg>`;
  }
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${H - 20} ${pts} ${x(n - 1)},${H - 20}`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}<polygon points="${area}" fill="#0A0A0A" fill-opacity=".06"/><polyline points="${pts}" fill="none" stroke="#0A0A0A" stroke-width="3"/><rect x="${x(n - 1) - 7}" y="${y(vals[n - 1]) - 7}" width="14" height="14" fill="#F7B500"/></svg>`;
}

const cards = [];
const add = (p, html) => (!filter || p.includes(filter)) && cards.push({ p, html });
const short = (t, max = 48) => (t.length <= max ? t : t.slice(0, t.lastIndexOf(" ", max)) + "…");

// Integrations
const CAT = { core: "Webhooks and data", data: "Webhooks and data", analytics: "Product analytics", attribution: "Attribution", marketing: "Messaging", support: "Support", ads: "Ad monetization" };
for (const i of [...IA, ...IB]) {
  const l = logoFile(i.logo);
  const chips = `<div class="chips"><span class="chip gold">INITIAL_PURCHASE</span><span class="chip up">RENEWAL</span><span class="chip info">TRIAL</span><span class="chip down">REFUND</span></div>`;
  add(`/integrations/${i.slug}`, page(`${chrome(`Integration · ${CAT[i.category] ?? i.category}`, `${i.name} + RevenueDot`)}<div class="vis" data-og-safe><div style="display:flex;align-items:center;margin-top:-60px"><div class="tile">${mark}</div><div class="wire"><i></i></div><div class="tile">${l ? `<img src="${l}">` : ""}</div></div>${chips}</div>`));
}
// Charts
const catalog = new Map(CATALOG.map((c) => [c.name, c]));
for (const c of [...CA, ...CB]) {
  const def = catalog.get(c.name); if (!def) continue;
  const group = GROUPS.find((g) => g.id === def.group)?.display_name ?? "";
  add(`/charts/${c.slug}`, page(`${chrome(`Subscription metrics · ${group}`, `${def.display_name}: what it is and how to calculate it`)}<div class="vis" data-og-safe><div><p class="cap">${esc(def.display_name)}</p>${chartSvg(def)}</div></div>`));
}
// Comparisons
for (const c of COMPARE) {
  const row = c.price?.rows.find((r) => /50,000|50K/i.test(r[0])) ?? c.price?.rows[1];
  const vis = row
    ? `<div><p class="cap">Monthly bill at ${esc(row[0])} tracked revenue</p><div class="cols">${c.price.head.slice(1).map((h, k) => `<div class="${/RevenueDot/.test(h) ? "rd" : ""}"><span>${esc(h.replace(/\s*\(.*\)/, ""))}</span><b>${esc(row[k + 1])}</b></div>`).join("")}</div></div>`
    : `<div class="cols">${c.columns.map((n) => `<div class="${n === "RevenueDot" ? "rd" : ""}"><span>${esc(n)}</span></div>`).join("")}</div>`;
  add(`/compare/${c.slug}`, page(`${chrome("Comparison · checked " + c.checked, c.columns.slice(0, 2).join(" vs "))}<div class="vis" data-og-safe>${vis}</div>`));
}
// Landing pages
const PLAT = { "app-store": "app-store.svg", "google-play": "google-play.svg", "amazon-appstore": "amazon.svg", stripe: "stripe.svg", ios: "apple.svg", android: "android-icon.svg", "react-native": "react.svg", flutter: "flutter.svg", web: "javascript.svg", capacitor: "ionic-icon.svg", cordova: "cordova.svg", unity: "unity.svg", "kotlin-multiplatform": "kotlin-icon.svg" };
const SEC = { features: "Feature", stores: "Store", sdks: "SDK", solutions: "Solution" };
const fallbackShot = { features: "screens/overview-light.png", stores: "screens/customer-light.png", sdks: "screens/offerings-light.png", solutions: "screens/overview-light.png" };
for (const l of [...FEATURES, ...STORES, ...SDK_PAGES, ...SOLUTIONS]) {
  const s = shotFile(l.shot?.src ?? fallbackShot[l.section]);
  const p = PLAT[l.slug] && logoFile(PLAT[l.slug]);
  const head = l.section === "stores" || l.section === "sdks" ? (l.slug === "test-store" ? "Test Store purchases" : `${l.name} in-app purchases`) : l.section === "solutions" ? `For ${l.name.charAt(0).toLowerCase() + l.name.slice(1)}` : l.name;
  add(`/${l.section}/${l.slug}`, page(`${chrome(SEC[l.section], l.section === "solutions" && /^(Self|EU|Web|Receipt|AI)/.test(l.name) ? l.name : head)}${s ? `<div class="crop"><img src="${s}"></div>` : ""}${p ? `<div class="plat" data-og-safe><img src="${p}"></div>` : ""}`));
}
// Hubs and lists
const hub = (p, label, title, logos) =>
  add(p, page(`${chrome(label, title)}<div class="vis" data-og-safe><div style="display:grid;grid-template-columns:repeat(4,96px);gap:12px">${logos.map((f) => logoFile(f)).filter(Boolean).slice(0, 12).map((u) => `<div class="tile" style="width:96px;height:96px"><img src="${u}" style="width:52px;height:52px"></div>`).join("")}</div></div>`));
hub("/integrations", "Integrations", `${IA.length + IB.length - 2} integrations, one event stream`, ["amplitude.svg", "mixpanel.svg", "posthog.svg", "segment.svg", "firebase.svg", "bigquery.svg", "appsflyer.png", "adjust.png", "meta-ads.svg", "braze.svg", "slack.svg", "zendesk.svg"]);
hub("/sdks", "SDKs", "In-app purchases on every platform", ["apple.svg", "android-icon.svg", "react.svg", "flutter.svg", "javascript.svg", "ionic-icon.svg", "cordova.svg", "unity.svg", "kotlin-icon.svg", "expo-icon.svg"]);
hub("/stores", "Stores", "App Store, Google Play, Amazon and Stripe", ["app-store.svg", "google-play.svg", "amazon.svg", "stripe.svg"]);
const mrr = catalog.get("mrr");
add("/charts", page(`${chrome("Subscription analytics", `All ${CA.length + CB.length} subscription charts, defined`)}<div class="vis" data-og-safe><div><p class="cap">MRR</p>${chartSvg(mrr)}</div></div>`));
const rcRow = COMPARE[0]?.price?.rows.find((r) => /50,000|50K/i.test(r[0]));
const billVis = (head, row) => `<div class="vis" data-og-safe><div><p class="cap">Monthly bill at ${esc(row[0])} tracked revenue</p><div class="cols">${head.slice(1).map((h, k) => `<div class="${/RevenueDot/.test(h) ? "rd" : ""}"><span>${esc(h.replace(/\s*\(.*\)/, ""))}</span><b>${esc(row[k + 1])}</b></div>`).join("")}</div></div></div>`;
add("/compare", page(`${chrome("Compare", "Compare subscription platforms, with sources")}${rcRow ? billVis(COMPARE[0].price.head, rcRow) : ""}`));
add("/revenuecat-alternative", page(`${chrome("RevenueCat alternative", "The open-source RevenueCat alternative")}${rcRow ? billVis(COMPARE[0].price.head, rcRow) : ""}`));
add("/revenuecat-alternatives", page(`${chrome("Alternatives · 2026", `The ${ALTS.length} best RevenueCat alternatives`)}<div class="vis" data-og-safe><div class="cols">${ALTS.slice(0, 6).map((a, k) => `<div class="${k === 0 ? "rd" : ""}"><span>${esc(a.name)}</span><b style="font-size:18px;color:#737373">${String(k + 1).padStart(2, "0")}</b></div>`).join("")}</div></div>`));
for (const [p, label, title, s] of [
  ["/features", "Features", "Everything a subscription app needs", "paywalls-editor-light.png"],
  ["/solutions", "Solutions", "Keep the RevenueCat SDK, not the bill", "screens/overview-light.png"],
  ["/", "Open source", "The open-source RevenueCat alternative", "screens/overview-light.png"],
  ["/pricing", "Pricing", "Free on Cloud up to $10K a month", "screens/overview-light.png"],
  ["/migrate-from-revenuecat", "Migrate", "Move off RevenueCat in an afternoon", "screens/customers-light.png"],
  ["/self-host", "Self-host", "Run it on your own servers", "dashboard-light.png"],
  ["/blog", "Blog", "Guides for subscription app developers", "paywalls-gallery.png"],
  ["/docs", "Docs", "RevenueDot documentation", "screens/offerings-light.png"],
  ["/changelog", "Changelog", "What shipped in RevenueDot", "charts-light.png"],
]) add(p, page(`${chrome(label, title)}<div class="crop"><img src="${shotFile(s)}"></div>`));

// Blog posts: the post's own cover, letterboxed into the card.
const blogDir = path.resolve(site, process.env.DOCS_DIR ?? "../../../docs", "blog");
for (const f of readdirSync(blogDir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
  const src = readFileSync(path.join(blogDir, f), "utf8");
  const fm = Object.fromEntries([...src.matchAll(/^(\w+):\s*(.+)$/gm)].slice(0, 8).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
  const slug = f.replace(/\.md$/, "");
  const cover = fm.image && path.join(blogDir, fm.image.replace(/^\/blog\//, ""));
  if (cover && existsSync(cover)) add(`/blog/${slug}`, page(`<div class="cover"><img src="${file(cover)}"></div>`));
  else add(`/blog/${slug}`, page(`${chrome("Blog", short(plain(fm.title ?? slug), 70), true)}`));
}

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
const outDir = path.join(site, "public/og");
let n = 0;
// file:// images load only from a file:// page, so each card is written to a temp file and opened.
const tmp = path.join(os.tmpdir(), `revenuedot-og-${process.pid}.html`);
for (const c of cards) {
  writeFileSync(tmp, c.html);
  await tab.goto(pathToFileURL(tmp).href, { waitUntil: "load" });
  await tab.evaluate(() => document.fonts.ready);
  const broken = await tab.evaluate(() => [...document.images].filter((i) => !i.complete || !i.naturalWidth).map((i) => i.src));
  if (broken.length) console.warn("broken image on", c.p, broken);
  const overflow = await tab.evaluate(() => [...document.querySelectorAll("[data-og-safe]")].filter((e) => { const r = e.getBoundingClientRect(); return r.right > 1160 || r.bottom > 590 || r.left < 40 || r.top < 40; }).length);
  if (overflow) console.warn("content outside the safe area on", c.p);
  const buf = await tab.locator("[data-og-artboard]").screenshot();
  const out = path.join(outDir, `${c.p === "/" ? "home" : c.p.slice(1)}.png`);
  mkdirSync(path.dirname(out), { recursive: true });
  await sharp(buf).png({ palette: true, quality: 90, effort: 8 }).toFile(out);
  n++;
}
await browser.close();
rmSync(tmp, { force: true });
console.log(`wrote ${n} cards to public/og`);
