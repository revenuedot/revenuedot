/**
 * Store prices, the product editor and Create with AI, end to end in the browser (prd/catalog/PRD.md): against the e2e
 * server's stateful App Store Connect and Google Play fakes (store-fakes.ts `editorAsc`, `editorPlay`; their key and
 * service account are generated here and only the fakes accept them) and its scripted RevenueDot AI.
 *   - Products: store price and period as each row's label, the store status, where prices come from, the In-App
 *     Purchase key explained; the product page's prices by territory.
 *   - Product editor: select, download the CSV, a broken file, a file with every kind of error, the review diff,
 *     commit with a price the App Store has no price point for and a store outage, retry, the Files tab; Google Play
 *     with a one-time product that cannot be chosen, a price Play refuses, a new base plan.
 *   - Create with AI: products approved, an offering denied then approved.
 *   - A viewer reads and downloads but cannot upload, commit, refresh or use Create with AI. Phone width, dark theme,
 *     no console errors.
 *
 *   E2E_PORT=5561 pnpm --filter @revenuedot/dashboard e2e -- e2e/product-editor.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_ASC_ISSUER, E2E_EDITOR_ASC_KEY_ID, E2E_EDITOR_BUNDLE, E2E_EDITOR_PACKAGE, E2E_EDITOR_PLAY_EMAIL } from "./store-values.ts";

test.describe.configure({ mode: "serial" });

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/status of 4(03|09|22)/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
const p8 = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const serviceAccount = () => JSON.stringify({
  type: "service_account", project_id: "e2e-project", private_key_id: "e2e-kid",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  client_email: E2E_EDITOR_PLAY_EMAIL, token_uri: "https://oauth2.googleapis.com/token",
});
const dir = mkdtempSync(join(tmpdir(), "rd-editor-"));
/** The downloaded CSV with prices changed (`[store_identifier, territory, price]`) and rows added. */
function edited(csv: string, changes: [string, string, string][], add: string[] = []) {
  const rows = csv.trim().split(/\r?\n/);
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i]!.split(",");
    const hit = changes.find(([id, t]) => c[0] === id && c[5] === t);
    if (hit) { c[7] = hit[2]; rows[i] = c.join(","); }
  }
  return `${[...rows, ...add].join("\r\n")}\r\n`;
}

