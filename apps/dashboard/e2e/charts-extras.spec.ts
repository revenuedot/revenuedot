/**
 * Charts extras (prd/paywalls/PRD.md §6) on the seeded demo project: compare to the previous period (dashed line,
 * "Previous period" row, change per summary value, numbers checked against the API for the earlier window) and saved
 * charts (save with the view, list in the rail, open restores the view, update, remove).
 *   E2E_PORT=5401 pnpm --filter @revenuedot/dashboard e2e -- charts-extras
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, path: string): Promise<T> {
  const res = await req.fetch(path);
  if (!res.ok()) throw new Error(`GET ${path} → ${res.status()}`);
  return (await res.json()) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

test("charts: compare to the previous period, and saved charts", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const req = page.request;
  expect((await req.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } })).ok()).toBe(true);
  const pid: string = (await json(req, "/auth/me")).projects[0].id;

  // Compare: the 90 days before the current 90 days, monthly.
  await page.goto(`/projects/${pid}/charts/revenue?range=90d&res=month`);
  const chart = page.getByRole("region", { name: "Revenue chart" });
  await expect(chart.getByText(/Revenue · total/i)).toBeVisible();
  await page.getByRole("switch", { name: "Compare to previous period" }).click();
  await expect(page).toHaveURL(/cmp=1/);
  await expect(chart.getByTestId("compare-line")).toHaveAttribute("d", /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){2,}$/);
  await expect(chart.getByRole("row", { name: /Previous period/ })).toBeVisible();
  await expect(chart.getByTestId("compare-delta").first()).toContainText("vs");
  // The previous window's total matches the API for that window.
  const today = Math.floor(Date.now() / DAY) * DAY;
  const start = today - 89 * DAY;
  const prev = await json(req, `/v2/projects/${pid}/charts/revenue?resolution=month&start_date=${iso(start - DAY - 89 * DAY)}&end_date=${iso(start - DAY)}`);
  const prevTotal = prev.summary.total.Revenue as number;
  await expect(chart.getByTestId("compare-delta").first()).toContainText(prevTotal.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }));

  // Save it; it shows on top of the rail.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Save this chart" });
  await dlg.getByLabel("Name").fill("Revenue, quarter on quarter");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Chart saved")).toBeVisible();
  const rail = page.getByRole("complementary", { name: "Charts" });
  const savedLink = rail.getByRole("link", { name: "Revenue, quarter on quarter" });
  await expect(savedLink).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Revenue, quarter on quarter");
  const saved = (await json(req, `/v2/projects/${pid}/saved_charts`)).items;
  expect(saved).toEqual([expect.objectContaining({ name: "Revenue, quarter on quarter", chart_name: "revenue", view: expect.objectContaining({ range: "90d", res: "month", compare: true }) })]);

  // Another chart, then back through the saved link: the view comes back.
  await rail.getByRole("link", { name: "MRR", exact: true }).click();
  await expect(page).toHaveURL(/\/charts\/mrr$/);
  await savedLink.click();
  await expect(page).toHaveURL(/\/charts\/revenue\?.*range=90d/);
  await expect(page).toHaveURL(/cmp=1/);
  await expect(page.getByRole("switch", { name: "Compare to previous period" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Resolution")).toHaveValue("month");

  // Update it with a weekly resolution.
  await page.getByLabel("Resolution").selectOption("week");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog", { name: "Save chart" }).getByRole("button", { name: "Update" }).click();
  await expect(page.getByText("Saved chart updated")).toBeVisible();
  expect((await json(req, `/v2/projects/${pid}/saved_charts`)).items[0].view.res).toBe("week");

  // Remove it (keeps the demo project as it was for charts.spec.ts).
  await rail.getByRole("button", { name: "Remove saved chart Revenue, quarter on quarter" }).click();
  await expect(savedLink).toHaveCount(0);
  expect((await json(req, `/v2/projects/${pid}/saved_charts`)).items).toEqual([]);
  // Cohort tables have no comparison.
  await page.goto(`/projects/${pid}/charts/subscription_retention`);
  await expect(page.getByRole("switch", { name: "Compare to previous period" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
