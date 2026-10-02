/**
 * Sign-up pages when a self-hosted server takes only its owner's account (REVENUEDOT_ALLOW_SIGNUP unset). The e2e server
 * itself is open, so /auth/config is answered as a closed self-hosted server would; the server side is covered by
 * apps/server/test/signup.test.ts. SHOTS=<dir> saves screenshots.
 */
import { expect, test } from "@playwright/test";

test("closed sign-up: the sign-up page explains how to open it, and sign-in has no sign-up link", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/auth/config", (r) => r.fulfill({ json: { edition: "self-hosted", signup: "closed" } }));
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Sign-up is closed" })).toBeVisible();
  await expect(page.getByText("REVENUEDOT_ALLOW_SIGNUP=true")).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/signup-closed.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/signup-closed-390.png` });
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to RevenueDot" })).toBeVisible();
  await expect(page.getByText("Sign-up is closed on this server.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);

  // An open server shows the form.
  await page.unroute("**/auth/config");
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("signed out: a deep link asks for sign-in first, with no refused API calls, then opens that page", async ({ page }) => {
  expect((await page.request.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } })).ok()).toBe(true);
  const pid: string = (await (await page.request.get("/auth/me")).json()).projects[0].id;
  await page.request.post("/auth/logout");
  await page.context().clearCookies();
  const failed: string[] = [];
  page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`/projects/${pid}/customers`);
  await page.waitForURL(/\/login\?next=/);
  await expect(page.getByRole("heading", { name: "Sign in to RevenueDot" })).toBeVisible();
  await page.goto("/account");
  await page.waitForURL(/\/login\?next=%2Faccount/);
  expect(failed).toEqual([]);
  await page.goto(`/login?next=${encodeURIComponent(`/projects/${pid}/customers`)}`);
  await page.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(new RegExp(`/projects/${pid}/customers$`));
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
});

test("sign out from a busy Overview: no request answers 401 (found by the dashboard-ui journey)", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (r) => { if (r.status() === 401 && new URL(r.url()).pathname.startsWith("/v2/")) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.request.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } });
  // Keep the Overview's history requests in flight so sign-out has to wait for them, and the page refetches on its own.
  await page.route("**/metrics/history**", async (route) => { await new Promise((r) => setTimeout(r, 400)); await route.continue(); });
  const pid = ((await (await page.request.get("/auth/me")).json()) as any).projects[0].id;
  for (let round = 0; round < 3; round++) {
    if (round) await page.request.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } });
    await page.goto(`/projects/${pid}/overview`);
    await expect(page.locator('[aria-label="Key metrics"]')).toBeVisible();
    await page.waitForTimeout(round * 250);
    await page.locator("button.proj").first().click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/);
    await page.waitForTimeout(1500);
  }
  expect(failed).toEqual([]);
});

test("closed sign-up: an invite link sent to the sign-up page opens the invite instead of the closed notice", async ({ page }) => {
  await page.route("**/auth/config", (r) => r.fulfill({ json: { edition: "self-hosted", signup: "closed" } }));
  await page.goto(`/signup?next=${encodeURIComponent("/invite?token=not-a-real-token")}`);
  await page.waitForURL(/\/invite\?token=not-a-real-token$/);
  await expect(page.getByRole("heading", { name: "Sign-up is closed" })).toHaveCount(0);
});

test("sign-in only follows next= to pages on this site", async ({ page, baseURL }) => {
  for (const next of ["/\\evil.example/", "/\t/evil.example/", "//evil.example/", "https://evil.example/"]) {
    await page.context().clearCookies();
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
    await page.getByLabel("Password").fill("e2e-password-1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/projects\/[^/]+\/overview/, { timeout: 10_000 });
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
  }
});