test("store prices, the product editor and Create with AI", async ({ page, baseURL, browser }) => {
  test.setTimeout(300_000);
  const WEB = baseURL!;
  const errors = watchConsole(page);
  const api = async <T = any>(method: string, path: string, data?: unknown) => {
    const r = await page.request.fetch(`${WEB}${path}`, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
    const t = await r.text();
    return { status: r.status(), body: (t ? JSON.parse(t) : null) as T };
  };
  const stamp = Date.now();
  expect((await page.request.post(`${WEB}/__stores/editor/reset`)).ok()).toBe(true);
  const storePrice = async (store: "asc" | "play", product: string, territory: string) =>
    (await (await page.request.get(`${WEB}/__stores/editor/price?store=${store}&product=${encodeURIComponent(product)}&territory=${territory}`)).json()) as { price: string | number | null; exists: boolean; state?: string };

  await page.goto(`${WEB}/signup`);
  await page.getByLabel("Your name").fill("Editor e2e");
  await page.getByLabel("Email", { exact: true }).fill(`editor-${stamp}@revenuedot.test`);
  await page.getByLabel("Password").fill(`e2e-${stamp}-pw`);
  await page.getByLabel("First project").fill("Focus");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  const pid = page.url().split("/projects/")[1]!.split("/")[0]!;
  const P = `/v2/projects/${pid}`;
  const base = `${WEB}/projects/${pid}/product-catalog`;
  const app = async (body: Record<string, unknown>) => { const r = await api<{ id: string }>("POST", `${P}/apps`, body); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id; };
  const ios = await app({ name: "Focus iOS", type: "app_store", app_store: { bundle_id: E2E_EDITOR_BUNDLE, app_store_connect_api_key: p8(), app_store_connect_api_key_id: E2E_EDITOR_ASC_KEY_ID, app_store_connect_api_key_issuer: E2E_ASC_ISSUER } });
  const android = await app({ name: "Focus Android", type: "play_store", play_store: { package_name: E2E_EDITOR_PACKAGE, play_service_account_credentials_json: serviceAccount() } });
  const iapOnly = await app({ name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner", subscription_key: p8(), subscription_key_id: "IAPKEY0001", subscription_key_issuer: E2E_ASC_ISSUER } });
  const ts = await app({ name: "Test Store", type: "test_store" });
  const product = async (body: Record<string, unknown>) => { const r = await api<{ id: string }>("POST", `${P}/products`, body); expect(r.status).toBe(201); return r.body.id; };
  const monthly = await product({ app_id: ios, store_identifier: "focus_pro_monthly", type: "subscription", display_name: "Focus Pro Monthly", subscription: { duration: "P1M" } });
  await product({ app_id: ios, store_identifier: "focus_lifetime", type: "non_consumable", display_name: "Focus Lifetime" });
  await product({ app_id: android, store_identifier: "family:yearly", type: "subscription", subscription: { duration: "P1Y" } });
  await product({ app_id: ts, store_identifier: "pro_monthly", type: "subscription", subscription: { duration: "P1M" }, test_store_price: { amount_micros: 4_990_000, currency: "EUR" } });

  await test.step("Products: store price and period as the label, the store status, the price source and the In-App Purchase key", async () => {
    await page.goto(`${base}/products`);
    const iosGroup = page.getByRole("region", { name: "Focus iOS products" });
    // Prices are read once on first sight (an admin opened the page).
    await expect(iosGroup.getByTestId(`price-source-${ios}`)).toContainText("Prices and status from App Store Connect · read", { timeout: 20_000 });
    await expect(iosGroup.getByRole("row", { name: /focus_pro_monthly/ })).toContainText("$9.99/month");
    await expect(iosGroup.getByRole("row", { name: /focus_pro_monthly/ })).toContainText("Approved");
    await expect(iosGroup.getByRole("row", { name: /focus_lifetime/ })).toContainText("$99.99");
    const playGroup = page.getByRole("region", { name: "Focus Android products" });
    await expect(playGroup.getByRole("row", { name: /family:yearly/ })).toContainText("$79.99/year", { timeout: 20_000 });
    await expect(playGroup.getByRole("row", { name: /family:yearly/ })).toContainText("Draft");
    await expect(page.getByRole("region", { name: "Test Store products" }).getByRole("row", { name: /pro_monthly/ })).toContainText("€4.99/month");
    await expect(page.getByTestId(`price-source-${iapOnly}`)).toContainText("needs an App Store Connect API team key with the App Manager role");
    await expect(page.getByTestId(`price-source-${iapOnly}`)).toContainText("In-App Purchase key only works with the App Store Server API");
    await page.goto(`${base}/products/${monthly}`);
    const table = page.getByRole("table", { name: "Prices of focus_pro_monthly by territory" });
    await expect(table.getByRole("row").nth(1)).toContainText("USA · base");
    await expect(table.locator("tbody tr")).toHaveCount(12);
    await expect(page.getByText("Store status")).toBeVisible();
  });

  await test.step("Product editor, App Store: download, a broken file, every error, the review, commit, a partial failure, retry, Files", async () => {
    await page.goto(`${base}/products`);
    await page.getByRole("link", { name: /Product editor/ }).click();
    await expect(page.getByTestId("pe-count")).toHaveText("0 selected of 5 products");
    await page.getByRole("checkbox", { name: "Select focus_pro_monthly" }).check();
    await page.getByRole("checkbox", { name: "Select focus_lifetime" }).check();
    await expect(page.getByTestId("pe-count")).toHaveText("2 selected of 5 products");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download .csv" }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^focus-ios-app-store-products-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync(await dl.path(), "utf8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe("store_identifier,display_name,type,duration,group,territory,currency,price,action");
    expect(lines[1]).toBe("focus_pro_monthly,Focus Pro Monthly,subscription,P1M,Focus Pro,USA,USD,9.99,");
    expect(lines).toHaveLength(25);

    writeFileSync(join(dir, "broken.csv"), `${lines[0]}\r\n"focus_pro_monthly,unterminated,USA\r\n`);
    await page.locator("#pe-file").setInputFiles(join(dir, "broken.csv"));
    await expect(page.getByTestId("pe-errors")).toContainText("The quote opened on line 2 is never closed.");
    await page.getByRole("button", { name: "Upload a corrected file" }).click();

    writeFileSync(join(dir, "bad.csv"), [lines[0],
      "focus_pro_monthly,,,,,USA,USD,abc,", "focus_pro_monthly,,,,,GBR,GBP,7.49,", "focus_pro_monthly,,,,,GBR,GBP,8.99,",
      "focus_pro_yearly,,,,,USA,USD,49.99,", "focus_lifetime,,,,,DEU,USD,99.99,", "focus_lifetime,,,,,JPN,JPY,15000.5,"].join("\r\n"));
    await page.locator("#pe-file").setInputFiles(join(dir, "bad.csv"));
    const problems = page.getByTestId("pe-errors");
    await expect(problems).toContainText("The file has 5 problems. Nothing was changed.");
    await expect(problems).toContainText('Line 2: price "abc" is not a number such as 9.99.');
    await expect(problems).toContainText("Line 4: focus_pro_monthly in GBR is on lines 3 and 4. Keep one of them.");
    await expect(problems).toContainText("Line 5: focus_pro_yearly is not in App Store Connect for this app.");
    await expect(problems).toContainText("Line 6: The currency of DEU is EUR, not USD.");
    await expect(problems).toContainText('Line 7: JPY prices have no decimals; "15000.5" has 1.');
    await expect(page.getByRole("button", { name: /^Commit/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Upload a corrected file" }).click();

    // ¥1,600 is not an App Store price point; the new subscription's GBR price meets an outage once.
    writeFileSync(join(dir, "good.csv"), edited(csv, [["focus_pro_monthly", "USA", "10.99"], ["focus_pro_monthly", "JPN", "1600"], ["focus_lifetime", "USA", "119.99"]],
      ["focus_pro_quarterly,Focus Pro Quarterly,subscription,P3M,Focus Pro,USA,USD,24.99,create", "focus_pro_quarterly,,,,,GBR,GBP,19.99,create"]));
    await page.locator("#pe-file").setInputFiles(join(dir, "good.csv"));
    await expect(page.getByTestId("pe-summary")).toContainText("Price changes3");
    await expect(page.getByTestId("pe-summary")).toContainText("New products1");
    await expect(page.getByTestId("pe-summary")).toContainText("Unchanged rows21");
    const diff = page.getByTestId("pe-diff");
    const usaRow = diff.getByRole("region", { name: "Changes to focus_pro_monthly" }).getByRole("row", { name: /^USA USD/ });
    await expect(usaRow).toContainText("$10.99");
    await expect(usaRow).toContainText("+10%");
    await expect(diff.getByRole("region", { name: "Changes to focus_pro_quarterly" })).toContainText("New subscription · 3 months · group Focus Pro");
    await expect(page.getByLabel("Keep existing subscribers on their current price")).toBeChecked();
    await page.getByLabel("Keep existing subscribers on their current price").uncheck();
    await expect(page.getByLabel("Keep existing subscribers on their current price")).not.toBeChecked();
    expect((await page.request.post(`${WEB}/__stores/editor/fail`, { data: { store: "asc", method: "POST", path_includes: "/v1/subscriptionPrices", territory: "GBR", status: 500, message: "An unexpected error occurred on the server side.", times: 1 } })).ok()).toBe(true);
    await page.getByRole("button", { name: "Commit 5 changes to App Store Connect" }).click();
    await page.getByRole("dialog", { name: "Commit to App Store Connect?" }).getByRole("button", { name: "Commit 5 changes" }).click();
    await expect(page.getByTestId("pe-status")).toHaveText("Partly committed", { timeout: 30_000 });
    await expect(diff.getByRole("row", { name: /^JPN JPY/ })).toContainText("The App Store has no price of 1600 JPY in JPN. The nearest App Store prices are 1500 and 1650.");
    await expect(diff.getByRole("region", { name: "Changes to focus_pro_quarterly" }).getByRole("row", { name: /^GBR GBP/ })).toContainText("App Store Connect is not responding");
    expect((await storePrice("asc", "focus_pro_monthly", "USA")).price).toBe("10.99");
    expect((await storePrice("asc", "focus_lifetime", "USA")).price).toBe("119.99");
    expect((await storePrice("asc", "focus_pro_quarterly", "USA")).price).toBe("24.99");
    await page.getByRole("button", { name: "Retry 2 failed" }).click();
    await expect(page.getByRole("button", { name: "Retry 1 failed" })).toBeVisible({ timeout: 30_000 });
    expect((await storePrice("asc", "focus_pro_quarterly", "GBR")).price).toBe("19.99");
    await page.screenshot({ path: join(dir, "results.png") });

    await page.goto(`${base}/product-editor?app=${ios}`);
    await page.getByRole("tab", { name: /Files/ }).click();
    const files = page.getByRole("table");
    await expect(files.getByRole("row", { name: /good\.csv/ })).toContainText("Partly committed");
    await expect(files.getByRole("row", { name: /good\.csv/ })).toContainText("4 ok · 1 failed");
    await expect(files.getByRole("row", { name: /bad\.csv/ })).toContainText("5 errors");
    await expect(files.getByRole("row", { name: /broken\.csv/ })).toContainText("1 error");
    // The audit log has every store write with its outcome.
    const audit = await api<{ items: { action_type: string; target_identifier: string; additional_data: Record<string, unknown> }[] }>("GET", `${P}/audit_logs?limit=50`);
    const writes = audit.body.items.filter((a) => a.action_type === "store_price_changed");
    expect(writes.filter((a) => a.additional_data.result === "failed")).toHaveLength(3);
    expect(writes.filter((a) => a.additional_data.result === "succeeded")).toHaveLength(4);
    expect(audit.body.items.some((a) => a.action_type === "store_product_created" && a.target_identifier === "focus_pro_quarterly")).toBe(true);
    // The Products page shows the committed prices.
    await page.goto(`${base}/products`);
    await expect(page.getByRole("region", { name: "Focus iOS products" }).getByRole("row", { name: /focus_pro_monthly/ })).toContainText("$10.99/month");
  });

  await test.step("Product editor, Google Play: one-time products not selectable, a price Play refuses, a new base plan", async () => {
    await page.goto(`${base}/product-editor?app=${android}`);
    await expect(page.getByTestId("pe-play-note")).toContainText("Play Store one-time purchases aren't supported yet.");
    await expect(page.getByRole("checkbox", { name: "Select focus_unlock" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Select all products" }).check();
    await expect(page.getByTestId("pe-count")).toHaveText("3 selected of 3 products");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download .csv" }).click()]);
    const csv = readFileSync(await dl.path(), "utf8");
    writeFileSync(join(dir, "play.csv"), edited(csv, [["premium:monthly", "US", "10.99"], ["premium:monthly", "GB", "0.10"], ["family:yearly", "US", "84.99"]], ["premium:weekly,Focus Premium,subscription,P1W,,US,USD,2.99,create"]));
    await page.locator("#pe-file").setInputFiles(join(dir, "play.csv"));
    await expect(page.locator(".pe-warn")).toContainText("premium:monthly in GB changes by -98.7% (7.99 → 0.10)");
    await page.getByRole("button", { name: "Commit 4 changes to Google Play" }).click();
    await page.getByRole("dialog", { name: "Commit to Google Play?" }).getByRole("button", { name: "Commit 4 changes" }).click();
    await expect(page.getByTestId("pe-status")).toHaveText("Partly committed", { timeout: 30_000 });
    // The three rows of the premium patch share Play's refusal; family's patch went through.
    const premium = page.getByTestId("pe-diff").getByRole("region", { name: "Changes to premium:monthly" });
    await expect(premium.getByRole("row", { name: /^GB GBP/ })).toContainText("Google Play: Price for region GB is out of the allowed range");
    await expect(premium.getByRole("row", { name: /^US USD/ })).toContainText("Failed");
    expect((await storePrice("play", "family:yearly", "US")).price).toBe(84.99);
    expect((await storePrice("play", "premium:monthly", "US")).price).toBe(9.99);
    // A corrected file: the prices and the new base plan, activated (family's committed price is unchanged now).
    writeFileSync(join(dir, "play-fixed.csv"), edited(csv, [["premium:monthly", "US", "10.99"], ["premium:monthly", "GB", "8.49"], ["family:yearly", "US", "84.99"]], ["premium:weekly,Focus Premium,subscription,P1W,,US,USD,2.99,create"]));
    await page.getByRole("button", { name: "Back to products" }).click();
    await page.locator("#pe-file").setInputFiles(join(dir, "play-fixed.csv"));
    await page.getByRole("button", { name: "Commit 3 changes to Google Play" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Commit 3 changes" }).click();
    await expect(page.getByTestId("pe-status")).toHaveText("Committed", { timeout: 30_000 });
    expect(await storePrice("play", "premium:monthly", "GB")).toMatchObject({ price: 8.49 });
    expect(await storePrice("play", "premium:weekly", "US")).toMatchObject({ price: 2.99, exists: true, state: "ACTIVE" });
  });

  await test.step("Create with AI: products approved, an offering denied and then approved", async () => {
    await page.goto(`${base}/products`);
    await page.getByRole("button", { name: "New product", exact: true }).click();
    await page.getByRole("menuitem", { name: "Create with AI" }).click();
    const dlg = page.getByRole("dialog", { name: "Create products with AI" });
    await dlg.getByRole("button", { name: "Draft with RevenueDot AI" }).click();
    await expect(dlg.getByRole("alert")).toContainText("Describe the products to create");
    await dlg.getByLabel("What do you sell?").fill("Pro: $7.99 monthly and $49.99 yearly on the Test Store, attached to pro");
    await dlg.getByRole("button", { name: "Draft with RevenueDot AI" }).click();
    await page.waitForURL(/\/ai\//);
    const card = page.getByTestId("approval-card");
    await expect(card).toContainText("Create 2 products and attach them to pro?", { timeout: 30_000 });
    await expect(card.getByTestId("approval-rows")).toContainText("pro_annual");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Created 1 products, skipped 1 that already existed and attached them to pro/)).toBeVisible({ timeout: 30_000 });
    const tsProducts = await api<{ items: { store_identifier: string; indicative_price: { amount_micros: number } | null }[] }>("GET", `${P}/products?app_id=${ts}&expand=items.indicative_price`);
    expect(tsProducts.body.items.find((p) => p.store_identifier === "pro_annual")?.indicative_price?.amount_micros).toBe(49_990_000);

    const draftOffering = async () => {
      await page.goto(`${base}/offerings`);
      await page.getByRole("button", { name: "New offering" }).first().click();
      await page.getByRole("menuitem", { name: "Create with AI" }).click();
      const d = page.getByRole("dialog", { name: "Create an offering with AI" });
      await d.getByLabel("What should the offering show?").fill("An offering called default with every Pro plan, and make it current");
      await d.getByRole("button", { name: "Draft with RevenueDot AI" }).click();
      await page.waitForURL(/\/ai\//);
      await expect(page.getByTestId("approval-card")).toContainText("Create the offering default with", { timeout: 30_000 });
      return page.getByTestId("approval-card");
    };
    await (await draftOffering()).getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText("OK, I did not change anything.")).toBeVisible({ timeout: 30_000 });
    expect((await api<{ items: unknown[] }>("GET", `${P}/offerings`)).body.items).toHaveLength(0);
    await (await draftOffering()).getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Created the offering default with \d packages; it is now the current offering/)).toBeVisible({ timeout: 30_000 });
    const offerings = await api<{ items: { lookup_key: string; is_current: boolean }[] }>("GET", `${P}/offerings`);
    expect(offerings.body.items).toEqual([expect.objectContaining({ lookup_key: "default", is_current: true })]);
  });

  await test.step("A viewer reads and downloads; uploads, commits, refreshes and Create with AI are not offered", async () => {
    const viewerEmail = `viewer-${stamp}@revenuedot.test`;
    expect((await api("POST", `${P}/invites`, { email: viewerEmail, role: "viewer" })).status).toBe(201);
    const mails = await (await page.request.get(`${WEB}/__mail?to=${encodeURIComponent(viewerEmail)}`)).json() as { text: string }[];
    const token = decodeURIComponent(/invite\?token=([^\s&]+)/.exec(mails[mails.length - 1]!.text)![1]!);
    const ctx = await browser.newContext({ baseURL: WEB });
    const viewer = await ctx.newPage();
    const viewerErrors = watchConsole(viewer);
    expect((await viewer.request.post(`${WEB}/auth/signup`, { data: { email: viewerEmail, password: `e2e-${stamp}-viewer`, name: "Vic", invite_token: token } })).status()).toBe(201);
    await viewer.goto(`${base}/products`);
    await expect(viewer.getByTestId(`price-source-${ios}`)).toContainText("read");
    await expect(viewer.getByRole("button", { name: /Refresh prices/ })).toHaveCount(0);
    await viewer.getByRole("button", { name: "New product", exact: true }).click();
    await expect(viewer.getByRole("menuitem", { name: /Create with AI/ })).toBeDisabled();
    await expect(viewer.getByRole("menuitem", { name: /Create with AI/ })).toContainText("Your role (Viewer) can read only.");
    await viewer.keyboard.press("Escape");
    await viewer.goto(`${base}/product-editor?app=${ios}`);
    await expect(viewer.getByRole("note")).toContainText("Only admins and developers can upload and commit changes to the stores.");
    await expect(viewer.getByTestId("pe-drop")).toHaveCount(0);
    await viewer.getByRole("checkbox", { name: "Select focus_lifetime" }).check();
    const [dl] = await Promise.all([viewer.waitForEvent("download"), viewer.getByRole("button", { name: "Download .csv" }).click()]);
    expect(dl.suggestedFilename()).toMatch(/\.csv$/);
    const r = await viewer.request.post(`${WEB}${P}/product_edits`, { data: { app_id: ios, csv: "store_identifier,territory,currency,price\nfocus_lifetime,USA,USD,129.99" } });
    expect(r.status()).toBe(403);
    expect(viewerErrors).toEqual([]);
    await ctx.close();
  });

  await test.step("Phone width and dark theme", async () => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/products", `/product-editor?app=${ios}`, `/products/${monthly}`]) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");
      const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(scroll, `${path} scrolls sideways at 390px`).toBeLessThanOrEqual(client);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light" });
  });

  expect(errors).toEqual([]);
});
