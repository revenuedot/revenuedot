import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CONN_APP_ID, CONN_APP_KEY, FAKE_CONNECT_CONFIG, WEB_APP_ID, webEnv, type WebEnv } from "../../../packages/contract/src/web-env.js";
import { FAKE_CONNECT_CLIENT_ID, FAKE_PLATFORM_KEY, FAKE_PLATFORM_TEST_KEY, FAKE_STRIPE_KEY } from "../../../packages/contract/src/fake-stripe.js";
import { sha256 } from "../src/services/stripe-connect.js";

/**
 * "Connect with Stripe" (prd/web-billing/PRD.md §8) against the fake Connect platform: availability, OAuth with its state and
 * nonce checks, the sealed account id, every Stripe path acting on the connected account with Stripe-Account (web products,
 * checkout, discounts, receipts, refunds), the platform's webhook endpoint, deauthorization, disconnect, Account Links and
 * test mode; and the restricted-key app next to it, unchanged.
 */
let env: WebEnv;
afterEach(async () => { await env?.h.close(); });
const P = () => `/v2/projects/${env.h.ids.project}`;
const C = () => `${P()}/apps/${CONN_APP_ID}/stripe_connect`;

/** Starts OAuth, approves on the fake Stripe page and finishes from the callback, like the dashboard does. */
async function connect(o: { mode?: "live" | "test"; account?: string } = {}) {
  const start = await env.api("POST", `${C()}/actions/start`, { method: "oauth", mode: o.mode ?? "live" });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  const { redirect, account } = env.platform.approve(start.body.url, o.account);
  const back = new URL(redirect);
  const fin = await env.api("POST", `${C()}/actions/finish`, { state: back.searchParams.get("state"), code: back.searchParams.get("code"), nonce: start.body.nonce });
  expect(fin.status, JSON.stringify(fin.body)).toBe(200);
  return { account, start: start.body, finish: fin.body };
}

describe("availability", () => {
  it("without platform keys Connect is unavailable, says why, and the restricted-key app keeps working", async () => {
    env = await webEnv({ connect: null });
    const s = await env.api("GET", C());
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ object: "stripe_connect", available: false, status: "not_connected", modes: [], application_fee: null });
    expect(s.body.unavailable_reason).toMatch(/not set up on this server.*REVENUEDOT_STRIPE_CONNECT_CLIENT_ID.*REVENUEDOT_STRIPE_CONNECT_SECRET_KEY.*REVENUEDOT_STRIPE_CONNECT_WEBHOOK_SECRET.*restricted key/);
    const start = await env.api("POST", `${C()}/actions/start`, { method: "oauth" });
    expect(start.status).toBe(422);
    expect(start.body.message).toMatch(/not set up on this server/);
    // The platform endpoint does not exist without a webhook secret.
    expect((await env.connectWebhook({ id: "evt_x", type: "ping", account: "acct_x", data: { object: {} } })).status).toBe(404);
    // The restricted-key path: a web product created with the developer's own key, as before.
    await env.setupWeb();
    expect(env.stripe.writes("/v1/products").every((c) => c.auth === `Bearer ${FAKE_STRIPE_KEY}` && !c.account)).toBe(true);
    expect(env.platform.calls).toHaveLength(0);
  });

  it("a partial configuration names what is missing; Cloud says it is not available yet", async () => {
    env = await webEnv({ connect: { clientId: FAKE_CONNECT_CLIENT_ID, webhookSecrets: [] } });
    const s = (await env.api("GET", C())).body;
    expect(s.available).toBe(false);
    expect(s.unavailable_reason).toMatch(/REVENUEDOT_STRIPE_CONNECT_SECRET_KEY, REVENUEDOT_STRIPE_CONNECT_WEBHOOK_SECRET/);
    expect(s.unavailable_reason).not.toMatch(/CLIENT_ID/);
    const { connectAvailability } = await import("../src/services/stripe-connect.js");
    expect(connectAvailability({ edition: "cloud", stripeConnect: undefined }).reason).toMatch(/not available on RevenueDot Cloud yet/);
    expect(connectAvailability({ edition: "self-hosted", stripeConnect: FAKE_CONNECT_CONFIG })).toMatchObject({ available: true, modes: ["live", "test"] });
    expect(connectAvailability({ stripeConnect: { ...FAKE_CONNECT_CONFIG, secretKey: FAKE_PLATFORM_TEST_KEY, testSecretKey: undefined } }).modes).toEqual(["test"]);
  });
});

