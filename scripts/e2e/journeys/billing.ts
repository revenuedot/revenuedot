// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (billing), RevenueDot Cloud billing (prd/cloud-billing/PRD.md) on a real Node server run as Cloud
// (REVENUEDOT_EDITION=cloud) with its own Railway development database, and RevenueDot's own Stripe account played by a
// fake on the capture server (packages/contract/src/fake-billing-stripe.ts; Stripe is never called):
//   - A developer signs up; a live-mode Stripe subscription of $12,000 a year from their app (the developer's own Stripe,
//     the web-billing fake) is real production revenue; the server's own tick meters it, and the "passed Cloud Free" email
//     arrives through SMTP. Sandbox purchases do not count.
//   - In Chromium: the Billing page shows the plan, the tracked revenue and the banner; Upgrade goes through the fake
//     Checkout page, whose signed webhooks make the account Standard; the meter gets the month's bill ($10.00) at once.
//   - Manage billing opens the fake Customer Portal; cancelling shows the end date. A failed invoice payment shows the
//     banner on every page and emails once; the app keeps working; payment recovers it.
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, sdkClient, standardCatalog, type Dev } from "./lib/context.ts";
import { DB_PREFIX, PORT_BASE, PORTS, RdServer, ROOT, createDatabase, dropDatabase, hideUrls, linksOf, postgres, type Captured } from "./lib/stack.ts";
import { FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";
import { FAKE_BILLING_KEY, FAKE_BILLING_PRICE, FAKE_BILLING_WEBHOOK_SECRET, FakeBillingStripe } from "../../../packages/contract/src/fake-billing-stripe.ts";

const chromium = () => (createRequire(join(ROOT, "apps/dashboard/package.json"))("playwright") as typeof import("playwright")).chromium;
const DAY = 86400_000;

const journey: Journey = {
  name: "billing",
  title: "Cloud billing: metered production revenue, upgrade through Checkout, the meter, Portal, failed payment",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dbName = `${DB_PREFIX}${ctx.stamp}_billing`;
    const url = await createDatabase(dbName);
    const port = PORT_BASE + 8;
    const S = new RdServer({
      databaseUrl: url, port, smtpPort: PORTS.smtp, capturePort: PORTS.capture, logDir: join(ctx.out, "cloud"),
      env: { REVENUEDOT_EDITION: "cloud", REVENUEDOT_BILLING_STRIPE_SECRET_KEY: FAKE_BILLING_KEY, REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET: FAKE_BILLING_WEBHOOK_SECRET, REVENUEDOT_BILLING_PRICE_STANDARD: FAKE_BILLING_PRICE },
    });
    const sql = postgres(url, { max: 2, onnotice: () => {} });
    // RevenueDot's own Stripe account: API calls with the billing key, and its Checkout and Portal pages, on the capture server.
    const billing = new FakeBillingStripe();
    billing.checkoutUrl = `${ctx.capture.base}/__billing/checkout/{id}`;
    billing.portalUrl = `${ctx.capture.base}/__billing/portal/{id}`;
    const send = async (type: string, object: Record<string, unknown>) => {
      const e = await billing.event(type, object);
      const r = await fetch(`${S.base}/v2/billing/stripe/webhook`, { method: "POST", headers: { "stripe-signature": e.signature, "content-type": "application/json" }, body: e.body });
      return r.status;
    };
    const html = (res: ServerResponse, title: string, body: string) => { res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>${body}`); };
    ctx.capture.handlers.unshift(async (cap: Captured, res: ServerResponse) => {
      if (cap.host === "api.stripe.com" && cap.headers.authorization === `Bearer ${FAKE_BILLING_KEY}`) {
        const r = await billing.fetch(`https://api.stripe.com${cap.path}${cap.query}`, { method: cap.method, headers: cap.headers, body: ["GET", "HEAD"].includes(cap.method) ? undefined : cap.body });
        res.statusCode = r.status; res.setHeader("content-type", "application/json"); res.end(await r.text()); return true;
      }
      if (cap.host !== "local") return false;
      const co = /^\/__billing\/checkout\/([^/]+)$/.exec(cap.path);
      if (co) {
        const s = billing.sessions.get(co[1]!);
        if (!s) { res.statusCode = 404; res.end("no session"); return true; }
        if (cap.method === "POST") {
          const { subscription } = billing.complete(s.id);
          await send("checkout.session.completed", billing.sessions.get(s.id)!);
          await send("customer.subscription.created", subscription);
          res.statusCode = 303; res.setHeader("location", s.success_url); res.end(); return true;
        }
        html(res, "Fake Stripe Checkout", `<form method="post"><button type="submit">Subscribe</button></form>`); return true;
      }
      const po = /^\/__billing\/portal\/([^/]+)$/.exec(cap.path);
      if (po) {
        const s = billing.portalSessions.find((x) => x.id === po[1]);
        if (!s) { res.statusCode = 404; res.end("no session"); return true; }
        if (cap.method === "POST") {
          const sub = [...billing.subscriptions.values()].find((x) => x.customer === s.customer)!;
          await send("customer.subscription.updated", billing.updateSubscription(sub.id, { cancel_at_period_end: true }));
          res.statusCode = 303; res.setHeader("location", s.return_url); res.end(); return true;
        }
        html(res, "Fake Stripe Customer Portal", `<form method="post"><button type="submit">Cancel plan</button></form>`); return true;
      }
      return false;
    });
    const browser = await chromium().launch();
    const consoleErrors: string[] = [];
    try {
      await S.start();
      c.begin("a Cloud developer with production revenue from their own Stripe");
      const email = `payer-${ctx.stamp}@journeys.test`;
      const su = await fetch(`${S.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: `journey-${ctx.stamp}-pay`, name: "Payer", project_name: "Paid app" }) });
      c.must("Cloud sign-up", su.status === 201, await su.text());
      const cookie = `rd_session=${/rd_session=([^;]+)/.exec(su.headers.get("set-cookie") ?? "")?.[1]}`;
      const call = async (method: string, path: string, json?: unknown) => {
        const r = await fetch(S.base + path, { method, headers: { cookie, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
        const t = await r.text();
        return { status: r.status, body: t ? JSON.parse(t) : null };
      };
      const me = await call("GET", "/auth/me");
      const pid = me.body.projects[0].id as string;
      const dev: Dev = { email, password: "", cookie, projectId: pid, call: (m, p, j, h = {}) => fetch(S.base + p, { method: m, headers: { cookie, ...h, ...(j !== undefined ? { "content-type": "application/json" } : {}) }, body: j === undefined ? undefined : JSON.stringify(j) }).then(async (r) => { const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null, headers: r.headers }; }), v2: async (m, p, j) => (await call(m, `/v2/projects/${pid}${p}`, j)).body, v2r: (m, p, j) => call(m, `/v2/projects/${pid}${p}`, j) as never };
      const before = await call("GET", "/v2/billing");
      c.has("Billing starts on Cloud Free with $0 tracked", before.body, { account: { plan: "free", status: "none" }, usage: { tracked_revenue_usd: 0, bill_usd: 0 }, stripe_ready: true });
      const cat = await standardCatalog(dev);
      // Sandbox revenue never counts: a Test Store purchase.
      const sdk = sdkClient({ ...ctx, base: S.base }, cat.testKey);
      await sdk.purchase(`sbx_${ctx.stamp}`, "pro_monthly");
      // A live Stripe subscription of $12,000 a year, posted by the developer's backend (prd/store-stripe).
      const stripeApp = await dev.v2("POST", "/apps", { name: "Web", type: "stripe", stripe: { stripe_secret_key: FAKE_STRIPE_KEY, stripe_webhook_secret: `whsec_bill${ctx.stamp}` } });
      const stripeKey = (await dev.v2("GET", `/apps/${stripeApp.id}/public_api_keys`)).items[0].key as string;
      const price = { id: `price_live_year${ctx.stamp}`, object: "price", active: true, currency: "usd", product: `prod_year${ctx.stamp}`, recurring: { interval: "year", interval_count: 1 }, type: "recurring", unit_amount: 1_200_000, livemode: true };
      const prod = await dev.v2("POST", "/products", { store_identifier: price.id, app_id: stripeApp.id, type: "subscription", display_name: "Team yearly", subscription: { duration: "P1Y" } });
      await dev.v2("POST", `/entitlements/${cat.pro.id}/actions/attach_products`, { product_ids: [prod.id] });
      const id = `sub_bill_${ctx.stamp}`;
      const start = Date.now() - 60_000, end = start + 365 * DAY;
      ctx.capture.stripe.invoices.set(`in_${id}`, { id: `in_${id}`, object: "invoice", amount_due: 1_200_000, amount_paid: 1_200_000, amount_remaining: 0, attempt_count: 1, billing_reason: "subscription_create", collection_method: "charge_automatically", currency: "usd", customer: `cus_${id}`, customer_address: { country: "US" }, livemode: true, next_payment_attempt: null, period_start: Math.floor(start / 1000), period_end: Math.floor(start / 1000), paid: true, status: "paid", total: 1_200_000, subscription: id, status_transitions: { paid_at: Math.floor(start / 1000), finalized_at: Math.floor(start / 1000) }, lines: { data: [{ period: { start: Math.floor(start / 1000), end: Math.floor(end / 1000) }, price }] } });
      ctx.capture.stripe.subscriptions.set(id, { id, object: "subscription", status: "active", livemode: true, customer: `cus_${id}`, created: Math.floor(start / 1000), start_date: Math.floor(start / 1000), billing_cycle_anchor: Math.floor(start / 1000), current_period_start: Math.floor(start / 1000), current_period_end: Math.floor(end / 1000), trial_start: null, trial_end: null, cancel_at_period_end: false, cancel_at: null, canceled_at: null, ended_at: null, cancellation_details: { comment: null, feedback: null, reason: null }, pause_collection: null, currency: "usd", metadata: { app_user_id: `team_${ctx.stamp}` }, latest_invoice: `in_${id}`, collection_method: "charge_automatically", items: { object: "list", data: [{ id: `si_${id}`, object: "subscription_item", price, quantity: 1 }] } });
      const posted = await sdkClient({ ...ctx, base: S.base }, stripeKey, "stripe").call("POST", "/v1/receipts", { app_user_id: `team_${ctx.stamp}`, fetch_token: id });
      c.check("the live Stripe subscription is recorded (production)", posted.status === 200, posted.body);
      const tx = await sql`SELECT is_sandbox, revenue_usd FROM transactions WHERE project_id = ${pid} ORDER BY revenue_usd`;
      c.check("SQL: a sandbox purchase and a $12,000 production purchase", tx.length === 2 && tx[0]!.is_sandbox === true && tx[1]!.is_sandbox === false && Number(tx[1]!.revenue_usd) === 12_000, tx);

      c.begin("the server's tick meters it and emails once");
      const metered = await until(async () => { const r = await call("GET", "/v2/billing"); return r.body.usage.tracked_revenue_usd === 12_000 ? r.body : null; }, { timeoutMs: 90_000, everyMs: 2000 });
      c.has("tracked revenue $12,000 (sandbox left out), Free bill $0, Standard would be $10.00, over the free limit", metered, { usage: { tracked_revenue_usd: 12_000, bill_usd: 0, standard_bill_usd: 10 }, flags: ["over_free_limit"] });
      const usageMail = await until(async () => ctx.mails.find((m) => m.to.includes(email) && /passed RevenueDot Cloud Free/.test(m.subject)), { timeoutMs: 20_000 });
      c.check("the 'passed Cloud Free' email arrived through SMTP, with the Billing link", !!usageMail && linksOf(usageMail).some((l) => l.endsWith("/account/billing")), usageMail?.subject);

      c.begin("Billing page: Upgrade through Checkout");
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addCookies([{ name: "rd_session", value: cookie.split("=")[1]!, url: S.base }]);
      const page = await context.newPage();
      page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
      await page.goto(`${S.base}/account/billing`);
      await page.locator("[data-tracked]").filter({ hasText: "$12,000.00" }).waitFor({ timeout: 20_000 });
      c.check("the page shows $12,000 tracked and the over-limit banner", (await page.locator("body").innerText()).includes("above Cloud Free's $10,000"));
      await page.screenshot({ path: join(ctx.out, "billing-free.png"), fullPage: true });
      await page.getByRole("button", { name: "Upgrade to Standard" }).click();
      await page.getByRole("heading", { name: "Fake Stripe Checkout" }).waitFor();
      const session = [...billing.sessions.values()][0]!;
      c.has("Checkout: the metered price, anchored to the 1st of next month, no proration", session, { mode: "subscription", subscription_data: { proration_behavior: "none" } });
      await page.getByRole("button", { name: "Subscribe" }).click();
      await page.waitForURL(/\/account\/billing\?checkout=success/);
      await page.locator("[data-plan=standard]").getByText("Current").waitFor({ timeout: 20_000 });
      const acct = await sql`SELECT plan, status, stripe_customer_id IS NOT NULL AS has_customer FROM billing_accounts`;
      c.has("SQL: the account is Standard and active", acct[0], { plan: "standard", status: "active", has_customer: true });
      const meter = await until(async () => billing.meterEvents.at(-1), { timeoutMs: 15_000 });
      c.has("the meter got this month's bill in cents at once", meter, { event_name: "revenuedot_cloud_bill_cents", payload: { value: "1000" } });
      c.check("the bill shows $10.00", ((await page.locator("[data-bill]").textContent()) ?? "") === "$10.00");
      await page.screenshot({ path: join(ctx.out, "billing-standard.png"), fullPage: true });

      c.begin("Customer Portal, then a failed payment and its recovery");
      await page.locator("[data-plan=standard]").getByRole("button", { name: "Manage billing" }).click();
      await page.getByRole("heading", { name: "Fake Stripe Customer Portal" }).waitFor();
      await page.getByRole("button", { name: "Cancel plan" }).click();
      await page.waitForURL(/\/account\/billing$/);
      await page.getByText(/Ends /).waitFor({ timeout: 10_000 });
      c.check("cancelling at period end shows the end date", true);
      const cust = (await sql`SELECT stripe_customer_id FROM billing_accounts`)[0]!.stripe_customer_id as string;
      const inv = billing.invoice(cust, { amount_due: 1000, status: "open" });
      c.eq("the payment_failed webhook is accepted", await send("invoice.payment_failed", inv), 200);
      await send("invoice.payment_failed", inv);
      await page.goto(`${S.base}/projects/${pid}/overview`);
      await page.locator(".verify-banner").filter({ hasText: "A RevenueDot payment failed" }).waitFor({ timeout: 10_000 });
      c.check("every page shows the failed payment with a way to fix it", true);
      const failed = await until(async () => ctx.mails.filter((m) => m.to.includes(email) && m.subject === "Your RevenueDot payment failed"), { timeoutMs: 15_000 });
      c.eq("one 'payment failed' email for the invoice (sent twice by Stripe)", failed.length, 1);
      const app = await sdk.customerInfo(`team_${ctx.stamp}`);
      c.check("the app keeps working: customer info still has pro", Object.keys(app.body.subscriber?.entitlements ?? {}).includes("pro"), app.body);
      await send("invoice.paid", { ...inv, status: "paid", amount_paid: 1000 });
      const fixed = await call("GET", "/v2/billing");
      c.has("paid: active again, no banner", fixed.body, { account: { status: "active" }, flags: [] });
      c.check("no console errors in the dashboard", consoleErrors.length === 0, consoleErrors.slice(0, 5));
      await context.close();
    } finally {
      await browser.close().catch(() => {});
      S.stop();
      await sql.end().catch(() => {});
      if (process.env.KEEP_DB !== "1") await dropDatabase(dbName).catch((e) => console.error("drop failed", hideUrls(String(e))));
    }
  },
};

export default journey;
