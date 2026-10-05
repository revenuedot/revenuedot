/**
 * App Store billing plans (iOS 26.4, prd/offline-entitlements/PRD.md) on the customer page: a subscription bought on Apple's
 * monthly billing plan (recorded as product plan `monthly`, applied through the real purchase pipeline by
 * POST /__store/purchase) shows the `product:monthly` catalog product, the plan under the store, and the entitlement it
 * unlocks. The new-product dialog names the `productId:monthly` form for App Store apps.
 *
 *   cd apps/dashboard && pnpm exec vite build && E2E_PORT=5472 pnpm exec playwright test -c e2e/playwright.config.ts billing-plan.spec.ts --workers=1
 */
import { expect, test } from "@playwright/test";

test("App Store billing plan: the customer page shows the product:monthly product, the plan and its entitlement", async ({ page, baseURL }) => {
  const WEB = baseURL!;
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const ok = async <T = any>(method: string, path: string, data?: unknown): Promise<T> => {
    const r = await page.request.fetch(`${WEB}${path}`, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
    const t = await r.text();
    if (r.status() >= 300) throw new Error(`${method} ${path} → ${r.status()}: ${t}`);
    return (t ? JSON.parse(t) : null) as T;
  };
  const stamp = Date.now();
  await page.setViewportSize({ width: 1440, height: 900 });
  await ok("POST", "/auth/signup", { email: `billing-plan-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Billing plan e2e", project_name: "Billing Plan Shop" });
  const pid: string = (await ok<any>("GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;

  await test.step("a monthly billing plan purchase of max unlocks the entitlement of the product stored only as max:monthly", async () => {
    const { app_id } = await ok<{ app_id: string }>("POST", "/__store/purchase", { project_id: pid, app_user_id: "plan_user", product: "max", plan: "monthly" });
    const prod = await ok<any>("POST", `${P}/products`, { app_id, store_identifier: "max:monthly", type: "subscription", display_name: "Max monthly plan", subscription: { duration: "P1M" } });
    const ent = await ok<any>("POST", `${P}/entitlements`, { lookup_key: "max", display_name: "Max" });
    await ok("POST", `${P}/entitlements/${ent.id}/actions/attach_products`, { product_ids: [prod.id] });
    const subs = await ok<any>("GET", `${P}/customers/plan_user/subscriptions`);
    expect(subs.items[0]).toMatchObject({ product_id: prod.id, gives_access: true });
    expect(subs.items[0].entitlements.items.map((e: any) => e.lookup_key)).toEqual(["max"]);
  });

  await test.step("the customer page names the product and the plan", async () => {
    await page.goto(`${WEB}/projects/${pid}/customers/plan_user`);
    const row = page.locator("td.subs-prod").filter({ hasText: "Max monthly plan" });
    await expect(row).toBeVisible();
    await expect(row.locator(".l2")).toHaveText("App Store · monthly");
    await expect(row.locator("span[title]").first()).toHaveAttribute("title", /^max:monthly · /);
    await expect(page.locator(".erow").filter({ hasText: "Max" }).getByText("From Max monthly plan")).toBeVisible();
  });

  await test.step("the new-product dialog explains the productId:monthly form for App Store apps", async () => {
    await page.goto(`${WEB}/projects/${pid}/product-catalog/products`);
    await page.getByRole("button", { name: "New product" }).first().click();
    await page.getByRole("menuitem", { name: "Create from scratch" }).click();
    const d = page.getByRole("dialog", { name: "New product" });
    await d.getByLabel("App", { exact: true }).selectOption({ label: "Recovery app_store (App Store)" });
    await expect(d.getByText("A monthly billing plan with a 12-month commitment (iOS 26.4): productId:monthly.", { exact: false })).toBeVisible();
    await d.getByRole("button", { name: "Cancel" }).click();
  });

  expect(errors).toEqual([]);
});
