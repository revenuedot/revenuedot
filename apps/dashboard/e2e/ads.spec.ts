/**
 * Ads and the Batch D integrations in the browser (prd/ads/PRD.md, prd/integrations/PRD.md): the Ads onboarding, the
 * overview after the SDK posts ad events, the sandbox switch and breakdowns; a reward rule made in the browser, a test
 * reward in the ledger and the customer's balance; the integration catalogue with 37 + BigQuery cards; Superwall through
 * the webhook adapter to a local fake; the AdMob page with a project's own OAuth client (Google's page is intercepted,
 * nothing leaves this machine); Zendesk and the Intercom inbox setup. Signs up its own account.
 *   E2E_PORT=5407 pnpm --filter @revenuedot/dashboard e2e -- ads
 */
import { createServer, type Server } from "node:http";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}
function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

let pid = "", P = "", iosKey = "", testKey = "";
const stamp = Date.now();
const account = { email: `ads-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw` };
let signedUp = false;

/** The first test signs up; later tests log in to the same account. */
async function signedIn(page: Page) {
  const req = page.request;
  if (!signedUp) { await json(req, "POST", "/auth/signup", { ...account, name: "Ads e2e", project_name: "Ads e2e" }); signedUp = true; }
  else await json(req, "POST", "/auth/login", account);
  pid = (await json(req, "GET", "/auth/me")).projects[0].id;
  P = `/v2/projects/${pid}`;
}

test("ads: onboarding, then the overview from SDK ad events, sandbox switch and breakdowns", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  await signedIn(page);
  const req = page.request;
  const ios = await json(req, "POST", `${P}/apps`, { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.ads" } });
  iosKey = (await json(req, "GET", `${P}/apps/${ios.id}/public_api_keys`)).items[0].key;
  const test_ = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  testKey = (await json(req, "GET", `${P}/apps/${test_.id}/public_api_keys`)).items[0].key;

  await page.goto(`/projects/${pid}/ads`);
  await expect(page.getByRole("heading", { name: "Start tracking in-app ad revenue" })).toBeVisible();
  for (const step of ["Add the SDK ad adapter", "Explore your ad analytics", "AdMob users: connect your account"]) await expect(page.getByRole("heading", { name: step })).toBeVisible();
  await expect(page.getByRole("link", { name: "Connect AdMob" })).toHaveAttribute("href", `/projects/${pid}/integrations/admob`);
  // The sidebar has no SOON on Ads any more.
  await expect(page.locator(`a[href="/projects/${pid}/ads"]`).first()).toBeVisible();
  await expect(page.locator(`a[href="/projects/${pid}/ads"] .soon, a[href="/projects/${pid}/ads/rewards"] .soon`)).toHaveCount(0);

  // The SDK posts ad events (iOS AdEventsRequest shape) to POST /v1/events.
  const now = Date.now();
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), version: 1, type, app_user_id: "ad_viewer", app_session_id: "s1", timestamp_ms: now - 60_000, capture_method: "adapter",
    network_name: "Google AdMob", mediator_name: "AdMob", ad_format: "rewarded", placement: "out_of_scans", ad_unit_id: "ca-app-pub-1/222", impression_id: crypto.randomUUID(), ...extra,
  });
  const events = [
    ev("rc_ads_ad_loaded"), ev("rc_ads_ad_displayed"), ev("rc_ads_ad_revenue", { revenue_micros: 12_500, currency: "USD", precision: "exact" }), ev("rc_ads_ad_opened"),
    ev("rc_ads_ad_displayed", { network_name: "AppLovin", ad_format: "banner", placement: "home", ad_unit_id: "ca-app-pub-1/111" }),
    ev("rc_ads_ad_revenue", { network_name: "AppLovin", ad_format: "banner", placement: "home", ad_unit_id: "ca-app-pub-1/111", revenue_micros: 500, currency: "USD", precision: "estimated" }),
  ];
  expect((await req.fetch("/v1/events", { method: "POST", data: { events }, headers: { authorization: `Bearer ${iosKey}`, "content-type": "application/json" } })).status()).toBe(200);
  await req.fetch("/v1/events", { method: "POST", data: { events: [ev("rc_ads_ad_displayed"), ev("rc_ads_ad_revenue", { revenue_micros: 2_000_000, currency: "USD" })] }, headers: { authorization: `Bearer ${testKey}`, "content-type": "application/json" } });

  await page.reload();
  const grid = page.getByRole("region", { name: "Ad metrics" });
  await expect(grid.locator('[data-metric="ad_revenue"] .v')).toHaveText("$0.01");
  await expect(grid.locator('[data-metric="impressions"] .v')).toHaveText("2");
  await expect(grid.locator('[data-metric="ecpm"] .v')).toHaveText("$6.50");
  await expect(grid.locator('[data-metric="clicks"] .meta')).toContainText("CTR 50%");
  await expect(page.getByRole("heading", { name: "Ads Beta" })).toBeVisible();
  await expect(page.locator("table tbody tr")).toHaveCount(2);
  await expect(page.locator("table tbody tr").first()).toContainText("Google AdMob");
  await page.getByRole("tab", { name: "Format" }).click();
  await expect(page.locator("table tbody tr").first()).toContainText("Rewarded");
  await page.getByRole("tab", { name: "Ad unit" }).click();
  await expect(page.getByRole("link", { name: "Connect AdMob for ad unit names →" })).toBeVisible();
  await page.getByRole("button", { name: "Impressions" }).click();
  await expect(page.locator(".panel svg").first()).toBeVisible();

  await page.getByRole("switch", { name: "Sandbox data" }).click();
  await expect(page).toHaveURL(/environment=sandbox/);
  await expect(grid.locator('[data-metric="ad_revenue"] .v')).toHaveText("$2.00");
  expect(errors).toEqual([]);
});

