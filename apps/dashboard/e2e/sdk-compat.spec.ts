/**
 * Apps page end to end: the SDK compatibility panel fills from real SDK requests (their X-Platform, X-Version and
 * X-Platform-Flavor headers), and an app whose store notifications fail says so in the Apps list and in the Overview's
 * setup health. Runs against e2e/server.ts. SHOTS=<dir> saves desktop and 390px screenshots.
 *   pnpm --filter @revenuedot/dashboard e2e
 */
import { expect, test, type Page } from "@playwright/test";

const errors: string[] = [];

async function signIn(page: Page) {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${page.url()}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill("e2e@revenuedot.test");
  await page.getByLabel("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  return page.url().match(/projects\/([^/]+)/)![1]!;
}

const shot = async (page: Page, name: string) => { if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true }); };

test("apps: SDK compatibility from real SDK calls, and failing store notifications", async ({ page }) => {
  const pid = await signIn(page);
  const apps = (await (await page.request.get(`/v2/projects/${pid}/apps?limit=100`)).json()).items as { id: string; type: string; name: string }[];
  const testApp = apps.find((a) => a.type === "test_store")!;
  // A second App Store app of its own, so the other specs' seeded app keeps its state.
  const iosApp = (await (await page.request.post(`/v2/projects/${pid}/apps`, { data: { name: "Scanner Mac", type: "app_store", app_store: { bundle_id: "com.example.scanner.mac" } } })).json()) as { id: string; name: string };
  const key = (await (await page.request.get(`/v2/projects/${pid}/apps/${testApp.id}/public_api_keys`)).json()).items[0].key as string;

  // Three SDK builds call the SDK endpoints, as the real SDKs do.
  const sdkCall = (user: string, headers: Record<string, string>) =>
    page.request.get(`/v1/subscribers/${user}`, { headers: { Authorization: `Bearer ${key}`, ...headers } });
  const ios = { "X-Platform": "iOS", "X-Platform-Flavor": "native", "X-Version": "5.91.0", "X-Platform-Version": "Version 26.0 (Build 23A341)", "X-Client-Version": "3.4.1" };
  for (const u of ["sdk_ios_1", "sdk_ios_2", "sdk_ios_3"]) expect((await sdkCall(u, ios)).ok()).toBe(true);
  expect((await sdkCall("sdk_ios_old", { ...ios, "X-Version": "5.80.1" })).ok()).toBe(true);
  expect((await sdkCall("sdk_rn_1", { "X-Platform": "android", "X-Platform-Flavor": "react-native", "X-Platform-Flavor-Version": "8.11.0", "X-Version": "9.6.0", "X-Platform-Version": "35" })).ok()).toBe(true);
  expect((await sdkCall("sdk_ios_4", { ...ios, "X-Version": "4.43.2" })).ok()).toBe(true);

  // Someone posts a notification this server cannot verify: rejected, and the app's notifications are not failing.
  expect((await page.request.post(`/v1/notifications/apple/${iosApp.id}`, { data: { signedPayload: "not.a.jws" } })).status()).toBe(400);

  await page.goto(`/projects/${pid}/apps`);
  const row = page.getByRole("row").filter({ hasText: iosApp.name });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("Notifications failing");
  await expect(page.getByRole("row").filter({ hasText: testApp.name })).toContainText("Ready");

  const panel = page.getByRole("region", { name: "SDK compatibility" });
  await expect(panel).toBeVisible();
  const iosRow = panel.getByRole("row").filter({ hasText: "purchases-ios" });
  // Latest is the highest version; most used is the one most customers were last seen with (3 of 5 iOS customers).
  await expect(iosRow).toContainText("5.91.0");
  await expect(iosRow.locator("td").nth(3)).toContainText("5.91.0 (60.0%)");
  await expect(iosRow).toContainText("Untested version"); // 4.43.2 is outside the contract-tested majors
  const rnRow = panel.getByRole("row").filter({ hasText: "react-native-purchases" });
  await expect(rnRow.locator("td").nth(0)).toHaveText("Android");
  await expect(rnRow.locator("td").nth(2)).toHaveText("8.11.0");
  await expect(rnRow).toContainText("Supported");

  await panel.getByRole("button", { name: /What differs with the stock SDK/ }).click();
  await expect(panel).toContainText("keep entitlement verification off");
  await expect(panel).toContainText("Paywall and ad events from the stock Android SDK still go to RevenueCat");
  await panel.getByRole("button", { name: /Every SDK build/ }).click();
  const build = panel.getByRole("row").filter({ hasText: "8.11.0 (native 9.6.0)" });
  await expect(build).toContainText(testApp.name);
  await expect(build).toContainText("35");
  await shot(page, "apps-sdk-desktop");

  // Phone width: nothing spills out of the page; the tables scroll inside their panels.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("region", { name: "SDK compatibility" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await shot(page, "apps-sdk-390");
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The Overview's setup health shows the same failure, with the store's error.
  await page.goto(`/projects/${pid}/overview`);
  const health = page.getByRole("region", { name: "Setup health" });
  const failing = health.locator(".hrow").filter({ hasText: "App Store notifications · Scanner Mac" });
  await expect(failing).toContainText("The last notification failed");
  await expect(failing).toContainText("Malformed JWS");
  await expect(failing.locator(".dot")).toHaveClass(/bad/);
  await shot(page, "overview-failing-notifications");

  expect(errors).toEqual([]);
});
