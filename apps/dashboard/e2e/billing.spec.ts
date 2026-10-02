/**
 * Billing in the browser (prd/cloud-billing/PRD.md), on the e2e Cloud server (E2E_PORT + 1, e2e/cloud-server.ts) with a
 * fake of RevenueDot's own Stripe account: Free with tracked revenue over the limit (banner, the usage email, what
 * Standard would cost), Upgrade through the fake Checkout page and the signed webhooks, the bill and the meter event,
 * Manage billing through the fake Customer Portal (cancel at period end), a failed payment (banner on every page, the
 * email) and its recovery, and the self-hosted server saying billing is Cloud only.
 *   E2E_PORT=5413 pnpm --filter @revenuedot/dashboard e2e -- billing
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 5199);
const CLOUD = `http://localhost:${PORT + 1}`;
const stamp = Date.now();
const user = { email: `billing-${stamp}@revenuedot.test`, password: `e2e-${stamp}-bl` };

async function json<T = any>(req: APIRequestContext, method: string, url: string, data?: unknown): Promise<T> {
  const res = await req.fetch(url, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
async function fits(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} fits 390px`).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
}
const mails = async (req: APIRequestContext) => (await json<{ subject: string; text: string }[]>(req, "GET", `${CLOUD}/__mail?to=${encodeURIComponent(user.email)}`)).map((m) => m.subject);

test.use({ baseURL: CLOUD });

test("Free over the limit, then Upgrade to Standard through Checkout: the plan, the bill and the meter", async ({ page }) => {
  const errors = watch(page);
  await json(page.request, "POST", "/auth/signup", { ...user, name: "Bill Payer", project_name: "Paid app" });
  await page.goto("/account/billing");
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  const plan = page.locator("[data-plan=free]");
  await expect(plan.getByText("Current")).toBeVisible();
  await expect(page.locator("[data-tracked]")).toHaveText("$0.00");
  // $12,000 of production revenue this month, metered.
  await json(page.request, "POST", "/__billing/revenue", { email: user.email, usd: 12_000 });
  await json(page.request, "POST", "/__billing/meter", {});
  await page.reload();
  await expect(page.locator("[data-tracked]")).toHaveText("$12,000.00");
  await expect(page.getByRole("status").filter({ hasText: "above Cloud Free's $10,000" })).toContainText("$10.00 this month so far");
  await expect(page.getByRole("meter", { name: "Tracked revenue against the plan's limit" })).toHaveAttribute("aria-valuenow", "12000");
  await expect(page.getByRole("row", { name: /Paid app 1 \$12,000\.00/ })).toBeVisible();
  expect(await mails(page.request)).toContain(`Your apps passed RevenueDot Cloud Free's $10,000 for ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}`);
  await fits(page, "billing-free");

  // Upgrade: Stripe Checkout (the fake page), then back with the plan changed by the webhook.
  await page.getByRole("button", { name: "Upgrade to Standard" }).click();
  await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page).toHaveURL(/\/account\/billing\?checkout=success/);
  await expect(page.locator("[data-plan=standard]").getByText("Current")).toBeVisible();
  await expect(page.locator("[data-bill]")).toHaveText("$10.00");
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  const b = await json(page.request, "GET", "/v2/billing");
  expect(b.account).toMatchObject({ plan: "standard", status: "active", has_payment_method: true });
  expect((await json(page.request, "GET", "/auth/me")).account).toMatchObject({ plan: "standard", billing_status: "active" });
  // The meter receives the month's bill in cents.
  const meter = await json(page.request, "POST", "/__billing/meter", {});
  expect(meter.meter.at(-1).payload.value).toBe("1000");
  expect(errors).toEqual([]);
});

test("Manage billing opens the Customer Portal; cancelling shows the end date; a failed payment warns everywhere until paid", async ({ page }) => {
  const errors = watch(page);
  await json(page.request, "POST", "/auth/login", user);
  await page.goto("/account/billing");
  await page.locator("[data-plan=standard]").getByRole("button", { name: "Manage billing" }).click();
  await expect(page.getByRole("heading", { name: "Fake Stripe Customer Portal" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel plan" }).click();
  await expect(page).toHaveURL(/\/account\/billing$/);
  await expect(page.getByText(/^ Ends /)).toBeVisible();

  await json(page.request, "POST", "/__billing/invoice", { email: user.email, outcome: "failed" });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Your last payment failed" })).toBeVisible();
  await expect(page.getByText("Payment failed", { exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /Open \$12\.50/ })).toBeVisible();
  expect(await mails(page.request)).toContain("Your RevenueDot payment failed");
  // Every page shows it, with the way to fix it; the project itself keeps working.
  const pid = (await json(page.request, "GET", "/auth/me")).projects[0].id;
  await page.goto(`/projects/${pid}/overview`);
  await expect(page.locator(".verify-banner").filter({ hasText: "A RevenueDot payment failed" })).toBeVisible();
  await page.locator(".verify-banner").getByRole("link", { name: "Open billing" }).click();
  await expect(page).toHaveURL(/\/account\/billing/);
  await json(page.request, "POST", "/__billing/invoice", { email: user.email, outcome: "paid" });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Your last payment failed" })).toHaveCount(0);
  expect(await mails(page.request)).toContain("Your RevenueDot payment went through");
  await fits(page, "billing-standard");
  expect(errors).toEqual([]);
});

test("a self-hosted server has no billing", async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/login`);
  await json(page.request, "POST", `http://localhost:${PORT}/auth/signup`, { email: `selfhost-bill-${stamp}@revenuedot.test`, password: user.password, name: "Self", project_name: "Self-hosted" });
  await page.goto(`http://localhost:${PORT}/account/billing`);
  await expect(page.getByText("Billing is only on RevenueDot Cloud. This server is self-hosted: free and unmetered, with no limits.")).toBeVisible();
  expect((await page.request.get(`http://localhost:${PORT}/v2/billing`)).status()).toBe(404);
});
