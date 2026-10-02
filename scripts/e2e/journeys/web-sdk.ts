// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (b), an end user buys on the web with the UNMODIFIED purchases-js from npm (@revenuecat/purchases-js,
// as installed by revenuedot/examples web/vanilla-js), in Chromium. The example web app is built pointed at this server
// with the project's Test Store key; the user picks Monthly, confirms in purchases-js's own Test Store dialog, sees the
// success screen, then logs in. Checks: customer info and signed responses on the SDK endpoints, v2 customer,
// entitlements, subscriptions and transactions, SQL rows, INITIAL_PURCHASE delivered to the example backend and
// signature-checked there, Overview and Charts numbers moved, and the customer page timeline in the dashboard.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, eventsOf, signUp, standardCatalog } from "./lib/context.ts";
import { BUILD, ROOT } from "./lib/stack.ts";
import { backendUrl, publicKeyOfSeed, startExampleBackend, verifySignature } from "./lib/backend.ts";
import { chromium } from "./onboarding.ts";

const EXAMPLE = join(ROOT, "..", "examples/web/vanilla-js");

const journey: Journey = {
  name: "web-sdk",
  title: "End user buys with the unmodified purchases-js in Chromium (Test Store), then logs in",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const dev = await signUp(ctx, "webdev", "Focus Web");
    const cat = await standardCatalog(dev);
    const hook = await dev.v2("POST", "/integrations/webhooks", { name: "Backend", url: backendUrl() });
    const backend = await startExampleBackend(hook.signing_secret);
    const consoleErrors: string[] = [];
    const browser = await chromium().launch();
    try {
      c.begin("before the purchase");
      const before = await dev.v2("GET", "/metrics/overview?environment=sandbox");
      const metric = (o: any, id: string) => o.metrics.find((m: any) => m.id === id)?.value;
      c.check("overview (sandbox) starts empty", metric(before, "active_subscriptions") === 0 && metric(before, "revenue") === 0, before.metrics);

      c.begin("build the example web app against this server");
      const sdkPkg = JSON.parse(readFileSync(join(EXAMPLE, "node_modules/@revenuecat/purchases-js/package.json"), "utf8"));
      c.check("the example uses the unmodified npm package @revenuecat/purchases-js", sdkPkg.name === "@revenuecat/purchases-js" && !String(sdkPkg.repository?.url ?? "").includes("revenuedot"), { name: sdkPkg.name, version: sdkPkg.version });
      const outDir = join(BUILD, `web-sdk-${ctx.stamp}`);
      const b = spawnSync(join(EXAMPLE, "node_modules/.bin/vite"), ["build", "--base", "/site/", "--outDir", outDir, "--emptyOutDir"], {
        cwd: EXAMPLE, env: { ...process.env, VITE_REVENUEDOT_URL: ctx.base, VITE_REVENUEDOT_API_KEY: cat.testKey }, encoding: "utf8",
      });
      c.must("vite build of examples/web/vanilla-js", b.status === 0 && existsSync(join(outDir, "index.html")), (b.stderr || b.stdout).slice(-800));
      ctx.capture.dirs.set("/site/", outDir);
      const siteUrl = `${ctx.capture.base}/site/`;

      c.begin("purchase in Chromium");
      const page = await browser.newPage();
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(String(e)));
      await page.goto(siteUrl);
      await page.getByTestId("plan-$rc_monthly").waitFor({ timeout: 20_000 });
      const planText = await page.getByTestId("plan-$rc_monthly").innerText();
      c.check("plans come from the current offering with the Test Store price", planText.includes("9.99"), planText);
      // Cancelling the SDK's dialog buys nothing.
      await page.getByTestId("buy").click();
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByTestId("status").filter({ hasText: "Purchase cancelled." }).waitFor({ timeout: 10_000 });
      const anon = await page.evaluate(() => localStorage.getItem("revenuedot_app_user_id"));
      c.check("the SDK made an anonymous app user id", /^\$RCAnonymousID:[0-9a-f]{32}$/.test(anon ?? ""), anon);
      const afterCancel = await ctx.sql`SELECT count(*)::int AS n FROM transactions WHERE project_id = ${dev.projectId}`;
      c.eq("cancelling the dialog records no transaction", afterCancel[0]!.n, 0);

      await page.getByTestId("plan-$rc_monthly").click();
      await page.getByTestId("buy").click();
      await page.getByRole("button", { name: "Test valid purchase" }).click();
      await page.getByRole("heading", { name: "You're in." }).waitFor({ timeout: 20_000 });
      // The field sits in the collapsed Developer panel, so read its text content.
      const entText = await page.getByTestId("entitlement").textContent();
      c.check("the app shows pro active until a date after the purchase", /Active until/.test(entText ?? ""), entText);

      c.begin("server state after the purchase");
      const signingPub = publicKeyOfSeed(ctx.server.signingKey);
      const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
      const path = `/v1/subscribers/${encodeURIComponent(anon!)}`;
      const ci = await fetch(ctx.base + path, { headers: { authorization: `Bearer ${cat.testKey}`, "x-nonce": nonce.toString("base64") } });
      const ciBody = Buffer.from(await ci.arrayBuffer());
      const info = JSON.parse(ciBody.toString("utf8"));
      const pro = info.subscriber.entitlements.pro;
      c.check("customer info: pro active through pro_monthly, about a month", pro?.product_identifier === "pro_monthly" && Date.parse(pro.expires_date) - Date.now() > 27 * 86400_000, pro);
      c.check("customer info: subscription pro_monthly from the Test Store, sandbox", info.subscriber.subscriptions.pro_monthly?.store === "test_store" && info.subscriber.subscriptions.pro_monthly?.is_sandbox === true, info.subscriber.subscriptions);
      const sig = ci.headers.get("x-signature");
      c.check("the response is signed (Trusted Entitlements) and verifies with the server's public key", sig && verifySignature(sig, signingPub, { apiKey: cat.testKey, nonce, path, requestTime: ci.headers.get("x-revenuecat-request-time") ?? "", body: ciBody }) === "verified", sig ? verifySignature(sig, signingPub, { apiKey: cat.testKey, nonce, path, requestTime: ci.headers.get("x-revenuecat-request-time") ?? "", body: ciBody }) : "no X-Signature");
      const custId = encodeURIComponent(anon!);
      const ents = await dev.v2("GET", `/customers/${custId}/active_entitlements`);
      c.eq("v2 active entitlements: pro", ents.items.map((e: any) => e.entitlement_id), [cat.pro.id]);
      const subs = await dev.v2("GET", `/customers/${custId}/subscriptions`);
      c.has("v2 subscription: active, will renew, Test Store, sandbox", subs.items[0], { status: "active", auto_renewal_status: "will_renew", store: "test_store", environment: "sandbox", product_id: cat.products.monthly.id });
      const txns = await dev.v2("GET", `/transactions?customer=${custId}`);
      c.check("transactions feed: one purchase of pro_monthly", txns.items.length === 1 && txns.items[0].product_identifier === "pro_monthly", txns.items);
      const rows = await ctx.sql`SELECT kind, store, product_identifier, is_sandbox, price_amount, price_currency, revenue_usd FROM transactions WHERE project_id = ${dev.projectId}`;
      c.eq("SQL transactions: one sandbox Test Store purchase at 9.99 USD", rows.map((r) => ({ ...r })), [{ kind: "purchase", store: "test_store", product_identifier: "pro_monthly", is_sandbox: true, price_amount: 9.99, price_currency: "USD", revenue_usd: 9.99 }]);
      const [ev] = await eventsOf(ctx, dev.projectId, { type: "INITIAL_PURCHASE" });
      c.has("INITIAL_PURCHASE event", ev, { app_user_id: anon, product_id: "pro_monthly", entitlement_ids: ["pro"], period_type: "NORMAL", store: "TEST_STORE", environment: "SANDBOX", price: 9.99, currency: "USD", is_family_share: false });
      const delivered = await until(async () => (await dev.v2("GET", `/webhooks/${hook.id}/deliveries?limit=10`)).items.find((d: any) => d.event_type === "INITIAL_PURCHASE" && d.status === "delivered"), { timeoutMs: 45_000 });
      c.check("INITIAL_PURCHASE delivered to the example backend (HTTP 200)", delivered?.response_status === 200, delivered);
      c.check("the backend checked the signature and granted pro", await until(async () => backend.log.includes(`grant pro to ${anon}`), { timeoutMs: 5000 }), backend.log.slice(-500));

      c.begin("overview and charts moved");
      const after = await dev.v2("GET", "/metrics/overview?environment=sandbox");
      c.check("overview (sandbox): 1 active subscription, revenue 9.99, MRR 9.99, 1 new customer", metric(after, "active_subscriptions") === 1 && metric(after, "revenue") === 9.99 && metric(after, "mrr") === 9.99 && metric(after, "new_customers") === 1, after.metrics);
      const prod = await dev.v2("GET", "/metrics/overview");
      c.check("overview (production) is unchanged: sandbox purchases never count there", metric(prod, "active_subscriptions") === 0 && metric(prod, "revenue") === 0, prod.metrics);
      const today = new Date().toISOString().slice(0, 10);
      const rev = await dev.v2("GET", `/charts/revenue?environment=sandbox&resolution=day&start_date=${today}&end_date=${today}`);
      const revVal = rev.values?.filter((v: any) => v.measure === 0).reduce((s: number, v: any) => s + Number(v.value), 0);
      c.eq("revenue chart (sandbox, today) = 9.99", revVal, 9.99);
      const actives = await dev.v2("GET", `/charts/actives?environment=sandbox&resolution=day&start_date=${today}&end_date=${today}`);
      c.check("active subscriptions chart (sandbox, today) = 1", actives.values?.some((v: any) => v.measure === 0 && Number(v.value) === 1), actives.values);

      c.begin("log in: the anonymous purchase follows the user");
      const userId = `web_user_${ctx.stamp}`;
      await page.getByText("Developer").click();
      await page.getByRole("textbox", { name: "User id" }).fill(userId);
      await page.getByRole("button", { name: "Log in" }).click();
      await page.getByTestId("last-action").filter({ hasText: `Signed in as ${userId}.` }).waitFor({ timeout: 15_000 });
      c.check("the app shows the entitlement after logIn", /Active until/.test(await page.getByTestId("entitlement").innerText()));
      const viaUser = await fetch(`${ctx.base}/v1/subscribers/${userId}`, { headers: { authorization: `Bearer ${cat.testKey}` } }).then((r) => r.json()) as any;
      c.check("customer info for the new user id has pro", viaUser.subscriber.entitlements.pro?.product_identifier === "pro_monthly", viaUser.subscriber.entitlements);
      const aliases = await ctx.sql`SELECT a.app_user_id FROM customer_aliases a JOIN customers c ON c.id = a.customer_id WHERE c.project_id = ${dev.projectId} ORDER BY a.app_user_id`;
      c.check("one customer with both ids (anonymous and logged in)", aliases.map((a) => a.app_user_id).includes(userId) && aliases.map((a) => a.app_user_id).includes(anon), aliases);
      const custs = await ctx.sql`SELECT count(*)::int AS n FROM customers WHERE project_id = ${dev.projectId}`;
      c.eq("no second customer was created", custs[0]!.n, 1);

      c.begin("customer page in the dashboard");
      const dash = await browser.newContext();
      await dash.addCookies([{ name: "rd_session", value: dev.cookie.split("=")[1]!, url: ctx.base }]);
      const dp = await dash.newPage();
      dp.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`dashboard: ${m.text()}`); });
      await dp.goto(`${ctx.base}/projects/${dev.projectId}/customers/${encodeURIComponent(userId)}`);
      await dp.waitForLoadState("networkidle");
      const text = await dp.locator("body").innerText();
      c.check("customer page shows pro, pro_monthly, both ids and the purchase in the timeline", ["pro", "pro_monthly", userId].every((t) => text.includes(t)) && /Initial purchase|INITIAL_PURCHASE|Purchased/i.test(text), text.slice(0, 1500));
      await dp.screenshot({ path: join(ctx.out, "customer-page.png"), fullPage: true });
      await dp.goto(`${ctx.base}/projects/${dev.projectId}/overview`);
      await dp.waitForLoadState("networkidle");
      await dp.screenshot({ path: join(ctx.out, "overview.png"), fullPage: true });
      c.check("no console errors in the web app or the dashboard", consoleErrors.length === 0, consoleErrors.slice(0, 5));
    } finally {
      await browser.close();
      backend.stop();
    }
  },
};
export default journey;
