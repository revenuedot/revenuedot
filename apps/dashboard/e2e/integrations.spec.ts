/**
 * Integrations and scheduled data exports in the browser: connect Slack and PostHog to a local fake partner, send a
 * test event, see real purchases arrive and the delivery log, turn one off; then an S3 export to a local fake bucket:
 * check the bucket, run it, and read the file back. Then AppsFlyer's web purchase settings and Meta's App Events API, with
 * test events to the fake AppsFlyer and Meta hosts in e2e/server.ts. Signs up its own account; nothing leaves this machine.
 *   E2E_PORT=5392 pnpm --filter @revenuedot/dashboard e2e -- integrations
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Hit { method: string; path: string; headers: IncomingMessage["headers"]; body: Buffer }

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** One local server plays Slack (/slack), PostHog (/i/v0/e/) and an S3-compatible bucket (/e2e-bucket/...). */
async function fakePartners(): Promise<{ server: Server; origin: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url?.startsWith("/slack")) { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
      if (req.url?.startsWith("/i/v0/e")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"Ok"}'); return; }
      res.writeHead(200); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, origin: `http://127.0.0.1:${port}`, hits };
}

test("integrations: Slack and PostHog with test events, real purchases, delivery log and pausing; S3 export", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  const fake = await fakePartners();
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `integrations-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Integrations e2e", project_name: "Integrations e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  await json(req, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_monthly", type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M" } });
  const key = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  const buy = async (user: string) => {
    const r = await req.fetch("/v1/receipts", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, data: { app_user_id: user, fetch_token: `test_${Date.now()}_${user}`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect(r.status()).toBe(200);
  };
  const slackHits = () => fake.hits.filter((h) => h.path === "/slack").map((h) => JSON.parse(h.body.toString()));

  try {
    await test.step("the catalogue shows the live integrations", async () => {
      await page.goto(`/projects/${pid}/integrations`);
      await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
      for (const name of ["Slack", "Segment", "Amplitude", "Mixpanel", "PostHog", "Firebase", "BigQuery", "AppsFlyer", "Adjust", "Meta Ads", "Scheduled Data Exports"]) {
        await expect(page.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
      }
      await expect(page.getByRole("link", { name: /^Slack/ })).toContainText("Set up");
    });

    await test.step("connect Slack, including sandbox events", async () => {
      await page.getByRole("link", { name: /^Slack/ }).click();
      await expect(page.getByRole("heading", { name: "Slack", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Connect Slack" }).click();
      await expect(page.getByRole("alert")).toContainText("Incoming webhook URL is required");
      await page.getByLabel("Incoming webhook URL").fill(`${fake.origin}/slack`);
      await page.getByRole("group", { name: "Environment" }).getByRole("button", { name: "Both" }).click();
      await page.getByRole("button", { name: "Connect Slack" }).click();
      await expect(page.getByText("Slack is connected.")).toBeVisible();
      await expect(page.getByText(/Saved: /)).toBeVisible();
      await expect(page.getByText("Nothing sent yet")).toBeVisible();
    });

    await test.step("send a test event and see it delivered", async () => {
      await page.getByRole("button", { name: "Send test event" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Send test event" }).click();
      await expect.poll(() => slackHits().length, { timeout: 20_000 }).toBe(1);
      expect(slackHits()[0].text).toMatch(/is a test customer: Slack is connected to RevenueDot/);
      await expect(page.getByRole("row", { name: /TEST.*delivered/ })).toBeVisible({ timeout: 20_000 });
      // The Status line follows the delivery log without a reload.
      await expect(page.locator(".kv").filter({ hasText: "Integration ID" })).toContainText(/Delivered \d+s ago/);
    });

    await test.step("a Test Store purchase arrives in Slack, and the log shows the request", async () => {
      await buy("slack_buyer");
      await expect.poll(() => slackHits().length, { timeout: 20_000 }).toBe(2);
      expect(slackHits()[1].text).toBe("Customer slack_buyer started a subscription: pro_monthly ($9.99).");
      await page.getByRole("button", { name: "Refresh deliveries" }).click();
      const row = page.getByRole("row", { name: /INITIAL_PURCHASE.*initial_purchase.*delivered/ });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.getByRole("button", { name: "Details" }).click();
      // The delivery details drawer: the request without the Slack URL (a secret), the attempt and Slack's answer.
      const drawer = page.getByRole("dialog", { name: "Delivery details" });
      await expect(drawer.getByText("POST [redacted]")).toBeVisible();
      await expect(drawer.locator(".tag", { hasText: "HTTP 200" })).toBeVisible();
      await expect(drawer.getByText("Response body (first 4 KB)")).toBeVisible();
      await drawer.getByRole("button", { name: "Done" }).click();
      await expect(drawer).toBeHidden();
    });

    await test.step("turning Slack off stops deliveries", async () => {
      await page.getByRole("switch", { name: "On" }).click();
      await expect(page.getByText("Slack is off. New events are not queued")).toBeVisible();
      await buy("while_off");
      await page.waitForTimeout(6_000);
      expect(slackHits()).toHaveLength(2);
      await expect(page.getByRole("button", { name: "Send test event" }).first()).toBeDisabled();
      const s = (await json(req, "GET", `${P}/integrations/partners`)).items[0];
      expect(s).toMatchObject({ type: "slack", enabled: false, secrets: { webhook_url: { configured: true } } });
      expect(JSON.stringify(s)).not.toContain("/slack");
    });

    await test.step("PostHog on a self-hosted URL with a sandbox key and renamed events", async () => {
      await page.goto(`/projects/${pid}/integrations/posthog`);
      await page.getByLabel("Project API key", { exact: true }).fill("phc_live_e2e");
      await page.getByLabel("Sandbox project API key").fill("phc_sandbox_e2e");
      await page.getByLabel("Region").selectOption("custom");
      await page.getByLabel("PostHog URL").fill(fake.origin);
      await page.getByText("Event names").click();
      await page.getByLabel("Initial purchase").fill("Subscribed");
      await page.getByRole("button", { name: "Connect PostHog" }).click();
      await expect(page.getByText("PostHog is connected.")).toBeVisible();
      await buy("posthog_buyer");
      await expect.poll(() => fake.hits.filter((h) => h.path === "/i/v0/e/").length, { timeout: 20_000 }).toBe(1);
      const ev = JSON.parse(fake.hits.find((h) => h.path === "/i/v0/e/")!.body.toString());
      expect(ev).toMatchObject({ api_key: "phc_sandbox_e2e", event: "Subscribed", distinct_id: "posthog_buyer", properties: { environment: "SANDBOX", rc_subscription_status: "active" } });
      // The delivery log of a new integration with no rows polls every 15 seconds; waiting for that poll left 5 seconds
      // of a 20-second timeout and failed on a busy machine. Refresh, like a user would (pending rows poll every 2 seconds).
      await page.getByRole("button", { name: "Refresh deliveries" }).click();
      await expect(page.getByRole("row", { name: /INITIAL_PURCHASE.*Subscribed.*delivered/ })).toBeVisible({ timeout: 20_000 });
      await page.goto(`/projects/${pid}/integrations`);
      await expect(page.getByRole("link", { name: /^PostHog/ })).toContainText("Active · 1");
    });

    await test.step("an S3-compatible export: create, check the bucket, run it, read the file", async () => {
      await page.getByRole("link", { name: /^Scheduled Data Exports/ }).click();
      await expect(page.getByText("No data exports yet")).toBeVisible();
      await page.getByRole("link", { name: "New export" }).first().click();
      await page.getByLabel("Name", { exact: true }).fill("Warehouse");
      await page.getByLabel("Bucket", { exact: true }).fill("e2e-bucket");
      await page.getByLabel("Path prefix").fill("rd");
      await page.getByLabel("Endpoint").fill(fake.origin);
      await page.getByLabel("Access key ID").fill("AKIAE2E");
      await page.getByRole("button", { name: "Create export" }).click();
      await expect(page.getByRole("alert")).toContainText("secret access key");
      await page.getByLabel("Secret access key").fill("e2e-secret-key");
      await page.getByRole("button", { name: "Create export" }).click();
      await expect(page.getByRole("heading", { name: "Warehouse" })).toBeVisible();
      await page.getByRole("button", { name: "Check bucket" }).click();
      await expect(page.getByText("RevenueDot can reach the bucket e2e-bucket.")).toBeVisible();
      expect(fake.hits.some((h) => h.method === "HEAD" && h.path === "/e2e-bucket")).toBe(true);
      await page.getByRole("button", { name: "Run now" }).click();
      await expect(page.getByRole("row", { name: /succeeded/ })).toBeVisible({ timeout: 30_000 });
      const put = fake.hits.find((h) => h.method === "PUT" && h.path.startsWith("/e2e-bucket/rd/"))!;
      expect(put.path).toMatch(/^\/e2e-bucket\/rd\/\d{4}-\d{2}-\d{2}\/transactions_\d{8}T\d{6}Z\.csv\.gz$/);
      expect(String(put.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAE2E\//);
      const csv = gunzipSync(put.body).toString();
      expect(csv.split("\r\n")[0]).toMatch(/^rc_original_app_user_id,rc_last_seen_app_user_id_alias,country,/);
      expect(csv).toContain("slack_buyer");
      await expect(page.getByText(/transactions_\d{8}T\d{6}Z\.csv\.gz · 3 rows/)).toBeVisible();
      await page.goto(`/projects/${pid}/integrations/exports`);
      await expect(page.getByRole("row", { name: /Warehouse.*Amazon S3.*transactions/ })).toBeVisible();
    });

    await test.step("phone width", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/projects/${pid}/integrations/slack`);
      await expect(page.getByRole("heading", { name: "Slack", exact: true })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    expect(errors.filter((e) => !/status of (400|409|422)/.test(e))).toEqual([]);
  } finally {
    fake.server.close();
  }
});

