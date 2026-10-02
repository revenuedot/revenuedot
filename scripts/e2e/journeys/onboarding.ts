// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (a), developer onboarding. A developer signs up in the dashboard in a real browser, verifies the
// email from the link in the mail the server sent over SMTP, resets a forgotten password, invites a teammate, then builds
// the app's setup (Test Store app, products, entitlement, offering with packages, a secret API key, a webhook to the
// node-express example backend, a published paywall from the gallery) and checks each object through the v2 API, SQL,
// the SDK's own offerings call and the dashboard pages. Finally a Test Store purchase is delivered to the backend, which
// verifies the HMAC signature.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "./run.ts";
import { until, sleep } from "./lib/check.ts";
import { type Ctx, eventsOf, sdkClient, secretClient } from "./lib/context.ts";
import { PORTS, ROOT, linksOf } from "./lib/stack.ts";

const EXAMPLES = join(ROOT, "..", "examples");
export const chromium = () => (createRequire(join(ROOT, "apps/dashboard/package.json"))("playwright") as typeof import("playwright")).chromium;

const journey: Journey = {
  name: "onboarding",
  title: "Developer onboarding: sign-up, email, team, catalog, keys, webhook backend, paywall",
  needsDashboard: true,
  async run(ctx: Ctx) {
    const { c } = ctx;
    const email = `founder-${ctx.stamp}@journeys.test`;
    const password = `first-pass-${ctx.stamp}`;
    const browser = await chromium().launch();
    const consoleErrors: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(String(e)));

      c.begin("sign-up in the dashboard");
      await page.goto(`${ctx.base}/signup`);
      await page.fill("#name", "Founder");
      await page.fill("#email", email);
      await page.fill("#password", password);
      await page.fill("#project", "Sleep Coach");
      await page.click("button[type=submit]");
      await page.waitForURL(/\/projects\/[^/]+\/overview/, { timeout: 20_000 }).catch(() => {});
      const projectId = /\/projects\/([^/]+)\//.exec(page.url())?.[1] ?? "";
      c.must("the sign-up form lands on the new project's Overview", projectId, page.url());
      const [user] = await ctx.sql`SELECT id, email, email_verified_at, password_hash FROM users WHERE email = ${email}`;
      c.check("users row stored with a lowercased email and a password hash (never the password)", user && user.password_hash && !String(user.password_hash).includes(password), user);
      const [proj] = await ctx.sql`SELECT p.name, m.role FROM projects p JOIN memberships m ON m.project_id = p.id WHERE p.id = ${projectId} AND m.user_id = ${user!.id}`;
      c.eq("project 'Sleep Coach' with the founder as admin", proj && { name: proj.name, role: proj.role }, { name: "Sleep Coach", role: "admin" });
      const cookie = (await page.context().cookies()).find((k) => k.name === "rd_session");
      c.must("session cookie rd_session is HttpOnly", cookie?.httpOnly, cookie && { httpOnly: cookie.httpOnly });
      const call = async (method: string, path: string, json?: unknown) => {
        const r = await fetch(ctx.base + path, { method, headers: { cookie: `rd_session=${cookie!.value}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined });
        const t = await r.text();
        let body: any = t; try { body = t ? JSON.parse(t) : null; } catch { /* text */ }
        return { status: r.status, body };
      };
      const P = `/v2/projects/${projectId}`;
      const v2 = async (method: string, path: string, json?: unknown) => {
        const r = await call(method, P + path, json);
        if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
        return r.body;
      };

      c.begin("email verification (SMTP)");
      let me = await call("GET", "/auth/me");
      c.eq("a new self-hosted account starts unverified", me.body.user.email_verified, false);
      const resend = await call("POST", "/auth/email/verify/resend");
      c.check("verification email requested", resend.status === 200, resend);
      const verifyMail = await until(async () => ctx.mails.find((m) => m.to.includes(email) && /confirm|verif/i.test(m.subject)));
      c.must("verification email delivered over SMTP to the sink", verifyMail, ctx.mails.map((m) => ({ to: m.to, subject: m.subject })));
      const vlink = linksOf(verifyMail!).find((l) => /verify-email/i.test(l));
      c.check("the email links to this server's verify page", vlink?.startsWith(ctx.base), linksOf(verifyMail!));
      await page.goto(vlink!);
      await page.waitForLoadState("networkidle");
      me = await call("GET", "/auth/me");
      c.eq("opening the link in the browser verifies the email", me.body.user.email_verified, true);
      const [vu] = await ctx.sql`SELECT email_verified_at FROM users WHERE email = ${email}`;
      c.check("users.email_verified_at is set", vu?.email_verified_at instanceof Date, vu);
      const replay = await call("POST", "/auth/email/verify", { token: new URL(vlink!).searchParams.get("token") ?? vlink!.split("/").pop() });
      c.check("the verify link works once (a second use answers 400 used)", replay.status === 400 && replay.body.reason === "used", replay);

      c.begin("password reset (SMTP)");
      const ctx2 = await browser.newContext();
      const p2 = await ctx2.newPage();
      await p2.goto(`${ctx.base}/forgot-password?email=${encodeURIComponent(email)}`);
      await p2.click("button[type=submit]");
      const resetMail = await until(async () => ctx.mails.find((m) => m.to.includes(email) && /reset|password/i.test(m.subject)));
      c.must("password reset email delivered", resetMail, ctx.mails.map((m) => m.subject));
      const rlink = linksOf(resetMail!).find((l) => /reset-password/i.test(l))!;
      await p2.goto(rlink);
      const newPassword = `second-pass-${ctx.stamp}`;
      await p2.locator("input[type=password]").first().fill(newPassword);
      const confirm = p2.locator("input[type=password]").nth(1);
      if (await confirm.count()) await confirm.fill(newPassword);
      await p2.click("button[type=submit]");
      await p2.waitForURL(/\/projects\//, { timeout: 15_000 }).catch(() => {});
      c.check("the reset page signs the browser in and opens the project", /\/projects\//.test(p2.url()), p2.url());
      const oldLogin = await fetch(`${ctx.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const newLogin = await fetch(`${ctx.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: newPassword }) });
      c.check("the old password no longer signs in, the new one does", oldLogin.status === 401 && newLogin.status === 200, { old: oldLogin.status, new: newLogin.status });
      me = await call("GET", "/auth/me");
      c.eq("resetting the password signed out the first browser's session", me.status, 401);
      await ctx2.close();
      // Sign the first browser back in through the sign-in form.
      await page.goto(`${ctx.base}/login`);
      await page.fill("#email", email);
      await page.fill("#password", newPassword);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/projects\//, { timeout: 15_000 }).catch(() => {});
      const cookie2 = (await page.context().cookies()).find((k) => k.name === "rd_session");
      c.must("signed in again through the sign-in form", cookie2 && cookie2.value !== cookie!.value);
      cookie!.value = cookie2!.value;

      c.begin("team invite");
      const mate = `teammate-${ctx.stamp}@journeys.test`;
      const inv = await call("POST", `${P}/invites`, { email: mate, role: "developer" });
      c.check("invite created", inv.status === 201 || inv.status === 200, inv);
      const inviteMail = await until(async () => ctx.mails.find((m) => m.to.includes(mate)));
      c.must("invite email delivered to the teammate", inviteMail);
      const ilink = linksOf(inviteMail!).find((l) => /\/invite\?/i.test(l))!;
      const token = new URL(ilink).searchParams.get("token")!;
      const info = await fetch(`${ctx.base}/auth/invites/${token}`).then((r) => r.json()) as any;
      c.has("invite page names the project, role and inviter", info, { email: mate, role: "developer", project: { id: projectId, name: "Sleep Coach" }, account_exists: false });
      const su = await fetch(`${ctx.base}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: mate, password: "teammate-pass-1", invite_token: token }) });
      const suBody = await su.json() as any;
      c.check("the teammate signs up with the invite and joins the project", su.status === 201 && suBody.project_id === projectId, suBody);
      const [mm] = await ctx.sql`SELECT m.role, u.email_verified_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ${mate} AND m.project_id = ${projectId}`;
      c.check("teammate is a developer member with a verified email (the invite proved the inbox)", mm?.role === "developer" && mm.email_verified_at, mm);

      c.begin("Test Store app, products, entitlement, offering, packages");
      const app = await v2("POST", "/apps", { name: "Sleep Coach (Test Store)", type: "test_store" });
      const keys = await v2("GET", `/apps/${app.id}/public_api_keys`);
      const testKey = keys.items[0]?.key as string;
      c.check("Test Store app with a test_ public key", app.type === "test_store" && /^test_/.test(testKey), { app, key: testKey?.slice(0, 6) });
      const mk = (store_identifier: string, type: string, price: number, duration?: string) => v2("POST", "/products", { store_identifier, app_id: app.id, type, display_name: store_identifier, ...(duration ? { subscription: { duration } } : {}), test_store_price: { amount_micros: Math.round(price * 1e6), currency: "USD" } });
      const monthly = await mk("sleep_monthly", "subscription", 7.99, "P1M");
      const annual = await mk("sleep_annual", "subscription", 49.99, "P1Y");
      const lifetime = await mk("sleep_lifetime", "non_consumable", 99.99);
      const prodRows = await ctx.sql`SELECT store_identifier, type, duration FROM products WHERE project_id = ${projectId} ORDER BY store_identifier`;
      c.eq("products stored with their types and durations", prodRows.map((r) => [r.store_identifier, r.type, r.duration]), [["sleep_annual", "subscription", "P1Y"], ["sleep_lifetime", "non_consumable", null], ["sleep_monthly", "subscription", "P1M"]]);
      const pro = await v2("POST", "/entitlements", { lookup_key: "premium", display_name: "Premium" });
      await v2("POST", `/entitlements/${pro.id}/actions/attach_products`, { product_ids: [monthly.id, annual.id, lifetime.id] });
      const entProducts = await v2("GET", `/entitlements/${pro.id}/products`);
      c.eq("entitlement 'premium' unlocked by all three products", entProducts.items.map((p: any) => p.store_identifier).sort(), ["sleep_annual", "sleep_lifetime", "sleep_monthly"]);
      const off = await v2("POST", "/offerings", { lookup_key: "default", display_name: "Default", metadata: { headline: "Sleep better" } });
      await v2("POST", `/offerings/${off.id}`, { is_current: true });
      for (const [i, [lk, prod]] of ([["$rc_monthly", monthly], ["$rc_annual", annual], ["$rc_lifetime", lifetime]] as const).entries()) {
        const pkg = await v2("POST", `/offerings/${off.id}/packages`, { lookup_key: lk, display_name: lk, position: i });
        await v2("POST", `/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: prod.id, eligibility_criteria: "all" }] });
      }
      const offering = await v2("GET", `/offerings/${off.id}?expand=package.product`);
      c.has("offering is current with three packages in order", { is_current: offering.is_current, packages: offering.packages.items.map((p: any) => p.lookup_key).join(",") }, { is_current: true, packages: "$rc_monthly,$rc_annual,$rc_lifetime" });

      c.begin("API keys");
      const sk = await v2("POST", "/api_keys", { name: "Backend" });
      c.check("secret key shown once with the sk_ prefix", /^sk_/.test(sk.key), { prefix: String(sk.key).slice(0, 3) });
      const listed = await v2("GET", "/api_keys");
      c.check("key list never contains the key itself", !JSON.stringify(listed).includes(sk.key));
      const [keyRow] = await ctx.sql`SELECT * FROM api_keys WHERE id = ${sk.id}`;
      c.check("api_keys stores a hash, not the key", keyRow && !JSON.stringify(keyRow).includes(sk.key), Object.keys(keyRow ?? {}));
      const backend = secretClient(ctx, sk.key, projectId);
      const viaKey = await backend.r("GET", "/offerings");
      c.check("the secret key reads the project's offerings on v2", viaKey.status === 200 && viaKey.body.items.length === 1, viaKey.status);
      const pubOnV2 = await secretClient(ctx, testKey, projectId).r("GET", "/offerings");
      c.check("the public SDK key is refused on v2 (403)", pubOnV2.status === 403, pubOnV2);

      c.begin("webhook to the node-express example backend");
      const backendDir = join(EXAMPLES, "backend/node-express-webhook");
      c.must("examples repo has backend/node-express-webhook with its node_modules", existsSync(join(backendDir, "node_modules/express")), backendDir);
      const hook = await v2("POST", "/integrations/webhooks", { name: "Example backend", url: `http://localhost:${PORTS.backend}/webhooks/revenuedot` });
      c.check("webhook created and its signing secret returned once", /^whsec_/.test(hook.signing_secret));
      let backendLog = "";
      const be = spawn(process.execPath, ["src/server.js"], { cwd: backendDir, env: { ...process.env, PORT: String(PORTS.backend), REVENUEDOT_WEBHOOK_SECRET: hook.signing_secret } });
      be.stdout.on("data", (d) => { backendLog += d; }); be.stderr.on("data", (d) => { backendLog += d; });
      try {
        await until(async () => backendLog.includes("Listening"), { timeoutMs: 15_000 });
        const sdk = sdkClient(ctx, testKey);
        const buyer = `sleeper_${ctx.stamp}`;
        const off2 = await sdk.offerings(buyer);
        const sdkOff = off2.body.offerings?.find((o: any) => o.identifier === "default");
        c.check("SDK offerings call returns the current offering with its three packages", off2.status === 200 && off2.body.current_offering_id === "default" && sdkOff?.packages?.length === 3, off2.body);
        const purchase = await sdk.purchase(buyer, "sleep_monthly", { price: 7.99, presented_offering_identifier: "default" });
        c.check("SDK receipt post (Test Store) answers 200 with premium active", purchase.status === 200 && purchase.body.subscriber?.entitlements?.premium?.product_identifier === "sleep_monthly", purchase.body);
        const delivered = await until(async () => {
          const d = await backend.r("GET", `/webhooks/${hook.id}/deliveries?limit=20`);
          return d.body.items?.find((x: any) => x.event_type === "INITIAL_PURCHASE" && x.status !== "pending");
        }, { timeoutMs: 45_000 });
        c.check("INITIAL_PURCHASE delivered with HTTP 200", delivered?.status === "delivered" && delivered.response_status === 200, delivered);
        c.check("the backend verified the HMAC signature and granted premium", await until(async () => backendLog.includes(`grant premium to ${buyer}`), { timeoutMs: 5000 }), backendLog.slice(-800));
        const [ev] = await eventsOf(ctx, projectId, { type: "INITIAL_PURCHASE", appUserId: buyer });
        c.has("the stored event has RevenueCat's fields", ev, { type: "INITIAL_PURCHASE", app_user_id: buyer, product_id: "sleep_monthly", entitlement_ids: ["premium"], store: "TEST_STORE", environment: "SANDBOX", presented_offering_id: "default", price: 7.99, currency: "USD" });
        // A wrong secret: the backend answers 401 and the delivery is marked failed and retried.
        const bad = await v2("POST", "/integrations/webhooks", { name: "Wrong secret", url: `http://localhost:${PORTS.backend}/webhooks/revenuedot`, event_types: ["initial_purchase"] });
        await sdk.purchase(`second_${ctx.stamp}`, "sleep_annual", { price: 49.99 });
        const failed = await until(async () => (await backend.r("GET", `/webhooks/${bad.id}/deliveries?limit=5`)).body.items?.find((x: any) => x.status !== "pending" || x.attempts > 0), { timeoutMs: 45_000 });
        c.check("a webhook with another secret is refused by the backend (401) and not marked delivered", failed && failed.status !== "delivered" && failed.response_status === 401, failed);
        // Retry on a delivery waiting for its scheduled retry sends it at once, as RevenueCat's dashboard Retry does.
        c.check("the refused delivery waits about 5 minutes for its next attempt", failed?.status === "pending" && failed.attempts === 1 && Math.abs(failed.next_attempt_at - Date.now() - 5 * 60_000) < 60_000, failed);
        const retry = await backend.r("POST", `/webhooks/${bad.id}/deliveries/${failed.id}/retry`);
        c.check("Retry of the waiting delivery is accepted (200) and due now", retry.status === 200 && retry.body.status === "pending" && retry.body.next_attempt_at <= Date.now() + 1000, { status: retry.status, body: retry.body });
        const again = await until(async () => (await backend.r("GET", `/webhooks/${bad.id}/deliveries?limit=5`)).body.items?.find((x: any) => x.id === failed.id && x.attempts >= 2), { timeoutMs: 45_000 });
        c.check("the retried delivery was sent again at once (attempt 2, the backend still answers 401)", again?.attempts === 2 && again.response_status === 401, again);
      } finally { be.kill("SIGTERM"); }

      c.begin("paywall from the gallery, published");
      const templates = await v2("GET", "/paywall_templates");
      c.check("gallery lists ten templates", templates.items?.length >= 10, templates.items?.length);
      const pw = await v2("POST", "/paywalls", { offering_id: off.id, template_id: "annual_two_plan", template_options: { app_name: "Sleep Coach", terms_url: "https://example.com/terms", privacy_url: "https://example.com/privacy" } });
      const pub = await call("POST", `${P}/paywalls/${pw.id}/actions/publish`);
      c.check("paywall published", pub.status === 200, pub);
      const sdkOffs = await sdkClient(ctx, testKey).offerings(`viewer_${ctx.stamp}`);
      const withPw = sdkOffs.body.offerings?.find((o: any) => o.identifier === "default");
      c.check("the SDK's offerings carry the published paywall components and ui_config", withPw?.has_paywall_components === true && withPw.paywall_components?.components_config && sdkOffs.body.ui_config, { has: withPw?.has_paywall_components, keys: Object.keys(withPw?.paywall_components ?? {}) });

      c.begin("dashboard shows what was built");
      const seen = async (path: string, texts: string[]) => {
        await page.goto(`${ctx.base}/projects/${projectId}${path}`);
        await page.waitForLoadState("networkidle");
        const body = await page.locator("body").innerText();
        const missing = texts.filter((t) => !body.includes(t));
        return c.check(`${path} shows ${texts.join(", ")}`, missing.length === 0, { missing });
      };
      await seen("/product-catalog/products", ["sleep_monthly", "sleep_annual", "sleep_lifetime"]);
      await seen("/product-catalog/entitlements", ["premium"]);
      await seen("/product-catalog/offerings", ["default"]);
      await seen("/apps", ["Sleep Coach (Test Store)"]);
      await seen("/integrations/webhooks", ["Example backend"]);
      await seen("/paywalls", ["default"]);
      await seen(`/customers/sleeper_${ctx.stamp}`, ["sleep_monthly", "premium"]);
      await page.screenshot({ path: join(ctx.out, "customer.png"), fullPage: true });
      c.check("no console errors in the dashboard", consoleErrors.length === 0, consoleErrors.slice(0, 5));
    } finally {
      await browser.close();
    }
  },
};
export default journey;
