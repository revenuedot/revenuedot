/**
 * The Customer Center editor end to end (prd/customer-center/PRD.md): add, edit, reorder and delete paths, a cancel survey
 * with offers, a Custom URL and a Custom Action, colours, a translation and a custom string, the preview, validation, save,
 * and reset. Every saved value is checked in what the SDK receives from GET /v1/customercenter/{id} with a Test Store key.
 * Signs up its own account, so it does not touch the seeded demo data.
 *   pnpm --filter @revenuedot/dashboard e2e -- customer-center
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

test("Customer Center editor: paths, survey with offers, appearance, localization, preview, save, reset", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `cc-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "CC e2e", project_name: "CC e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const key: string = app.public_key ?? (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  const offer = await json(req, "POST", `${P}/retention_offers`, { trigger: "cancel", name: "Half price", title: "Stay for half price", subtitle: "3 months at 50% off", store: "app_store", product_mapping: { pro_monthly: "half_3m" } });
  const sdk = async (locales?: string) => (await json(req, "GET", "/v1/customercenter/cc_user", undefined, { authorization: `Bearer ${key}`, ...(locales ? { "x-preferred-locales": locales } : {}) })).customer_center;

  await page.goto(`/projects/${pid}/lifecycle/customer-center`);
  await expect(page.getByRole("heading", { name: "Customer Center", exact: true })).toBeVisible();
  const active = page.getByRole("region", { name: "Customers with active subscriptions" });
  const list = active.getByRole("list", { name: /paths in order/ });
  const titles = async () => (await list.locator(".cc-path-b b").allInnerTexts()).map((t) => t.trim());
  await expect.poll(titles).toEqual(["Cancel subscription", "Request a refund", "Missing purchase"]);
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // Add a Custom URL path: it opens selected, with its settings.
  await active.getByRole("button", { name: "Add path" }).click();
  await expect(page.getByRole("menuitem", { name: /Manage/ })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Custom URL" }).click();
  await expect(page.getByRole("region", { name: "Path settings" })).toContainText("Opens a web page or deep link");
  await page.getByLabel("Button text", { exact: true }).fill("Help center");
  await page.getByLabel("URL", { exact: true }).fill("https://scanner.app/help");
  await page.getByRole("group", { name: "Open in" }).getByRole("button", { name: "In the app" }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Add a Custom Action path.
  await active.getByRole("button", { name: "Add path" }).click();
  await page.getByRole("menuitem", { name: "Custom Action" }).click();
  await page.getByLabel("Button text", { exact: true }).fill("Chat with us");
  await page.getByLabel("Action identifier", { exact: true }).fill("open_chat");
  await expect.poll(titles).toEqual(["Cancel subscription", "Request a refund", "Missing purchase", "Help center", "Chat with us"]);

  // Reorder with the arrows and by dragging, delete a path.
  await active.getByRole("button", { name: "Move Help center up" }).click();
  await active.getByRole("button", { name: "Move Help center up" }).click();
  await expect.poll(titles).toEqual(["Cancel subscription", "Help center", "Request a refund", "Missing purchase", "Chat with us"]);
  await list.locator("li").nth(4).locator(".grip").dragTo(list.locator("li").nth(0));
  await expect.poll(titles).toEqual(["Chat with us", "Cancel subscription", "Help center", "Request a refund", "Missing purchase"]);
  await active.getByRole("button", { name: "Delete Missing purchase" }).click();
  await expect.poll(titles).toEqual(["Chat with us", "Cancel subscription", "Help center", "Request a refund"]);

  // Manage: a German button text, a survey whose first answer shows the Retention offer, and an offer of its own on the path.
  await list.getByRole("button", { name: /^Cancel subscription/ }).click();
  await page.getByRole("button", { name: "Edit translations: Manage: button text" }).click();
  await page.getByRole("dialog").getByLabel("German translation").fill("Abo beenden");
  await page.getByRole("button", { name: "Save translations" }).click();
  await expect(page.getByRole("button", { name: "Edit translations: Manage: button text" })).toContainText("(1)");
  await page.getByLabel("Ask why with a feedback survey").check();
  await expect(page.getByLabel("Answer 1", { exact: true })).toHaveValue("Too expensive");
  await expect(page.getByLabel("Answer 3", { exact: true })).toHaveValue("Bought by mistake");
  await page.getByLabel("Offer for answer 1").selectOption({ label: "Half price · cancel · App Store" });
  await page.getByRole("button", { name: "Add answer" }).click();
  await page.getByLabel("Answer 4", { exact: true }).fill("Missing features");
  await page.getByLabel("Promotional offer", { exact: true }).selectOption("custom");
  await page.getByLabel("Offer title", { exact: true }).fill("Wait! 30% off");
  await page.getByLabel("Offer subtitle", { exact: true }).fill("For the next 6 months");
  await page.getByLabel("Product id 1", { exact: true }).fill("pro_monthly");
  await page.getByLabel("Store offer id 1", { exact: true }).fill("save_30");

  // Refund Request: no offer at all (the Retention offers stay off it).
  await list.getByRole("button", { name: /^Request a refund/ }).click();
  await page.getByLabel("Promotional offer", { exact: true }).selectOption("none");

  // The no-active screen gets a title.
  await page.locator("#cc-NO_ACTIVE-title").fill("Nothing active yet");

  // Validation: a Custom URL without a URL cannot be saved, and the problem names the field.
  await list.getByRole("button", { name: /^Help center/ }).click();
  await page.getByLabel("URL", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert").first()).toContainText("paths[2].url: needs a full URL");
  await expect(list.getByText("Fix", { exact: true })).toBeVisible();
  await page.getByLabel("URL", { exact: true }).fill("https://scanner.app/help");
  await expect(list.getByText("Fix", { exact: true })).toHaveCount(0);

  // Appearance: a light accent and a dark background; a bad hex shows an error until fixed.
  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.locator("#cc-light-accent_color").fill("#F4A9");
  await expect(page.getByText("Use a hex colour such as #1A1A1A.")).toBeVisible();
  await page.locator("#cc-light-accent_color").fill("#F4A900");
  await page.locator("#cc-dark-background_color").fill("#000000");
  await expect(page.getByText("Use a hex colour such as #1A1A1A.")).toHaveCount(0);

  // Localization: a German custom string; another one added, then deleted with Delete selected.
  await page.getByRole("tab", { name: "Localization" }).click();
  await page.getByLabel("Language", { exact: true }).selectOption("de");
  await page.getByRole("button", { name: "Override contact_support" }).click();
  await page.getByLabel("Custom text for contact_support").fill("Schreib uns");
  await page.getByRole("button", { name: "Override done" }).click();
  await page.getByLabel("Select done").check();
  await page.getByRole("button", { name: "Delete selected (1)" }).click();
  await expect(page.getByLabel("Custom text for done")).toHaveCount(0);
  await expect(page.getByLabel("Custom text for contact_support")).toHaveValue("Schreib uns");

  // Preview: the unsaved configuration, in English and German, following a tap into the survey.
  await page.getByRole("button", { name: "Preview" }).click();
  const preview = page.getByRole("dialog", { name: "Customer Center preview" });
  await expect(preview.getByTestId("cc-preview-title")).toHaveText("Manage subscription");
  await expect(preview.getByTestId("cc-preview-paths")).toContainText("Help center");
  await preview.getByLabel("Preview language").selectOption("de");
  await expect(preview.getByTestId("cc-preview-paths")).toContainText("Abo beenden");
  await expect(preview).toContainText("Schreib uns");
  await preview.getByRole("button", { name: /Abo beenden/ }).click();
  await preview.getByRole("button", { name: /Zu teuer|Too expensive/ }).click();
  await expect(preview).toContainText("Stay for half price");
  await preview.getByRole("group", { name: "Customer" }).getByRole("button", { name: "No subscription" }).click();
  await expect(preview.getByTestId("cc-preview-title")).toHaveText("Nothing active yet");
  await preview.getByRole("button", { name: "Close" }).click();

  // Save, then check every value in what the SDK receives.
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Customer Center saved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  const en = await sdk();
  const paths = en.screens.MANAGEMENT.paths;
  expect(paths.map((p: any) => p.title)).toEqual(["Chat with us", "Cancel subscription", "Help center", "Request a refund"]);
  expect(paths[0]).toMatchObject({ type: "CUSTOM_ACTION", action_identifier: "open_chat" });
  expect(paths[2]).toMatchObject({ type: "CUSTOM_URL", url: "https://scanner.app/help", open_method: "IN_APP" });
  expect(paths[1].promotional_offer).toEqual({ ios_offer_id: "save_30", android_offer_id: "save_30", eligible: true, title: "Wait! 30% off", subtitle: "For the next 6 months", product_mapping: { pro_monthly: "save_30" } });
  expect(paths[1].feedback_survey.options.map((o: any) => o.title)).toEqual(["Too expensive", "Don't use the app", "Bought by mistake", "Missing features"]);
  expect(paths[1].feedback_survey.options[0].promotional_offer).toMatchObject({ title: "Stay for half price", subtitle: "3 months at 50% off", ios_offer_id: "half_3m", product_mapping: { pro_monthly: "half_3m" } });
  expect(paths[1].feedback_survey.options[1].promotional_offer).toBeUndefined();
  expect(paths[3].promotional_offer).toBeUndefined();
  expect(en.screens.NO_ACTIVE.title).toBe("Nothing active yet");
  expect(en.appearance).toEqual({ light: { accent_color: "#F4A900" }, dark: { background_color: "#000000" } });
  expect(JSON.stringify(en)).not.toMatch(/_localizations|custom_strings|retention_offer_id/);
  const de = await sdk("de_DE,en_US");
  expect(de.localization.locale).toBe("de_DE");
  expect(de.localization.localized_strings.contact_support).toBe("Schreib uns");
  expect(de.screens.MANAGEMENT.paths[1].title).toBe("Abo beenden");
  expect(de.screens.MANAGEMENT.paths[2].title).toBe("Help center");
  expect((await json(req, "GET", `${P}/customer_center_config`)).config.screens.MANAGEMENT.paths[1].feedback_survey.options[0].promotional_offer).toEqual({ retention_offer_id: offer.id });

  // A reload shows the saved document.
  await page.reload();
  await page.getByLabel("Language", { exact: true }).selectOption("de");
  await expect(page.getByLabel("Custom text for contact_support")).toHaveValue("Schreib uns");
  await page.getByRole("tab", { name: "Configuration" }).click();
  await expect.poll(titles).toEqual(["Chat with us", "Cancel subscription", "Help center", "Request a refund"]);

  // Phone width: nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["configuration", "appearance", "localization"]) {
    await page.goto(`/projects/${pid}/lifecycle/customer-center?tab=${tab}`);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tab} fits 390px`).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Reset configuration: back to the default for the SDK too.
  await page.goto(`/projects/${pid}/lifecycle/customer-center`);
  await page.getByRole("button", { name: "Reset configuration" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reset configuration" }).click();
  await expect(page.getByText("Customer Center reset to the default")).toBeVisible();
  await expect.poll(titles).toEqual(["Cancel subscription", "Request a refund", "Missing purchase"]);
  const after = await sdk();
  expect(after.screens.MANAGEMENT.paths.map((p: any) => p.id)).toEqual(["path_cancel", "path_refund", "path_missing"]);
  expect(after.appearance).toEqual({ light: {}, dark: {} });
  expect((await json(req, "GET", `${P}/customer_center_config`)).overrides).toBeNull();

  expect(errors).toEqual([]);
});
