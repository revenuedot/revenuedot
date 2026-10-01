import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { qs, webEnv, WEB_APP_ID, type WebEnv } from "../../../packages/contract/src/web-env.js";

/**
 * Web billing (prd/web-billing/PRD.md §1–§3, §7) against the in-memory fake Stripe: the checklist, web products created in
 * Stripe, purchase links, hosted checkout and its completion from the success page and the webhook in either order,
 * one-time products, expired links, outages, and custom domains.
 */
let env: WebEnv;
afterEach(async () => { await env?.h.close(); });
const P = () => `/v2/projects/${env.h.ids.project}`;

async function link(o: Record<string, unknown> = {}) {
  const r = await env.api("POST", `${P()}/purchase_links`, { name: "Spring sale", offering_id: (o.offering_id as string) ?? (await env.api("GET", `${P()}/offerings`)).body.items.find((x: any) => x.lookup_key === "web").id, ...o });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

/** Opens a purchase link, starts a checkout for `pkg`, pays on the fake Stripe page and loads the success page. */
async function buy(url: string, pkg: string, extra: Record<string, unknown> = {}) {
  const u = new URL(url);
  const [, , project, slug] = u.pathname.split("/");
  const start = await env.raw(`${u.origin}/pay/api/checkout`, { method: "POST", json: { project, slug, package: pkg, ...extra } });
  const body = await start.json() as { url: string; checkout_id: string; message?: string };
  expect(start.status, body.message).toBe(200);
  const sessionId = new URL(body.url).pathname.split("/").pop()!;
  const session = env.stripe.complete(sessionId, { email: "buyer@example.com" });
  return { sessionId, session, checkoutId: body.checkout_id, successUrl: session.success_url as string };
}

describe("Web page and checklist", () => {
  it("walks the four steps: Stripe connected, web config, web products created in Stripe, an offering with them", async () => {
    env = await webEnv();
    let o = (await env.api("GET", `${P()}/web`)).body;
    expect(o.checklist).toEqual({ connect_stripe: true, web_config: false, web_products: false, offering: false });
    expect(o.providers).toEqual([expect.objectContaining({ id: WEB_APP_ID, type: "stripe", public_key: "strp_webtest123", key: expect.objectContaining({ configured: true, mode: "test", kind: "restricted" }) })]);
    expect(o.pay_base).toBe("http://localhost/pay");
    expect(o.domain.slug).toBe("scanner");

    // Web config validation and defaults.
    const bad = await env.api("PUT", `${P()}/apps/${WEB_APP_ID}/web_config`, { logo_url: "http://insecure.example/logo.png" });
    expect(bad.status).toBe(400);
    expect(bad.body.param).toBe("logo_url");
    const redirectWithoutUrl = await env.api("PUT", `${P()}/apps/${WEB_APP_ID}/web_config`, { success_mode: "redirect" });
    expect(redirectWithoutUrl.status).toBe(400);
    const def = await env.api("GET", `${P()}/apps/${WEB_APP_ID}/web_config`);
    expect(def.body).toMatchObject({ saved: false, app_name: "Scanner Web", app_scheme: expect.stringMatching(/^rd-[0-9a-f]{10}$/), redemption_link_hours: 24, theme: { background: "#FFFFFF" } });
    expect(def.body.presets.length).toBeGreaterThan(2);
    const notStripe = await env.api("GET", `${P()}/apps/${env.h.ids.app}/web_config`);
    expect(notStripe.status).toBe(400);

    const ids = await env.setupWeb();
    o = (await env.api("GET", `${P()}/web`)).body;
    expect(o.checklist).toEqual({ connect_stripe: true, web_config: true, web_products: true, offering: true });
    expect(o.offerings_with_web_products).toEqual([ids.offeringId]);

    // Each web product is a Stripe product and price created with the app's key.
    const prodCalls = env.stripe.writes("/v1/products"), priceCalls = env.stripe.writes("/v1/prices");
    expect(prodCalls).toHaveLength(3);
    expect(prodCalls[0]!.params).toMatchObject({ name: "Pro monthly", metadata: { revenuedot_project: env.h.ids.project } });
    expect(priceCalls[0]!.params).toMatchObject({ currency: "usd", unit_amount: "999", recurring: { interval: "month", interval_count: "1" } });
    expect(priceCalls[2]!.params.recurring).toBeUndefined();
    expect(prodCalls.every((c) => c.idempotencyKey && c.auth?.startsWith("Bearer rk_test_"))).toBe(true);
    const list = await env.api("GET", `${P()}/apps/${WEB_APP_ID}/web_products`);
    const order = ["Pro monthly", "Pro annual", "Lifetime"];
    list.body.items.sort((a: any, b: any) => order.indexOf(a.product.display_name) - order.indexOf(b.product.display_name));
    expect(list.body.items.map((x: any) => [x.product.display_name, x.price.amount, x.interval, x.trial_days, x.product.subscription?.duration ?? null])).toEqual([
      ["Pro monthly", 9.99, "month", 7, "P1M"], ["Pro annual", 59.99, "year", null, "P1Y"], ["Lifetime", 99, null, null, null],
    ]);
    // The RevenueDot product is the Stripe price, so the Stripe store maps purchases to it.
    const [p] = await env.h.db.select().from(schema.products).where(eq(schema.products.id, ids.monthly));
    expect(p!.storeIdentifier).toBe(list.body.items[0].stripe_price_id);
    const ent = await env.h.db.select().from(schema.entitlementProducts).where(eq(schema.entitlementProducts.productId, ids.monthly));
    expect(ent).toEqual([{ entitlementId: "ent_pro", productId: ids.monthly }]);

    // Linking an existing price, validation and duplicates.
    expect((await env.api("POST", `${P()}/apps/${WEB_APP_ID}/web_products`, { display_name: "x", type: "subscription", price: { amount: 5, currency: "USD" } })).status).toBe(400);
    const linked = await env.api("POST", `${P()}/apps/${WEB_APP_ID}/web_products`, { display_name: "Again", type: "subscription", stripe_price_id: list.body.items[0].stripe_price_id });
    expect(linked.status).toBe(409);
    const wrongType = await env.api("POST", `${P()}/apps/${WEB_APP_ID}/web_products`, { display_name: "Again", type: "subscription", stripe_price_id: list.body.items[2].stripe_price_id });
    expect(wrongType.status).toBe(400);
  });

  it("a Stripe key without write access answers store_error naming the permissions", async () => {
    env = await webEnv();
    env.stripe.override = (method) => (method === "POST" ? new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "The provided key 'rk_test_***' does not have the required permissions for this endpoint." } }), { status: 403 }) : undefined);
    const r = await env.api("POST", `${P()}/apps/${WEB_APP_ID}/web_products`, { display_name: "Pro", type: "subscription", price: { amount: 5, currency: "USD" }, duration: "P1M" });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ type: "store_error" });
    expect(r.body.message).toMatch(/write access to Products and Prices/);
  });
});

