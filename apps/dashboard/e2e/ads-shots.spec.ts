/**
 * Screenshots of the Ads pages and the integration catalogue on the e2e seed (prd/ads/PRD.md), 1440×900, light, plus
 * the overview in dark. Compared with RevenueCat's frames 17 (Ads) and 27 (Integrations). Skipped unless SHOTS is set:
 *   cd apps/dashboard && npx vite build && SHOTS=../../docs/assets/ads E2E_PORT=5407 npx playwright test -c e2e/playwright.config.ts e2e/ads-shots
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test, type Page } from "@playwright/test";

async function json<T = any>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

test("ads screenshots (SHOTS=<dir>)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "set SHOTS=<dir> to save screenshots");
  test.setTimeout(120_000);
  const dir = resolve(process.cwd(), process.env.SHOTS!);
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const shot = async (name: string, path: string, full = false) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/${name}.png`, fullPage: full });
  };
  // A project with no ad events: the onboarding (RevenueCat frame 17).
  await json(page, "POST", "/auth/login", { email: "fresh@revenuedot.test", password: "e2e-password-1" });
  const fresh = (await json(page, "GET", "/auth/me")).projects[0].id as string;
  await shot("ads-onboarding", `/projects/${fresh}/ads`);
  await json(page, "POST", "/auth/logout").catch(() => null);

  await json(page, "POST", "/auth/login", { email: "e2e@revenuedot.test", password: "e2e-password-1" });
  const pid = (await json(page, "GET", "/auth/me")).projects[0].id as string;
  await shot("ads-overview", `/projects/${pid}/ads`);
  await shot("ads-overview-full", `/projects/${pid}/ads`, true);
  await shot("ads-rewards", `/projects/${pid}/ads/rewards`, true);
  await shot("integrations", `/projects/${pid}/integrations`);
  await shot("integration-admob", `/projects/${pid}/integrations/admob`);
  await shot("integration-braze", `/projects/${pid}/integrations/braze`);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("ads-overview-dark", `/projects/${pid}/ads`);
});
