// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: tests for the migration import endpoint with the real App Store and Google Play adapters.
// Docs: https://revenuedot.app/docs/migrate
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { createAppleStore, setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { createSecretKey } from "../src/services/auth.js";
import { tick } from "../src/services/tick.js";
import { DAY, T0, appleHarness, makeP8, makePki, signJws, transaction, type AppleHarness, type Pki } from "./apple-fixtures.js";
import { env, makeKeys, sub, type Env, type Keys } from "./google-helpers.js";

let pki: Pki;
let keys: Keys;
let h: AppleHarness | undefined;
let e: Env | undefined;
beforeAll(async () => { pki = await makePki(); keys = await makeKeys(); setAppleRootsForTesting([pki.rootPem]); });
afterAll(() => setAppleRootsForTesting(null));
afterEach(async () => { await h?.close(); h = undefined; await e?.h.close(); e = undefined; });

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

/** A second app instance on the harness database, for the REST API with a secret key. */
async function restFor(db: DB, now: () => Date, fetchFn?: typeof fetch) {
  const app = createApp({ db, now, stores: { ...defaultStores(), app_store: createAppleStore({ now, fetch: fetchFn }) }, fetch: fetchFn });
  const { key } = await createSecretKey(db, "proj1", "import");
  const call: Fetch = (path, init = {}) => Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers as Record<string, string> ?? {}) } })));
  return {
    importCustomers: async (customers: unknown[], extra: Record<string, unknown> = {}) => {
      const res = await call("/v2/projects/proj1/import/customers", { method: "POST", body: JSON.stringify({ customers, ...extra }) });
      const body = await res.json() as any;
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body;
    },
    call,
  };
}

/** Everything an import may touch, minus nothing: two identical dumps mean the second run changed nothing. */
async function dump(db: DB) {
  const t = schema;
  const rows = await Promise.all([
    db.select().from(t.customers).orderBy(asc(t.customers.id)),
    db.select().from(t.customerAliases).orderBy(asc(t.customerAliases.appUserId)),
    db.select().from(t.customerAttributes).orderBy(asc(t.customerAttributes.customerId), asc(t.customerAttributes.key)),
    db.select().from(t.subscriptions).orderBy(asc(t.subscriptions.id)),
    db.select().from(t.nonSubscriptions).orderBy(asc(t.nonSubscriptions.id)),
    db.select().from(t.transactions).orderBy(asc(t.transactions.id)),
    db.select().from(t.events).orderBy(asc(t.events.id)),
    db.select().from(t.webhookDeliveries).orderBy(asc(t.webhookDeliveries.id)),
  ]);
  return JSON.parse(JSON.stringify(rows));
}

const appleCustomer = (over: Record<string, unknown> = {}, sub: Record<string, unknown> = {}) => ({
  id: "user1", first_seen_at: T0 - 90 * DAY, last_seen_at: T0 - DAY, last_seen_platform: "iOS",
  attributes: [{ name: "$email", value: "a@example.com", updated_at: T0 - 50 * DAY }],
  subscriptions: [{
    source_id: "sub_rc_1", app_id: "app_ios", store: "app_store", product_identifier: "pro_monthly", environment: "production",
    starts_at: T0 - 60 * DAY, current_period_starts_at: T0, current_period_ends_at: T0 + 30 * DAY, status: "active", auto_renewal_status: "will_renew",
    store_subscription_identifier: "2000000001", original_transaction_id: "2000000001", country: "US", price: { amount: 9.99, currency: "USD" },
    transactions: [
      { id: "1999999998", purchased_at: T0 - 60 * DAY, revenue_usd: 9.99, price: { amount: 9.99, currency: "USD" } },
      { id: "1999999999", purchased_at: T0 - 30 * DAY, revenue_usd: 9.99, price: { amount: 9.99, currency: "USD" } },
      { id: "2000000001", purchased_at: T0, revenue_usd: 9.99, price: { amount: 9.99, currency: "USD" } },
    ],
    ...sub,
  }],
  ...over,
});

