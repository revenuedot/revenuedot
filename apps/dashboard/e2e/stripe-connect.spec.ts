/**
 * "Connect with Stripe" end to end (prd/web-billing/PRD.md §8) on the e2e server's fake Connect platform (never Stripe):
 * the button unavailable without platform keys (and the restricted-key path), cancel on Stripe's page, connect in test
 * mode, the connected state on the app and Web pages, a purchase link paid on the connected account, a refund through the
 * Connect endpoint, Disconnect in RevenueDot, reconnect, RevenueDot removed in Stripe (account.application.deauthorized),
 * then a restricted key again; phone width and dark mode; no console errors.
 *
 *   cd apps/dashboard && pnpm exec vite build && E2E_PORT=5471 pnpm exec playwright test -c e2e/playwright.config.ts stripe-connect.spec.ts --workers=1
 * SHOTS=<dir> saves screenshots.
 */
import { expect, test, type Page } from "@playwright/test";
import { FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("Connect with Stripe: unavailable, cancel, connect, sell, refund, disconnect, deauthorized, restricted key", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const WEB = baseURL!;
  const errors = watchConsole(page);
  const stamp = Date.now();
  const SHOTS = process.env.SHOTS;
  const api = async <T = any>(method: string, path: string, data?: unknown) => {
    const r = await page.request.fetch(`${WEB}${path}`, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
    const t = await r.text();
    return { status: r.status(), body: (t ? JSON.parse(t) : null) as T };
  };
  const ok = async <T = any>(method: string, path: string, data?: unknown) => {
    const r = await api<T>(method, path, data);
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const toast = (text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible();
  const shot = async (name: string) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };
  // Stripe's real OAuth page is never opened: the browser lands on the e2e server's fake consent page instead.
  await page.route("https://connect.stripe.com/**", (route) => {
    const u = new URL(route.request().url());
    return route.fulfill({ status: 302, headers: { location: `${WEB}/__stripe/connect/authorize${u.search}` } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  await ok("POST", "/auth/signup", { email: `connect-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Connect e2e", project_name: "Connect Shop" });
  const pid: string = (await ok("GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await ok("POST", `${P}/apps`, { name: "Scanner Web", type: "stripe" });
  const C = `${P}/apps/${app.id}/stripe_connect`;
  const appUrl = `${WEB}/projects/${pid}/apps/${app.id}`;
  const box = () => page.locator(".sc-box");
  try {
    await test.step("without platform keys the button is disabled and says why; the restricted-key form is there", async () => {
      await ok("POST", "/__connect", { available: false });
      await page.goto(appUrl);
      const region = page.getByRole("region", { name: "Stripe account" });
      await expect(region).toBeVisible();
      await expect(box()).toHaveAttribute("data-state", "unavailable");
      await expect(box().getByRole("button", { name: "Connect with Stripe" })).toBeDisabled();
      await expect(box().getByRole("note")).toContainText("Connect with Stripe is not set up on this server");
      await expect(box().getByRole("note")).toContainText("REVENUEDOT_STRIPE_CONNECT_CLIENT_ID");
      await expect(region.getByRole("heading", { name: "Or use a restricted key" })).toBeVisible();
      await expect(region.getByLabel("Restricted key")).toBeVisible();
      expect((await ok("GET", C)).available).toBe(false);
      await shot("connect-unavailable");
      await ok("POST", "/__connect", { available: true });
    });

    await test.step("Cancel on Stripe's page: nothing changes", async () => {
      await page.goto(appUrl);
      await expect(box()).toHaveAttribute("data-state", "not_connected");
      await box().getByRole("button", { name: "Connect with Stripe" }).click();
      await expect(page.getByRole("heading", { name: "Fake Stripe Connect" })).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("heading", { name: "Stripe was not connected" })).toBeVisible();
      await expect(page.getByText("You cancelled on Stripe's page. Nothing changed.")).toBeVisible();
      await page.getByRole("link", { name: "Back to the app" }).click();
      await expect(box()).toHaveAttribute("data-state", "not_connected");
      expect((await ok("GET", C)).status).toBe("not_connected");
    });

    let account = "";
    await test.step("Connect in test mode: Stripe's page, back to the app, connected", async () => {
      await box().getByRole("button", { name: "Test" }).click();
      await shot("connect-ready");
      await box().getByRole("button", { name: "Connect with Stripe" }).click();
      await page.getByRole("button", { name: "Connect my Stripe account" }).click();
      await page.waitForURL(/\/apps\/app[^/]*#credentials$/);
      await toast("Stripe account connected");
      await expect(box()).toHaveAttribute("data-state", "connected");
      await expect(box()).toContainText(/Connected with Stripe Connect to acct_…\w{4} in test mode/);
      await expect(page.getByRole("heading", { name: "Or use a restricted key" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Stripe webhooks" })).toContainText("Nothing to set up here");
      const s = await ok("GET", C);
      expect(s).toMatchObject({ status: "connected", method: "oauth", mode: "test", charges_enabled: true, application_fee: null });
      account = s.account;
      // The callback cannot be replayed: the state was single use.
      await page.goto(`${WEB}/connect/stripe?code=ac_replay&state=${pid}.${app.id}.00000000000000000000000000000000`);
      await expect(page.getByRole("heading", { name: "Start again from the app's page" })).toBeVisible();
      await page.goto(appUrl);
      await page.getByRole("button", { name: "Check connection" }).click();
      await expect(page.getByText("The connected Stripe account answered in test mode.")).toBeVisible();
      await shot("connect-connected");
    });

    let link = "";
    await test.step("Web page: the provider row and step 1; a purchase link paid on the connected account", async () => {
      await page.goto(`${WEB}/projects/${pid}/web`);
      const row = page.getByRole("table", { name: "Web providers" }).locator("tbody tr");
      await expect(row).toContainText(`Connect · ${account}`);
      await expect(page.locator('[data-step="stripe"]')).toHaveClass(/done/);
      const ent = await ok("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" });
      await ok("PUT", `${P}/apps/${app.id}/web_config`, { app_name: "Scanner", support_email: "help@scanner.example", app_scheme: "scanner" });
      const prod = await ok("POST", `${P}/apps/${app.id}/web_products`, { display_name: "Pro annual", type: "subscription", price: { amount: 59.99, currency: "USD" }, duration: "P1Y", entitlement_ids: [ent.id] });
      const off = await ok("POST", `${P}/offerings`, { lookup_key: "web", display_name: "Go Pro" });
      const pkg = await ok("POST", `${P}/offerings/${off.id}/packages`, { lookup_key: "$rc_annual", display_name: "Annual", position: 1 });
      await ok("POST", `${P}/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: prod.product.id, eligibility_criteria: "all" }] });
      link = (await ok("POST", `${P}/purchase_links`, { name: "Annual", offering_id: off.id, app_id: app.id })).url;
      await page.goto(`${link}?app_user_id=connect_buyer`);
      await page.getByRole("button", { name: "Continue to payment" }).click();
      await page.waitForURL(/\/__stripe\/checkout\/cs_/);
      await expect(page.locator("[data-amount]")).toHaveText("59.99 USD");
      await page.getByLabel("Email").fill("buyer@example.com");
      await page.getByRole("button", { name: "Pay" }).click();
      await page.waitForURL(/\/success\?/);
      await expect(page.getByRole("heading", { name: "Thank you for your purchase" })).toBeVisible();
      const subs = await ok("GET", `${P}/customers/connect_buyer/subscriptions`);
      expect(subs.items).toEqual([expect.objectContaining({ store: "stripe", status: "active" })]);
    });

    await test.step("a refund in Stripe reaches RevenueDot through the Connect endpoint", async () => {
      const r = await ok("POST", "/__stripe/refund", {});
      expect(r.delivered).toMatchObject({ status: 200, body: { status: "processed" } });
      const ev = await ok("GET", `${P}/customers/connect_buyer/events?limit=50`);
      expect(ev.items.find((e: any) => e.type === "CANCELLATION")?.body).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", store: "STRIPE" });
    });

    await test.step("Disconnect in RevenueDot", async () => {
      await page.goto(appUrl);
      await box().getByRole("button", { name: "Disconnect" }).click();
      const d = page.getByRole("dialog", { name: "Disconnect your Stripe account?" });
      await d.getByRole("button", { name: "Disconnect" }).click();
      await toast("Stripe account disconnected");
      await expect(box()).toHaveAttribute("data-state", "disconnected");
      await expect(box()).toContainText("Disconnected in RevenueDot");
      await expect(page.getByRole("heading", { name: "Or use a restricted key" })).toBeVisible();
      expect((await ok("GET", C))).toMatchObject({ status: "disconnected", account: null, disconnect_reason: "Disconnected in RevenueDot" });
    });

    await test.step("Connect again, then RevenueDot is removed in Stripe: the app shows it", async () => {
      await box().getByRole("button", { name: "Connect with Stripe" }).click();
      await page.getByRole("button", { name: "Connect my Stripe account" }).click();
      await page.waitForURL(/#credentials$/);
      await expect(box()).toHaveAttribute("data-state", "connected");
      const r = await ok("POST", "/__stripe/deauthorize", {});
      expect(r.delivered).toMatchObject({ status: 200, body: { status: "disconnected" } });
      await page.reload();
      await expect(box()).toHaveAttribute("data-state", "disconnected");
      await expect(box()).toContainText("Disconnected in Stripe");
      // Checkout no longer works for this app until it connects again.
      const w = await api("POST", `${P}/apps/${app.id}/web_products`, { display_name: "x", type: "subscription", price: { amount: 5, currency: "USD" }, duration: "P1M" });
      expect(w.status).toBe(422);
      await shot("connect-disconnected");
    });

    await test.step("the restricted-key path still works on the same app", async () => {
      const region = page.getByRole("region", { name: "Stripe account" });
      await region.getByLabel("Restricted key").fill(FAKE_STRIPE_KEY);
      await region.getByRole("button", { name: "Check credentials" }).click();
      await expect(region.getByText("Valid credentials. Stripe accepted the test mode key.")).toBeVisible();
      await page.getByRole("button", { name: "Save changes" }).click();
      await toast("Changes saved.");
      await page.goto(`${WEB}/projects/${pid}/web`);
      await expect(page.getByRole("table", { name: "Web providers" }).locator("tbody tr")).toContainText("Restricted key");
      expect((await ok("GET", C))).toMatchObject({ status: "disconnected", restricted_key_configured: true });
    });

    await test.step("phone width and dark mode", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(appUrl);
      await expect(box()).toBeVisible();
      const o = await page.evaluate(() => { const s = document.querySelector(".scroll"); return Math.max(document.documentElement.scrollWidth - window.innerWidth, s ? s.scrollWidth - s.clientWidth : 0); });
      expect(o).toBeLessThanOrEqual(1);
      await shot("connect-390");
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.reload();
      await expect(box()).toBeVisible();
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector(".sc-box")!).backgroundColor);
      expect(bg).not.toBe("rgb(255, 255, 255)");
      await shot("connect-dark");
      await page.emulateMedia({ colorScheme: "light" });
    });
  } finally {
    await api("POST", "/__connect", { available: true });
  }
  // The cancelled and replayed callbacks are expected 400s; nothing else may error.
  expect(errors.filter((x) => !/status of (400|422)/.test(x))).toEqual([]);
});
