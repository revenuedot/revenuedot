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
