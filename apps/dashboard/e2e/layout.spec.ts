/**
 * No page scrolls sideways, and no table or tab row inside it does, at 1024, 1200 and 1440 pixels wide (found on
 * production 2026-10-02: Project settings tabs, the Apps, Products, Customers and customer Subscriptions tables cut off at
 * 1200px). The only sideways scrolling allowed is marked `data-scroll="x"` (the chart's data table, one column per day,
 * and the chart list rail below 1100px) and code blocks (`pre`).
 *   cd apps/dashboard && npx vite build && E2E_PORT=5522 npx playwright test -c e2e/playwright.config.ts layout
 */
import { expect, test, type Page } from "@playwright/test";

async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) out.push(`page +${de.scrollWidth - de.clientWidth}px`);
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const x = getComputedStyle(el).overflowX;
      if ((x !== "auto" && x !== "scroll") || !el.clientWidth || el.closest("[data-scroll=x],pre")) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        const inner = el.querySelector("table,[role=tablist]");
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, ".")}${inner ? ` > ${inner.tagName.toLowerCase()}${inner.getAttribute("aria-label") ? `[${inner.getAttribute("aria-label")}]` : ""}` : ""} +${el.scrollWidth - el.clientWidth}px`);
      }
    }
    return out;
  });
}

test("no page, table or tab row scrolls sideways at 1024, 1200 and 1440px", async ({ page }) => {
  test.setTimeout(600_000);
  await page.request.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } });
  const pid = (await (await page.request.get("/auth/me")).json()).projects[0].id as string;
  const P = `/projects/${pid}`;
  const first = async (path: string) => ((await (await page.request.get(`/v2/projects/${pid}${path}`)).json()).items?.[0]?.id as string | undefined);
  const [prod, ent, off, app, cust, wh] = await Promise.all([first("/products"), first("/entitlements"), first("/offerings"), first("/apps"), first("/customers?limit=1"), first("/integrations/webhooks")]);
  const routes = [
    `${P}/overview`, `${P}/overview?environment=sandbox`, `${P}/ai`, `${P}/charts/mrr`, `${P}/customers`, cust && `${P}/customers/${encodeURIComponent(cust)}`,
    `${P}/product-catalog/offerings`, `${P}/product-catalog/offerings/new`, off && `${P}/product-catalog/offerings/${off}`,
    `${P}/product-catalog/products`, prod && `${P}/product-catalog/products/${prod}`, `${P}/product-catalog/entitlements`, ent && `${P}/product-catalog/entitlements/${ent}`,
    `${P}/product-catalog/virtual-currencies`, `${P}/lifecycle/customer-center`, `${P}/lifecycle/support`, `${P}/lifecycle/retention`, `${P}/lifecycle/refund-control`, `${P}/lifecycle/winback`,
    `${P}/lifecycle/payment-recovery`, `${P}/lifecycle/payment-recovery?environment=sandbox`,
    `${P}/paywalls`, `${P}/paywalls/templates`, `${P}/ads`, `${P}/ads/rewards`, `${P}/targeting`, `${P}/experiments`, `${P}/web`, `${P}/funnels`, `${P}/web-discounts`, `${P}/auth`,
    `${P}/apps`, app && `${P}/apps/${app}`, `${P}/api-keys`, `${P}/integrations`, `${P}/integrations/webhooks`, wh && `${P}/integrations/webhooks/${wh}`, `${P}/integrations/exports`,
    ...["general", "ai", "brand", "audit-logs", "blocked-customers", "collaborators", "verified-metrics", "domains", "export"].map((t) => `${P}/settings/${t}`), `/account`,
  ].filter((r): r is string => !!r);
  const found = await measure(page, routes, P);
  expect(found).toEqual([]);
});

test("Overview → All projects with long project and product names fits at 1024, 1200 and 1440px", async ({ page }) => {
  // The e2e account has one project, so All projects gets its own account: two projects, long names, a sale in each.
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await page.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  await call("POST", "/auth/signup", { email: `layout-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Layout", project_name: "Meditation and sleep sounds for the whole family" });
  const a = (await call("GET", "/auth/me")).projects[0].id as string;
  const b = (await call("POST", "/v2/projects", { name: "Focus timer with a very long project name indeed" })).id as string;
  for (const pid of [a, b]) {
    const app = await call("POST", `/v2/projects/${pid}/apps`, { name: "Test Store", type: "test_store" });
    const prod = await call("POST", `/v2/projects/${pid}/products`, { app_id: app.id, store_identifier: "com.example.premium_annual_subscription_with_trial_v2", type: "subscription", subscription: { duration: "P1Y" }, display_name: "Premium annual subscription with a free trial", test_store_price: { amount_micros: 59_990_000, currency: "USD" } });
    await call("POST", `/v2/projects/${pid}/test_purchases`, { app_user_id: "a_rather_long_app_user_id_for_layout_checks", product_id: prod.id, app_id: app.id });
  }
  const found = await measure(page, [`/projects/${a}/overview?projects=all&environment=sandbox`], `/projects/${a}`, async () => {
    await expect(page.getByRole("region", { name: "Recent transactions" }).getByRole("columnheader", { name: "Project" })).toBeVisible();
  });
  expect(found).toEqual([]);
});

