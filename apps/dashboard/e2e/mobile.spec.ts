/**
 * Phone width (390×844) for the dashboard pages changed most recently: no page scrolls sideways, and every button, input,
 * select and switch in the page (or the open dialog) is on screen, at least partly visible and the element a tap at its
 * centre reaches. The demo project (e2e@revenuedot.test) covers Charts and Refund Control, read-only; a fresh account
 * covers the rest, so nothing here changes the demo data other specs count. SHOTS=<dir> saves a full-page screenshot of
 * each check.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function json<T = any>(req: APIRequestContext, method: string, path: string, data?: unknown): Promise<T> {
  const res = await req.fetch(path, { method, data, headers: data === undefined ? {} : { "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Controls a phone user cannot reach: off screen sideways, zero-sized, or covered by another element at their centre. */
async function unreachable(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].filter((d) => d.offsetParent || getComputedStyle(d).position === "fixed").at(-1);
    const root = dialog ?? document.querySelector<HTMLElement>(".main") ?? document.body;
    const name = (el: HTMLElement) => `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}${el.id ? `#${el.id}` : ""} "${(el.innerText || (el as HTMLInputElement).value || "").trim().slice(0, 40)}"`;
    const out: string[] = [];
    const els = [...root.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, [role="switch"], [role="tab"], a.btn')];
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[hidden], [aria-hidden='true'], details:not([open]) > :not(summary)")) continue;
      // Visually hidden native inputs behind a styled control (Check, Switch, radio cards): their label is the target.
      const proxy = (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && (Number(cs.opacity) === 0 || el.getBoundingClientRect().width <= 1)) ? (el.closest("label") ?? el.labels?.[0] ?? null) : el;
      if (!proxy) continue;
      let r = proxy.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // not rendered (inside a collapsed parent)
      proxy.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise((d) => requestAnimationFrame(() => d(null)));
      r = proxy.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { out.push(`${name(el)} has no size`); continue; }
      if (r.left < -1 || r.right > innerWidth + 1) { out.push(`${name(el)} is off screen (x ${Math.round(r.left)}–${Math.round(r.right)} of ${innerWidth})`); continue; }
      // The tap point: the centre of the part inside any clipping scroll container.
      let left = r.left, right = r.right;
      for (let p = proxy.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(ps.overflowX)) { const pr = p.getBoundingClientRect(); left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
      }
      if (right - left < 8) { out.push(`${name(el)} is clipped by its container`); continue; }
      const x = (left + right) / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit) { out.push(`${name(el)} is outside the viewport`); continue; }
      if (!(proxy.contains(hit) || hit.contains(proxy) || (el instanceof HTMLInputElement && [...(el.labels ?? [])].some((l) => l.contains(hit))))) {
        out.push(`${name(el)} is covered by ${hit.tagName.toLowerCase()}.${String((hit as HTMLElement).className).trim().replace(/\s+/g, ".")}`);
      }
    }
    // Put every scroller back, so the screenshot shows what a visitor first sees.
    for (const el of document.querySelectorAll<HTMLElement>("*")) if (el.scrollLeft || el.scrollTop) el.scrollTo(0, 0);
    scrollTo(0, 0);
    return out;
  });
}