describe("OAuth", () => {
  it("connects an existing Stripe account: state, nonce, the code exchange, the sealed account id", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG, publicUrl: "https://app.example.com" });
    // The app had a restricted key before; connecting replaces it.
    await env.api("POST", `${P()}/apps/${CONN_APP_ID}`, { stripe: { stripe_secret_key: "rk_test_51Old0000", stripe_webhook_secret: "whsec_old000" } });
    const before = (await env.api("GET", C())).body;
    expect(before).toMatchObject({ available: true, modes: ["live", "test"], status: "not_connected", restricted_key_configured: true, webhook_url: "http://localhost/v1/notifications/stripe-connect" });

    const start = await env.api("POST", `${C()}/actions/start`, { method: "oauth", mode: "live" });
    expect(start.status).toBe(200);
    const url = new URL(start.body.url);
    expect(url.origin + url.pathname).toBe("https://connect.stripe.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: "code", client_id: FAKE_CONNECT_CLIENT_ID, scope: "read_write", redirect_uri: "https://app.example.com/connect/stripe" });
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(new RegExp(`^${env.h.ids.project}\\.${CONN_APP_ID}\\.[0-9a-f]{32}$`));
    expect(start.body.nonce).toMatch(/^[0-9a-f]{64}$/);
    // Only hashes are stored.
    const [pending] = await env.h.db.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.appId, CONN_APP_ID));
    expect(pending!.pendingStateHash).toBe(await sha256(state));
    expect(JSON.stringify(pending)).not.toContain(start.body.nonce);

    const { redirect, account } = env.platform.approve(start.body.url);
    const code = new URL(redirect).searchParams.get("code")!;
    // A nonce from another browser is refused, and the state is spent.
    const wrong = await env.api("POST", `${C()}/actions/finish`, { state, code, nonce: "f".repeat(64) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/another browser/);
    const again = await env.api("POST", `${C()}/actions/finish`, { state, code, nonce: start.body.nonce });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/not valid/);

    const s2 = await env.api("POST", `${C()}/actions/start`, { method: "oauth", mode: "live" });
    const ok = env.platform.approve(s2.body.url, account);
    const back = new URL(ok.redirect);
    const fin = await env.api("POST", `${C()}/actions/finish`, { state: back.searchParams.get("state"), code: back.searchParams.get("code"), nonce: s2.body.nonce });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    expect(fin.body).toMatchObject({ status: "connected", method: "oauth", mode: "live", account: `acct_…${account.slice(-4)}`, charges_enabled: true, details_submitted: true, restricted_key_configured: false });
    // The code exchange used the platform's secret key at connect.stripe.com; only the account id was kept.
    const exchange = env.platform.calls.find((x) => x.host === "connect.stripe.com" && x.path === "/oauth/token" && x.params.code === back.searchParams.get("code"))!;
    expect(exchange).toMatchObject({ method: "POST", auth: `Bearer ${FAKE_PLATFORM_KEY}`, params: { grant_type: "authorization_code" } });
    const [row] = await env.h.db.select().from(schema.apps).where(eq(schema.apps.id, CONN_APP_ID));
    expect(row!.secrets).toMatch(/^v1:/);
    expect(row!.secrets).not.toContain(account);
    expect(JSON.stringify(row!.credentials)).not.toContain(account);
    expect(row!.secretHints).toEqual({ stripe_connect_account_id: `acct_…${account.slice(-4)}` });
    expect(row!.credentials).toMatchObject({ stripe_connect_mode: "live" });
    const [conn] = await env.h.db.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.appId, CONN_APP_ID));
    expect(conn).toMatchObject({ status: "connected", accountHash: await sha256(account), pendingStateHash: null, pendingNonceHash: null });
    // No API answer carries the account id or a key.
    for (const path of [C(), `${P()}/apps/${CONN_APP_ID}`, `${P()}/web`, `${P()}/apps/${CONN_APP_ID}/store_settings`]) {
      const r = await env.api("GET", path);
      expect(JSON.stringify(r.body)).not.toContain(account);
      expect(JSON.stringify(r.body)).not.toContain(FAKE_PLATFORM_KEY);
    }
    const web = (await env.api("GET", `${P()}/web`)).body;
    expect(web.providers.find((p: any) => p.id === CONN_APP_ID)).toMatchObject({ connection: "stripe_connect", mode: "live" });
    expect(web.checklist.connect_stripe).toBe(true);
    // Connected twice is refused.
    expect((await env.api("POST", `${C()}/actions/start`, { method: "oauth" })).status).toBe(409);
  });

  it("refuses expired, denied, foreign and tampered sign-ins", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG });
    const start = await env.api("POST", `${C()}/actions/start`, { method: "oauth" });
    const { redirect } = env.platform.approve(start.body.url);
    const back = new URL(redirect);
    // Eleven minutes later.
    env.h.setNow(new Date(env.h.now().getTime() + 11 * 60_000));
    const late = await env.api("POST", `${C()}/actions/finish`, { state: back.searchParams.get("state"), code: back.searchParams.get("code"), nonce: start.body.nonce });
    expect(late.status).toBe(400);
    expect(late.body.message).toMatch(/longer than 10 minutes/);
    // The developer cancelled on Stripe's page: no code.
    const s2 = await env.api("POST", `${C()}/actions/start`, { method: "oauth" });
    const denied = new URL(env.platform.deny(s2.body.url));
    const d = await env.api("POST", `${C()}/actions/finish`, { state: denied.searchParams.get("state"), nonce: s2.body.nonce, code: null });
    expect(d.status).toBe(400);
    // A state for another app (or project) is refused on this app.
    const s3 = await env.api("POST", `${C()}/actions/start`, { method: "oauth" });
    const st3 = new URL(s3.body.url).searchParams.get("state")!;
    const foreign = await env.api("POST", `${P()}/apps/${WEB_APP_ID}/stripe_connect/actions/finish`, { state: st3, code: "ac_x", nonce: s3.body.nonce });
    expect(foreign.status).toBe(400);
    // Stripe refusing the code (used, or invented) leaves the app unconnected.
    const s4 = await env.api("POST", `${C()}/actions/start`, { method: "oauth" });
    const bad = await env.api("POST", `${C()}/actions/finish`, { state: new URL(s4.body.url).searchParams.get("state"), code: "ac_invented", nonce: s4.body.nonce });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ type: "store_error" });
    expect(bad.body.message).toMatch(/Authorization code does not exist/);
    expect((await env.api("GET", C())).body.status).toBe("not_connected");
    // Unknown modes, a Test Store app.
    expect((await env.api("POST", `${C()}/actions/start`, { method: "oauth", mode: "sandbox" })).status).toBe(400);
    expect((await env.api("GET", `${P()}/apps/${env.h.ids.app}/stripe_connect`)).status).toBe(422);
    // A body can never point an app at an account.
    const inject = await env.api("POST", `${P()}/apps/${CONN_APP_ID}`, { stripe: { stripe_connect_account_id: "acct_someoneelse" } });
    expect(inject.status).toBe(400);
    expect(inject.body.param).toBe("stripe.stripe_connect_account_id");
  });
});

