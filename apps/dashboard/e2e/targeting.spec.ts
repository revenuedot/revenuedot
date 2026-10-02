/**
 * Targeting end to end (prd/experiments/PRD.md §6): an audience, a rule with a placement made in the dialog, the rule
 * card's sentences, turning it on (Live), a rule starting tomorrow (Scheduled), turning one off and an ended rule
 * (Inactive), duplicate, order by keyboard and drag across the global order, the default offering picker, what the SDK
 * receives for matching and other customers, Create with RevenueDot AI approving a rule that stays off; phone width and
 * dark theme; no console errors.
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

test("targeting: audience, rule cards in Live, Scheduled and Inactive, order, default offering, SDK view, AI draft", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `targeting-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Targeting e2e", project_name: "Targeting e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const key = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  const def = await json(req, "POST", `${P}/offerings`, { lookup_key: "default", display_name: "Default" });
  const promo = await json(req, "POST", `${P}/offerings`, { lookup_key: "promo", display_name: "Promo" });
  await json(req, "POST", `${P}/offerings`, { lookup_key: "onboarding", display_name: "Onboarding" });
  // Like an app: customer info first (creates the customer), then offerings.
  const sdk = async (user: string) => {
    await req.fetch(`/v1/subscribers/${user}`, { headers: { authorization: `Bearer ${key}` } });
    return (await (await req.fetch(`/v1/subscribers/${user}/offerings`, { headers: { authorization: `Bearer ${key}` } })).json()) as any;
  };
  await sdk("vip"); await sdk("normal");
  await json(req, "POST", `${P}/customers/vip/attributes`, { attributes: [{ name: "plan", value: "gold" }] });

  await page.goto(`/projects/${pid}/targeting`);
  await expect(page.getByRole("tab", { name: "Live · 0" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No live rules: everyone sees the default offering below.")).toBeVisible();
  await expect(page.getByLabel("Select default offering")).toHaveValue(def.id);

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

  // A rule with a placement; it is created off, in Inactive.
  await page.getByRole("tab", { name: /^Live/ }).click();
  await page.getByRole("button", { name: "New rule" }).click();
  await page.getByRole("menuitem", { name: "Create from scratch" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Gold sees promo");
  await page.getByLabel("Audience").selectOption({ label: "Gold plan" });
  await page.getByLabel("Current offering").selectOption({ label: "Promo (promo)" });
  await page.getByRole("button", { name: "Add a placement" }).click();
  await page.getByLabel("Placement 1", { exact: true }).fill("onboarding_end");
  await page.getByLabel("Placement offering 1").selectOption({ label: "onboarding" });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("tab", { name: "Inactive · 1" })).toBeVisible();
  expect((await sdk("vip")).current_offering_id).toBe("default");
  await page.getByRole("tab", { name: /^Inactive/ }).click();
  const card = page.getByRole("listitem", { name: "Rule Gold sees promo" });
  await expect(card).toContainText("If customer matches Gold plan then show");
  await expect(card).toContainText("onboarding for onboarding_end");
  await expect(card).toContainText("promo for all other cases");
  await card.getByRole("button", { name: "Actions for Gold sees promo" }).click();
  await page.getByRole("menuitem", { name: "Turn on" }).click();
  await expect(page.getByRole("tab", { name: "Live · 1" })).toBeVisible();
  await page.getByRole("tab", { name: /^Live/ }).click();
  await expect(page.getByRole("listitem", { name: "Rule Gold sees promo" }).getByText("Live", { exact: true })).toBeVisible();
  const v = await sdk("vip");
  expect(v.current_offering_id).toBe("promo");
  expect(v.placements.offering_ids_by_placement).toEqual({ onboarding_end: "onboarding" });
  expect((await sdk("normal")).current_offering_id).toBe("default");

  // Scheduled: on, starting tomorrow (from the dialog's start date).
  await page.getByRole("button", { name: "New rule" }).click();
  await page.getByRole("menuitem", { name: "Create from scratch" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Weekend sale");
  await page.getByLabel("Current offering").selectOption({ label: "Onboarding (onboarding)" });
  const tomorrow = new Date(Date.now() + 86_400_000);
  const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel("Starts").fill(local);
  await page.getByLabel("Ends").fill(local);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toHaveText("The end must be after the start.");
  await page.getByLabel("Ends").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("tab", { name: /^Inactive/ }).click();
  await page.getByRole("button", { name: "Actions for Weekend sale" }).click();
  await page.getByRole("menuitem", { name: "Turn on" }).click();
  await expect(page.getByRole("tab", { name: "Scheduled · 1" })).toBeVisible();
  await page.getByRole("tab", { name: /^Scheduled/ }).click();
  await expect(page.getByRole("listitem", { name: "Rule Weekend sale" })).toContainText("Starts");
  const weekend = (await json(req, "GET", `${P}/targeting_rules`)).items.find((r: any) => r.name === "Weekend sale");
  expect(weekend).toMatchObject({ state: "active", ends_at: null });
  expect(Math.abs(weekend.starts_at - tomorrow.getTime())).toBeLessThan(60_000);
  expect((await sdk("normal")).current_offering_id).toBe("default");

  // An ended rule is Inactive. Duplicate makes an inactive copy.
  await json(req, "POST", `${P}/targeting_rules`, { name: "Spring sale", offering_id: promo.id, state: "active", starts_at: Date.now() - 2 * 86_400_000, ends_at: Date.now() - 86_400_000 });
  await page.reload();
  await page.getByRole("tab", { name: /^Inactive/ }).click();
  await expect(page.getByRole("listitem", { name: "Rule Spring sale" }).getByText("Ended", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^Live/ }).click();
  await page.getByRole("button", { name: "Actions for Gold sees promo" }).click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByRole("tab", { name: "Inactive · 2" })).toBeVisible();
  const copy = (await json(req, "GET", `${P}/targeting_rules`)).items.find((r: any) => r.name === "Gold sees promo (copy)");
  expect(copy).toMatchObject({ state: "inactive", placements: { onboarding_end: expect.stringMatching(/^ofrng/) } });

  // Order: a second live rule, moved above the first by keyboard, then back by drag.
  const everyone = await json(req, "POST", `${P}/targeting_rules`, { name: "Everyone onboarding", offering_id: (await json(req, "GET", `${P}/offerings`)).items.find((o: any) => o.lookup_key === "onboarding").id, state: "active" });
  await page.reload();
  const liveOrder = () => page.locator(".tg-card .tg-name").allTextContents();
  await expect.poll(liveOrder).toEqual(["Gold sees promo", "Everyone onboarding"]);
  expect((await sdk("vip")).current_offering_id).toBe("promo");
  await page.getByRole("button", { name: /^Move Everyone onboarding/ }).focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(liveOrder).toEqual(["Everyone onboarding", "Gold sees promo"]);
  await expect.poll(async () => (await sdk("vip")).current_offering_id).toBe("onboarding");
  const ids = (await json(req, "GET", `${P}/targeting_rules`)).items.sort((a: any, b: any) => a.position - b.position).map((r: any) => r.name);
  expect(ids.indexOf("Everyone onboarding")).toBeLessThan(ids.indexOf("Gold sees promo"));
  await page.getByRole("button", { name: /^Move Gold sees promo/ }).dragTo(page.locator(".tg-card").first());
  await expect.poll(liveOrder).toEqual(["Gold sees promo", "Everyone onboarding"]);
  await expect.poll(async () => (await sdk("vip")).current_offering_id).toBe("promo");
  await json(req, "DELETE", `${P}/targeting_rules/${everyone.id}`);

  // The default offering for customers no rule matches.
  await page.reload();
  await page.getByLabel("Select default offering").selectOption({ label: "Promo (promo)" });
  await page.getByRole("dialog", { name: "Make promo the default offering?" }).getByRole("button", { name: "Make default" }).click();
  await expect(page.getByRole("status").filter({ hasText: "promo is the default offering" })).toBeVisible();
  expect((await json(req, "GET", `${P}/offerings/${promo.id}`)).is_current).toBe(true);
  expect((await sdk("normal")).current_offering_id).toBe("promo");
  await page.getByLabel("Select default offering").selectOption({ label: "Default (default)" });
  await page.getByRole("dialog", { name: "Make default the default offering?" }).getByRole("button", { name: "Make default" }).click();
  await expect.poll(async () => (await json(req, "GET", `${P}/offerings/${def.id}`)).is_current).toBe(true);

  // Delete.
  await page.getByRole("tab", { name: /^Inactive/ }).click();
  await page.getByRole("button", { name: "Actions for Spring sale" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this rule?" }).getByRole("button", { name: "Delete rule" }).click();
  await expect(page.getByRole("listitem", { name: "Rule Spring sale" })).toHaveCount(0);

  // Create with RevenueDot AI: the scripted model proposes a rule that stays off; approve it.
  await page.getByRole("button", { name: "New rule" }).click();
  await page.getByRole("menuitem", { name: "Create with RevenueDot AI" }).click();
  const ask = page.getByRole("dialog", { name: "Create a targeting rule with RevenueDot AI" });
  await ask.getByLabel("Who should see which offering?").fill("Show the onboarding offering to new customers");
  await ask.getByRole("button", { name: "Draft it" }).click();
  await page.waitForURL(/\/ai\/aic\w+$/);
  const approval = page.getByTestId("approval-card");
  await expect(approval).toContainText('Create the targeting rule "Show onboarding" showing onboarding to everyone, turned off');
  await approval.getByRole("button", { name: "Approve" }).click();
  await expect(approval).toContainText("Approved");
  await expect(page.getByText(/Done: the rule "Show onboarding" is saved and turned off\./)).toBeVisible();
  await expect(page.locator(".ai-messages a", { hasText: "Targeting" }).or(page.getByRole("log").getByRole("link", { name: "Targeting" }))).toBeVisible();
  const drafted = (await json(req, "GET", `${P}/targeting_rules`)).items.find((r: any) => r.name === "Show onboarding");
  expect(drafted).toMatchObject({ state: "inactive" });
  await page.goto(`/projects/${pid}/targeting`);
  await page.getByRole("tab", { name: /^Inactive/ }).click();
  await expect(page.getByRole("listitem", { name: "Rule Show onboarding" })).toBeVisible();

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of ["Live", "Scheduled", "Inactive", "Audiences"]) {
      await page.goto(`/projects/${pid}/targeting`);
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tab} at 390px ${scheme}`).toBe(true);
    }
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/targeting-${scheme}-390.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  expect(errors).toEqual([]);
});
