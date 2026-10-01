/**
 * Lifecycle and customer lists end to end (prd/lifecycle/PRD.md), on the seeded demo project of e2e/server.ts:
 * Refund Control, Retention (Apple Retention Messaging and Customer Center offers), Win-back, Support and Customers.
 * Apple is never called: the demo App Store app has no In-App Purchase key, so "Sync to Apple" stops before any request.
 * Emails go to the e2e server's in-memory mailer (GET /__mail?to=).
 *   pnpm --filter @revenuedot/dashboard e2e -- lifecycle
 * Screenshots of the clean seed: e2e/shots.spec.ts.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const errors: string[] = [];
let pid = "";
let P = "";

async function json<T = any>(page: Page, method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await page.request.fetch(path, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
async function signIn(page: Page) {
  page.on("console", (m) => { if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(`${page.url()}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  await json(page, "POST", "/auth/login", { email: "e2e@revenuedot.test", password: "e2e-password-1" });
  pid = (await json(page, "GET", "/auth/me")).projects[0].id;
  P = `/v2/projects/${pid}`;
}
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();

test("refund control: cards, add a recent-renewal policy, preference, drag and keyboard order, consent, save, cancel", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${pid}/lifecycle/refund-control`);
  await expect(page.getByRole("heading", { name: "Refund Control" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "Refund control" })).not.toContainText("SOON");

  // Cards match the API, and the Declined/Approved switches change them.
  const stats = await json(page, "GET", `${P}/refund_control/stats?days=28&environment=production`);
  expect(stats.requests.total).toBeGreaterThanOrEqual(8);
  await expect(page.getByTestId("refund-count")).toHaveText(String(stats.requests.declined));
  await page.getByRole("group", { name: "Refund requests" }).getByRole("button", { name: "Approved" }).click();
  await expect(page.getByTestId("refund-count")).toHaveText(String(stats.requests.approved));
  await page.getByRole("group", { name: "Refund request amount" }).getByRole("button", { name: "Approved" }).click();
  await expect(page.getByTestId("refund-amount")).toHaveText(`$${stats.amount_in_usd.approved.toFixed(2)}`);
  await expect(page.getByText(`${Math.round(stats.refund_rate * 100)}%`, { exact: true })).toBeVisible();

  // Seeded policies, the default policy, no unsaved changes yet.
  await expect(page.getByLabel("Policy 1 name")).toHaveValue("Renewed in the last day");
  await expect(page.getByLabel("Policy 2 name")).toHaveValue("Spent over $40");
  await expect(page.getByLabel("Default refund preference")).toHaveValue("do_not_respond");
  const unsaved = page.getByRole("region", { name: "Unsaved changes" });
  await expect(unsaved).toHaveCount(0);

  // Add a "Recent renewal" policy: the template's condition, then a preference.
  await page.getByRole("button", { name: "Add policy: Recent renewal" }).click();
  await expect(page.getByLabel("Policy 3 name")).toHaveValue("Recent renewal");
  await expect(page.getByLabel("Policy 3 name")).toBeFocused();
  await expect(page.getByLabel("Policy 3 field 1.1")).toHaveValue("lastRenewalAt");
  await expect(page.getByLabel("Policy 3 operator 1.1")).toHaveValue("within");
  await expect(page.getByLabel("Policy 3 value 1.1")).toHaveValue("24h");
  await page.getByLabel("Refund preference for Recent renewal").selectOption({ label: "Prefer full refund" });
  await expect(unsaved).toBeVisible();

  // Drag it to the top by its handle, then one place down with the keyboard buttons.
  const items = page.locator(".policy-list > li");
  await items.nth(2).locator(".grip").dragTo(items.nth(0));
  await expect(page.getByLabel("Policy 1 name")).toHaveValue("Recent renewal");
  await page.getByRole("button", { name: "Move Recent renewal down" }).click();
  await expect(page.getByLabel("Policy 1 name")).toHaveValue("Renewed in the last day");
  await expect(page.getByLabel("Policy 2 name")).toHaveValue("Recent renewal");

  // Consent, then Save.
  const consent = page.getByRole("checkbox", { name: /Customers agreed to share consumption data with Apple/ });
  await expect(consent).not.toBeChecked();
  await consent.check();
  await unsaved.getByRole("button", { name: "Save" }).click();
  await toast(page, "Refund policies saved");
  await expect(unsaved).toHaveCount(0);
  const saved = await json(page, "GET", `${P}/refund_control`);
  expect(saved.policies.map((p: any) => p.name)).toEqual(["Renewed in the last day", "Recent renewal", "Spent over $40"]);
  expect(saved.policies[1]).toMatchObject({ template: "recent_renewal", preference: "prefer_refund", rules: { groups: [{ conditions: [{ field: "lastRenewalAt", operator: "within", value: "24h" }] }] } });
  expect(saved.settings.customer_consented).toBe(true);

  // Reload: persisted. Cancel throws edits away.
  await page.reload();
  await expect(page.getByLabel("Policy 2 name")).toHaveValue("Recent renewal");
  await expect(page.getByLabel("Refund preference for Recent renewal")).toHaveValue("prefer_refund");
  await expect(consent).toBeChecked();
  await page.getByLabel("Policy 1 name").fill("Changed name");
  await page.getByRole("button", { name: "Delete Spent over $40" }).click();
  await expect(unsaved).toBeVisible();
  await unsaved.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Policy 1 name")).toHaveValue("Renewed in the last day");
  await expect(page.getByLabel("Policy 3 name")).toHaveValue("Spent over $40");
  await expect(unsaved).toHaveCount(0);

  // The request log.
  const log = page.locator("section.panel").filter({ has: page.getByText("Recent refund requests", { exact: true }) });
  await expect(log.locator("tbody tr").filter({ hasText: "c1tdha8u" })).toBeVisible();
  expect(await log.locator("tbody tr").count()).toBe((await json(page, "GET", `${P}/refund_requests?limit=20`)).items.length);
  await expect(log.locator("tbody tr").filter({ hasText: "pbg6xs2d" })).toContainText("Refunded");
  await expect(log.locator("tbody tr").filter({ hasText: "c1tdha8u" })).toContainText("Skipped");
});

test("retention: Apple message, rule and sync error; Customer Center cancel offer", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${pid}/lifecycle/retention`);
  await expect(page.getByRole("heading", { name: "Retention Offers" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Apple Retention Messaging API" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("link", { name: "Request access from Apple" })).toHaveAttribute("href", "https://developer.apple.com/contact/request/retention-messaging-api/");

  // A message: counters, then the UUID made in the browser.
  await page.getByRole("button", { name: "New message" }).click();
  const dlg = page.getByRole("dialog", { name: "New message" });
  await dlg.getByLabel("Header").fill("Before you go");
  await expect(dlg.getByText("13/66")).toBeVisible();
  await dlg.getByLabel("Body").fill("Stay on Pro and keep unlimited scans synced across your devices.");
  await expect(dlg.getByText("64/144")).toBeVisible();
  await dlg.getByRole("button", { name: "Add message" }).click();
  await toast(page, "Message added");
  await expect(page.getByRole("cell", { name: /^Before you go Stay/ })).toBeVisible();

  // A real-time rule for any product, and a default message for one product.
  await page.getByLabel("Show", { exact: true }).selectOption({ label: "Before you go" });
  await page.getByRole("button", { name: "Add rule" }).click();
  await toast(page, "Rule added");
  await page.getByLabel("Product", { exact: true }).selectOption("scanner.pro.monthly");
  await page.getByLabel("Text message").selectOption({ label: "Before you go" });
  await page.getByRole("button", { name: "Add default" }).click();
  await toast(page, "Default message added");
  const apps = (await json(page, "GET", `${P}/apps?limit=100`)).items;
  const ios = apps.find((a: any) => a.type === "app_store");
  const rm = await json(page, "GET", `${P}/apps/${ios.id}/retention_messaging`);
  expect(rm.messages).toHaveLength(1);
  expect(rm.messages[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(rm.rules).toEqual([{ product_id: null, message_id: rm.messages[0].id }]);
  expect(rm.defaults).toMatchObject([{ product_id: "scanner.pro.monthly", locale: "en-US", message_id: rm.messages[0].id }]);
  await expect(page.getByRole("cell", { name: "Any product" })).toBeVisible();

  // Turn it on; syncing without an In-App Purchase key fails before any call to Apple.
  await page.getByRole("switch", { name: "Answer Apple's real-time requests" }).click();
  await toast(page, "Retention messages are on");
  await page.getByRole("button", { name: "Sync to Apple (sandbox)" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "In-App Purchase key" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add it in the app's settings" })).toHaveAttribute("href", `/projects/${pid}/apps/${ios.id}`);
  // The app's Apple ID, which Apple sends with each real-time request.
  await page.getByLabel("Apple ID of the app").fill("1234567890");
  await page.getByRole("button", { name: "Save Apple ID" }).click();
  await toast(page, "Apple ID saved");
  await expect(page.getByText("Apple ID of the app: 1234567890")).toBeVisible();
  expect((await json(page, "GET", `${P}/apps/${ios.id}/retention_messaging`)).app_apple_id).toBe("1234567890");
  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await expect(page.getByRole("columnheader", { name: "Apple (sandbox)" })).toBeVisible();

  // Customer Center: the seeded cancel offer, then a new one.
  await page.getByRole("tab", { name: "Customer Center" }).click();
  await expect(page).toHaveURL(/tab=customer_center/);
  await expect(page.getByText("Half off for 3 months")).toBeVisible();
  await page.getByRole("button", { name: "New offer: Cancellation Retention Discount" }).click();
  const od = page.getByRole("dialog", { name: "New cancellation offer" });
  await od.getByLabel("Name", { exact: true }).fill("Annual saver");
  await od.getByLabel("Product 1", { exact: true }).selectOption("scanner.pro.yearly");
  await od.getByLabel("Offer ID 1").fill("yearly_30off");
  await od.getByRole("button", { name: "Create offer" }).click();
  await toast(page, "Offer created");
  await expect(page.getByRole("row").filter({ hasText: "Annual saver" })).toContainText("scanner.pro.yearly → yearly_30off");
  const offers = (await json(page, "GET", `${P}/retention_offers`)).items;
  expect(offers.find((o: any) => o.name === "Annual saver")).toMatchObject({ trigger: "cancel", store: "app_store", product_mapping: { "scanner.pro.yearly": "yearly_30off" }, active: true });
  await page.getByRole("row").filter({ hasText: "Annual saver" }).getByRole("switch").click();
  await toast(page, "Annual saver is off");
});

test("win-back: empty state, create, preview, send test, start, send now", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${pid}/lifecycle/winback`);
  await expect(page.getByRole("heading", { name: /Win-back campaigns/ })).toContainText("BETA");
  await expect(page.getByText("Bring churned subscribers back by emailing them an offer.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create your first win-back campaign" })).toBeVisible();
  await page.getByRole("link", { name: "Create campaign" }).click();
  await expect(page).toHaveURL(/\/winback\/new$/);
  await page.getByLabel("Name", { exact: true }).fill("Lapsed Pro subscribers");
  await page.getByLabel("Subject").fill("Come back to Scanner Pro");
  await expect(page.getByLabel("Email preview")).toContainText("Come back to Scanner Pro");
  await page.getByRole("button", { name: "Save draft" }).click();
  await toast(page, "Campaign saved as a draft");
  await expect(page).toHaveURL(/\/winback\/wbc_/);
  const id = page.url().split("/").pop()!;

  // Preview: who would get it now (churned App Store subscribers with an email).
  await expect(page.getByTestId("wb-eligible")).toContainText("would get this email now");
  const eligible = Number((await page.getByTestId("wb-eligible").locator("b").textContent())!.replace(/\D/g, ""));
  expect(eligible).toBeGreaterThanOrEqual(1);
  const preview = await json(page, "POST", `${P}/winback_campaigns/${id}/actions/preview`);
  expect(preview.eligible).toBe(eligible);
  await expect(page.getByRole("cell", { name: /pbg6xs2d/ })).toBeVisible();

  // Send test: the email arrives in the e2e mailer.
  await page.getByRole("button", { name: "Send test" }).click();
  const td = page.getByRole("dialog", { name: "Send a test email" });
  await td.getByLabel("Send to").fill("winback-test@revenuedot.test");
  await td.getByRole("button", { name: "Send test" }).click();
  await toast(page, "Test email sent to winback-test@revenuedot.test");
  const mail = await json(page, "GET", "/__mail?to=winback-test@revenuedot.test");
  expect(mail).toHaveLength(1);
  expect(mail[0].subject).toBe("[Test] Come back to Scanner Pro");

  // Start, then send now.
  await expect(page.getByRole("button", { name: "Send now" })).toBeDisabled();
  await page.getByRole("button", { name: "Start" }).click();
  await toast(page, /Campaign started/);
  await expect(page.locator(".head .tag")).toHaveText("Active");
  await page.getByRole("button", { name: "Send now" }).click();
  await page.getByRole("dialog", { name: "Send this campaign now?" }).getByRole("button", { name: "Send now" }).click();
  await toast(page, `Sent ${eligible} email${eligible === 1 ? "" : "s"}`);
  expect(await json(page, "GET", "/__mail?to=bruna@example.com")).toHaveLength(1);
  await expect(page.getByLabel("Campaign results")).toContainText(String(eligible));
  await expect(page.getByRole("cell", { name: "bruna@example.com", exact: true })).toBeVisible();
  await expect(page.getByTestId("wb-eligible")).toContainText("0 customers would get this email now");

  await page.goto(`/projects/${pid}/lifecycle/winback`);
  const row = page.getByRole("row").filter({ hasText: "Lapsed Pro subscribers" });
  await expect(row).toContainText("Active");
  await expect(row.getByRole("cell").nth(2)).toHaveText(String(eligible));
});

test("support: integrations, ticket settings, a Customer Center ticket arrives, close it", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${pid}/lifecycle/support`);
  await expect(page.getByRole("heading", { name: "Support", exact: true })).toBeVisible();
  await expect(page.getByText("Intercom", { exact: true })).toBeVisible();
  await expect(page.getByText("Zendesk", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read the guide" }).first()).toHaveAttribute("href", "https://revenuedot.app/docs/guides/support-integrations");
  await expect(page.locator(".codeblock")).toContainText(`/v2/projects/${pid}/support_summaries?email=`);

  await page.getByRole("tab", { name: "Customer Center" }).click();
  await page.getByLabel("Support email").fill("help@scanner.test");
  await expect(page.getByRole("checkbox", { name: /Let customers create tickets/ })).toBeChecked();
  await page.getByLabel("Who can create tickets").selectOption("all");
  await page.getByRole("checkbox", { name: "IDFV" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await toast(page, "Support settings saved");
  const cc = await json(page, "GET", `${P}/customer_center_config`);
  expect(cc.customer_center.support.email).toBe("help@scanner.test");
  expect(cc.customer_center.support.support_tickets).toMatchObject({ allow_creation: true, customer_type: "all", customer_details: { idfv: true, appUserId: true } });

  // The SDK's create-ticket call with the Test Store public key.
  const apps = (await json(page, "GET", `${P}/apps?limit=100`)).items;
  const testApp = apps.find((a: any) => a.type === "test_store");
  const key = (await json(page, "GET", `${P}/apps/${testApp.id}/public_api_keys`)).items[0].key;
  const message = `My subscription does not show up on my new phone (${Date.now()}).`;
  const sent = await json(page, "POST", "/v1/customercenter/support/create-ticket", { app_user_id: "wjqx8kd2rn1", customer_email: "wren@example.com", issue_description: message }, { authorization: `Bearer ${key}`, "x-platform": "iOS" });
  expect(sent).toEqual({ sent: true });
  const mails = await json(page, "GET", "/__mail?to=help@scanner.test");
  expect(mails.length).toBeGreaterThanOrEqual(1);

  await page.getByRole("tab", { name: "Tickets" }).click();
  const row = page.getByRole("row").filter({ hasText: message });
  await expect(row).toContainText("wren@example.com");
  await expect(row).toContainText("help@scanner.test");
  await expect(row.getByRole("link", { name: "wjqx8kd2rn1" })).toHaveAttribute("href", `/projects/${pid}/customers/wjqx8kd2rn1`);
  await row.click();
  await expect(page).toHaveURL(/ticket=tkt_/);
  await expect(page.getByLabel("Full message")).toHaveText(message);
  await page.getByRole("button", { name: "Close ticket", exact: true }).click();
  await toast(page, "Ticket closed");
  await expect(page.getByRole("row").filter({ hasText: message })).toHaveCount(0);
  await page.getByRole("group", { name: "Ticket status" }).getByRole("button", { name: "Closed" }).click();
  await expect(page.getByRole("row").filter({ hasText: message })).toContainText("Closed");
});

test("customers: lists, summary cards, filter, save audience, export, search", async ({ page }) => {
  await signIn(page);
  await page.goto(`/projects/${pid}/customers`);
  const rail = page.getByRole("navigation", { name: "Customer lists" });
  await expect(rail.getByRole("button", { name: "All customers" })).toHaveAttribute("aria-pressed", "true");
  const card = (label: string) => page.locator(`[data-kpi="${label}"] .v`);
  const all = await json(page, "GET", `${P}/customer_lists?list=all&limit=1`);
  await expect(card("Customers")).toHaveText(all.summary.customers.toLocaleString("en-US"));
  await expect(card("Paid subscribers")).toHaveText(all.summary.paid_subscribers.toLocaleString("en-US"));
  await expect(page.locator("table tbody tr")).toHaveCount(25);

  await rail.getByRole("button", { name: "Active subscribers" }).click();
  await expect(page).toHaveURL(/list=active/);
  const active = await json(page, "GET", `${P}/customer_lists?list=active&limit=1`);
  await expect(card("Customers")).toHaveText(active.summary.customers.toLocaleString("en-US"));
  expect(active.summary.customers).toBeLessThan(all.summary.customers);
  await rail.getByRole("button", { name: "Expired" }).click();
  await expect(page.getByRole("row").filter({ hasText: "pbg6xs2d" })).toContainText("Expired");

  // Filter Active subscribers by country.
  await rail.getByRole("button", { name: "Active subscribers" }).click();
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("button", { name: "Add a condition" }).click();
  await page.getByLabel("Field 1.1").selectOption("country");
  await page.getByLabel("Operator 1.1").selectOption("is");
  await page.getByLabel("Value 1.1").fill("US");
  await page.getByRole("button", { name: "Apply filter" }).click();
  const rules = { groups: [{ conditions: [{ field: "country", operator: "is", value: "US" }] }] };
  const us = await json(page, "GET", `${P}/customer_lists?list=active&rules=${encodeURIComponent(JSON.stringify(rules))}&limit=1`);
  expect(us.summary.customers).toBeGreaterThan(0);
  await expect(card("Customers")).toHaveText(us.summary.customers.toLocaleString("en-US"));
  await expect(page.getByTestId("filter-count")).toHaveText("1");

  // Save audience: the list's condition plus the filter.
  await page.getByRole("button", { name: "Save audience" }).click();
  const sd = page.getByRole("dialog", { name: "Save audience" });
  await expect(sd).toContainText("Subscription status is any of active,trialing and Country is US");
  await sd.getByLabel("Name").fill("Active in the US");
  await sd.getByRole("button", { name: "Save audience" }).click();
  await toast(page, 'Audience "Active in the US" saved');
  await expect(rail.getByRole("button", { name: "Active in the US" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/list=aud/);
  const auds = (await json(page, "GET", `${P}/audiences`)).items;
  expect(auds.find((a: any) => a.name === "Active in the US").rules).toEqual({ groups: [{ conditions: [{ field: "status", operator: "isAnyOf", value: "active,trialing" }, { field: "country", operator: "is", value: "US" }] }] });
  await expect(page.locator("table tbody tr").first()).toBeVisible();

  // Export downloads a CSV with a header row.
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export all" }).click()]);
  const csv = readFileSync((await download.path())!, "utf8");
  expect(csv.split("\r\n")[0]).toBe("app_user_id,email,subscription_status,auto_renewal_status,first_seen_at,last_seen_at,spent_in_usd,latest_product_id,latest_store,latest_purchase_at,country,platform");
  expect(download.suggestedFilename()).toMatch(/^customers-aud.*\.csv$/);

  // Search inside All customers keeps the URL in sync; a row opens the customer.
  await rail.getByRole("button", { name: "All customers" }).click();
  await page.getByPlaceholder("App user ID, email or store transaction ID").fill("wren");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/q=wren/);
  await expect(page.locator("table tbody tr")).toHaveCount(1);
  await page.locator("table tbody tr").first().click();
  await expect(page).toHaveURL(/customers\/wjqx8kd2rn1$/);
});

test("phone width and dark theme: lifecycle pages fit without page-level horizontal scroll", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["lifecycle/refund-control", "lifecycle/retention", "lifecycle/retention?tab=customer_center", "lifecycle/winback", "lifecycle/support", "lifecycle/support?tab=customer_center", "lifecycle/support?tab=tickets", "customers"]) {
    await page.goto(`/projects/${pid}/${path}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => { const s = document.querySelector(".scroll")!; return s.scrollWidth - s.clientWidth; });
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  const campaigns = (await json(page, "GET", `${P}/winback_campaigns`)).items;
  await page.goto(`/projects/${pid}/lifecycle/winback/${campaigns[0].id}`);
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => { const s = document.querySelector(".scroll")!; return s.scrollWidth - s.clientWidth; }), "win-back editor").toBeLessThanOrEqual(0);
  // Dark theme: every colour comes from tokens, so the page background follows.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/projects/${pid}/lifecycle/refund-control`);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(10, 10, 10)");
});

test("no console errors on the lifecycle pages", () => {
  expect(errors).toEqual([]);
});
