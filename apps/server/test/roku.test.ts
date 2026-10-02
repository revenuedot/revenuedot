import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { CustomerInfoSchema } from "../../../packages/contract/src/sdk-schemas.js";
import { FAKE_ROKU_KEY } from "../../../packages/contract/src/fake-roku.js";
import { flushStoreForwards } from "../src/stores/forward.js";
import { secretKeyFrom, unseal } from "../src/services/secrets.js";
import { tick } from "../src/services/tick.js";
import { sealedColumns, TEST_ENCRYPTION_KEY } from "./store-secret-helpers.js";
import { at, env, eventTypes, T0, type Env } from "./stores3-helpers.js";

let e: Env;
beforeEach(async () => { e = await env("roku"); });
afterEach(async () => { await e?.h.close(); });

const dashed = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
const info = async (user: string) => CustomerInfoSchema.parse(await (await e.call(`/v1/subscribers/${encodeURIComponent(user)}`, { key: e.key })).json());
const move = (days: number) => e.h.setNow(at(days));
const expire = () => tick(e.h.db, e.h.now(), (async () => new Response("{}")) as unknown as typeof fetch);
const sub = async (key: string) => (await e.h.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.store, "roku"), eq(schema.subscriptions.storeKey, key))))[0]!;
async function push(messages: Array<Record<string, any>>, o: Parameters<Env["roku"]["sign"]>[1] = {}, appId?: string) {
  const out: Response[] = [];
  for (const m of messages) out.push(await e.notify((await e.roku.sign(m, o)).body, { "content-type": "text/plain" }, appId));
  return out;
}

/** The Roku SDK's purchase: `POST /v1/receipts` with the order's purchaseId (dashed) and a formatted price, no currency. */
async function bought(product = "scanner_monthly", o: { trialDays?: number; sandbox?: boolean } = {}) {
  const b = e.roku.buy(product, { price: 4.99, trialDays: o.trialDays });
  const res = await e.receipt({
    fetch_token: dashed(b.transaction.transactionId), app_user_id: "tv_user", product_id: product, price: "$4.99", intro_duration: null,
    trial_duration: o.trialDays ? `${o.trialDays} Days` : null, introductory_price: null, presented_offering_identifier: "default", presented_placement_identifier: null, applied_targeting_rule: null,
  }, { "X-Is-Sandbox": o.sandbox === false ? "false" : "true" });
  expect(res.status).toBe(200);
  return { chain: b.transaction.transactionId as string, transaction: b.transaction, res };
}

describe("Roku push signatures", () => {
  it("accepts Roku-signed pushes (both base64 alphabets), fetches the key set once, and answers with the responseKey", async () => {
    const { chain } = await bought();
    move(30);
    const r = e.roku.renew(chain);
    const res = await push(r.pushes);
    expect(res[0]!.status).toBe(200);
    expect(await res[0]!.text()).toBe(r.pushes[0]!.responseKey);
    await push(e.roku.renew(chain).pushes, { urlSafe: true });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL", "RENEWAL"]);
    expect(e.roku.calls.filter((c) => c.url.includes("partner-jwks.json"))).toHaveLength(1);
  });

  it("refuses forged keys, another issuer, another message type, unknown kids and bodies that are not JWTs", async () => {
    const { chain } = await bought();
    const m = e.roku.cancel(chain)[0]!;
    const refused = async (o: Parameters<Env["roku"]["sign"]>[1]) => (await push([m], o))[0]!.status;
    expect(await refused({ forged: true })).toBe(400);
    expect(await refused({ issuer: "Someone else" })).toBe(400);
    expect(await refused({ type: "roku.other" })).toBe(400);
    expect((await e.notify("not a jwt")).status).toBe(400);
    const body = (await e.roku.sign(m)).body;
    const [h, p, s] = body.split(".");
    const otherKid = Buffer.from(JSON.stringify({ typ: "JWT", alg: "RS256", kid: "ROKU-PARTNER-SERVICE-2099-01-01" })).toString("base64url");
    expect((await e.notify(`${otherKid}.${p}.${s}`)).status).toBe(400);
    expect((await e.notify(`${h}.${p}x.${s}`)).status).toBe(400);
    const stored = await e.h.db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.appId, e.appId));
    expect(stored.every((n) => n.error?.startsWith("rejected: "))).toBe(true);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
  });

  it("pushes from Roku's test endpoint (test key set) are accepted and stored as sandbox", async () => {
    const { chain } = await bought();
    await push(e.roku.cancel(chain), { test: true });
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION"]);
    const [n] = await e.h.db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.appId, e.appId));
    expect(n!.environment).toBe("sandbox");
  });
});

