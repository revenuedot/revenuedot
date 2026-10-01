/**
 * Paywalls end to end: create a paywall for an offering, fill the template form, check the preview, publish, and check
 * what the SDK receives (paywall components with the texts and packages). Then reopen, unpublish and delete.
 *   pnpm --filter @revenuedot/dashboard e2e -- paywalls
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
  page.on("console", (m) => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("paywall: create, edit with a template, preview, publish to the SDK, unpublish, delete", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `paywall-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Paywall e2e", project_name: "Paywall e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const key = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  const monthly = await json(req, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_monthly", type: "subscription", subscription: { duration: "P1M" } });
  const annual = await json(req, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_annual", type: "subscription", subscription: { duration: "P1Y" } });
  const off = await json(req, "POST", `${P}/offerings`, { lookup_key: "default", display_name: "Default" });
  for (const [lk, name, prod] of [["$rc_monthly", "Monthly", monthly], ["$rc_annual", "Annual", annual]] as const) {
    const pk = await json(req, "POST", `${P}/offerings/${off.id}/packages`, { lookup_key: lk, display_name: name });
    await json(req, "POST", `${P}/packages/${pk.id}/actions/attach_products`, { products: [{ product_id: prod.id, eligibility_criteria: "all" }] });
  }

  await page.goto(`/projects/${pid}/paywalls`);
  await expect(page.getByText("No paywalls yet")).toBeVisible();
  await page.getByRole("button", { name: "New paywall" }).first().click();
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/paywalls\/pw/);

  await page.getByLabel("Headline", { exact: true }).fill("Scan without limits");
  await page.getByLabel("Features", { exact: true }).fill("Unlimited scans\nCloud backup");
  await page.getByLabel("Label for $rc_annual", { exact: true }).fill("Yearly, save 40%");
  await page.getByRole("radio").nth(1).check();
  await page.getByLabel("Button text", { exact: true }).fill("Start free trial");
  const preview = page.getByRole("figure", { name: "Paywall preview" });
  await expect(preview).toContainText("Scan without limits");
  await expect(preview).toContainText("Yearly, save 40%");
  await expect(preview).toContainText("Start free trial");
  await page.getByRole("button", { name: "Hero image" }).click();
  await expect(page.getByLabel("Hero image", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Classic" }).click();

  // Not visible to the SDK until published.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  const sdk = async () => (await (await req.fetch("/v1/subscribers/e2e_user/offerings", { headers: { authorization: `Bearer ${key}` } })).json()) as any;
  expect((await sdk()).offerings[0].has_paywall_components).toBe(false);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/^Published\. Apps get it/)).toBeVisible();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  const o = (await sdk()).offerings[0];
  expect(o.has_paywall_components).toBe(true);
  const strings = Object.values(o.paywall_components.components_localizations.en_US);
  expect(strings).toEqual(expect.arrayContaining(["Scan without limits", "Yearly, save 40%", "Start free trial", "✓  Unlimited scans"]));
  const pkgIds: string[] = [];
  JSON.stringify(o.paywall_components.components_config, (k, v) => { if (k === "package_id") pkgIds.push(v); return v; });
  expect(pkgIds).toEqual(["$rc_monthly", "$rc_annual"]);

  // The form comes back after a reload.
  await page.reload();
  await expect(page.getByLabel("Headline", { exact: true })).toHaveValue("Scan without limits");
  await expect(page.getByLabel("Label for $rc_annual", { exact: true })).toHaveValue("Yearly, save 40%");

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByRole("button", { name: "Paywall actions" }).click();
  await page.getByRole("menuitem", { name: "Unpublish" }).click();
  await page.getByRole("button", { name: "Unpublish" }).last().click();
  await expect(page.getByText("Not published")).toBeVisible();
  expect((await sdk()).offerings[0].has_paywall_components).toBe(false);

  await page.getByRole("button", { name: "Paywall actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete paywall" }).click();
  await page.waitForURL(/\/paywalls$/);
  await expect(page.getByText("No paywalls yet")).toBeVisible();
  expect(errors).toEqual([]);
});