describe("purchase links and hosted checkout", () => {
  it("an anonymous buyer pays, the success page shows a redemption link, INITIAL_PURCHASE fires once, and the webhook adds nothing", async () => {
    env = await webEnv();
    const ids = await env.setupWeb();
    const l = await link();
    expect(l).toMatchObject({ object: "purchase_link", slug: "spring-sale", status: "active", offering_lookup_key: "web", url: "http://localhost/pay/scanner/spring-sale" });

    const page = await env.raw(l.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    const n = /nonce-([^']+)'/.exec(csp)![1]!;
    expect(html).toContain(`<script nonce="${n}">`);
    expect(html).toContain("Go Pro on the web");
    expect(html).toContain("7-day free trial, then $9.99 per month");
    expect(html).toContain("Save 50%");
    expect(html).toContain('href="https://scanner.example/terms"');

    const { sessionId, successUrl, checkoutId } = await buy(l.url, "$rc_monthly");
    const created = env.stripe.writes("/v1/checkout/sessions")[0]!;
    expect(created.idempotencyKey).toBe(`rd-checkout-${checkoutId}`);
    expect(created.params).toMatchObject({
      mode: "subscription", line_items: [{ price: expect.stringMatching(/^price_/), quantity: "1" }], client_reference_id: checkoutId,
      metadata: { app_user_id: expect.stringMatching(/^\$RCAnonymousID:[0-9a-f]{32}$/), rd_checkout: checkoutId, rd_offering: "web" },
      subscription_data: { trial_period_days: "7", metadata: { rd_checkout: checkoutId } }, cancel_url: "http://localhost/pay/scanner/spring-sale?canceled=1",
    });
    expect(created.params.success_url).toBe(`http://localhost/pay/scanner/spring-sale/success?co=${checkoutId}&session_id={CHECKOUT_SESSION_ID}`);
    expect(qs(successUrl).session_id).toBe(sessionId);

    const success = await env.raw(successUrl);
    expect(success.status).toBe(200);
    const sHtml = await success.text();
    const redeem = /http:\/\/localhost\/pay\/r\/(rdrt_[A-Za-z0-9_-]+)/.exec(sHtml);
    expect(redeem).not.toBeNull();
    const anon = created.params.metadata.app_user_id as string;
    const initial = await env.events("INITIAL_PURCHASE");
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ app_user_id: anon, store: "STRIPE", period_type: "TRIAL", presented_offering_id: "web", environment: "SANDBOX", entitlement_ids: ["pro"] });
    // The buyer's email is on the customer and the redemption link went to it.
    const sent = env.mail.sent.filter((m) => m.to === "buyer@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(`http://localhost/pay/r/${redeem![1]}`);
    expect(sent[0]!.subject).toBe("Your Scanner purchase is ready");

    // The success page again shows the same token; the webhook for the same session changes nothing.
    expect(await (await env.raw(successUrl)).text()).toContain(redeem![1]!);
    const hook = await env.webhook(env.stripe.completedEvent(sessionId));
    expect(hook.status).toBe(200);
    expect(await env.events("INITIAL_PURCHASE")).toHaveLength(1);
    expect(env.mail.sent).toHaveLength(1);
    const linkAfter = (await env.api("GET", `${P()}/purchase_links/${l.id}`)).body;
    expect(linkAfter).toMatchObject({ checkouts: 1, purchases: 1 });

    // The redemption page opens the app's scheme.
    const r = await env.raw(`http://localhost/pay/r/${redeem![1]}`);
    expect(await r.text()).toContain(`scanner://redeem_web_purchase?redemption_token=${redeem![1]}`);
    expect((await env.raw("http://localhost/pay/r/rdrt_nottherealtokenatall0000")).status).toBe(404);
    void ids;
  });

  it("the webhook can arrive first: the purchase is recorded, the link emailed, and the success page shows the same token", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    const { sessionId, successUrl } = await buy(l.url, "$rc_annual");
    const hook = await env.webhook(env.stripe.completedEvent(sessionId));
    expect(await hook.json()).toEqual({ status: "processed" });
    const initial = await env.events("INITIAL_PURCHASE");
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ period_type: "NORMAL", price_in_purchased_currency: 59.99 });
    const emailed = /\/pay\/r\/(rdrt_[A-Za-z0-9_-]+)/.exec(env.mail.sent[0]!.text)![1];
    expect(await (await env.raw(successUrl)).text()).toContain(emailed);
    expect(await env.events("INITIAL_PURCHASE")).toHaveLength(1);
  });

  it("with app_user_id the purchase goes straight to that user: no redemption link", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    const { successUrl } = await buy(l.url, "$rc_monthly", { app_user_id: "user_42", email: "u42@example.com" });
    const html = await (await env.raw(successUrl)).text();
    expect(html).toContain("Your purchase is linked to your account");
    expect(html).not.toContain("/pay/r/rdrt_");
    expect((await env.events("INITIAL_PURCHASE"))[0]).toMatchObject({ app_user_id: "user_42" });
    const info = await env.h.fetch("/v1/subscribers/user_42");
    const body = await info.json() as any;
    expect(body.subscriber.entitlements.pro).toBeDefined();
    expect(env.mail.sent).toHaveLength(0);
    const attrs = await env.h.db.select().from(schema.customerAttributes);
    expect(attrs.find((a) => a.key === "$email")?.value).toBe("u42@example.com");
  });

  it("a one-time product is a payment-mode checkout and a NON_RENEWING_PURCHASE", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    const { successUrl } = await buy(l.url, "$rc_lifetime");
    expect(env.stripe.writes("/v1/checkout/sessions")[0]!.params).toMatchObject({ mode: "payment", payment_intent_data: { metadata: { rd_offering: "web" } } });
    expect((await env.raw(successUrl)).status).toBe(200);
    expect(await env.events("NON_RENEWING_PURCHASE")).toHaveLength(1);
  });

  it("expired and disabled links answer 410; unknown pages 404; a processing payment reloads", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link({ expires_at: env.h.now().getTime() - 1000 });
    expect(l.status).toBe("expired");
    expect((await env.raw(l.url)).status).toBe(410);
    const r = await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: l.slug, package: "$rc_monthly" } });
    expect(r.status).toBe(410);
    const l2 = await link({ name: "Off", enabled: false });
    expect((await env.raw(l2.url)).status).toBe(410);
    expect((await env.raw("http://localhost/pay/scanner/nothing-here")).status).toBe(404);
    expect((await env.raw("http://localhost/pay/nobody/x")).status).toBe(404);
    // A slug is unique among links and funnels.
    expect((await env.api("POST", `${P()}/purchase_links`, { name: "Dup", slug: l.slug, offering_id: l.offering_id })).status).toBe(409);
    expect((await env.api("POST", `${P()}/funnels`, { name: "Dup", slug: l.slug })).status).toBe(409);
    expect((await env.api("POST", `${P()}/purchase_links`, { name: "Bad", slug: "api", offering_id: l.offering_id })).status).toBe(400);

    // Not paid yet: the page says processing and reloads itself.
    const l3 = await link({ name: "Live" });
    const start = await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: l3.slug, package: "$rc_monthly" } });
    const { url, checkout_id } = await start.json() as { url: string; checkout_id: string };
    const sid = new URL(url).pathname.split("/").pop()!;
    const html = await (await env.raw(`${l3.url}/success?co=${checkout_id}&session_id=${sid}`)).text();
    expect(html).toContain("Your payment is processing");
    expect(await env.events("INITIAL_PURCHASE")).toHaveLength(0);
    // A session id that is not this checkout's shows nothing.
    expect((await env.raw(`${l3.url}/success?co=${checkout_id}&session_id=cs_test_other`)).status).toBe(404);
  });

  it("a Stripe outage or a rejected key answers 503 with a message, and the checkout row is marked failed", async () => {
    env = await webEnv();
    await env.setupWeb();
    const l = await link();
    env.stripe.override = (method, path) => (method === "POST" && path === "/v1/checkout/sessions" ? new Response("{}", { status: 502 }) : undefined);
    const r = await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: l.slug, package: "$rc_monthly" } });
    expect(r.status).toBe(503);
    expect((await r.json() as any).message).toMatch(/busy/);
    const rows = await env.h.db.select().from(schema.webCheckouts);
    expect(rows.map((x) => x.status)).toEqual(["failed"]);
    expect((await env.raw("http://localhost/pay/api/checkout", { method: "POST", json: { project: "scanner", slug: l.slug, package: "$rc_nope" } })).status).toBe(400);
  });

  it("the iOS SDK's hosted checkout returns a Stripe checkout for the package and completes on the success URL", async () => {
    env = await webEnv();
    await env.setupWeb();
    const r = await env.h.fetch("/rcbilling/v1/hosted-checkout", { method: "POST", json: { app_user_id: "ios_user", package_id: "$rc_monthly", presented_offering_identifier: "web" } });
    expect(r.status).toBe(200);
    const b = await r.json() as Record<string, string>;
    expect(Object.keys(b).sort()).toEqual(["cancel_url", "checkout_url", "operation_session_id", "success_url"]);
    expect(b).toMatchObject({ success_url: "http://localhost/pay/scanner/_/success", cancel_url: "http://localhost/pay/scanner/_/cancel", operation_session_id: expect.stringMatching(/^wco_/) });
    const sid = new URL(b.checkout_url!).pathname.split("/").pop()!;
    const s = env.stripe.complete(sid);
    expect(s.success_url.startsWith(b.success_url!)).toBe(true);
    const page = await env.raw(s.success_url);
    expect(await page.text()).toContain("Purchase complete");
    expect((await env.events("INITIAL_PURCHASE"))[0]).toMatchObject({ app_user_id: "ios_user" });
    const none = await env.h.fetch("/rcbilling/v1/hosted-checkout", { method: "POST", json: { app_user_id: "ios_user", package_id: "$rc_monthly", presented_offering_identifier: "default" } });
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ code: 7000 });
  });
});

