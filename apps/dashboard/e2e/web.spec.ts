/**
 * Web billing end to end (prd/web-billing/PRD.md): connect Stripe, add the web config, create a web product, sell an
 * offering through a purchase link with a discount code, pay on a fake Stripe Checkout page, redeem the redemption link
 * with the SDK's POST /v1/subscribers/redeem_purchase, build and publish a funnel and buy through it, read its analytics,
 * and verify a custom domain. Stripe is the e2e server's in-memory FakeStripeAccount (FAKE_STRIPE_KEY, never a real key);
 * DNS answers come from the e2e server's POST /__dns. Every run signs up a fresh account.
 *
 *   cd apps/dashboard && E2E_PORT=5404 pnpm exec vite build && E2E_PORT=5404 pnpm exec playwright test -c e2e/playwright.config.ts web.spec.ts --workers=1
 * SHOTS=<dir> saves screenshots at 1440×900 and 390px wide (docs/assets/web/ holds the committed set).
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

test("web billing: Stripe, web config, products, purchase link, discount code, redemption, funnel, analytics, domains", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const WEB = baseURL!;
  const errors = watchConsole(page);
  const stamp = Date.now();
  const SHOTS = process.env.SHOTS;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
  const api = async <T = any>(method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const r = await page.request.fetch(`${WEB}${path}`, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
    const t = await r.text();
    return { status: r.status(), body: (t ? JSON.parse(t) : null) as T };
  };
  const ok = async <T = any>(method: string, path: string, data?: unknown) => {
    const r = await api<T>(method, path, data);
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const toast = (text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible();
  /** Screenshot at 1440×900 and, unless `wide`, again at 390px wide. */
  const shot = async (name: string, o: { wide?: boolean; full?: boolean } = {}) => {
    if (!SHOTS) return;
    // No toast, and the page (or the open dialog) scrolled to the top.
    await page.locator(".toast").waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    await page.evaluate(() => { for (const el of document.querySelectorAll(".scroll, .dialog")) el.scrollTop = 0; });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: o.full });
    if (o.wide) return;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-390.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  /** No horizontal scroll at 390px: neither the page nor the dashboard's scroll area. */
  const narrow = async (url: string, ready: () => Promise<void>) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await ready();
    const o = await page.evaluate(() => {
      const s = document.querySelector(".scroll");
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, s ? s.scrollWidth - s.clientWidth : 0);
    });
    expect(o, `${url} scrolls sideways at 390px`).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  await page.setViewportSize({ width: 1440, height: 900 });

  // A fresh account; the session cookie lands in the browser context.
  await ok("POST", "/auth/signup", { email: `web-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Web e2e", project_name: "Scanner" });
  const pid: string = (await ok("GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  // The project's web address comes from its name, "scanner", unless an earlier spec's "Scanner" project took it first
  // (the e2e account's project gets one when layout.spec opens its Web page): then "scanner-<random>". Read it once.
  const slug: string = (await ok("GET", `${P}/web_domain`)).slug;
  expect(slug).toMatch(/^scanner(-[a-z0-9]+)?$/);
  const ent = await ok("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro access" });
  // The iOS app that redeems the web purchase (apps are another area; made through the API).
  const ios = await ok("POST", `${P}/apps`, { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner" } });
  const iosKey: string = (await ok("GET", `${P}/apps/${ios.id}/public_api_keys`)).items[0].key;

  let stripeId = "";
  await test.step("Web page: no provider yet; Add web provider opens Add app → Stripe, and the key is checked against the fake Stripe", async () => {
    await page.goto(`${WEB}/projects/${pid}/web`);
    await expect(page.getByRole("heading", { name: "Web", exact: true })).toBeVisible();
    await expect(page.getByText("Configure web payment providers to sell subscriptions on the web.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No web provider yet" })).toBeVisible();
    await expect(page.locator(".step.next")).toContainText("Connect Stripe");
    await expect(page.locator(".step.next")).toContainText("Products, Prices, Checkout Sessions, Coupons and Promotion Codes");
    await page.getByRole("button", { name: "Add web provider" }).first().click();
    const d = page.getByRole("dialog", { name: "Add an app" });
    await expect(d.getByRole("button", { name: /Stripe/ })).toHaveAttribute("aria-pressed", "true");
    await d.getByLabel("App name").fill("Scanner Web");
    await d.getByRole("button", { name: "Add app" }).click();
    await page.waitForURL(/\/apps\/app/);
    stripeId = page.url().split("/").pop()!.split("#")[0]!;
    const keySection = page.getByRole("region", { name: "Stripe account" });
    await keySection.getByLabel("Restricted key").fill(FAKE_STRIPE_KEY);
    await keySection.getByRole("button", { name: "Check credentials" }).click();
    await expect(keySection.getByText("Valid credentials. Stripe accepted the test mode key.")).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
  });

  await test.step("Web page: the provider row, then add the web config with a preset and the deep link scheme", async () => {
    await page.goto(`${WEB}/projects/${pid}/web`);
    const row = page.getByRole("table", { name: "Web providers" }).locator("tbody tr");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Scanner Web");
    await expect(row).toContainText("Stripe");
    await expect(row).toContainText(stripeId);
    await expect(row.locator(".tag")).toContainText(["Test"]);
    await expect(row.getByText("strp_", { exact: false })).toBeVisible();
    await row.getByRole("button", { name: "Show public API key" }).click();
    await expect(row.locator(".secret code")).toHaveText(/^strp_[A-Za-z0-9]+$/);
    await expect(page.locator('[data-step="stripe"]')).toHaveClass(/done/);
    await expect(page.locator(".step.next")).toContainText("Add a web config");
    await page.locator(".step.next").getByRole("button", { name: "Add web config" }).click();
    const d = page.getByRole("dialog", { name: "Web config" });
    await d.getByLabel("App name").fill("Scanner");
    await d.getByRole("button", { name: "Ocean", exact: true }).click();
    await expect(d.getByRole("button", { name: "Ocean", exact: true })).toHaveAttribute("aria-pressed", "true");
    await d.getByLabel("Terms URL").fill("https://scanner.example/terms");
    await d.getByLabel("Privacy URL").fill("https://scanner.example/privacy");
    await d.getByLabel("Support email").fill("help@scanner.example");
    await d.getByLabel("Deep link scheme").fill("scanner");
    await expect(d.locator(".copyfield code")).toHaveText("scanner://redeem_web_purchase?redemption_token=…");
    await d.getByLabel("App Store URL").fill("https://apps.apple.com/app/id123");
    await shot("web-config");
    await d.getByLabel("Logo URL").fill("http://insecure.example/logo.png");
    await d.getByRole("button", { name: "Save web config" }).click();
    await expect(d.getByText("must be an https URL", { exact: false })).toBeVisible();
    await d.getByLabel("Logo URL").fill("");
    await d.getByRole("button", { name: "Save web config" }).click();
    await toast("Web config saved.");
    const cfg = await ok("GET", `${P}/apps/${stripeId}/web_config`);
    expect(cfg).toMatchObject({ saved: true, app_name: "Scanner", app_scheme: "scanner", theme: { accent: "#2F6F9F", corner_radius: 12 }, terms_url: "https://scanner.example/terms", logo_url: null });
  });

  await test.step("create a web product through the dialog; it is a product and a price in the fake Stripe account", async () => {
    await expect(page.locator(".step.next")).toContainText("Create web products and prices");
    await page.locator(".step.next").getByRole("button", { name: "Create web product" }).click();
    const d = page.getByRole("dialog", { name: "Create web product" });
    await d.getByLabel("Name").fill("Pro monthly");
    await d.getByLabel("Price", { exact: true }).fill("9.99");
    await d.getByLabel("Billing period").selectOption("P1M");
    await d.getByLabel("Free trial (days)").fill("7");
    await expect(d.getByRole("checkbox", { name: /Pro access/ })).toBeChecked();
    await shot("web-product-dialog");
    await d.getByRole("button", { name: "Create product" }).click();
    await toast("Pro monthly created in Stripe.");
    const products = page.getByRole("region", { name: "Web products" });
    await expect(products.locator("tbody tr")).toContainText(["$9.99 / month"]);
    await expect(products.locator("tbody tr").first()).toContainText("7 days");
    await expect(products.locator("tbody tr").first()).toContainText(/price_test_/);
  });

  let offeringId = "";
  let monthlyId = "";
  await test.step("an offering with the web products (API), and the checklist is complete", async () => {
    const list = (await ok("GET", `${P}/apps/${stripeId}/web_products`)).items;
    monthlyId = list[0].product.id;
    const annual = await ok("POST", `${P}/apps/${stripeId}/web_products`, { display_name: "Pro annual", type: "subscription", price: { amount: 59.99, currency: "USD" }, duration: "P1Y", entitlement_ids: [ent.id] });
    const o = await ok("POST", `${P}/offerings`, { lookup_key: "web", display_name: "Go Pro on the web" });
    offeringId = o.id;
    for (const [key, name, product, position] of [["$rc_monthly", "Monthly", monthlyId, 1], ["$rc_annual", "Annual", annual.product.id, 2]] as const) {
      const pk = await ok("POST", `${P}/offerings/${o.id}/packages`, { lookup_key: key, display_name: name, position });
      await ok("POST", `${P}/packages/${pk.id}/actions/attach_products`, { products: [{ product_id: product, eligibility_criteria: "all" }] });
    }
    await page.reload();
    for (const k of ["stripe", "config", "products", "offering"]) await expect(page.locator(`[data-step="${k}"]`)).toHaveClass(/done/);
    await expect(page.getByLabel("4 of 4 steps done")).toBeVisible();
    await expect(page.getByText("You can sell on the web.")).toBeVisible();
    await expect(page.locator(".wb-base code")).toContainText(`${WEB}/pay/${slug}`);
    await shot("web", { full: false });
  });

  await test.step("Web discounts: empty state, create a 20% discount for 3 months with a code", async () => {
    await page.goto(`${WEB}/projects/${pid}/web-discounts`);
    await expect(page.getByRole("heading", { name: "No discounts yet" })).toBeVisible();
    await expect(page.getByText("Create discounts to apply automatically or with a code at checkout.")).toBeVisible();
    await page.getByRole("button", { name: "Create discount" }).click();
    const d = page.getByRole("dialog", { name: "Create discount" });
    await d.getByLabel("Name").fill("Spring sale");
    await expect(d.getByLabel("Identifier")).toHaveValue("spring_sale");
    await d.getByLabel("Percent off").fill("20");
    await d.getByRole("button", { name: "Several months" }).click();
    await d.getByLabel("Months").fill("3");
    await d.getByLabel("Codes").fill("SPRING20, friends-e2e");
    await d.getByRole("button", { name: "Create discount" }).click();
    await toast("Discount created with 2 codes.");
    const row = page.getByRole("table", { name: "Discounts" }).locator("tbody tr");
    await expect(row).toContainText("Spring sale");
    await expect(row).toContainText("spring_sale");
    await expect(row).toContainText("20% off for 3 months");
    await expect(row.locator(".wb-code")).toHaveText(["SPRING20", "friends-e2e"]);
    await expect(row.locator(".tag")).toHaveText(/active/i);
    // RevenueCat's v2 shape and the Stripe coupon behind it.
    const v2 = (await ok("GET", `${P}/discounts`)).items[0];
    expect(v2).toMatchObject({ object: "discount", identifier: "spring_sale", type: "percentage", percentage: 20, duration_mode: "time_window", time_window: "P3M", eligibility: "everyone" });
    const ext = (await ok("GET", `${P}/web_discounts`)).items[0];
    expect(ext.stripe[0].coupon_id).toBeTruthy();
    await shot("web-discounts");
  });

  let link: any;
  await test.step("Funnels and Purchase Links: empty funnels with the three cards, then create a purchase link and copy it", async () => {
    await page.goto(`${WEB}/projects/${pid}/funnels`);
    await expect(page.getByRole("heading", { name: "Funnels and Purchase Links" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No funnels yet" })).toBeVisible();
    for (const t of ["Acquire customers on the web", "Build with AI and test every step", "Keep every signal connected"]) await expect(page.getByRole("heading", { name: t })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No purchase links yet" })).toBeVisible();
    await page.getByRole("button", { name: "Create purchase link" }).click();
    const d = page.getByRole("dialog", { name: "Create purchase link" });
    await d.getByLabel("Name").fill("Spring sale");
    await expect(d.getByLabel("Offering")).toHaveValue(offeringId);
    await d.getByRole("button", { name: "Create link" }).click();
    await toast(/Link ready/);
    const row = page.getByRole("table", { name: "Purchase links" }).locator("tbody tr");
    await expect(row).toContainText("Spring sale");
    await expect(row).toContainText("Go Pro on the web");
    await expect(row).toContainText(`${WEB}/pay/${slug}/spring-sale`);
    await expect(row.locator(".tag")).toHaveText(/active/i);
    link = (await ok("GET", `${P}/purchase_links`)).items[0];
    expect(link.url).toBe(`${WEB}/pay/${slug}/spring-sale`);
    await row.getByRole("button", { name: "Copy Spring sale link" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link.url);
    await row.getByRole("button", { name: "Actions for Spring sale" }).click();
    await page.getByRole("menuitem", { name: "Copy link for a signed-in user" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${link.url}?app_user_id={app_user_id}`);
    await shot("funnels");
  });

  let token = "";
  await test.step("the hosted purchase link: pick a plan, apply the discount code, pay on the fake Stripe page, read the redemption link", async () => {
    await page.goto(link.url);
    await expect(page.getByRole("heading", { name: "Go Pro on the web" })).toBeVisible();
    await expect(page.getByText("7-day free trial, then $9.99 per month")).toBeVisible();
    await expect(page.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "https://scanner.example/terms");
    await shot("pay-link");
    await page.getByRole("radio", { name: /Monthly/ }).click();
    await page.getByText("Have a discount code?").click();
    await page.getByLabel("Discount code").fill("nope");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("This code is not valid.")).toBeVisible();
    await page.getByLabel("Discount code").fill("spring20");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("20% off for 3 months applied at checkout.")).toBeVisible();
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.waitForURL(/\/__stripe\/checkout\/cs_/);
    await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
    await expect(page.locator("[data-discount]")).toBeVisible();
    await expect(page.locator("[data-amount]")).toHaveText("9.99 USD");
    await page.getByLabel("Email").fill(`buyer-${stamp}@example.com`);
    await page.getByRole("button", { name: "Pay" }).click();
    await page.waitForURL(new RegExp(`/pay/${slug}/spring-sale/success\\?`));
    await expect(page.getByRole("heading", { name: "Thank you for your purchase" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the app" })).toHaveAttribute("href", /\/pay\/r\/rdrt_/);
    await expect(page.getByRole("link", { name: "App Store" })).toHaveAttribute("href", "https://apps.apple.com/app/id123");
    const text = await page.locator(".link").textContent();
    token = /\/pay\/r\/(rdrt_[A-Za-z0-9_-]+)/.exec(text ?? "")![1]!;
    await shot("pay-success");
    // The redemption link page opens the app's scheme.
    await page.goto(`${WEB}/pay/r/${token}`);
    await expect(page.getByRole("link", { name: "Open the app" })).toHaveAttribute("href", `scanner://redeem_web_purchase?redemption_token=${token}`);
    const d = (await ok("GET", `${P}/web_discounts`)).items[0];
    expect(d.times_redeemed).toBe(1);
  });

  await test.step("the iOS SDK redeems the link: 200 with the entitlement, and a PURCHASE_REDEEMED event", async () => {
    const user = `ios_user_${stamp}`;
    const headers = { authorization: `Bearer ${iosKey}`, "x-platform": "iOS", "x-platform-flavor": "native", "x-version": "5.30.0" };
    const r = await api("POST", "/v1/subscribers/redeem_purchase", { app_user_id: user, redemption_token: token }, headers);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const e = r.body.subscriber.entitlements.pro;
    expect(e).toBeDefined();
    expect(new Date(e.expires_date).getTime()).toBeGreaterThan(Date.now());
    // A retry by the same customer answers the same; another customer gets 7852.
    expect((await api("POST", "/v1/subscribers/redeem_purchase", { app_user_id: user, redemption_token: token }, headers)).status).toBe(200);
    const other = await api("POST", "/v1/subscribers/redeem_purchase", { app_user_id: `someone_else_${stamp}`, redemption_token: token }, headers);
    expect(other.status).toBe(400);
    expect(other.body.code).toBe(7852);
    const events = (await ok("GET", `${P}/customers/${encodeURIComponent(user)}/events`)).items;
    const redeemed = events.find((x: any) => x.type === "PURCHASE_REDEEMED");
    expect(redeemed?.body).toMatchObject({ type: "PURCHASE_REDEEMED", store: "STRIPE", redeemed_by: [user], redemption_outcome: "alias", redemption_platform: "ios" });
  });

  let funnel: any;
  await test.step("funnel builder: create from the starter, edit a question and add one, see the preview change, publish", async () => {
    await page.goto(`${WEB}/projects/${pid}/funnels`);
    await page.getByRole("button", { name: "Create web funnel" }).click();
    await page.getByRole("menuitem", { name: "Start from the starter funnel" }).click();
    const d = page.getByRole("dialog", { name: "New funnel from the starter" });
    await expect(d.getByLabel("Name")).toHaveValue("Onboarding funnel");
    await d.getByRole("button", { name: "Create funnel" }).click();
    await page.waitForURL(/\/funnels\/fnl_/);
    const funnelId = page.url().split("/").pop()!.split("?")[0]!;
    const steps = page.getByRole("region", { name: "Steps" });
    const props = page.getByRole("region", { name: "Properties" });
    const preview = page.frameLocator('iframe[title="Funnel preview"]');
    await expect(steps.locator(".fb-row")).toHaveCount(5);
    await expect(preview.getByRole("heading", { name: "What do you want to get done?" })).toBeVisible();
    await props.getByLabel("Title", { exact: true }).fill("What brings you here?");
    await expect(preview.getByRole("heading", { name: "What brings you here?" })).toBeVisible();
    await props.getByRole("button", { name: "Add answer" }).click();
    await props.getByLabel("Answer 4 label").fill("Learn a language");
    await expect(preview.getByRole("radio", { name: "Learn a language" })).toBeVisible();
    // A new question step after the first one.
    await steps.getByRole("button", { name: "Add step" }).click();
    await page.getByRole("menuitem", { name: "Question" }).click();
    await expect(steps.locator(".fb-row")).toHaveCount(6);
    await expect(steps.locator(".fb-row").nth(1)).toHaveClass(/on/);
    await props.getByLabel("Title", { exact: true }).fill("Pick your pace");
    await expect(preview.getByRole("heading", { name: "Pick your pace" })).toBeVisible();
    // Move it down and back up with the arrows.
    await steps.getByRole("button", { name: "Move Pick your pace down" }).click();
    await expect(steps.locator(".fb-row").nth(2)).toContainText("Pick your pace");
    await steps.getByRole("button", { name: "Move Pick your pace up" }).click();
    await expect(steps.locator(".fb-row").nth(1)).toContainText("Pick your pace");
    // The paywall sells the web offering; the preview shows its web prices.
    await steps.locator(".fb-pick", { hasText: "Unlock your full plan" }).click();
    await props.getByLabel("Offering").selectOption("web");
    await expect(preview.getByText("7-day free trial, then $9.99 per month")).toBeVisible();
    // Problems: a success step that is not last blocks Publish.
    await steps.getByRole("button", { name: "Move You are in up" }).click();
    await expect(page.getByRole("region", { name: "Problems" })).toContainText("the success step must be the last step");
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
    await steps.getByRole("button", { name: "Move You are in down" }).click();
    await expect(page.getByRole("region", { name: "Problems" })).toContainText("Ready to publish");
    await steps.locator(".fb-pick", { hasText: "What brings you here?" }).click();
    await shot("funnel-builder");
    await page.getByRole("button", { name: "Save draft" }).click();
    await toast("Draft saved.");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await toast("Published. The public page shows this version now.");
    await expect(page.locator(".pe-meta .tag").first()).toHaveText(/published/i);
    funnel = await ok("GET", `${P}/funnels/${funnelId}`);
    expect(funnel).toMatchObject({ status: "published", url: `${WEB}/pay/${slug}/onboarding-funnel`, problems: [] });
    expect(funnel.draft.steps.map((s: any) => s.id)).toEqual(["goal", "question", "plan", "email", "paywall", "success"]);
    expect(funnel.draft.steps[4].offering).toBe("web");
  });

  await test.step("the public funnel: answer the steps, pay, see the success page", async () => {
    await page.goto(funnel.url);
    await expect(page.getByRole("heading", { name: "What brings you here?" })).toBeVisible();
    await shot("funnel-public");
    await page.getByRole("radio", { name: "Learn a language" }).click();
    await expect(page.getByRole("heading", { name: "Pick your pace" })).toBeVisible();
    await page.getByRole("radio", { name: "First answer" }).click();
    await expect(page.getByRole("heading", { name: "Your plan is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Email").fill(`funnel-${stamp}@example.com`);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Unlock your full plan" })).toBeVisible();
    await page.getByRole("radio", { name: /Annual/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/__stripe\/checkout\/cs_/);
    await expect(page.getByLabel("Email")).toHaveValue(`funnel-${stamp}@example.com`);
    await page.getByRole("button", { name: "Pay" }).click();
    await page.waitForURL(new RegExp(`/pay/${slug}/onboarding-funnel/success\\?`));
    await expect(page.getByRole("heading", { name: "You are in" })).toBeVisible();
    await expect(page.locator(".link")).toContainText("/pay/r/rdrt_");
    await shot("funnel-success", { wide: true });
  });

  await test.step("funnel analytics: 1 view and 1 purchase, and the steps' drop-off", async () => {
    await page.goto(`${WEB}/projects/${pid}/funnels/${funnel.id}?tab=analytics`);
    await page.getByRole("button", { name: "7D" }).click();
    await expect.poll(async () => (await ok("GET", `${P}/funnels/${funnel.id}/analytics?days=7`)).views, { timeout: 15_000 }).toBe(1);
    await page.reload();
    await expect(page.locator('[data-metric="views"]')).toHaveText("1");
    await expect(page.locator('[data-metric="purchases"]')).toHaveText("1");
    await expect(page.locator('[data-metric="revenue"]')).toHaveText("$59.99");
    const rows = page.getByRole("table", { name: "Step drop-off" }).locator("tbody tr");
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText("What brings you here?");
    await shot("funnel-analytics");
    await page.goto(`${WEB}/projects/${pid}/funnels`);
    const frow = page.getByRole("table", { name: "Funnels" }).locator("tbody tr");
    await expect(frow).toContainText("Onboarding funnel");
    await expect(frow.locator(".tag").first()).toHaveText(/published/i);
    await expect(frow.locator("td.amt").nth(0)).toHaveText("1");
    await expect(frow.locator("td.amt").nth(1)).toHaveText("1");
  });

  await test.step("Build with AI: the generated draft becomes a new funnel (the e2e server's fake model)", async () => {
    await page.goto(`${WEB}/projects/${pid}/funnels`);
    await page.getByRole("button", { name: "Create web funnel" }).click();
    await page.getByRole("menuitem", { name: "Build with AI" }).click();
    const d = page.getByRole("dialog", { name: "Build a funnel with AI" });
    await d.getByLabel("Describe the funnel").fill("A sleep app quiz");
    await d.getByRole("button", { name: "Generate funnel" }).click();
    await page.waitForURL(/\/funnels\/fnl_/);
    await expect(page.frameLocator('iframe[title="Funnel preview"]').getByRole("heading", { name: "AI: A sleep app quiz" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Steps" }).locator(".fb-row")).toHaveCount(4);
  });

  await test.step("phone width: every web page fits 390px and the builder stacks steps, preview, properties", async () => {
    await narrow(`${WEB}/projects/${pid}/web`, () => expect(page.getByText("You can sell on the web.")).toBeVisible());
    await narrow(`${WEB}/projects/${pid}/funnels`, () => expect(page.getByRole("table", { name: "Purchase links" })).toBeVisible());
    await narrow(`${WEB}/projects/${pid}/web-discounts`, () => expect(page.getByRole("table", { name: "Discounts" })).toBeVisible());
    await narrow(`${WEB}/projects/${pid}/settings/domains`, () => expect(page.getByLabel("Project address")).toBeVisible());
    await narrow(`${WEB}/projects/${pid}/funnels/${funnel.id}?tab=analytics`, () => expect(page.locator('[data-metric="views"]')).toHaveText("1"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/projects/${pid}/funnels/${funnel.id}`);
    await expect(page.frameLocator('iframe[title="Funnel preview"]').getByRole("heading", { name: "What brings you here?" })).toBeVisible();
    const y = async (name: string) => (await page.getByRole("region", { name }).boundingBox())!.y;
    const [a, b, c] = [await y("Steps"), await y("Preview"), await y("Properties")];
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    const o = await page.evaluate(() => { const s = document.querySelector(".scroll")!; return Math.max(document.documentElement.scrollWidth - window.innerWidth, s.scrollWidth - s.clientWidth); });
    expect(o).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await test.step("Project settings → Domains: the project address, a custom domain, its DNS records and verification", async () => {
    await page.goto(`${WEB}/projects/${pid}/settings/domains`);
    await expect(page.getByRole("tab", { name: "Domains" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Project address")).toHaveValue(slug);
    await expect(page.getByRole("region", { name: "RevenueDot domain" }).locator(".copyfield code")).toHaveText(`${WEB}/pay/${slug}`);
    const domain = `pay-${stamp}.scanner-e2e.test`;
    await page.getByLabel("Domain", { exact: true }).fill(domain);
    await page.getByRole("button", { name: "Save domain" }).click();
    await toast("Custom domain saved.");
    const dns = page.getByRole("table", { name: "DNS records" }).locator("tbody tr");
    await expect(dns).toHaveCount(2);
    await expect(dns.nth(0)).toContainText("CNAME");
    await expect(dns.nth(1)).toContainText(`_revenuedot.${domain}`);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/Not verified \(checked .*TXT record/)).toBeVisible();
    const d = await ok("GET", `${P}/web_domain`);
    const cname = d.dns.find((x: any) => x.type === "CNAME"), txt = d.dns.find((x: any) => x.type === "TXT");
    await ok("POST", "/__dns", { name: cname.name, CNAME: [cname.value] });
    await ok("POST", "/__dns", { name: txt.name, TXT: [txt.value] });
    await page.getByRole("button", { name: "Verify" }).click();
    await toast("Domain verified.");
    await expect(page.getByText(/Verified .* Pages answer on/)).toBeVisible();
    await shot("domains");
    // Back to RevenueDot's address, so links stay on this host.
    await page.getByRole("button", { name: "Remove" }).click();
    await toast("Custom domain removed.");
  });

  // Hosted pages are not the dashboard: count only the dashboard's own errors and script errors anywhere.
  expect(errors.filter((x) => !/status of 4\d\d/.test(x))).toEqual([]);
});