describe("using the connection", () => {
  it("web products, checkout, the platform webhook, receipts, discounts and refunds act on the connected account", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG });
    const { account } = await connect();
    const acct = env.platform.accounts.get(account)!;
    const ids = await env.setupWeb(CONN_APP_ID);
    // Products and prices were created on the connected account with the platform key and Stripe-Account.
    const writes = acct.writes("/v1/products");
    expect(writes).toHaveLength(3);
    expect(writes.every((c) => c.auth === `Bearer ${FAKE_PLATFORM_KEY}` && c.account === account)).toBe(true);
    expect(env.stripe.writes()).toHaveLength(0);

    const link = await env.api("POST", `${P()}/purchase_links`, { name: "Launch", offering_id: ids.offeringId, app_id: CONN_APP_ID });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    const u = new URL(link.body.url);
    const [, , project, slug] = u.pathname.split("/");
    const startRes = await env.raw(`${u.origin}/pay/api/checkout`, { method: "POST", json: { project, slug, package: "$rc_annual", app_user_id: "conn_user_1" } });
    const start = await startRes.json() as { url: string };
    expect(startRes.status, JSON.stringify(start)).toBe(200);
    const sessionId = new URL(start.url).pathname.split("/").pop()!;
    expect(acct.sessions.has(sessionId)).toBe(true);
    acct.complete(sessionId, { email: "buyer@example.com" });
    // checkout.session.completed arrives at the platform endpoint with `account`.
    const done = await env.connectWebhook(acct.completedEvent(sessionId));
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: "processed" });
    const initial = await env.events("INITIAL_PURCHASE");
    expect(initial).toHaveLength(1);
    // A live connection: live objects, production purchases.
    expect(initial[0]).toMatchObject({ app_user_id: "conn_user_1", app_id: CONN_APP_ID, store: "STRIPE", environment: "PRODUCTION" });
    // The same event again is a duplicate; the per-app endpoint of a connected app acknowledges and drops Stripe's copies.
    const evt = acct.completedEvent(sessionId);
    expect(await (await env.connectWebhook(evt)).json()).toMatchObject({ status: "processed" });
    expect(await (await env.connectWebhook(evt)).json()).toMatchObject({ status: "duplicate" });
    const perApp = await env.raw(`/v1/notifications/stripe/${CONN_APP_ID}`, { method: "POST", body: JSON.stringify(evt), headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=00" } });
    expect(perApp.status).toBe(200);
    expect(await perApp.json()).toMatchObject({ status: "ignored" });

    // A backend posting the subscription with the Stripe app's key: read on the connected account.
    const subId = acct.sessions.get(sessionId)!.subscription as string;
    const receipt = await env.h.fetch("/v1/receipts", { method: "POST", key: CONN_APP_KEY, headers: { "x-platform": "stripe", "content-type": "application/json" }, body: JSON.stringify({ app_user_id: "conn_user_1", fetch_token: subId }) });
    expect(receipt.status).toBe(200);
    expect(Object.keys(((await receipt.json()) as any).subscriber.entitlements)).toContain("pro");
    expect(acct.calls.some((c) => c.method === "GET" && c.path === `/v1/subscriptions/${subId}` && c.account === account)).toBe(true);

    // Web discounts: a coupon and a promotion code on the connected account.
    const disc = await env.api("POST", `${P()}/discounts`, { identifier: "launch20", customer_facing_name: "Launch", type: "percentage", percentage: 20, duration_mode: "one_time", eligibility: "everyone" });
    expect(disc.status, JSON.stringify(disc.body)).toBe(201);
    // Each Stripe app of the project gets the coupon: the connected account through the platform, the other with its own key.
    expect([...acct.coupons.values()].some((c) => c.percent_off === 20)).toBe(true);
    expect(acct.writes("/v1/coupons").every((c) => c.account === account && c.auth === `Bearer ${FAKE_PLATFORM_KEY}`)).toBe(true);

    // A refund in Stripe: charge.refunded on the connected account marks the period refunded.
    const sub = acct.subscriptions.get(subId)!;
    const refund = await env.connectWebhook(env.platform.connectEvent(account, "charge.refunded", { id: "ch_1", object: "charge", amount: 5999, amount_refunded: 5999, refunded: true, currency: "usd", invoice: sub.latest_invoice, livemode: true, refunds: { data: [{ created: Math.floor(env.h.now().getTime() / 1000) }] } }));
    expect(await refund.json()).toMatchObject({ status: "processed" });
    expect(await env.events("CANCELLATION")).toEqual([expect.objectContaining({ cancel_reason: "CUSTOMER_SUPPORT", app_id: CONN_APP_ID })]);

    // "Check credentials" reads the connected account.
    const check = await env.api("POST", `${P()}/apps/${CONN_APP_ID}/actions/verify_credentials`, {});
    expect(check.body).toMatchObject({ status: "valid", message: "The connected Stripe account answered in live mode." });
    // A restricted key cannot be added while connected.
    const key = await env.api("POST", `${P()}/apps/${CONN_APP_ID}`, { stripe: { stripe_secret_key: "rk_live_51New0000" } });
    expect(key.status).toBe(409);
    // The restricted-key app in the same project still uses the developer's own key.
    await env.api("POST", `${P()}/apps/${WEB_APP_ID}/web_products`, { display_name: "Own", type: "subscription", price: { amount: 3, currency: "USD" }, duration: "P1M" });
    expect(env.stripe.writes("/v1/products").at(-1)).toMatchObject({ auth: `Bearer ${FAKE_STRIPE_KEY}`, account: null });
  });

  it("Check credentials never sends the platform key with another account (no Stripe values in the body while connected)", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG });
    const { account } = await connect();
    const victim = "acct_1Victim000000";
    const before = env.platform.calls.length;
    for (const stripe of [{ stripe_account_id: victim }, { stripe_secret_key: "rk_live_51Mine0000", stripe_account_id: victim }, { stripe_secret_key: "rk_live_51Mine0000" }]) {
      const r = await env.api("POST", `${P()}/apps/${CONN_APP_ID}/actions/verify_credentials`, { stripe });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.message).toMatch(/connected with Stripe Connect/);
    }
    const acctCalls = [...env.platform.accounts.values()].flatMap((a) => a.calls);
    expect(acctCalls.some((c) => c.account === victim)).toBe(false);
    expect(env.platform.calls.slice(before).some((c) => c.account === victim)).toBe(false);
    // The stored connection is still checked as before.
    expect((await env.api("POST", `${P()}/apps/${CONN_APP_ID}/actions/verify_credentials`, {})).body).toMatchObject({ status: "valid" });
    expect(acctCalls.every((c) => !c.account || c.account === account)).toBe(true);
  });

  it("the platform endpoint checks the signature and answers unknown accounts and platform events with 200", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG });
    const { account } = await connect();
    const evt = env.platform.connectEvent(account, "customer.subscription.updated", { id: "sub_missing", object: "subscription", livemode: true });
    expect((await env.connectWebhook(evt, "whsec_wrongsecret0000")).status).toBe(400);
    const unknown = await env.connectWebhook(env.platform.connectEvent("acct_1Nobody", "invoice.paid", { id: "in_1", object: "invoice" }));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ status: "unknown_account" });
    const { account: _a, ...platformEvent } = evt;
    void _a;
    expect(await (await env.connectWebhook(platformEvent)).json()).toEqual({ status: "ignored" });
    // A subscription Stripe does not know: stored with the error, answered 200 so Stripe stops retrying.
    expect(await (await env.connectWebhook(evt)).json()).toMatchObject({ status: "invalid" });
    const [n] = await env.h.db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.id, `stripe_${CONN_APP_ID}_${evt.id}`));
    expect(n!.error).toMatch(/No such subscription/);
    // Onboarding progress from account.updated.
    // A test-mode event is not this live connection's: acknowledged, not applied.
    expect(await (await env.connectWebhook(env.platform.connectEvent(account, "customer.subscription.updated", { id: "sub_test", object: "subscription", livemode: false }))).json()).toEqual({ status: "other_mode" });
    expect(await (await env.connectWebhook(env.platform.connectEvent(account, "account.updated", { id: account, object: "account", charges_enabled: false, details_submitted: true }))).json()).toEqual({ status: "processed" });
    expect((await env.api("GET", C())).body).toMatchObject({ charges_enabled: false, details_submitted: true });
  });
});

