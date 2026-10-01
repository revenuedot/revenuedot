/**
 * Charts against the seeded demo project (App Store production history and Test Store sandbox purchases, e2e/server.ts):
 * the rail, the chart page's controls kept in the URL, numbers checked against the API and the Overview, segments,
 * filters, the sandbox switch, CSV download, cohort tables, hover and keyboard, and phone width.
 *   E2E_PORT=5391 pnpm --filter @revenuedot/dashboard e2e -- charts
 */
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, path: string): Promise<T> {
  const res = await req.fetch(path);
  const text = await res.text();
  if (!res.ok()) throw new Error(`GET ${path} → ${res.status()}: ${text}`);
  return JSON.parse(text) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

test("charts: rail, MRR against the API and the Overview, controls in the URL, segments, filters, sandbox, CSV", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const req = page.request;
  expect((await req.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } })).ok()).toBe(true);
  const pid: string = (await json(req, "/auth/me")).projects[0].id;

  // The Charts entry opens the first chart; the rail lists the 42 dashboard charts in RevenueCat's groups.
  await page.goto(`/projects/${pid}/overview`);
  const nav = page.getByRole("navigation", { name: "Project" });
  await nav.getByRole("button", { name: "Analytics" }).click();
  await nav.getByRole("link", { name: "Charts" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/charts/revenue$`));
  const rail = page.getByRole("complementary", { name: "Charts" });
  await expect(rail.getByRole("link")).toHaveCount(42);
  await expect(rail.locator(".crail-g > .label")).toHaveText(["Revenue", "Subscriptions", "Ads", "LTV", "Customers", "Conversion", "Paywalls", "Trials", "Churn and refunds"]);
  await rail.getByLabel("Search charts").fill("mrr");
  await expect(rail.getByRole("link")).toHaveCount(2);
  await rail.getByRole("link", { name: "MRR", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MRR", exact: true })).toBeVisible();

  // The latest MRR equals the API's last point and the Overview's MRR card (same definition, two code paths).
  const api = await json(req, `/v2/projects/${pid}/charts/mrr?resolution=day`);
  const last = api.values.at(-1).value as number;
  const overview = await json(req, `/v2/projects/${pid}/metrics/overview`);
  expect(last).toBeCloseTo(overview.metrics.find((m: any) => m.id === "mrr").value, 2);
  expect(last).toBeGreaterThan(0);
  await expect(page.locator(".cstats")).toContainText(money(last));
  await expect(page.getByRole("row", { name: /^MRR/ })).toBeVisible();

  // Range and resolution are in the URL; 12 months defaults to monthly periods.
  await page.getByRole("group", { name: "Date range" }).getByRole("button", { name: "12M" }).click();
  await expect(page).toHaveURL(/range=12m/);
  await expect(page.getByLabel("Resolution")).toHaveValue("month");
  const months = await page.locator(".ctable thead th").count();
  expect(months).toBeGreaterThanOrEqual(13);
  await page.getByLabel("Resolution").selectOption("week");
  await expect(page).toHaveURL(/res=week/);

  // Hover shows every series at that period; the plot also answers the arrow keys.
  await page.getByRole("group", { name: "Date range" }).getByRole("button", { name: "30D" }).click();
  const plot = page.locator(".plot");
  const box = (await plot.boundingBox())!;
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2);
  await expect(page.locator(".tip")).toBeVisible();
  await expect(page.locator(".tip")).toContainText("MRR");
  await page.mouse.move(box.x - 40, box.y - 40);
  await plot.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".tip")).toBeVisible();

  // Segment by country: a legend and one table row per country, plus the total.
  await page.getByLabel("Segment").selectOption("country");
  await expect(page).toHaveURL(/segment=country/);
  await expect(page.getByRole("list", { name: "Legend" })).toContainText("United States");
  await expect(page.locator(".ctable tbody th", { hasText: "Total" })).toBeVisible();
  await page.getByLabel("Segment").selectOption("");

  // Filter to one product: a chip, and the value the API gives for the same filter.
  await page.getByRole("button", { name: "Filter" }).click();
  const filters = page.getByRole("dialog", { name: "Filters" });
  await filters.getByRole("tab", { name: "Product", exact: true }).click();
  await filters.getByLabel("Pro weekly").click();
  await expect(filters.getByLabel("Pro weekly")).toBeChecked();
  await filters.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Active filters")).toContainText("Product: Pro weekly");
  const weekly = await json(req, `/v2/projects/${pid}/charts/mrr?resolution=day&filters=${encodeURIComponent(JSON.stringify([{ name: "product", values: ["scanner.pro.weekly"] }]))}`);
  await expect(page.locator(".cstats")).toContainText(money(weekly.values.at(-1).value));
  await page.getByRole("button", { name: "Remove Product filter" }).click();
  await expect(page.getByLabel("Active filters")).toHaveCount(0);

  // Sandbox: Test Store purchases only.
  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await expect(page).toHaveURL(/env=sandbox/);
  await expect(page.getByText("Showing sandbox and Test Store purchases only.")).toBeVisible();
  const sandbox = await json(req, `/v2/projects/${pid}/charts/mrr?resolution=day&environment=sandbox`);
  await expect(page.locator(".cstats")).toContainText(money(sandbox.values.at(-1).value));
  await page.getByRole("switch", { name: "Sandbox data" }).click();

  // CSV of what the table shows.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^mrr-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await download.path())!, "utf8").trim().split("\n");
  expect(csv[0]).toBe("period,MRR,incomplete");
  expect(csv).toHaveLength(31);
  expect(Number(csv.at(-1)!.split(",")[1])).toBeCloseTo(last, 2);

  // Revenue has two units, plotted one at a time (never two y axes).
  await rail.getByLabel("Search charts").fill("");
  await rail.getByRole("link", { name: "Revenue", exact: true }).click();
  const measure = page.getByRole("group", { name: "Measure" });
  await measure.getByRole("button", { name: "Transactions" }).click();
  await expect(measure.getByRole("button", { name: "Transactions" })).toHaveAttribute("aria-pressed", "true");

  // Selectors: proceeds are lower than revenue.
  const rev = await json(req, `/v2/projects/${pid}/charts/revenue?resolution=day`);
  await page.getByLabel("Revenue type").selectOption("proceeds");
  await expect(page).toHaveURL(/sel=/);
  const proceeds = await json(req, `/v2/projects/${pid}/charts/revenue?resolution=day&selectors=${encodeURIComponent('{"revenue_type":"proceeds"}')}`);
  expect(proceeds.summary.total.Proceeds).toBeLessThan(rev.summary.total.Revenue);
  await expect(page.locator(".cstats")).toContainText("Proceeds");

  expect(errors).toEqual([]);
});

test("charts: cohort tables, every chart renders, phone width", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  const req = page.request;
  expect((await req.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } })).ok()).toBe(true);
  const pid: string = (await json(req, "/auth/me")).projects[0].id;

  await page.goto(`/projects/${pid}/charts/subscription_retention`);
  const table = page.getByRole("region", { name: "Subscription Retention table" });
  await expect(table.getByRole("columnheader", { name: "Subscriptions" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Period 0" })).toBeVisible();
  await page.goto(`/projects/${pid}/charts/prediction_explorer`);
  await expect(page.locator(".cohort td.pred").first()).toBeVisible();
  await expect(page.getByText("Italic values are predicted.")).toBeVisible();
  await page.goto(`/projects/${pid}/charts/cohort_explorer`);
  await page.getByLabel("Measure", { exact: true }).selectOption("revenue");
  await expect(page.getByRole("region", { name: "Cohort Explorer table" })).toBeVisible();

  // Every chart in the rail loads without an error.
  const names = await page.getByRole("complementary", { name: "Charts" }).getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  expect(names).toHaveLength(42);
  for (const href of names) {
    await page.goto(href);
    await expect(page.locator(".cpanel:not([aria-busy])"), href).toBeVisible();
    await expect(page.getByText("Could not load the chart")).toHaveCount(0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${pid}/charts/actives`);
  await expect(page.getByRole("heading", { name: "Active Subscriptions", exact: true })).toBeVisible();
  expect(await page.locator(".scroll").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});
