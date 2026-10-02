// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (f), web billing with the developer's own Stripe account. No Stripe test-mode key exists for this
// project (the RevenueDot 1Password vault has none), so Stripe is the FAKE Stripe account (packages/contract/src/
// fake-stripe.ts) answering at the network layer: the server's real Stripe client calls https://api.stripe.com and the
// journey preload routes it to the fake. Recorded as "fake Stripe" in prd/validation/COVERAGE.md.
// The buyer uses a real browser: a purchase link with a discount code, the (fake) Stripe Checkout page, the success page
// with the redemption link, the redemption email over SMTP; the mobile app redeems with the SDK's
// POST /v1/subscribers/redeem_purchase; Stripe's signed checkout.session.completed webhook arrives too and completes the
// checkout only once. Then a funnel: answer its steps, pay, analytics; and PURCHASE_REDEEMED and FUNNEL_* events.
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, eventsOf, sdkClient, signUp } from "./lib/context.ts";
import { linksOf } from "./lib/stack.ts";
import { chromium } from "./onboarding.ts";
import { FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.ts";
import { signStripePayload } from "../../../apps/server/src/stores/stripe/signature.ts";

const WHSEC = "whsec_journeyWebBillingSigningSecret0000";

const journey: Journey = {
  name: "web-billing",
  title: "Web billing (fake Stripe): purchase link, discount, checkout, redemption email and SDK redeem, webhook once, funnel",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "webbilling", "Scanner");
    const stripe = ctx.capture.stripe;
    const hookPath = `/hooks/web-${ctx.stamp}`;
    await dev.v2("POST", "/integrations/webhooks", { name: "Web events", url: ctx.capture.base + hookPath, event_types: ["initial_purchase", "purchase_redeemed", "funnel_viewed", "funnel_step_completed", "funnel_purchase"] });

    c.begin("Stripe app, web config, web products, offering");
    const pro = await dev.v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro access" });
    const ios = await dev.v2("POST", "/apps", { name: "Scanner iOS", type: "app_store", app_store: { bundle_id: "com.example.scanner" } });
    const iosKey = (await dev.v2("GET", `/apps/${ios.id}/public_api_keys`)).items[0].key as string;
    const app = await dev.v2("POST", "/apps", { name: "Scanner Web", type: "stripe", stripe: { stripe_secret_key: FAKE_STRIPE_KEY, stripe_webhook_secret: WHSEC } });
    c.check("Stripe app created with a strp_ key", app.type === "stripe");
    const [row] = await ctx.sql`SELECT credentials, secrets FROM apps WHERE id = ${app.id}`;
    c.check("the Stripe key and webhook secret are sealed (never in plain credentials)", !JSON.stringify(row?.credentials ?? {}).includes(FAKE_STRIPE_KEY) && !JSON.stringify(row?.secrets ?? {}).includes(FAKE_STRIPE_KEY) && !JSON.stringify(row?.secrets ?? {}).includes(WHSEC), Object.keys(row?.credentials ?? {}));
    const check = await dev.v2r("POST", `/apps/${app.id}/actions/verify_credentials`);
    c.check("Check credentials calls Stripe with the key and passes", check.status === 200 && JSON.stringify(check.body).match(/ok|valid|true/i), check.body);
    await dev.v2("PUT", `/apps/${app.id}/web_config`, { app_name: "Scanner", support_email: "help@scanner.example", terms_url: "https://scanner.example/terms", privacy_url: "https://scanner.example/privacy", app_scheme: "scanner", app_store_url: "https://apps.apple.com/app/id123" });
    const mk = async (json: Record<string, unknown>) => (await dev.v2("POST", `/apps/${app.id}/web_products`, json)).product;
    const monthly = await mk({ display_name: "Pro monthly", type: "subscription", price: { amount: 9.99, currency: "USD" }, duration: "P1M", trial_days: 7, entitlement_ids: [pro.id] });
    const annual = await mk({ display_name: "Pro annual", type: "subscription", price: { amount: 59.99, currency: "USD" }, duration: "P1Y", entitlement_ids: [pro.id] });
    c.check("web products exist in Stripe as a Product and a Price (store_identifier = price id)", stripe.prices.has(monthly.store_identifier) && stripe.prices.has(annual.store_identifier) && stripe.prices.get(annual.store_identifier)?.unit_amount === 5999, [monthly.store_identifier, annual.store_identifier]);
    const off = await dev.v2("POST", "/offerings", { lookup_key: "web", display_name: "Go Pro on the web" });
    for (const [lk, name, prod, pos] of [["$rc_monthly", "Monthly", monthly, 1], ["$rc_annual", "Annual", annual, 2]] as const) {
      const pk = await dev.v2("POST", `/offerings/${off.id}/packages`, { lookup_key: lk, display_name: name, position: pos });
      await dev.v2("POST", `/packages/${pk.id}/actions/attach_products`, { products: [{ product_id: prod.id, eligibility_criteria: "all" }] });
    }
    const web = await dev.v2("GET", "/web");
    c.check("the Web checklist is complete", JSON.stringify(web).includes(app.id), web);

    c.begin("discount with a code");
    const disc = await dev.v2("POST", "/discounts", { identifier: "spring_sale", customer_facing_name: "Spring sale", type: "percentage", percentage: 20, duration_mode: "time_window", time_window: "P3M", eligibility: "everyone" });
    await dev.v2("POST", `/discounts/${disc.id}/discount_codes`, { codes: ["SPRING20"] }).catch(async () => dev.v2("POST", `/discounts/${disc.id}/discount_codes`, { code: "SPRING20" }));
    c.check("the discount has a Stripe coupon (20% for 3 months)", [...stripe.coupons.values()].some((cp) => Number(cp.percent_off) === 20 && cp.duration === "repeating" && Number(cp.duration_in_months) === 3), [...stripe.coupons.values()]);

    c.begin("a buyer pays through a purchase link with the code");
    const link = await dev.v2("POST", "/purchase_links", { name: "Spring sale", offering_id: off.id });
    c.check("the purchase link lives on this server's /pay", String(link.url).startsWith(`${ctx.base}/pay/`), link.url);
    const browser = await chromium().launch();
    const errors: string[] = [];
    const buyerEmail = `buyer-${ctx.stamp}@example.com`;
    let token = "";
    try {
      const page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(link.url);
      await page.getByRole("heading", { name: "Go Pro on the web" }).waitFor({ timeout: 15_000 });
      c.check("the page shows the trial and the price from the web product", await page.getByText("7-day free trial, then $9.99 per month").isVisible());
      await page.getByRole("radio", { name: /Monthly/ }).click();
      await page.getByText("Have a discount code?").click();
      await page.getByLabel("Discount code").fill("nope");
      await page.getByRole("button", { name: "Apply" }).click();
      c.check("an unknown code is refused", await page.getByText("This code is not valid.").waitFor({ timeout: 10_000 }).then(() => true, () => false));
      await page.getByLabel("Discount code").fill("spring20");
      await page.getByRole("button", { name: "Apply" }).click();
      c.check("the code applies (case-insensitive)", await page.getByText("20% off for 3 months applied at checkout.").waitFor({ timeout: 10_000 }).then(() => true, () => false));
      await page.getByRole("button", { name: "Continue to payment" }).click();
      await page.waitForURL(/\/__stripe\/checkout\/cs_/, { timeout: 15_000 });
      const sessionId = page.url().split("/").pop()!;
      const session = stripe.sessions.get(sessionId);
      c.check("Stripe Checkout Session: subscription, the monthly price, 7-day trial, the discount", session?.mode === "subscription" && session.line_items.data[0].price.id === monthly.store_identifier && Number(session.subscription_data?.trial_period_days) === 7 && session.discounts?.length === 1, { mode: session?.mode, discounts: session?.discounts, trial: session?.subscription_data });
      await page.locator("input[name=email]").fill(buyerEmail);
      await page.getByRole("button", { name: "Pay" }).click();
      await page.waitForURL(/\/success\?/, { timeout: 20_000 });
      c.check("the success page thanks the buyer and shows the redemption link", await page.getByRole("heading", { name: "Thank you for your purchase" }).waitFor({ timeout: 10_000 }).then(() => true, () => false));
      token = /\/pay\/r\/(rdrt_[A-Za-z0-9_-]+)/.exec((await page.locator(".link").textContent()) ?? "")?.[1] ?? "";
      c.must("a redemption token rdrt_… is shown", token);
      const appLink = await page.getByRole("link", { name: "Open the app" }).getAttribute("href");
      c.check("'Open the app' goes to the redemption page", appLink?.includes(`/pay/r/${token}`), appLink);
      await page.goto(`${ctx.base}/pay/r/${token}`);
      c.check("the redemption page opens the app's scheme with the token", (await page.getByRole("link", { name: "Open the app" }).getAttribute("href")) === `scanner://redeem_web_purchase?redemption_token=${token}`);

      c.begin("Stripe's webhook arrives too: completes once");
      const evt = stripe.completedEvent(sessionId);
      const raw = JSON.stringify(evt);
      const sig = await signStripePayload(WHSEC, raw, Math.floor(Date.now() / 1000));
      const wh = await fetch(`${ctx.base}/v1/notifications/stripe/${app.id}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: raw });
      c.check("the signed checkout.session.completed is accepted", wh.status === 200, await wh.text());
      const bad = await fetch(`${ctx.base}/v1/notifications/stripe/${app.id}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": await signStripePayload("whsec_wrong", raw) }, body: raw });
      c.check("a webhook signed with another secret is refused", bad.status >= 400 && bad.status < 500, bad.status);
      const initial = await eventsOf(ctx, dev.projectId, { type: "INITIAL_PURCHASE" });
      c.eq("one INITIAL_PURCHASE for the checkout (success page and webhook did not double it)", initial.length, 1);
      c.has("the purchase event: Stripe store, trial, the web offering", initial[0], { store: "STRIPE", period_type: "TRIAL", presented_offering_id: "web" });
      const checkouts = await ctx.sql`SELECT status FROM web_checkouts WHERE project_id = ${dev.projectId}`;
      c.check("web_checkouts row completed", checkouts.length === 1 && /complete/.test(String(checkouts[0]!.status)), checkouts);
      const dlist = await dev.v2("GET", "/web_discounts");
      c.eq("the discount counts one redemption", dlist.items[0]?.times_redeemed, 1);

      c.begin("redemption email (SMTP)");
      const mail = await until(async () => ctx.mails.find((m) => m.to.includes(buyerEmail)));
      c.must("the buyer got an email", mail, ctx.mails.map((m) => m.to));
      c.check("the email carries the same redemption link", linksOf(mail!).some((l) => l.includes(token)), linksOf(mail!));

      c.begin("the iOS app redeems with the SDK's call");
      const iosSdk = sdkClient(ctx, iosKey);
      const user = `ios_user_${ctx.stamp}`;
      const r = await iosSdk.call("POST", "/v1/subscribers/redeem_purchase", { app_user_id: user, redemption_token: token });
      c.check("redeem answers 200 with pro active", r.status === 200 && Date.parse(r.body.subscriber?.entitlements?.pro?.expires_date) > Date.now(), r.body);
      c.eq("a retry by the same user answers 200 again", (await iosSdk.call("POST", "/v1/subscribers/redeem_purchase", { app_user_id: user, redemption_token: token })).status, 200);
      const other = await iosSdk.call("POST", "/v1/subscribers/redeem_purchase", { app_user_id: `someone_${ctx.stamp}`, redemption_token: token });
      c.check("another user gets 7852 (already redeemed)", other.status === 400 && other.body.code === 7852, other.body);
      const invalid = await iosSdk.call("POST", "/v1/subscribers/redeem_purchase", { app_user_id: user, redemption_token: "rdrt_doesnotexist" });
      c.check("an unknown token gets 7849", invalid.body.code === 7849, invalid.body);
      const redeemed = (await eventsOf(ctx, dev.projectId, { type: "PURCHASE_REDEEMED" }))[0];
      c.has("PURCHASE_REDEEMED: Stripe, redeemed by the iOS user", redeemed, { type: "PURCHASE_REDEEMED", store: "STRIPE", redeemed_by: [user], redemption_platform: "ios" });

      c.begin("a funnel: steps, paywall, payment, analytics");
      const funnel = await dev.v2("POST", "/funnels", { name: "Onboarding funnel" });
      const draft = funnel.draft;
      for (const s of draft.steps) if (s.type === "paywall") s.offering = "web";
      await dev.v2("PATCH", `/funnels/${funnel.id}`, { draft });
      const pub = await dev.v2("POST", `/funnels/${funnel.id}/actions/publish`);
      c.check("funnel published with no problems", pub.status === "published" || pub.object === "funnel", pub);
      const fp = await browser.newPage();
      fp.on("pageerror", (e) => errors.push(String(e)));
      await fp.goto(funnel.url);
      const funnelEmail = `funnel-${ctx.stamp}@example.com`;
      // The starter funnel: a question, an info step, the email step, the paywall.
      await fp.getByRole("heading", { name: "What do you want to get done?" }).waitFor({ timeout: 15_000 });
      await fp.getByRole("radio", { name: "Sleep better" }).click();
      await fp.getByRole("heading", { name: "Your plan is ready" }).waitFor({ timeout: 10_000 });
      await fp.getByRole("button", { name: "Continue" }).click();
      await fp.getByLabel("Email").fill(funnelEmail);
      await fp.getByRole("button", { name: "Continue" }).click();
      await fp.getByRole("heading", { name: "Unlock your full plan" }).waitFor({ timeout: 10_000 });
      await fp.getByRole("radio", { name: /Annual/ }).click();
      await fp.getByRole("button", { name: "Continue" }).click();
      await fp.waitForURL(/\/__stripe\/checkout\/cs_/, { timeout: 15_000 }).catch(() => {});
      c.must("the funnel reaches Stripe Checkout", /__stripe\/checkout\/cs_/.test(fp.url()), fp.url());
      await fp.getByRole("button", { name: "Pay" }).click();
      await fp.waitForURL(/\/success\?/, { timeout: 20_000 });
      c.check("the funnel's success step shows the redemption link", await fp.getByRole("heading", { name: "You are in" }).waitFor({ timeout: 10_000 }).then(() => true, () => false) && /\/pay\/r\/rdrt_/.test((await fp.locator(".link").textContent()) ?? ""));
      const attrs = await ctx.sql`SELECT a.key, a.value FROM customer_attributes a JOIN customers c ON c.id = a.customer_id WHERE c.project_id = ${dev.projectId} AND a.key = 'goal'`;
      c.check("the answer to the goal question was saved as an attribute", attrs.length === 1 && attrs[0]!.value === "Sleep better", attrs);
      const analytics = await until(async () => { const a = await dev.v2("GET", `/funnels/${funnel.id}/analytics?days=7`); return a.views >= 1 && a.purchases >= 1 ? a : null; }, { timeoutMs: 15_000 });
      c.check("funnel analytics: 1 view and 1 purchase", analytics?.views === 1 && analytics.purchases === 1, analytics);
      const funnelEvents = await until(async () => {
        const got = ctx.capture.requests.filter((r) => r.path === hookPath).map((r) => JSON.parse(r.body).event.type as string);
        return got.includes("FUNNEL_PURCHASE") ? got : null;
      }, { timeoutMs: 45_000, everyMs: 1000 });
      c.check("opt-in webhook got FUNNEL_VIEWED, FUNNEL_STEP_COMPLETED, FUNNEL_PURCHASE, PURCHASE_REDEEMED and INITIAL_PURCHASE", ["FUNNEL_VIEWED", "FUNNEL_STEP_COMPLETED", "FUNNEL_PURCHASE", "PURCHASE_REDEEMED", "INITIAL_PURCHASE"].every((t) => funnelEvents?.includes(t)), funnelEvents);
      c.begin("the iOS paywall's web checkout (the SDK's hosted checkout)");
      const hcUser = `ios_web_${ctx.stamp}`;
      const hc = await iosSdk.call("POST", "/rcbilling/v1/hosted-checkout", { app_user_id: hcUser, presented_offering_identifier: "web", package_id: "$rc_monthly" });
      const payRoot = `${ctx.base}/pay/`;
      c.check("POST /rcbilling/v1/hosted-checkout answers a Stripe Checkout URL and this server's _/success and _/cancel pages", hc.status === 200 && /\/__stripe\/checkout\/cs_/.test(hc.body.checkout_url ?? "") && String(hc.body.success_url).startsWith(payRoot) && /\/_\/success$/.test(hc.body.success_url) && /\/_\/cancel$/.test(hc.body.cancel_url ?? ""), hc.body);
      const hp = await browser.newPage();
      hp.on("pageerror", (e) => errors.push(String(e)));
      await hp.goto(hc.body.cancel_url);
      c.check("the buyer backs out: the cancel page says nothing was charged", await hp.getByRole("heading", { name: "Checkout cancelled" }).waitFor({ timeout: 10_000 }).then(() => true, () => false) && (await hp.locator("body").innerText()).includes("Nothing was charged"));
      c.eq("SQL: the cancelled checkout stays open (no purchase)", (await ctx.sql`SELECT count(*)::int AS n FROM web_checkouts WHERE project_id = ${dev.projectId} AND app_user_id = ${hcUser} AND status LIKE 'complete%'`)[0]!.n, 0);
      await hp.goto(hc.body.checkout_url);
      const hcEmail = hp.locator("input[name=email]");
      if (await hcEmail.isVisible().catch(() => false)) await hcEmail.fill(`ios-web-${ctx.stamp}@example.com`);
      await hp.getByRole("button", { name: "Pay" }).click();
      await hp.waitForURL(/\/_\/success\?/, { timeout: 20_000 }).catch(() => {});
      c.check("paying lands on _/success: Purchase complete", /\/_\/success\?/.test(hp.url()) && await hp.getByRole("heading", { name: "Purchase complete" }).waitFor({ timeout: 10_000 }).then(() => true, () => false), hp.url());
      const hcRows = await ctx.sql`SELECT source_type, status, anonymous FROM web_checkouts WHERE project_id = ${dev.projectId} AND app_user_id = ${hcUser}`;
      c.check("SQL: one sdk checkout, completed, not anonymous", hcRows.length === 1 && hcRows[0]!.source_type === "sdk" && hcRows[0]!.status === "completed" && hcRows[0]!.anonymous === false, hcRows);
      const hcInfo = await iosSdk.call("GET", `/v1/subscribers/${hcUser}`);
      c.check("the iOS app user has pro at once (bought for that app user id, no redemption step)", Date.parse(hcInfo.body.subscriber?.entitlements?.pro?.expires_date) > Date.now(), hcInfo.body.subscriber?.entitlements);
      c.has("the purchase event: Stripe, for the iOS app user", (await eventsOf(ctx, dev.projectId, { type: "INITIAL_PURCHASE", appUserId: hcUser }))[0], { store: "STRIPE", app_user_id: hcUser, presented_offering_id: "web" });

      c.begin("cancel page, funnel and link clean-up");
      const cancelUrl = session?.cancel_url as string | undefined;
      const cancelPage = cancelUrl ? await fetch(cancelUrl) : null;
      c.check("the purchase link checkout's cancel URL returns to the purchase link page (?canceled=1) and answers", cancelUrl?.startsWith(link.url) && /canceled=1/.test(cancelUrl) && cancelPage?.ok, { cancelUrl, status: cancelPage?.status });
      c.eq("GET the funnel reads it back published", (await dev.v2("GET", `/funnels/${funnel.id}`)).status, "published");
      await dev.v2("DELETE", `/funnels/${funnel.id}`);
      c.eq("a deleted funnel is gone from the API", (await dev.v2r("GET", `/funnels/${funnel.id}`)).status, 404);
      c.eq("and its public page answers 404", (await fetch(funnel.url)).status, 404);
      await dev.v2("DELETE", `/purchase_links/${link.id}`);
      c.eq("a deleted purchase link's page answers 404", (await fetch(link.url)).status, 404);
      c.check("no page errors on the hosted pages", errors.length === 0, errors);
    } finally {
      await browser.close();
    }
  },
};
export default journey;
