/**
 * Attribution, benchmarks and AI growth insights (prd/attribution-benchmarks-insights) against the seeded demo project:
 * attribution set through the REST API on its App Store customers, and 11 peer projects that share benchmarks as
 * Health & Fitness apps (e2e/seed-insights.ts). The fake model writes the insights. Checks every page against the API,
 * the states (not sharing, no run yet, a group under 10 apps, full), phone width, dark mode and the console.
 *   cd apps/dashboard && E2E_PORT=5503 npx playwright test -c e2e/playwright.config.ts insights --workers=1
 * SHOTS=<dir> saves screenshots of each page (light and dark).
 */
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const SHOTS = process.env.SHOTS;
async function json<T = any>(req: APIRequestContext, path: string, init?: { method?: string; data?: unknown }): Promise<T> {
  const res = await req.fetch(path, { method: init?.method ?? "GET", data: init?.data });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status()}: ${text}`);
  return JSON.parse(text) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
async function noSideScroll(page: Page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(sw, "no horizontal page scroll").toBeLessThanOrEqual(iw);
}
async function shots(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-light.png`, fullPage: true });
  // Buttons fade their colours, so wait for the switch to finish before each shot.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(400);
}

let pid = "";
test.beforeEach(async ({ page }) => {
  expect((await page.request.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } })).ok()).toBe(true);
  pid = (await json(page.request, "/auth/me")).projects[0].id;
});

test("attribution: revenue by campaign against the API, spend and ROAS, links to the chart and Customers, CSV", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  await page.goto(`/projects/${pid}/overview`);
  const nav = page.getByRole("navigation", { name: "Project" });
  await nav.getByRole("button", { name: "Analytics" }).click();
  await nav.getByRole("link", { name: "Attribution" }).click();
  await expect(page.getByRole("heading", { name: "Revenue by campaign" })).toBeVisible();
  await page.getByRole("group", { name: "Date range" }).getByRole("button", { name: "90D" }).click();
  await expect(page).toHaveURL(/range=90d/);

  // Every row equals the API's report for the same range.
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const api = await json(page.request, `/v2/projects/${pid}/attribution/report?group_by=campaign&start_date=${day(today - 89 * 86_400_000)}&end_date=${day(today)}`);
  const spring = api.rows.find((r: any) => r.label === "Spring sale");
  expect(spring).toMatchObject({ customers: 2, paying_customers: 2 });
  const row = page.locator('tr[data-row="Spring sale"]');
  await expect(row).toContainText(usd(spring.revenue_to_date));
  await expect(row.locator("td").nth(1)).toHaveText("2");
  await expect(page.locator(".attr-cards")).toContainText(usd(api.total.revenue_to_date));
  await expect(page.locator('tr[data-row="Brand US"]')).toBeVisible(); // Apple Search Ads, by name
  await expect(page.locator('tr[data-row="No attribution"]')).toBeVisible();

  // Spend gives ROAS on the row and in the totals (only rows with spend count).
  const spend = page.getByLabel("Spend for Spring sale");
  await spend.fill("20");
  await spend.press("Enter");
  const roas = `${Math.round((spring.revenue_to_date / 20) * 100)}%`;
  await expect(row).toContainText(roas);
  await expect(page.locator(".attr-cards")).toContainText(roas);
  await page.reload();
  await expect(page.getByLabel("Spend for Spring sale")).toHaveValue("20");

  // CSV with spend and ROAS.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "CSV" }).click()]);
  const csv = readFileSync((await download.path())!, "utf8");
  expect(csv.split("\r\n")[0]).toContain("campaign,new_customers,trial_starts,paying_customers");
  expect(csv).toMatch(/Spring sale,2,0,2,100,[\d.]+,[\d.]+,[\d.]+,[\d.]+,[\d.]+,20,/);

  // By media source, then campaigns of one media source.
  await page.getByLabel("Group by").selectOption("media_source");
  await expect(page.locator('tr[data-row="Meta"]')).toContainText("3");
  await page.getByLabel("Group by").selectOption("campaign");
  await page.getByLabel("Media source").selectOption("Meta");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator('tr[data-row="Retargeting"]')).toBeVisible();

  // The row opens the Revenue chart filtered to it, and the Customers list filtered to it.
  await page.getByRole("link", { name: "Revenue chart for Spring sale" }).click();
  await expect(page).toHaveURL(/\/charts\/revenue\?/);
  await expect(page.getByLabel("Active filters")).toContainText("Campaign: Spring sale");
  await expect(page.getByLabel("Active filters")).toContainText("Media source: Meta");
  await page.goBack();
  await page.getByRole("link", { name: "Customers from Spring sale" }).click();
  await expect(page).toHaveURL(/\/customers\?filter=/);
  await expect(page.getByRole("link", { name: "ne45gd13" })).toBeVisible();
  await expect(page.getByRole("link", { name: "k2aa91qe" })).toBeVisible();
  await expect(page.getByRole("link", { name: "wjqx8kd2rn1" })).toHaveCount(0);
  await shots(page, "customers-filtered");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${pid}/attribution?range=90d`);
  await expect(page.locator('tr[data-row="Spring sale"]')).toBeVisible();
  await noSideScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/projects/${pid}/attribution?range=90d`);
  await shots(page, "attribution");
  expect(errors).toEqual([]);
});

