/**
 * Screenshots of the Lifecycle and Customers pages on the clean e2e seed (prd/lifecycle/PRD.md), at 1440×900, light, plus
 * dark versions of two pages. Skipped unless SHOTS is set, and meant to run alone on a fresh server:
 *   cd apps/dashboard && npx vite build && SHOTS=../../docs/assets/lifecycle E2E_PORT=5403 npx playwright test -c e2e/playwright.config.ts shots
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

test("lifecycle screenshots (SHOTS=<dir>)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "set SHOTS=<dir> to save screenshots");
  test.setTimeout(120_000);
  const dir = resolve(process.cwd(), process.env.SHOTS!);
  mkdirSync(dir, { recursive: true });
  await json(page, "POST", "/auth/login", { email: "e2e@revenuedot.test", password: "e2e-password-1" });
  const pid = (await json(page, "GET", "/auth/me")).projects[0].id as string;
  const P = `/v2/projects/${pid}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  const shot = async (name: string, path: string, act?: () => Promise<void>) => {
    await page.goto(`/projects/${pid}/${path}`);
    await page.waitForLoadState("networkidle");
    if (act) { await act(); await page.waitForLoadState("networkidle"); }
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}.png` });
  };

  await shot("refund-control", "lifecycle/refund-control");
  await shot("winback-empty", "lifecycle/winback");

  // Apple Retention Messaging as a developer would set it up: the app's Apple ID, a message, a default and a rule.
  const ios = (await json(page, "GET", `${P}/apps`)).items.find((a: any) => a.type === "app_store");
  await json(page, "POST", `${P}/apps/${ios.id}`, { app_store: { app_apple_id: "1234567890" } });
  const msg = { id: "5b0c6f1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e", kind: "text", header: "Your scans stay synced", body: "Keep unlimited scans, OCR and iCloud backup on all your devices." };
  const offer = { id: "6c1d7a2f-3e4b-4c6d-9e0f-1a2b3c4d5e6f", kind: "promotional_offer", header: "Stay for half price", body: "Three months of Pro at 50% off.", promotional_offer_id: "pro_monthly_50off" };
  await json(page, "POST", `${P}/apps/${ios.id}/retention_messaging`, {
    enabled: true, messages: [msg, offer], defaults: [{ product_id: "scanner.pro.monthly", locale: "en-US", message_id: msg.id }],
    rules: [{ product_id: "scanner.pro.monthly", message_id: offer.id }, { product_id: null, message_id: msg.id }],
  });
  await shot("retention-apple", "lifecycle/retention");
  await shot("retention-customer-center", "lifecycle/retention?tab=customer_center");

  const campaign = await json(page, "POST", `${P}/winback_campaigns`, {
    name: "Lapsed Pro subscribers", status: "active", audience: { churned_min_days: 1, churned_max_days: 90, product_ids: [], stores: [], audience_id: null },
    email: { subject: "Come back to Scanner Pro", heading: "Your scans are waiting", body: "Your subscription ended, but every scan you made is still here.\n\nResubscribe today and pick up where you left off.", button_label: "Resubscribe" },
    offer: { type: "store" }, send_hour_utc: 16, track_opens: false,
  });
  await json(page, "POST", `${P}/winback_campaigns/${campaign.id}/actions/run`);
  await shot("winback-list", "lifecycle/winback");
  await shot("winback-editor", `lifecycle/winback/${campaign.id}`);

  await shot("support-integrations", "lifecycle/support");
  await shot("support-customer-center", "lifecycle/support?tab=customer_center");
  await shot("support-tickets", "lifecycle/support?tab=tickets", async () => { await page.locator("table tbody tr").first().click(); });
  await shot("customers", "customers");

  await page.emulateMedia({ colorScheme: "dark" });
  await shot("refund-control-dark", "lifecycle/refund-control");
  await shot("customers-dark", "customers");
});