test("attribution: AppsFlyer web routing fields and Meta's App Events API, each with a test event to a fake partner", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `attribution-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Attribution e2e", project_name: "Attribution e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  await json(req, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_monthly", type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M" } });
  const key = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  // A customer on iOS with the ids AppsFlyer and Meta match on, made before either integration exists.
  const user = `attr_${stamp}`;
  const attrs = { $appsflyerId: "1700000000000-4242", $fbAnonId: "XZfbanon", $attConsentStatus: "authorized", $ip: "203.0.113.50" };
  const r = await req.fetch("/v1/receipts", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-platform": "iOS" },
    data: { app_user_id: user, fetch_token: `test_${stamp}_${user}`, product_id: "pro_monthly", price: 9.99, currency: "USD", attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v, updated_at_ms: stamp }])) },
  });
  expect(r.status()).toBe(200);
  const hits = async (host: string) => (await json<{ url: string; headers: Record<string, string>; body: string }[]>(req, "GET", `/__partners?host=${host}`));
  const sendTest = async () => {
    await page.getByRole("button", { name: "Send test event" }).click();
    await page.getByLabel("App user ID (optional)").fill(user);
    await page.getByRole("dialog").getByRole("button", { name: "Send test event" }).click();
  };

  await test.step("AppsFlyer shows the web purchase settings; a test event reaches the mobile API", async () => {
    await page.goto(`/projects/${pid}/integrations/appsflyer`);
    await expect(page.getByRole("heading", { name: "AppsFlyer", exact: true })).toBeVisible();
    for (const label of ["Web SDK ID", "Web S2S API token", "Web (PBA) bundle ID", "Web (PBA) dev key"]) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    const routing = page.getByLabel("Web store event routing");
    await expect(routing).toHaveValue("mobile_s2s");
    await page.getByLabel("Developer key", { exact: true }).fill("af_dev_key_e2e");
    await page.getByLabel("iOS app ID").fill("id123456789");
    await page.getByLabel("Web SDK ID", { exact: true }).fill("web-sdk-e2e");
    await page.getByLabel("Web S2S API token", { exact: true }).fill("af_web_token_e2e");
    await routing.selectOption("web_s2s");
    await page.getByRole("button", { name: "Connect AppsFlyer" }).click();
    await expect(page.getByText("AppsFlyer is connected.")).toBeVisible();
    const saved = (await json(req, "GET", `${P}/integrations/partners`)).items.find((x: any) => x.type === "appsflyer");
    expect(saved).toMatchObject({ settings: { web_app_id: "web-sdk-e2e", web_routing: "web_s2s" }, secrets: { web_s2s_token: { configured: true } } });
    await page.reload();
    await expect(page.getByLabel("Web store event routing")).toHaveValue("web_s2s");
    await sendTest();
    await expect.poll(async () => (await hits("api2.appsflyer.com")).length, { timeout: 20_000 }).toBe(1);
    const [hit] = await hits("api2.appsflyer.com");
    expect(hit!.url).toBe("https://api2.appsflyer.com/inappevent/id123456789");
    expect(JSON.parse(hit!.body)).toMatchObject({ appsflyer_id: "1700000000000-4242", customer_user_id: user, eventName: "rc_test_event" });
    await page.getByRole("button", { name: "Refresh deliveries" }).click();
    await expect(page.getByRole("row", { name: /TEST.*delivered/ })).toBeVisible({ timeout: 20_000 });
  });

  await test.step("Meta switches between the Conversions API and the App Events API fields", async () => {
    await page.goto(`/projects/${pid}/integrations/meta`);
    await expect(page.getByRole("heading", { name: "Meta Ads", exact: true })).toBeVisible();
    const type = page.getByLabel("Integration type");
    await expect(type).toHaveValue("conversions");
    await expect(page.getByLabel("Dataset ID", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Meta app ID")).toHaveCount(0);
    await type.selectOption("app_events");
    await expect(page.getByLabel("Dataset ID", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Send iOS events without ATT consent")).toHaveCount(0);
    for (const label of ["Meta app ID", "Client token", "Sandbox app ID", "Sandbox client token"]) await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Connect Meta Ads" }).click();
    await expect(page.getByRole("alert")).toContainText("Client token is required");
    await page.getByLabel("Meta app ID", { exact: true }).fill("111222333");
    await page.getByLabel("Client token", { exact: true }).fill("ct_live_e2e");
    await page.getByLabel("Sandbox app ID", { exact: true }).fill("444555666");
    await page.getByLabel("Sandbox client token", { exact: true }).fill("ct_sandbox_e2e");
    // The App Events API has no test mode: test events go to the sandbox app only.
    await page.getByRole("group", { name: "Environment" }).getByRole("button", { name: "Sandbox" }).click();
    await page.getByRole("button", { name: "Connect Meta Ads" }).click();
    await expect(page.getByText("Meta Ads is connected.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Integration type")).toHaveValue("app_events");
    await expect(page.getByLabel("Meta app ID", { exact: true })).toHaveValue("111222333");
  });

  await test.step("a Meta test event goes to the sandbox app's activities with X-Forwarded-For, and the log hides the token", async () => {
    await sendTest();
    await expect.poll(async () => (await hits("graph.facebook.com")).length, { timeout: 20_000 }).toBe(1);
    const [hit] = await hits("graph.facebook.com");
    expect(hit!.url).toBe("https://graph.facebook.com/v21.0/444555666/activities");
    expect(hit!.headers["x-forwarded-for"]).toBe("203.0.113.50");
    expect(JSON.parse(hit!.body)).toMatchObject({ event: "CUSTOM_APP_EVENTS", client_token: "ct_sandbox_e2e", anon_id: "XZfbanon", app_user_id: user, custom_events: [{ _eventName: "Subscribe" }] });
    await page.getByRole("button", { name: "Refresh deliveries" }).click();
    const row = page.getByRole("row", { name: /TEST.*Subscribe.*delivered/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button", { name: "Details" }).click();
    const drawer = page.getByRole("dialog", { name: "Delivery details" });
    await expect(drawer.getByText("POST https://graph.facebook.com/v21.0/444555666/activities")).toBeVisible();
    await expect(drawer).toContainText(/"client_token": ?"\[redacted\]"/);
    await expect(drawer).not.toContainText("ct_sandbox_e2e");
  });

  expect(errors.filter((e) => !/status of (400|409|422)/.test(e))).toEqual([]);
});
