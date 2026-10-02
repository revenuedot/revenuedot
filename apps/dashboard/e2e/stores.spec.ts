/**
 * Amazon Appstore and Stripe setup end to end: Add app for each store, the credential fields and their validation, the
 * live "Check credentials" (answered by the e2e server's in-process Amazon RVS and Stripe API fakes, e2e/store-fakes.ts,
 * so neither store is ever called), the notification URL with its live status, saving, and what the API returns.
 * For Stripe it also posts a subscription to /v1/receipts and sends a Stripe-signed webhook, and the open page turns
 * green by itself. Every run signs up a fresh account.
 *
 *   E2E_PORT=5394 pnpm --filter @revenuedot/dashboard e2e -- e2e/stores.spec.ts
 * SHOTS=<dir> saves the Amazon and Stripe setup sections (the README screenshots come from here).
 */
import { expect, test, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { E2E_AMAZON_SECRET, E2E_STRIPE_KEY, E2E_STRIPE_SUB, E2E_STRIPE_WHSEC } from "./store-values.ts";

test.describe.configure({ mode: "serial" });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("stores: Amazon Appstore and Stripe apps", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const WEB = baseURL!;
  const errors = watchConsole(page);
  const api = async <T = any>(method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const r = await page.request.fetch(`${WEB}${path}`, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
    const t = await r.text();
    return { status: r.status(), body: (t ? JSON.parse(t) : null) as T };
  };
  const toast = (text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible();
  const stamp = Date.now();
  const shot = async (selector: string, name: string) => { if (process.env.SHOTS) await page.locator(selector).screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };

  await page.goto(`${WEB}/signup`);
  await page.getByLabel("Your name").fill("Stores e2e");
  await page.getByLabel("Email", { exact: true }).fill(`stores-${stamp}@revenuedot.test`);
  await page.getByLabel("Password").fill(`e2e-${stamp}-pw`);
  await page.getByLabel("First project").fill("Stores");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  const pid = page.url().split("/projects/")[1]!.split("/")[0]!;
  const P = `/v2/projects/${pid}`;

  let amazonId = "";
  await test.step("Amazon: add the app with its package name", async () => {
    await page.goto(`${WEB}/projects/${pid}/apps`);
    await page.getByRole("button", { name: "Add app" }).first().click();
    const d = page.getByRole("dialog", { name: "Add an app" });
    await d.getByRole("button", { name: /Amazon Appstore/ }).click();
    await d.getByLabel("App name").fill("Scanner Fire");
    await d.getByRole("button", { name: "Add app" }).click();
    await expect(d.getByText("Enter the package name from the Amazon Appstore Console.")).toBeVisible();
    await d.getByLabel("Package name").fill("com.example.scanner");
    await d.getByRole("button", { name: "Add app" }).click();
    await page.waitForURL(/\/apps\/app/);
    amazonId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { name: "Scanner Fire" })).toBeVisible();
    await expect(page.getByText("Shared key is missing. RevenueDot needs it to check purchases with Amazon.")).toBeVisible();
  });

  await test.step("Amazon: a wrong shared key fails the live check, the right one passes, and saving keeps it secret", async () => {
    const section = page.getByRole("region", { name: "Amazon shared key" });
    await section.getByLabel("Shared key").fill("wrong key");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("The shared key has no spaces. Copy it again from Settings → Identity.")).toBeVisible();
    await section.getByLabel("Shared key").fill("wrong-key");
    await section.getByRole("button", { name: "Check credentials" }).click();
    await expect(section.getByText(/Amazon rejected the shared key/)).toBeVisible();
    await section.getByLabel("Shared key").fill(E2E_AMAZON_SECRET);
    await section.getByRole("button", { name: "Check credentials" }).click();
    await expect(section.getByText("Valid credentials. Amazon accepted the shared key.")).toBeVisible();
    await shot("#credentials", "amazon-setup");
    const notif = page.getByRole("region", { name: "Amazon Real-time Notifications" });
    await expect(notif.locator(".copyfield code")).toHaveText(new RegExp(`/v1/notifications/amazon/${amazonId}$`));
    await expect(notif.getByText(/Waiting for the first notification from Amazon/)).toBeVisible();
    await notif.getByLabel("SNS topic ARN").fill("topic");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/An SNS topic ARN looks like/)).toBeVisible();
    await notif.getByLabel("SNS topic ARN").fill("arn:aws:sns:us-east-1:123456789012:amazon-rtn");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
    await expect(page.getByText("A shared key is saved. It is never shown again.")).toBeVisible();
    await expect(page.getByText("Shared key is saved.", { exact: true })).toBeVisible();
    const settings = await api("GET", `${P}/apps/${amazonId}/store_settings`);
    expect(settings.body).toMatchObject({ sns_topic_arn: "arn:aws:sns:us-east-1:123456789012:amazon-rtn", credentials: { amazon_shared_secret: { configured: true } } });
    expect(JSON.stringify(settings.body)).not.toContain(E2E_AMAZON_SECRET);
    // The SDK snippet is the Amazon build's configuration.
    await expect(page.getByText(/AmazonConfiguration\.Builder\(this, "amzn_/)).toBeVisible();
  });

  let stripeId = "";
  let stripeKey = "";
  await test.step("Stripe: add the app, refuse a publishable key, check and save a restricted key and the signing secret", async () => {
    await page.goto(`${WEB}/projects/${pid}/apps`);
    await page.getByRole("button", { name: "Add app" }).first().click();
    const d = page.getByRole("dialog", { name: "Add an app" });
    await d.getByRole("button", { name: /Stripe/ }).click();
    await d.getByLabel("App name").fill("Scanner Web");
    await expect(d.getByLabel("Package name")).toHaveCount(0);
    await d.getByRole("button", { name: "Add app" }).click();
    await page.waitForURL(/\/apps\/app/);
    stripeId = page.url().split("/").pop()!;
    const keySection = page.getByRole("region", { name: "Stripe account" });
    await keySection.getByLabel("Restricted key").fill("pk_test_123");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("This is a publishable key (pk_…). Paste a restricted key (rk_…) instead.")).toBeVisible();
    await keySection.getByLabel("Restricted key").fill("rk_test_SomeoneElsesKey");
    await keySection.getByRole("button", { name: "Check credentials" }).click();
    await expect(keySection.getByText(/Stripe rejected the key/)).toBeVisible();
    await keySection.getByLabel("Restricted key").fill(E2E_STRIPE_KEY);
    await keySection.getByRole("button", { name: "Check credentials" }).click();
    await expect(keySection.getByText("Valid credentials. Stripe accepted the test mode key.")).toBeVisible();
    const hooks = page.getByRole("region", { name: "Stripe webhooks" });
    await expect(hooks.getByText(/customer\.subscription\.updated/)).toBeVisible();
    await hooks.getByLabel("Signing secret").fill(E2E_STRIPE_WHSEC);
    const counts = page.getByRole("region", { name: "Which purchases count" });
    await expect(counts.getByLabel("When does a subscription count?")).toHaveValue("invoice_paid");
    await counts.getByLabel("Find the app user ID from").selectOption("customer_id");
    await expect(counts.getByLabel("Metadata key")).toHaveCount(0);
    await counts.getByLabel("Find the app user ID from").selectOption("metadata");
    await counts.getByLabel("Metadata key").fill("uid");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
    await expect(page.getByText(/A test mode restricted key ending in/)).toBeVisible();
    await expect(page.getByText("A signing secret is saved.")).toBeVisible();
    const settings = await api("GET", `${P}/apps/${stripeId}/store_settings`);
    expect(settings.body).toMatchObject({ credentials: { stripe_secret_key: { configured: true, mode: "test", kind: "restricted", last4: E2E_STRIPE_KEY.slice(-4) }, stripe_webhook_secret: { configured: true } },
      stripe: { app_user_id_source: "metadata", app_user_id_metadata_key: "uid", register_on: "invoice_paid" } });
    const body = JSON.stringify(settings.body);
    expect(body).not.toContain(E2E_STRIPE_KEY);
    expect(body).not.toContain(E2E_STRIPE_WHSEC);
    const keys = await api("GET", `${P}/apps/${stripeId}/public_api_keys`);
    stripeKey = keys.body.items[0].key;
    expect(stripeKey).toMatch(/^strp_/);
    await expect(page.getByText(/"X-Platform": "stripe"|X-Platform: stripe/).first()).toBeVisible();
  });

  await test.step("Stripe: the backend posts a subscription, a signed webhook arrives, and the open page shows it", async () => {
    const res = await api("POST", "/v1/receipts", { app_user_id: "web_e2e_user", fetch_token: E2E_STRIPE_SUB }, { authorization: `Bearer ${stripeKey}`, "x-platform": "stripe" });
    expect(res.status).toBe(200);
    expect(res.body.subscriber.subscriptions.prod_E2eMonthly).toMatchObject({ store: "stripe", is_sandbox: true });
    const hooks = page.getByRole("region", { name: "Stripe webhooks" });
    await expect(hooks.getByText(/Waiting for the first notification from Stripe/)).toBeVisible();
    // A forged event is refused and shows as a failure on the page.
    const event = JSON.stringify({ id: `evt_e2e_${stamp}`, object: "event", type: "customer.subscription.updated", created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: E2E_STRIPE_SUB, object: "subscription" } } });
    const t = Math.floor(Date.now() / 1000);
    const bad = await page.request.post(`${WEB}/v1/notifications/stripe/${stripeId}`, { data: event, headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${"0".repeat(64)}` } });
    expect(bad.status()).toBe(400);
    await expect(hooks.getByText(/The last notification from Stripe could not be processed/)).toBeVisible({ timeout: 15_000 });
    const sig = createHmac("sha256", E2E_STRIPE_WHSEC).update(`${t}.${event}`).digest("hex");
    const good = await page.request.post(`${WEB}/v1/notifications/stripe/${stripeId}`, { data: event, headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` } });
    expect(await good.json()).toEqual({ status: "processed" });
    await expect(hooks.getByText(/Stripe notifications are configured correctly\. Last received/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Stripe webhooks arrive \(last/)).toBeVisible();
    await shot("#notifications", "stripe-webhooks");
  });

  await test.step("the Apps list shows both stores as ready or waiting", async () => {
    await page.goto(`${WEB}/projects/${pid}/apps`);
    const rows = page.locator("tbody tr");
    await expect(rows.filter({ hasText: "Scanner Fire" })).toContainText("Amazon Appstore");
    await expect(rows.filter({ hasText: "Scanner Fire" })).toContainText("Waiting for store notifications");
    await expect(rows.filter({ hasText: "Scanner Web" })).toContainText("Ready");
  });

  await test.step("phone width: the Stripe page has no horizontal scroll", async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${WEB}/projects/${pid}/apps/${stripeId}`);
    await expect(page.getByRole("region", { name: "Stripe account" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  // The forged webhook's 400 shows in the console as a failed request; nothing else may error.
  expect(errors.filter((x) => !/status of 400/.test(x))).toEqual([]);
});
