import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { getOrCreateCustomer } from "@revenuedot/server/repo/customers.js";
import { monthlyFactor } from "@revenuedot/server/routes/v2/metrics.js";
import { harness, type Harness } from "../src/harness.js";
import { buy, spec, v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const C = "/v2/projects/{project_id}/customers";
const CU = `${C}/{customer_id}`;
const SUBS = "/v2/projects/{project_id}/subscriptions";
const PURS = "/v2/projects/{project_id}/purchases";
const DAY = 86400_000;

describe("customers", () => {
  it("creates with attributes, rejects duplicates, gets with expand=attributes, deletes", async () => {
    const created = await call("POST", C, {}, { json: { id: "user_1", attributes: [{ name: "$email", value: "a@b.io" }, { name: "plan", value: "gold" }] } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: "customer", id: "user_1", project_id: "proj1", active_entitlements: { object: "list", items: [] } });
    expect((await call("POST", C, {}, { json: { id: "user_1" } })).status).toBe(409);
    expect((await call("POST", C, {}, { json: {} })).body.param).toBe("id");

    const got = await call("GET", CU, { customer_id: "user_1" }, { query: "expand=attributes" });
    expect(got.body.attributes.items.map((a: any) => [a.name, a.value])).toEqual([["$email", "a@b.io"], ["plan", "gold"]]);
    expect((await call("GET", CU, { customer_id: "user_1" })).body.attributes).toBeUndefined();
    expect((await call("GET", CU, { customer_id: "nobody" })).status).toBe(404);

    const del = await call("DELETE", CU, { customer_id: "user_1" });
    expect(del.body).toMatchObject({ object: "customer", id: "user_1" });
    expect((await call("GET", CU, { customer_id: "user_1" })).status).toBe(404);
  });

  it("anonymous ids work as path ids", async () => {
    const anon = "$RCAnonymousID:0123456789abcdef0123456789abcdef";
    await h.fetch(`/v1/subscribers/${encodeURIComponent(anon)}`);
    expect((await call("GET", CU, { customer_id: anon })).body.id).toBe(anon);
  });

  it("lists newest first with pagination and searches by app user id, alias, email and transaction id", async () => {
    for (let i = 0; i < 5; i++) {
      h.setNow(new Date(Date.UTC(2026, 8, 1, 12, i)));
      await h.fetch(`/v1/subscribers/list_${i}`);
    }
    const p1 = await call("GET", C, {}, { query: "limit=2" });
    expect(p1.body.items.map((c: any) => c.id)).toEqual(["list_4", "list_3"]);
    expect(p1.body.next_page).toBe("/v2/projects/proj1/customers?limit=2&starting_after=list_3");
    const p2 = await call("GET", C, {}, { query: "limit=2&starting_after=list_3" });
    expect(p2.body.items.map((c: any) => c.id)).toEqual(["list_2", "list_1"]);
    const p3 = await call("GET", C, {}, { query: "limit=2&starting_after=list_1" });
    expect(p3.body.items.map((c: any) => c.id)).toEqual(["list_0"]);
    expect(p3.body.next_page).toBeNull();

    const anon = "$RCAnonymousID:ffffffffffffffffffffffffffffffff";
    await h.fetch(`/v1/subscribers/${encodeURIComponent(anon)}`);
    await h.fetch("/v1/subscribers/identify", { method: "POST", json: { app_user_id: anon, new_app_user_id: "anon_alias" } });
    await h.fetch("/v1/subscribers/list_1/attributes", { method: "POST", json: { attributes: { $email: { value: "Found@Example.com", updated_at_ms: 1 } } } });
    const at = new Date("2026-09-01T11:00:00Z");
    const token = `test_${at.getTime()}_abc`;
    await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "list_2", fetch_token: token, product_id: "pro_monthly" } });
    expect((await call("GET", C, {}, { query: "search=list_3" })).body.items.map((c: any) => c.id)).toEqual(["list_3"]);
    expect((await call("GET", C, {}, { query: "search=anon_alias" })).body.items.map((c: any) => c.id)).toEqual([anon]);
    expect((await call("GET", C, {}, { query: "search=found%40example.com" })).body.items.map((c: any) => c.id)).toEqual(["list_1"]);
    expect((await call("GET", C, {}, { query: `search=${token}` })).body.items.map((c: any) => c.id)).toEqual(["list_2"]);
    expect((await call("GET", C, {}, { query: "search=nobody" })).body.items).toEqual([]);
    expect((await call("GET", C, {}, { query: "starting_after=ghost" })).status).toBe(400);
  });

  it("aliases, attributes (set and delete) and active entitlements", async () => {
    await h.fetch("/v1/subscribers/%24RCAnonymousID%3Aaaaa", {});
    await h.fetch("/v1/subscribers/identify", { method: "POST", json: { app_user_id: "$RCAnonymousID:aaaa", new_app_user_id: "known" } });
    const aliases = await call("GET", `${CU}/aliases`, { customer_id: "known" });
    expect(aliases.body.items.map((a: any) => a.id).sort()).toEqual(["$RCAnonymousID:aaaa", "known"]);

    const set = await call("POST", `${CU}/attributes`, { customer_id: "known" }, { json: { attributes: [{ name: "$displayName", value: "Kai" }, { name: "team", value: "a" }] } });
    expect(set.status).toBe(200);
    expect(set.body.items.map((a: any) => a.name)).toEqual(["$displayName", "team"]);
    await call("POST", `${CU}/attributes`, { customer_id: "known" }, { json: { attributes: [{ name: "team", value: null }] } });
    expect((await call("GET", `${CU}/attributes`, { customer_id: "known" })).body.items.map((a: any) => a.name)).toEqual(["$displayName"]);
    expect((await call("POST", `${CU}/attributes`, { customer_id: "known" }, { json: { attributes: [] } })).status).toBe(400);

    expect((await call("GET", `${CU}/active_entitlements`, { customer_id: "known" })).body.items).toEqual([]);
    await buy(h, "known", "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    const ents = await call("GET", `${CU}/active_entitlements`, { customer_id: "known" });
    expect(ents.body.items).toEqual([{ object: "customer.active_entitlement", entitlement_id: "ent_pro", expires_at: new Date("2026-10-01T11:00:00Z").getTime() }]);
    expect((await call("GET", CU, { customer_id: "known" })).body.active_entitlements.items).toHaveLength(1);
  });

  it("subscriptions and purchases, by customer and at project level", async () => {
    await buy(h, "buyer", "pro_monthly", new Date("2026-09-01T11:00:00Z"), 9.99);
    await buy(h, "buyer", "lifetime", new Date("2026-09-01T11:30:00Z"), 49.99);
    const subs = await call("GET", `${CU}/subscriptions`, { customer_id: "buyer" });
    expect(subs.body.items).toHaveLength(1);
    const s = subs.body.items[0];
    expect(s).toMatchObject({
      object: "subscription", customer_id: "buyer", product_id: "p4", status: "active", gives_access: true, auto_renewal_status: "will_renew",
      environment: "sandbox", store: "test_store", ownership: "purchased", total_revenue_in_usd: { currency: "USD", gross: 9.99, proceeds: 9.99 },
    });
    expect(s.entitlements.items.map((e: any) => e.id)).toEqual(["ent_pro"]);
    expect((await call("GET", `${CU}/subscriptions`, { customer_id: "buyer" }, { query: "environment=production" })).body.items).toEqual([]);
    expect((await call("GET", `${CU}/subscriptions`, { customer_id: "buyer" }, { query: "environment=moon" })).status).toBe(400);

    const one = await call("GET", `${SUBS}/{subscription_id}`, { subscription_id: s.id });
    expect(one.body.id).toBe(s.id);
    expect((await call("GET", SUBS, {}, { query: `store_subscription_identifier=${s.store_subscription_identifier}` })).body.items.map((x: any) => x.id)).toEqual([s.id]);
    expect((await call("GET", SUBS)).status).toBe(400);
    expect((await call("GET", `${SUBS}/{subscription_id}/entitlements`, { subscription_id: s.id })).body.items.map((e: any) => e.lookup_key)).toEqual(["pro"]);

    const purs = await call("GET", `${CU}/purchases`, { customer_id: "buyer" });
    expect(purs.body.items).toHaveLength(1);
    const p = purs.body.items[0];
    expect(p).toMatchObject({ object: "purchase", product_id: "p5", status: "owned", quantity: 1, store: "test_store", revenue_in_usd: { gross: 49.99 } });
    expect((await call("GET", `${PURS}/{purchase_id}`, { purchase_id: p.id })).body.id).toBe(p.id);
    expect((await call("GET", PURS, {}, { query: `store_purchase_identifier=${p.store_purchase_identifier}` })).body.items).toHaveLength(1);
    expect((await call("GET", `${PURS}/{purchase_id}/entitlements`, { purchase_id: p.id })).body.items.map((e: any) => e.id)).toEqual(["ent_pro"]);
    expect((await call("GET", `${PURS}/{purchase_id}`, { purchase_id: "nope" })).status).toBe(404);

    const events = await call("GET", `${CU}/events`, { customer_id: "buyer" });
    expect(events.body.items.map((e: any) => e.type).sort()).toEqual(["INITIAL_PURCHASE", "NON_RENEWING_PURCHASE"]);
    expect(events.body.items[0].body.app_user_id).toBe("buyer");

    // Deleting the customer removes their purchases and history.
    await call("DELETE", CU, { customer_id: "buyer" });
    expect((await call("GET", `${SUBS}/{subscription_id}`, { subscription_id: s.id })).status).toBe(404);
    expect(await h.db.select().from(schema.transactions)).toHaveLength(0);
    expect(await h.db.select().from(schema.events)).toHaveLength(0);
  });

  it("grants and revokes promotional entitlements; duplicates within 2 hours are ignored", async () => {
    await call("POST", C, {}, { json: { id: "vip" } });
    const exp = new Date("2026-10-01T12:00:00Z").getTime();
    const g = await call("POST", `${CU}/actions/grant_entitlement`, { customer_id: "vip" }, { json: { entitlement_id: "ent_pro", expires_at: exp } });
    expect(g.status).toBe(201);
    expect(g.body.active_entitlements.items).toEqual([{ object: "customer.active_entitlement", entitlement_id: "ent_pro", expires_at: exp }]);
    await call("POST", `${CU}/actions/grant_entitlement`, { customer_id: "vip" }, { json: { entitlement_id: "ent_pro", expires_at: exp + 3600_000 } });
    expect(await h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.store, "promotional"))).toHaveLength(1);
    // The SDK sees it too.
    const info = await (await h.fetch("/v1/subscribers/vip")).json();
    expect(info.subscriber.entitlements.pro.expires_date).toBe("2026-10-01T12:00:00Z");
    expect((await call("POST", `${CU}/actions/grant_entitlement`, { customer_id: "vip" }, { json: { entitlement_id: "ent_pro", expires_at: h.now().getTime() - 1 } })).status).toBe(400);
    expect((await call("POST", `${CU}/actions/grant_entitlement`, { customer_id: "vip" }, { json: { entitlement_id: "entlB", expires_at: exp } })).status).toBe(404);

    const rv = await call("POST", `${CU}/actions/revoke_granted_entitlement`, { customer_id: "vip" }, { json: { entitlement_id: "ent_pro" } });
    expect(rv.status).toBe(200);
    expect(rv.body.active_entitlements.items).toEqual([]);
    expect((await call("POST", `${CU}/actions/revoke_granted_entitlement`, { customer_id: "vip" }, { json: { entitlement_id: "ent_pro" } })).status).toBe(404);
  });

  it("assigns and clears an offering override", async () => {
    await h.db.insert(schema.offerings).values({ id: "ofr_sale", projectId: "proj1", lookupKey: "sale", displayName: "Sale" });
    await call("POST", C, {}, { json: { id: "o1" } });
    expect((await call("POST", `${CU}/actions/assign_offering`, { customer_id: "o1" }, { json: { offering_id: "ofr_sale" } })).status).toBe(200);
    expect((await (await h.fetch("/v1/subscribers/o1/offerings")).json()).current_offering_id).toBe("sale");
    await call("POST", `${CU}/actions/assign_offering`, { customer_id: "o1" }, { json: { offering_id: null } });
    expect((await (await h.fetch("/v1/subscribers/o1/offerings")).json()).current_offering_id).toBe("default");
    expect((await call("POST", `${CU}/actions/assign_offering`, { customer_id: "o1" }, { json: { offering_id: "ofrngB" } })).status).toBe(404);
  });
});

