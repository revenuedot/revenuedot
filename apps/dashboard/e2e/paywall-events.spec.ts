/**
 * Paywall events to an analytics integration in the browser: connect PostHog to a local fake partner, tick "Send paywall
 * events", post a paywall_impression through the SDK endpoint with the app's public key, and see it in PostHog and in
 * the delivery log. Signs up its own account; nothing leaves this machine.
 *   E2E_PORT=5393 pnpm --filter @revenuedot/dashboard e2e -- paywall-events
 */
import { createServer, type Server } from "node:http";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** A local PostHog capture endpoint (/i/v0/e/) that records what it receives. */
async function fakePostHog(): Promise<{ server: Server; origin: string; events: any[] }> {
  const events: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url?.startsWith("/i/v0/e")) events.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"Ok"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, events };
}

test("paywall events: opt PostHog in, post a paywall impression from the SDK, see the delivery", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const fake = await fakePostHog();
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `paywall-events-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Paywall events e2e", project_name: "Paywall events e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const key = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;

  try {
    await test.step("connect PostHog and tick Send paywall events", async () => {
      await page.goto(`/projects/${pid}/integrations/posthog`);
      await page.getByLabel("Project API key", { exact: true }).fill("phc_live_e2e");
      await page.getByLabel("Sandbox project API key").fill("phc_sandbox_e2e");
      await page.getByLabel("Region").selectOption("custom");
      await page.getByLabel("PostHog URL").fill(fake.origin);
      const group = page.getByRole("group", { name: "Paywall events" });
      await group.getByLabel("Send paywall events").check();
      // RevenueCat's five are on; the two RevenueDot additions stay off until ticked.
      await expect(group.getByLabel("Paywall shown")).toBeChecked();
      await expect(group.getByLabel("Paywall purchase failed")).not.toBeChecked();
      await expect(group.getByText("paywall_impression", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Connect PostHog" }).click();
      await expect(page.getByText("PostHog is connected.")).toBeVisible();
      const saved = (await json(req, "GET", `${P}/integrations/partners`)).items[0];
      expect(saved.event_types.sort()).toEqual(["paywall_cancel", "paywall_close", "paywall_component_interacted", "paywall_exit_offer", "paywall_impression"]);
    });

    await test.step("the SDK posts a paywall impression; PostHog gets it and the log shows it", async () => {
      const r = await req.fetch("/v1/events", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, data: { events: [{
        id: `e2e-${stamp}`, version: 1, type: "paywall_impression", app_user_id: "paywall_viewer", paywall_id: "pw_e2e", session_id: "S-e2e", offering_id: "default",
        paywall_revision: 1, timestamp: Date.now() - 1000, display_mode: "full_screen", dark_mode: false, locale: "en_US",
      }] } });
      expect(r.status()).toBe(200);
      await expect.poll(() => fake.events.length, { timeout: 20_000 }).toBe(1);
      expect(fake.events[0]).toMatchObject({ api_key: "phc_sandbox_e2e", event: "paywall_impression", distinct_id: "paywall_viewer",
        properties: { paywall_id: "pw_e2e", session_id: "S-e2e", offering_id: "default", environment: "SANDBOX", store: "TEST_STORE" } });
      expect(fake.events[0].properties).not.toHaveProperty("revenue");
      await page.getByRole("button", { name: "Refresh deliveries" }).click();
      await expect(page.getByRole("row", { name: /PAYWALL_IMPRESSION.*paywall_impression.*delivered/ })).toBeVisible({ timeout: 20_000 });
    });
    expect(errors).toEqual([]);
  } finally {
    fake.server.close();
  }
});
