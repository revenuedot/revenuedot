/**
 * The chart page's RevenueCat-parity extras (prd/charts/PRD.md "The chart page") on the seeded demo project: every chart
 * type (stacked only with two or more series, kept in the URL and in saved charts), the Customers tab against the API and
 * its CSV export, annotations made on the chart (a day by click, a range by drag) shown on other charts, edited and
 * deleted, a Viewer who reads but cannot write, Share preview opened signed out and revoked, Refresh, the Ask AI handoff,
 * phone width, dark theme and no console errors.
 *   E2E_PORT=5540 pnpm --filter @revenuedot/dashboard e2e -- charts-page-extras
 */
import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PW = "e2e-password-1";
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
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
async function signIn(page: Page, email = "e2e@revenuedot.test") {
  expect((await page.request.post("/auth/login", { data: { email, password: PW } })).ok()).toBe(true);
  return (await json(page.request, "/auth/me")).projects[0].id as string;
}
const noPageScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test("chart types: five types, stacked ones need two series; the type is in the URL and saved charts", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/charts/mrr_movement?range=90d&res=week`);
  const chart = page.getByRole("region", { name: "MRR Movement chart" });
  const type = page.getByLabel("Chart type");
  await expect(type).toHaveValue("stacked_column");
  await expect(chart.getByRole("list", { name: "Legend" }).getByRole("listitem")).toHaveCount(5);
  await type.selectOption("stacked_area");
  await expect(page).toHaveURL(/type=stacked_area/);
  await expect(chart.getByTestId("area")).toHaveCount(5);
  await expect(chart.getByRole("img", { name: /drawn as stacked area/ })).toBeVisible();
  await type.selectOption("line");
  await expect(chart.getByTestId("area")).toHaveCount(0);
  await expect(chart.getByRole("img", { name: /drawn as line/ })).toBeVisible();
  await type.selectOption("column");
  await expect(chart.getByRole("img", { name: /drawn as column/ })).toBeVisible();
  await type.selectOption("percent_column");
  await expect(chart.locator(".plot text.ax").filter({ hasText: /^100%$/ })).toHaveCount(1);
  // The table keeps the real values.
  const api = await json(page.request, `/v2/projects/${pid}/charts/mrr_movement?resolution=week&start_date=${iso(Date.now() - 89 * DAY)}&end_date=${iso(Date.now())}`);
  const newMrr = api.values.filter((v: any) => v.measure === 0).map((v: any) => v.value as number);
  const max = Math.max(...newMrr);
  await expect(chart.getByRole("row", { name: /^New MRR/ })).toContainText(max.toLocaleString("en-US", { style: "currency", currency: "USD" }));
  await type.selectOption("stacked_column");
  await expect(page).not.toHaveURL(/type=/);

  // One series: the stacked types are disabled and a stacked type in the URL draws unstacked.
  await page.goto(`/projects/${pid}/charts/revenue?range=90d&res=month&type=stacked_area`);
  await expect(page.getByLabel("Chart type")).toHaveValue("line");
  const disabled = await page.getByLabel("Chart type").locator("option").evaluateAll((os) => os.filter((o) => (o as HTMLOptionElement).disabled).map((o) => (o as HTMLOptionElement).value));
  expect(disabled).toEqual(["stacked_area", "stacked_column", "percent_column"]);
  // Segmented: they open up.
  await page.getByLabel("Segment").selectOption("product");
  await expect(page.getByLabel("Chart type").locator("option:disabled")).toHaveCount(0);
  await expect(page.getByLabel("Chart type")).toHaveValue("stacked_area");

  // A saved chart keeps its type.
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Save this chart" });
  await dlg.getByLabel("Name").fill("Revenue by product, stacked area");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/saved=sc/);
  const saved = (await json(page.request, `/v2/projects/${pid}/saved_charts`)).items.find((x: any) => x.name === "Revenue by product, stacked area");
  expect(saved.view).toMatchObject({ type: "stacked_area", segment: "product", range: "90d", res: "month" });
  await page.goto(`/projects/${pid}/charts/revenue`);
  await page.getByRole("complementary", { name: "Charts" }).getByRole("link", { name: "Revenue by product, stacked area" }).click();
  await expect(page.getByLabel("Chart type")).toHaveValue("stacked_area");
  await page.getByRole("complementary", { name: "Charts" }).getByRole("button", { name: "Remove saved chart Revenue by product, stacked area" }).click();
  expect(errors).toEqual([]);
});

test("Customers tab: the API's sample, links to the customer page, and Export all", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/charts/revenue?range=90d&res=month&tab=customers`);
  const table = page.getByRole("table", { name: "Customers contributing to this chart" });
  await expect(table).toBeVisible();
  const q = `resolution=month&start_date=${iso(Date.now() - 89 * DAY)}&end_date=${iso(Date.now())}&environment=production`;
  const api = await json(page.request, `/v2/projects/${pid}/charts/revenue/customers?${q}`);
  const chart = await json(page.request, `/v2/projects/${pid}/charts/revenue?${q}`);
  expect(api.total_count).toBeGreaterThan(0);
  await expect(page.getByText(`This is a sample of customers contributing to this chart: ${Math.min(100, api.total_count)} of ${api.total_count}`)).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(Math.min(100, api.total_count));
  const first = api.items[0];
  const row = table.getByRole("row").nth(1);
  await expect(row).toContainText(first.app_user_id);
  await expect(row).toContainText(first.value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }));
  await expect(table.getByRole("columnheader", { name: "Latest purchase" })).toBeVisible();
  // Export all: every contributor.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export all" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^revenue-customers-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await download.path())!, "utf8").trim().split("\r\n");
  expect(csv[0]).toBe("App User ID,Customer ID,Status,Store,Product,Latest purchase,First seen,Revenue (USD)");
  expect(csv).toHaveLength(api.total_count + 1);
  // Every contributor's revenue, plus the ad revenue of app users who never became customers (the seed's anonymous ad
  // viewers), adds up to the chart's total. The tab shows the 100 most recent; the export has them all.
  expect(api.unattributed_value).toBeGreaterThan(0);
  expect(csv.slice(1).reduce((s, l) => s + Number(l.split(",").at(-1)), 0) + api.unattributed_value).toBeCloseTo(chart.summary.total.Revenue, 1);
  await expect(page.getByText(`${api.unattributed_value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })} of it is ad revenue from app users with no customer record`)).toBeVisible();
  // The app user id opens the customer page.
  await row.getByRole("link", { name: first.app_user_id }).click();
  await expect(page).toHaveURL(new RegExp(`/customers/${encodeURIComponent(first.app_user_id)}$`));
  // Filters and the sandbox switch reach the tab.
  await page.goto(`/projects/${pid}/charts/revenue?range=90d&res=month&tab=customers&env=sandbox`);
  const sandbox = await json(page.request, `/v2/projects/${pid}/charts/revenue/customers?${q.replace("production", "sandbox")}`);
  await expect(page.getByText(`: ${Math.min(100, sandbox.total_count)} of ${sandbox.total_count}`)).toBeVisible();
  await expect(table.getByRole("cell", { name: "Test Store" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("annotations: a day by click, a range by drag, on every chart; edit and delete; markers open the tab", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/charts/revenue?range=30d`);
  const chart = page.getByRole("region", { name: "Revenue chart" });
  const area = chart.getByTestId("plot-area");
  const box = (await area.boundingBox())!;
  // Day 20 of 30 by click.
  await page.mouse.click(box.x + (box.width / 30) * 19.5, box.y + box.height / 2);
  await expect(chart.getByTestId("selection")).toBeVisible();
  const day = iso(Math.floor(Date.now() / DAY) * DAY - 10 * DAY);
  await chart.getByRole("button", { name: /^Add annotation for / }).click();
  let dlg = page.getByRole("dialog", { name: "New annotation" });
  await expect(dlg.getByLabel("Start date")).toHaveValue(day);
  await expect(dlg.getByLabel("End date")).toHaveValue(day);
  await dlg.getByLabel("Title").fill("Launched paywall v2");
  await dlg.getByLabel("Description (optional)").fill("New annual plan on the main paywall");
  await dlg.getByRole("button", { name: "Add annotation" }).click();
  await expect(dlg).toBeHidden();
  await expect(chart.getByRole("button", { name: /^Annotation: Launched paywall v2/ })).toBeVisible();
  // A range by drag, days 5 to 9.
  await page.mouse.move(box.x + (box.width / 30) * 4.5, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + (box.width / 30) * 8.5, box.y + 60, { steps: 6 });
  await page.mouse.up();
  await chart.getByRole("button", { name: /^Add annotation for .* – / }).click();
  dlg = page.getByRole("dialog", { name: "New annotation" });
  const from = iso(Math.floor(Date.now() / DAY) * DAY - 25 * DAY), to = iso(Math.floor(Date.now() / DAY) * DAY - 21 * DAY);
  await expect(dlg.getByLabel("Start date")).toHaveValue(from);
  await expect(dlg.getByLabel("End date")).toHaveValue(to);
  await dlg.getByLabel("Title").fill("Spring sale");
  await dlg.getByRole("button", { name: "Add annotation" }).click();
  await expect(chart.getByRole("button", { name: /^Annotation: Spring sale/ })).toBeVisible();
  const list = await json(page.request, `/v2/projects/${pid}/chart_annotations`);
  expect(list.items.map((a: any) => [a.title, a.start_date, a.end_date, a.description])).toEqual(expect.arrayContaining([
    ["Spring sale", from, to, null], ["Launched paywall v2", day, day, "New annual plan on the main paywall"],
  ]));

  // On another chart too, and its marker opens the Annotations tab with the annotation picked out.
  await page.goto(`/projects/${pid}/charts/actives?range=30d`);
  const actives = page.getByRole("region", { name: "Active Subscriptions chart" });
  await actives.getByRole("button", { name: /^Annotation: Launched paywall v2/ }).click();
  await expect(page).toHaveURL(/tab=annotations/);
  const items = page.getByRole("list", { name: "Annotations" });
  await expect(items.getByRole("listitem").filter({ hasText: "Launched paywall v2" })).toHaveClass(/on/);
  await expect(items).toContainText("New annual plan on the main paywall");
  await expect(page.getByRole("tab", { name: "Annotations (2)" })).toBeVisible();
  // Edit from the tab.
  await items.getByRole("button", { name: "Edit annotation Spring sale" }).click();
  dlg = page.getByRole("dialog", { name: "Edit annotation" });
  await dlg.getByLabel("Title").fill("Spring sale (20% off)");
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(items).toContainText("Spring sale (20% off)");
  // New annotation from the tab, then delete it.
  await page.getByRole("button", { name: "New annotation" }).click();
  dlg = page.getByRole("dialog", { name: "New annotation" });
  await dlg.getByLabel("Title").fill("Temporary note");
  await dlg.getByRole("button", { name: "Add annotation" }).click();
  await items.getByRole("button", { name: "Delete annotation Temporary note" }).click();
  await page.getByRole("dialog", { name: 'Delete "Temporary note"?' }).getByRole("button", { name: "Delete annotation" }).click();
  await expect(items).not.toContainText("Temporary note");
  // Outside the range: not on a 7-day chart.
  await page.goto(`/projects/${pid}/charts/actives?range=7d`);
  await expect(page.getByRole("region", { name: "Active Subscriptions chart" }).getByTestId("annotation-marker")).toHaveCount(0);
  // The audit log names every write.
  const log = await json(page.request, `/v2/projects/${pid}/audit_logs?limit=50`);
  expect(log.items.filter((x: any) => x.target_type === "chart_annotation").map((x: any) => x.action_type)).toEqual(expect.arrayContaining(["chart_annotation_created", "chart_annotation_updated", "chart_annotation_deleted"]));
  expect(errors).toEqual([]);
});

async function viewer(page: Page, browser: Browser, pid: string) {
  const email = `viewer-${Date.now()}@revenuedot.test`;
  expect((await page.request.post(`/v2/projects/${pid}/invites`, { data: { email, role: "viewer" } })).ok()).toBe(true);
  let link = "";
  await expect.poll(async () => {
    const mails = (await (await page.request.get(`/__mail?to=${encodeURIComponent(email)}`)).json()) as { text: string }[];
    const m = mails.map((x) => /https?:\/\/[^\s]+\/invite\?token=[^\s]+/.exec(x.text)?.[0]).find(Boolean);
    if (m) link = new URL(m).pathname + new URL(m).search;
    return !!m;
  }, { timeout: 10_000 }).toBe(true);
  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(link);
  await guest.getByLabel("Your name").fill("Vic Viewer");
  await guest.getByLabel("Password").fill(PW);
  await guest.getByRole("button", { name: "Create account and join" }).click();
  await guest.waitForURL(new RegExp(`/projects/${pid}/overview`));
  return guest;
}

test("share preview: a link anyone can open signed out, numbers only; revoke stops it; a Viewer reads only", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const errors = watchConsole(page);
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/charts/revenue?range=90d&res=month&segment=product`);
  await expect(page.getByRole("region", { name: "Revenue chart" })).toBeVisible();
  await page.getByRole("button", { name: "More chart actions" }).click();
  await page.getByRole("menuitem", { name: "Share preview" }).click();
  const dlg = page.getByRole("dialog", { name: "Share preview" });
  await expect(dlg).toContainText("monthly, by product, stacked column");
  await dlg.getByRole("button", { name: "Create link" }).click();
  await expect(dlg.getByRole("img", { name: "Preview of the shared Revenue chart" })).toBeVisible();
  const url = await dlg.getByRole("textbox", { name: "Share link" }).inputValue();
  expect(url).toMatch(/\/share\/charts\/cs_[A-Za-z0-9_-]{32}$/);
  await expect(dlg.getByRole("list", { name: "Active share links" }).getByRole("listitem")).toHaveCount(1);

  // Signed out, in another browser context.
  const anon = await browser.newContext();
  const pub = await anon.newPage();
  const res = await pub.goto(url);
  expect(res!.status()).toBe(200);
  await expect(pub.getByRole("heading", { name: "Revenue" })).toBeVisible();
  await expect(pub.getByText(/Scanner · .* · Monthly · By product/)).toBeVisible();
  const chart = await json(page.request, `/v2/projects/${pid}/charts/revenue?resolution=month&start_date=${iso(Date.now() - 89 * DAY)}&end_date=${iso(Date.now())}`);
  await expect(pub.locator(".stat").first()).toContainText((chart.summary.total.Revenue as number).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }));
  const html = await pub.content();
  const customers = await json(page.request, `/v2/projects/${pid}/charts/revenue/customers?resolution=month&start_date=${iso(Date.now() - 89 * DAY)}&end_date=${iso(Date.now())}`);
  for (const c of customers.items) { expect(html).not.toContain(c.app_user_id); expect(html).not.toContain(c.customer_id); }
  expect(html).toContain(`content="${url}/og.png"`);
  const og = await pub.request.get(`${url}/og.png`);
  expect(og.status()).toBe(200);
  expect(og.headers()["content-type"]).toBe("image/png");
  // Phone width and dark theme on the public page.
  await pub.setViewportSize({ width: 390, height: 844 });
  await pub.emulateMedia({ colorScheme: "dark" });
  await pub.reload();
  await noPageScroll(pub);
  expect(await pub.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 10, 10)");

  // A Viewer sees the link but cannot make or revoke one, and cannot annotate.
  const guest = await viewer(page, browser, pid);
  const guestErrors = watchConsole(guest);
  await guest.goto(`/projects/${pid}/charts/revenue?range=90d&res=month&tab=annotations`);
  await expect(guest.getByRole("region", { name: "Revenue chart" })).toBeVisible();
  await expect(guest.getByRole("button", { name: "New annotation" })).toHaveCount(0);
  const gbox = (await guest.getByTestId("plot-area").boundingBox())!;
  await guest.mouse.click(gbox.x + gbox.width / 2, gbox.y + gbox.height / 2);
  await expect(guest.getByRole("button", { name: /^Add annotation for/ })).toHaveCount(0);
  await guest.getByRole("button", { name: "More chart actions" }).click();
  await guest.getByRole("menuitem", { name: "Share preview" }).click();
  const gdlg = guest.getByRole("dialog", { name: "Share preview" });
  await expect(gdlg.getByText("Viewers can open the links below.")).toBeVisible();
  await expect(gdlg.getByRole("button", { name: "Create link" })).toHaveCount(0);
  await expect(gdlg.getByRole("list", { name: "Active share links" }).getByRole("listitem")).toHaveCount(1);
  await expect(gdlg.getByRole("button", { name: /^Revoke link/ })).toHaveCount(0);
  expect(guestErrors).toEqual([]);

  // Revoke: the signed-out page says so at once.
  await dlg.getByRole("button", { name: /^Revoke link/ }).click();
  await page.getByRole("dialog", { name: "Revoke this link?" }).getByRole("button", { name: "Revoke link" }).click();
  await expect(dlg.getByText("No links yet.")).toBeVisible();
  const gone = await pub.reload();
  expect(gone!.status()).toBe(410);
  await expect(pub.getByRole("heading", { name: "This link was revoked." })).toBeVisible();
  expect((await pub.request.get(`${url}/og.png`)).status()).toBe(410);
  await anon.close();
  expect(errors).toEqual([]);
});