describe("metrics overview", () => {
  it("normalises periods to a month", () => {
    expect(monthlyFactor("P1M")).toBe(1);
    expect(monthlyFactor("P1Y")).toBeCloseTo(1 / 12, 10);
    expect(monthlyFactor("P1W")).toBeCloseTo(4.33, 10);
    expect(monthlyFactor("P3M")).toBeCloseTo(1 / 3, 10);
    expect(monthlyFactor("P3D")).toBeCloseTo(10, 10);
    expect(monthlyFactor(null)).toBeNull();
  });

  it("computes trials, active subscriptions, MRR, revenue, new and active customers from seeded data", async () => {
    const now = h.now(); // 2026-09-01T12:00Z
    const d = (days: number) => new Date(now.getTime() + days * DAY);
    await h.db.insert(schema.products).values({ id: "pw", projectId: "proj1", appId: "app_ios", storeIdentifier: "pro_weekly", duration: "P1W" });
    const cust = async (id: string, firstSeen: Date, lastSeen: Date) => {
      const { customer } = await getOrCreateCustomer(h.db, "proj1", id, firstSeen);
      await h.db.update(schema.customers).set({ firstSeen, lastSeen }).where(eq(schema.customers.id, customer.id));
      return customer.id;
    };
    let n = 0;
    const sub = async (customerId: string, v: Partial<typeof schema.subscriptions.$inferInsert>) => h.db.insert(schema.subscriptions).values({
      id: `s${++n}`, projectId: "proj1", customerId, appId: "app_ios", store: "app_store", storeKey: `k${n}`, productIdentifier: "pro_monthly",
      purchaseDate: d(-5), originalPurchaseDate: d(-5), expiresDate: d(25), priceUsd: 9.99, priceAmount: 9.99, priceCurrency: "USD", ...v,
    });
    const a = await cust("a", d(-100), d(-1));
    const b = await cust("b", d(-10), d(-2));
    const c = await cust("c", d(-3), d(0));
    const e = await cust("e", d(-60), d(-40));
    await sub(a, {}); // monthly 9.99
    await sub(b, { productIdentifier: "pro_annual", priceUsd: 59.99, priceAmount: 59.99, expiresDate: d(300) }); // 59.99 / 12
    await sub(c, { productIdentifier: "pro_weekly", priceUsd: 2.99, priceAmount: 2.99, expiresDate: d(2) }); // 2.99 * 4.33
    await sub(c, { appId: "app_play", store: "play_store", productIdentifier: "pro", productPlanIdentifier: "monthly", priceUsd: 4.99, priceAmount: 4.99 }); // 4.99
    await sub(a, { periodType: "trial", priceUsd: 0, priceAmount: 0 }); // trial
    await sub(e, { expiresDate: d(-1) }); // expired
    await sub(e, { refundedAt: d(-1) }); // refunded
    await sub(e, { store: "promotional", productIdentifier: "rc_promo_pro_monthly", priceUsd: null, priceAmount: null, priceCurrency: null }); // promotional
    await sub(e, { isSandbox: true }); // sandbox
    await sub(e, { expiresDate: d(-1), gracePeriodExpiresDate: d(3) }); // in grace period: still active (9.99)
    let t = 0;
    const txn = async (customerId: string, at: Date, usd: number, isSandbox = false) => h.db.insert(schema.transactions).values({
      id: `t${++t}`, projectId: "proj1", customerId, store: "app_store", storeTransactionId: `st${t}`, productIdentifier: "pro_monthly", kind: usd < 0 ? "refund" : "purchase", purchasedAt: at, revenueUsd: usd, isSandbox,
    });
    await txn(a, d(-12), 9.99);
    await txn(b, d(-20), 59.99);
    await txn(e, d(-1), -9.99);
    await txn(e, d(-40), 100); // older than 28 days
    await txn(e, d(-2), 5, true); // sandbox

    const r = await call("GET", "/v2/projects/{project_id}/metrics/overview");
    expect(r.status).toBe(200);
    expect(r.body.currency).toBe("USD");
    const m = Object.fromEntries(r.body.metrics.map((x: any) => [x.id, x.value]));
    expect(m).toEqual({
      active_trials: 1,
      active_subscriptions: 5,
      mrr: Math.round((9.99 + 59.99 / 12 + 2.99 * 4.33 + 4.99 + 9.99) * 100) / 100,
      revenue: 59.99,
      new_customers: 2, // b (10 days ago) and c (3 days ago)
      active_users: 3, // a, b, c
    });
    expect(r.body.metrics.map((x: any) => x.period)).toEqual(["P0D", "P0D", "P28D", "P28D", "P28D", "P28D"]);

    const sandbox = await call("GET", "/v2/projects/{project_id}/metrics/overview", {}, { query: "environment=sandbox" });
    expect(sandbox.body.metrics.find((x: any) => x.id === "active_subscriptions").value).toBe(1);
    expect(sandbox.body.metrics.find((x: any) => x.id === "revenue").value).toBe(5);
    expect((await call("GET", "/v2/projects/{project_id}/metrics/overview", {}, { query: "currency=EUR" })).status).toBe(400);
  });
});