/** The checks for one page state at 390px, plus a screenshot when SHOTS is set. */
async function check(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: innerWidth }));
  expect(sw, `${name}: the page scrolls sideways (${sw}px wide at ${iw}px)`).toBeLessThanOrEqual(iw);
  expect(await unreachable(page), `${name}: controls a phone cannot tap`).toEqual([]);
  if (process.env.SHOTS) {
    // The page scrolls inside the shell (and dialogs inside themselves): grow the viewport to the tallest scroller for one shot.
    const tall = await page.evaluate(() => Math.max(innerHeight, ...[...document.querySelectorAll<HTMLElement>("*")]
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)
      .map((el) => innerHeight + el.scrollHeight - el.clientHeight)));
    await page.setViewportSize({ width: 390, height: Math.min(tall, 6000) });
    await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
  }
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${page.url()}: ${m.text()}`); });
  return errors;
}

test.describe.configure({ mode: "serial" });

test("phone width: Charts segment pickers and Refund Control on the demo project", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  expect((await page.request.post("/auth/login", { data: { email: "e2e@revenuedot.test", password: "e2e-password-1" } })).ok()).toBe(true);
  const pid: string = (await json(page.request, "GET", "/auth/me")).projects[0].id;

  await test.step("Charts: segment by Renewal Cycle, Offer type and a custom attribute", async () => {
    await page.goto(`/projects/${pid}/charts/revenue`);
    const segment = page.getByLabel("Segment");
    await expect(segment).toBeVisible();
    const values = await segment.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const attribute = values.find((v) => v.startsWith("custom_attribute:"));
    expect(attribute, "a custom attribute segment").toBeTruthy();
    for (const [id, shot] of [["subscription_renewal_cycle_group", "charts-renewal-cycle"], ["offer_type", "charts-offer-type"], [attribute!, "charts-custom-attribute"]] as const) {
      await segment.selectOption(id);
      await expect(page).toHaveURL(new RegExp(`segment=${encodeURIComponent(id).replace(/%3A/g, "(%3A|:)")}`));
      await expect(page.locator("section.cpanel[aria-busy]")).toHaveCount(0);
      await check(page, shot);
    }
  });

  await test.step("Refund Control: the default policy set to Prefer prorated refund (not saved)", async () => {
    await page.goto(`/projects/${pid}/lifecycle/refund-control`);
    await expect(page.getByRole("heading", { name: "Refund Control" })).toBeVisible();
    await page.getByLabel("Default refund preference").selectOption({ label: "Prefer prorated refund" });
    await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeVisible();
    await check(page, "refund-control-prorated");
  });

  expect(errors).toEqual([]);
});

test("phone width: integrations, catalog, exports, customer history, notifications and Verified Metrics on a fresh account", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const req = page.request;
  const stamp = Date.now();
  await json(req, "POST", "/auth/signup", { email: `mobile-${stamp}@revenuedot.test`, password: `e2e-${stamp}-pw`, name: "Mobile e2e", project_name: "Mobile e2e" });
  const pid: string = (await json(req, "GET", "/auth/me")).projects[0].id;
  const P = `/v2/projects/${pid}`;
  const app = await json(req, "POST", `${P}/apps`, { name: "Test Store", type: "test_store" });
  await json(req, "POST", `${P}/apps`, { name: "Mobile iOS", type: "app_store", app_store: { bundle_id: "com.example.mobile" } });
  const key: string = (await json(req, "GET", `${P}/apps/${app.id}/public_api_keys`)).items[0].key;
  const prod = await json(req, "POST", `${P}/products`, { app_id: app.id, store_identifier: "mobile_monthly", type: "subscription", subscription: { duration: "P1M" }, test_store_price: { amount_micros: 4_990_000, currency: "USD" } });
  await json(req, "POST", `${P}/test_purchases`, { app_user_id: "phone_viewer", product_id: prod.id, app_id: app.id, offset_days: 1 });
  await test.step("AppsFlyer settings", async () => {
    await page.goto(`/projects/${pid}/integrations/appsflyer`);
    await expect(page.getByRole("heading", { name: "AppsFlyer", exact: true })).toBeVisible();
    await check(page, "appsflyer");
  });

  await test.step("Meta Ads with the App Events API type", async () => {
    await page.goto(`/projects/${pid}/integrations/meta`);
    await page.getByLabel("Integration type").selectOption("app_events");
    await expect(page.getByLabel("Sandbox client token", { exact: true })).toBeVisible();
    await check(page, "meta-app-events");
  });

  await test.step("PostHog with the Paywall events group", async () => {
    await page.goto(`/projects/${pid}/integrations/posthog`);
    await expect(page.getByRole("group", { name: "Paywall events" })).toBeVisible();
    await page.getByLabel("Project API key", { exact: true }).fill("phc_live_e2e");
    await page.getByLabel("Region").selectOption("custom");
    // Nothing listens there: deliveries fail, but the connection is what makes the server keep paywall events.
    await page.getByLabel("PostHog URL").fill("http://127.0.0.1:9");
    await page.getByRole("group", { name: "Paywall events" }).getByLabel("Send paywall events").check();
    await check(page, "posthog-paywall-events");
    await page.getByRole("button", { name: "Connect PostHog" }).click();
    await expect(page.getByText("PostHog is connected.")).toBeVisible();
  });

  await test.step("New product dialog: the App Store billing plan hint", async () => {
    await page.goto(`/projects/${pid}/product-catalog/products`);
    await page.getByRole("button", { name: "New product" }).first().click();
    await page.getByRole("menuitem", { name: "Create from scratch" }).click();
    const d = page.getByRole("dialog", { name: "New product" });
    await d.getByLabel("App", { exact: true }).selectOption({ label: "Mobile iOS (App Store)" });
    await expect(d.getByText("productId:monthly", { exact: false })).toBeVisible();
    await check(page, "new-product-billing-plan");
    await d.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("Test Store price editor with four currencies", async () => {
    await page.goto(`/projects/${pid}/product-catalog/products/${prod.id}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const d = page.getByRole("dialog", { name: "Edit product" });
    for (const [i, amount] of [[2, "4.49"], [3, "3.99"], [4, "749"]] as const) {
      await d.getByRole("button", { name: "Add currency" }).click();
      await d.getByLabel(`Amount ${i}`).fill(amount);
    }
    await expect(d.getByTestId("price-row")).toHaveCount(4);
    await check(page, "test-store-prices");
    await d.getByRole("button", { name: "Cancel" }).click();
  });

  await test.step("Data export form: Azure, column picker, every few hours; then email", async () => {
    await page.goto(`/projects/${pid}/integrations/exports/new`);
    await page.getByLabel("Name", { exact: true }).fill("Phone export");
    await page.getByLabel("Storage").selectOption("azure");
    await page.getByRole("checkbox", { name: /paywall_events/ }).check();
    await page.getByText(/^transactions columns: all \d+$/).click();
    await page.getByRole("checkbox", { name: "Every column of transactions" }).uncheck();
    await page.getByRole("button", { name: "Every few hours" }).click();
    await page.getByLabel("Every", { exact: true }).selectOption("8");
    await check(page, "export-azure-columns-interval");
    await page.getByLabel("Storage").selectOption("email");
    await expect(page.getByLabel("Recipients")).toBeVisible();
    await check(page, "export-email");
  });

  await test.step("Customer history with Show paywall events", async () => {
    const now = Date.now();
    const sent = await req.fetch("/v1/events", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, data: { events: Array.from({ length: 3 }, (_, i) => ({
      id: `mobile-${stamp}-${i}`, version: 1, type: "paywall_impression", app_user_id: "phone_viewer", paywall_id: "pw_mobile", session_id: `S-${i}`, offering_id: "default",
      paywall_revision: 1, timestamp: now - 60_000 + i * 1000, display_mode: "full_screen", dark_mode: false, locale: "en_US",
    })) } });
    expect(sent.status()).toBe(200);
    await expect.poll(async () => (await json(req, "GET", `${P}/customers/phone_viewer/events?limit=100&include_paywall_events=true`)).items.length, { timeout: 20_000 }).toBe(4);

    await page.goto(`/projects/${pid}/customers/phone_viewer`);
    const toggle = page.getByRole("switch", { name: "Show paywall events" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("list", { name: "Events, newest first" }).getByText(/^Saw the .*paywall$/)).toHaveCount(3);
    await check(page, "customer-paywall-events");
  });

  await test.step("Account → Notifications with the Integration failures switch", async () => {
    await page.goto("/account/notifications");
    await expect(page.getByRole("switch", { name: "Email me when an integration keeps failing" })).toBeVisible();
    await check(page, "account-notifications");
  });

  await test.step("Verified Metrics: chart types and the custom domain panel with its DNS records", async () => {
    await page.goto(`/projects/${pid}/settings/verified-metrics`);
    await page.getByLabel("Chart type").selectOption("line");
    await page.getByLabel("Domain", { exact: true }).fill(`metrics.mobile-${stamp}.example`);
    await page.getByRole("button", { name: "Save domain" }).click();
    await expect(page.getByRole("table", { name: "DNS records" })).toBeVisible();
    await check(page, "verified-metrics");
  });

  expect(errors).toEqual([]);
});
