// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: journey (stores3), Paddle, Roku and the Samsung Galaxy Store (prd/stores-paddle-roku-galaxy/PRD.md) on the real
// Node server and its own Railway development database. The three stores are the stateful fakes in packages/contract/src
// (fake-paddle.ts, fake-roku.ts, fake-galaxy.ts), answering on the capture server for api.paddle.com, sandbox-api.paddle.com,
// apipub.roku.com, assets.cs.roku.com, iap.samsungapps.com and devapi.samsungapps.com; no store is ever called.
//   - A developer signs up and sets up one app per store through v2 the way the dashboard does: sealed credentials, the
//     live credential checks (bad and good), Apply in Paddle, Import products.
//   - Purchases arrive the way each SDK or backend sends them (Paddle from a backend, the Roku SDK's headers and body, the
//     Galaxy SDK's X-Platform android with a galx_ key), then every lifecycle notification each store sends, signed.
//   - Every state is checked through the SDK's customer info, v2, direct SQL (subscriptions, transactions, events,
//     store_notifications), the developer's webhook endpoint (signed deliveries), and the charts' store segment.
// Docs: https://revenuedot.app/docs/guides
import { createHmac } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Journey } from "./run.ts";
import { until } from "./lib/check.ts";
import { type Ctx, signUp } from "./lib/context.ts";
import type { Captured } from "./lib/stack.ts";
import { FAKE_PADDLE_KEY, FAKE_PADDLE_LIMITED_KEY, FakePaddleAccount } from "../../../packages/contract/src/fake-paddle.ts";
import { FAKE_ROKU_KEY, FakeRoku } from "../../../packages/contract/src/fake-roku.ts";
import { FAKE_GALAXY_ACCOUNT, FakeGalaxy } from "../../../packages/contract/src/fake-galaxy.ts";

const HOOK_HOST = "hooks.stores3.journeys.test";
const STORE_HOSTS = new Set(["api.paddle.com", "sandbox-api.paddle.com", "apipub.roku.com", "assets.cs.roku.com", "iap.samsungapps.com", "devapi.samsungapps.com"]);

