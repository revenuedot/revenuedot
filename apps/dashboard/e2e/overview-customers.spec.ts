/**
 * End-to-end tests for the Overview and Customers areas, in a real browser against the real API (e2e/server.ts).
 * Run: pnpm --filter @revenuedot/dashboard e2e   (see e2e/README.md)
 */
import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "e2e-password-1";
const consoleErrors: string[] = [];

async function signIn(page: Page, email = "e2e@revenuedot.test") {
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`${page.url()}: ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/projects\/[^/]+\/overview/);
  return page.url().match(/projects\/([^/]+)/)![1]!;
}
const panel = (page: Page, title: string) => page.locator("section.panel").filter({ has: page.locator(".ph b", { hasText: new RegExp(`^${title}$`) }) });
const json = async (page: Page, path: string) => (await page.request.get(path)).json();

test.describe.configure({ mode: "serial" });

test("first run: an empty project shows the setup checklist, the SDK line and the test purchase flow", async ({ page }) => {
  await signIn(page, "fresh@revenuedot.test");
  const setup = page.getByRole("region", { name: "Set up your project" });
  await expect(setup).toBeVisible();
  await expect(setup.getByLabel("0 of 6 steps done")).toBeVisible();
  await expect(page.getByRole("region", { name: "Key metrics" })).toHaveCount(0);
  // A new app gets install, configure and purchase code; an app on RevenueCat gets the one-line change.
  await expect(setup.getByRole("heading", { name: "Add the SDK to your app" })).toBeVisible();
  await expect(setup.getByLabel("Swift install", { exact: true })).toContainText("https://github.com/RevenueCat/purchases-ios-spm.git");
  await expect(setup.getByLabel("Swift setup code", { exact: true })).toContainText(`Purchases.proxyURL = URL(string: "${new URL(page.url()).origin}")!`);
  await expect(setup.getByLabel("Swift purchase code", { exact: true })).toContainText("Purchases.shared.purchase(package:");
  await setup.getByRole("button", { name: "Kotlin" }).click();
  await expect(setup.getByLabel("Kotlin install", { exact: true })).toContainText("com.revenuecat.purchases:purchases:");
  await expect(setup.getByLabel("Kotlin setup code", { exact: true })).toContainText("Purchases.proxyURL = URL(");
  await setup.getByRole("button", { name: "React Native" }).click();
  await expect(setup.getByLabel("React Native install", { exact: true })).toContainText("npm install react-native-purchases");
  await setup.getByRole("button", { name: "Flutter" }).click();
  await expect(setup.getByLabel("Flutter install", { exact: true })).toContainText("flutter pub add purchases_flutter");
  await setup.getByRole("button", { name: "Already on RevenueCat" }).click();
  await expect(setup.getByRole("heading", { name: "Point your SDK at RevenueDot" })).toBeVisible();
  await expect(setup.getByLabel("Flutter install", { exact: true })).toHaveCount(0);
  await expect(setup.getByLabel("Flutter setup code", { exact: true })).toContainText("await Purchases.setProxyURL(");
  await expect(setup.getByLabel("Flutter setup code", { exact: true })).not.toContainText("import");
  await setup.getByRole("button", { name: "New to in-app purchases" }).click();
  await expect(page.getByRole("region", { name: "Setup health" })).toContainText("No apps connected");

  await setup.getByRole("button", { name: "Make a test purchase" }).click();
  const dialog = page.getByRole("dialog", { name: "Make a test purchase" });
  await dialog.getByRole("button", { name: "Create Test Store app" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Test Store app created." })).toBeVisible();
  await expect(dialog).toContainText("The Test Store app has no products.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(setup.getByLabel("1 of 6 steps done")).toBeVisible();
  await expect(page.getByRole("region", { name: "Setup health" })).toContainText("Ready for sandbox test purchases");
});

test("overview: live cards match the API, periods and sandbox switch, transactions and setup health", async ({ page }) => {
  const pid = await signIn(page);
  const grid = page.getByRole("region", { name: "Key metrics" });
  const api = await json(page, `/v2/projects/${pid}/metrics/overview`);
  const val = (id: string) => api.metrics.find((m: { id: string }) => m.id === id).value as number;
  await expect(grid.locator('[data-metric="active_subscriptions"] .v')).toHaveText(val("active_subscriptions").toLocaleString("en-US"));
  await expect(grid.locator('[data-metric="active_trials"] .v')).toHaveText(String(val("active_trials")));
  await expect(grid.locator('[data-metric="mrr"] .v')).toHaveText(val("mrr").toLocaleString("en-US", { style: "currency", currency: "USD" }).replace(/\.00$/, ""));
  await expect(grid.locator("svg.sp")).toHaveCount(5);
  await expect(grid.locator('[data-metric="active_users"]')).toContainText("No daily history");
  expect(val("active_subscriptions")).toBeGreaterThan(0);

  // Period: 7D changes the window of revenue and the subtitle, and is kept in the URL.
  await page.getByRole("group", { name: "Period" }).getByRole("button", { name: "7D" }).click();
  await expect(page).toHaveURL(/period=7d/);
  await expect(page.getByText("last 7 days compared with the 7 days before")).toBeVisible();
  const h7 = await json(page, `/v2/projects/${pid}/metrics/history?metric=revenue&days=7`);
  await expect(grid.locator('[data-metric="revenue"] .v')).toHaveText(h7.value.toLocaleString("en-US", { style: "currency", currency: "USD" }).replace(/\.00$/, ""));
  await expect(grid.locator('[data-metric="revenue"] .meta')).toContainText("last 7 days");

  // Transactions: App Store renewals, trials and the refund are production data.
  const tx = page.getByRole("region", { name: "Recent transactions" });
  await expect(tx.locator("tbody tr").first()).toBeVisible();
  await expect(tx.getByText("Renewal").first()).toBeVisible();
  await tx.getByRole("button", { name: /Show more/ }).click();
  await expect(tx.locator("tbody tr")).toHaveCount(16);

  // Sandbox switch.
  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await expect(page).toHaveURL(/environment=sandbox/);
  await expect(tx.getByText("Sandbox", { exact: true })).toBeVisible();
  await expect(tx.getByText("Test Store").first()).toBeVisible();

  // Setup health: live App Store notification time and the missing key, which links to the app.
  const health = page.getByRole("region", { name: "Setup health" });
  await expect(health).toContainText("App Store notifications");
  // Seeded when the e2e server started; earlier specs can take over a minute.
  await expect(health).toContainText(/Last received (\d+s|\d+ min) ago/);
  await expect(health).toContainText("Scanner iOS: In-app purchase key missing");
  await expect(health.getByRole("link", { name: "Fix →" })).toHaveAttribute("href", new RegExp(`/projects/${pid}/apps/`));

  // A transaction row opens the customer.
  await tx.locator("tbody tr a").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/]+$/);
  await expect(panel(page, "Customer history")).toBeVisible();
});

test("customers: list, pagination, exact search and the top-bar search", async ({ page }) => {
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/customers`);
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(25);
  await expect(page.getByText("Page 1")).toBeVisible();
  const firstOnPage1 = await rows.first().locator("a").textContent();
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page).toHaveURL(/after=/);
  await expect(page.getByText("Page 2")).toBeVisible();
  await expect(rows.first().locator("a")).not.toHaveText(firstOnPage1!);
  await page.getByRole("button", { name: "← Previous" }).click();
  await expect(page.getByText("Page 1")).toBeVisible();
  await expect(rows.first().locator("a")).toHaveText(firstOnPage1!);

  // Entitlement and revenue columns come from the summaries.
  await page.getByPlaceholder("App user ID, email or store transaction ID").fill("wren@example.com");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=wren%40example.com/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("wjqx8kd2rn1");
  await expect(rows.first()).toContainText("pro");
  await expect(rows.first()).toContainText("$54.89");

  // Search matches part of an app user ID or email (customer lists); nothing matches a made-up value.
  await page.getByPlaceholder("App user ID, email or store transaction ID").fill("wren");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=wren$/);
  await expect(rows).toHaveCount(1);
  await page.getByPlaceholder("App user ID, email or store transaction ID").fill("nobody-matches-this");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText('No customer matches "nobody-matches-this"')).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(rows).toHaveCount(25);

  await page.getByLabel("Search customers").first().fill("pbg6xs2d");
  await page.getByLabel("Search customers").first().press("Enter");
  await expect(page).toHaveURL(/customers\?q=pbg6xs2d/);
  // The previous list stays on screen (dimmed, not clickable) until the search answers.
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("pbg6xs2d");
  await rows.first().click();
  await expect(page).toHaveURL(/customers\/pbg6xs2d$/);
});

