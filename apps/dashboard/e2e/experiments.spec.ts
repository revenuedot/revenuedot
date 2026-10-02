/**
 * Experiments v2 (prd/experiments/PRD.md) in a real browser: the six starter categories and their defaults, the create
 * form (duplicate the control offering with a swapped product, placements, a third variant, validations, notes preview,
 * enrollment and paywall tracking, custom audience and the live estimate), save as draft, edit, start; customers from
 * the SDK endpoints split between the variants with the placements overlaid; results (guidance, intervals, chart,
 * filters) and both CSV exports; pause, resume, stop; priority by keyboard and drag; Create with RevenueDot AI approving
 * a draft; phone width and dark theme; no console errors. Each test signs up its own account.
 *   cd apps/dashboard && npx vite build && E2E_PORT=5552 npx playwright test -c e2e/playwright.config.ts experiments
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(page: Page, method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await page.request.fetch(path, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** A fresh account: a Test Store app, three priced products, "pro", and offerings default (current) and promo. */
async function fresh(page: Page, label: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await json(page, "POST", "/auth/signup", { email: `xp-${label}-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Grace Hopper", project_name: `Experiments ${label}` });
  const pid = (await json(page, "GET", "/auth/me")).projects[0].id as string;
  const P = `/v2/projects/${pid}`;
  const app = await json(page, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const key = (await json(page, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key as string;
  const product = (sid: string, price: number, duration: string, name: string) => json(page, "POST", `${P}/products`, {
    app_id: app.id, store_identifier: sid, type: "subscription", display_name: name, subscription: { duration }, test_store_price: { amount_micros: Math.round(price * 1e6), currency: "USD" },
  });
  const monthly = await product("pro_monthly", 9.99, "P1M", "Pro monthly"), annual = await product("pro_annual", 59.99, "P1Y", "Pro annual"), high = await product("pro_monthly_hi", 14.99, "P1M", "Pro monthly plus");
  const ent = await json(page, "POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" });
  await json(page, "POST", `${P}/entitlements/${ent.id}/actions/attach_products`, { product_ids: [monthly.id, annual.id, high.id] });
  const offering = async (key: string, pkgs: [string, string][]) => {
    const o = await json(page, "POST", `${P}/offerings`, { lookup_key: key, display_name: key === "default" ? "Standard" : key });
    for (const [i, [lk, pr]] of pkgs.entries()) {
      const pkg = await json(page, "POST", `${P}/offerings/${o.id}/packages`, { lookup_key: lk, display_name: lk, position: i });
      await json(page, "POST", `${P}/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: pr, eligibility_criteria: "all" }] });
    }
    return o;
  };
  const def = await offering("default", [["$rc_monthly", monthly.id], ["$rc_annual", annual.id]]);
  const promo = await offering("promo", [["$rc_monthly", high.id]]);
  const sdkHeaders = (platform = "iOS") => ({ authorization: `Bearer ${key}`, "x-platform": platform, "x-storefront": platform === "iOS" ? "USA" : "DEU" });
  const sdk = {
    open: async (user: string, platform = "iOS") => {
      await page.request.get(`/v1/subscribers/${encodeURIComponent(user)}`, { headers: sdkHeaders(platform) });
      return (await (await page.request.get(`/v1/subscribers/${encodeURIComponent(user)}/offerings`, { headers: sdkHeaders(platform) })).json()) as any;
    },
    buy: (user: string, productId: string, price: number) => page.request.post("/v1/receipts", { headers: { ...sdkHeaders(), "content-type": "application/json" },
      data: { app_user_id: user, fetch_token: `test_${Date.now()}_${crypto.randomUUID()}`, product_id: productId, price, currency: "USD", is_restore: false } }),
    view: (user: string) => page.request.post("/v1/events", { headers: { ...sdkHeaders(), "content-type": "application/json" },
      data: { events: [{ id: crypto.randomUUID(), type: "paywall_impression", app_user_id: user, timestamp_ms: Date.now() }] } }),
  };
  return { pid, P, stamp, ids: { monthly: monthly.id, annual: annual.id, high: high.id, def: def.id, promo: promo.id }, sdk };
}

