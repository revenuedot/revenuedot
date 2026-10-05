// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: contract tests for the migration import endpoint (RevenueDot extension) through the SDK and REST API.
// Docs: https://revenuedot.app/docs/migrate
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "@revenuedot/server/services/auth.js";
import { harness, type Harness } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const IMPORT = "/v2/projects/{project_id}/import/customers";
const DAY = 86_400_000;
const T = Date.parse("2026-08-20T12:00:00Z");
const TOKEN = `test_${T}_4f0c3c1e-8a1b-4d3e-9f21-0c2b7a9d1e55`;
const MONTH_LATER = Date.parse("2026-09-20T12:00:00Z");

const testStoreCustomer = (over: Record<string, unknown> = {}) => ({
  id: "user_b", aliases: ["$RCAnonymousID:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"], first_seen_at: T - 30 * DAY, last_seen_at: T,
  attributes: [{ name: "$displayName", value: "Bea", updated_at: T - DAY }],
  subscriptions: [{
    app_id: "app_test", store: "test_store", product_identifier: "pro_monthly", environment: "sandbox", starts_at: T, current_period_starts_at: T,
    current_period_ends_at: MONTH_LATER, status: "active", auto_renewal_status: "will_renew", store_subscription_identifier: TOKEN, price: { amount: 9.99, currency: "USD" },
  }],
  purchases: [{ app_id: "app_test", store: "test_store", product_identifier: "lifetime", purchased_at: T - DAY, store_purchase_identifier: "test_life_1", environment: "sandbox", status: "owned" }],
  ...over,
});

async function dump() {
  const t = schema;
  const out: string[][] = [];
  for (const table of [t.customers, t.customerAliases, t.customerAttributes, t.subscriptions, t.nonSubscriptions, t.transactions, t.events]) {
    out.push((await h.db.select().from(table as typeof t.customers)).map((r) => JSON.stringify(r)).sort());
  }
  return out;
}