describe("POST /v2/projects/{id}/import/customers (App Store)", () => {
  it("imports access without events or webhooks, keeps first-seen and dates, and a later receipt post attaches to the imported chain", async () => {
    h = await appleHarness();
    await h.db.insert(schema.webhooks).values({ id: "wh1", projectId: "proj1", name: "Hook", url: "https://hooks.example.com/rd", signingSecret: "whsec_x" });
    const rest = await restFor(h.db, h.now);
    const out = await rest.importCustomers([appleCustomer()]);
    expect(out.customers).toEqual([{ id: "user1", status: "created", subscriptions: 1, purchases: 0, needs_token_refresh: 0, notes: [] }]);
    expect(await h.newEvents()).toEqual([]);
    expect(await h.db.select().from(schema.webhookDeliveries)).toEqual([]);

    const info = await h.customerInfo("user1");
    expect(info.subscriber.first_seen).toBe(new Date(T0 - 90 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(info.subscriber.original_purchase_date).toBe(new Date(T0 - 60 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(info.subscriber.entitlements.pro).toMatchObject({ product_identifier: "pro_monthly", expires_date: new Date(T0 + 30 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z") });
    const [s] = await h.db.select().from(schema.subscriptions);
    expect(s).toMatchObject({ storeKey: "2000000001", originalTransactionId: "2000000001", storeTransactionId: "2000000001", appId: "app_ios" });
    const txns = await h.db.select().from(schema.transactions);
    expect(txns.map((t) => [t.storeTransactionId, t.kind]).sort()).toEqual([["1999999998", "renewal"], ["1999999999", "renewal"], ["2000000001", "purchase"]].sort());

    // The device posts the same StoreKit 2 transaction: nothing changes, and there is no INITIAL_PURCHASE.
    expect((await h.postReceipt("user1", await signJws(transaction(), pki))).status).toBe(200);
    expect(await h.newEvents()).toEqual([]);
    expect(await h.db.select().from(schema.subscriptions)).toHaveLength(1);
    // The next renewal is a RENEWAL on the same chain.
    h.setNow(T0 + 30 * DAY + 1000);
    await h.postReceipt("user1", await signJws(transaction({ transactionId: "2000000031", originalTransactionId: "2000000001", purchaseDate: T0 + 30 * DAY, expiresDate: T0 + 60 * DAY }), pki));
    expect((await h.newEvents()).map((x) => x.type)).toEqual(["RENEWAL"]);
  });

  it("running the same import twice leaves the database unchanged", async () => {
    h = await appleHarness();
    const rest = await restFor(h.db, h.now);
    const batch = [
      appleCustomer(),
      appleCustomer({ id: "user2", aliases: ["$RCAnonymousID:00000000000000000000000000000002"] }, { store_subscription_identifier: "3000000005", original_transaction_id: "3000000001", status: "expired", auto_renewal_status: "will_not_renew", current_period_starts_at: T0 - 90 * DAY, current_period_ends_at: T0 - 60 * DAY, transactions: [] }),
      { id: "user3", first_seen_at: T0 - DAY, purchases: [{ app_id: "app_ios", store: "app_store", product_identifier: "lifetime", purchased_at: T0 - DAY, store_purchase_identifier: "4000000001", status: "owned", price: { amount: 49.99, currency: "USD" } }, { app_id: "app_ios", store: "app_store", product_identifier: "coins_100", purchased_at: T0 - 2 * DAY, store_purchase_identifier: "4000000002", status: "refunded" }] },
    ];
    const first = await rest.importCustomers(batch);
    expect(first.customers.map((c: any) => c.status)).toEqual(["created", "created", "created"]);
    const before = await dump(h.db);
    const second = await rest.importCustomers(batch);
    expect(second.customers.map((c: any) => c.status)).toEqual(["updated", "updated", "updated"]);
    expect(await dump(h.db)).toEqual(before);
    const [lifetime] = await h.db.select().from(schema.nonSubscriptions).where(eq(schema.nonSubscriptions.storeTransactionId, "4000000001"));
    expect(lifetime).toMatchObject({ productIdentifier: "lifetime", isConsumable: false, refundedAt: null });
    const [coins] = await h.db.select().from(schema.nonSubscriptions).where(eq(schema.nonSubscriptions.storeTransactionId, "4000000002"));
    expect(coins).toMatchObject({ isConsumable: true, refundedAt: new Date(T0 - 2 * DAY) });
  });

  it("an imported subscription that already ended gets no EXPIRATION from the expiration job", async () => {
    h = await appleHarness();
    const rest = await restFor(h.db, h.now);
    await rest.importCustomers([appleCustomer({}, { status: "expired", auto_renewal_status: "will_not_renew", current_period_starts_at: T0 - 40 * DAY, current_period_ends_at: T0 - 10 * DAY })]);
    await tick(h.db, h.now(), (async () => new Response("ok")) as typeof fetch);
    expect(await h.newEvents()).toEqual([]);
    expect((await h.customerInfo("user1")).subscriber.entitlements.pro.expires_date).toBe(new Date(T0 - 10 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"));
  });

  it("merges existing customers that hold any of the imported ids and adds the aliases", async () => {
    h = await appleHarness();
    const anon = "$RCAnonymousID:0123456789abcdef0123456789abcdef";
    await h.customerInfo(anon);
    await h.customerInfo("user1");
    await h.db.insert(schema.customerAttributes).values({ customerId: (await h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, anon)))[0]!.id, key: "plan", value: "gold", updatedAtMs: T0 });
    const rest = await restFor(h.db, h.now);
    const out = await rest.importCustomers([appleCustomer({ aliases: [anon, "old_login"] })]);
    expect(out.customers[0].status).toBe("merged");
    const customers = await h.db.select().from(schema.customers);
    expect(customers).toHaveLength(1);
    const aliases = await h.db.select().from(schema.customerAliases);
    expect(aliases.map((a) => a.appUserId).sort()).toEqual([anon, "old_login", "user1"].sort());
    expect(aliases.every((a) => a.customerId === customers[0]!.id)).toBe(true);
    // Any alias reads the same customer, with the merged attribute and the imported access.
    const viaAlias = await h.customerInfo("old_login");
    expect(viaAlias.subscriber.entitlements.pro.product_identifier).toBe("pro_monthly");
    expect(viaAlias.subscriber.first_seen).toBe(new Date(T0 - 90 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"));
    const attrs = await h.db.select().from(schema.customerAttributes);
    expect(attrs.map((a) => a.key).sort()).toEqual(["$email", "plan"]);
    // A second run with the same aliases changes nothing.
    const before = await dump(h.db);
    await rest.importCustomers([appleCustomer({ aliases: [anon, "old_login"] })]);
    expect(await dump(h.db)).toEqual(before);
  });

  it("with the in-app purchase key, Apple's API confirms the original transaction id of a resubscribed chain", async () => {
    const lookups: string[] = [];
    const appleApi = (async (url: string) => {
      const u = new URL(url);
      lookups.push(u.pathname);
      if (u.pathname === "/inApps/v1/transactions/5000000009") {
        return Response.json({ signedTransactionInfo: await signJws(transaction({ transactionId: "5000000009", originalTransactionId: "5000000001", purchaseDate: T0, expiresDate: T0 + 30 * DAY }), pki) });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    h = await appleHarness({ credentials: { subscription_key_id: "KEY123", subscription_key_issuer: "issuer-1", subscription_private_key: await makeP8() }, fetch: appleApi });
    const rest = await restFor(h.db, h.now, appleApi);
    // The source split the chain after a lapse, so its first known transaction (5000000007) is not Apple's original.
    await rest.importCustomers([appleCustomer({}, { store_subscription_identifier: "5000000009", original_transaction_id: null, transactions: [{ id: "5000000007", purchased_at: T0 - 30 * DAY }, { id: "5000000009", purchased_at: T0 }] })]);
    expect(lookups).toContain("/inApps/v1/transactions/5000000009");
    const [s] = await h.db.select().from(schema.subscriptions);
    expect(s).toMatchObject({ storeKey: "5000000001", originalTransactionId: "5000000001" });
  });

  it("emit_events: true records lifecycle events as if the purchase had just arrived", async () => {
    h = await appleHarness();
    const rest = await restFor(h.db, h.now);
    await rest.importCustomers([appleCustomer()], { emit_events: true });
    expect((await h.newEvents()).map((x) => x.type)).toEqual(["INITIAL_PURCHASE"]);
  });

  it("rejects apps from another project and oversized batches", async () => {
    h = await appleHarness();
    const rest = await restFor(h.db, h.now);
    const bad = await rest.call("/v2/projects/proj1/import/customers", { method: "POST", body: JSON.stringify({ customers: [appleCustomer({}, { app_id: "nope" })] }) });
    expect(bad.status).toBe(400);
    const many = await rest.call("/v2/projects/proj1/import/customers", { method: "POST", body: JSON.stringify({ customers: Array.from({ length: 101 }, (_, i) => ({ id: `u${i}` })) }) });
    expect(many.status).toBe(400);
  });

  it("keeps an app's existing public SDK key", async () => {
    h = await appleHarness();
    const rest = await restFor(h.db, h.now);
    const set = (key: string) => rest.call("/v2/projects/proj1/import/apps/app_ios/public_key", { method: "POST", body: JSON.stringify({ public_key: key }) });
    expect((await set("goog_abc")).status).toBe(400);
    const ok = await set("appl_ShippedKey123");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ object: "public_api_key", key: "appl_ShippedKey123", app_id: "app_ios" });
    const [app] = await h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_ios"));
    expect(app!.publicKey).toBe("appl_ShippedKey123");
    await h.db.insert(schema.apps).values({ id: "app_other", projectId: "proj1", name: "Other", type: "app_store", bundleId: "com.other", publicKey: "appl_other" });
    const taken = await rest.call("/v2/projects/proj1/import/apps/app_other/public_key", { method: "POST", body: JSON.stringify({ public_key: "appl_ShippedKey123" }) });
    expect(taken.status).toBe(409);
  });
});

describe("POST /v2/projects/{id}/import/customers (Google Play)", () => {
  const MONTH_END = new Date("2026-10-01T12:00:00Z");
  const T = new Date(T0);
  const playCustomer = (token?: string) => ({
    id: "droid", first_seen_at: T0 - 10 * DAY,
    subscriptions: [{
      app_id: "app_play", store: "play_store", product_identifier: "pro:monthly", starts_at: T0, current_period_starts_at: T0,
      current_period_ends_at: MONTH_END.getTime(), status: "active", auto_renewal_status: "will_renew", store_subscription_identifier: "GPA.1111-2222-3333-44444",
      ...(token ? { purchase_token: token } : {}), transactions: [{ id: "GPA.1111-2222-3333-44444", purchased_at: T0, revenue_usd: 9.99 }],
    }],
  });

  it("looks up the purchase token by order id with the app's service account, so a later receipt post changes nothing", async () => {
    e = await env(keys);
    e.g.orders.set("GPA.1111-2222-3333-44444", "tok_imported");
    e.g.subs.set("tok_imported", sub({ start: T, expiry: MONTH_END, order: "GPA.1111-2222-3333-44444", ack: true }));
    const rest = await restFor(e.h.db, e.h.now, e.g.fetch);
    const out = await rest.importCustomers([playCustomer()]);
    expect(out.customers[0]).toMatchObject({ needs_token_refresh: 0 });
    const [s] = await e.h.db.select().from(schema.subscriptions);
    expect(s).toMatchObject({ storeKey: "tok_imported", productIdentifier: "pro", productPlanIdentifier: "monthly", originalTransactionId: "GPA.1111-2222-3333-44444" });
    const res = await e.receipt({ app_user_id: "droid", fetch_token: "tok_imported", product_ids: ["pro"], platform_product_ids: [{ product_id: "pro", base_plan_id: "monthly" }], price: 9.99, currency: "USD" });
    expect(res.status).toBe(200);
    expect(await e.events()).toEqual([]);
    expect(await e.h.db.select().from(schema.subscriptions)).toHaveLength(1);
  });

  it("without credentials marks the chain needs_token_refresh, and a later run with credentials upgrades it in place", async () => {
    e = await env(keys);
    const creds = (await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_play")))[0]!.credentials;
    await e.h.db.update(schema.apps).set({ credentials: {} }).where(eq(schema.apps.id, "app_play"));
    const rest = await restFor(e.h.db, e.h.now, e.g.fetch);
    const out = await rest.importCustomers([playCustomer()]);
    expect(out.customers[0]).toMatchObject({ needs_token_refresh: 1 });
    const status = await (await rest.call("/v2/projects/proj1/import/status")).json() as any;
    expect(status).toMatchObject({ object: "import_status", customers: 1, subscriptions: 1, needs_token_refresh: 1, needs_token_refresh_by_app: { app_play: 1 } });
    // Access is imported even without the token.
    const info = await (await e.call("/v1/subscribers/droid", { key: e.h.ids.androidKey })).json() as any;
    expect(info.subscriber.entitlements.pro.expires_date).toBe("2026-10-01T12:00:00Z");

    await e.h.db.update(schema.apps).set({ credentials: creds }).where(eq(schema.apps.id, "app_play"));
    e.g.orders.set("GPA.1111-2222-3333-44444", "tok_later");
    const again = await rest.importCustomers([playCustomer()]);
    expect(again.customers[0]).toMatchObject({ needs_token_refresh: 0 });
    const subs = await e.h.db.select().from(schema.subscriptions);
    expect(subs.map((s) => s.storeKey)).toEqual(["tok_later"]);
  });

  it("a purchase token exported with the data is used as is", async () => {
    e = await env(keys);
    const rest = await restFor(e.h.db, e.h.now, e.g.fetch);
    await rest.importCustomers([playCustomer("tok_from_export")]);
    const [s] = await e.h.db.select().from(schema.subscriptions);
    expect(s!.storeKey).toBe("tok_from_export");
    expect(e.g.calls.filter((c) => c.url.includes("orders:batchGet"))).toEqual([]);
  });
});