test("starter categories open the form with their type and metrics", async ({ page }) => {
  const errors = watchConsole(page);
  const { pid } = await fresh(page, "starters");
  await page.goto(`/projects/${pid}/experiments`);
  await expect(page.getByRole("heading", { name: "Start with a proven test" })).toBeVisible();
  const expected: [string, string, string][] = [
    ["Introductory offer", "introductory_offer", "conversion_to_paying"], ["Free trial offer", "free_trial_offer", "conversion_to_paying"],
    ["Paywall design", "paywall_design", "initial_conversion_rate"], ["Price point", "price_point", "realized_ltv_per_customer"],
    ["Subscription duration", "subscription_duration", "realized_ltv_per_customer"], ["Subscription ordering", "subscription_ordering", "initial_conversion_rate"],
  ];
  for (const [name, type, primary] of expected) {
    await page.goto(`/projects/${pid}/experiments`);
    await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/experiments/new\\?type=${type}$`));
    await expect(page.getByLabel("Experiment type")).toHaveValue(type);
    await expect(page.getByLabel("Primary metric")).toHaveValue(primary);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(`${name} test`);
    await expect(page.getByRole("button", { name: "Create offering" })).toBeVisible();
  }
  // Import from targeting: the rule's offering and placements go into every variant; remove a placement and a variant.
  const { P, ids } = await fresh(page, "import");
  const pid2 = P.split("/").pop()!;
  await json(page, "POST", `${P}/targeting_rules`, { name: "Onboarding promo", offering_id: ids.promo, placements: { onboarding_end: ids.promo, settings: null } });
  await page.goto(`/projects/${pid2}/experiments/new?type=paywall_design`);
  await page.getByRole("button", { name: "Import from targeting" }).click();
  await page.getByRole("menuitem", { name: "Onboarding promo" }).click();
  await expect(page.locator("#xp-off-0")).toHaveValue(ids.promo);
  await expect(page.locator("#xp-off-1")).toHaveValue(ids.promo);
  await expect(page.getByLabel("Variant A placement onboarding_end")).toHaveValue(ids.promo);
  await expect(page.getByLabel("Variant B placement settings")).toHaveValue("");
  await page.getByRole("button", { name: "Add variant" }).click();
  await expect(page.getByLabel("Variant C name")).toHaveValue("Treatment C");
  await page.getByRole("button", { name: "Remove variant C" }).click();
  await expect(page.getByLabel("Variant C name")).toHaveCount(0);
  await page.getByRole("button", { name: "Remove placement settings" }).click();
  await expect(page.getByLabel("Variant B placement settings")).toHaveCount(0);
  await page.getByLabel("Variant B placement onboarding_end").selectOption({ label: "default" });
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/experiments\/prexp\w+$/);
  const imported = await json(page, "GET", `${P}/experiments/${page.url().split("/").pop()}`);
  expect(imported.variants).toEqual([
    { id: "a", name: "Control", offering_id: ids.promo, placements: { onboarding_end: ids.promo } },
    { id: "b", name: "Treatment B", offering_id: ids.promo, placements: { onboarding_end: ids.def } },
  ]);
  expect(imported).toMatchObject({ type: "paywall_design", primary_metric: "initial_conversion_rate" });

  // The New experiment menu lists the same starts, from scratch and with RevenueDot AI.
  await page.goto(`/projects/${pid2}/experiments`);
  await page.getByRole("button", { name: "New experiment" }).click();
  for (const item of ["Create from scratch", "Create with RevenueDot AI", "Introductory offer", "Subscription ordering"]) await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
  await page.getByRole("menuitem", { name: "Create from scratch" }).click();
  await expect(page.getByLabel("Experiment type")).toHaveValue("other");
  expect(errors).toEqual([]);
});

test("create, validate, draft, edit, start; SDK split with placements; results, CSV, pause, resume, stop", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  const { pid, P, stamp, ids, sdk } = await fresh(page, "full");
  // Customers seen before the experiment starts: one Android, two iOS.
  for (let i = 0; i < 3; i++) await sdk.open(`pre_${stamp}_${i}`, i ? "iOS" : "android");
  const est = async (json: unknown) => (await page.request.post(`${P}/experiments/actions/estimate`, { data: json })).json();
  const all3 = await est({ variant_count: 3 });
  expect(all3.matching_customers).toBeGreaterThanOrEqual(3);
  await page.goto(`/projects/${pid}/experiments/new?type=price_point`);
  await page.getByLabel("Name", { exact: true }).fill("Higher monthly price");
  await page.getByRole("checkbox", { name: "Active subscribers" }).check();
  await page.getByRole("textbox", { name: "Notes" }).fill("## Hypothesis\nA **higher** monthly price keeps conversion.\n\n- Treatment B: $14.99 monthly\n- Treatment C: promo");
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByRole("tabpanel", { name: "Notes preview" }).locator("strong", { hasText: "higher" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Notes preview" }).locator("li")).toHaveCount(2);

  // Treatment B: duplicate the control with the monthly package's product swapped.
  await page.getByRole("button", { name: "Create offering" }).click();
  const dup = page.getByRole("dialog", { name: "Duplicate default" });
  await expect(dup.getByLabel("Identifier")).toHaveValue("default_price");
  await dup.getByLabel("Product 1 of $rc_monthly").selectOption({ label: "Pro monthly plus · 1 month · $14.99" });
  await dup.getByRole("button", { name: "Create offering" }).click();
  await expect(dup).toHaveCount(0);
  await expect(page.locator("#xp-off-1")).toHaveValue(/^ofrng/);
  const copy = (await json(page, "GET", `${P}/offerings?expand=items.package.product&limit=100`)).items.find((o: any) => o.lookup_key === "default_price");
  expect(copy.packages.items.map((p: any) => [p.lookup_key, p.products.items[0].product.store_identifier])).toEqual([["$rc_monthly", "pro_monthly_hi"], ["$rc_annual", "pro_annual"]]);

  // A placement on every variant, and a third variant left empty to see the validation.
  await page.getByRole("button", { name: "Add placement" }).click();
  await page.getByLabel("Placement identifier").fill("bad id!");
  await expect(page.getByText("Letters, digits, dots, dashes or underscores.")).toBeVisible();
  await page.getByLabel("Placement identifier").fill("onboarding_end");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add variant" }).click();
  await page.getByRole("button", { name: "Start experiment" }).click();
  await expect(page.getByText("Pick an offering, or create one from the control.")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Fix the highlighted fields." })).toBeVisible();
  // Same as the control: refused before the API is asked.
  await page.locator("#xp-off-2").selectOption({ label: "Standard (default) · current" });
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("Same offering and placements as Control.")).toBeVisible();
  await page.locator("#xp-off-2").selectOption({ label: "promo (promo)" });
  await page.getByLabel("Variant C placement onboarding_end").selectOption({ label: "No paywall" });

  // New and existing customers turns paywall tracking on; custom audience with the estimate.
  await page.getByRole("button", { name: /^New and existing customers/ }).click();
  await expect(page.getByRole("checkbox", { name: /Track paywall views/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Track paywall views/ })).toBeDisabled();
  await page.getByRole("button", { name: /^New customers/ }).click();
  await expect(page.getByRole("checkbox", { name: /Track paywall views/ })).toBeEnabled();
  await page.getByRole("checkbox", { name: /Track paywall views/ }).uncheck();
  await expect(page.getByTestId("xp-est-matching")).toHaveText(String(all3.matching_customers));
  await page.locator("label", { hasText: "Custom filters" }).click();
  await page.getByLabel("Field 1.1").selectOption("platform");
  await page.getByLabel("Operator 1.1").selectOption("is");
  await page.getByLabel("Value 1.1").fill("iOS");
  const ios = await est({ variant_count: 3, audience_rules: { groups: [{ conditions: [{ field: "platform", operator: "is", value: "iOS" }] }] } });
  expect(ios.matching_customers).toBe(all3.matching_customers - 1);
  await expect(page.getByTestId("xp-est-matching")).toHaveText(String(ios.matching_customers));
  await page.getByLabel("Audience percentage").fill("0");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await expect(page.getByText("A whole percentage from 1 to 100.")).toBeVisible();
  await page.getByLabel("Audience percentage").fill("100");
  await expect(page.getByTestId("xp-est-per")).toHaveText(String(Math.floor(ios.matching_customers / 3)));
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(/\/experiments\/prexp\w+$/);
  const id = page.url().split("/").pop()!;
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  let x = await json(page, "GET", `${P}/experiments/${id}`);
  expect(x).toMatchObject({
    name: "Higher monthly price", type: "price_point", status: "draft", primary_metric: "realized_ltv_per_customer", enrollment: "new", track_paywall_views: false,
    audience_rules: { groups: [{ conditions: [{ field: "platform", operator: "is", value: "iOS" }] }] }, enrollment_percent: 100, priority: 1,
    variants: [{ id: "a", offering_id: ids.def, placements: { onboarding_end: ids.def } }, { id: "b", offering_id: copy.id, placements: { onboarding_end: copy.id } }, { id: "c", offering_id: ids.promo, placements: { onboarding_end: null } }],
  });
  expect(x.secondary_metrics).toEqual(expect.arrayContaining(["conversion_to_paying", "initial_conversion_rate", "refund_rate", "active_subscribers"]));
  await expect(page.locator(".xp-md strong", { hasText: "higher" })).toBeVisible();

  // Edit the draft: everyone, 50%, then start from the page.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.locator("label", { hasText: "Everyone" }).click();
  await page.getByLabel("Audience percentage").fill("50");
  await page.getByRole("button", { name: "Save as draft" }).click();
  await page.waitForURL(new RegExp(`/experiments/${id}$`));
  x = await json(page, "GET", `${P}/experiments/${id}`);
  expect(x).toMatchObject({ audience_rules: null, audience_id: null, enrollment_percent: 50 });
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Audience percentage").fill("100");
  await page.getByRole("button", { name: "Start experiment" }).click();
  await page.waitForURL(new RegExp(`/experiments/${id}$`));
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  // A started experiment's form locks variants, enrollment and audience.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.locator("#xp-off-1")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start experiment" })).toHaveCount(0);
  await page.getByLabel("Name", { exact: true }).fill("Higher monthly price, live");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL(new RegExp(`/experiments/${id}$`));
  await expect(page.getByRole("heading", { name: "Higher monthly price, live" })).toBeVisible();

  // Customers: those seen before the start never join (new customers only); new ones split three ways, for good.
  expect((await sdk.open(`pre_${stamp}_1`)).current_offering_id).toBe("default");
  const seen: Record<string, any> = {};
  for (let i = 0; i < 45; i++) seen[`n_${stamp}_${i}`] = await sdk.open(`n_${stamp}_${i}`);
  const keys = Object.values(seen).map((s) => s.current_offering_id);
  expect(new Set(keys)).toEqual(new Set(["default", "default_price", "promo"]));
  const promoOne = Object.values(seen).find((s) => s.current_offering_id === "promo");
  expect(promoOne.placements.offering_ids_by_placement).toEqual({ onboarding_end: null });
  expect(Object.values(seen).find((s) => s.current_offering_id === "default_price").placements.offering_ids_by_placement).toEqual({ onboarding_end: "default_price" });
  for (const u of Object.keys(seen).slice(0, 10)) expect((await sdk.open(u)).current_offering_id).toBe(seen[u].current_offering_id);
  const users = Object.keys(seen);
  const buyers = users.filter((_, i) => i % 3 === 0);
  for (const u of buyers) {
    const price = seen[u].current_offering_id === "default" ? 9.99 : 14.99;
    expect((await sdk.buy(u, seen[u].current_offering_id === "default" ? "pro_monthly" : "pro_monthly_hi", price)).ok()).toBe(true);
  }
  for (const u of users.slice(0, 9)) await sdk.view(u);

  // Results in the browser match the API.
  await page.reload();
  await page.getByLabel("Environment").selectOption("sandbox");
  const res = await json(page, "GET", `${P}/experiments/${id}/results?environment=sandbox`);
  expect(res.variants.items.reduce((s: number, v: any) => s + v.customers, 0)).toBe(45);
  expect(res.variants.items.reduce((s: number, v: any) => s + v.metrics.paid_customers.value, 0)).toBe(buyers.length);
  await expect(page.getByTestId("xp-guidance")).toContainText("Too early to call");
  const ltvRow = page.locator('tr[data-metric="realized_ltv_per_customer"]');
  await expect(ltvRow).toContainText("Primary");
  await expect(ltvRow).toContainText("95%:");
  await expect(ltvRow).toContainText("chance to beat the control");
  const a = res.variants.items[0];
  await expect(ltvRow.locator("td").first()).toContainText(`$${a.metrics.realized_ltv_per_customer.value.toFixed(2)}`);
  await page.getByRole("button", { name: /All metrics/ }).click();
  await expect(page.locator('tr[data-metric="trials_started"]').first()).toBeVisible();
  await page.getByLabel("Chart metric").selectOption("paid_customers");
  await expect(page.locator(".xp-chart svg").first()).toBeVisible();
  await expect(page.locator(".xp-chart .legend li")).toHaveCount(3);
  await page.getByLabel("Platform").selectOption("iOS");
  await page.getByLabel("Paywall views").selectOption("viewed");
  await expect(page.locator(".xp-kpis .kpi .v").first()).not.toHaveText("");
  const viewed = await json(page, "GET", `${P}/experiments/${id}/results?environment=sandbox&platform=iOS&paywall=viewed`);
  expect(viewed.variants.items.reduce((s: number, v: any) => s + v.customers, 0)).toBe(9);
  await expect.poll(async () => (await page.locator(".xp-kpis .kpi .v").allTextContents()).map(Number).reduce((s, n) => s + n, 0)).toBe(9);
  await page.getByLabel("Paywall views").selectOption("all");
  await page.getByLabel("Platform").selectOption("");

  // CSV: the summary and the daily series.
  await page.getByRole("button", { name: "Export CSV" }).click();
  const [summary] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Summary per variant (CSV)" }).click()]);
  expect(summary.suggestedFilename()).toMatch(new RegExp(`^experiment-${id}-summary-sandbox-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  const sumText = readFileSync((await summary.path())!, "utf8");
  expect(sumText.split("\r\n")[0]).toMatch(/^variant_id,variant_name,offering_id,customers,metric,metric_name,value/);
  const paidRows = sumText.split("\r\n").filter((l) => l.split(",")[4] === "paid_customers");
  expect(paidRows.reduce((s, l) => s + Number(l.split(",")[6]), 0)).toBe(buyers.length);
  await page.getByRole("button", { name: "Export CSV" }).click();
  const [daily] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Every metric by day (CSV)" }).click()]);
  const dailyText = readFileSync((await daily.path())!, "utf8");
  expect(dailyText.split("\r\n")[0]).toMatch(/^date,variant_id,variant_name,initial_conversion_rate,/);
  expect(dailyText.trim().split("\r\n").length).toBe(1 + res.series.days.length * 3);

  // Pause (nobody new joins), resume, stop.
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  expect((await sdk.open(`late_${stamp}`)).current_offering_id).toBe("default");
  expect((await sdk.open(users[0]!)).current_offering_id).toBe(seen[users[0]!].current_offering_id);
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("dialog", { name: "Stop this experiment?" }).getByRole("button", { name: "Stop experiment" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  expect((await json(page, "GET", `${P}/experiments/${id}`)).status).toBe("stopped");
  expect((await sdk.open(users[1]!)).current_offering_id).toBe("default");
  // The offering a live experiment uses cannot be deleted; a stopped one's can.
  const draft = await json(page, "POST", `${P}/experiments`, { name: "Uses promo", variants: [{ offering_id: ids.def }, { offering_id: ids.promo }] });
  const del = await page.request.delete(`${P}/offerings/${ids.promo}`);
  expect(del.status()).toBe(409);
  await json(page, "DELETE", `${P}/experiments/${draft.id}`);
  expect(errors).toEqual([]);
});

test("enrollment priority by keyboard and drag; Create with RevenueDot AI saves a draft after approval", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const { pid, P, ids } = await fresh(page, "order");
  const mk = (name: string) => json(page, "POST", `${P}/experiments`, { name, variants: [{ offering_id: ids.def }, { offering_id: ids.promo }] });
  const [one, two, three] = [await mk("First"), await mk("Second"), await mk("Third")];
  await json(page, "POST", `${P}/experiments/${two.id}/actions/start`);
  await page.goto(`/projects/${pid}/experiments`);
  const order = () => page.locator(".xp-item .xp-item-main b").allTextContents();
  await expect.poll(order).toEqual(["First", "Second", "Third"]);
  await page.getByRole("button", { name: /^Priority of Third: 3/ }).focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(order).toEqual(["First", "Third", "Second"]);
  await expect.poll(async () => (await json(page, "GET", `${P}/experiments/${three.id}`)).priority).toBe(2);
  await page.getByRole("button", { name: /^Priority of Second: 3/ }).dragTo(page.locator(".xp-item").first());
  await expect.poll(async () => (await json(page, "GET", `${P}/experiments?limit=100`)).items.sort((a: any, b: any) => a.priority - b.priority).map((e: any) => e.name)).toEqual(["Second", "First", "Third"]);
  await page.reload();
  await expect.poll(order).toEqual(["Second", "First", "Third"]);
  await page.getByRole("button", { name: "Actions for First" }).click();
  await page.getByRole("menuitem", { name: "Move down" }).click();
  await expect.poll(order).toEqual(["Second", "Third", "First"]);
  await expect.poll(async () => (await json(page, "GET", `${P}/experiments/${one.id}`)).priority).toBe(3);

  // Create with RevenueDot AI: the scripted model reads the offerings and proposes a draft behind an approval card.
  await page.getByRole("button", { name: "New experiment" }).click();
  await page.getByRole("menuitem", { name: "Create with RevenueDot AI" }).click();
  const ask = page.getByRole("dialog", { name: "Create an experiment with RevenueDot AI" });
  await ask.getByRole("button", { name: "Draft it" }).click();
  await expect(ask.getByRole("alert")).toHaveText("Say what the experiment should do.");
  await ask.getByRole("button", { name: "Test a 14-day free trial against our 7-day trial" }).click();
  await ask.getByRole("button", { name: "Draft it" }).click();
  await page.waitForURL(/\/ai\/aic\w+$/);
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Save the draft experiment");
  const before = (await json(page, "GET", `${P}/experiments?limit=100`)).items.length;
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toContainText("Approved");
  const link = page.getByRole("link", { name: /default vs promo/ });
  await expect(link).toBeVisible();
  const after = (await json(page, "GET", `${P}/experiments?limit=100`)).items;
  expect(after.length).toBe(before + 1);
  const drafted = after.find((e: any) => e.name === "default vs promo");
  expect(drafted).toMatchObject({ status: "draft", type: "free_trial_offer", priority: 4, variants: [{ offering_id: ids.def }, { offering_id: ids.promo }] });
  expect(drafted.notes).toContain("14-day free trial");
  await link.click();
  await expect(page.getByRole("heading", { name: "default vs promo" })).toBeVisible();
  await expect(page.getByText("Draft", { exact: true })).toBeVisible();
  const audit = await json(page, "GET", `${P}/audit_logs?limit=20`);
  expect(audit.items.some((l: any) => l.action_type === "experiment_created" && l.actor_type === "assistant")).toBe(true);
  expect(errors).toEqual([]);
});

test("phone width and dark theme: list, form, experiment and results fit without page-level horizontal scroll", async ({ page }) => {
  const errors = watchConsole(page);
  const { pid, P, ids, sdk } = await fresh(page, "phone");
  const x = await json(page, "POST", `${P}/experiments`, { name: "Phone check", type: "subscription_duration", notes: "- one\n- two", variants: [{ offering_id: ids.def }, { offering_id: ids.promo, placements: { onboarding_end: null } }, { offering_id: ids.def, placements: { onboarding_end: ids.promo } }] });
  await json(page, "POST", `${P}/experiments/${x.id}/actions/start`);
  for (let i = 0; i < 6; i++) await sdk.open(`ph_${i}_${Date.now()}`);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const path of ["experiments", "experiments/new?type=price_point", `experiments/${x.id}`, `experiments/${x.id}/edit`]) {
        await page.goto(`/projects/${pid}/${path}`);
        await expect(page.locator("h1").first()).toBeVisible();
        await page.waitForTimeout(300);
        expect(await noSideScroll(page), `${path} at ${width}px ${scheme}`).toBe(true);
      }
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/experiment-${scheme}-${width}.png`, fullPage: true });
    }
  }
  await page.goto(`/projects/${pid}/experiments/${x.id}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(10, 10, 10)");
  expect(errors).toEqual([]);
});
