/**
 * Paywalls end to end (prd/paywalls/PRD.md): the three starts, the template gallery and its filters, create from a
 * template, the visual editor (select, edit a text, add a component, reorder, undo and redo, nest, a translation, dark
 * mode, problems), save, publish, what the SDK receives (offerings and remote config), versions, and "Generate with AI"
 * with the e2e server's fake model.
 *   E2E_PORT=5401 pnpm --filter @revenuedot/dashboard e2e -- paywalls
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
/** The texts of the tree rows, in order. */
const treeLabels = async (tree: Locator) => (await tree.locator(".pe-row .pe-label").allInnerTexts()).map((s) => s.trim());

test("paywalls: gallery, create from template, edit, translate, publish to the SDK, versions, AI", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `paywall-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Paywall e2e", project_name: "Lumen" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  const key = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  const monthly = await json(req, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_monthly", type: "subscription", subscription: { duration: "P1M" } });
  const annual = await json(req, "POST", `${P}/products`, { app_id: app.id, store_identifier: "pro_annual", type: "subscription", subscription: { duration: "P1Y" } });
  const offerings: Record<string, string> = {};
  for (const lkOff of ["default", "spring"]) {
    const off = await json(req, "POST", `${P}/offerings`, { lookup_key: lkOff, display_name: lkOff === "default" ? "Default" : "Spring" });
    offerings[lkOff] = off.id;
    for (const [lk, name, prod] of [["$rc_monthly", "Monthly", monthly], ["$rc_annual", "Annual", annual]] as const) {
      const pk = await json(req, "POST", `${P}/offerings/${off.id}/packages`, { lookup_key: lk, display_name: name });
      await json(req, "POST", `${P}/packages/${pk.id}/actions/attach_products`, { products: [{ product_id: prod.id, eligibility_criteria: "all" }] });
    }
  }
  const sdk = async () => (await (await req.fetch("/v1/subscribers/e2e_user/offerings", { headers: { authorization: `Bearer ${key}` } })).json()) as any;

  // 1. Three ways to start, as on RevenueCat's empty Paywalls page.
  await page.goto(`/projects/${pid}/paywalls`);
  const starts = page.getByRole("region", { name: "Start a paywall" });
  await expect(starts.getByRole("heading", { name: "No paywalls yet" })).toBeVisible();
  for (const h of ["Use a template", "Start from scratch", "Generate with AI"]) await expect(starts.getByRole("heading", { name: h })).toBeVisible();

  // 2. The gallery: ten live previews and four filters.
  await starts.getByRole("link", { name: "Select template" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/paywalls/templates`));
  const cards = page.getByRole("list", { name: "Templates" }).getByRole("listitem");
  await expect(cards).toHaveCount(10);
  await expect(page.getByRole("figure", { name: "Trial timeline preview" })).toContainText("How your free trial works");
  // Previews use the offering's packages with sample prices, and the project's name.
  await expect(page.getByRole("figure", { name: "Annual first preview" })).toContainText("Unlock Lumen");
  await expect(page.getByRole("figure", { name: "Annual first preview" })).toContainText("$39.99/yr");
  const filters = page.getByRole("complementary", { name: "Filters" });
  await filters.getByLabel("Single screen").uncheck();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Story pages");
  await filters.getByLabel("Single screen").check();
  await filters.getByLabel("In-app purchase").uncheck();
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Web checkout");
  await filters.getByLabel("In-app purchase").check();
  await filters.getByLabel("Number of tiers").selectOption("2");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Tiers");
  await filters.getByLabel("Number of tiers").selectOption("any");
  await filters.getByLabel("Number of packages").selectOption("1");
  await expect(cards.first()).toContainText("Limited offer");
  await filters.getByLabel("Number of packages").selectOption("any");
  await expect(cards).toHaveCount(10);

  // 3. Create from "Trial timeline" on the default offering.
  await page.getByRole("button", { name: "Use template Trial timeline" }).click();
  const dlg = page.getByRole("dialog", { name: "Use “Trial timeline”" });
  await dlg.getByLabel("Offering").selectOption(offerings.default!);
  await dlg.getByLabel("Terms URL").fill("https://example.com/terms");
  await dlg.getByLabel("Privacy URL").fill("https://example.com/privacy");
  await dlg.getByRole("button", { name: "Create paywall" }).click();
  await page.waitForURL(/\/paywalls\/pw/);
  const paywallId = page.url().split("/").pop()!;

  // 4. The editor: tree, preview and properties.
  const tree = page.getByRole("tree", { name: "Components" });
  const phone = page.getByRole("figure", { name: "Paywall preview" });
  const props = page.getByRole("region", { name: "Properties" });
  await expect(phone).toContainText("How your free trial works");
  await expect(phone).toContainText("$39.99/yr");
  await expect(page.getByRole("button", { name: "No problems" })).toBeVisible();
  // Select the headline by clicking it in the preview, and change it.
  await phone.getByText("How your free trial works").click();
  await expect(props.getByText("Text", { exact: true }).first()).toBeVisible();
  const text = props.getByRole("textbox").first();
  await text.fill("Scan without limits");
  await expect(phone).toContainText("Scan without limits");
  await expect(tree.getByRole("treeitem", { name: /Scan without limits/ })).toHaveAttribute("aria-selected", "true");
  // Font size from the properties panel.
  await props.getByLabel("Font size").fill("32");
  await expect(phone.getByText("Scan without limits")).toHaveCSS("font-size", "32px");

  // Add a text after the headline, write it, then move it above the headline.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Text", exact: true }).click();
  await expect(phone).toContainText("New text");
  await props.getByRole("textbox").first().fill("Cancel anytime in two taps");
  let labels = await treeLabels(tree);
  expect(labels.indexOf("Cancel anytime in two taps")).toBe(labels.indexOf("Scan without limits") + 1);
  await tree.getByRole("button", { name: "Move Cancel anytime in two taps up" }).click();
  labels = await treeLabels(tree);
  expect(labels.indexOf("Cancel anytime in two taps")).toBe(labels.indexOf("Scan without limits") - 1);
  // Undo the move, redo it, undo again (keyboard), so the new text ends up under the headline.
  await page.getByRole("button", { name: "Undo" }).click();
  labels = await treeLabels(tree);
  expect(labels.indexOf("Cancel anytime in two taps")).toBe(labels.indexOf("Scan without limits") + 1);
  await page.getByRole("button", { name: "Redo" }).click();
  labels = await treeLabels(tree);
  expect(labels.indexOf("Cancel anytime in two taps")).toBe(labels.indexOf("Scan without limits") - 1);
  await tree.focus();
  await page.keyboard.press("Alt+ArrowDown");
  labels = await treeLabels(tree);
  expect(labels.indexOf("Cancel anytime in two taps")).toBe(labels.indexOf("Scan without limits") + 1);
  // Duplicate and remove.
  await tree.getByRole("button", { name: "Duplicate Cancel anytime in two taps" }).click();
  expect((await treeLabels(tree)).filter((l) => l === "Cancel anytime in two taps")).toHaveLength(2);
  await tree.getByRole("button", { name: "Remove Cancel anytime in two taps" }).last().click();
  expect((await treeLabels(tree)).filter((l) => l === "Cancel anytime in two taps")).toHaveLength(1);

  // Package binding: the yearly card is selected; select monthly in the preview and the override (selected border) moves.
  const pkgCards = phone.locator('[data-pw-type="package"]');
  await expect(pkgCards).toHaveCount(2);
  await expect(page.getByLabel("Selected package in preview")).toHaveValue("");
  await pkgCards.nth(1).click();
  await expect(page.getByLabel("Selected package in preview")).toHaveValue("$rc_monthly");
  await tree.getByRole("treeitem", { name: /^Monthly Package/ }).click();
  await expect(props.getByLabel("Package", { exact: true })).toHaveValue("$rc_monthly");

  // A component the SDK cannot render without a URL shows as a problem and blocks publishing.
  await tree.getByRole("treeitem", { name: /Scan without limits/ }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: "Video" }).click();
  await expect(page.getByRole("button", { name: /1 problem/ })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("url must be a URL");
  await props.getByLabel("URL", { exact: true }).fill("https://example.com/demo.mp4");
  await expect(page.getByRole("button", { name: "No problems" })).toBeVisible();
  await tree.getByRole("button", { name: /^Remove https:\/\/example.com\/demo.mp4/ }).click();

  // Translation: add Spanish, translate the headline, preview it in Spanish and in dark mode.
  await page.getByRole("tab", { name: /Localizations/ }).click();
  const loc = page.getByRole("region", { name: "Localizations" });
  await loc.getByLabel("Add language").selectOption("es_ES");
  await loc.getByRole("button", { name: "Add", exact: true }).click();
  const enCells = loc.locator("textarea[aria-label$=' in en_US']");
  const count = await enCells.count();
  let row = -1;
  for (let i = 0; i < count; i++) if ((await enCells.nth(i).inputValue()) === "Scan without limits") row = i;
  expect(row).toBeGreaterThanOrEqual(0);
  await loc.locator("textarea[aria-label$=' in es_ES']").nth(row).fill("Escanea sin límites");
  await expect(loc.getByText(/missing/)).toBeVisible();
  await page.getByRole("tab", { name: "Design" }).click();
  await page.getByLabel("Locale").selectOption("es_ES");
  await expect(phone).toContainText("Escanea sin límites");
  // Untranslated strings show the English text.
  await expect(phone).toContainText("Cancel anytime in two taps");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(phone.locator(".pwr-screen")).toHaveCSS("background-color", "rgb(10, 10, 10)");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByLabel("Locale").selectOption("en_US");

  // 5. Save, then publish: the SDK gets it from offerings and from remote config.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  expect((await sdk()).offerings.find((o: any) => o.identifier === "default").has_paywall_components).toBe(false);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/^Published\. Apps get it/)).toBeVisible();
  const off = (await sdk()).offerings.find((o: any) => o.identifier === "default");
  expect(off.has_paywall_components).toBe(true);
  const en = off.paywall_components.components_localizations.en_US;
  expect(Object.values(en)).toEqual(expect.arrayContaining(["Scan without limits", "Cancel anytime in two taps", "https://example.com/terms"]));
  expect(off.paywall_components.components_localizations.es_ES).toMatchObject({ ...Object.fromEntries(Object.entries(en).filter(([, v]) => v !== "Scan without limits")) });
  expect(Object.values(off.paywall_components.components_localizations.es_ES)).toContain("Escanea sin límites");
  const types = new Set<string>();
  JSON.stringify(off.paywall_components.components_config, (k, v) => { if (k === "type" && typeof v === "string") types.add(v); return v; });
  expect([...types]).toEqual(expect.arrayContaining(["timeline", "package", "purchase_button", "icon", "button"]));
  const cfg = await req.fetch("/v1/config/app", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, data: { fetch_context: "app_start", app_user_id: "e2e_user" } });
  expect(cfg.status()).toBe(200);
  expect(Buffer.from(await cfg.body()).toString("latin1")).toContain(`"offering_identifier":"default"`);
  // Icons in the published paywall resolve.
  const iconUrl = /"base_url":"([^"]+)","icon_name":"(\w+)"/.exec(JSON.stringify(off.paywall_components))!;
  expect((await req.fetch(`${new URL(iconUrl[1]!).pathname}/${iconUrl[2]}.png`)).headers()["content-type"]).toBe("image/png");
  await expect(page.getByText("Published", { exact: true })).toBeVisible();

  // 6. Versions: save one, change the headline, restore.
  await page.getByRole("button", { name: "Paywall actions" }).click();
  await page.getByRole("menuitem", { name: "Save a version…" }).click();
  const ver = page.getByRole("dialog", { name: "Versions" });
  await ver.getByLabel("Save the current draft as").fill("Launch");
  await ver.getByRole("button", { name: "Save version" }).click();
  await expect(ver.getByRole("list", { name: "Saved versions" })).toContainText("Launch");
  await ver.getByRole("button", { name: "Close", exact: true }).last().click();
  await phone.getByText("Scan without limits").click();
  await props.getByRole("textbox").first().fill("Changed headline");
  await page.getByRole("button", { name: "Paywall actions" }).click();
  await page.getByRole("menuitem", { name: "Save a version…" }).click();
  await ver.getByRole("button", { name: "Restore" }).first().click();
  await expect(page.getByText("Version restored into the draft")).toBeVisible();
  await expect(phone).toContainText("Scan without limits");

  // The JSON tab shows what the SDK receives.
  await page.getByRole("tab", { name: "JSON" }).click();
  await expect(page.getByLabel("Paywall JSON")).toHaveValue(/"components_config"/);
  await page.getByRole("tab", { name: "Design" }).click();

  // Phone width: no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 7. Generate with AI (the e2e server's fake model) on the second offering.
  await page.goto(`/projects/${pid}/paywalls`);
  await expect(page.getByRole("cell", { name: "Trial timeline · Default" })).toBeVisible();
  await page.getByRole("button", { name: "Generate with AI" }).click();
  const ai = page.getByRole("dialog", { name: "Generate a paywall with AI" });
  await ai.getByLabel("Describe the paywall").fill("A focus timer for students, calm and simple");
  await ai.getByLabel("App name").fill("Lumen");
  await ai.getByRole("button", { name: "Generate" }).click();
  const gen = ai.getByRole("figure", { name: "Generated paywall preview" });
  await expect(gen).toContainText("AI: A focus timer for students, calm and simple");
  await expect(gen).toContainText("Smart suggestions");
  await expect(ai.getByLabel("What was fixed")).toContainText("Fake");
  await ai.getByRole("button", { name: "Create paywall" }).click();
  await page.waitForURL((u) => /\/paywalls\/pw/.test(u.pathname) && !u.pathname.endsWith(paywallId));
  await expect(page.getByRole("figure", { name: "Paywall preview" })).toContainText("AI: A focus timer");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/^Published\. Apps get it/)).toBeVisible();
  const spring = (await sdk()).offerings.find((o: any) => o.identifier === "spring");
  expect(Object.values(spring.paywall_components.components_localizations.en_US)).toContain("AI: A focus timer for students, calm and simple");

  expect(errors).toEqual([]);
});
