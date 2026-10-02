import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { FAKE_GALAXY_ACCOUNT } from "../../../packages/contract/src/fake-galaxy.js";
import { flushStoreForwards } from "../src/stores/forward.js";
import { secretKeyFrom, unseal } from "../src/services/secrets.js";
import { tick } from "../src/services/tick.js";
import { TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";
import { at, env, eventTypes, type Env } from "./stores3-helpers.js";

let e: Env;
beforeEach(async () => { e = await env("galaxy"); });
afterEach(async () => { await e?.h.close(); });

const info = async (user: string) => CustomerInfoSchema.parse(await (await e.call(`/v1/subscribers/${encodeURIComponent(user)}`, { key: e.key })).json());
const move = (days: number) => e.h.setNow(at(days));
const expire = () => tick(e.h.db, e.h.now(), (async () => new Response("{}")) as unknown as typeof fetch);
const sub = async (key: string) => (await e.h.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.store, "galaxy"), eq(schema.subscriptions.storeKey, key))))[0]!;
async function notify(claims: Array<Record<string, any>>, o: Parameters<Env["galaxy"]["sign"]>[1] = {}) {
  const out: Response[] = [];
  for (const c of claims) out.push(await e.notify((await e.galaxy.sign(c, o)).body));
  return out;
}

/** The Android SDK built with purchases-store-galaxy: X-Platform android, the galx_ key, fetch_token = Samsung's purchaseId. */
function post(purchaseId: string, productId: string, extra: Record<string, unknown> = {}, user = "galaxy_user") {
  return e.receipt({ fetch_token: purchaseId, product_ids: [productId], platform_product_ids: [{ product_id: productId }], app_user_id: user, is_restore: false, observer_mode: false, price: 4.99, currency: "USD", ...extra });
}
async function subscribed(o: Parameters<Env["galaxy"]["subscribe"]>[1] = {}, item = "premium_monthly") {
  const s = e.galaxy.subscribe(item, o);
  const res = await post(s.purchaseId, item, { normal_duration: "P1M" });
  expect(res.status).toBe(200);
  return { first: s.purchaseId, res };
}

describe("Samsung server notifications", () => {
  it("verifies the IAP signature, the issuer and the package; refuses forged or foreign ones", async () => {
    const { first } = await subscribed();
    const n = e.galaxy.unsubscribe(first)[0]!;
    const otherKey = (await new (await import("../../../packages/contract/src/fake-galaxy.js")).FakeGalaxy().keys()).iapPrivateKey;
    expect((await notify([n], { key: otherKey }))[0]!.status).toBe(400);
    expect((await notify([n], { issuer: "someone.example.com" }))[0]!.status).toBe(400);
    expect((await notify([n], { audience: ["com.other.app"] }))[0]!.status).toBe(400);
    expect((await e.notify("{\"not\":\"a jwt\"}")).status).toBe(400);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
    const ok = await notify([n]);
    expect(await ok[0]!.json()).toEqual({ status: "processed", verified: true });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION"]);
  });

  it("without the IAP public key a notification is only a trigger: the purchase is re-read and a claimed refund needs Samsung's word", async () => {
    await e.setCredentials({ galaxy_service_account_id: FAKE_GALAXY_ACCOUNT, galaxy_service_account_private_key: (await e.galaxy.keys()).serviceAccountPrivateKey });
    const { first } = await subscribed();
    const s = e.galaxy.sub(first);
    // A refund that never happened, signed with any key: nothing changes.
    const fake = e.galaxy.n("ARS_REFUNDED", { firstOrderId: s.latestOrderId, firstPurchaseId: first, refundedOrderId: s.latestOrderId, refundedPurchaseId: first, refundedPurchaseDate: 1 });
    const otherKey = (await new (await import("../../../packages/contract/src/fake-galaxy.js")).FakeGalaxy().keys()).iapPrivateKey;
    expect(await (await notify([fake], { key: otherKey }))[0]!.json()).toMatchObject({ verified: false });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
    // A real one: Samsung's receipt shows the cancel.
    move(3);
    await notify(e.galaxy.refund(first), { key: otherKey });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION"]);
  });

  it("the TEST notification proves the URL; redeliveries count once; bodies are forwarded", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/galaxy" }).where(eq(schema.apps.id, e.appId));
    const t = await e.galaxy.sign(e.galaxy.test()[0]!);
    expect((await e.notify(t.body)).status).toBe(200);
    expect(await (await e.notify(t.body)).json()).toEqual({ status: "duplicate" });
    await flushStoreForwards();
    expect(e.forwarded.map((f) => f.body)).toEqual([t.body]);
    const st = await (await e.v2("GET", `/apps/${e.appId}/store_settings`)).json();
    expect(st).toMatchObject({ notification_url: `http://localhost/v1/notifications/galaxy/${e.appId}`, notification_status: "ready", galaxy: { package_name: e.galaxy.packageName, service_account_id: FAKE_GALAXY_ACCOUNT, iap_public_key_configured: true } });
  });
});