describe("POST /v2/projects/{id}/import/customers", () => {
  it("imports a customer whose REST API view matches RevenueCat's schemas, and a second import changes nothing", async () => {
    const first = await call("POST", IMPORT, {}, { ext: true, json: { customers: [testStoreCustomer()] } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ object: "import_result", emit_events: false, customers: [{ id: "user_b", status: "created", subscriptions: 1, purchases: 1, needs_token_refresh: 0 }] });
    const before = await dump();
    const second = await call("POST", IMPORT, {}, { ext: true, json: { customers: [testStoreCustomer()] } });
    expect(second.body.customers[0].status).toBe("updated");
    expect(await dump()).toEqual(before);

    // The imported data through the regular v2 endpoints (validated against RevenueCat's response schemas).
    const cust = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}", { customer_id: "$RCAnonymousID:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(cust.body).toMatchObject({ id: "user_b", first_seen_at: T - 30 * DAY, active_entitlements: { items: [{ entitlement_id: "ent_pro", expires_at: null }] } });
    const subs = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}/subscriptions", { customer_id: "user_b" });
    expect(subs.body.items[0]).toMatchObject({ store: "test_store", store_subscription_identifier: TOKEN, starts_at: T, current_period_ends_at: MONTH_LATER, gives_access: true, environment: "sandbox" });
    const purchases = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}/purchases", { customer_id: "user_b" });
    expect(purchases.body.items[0]).toMatchObject({ store_purchase_identifier: "test_life_1", status: "owned" });
    expect((await call("GET", "/v2/projects/{project_id}/customers/{customer_id}/events", { customer_id: "user_b" })).body.items).toEqual([]);
  });

  it("a later receipt post for the imported subscription records no INITIAL_PURCHASE", async () => {
    await call("POST", IMPORT, {}, { ext: true, json: { customers: [testStoreCustomer()] } });
    const res = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: "user_b", fetch_token: TOKEN, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect(res.status).toBe(200);
    const info = await res.json() as any;
    expect(info.subscriber.subscriptions.pro_monthly).toMatchObject({ store: "test_store", purchase_date: "2026-08-20T12:00:00Z", expires_date: "2026-09-20T12:00:00Z" });
    expect(info.subscriber.first_seen).toBe(new Date(T - 30 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect((await h.db.select().from(schema.events)).map((e) => e.type)).toEqual([]);
    expect(await h.db.select().from(schema.subscriptions)).toHaveLength(1);
  });

  it("merges customers that already exist under any imported id into one, keeping every alias", async () => {
    const anon = "$RCAnonymousID:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await h.fetch(`/v1/subscribers/${encodeURIComponent(anon)}`, { key: h.ids.testKey });
    await h.fetch("/v1/subscribers/user_b", { key: h.ids.testKey });
    await h.fetch("/v1/subscribers/legacy_id", { key: h.ids.testKey });
    expect(await h.db.select().from(schema.customers)).toHaveLength(3);
    const res = await call("POST", IMPORT, {}, { ext: true, json: { customers: [testStoreCustomer({ aliases: [anon, "legacy_id"] })] } });
    expect(res.body.customers[0].status).toBe("merged");
    const customers = await h.db.select().from(schema.customers);
    expect(customers).toHaveLength(1);
    expect(customers[0]!.originalAppUserId).toBe("user_b");
    const aliases = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}/aliases", { customer_id: "legacy_id" });
    expect(aliases.body.items.map((a: any) => a.id).sort()).toEqual([anon, "legacy_id", "user_b"].sort());
    // The merged customer holds the imported access, whichever id the SDK uses.
    const info = await (await h.fetch(`/v1/subscribers/${encodeURIComponent(anon)}`, { key: h.ids.testKey })).json() as any;
    expect(info.subscriber.entitlements.pro).toBeDefined();
    expect(info.subscriber.original_app_user_id).toBe("user_b");
  });

  it("needs a secret key with customer write access; public SDK keys and read-only keys are refused", async () => {
    const pub = await call("POST", IMPORT, {}, { ext: true, key: h.ids.testKey, json: { customers: [testStoreCustomer()] } });
    expect(pub.status).toBe(403);
    const { key } = await createSecretKey(h.db, h.ids.project, "read only", ["customer_information:customers:read"]);
    const ro = await call("POST", IMPORT, {}, { ext: true, key, json: { customers: [testStoreCustomer()] } });
    expect(ro.status).toBe(403);
    expect(ro.body.type).toBe("authorization_error");
    const bad = await call("POST", IMPORT, {}, { ext: true, json: { customers: [{ id: "x", subscriptions: [{ store: "nowhere" }] }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("parameter_error");
  });

  it("status counts customers, subscriptions and Google chains still waiting for a purchase token", async () => {
    await call("POST", IMPORT, {}, { ext: true, json: { customers: [
      testStoreCustomer(),
      { id: "droid", subscriptions: [{ app_id: "app_play", store: "play_store", product_identifier: "pro:monthly", starts_at: T, current_period_starts_at: T, current_period_ends_at: MONTH_LATER, status: "active", store_subscription_identifier: "GPA.1234-5678-9012-34567" }] },
    ] } });
    const status = await call("GET", "/v2/projects/{project_id}/import/status", {}, { ext: true });
    expect(status.body).toEqual({ object: "import_status", customers: 2, subscriptions: 2, needs_token_refresh: 1, needs_token_refresh_by_app: { app_play: 1 } });
  });

  it("App Store billing plans: product:monthly is split into product and plan, product:upFront is the bare product", async () => {
    const sub = (product: string, id: string) => ({ app_id: "app_ios", store: "app_store", product_identifier: product, starts_at: T, current_period_starts_at: T, current_period_ends_at: MONTH_LATER, status: "active", store_subscription_identifier: id });
    const res = await call("POST", IMPORT, {}, { ext: true, json: { customers: [
      { id: "plan_monthly", subscriptions: [sub("pro_monthly:monthly", "300000901")] }, { id: "plan_upfront", subscriptions: [sub("pro_annual:upFront", "300000902")] },
    ] } });
    expect(res.status).toBe(200);
    const rows = (await h.db.select().from(schema.subscriptions)).map((r) => [r.productIdentifier, r.productPlanIdentifier]).sort();
    expect(rows).toEqual([["pro_annual", null], ["pro_monthly", "monthly"]]);
    const info = await (await h.fetch("/v1/subscribers/plan_monthly")).json();
    expect(info.subscriber.entitlements.pro).toMatchObject({ product_identifier: "pro_monthly", product_plan_identifier: "monthly" });
  });
});
