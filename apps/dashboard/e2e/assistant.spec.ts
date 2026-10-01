/**
 * RevenueDot AI (prd/ai-assistant/PRD.md) in a real browser against the e2e server's scripted fake model (no model API
 * is called): open /ai, ask, see a tool card and the answer, reload and resume; approve and deny a write; the Overview
 * bar; Project settings → AI features; @ mentions and the .storekit viewer; the audit log; phone width and dark theme.
 * `SHOTS=<dir>` also saves 1440×900 light and dark screenshots (compare with frame 29 of the RevenueCat study).
 *   cd apps/dashboard && npx vite build && E2E_PORT=5408 npx playwright test -c e2e/playwright.config.ts assistant
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(page: Page, method: string, path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const demo = async (page: Page) => {
  await json(page, "POST", "/auth/login", { email: "e2e@revenuedot.test", password: "e2e-password-1" });
  return (await json(page, "GET", "/auth/me")).projects[0].id as string;
};
/** A fresh account with a Test Store app and the "pro" entitlement, so writes never touch the demo project. */
async function fresh(page: Page, label: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await json(page, "POST", "/auth/signup", { email: `ai-${label}-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Grace Hopper", project_name: `AI ${label}` });
  const pid = (await json(page, "GET", "/auth/me")).projects[0].id as string;
  const P = `/v2/projects/${pid}`;
  const app = await json(page, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const prod = await json(page, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_monthly", type: "subscription", subscription: { duration: "P1M" } });
  const ent = await json(page, "POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro" });
  await json(page, "POST", `${P}/entitlements/${ent.id}/actions/attach_products`, { product_ids: [prod.id] });
  return { pid, P, appId: app.id as string };
}
const composer = (page: Page) => page.getByRole("textbox", { name: "Ask RevenueDot AI" });
/** Asks once the previous answer is done (Enter does nothing while an answer is being written). */
const ask = async (page: Page, text: string) => {
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await composer(page).fill(text);
  await composer(page).press("Enter");
};

test("ask a question: greeting, tool card, streamed answer, history rail, reload", async ({ page }) => {
  const errors = watchConsole(page);
  const pid = await demo(page);
  await page.goto(`/projects/${pid}/ai`);
  await expect(page.getByRole("heading", { name: /^(Morning|Afternoon|Evening), Demo$/ })).toBeVisible();
  await expect(page.getByText("I'm RevenueDot AI.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach image" })).toBeVisible();
  await ask(page, "How is revenue doing this month?");
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/ai/aic\\w+$`));
  const card = page.locator('[data-tool="get-metrics"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("Revenue metrics");
  await expect(page.getByText(/MRR is \$[\d,]+/)).toBeVisible();
  // The MRR figure matches the Overview API.
  const overview = await json(page, "GET", `/v2/projects/${pid}/metrics/overview`);
  const mrr = Math.round(overview.metrics.find((m: { id: string }) => m.id === "mrr").value);
  await expect(page.getByText(`MRR is $${mrr.toLocaleString("en-US")}`)).toBeVisible();
  // The link in the answer opens the chart inside the dashboard.
  await expect(page.getByRole("link", { name: "MRR chart" })).toHaveAttribute("href", `/projects/${pid}/charts/mrr`);
  // The rail lists it under the question's words; a reload keeps the whole conversation.
  await expect(page.getByRole("complementary", { name: "Conversations" }).getByRole("link", { name: "How is revenue doing this month?" })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-tool="get-metrics"]')).toBeVisible();
  await expect(page.getByText(/MRR is \$/)).toBeVisible();
  // Tool card opens to show its input and result.
  await page.locator('[data-tool="get-metrics"]').getByRole("button").first().click();
  await expect(page.locator('[data-tool="get-metrics"]')).toContainText("Result");
  expect(errors).toEqual([]);
});

test("a reload mid-answer resumes the stream", async ({ page }) => {
  const pid = await demo(page);
  await page.goto(`/projects/${pid}/ai`);
  await ask(page, "How is revenue doing? Summarize growth for me.");
  await expect(page.locator('[data-tool="get-metrics"]')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Revenue in the last 28 days was/)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-tool="get-metrics"]')).toHaveCount(1);
});