test("attribution dimensions: chart segments, Customers filter suggestions, the customer page", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  // Revenue segmented by media source, against the API.
  await page.goto(`/projects/${pid}/charts/revenue?range=90d&res=month`);
  const seg = page.getByLabel("Segment");
  await expect(seg.locator('optgroup[label="Attribution"] option')).toHaveText(["By media source", "By campaign", "By ad group", "By keyword", "By ad", "By creative"]);
  await seg.selectOption("media_source");
  await expect(page).toHaveURL(/segment=media_source/);
  await expect(page.locator(".legend")).toContainText("Meta");
  await expect(page.locator(".legend")).toContainText("Apple Search Ads");

  // Customers: Campaign condition, with the project's values suggested.
  await page.goto(`/projects/${pid}/customers`);
  await page.getByRole("button", { name: /Filter/ }).click();
  await page.getByRole("button", { name: "Add a condition" }).click();
  await page.getByLabel("Field 1.1").selectOption("campaign");
  await page.getByLabel("Operator 1.1").selectOption("is");
  const value = page.getByLabel("Value 1.1");
  const listId = await value.getAttribute("list");
  expect(listId).toBeTruthy();
  const options = await page.locator(`datalist[id="${listId}"] option`).evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(options).toEqual(expect.arrayContaining(["Brand US", "Spring sale", "Retargeting", "Launch", "Brand search"]));
  await value.fill("Brand US");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page.getByRole("link", { name: "c1tdha8u" })).toBeVisible();
  await expect(page.getByRole("link", { name: "sofia_ios" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ne45gd13" })).toHaveCount(0);

  // The customer page shows the attribution row.
  await page.goto(`/projects/${pid}/customers/c1tdha8u`);
  const panel = page.getByRole("region", { name: "Attribution" }).or(page.locator("section.panel", { has: page.getByText("Revenue by campaign →") }));
  await expect(panel.first()).toContainText("Apple Search Ads");
  await expect(panel.first()).toContainText("Brand US (542370539)");
  await expect(panel.first()).toContainText("Exact (542317095)");
  expect(errors).toEqual([]);
});

test("benchmarks: not sharing, share with a category, the nightly run, a group under 10 apps, stop sharing", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const nav = page.getByRole("navigation", { name: "Project" });
  await page.goto(`/projects/${pid}/overview`);
  await nav.getByRole("button", { name: "Analytics" }).click();
  await nav.getByRole("link", { name: "Benchmarks" }).click();
  await expect(page.getByRole("heading", { name: /Benchmarks/ })).toBeVisible();

  // Not sharing: no peer data, the privacy promises, and the opt-in.
  const before = await json(page.request, `/v2/projects/${pid}/benchmarks`);
  expect(before).toMatchObject({ available: true, settings: { share: false }, metrics: [] });
  await expect(page.getByText("Off by default. Nothing about this project is shared")).toBeVisible();
  await expect(page.getByText("at least 10 apps")).toBeVisible();
  await shots(page, "benchmarks-off");
  await page.getByRole("button", { name: "Share and compare" }).click();
  await expect(page.getByText("Pick your app's category first.")).toBeVisible();
  await page.getByLabel("App category").selectOption("health_fitness");
  await page.getByRole("button", { name: "Share and compare" }).click();

  // Own values arrive at once; peers only after the nightly run.
  await expect(page.locator('[data-metric="initial_conversion"] .bm-you')).toContainText("%", { timeout: 20_000 });
  const runs = await json(page.request, `/v2/projects/${pid}/benchmarks`);
  if (runs.last_computed_at === null) await expect(page.getByText(/Peer numbers arrive after the next nightly run/)).toBeVisible();
  const job = await json(page.request, "/__jobs/benchmarks", { method: "POST" });
  expect(job.aggregated).toBe(true);
  await page.reload();
  const full = await json(page.request, `/v2/projects/${pid}/benchmarks`);
  expect(full.peer_group).toMatchObject({ category: "health_fitness", platform: "all", country: "all" });
  expect(full.peer_group.projects).toBeGreaterThanOrEqual(10);
  const withPeers = full.metrics.filter((m: any) => m.peers);
  expect(withPeers.length).toBeGreaterThan(3);
  for (const m of withPeers) {
    expect(m.peers.projects).toBeGreaterThanOrEqual(10);
    expect(Object.keys(m.peers).sort()).toEqual(["p10", "p25", "p50", "p75", "p90", "projects"]);
  }
  // The page shows the API's numbers: your value, the median, the standing; and the biggest opportunity.
  const tc = withPeers[0];
  const rowEl = page.locator(`[data-metric="${tc.metric}"]`);
  await expect(rowEl.locator(".bm-pct")).toContainText(tc.definition.unit === "%" ? `Median ${tc.peers.p50.toFixed(1)}%` : `Median ${usd(tc.peers.p50)}`);
  await expect(rowEl.locator(".bm-track .you")).toHaveCount(tc.value === null ? 0 : 1);
  await expect(page.getByText(/\d+\+ apps/)).toBeVisible();
  if (full.opportunity) await expect(page.getByTestId("opportunity")).toContainText("Your biggest opportunity");
  await shots(page, "benchmarks");

  // A category without 10 sharing apps shows no peer numbers, and offers all apps.
  await page.getByLabel("Category", { exact: true }).selectOption("travel");
  await expect(page).toHaveURL(/category=travel/);
  await expect(page.getByText(/Fewer than 10 apps share data in Travel/)).toBeVisible();
  const travel = await json(page.request, `/v2/projects/${pid}/benchmarks?category=travel`);
  expect(travel.metrics.every((m: any) => m.peers === null)).toBe(true);
  await page.getByRole("button", { name: "Compare with all apps" }).click();
  await expect(page).toHaveURL(/category=all/);
  await expect(page.locator(".bm-track").first()).toBeVisible();

  // Phone width and dark theme.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".bm-track").first()).toBeVisible();
  await noSideScroll(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Project settings → Benchmarks: stop sharing removes the project's values at once.
  await page.goto(`/projects/${pid}/settings/benchmarks`);
  await expect(page.getByRole("tab", { name: "Benchmarks" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("App category")).toHaveValue("health_fitness");
  await page.getByRole("button", { name: "Stop sharing" }).click();
  await expect(page.getByText("Sharing is off. Your values were removed")).toBeVisible();
  expect(await json(page.request, `/v2/projects/${pid}/benchmarks`)).toMatchObject({ settings: { share: false }, metrics: [] });
  const audit = await json(page.request, `/v2/projects/${pid}/audit_logs`);
  expect(audit.items.filter((x: any) => x.action_type === "benchmarks_settings_updated").length).toBeGreaterThanOrEqual(2);
  // Back on for the insights test.
  await page.getByLabel("App category").selectOption("health_fitness");
  await page.getByRole("button", { name: "Share and compare" }).click();
  await expect(page.getByText("Sharing is on.")).toBeVisible();
  await json(page.request, "/__jobs/benchmarks", { method: "POST" });
  expect(errors).toEqual([]);
});

test("growth insights: write, numbers from the data, ask about one, refresh limit, digest switch and email", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await page.goto(`/projects/${pid}/overview`);
  const panel = page.getByTestId("growth-insights");
  await expect(panel).toBeVisible();
  const write = panel.getByRole("button", { name: /Write insights|Refresh/ });
  await write.click();
  await expect(panel.locator("li.ins-i").first()).toBeVisible({ timeout: 60_000 });
  const api = await json(page.request, `/v2/projects/${pid}/ai/insights`);
  expect(api).toMatchObject({ status: "ready", stale: false, provider: "Fake" });
  expect(api.insights.length).toBeGreaterThanOrEqual(3);
  expect(api.insights.length).toBeLessThanOrEqual(5);
  await expect(panel.locator("li.ins-i")).toHaveCount(api.insights.length);
  // Each insight shows the server's numbers and opens its page.
  for (const [i, ins] of api.insights.entries()) {
    const item = panel.locator("li.ins-i").nth(i);
    await expect(item.getByRole("heading")).toHaveText(ins.title);
    await expect(item.locator(".ins-num").first()).toBeVisible();
    await expect(item.getByRole("link", { name: "Open" })).toHaveAttribute("href", ins.link);
  }
  // When the project shares benchmarks (the test before turned it on), one insight compares it with peers.
  if ((await json(page.request, `/v2/projects/${pid}/benchmarks/settings`)).share) {
    expect(api.insights.some((x: any) => x.metric_ids.some((m: string) => m.startsWith("benchmark_"))), "an insight uses the benchmarks").toBe(true);
  }
  await shots(page, "overview-insights");

  // Refreshing again within the hour: the button says when, and the API refuses it.
  await expect(panel.getByRole("button", { name: "Refresh" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Refresh" })).toHaveAttribute("title", /Refresh again after/);
  const again = await page.request.post(`/v2/projects/${pid}/ai/insights/refresh`);
  expect(again.status()).toBe(429);
  expect((await again.json()).message).toContain("less than an hour ago");

  // Ask about this: a conversation with the question, answered.
  await panel.locator("li.ins-i").first().getByRole("button", { name: "Ask about this" }).click();
  await expect(page).toHaveURL(/\/ai\/aic\w+$/);
  await expect(page.getByText(api.insights[0].title).first()).toBeVisible();
  await expect(page.locator('[data-tool="get-metrics"]').first()).toBeVisible({ timeout: 30_000 });

  // The digest switch on the Overview and in Account settings.
  await page.goto(`/projects/${pid}/overview`);
  const sw = page.getByTestId("growth-insights").getByRole("switch", { name: "Email me weekly" });
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await page.goto("/account/notifications");
  const acc = page.getByRole("switch", { name: "Email me the weekly growth insights digest" });
  await expect(acc).toHaveAttribute("aria-checked", "false");
  await acc.click();
  await expect(acc).toHaveAttribute("aria-checked", "true");

  // The weekly digest emails this week's insights to the admin, with a one-click opt-out.
  await json(page.request, "/__jobs/insights", { method: "POST" });
  const mails = await json<any[]>(page.request, "/__mail?to=e2e@revenuedot.test");
  const digest = mails.reverse().find((m) => /growth ideas/.test(m.subject));
  expect(digest).toBeTruthy();
  expect(digest.text).toContain(api.insights[0].title);
  expect(digest.text).not.toContain("wjqx8kd2rn1");
  const unsub = /https?:\/\/\S+\/auth\/insights\/unsubscribe\?token=\S+/.exec(digest.text)![0];
  await page.goto(new URL(unsub).pathname + new URL(unsub).search);
  await expect(page.getByRole("heading", { name: "Stop the weekly digest?" })).toBeVisible();
  await page.getByRole("button", { name: "Stop the digest" }).click();
  await expect(page.getByRole("heading", { name: "The digest is off" })).toBeVisible();
  expect((await json(page.request, "/auth/me")).user.insights_emails).toBe(false);

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${pid}/overview`);
  await expect(page.getByTestId("growth-insights").locator("li.ins-i").first()).toBeVisible();
  await noSideScroll(page);
  expect(errors).toEqual([]);
});
