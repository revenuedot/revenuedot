/**
 * In-app currencies, Customer Center and the audit log, driven through the dashboard and checked against the API and
 * the SDK endpoints. Signs up its own account, so it does not touch the seeded demo data.
 *   pnpm --filter @revenuedot/dashboard e2e -- tier2-pages
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("in-app currencies, Customer Center and audit logs", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `tier2-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Tier 2 e2e", project_name: "Tier 2 e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const test_app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const coins = await json(req, "POST", `${P}/products`, { app_id: test_app.id, store_identifier: "coins_100", type: "consumable", display_name: "100 coins" });

  // ---- In-app currencies ----
  await page.goto(`/projects/${pid}/product-catalog/virtual-currencies`);
  await expect(page.getByRole("heading", { name: "In-app currencies", exact: true })).toBeVisible();
  await expect(page.getByText("No in-app currencies yet")).toBeVisible();
  await page.getByRole("button", { name: "New currency" }).first().click();
  await page.getByLabel("Code").fill("bad code");
  await page.getByLabel("Name").fill("Gold");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("1 to 10 letters");
  await page.getByLabel("Code").fill("GLD");
  await page.getByRole("button", { name: "Add a grant" }).click();
  await page.getByLabel("Product 1", { exact: true }).selectOption({ label: "100 coins" });
  await page.getByLabel("Amount 1", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: "GLD", exact: true })).toBeVisible();
  await expect(page.getByText("100 coins: 100")).toBeVisible();

  // A purchase through the SDK credits the balance (what the grant is for).
  await json(req, "POST", `${P}/customers`, { id: "gamer_1" });
  const key = test_app.public_key ?? (await json(req, "GET", `${P}/apps/${test_app.id}/public_api_keys`)).items[0].key;
  const buy = await req.fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, data: { app_user_id: "gamer_1", fetch_token: `test_${Date.now()}_${stamp}`, product_id: "coins_100", price: 0.99, currency: "USD" } });
  expect(buy.status()).toBe(200);
  const bal = await json(req, "GET", `${P}/customers/gamer_1/virtual_currencies`);
  expect(bal.items[0]).toMatchObject({ currency_code: "GLD", balance: 100 });

  // The customer page shows the balance and adjusts it by hand; a debit below zero is refused.
  await page.goto(`/projects/${pid}/customers/gamer_1`);
  const panel = page.locator("section, .panel").filter({ has: page.getByText("In-app currencies", { exact: true }) }).last();
  await expect(panel).toContainText("100");
  await page.getByRole("button", { name: "Adjust →" }).click();
  await page.getByLabel("Amount").fill("-150");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("cannot go below zero");
  await page.getByLabel("Amount").fill("25");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(panel).toContainText("125");
  expect((await json(req, "GET", `${P}/customers/gamer_1/virtual_currencies`)).items[0]).toMatchObject({ currency_code: "GLD", balance: 125 });
  // Back to the currencies page without a reload: both pages share the currency list in the query cache.
  await page.evaluate((to) => { history.pushState({}, "", to); dispatchEvent(new PopStateEvent("popstate")); }, `/projects/${pid}/product-catalog/virtual-currencies`);
  await expect(page.getByRole("cell", { name: "GLD", exact: true })).toBeVisible();
  // And back to the customer page, which reads the list that page cached.
  await page.evaluate((to) => { history.pushState({}, "", to); dispatchEvent(new PopStateEvent("popstate")); }, `/projects/${pid}/customers/gamer_1`);
  await expect(panel).toContainText("125");
  await page.evaluate((to) => { history.pushState({}, "", to); dispatchEvent(new PopStateEvent("popstate")); }, `/projects/${pid}/product-catalog/virtual-currencies`);

  // Edit, archive, unarchive, delete from the row menu.
  await page.getByRole("button", { name: "Actions for GLD" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("Gold coins");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: "Gold coins", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Actions for GLD" }).click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.getByRole("button", { name: "Archive" }).last().click();
  await expect(page.getByText("Archived")).toBeVisible();
  await page.getByRole("button", { name: "Actions for GLD" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete currency" }).click();
  await expect(page.getByText("No in-app currencies yet")).toBeVisible();
  void coins;

  // ---- Customer Center ----
  await page.goto(`/projects/${pid}/lifecycle/customer-center`);
  await expect(page.getByRole("heading", { name: "Customer Center", exact: true })).toBeVisible();
  await expect(page.getByLabel("Support email")).toHaveValue(/@/);
  await page.getByLabel("Support email").fill("not an email");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert")).toContainText("support.email");
  await page.getByLabel("Support email").fill("help@scanner.app");
  await page.locator("#cc-MANAGEMENT-title").fill("Your plan");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Customer Center saved")).toBeVisible();
  const sdk = await req.fetch("/v1/customercenter/gamer_1", { headers: { authorization: `Bearer ${key}` } });
  const cfg = (await sdk.json()).customer_center;
  expect(cfg.support.email).toBe("help@scanner.app");
  expect(cfg.screens.MANAGEMENT.title).toBe("Your plan");
  await page.getByRole("button", { name: "Reset configuration" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset configuration" }).click();
  await expect(page.getByText("Customer Center reset to the default")).toBeVisible();
  expect((await (await req.fetch("/v1/customercenter/gamer_1", { headers: { authorization: `Bearer ${key}` } })).json()).customer_center.screens.MANAGEMENT.title).toBe("Manage subscription");

  // ---- Audit logs ----
  await page.goto(`/projects/${pid}/settings/audit-logs`);
  await expect(page.getByRole("tab", { name: "Audit logs" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Virtual currency deleted" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Virtual currency created" })).toBeVisible();
  await expect(page.getByText("Dashboard user").first()).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill("2001-01-01");
  await page.getByLabel("To", { exact: true }).fill("2001-01-02");
  await expect(page.getByText("No changes recorded")).toBeVisible();

  // Phone width: nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [`product-catalog/virtual-currencies`, `lifecycle/customer-center`, `settings/audit-logs`]) {
    await page.goto(`/projects/${pid}/${path}`);
    await page.waitForTimeout(300);
    // Neither the document nor the app's scroll area scrolls sideways.
    expect(await page.evaluate(() => { const s = document.querySelector(".scroll"); return document.documentElement.scrollWidth <= window.innerWidth + 1 && (!s || s.scrollWidth <= s.clientWidth + 1); }), `${path} fits 390px`).toBe(true);
  }
  expect(errors.filter((e) => !/status of 4\d\d/.test(e))).toEqual([]);
});
