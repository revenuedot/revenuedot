/**
 * Targeting and experiments end to end: build an audience, a rule with a placement, check what the SDK receives for a
 * matching and a non-matching customer; then run an experiment and read its results.
 *   pnpm --filter @revenuedot/dashboard e2e -- targeting
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

test("targeting: audience, rule with placement, SDK view; experiment start, results, stop", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `targeting-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Targeting e2e", project_name: "Targeting e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const key = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  await json(req, "POST", `${P}/offerings`, { lookup_key: "default", display_name: "Default" });
  await json(req, "POST", `${P}/offerings`, { lookup_key: "promo", display_name: "Promo" });
  await json(req, "POST", `${P}/offerings`, { lookup_key: "onboarding", display_name: "Onboarding" });
  // Like an app: customer info first (creates the customer), then offerings.
  const sdk = async (user: string) => {
    await req.fetch(`/v1/subscribers/${user}`, { headers: { authorization: `Bearer ${key}` } });
    return (await (await req.fetch(`/v1/subscribers/${user}/offerings`, { headers: { authorization: `Bearer ${key}` } })).json()) as any;
  };
  await sdk("vip"); await sdk("normal");
  await json(req, "POST", `${P}/customers/vip/attributes`, { attributes: [{ name: "plan", value: "gold" }] });

  await page.goto(`/projects/${pid}/targeting`);
  await page.getByRole("tab", { name: "Audiences" }).click();
  await page.getByRole("button", { name: "New audience" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Gold plan");
  await page.getByLabel("Field 1.1").selectOption("custom");
  await page.getByLabel("Attribute 1.1").fill("plan");
  await page.getByLabel("Operator 1.1").selectOption("is");
  await page.getByLabel("Value 1.1").fill("gold");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 customers match today." })).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: "Gold plan", exact: true })).toBeVisible();
  await expect(page.getByText("Attribute plan is gold")).toBeVisible();

  await page.getByRole("tab", { name: "Rules" }).click();
  await page.getByRole("button", { name: "New rule" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Gold sees promo");
  await page.getByLabel("Audience").selectOption({ label: "Gold plan" });
  await page.getByLabel("Current offering").selectOption({ label: "Promo (promo)" });
  await page.getByRole("button", { name: "Add a placement" }).click();
  await page.getByLabel("Placement 1", { exact: true }).fill("onboarding_end");
  await page.getByLabel("Placement offering 1").selectOption({ label: "onboarding" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("cell", { name: "Gold sees promo", exact: true })).toBeVisible();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  expect((await sdk("vip")).current_offering_id).toBe("default");
  await page.getByRole("button", { name: "Actions for Gold sees promo" }).click();
  await page.getByRole("menuitem", { name: "Turn on" }).click();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  const v = await sdk("vip");
  expect(v.current_offering_id).toBe("promo");
  expect(v.placements.offering_ids_by_placement).toEqual({ onboarding_end: "onboarding" });
  expect((await sdk("normal")).current_offering_id).toBe("default");

  // Experiment
  await page.goto(`/projects/${pid}/experiments`);
  await page.getByRole("button", { name: "New experiment" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Promo test");
  await page.getByLabel("Control (a)").selectOption({ label: "default" });
  await page.getByLabel("Treatment (b)").selectOption({ label: "onboarding" });
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/experiments\/prexp/);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  for (let i = 0; i < 12; i++) await sdk(`exp_${stamp}_${i}`);
  await page.getByLabel("Environment").selectOption("sandbox");
  // The choice is kept in the URL (?environment=sandbox), so a reload stays on sandbox results.
  await expect(page).toHaveURL(/\?environment=sandbox$/);
  await page.reload();
  await expect(page.getByLabel("Environment")).toHaveValue("sandbox");
  await expect(page.getByRole("cell", { name: /Control/ })).toBeVisible();
  const res = await json(req, "GET", `${P}/experiments/${new URL(page.url()).pathname.split("/").pop()}/results`);
  expect(res.variants.items.reduce((s: number, x: any) => s + x.customers, 0)).toBe(12);
  await expect(page.getByText("Too early to call")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Stop" }).last().click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["targeting", "experiments"]) {
    await page.goto(`/projects/${pid}/${path}`);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${path} at 390px`).toBe(true);
  }
  expect(errors).toEqual([]);
});