describe("POST /v1/receipts from the Roku SDK", () => {
  it("validates the transaction with Roku and takes price and currency from Roku; X-Is-Sandbox decides sandbox", async () => {
    const { chain, res } = await bought();
    const ci = CustomerInfoSchema.parse(await res.json());
    expect(ci.subscriber.subscriptions.scanner_monthly).toMatchObject({ store: "roku", is_sandbox: true, period_type: "normal", purchase_date: "2026-09-01T12:00:00Z", expires_date: "2026-10-01T12:00:00Z", store_transaction_id: chain });
    expect(ci.subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
    const [ev] = await e.events("INITIAL_PURCHASE");
    expect(ev).toMatchObject({ store: "ROKU", price: 4.99, currency: "USD", environment: "SANDBOX", transaction_id: chain, original_transaction_id: chain, commission_percentage: 0.2 });
    const call = e.roku.calls.find((c) => c.url.includes("validate-transaction"))!;
    expect(call.url).toBe(`https://apipub.roku.com/listen/transaction-service.svc/validate-transaction/${FAKE_ROKU_KEY}/${dashed(chain)}`);
    const prod = await bought("scanner_yearly", { sandbox: false });
    expect(CustomerInfoSchema.parse(await prod.res.json()).subscriber.subscriptions.scanner_yearly!.is_sandbox).toBe(false);
  });

  it("a free trial (the SDK's trial_duration and a $0 first transaction) and a one-time product", async () => {
    const { res } = await bought("scanner_monthly", { trialDays: 7 });
    expect(CustomerInfoSchema.parse(await res.json()).subscriber.subscriptions.scanner_monthly).toMatchObject({ period_type: "trial", expires_date: "2026-09-08T12:00:00Z" });
    expect((await e.events("INITIAL_PURCHASE"))[0]).toMatchObject({ period_type: "TRIAL", price: 0 });
    const b = e.roku.buy("scanner_lifetime", { price: 29.99, months: 0 });
    const r2 = await e.receipt({ fetch_token: b.transaction.transactionId, app_user_id: "tv_user", product_id: "scanner_lifetime", price: "$29.99" }, { "X-Is-Sandbox": "true" });
    expect(CustomerInfoSchema.parse(await r2.json()).subscriber.non_subscriptions.scanner_lifetime).toHaveLength(1);
    expect((await e.events("NON_RENEWING_PURCHASE"))[0]).toMatchObject({ price: 29.99, store: "ROKU" });
  });

  it("answers 400 for unknown or malformed transactions, 500 for a rejected key, 503 when Roku is down", async () => {
    const code = async (r: Response) => [r.status, (await r.json()).code];
    expect(await code(await e.receipt({ fetch_token: "0123456789abcdef0123456789abcdef", app_user_id: "u" }))).toEqual([400, 7103]);
    expect(await code(await e.receipt({ fetch_token: "not-a-roku-id", app_user_id: "u" }))).toEqual([400, 7103]);
    e.roku.outage = 429;
    expect(await code(await e.receipt({ fetch_token: "0123456789abcdef0123456789abcdef", app_user_id: "u" }))).toEqual([503, 7101]);
    e.roku.outage = null;
    await e.setCredentials({ roku_api_key: "WRONGKEY0123456789ABCDEF012345678" });
    expect(await code(await e.receipt({ fetch_token: "0123456789abcdef0123456789abcdef", app_user_id: "u" }))).toEqual([500, 7101]);
    const [app] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(app!.credentialsStatus).toBe("failing");
    await e.setCredentials({});
    expect(await code(await e.receipt({ fetch_token: "0123456789abcdef0123456789abcdef", app_user_id: "u" }))).toEqual([500, 7101]);
  });
});

describe("Roku lifecycle through pushes", () => {
  it("renewal, redelivery, grace with access for 3 days, on hold, recovery", async () => {
    const { chain } = await bought();
    move(30);
    const r = e.roku.renew(chain);
    await push(r.pushes);
    expect((await e.events("RENEWAL"))[0]).toMatchObject({ transaction_id: r.transaction.transactionId, original_transaction_id: chain, price: 4.99 });
    // The next charge fails when the period ends (November 1): grace keeps access 3 more days.
    move(61.5);
    await push(e.roku.grace(chain));
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL", "BILLING_ISSUE"]);
    expect((await info("tv_user")).subscriber.entitlements.pro!.expires_date).toBe("2026-11-04T12:00:00Z");
    move(64.5);
    await push(e.roku.onHold(chain));
    await expire();
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL", "BILLING_ISSUE", "EXPIRATION"]);
    expect((await e.events("EXPIRATION"))[0]).toMatchObject({ expiration_reason: "BILLING_ERROR" });
    move(70);
    await push(e.roku.renew(chain, "OnHoldRecovered").pushes);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "RENEWAL", "BILLING_ISSUE", "EXPIRATION", "RENEWAL"]);
    expect((await sub(chain)).billingIssuesDetectedAt).toBeNull();
  });

  it("cancellation and resubscribe; a refund ends access", async () => {
    const { chain } = await bought();
    move(5);
    await push(e.roku.cancel(chain));
    move(6);
    await push(e.roku.resubscribe(chain));
    move(7);
    await push(e.roku.refund(chain));
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "UNCANCELLATION", "CANCELLATION"]);
    const evs = await e.events("CANCELLATION");
    expect(evs.map((x) => x.cancel_reason)).toEqual(["UNSUBSCRIBE", "CUSTOMER_SUPPORT"]);
    expect(evs[1]).toMatchObject({ price: -4.99 });
    expect((await sub(chain)).refundedAt).toEqual(at(7));
  });

  it("an upgrade is a new subscription for the same customer; the old one is cancelled and expires (RevenueCat: no PRODUCT_CHANGE for Roku)", async () => {
    const { chain } = await bought();
    move(10);
    const up = e.roku.upgrade(chain, "scanner_yearly", 49.99);
    await push(up.pushes);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]);
    const evs = await e.events("INITIAL_PURCHASE");
    expect(evs[1]).toMatchObject({ product_id: "scanner_yearly", app_user_id: "tv_user", price: 49.99, environment: "SANDBOX" });
    expect((await sub(chain)).expiresDate).toEqual(at(10));
    expect((await info("tv_user")).subscriber.entitlements.pro!.product_identifier).toBe("scanner_yearly");
  });

  it("a downgrade turns renewal off; the downgraded plan starts as its own subscription when Roku charges it", async () => {
    const { chain } = await bought("scanner_yearly");
    move(10);
    const down = e.roku.downgrade(chain, "scanner_monthly");
    await push(down.pushes);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION"]);
    move(365);
    Object.assign(down.transaction, { purchaseStatus: "Active", amount: 4.99, total: 4.99, expirationDate: `/Date(${at(395).getTime()}+0000)/` });
    await e.receipt({ fetch_token: down.transaction.transactionId, app_user_id: "tv_user" }, { "X-Is-Sandbox": "true" });
    await expire();
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "INITIAL_PURCHASE", "EXPIRATION"]);
  });

  it("credits and chargebacks change nothing; unknown transactions are ignored unless tracked", async () => {
    const { transaction } = await bought();
    const res = await push([...e.roku.other("Credit", transaction.transactionId), ...e.roku.other("Chargeback", transaction.transactionId)]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
    const other = e.roku.buy("scanner_monthly");
    await push(other.pushes);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE"]);
    await e.setCredentials({ roku_api_key: FAKE_ROKU_KEY, roku_channel_id: e.roku.channelId, track_new_purchases: true });
    const third = e.roku.buy("scanner_monthly");
    await push(third.pushes);
    const evs = await e.events("INITIAL_PURCHASE");
    expect(evs[1]).toMatchObject({ app_user_id: expect.stringMatching(/^\$RCAnonymousID:/), environment: "PRODUCTION" });
  });

  it("one push URL for the developer account: a push for another channel goes to the Roku app with that channel id", async () => {
    await e.h.db.insert(schema.apps).values({ id: "app_roku2", projectId: e.h.ids.project, name: "Second channel", type: "roku", publicKey: "roku_second", ...(await sealedColumns("roku", { roku_api_key: FAKE_ROKU_KEY, roku_channel_id: "111111", track_new_purchases: true })) });
    e.roku.channelId = "111111";
    const b = e.roku.buy("scanner_monthly");
    await push(b.pushes);
    const rows = await e.h.db.select().from(schema.storeNotifications);
    expect(rows.map((r) => r.appId)).toEqual(["app_roku2"]);
    expect((await e.h.db.select().from(schema.subscriptions))[0]!.appId).toBe("app_roku2");
  });

  it("forwards verified pushes and records redeliveries once", async () => {
    await e.h.db.update(schema.apps).set({ notificationForwardUrl: "https://hooks.example.com/roku" }).where(eq(schema.apps.id, e.appId));
    const { chain } = await bought();
    const signed = await e.roku.sign(e.roku.cancel(chain)[0]!);
    await e.notify(signed.body);
    await e.notify(signed.body);
    await flushStoreForwards();
    expect(e.forwarded).toHaveLength(1);
    expect(e.forwarded[0]!.body).toBe(signed.body);
    expect(await eventTypes(e)).toEqual(["INITIAL_PURCHASE", "CANCELLATION"]);
  });
});