describe("disconnect", () => {
  it("removing RevenueDot in Stripe (account.application.deauthorized) disconnects the app", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG });
    const { account } = await connect();
    env.platform.deauthorized.add(account);
    const r = await env.connectWebhook(env.platform.connectEvent(account, "account.application.deauthorized", { id: FAKE_CONNECT_CLIENT_ID, object: "application", name: "RevenueDot" }));
    expect(await r.json()).toEqual({ status: "disconnected" });
    const s = (await env.api("GET", C())).body;
    expect(s).toMatchObject({ status: "disconnected", account: null, disconnect_reason: "Disconnected in Stripe" });
    expect(s.disconnected_at).toBe(env.h.now().getTime());
    const [row] = await env.h.db.select().from(schema.apps).where(eq(schema.apps.id, CONN_APP_ID));
    expect(row!.secretHints).toEqual({});
    expect(row!.credentials).not.toHaveProperty("stripe_connect_mode");
    const [conn] = await env.h.db.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.appId, CONN_APP_ID));
    expect(conn!.accountHash).toBeNull();
    // Stripe calls now fail with "no API key"; later events for the account find no app.
    const w = await env.api("POST", `${P()}/apps/${CONN_APP_ID}/web_products`, { display_name: "x", type: "subscription", price: { amount: 5, currency: "USD" }, duration: "P1M" });
    expect(w.status).toBe(422);
    expect(w.body.message).toMatch(/no API key yet. Connect with Stripe/);
    expect(await (await env.connectWebhook(env.platform.connectEvent(account, "invoice.paid", { id: "in_1", object: "invoice" }))).json()).toEqual({ status: "unknown_account" });
    // It can connect again.
    await connect({ account });
    expect((await env.api("GET", C())).body.status).toBe("connected");
  });

  it("Disconnect in RevenueDot deauthorizes at Stripe; Stripe down still disconnects and warns", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG });
    const { account } = await connect();
    const d = await env.api("POST", `${C()}/actions/disconnect`, {});
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ status: "disconnected", deauthorized: true, warning: null, disconnect_reason: "Disconnected in RevenueDot" });
    expect(env.platform.calls.find((c) => c.path === "/oauth/deauthorize")).toMatchObject({ auth: `Bearer ${FAKE_PLATFORM_KEY}`, params: { client_id: FAKE_CONNECT_CLIENT_ID, stripe_user_id: account } });
    expect((await env.api("POST", `${C()}/actions/disconnect`, {})).status).toBe(409);

    await connect({ account });
    env.platform.override = (_m, path) => (path === "/oauth/deauthorize" ? new Response("{}", { status: 503 }) : undefined);
    const down = await env.api("POST", `${C()}/actions/disconnect`, {});
    expect(down.body).toMatchObject({ status: "disconnected", deauthorized: false });
    expect(down.body.warning).toMatch(/Remove it there/);
  });
});

