/**
 * DataFast in the browser (docs/analytics.md), on the e2e Cloud server (E2E_PORT + 1) with the fake Stripe. The tracker script only
 * loads on app.revenuedot.app, so each page gets a stand-in `window.datafast` that records every call, and the visitor and session
 * cookies the real script would have set. Checks: signing up records signup_completed and identifies the user by email; creating
 * a project records project_created; Upgrade records checkout_started and puts the visitor and session ids on the Stripe session
 * (the metadata DataFast reads to attribute the payment); returning from Checkout records checkout_returned; nothing carries a
 * project name or a password.
 *   E2E_PORT=5413 pnpm --filter @revenuedot/dashboard e2e -- analytics
 */
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PORT = Number(process.env.E2E_PORT ?? 5199);
const CLOUD = `http://localhost:${PORT + 1}`;
const stamp = Date.now();
const user = { name: "Ada Analytics", email: `analytics-${stamp}@revenuedot.test`, password: `e2e-${stamp}-an`, project: "Secret Project Name" };
const VISITOR = "a3ab2331-989f-4cfa-91c6-2461c9e3c6bd";
const VISIT = "0f2c5d7e-1b4a-4c1e-9d3f-7a6b5c4d3e2f";

test.use({ baseURL: CLOUD });

test("sign up, create a project and upgrade: goals, the user profile and the Stripe metadata", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await context.addCookies([
    { name: "datafast_visitor_id", value: VISITOR, url: CLOUD },
    { name: "datafast_session_id", value: VISIT, url: CLOUD },
  ]);
  // Survives full page loads (the Checkout round trip) by keeping the calls in sessionStorage.
  await page.addInitScript(() => {
    (window as unknown as { __rdAnalyticsTest: boolean }).__rdAnalyticsTest = true;
    const read = () => { try { return JSON.parse(sessionStorage.getItem("__df") ?? "[]"); } catch { return []; } };
    (window as unknown as { datafast: (...a: unknown[]) => void }).datafast = (...a: unknown[]) => { const c = read(); c.push(a); sessionStorage.setItem("__df", JSON.stringify(c)); };
  });
  const calls = async () => (await page.evaluate(() => JSON.parse(sessionStorage.getItem("__df") ?? "[]"))) as unknown[][];
  const names = async () => (await calls()).map((c) => c[0]);

  await page.goto("/signup");
  // Only app.revenuedot.app loads the script: a self-hosted or local dashboard never does.
  await expect(page.locator('script[src*="datafa.st"]')).toHaveCount(0);
  await page.getByLabel("Your name").fill(user.name);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByLabel("First project").fill(user.project);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/overview/);
  await expect.poll(names).toEqual(expect.arrayContaining(["signup_completed", "identify"]));
  const identify = (await calls()).find((c) => c[0] === "identify")![1] as Record<string, string>;
  expect(identify).toMatchObject({ user_id: user.email, name: user.name, plan: "free", projects: "1", email_verified: "false" });

  await page.goto("/projects/new");
  await page.getByLabel("Project name").fill("Second app");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/overview/);
  await expect.poll(names).toContain("project_created");

  await page.goto("/account/billing");
  await page.getByRole("button", { name: "Upgrade to Standard" }).click();
  await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
  const sent = JSON.parse(await page.locator("[data-session-metadata]").innerText()) as { metadata: Record<string, string>; subscription: Record<string, string> };
  expect(sent.metadata).toMatchObject({ plan: "standard", datafast_visitor_id: VISITOR, datafast_session_id: VISIT });
  expect(sent.subscription).toMatchObject({ datafast_visitor_id: VISITOR, datafast_session_id: VISIT });
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page).toHaveURL(/\/account\/billing\?checkout=success/);
  await expect.poll(names).toEqual(expect.arrayContaining(["checkout_started", "checkout_returned"]));
  const returned = (await calls()).find((c) => c[0] === "checkout_returned")![1];
  expect(returned).toEqual({ result: "success" });
  // The plan change reaches the profile.
  await expect(page.locator("[data-plan=standard]").getByText("Current")).toBeVisible();
  await expect.poll(async () => (await calls()).filter((c) => c[0] === "identify").map((c) => (c[1] as Record<string, string>).plan)).toContain("standard");

  const all = JSON.stringify(await calls());
  expect(all).not.toContain(user.project);
  expect(all).not.toContain("Second app");
  expect(all).not.toContain(user.password);
  expect(errors).toEqual([]);
});