test("rewards: a rule made in the browser, a test reward in the ledger, the customer's balance", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchConsole(page);
  await signedIn(page);
  const req = page.request;
  await json(req, "POST", `${P}/virtual_currencies`, { code: "GEMS", name: "Gems" });
  await page.goto(`/projects/${pid}/ads/rewards`);
  await expect(page.getByRole("heading", { name: "Rewards", exact: true })).toBeVisible();
  await expect(page.locator(".copyfield code").first()).toHaveText(/\/v1\/ads\/admob\/ssv$/);
  await expect(page.getByRole("heading", { name: "No reward rules yet" })).toBeVisible();

  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog", { name: "New reward rule" });
  await dialog.getByLabel("Name").fill("Gems for rewarded ads");
  await dialog.getByLabel("Amount per reward").fill("25");
  await dialog.getByLabel("Ad unit").fill("ca-app-pub-1/222");
  await dialog.getByRole("button", { name: "Add rule" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("list", { name: "Reward rules in priority order" })).toContainText("Grants 25 GEMS · when ad unit ca-app-pub-1/222");

  // A rule with a missing entitlement duration is refused with the field marked.
  await page.getByRole("button", { name: "New rule" }).click();
  const d2 = page.getByRole("dialog", { name: "New reward rule" });
  await d2.getByLabel("Name").fill("A day of Pro");
  await d2.getByRole("button", { name: "Temporary access" }).click();
  await d2.getByLabel("For").fill("");
  await d2.getByRole("button", { name: "Add rule" }).click();
  await expect(d2.getByRole("alert").first()).toBeVisible();
  await d2.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Send a test reward" }).click();
  const t = page.getByRole("dialog", { name: "Send a test reward" });
  await t.getByLabel("App user ID").fill("gamer_1");
  await t.getByLabel("Ad unit (optional)").fill("222");
  await t.getByRole("button", { name: "Send test reward" }).click();
  await expect(page.getByText("Granted 25 GEMS to gamer_1.")).toBeVisible();
  const row = page.locator("table tbody tr").first();
  await expect(row).toContainText("gamer_1");
  await expect(row).toContainText("verified");
  await expect(row).toContainText("25 GEMS");
  const balances = await json(req, "GET", `/v1/subscribers/gamer_1/virtual_currencies`, undefined, { authorization: `Bearer ${iosKey}` });
  expect(balances.virtual_currencies.GEMS.balance).toBe(25);
  // The SDK's poll for that reward answers verified.
  const ledger = await json(req, "GET", `${P}/ads/reward_verifications`);
  const poll = await json(req, "GET", `/v1/subscribers/gamer_1/ads/reward_verifications/${ledger.items[0].client_transaction_id}`, undefined, { authorization: `Bearer ${iosKey}` });
  expect(poll).toEqual({ status: "verified", reward: { type: "virtual_currency", code: "GEMS", amount: 25 }, more_rewards: [] });

  // Turn the rule off: the next test reward is verified with nothing granted.
  await page.getByRole("switch", { name: "On" }).click();
  await expect(page.getByRole("switch", { name: "Off" })).toBeVisible();
  await page.getByRole("button", { name: "Send a test reward" }).click();
  await page.getByRole("dialog", { name: "Send a test reward" }).getByLabel("App user ID").fill("gamer_2");
  await page.getByRole("dialog", { name: "Send a test reward" }).getByRole("button", { name: "Send test reward" }).click();
  await expect(page.getByText("Verified, but no rule matched, so nothing was granted.")).toBeVisible();
  expect(errors).toEqual([]);
});