test("Refresh recomputes; Ask AI opens RevenueDot AI with the chart and its view", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/charts/mrr?range=90d&res=week&segment=country`);
  await expect(page.getByRole("region", { name: "MRR chart" })).toBeVisible();
  const recomputed = page.waitForRequest((r) => /\/charts\/mrr\?/.test(r.url()));
  await page.getByRole("button", { name: "Refresh" }).click();
  await recomputed;
  await expect(page.getByText("Chart recomputed")).toBeVisible();
  await page.getByRole("button", { name: "Ask AI" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/ai$`));
  const box = page.getByLabel("Ask RevenueDot AI");
  await expect(box).toHaveValue(/^@MRR What stands out in this chart for \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}, and why\?$/);
  await box.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/ai/[^/]+$`));
  const cid = page.url().split("/").pop()!;
  await expect.poll(async () => (await json(page.request, `/v2/projects/${pid}/ai/conversations/${cid}`)).messages.length, { timeout: 20_000 }).toBeGreaterThan(1);
  const conv = await json(page.request, `/v2/projects/${pid}/ai/conversations/${cid}`);
  expect(conv.messages[0].metadata.mentions).toEqual([{ type: "chart", id: "mrr", label: "MRR", params: expect.objectContaining({ resolution: "week", segment: "country", environment: "production" }) }]);
  expect(errors).toEqual([]);
});

test("phone width and dark theme: the chart page, its tabs and dialogs fit", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  const pid = await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/projects/${pid}/charts/revenue?range=90d&res=month&segment=product`);
  await expect(page.getByRole("region", { name: "Revenue chart" })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 10, 10)");
  await noPageScroll(page);
  for (const tab of ["Customers", /Annotations/]) {
    await page.getByRole("tab", { name: tab }).click();
    await noPageScroll(page);
  }
  await page.getByRole("button", { name: "More chart actions" }).click();
  await page.getByRole("menuitem", { name: "Share preview" }).click();
  await expect(page.getByRole("dialog", { name: "Share preview" })).toBeVisible();
  await noPageScroll(page);
  expect(errors).toEqual([]);
});