describe("Account Links and test mode", () => {
  it("creates a Standard account through the platform and follows its onboarding", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG, publicUrl: "https://app.example.com" });
    const start = await env.api("POST", `${C()}/actions/start`, { method: "account_link", mode: "live", email: "owner@scanner.example" });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.url).toMatch(/^https:\/\/connect\.stripe\.com\/setup\/s\/acct_/);
    const created = env.platform.calls.find((c) => c.path === "/v1/accounts" && c.method === "POST")!;
    expect(created).toMatchObject({ auth: `Bearer ${FAKE_PLATFORM_KEY}`, account: null, params: { type: "standard", email: "owner@scanner.example", metadata: { revenuedot_app: CONN_APP_ID } } });
    const link = env.platform.calls.find((c) => c.path === "/v1/account_links")!;
    expect(link.params).toMatchObject({ type: "account_onboarding" });
    expect(link.params.return_url).toMatch(/^https:\/\/app\.example\.com\/connect\/stripe\?state=/);
    expect(link.params.refresh_url).toMatch(/&refresh=1$/);
    let s = (await env.api("GET", C())).body;
    expect(s).toMatchObject({ status: "connected", method: "account_link", charges_enabled: false, details_submitted: false });
    // Back from onboarding: the status is read again.
    const account = [...env.platform.accounts.keys()][0]!;
    env.platform.finishOnboarding(account);
    const state = new URL(link.params.return_url).searchParams.get("state");
    const fin = await env.api("POST", `${C()}/actions/finish`, { state, nonce: start.body.nonce });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    s = fin.body;
    expect(s).toMatchObject({ status: "connected", charges_enabled: true, details_submitted: true });
    // An unfinished onboarding can be resumed with a fresh link for the same account.
    const again = await env.api("POST", `${C()}/actions/start`, { method: "account_link", mode: "live" });
    expect(again.status).toBe(200);
    expect(env.platform.calls.filter((c) => c.path === "/v1/accounts" && c.method === "POST")).toHaveLength(1);
  });

  it("a test-mode connection acts with the platform's test key and records sandbox purchases", async () => {
    env = await webEnv({ connect: FAKE_CONNECT_CONFIG });
    const { account } = await connect({ mode: "test" });
    expect((await env.api("GET", C())).body).toMatchObject({ mode: "test" });
    await env.setupWeb(CONN_APP_ID);
    const acct = env.platform.accounts.get(account)!;
    expect(acct.writes("/v1/prices").every((c) => c.auth === `Bearer ${FAKE_PLATFORM_TEST_KEY}`)).toBe(true);
    expect((await env.api("GET", `${P()}/web`)).body.providers.find((p: any) => p.id === CONN_APP_ID).mode).toBe("test");
  });
});