async function fakePartner(): Promise<{ server: Server; origin: string; bodies: any[] }> {
  const bodies: any[] = [];
  const server = createServer((r, res) => {
    const chunks: Buffer[] = [];
    r.on("data", (c: Buffer) => chunks.push(c));
    r.on("end", () => { bodies.push({ path: r.url, auth: r.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || "null") }); res.writeHead(200); res.end("{}"); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies };
}

test("integrations: 38 cards by category, Superwall through the webhook adapter, Statsig, AdMob, Zendesk, Intercom inbox", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = watchConsole(page);
  await signedIn(page);
  await page.goto(`/projects/${pid}/integrations`);
  const rail = page.getByRole("navigation", { name: "Integration categories" });
  await expect(rail.getByRole("button", { name: /All categories/ })).toContainText("38");
  for (const [label, n] of [["Analytics", 9], ["Attribution", 14], ["Marketing", 9], ["Ads", 1], ["Support", 2], ["Core tools", 3]] as const) {
    await expect(rail.getByRole("button", { name: new RegExp(`^${label}`) })).toContainText(String(n));
  }
  await expect(page.locator('[data-integration="superwall"]')).toContainText("Via webhook");
  await page.getByLabel("Search integrations").fill("braze");
  await expect(page.locator(".cards .card")).toHaveCount(1);
  await page.getByLabel("Search integrations").fill("");

  // Superwall: RevenueCat's webhook body to the URL Superwall gives you (a local fake here).
  const fake = await fakePartner();
  try {
    await page.goto(`/projects/${pid}/integrations/superwall`);
    await expect(page.getByText("Superwall publishes no event API of its own.")).toBeVisible();
    await page.locator("#f-webhook_url").fill(`${fake.origin}/revenuecat/webhook`);
    await page.getByRole("button", { name: "Connect Superwall" }).click();
    await expect(page.getByText("Superwall is connected. Send a test event to check it.")).toBeVisible();
    await page.getByRole("button", { name: "Send test event" }).click();
    await page.getByRole("dialog", { name: "Send a test event" }).getByRole("button", { name: "Send test event" }).click();
    await expect(page.locator("table tbody tr").first()).toContainText("delivered", { timeout: 30_000 });
    expect(fake.bodies[0]).toMatchObject({ path: "/revenuecat/webhook", body: { api_version: "1.0", event: { type: "TEST" } } });
  } finally { fake.server.close(); }

  // Statsig: saved with its key check; Statsig is an outside host, so the e2e server's delivery fails and says why.
  await page.goto(`/projects/${pid}/integrations/statsig`);
  await page.locator("#f-server_secret").fill("not-a-statsig-key");
  await page.getByRole("button", { name: "Connect Statsig" }).click();
  await expect(page.getByRole("alert").first()).toContainText("secret-");
  await page.locator("#f-server_secret").fill("secret-e2e-key");
  await page.getByRole("button", { name: "Connect Statsig" }).click();
  await expect(page.getByText("Statsig is connected. Send a test event to check it.")).toBeVisible();

  // AdMob: no server OAuth client on the e2e server; a project's own client sends the browser to Google (intercepted).
  await page.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google sign-in (intercepted)</title><h1>Google</h1>" }));
  await page.goto(`/projects/${pid}/integrations/admob`);
  await expect(page.getByText("This server has no Google OAuth client.")).toBeVisible();
  await expect(page.locator(".copyfield code").first()).toHaveText(/\/v1\/ads\/admob\/oauth\/callback$/);
  await page.getByLabel("Client ID").fill("not-a-client");
  await page.getByLabel("Client secret").fill("GOCSPX-e2e");
  await page.getByRole("button", { name: "Save and connect with Google" }).click();
  await expect(page.getByRole("alert").first()).toContainText("apps.googleusercontent.com");
  await page.getByLabel("Client ID").fill("123-e2e.apps.googleusercontent.com");
  await page.getByRole("button", { name: "Save and connect with Google" }).click();
  await page.waitForURL(/accounts\.google\.com/);
  const google = new URL(page.url());
  expect(google.searchParams.get("client_id")).toBe("123-e2e.apps.googleusercontent.com");
  expect(google.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/admob.readonly");
  // Back from Google with an expired or reused state: the page explains what to do.
  await page.goto(`/v1/ads/admob/oauth/callback?code=x&state=${encodeURIComponent(`${pid}.unknown`)}`);
  await expect(page.getByRole("alert").first()).toContainText("This AdMob sign-in link is not valid");

  // Zendesk and the Intercom inbox.
  await page.goto(`/projects/${pid}/integrations/zendesk`);
  await expect(page.getByRole("link", { name: "integrations/zendesk-app" })).toBeVisible();
  await page.getByRole("button", { name: "Mark as installed" }).click();
  await expect(page.getByText(/Installed/)).toBeVisible();
  await page.goto(`/projects/${pid}/integrations/intercom_inbox`);
  await expect(page.locator(".copyfield code").first()).toHaveText(new RegExp(`/v1/support/intercom/${pid}/canvas$`));
  await page.locator("#f-client_secret").fill("ic-e2e-secret");
  await page.getByRole("button", { name: "Connect Intercom inbox" }).click();
  await expect(page.getByText("Intercom inbox is connected.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Deliveries" })).toHaveCount(0);

  await page.goto(`/projects/${pid}/integrations`);
  await page.getByRole("navigation", { name: "Integration categories" }).getByRole("button", { name: /^Active/ }).click();
  await expect(page.locator(".cards .card")).toHaveCount(5);
  expect(errors).toEqual([]);
});