describe("POST /v1/receipts from the Galaxy SDK", () => {
  it("records a subscription from the receipt and subscription APIs, keyed by the first purchase id", async () => {
    const { first, res } = await subscribed();
    const ci = CustomerInfoSchema.parse(await res.json());
    const order = e.galaxy.sub(first).latestOrderId;
    expect(ci.subscriber.subscriptions.premium_monthly).toMatchObject({ store: "galaxy", is_sandbox: false, period_type: "normal", store_transaction_id: order, expires_date: "2026-10-01T12:00:00Z" });
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ store: "GALAXY", price: 4.99, currency: "USD", country_code: "US", environment: "PRODUCTION", transaction_id: order, original_transaction_id: first, commission_percentage: 0.3 });
    expect(e.galaxy.calls.some((c) => c.url === `https://iap.samsungapps.com/iap/v6/receipt?purchaseID=${first}`)).toBe(true);
    expect(e.galaxy.calls.some((c) => c.url.endsWith(`/iap/seller/v6/applications/${e.galaxy.packageName}/purchases/subscriptions/${first}`))).toBe(true);
  });

  it("test mode is sandbox; free trials and tiered prices", async () => {
    const t = await subscribed({ test: true, trialDays: 7 });
    expect(CustomerInfoSchema.parse(await t.res.json()).subscriber.subscriptions.premium_monthly).toMatchObject({ is_sandbox: true, period_type: "trial", expires_date: "2026-09-08T12:00:00Z" });
    const i = await subscribed({ intro: true }, "premium_yearly");
    expect(CustomerInfoSchema.parse(await i.res.json()).subscriber.subscriptions.premium_yearly!.period_type).toBe("intro");
    expect((await e.events("INITIAL_PURCHASE")).map((x) => [x.period_type, x.environment])).toEqual([["TRIAL", "SANDBOX"], ["INTRO", "PRODUCTION"]]);
  });

  it("items: a consumable the SDK is told to consume, a lifetime unlock, an item refunded before it was posted", async () => {
    const coins = e.galaxy.buyItem("coins_100");
    expect((await (await post(coins.purchaseId, "coins_100")).json()).purchased_products).toEqual({ coins_100: { should_consume: true } });
    const life = e.galaxy.buyItem("lifetime", { amount: 19.99 });
    const r = await post(life.purchaseId, "lifetime");
    expect(CustomerInfoSchema.parse(await r.json()).subscriber.entitlements.pro!.expires_date).toBeNull();
    const gone = e.galaxy.buyItem("lifetime");
    e.galaxy.refundItem(gone.purchaseId);
    await post(gone.purchaseId, "lifetime", {}, "other_user");
    expect(await eventTypes(e)).toEqual(["NON_RENEWING_PURCHASE", "NON_RENEWING_PURCHASE", "NON_RENEWING_PURCHASE", "CANCELLATION"]);
  });

  it("answers 400 for unknown purchases and other packages, 500 without or with a rejected service account, 503 when Samsung is down", async () => {
    const code = async (r: Response) => [r.status, (await r.json()).code];
    expect(await code(await post("0123456789abcdef0123456789abcdef", "premium_monthly"))).toEqual([400, 7103]);
    expect(await code(await post("bad id!", "premium_monthly"))).toEqual([400, 7103]);
    const s = e.galaxy.subscribe("premium_monthly");
    e.galaxy.receipts.get(s.purchaseId)!.packageName = "com.other.app";
    expect(await code(await post(s.purchaseId, "premium_monthly"))).toEqual([400, 7103]);
    e.galaxy.receipts.get(s.purchaseId)!.packageName = e.galaxy.packageName;
    e.galaxy.outage = 503;
    expect(await code(await post(s.purchaseId, "premium_monthly"))).toEqual([503, 7101]);
    e.galaxy.outage = null;
    await e.setCredentials({ galaxy_service_account_id: "someone-else", galaxy_service_account_private_key: (await e.galaxy.keys()).serviceAccountPrivateKey });
    expect(await code(await post(s.purchaseId, "premium_monthly"))).toEqual([500, 7101]);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(app!.credentialsStatus).toBe("failing");
    await e.setCredentials({});
    expect(await code(await post(s.purchaseId, "premium_monthly"))).toEqual([500, 7101]);
    // Items need no service account.
    const coins = e.galaxy.buyItem("coins_100");
    expect((await post(coins.purchaseId, "coins_100")).status).toBe(200);
  });
});

