/**
 * Setup areas end to end: new project, apps (App Store, Google Play, Test Store) with credentials, live notification
 * status and forwarding, API keys, webhooks (signed deliveries, retry, test event), project settings (transfer
 * behaviour checked against real receipt posts) and project deletion. Everything is driven through the dashboard UI and
 * checked against the REST API and the SDK endpoints.
 *
 * Apple and Google are never called: the "Check credentials" answer is mocked in the browser (the server side of that
 * check is covered by apps/server/test/setup-endpoints.test.ts). Webhooks go to a listener this test starts.
 *
 *   RD_WEB=http://localhost:5178 npx playwright test e2e/setup.spec.ts      (running API :8787 + dashboard :5178)
 *   npx playwright test -c e2e/playwright.config.ts e2e/setup.spec.ts         (the self-contained e2e server)
 * Every run signs up a fresh account. SHOTS=<dir> saves screenshots of each dialog and state.
 */
import { expect, test, type Page } from "@playwright/test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

test.describe.configure({ mode: "serial" });

type Hit = { path: string; body: string; headers: http.IncomingHttpHeaders };

function listener() {
  const hits: Hit[] = [];
  let failing = true;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", body, headers: req.headers });
      res.writeHead(req.url?.startsWith("/flaky") && failing ? 500 : 200).end("ok");
    });
  });
  return {
    hits, server,
    start: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port))),
    heal: () => { failing = false; },
  };
}

const p8 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const serviceAccount = JSON.stringify({ type: "service_account", project_id: "scanner", private_key_id: "kid1", private_key: rsa, client_email: "revenuedot@scanner.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token" });

