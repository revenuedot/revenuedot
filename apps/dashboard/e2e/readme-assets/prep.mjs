// Prepares the seeded Scanner project for the README shots: support email, a paywall from a template, an experiment
// with results, and a funnel from the starter. Prints the ids the capture script needs.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const base = process.env.RD_DASHBOARD ?? "http://localhost:5500";
const out = `${process.env.OUT ?? new URL("../../.readme-assets", import.meta.url).pathname}/ids.json`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
const p = await ctx.newPage();
await p.goto(`${base}/login`);
await p.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
await p.getByLabel("Password").fill("e2e-password-1");
await p.getByRole("button", { name: "Sign in" }).click();
await p.waitForURL(/\/projects\/[^/]+\//);
const pid = p.url().match(/\/projects\/([^/]+)\//)[1];
const P = `/v2/projects/${pid}`;
const json = async (method, path, data, headers = {}) => {
  const res = await p.request.fetch(`${base}${path}`, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return text ? JSON.parse(text) : null;
};
const ids = { pid };

// 1. Customer Center support email (the seed uses the e2e login address).
await p.goto(`${base}/projects/${pid}/lifecycle/customer-center`);
await p.waitForLoadState("networkidle");
await p.locator("#cc-email").fill("support@example.com");
await p.getByRole("button", { name: "Save changes" }).click();
await p.waitForTimeout(1200);
console.log("support email set");

// 2. A paywall from the "Trial timeline" template on the default offering.
const offerings = (await json("GET", `${P}/offerings?limit=100`)).items;
const def = offerings.find((o) => o.lookup_key === "default");
await p.goto(`${base}/projects/${pid}/paywalls/templates`);
await p.waitForLoadState("networkidle");
await p.getByRole("button", { name: "Use template Trial timeline" }).click();
const dlg = p.getByRole("dialog", { name: "Use “Trial timeline”" });
await dlg.getByLabel("Offering").selectOption(def.id);
await dlg.getByLabel("Terms URL").fill("https://example.com/terms");
await dlg.getByLabel("Privacy URL").fill("https://example.com/privacy");
await dlg.getByRole("button", { name: "Create paywall" }).click();
await p.waitForURL(/\/paywalls\/pw/);
ids.paywall = p.url().split("/").pop();
console.log("paywall", ids.paywall);

// 3. An experiment: "Annual plan first" offering against the default, with 320 Test Store customers through the SDK.
const products = (await json("GET", `${P}/products?limit=100`)).items;
const apps = (await json("GET", `${P}/apps`)).items;
const ts = apps.find((a) => a.type === "test_store");
const key = (await json("GET", `${P}/apps/${ts.id}/public_api_keys`)).items[0].key;
const prodByStore = Object.fromEntries(products.filter((x) => x.app_id === ts.id).map((x) => [x.store_identifier, x]));
let treat = offerings.find((o) => o.lookup_key === "annual_first");
if (!treat) {
  treat = await json("POST", `${P}/offerings`, { lookup_key: "annual_first", display_name: "Annual first" });
  for (const [i, [lk, name, pk]] of [["$rc_annual", "Yearly", "pro_annual"], ["$rc_monthly", "Monthly", "pro_monthly"]].entries()) {
    const pkg = await json("POST", `${P}/offerings/${treat.id}/packages`, { lookup_key: lk, display_name: name, position: i });
    await json("POST", `${P}/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: prodByStore[pk].id, eligibility_criteria: "all" }] });
  }
}
const x = await json("POST", `${P}/experiments`, { name: "Annual plan first on the paywall", type: "subscription_ordering", notes: "- Control: weekly, monthly, yearly\n- Treatment: yearly shown first, no weekly plan", variants: [{ offering_id: def.id }, { offering_id: treat.id }] });
await json("POST", `${P}/experiments/${x.id}/actions/start`);
ids.experiment = x.id;
console.log("experiment", x.id);
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const h = { authorization: `Bearer ${key}`, "x-platform": "iOS", "x-storefront": "USA" };
let bought = { control: 0, treat: 0 }, n = { control: 0, treat: 0 };
for (let i = 0; i < 320; i++) {
  const user = `$RCAnonymousID:${crypto.randomUUID().replace(/-/g, "")}`;
  await p.request.get(`${base}/v1/subscribers/${encodeURIComponent(user)}`, { headers: h });
  const off = await (await p.request.get(`${base}/v1/subscribers/${encodeURIComponent(user)}/offerings`, { headers: h })).json();
  const isTreat = off.current_offering_id === "annual_first";
  n[isTreat ? "treat" : "control"]++;
  if (rnd() < 0.85) await p.request.post(`${base}/v1/events`, { headers: { ...h, "content-type": "application/json" }, data: { events: [{ id: crypto.randomUUID(), type: "paywall_impression", app_user_id: user, timestamp_ms: Date.now() }] } });
  const buys = rnd() < (isTreat ? 0.31 : 0.23);
  if (!buys) continue;
  const annual = rnd() < (isTreat ? 0.6 : 0.3);
  const product = annual ? "pro_annual" : "pro_monthly";
  const res = await p.request.post(`${base}/v1/receipts`, { headers: { ...h, "content-type": "application/json" }, data: { app_user_id: user, fetch_token: `test_${Date.now()}_${crypto.randomUUID()}`, product_id: product, price: annual ? 39.99 : 9.99, currency: "USD", is_restore: false } });
  if (!res.ok()) throw new Error(`receipt ${res.status()} ${await res.text()}`);
  bought[isTreat ? "treat" : "control"]++;
}
console.log("experiment customers", n, "buyers", bought);

// 4. A funnel from the starter.
await p.goto(`${base}/projects/${pid}/funnels`);
await p.waitForLoadState("networkidle");
await p.getByRole("button", { name: "Create web funnel" }).click();
await p.getByRole("menuitem", { name: "Start from the starter funnel" }).click();
await p.getByRole("dialog", { name: "New funnel from the starter" }).getByRole("button", { name: "Create funnel" }).click();
await p.waitForURL(/\/funnels\/fnl_/);
ids.funnel = p.url().split("/").pop().split("?")[0];
console.log("funnel", ids.funnel);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(ids, null, 2));
await browser.close();
