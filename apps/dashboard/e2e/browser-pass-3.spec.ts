/**
 * Fixes from the third real-user pass on production against RevenueCat (2026-10-02), each checked as a person would:
 * the Test Store price on the app page's inline product form and what the purchase records; the Products table at
 * 1200px; Attach to entitlement creating the entitlement in place; the Offerings header link; the paywall preview with
 * the offering's real prices; Overview "All projects" summing two projects (sandbox switch, periods, project chips);
 * the setup checklist opening Add app directly. Phone width and dark theme at the end; no console errors.
 *   cd apps/dashboard && npx vite build && E2E_PORT=5522 npx playwright test -c e2e/playwright.config.ts browser-pass-3
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const errors: string[] = [];
async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watch(page: Page) {
  page.on("console", (m) => { // 409: the duplicate entitlement this spec makes on purpose. 404: unknown ids the pages probe.
    if (m.type() === "error" && !/404 \(Not Found\)|409 \(Conflict\)/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
}
/** A new account with two projects: "Sleep" (empty) and "Focus". */
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const login = { email: `pass3-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw` };
/** Each test has its own browser context: sign in again. */
const signIn = (page: Page) => json(page.request, "POST", "/auth/login", login);
async function account(page: Page) {
  await json(page.request, "POST", "/auth/signup", { ...login, name: "Ada Lovelace", project_name: "Sleep" });
  const sleep = (await json(page.request, "GET", "/auth/me")).projects[0].id as string;
  const focus = (await json(page.request, "POST", "/v2/projects", { name: "Focus" })).id as string;
  return { sleep, focus };
}

let ids: { sleep: string; focus: string };

