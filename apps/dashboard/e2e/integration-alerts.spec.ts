/**
 * Integration failure alerts in the browser: the "Integration failures" switch in Account settings → Notifications saves
 * and survives a reload; an integration whose partner answers 400 to 10 test events emails the admin, and the email's
 * link opens the integration page with its failing status and delivery log. The partner is a local server.
 *   pnpm --filter @revenuedot/dashboard e2e -- integration-alerts
 */
import { createServer, type Server } from "node:http";
import { expect, test, type APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** A partner that refuses every request with HTTP 400 (fails at once, no retries). */
async function refusingPartner(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"bad request"}'); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test("integration failures: the notification switch saves, and a failing integration emails a link to its delivery log", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const req = page.request;
  const stamp = Date.now();
  const email = `int-alerts-${stamp}@revenuedot.test`;
  await json(req, "POST", "/auth/signup", { email, password: `e2e-${stamp}-pw`, name: "Integration alerts", project_name: "Integration alerts" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;

  await test.step("the switch is on by default, turns off, survives a reload, and is disabled while alert emails are off", async () => {
    await page.goto("/account/notifications");
    const sw = page.getByRole("switch", { name: "Email me when an integration keeps failing" });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(page.getByRole("status").filter({ hasText: "Integration failure emails are off." })).toBeVisible();
    expect((await json(req, "GET", "/auth/me")).user.integration_alert_emails).toBe(false);
    await page.reload();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect.poll(async () => (await json(req, "GET", "/auth/notifications")).integration_alert_emails).toBe(true);
    await page.getByRole("switch", { name: "Email me about problems with my projects" }).click();
    await expect(sw).toBeDisabled();
    await page.getByRole("switch", { name: "Email me about problems with my projects" }).click();
    await expect(sw).toBeEnabled();
  });

  const partner = await refusingPartner();
  try {
    await test.step("10 failed deliveries email the admin; the link opens the delivery log with the failing status", async () => {
      const P = `/v2/projects/${pid}`;
      const integ = await json(req, "POST", `${P}/integrations/partners`, { type: "appstack", name: "Attribution feed", settings: { webhook_url: `${partner.origin}/hook`, authorization: "Bearer e2e-token-1234" } });
      for (let i = 0; i < 10; i++) await json(req, "POST", `${P}/integrations/partners/${integ.id}/test`, {});
      const mail = async () => (await json<{ subject: string; text: string }[]>(req, "GET", `/__mail?to=${encodeURIComponent(email)}`)).filter((m) => m.subject.includes("Attribution feed"));
      await expect.poll(async () => (await mail()).map((m) => m.subject), { timeout: 60_000 }).toEqual(["Integration Attribution feed (Appstack) is failing"]);
      const m = (await mail())[0]!;
      expect(m.text).toContain("The last 10 deliveries failed, one after the other.");
      const link = /Open the delivery log: (\S+)/.exec(m.text)![1]!;
      expect(link).toContain(`/projects/${pid}/integrations/appstack#deliveries`);
      const u = new URL(link);
      await page.goto(`${u.pathname}${u.hash}`);
      await expect(page.getByText(/Failing · HTTP 400/)).toBeVisible();
      const log = page.locator("#deliveries");
      await expect(log.getByRole("row", { name: /failed/ }).first()).toBeVisible({ timeout: 20_000 });
      await expect(log).toBeInViewport();
    });
  } finally {
    partner.server.close();
  }
  expect(errors).toEqual([]);
});
