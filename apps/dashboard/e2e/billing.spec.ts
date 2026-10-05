/**
 * Billing in the browser (prd/cloud-billing/PRD.md), on the e2e Cloud server (E2E_PORT + 1, e2e/cloud-server.ts) with a
 * fake of RevenueDot's own Stripe account. Building: the Billing page says building is free and offers Start Pro; the
 * first live sale starts the 14 days (grace banner on every page, the email); Start Pro from the banner through the fake
 * Checkout page and the signed webhooks; Pro with this month's bill, the meter event and Manage billing through the fake
 * Customer Portal (cancel at period end); a failed payment (banner on every page, the email) and its recovery. Paused:
 * the red banner, the plan-required panel on Overview and Customers while their Sandbox views keep working, a held webhook
 * delivery, a paywall edit refused with the Start Pro dialog, and Start Pro from the panel reaching Checkout. The
 * self-hosted server says billing is Cloud only.
 *   E2E_PORT=5413 pnpm --filter @revenuedot/dashboard e2e -- billing
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 5199);
const CLOUD = `http://localhost:${PORT + 1}`;
const stamp = Date.now();
const user = { email: `billing-${stamp}@revenuedot.test`, password: `e2e-${stamp}-bl` };
const paused = { email: `paused-${stamp}@revenuedot.test`, password: `e2e-${stamp}-ps` };

async function json<T = any>(req: APIRequestContext, method: string, url: string, data?: unknown): Promise<T> {
  const res = await req.fetch(url, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
/** Console errors, except the 402s the go-live gate answers on purpose (the browser logs each refused request). */
function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
async function fits(page: Page, name: string) {
  // SHOTS=<dir> also saves the page at desktop width (README and docs screenshots).
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} fits 390px`).toBe(true);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
}
const mails = async (req: APIRequestContext, email = user.email) => (await json<{ subject: string; text: string }[]>(req, "GET", `${CLOUD}/__mail?to=${encodeURIComponent(email)}`)).map((m) => m.subject);

test.use({ baseURL: CLOUD });

test("building, then live with 14 days, then Start Pro from the banner through Checkout: the plan, the bill and the meter", async ({ page }) => {
  const errors = watch(page);
  await json(page.request, "POST", "/auth/signup", { ...user, name: "Bill Payer", project_name: "Paid app" });
  await page.goto("/account/billing");
  await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
  // Building: free, no card, and the way to start Pro with its price.
  const state = page.locator("[data-stage]");
  await expect(state).toHaveAttribute("data-stage", "building");
  await expect(state.getByRole("heading", { name: "Building and testing are free" })).toBeVisible();
  await expect(state).toContainText("Start Pro before you release your app: it costs $0 until your apps make $10,000 a month.");
  await expect(state.getByRole("button", { name: "Start Pro" })).toBeVisible();
  await expect(state.getByText("$0 today. Card required.")).toBeVisible();
  await expect(page.locator("[data-tracked]")).toHaveText("$0.00");
  const pro = page.locator("[data-plan=pro]");
  await expect(pro.getByText("Start for free")).toBeVisible();
  await expect(pro).toContainText("$0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month.");
  await expect(page.locator("[data-plan=enterprise]").getByRole("link", { name: "Contact sales" })).toHaveAttribute("href", "https://revenuedot.app/contact-sales");
  await expect(page.locator("[data-account-project]")).toContainText("No plan");
  // No banner while building, and no plan-only words anywhere.
  const pid = (await json(page.request, "GET", "/auth/me")).projects[0].id;
  await page.goto(`/projects/${pid}/overview`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".gate-banner")).toHaveCount(0);
  await page.goto("/account/billing");
  const body = await page.locator("body").innerText();
  for (const banned of ["Cloud Free", "Cloud Standard", "Standard", "free plan", "self-host", "Self-host"]) expect(body, banned).not.toContain(banned);
  await fits(page, "billing-building");

  // $12,000 of production revenue this month: the billing pass marks the account live, with 14 days to start Pro.
  await json(page.request, "POST", "/__billing/revenue", { email: user.email, usd: 12_000 });
  await json(page.request, "POST", "/__billing/meter", {});
  await page.reload();
  await expect(state).toHaveAttribute("data-stage", "grace");
  await expect(state.getByRole("heading", { name: "Your app is live" })).toBeVisible();
  await expect(state).toContainText(/Start Pro by \w{3} \d{1,2}, \d{4} to keep live charts, customer data and webhooks running/);
  await expect(state).toContainText(/1[34] days left/);
  await expect(page.locator("[data-tracked]")).toHaveText("$12,000.00");
  await expect(page.locator("[data-bill]")).toHaveText("$10.00");
  await expect(page.getByRole("meter", { name: /Tracked revenue against the \$10,000 that costs nothing/ })).toHaveAttribute("aria-valuenow", "12000");
  await expect(page.getByRole("row", { name: /Paid app 1 \$12,000\.00/ })).toBeVisible();
  expect(await mails(page.request)).toContain("RevenueDot recorded your first live sale");
  await fits(page, "billing-grace");

  // Every page shows the date, with Start Pro; it goes straight to Stripe Checkout.
  await page.goto(`/projects/${pid}/overview`);
  const banner = page.locator(".gate-banner[data-gate=grace]");
  await expect(banner).toContainText("Your app is live. Start Pro by");
  await banner.getByRole("button", { name: "Start Pro" }).click();
  await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
  await expect(page.getByText("RevenueDot Pro, billed monthly by usage. $0 today.")).toBeVisible();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page).toHaveURL(/\/account\/billing\?checkout=success/);
  await expect(state).toHaveAttribute("data-stage", "pro");
  await expect(state.getByRole("heading", { name: "You are on Pro" })).toBeVisible();
  await expect(pro.getByText("Current")).toBeVisible();
  await expect(page.locator("[data-bill]")).toHaveText("$10.00");
  await expect(state.getByText("Active", { exact: true })).toBeVisible();
  await expect(state).toContainText("0.5% of the $2,000.00 above $10,000: $10.00 so far.");
  const b = await json(page.request, "GET", "/v2/billing");
  expect(b.account).toMatchObject({ plan: "pro", status: "active", has_payment_method: true });
  expect(b.gate.stage).toBe("active");
  expect((await json(page.request, "GET", "/auth/me")).account).toMatchObject({ plan: "pro", billing_status: "active" });
  // The meter receives the month's bill in cents.
  const meter = await json(page.request, "POST", "/__billing/meter", {});
  expect(meter.meter.at(-1).payload.value).toBe("1000");
  // Pro: the banner is gone.
  await page.goto(`/projects/${pid}/overview`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.locator(".gate-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Manage billing opens the Customer Portal; cancelling shows the end date; a failed payment warns everywhere until paid", async ({ page }) => {
  const errors = watch(page);
  await json(page.request, "POST", "/auth/login", user);
  await page.goto("/account/billing");
  await page.locator("[data-stage=pro]").getByRole("button", { name: "Manage billing" }).click();
  await expect(page.getByRole("heading", { name: "Fake Stripe Customer Portal" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel plan" }).click();
  await expect(page).toHaveURL(/\/account\/billing$/);
  await expect(page.getByText(/^ Ends /)).toBeVisible();

  await json(page.request, "POST", "/__billing/invoice", { email: user.email, outcome: "failed" });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Your last payment failed" })).toBeVisible();
  await expect(page.locator("[data-stage=pro]").getByText("Payment failed", { exact: true })).toBeVisible();
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
  await fits(page, "billing-pro");
  expect(errors).toEqual([]);
});

test("paused: the red banner, the plan-required panel with the Sandbox views still open, a held webhook, a refused paywall edit, Start Pro", async ({ page }) => {
  const errors = watch(page);
  await json(page.request, "POST", "/auth/signup", { ...paused, name: "Paula Paused", project_name: "Paused app" });
  await json(page.request, "POST", "/__billing/gate", { email: paused.email, stage: "paused" });
  const me = await json(page.request, "GET", "/auth/me");
  const pid: string = me.projects[0].id;
  expect(me.account.gate.stage).toBe("paused");
  expect(me.account.project_gates[pid]).toMatchObject({ stage: "paused", owner_is_you: true });

  await page.goto("/account/billing");
  const state = page.locator("[data-stage]");
  await expect(state).toHaveAttribute("data-stage", "paused");
  await expect(state.getByRole("heading", { name: "Live data and webhooks are paused" })).toBeVisible();
  await expect(state).toContainText("Your app still works and every purchase still unlocks.");
  await fits(page, "billing-paused");

  // Overview: the red banner and the panel instead of live numbers; the head's Sandbox switch still works.
  await page.goto(`/projects/${pid}/overview`);
  const banner = page.locator(".gate-banner[data-gate=paused]");
  await expect(banner).toContainText("Live data and webhooks are paused.");
  await expect(banner.getByRole("button", { name: "Start Pro" })).toBeVisible();
  const panel = page.locator("[data-plan-required]");
  await expect(panel.getByRole("heading", { name: "Start Pro to see your live data" })).toBeVisible();
  await expect(panel).toContainText("Your app keeps working and every purchase still unlocks. Pro costs $0 until your apps make $10,000 a month.");
  await expect(panel.getByText("$0 today. Card required.")).toBeVisible();
  await expect(page.getByText("Active trials", { exact: true })).toBeHidden();
  await fits(page, "overview-paused");
  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await expect(page).toHaveURL(/environment=sandbox/);
  await expect(panel).toHaveCount(0);
  await expect(page.getByText("Active trials", { exact: true })).toBeVisible();
  await expect(banner).toBeVisible();
  // Back to production: the panel again; its own "Show sandbox data" does the same.
  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Show sandbox data" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByText("Active trials", { exact: true })).toBeVisible();

  // Customers: the list needs Pro, the Sandbox list does not (it asks with environment=sandbox).
  await page.goto(`/projects/${pid}/customers`);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Show sandbox data" }).click();
  await expect(page).toHaveURL(/list=sandbox/);
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();

  // A production delivery held by the gate: "Held", sent when Pro starts, and no Retry.
  const hook = await json(page.request, "POST", `/v2/projects/${pid}/integrations/webhooks`, { name: "Backend", url: "http://localhost:9/hook" });
  await json(page.request, "POST", "/__billing/held", { email: paused.email });
  await page.goto(`/projects/${pid}/integrations/webhooks/${hook.id}`);
  const row = page.getByRole("row").filter({ hasText: "INITIAL_PURCHASE" });
  await expect(row.getByText("Held", { exact: true })).toBeVisible();
  await expect(row.getByText("Sent when Pro starts")).toBeVisible();
  await expect(row.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Editing a paywall answers 402: the dialog says why and offers Pro.
  await json(page.request, "POST", `/v2/projects/${pid}/offerings`, { lookup_key: "default", display_name: "Default" });
  await page.goto(`/projects/${pid}/paywalls`);
  await page.getByRole("button", { name: "Create paywall" }).click();
  await page.getByRole("dialog", { name: "New paywall" }).getByRole("button", { name: "Create" }).click();
  const dialog = page.getByRole("dialog", { name: "Start Pro to keep editing" });
  await expect(dialog).toContainText("Paywalls, experiments and targeting that are live keep serving. Changing them needs Pro.");
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toHaveCount(0);

  // Start Pro from the panel goes straight to Checkout.
  await page.goto(`/projects/${pid}/charts/revenue`);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Start Pro" }).click();
  await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page).toHaveURL(/\/account\/billing\?checkout=success/);
  await expect(state).toHaveAttribute("data-stage", "pro");
  await page.goto(`/projects/${pid}/overview`);
  await expect(page.getByText("Active trials", { exact: true })).toBeVisible();
  await expect(page.locator("[data-plan-required]")).toHaveCount(0);
  await expect(page.locator(".gate-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a self-hosted server has no billing", async ({ page }) => {
  await page.goto(`http://localhost:${PORT}/login`);
  await json(page.request, "POST", `http://localhost:${PORT}/auth/signup`, { email: `selfhost-bill-${stamp}@revenuedot.test`, password: user.password, name: "Self", project_name: "Self-hosted" });
  await page.goto(`http://localhost:${PORT}/account/billing`);
  await expect(page.getByText("Billing is only on RevenueDot Cloud. This server is self-hosted, so it has no billing.")).toBeVisible();
  expect((await page.request.get(`http://localhost:${PORT}/v2/billing`)).status()).toBe(404);
});
