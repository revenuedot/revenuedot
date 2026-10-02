// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (connect-recovery), "Connect with Stripe" (prd/web-billing/PRD.md §8) and failed-payment recovery
// (prd/payment-recovery/PRD.md), on the real Node server, a fresh Railway development database and Chromium:
//   - Connect unavailable: a second server on the same database without the platform keys shows the disabled button and
//     why, and the restricted-key form.
//   - Connect: the browser goes through Stripe's (fake) consent page and back; the account id is sealed (never in plain
//     columns), the webhook routing hash is its SHA-256; web products, a purchase link checkout and the hosted Checkout
//     page act on the connected account; a refund arrives through the platform's Connect endpoint.
//   - Recovery on Stripe: the renewal fails (past_due through the Connect endpoint), a case opens, the server's tick
//     emails the buyer through the real SMTP driver, the email's link opens the (fake) Stripe customer portal, the card
//     update pays the invoice, the renewal recovers the case: attributed revenue in SQL, the API and on the dashboard.
//   - Recovery on Google Play: an account hold from a real RTDN push (Play Developer API answered by a fake on the
//     capture server), the email, then SUBSCRIPTION_RECOVERED.
//   - Test Store billing issue: the sandbox email and one-click unsubscribe in the browser (suppression in SQL).
//   - Disconnect in RevenueDot, reconnect, RevenueDot removed in Stripe (account.application.deauthorized), and the
//     restricted-key path on the same app in the browser.
//   - The Payment recovery page and the Stripe app page at 1440 px, 390 px and in dark mode, with no console errors.
// Stripe, Apple and Google are never called: the capture server answers every store host.
import { createHash, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { sleep, until } from "./lib/check.ts";
import { type Ctx, signUp, sdkClient } from "./lib/context.ts";
import { linksOf, PORT_BASE, RdServer, ROOT, type Captured } from "./lib/stack.ts";
import { FAKE_CONNECT_CLIENT_ID, FAKE_PLATFORM_KEY, FAKE_PLATFORM_TEST_KEY, FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";

const chromium = () => (createRequire(join(ROOT, "apps/dashboard/package.json"))("@playwright/test") as typeof import("@playwright/test")).chromium;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const journey: Journey = {
  name: "connect-recovery",
  title: "Connect with Stripe (OAuth, sealed account, checkout, refund, disconnect, deauthorization) and payment recovery (Stripe, Google Play, Test Store) in a real browser",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c, sql } = ctx;
    ctx.capture.connectEndpoint = `${ctx.base}/v1/notifications/stripe-connect`;
    const dev = await signUp(ctx, "connect", "Scanner Pro");
    const P = dev.projectId;
    const browser = await chromium().launch();
    const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    // The session cookie from the real sign-up: the browser acts as the same developer.
    await bctx.addCookies([{ name: "rd_session", value: dev.cookie.replace(/^rd_session=/, ""), domain: "localhost", path: "/" }]);
    const page = await bctx.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error" && !/status of (400|404|409|422)/.test(m.text())) consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    // Stripe's OAuth page is the capture server's fake consent page.
    await page.route("https://connect.stripe.com/**", (route) => route.fulfill({ status: 302, headers: { location: `${ctx.capture.base}/__stripe/connect/authorize${new URL(route.request().url()).search}` } }));
    const shot = (name: string) => page.screenshot({ path: join(ctx.out, `${name}.png`) });
    const box = () => page.locator(".sc-box");
    /** The panel once loaded (the loading placeholder has no data-state). */
    const panelState = async () => (await until(async () => box().getAttribute("data-state").catch(() => null), { timeoutMs: 15_000 })) ?? null;
    const mailsTo = (to: string) => ctx.mails.filter((m) => m.to.includes(to.toLowerCase()));

    try {
      // =============================================================================================================
      c.begin("Connect unavailable on a server without the platform keys");
      const app = await dev.v2("POST", "/apps", { name: "Scanner Web", type: "stripe" });
      const plain = new RdServer({ ...ctx.server.o, port: PORT_BASE + 8, logDir: join(ctx.out, "no-connect"), env: {
        REVENUEDOT_ENCRYPTION_KEY: ctx.server.encryptionKey, REVENUEDOT_SIGNING_KEY: ctx.server.signingKey, REVENUEDOT_PUBLIC_URL: `http://localhost:${PORT_BASE + 8}`,
        REVENUEDOT_STRIPE_CONNECT_CLIENT_ID: "", REVENUEDOT_STRIPE_CONNECT_SECRET_KEY: "", REVENUEDOT_STRIPE_CONNECT_TEST_SECRET_KEY: "", REVENUEDOT_STRIPE_CONNECT_WEBHOOK_SECRET: "",
      } });
      await plain.start();
      try {
        await page.goto(`${plain.base}/projects/${P}/apps/${app.id}`);
        c.eq("the panel says unavailable", await panelState(), "unavailable");
        c.check("Connect with Stripe is disabled", await box().getByRole("button", { name: "Connect with Stripe" }).isDisabled());
        const why = await box().getByRole("note").textContent();
        c.check("it says the server is not set up and names the settings", /not set up on this server/.test(why ?? "") && /REVENUEDOT_STRIPE_CONNECT_CLIENT_ID/.test(why ?? ""), why);
        c.check("the restricted-key form is there", await page.getByLabel("Restricted key").isVisible());
        const api = await fetch(`${plain.base}/v2/projects/${P}/apps/${app.id}/stripe_connect`, { headers: { cookie: dev.cookie } }).then((r) => r.json()) as any;
        c.has("the API agrees", api, { available: false, status: "not_connected" });
        await shot("connect-unavailable");
      } finally { plain.stop(); }

      // =============================================================================================================
      c.begin("Connect with Stripe in the browser");
      const appUrl = `${ctx.base}/projects/${P}/apps/${app.id}`;
      await page.goto(appUrl);
      c.eq("available on the main server", await panelState(), "not_connected");
      await box().getByRole("button", { name: "Test" }).click();
      await box().getByRole("button", { name: "Connect with Stripe" }).click();
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("heading", { name: "Stripe was not connected" }).waitFor();
      c.check("cancelling on Stripe's page connects nothing", (await dev.v2("GET", `/apps/${app.id}/stripe_connect`)).status === "not_connected");
      await page.goto(appUrl);
      await box().getByRole("button", { name: "Test" }).click();
      await box().getByRole("button", { name: "Connect with Stripe" }).click();
      await page.getByRole("button", { name: "Connect my Stripe account" }).click();
      await page.waitForURL(/#credentials$/);
      await until(async () => (await box().getAttribute("data-state")) === "connected");
      const account = [...ctx.capture.platform.accounts.keys()].at(-1)!;
      const conn = await dev.v2("GET", `/apps/${app.id}/stripe_connect`);
      c.has("connected in test mode through OAuth", conn, { status: "connected", method: "oauth", mode: "test", account: `acct_…${account.slice(-4)}`, application_fee: null });
      const [row] = await sql`SELECT secrets, secret_hints, credentials FROM apps WHERE id = ${app.id}`;
      c.check("SQL: the account id is sealed (not in secrets, hints or credentials in plain)", !String(row!.secrets).includes(account) && !JSON.stringify(row!.secret_hints).includes(account) && !JSON.stringify(row!.credentials).includes(account) && String(row!.secrets).startsWith("v1:"), row);
      const [sc] = await sql`SELECT status, method, mode, account_hash, pending_state_hash FROM stripe_connections WHERE app_id = ${app.id}`;
      c.has("SQL: the connection row routes webhooks by the account's SHA-256", sc, { status: "connected", method: "oauth", mode: "test", account_hash: sha256(account), pending_state_hash: null });
      const exchange = ctx.capture.platform.calls.find((x) => x.path === "/oauth/token");
      c.check("the code was exchanged at connect.stripe.com with the platform key", exchange?.auth === `Bearer ${FAKE_PLATFORM_KEY}`, exchange);
      await shot("connect-connected");

      // =============================================================================================================
      c.begin("Selling on the connected account");
      const acct = ctx.capture.platform.accounts.get(account)!;
      const ent = await dev.v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro" });
      await dev.v2("PUT", `/apps/${app.id}/web_config`, { app_name: "Scanner Pro", support_email: "help@scanner.example", app_scheme: "scanner" });
      const prod = await dev.v2("POST", `/apps/${app.id}/web_products`, { display_name: "Pro annual", type: "subscription", price: { amount: 59.99, currency: "USD" }, duration: "P1Y", entitlement_ids: [ent.id] });
      c.check("the product and price were created on the connected account with the platform's test key", acct.writes("/v1/prices").length === 1 && acct.writes().every((x) => x.account === account && x.auth === `Bearer ${FAKE_PLATFORM_TEST_KEY}`), acct.writes().map((x) => [x.path, x.account]));
      const off = await dev.v2("POST", "/offerings", { lookup_key: "web", display_name: "Go Pro" });
      const pkg = await dev.v2("POST", `/offerings/${off.id}/packages`, { lookup_key: "$rc_annual", display_name: "Annual", position: 1 });
      await dev.v2("POST", `/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: prod.product.id, eligibility_criteria: "all" }] });
      const link = (await dev.v2("POST", "/purchase_links", { name: "Annual", offering_id: off.id, app_id: app.id })).url as string;
      const buy = async (user: string, email: string) => {
        await page.goto(`${link}?app_user_id=${user}`);
        await page.getByRole("button", { name: "Continue to payment" }).click();
        await page.waitForURL(/\/__stripe\/checkout\/cs_/);
        await page.getByRole("textbox").fill(email);
        await page.getByRole("button", { name: "Pay" }).click();
        await page.getByRole("heading", { name: "Thank you for your purchase" }).waitFor();
      };
      const S = ctx.stamp;
      await buy(`buyer_a_${S}`, `buyer-a-${S}@journeys.test`);
      await buy(`buyer_b_${S}`, `buyer-b-${S}@journeys.test`);
      const subs = await sql`SELECT a.app_user_id, s.store, s.is_sandbox, s.store_key FROM subscriptions s JOIN customer_aliases a ON a.customer_id = s.customer_id WHERE s.project_id = ${P} AND s.store = 'stripe' ORDER BY a.app_user_id`;
      c.check("SQL: both web subscriptions are recorded as Stripe sandbox purchases", subs.length === 2 && subs.every((x) => x.is_sandbox), subs);
      c.check("the Checkout Sessions live on the connected account", acct.sessions.size === 2 && ctx.capture.stripe.sessions.size === 0);
      const subA = subs.find((x) => x.app_user_id === `buyer_a_${S}`)!.store_key as string;
      const subB = subs.find((x) => x.app_user_id === `buyer_b_${S}`)!.store_key as string;

      c.begin("A refund through the Connect endpoint");
      const invB = acct.invoices.get(acct.subscriptions.get(subB)!.latest_invoice)!;
      const refund = await ctx.capture.deliverConnect(ctx.capture.platform.connectEvent(account, "charge.refunded", { id: `ch_${S}`, object: "charge", amount: invB.amount_paid, amount_refunded: invB.amount_paid, refunded: true, currency: "usd", invoice: invB.id, livemode: false, refunds: { data: [{ created: Math.floor(Date.now() / 1000) }] } }));
      c.has("the platform endpoint processed it", refund, { status: 200, body: { status: "processed" } });
      const refunds = await sql`SELECT kind, revenue_usd FROM transactions WHERE project_id = ${P} AND kind = 'refund'`;
      c.check("SQL: a refund transaction of -59.99", refunds.length === 1 && Math.abs(Number(refunds[0]!.revenue_usd) + 59.99) < 0.01, refunds);
      const [ev] = await sql`SELECT payload FROM events WHERE project_id = ${P} AND type = 'CANCELLATION'`;
      c.has("SQL: CANCELLATION (CUSTOMER_SUPPORT) for the web purchase", ev?.payload?.event, { cancel_reason: "CUSTOMER_SUPPORT", store: "STRIPE", app_id: app.id });

      // =============================================================================================================
      c.begin("Payment recovery on Stripe: failed renewal, email, portal, recovered");
      await dev.v2("POST", "/payment_recovery", { enabled: true, include_sandbox: true, window_days: 30, steps: (await dev.v2("GET", "/payment_recovery")).default_steps });
      const subObj = acct.subscriptions.get(subA)!;
      const failed = acct.failRenewal(subA, { startAt: Number(subObj.current_period_start) + 5 });
      const fail = await ctx.capture.deliverConnect(acct.event("invoice.payment_failed", failed));
      c.has("invoice.payment_failed processed", fail, { status: 200, body: { status: "processed" } });
      const [caseA] = await until(async () => { const r = await sql`SELECT * FROM recovery_cases WHERE project_id = ${P} AND store_key = ${subA}`; return r.length ? r : null; }) ?? [];
      c.has("SQL: an open sandbox case with the at-risk amount", caseA, { status: "open", is_sandbox: true, at_risk_usd: 59.99, store: "stripe" });
      const mailA = await until(async () => mailsTo(`buyer-a-${S}@journeys.test`).find((m) => /didn't go through/.test(m.subject)), { timeoutMs: 45_000 });
      c.check("the server's tick emailed the buyer through SMTP", !!mailA, ctx.mails.map((m) => [m.to, m.subject]));
      c.check("from the app's name, not RevenueDot", /Scanner Pro/.test(mailA?.raw.match(/^from:.*$/im)?.[0] ?? ""), mailA?.raw.match(/^from:.*$/im)?.[0]);
      const linksA = mailA ? linksOf(mailA) : [];
      const fix = linksA.find((l) => l.includes("/v1/recovery/l/"));
      const unsubA = linksA.find((l) => l.includes("/v1/recovery/u/"));
      c.check("the email has the update link and an unsubscribe link", !!fix && !!unsubA, linksA);
      const [msg] = await sql`SELECT step, error FROM recovery_messages WHERE case_id = ${caseA!.id}`;
      c.has("SQL: the message is recorded", msg, { step: 0, error: null });
      // Customer Center: management_url is a link of its own. Customer info is readable with the public SDK key, so for a
      // web purchase it never opens the portal: it emails the buyer a one-time 30-minute link.
      const sdk = sdkClient(ctx, (await dev.v2("GET", `/apps/${app.id}/public_api_keys`)).items[0].key, "stripe");
      const info = await sdk.customerInfo(`buyer_a_${S}`);
      const center = String(info.body?.subscriber?.management_url ?? "");
      c.check("customer info carries the Customer Center link as management_url, not the emailed one", center.includes(`/v1/recovery/c/${caseA!.center_token}`) && !center.includes(caseA!.token), center);
      const portalCalls = () => acct.calls.filter((x) => x.path === "/v1/billing_portal/sessions").length;
      const linkMails = () => mailsTo(`buyer-a-${S}@journeys.test`).filter((m) => /Your link to update your payment/.test(m.subject));
      const askForLink = async () => {
        await page.goto(center);
        await page.getByRole("heading", { name: "We'll email you a secure link" }).waitFor();
        await page.getByRole("button", { name: "Email me the link" }).click();
        return (await page.getByRole("heading").first().textContent())?.trim();
      };
      await page.goto(center);
      await page.getByRole("heading", { name: "We'll email you a secure link" }).waitFor();
      c.eq("opening it makes no portal session", portalCalls(), 0);
      c.eq("asking for the link answers Check your email", await askForLink(), "Check your email");
      const linkMail = await until(async () => linkMails()[0], { timeoutMs: 30_000 });
      const oneTime = linkMail ? linksOf(linkMail).find((l) => l.includes("/v1/recovery/p/")) : undefined;
      c.check("the one-time link arrives at the buyer's address through SMTP", !!oneTime, ctx.mails.map((m) => [m.to, m.subject]));
      const [pl] = await sql`SELECT token_hash, email, expires_at - created_at AS ttl FROM recovery_portal_links WHERE case_id = ${caseA!.id}`;
      c.check("SQL: only the token's hash is stored, for 30 minutes", !!pl && !oneTime!.includes(pl.token_hash) && pl.email === `buyer-a-${S}@journeys.test` && String(pl.ttl).startsWith("00:30"), pl);
      await page.goto(oneTime!);
      await page.getByRole("heading", { name: "Update your payment method" }).waitFor();
      c.eq("opening the emailed link (or a mail scanner) makes no portal session yet", portalCalls(), 0);
      await page.getByRole("button", { name: "Update payment method" }).click();
      await page.getByRole("heading", { name: "Fake Stripe customer portal" }).waitFor();
      c.eq("its button opens the portal on the connected account", portalCalls(), 1);
      await page.goto(oneTime!);
      await page.getByRole("button", { name: "Update payment method" }).click();
      await page.getByRole("heading", { name: "This link was already used" }).waitFor();
      c.eq("a used link is refused without a new session", portalCalls(), 1);
      c.eq("a second link can be asked for", await askForLink(), "Check your email");
      const second = await until(async () => linkMails()[1], { timeoutMs: 30_000 });
      const secondLink = second ? linksOf(second).find((l) => l.includes("/v1/recovery/p/")) : undefined;
      await sql`UPDATE recovery_portal_links SET expires_at = now() - interval '1 minute' WHERE case_id = ${caseA!.id} AND used_at IS NULL`;
      await page.goto(secondLink!);
      await page.getByRole("heading", { name: "This link has expired" }).waitFor();
      c.eq("an expired link is refused without a new session", portalCalls(), 1);
      c.eq("a third link in the hour is still sent", await askForLink(), "Check your email");
      c.eq("a fourth is refused: three links an hour per customer", await askForLink(), "Too many requests");
      await until(async () => linkMails().length >= 3 || null, { timeoutMs: 30_000 });
      c.eq("three link emails in all", linkMails().length, 3);
      // A GET of the unsubscribe link never unsubscribes (mail scanners follow links).
      await page.goto(unsubA!);
      await page.getByRole("heading", { name: "Unsubscribe?" }).waitFor();
      c.eq("GET leaves the address subscribed", (await sql`SELECT count(*)::int AS n FROM email_suppressions WHERE project_id = ${P}`)[0]!.n, 0);
      await page.goto(fix!);
      await page.getByRole("heading", { name: "Fake Stripe customer portal" }).waitFor();
      const portalCall = acct.calls.filter((x) => x.path === "/v1/billing_portal/sessions").at(-1);
      c.check("the portal session was made at the click, on the connected account, for a payment method update", portalCall?.account === account && portalCall?.params?.flow_data?.type === "payment_method_update", portalCall);
      await page.getByRole("button", { name: "Update payment method" }).click();
      await page.getByRole("heading", { name: "Thank you" }).waitFor();
      const [done] = await until(async () => { const r = await sql`SELECT * FROM recovery_cases WHERE id = ${caseA!.id} AND status = 'recovered'`; return r.length ? r : null; }) ?? [];
      c.has("SQL: recovered, attributed, with the renewal's revenue", done, { status: "recovered", attributed: true, recovered_usd: 59.99 });
      c.check("SQL: the click was recorded", !!done?.clicked_at);
      const renewals = await sql`SELECT count(*)::int AS n FROM events WHERE project_id = ${P} AND type = 'RENEWAL'`;
      c.eq("SQL: one RENEWAL", renewals[0]!.n, 1);
      const stats = await dev.v2("GET", "/payment_recovery/stats?environment=sandbox");
      c.has("API: recovered revenue", stats, { recovered: { count: 1, revenue_in_usd: 59.99 }, messages_sent: 1, clicked: 1 });
      c.check("management_url is null again", (await sdk.customerInfo(`buyer_a_${S}`)).body?.subscriber?.management_url === null);
      await page.goto(`${ctx.base}/projects/${P}/lifecycle/payment-recovery`);
      await page.getByRole("switch", { name: "Sandbox data" }).click();
      await until(async () => (await page.getByTestId("pr-revenue").textContent()) === "$59.99");
      c.eq("the dashboard shows the recovered revenue", await page.getByTestId("pr-revenue").textContent(), "$59.99");
      c.eq("and one recovered subscriber", await page.getByTestId("pr-recovered").textContent(), "1");
      await shot("recovery-stripe-recovered");

      // =============================================================================================================
      c.begin("Payment recovery on Google Play: account hold, email, SUBSCRIPTION_RECOVERED");
      const PKG = `com.example.recovery.j${S}`;
      const sa = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const SA = { type: "service_account", project_id: "recovery-journey", private_key_id: `k${S}`, private_key: sa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), client_email: `rd-${S}@recovery-journey.iam.gserviceaccount.com`, client_id: "1", token_uri: "https://oauth2.googleapis.com/token" };
      const gSubs = new Map<string, Record<string, unknown>>();
      const reply = (res: ServerResponse, status: number, body: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); return true; };
      ctx.capture.handlers.push((q: Captured, res: ServerResponse) => {
        if (q.host !== "androidpublisher.googleapis.com" || !q.path.includes(`/applications/${PKG}/`)) return false;
        const m = /\/purchases\/subscriptionsv2\/tokens\/([^/:]+)$/.exec(q.path);
        if (m && q.method === "GET") { const s = gSubs.get(decodeURIComponent(m[1]!)); return s ? reply(res, 200, s) : reply(res, 404, { error: { code: 404, message: "not found" } }); }
        return reply(res, 200, {});
      });
      const playSub = (state: string, expiry: number, order: string) => ({
        kind: "androidpublisher#subscriptionPurchaseV2", regionCode: "US", startTime: new Date(Date.now() - 31 * 86400_000).toISOString(), subscriptionState: state, latestOrderId: order,
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        lineItems: [{ productId: "recovery_pro", expiryTime: new Date(expiry).toISOString(), latestSuccessfulOrderId: order, autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { currencyCode: "USD", units: "7", nanos: 990000000 } }, offerDetails: { basePlanId: "monthly", offerTags: [] } }],
      });
      const play = await dev.v2("POST", "/apps", { name: "Scanner Android", type: "play_store", play_store: { package_name: PKG, play_service_account_credentials_json: JSON.stringify(SA) } });
      await dev.v2("POST", "/products", { store_identifier: "recovery_pro:monthly", app_id: play.id, type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M" } });
      const playKey = (await dev.v2("GET", `/apps/${play.id}/public_api_keys`)).items[0].key;
      const android = sdkClient(ctx, playKey, "android");
      const token = `tok_${S}`;
      gSubs.set(token, playSub("SUBSCRIPTION_STATE_ACTIVE", Date.now() + 86400_000, "GPA.1"));
      const gUser = `play_user_${S}`;
      const pr = await android.call("POST", "/v1/receipts", { app_user_id: gUser, fetch_token: token, product_id: "recovery_pro", platform_product_ids: [{ product_id: "recovery_pro", base_plan_id: "monthly" }], is_restore: false });
      c.check("the Play purchase is recorded through the (fake) Play Developer API", pr.status === 200, pr.body);
      await android.attributes(gUser, { $email: `play-${S}@journeys.test` });
      gSubs.set(token, playSub("SUBSCRIPTION_STATE_ON_HOLD", Date.now() - 60_000, "GPA.1"));
      const rtdn = (type: number) => fetch(`${ctx.base}/v1/notifications/google/${play.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        message: { data: Buffer.from(JSON.stringify({ version: "1.0", packageName: PKG, eventTimeMillis: String(Date.now()), subscriptionNotification: { version: "1.0", notificationType: type, purchaseToken: token, subscriptionId: "recovery_pro" } })).toString("base64"), messageId: crypto.randomUUID(), publishTime: new Date().toISOString() },
        subscription: "projects/recovery/subscriptions/rtdn" }) });
      c.eq("SUBSCRIPTION_ON_HOLD push accepted", (await rtdn(5)).status, 200);
      const [gCase] = await until(async () => { const r = await sql`SELECT * FROM recovery_cases WHERE project_id = ${P} AND store = 'play_store'`; return r.length ? r : null; }) ?? [];
      c.has("SQL: an open production Play case", gCase, { status: "open", is_sandbox: false, store_key: token });
      const gMail = await until(async () => mailsTo(`play-${S}@journeys.test`)[0], { timeoutMs: 45_000 });
      c.check("the Play subscriber got the email", !!gMail);
      const gLink = gMail ? linksOf(gMail).find((l) => l.includes("/v1/recovery/l/")) : undefined;
      const gClick = gLink ? await fetch(gLink, { redirect: "manual" }) : null;
      c.eq("the link opens the Play Store subscription page", gClick?.headers.get("location"), `https://play.google.com/store/account/subscriptions?sku=recovery_pro&package=${PKG}`);
      gSubs.set(token, playSub("SUBSCRIPTION_STATE_ACTIVE", Date.now() + 30 * 86400_000, "GPA.1..0"));
      c.eq("SUBSCRIPTION_RECOVERED push accepted", (await rtdn(1)).status, 200);
      const [gDone] = await until(async () => { const r = await sql`SELECT * FROM recovery_cases WHERE id = ${gCase!.id} AND status = 'recovered'`; return r.length ? r : null; }) ?? [];
      c.has("SQL: the Play case is recovered and attributed", gDone, { status: "recovered", attributed: true });
      c.check("SQL: with the renewal's revenue", Math.abs(Number(gDone?.recovered_usd) - 7.99) < 0.01, gDone?.recovered_usd);

      // =============================================================================================================
      c.begin("Test Store: sandbox email and one-click unsubscribe in the browser");
      const testApp = (await dev.v2("GET", "/apps?limit=100")).items.find((a: any) => a.type === "test_store") ?? await dev.v2("POST", "/apps", { name: "Test Store", type: "test_store" });
      const tp = await dev.v2("POST", "/products", { store_identifier: "recovery_test_monthly", app_id: testApp.id, type: "subscription", display_name: "Test monthly", subscription: { duration: "P1M" }, test_store_price: { amount_micros: 4_990_000, currency: "USD" } });
      const tUser = `tester_${S}`;
      await dev.v2("POST", "/test_purchases", { app_user_id: tUser, product_id: tp.id, scenario: "billing_issue", offset_days: 31 });
      await dev.v2("POST", `/customers/${tUser}/attributes`, { attributes: [{ name: "$email", value: `tester-${S}@journeys.test` }] });
      await dev.v2("POST", "/payment_recovery/actions/run");
      const tMail = await until(async () => mailsTo(`tester-${S}@journeys.test`)[0], { timeoutMs: 45_000 });
      c.check("the sandbox subscriber got the email", !!tMail);
      const tUnsub = tMail ? linksOf(tMail).find((l) => l.includes("/v1/recovery/u/")) : undefined;
      await page.goto(tUnsub!);
      await page.getByRole("button", { name: "Unsubscribe" }).click();
      await page.getByRole("heading", { name: "You are unsubscribed" }).waitFor();
      const sup = await sql`SELECT email FROM email_suppressions WHERE project_id = ${P}`;
      c.check("SQL: the address is suppressed for the project", sup.some((x) => x.email === `tester-${S}@journeys.test`), sup);
      const [tCase] = await sql`SELECT unsubscribed_at, next_step_at, skip_reason FROM recovery_cases WHERE project_id = ${P} AND store = 'test_store'`;
      c.check("SQL: the case stops sending", !!tCase?.unsubscribed_at && tCase?.next_step_at === null && tCase?.skip_reason === "unsubscribed", tCase);

      // =============================================================================================================
      c.begin("Disconnect, reconnect, deauthorized in Stripe, then a restricted key");
      await page.goto(appUrl);
      await box().getByRole("button", { name: "Disconnect" }).click();
      await page.getByRole("dialog", { name: "Disconnect your Stripe account?" }).getByRole("button", { name: "Disconnect" }).click();
      await until(async () => (await box().getAttribute("data-state")) === "disconnected");
      const [d1] = await sql`SELECT status, account_hash, disconnect_reason FROM stripe_connections WHERE app_id = ${app.id}`;
      c.has("SQL: disconnected in RevenueDot, the routing hash gone", d1, { status: "disconnected", account_hash: null, disconnect_reason: "Disconnected in RevenueDot" });
      c.check("Stripe was asked to deauthorize", ctx.capture.platform.calls.some((x) => x.path === "/oauth/deauthorize" && x.params.client_id === FAKE_CONNECT_CLIENT_ID && x.params.stripe_user_id === account));
      await box().getByRole("button", { name: "Connect with Stripe" }).click();
      await page.getByRole("button", { name: "Connect my Stripe account" }).click();
      await page.waitForURL(/#credentials$/);
      await until(async () => (await box().getAttribute("data-state")) === "connected");
      const again = [...ctx.capture.platform.accounts.keys()].at(-1)!;
      ctx.capture.platform.deauthorized.add(again);
      const de = await ctx.capture.deliverConnect(ctx.capture.platform.connectEvent(again, "account.application.deauthorized", { id: FAKE_CONNECT_CLIENT_ID, object: "application" }));
      c.has("account.application.deauthorized processed", de, { status: 200, body: { status: "disconnected" } });
      await page.reload();
      c.eq("the app page shows the disconnected state", await panelState(), "disconnected");
      c.check("and says it was disconnected in Stripe", /Disconnected in Stripe/.test((await box().textContent()) ?? ""), await box().textContent());
      const [secretsAfter] = await sql`SELECT secret_hints FROM apps WHERE id = ${app.id}`;
      c.eq("SQL: no connected account is left on the app", secretsAfter!.secret_hints, {});
      await page.getByLabel("Restricted key").fill(FAKE_STRIPE_KEY);
      await page.getByRole("button", { name: "Check credentials" }).click();
      await page.getByText("Stripe accepted the test mode key.").waitFor();
      await page.getByRole("button", { name: "Save changes" }).click();
      await until(async () => (await sql`SELECT secret_hints FROM apps WHERE id = ${app.id}`)[0]!.secret_hints.stripe_secret_key);
      const web = await dev.v2("GET", "/web");
      c.check("the Web page lists the app with its restricted key", web.providers.find((x: any) => x.id === app.id)?.connection === "restricted_key", web.providers);

      // =============================================================================================================
      c.begin("Phone width, dark mode, console");
      for (const [path, name] of [[`/projects/${P}/lifecycle/payment-recovery`, "recovery"], [`/projects/${P}/apps/${app.id}`, "stripe-app"]] as const) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${ctx.base}${path}`);
        await sleep(600);
        const o = await page.evaluate(() => { const s = document.querySelector(".scroll"); return Math.max(document.documentElement.scrollWidth - window.innerWidth, s ? s.scrollWidth - s.clientWidth : 0); });
        c.check(`${name} has no horizontal scroll at 390 px`, o <= 1, o);
        await shot(`${name}-390`);
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.reload();
        await sleep(600);
        await shot(`${name}-dark`);
        await page.emulateMedia({ colorScheme: "light" });
      }
      c.eq("no console errors in the dashboard", consoleErrors, []);
    } finally {
      await browser.close().catch(() => {});
    }
  },
};

export default journey;