describe("Galaxy lifecycle through notifications", () => {
  it("renewal, unsubscribe, resubscribe, grace and lapse", async () => {
    const { first } = await subscribed();
    move(30);
    const r = e.galaxy.renew(first);
    await notify(r.notifications);
    expect((await e.events("RENEWAL"))[0]).toMatchObject({ transaction_id: e.galaxy.sub(first).latestOrderId, original_transaction_id: first });
    move(35);
    await notify(e.galaxy.unsubscribe(first));
    move(36);
    await notify(e.galaxy.resubscribe(first));
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION"]);
    move(61.5);
    await notify(e.galaxy.grace(first, 7));
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION", "BILLING_ISSUE"]);
    expect((await info("galaxy_user")).subscriber.entitlements.pro!.expires_date).toBe("2026-11-08T12:00:00Z");
    move(69);
    await notify(e.galaxy.lapse(first));
    await expire();
    expect((await eventTypes(e)).slice(5)).toEqual(["CANCELLATION", "EXPIRATION"]);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "BILLING_ERROR" });
  });

  it("a refund ends access; an item refund; a price increase consent", async () => {
    const { first } = await subscribed();
    move(2);
    await notify(e.galaxy.priceChangeAgreed(first));
    move(3);
    await notify(e.galaxy.refund(first));
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "PRICE_INCREASE_CONSENT_APPROVED", "CANCELLATION"]);
    expect((await e.events("CANCELLATION"))[0]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT", price: -4.99 });
    expect((await sub(first)).refundedAt).toEqual(at(3));
    const life = e.galaxy.buyItem("lifetime");
    await post(life.purchaseId, "lifetime");
    move(4);
    await notify(e.galaxy.refundItem(life.purchaseId));
    expect((await eventTypes(e)).slice(-2)).toEqual(["NON_RENEWING_PURCHASE", "CANCELLATION"]);
  });

  it("a plan change: PRODUCT_CHANGE on the old subscription, which ends now; the new one belongs to the same customer", async () => {
    const { first } = await subscribed();
    move(10);
    const up = e.galaxy.upDowngrade(first, "premium_yearly", { amount: 49.99 });
    await notify(up.notifications);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "PRODUCT_CHANGE", "EXPIRATION", "INITIAL_PURCHASE"]);
    const evs = await e.events("INITIAL_PURCHASE");
    expect(evs[1]).toMatchObject({ product_id: "premium_yearly", app_user_id: "galaxy_user", price: 49.99 });
    expect((await e.events("PRODUCT_CHANGE"))[0]).toMatchObject({ product_id: "premium_monthly", new_product_id: "premium_yearly" });
    expect((await info("galaxy_user")).subscriber.entitlements.pro!.product_identifier).toBe("premium_yearly");
  });

  it("unknown purchases are ignored unless tracked", async () => {
    const s = e.galaxy.subscribe("premium_monthly");
    expect(await (await notify(s.notifications))[0]!.json()).toMatchObject({ status: "unknown_purchase" });
    const keys = await e.galaxy.keys();
    await e.setCredentials({ galaxy_service_account_id: FAKE_GALAXY_ACCOUNT, galaxy_service_account_private_key: keys.serviceAccountPrivateKey, galaxy_iap_public_key: keys.iapPublicKey, track_new_purchases: true });
    move(1);
    const t = e.galaxy.subscribe("premium_monthly");
    await notify(t.notifications);
    expect((await e.events("INITIAL_PURCHASE"))[0]!.app_user_id).toMatch(/^\$RCAnonymousID:/);
  });
});