test("a write asks first: Approve runs it and audits it; Deny changes nothing", async ({ page }) => {
  const errors = watchConsole(page);
  const { pid, P } = await fresh(page, "write");
  await page.goto(`/projects/${pid}/ai`);
  await expect(page.getByRole("heading", { name: /, Grace$/ })).toBeVisible();
  await ask(page, "Please grant pro to e2e_ai_user");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Grant pro to e2e_ai_user for 7 days?");
  await expect(card).toContainText("Nothing changes until you approve.");
  expect((await page.request.get(`${P}/customers/e2e_ai_user`)).status()).toBe(404);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toContainText("Approved");
  await expect(page.getByText(/^Done\. The customer has the entitlement until/)).toBeVisible();
  const active = await json(page, "GET", `${P}/customers/e2e_ai_user/active_entitlements`);
  expect(active.items).toHaveLength(1);

  await ask(page, "grant pro to someone_else");
  const second = page.getByTestId("approval-card").nth(1);
  await expect(second).toContainText("Grant pro to someone_else");
  await second.getByRole("button", { name: "Deny" }).click();
  await expect(second).toContainText("Denied. Nothing changed.");
  await expect(page.getByText("OK, I did not change anything.")).toBeVisible();
  expect((await page.request.get(`${P}/customers/someone_else`)).status()).toBe(404);

  // The audit log names the assistant and the person who approved.
  await page.goto(`/projects/${pid}/settings/audit-logs`);
  await expect(page.getByText("RevenueDot AI").first()).toBeVisible();
  await expect(page.getByText(/ai-write-\d+@revenuedot\.test/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("Overview bar opens a conversation with the question", async ({ page }) => {
  const pid = await demo(page);
  await page.goto(`/projects/${pid}/overview`);
  const bar = page.getByRole("textbox", { name: "Ask about insights or growth opportunities" });
  await expect(bar).toBeVisible();
  await page.keyboard.press("/");
  await expect(bar).toBeFocused();
  await bar.fill("Which subscriptions are growing?");
  await bar.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/ai/aic\\w+$`));
  await expect(page.locator(".ai-user-text", { hasText: "Which subscriptions are growing?" })).toBeVisible();
  await expect(page.getByText(/MRR is \$/)).toBeVisible();
});

test("Project settings → AI features: read only hides writes, disabled turns it off", async ({ page }) => {
  const { pid } = await fresh(page, "settings");
  await page.goto(`/projects/${pid}/settings/ai`);
  const tab = page.getByTestId("ai-features");
  await expect(tab.getByRole("radio", { name: /Read and write with permission/ })).toBeChecked();
  await expect(tab).toContainText("Fake · fake-assistant-model");
  await tab.getByRole("radio", { name: /^Read only/ }).check();
  await expect(page.getByText("AI features saved.")).toBeVisible();
  await page.goto(`/projects/${pid}/ai`);
  await expect(page.getByText("This project allows RevenueDot AI to read only.")).toBeVisible();
  await ask(page, "grant pro to blocked_user");
  await expect(page.getByText("I can't change anything in this project")).toBeVisible();
  await expect(page.getByTestId("approval-card")).toHaveCount(0);

  await page.goto(`/projects/${pid}/settings/ai`);
  await page.getByTestId("ai-features").getByRole("radio", { name: /^Disabled/ }).check();
  await expect(page.getByText("AI features saved.")).toBeVisible();
  await page.goto(`/projects/${pid}/ai`);
  await expect(page.getByTestId("ai-unavailable")).toContainText("An admin turned RevenueDot AI off for this project.");
  await page.goto(`/projects/${pid}/overview`);
  await expect(page.getByRole("button", { name: "RevenueDot AI" }).first()).toBeVisible();
});

test("@ mentions and the .storekit viewer", async ({ page }) => {
  const { pid } = await fresh(page, "extras");
  await page.goto(`/projects/${pid}/ai`);
  await composer(page).fill("Explain @mr");
  const list = page.getByRole("listbox", { name: "Mention" });
  await expect(list.getByRole("option", { name: "chart @MRR Chart", exact: true })).toBeVisible();
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("Explain @MRR ");

  const storekit = readFileSync(new URL("../../../packages/core/test/fixtures/storekit/Scanner.storekit", import.meta.url));
  await page.locator('input[type="file"]').setInputFiles({ name: "Scanner.storekit", mimeType: "application/octet-stream", buffer: storekit });
  await expect(page.locator(".ai-chip", { hasText: "Scanner.storekit" })).toBeVisible();
  await composer(page).press("Enter");
  const card = page.getByTestId("storekit-card");
  await expect(card).toContainText("5 products · USA");
  await expect(card).toContainText("com.example.scanner.pro.yearly");
  await expect(card.getByRole("button", { name: "Import into catalog" })).toBeVisible();
  // The mention reached the model as context and stays in the transcript.
  const conv = await json(page, "GET", `/v2/projects/${pid}/ai/conversations/${page.url().split("/").pop()}`);
  expect(conv.messages[0].metadata.mentions).toEqual([{ type: "chart", id: "mrr", label: "MRR" }]);
});

test("phone width and dark theme", async ({ page }) => {
  const errors = watchConsole(page);
  const pid = await demo(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/projects/${pid}/ai`);
  await expect(composer(page)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(10, 10, 10)");
  expect(errors).toEqual([]);
});

test("screenshots (SHOTS=<dir>)", async ({ page }) => {
  test.skip(!process.env.SHOTS, "set SHOTS=<dir> to save screenshots");
  test.setTimeout(120_000);
  const dir = resolve(process.cwd(), process.env.SHOTS!);
  mkdirSync(dir, { recursive: true });
  const pid = await demo(page);
  await json(page, "POST", "/auth/me", { name: "Kai Feng" });
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/projects/${pid}/ai`);
      await expect(composer(page)).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${dir}/ai-welcome-${scheme}.png` });
      await ask(page, "How is revenue doing this month?");
      await expect(page.getByText(/See the/)).toBeVisible();
      await ask(page, "Grant pro to wjqx8kd2rn1 as a thank-you");
      await expect(page.getByTestId("approval-card").last()).toContainText("Approve");
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/ai-conversation-${scheme}.png` });
      await page.getByTestId("approval-card").last().getByRole("button", { name: "Deny" }).click();
      await expect(page.getByText("OK, I did not change anything.")).toBeVisible();
      await page.goto(`/projects/${pid}/settings/ai`);
      await expect(page.getByTestId("ai-features")).toBeVisible();
      await page.screenshot({ path: `${dir}/ai-settings-${scheme}.png` });
      await page.goto(`/projects/${pid}/overview`);
      await expect(page.getByRole("textbox", { name: "Ask about insights or growth opportunities" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/ai-overview-bar-${scheme}.png`, clip: { x: 0, y: 0, width: 1440, height: 520 } });
    }
  } finally {
    await json(page, "POST", "/auth/me", { name: "Demo owner" });
  }
});
