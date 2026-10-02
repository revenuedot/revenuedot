/**
 * Import products from the store, end to end in the browser: the "Import products" dialog on the Products page and on an
 * app's page, against the e2e server's fake App Store Connect and Google Play (store-fakes.ts `storeCatalogFetch`) and its
 * in-memory Stripe account. No store is ever called: the keys are generated here and only the fakes accept them.
 * Search, select all, rows already in the catalog disabled, the entitlement picker, the result summary, a refused key,
 * Amazon's explanation, phone width. Every run signs up a fresh account.
 *
 *   E2E_PORT=5450 pnpm --filter @revenuedot/dashboard e2e -- e2e/store-import.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
import { FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";
import { E2E_ASC_EMPTY_KEY_ID, E2E_ASC_FORBIDDEN_KEY_ID, E2E_ASC_ISSUER, E2E_ASC_KEY_ID, E2E_IMPORT_BUNDLE, E2E_PLAY_DENIED_EMAIL, E2E_PLAY_EMAIL } from "./store-values.ts";

test.describe.configure({ mode: "serial" });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

const p8 = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const serviceAccount = (email = E2E_PLAY_EMAIL) => JSON.stringify({
  type: "service_account", project_id: "e2e-project", private_key_id: "e2e-kid",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_email: email, token_uri: "https://oauth2.googleapis.com/token",
});

test("store import: App Store Connect, Google Play, Stripe and Amazon", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const WEB = baseURL!;
  const errors = watchConsole(page);
  const api = async <T = any>(method: string, path: string, data?: unknown) => {
    const r = await page.request.fetch(`${WEB}${path}`, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
    const t = await r.text();
    return { status: r.status(), body: (t ? JSON.parse(t) : null) as T };
  };
  const stamp = Date.now();

  await page.goto(`${WEB}/signup`);
  await page.getByLabel("Your name").fill("Import e2e");
  await page.getByLabel("Email", { exact: true }).fill(`import-${stamp}@revenuedot.test`);
  await page.getByLabel("Password").fill(`e2e-${stamp}-pw`);
  await page.getByLabel("First project").fill("Focus");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  const pid = page.url().split("/projects/")[1]!.split("/")[0]!;
  const P = `/v2/projects/${pid}`;

  const app = async (body: Record<string, unknown>) => { const r = await api<{ id: string }>("POST", `${P}/apps`, body); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id; };
  const ios = await app({ name: "Focus iOS", type: "app_store", app_store: { bundle_id: E2E_IMPORT_BUNDLE, app_store_connect_api_key: p8(), app_store_connect_api_key_id: E2E_ASC_KEY_ID, app_store_connect_api_key_issuer: E2E_ASC_ISSUER } });
  const android = await app({ name: "Focus Android", type: "play_store", play_store: { package_name: E2E_IMPORT_BUNDLE, play_service_account_credentials_json: serviceAccount() } });
  await app({ name: "Focus Web", type: "stripe", stripe: { stripe_secret_key: FAKE_STRIPE_KEY } });
  await app({ name: "Focus Fire", type: "amazon", amazon: { package_name: E2E_IMPORT_BUNDLE } });
  await app({ name: "Empty iOS", type: "app_store", app_store: { bundle_id: E2E_IMPORT_BUNDLE, app_store_connect_api_key: p8(), app_store_connect_api_key_id: E2E_ASC_EMPTY_KEY_ID, app_store_connect_api_key_issuer: E2E_ASC_ISSUER } });
  await app({ name: "No key iOS", type: "app_store", app_store: { bundle_id: E2E_IMPORT_BUNDLE } });
  await app({ name: "Denied Android", type: "play_store", play_store: { package_name: E2E_IMPORT_BUNDLE, play_service_account_credentials_json: serviceAccount(E2E_PLAY_DENIED_EMAIL) } });
  await app({ name: "Denied iOS", type: "app_store", app_store: { bundle_id: E2E_IMPORT_BUNDLE, app_store_connect_api_key: p8(), app_store_connect_api_key_id: E2E_ASC_FORBIDDEN_KEY_ID, app_store_connect_api_key_issuer: E2E_ASC_ISSUER } });
  // One product is already in the catalog, and the entitlement to attach imports to.
  expect((await api("POST", `${P}/products`, { app_id: ios, store_identifier: "focus_pro_monthly", type: "subscription", subscription: { duration: "P1M" } })).status).toBe(201);
  const ent = await api<{ id: string }>("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro access" });
  expect(ent.status).toBe(201);
  // Stripe products made "in Stripe's dashboard" (the e2e server's in-memory account).
  const sid = `${stamp}`;
  expect((await api("POST", "/__stripe/seed", {
    products: [{ id: `prod_focus_${sid}`, name: "Focus Plus", default_price: `price_focus_y_${sid}` }],
    prices: [
      { id: `price_focus_m_${sid}`, product: `prod_focus_${sid}`, currency: "usd", unit_amount: 499, type: "recurring", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } },
      { id: `price_focus_y_${sid}`, product: `prod_focus_${sid}`, currency: "usd", unit_amount: 3999, type: "recurring", recurring: { interval: "year", interval_count: 1, usage_type: "licensed" } },
    ],
  })).status).toBe(200);

  const dialog = page.getByRole("dialog", { name: /Import products/ });

  await test.step("App Store: list, search, select all, a row already in the catalog, attach to pro", async () => {
    await page.goto(`${WEB}/projects/${pid}/product-catalog/products`);
    await page.getByRole("button", { name: "Import products", exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Focus iOS (App Store)" });
    await expect(dialog.getByText("6 products in App Store Connect, 1 already in the catalog")).toBeVisible();
    const rows = dialog.locator("tbody tr");
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText("Focus Pro Monthly");
    await expect(rows.first()).toContainText("In catalog");
    await expect(dialog.getByLabel("Select focus_pro_monthly")).toBeDisabled();
    await expect(dialog.getByRole("row", { name: /Focus Pro Annual/ })).toContainText("1 year");
    await expect(dialog.getByRole("row", { name: /Exam season pass/ })).toContainText("Non-renewing");

    await dialog.getByPlaceholder("Search store products").fill("coins");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("focus_coins_100");
    await dialog.getByPlaceholder("Search store products").fill("");
    await expect(rows).toHaveCount(6);

    await dialog.getByLabel("Select all").check();
    await expect(dialog.getByRole("button", { name: "Import 5 products" })).toBeEnabled();
    await dialog.getByRole("row", { name: /Exam season pass/ }).click();
    await expect(dialog.getByLabel("Select focus_season")).not.toBeChecked();
    await expect(dialog.getByRole("button", { name: "Import 4 products" })).toBeVisible();
    await dialog.getByRole("checkbox", { name: /^pro/ }).check();
    if (process.env.SHOTS) await dialog.screenshot({ path: `${process.env.SHOTS}/import-list.png` });
    await dialog.getByRole("button", { name: "Import 4 products" }).click();

    await expect(dialog.getByText("Imported 4 products from App Store Connect.")).toBeVisible();
    await expect(dialog.getByLabel("Import result")).toContainText("focus_pro_weekly · Subscription · 1 week");
    await expect(dialog.getByLabel("Import result")).toContainText("Attached to pro.");
    if (process.env.SHOTS) await dialog.screenshot({ path: `${process.env.SHOTS}/import-result.png` });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    // The Products page shows them, and the API agrees on types, durations and the entitlement.
    const panel = page.getByRole("region", { name: "Focus iOS products" });
    for (const id of ["focus_pro_annual", "focus_pro_weekly", "focus_lifetime", "focus_coins_100"]) await expect(panel.getByText(id)).toBeVisible();
    const products = (await api<{ items: any[] }>("GET", `${P}/products?app_id=${ios}&limit=50`)).body.items;
    const by = Object.fromEntries(products.map((p) => [p.store_identifier, p]));
    expect(by.focus_pro_annual).toMatchObject({ type: "subscription", display_name: "Focus Pro Annual", subscription: { duration: "P1Y" } });
    expect(by.focus_coins_100).toMatchObject({ type: "consumable", display_name: "100 focus coins" });
    expect(by.focus_season).toBeUndefined();
    const attached = (await api<{ items: any[] }>("GET", `${P}/entitlements/${ent.body.id}/products`)).body.items.map((p) => p.store_identifier).sort();
    expect(attached).toEqual(["focus_coins_100", "focus_lifetime", "focus_pro_annual", "focus_pro_weekly"]);
    // What the SDK receives: the imported products unlock pro (consumables never do).
    const key = (await api<{ items: { key: string }[] }>("GET", `${P}/apps/${ios}/public_api_keys`)).body.items[0]!.key;
    const sdk = await page.request.get(`${WEB}/v1/product_entitlement_mapping`, { headers: { authorization: `Bearer ${key}` } });
    const mapping = (await sdk.json()).product_entitlement_mapping;
    for (const id of ["focus_pro_annual", "focus_pro_weekly", "focus_lifetime"]) expect(mapping[id]).toMatchObject({ product_identifier: id, entitlements: ["pro"] });
    expect(mapping.focus_coins_100).toBeUndefined();

    // Opened again from the app group: only the season pass is left to import.
    await panel.getByRole("button", { name: "Import products into Focus iOS" }).click();
    await expect(dialog.getByText("6 products in App Store Connect, 5 already in the catalog")).toBeVisible();
    await dialog.getByLabel("Select all").check();
    await expect(dialog.getByRole("button", { name: "Import 1 product" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("Google Play from the app page: base plans as subscription:base_plan, over two pages", async () => {
    await page.goto(`${WEB}/projects/${pid}/apps/${android}`);
    await page.getByRole("button", { name: "Import products", exact: true }).click();
    const d = page.getByRole("dialog", { name: "Import products into Focus Android" });
    await expect(d.locator("tbody tr")).toHaveCount(4);
    await expect(d.getByRole("row", { name: /focus_family:yearly/ })).toContainText("Focus Family");
    await expect(d.getByRole("row", { name: /focus_premium:annual/ })).toContainText("1 year");
    await expect(d.getByRole("row", { name: /focus_unlock/ })).toContainText("One-time");
    await d.getByLabel("Select all").check();
    await d.getByRole("button", { name: "Import 4 products" }).click();
    await expect(d.getByText("Imported 4 products from Google Play.")).toBeVisible();
    await d.getByRole("button", { name: "Done" }).click();
    const ids = (await api<{ items: any[] }>("GET", `${P}/products?app_id=${android}`)).body.items.map((p) => p.store_identifier).sort();
    expect(ids).toEqual(["focus_family:yearly", "focus_premium:annual", "focus_premium:monthly", "focus_unlock"]);
  });

  await test.step("Stripe: one row per price, with the price", async () => {
    await page.goto(`${WEB}/projects/${pid}/product-catalog/products`);
    await page.getByRole("button", { name: "Import products", exact: true }).click();
    // Entitlements picked for one app do not carry over to another app's import.
    await dialog.getByRole("checkbox", { name: /^pro/ }).check();
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Focus Web (Stripe)" });
    await expect(dialog.getByRole("checkbox", { name: /^pro/ })).not.toBeChecked();
    await dialog.getByRole("checkbox", { name: /^pro/ }).check();
    const yearly = dialog.getByRole("row", { name: /Focus Plus \(yearly\)/ });
    await expect(yearly).toContainText("$39.99");
    await expect(dialog.getByRole("row", { name: /Focus Plus \(monthly\)/ })).toContainText("1 month");
    await dialog.getByLabel(`Select price_focus_y_${sid}`).check();
    await dialog.getByRole("button", { name: "Import 1 product" }).click();
    await expect(dialog.getByText("Imported 1 product from Stripe.")).toBeVisible();
    await dialog.getByRole("button", { name: "Import more" }).click();
    await expect(yearly).toContainText("In catalog");
    await expect(dialog.getByRole("checkbox", { name: /^pro/ })).not.toBeChecked();
  });

  await test.step("Amazon explains why it cannot import; a missing key, a refused key and an empty store each say so", async () => {
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Focus Fire (Amazon)" });
    await expect(dialog.getByRole("note")).toContainText("Amazon has no API");
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Denied iOS (App Store)" });
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("App Manager role");
    await expect(alert.getByRole("link", { name: "Open app settings" })).toBeVisible();
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "No key iOS (App Store)" });
    await expect(dialog.getByRole("alert")).toContainText("needs the app's App Store Connect API key");
    await expect(dialog.getByRole("alert")).toContainText("The In-App Purchase key cannot read the product list");
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Denied Android (Google Play)" });
    await expect(dialog.getByRole("alert")).toContainText("View app information and download bulk reports (read-only)");
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Empty iOS (App Store)" });
    await expect(dialog.getByText("App Store Connect has no products for this app yet.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("phone width: the dialog fits and the page does not scroll sideways", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Import products", exact: true }).click();
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Focus iOS (App Store)" });
    await expect(dialog.locator("tbody tr")).toHaveCount(6);
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // The table fits too: type and duration move under the product name, nothing scrolls sideways.
    expect(await dialog.locator(".imp-list").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await expect(dialog.getByRole("row", { name: /Focus Pro Annual/ })).toContainText("Subscription · 1 year");
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("dark theme: the dialog uses the dark tokens", async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await page.getByRole("button", { name: "Import products", exact: true }).click();
    await dialog.getByLabel("App", { exact: true }).selectOption({ label: "Focus iOS (App Store)" });
    await expect(dialog.locator("tbody tr")).toHaveCount(6);
    const bg = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(17, 17, 17)");
    if (process.env.SHOTS) await dialog.screenshot({ path: `${process.env.SHOTS}/import-dark.png` });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.emulateMedia({ colorScheme: "light" });
  });

  // The 422s the test provokes (Amazon, the refused key) are logged by the browser as failed requests; nothing else.
  expect(errors.filter((e) => !/status of 422/.test(e))).toEqual([]);
});
