/**
 * The RevenueDot AI composer keeps every keystroke (found on production 2026-10-02: "test_user" arrived as "tst_user").
 * Cause: the composer set its `@`-mention state from an effect on every keystroke, so each keystroke's synchronous
 * render left a second render queued; when keys came faster than React's scheduler ran, React counted 50 such commits
 * in a row, threw "Maximum update depth exceeded" (minified error #185) in the next keystroke's setState and dropped
 * that character. The fix derives the mention query while rendering (pages/ai/Composer.tsx).
 * Each test types long sentences back to back (the burst that triggered it) and at a person's speed, on the empty
 * page while the history list is still loading and inside a conversation, then checks the exact text and the console.
 *   cd apps/dashboard && npx vite build && E2E_PORT=5522 npx playwright test -c e2e/playwright.config.ts composer-typing
 */
import { expect, test, type Page } from "@playwright/test";

const SENTENCE = "What products did test_user_tihywd buy? Does that customer have access to pro right now? Grant test_user_tihywd promotional pro access for 3 days, then show the MRR for the last 90 days with every detail you have.";

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
async function signIn(page: Page) {
  const r = await page.request.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } });
  expect(r.ok()).toBe(true);
  return (await (await page.request.get("/auth/me")).json()).projects[0].id as string;
}
const composer = (page: Page) => page.getByRole("textbox", { name: "Ask RevenueDot AI" });

async function typeAndCheck(page: Page, delay: number) {
  const box = composer(page);
  await box.click();
  await box.fill("");
  await box.pressSequentially(SENTENCE, { delay });
  await expect(box).toHaveValue(SENTENCE);
}

test("empty page: a fast burst and person-speed typing keep every letter while the history list loads", async ({ page }) => {
  const errors = watchErrors(page);
  const pid = await signIn(page);
  // The chat history and AI status answer slowly, so the list arrives (and re-renders the page) mid-sentence.
  await page.route(/\/v2\/projects\/[^/]+\/ai\/conversations(\?.*)?$/, async (route) => { await new Promise((r) => setTimeout(r, 700)); await route.continue(); });
  await page.goto(`/projects/${pid}/ai`);
  await expect(composer(page)).toBeVisible();
  await typeAndCheck(page, 0);
  await typeAndCheck(page, 0);
  // A person typing quickly (about 12 keys a second) while the page refetches the history list on focus.
  const box = composer(page);
  await box.fill("");
  await box.click();
  const typing = box.pressSequentially(SENTENCE, { delay: 80 });
  for (let i = 0; i < 4; i++) { await page.waitForTimeout(600); await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); }); }
  await typing;
  await expect(box).toHaveValue(SENTENCE);
  // Mentions still open, filter and close.
  await box.fill("");
  await box.pressSequentially("Look at @", { delay: 0 });
  await expect(page.getByRole("listbox", { name: "Mention" })).toBeVisible();
  await box.press("Escape");
  await expect(page.getByRole("listbox", { name: "Mention" })).toHaveCount(0);
  await expect(box).toHaveValue("Look at @");
  expect(errors).toEqual([]);
});

test("inside a conversation: every letter arrives, before and after an answer", async ({ page }) => {
  const errors = watchErrors(page);
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/ai`);
  await composer(page).fill("How is revenue doing this month?");
  await composer(page).press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/ai/aic\\w+$`));
  await expect(page.locator('[data-tool="get-metrics"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await typeAndCheck(page, 0);
  await typeAndCheck(page, 0);
  await typeAndCheck(page, 40);
  // At phone width too (the composer wraps after fewer letters).
  await page.setViewportSize({ width: 390, height: 844 });
  await typeAndCheck(page, 0);
  expect(errors).toEqual([]);
});