const verifySig = (secret: string, body: string, header: string) => {
  const m = /t=(\d+),v1=([0-9a-f]+)/.exec(header);
  return !!m && createHmac("sha256", secret).update(`${m[1]}.${body}`).digest("hex") === m[2];
};

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("setup: project, apps, credentials, API keys, webhooks, settings", async ({ page, context, baseURL }) => {
  test.setTimeout(300_000);
  const WEB = process.env.RD_WEB ?? baseURL ?? "http://localhost:5178";
  const shot = async (name: string) => {
    if (!process.env.SHOTS) return;
    await page.waitForTimeout(350); // let dialogs finish fading in
    await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
  };
  const errors = watchConsole(page);
  const req = page.request;
  const api = async <T = any>(method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
    const r = await req.fetch(`${WEB}${path}`, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
    const t = await r.text();
    return { status: r.status(), body: (t ? JSON.parse(t) : null) as T };
  };
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: WEB });
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const hooks = listener();
  const port = await hooks.start();
  const stamp = Date.now();
  const toast = (text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible();

  let pid = "";
  await test.step("sign up, then create a second project from the project switcher", async () => {
    await page.goto(`${WEB}/signup`);
    await page.getByLabel("Your name").fill("Setup e2e");
    await page.getByLabel("Email", { exact: true }).fill(`setup-${stamp}@revenuedot.test`);
    await page.getByLabel("Password").fill(`e2e-${stamp}-pw`);
    await page.getByLabel("First project").fill("First project");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.waitForURL(/\/projects\/[^/]+\/overview/);
    await page.getByRole("button", { name: /First project/ }).first().click();
    await page.getByRole("menuitem", { name: "New project" }).click();
    await page.waitForURL(/\/projects\/new$/);
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByText("Give the project a name.")).toBeVisible();
    await page.getByLabel("Project name").fill("Setup e2e");
    await shot("new-project");
    await page.getByRole("button", { name: "Create project" }).click();
    await page.waitForURL(/\/projects\/(?!new)[^/]+\/overview/);
    pid = page.url().split("/projects/")[1]!.split("/")[0]!;
    const me = await api("GET", "/auth/me");
    expect(me.body.projects.map((p: any) => p.name).sort()).toEqual(["First project", "Setup e2e"]);
  });
  const P = `/v2/projects/${pid}`;
  const base = `${WEB}/projects/${pid}`;

  let iosId = "";
  await test.step("add an App Store app; the dialog validates the bundle ID", async () => {
    await page.goto(`${base}/apps`);
    await expect(page.getByRole("heading", { name: "Add your first app" })).toBeVisible();
    await page.getByRole("button", { name: "Add app" }).first().click();
    const d = page.getByRole("dialog", { name: "Add an app" });
    await d.getByRole("button", { name: "Add app" }).click();
    await expect(d.getByText("Give the app a name, for example Scanner iOS.")).toBeVisible();
    await expect(d.getByText("Enter the bundle ID from Xcode.")).toBeVisible();
    await d.getByLabel("App name").fill("Scanner iOS");
    await d.getByLabel("Bundle ID").fill("not a bundle");
    await d.getByRole("button", { name: "Add app" }).click();
    await expect(d.getByText("A bundle ID looks like com.company.app.")).toBeVisible();
    await d.getByLabel("Bundle ID").fill("com.example.scanner");
    await shot("add-app-dialog");
    await d.getByRole("button", { name: "Add app" }).click();
    await page.waitForURL(/\/apps\/app/);
    iosId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { name: "Scanner iOS" })).toBeVisible();
    const app = await api("GET", `${P}/apps/${iosId}`);
    expect(app.body).toMatchObject({ type: "app_store", app_store: { bundle_id: "com.example.scanner", subscription_key_configured: false } });
  });

  await test.step("App Store: .p8 upload fills the key ID, the credential check, forwarding URL, save", async () => {
    let verify: object = { object: "credentials_check", status: "invalid", valid: false, message: "Apple rejected the key. Check that the key ID and issuer ID belong to this .p8 file and that the key is an In-App Purchase key.", checked_at: Date.now() };
    const verifyBodies: any[] = [];
    await page.route("**/actions/verify_credentials", async (route) => { verifyBodies.push(route.request().postDataJSON()); await route.fulfill({ json: verify }); });
    await page.locator("#f-p8").setInputFiles({ name: "SubscriptionKey_ABC123DEFG.p8", mimeType: "application/octet-stream", buffer: Buffer.from(p8) });
    await expect(page.getByText("SubscriptionKey_ABC123DEFG.p8 is ready to save.")).toBeVisible();
    const iap = page.getByRole("region", { name: "In-app purchase key" });
    await expect(iap.getByLabel("Key ID")).toHaveValue("ABC123DEFG");
    await iap.getByLabel("Issuer ID").fill("69a6de94-014f-47e3-e053-5b8c7c11a4d1");
    await page.getByRole("button", { name: "Check credentials" }).click();
    await expect(page.getByText(/Apple rejected the key/)).toBeVisible();
    expect(verifyBodies[0]).toMatchObject({ app_store: { subscription_key_id: "ABC123DEFG", subscription_key_issuer: "69a6de94-014f-47e3-e053-5b8c7c11a4d1", bundle_id: "com.example.scanner" } });
    expect(verifyBodies[0].app_store.subscription_private_key).toContain("BEGIN PRIVATE KEY");
    verify = { object: "credentials_check", status: "valid", valid: true, message: "Apple accepted the in-app purchase key.", checked_at: Date.now() };
    await page.getByRole("button", { name: "Check credentials" }).click();
    await expect(page.getByText("Valid credentials. Apple accepted the in-app purchase key.")).toBeVisible();
    await shot("app-store-valid-credentials");

    // The notification URL is copyable and points at this server.
    const url = await page.locator("#notifications .copyfield code").textContent();
    expect(url).toMatch(new RegExp(`/v1/notifications/apple/${iosId}$`));
    await page.getByRole("button", { name: "Copy notification URL" }).click();
    expect(await clipboard()).toBe(url);
    await expect(page.getByText(/Waiting for the first notification from Apple/)).toBeVisible();

    // Forwarding URL validation, then a real one (our listener stands in for RevenueCat).
    await page.getByLabel("Forward notifications to RevenueCat or your own server").fill(new URL(url!).origin + "/v1/x");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/forwarding there would loop/)).toBeVisible();
    await page.getByLabel("Forward notifications to RevenueCat or your own server").fill(`http://127.0.0.1:${port}/apple-forward`);
    await page.getByText("Track new purchases from server-to-server notifications").click();
    await page.getByRole("button", { name: /StoreKit testing in Xcode/ }).click();
    await page.getByRole("switch", { name: "Allow unsigned receipts (development only)" }).click();
    await expect(page.getByText(/Anyone can then send a made-up receipt/)).toBeVisible();
    await page.getByRole("switch", { name: "Allow unsigned receipts (development only)" }).click();
    await page.getByRole("button", { name: /App-specific shared secret/ }).click();
    await page.getByLabel("Shared secret").fill("0123456789abcdef0123456789abcdef");
    await shot("app-store-unsaved");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
    await expect(page.getByText("Key ABC123DEFG is saved. The private key is never shown again.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
    const s = await api("GET", `${P}/apps/${iosId}/store_settings`);
    expect(s.body).toMatchObject({
      notification_forward_url: `http://127.0.0.1:${port}/apple-forward`, track_new_purchases: true, allow_unsigned_receipts: false,
      credentials: { subscription_key: { configured: true, key_id: "ABC123DEFG", issuer_id: "69a6de94-014f-47e3-e053-5b8c7c11a4d1" }, shared_secret: { configured: true } },
    });
    expect(JSON.stringify(s.body)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify((await api("GET", `${P}/apps/${iosId}`)).body)).not.toContain("0123456789abcdef");
    // Saving new key material re-runs the check against the stored key.
    await expect.poll(() => verifyBodies.some((b) => b && Object.keys(b).length === 0)).toBe(true);
    await page.unroute("**/actions/verify_credentials");
  });

  await test.step("a store notification is forwarded and the status on the open page updates by itself", async () => {
    const res = await api("POST", `/v1/notifications/apple/${iosId}`, { signedPayload: "not-a-jws" });
    expect(res.status).toBe(400);
    await expect.poll(() => hooks.hits.filter((h) => h.path === "/apple-forward").length, { timeout: 10_000 }).toBe(1);
    expect(JSON.parse(hooks.hits.find((h) => h.path === "/apple-forward")!.body)).toEqual({ signedPayload: "not-a-jws" });
    await expect(page.getByText(/The last notification from Apple could not be processed/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Last forward: HTTP 200/)).toBeVisible({ timeout: 15_000 });
    await shot("app-store-live-status");
  });

  let playId = "";
  await test.step("Google Play: service account upload, explained check failure, save", async () => {
    await page.goto(`${base}/apps`);
    await page.getByRole("button", { name: "Add app" }).click();
    const d = page.getByRole("dialog", { name: "Add an app" });
    await d.getByRole("button", { name: /Google Play/ }).click();
    await d.getByLabel("App name").fill("Scanner Android");
    await d.getByLabel("Package name").fill("com.example.scanner");
    await d.getByRole("button", { name: "Add app" }).click();
    await page.waitForURL(/\/apps\/app/);
    playId = page.url().split("/").pop()!;
    await page.locator("#f-sa").setInputFiles({ name: "notakey.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
    await expect(page.getByText("This JSON is not a service account key: it has no client_email and private_key.")).toBeVisible();
    await page.locator("#f-sa").setInputFiles({ name: "scanner-sa.json", mimeType: "application/json", buffer: Buffer.from(serviceAccount) });
    await expect(page.getByText("revenuedot@scanner.iam.gserviceaccount.com")).toBeVisible();
    await page.route("**/actions/verify_credentials", (route) => route.fulfill({ json: { object: "credentials_check", status: "invalid", valid: false, message: "The service account works but cannot see this app yet. In Play Console, invite it under Users and permissions with the financial data and order management permissions. New permissions can take up to 36 hours to apply.", checked_at: Date.now() } }));
    await page.getByRole("button", { name: "Check credentials" }).click();
    await expect(page.getByText(/cannot see this app yet/)).toBeVisible();
    const endpoint = await page.locator("#notifications .copyfield code").textContent();
    expect(endpoint).toMatch(new RegExp(`/v1/notifications/google/${playId}$`));
    await shot("google-play");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Changes saved.");
    await expect(page.getByText("Service account revenuedot@scanner.iam.gserviceaccount.com is saved.")).toBeVisible();
    await page.unroute("**/actions/verify_credentials");
    const app = await api("GET", `${P}/apps/${playId}`);
    expect(app.body.play_store).toEqual({ package_name: "com.example.scanner", play_service_account_credentials_configured: true });
  });

  let testId = "";
  let testKey = "";
  await test.step("Test Store: create a product inline and send a test purchase", async () => {
    await page.goto(`${base}/apps`);
    await page.getByRole("button", { name: "Create Test Store app" }).click();
    await page.getByRole("dialog", { name: "Add an app" }).getByRole("button", { name: "Add app" }).click();
    await page.waitForURL(/\/apps\/app/);
    testId = page.url().split("/").pop()!;
    await expect(page.getByRole("region", { name: "Nothing to configure" })).toBeVisible();
    await page.getByRole("button", { name: "Create product" }).click();
    await toast("Product pro_monthly created.");
    await page.getByLabel("App user ID").fill("e2e_buyer");
    await page.getByRole("button", { name: "Send a test purchase" }).click();
    await expect(page.getByText(/e2e_buyer bought pro_monthly/)).toBeVisible();
    await shot("test-store-purchase");
    const c = await api("GET", `${P}/customers/e2e_buyer`);
    expect(c.status).toBe(200);
    testKey = (await api("GET", `${P}/apps/${testId}/public_api_keys`)).body.items[0].key;
    // The SDK snippet carries this app's key and the proxy URL.
    await expect(page.locator("#sdk pre")).toContainText(testKey);
    await expect(page.locator("#sdk pre")).toContainText("Purchases.proxyURL");
    await page.getByRole("tab", { name: "Flutter" }).click();
    await expect(page.locator("#sdk pre")).toContainText("await Purchases.setProxyURL(");
  });

  await test.step("apps list: store, ids, masked keys with reveal and copy, setup state", async () => {
    await page.goto(`${base}/apps`);
    await expect(page.getByRole("row")).toHaveCount(4);
    const row = page.getByRole("row", { name: /Test Store/ });
    await expect(row).toContainText("test_••••");
    await row.getByRole("button", { name: "Show public SDK key" }).click();
    await expect(row).toContainText(testKey);
    await row.getByRole("button", { name: "Copy public SDK key" }).click();
    expect(await clipboard()).toBe(testKey);
    // The only App Store notification (the forwarded one above) failed verification, so the app is not Ready: its
    // notifications are failing until one is processed. Google Play has none yet.
    await expect(page.getByRole("row", { name: /Scanner iOS/ })).toContainText("Notifications failing");
    await expect(page.getByRole("row", { name: /Scanner Android/ })).toContainText("Waiting for store notifications");
    await shot("apps-list");
  });

  await test.step("API keys: create a secret key, use it, a scoped key is refused writes, revoke", async () => {
    await page.goto(`${base}/api-keys`);
    await expect(page.getByRole("row")).toHaveCount(4); // header + 3 public keys; no secret keys yet
    await page.getByRole("button", { name: "New secret key" }).click();
    let d = page.getByRole("dialog", { name: "New secret API key" });
    await d.getByRole("button", { name: "Create key" }).click();
    await expect(d.getByText(/Name the key after where it is used/)).toBeVisible();
    await d.getByLabel("Name").fill("E2E full");
    await d.getByRole("button", { name: "Create key" }).click();
    d = page.getByRole("dialog", { name: "Copy your secret key now" });
    const full = (await d.locator(".codeblock pre").first().textContent())!.trim();
    expect(full).toMatch(/^sk_/);
    await shot("secret-key-once");
    await d.getByRole("button", { name: "I have copied it" }).click();
    expect((await api("GET", `${P}/apps`, undefined, { authorization: `Bearer ${full}` })).status).toBe(200);

    await page.getByRole("button", { name: "New secret key" }).click();
    d = page.getByRole("dialog", { name: "New secret API key" });
    await d.getByLabel("Name").fill("Read apps only");
    await d.getByRole("button", { name: "Choose permissions" }).click();
    await d.getByRole("button", { name: "Create key" }).click();
    await expect(d.getByText("Give the key at least one permission.")).toBeVisible();
    await d.getByLabel("Apps access").selectOption("read");
    await shot("secret-key-permissions");
    await d.getByRole("button", { name: "Create key" }).click();
    const scoped = (await page.getByRole("dialog", { name: "Copy your secret key now" }).locator(".codeblock pre").first().textContent())!.trim();
    await page.getByRole("button", { name: "I have copied it" }).click();
    expect((await api("GET", `${P}/apps`, undefined, { authorization: `Bearer ${scoped}` })).status).toBe(200);
    expect((await api("POST", `${P}/apps`, { name: "x", type: "test_store" }, { authorization: `Bearer ${scoped}` })).status).toBe(403);
    await expect(page.getByRole("row", { name: /Read apps only/ })).toContainText("1 permission, read only");

    await page.getByRole("button", { name: "Actions for E2E full" }).click();
    await page.getByRole("menuitem", { name: "Revoke key" }).click();
    await page.getByRole("dialog", { name: "Revoke E2E full?" }).getByRole("button", { name: "Revoke key" }).click();
    await toast(/E2E full revoked/);
    await expect(page.getByRole("row", { name: /E2E full/ })).toHaveCount(0);
    expect((await api("GET", `${P}/apps`, undefined, { authorization: `Bearer ${full}` })).status).toBe(401);
  });

  let hookId = "";
  let secret = "";
  await test.step("webhook: create with an event filter, signing secret shown once", async () => {
    await page.goto(`${base}/integrations`);
    await expect(page.getByRole("button", { name: /Core tools/ })).toContainText("3");
    await page.getByRole("link", { name: /Webhooks/ }).click();
    await expect(page.getByRole("heading", { name: "No webhooks yet" })).toBeVisible();
    await page.getByRole("link", { name: "Add webhook" }).click();
    await page.getByLabel("Name").fill("E2E listener");
    await page.getByLabel("Webhook URL").fill(`http://127.0.0.1:${port}/ok`);
    await page.getByLabel("Authorization header value").fill("Bearer e2e-token");
    await page.getByRole("button", { name: "Only selected events" }).click();
    await page.getByRole("button", { name: "Add webhook" }).click();
    await expect(page.getByText("Pick at least one event, or choose All events.")).toBeVisible();
    await expect(page.locator("#wh-types .check")).toHaveCount(24);
    await page.getByText("INITIAL_PURCHASE", { exact: true }).click();
    await page.getByText("RENEWAL", { exact: true }).click();
    await shot("webhook-form");
    await page.getByRole("button", { name: "Add webhook" }).click();
    const d = page.getByRole("dialog", { name: "Copy the signing secret now" });
    secret = (await d.locator(".codeblock pre").first().textContent())!.trim();
    expect(secret).toMatch(/^whsec_/);
    await shot("webhook-secret");
    await d.getByRole("button", { name: "I have copied it" }).click();
    await page.waitForURL(/\/integrations\/webhooks\/wh_/);
    hookId = page.url().split("/").pop()!;
    const w = await api("GET", `${P}/integrations/webhooks/${hookId}`);
    expect(w.body).toMatchObject({ name: "E2E listener", environment: null, event_types: ["initial_purchase", "renewal"] });
    expect(w.body.signing_secret).toBeUndefined();
  });

  await test.step("send a test event and a real Test Store purchase; both arrive signed", async () => {
    await page.getByRole("button", { name: "Send test event" }).click();
    await toast(/Test event queued/);
    await expect.poll(() => hooks.hits.filter((h) => h.path === "/ok").length, { timeout: 20_000 }).toBe(1);
    const t = hooks.hits.find((h) => h.path === "/ok")!;
    expect(JSON.parse(t.body).event.type).toBe("TEST");
    expect(t.headers.authorization).toBe("Bearer e2e-token");
    expect(verifySig(secret, t.body, String(t.headers["x-revenuecat-webhook-signature"]))).toBe(true);
    await expect(page.getByRole("row", { name: /TEST.*delivered/i })).toBeVisible({ timeout: 15_000 });

    // A purchase through the SDK endpoint with the Test Store key.
    const token = `test_${Date.now()}_${crypto.randomUUID()}`;
    const r = await api("POST", "/v1/receipts", { app_user_id: "e2e_hook_user", fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD" }, { authorization: `Bearer ${testKey}`, "x-platform": "iOS" });
    expect(r.status).toBe(200);
    await expect.poll(() => hooks.hits.filter((h) => h.path === "/ok").length, { timeout: 20_000 }).toBe(2);
    const p = hooks.hits.filter((h) => h.path === "/ok")[1]!;
    expect(JSON.parse(p.body).event).toMatchObject({ type: "INITIAL_PURCHASE", app_user_id: "e2e_hook_user", product_id: "pro_monthly", environment: "SANDBOX", store: "TEST_STORE" });
    expect(verifySig(secret, p.body, String(p.headers["x-revenuecat-webhook-signature"]))).toBe(true);
    await expect(page.getByRole("row", { name: /INITIAL_PURCHASE.*delivered/i })).toBeVisible({ timeout: 25_000 });
    await shot("webhook-deliveries");
  });

  await test.step("a failing endpoint shows the failure; Retry delivers it", async () => {
    await page.goto(`${base}/integrations/webhooks/new`);
    await page.getByLabel("Name").fill("Flaky");
    await page.getByLabel("Webhook URL").fill(`http://127.0.0.1:${port}/flaky`);
    await page.getByRole("button", { name: "Add webhook" }).click();
    await page.getByRole("button", { name: "I have copied it" }).click();
    await page.waitForURL(/\/integrations\/webhooks\/wh_/);
    const flakyId = page.url().split("/").pop()!;
    await page.getByRole("button", { name: "Send test event" }).click();
    const row = page.getByRole("row", { name: /TEST/ });
    await expect(row).toContainText("500", { timeout: 20_000 });
    await expect(row).toContainText("HTTP 500");
    await shot("webhook-failing");
    await page.goto(`${base}/integrations/webhooks`);
    await expect(page.getByRole("row", { name: /Flaky/ })).toContainText("Failing (HTTP 500)", { timeout: 20_000 });
    await page.goto(`${base}/integrations/webhooks/${flakyId}`);
    hooks.heal();
    await page.getByRole("row", { name: /TEST/ }).getByRole("button", { name: "Retry" }).click();
    await toast("Retry queued.");
    await expect(page.getByRole("row", { name: /TEST/ })).toContainText("delivered", { timeout: 20_000 });
    const log = await api("GET", `${P}/webhooks/${flakyId}/deliveries`);
    expect(log.body.items[0]).toMatchObject({ status: "delivered", attempts: 2, response_status: 200 });

    // Edit keeps the secret and filters; delete asks first.
    await page.getByRole("link", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Flaky, fixed");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Webhook saved.");
    await expect(page.getByRole("heading", { name: "Flaky, fixed" })).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete webhook" }).click();
    await page.getByRole("dialog", { name: /Delete Flaky, fixed/ }).getByRole("button", { name: "Delete webhook" }).click();
    await page.waitForURL(/\/integrations\/webhooks$/);
    expect((await api("GET", `${P}/integrations/webhooks/${flakyId}`)).status).toBe(404);
  });

  await test.step("transfer behaviour set in Project settings decides who keeps a restored purchase", async () => {
    const post = (user: string, token: string) => api("POST", "/v1/receipts", { app_user_id: user, fetch_token: token, product_id: "pro_monthly", price: 9.99, currency: "USD" }, { authorization: `Bearer ${testKey}`, "x-platform": "iOS" });
    const t1 = `test_${Date.now()}_${crypto.randomUUID()}`, t2 = `test_${Date.now()}_${crypto.randomUUID()}`;
    expect((await post("alice", t1)).status).toBe(200);
    expect((await post("bob", t1)).status).toBe(200); // default: transfer to the new app user id

    await page.goto(`${base}/settings`);
    await expect(page.locator("#project-id")).toContainText(pid);
    await page.getByLabel("Transferring purchases seen on multiple app user IDs").selectOption("keep");
    await expect(page.getByText(/Restoring on another account fails/)).toBeVisible();
    await shot("settings-general");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Project settings saved.");
    expect((await api("GET", P)).body).toMatchObject({ transfer_behavior: "keep", sandbox_transfer_behavior: null });
    expect((await post("carol", t2)).status).toBe(200);
    const refused = await post("dave", t2);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe(7102);

    // Test Store purchases are sandbox: a separate sandbox behaviour wins for them.
    await page.getByRole("switch", { name: "Use a different behavior for sandbox" }).click();
    await page.getByLabel("Sandbox behavior").selectOption("transfer");
    await page.getByRole("button", { name: "Save changes" }).click();
    await toast("Project settings saved.");
    expect((await api("GET", P)).body).toMatchObject({ transfer_behavior: "keep", sandbox_transfer_behavior: "transfer" });
    expect((await post("dave", t2)).status).toBe(200);
  });

  await test.step("collaborators list the signed-in member; later tabs say so", async () => {
    await page.getByRole("tab", { name: "Collaborators" }).click();
    await expect(page.getByRole("row", { name: new RegExp(`setup-${stamp}@revenuedot.test`) })).toContainText("Admin");
    await page.getByRole("tab", { name: /Audit logs/ }).click();
    await expect(page.getByText(/No changes recorded|Dashboard user/).first()).toBeVisible();
  });

  await test.step("delete an app, then the project, each after confirmation", async () => {
    await page.goto(`${base}/apps/${playId}`);
    await page.getByRole("button", { name: "Delete app" }).click();
    await page.getByRole("dialog", { name: "Delete Scanner Android?" }).getByRole("button", { name: "Delete app" }).click();
    await page.waitForURL(/\/apps$/);
    expect((await api("GET", `${P}/apps/${playId}`)).status).toBe(404);

    await page.goto(`${base}/settings`);
    await page.getByRole("button", { name: "Delete project" }).click();
    const d = page.getByRole("dialog", { name: "Delete Setup e2e?" });
    await expect(d.getByRole("button", { name: "Delete project" })).toBeDisabled();
    await d.getByLabel("Type Setup e2e to confirm").fill("Setup e2e");
    await shot("delete-project");
    await d.getByRole("button", { name: "Delete project" }).click();
    await page.waitForURL(/\/projects\/[^/]+\/overview/);
    expect(page.url()).not.toContain(pid);
    expect((await api("GET", P)).status).toBe(404);
  });

  hooks.server.close();
  // The only console errors allowed are the failed network requests this test causes on purpose.
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
