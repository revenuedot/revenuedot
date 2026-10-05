/**
 * Product catalog end to end: products, entitlements and offerings built through the dashboard UI, checked against the
 * REST API v2 and against what the SDK receives from GET /v1/subscribers/{id}/offerings (decoded with the SDK schema).
 *
 * Runs on the e2e server like the other specs (see e2e/README.md):
 *   pnpm --filter @revenuedot/dashboard e2e -- catalog
 * It signs up its own fresh account, so it neither needs nor touches the seeded demo data.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { OfferingsSchema } from "../../../packages/contract/src/sdk-schemas";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(`${path}`, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** What an SDK with this app's public key receives. */
async function sdkOfferings(req: APIRequestContext, key: string) {
  const res = await req.fetch(`/v1/subscribers/e2e_user/offerings`, { headers: { authorization: `Bearer ${key}`, "x-platform": "iOS" } });
  expect(res.status()).toBe(200);
  return OfferingsSchema.parse(await res.json());
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  // The browser logs every non-2xx response; the 409s this test provokes on purpose are expected.
  page.on("console", (m) => { if (m.type() === "error" && !/status of 409/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

test("product catalog: products, entitlement, offerings, default offering and the SDK view", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const req = page.request;
  const stamp = Date.now();

  // Fresh account; the session cookie lands in the browser context.
  await json(req, "POST", "/auth/signup", { email: `catalog-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Catalog e2e", project_name: "Catalog e2e" });
  const me = await json(req, "GET", "/auth/me");
  const pid: string = me.projects[0].id;
  const P = `/v2/projects/${pid}`;
  const base = `/projects/${pid}/product-catalog`;

  // Apps come from the Apps page (another area); create them through the API.
  const ios = await json(req, "POST", `${P}/apps`, { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner" } });
  const android = await json(req, "POST", `${P}/apps`, { name: "Scanner Android", type: "play_store", play_store: { package_name: "com.example.scanner" } });
  const testStore = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const iosKey: string = (await json(req, "GET", `${P}/apps/${ios.id}/public_api_keys`)).items[0].key;

  await test.step("empty states explain the next step", async () => {
    await page.goto(`${base}/offerings`);
    await expect(page.getByRole("heading", { name: "No offerings yet" })).toBeVisible();
    await expect(page.getByText("Create your first product, then group products into an offering")).toBeVisible();
    await page.goto(`${base}/entitlements`);
    await expect(page.getByRole("heading", { name: "No entitlements yet" })).toBeVisible();
  });

  const newProduct = async (app: string, sid: string, type: "Subscription" | "Consumable" | "Non-consumable", duration: string | null, name: string) => {
    await page.getByRole("button", { name: "New product" }).first().click();
    await page.getByRole("menuitem", { name: "Create from scratch" }).click();
    const d = page.getByRole("dialog", { name: "New product" });
    await d.getByLabel("App", { exact: true }).selectOption({ label: app });
    await d.getByLabel("Store identifier").fill(sid);
    await d.getByRole("radio", { name: new RegExp(`^${type} `) }).locator("xpath=..").click();
    if (duration) await d.getByLabel("Duration").selectOption(duration);
    // Test Store products need a price (amount and currency, USD by default); it is what test purchases record.
    if (app.startsWith("Test Store")) {
      await d.getByRole("button", { name: "Create product" }).click();
      await expect(d.getByText("Enter the price, such as 9.99. Test purchases record it as revenue.")).toBeVisible();
      await d.getByLabel("Price amount").fill("0");
      await d.getByRole("button", { name: "Create product" }).click();
      await expect(d.getByText("Enter a price above 0, such as 9.99.")).toBeVisible();
      await d.getByLabel("Price amount").fill("79.99");
      await expect(d.getByLabel("Currency")).toHaveValue("USD");
    }
    await d.getByLabel("Display name").fill(name);
    await d.getByRole("button", { name: "Create product" }).click();
    return d;
  };

  await test.step("create app-scoped products; a duplicate store identifier is a 409 shown inline", async () => {
    await page.goto(`${base}/products`);
    await expect(page.getByRole("heading", { name: "No products yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Import products", exact: true }).first()).toBeVisible();
    await expect((await newProduct("Scanner iOS (App Store)", "pro_monthly", "Subscription", "P1M", "Pro monthly"))).toBeHidden();
    await expect(page.getByText("Product pro_monthly created")).toBeVisible();
    const dup = await newProduct("Scanner iOS (App Store)", "pro_monthly", "Subscription", "P1M", "Again");
    await expect(dup.getByText("Scanner iOS already has a product with this identifier.")).toBeVisible();
    await dup.getByRole("button", { name: "Cancel" }).click();
    await newProduct("Scanner iOS (App Store)", "pro_annual", "Subscription", "P1Y", "Pro annual");
    await newProduct("Scanner Android (Google Play)", "pro:monthly", "Subscription", "P1M", "Pro monthly");
    await newProduct("Scanner Android (Google Play)", "pro:annual", "Subscription", "P1Y", "Pro annual");
    await newProduct("Test Store (Test Store)", "lifetime", "Non-consumable", null, "Lifetime");
    const iosPanel = page.getByRole("region", { name: "Scanner iOS products" });
    await expect(iosPanel.getByRole("row")).toHaveCount(3); // header + 2
    await expect(iosPanel.getByText("pro_annual")).toBeVisible();
    await expect(iosPanel.getByRole("cell", { name: "1 year", exact: true })).toBeVisible();
    const products = (await json(req, "GET", `${P}/products?limit=100`)).items;
    expect(products).toHaveLength(5);
    expect(products.find((p: any) => p.store_identifier === "pro:annual")).toMatchObject({ app_id: android.id, type: "subscription", subscription: { duration: "P1Y" }, display_name: "Pro annual" });
    expect(products.find((p: any) => p.store_identifier === "lifetime")).toMatchObject({ app_id: testStore.id, type: "non_consumable" });
  });

  let entId = "";
  await test.step("entitlement: create, 409 inline, attach products, detach one", async () => {
    await page.goto(`${base}/entitlements`);
    await page.getByRole("button", { name: "New entitlement" }).first().click();
    let d = page.getByRole("dialog", { name: "New entitlement" });
    await d.getByLabel("Identifier").fill("pro");
    await d.getByLabel("Display name").fill("Pro access");
    await d.getByRole("button", { name: "Create entitlement" }).click();
    await expect(page.getByRole("heading", { name: "pro", exact: true })).toBeVisible();
    entId = page.url().split("/").pop()!;
    await expect(page.getByText("No products unlock this entitlement yet.")).toBeVisible();

    await page.getByRole("button", { name: "Attach" }).click();
    d = page.getByRole("dialog", { name: "Attach products to pro" });
    for (const box of await d.getByRole("checkbox").all()) await box.check();
    await d.getByRole("button", { name: "Attach 5 products" }).click();
    await expect(page.getByText("5 products attached to pro")).toBeVisible();
    await page.getByRole("button", { name: "Detach lifetime" }).click();
    await page.getByRole("dialog", { name: "Detach this product?" }).getByRole("button", { name: "Detach" }).click();
    await expect(page.getByText("lifetime detached")).toBeVisible();
    const ent = await json(req, "GET", `${P}/entitlements/${entId}?expand=product`);
    expect(ent.products.items.map((p: any) => p.store_identifier).sort()).toEqual(["pro:annual", "pro:monthly", "pro_annual", "pro_monthly"]);

    await page.goto(`${base}/entitlements`);
    await page.getByRole("button", { name: "New entitlement" }).first().click();
    d = page.getByRole("dialog", { name: "New entitlement" });
    await d.getByLabel("Identifier").fill("pro");
    await d.getByLabel("Display name").fill("Duplicate");
    await d.getByRole("button", { name: "Create entitlement" }).click();
    await expect(d.getByText("An entitlement with this identifier already exists.")).toBeVisible();
    await d.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("row", { name: /pro Pro access 4 products/ })).toBeVisible();
  });

  const pkg = (n: number) => page.getByRole("region", { name: `Package ${n}` });

  await test.step("new offering with packages, per-app products, inline new product and metadata validation", async () => {
    await page.goto(`${base}/offerings`);
    await page.getByRole("button", { name: "New offering" }).first().click();
    await page.getByRole("menuitem", { name: "Create from scratch" }).click();
    await expect(page.getByRole("heading", { name: "New offering" })).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Enter an identifier for the offering.")).toBeVisible();
    await page.getByLabel("Identifier", { exact: true }).fill("default");
    await page.getByLabel("Display name").fill("The standard set of packages");

    await page.getByRole("button", { name: "Add package" }).click();
    await pkg(1).getByLabel("Identifier *").selectOption({ label: "Monthly" });
    await expect(pkg(1).getByLabel("Description *")).toHaveValue("Monthly");
    await pkg(1).getByLabel("Product for Scanner iOS").selectOption({ label: "Pro monthly · pro_monthly" });
    await pkg(1).getByLabel("Product for Scanner Android").selectOption({ label: "Pro monthly · pro:monthly" });

    await page.getByRole("button", { name: "New package" }).click();
    await pkg(2).getByLabel("Identifier *").selectOption({ label: "Annual" });
    await pkg(2).getByLabel("Description *").fill("Annual with 3-day trial");
    await pkg(2).getByLabel("Product for Scanner iOS").selectOption({ label: "Pro annual · pro_annual" });
    await pkg(2).getByLabel("Product for Scanner Android").selectOption({ label: "Pro annual · pro:annual" });
    // Inline "New product" for the Test Store app selects the new product.
    await pkg(2).locator(".cat-prow", { hasText: "Test Store" }).getByRole("button", { name: "New product" }).click();
    const d = page.getByRole("dialog", { name: "New product" });
    await expect(d.getByLabel("App", { exact: true })).toBeDisabled();
    await d.getByLabel("Store identifier").fill("annual_test");
    await d.getByLabel("Duration").selectOption("P1Y");
    await d.getByLabel("Price amount").fill("29.99");
    await d.getByRole("button", { name: "Create product" }).click();
    await expect(d).toBeHidden();
    await expect(pkg(2).getByLabel("Product for Test Store")).toHaveValue(/^prod/);

    await page.getByRole("tab", { name: "Metadata" }).click();
    await page.getByLabel("Metadata (JSON)").fill('{"paywall_title": "Go Pro",');
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/^Invalid JSON/).first()).toBeVisible();
    await page.getByLabel("Metadata (JSON)").fill('{"paywall_title": "Go Pro", "highlight": "$rc_annual"}');
    await expect(page.getByText("Valid JSON object")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByText("Offering default created")).toBeVisible();
    await expect(page.getByRole("heading", { name: "default", exact: true })).toBeVisible();
    await expect(page.getByText("This is the default offering.")).toBeVisible();
    const offs = (await json(req, "GET", `${P}/offerings?expand=items.package.product`)).items;
    expect(offs).toHaveLength(1);
    expect(offs[0]).toMatchObject({ lookup_key: "default", is_current: true, metadata: { paywall_title: "Go Pro", highlight: "$rc_annual" } });
    expect(offs[0].packages.items.map((p: any) => [p.lookup_key, p.display_name, p.position])).toEqual([["$rc_monthly", "Monthly", 0], ["$rc_annual", "Annual with 3-day trial", 1]]);
    expect(offs[0].packages.items[1].products.items.map((x: any) => x.product.store_identifier).sort()).toEqual(["annual_test", "pro:annual", "pro_annual"]);

    const sdk = await sdkOfferings(req, iosKey);
    expect(sdk.current_offering_id).toBe("default");
    expect(sdk.offerings[0]!.packages).toEqual([
      { identifier: "$rc_monthly", platform_product_identifier: "pro_monthly" },
      { identifier: "$rc_annual", platform_product_identifier: "pro_annual" },
    ]);
    expect(sdk.offerings[0]!.metadata).toEqual({ paywall_title: "Go Pro", highlight: "$rc_annual" });
  });

  await test.step("a duplicate offering identifier is a 409 shown inline; custom package identifiers are validated", async () => {
    await page.goto(`${base}/offerings/new`);
    await page.getByLabel("Identifier", { exact: true }).fill("default");
    await page.getByLabel("Display name").fill("Sale");
    await page.getByRole("button", { name: "Add package" }).click();
    await pkg(1).getByLabel("Identifier *").selectOption({ label: "Custom" });
    await pkg(1).getByLabel("Custom package identifier").fill("$rc_intro");
    await pkg(1).getByLabel("Description *").fill("Intro annual");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pkg(1).getByText("Identifiers starting with $rc_ are reserved.", { exact: false })).toBeVisible();
    await pkg(1).getByLabel("Custom package identifier").fill("annual_intro");
    await pkg(1).getByLabel("Product for Scanner iOS").selectOption({ label: "Pro annual · pro_annual" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("An offering with this identifier already exists. Identifiers are unique per project.")).toBeVisible();
    await page.getByLabel("Identifier", { exact: true }).fill("sale");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Offering sale created")).toBeVisible();
    await expect(page.getByText("It is not the default.")).toBeVisible();
  });

  await test.step("make default from the row menu; the SDK's current offering follows", async () => {
    await page.goto(`${base}/offerings`);
    await expect(page.getByText("Default offering").first()).toBeVisible();
    // Keyboard only: open the row menu, arrow to "Make default", confirm with Enter.
    await page.getByRole("button", { name: "Actions for sale" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Make default" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Make this the default offering?" }).getByRole("button", { name: "Make default" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("sale is now the default offering")).toBeVisible();
    await expect(page.getByRole("row", { name: /^sale\s+Default/ })).toBeVisible();
    expect((await sdkOfferings(req, iosKey)).current_offering_id).toBe("sale");
    // The current offering cannot be made inactive.
    await page.getByRole("button", { name: "Actions for sale" }).click();
    await expect(page.getByRole("menuitem", { name: /Make inactive/ })).toBeDisabled();
    await page.keyboard.press("Escape");
  });

  await test.step("duplicate, make inactive, make active and delete", async () => {
    await page.getByRole("button", { name: "Actions for default" }).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    const d = page.getByRole("dialog", { name: "Duplicate default" });
    await expect(d.getByLabel("Identifier")).toHaveValue("default_copy");
    await d.getByRole("button", { name: "Duplicate" }).click();
    await expect(page.getByRole("heading", { name: "default_copy", exact: true })).toBeVisible();
    const copy = (await json(req, "GET", `${P}/offerings?expand=items.package.product`)).items.find((o: any) => o.lookup_key === "default_copy");
    expect(copy).toMatchObject({ is_current: false, metadata: { paywall_title: "Go Pro" } });
    expect(copy.packages.items.map((p: any) => p.products.items.length)).toEqual([2, 3]);

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Make inactive" }).click();
    await page.getByRole("dialog", { name: "Make this offering inactive?" }).getByRole("button", { name: "Make inactive" }).click();
    await expect(page.getByText("default_copy is inactive")).toBeVisible();
    expect((await sdkOfferings(req, iosKey)).offerings.map((o) => o.identifier)).not.toContain("default_copy");

    await page.goto(`${base}/offerings`);
    await page.getByRole("button", { name: "Inactive", exact: true }).click();
    await expect(page.getByRole("row", { name: /default_copy/ })).toBeVisible();
    await page.getByRole("button", { name: "Actions for default_copy" }).click();
    await page.getByRole("menuitem", { name: "Make active" }).click();
    await page.getByRole("dialog", { name: "Make this offering active?" }).getByRole("button", { name: "Make active" }).click();
    await expect(page.getByText("default_copy is active")).toBeVisible();
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: "Actions for default_copy" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const del = page.getByRole("dialog", { name: "Delete this offering?" });
    await expect(del.getByText("offerings[\"default_copy\"]", { exact: false })).toBeVisible();
    await del.getByRole("button", { name: "Delete offering" }).click();
    await expect(page.getByText("default_copy deleted")).toBeVisible();
    expect((await json(req, "GET", `${P}/offerings`)).items.map((o: any) => o.lookup_key).sort()).toEqual(["default", "sale"]);
  });

  await test.step("edit: reorder packages with the keyboard, rename, remove a product", async () => {
    await page.getByRole("link", { name: "default", exact: true }).click();
    await page.getByRole("link", { name: "Edit" }).click();
    await expect(page.getByLabel("Identifier", { exact: true })).toBeDisabled();
    await pkg(1).getByRole("button", { name: /Reorder package 1/ }).press("ArrowDown");
    await expect(pkg(1).getByLabel("Identifier *")).toHaveValue("$rc_annual");
    await pkg(1).getByLabel("Description *").fill("Annual");
    await pkg(1).getByLabel("Product for Scanner Android").selectOption("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Offering saved")).toBeVisible();
    const o = (await json(req, "GET", `${P}/offerings?expand=items.package.product`)).items.find((x: any) => x.lookup_key === "default");
    const pkgs = [...o.packages.items].sort((a: any, b: any) => a.position - b.position);
    expect(pkgs.map((p: any) => [p.lookup_key, p.display_name])).toEqual([["$rc_annual", "Annual"], ["$rc_monthly", "Monthly"]]);
    expect(pkgs[0].products.items.map((x: any) => x.product.store_identifier).sort()).toEqual(["annual_test", "pro_annual"]);
    await expect(page.getByText("No product. Scanner Android does not show this package.")).toBeVisible();
  });

  await test.step("Test Store prices by currency: add, validate, change the default, remove; the SDK shows the storefront's currency", async () => {
    const lifetime = (await json(req, "GET", `${P}/products?limit=100`)).items.find((p: any) => p.store_identifier === "lifetime");
    const testKey: string = (await json(req, "GET", `${P}/apps/${testStore.id}/public_api_keys`)).items[0].key;
    await page.goto(`${base}/products/${lifetime.id}`);
    await expect(page.getByTestId("test-store-prices")).toHaveText("$79.99");
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const d = page.getByRole("dialog", { name: "Edit product" });
    const rows = d.getByTestId("price-row");
    await expect(rows).toHaveCount(1);
    await expect(d.getByLabel("Amount 1")).toHaveValue("79.99");
    await expect(d.getByRole("radio", { name: "Default price USD" })).toBeChecked();
    await d.getByRole("button", { name: "Add currency" }).click();
    await expect(d.getByLabel("Currency 2")).toHaveValue("EUR");
    await d.getByLabel("Amount 2").fill("74,99");
    await d.getByRole("button", { name: "Add currency" }).click();
    await expect(d.getByLabel("Currency 3")).toHaveValue("GBP");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d.getByText("Enter the price, such as 9.99, or remove the row.")).toBeVisible();
    await d.getByLabel("Amount 3").fill("64.99");
    await d.getByLabel("Currency 3").fill("EUR");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d.getByText("EUR is listed twice.")).toBeVisible();
    await d.getByLabel("Currency 3").fill("GBP");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d).toBeHidden();
    await expect(page.getByTestId("test-store-prices")).toHaveText("$79.99 default · €74.99 · £64.99");
    expect((await json(req, "GET", `${P}/products/${lifetime.id}/prices`)).map((p: any) => [p.currency, p.amount_micros])).toEqual([["USD", 79_990_000], ["EUR", 74_990_000], ["GBP", 64_990_000]]);
    const sdkPrice = async (storefront: string) => {
      const res = await req.fetch(`/rcbilling/v1/subscribers/e2e_user/products?id=lifetime`, { headers: { authorization: `Bearer ${testKey}`, "x-platform": "iOS", "x-storefront": storefront } });
      return (await res.json()).product_details[0].current_price;
    };
    expect(await sdkPrice("DEU")).toEqual({ amount: 74.99, amount_micros: 74_990_000, currency: "EUR" });
    expect(await sdkPrice("JPN")).toMatchObject({ currency: "USD", amount_micros: 79_990_000 });

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(rows).toHaveCount(3);
    await d.getByRole("radio", { name: "Default price EUR" }).check();
    await d.getByRole("button", { name: "Remove GBP price" }).click();
    await d.getByLabel("Amount 1").fill("89.99");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d).toBeHidden();
    await expect(page.getByTestId("test-store-prices")).toHaveText("€74.99 default · $89.99");
    expect((await json(req, "GET", `${P}/products/${lifetime.id}?expand=indicative_price`)).indicative_price).toMatchObject({ currency: "EUR", amount_micros: 74_990_000 });
    expect((await json(req, "GET", `${P}/products/${lifetime.id}/prices`)).map((p: any) => [p.currency, p.amount_micros])).toEqual([["EUR", 74_990_000], ["USD", 89_990_000]]);
    const amounts = async () => (await json(req, "GET", `${P}/products/${lifetime.id}/prices`)).map((p: any) => [p.currency, p.amount_micros]);

    // A price saved through the API with more decimals than the editor takes (¥1500.5) is kept when its row is left as is.
    await json(req, "POST", `${P}/products/${lifetime.id}/test_store_prices`, { prices: [{ currency: "JPY", amount_micros: 1_500_500_000 }] });
    await page.reload();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(rows).toHaveCount(3);
    // A currency added elsewhere while the editor is open (another tab, the API) is not removed by its save.
    await json(req, "POST", `${P}/products/${lifetime.id}/test_store_prices`, { prices: [{ currency: "CHF", amount_micros: 70_000_000 }] });
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d).toBeHidden();
    expect(await amounts()).toEqual([["EUR", 74_990_000], ["CHF", 70_000_000], ["JPY", 1_500_500_000], ["USD", 89_990_000]]);

    // Prices that cannot be loaded: Retry is offered, and the name still saves without touching the prices.
    const pricesUrl = `**/products/${lifetime.id}/prices`;
    await page.route(pricesUrl, (r) => (r.request().method() === "GET" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"message":"Unavailable"}' }) : r.continue()));
    await page.reload();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(d.getByText("The prices could not be loaded, so saving keeps them as they are.")).toBeVisible({ timeout: 20_000 });
    await expect(d.getByRole("button", { name: "Retry" })).toBeVisible();
    await d.getByLabel("Display name").fill("Lifetime access");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d).toBeHidden();
    await page.unroute(pricesUrl);
    expect((await json(req, "GET", `${P}/products/${lifetime.id}`)).display_name).toBe("Lifetime access");
    expect(await amounts()).toEqual([["EUR", 74_990_000], ["CHF", 70_000_000], ["JPY", 1_500_500_000], ["USD", 89_990_000]]);
    // The browser logs the 503s answered above on purpose.
    errors.splice(0, errors.length, ...errors.filter((e) => !/status of 503/.test(e)));
    // Back to the two prices the later steps expect.
    for (const c of ["CHF", "JPY"]) await json(req, "DELETE", `${P}/products/${lifetime.id}/prices/${c}`);
  });

  await test.step("products: archive, unarchive and delete with confirmation", async () => {
    await page.goto(`${base}/products`);
    await page.getByRole("button", { name: "Actions for lifetime" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByText("lifetime archived")).toBeVisible();
    await page.getByRole("button", { name: "Inactive", exact: true }).click();
    await expect(page.getByRole("row", { name: /lifetime/ })).toBeVisible();
    await page.getByRole("button", { name: "Actions for lifetime" }).click();
    await page.getByRole("menuitem", { name: "Unarchive" }).click();
    await expect(page.getByText("lifetime restored")).toBeVisible();
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: "Actions for lifetime" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog", { name: "Delete this product?" }).getByRole("button", { name: "Delete product" }).click();
    await expect(page.getByText("lifetime deleted")).toBeVisible();
    expect((await json(req, "GET", `${P}/products?limit=100`)).items.map((p: any) => p.store_identifier)).not.toContain("lifetime");
  });

  expect(errors, errors.join("\n")).toEqual([]);
});