test("checklist opens Add app; the app page's inline product asks for a price and the test purchase records it", async ({ page }) => {
  watch(page);
  ids = await account(page);
  await page.goto(`/projects/${ids.sleep}/overview`);
  await page.getByRole("link", { name: "Add an app" }).click();
  const dialog = page.getByRole("dialog", { name: "Add an app" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/apps\?add=app_store$/);
  await dialog.getByRole("button", { name: /Test Store/ }).click();
  await dialog.getByRole("button", { name: "Add app" }).click();
  await page.waitForURL(/\/apps\/app\w+$/);
  const form = page.getByRole("form", { name: "Create a Test Store product" });
  await expect(form.getByLabel("Price amount")).toHaveValue("9.99");
  await expect(form.getByLabel("Currency")).toHaveValue("USD");
  // Validation: empty, zero, a comma, a bad currency.
  for (const [amount, currency, message] of [["", "USD", "Enter the price"], ["0", "USD", "above 0"], ["4,99", "USD", "with a dot"], ["4.99", "EU", "three-letter currency code"]] as const) {
    await form.getByLabel("Price amount").fill(amount);
    await form.getByLabel("Currency").fill(currency);
    await form.getByRole("button", { name: "Create product" }).click();
    await expect(form.getByText(new RegExp(message))).toBeVisible();
  }
  await form.getByLabel("Price amount").fill("4.99");
  await form.getByLabel("Currency").fill("eur");
  await form.getByLabel("Type").selectOption("P1W");
  await form.getByRole("button", { name: "Create product" }).click();
  await expect(page.locator("#tp-product option:checked")).toHaveText("pro_monthly · €4.99");
  await expect(page.getByText("The purchase records €4.99, the product's Test Store price.")).toBeVisible();
  await page.getByLabel("App user ID").fill("pass3_buyer");
  await page.getByRole("button", { name: "Send a test purchase" }).click();
  await expect(page.getByText("pass3_buyer bought pro_monthly for €4.99.")).toBeVisible();
  const tx = await json(page.request, "GET", `/v2/projects/${ids.sleep}/transactions?environment=sandbox`);
  expect(tx.items[0]).toMatchObject({ customer_id: "pass3_buyer", price: { amount: 4.99, currency: "EUR" } });
  expect(tx.items[0].revenue_in_usd).toBeGreaterThan(0);
  const product = (await json(page.request, "GET", `/v2/projects/${ids.sleep}/products?expand=items.indicative_price`)).items[0];
  expect(product).toMatchObject({ subscription: { duration: "P1W" }, indicative_price: { amount_micros: 4_990_000, currency: "EUR" } });
});

test("Products at 1200px: nothing cut; Attach creates an entitlement in place, refuses a duplicate, attaches an existing one", async ({ page }) => {
  watch(page);
  await signIn(page);
  await page.setViewportSize({ width: 1200, height: 900 });
  const P = `/v2/projects/${ids.sleep}`;
  const app = (await json(page.request, "GET", `${P}/apps`)).items[0];
  await json(page.request, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_yearly_with_a_long_identifier", type: "subscription", subscription: { duration: "P1Y" }, display_name: "Pro yearly", test_store_price: { amount_micros: 39_990_000, currency: "USD" } });
  await page.goto(`/projects/${ids.sleep}/product-catalog/products`);
  const table = page.locator("table.cat-ptable");
  await expect(table.getByRole("row")).toHaveCount(3);
  // Entitlements and Created are fully visible: no cell of those columns is cut.
  const cut = await table.evaluate((t) => [...t.querySelectorAll("tbody td:nth-child(4), tbody td:nth-child(5)")].filter((td) => td.scrollWidth > td.clientWidth).map((td) => td.textContent));
  expect(cut).toEqual([]);
  await expect(table.getByText("None").first()).toBeVisible();
  await expect(table.locator("..").evaluate((d) => d.scrollWidth <= d.clientWidth)).resolves.toBe(true);

  await page.getByRole("link", { name: "Pro yearly" }).click();
  await page.getByRole("button", { name: "Attach" }).click();
  let d = page.getByRole("dialog", { name: "Attach to entitlement" });
  await expect(d.getByText("This project has no other entitlement yet.")).toBeVisible();
  await d.getByRole("button", { name: "Create and attach" }).click();
  await expect(d.getByText("Enter an identifier for the entitlement.")).toBeVisible();
  await d.getByLabel("Identifier").fill("pro access");
  await d.getByLabel("Display name").fill("Pro access");
  await d.getByRole("button", { name: "Create and attach" }).click();
  await expect(d.getByText(/cannot contain spaces/)).toBeVisible();
  await d.getByLabel("Identifier").fill("pro");
  await d.getByRole("button", { name: "Create and attach" }).click();
  await expect(d).toBeHidden();
  await expect(page.getByRole("link", { name: "pro", exact: true })).toBeVisible();

  await page.goto(`/projects/${ids.sleep}/product-catalog/products`);
  await expect(table.getByText("pro", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "pro_monthly" }).click();
  await page.getByRole("button", { name: "Attach" }).click();
  d = page.getByRole("dialog", { name: "Attach to entitlement" });
  await d.getByRole("button", { name: "New entitlement" }).click();
  await d.getByLabel("Identifier").fill("pro");
  await d.getByLabel("Display name").fill("Pro again");
  await d.getByRole("button", { name: "Create and attach" }).click();
  await expect(d.getByText(/already exists/)).toBeVisible();
  await d.getByRole("button", { name: "Existing entitlement" }).click();
  await expect(d.getByLabel("Entitlement", { exact: true }).locator("option:checked")).toHaveText("pro · Pro access");
  await d.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(d).toBeHidden();
  const ents = (await json(page.request, "GET", `${P}/entitlements?expand=items.product`)).items;
  expect(ents).toHaveLength(1);
  expect(ents[0].products.items).toHaveLength(2);
});

test("Offerings: the header's New offering link opens the form, with and without offerings", async ({ page }) => {
  watch(page);
  await signIn(page);
  const open = async (pid: string) => {
    await page.goto(`/projects/${pid}/product-catalog/offerings`);
    await page.locator(".head .actions").getByRole("link", { name: "New offering" }).click();
    await expect(page).toHaveURL(/\/offerings\/new$/);
    await expect(page.getByRole("heading", { name: "New offering" })).toBeVisible();
  };
  await open(ids.focus); // empty: the header link and the empty state's button both show
  await json(page.request, "POST", `/v2/projects/${ids.sleep}/offerings`, { lookup_key: "default", display_name: "Standard" });
  await page.goto(`/projects/${ids.sleep}/product-catalog/offerings`);
  await expect(page.getByText("default", { exact: true }).first()).toBeVisible();
  await open(ids.sleep); // with an offering in the table
});

test("paywall preview: the offering's Test Store prices, the intro offer switch, samples without prices", async ({ page }) => {
  watch(page);
  await signIn(page);
  const P = `/v2/projects/${ids.sleep}`;
  const products = (await json(page.request, "GET", `${P}/products`)).items as { id: string; store_identifier: string }[];
  const off = (await json(page.request, "GET", `${P}/offerings`)).items[0];
  const monthly = await json(page.request, "POST", `${P}/offerings/${off.id}/packages`, { lookup_key: "$rc_annual", display_name: "Yearly", position: 1 });
  await json(page.request, "POST", `${P}/packages/${monthly.id}/actions/attach_products`, { products: [{ product_id: products.find((p) => p.store_identifier.startsWith("pro_yearly"))!.id, eligibility_criteria: "all" }] });
  const weekly = await json(page.request, "POST", `${P}/offerings/${off.id}/packages`, { lookup_key: "$rc_weekly", display_name: "Weekly", position: 2 });
  await json(page.request, "POST", `${P}/packages/${weekly.id}/actions/attach_products`, { products: [{ product_id: products.find((p) => p.store_identifier === "pro_monthly")!.id, eligibility_criteria: "all" }] });

  await page.goto(`/projects/${ids.sleep}/paywalls/templates`);
  await expect(page.getByText(/Prices are your products' Test Store prices/)).toBeVisible();
  const card = page.getByRole("button", { name: "Use template Annual first" });
  await expect(card).toContainText("$39.99/yr");
  await expect(card).toContainText("€4.99/wk");
  await card.click();
  await page.getByRole("dialog").getByRole("button", { name: "Create paywall" }).click();
  await page.waitForURL(/\/paywalls\/pw\w+$/);
  const phone = page.getByRole("figure", { name: "Paywall preview" });
  await expect(phone).toContainText("$39.99/yr");
  await expect(phone).not.toContainText("$6.99");
  await expect(page.getByTestId("price-note")).toContainText("Test Store prices from the offering's products");
  await expect(phone).toContainText("Start free trial");
  await page.getByRole("switch", { name: "Intro offer" }).click();
  await expect(phone).not.toContainText("Start free trial");
  await expect(phone).toContainText("$39.99/year");
});

test("Overview → All projects sums both projects; chips, sandbox switch and periods; transactions name the project", async ({ page }) => {
  watch(page);
  await signIn(page);
  // Focus gets its own Test Store purchase.
  const F = `/v2/projects/${ids.focus}`;
  const app = await json(page.request, "POST", `${F}/apps`, { name: "Focus Test Store", type: "test_store" });
  const prod = await json(page.request, "POST", `${F}/products`, { app_id: app.id, store_identifier: "focus_monthly", type: "subscription", subscription: { duration: "P1M" }, test_store_price: { amount_micros: 10_000_000, currency: "USD" } });
  await json(page.request, "POST", `${F}/test_purchases`, { app_user_id: "focus_buyer", product_id: prod.id, app_id: app.id });
  const one = async (pid: string, id: string) => (await json(page.request, "GET", `/v2/projects/${pid}/metrics/overview?environment=sandbox`)).metrics.find((m: any) => m.id === id).value as number;
  const revenue = Math.round(((await one(ids.sleep, "revenue")) + (await one(ids.focus, "revenue"))) * 100) / 100;
  const subs = (await one(ids.sleep, "active_subscriptions")) + (await one(ids.focus, "active_subscriptions"));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/projects/${ids.sleep}/overview?environment=sandbox`);
  const chips = page.getByRole("group", { name: "Projects" });
  await expect(chips.getByRole("button")).toHaveText(["All projects", "Sleep", "Focus"]);
  await expect(chips.getByRole("button", { name: "Sleep" })).toHaveAttribute("aria-pressed", "true");
  await chips.getByRole("button", { name: "All projects" }).click();
  await expect(page).toHaveURL(/projects=all/);
  await expect(page.getByText(/All projects · 2 projects · USD/)).toBeVisible();
  const grid = page.getByRole("region", { name: "Key metrics" });
  await expect(grid).toHaveAttribute("data-scope", "all");
  await expect(grid.locator('[data-metric="revenue"] .v')).toHaveText(`$${revenue.toFixed(2).replace(/\.00$/, "")}`);
  await expect(grid.locator('[data-metric="active_subscriptions"] .v')).toHaveText(String(subs));
  const tx = page.getByRole("region", { name: "Recent transactions" });
  await expect(tx.getByRole("columnheader", { name: "Project" })).toBeVisible();
  await expect(tx.getByRole("row", { name: /focus_buyer|focus…|focu/ }).first()).toContainText("Focus");
  await expect(tx.getByRole("row", { name: /pass3_buyer|pass3…/ }).first()).toContainText("Sleep");
  // Production has no purchases: zero, and the switch keeps All projects.
  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await expect(page).toHaveURL(/projects=all/);
  await expect(grid.locator('[data-metric="revenue"] .v')).toHaveText("$0");
  await page.getByRole("group", { name: "Period" }).getByRole("button", { name: "7D" }).click();
  await expect(page.getByText(/last 7 days compared/)).toBeVisible();
  // The customer link in a row opens that project's customer.
  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await tx.getByRole("link").filter({ hasText: /focus/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.focus}/customers/focus_buyer$`));
  // A project chip opens that project's Overview with the same period and data switch.
  await page.goto(`/projects/${ids.sleep}/overview?environment=sandbox&projects=all&period=7d`);
  await page.getByRole("group", { name: "Projects" }).getByRole("button", { name: "Focus" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.focus}/overview\\?environment=sandbox&period=7d$`));
});

test("Overview → All projects lists a project it leaves out, and why", async ({ page }) => {
  watch(page);
  await signIn(page);
  // The server leaves out projects a custom role or single sign-on closes (apps/server/test/account-overview.test.ts);
  // here the answer is shaped like that to check the page.
  await page.route("**/v2/overview?*", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.projects.push({ id: "proj_closed", name: "Closed project", included: false, reason: "This organization requires single sign-on." });
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`/projects/${ids.sleep}/overview?projects=all`);
  await expect(page.getByTestId("left-out")).toContainText("Not included: Closed project (This organization requires single sign-on.)");
});

test("phone width and dark theme: chips wrap, the dialogs fit, no page scrolls sideways", async ({ page }) => {
  watch(page);
  await signIn(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [`overview?projects=all`, `overview`, `product-catalog/products`, `apps`]) {
    await page.goto(`/projects/${ids.sleep}/${path}`);
    await page.waitForLoadState("networkidle");
    const over = await page.evaluate(() => { const s = document.querySelector(".scroll")!; return s.scrollWidth - s.clientWidth; });
    expect(over, path).toBeLessThanOrEqual(0);
  }
  await page.goto(`/projects/${ids.sleep}/product-catalog/products`);
  await expect(page.locator("table.cat-ptable .cat-show-sm").first()).toBeVisible();
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(10, 10, 10)");
});

test("no console errors", () => {
  expect(errors).toEqual([]);
});
