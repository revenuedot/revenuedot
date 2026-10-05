// Email video covers (prd/onboarding-emails/PRD.md): a frame of the video with a play button, the title and the length,
// so the image in an email reads as "click to watch". 1200x675 JPEG in public/email/<slug>.jpg.
//   node scripts/email-covers.mjs [path/to/posters-dir]
// A poster for each video is looked up as <posters-dir>/<slug>.png|.jpg|.webp (the video's own poster frame); without one
// the fallback screenshot below is used.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
// Playwright comes with the dashboard's end-to-end tests, as in capture-screens.mjs.
const { chromium } = createRequire(path.join(here, "../../dashboard/package.json"))("@playwright/test");
const site = path.join(here, "..");
const out = path.join(site, "public/email");
mkdirSync(out, { recursive: true });
const posters = process.argv[2];

const VIDEOS = [
  { slug: "revenuedot-first-purchase", title: "Your first purchase in 5 minutes", length: "1:18", fallback: "src/assets/screens/overview-light.png", titled: true },
  { slug: "revenuedot-connect-your-app", title: "Connect your app with one line", length: "1:30", fallback: "src/assets/screens/offerings-light.png" },
  { slug: "revenuedot-switch-from-revenuecat", title: "Switch from RevenueCat without losing a renewal", length: "1:34", fallback: "src/assets/screens/customers-light.png", titled: true },
  { slug: "revenuedot-paywalls-and-experiments", title: "Build a paywall and test it", length: "1:30", fallback: "public/clips/paywalls.webp" },
  { slug: "revenuedot-chatgpt-demo", title: "Run your subscriptions from ChatGPT", length: "1:27", fallback: "public/videos/revenuedot-chatgpt-demo.webp", titled: true },
];

const only = new Set(process.argv.slice(3));
const mime = (f) => (f.endsWith(".png") ? "image/png" : f.endsWith(".webp") ? "image/webp" : "image/jpeg");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 1 });
for (const v of VIDEOS) {
  if (only.size && !only.has(v.slug)) continue;
  const own = posters && [".png", ".jpg", ".webp"].map((x) => path.join(posters, `${v.slug}${x}`)).find(existsSync);
  const src = own ?? path.join(site, v.fallback);
  const img = `data:${mime(src)};base64,${readFileSync(src).toString("base64")}`;
  await page.setContent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@600;700&family=Geist+Mono:wght@500&display=swap" rel="stylesheet"><style>
    *{margin:0;box-sizing:border-box}body{width:1200px;height:675px;overflow:hidden;font-family:Manrope,system-ui,sans-serif;background:#0A0A0A}
    .shot{position:absolute;inset:0;background:url(${img}) center top/cover no-repeat}
    .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,10,10,.05) 0%,rgba(10,10,10,.18) 45%,rgba(10,10,10,.86) 100%)}
    .play{position:absolute;left:50%;top:44%;width:132px;height:132px;margin:-66px 0 0 -66px;border-radius:50%;background:#0A0A0A;box-shadow:0 0 0 10px rgba(255,255,255,.22),0 18px 50px rgba(0,0,0,.35)}
    .play:after{content:"";position:absolute;left:52px;top:38px;border-left:44px solid #fff;border-top:28px solid transparent;border-bottom:28px solid transparent}
    .meta{position:absolute;left:48px;right:48px;bottom:40px;color:#fff}
    /* A poster with its own title: the play button sits on the product shot, and the shade stays light so the title reads. */
    .titled .play{left:74%;top:50%}
    .titled .shade{background:linear-gradient(180deg,rgba(10,10,10,0) 60%,rgba(10,10,10,.55) 100%)}
    .tag{display:inline-flex;gap:10px;align-items:center;font:500 18px/1 'Geist Mono',monospace;letter-spacing:.06em;text-transform:uppercase;background:rgba(255,255,255,.14);padding:9px 12px;margin-bottom:16px}
    h1{font-weight:700;font-size:52px;line-height:1.08;letter-spacing:-.035em;text-wrap:balance;max-width:980px}
  </style></head><body class="${v.titled ? "titled" : ""}"><div class="shot"></div><div class="shade"></div><div class="play"></div>
  <div class="meta"><div class="tag">&#9654; Video &middot; ${v.length}</div>${v.titled ? "" : `<h1>${v.title}</h1>`}</div></body></html>`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(out, `${v.slug}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 82 });
  console.log(`${file}${own ? "" : " (fallback screenshot)"}`);
}
await browser.close();