describe("Roku apps through REST v2", () => {
  it("creates a Roku app with the key sealed and RevenueCat's shape", async () => {
    const res = await e.v2("POST", "/apps", { name: "TV", type: "roku", roku: { roku_api_key: FAKE_ROKU_KEY, roku_channel_id: 123456, roku_channel_name: "Scanner TV" } });
    expect(res.status).toBe(201);
    const app = await res.json();
    expect(app.roku).toEqual({ roku_channel_id: "123456", roku_channel_name: "Scanner TV" });
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, app.id));
    expect(await unseal(row!.secrets, await secretKeyFrom(TEST_ENCRYPTION_KEY))).toEqual({ roku_api_key: FAKE_ROKU_KEY });
    expect(JSON.stringify(row!.credentials)).not.toContain(FAKE_ROKU_KEY);
    expect((await e.v2("POST", "/apps", { name: "x", type: "roku", roku: { roku_api_key: "short" } })).status).toBe(400);
  });

  it("verify_credentials, store_settings, Import products and the management link", async () => {
    const check = async (roku?: Record<string, unknown>) => (await e.v2("POST", `/apps/${e.appId}/actions/verify_credentials`, roku ? { roku } : {})).json();
    expect(await check()).toMatchObject({ status: "valid" });
    expect(await check({ roku_api_key: "WRONGKEY0123456789ABCDEF012345678" })).toMatchObject({ status: "invalid", message: expect.stringMatching(/UNAUTHORIZED/) });
    e.roku.outage = 503;
    expect(await check()).toMatchObject({ status: "unreachable" });
    e.roku.outage = null;
    const st = await (await e.v2("GET", `/apps/${e.appId}/store_settings`)).json();
    expect(st).toMatchObject({ notification_url: `http://localhost/v1/notifications/roku/${e.appId}`, roku: { roku_channel_id: e.roku.channelId, configured: true }, credentials: { roku_api_key: { configured: true } } });
    const imp = await e.v2("GET", `/apps/${e.appId}/store_products`);
    expect(imp.status).toBe(422);
    expect((await imp.json()).message).toMatch(/Roku has no API that lists/);
    const { chain } = await bought();
    const row = await sub(chain);
    expect((await (await e.v2("GET", `/subscriptions/${row.id}/authenticated_management_url`)).json()).management_url).toBe("https://my.roku.com/account/subscriptions");
    expect(T0).toBeTruthy();
  });
});