describe("schema coverage", () => {
  it("validated every customer operation against RevenueCat's spec", () => {
    if (!spec) return;
    const want = [
      `GET ${C} 200`, `POST ${C} 201`, `GET ${CU} 200`, `DELETE ${CU} 200`, `GET ${CU}/aliases 200`, `GET ${CU}/attributes 200`, `POST ${CU}/attributes 200`,
      `GET ${CU}/active_entitlements 200`, `GET ${CU}/subscriptions 200`, `GET ${CU}/purchases 200`, `GET ${CU}/events 200`,
      `POST ${CU}/actions/grant_entitlement 201`, `POST ${CU}/actions/revoke_granted_entitlement 200`, `POST ${CU}/actions/assign_offering 200`,
      `GET ${SUBS} 200`, `GET ${SUBS}/{subscription_id} 200`, `GET ${SUBS}/{subscription_id}/entitlements 200`,
      `GET ${PURS} 200`, `GET ${PURS}/{purchase_id} 200`, `GET ${PURS}/{purchase_id}/entitlements 200`,
      "GET /v2/projects/{project_id}/metrics/overview 200",
      `GET ${CU} 404`, `POST ${C} 409`, `POST ${C} 400`,
    ];
    expect(want.filter((w) => !spec!.checked.has(w))).toEqual([]);
  });
});