test("Customers with long app user IDs and emails fit at 1024, 1200 and 1440px", async ({ page }) => {
  // Found on production 2026-10-03: IDs like qa_storefront_1790930293165 with an email pushed the table 31px past its panel.
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const call = async (method: string, path: string, data?: unknown) => {
    const res = await page.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBe(true);
    return res.json();
  };
  await call("POST", "/auth/signup", { email: `layout-cust-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Layout", project_name: "Customers layout" });
  const pid = (await call("GET", "/auth/me")).projects[0].id as string;
  const app = await call("POST", `/v2/projects/${pid}/apps`, { name: "Test Store", type: "test_store" });
  const prod = await call("POST", `/v2/projects/${pid}/products`, { app_id: app.id, store_identifier: "com.example.premium_annual_subscription_with_trial_v2", type: "subscription", subscription: { duration: "P1Y" }, display_name: "Premium annual", test_store_price: { amount_micros: 59_990_000, currency: "USD" } });
  for (const i of [1, 2, 3]) {
    const id = `customer_with_a_very_long_app_user_id_${stamp}_${i}`;
    await call("POST", `/v2/projects/${pid}/test_purchases`, { app_user_id: id, product_id: prod.id, app_id: app.id });
    await call("POST", `/v2/projects/${pid}/customers/${id}/attributes`, { attributes: [{ name: "$email", value: `a.really.long.email.address.${i}@a-long-company-domain.example.com` }] });
  }
  const found = await measure(page, [`/projects/${pid}/customers`, `/projects/${pid}/customers?environment=sandbox`], `/projects/${pid}`, async () => {
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });
  expect(found).toEqual([]);
  // The ID is cut on screen, but stays whole in the link title and in search.
  const link = page.locator("table tbody tr").first().locator("td").first().locator("a").first();
  await expect(link).toHaveAttribute("title", /customer_with_a_very_long_app_user_id_/);
});

/** Opens every route at each width, after its data has loaded, and lists what scrolls sideways. */
async function measure(page: Page, routes: string[], base: string, ready?: () => Promise<void>): Promise<string[]> {
  const found: string[] = [];
  for (const width of [1024, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const r of routes) {
      await page.goto(r);
      // Pages that poll keep the network busy; the loading markers are the real signal.
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await expect(page.locator(".loading, [aria-busy=true]")).toHaveCount(0, { timeout: 20_000 });
      await ready?.();
      // A redirect (a missing page, a sign-in) would pass without measuring the page asked for.
      expect(new URL(page.url()).pathname, r).toBe(r.split("?")[0]);
      for (const o of await overflow(page)) found.push(`${width}px ${r.replace(base, "")}: ${o}`);
    }
  }
  return found;
}