const journey: Journey = {
  name: "stores3",
  title: "Paddle, Roku and Galaxy Store: setup, SDK purchases, every lifecycle notification, webhooks out and charts",
  async run(ctx: Ctx) {
    const { c } = ctx;
    const paddle = new FakePaddleAccount();
    const roku = new FakeRoku();
    const galaxy = new FakeGalaxy();
    const gkeys = await galaxy.keys();
    ctx.capture.handlers.unshift(async (cap: Captured, res: ServerResponse) => {
      if (!STORE_HOSTS.has(cap.host)) return false;
      const url = `https://${cap.host}${cap.path}${cap.query}`;
      const fake = cap.host.includes("paddle") ? paddle : cap.host.includes("roku") ? roku : galaxy;
      const r = await fake.fetch(url, { method: cap.method, headers: cap.headers, body: ["GET", "HEAD"].includes(cap.method) ? undefined : cap.body });
      res.statusCode = r.status;
      res.setHeader("content-type", r.headers.get("content-type") ?? "application/json");
      res.end(await r.text());
      return true;
    });

    const dev = await signUp(ctx, "stores3", "TV and web");
    const P = `/v2/projects/${dev.projectId}`;
    const hook = await dev.v2("POST", "/integrations/webhooks", { name: "Backend", url: `https://${HOOK_HOST}/rd` });
    const hookSecret = hook.signing_secret as string;
    const pro = await dev.v2("POST", "/entitlements", { lookup_key: "pro", display_name: "Pro" });
    const product = async (appId: string, store_identifier: string, type: string, duration?: string) => {
      const p = await dev.v2("POST", "/products", { store_identifier, app_id: appId, type, display_name: store_identifier, ...(duration ? { subscription: { duration } } : {}) });
      if (type !== "consumable") await dev.v2("POST", `/entitlements/${pro.id}/actions/attach_products`, { product_ids: [p.id] });
      return p;
    };
    const keyOf = async (appId: string) => (await dev.v2("GET", `/apps/${appId}/public_api_keys`)).items[0].key as string;
    const send = async (path: string, key: string, body: unknown, headers: Record<string, string>) => {
      const r = await fetch(`${ctx.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const t = await r.text();
      let j: any = t; try { j = JSON.parse(t); } catch { /* text */ }
      return { status: r.status, body: j };
    };
    const ci = async (key: string, user: string) => (await fetch(`${ctx.base}/v1/subscribers/${encodeURIComponent(user)}`, { headers: { authorization: `Bearer ${key}` } })).json() as Promise<any>;
    const eventsOf = async (store: string) => (await ctx.sql<{ type: string; payload: any }[]>`SELECT type, payload FROM events WHERE project_id = ${dev.projectId} AND payload->'event'->>'store' = ${store} ORDER BY event_timestamp_ms, created_at`).map((r) => r.payload.event);
    const typesOf = async (store: string) => (await eventsOf(store)).map((e: any) => e.type);
    const post = async (store: string, appId: string, body: string, headers: Record<string, string>) => {
      const r = await fetch(`${ctx.base}/v1/notifications/${store}/${appId}`, { method: "POST", headers, body });
      return { status: r.status, text: await r.text() };
    };

    // ------------------------------------------------------------------------------------------------------- Paddle
    c.begin("Paddle: setup through v2");
    const pdlProduct = paddle.product({ name: "Scanner Pro" });
    const monthly = paddle.price({ product: pdlProduct.id, amount: 999, interval: "month", name: "Monthly" });
    const annual = paddle.price({ product: pdlProduct.id, amount: 7999, interval: "year", name: "Annual" });
    const life = paddle.price({ product: paddle.product({ name: "Lifetime" }).id, amount: 4999, interval: null });
    const bad = await dev.v2r("POST", "/apps", { name: "x", type: "paddle", paddle: { paddle_api_key: "test_0123456789abcdef" } });
    c.eq("a client-side token is refused (400)", bad.status, 400);
    const pdlApp = await dev.v2("POST", "/apps", { name: "Scanner Web", type: "paddle", paddle: { paddle_api_key: FAKE_PADDLE_KEY } });
    c.eq("the app shape never returns the key", pdlApp.paddle, { paddle_is_sandbox: true, paddle_api_key: null });
    const [sealed] = await ctx.sql`SELECT credentials, secrets FROM apps WHERE id = ${pdlApp.id}`;
    c.check("SQL: the key is sealed, not in credentials", !JSON.stringify(sealed!.credentials).includes(FAKE_PADDLE_KEY) && !String(sealed!.secrets).includes(FAKE_PADDLE_KEY));
    c.eq("live check with a key that may not read subscriptions", (await dev.v2("POST", `/apps/${pdlApp.id}/actions/verify_credentials`, { paddle: { paddle_api_key: FAKE_PADDLE_LIMITED_KEY } })).status, "invalid");
    c.eq("live check with the saved key", (await dev.v2("POST", `/apps/${pdlApp.id}/actions/verify_credentials`, {})).status, "valid");
    const applied = await dev.v2("POST", `/apps/${pdlApp.id}/actions/apply_notification_settings`, {});
    c.check("Apply in Paddle created a destination pointing at this server", paddle.notificationSettings.get(applied.notification_setting_id)?.destination === `${ctx.base}/v1/notifications/paddle/${pdlApp.id}`, applied);
    const imported = await dev.v2("POST", `/apps/${pdlApp.id}/store_products/actions/import`, { store_identifiers: [monthly.id, annual.id, life.id], entitlement_ids: [pro.id] });
    c.eq("Import products created the three prices", imported.created.map((p: any) => p.store_identifier).sort(), [monthly.id, annual.id, life.id].sort());
    const pdlKey = await keyOf(pdlApp.id);
    const pdlDeliver = async (events: Array<Record<string, any>>, o: { secret?: string } = {}) => {
      const out: number[] = [];
      for (const ev of events) { const w = await paddle.sign(ev, o); out.push((await post("paddle", pdlApp.id, w.body, { "content-type": "application/json", "paddle-signature": w.signature })).status); }
      return out;
    };

    c.begin("Paddle: purchases and every lifecycle notification");
    const pUser = `pdl_${ctx.stamp}`;
    const buy = paddle.buy(monthly.id, { customData: { app_user_id: pUser } });
    const rcpt = await send("/v1/receipts", pdlKey, { app_user_id: pUser, fetch_token: buy.transaction.id }, { "x-platform": "paddle" });
    c.eq("POST /v1/receipts with the txn_ id", rcpt.status, 200);
    c.check("customer info: pro from Paddle, sandbox", rcpt.body?.subscriber?.entitlements?.pro?.product_identifier === monthly.id && rcpt.body.subscriber.subscriptions[monthly.id]?.store === "paddle" && rcpt.body.subscriber.subscriptions[monthly.id]?.is_sandbox === true, rcpt.body?.subscriber);
    c.eq("forged signature: 400", await pdlDeliver(buy.events.slice(0, 1), { secret: "pdl_ntfset_forged" }), [400]);
    c.eq("the purchase's own events: 200", await pdlDeliver(buy.events), [200, 200, 200]);
    const sub = buy.subscription!.id;
    await pdlDeliver(paddle.renew(sub).events);
    const failed = paddle.renew(sub, { fail: true });
    await pdlDeliver(failed.events);
    await pdlDeliver(paddle.recover(sub).events);
    await pdlDeliver(paddle.scheduleCancel(sub));
    await pdlDeliver(paddle.unscheduleChange(sub));
    await pdlDeliver(paddle.changePlan(sub, annual.id).events);
    await pdlDeliver(paddle.refund(failed.transaction.id).events);
    c.eq("events: initial, renewal, billing issue, renewal, cancellation, uncancellation, product change, refund", await typesOf("PADDLE"),
      ["INITIAL_PURCHASE", "RENEWAL", "BILLING_ISSUE", "RENEWAL", "CANCELLATION", "UNCANCELLATION", "PRODUCT_CHANGE", "CANCELLATION"]);
    const [pRow] = await ctx.sql`SELECT product_identifier, refunded_at, store_transaction_id FROM subscriptions WHERE project_id = ${dev.projectId} AND store = 'paddle'`;
    c.check("SQL: the chain is on the annual price and refunded", pRow?.product_identifier === annual.id && !!pRow?.refunded_at && pRow.store_transaction_id === failed.transaction.id, pRow);
    const lifeBuy = paddle.buy(life.id);
    await send("/v1/receipts", pdlKey, { app_user_id: pUser, fetch_token: lifeBuy.transaction.id }, { "x-platform": "paddle" });
    c.check("a one-time purchase restores pro (lifetime)", (await ci(pdlKey, pUser)).subscriber.entitlements.pro.expires_date === null);
    const [notifRows] = await ctx.sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE error IS NOT NULL)::int AS bad FROM store_notifications WHERE app_id = ${pdlApp.id}`;
    c.check("SQL: every notification stored once, only the forged one with an error", notifRows!.n >= 12 && notifRows!.bad === 1, notifRows);
    const st = await dev.v2("GET", `/apps/${pdlApp.id}/store_settings`);
    c.eq("store_settings: notifications ready", st.notification_status, "ready");

    // --------------------------------------------------------------------------------------------------------- Roku
    c.begin("Roku: setup, the Roku SDK's purchase and Roku's signed pushes");
    const rokuApp = await dev.v2("POST", "/apps", { name: "Scanner TV", type: "roku", roku: { roku_api_key: FAKE_ROKU_KEY, roku_channel_id: roku.channelId, roku_channel_name: roku.channelName } });
    c.eq("v2 shape: channel id and name, no key", rokuApp.roku, { roku_channel_id: roku.channelId, roku_channel_name: roku.channelName });
    c.eq("live check: a wrong key", (await dev.v2("POST", `/apps/${rokuApp.id}/actions/verify_credentials`, { roku: { roku_api_key: "WRONGKEY0123456789ABCDEF012345678" } })).status, "invalid");
    c.eq("live check: the saved key", (await dev.v2("POST", `/apps/${rokuApp.id}/actions/verify_credentials`, {})).status, "valid");
    await product(rokuApp.id, "scanner_monthly", "subscription", "P1M");
    await product(rokuApp.id, "scanner_yearly", "subscription", "P1Y");
    const rokuKey = await keyOf(rokuApp.id);
    const rUser = `$RCAnonymousID:${crypto.randomUUID().replace(/-/g, "")}`;
    const rb = roku.buy("scanner_monthly", { price: 4.99 });
    const tx = rb.transaction.transactionId as string;
    const dashed = `${tx.slice(0, 8)}-${tx.slice(8, 12)}-${tx.slice(12, 16)}-${tx.slice(16, 20)}-${tx.slice(20)}`;
    // The Roku SDK's own request (purchases-roku source/Purchases.brs): raw anonymous id, formatted price, no currency.
    const rr = await send("/v1/receipts", rokuKey, { fetch_token: dashed, app_user_id: rUser, product_id: "scanner_monthly", price: "$4.99", intro_duration: null, trial_duration: null, introductory_price: null, presented_offering_identifier: null, presented_placement_identifier: null, applied_targeting_rule: null },
      { "x-platform": "roku", "x-platform-flavor": "native", "x-version": "0.0.2", "x-client-bundle-id": "dev", "x-is-sandbox": "false" });
    c.eq("POST /v1/receipts from the Roku SDK", rr.status, 200);
    c.check("customer info: production Roku subscription, price from Roku", rr.body?.subscriber?.subscriptions?.scanner_monthly?.store === "roku" && rr.body.subscriber.subscriptions.scanner_monthly.is_sandbox === false, rr.body?.subscriber);
    const rokuPush = async (messages: Array<Record<string, any>>, o: Parameters<FakeRoku["sign"]>[1] = {}) => {
      const out: Array<{ status: number; text: string }> = [];
      for (const m of messages) out.push(await post("roku", rokuApp.id, (await roku.sign(m, o)).body, { "content-type": "text/plain" }));
      return out;
    };
    c.eq("a forged push: 400", (await rokuPush(rb.pushes, { forged: true }))[0]!.status, 400);
    const first = await rokuPush(rb.pushes);
    c.eq("Roku's push is answered 200 with its responseKey", first[0], { status: 200, text: rb.pushes[0]!.responseKey });
    await rokuPush(roku.renew(tx).pushes);
    await rokuPush(roku.cancel(tx));
    await rokuPush(roku.resubscribe(tx));
    const up = roku.upgrade(tx, "scanner_yearly", 49.99);
    await rokuPush(up.pushes);
    c.eq("events: initial, renewal, cancellation, uncancellation, upgrade (new chain, old cancelled and expired)", await typesOf("ROKU"),
      ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION", "INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]);
    c.check("the upgrade belongs to the same customer", (await ci(rokuKey, rUser)).subscriber.entitlements.pro.product_identifier === "scanner_yearly");
    await rokuPush(roku.refund(up.transaction.transactionId));
    c.eq("a refund: CANCELLATION (CUSTOMER_SUPPORT)", (await eventsOf("ROKU")).at(-1)?.cancel_reason, "CUSTOMER_SUPPORT");

    // ------------------------------------------------------------------------------------------------------- Galaxy
    c.begin("Galaxy Store: setup, the Galaxy SDK's purchases and Samsung's notifications");
    const gx = await dev.v2("POST", "/apps", { name: "Scanner Galaxy", type: "galaxy", galaxy: { package_name: galaxy.packageName, galaxy_service_account_id: FAKE_GALAXY_ACCOUNT, galaxy_service_account_private_key: gkeys.serviceAccountPrivateKey, galaxy_iap_public_key: gkeys.iapPublicKey } });
    c.eq("v2 shape (RevenueDot extension)", gx.galaxy, { package_name: galaxy.packageName });
    c.eq("live check: the service account", (await dev.v2("POST", `/apps/${gx.id}/actions/verify_credentials`, {})).status, "valid");
    await product(gx.id, "premium_monthly", "subscription", "P1M");
    await product(gx.id, "premium_yearly", "subscription", "P1Y");
    await product(gx.id, "coins_100", "consumable");
    const gxKey = await keyOf(gx.id);
    c.check("the public key has the galx_ prefix the SDK requires", /^galx_/.test(gxKey), gxKey);
    const gxPush = async (claims: Array<Record<string, any>>, o: Parameters<FakeGalaxy["sign"]>[1] = {}) => {
      const out: number[] = [];
      for (const n of claims) out.push((await post("galaxy", gx.id, (await galaxy.sign(n, o)).body, { "content-type": "text/plain" })).status);
      return out;
    };
    c.eq("Samsung's TEST notification", await gxPush(galaxy.test()), [200]);
    const gUser = `gx_${ctx.stamp}`;
    const gs = galaxy.subscribe("premium_monthly", { amount: 4.99 });
    const androidHeaders = { "x-platform": "android", "x-platform-flavor": "native", "x-version": "10.24.0" };
    const gr = await send("/v1/receipts", gxKey, { fetch_token: gs.purchaseId, product_ids: ["premium_monthly"], platform_product_ids: [{ product_id: "premium_monthly" }], app_user_id: gUser, is_restore: false, observer_mode: false, price: 4.99, currency: "USD", normal_duration: "P1M" }, androidHeaders);
    c.check("POST /v1/receipts from the Galaxy SDK: a production Galaxy subscription", gr.status === 200 && gr.body.subscriber.subscriptions.premium_monthly?.store === "galaxy" && gr.body.subscriber.subscriptions.premium_monthly.is_sandbox === false, gr.body);
    const coins = galaxy.buyItem("coins_100");
    const cr = await send("/v1/receipts", gxKey, { fetch_token: coins.purchaseId, product_ids: ["coins_100"], app_user_id: gUser, price: 0.99, currency: "USD" }, androidHeaders);
    c.eq("the SDK is told to consume the consumable", cr.body?.purchased_products, { coins_100: { should_consume: true } });
    const otherKey = (await new FakeGalaxy().keys()).iapPrivateKey;
    c.eq("a notification signed with another key: 400", await gxPush(galaxy.unsubscribe(gs.purchaseId), { key: otherKey }), [400]);
    await gxPush(galaxy.renew(gs.purchaseId).notifications);
    await gxPush(galaxy.unsubscribe(gs.purchaseId));
    await gxPush(galaxy.resubscribe(gs.purchaseId));
    await gxPush(galaxy.grace(gs.purchaseId, 7));
    await gxPush(galaxy.renew(gs.purchaseId, "ARS_OUT_GRACE_PERIOD").notifications);
    const change = galaxy.upDowngrade(gs.purchaseId, "premium_yearly", { amount: 49.99 });
    await gxPush(change.notifications);
    c.eq("events: initial, renewal, cancellation, uncancellation, billing issue, renewal, product change", (await typesOf("GALAXY")).filter((t: string) => t !== "NON_RENEWING_PURCHASE"),
      ["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION", "BILLING_ISSUE", "RENEWAL", "PRODUCT_CHANGE", "EXPIRATION", "INITIAL_PURCHASE"]);
    const refundRow = await ctx.sql`SELECT id, store_transaction_id FROM subscriptions WHERE project_id = ${dev.projectId} AND store = 'galaxy' AND product_identifier = 'premium_yearly'`;
    const refund = await dev.v2r("POST", `/subscriptions/${refundRow[0]!.id}/transactions/${refundRow[0]!.store_transaction_id}/actions/refund`);
    c.eq("v2 refund of a Galaxy transaction goes through Samsung", [refund.status, galaxy.actions.at(-1)?.action], [200, "refund"]);
    c.eq("and is recorded as CUSTOMER_SUPPORT", (await eventsOf("GALAXY")).at(-1)?.cancel_reason, "CUSTOMER_SUPPORT");

    // ------------------------------------------------------------------------------------------------ Webhooks, charts
    c.begin("Webhooks out and charts");
    const delivered = await until(async () => {
      const got = ctx.capture.of(HOOK_HOST, "/rd").map((r) => JSON.parse(r.body).event?.store);
      return ["PADDLE", "ROKU", "GALAXY"].every((s) => got.includes(s)) ? got : null;
    }, { timeoutMs: 90_000 }).catch(() => null);
    c.check("the developer's webhook received PADDLE, ROKU and GALAXY events", !!delivered, ctx.capture.of(HOOK_HOST, "/rd").length);
    const one = ctx.capture.of(HOOK_HOST, "/rd").find((r) => /"GALAXY"/.test(r.body));
    if (one) {
      const sig = one.headers["x-revenuecat-webhook-signature"] ?? "";
      const t = /t=(\d+)/.exec(sig)?.[1];
      const v1 = /v1=([0-9a-f]+)/.exec(sig)?.[1];
      c.check("deliveries are signed with the webhook's secret", !!t && v1 === createHmac("sha256", hookSecret).update(`${t}.${one.body}`).digest("hex"), sig);
      c.eq("a Galaxy delivery reports the store's commission", JSON.parse(one.body).event.commission_percentage, 0.3);
    }
    const rev = await dev.v2("GET", `/charts/revenue?segment=store&environment=sandbox&resolution=day`);
    const prodRev = await dev.v2("GET", `/charts/revenue?segment=store&resolution=day`);
    const names = (x: any) => (x.segments ?? []).map((s: any) => s.display_name);
    c.check("sandbox revenue chart, segmented by store, has Paddle", names(rev).includes("Paddle"), names(rev));
    c.check("production revenue chart has Roku and Galaxy Store", names(prodRev).includes("Roku") && names(prodRev).includes("Galaxy Store"), names(prodRev));
    const reached = ctx.server.outbound().filter((o) => STORE_HOSTS.has(o.host) && !String(o.routed).startsWith("http://127.0.0.1"));
    c.eq("no store host was called for real (every call went to the capture server)", reached, []);
    void P;
  },
};

export default journey;
