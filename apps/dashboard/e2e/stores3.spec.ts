/**
 * Paddle, Roku and Samsung Galaxy Store end to end in the browser: Add app for each store, wrong and right credentials
 * with the live check, saving (secrets never come back), Apply in Paddle, Import products, a purchase posted the way the
 * store's SDK or backend posts it, the store's signed notifications turning the open page green, lifecycle changes on the
 * customer page, forged notifications refused, the Apps list, phone width and dark mode, no console errors. The stores are
 * the stateful fakes in packages/contract/src, driven through the e2e server's /__store3/* routes (e2e/store3-routes.ts);
 * Paddle, Roku and Samsung are never called. Every run signs up a fresh account.
 *
 *   E2E_PORT=5510 pnpm --filter @revenuedot/dashboard e2e -- e2e/stores3.spec.ts
 * SHOTS=<dir> saves each store's setup sections.
 */
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("stores: Paddle, Roku and Samsung Galaxy Store apps", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const WEB = baseURL!;
  const errors = watchConsole(page);
  const api = async <T = any>(method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const r = await page.request.fetch(`${WEB}${path}`, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
    const t = await r.text();
    let body: any = t;
    try { body = t ? JSON.parse(t) : null; } catch { /* text */ }
    return { status: r.status(), body: body as T };
  };
  const toast = (text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible();
  const stamp = Date.now();
  const shot = async (selector: string, name: string) => {
    if (!process.env.SHOTS) return;
    // The customer page keeps updating, so it is captured as the viewport rather than waiting for <main> to stand still.
    if (selector === "viewport") await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
    else await page.locator(selector).first().screenshot({ path: `${process.env.SHOTS}/${name}.png` });
  };
  const values = (await api("GET", "/__store3/values")).body;
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

  await page.goto(`${WEB}/signup`);
  await page.getByLabel("Your name").fill("Stores3 e2e");
  await page.getByLabel("Email", { exact: true }).fill(`stores3-${stamp}@revenuedot.test`);
  await page.getByLabel("Password").fill(`e2e-${stamp}-pw`);
  await page.getByLabel("First project").fill("More stores");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  const pid = page.url().split("/projects/")[1]!.split("/")[0]!;
  const P = `/v2/projects/${pid}`;
  const pro = (await api("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" })).body;

  const addApp = async (choice: RegExp, name: string, packageName?: string) => {
    await page.goto(`${WEB}/projects/${pid}/apps`);
    await page.getByRole("button", { name: "Add app" }).first().click();
    const d = page.getByRole("dialog", { name: "Add an app" });
    await expect(d.getByRole("button", { name: /\(soon\)/ })).toHaveCount(0);
    await d.getByRole("button", { name: choice }).click();
    await d.getByLabel("App name").fill(name);
    if (packageName) {
      await d.getByRole("button", { name: "Add app" }).click();
      await expect(d.getByText("Enter the package name from Samsung Seller Portal.")).toBeVisible();
      await d.getByLabel("Package name").fill(packageName);
    }
    await d.getByRole("button", { name: "Add app" }).click();
    await page.waitForURL(/\/apps\/app/);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    return page.url().split("/").pop()!;
  };
  const publicKey = async (appId: string) => (await api("GET", `${P}/apps/${appId}/public_api_keys`)).body.items[0].key as string;
  const historyOf = async (user: string) => {
    await page.goto(`${WEB}/projects/${pid}/customers/${encodeURIComponent(user)}`);
    await expect(page.getByRole("heading", { name: user })).toBeVisible();
  };

  // ---------------------------------------------------------------------------------------------------------- Paddle
  let paddleId = "", paddleKey = "", subId = "", txnId = "";
  const paddleUser = `paddle_${stamp}`;
  await test.step("Paddle: add the app, refuse a client-side token, check a limited and a good key, save it", async () => {
    paddleId = await addApp(/^Paddle/, "Scanner Web (Paddle)");
    await expect(page.getByText("Paddle API key is missing. RevenueDot needs it to check purchases with Paddle.")).toBeVisible();
    const keys = page.getByRole("region", { name: "Paddle API key" });
    await keys.getByLabel("API key").fill("test_0123456789abcdef0123456789");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/This is a client-side token/)).toBeVisible();
    await keys.getByLabel("API key").fill(values.paddle.limited_key);
    await keys.getByRole("button", { name: "Check credentials" }).click();
    await expect(keys.getByText(/cannot read everything RevenueDot needs/)).toBeVisible();
    await keys.getByLabel("API key").fill(values.paddle.api_key);
    await keys.getByRole("button", { name: "Check credentials" }).click();
    await expect(keys.getByText("Valid credentials. Paddle accepted the sandbox key.")).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
    await expect(keys.getByText(new RegExp(`A sandbox key ending in ${values.paddle.api_key.slice(-4)} is saved`))).toBeVisible();
    const st = await api("GET", `${P}/apps/${paddleId}/store_settings`);
    expect(JSON.stringify(st.body)).not.toContain(values.paddle.api_key);
    expect(st.body.credentials.paddle_api_key).toMatchObject({ configured: true, environment: "sandbox" });
    paddleKey = await publicKey(paddleId);
    expect(paddleKey).toMatch(/^pdl_/);
    await shot("#credentials", "paddle-key");
  });

  await test.step("Paddle: Apply in Paddle creates the notification destination and saves its secret", async () => {
    const notif = page.getByRole("region", { name: "Paddle notifications" });
    await expect(notif.locator(".copyfield code")).toHaveText(new RegExp(`/v1/notifications/paddle/${paddleId}$`));
    await expect(notif.getByText(/Waiting for the first notification from Paddle/)).toBeVisible();
    await notif.getByRole("button", { name: "Apply in Paddle" }).click();
    await expect(notif.getByText(/Paddle now sends notifications to this app/)).toBeVisible();
    await expect(notif.getByRole("button", { name: "Apply in Paddle again" })).toBeVisible();
    const st = await api("GET", `${P}/apps/${paddleId}/store_settings`);
    expect(st.body.credentials.paddle_webhook_secret).toEqual({ configured: true });
    expect(st.body.paddle.notification_setting_id).toMatch(/^ntfset_/);
  });

  await test.step("Paddle: Import products lists each price; import them into pro", async () => {
    await api("POST", "/__store3/paddle/seed", { products: [{ name: `Scanner Pro ${stamp}`, prices: [{ amount: 999, interval: "month", name: "Monthly" }, { amount: 7999, interval: "year", name: "Annual", trial_days: 7 }] }] });
    await page.getByRole("button", { name: "Import products", exact: true }).click();
    const d = page.getByRole("dialog", { name: /Import products/ });
    await expect(d.getByRole("row", { name: new RegExp(`Scanner Pro ${stamp} \\(Annual\\)`) })).toContainText("1 year");
    await expect(d.getByRole("row", { name: new RegExp(`Scanner Pro ${stamp} \\(Annual\\)`) })).toContainText("Free trial: 7 days.");
    await d.getByRole("checkbox", { name: /^pro/ }).check();
    for (const row of await d.locator("tbody tr").filter({ hasText: `Scanner Pro ${stamp}` }).all()) await row.getByRole("checkbox").check();
    await d.getByRole("button", { name: /Import 2 products/ }).click();
    await expect(d.getByText("Imported 2 products from Paddle.")).toBeVisible();
    await d.getByRole("button", { name: "Done" }).click();
  });

  await test.step("Paddle: a purchase posted by the backend unlocks pro; Paddle's signed events turn the page green", async () => {
    const prices = (await api("GET", `${P}/products?app_id=${paddleId}`)).body.items as Array<{ store_identifier: string; subscription?: { duration: string } }>;
    const monthly = prices.find((p) => p.subscription?.duration === "P1M")!.store_identifier;
    const buy = (await api("POST", "/__store3/paddle/do", { action: "buy", price: monthly, custom_data: { app_user_id: paddleUser } })).body;
    subId = buy.subscription_id; txnId = buy.transaction_id;
    const r = await api("POST", "/v1/receipts", { app_user_id: paddleUser, fetch_token: txnId }, { authorization: `Bearer ${paddleKey}`, "x-platform": "paddle" });
    expect(r.status).toBe(200);
    expect(r.body.subscriber.entitlements.pro).toMatchObject({ product_identifier: monthly });
    expect(r.body.subscriber.subscriptions[monthly]).toMatchObject({ store: "paddle", is_sandbox: true });
    // A forged event is refused and the page says so.
    const forged = await api("POST", "/__store3/paddle/deliver", { app_id: paddleId, events: buy.events.slice(0, 1), forged: true });
    expect(forged.body.results[0].status).toBe(400);
    const notif = page.getByRole("region", { name: "Paddle notifications" });
    await expect(notif.getByText(/The last notification from Paddle could not be processed/)).toBeVisible({ timeout: 15_000 });
    const ok = await api("POST", "/__store3/paddle/deliver", { app_id: paddleId, events: buy.events });
    expect(ok.body.results.map((x: { status: number }) => x.status)).toEqual([200, 200, 200]);
    await expect(notif.getByText(/Paddle notifications are configured correctly\. Last received/)).toBeVisible({ timeout: 15_000 });
    await shot("#notifications", "paddle-notifications");
  });

  await test.step("Paddle: renewal, failed payment, scheduled cancellation and refund show on the customer page", async () => {
    const deliver = async (body: Record<string, unknown>) => {
      const ev = (await api("POST", "/__store3/paddle/do", body)).body;
      const out = await api("POST", "/__store3/paddle/deliver", { app_id: paddleId, events: ev.events });
      expect(out.body.results.every((x: { status: number }) => x.status === 200)).toBe(true);
      return ev;
    };
    await deliver({ action: "renew", subscription_id: subId });
    const failed = await deliver({ action: "renew", subscription_id: subId, fail: true });
    await deliver({ action: "recover", subscription_id: subId });
    await deliver({ action: "schedule_cancel", subscription_id: subId });
    // A refund of the period being used (the recovered renewal).
    await deliver({ action: "refund", transaction_id: failed.transaction_id });
    await historyOf(paddleUser);
    for (const t of ["Started a subscription", "Renewed", "Had a billing issue", "Opted out of renewal", "Was issued a refund"]) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Paddle").first()).toBeVisible();
    await shot("viewport", "paddle-customer");
    // The refund ended access: the SDK sees pro expired at the refund.
    const ci = await api("GET", `/v1/subscribers/${paddleUser}`, undefined, { authorization: `Bearer ${paddleKey}` });
    expect(new Date(ci.body.subscriber.entitlements.pro.expires_date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  // ------------------------------------------------------------------------------------------------------------- Roku
  let rokuId = "", rokuKey = "";
  const rokuUser = `roku_${stamp}`;
  await test.step("Roku: add the app (no longer 'soon'), a wrong key fails the check, the right one passes", async () => {
    rokuId = await addApp(/^Roku/, "Scanner TV");
    const sec = page.getByRole("region", { name: "Roku Pay" });
    await sec.getByLabel("Roku Pay API key").fill("WRONGKEY0123456789ABCDEF012345678");
    await sec.getByRole("button", { name: "Check credentials" }).click();
    await expect(sec.getByText(/Roku rejected the API key \(UNAUTHORIZED\)/)).toBeVisible();
    await sec.getByLabel("Roku Pay API key").fill(values.roku.api_key);
    await sec.getByRole("button", { name: "Check credentials" }).click();
    await expect(sec.getByText("Valid credentials. Roku accepted the Roku Pay API key.")).toBeVisible();
    await sec.getByLabel("Channel ID").fill(values.roku.channel_id);
    await sec.getByLabel("Channel name").fill(values.roku.channel_name);
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
    await expect(sec.getByText("A Roku Pay API key is saved. It is never shown again.")).toBeVisible();
    const app = (await api("GET", `${P}/apps/${rokuId}`)).body;
    expect(app.roku).toEqual({ roku_channel_id: values.roku.channel_id, roku_channel_name: values.roku.channel_name });
    rokuKey = await publicKey(rokuId);
    await expect(page.getByText(/proxyUrl: ".*\/v1\/"/)).toBeVisible();
    await shot("#credentials", "roku-setup");
  });

  await test.step("Roku: the SDK's purchase, Roku's signed pushes, a cancellation on the customer page", async () => {
    await api("POST", `${P}/products`, { store_identifier: "scanner_monthly", app_id: rokuId, type: "subscription", subscription: { duration: "P1M" } }).then(async (r) => {
      await api("POST", `${P}/entitlements/${pro.id}/actions/attach_products`, { product_ids: [r.body.id] });
    });
    const buy = (await api("POST", "/__store3/roku/do", { action: "buy", product: "scanner_monthly", price: 4.99 })).body;
    const tx: string = buy.transaction_id;
    const dashed = `${tx.slice(0, 8)}-${tx.slice(8, 12)}-${tx.slice(12, 16)}-${tx.slice(16, 20)}-${tx.slice(20)}`;
    const r = await api("POST", "/v1/receipts", { fetch_token: dashed, app_user_id: rokuUser, product_id: "scanner_monthly", price: "$4.99", trial_duration: null, intro_duration: null },
      { authorization: `Bearer ${rokuKey}`, "x-platform": "roku", "x-platform-flavor": "native", "x-is-sandbox": "true" });
    expect(r.status).toBe(200);
    expect(r.body.subscriber.subscriptions.scanner_monthly).toMatchObject({ store: "roku", is_sandbox: true });
    const notif = page.getByRole("region", { name: "Roku push notifications" });
    const forged = await api("POST", "/__store3/roku/deliver", { app_id: rokuId, events: buy.events, forged: true });
    expect(forged.body.results[0].status).toBe(400);
    const ok = await api("POST", "/__store3/roku/deliver", { app_id: rokuId, events: buy.events });
    expect(ok.body.results[0]).toEqual({ status: 200, body: buy.events[0].responseKey });
    await expect(notif.getByText(/Roku notifications are configured correctly/)).toBeVisible({ timeout: 15_000 });
    const cancel = (await api("POST", "/__store3/roku/do", { action: "cancel", chain: tx })).body;
    await api("POST", "/__store3/roku/deliver", { app_id: rokuId, events: cancel.events });
    await historyOf(rokuUser);
    await expect(page.getByText("Opted out of renewal", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Roku").first()).toBeVisible();
  });

  // ----------------------------------------------------------------------------------------------------------- Galaxy
  let galaxyId = "", galaxyKey = "";
  const galaxyUser = `galaxy_${stamp}`;
  await test.step("Galaxy Store: add the app with its package name, a service account the check accepts, the IAP key", async () => {
    galaxyId = await addApp(/^Galaxy Store/, "Scanner Galaxy", values.galaxy.package_name);
    const sec = page.getByRole("region", { name: "Service account" });
    await sec.getByLabel("Service account ID").fill("someone-else-0001");
    await page.locator("#f-galaxyKey").setInputFiles({ name: "service-account.key", mimeType: "text/plain", buffer: Buffer.from(values.galaxy.private_key) });
    await sec.getByRole("button", { name: "Check credentials" }).click();
    await expect(sec.getByText(/Samsung rejected the service account/)).toBeVisible();
    await sec.getByLabel("Service account ID").fill(values.galaxy.service_account_id);
    await sec.getByRole("button", { name: "Check credentials" }).click();
    await expect(sec.getByText("Valid credentials. Samsung accepted the service account and it can read this app's subscriptions.")).toBeVisible();
    const notif = page.getByRole("region", { name: "Galaxy Store server notifications" });
    await notif.getByLabel("IAP public key (optional)").fill("not a key");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Paste the IAP public key from Seller Portal/)).toBeVisible();
    await notif.getByLabel("IAP public key (optional)").fill(values.galaxy.iap_public_key);
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
    await expect(sec.getByText(new RegExp(`The private key of ${values.galaxy.service_account_id} is saved`))).toBeVisible();
    const st = await api("GET", `${P}/apps/${galaxyId}/store_settings`);
    expect(st.body.galaxy).toMatchObject({ service_account_id: values.galaxy.service_account_id, configured: true, iap_public_key_configured: true });
    expect(JSON.stringify(st.body)).not.toContain("PRIVATE KEY");
    galaxyKey = await publicKey(galaxyId);
    expect(galaxyKey).toMatch(/^galx_/);
    await expect(page.getByText(/GalaxyConfiguration\.Builder\(this, "galx_/)).toBeVisible();
    await shot("#credentials", "galaxy-setup");
  });

  await test.step("Galaxy Store: Samsung's test notification, the SDK's purchase, a renewal and an item", async () => {
    const notif = page.getByRole("region", { name: "Galaxy Store server notifications" });
    const t = (await api("POST", "/__store3/galaxy/do", { action: "test" })).body;
    expect((await api("POST", "/__store3/galaxy/deliver", { app_id: galaxyId, events: t.events, forged: true })).body.results[0].status).toBe(400);
    expect((await api("POST", "/__store3/galaxy/deliver", { app_id: galaxyId, events: t.events })).body.results[0].status).toBe(200);
    await expect(notif.getByText(/Samsung notifications are configured correctly/)).toBeVisible({ timeout: 15_000 });
    const m = await api("POST", `${P}/products`, { store_identifier: "premium_monthly", app_id: galaxyId, type: "subscription", subscription: { duration: "P1M" } });
    await api("POST", `${P}/entitlements/${pro.id}/actions/attach_products`, { product_ids: [m.body.id] });
    await api("POST", `${P}/products`, { store_identifier: "coins_100", app_id: galaxyId, type: "consumable" });
    const s = (await api("POST", "/__store3/galaxy/do", { action: "subscribe", item: "premium_monthly", amount: 4.99, test: true })).body;
    const headers = { authorization: `Bearer ${galaxyKey}`, "x-platform": "android", "x-platform-flavor": "native" };
    const r = await api("POST", "/v1/receipts", { fetch_token: s.purchase_id, product_ids: ["premium_monthly"], app_user_id: galaxyUser, price: 4.99, currency: "USD", normal_duration: "P1M" }, headers);
    expect(r.status).toBe(200);
    expect(r.body.subscriber.subscriptions.premium_monthly).toMatchObject({ store: "galaxy", is_sandbox: true });
    const coins = (await api("POST", "/__store3/galaxy/do", { action: "buy_item", item: "coins_100", amount: 0.99 })).body;
    const rc = await api("POST", "/v1/receipts", { fetch_token: coins.purchase_id, product_ids: ["coins_100"], app_user_id: galaxyUser, price: 0.99, currency: "USD" }, headers);
    expect(rc.body.purchased_products).toEqual({ coins_100: { should_consume: true } });
    const renew = (await api("POST", "/__store3/galaxy/do", { action: "renew", purchase_id: s.purchase_id })).body;
    expect((await api("POST", "/__store3/galaxy/deliver", { app_id: galaxyId, events: renew.events })).body.results[0].status).toBe(200);
    await historyOf(galaxyUser);
    await expect(page.getByText("Renewed", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Galaxy Store").first()).toBeVisible();
  });

  await test.step("Galaxy Store: Import products lists items and explains subscriptions", async () => {
    await api("POST", "/__store3/galaxy/do", { action: "item", id: `gems_${stamp}`, title: "Gems", usd_price: 1.99 });
    await page.goto(`${WEB}/projects/${pid}/apps/${galaxyId}`);
    await page.getByRole("button", { name: "Import products", exact: true }).click();
    const d = page.getByRole("dialog", { name: /Import products/ });
    await expect(d.getByText(/in-app items only/)).toBeVisible();
    await expect(d.getByRole("row", { name: new RegExp(`gems_${stamp}`) })).toContainText("Gems");
    await d.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("the Apps list shows each store's state", async () => {
    await page.goto(`${WEB}/projects/${pid}/apps`);
    const rows = page.locator("tbody tr");
    await expect(rows.filter({ hasText: "Scanner Web (Paddle)" })).toContainText("Ready");
    await expect(rows.filter({ hasText: "Scanner TV" })).toContainText("Ready");
    await expect(rows.filter({ hasText: "Scanner Galaxy" })).toContainText(values.galaxy.package_name);
  });

  await test.step("phone width and dark mode: every store page fits and renders", async () => {
    await page.setViewportSize({ width: 390, height: 900 });
    for (const id of [paddleId, rokuId, galaxyId]) {
      await page.goto(`${WEB}/projects/${pid}/apps/${id}`);
      await expect(page.locator("#credentials")).toBeVisible();
      await noOverflow();
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const id of [paddleId, rokuId, galaxyId]) {
      await page.goto(`${WEB}/projects/${pid}/apps/${id}`);
      await expect(page.locator("#notifications")).toBeVisible();
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe("rgb(10, 10, 10)");
    }
    await page.goto(`${WEB}/projects/${pid}/apps`);
    await page.getByRole("button", { name: "Add app" }).first().click();
    await shot("[role=dialog]", "add-app-dark");
    await page.emulateMedia({ colorScheme: "light" });
  });

  // The forged notifications' 400s show in the console as failed requests (made by the test, not the page); nothing else may error.
  expect(errors.filter((x) => !/status of 400/.test(x))).toEqual([]);
});