test("customers: sort by a column header, page in that order, hide app user IDs", async ({ page }) => {
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/customers`);
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(25);
  const header = (name: string) => page.getByRole("columnheader", { name, exact: true });
  const spent = async () => (await rows.locator("td:nth-child(6)").allInnerTexts()).map((t) => Number(t.replace(/[^0-9.]/g, "")));

  // The default order is last seen, newest first, and the header says so; a click on it flips it, the next returns to a clean URL.
  await expect(header("Last seen")).toHaveAttribute("aria-sort", "descending");
  await expect(header("Spent")).not.toHaveAttribute("aria-sort");
  await expect(header("Latest purchase").getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Last seen" }).click();
  await expect(page).toHaveURL(/sort=last_seen_at&direction=asc/);
  await expect(header("Last seen")).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Last seen" }).click();
  await expect(page).not.toHaveURL(/sort=|direction=/);
  await expect(header("Last seen")).toHaveAttribute("aria-sort", "descending");

  // Spent: the first click puts the biggest spenders first, the second flips it.
  await page.getByRole("button", { name: "Spent" }).click();
  await expect(page).toHaveURL(/sort=spent_in_usd&direction=desc/);
  await expect(header("Spent")).toHaveAttribute("aria-sort", "descending");
  await expect(header("Last seen")).not.toHaveAttribute("aria-sort");
  await expect.poll(async () => { const v = await spent(); return v.length === 25 && v.every((x, i) => i === 0 || v[i - 1]! >= x); }).toBe(true);
  const top = (await spent())[0]!;
  expect(top).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Next →" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  await expect.poll(async () => Math.max(...(await spent()))).toBeLessThanOrEqual(top);
  await page.getByRole("button", { name: "Spent" }).click();
  await expect(page).toHaveURL(/sort=spent_in_usd&direction=asc/);
  await expect(page).not.toHaveURL(/after=/);
  await expect(page.getByText("Page 1")).toBeVisible();
  await expect.poll(async () => { const v = await spent(); return v.every((x, i) => i === 0 || v[i - 1]! <= x); }).toBe(true);

  // Customer: app user IDs A to Z, then Z to A; anonymous IDs come after the named ones both ways, in the API and on screen.
  const ANON = "$RCAnonymousID:";
  const byId = (dir: 1 | -1) => (a: string, b: string) => Number(a.startsWith(ANON)) - Number(b.startsWith(ANON))
    || (a.toLowerCase() < b.toLowerCase() ? -dir : a.toLowerCase() > b.toLowerCase() ? dir : 0);
  const shownIds = () => rows.locator("td:first-child a").evaluateAll((as) => as.map((a) => a.getAttribute("title") ?? ""));
  const allIds: string[] = [];
  for (let url: string | null = `/v2/projects/${pid}/customer_lists?sort=id&limit=100`; url;) {
    const r = await json(page, url) as { items: { id: string }[]; next_page: string | null };
    allIds.push(...r.items.map((x) => x.id));
    url = r.next_page;
  }
  expect(allIds.some((x) => x.startsWith(ANON)) && allIds.some((x) => !x.startsWith(ANON))).toBe(true);
  expect(allIds).toEqual([...allIds].sort(byId(1)));
  await page.getByRole("button", { name: "Customer", exact: true }).click();
  await expect(page).toHaveURL(/sort=id&direction=asc/);
  await expect.poll(async () => JSON.stringify(await shownIds())).toBe(JSON.stringify(allIds.slice(0, 25)));
  await page.getByRole("button", { name: "Customer", exact: true }).click();
  await expect(page).toHaveURL(/sort=id&direction=desc/);
  await expect.poll(async () => { const ids = await shownIds(); return ids.length === 25 && JSON.stringify(ids) === JSON.stringify([...ids].sort(byId(-1))); }).toBe(true);

  // Hide app user IDs: one button name, aria-pressed for the state. IDs and emails leave the table's text, titles,
  // labels and links (the masked cell is a button), rows still open the customer, and the choice survives a reload.
  const before = await shownIds();
  const eye = page.getByRole("button", { name: "Hide app user IDs" });
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  const body = page.locator("table tbody");
  await expect(rows.first().locator("td").first()).toHaveText("••••••••••");
  await expect(body).not.toContainText("@");
  await expect(body.locator("a")).toHaveCount(0);
  const attrs = await body.evaluate((el) => [...el.querySelectorAll("*")].flatMap((n) => [...n.attributes].map((a) => a.value)).join("\n"));
  for (const id of before) { expect(attrs).not.toContain(id); expect(attrs).not.toContain(encodeURIComponent(id)); }
  await rows.first().getByRole("button", { name: "Open customer (ID hidden)" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL((u) => u.pathname === `/projects/${pid}/customers/${encodeURIComponent(before[0]!)}`);
  // One history entry: Enter on the cell's button does not also fire the row's own Enter.
  await page.goBack();
  await expect(page).toHaveURL(/sort=id&direction=desc/);
  await page.reload();
  await expect(eye).toHaveAttribute("aria-pressed", "true");
  await expect(rows.first().locator("td").first()).toHaveText("••••••••••");

  // The exact-search answer names nobody while IDs are hidden; its button still opens the customer.
  const subs = await json(page, `/v2/projects/${pid}/customers/wjqx8kd2rn1/subscriptions`) as { items: { store_subscription_identifier: string }[] };
  const tx = subs.items[0]!.store_subscription_identifier;
  await page.getByPlaceholder("App user ID, email or store transaction ID").fill(tx);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: `"${tx}" belongs to a customer` })).toBeVisible();
  await expect(page.locator(".empty")).not.toContainText("wjqx8kd2rn1");
  await expect(page.locator(".empty a")).toHaveCount(0);
  await page.locator(".empty").getByRole("button", { name: "Open customer" }).click();
  await expect(page).toHaveURL(/\/customers\/wjqx8kd2rn1$/);
  await page.goBack();

  await eye.click();
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("heading", { name: `"${tx}" belongs to wjqx8kd2rn1` })).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(rows.first().locator("td").first()).not.toHaveText("••••••••••");
  await rows.first().locator("a").first().click();
  await expect(page).toHaveURL(/\/customers\/[^/?]+$/);
});

test("customer page: history labels, grant and revoke, offering override, attribute, delete", async ({ page }) => {
  const pid = await signIn(page);
  await page.goto(`/projects/${pid}/customers/pbg6xs2d`);
  await expect(page.getByRole("heading", { name: "pbg6xs2d" })).toBeVisible();
  const history = page.getByRole("list", { name: "Events, newest first" });
  await expect(history).toContainText("Started a trial");
  await expect(history).toContainText("Converted from a trial");
  await expect(history).toContainText("Was issued a refund");
  await history.locator("summary").first().click();
  await expect(history.getByLabel("Event body").first()).toContainText('"type": "CANCELLATION"');
  await expect(page.getByText("No active entitlements.")).toBeVisible();
  await expect(page.locator("table").first()).toContainText("Expired");

  // Grant, then revoke.
  await page.getByRole("button", { name: "Grant entitlement" }).click();
  const grant = page.getByRole("dialog", { name: "Grant an entitlement" });
  await grant.getByLabel("Entitlement").selectOption({ label: "Pro access (pro)" });
  await grant.getByText("1 week").click();
  await grant.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Granted Pro access until/ })).toBeVisible();
  await expect(page.getByText("Granted · expires")).toBeVisible();
  const summary = await json(page, `/v2/projects/${pid}/customer_summaries?ids=pbg6xs2d`);
  expect(summary.items[0].granted_entitlements).toHaveLength(1);
  await expect(history).toContainText("Was granted the Pro access entitlement");
  await page.getByRole("button", { name: "Revoke grant" }).click();
  await page.getByRole("dialog", { name: "Revoke Pro access?" }).getByRole("button", { name: "Revoke grant" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revoked the granted Pro access." })).toBeVisible();
  await expect(page.getByText("No active entitlements.")).toBeVisible();

  // Offering override through the "…" menu.
  await page.getByRole("button", { name: "More customer actions" }).click();
  await page.getByRole("menuitem", { name: "Offering override" }).click();
  const off = page.getByRole("dialog", { name: "Offering override" });
  await off.getByLabel("Offering").selectOption({ label: "Win-back 50% off (winback)" });
  await off.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "This customer now sees Win-back 50% off." })).toBeVisible();
  await expect(panel(page, "Current offering")).toContainText("Override");

  // Attribute.
  await page.getByRole("button", { name: "Set →" }).click();
  const attr = page.getByRole("dialog", { name: "Set an attribute" });
  await attr.getByLabel("Name").fill("$email");
  await attr.getByLabel("Value").fill("bruno@example.com");
  await attr.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved $email." })).toBeVisible();
  await expect(panel(page, "Attributes")).toContainText("bruno@example.com");

  // Delete needs the word DELETE.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const del = page.getByRole("dialog", { name: "Delete this customer?" });
  await del.getByRole("button", { name: "Delete customer" }).click();
  await expect(del.getByRole("alert")).toContainText("Type DELETE to confirm.");
  await del.getByLabel("Type DELETE to confirm").fill("DELETE");
  await del.getByRole("button", { name: "Delete customer" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${pid}/customers$`));
  await expect(page.getByRole("status").filter({ hasText: "Deleted pbg6xs2d." })).toBeVisible();
  expect((await page.request.get(`/v2/projects/${pid}/customers/pbg6xs2d`)).status()).toBe(404);
  await page.goto(`/projects/${pid}/customers/pbg6xs2d`);
  await expect(page.getByText("Customer not found")).toBeVisible();
});

test("phone width: overview and customer page fit without page-level horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pid = await signIn(page);
  for (const path of ["overview", "customers", "customers/wjqx8kd2rn1"]) {
    await page.goto(`/projects/${pid}/${path}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => { const s = document.querySelector(".scroll")!; return s.scrollWidth - s.clientWidth; });
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test("no console errors on any page", () => {
  expect(consoleErrors.filter((e) => !/404 \(Not Found\)/.test(e))).toEqual([]);
});
