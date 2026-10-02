/**
 * Payment recovery end to end (prd/payment-recovery/PRD.md) on the e2e server: the empty and off states; Turn on with the
 * settings dialog (edit an email, the preview, Send test read back from /__mail); billing issues on the App Store, Google
 * Play and Amazon (applied through the real purchase pipeline by POST /__store/billing_issue) and on a Stripe account
 * connected with "Connect with Stripe" (a purchase link paid on the fake Checkout page, then a failed renewal); the at-risk
 * list; Send due emails; the email's link opening the fake Stripe customer portal, which pays the invoice; recovered
 * revenue on the page and in the API; unsubscribe; renewals on the other stores; phone width, dark mode, no console errors.
 *
 *   cd apps/dashboard && pnpm exec vite build && E2E_PORT=5472 pnpm exec playwright test -c e2e/playwright.config.ts payment-recovery.spec.ts --workers=1
 * SHOTS=<dir> saves screenshots (docs/assets/payment-recovery/).
 */
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 15_000 });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("payment recovery: off, turn on, billing issues on four stores, emails, portal, recovered revenue, unsubscribe", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
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
  const mails = async (to: string) => (await ok<Array<{ to: string; subject: string; text: string; html: string; fromName?: string; headers?: Record<string, string> }>>("GET", `/__mail?to=${encodeURIComponent(to)}`));
  const toast = (text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible();
  const shot = async (name: string) => {
    if (!SHOTS) return;
    await page.locator(".toast").waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  };
  await page.route("https://connect.stripe.com/**", (route) => route.fulfill({ status: 302, headers: { location: `${WEB}/__stripe/connect/authorize${new URL(route.request().url()).search}` } }));
  await page.setViewportSize({ width: 1440, height: 900 });

  await ok("POST", "/auth/signup", { email: `recovery-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Recovery e2e", project_name: "Recovery Shop" });
  const pid: string = (await ok("GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const pageUrl = `${WEB}/projects/${pid}/lifecycle/payment-recovery`;
  const grid = () => page.getByLabel("Payment recovery results");
  const casesPanel = () => page.locator("section.panel").filter({ has: page.getByText("Subscribers in billing retry") });

  await test.step("empty and off: the sidebar entry, the off banner, empty cases, zero numbers", async () => {
    await page.goto(`${WEB}/projects/${pid}/overview`);
    await page.getByRole("button", { name: "Lifecycle" }).click();
    await page.getByRole("link", { name: "Payment recovery" }).click();
    await page.waitForURL(/\/lifecycle\/payment-recovery$/);
    await expect(page.getByRole("heading", { name: "Payment recovery", level: 1 })).toBeVisible();
    await expect(page.getByText("Recovery emails are off.")).toBeVisible();
    await expect(page.getByTestId("pr-at-risk")).toHaveText("0");
    await expect(page.getByTestId("pr-revenue")).toHaveText("$0.00");
    await expect(page.getByRole("heading", { name: "No failed payments right now" })).toBeVisible();
    await shot("recovery-empty");
  });

  await test.step("Turn on: edit the day-3 email, preview, Send test, sandbox on, save", async () => {
    await page.getByRole("button", { name: "Turn on" }).first().click();
    const d = page.getByRole("dialog", { name: "Payment recovery settings" });
    await expect(d.getByRole("tab", { name: "Day 0" })).toHaveAttribute("aria-selected", "true");
    await expect(d.getByLabel("Email preview")).toContainText("Your payment for Recovery Shop didn't go through");
    await d.getByRole("tab", { name: "Day 3" }).click();
    await d.getByLabel("Subject").fill("Still having trouble paying for {app}?");
    await expect(d.getByLabel("Email preview")).toContainText("Still having trouble paying for Recovery Shop?");
    await d.getByLabel("Sender name").fill("Scanner Pro");
    await expect(d.getByLabel("Email preview")).toContainText("Still having trouble paying for Scanner Pro?");
    await d.getByLabel("Send a test to").fill(`dev-${stamp}@example.com`);
    await d.getByRole("button", { name: "Send test" }).click();
    await toast(`Test email sent to dev-${stamp}@example.com`);
    const test0 = await mails(`dev-${stamp}@example.com`);
    expect(test0.at(-1)).toMatchObject({ subject: "[Test] Still having trouble paying for Scanner Pro?", fromName: "Scanner Pro" });
    // Steps must go in order of day.
    await d.getByLabel("Send on day").fill("9");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d.getByRole("alert")).toContainText("Email 3 must go out on a later day than email 2.");
    await d.getByLabel("Send on day").fill("3");
    await d.getByLabel("Also email sandbox subscribers").check();
    await shot("recovery-settings");
    await d.getByRole("button", { name: "Save" }).click();
    await toast("Payment recovery is on");
    await expect(page.getByText("Recovery emails are off.")).toHaveCount(0);
    expect(await ok("GET", `${P}/payment_recovery`)).toMatchObject({ enabled: true, include_sandbox: true, sender_name: "Scanner Pro", steps: [{ day: 0 }, { day: 3, subject: "Still having trouble paying for {app}?" }, { day: 7 }] });
  });

  const stores: Record<string, { key: string; user: string }> = {};
  await test.step("billing issues on the App Store, Google Play and Amazon show in the at-risk list", async () => {
    for (const store of ["app_store", "play_store", "amazon"]) {
      const user = `${store}_user_${stamp}`;
      const r = await ok("POST", "/__store/billing_issue", { project_id: pid, store, app_user_id: user, email: `${store}-${stamp}@example.com` });
      stores[store] = { key: r.store_key, user };
    }
    await page.reload();
    await expect(page.getByTestId("pr-at-risk")).toHaveText("3");
    const rows = casesPanel().locator("tbody tr");
    await expect(rows).toHaveCount(3);
    for (const label of ["App Store", "Google Play", "Amazon"]) await expect(rows.filter({ hasText: label }).locator(".tag")).toHaveText("Billing issue");
    const cases = await ok("GET", `${P}/payment_recovery/cases?status=open`);
    expect(cases.items.map((c: any) => c.store).sort()).toEqual(["amazon", "app_store", "play_store"]);
  });

  let stripeUser = "";
  await test.step("a web subscriber on a connected Stripe account; its renewal fails (sandbox)", async () => {
    const app = await ok("POST", `${P}/apps`, { name: "Scanner Web", type: "stripe" });
    await page.goto(`${WEB}/projects/${pid}/apps/${app.id}`);
    // Test mode: the web purchases are sandbox data.
    await page.locator(".sc-box").getByRole("button", { name: "Test" }).click();
    await page.locator(".sc-box").getByRole("button", { name: "Connect with Stripe" }).click();
    await page.getByRole("button", { name: "Connect my Stripe account" }).click();
    await page.waitForURL(/#credentials$/);
    await expect(page.locator(".sc-box")).toHaveAttribute("data-state", "connected");
    const ent = await ok("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" });
    await ok("PUT", `${P}/apps/${app.id}/web_config`, { app_name: "Scanner", support_email: "help@scanner.example", app_scheme: "scanner" });
    const prod = await ok("POST", `${P}/apps/${app.id}/web_products`, { display_name: "Pro annual", type: "subscription", price: { amount: 59.99, currency: "USD" }, duration: "P1Y", entitlement_ids: [ent.id] });
    const off = await ok("POST", `${P}/offerings`, { lookup_key: "web", display_name: "Go Pro" });
    const pkg = await ok("POST", `${P}/offerings/${off.id}/packages`, { lookup_key: "$rc_annual", display_name: "Annual", position: 1 });
    await ok("POST", `${P}/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: prod.product.id, eligibility_criteria: "all" }] });
    const link = (await ok("POST", `${P}/purchase_links`, { name: "Annual", offering_id: off.id, app_id: app.id })).url;
    stripeUser = `web_user_${stamp}`;
    await page.goto(`${link}?app_user_id=${stripeUser}`);
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.getByLabel("Email").fill(`web-${stamp}@example.com`);
    await page.getByRole("button", { name: "Pay" }).click();
    await expect(page.getByRole("heading", { name: "Thank you for your purchase" })).toBeVisible();
    const failed = await ok("POST", "/__stripe/fail_renewal", {});
    expect(failed.delivered).toMatchObject({ status: 200, body: { status: "processed" } });
    await page.goto(pageUrl);
    await page.getByRole("switch", { name: "Sandbox data" }).click();
    await expect(page.getByTestId("pr-at-risk")).toHaveText("1");
    await expect(grid()).toContainText("$59.99");
    await expect(casesPanel().locator("tbody tr")).toContainText(stripeUser);
    await expect(casesPanel().locator("tbody tr").locator(".tag")).toHaveText("Billing issue");
    await shot("recovery-at-risk");
  });

  await test.step("Send due emails: one email per store, from the app, with working links", async () => {
    // The server's minute tick may have sent them already; "Send due emails" sends whatever is still due.
    await page.getByRole("button", { name: "Send due emails" }).click();
    await toast(/Sent \d+ emails?|Nothing is due right now/);
    for (const to of [`web-${stamp}@example.com`, ...["app_store", "play_store", "amazon"].map((s) => `${s}-${stamp}@example.com`)]) {
      await expect.poll(async () => (await mails(to)).length, { message: `an email to ${to}` }).toBe(1);
    }
    await page.reload();
    await page.getByRole("switch", { name: "Sandbox data" }).click();
    await expect(page.getByTestId("pr-sent")).toHaveText("1");
    const web = (await mails(`web-${stamp}@example.com`)).filter((m) => m.subject.includes("didn't go through"));
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({ subject: "Your payment for Scanner Pro didn't go through", fromName: "Scanner Pro" });
    for (const store of ["app_store", "play_store", "amazon"]) expect((await mails(`${store}-${stamp}@example.com`)).length).toBe(1);
    // Nothing more is due today.
    await page.getByRole("button", { name: "Send due emails" }).click();
    await toast("Nothing is due right now");
    // The App Store link opens Apple's payment page; Play's the subscription page (followed without leaving: 303s).
    const appleLink = /http:\/\/[^\s]+\/v1\/recovery\/l\/[A-Za-z0-9_-]+/.exec((await mails(`app_store-${stamp}@example.com`))[0]!.text)![0];
    const a = await page.request.get(appleLink, { maxRedirects: 0 });
    expect(a.status()).toBe(303);
    expect(a.headers().location).toBe("https://apps.apple.com/account/billing");
    const playLink = /http:\/\/[^\s]+\/v1\/recovery\/l\/[A-Za-z0-9_-]+/.exec((await mails(`play_store-${stamp}@example.com`))[0]!.text)![0];
    expect((await page.request.get(playLink, { maxRedirects: 0 })).headers().location).toBe("https://play.google.com/store/account/subscriptions?sku=recovery_pro&package=com.example.recovery");

    // The web subscriber: the link opens the Stripe customer portal; updating the card pays the invoice.
    const webLink = /http:\/\/[^\s]+\/v1\/recovery\/l\/[A-Za-z0-9_-]+/.exec(web[0]!.text)![0];
    await page.goto(webLink);
    await expect(page.getByRole("heading", { name: "Fake Stripe customer portal" })).toBeVisible();
    await page.getByRole("button", { name: "Update payment method" }).click();
    await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
    await expect(page.getByText("Your payment details are saved.")).toBeVisible();
  });

  await test.step("recovered revenue on the page and in the API", async () => {
    await page.goto(pageUrl);
    await page.getByRole("switch", { name: "Sandbox data" }).click();
    await expect(page.getByTestId("pr-recovered")).toHaveText("1");
    await expect(page.getByTestId("pr-revenue")).toHaveText("$59.99");
    await expect(page.getByTestId("pr-at-risk")).toHaveText("0");
    await page.getByRole("button", { name: "Recovered" }).click();
    await expect(casesPanel().locator("tbody tr").locator(".tag")).toHaveText("Recovered");
    await expect(casesPanel().locator("tbody tr")).toContainText("$59.99");
    const st = await ok("GET", `${P}/payment_recovery/stats?environment=sandbox`);
    expect(st).toMatchObject({ recovered: { count: 1, revenue_in_usd: 59.99 }, messages_sent: 1, clicked: 1, at_risk: { count: 0 }, recovery_rate: 1 });
    await shot("recovery-recovered");
  });

  await test.step("unsubscribe from the Amazon email: the case shows it and no more emails go out", async () => {
    await page.getByRole("switch", { name: "Sandbox data" }).click();
    const m = (await mails(`amazon-${stamp}@example.com`))[0]!;
    expect(m.text).toContain("Unsubscribe: http");
    const unsub = /http:\/\/[^\s]+\/v1\/recovery\/u\/[A-Za-z0-9_-]+/.exec(m.text)![0];
    await page.goto(unsub);
    await expect(page.getByRole("heading", { name: "Unsubscribe?" })).toBeVisible();
    await page.getByRole("button", { name: "Unsubscribe" }).click();
    await expect(page.getByRole("heading", { name: "You are unsubscribed" })).toBeVisible();
    await page.goto(pageUrl);
    await expect(casesPanel().locator("tbody tr").filter({ hasText: "Amazon" }).locator(".tag")).toHaveText("Unsubscribed");
  });

  await test.step("the App Store and Play renewals recover their cases; the 28-day production numbers", async () => {
    for (const store of ["app_store", "play_store"]) await ok("POST", "/__store/renew", { project_id: pid, store, app_user_id: stores[store]!.user, store_key: stores[store]!.key });
    await page.reload();
    await expect(page.getByTestId("pr-recovered")).toHaveText("2");
    await expect(page.getByTestId("pr-at-risk")).toHaveText("1");
    const st = await ok("GET", `${P}/payment_recovery/stats`);
    expect(st.recovered.count).toBe(2);
    expect(st.recovered.revenue_in_usd).toBeCloseTo(9.99 + 7.99, 2);
    expect(st.by_store.map((s: any) => [s.store, s.recovered]).sort()).toEqual([["amazon", 0], ["app_store", 1], ["play_store", 1]]);
    await page.getByRole("button", { name: "All" }).click();
    await expect(casesPanel().locator("tbody tr")).toHaveCount(3);
  });

  await test.step("phone width and dark mode", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(pageUrl);
    await expect(grid()).toBeVisible();
    const o = await page.evaluate(() => { const s = document.querySelector(".scroll"); return Math.max(document.documentElement.scrollWidth - window.innerWidth, s ? s.scrollWidth - s.clientWidth : 0); });
    expect(o).toBeLessThanOrEqual(1);
    await shot("recovery-390");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(grid()).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".pr-grid")!).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    await shot("recovery-dark");
    await page.emulateMedia({ colorScheme: "light" });
  });

  expect(errors.filter((x) => !/status of 400/.test(x))).toEqual([]);
});