describe("domains", () => {
  it("a custom domain is verified by its CNAME and TXT records, then serves the project's pages at its root", async () => {
    env = await webEnv({ customDomainTarget: "domains.pay.test" });
    await env.setupWeb();
    const l = await link();
    const put = await env.api("PUT", `${P()}/web_domain`, { custom_domain: "Pay.Scanner.example" });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ custom_domain: "pay.scanner.example", status: "pending" });
    const [cname, txt] = put.body.dns;
    expect(cname).toEqual({ type: "CNAME", name: "pay.scanner.example", value: "domains.pay.test" });
    expect(txt.name).toBe("_revenuedot.pay.scanner.example");
    // Not yet: the page is not served on that host.
    expect((await env.raw(`https://pay.scanner.example/${l.slug}`)).status).toBe(404);
    let v = await env.api("POST", `${P()}/web_domain/actions/verify`);
    expect(v.body).toMatchObject({ status: "failed" });
    expect(v.body.error).toMatch(/TXT record _revenuedot\.pay\.scanner\.example/);
    env.dns["_revenuedot.pay.scanner.example"] = { TXT: [txt.value] };
    env.dns["pay.scanner.example"] = { CNAME: ["elsewhere.example"] };
    v = await env.api("POST", `${P()}/web_domain/actions/verify`);
    expect(v.body.error).toMatch(/must be a CNAME to domains\.pay\.test; it points to elsewhere\.example/);
    env.dns["pay.scanner.example"] = { CNAME: ["domains.pay.test"] };
    v = await env.api("POST", `${P()}/web_domain/actions/verify`);
    expect(v.body).toMatchObject({ status: "verified", error: null, base: "https://pay.scanner.example" });
    expect((await env.api("GET", `${P()}/purchase_links/${l.id}`)).body.url).toBe(`https://pay.scanner.example/${l.slug}`);

    const page = await env.raw(`https://pay.scanner.example/${l.slug}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('"checkout":"https://pay.scanner.example/api/checkout"');
    // Behind a TLS proxy the request arrives as http; links keep the visitor's https.
    const proxied = await env.raw(`http://pay.scanner.example/${l.slug}`, { headers: { "x-forwarded-proto": "https" } });
    expect(await proxied.text()).toContain('"checkout":"https://pay.scanner.example/api/checkout"');
    const start = await env.raw("https://pay.scanner.example/api/checkout", { method: "POST", json: { project: "scanner", slug: l.slug, package: "$rc_annual" } });
    expect(start.status).toBe(200);
    expect(env.stripe.writes("/v1/checkout/sessions")[0]!.params.success_url).toMatch(/^https:\/\/pay\.scanner\.example\/spring-sale\/success\?co=/);
    // API paths on that host are still the API; a domain of another project is refused.
    expect((await env.raw("https://pay.scanner.example/v1/health")).status).toBe(200);
    expect((await env.api("PUT", `${P()}/web_domain`, { custom_domain: "api.revenuedot.app" })).status).toBe(400);
    expect((await env.api("PUT", `${P()}/web_domain`, { slug: "api" })).status).toBe(400);
  });

  it("with REVENUEDOT_PAY_URL on its own host, pages live at that host's root", async () => {
    env = await webEnv({ payUrl: "https://pay.example.dev" });
    await env.setupWeb();
    const l = await link();
    expect(l.url).toBe("https://pay.example.dev/scanner/spring-sale");
    const page = await env.raw(l.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('"checkout":"https://pay.example.dev/api/checkout"');
    const start = await env.raw("https://pay.example.dev/api/checkout", { method: "POST", json: { project: "scanner", slug: "spring-sale", package: "$rc_monthly" } });
    expect(start.status).toBe(200);
    const { url } = await start.json() as { url: string };
    const s = env.stripe.complete(new URL(url).pathname.split("/").pop()!);
    expect(s.success_url).toMatch(/^https:\/\/pay\.example\.dev\/scanner\/spring-sale\/success\?/);
    const html = await (await env.raw(s.success_url)).text();
    expect(html).toMatch(/https:\/\/pay\.example\.dev\/r\/rdrt_/);
  });
});
