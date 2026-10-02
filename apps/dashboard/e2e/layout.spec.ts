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
    `${P}/overview`, `${P}/overview?projects=all`, `${P}/ai`, `${P}/charts/mrr`, `${P}/customers`, cust && `${P}/customers/${encodeURIComponent(cust)}`,
    `${P}/product-catalog/offerings`, `${P}/product-catalog/offerings/new`, off && `${P}/product-catalog/offerings/${off}`,
    `${P}/product-catalog/products`, prod && `${P}/product-catalog/products/${prod}`, `${P}/product-catalog/entitlements`, ent && `${P}/product-catalog/entitlements/${ent}`,
    `${P}/product-catalog/virtual-currencies`, `${P}/lifecycle/customer-center`, `${P}/lifecycle/support`, `${P}/lifecycle/retention`, `${P}/lifecycle/refund-control`, `${P}/lifecycle/winback`,
    `${P}/paywalls`, `${P}/paywalls/templates`, `${P}/ads`, `${P}/ads/rewards`, `${P}/targeting`, `${P}/experiments`, `${P}/web`, `${P}/funnels`, `${P}/web-discounts`, `${P}/auth`,
    `${P}/apps`, app && `${P}/apps/${app}`, `${P}/api-keys`, `${P}/integrations`, `${P}/integrations/webhooks`, wh && `${P}/integrations/webhooks/${wh}`, `${P}/integrations/exports`,
    `${P}/settings/general`, `${P}/settings/collaborators`, `${P}/settings/audit-logs`, `${P}/settings/export`, `${P}/settings/blocked-customers`, `/account`,
  ].filter((r): r is string => !!r);
  const found: string[] = [];
  for (const width of [1024, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const r of routes) {
      await page.goto(r);
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.locator(".loading, [aria-busy=true]")).toHaveCount(0).catch(() => {});
      for (const o of await overflow(page)) found.push(`${width}px ${r.replace(P, "")}: ${o}`);
    }
  }
  expect(found).toEqual([]);
});
