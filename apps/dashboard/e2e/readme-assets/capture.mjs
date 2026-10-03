// README screenshots: 1440x900 at 2x, light and dark, from the prepared e2e dashboard (ids.json from prep.mjs).
//   node capture.mjs [shot-name ...]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const base = process.env.RD_DASHBOARD ?? "http://localhost:5500";
const scratch = process.env.OUT ?? new URL("../../.readme-assets", import.meta.url).pathname;
const ids = JSON.parse(readFileSync(`${scratch}/ids.json`, "utf8"));
const out = `${scratch}/raw`;
mkdirSync(out, { recursive: true });
const only = new Set(process.argv.slice(2));
const HIDE = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } ::-webkit-scrollbar { display: none; }`;

const browser = await chromium.launch();
async function login(scheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  const p = await ctx.newPage();
  await p.goto(`${base}/login`);
  await p.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
  await p.getByLabel("Password").fill("e2e-password-1");
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL(/\/projects\/[^/]+\//);
  return { ctx, p };
}
const settle = async (p, ms = 900) => {
  await p.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await p.evaluate(() => document.fonts.ready);
  await p.addStyleTag({ content: HIDE }).catch(() => {});
  await p.waitForTimeout(ms);
};
const pid = ids.pid;
const shots = {
  overview: async (p) => { await p.goto(`${base}/projects/${pid}/overview`); await settle(p, 1500); },
  charts: async (p) => {
    await p.goto(`${base}/projects/${pid}/charts/mrr`); await settle(p);
    const seg = p.getByLabel("Segment");
    const opts = await seg.locator("option").evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
    console.log("segments", JSON.stringify(opts));
    const want = opts.find(([, t]) => /product/i.test(t)) ?? opts[1];
    if (want) await seg.selectOption(want[0]);
    await settle(p, 1200);
    await p.getByRole("tab", { name: "Customers" }).or(p.getByRole("button", { name: "Customers", exact: true })).first().click().catch(() => {});
    await settle(p, 1200);
  },
  "paywall-editor": async (p) => {
    await p.goto(`${base}/projects/${pid}/paywalls/${ids.paywall}`); await settle(p, 1500);
    const h = p.getByRole("figure", { name: "Paywall preview" }).getByText(/How your free trial works/).first();
    if (await h.count()) { await h.click(); await settle(p, 600); }
  },
  experiments: async (p) => {
    await p.goto(`${base}/projects/${pid}/experiments/${ids.experiment}?environment=sandbox`); await settle(p, 1500);
    await p.locator("#xp-results").evaluate((el) => el.closest(".card, section")?.scrollIntoView({ block: "start" }) ?? el.scrollIntoView({ block: "start" }));
    await p.evaluate(() => window.scrollBy(0, -20));
    await settle(p, 800);
  },
  funnels: async (p) => {
    await p.goto(`${base}/projects/${pid}/funnels/${ids.funnel}`); await settle(p, 1500);
    // The hosted page address shows this machine's host; show the Cloud host instead.
    await p.evaluate(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.nodeValue.includes("http://localhost:5500")) n.nodeValue = n.nodeValue.replace("http://localhost:5500", "https://api.revenuedot.app"); });
    const step = p.getByRole("region", { name: "Steps" }).getByText(/Where should we|What do you want/).first();
    if (await step.count()) { await step.click(); await settle(p, 800); }
  },
  "customer-center": async (p) => {
    await p.goto(`${base}/projects/${pid}/lifecycle/customer-center`); await settle(p);
    await p.getByRole("button", { name: "Preview" }).click();
    await settle(p, 800);
  },
  integrations: async (p) => {
    await p.goto(`${base}/projects/${pid}/integrations`); await settle(p);
    await p.getByRole("heading", { name: "Analytics" }).first().evaluate((el) => el.scrollIntoView({ block: "start" })).catch(() => {});
    await p.evaluate(() => window.scrollBy(0, -16));
    await settle(p, 600);
  },
  customer: async (p) => { await p.goto(`${base}/projects/${pid}/customers/wjqx8kd2rn1`); await settle(p, 1500); },
  ai: async (p) => {
    // One conversation in the history: delete the earlier ones, then ask again.
    const list = await (await p.request.get(`${base}/v2/projects/${pid}/ai/conversations`)).json().catch(() => ({ items: [] }));
    for (const c of list.items ?? list ?? []) await p.request.delete(`${base}/v2/projects/${pid}/ai/conversations/${c.id}`);
    await p.goto(`${base}/projects/${pid}/ai`); await settle(p);
    await p.getByRole("button", { name: "How is revenue doing this month?", exact: true }).click();
    await p.waitForTimeout(2500);
    await settle(p, 1500);
  },
};
for (const scheme of ["light", "dark"]) {
  const { ctx, p } = await login(scheme);
  for (const [name, fn] of Object.entries(shots)) {
    if (only.size && !only.has(name)) continue;
    try {
      await fn(p);
      const file = `${out}/${name}-${scheme}.png`;
      await p.screenshot({ path: file });
      console.log("wrote", file);
    } catch (e) { console.error("FAILED", name, scheme, e.message); }
  }
  await ctx.close();
}
await browser.close();