describe("Galaxy apps through REST v2", () => {
  it("creates a Galaxy app (a RevenueDot extension) with a galx_ key and the private key sealed", async () => {
    const keys = await e.galaxy.keys();
    const res = await e.v2("POST", "/apps", { name: "Galaxy", type: "galaxy", galaxy: { package_name: "com.example.new", galaxy_service_account_id: FAKE_GALAXY_ACCOUNT, galaxy_service_account_private_key: keys.serviceAccountPrivateKey } });
    expect(res.status).toBe(201);
    const app = await res.json();
    expect(app.galaxy).toEqual({ package_name: "com.example.new" });
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    expect(row!.credentials).toEqual({ galaxy_service_account_id: FAKE_GALAXY_ACCOUNT });
    expect(await unseal(row!.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ galaxy_service_account_private_key: keys.serviceAccountPrivateKey.trim() });
    expect(row!.publicKey).toMatch(/^galx_/);
    expect((await e.v2("POST", "/apps", { name: "x", type: "galaxy", galaxy: {} })).status).toBe(400);
    expect((await e.v2("POST", "/apps", { name: "x", type: "galaxy", galaxy: { package_name: "com.x.y", galaxy_service_account_private_key: "not a key" } })).status).toBe(400);
  });

  it("verify_credentials: valid, no permission, a rejected key, Samsung down", async () => {
    const check = async (galaxy?: Record<string, unknown>) => (await e.v2("POST", `/apps/${e.appId}/actions/verify_credentials`, galaxy ? { galaxy } : {})).json();
    expect(await check()).toMatchObject({ status: "valid", service_account_id: FAKE_GALAXY_ACCOUNT });
    e.galaxy.noPermission.add(FAKE_GALAXY_ACCOUNT);
    expect(await check()).toMatchObject({ status: "invalid", message: expect.stringMatching(/GSS scope/) });
    e.galaxy.noPermission.clear();
    const other = (await new (await import("../../../packages/contract/src/fake-galaxy.js")).FakeGalaxy().keys()).serviceAccountPrivateKey;
    expect(await check({ galaxy_service_account_private_key: other })).toMatchObject({ status: "invalid", message: expect.stringMatching(/rejected the service account/) });
    e.galaxy.outage = 503;
    expect(await check()).toMatchObject({ status: "unreachable" });
  });

  it("imports in-app items and says subscriptions must be added by hand", async () => {
    e.galaxy.item("coins_500", "500 coins", 3.99);
    e.galaxy.item("coins_100", "100 coins", 0.99);
    const list = await (await e.v2("GET", `/apps/${e.appId}/store_products`)).json();
    expect(list.warnings[0]).toMatch(/in-app items only/);
    expect(list.items.map((i: Record<string, unknown>) => [i.store_identifier, i.type, i.in_catalog])).toEqual([["coins_500", "consumable", false], ["coins_100", "consumable", true]]);
    const imp = await (await e.v2("POST", `/apps/${e.appId}/store_products/actions/import`, { store_identifiers: ["coins_500"] })).json();
    expect(imp.created[0]).toMatchObject({ store_identifier: "coins_500", type: "consumable" });
  });

  it("refunds and cancels through Samsung (RevenueCat's Play Store or Galaxy refund), and the management link", async () => {
    const { first } = await subscribed();
    const row = await sub(first);
    expect((await (await e.v2("GET", `/subscriptions/${row.id}/authenticated_management_url`)).json()).management_url).toBe("samsungapps://SubscriptionList/");
    move(1);
    const c = await e.v2("POST", `/subscriptions/${row.id}/actions/cancel`);
    expect(c.status).toBe(200);
    expect(e.galaxy.actions).toEqual([{ purchaseId: first, action: "cancel" }]);
    move(2);
    const r = await e.v2("POST", `/subscriptions/${row.id}/transactions/${row.storeTransactionId}/actions/refund`);
    expect(r.status).toBe(200);
    expect(e.galaxy.actions.at(-1)).toEqual({ purchaseId: first, action: "refund" });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "CANCELLATION"]);
    expect((await e.events("CANCELLATION"))[1]).toMatchObject({ cancel_reason: "CUSTOMER_SUPPORT" });
    expect((await e.v2("POST", `/subscriptions/${row.id}/transactions/S20260101USA0000001/actions/refund`)).status).toBe(404);
  });
});
