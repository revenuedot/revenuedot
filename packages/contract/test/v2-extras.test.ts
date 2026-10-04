import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { createSecretKey } from "@revenuedot/server/services/auth.js";
import { buy, signup, v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const VC = "/v2/projects/{project_id}/virtual_currencies";
const VCC = `${VC}/{virtual_currency_code}`;
const CUSTOMER = "/v2/projects/{project_id}/customers/{customer_id}";
const BAL = `${CUSTOMER}/virtual_currencies`;
const at = new Date(Date.UTC(2026, 8, 1, 12));

describe("in-app currencies", () => {
  it("creates, lists, gets, updates, archives, unarchives and deletes a currency; validates codes and grants", async () => {
    const made = await call("POST", VC, {}, { json: { code: "GLD", name: "Gold", description: "Gold coins", product_grants: [{ product_ids: ["p6"], amount: 100 }] } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ object: "virtual_currency", code: "GLD", state: "active", project_id: "proj1" });
    expect(made.body.product_grants[0]).toMatchObject({ object: "virtual_currency.product_grant", product_ids: ["p6"], amount: 100, trial_amount: 0, expire_at_cycle_end: false });
    expect((await call("POST", VC, {}, { json: { code: "GLD", name: "Again" } })).status).toBe(409);
    expect((await call("POST", VC, {}, { json: { code: "bad code!", name: "X" } })).status).toBe(400);
    const unknown = await call("POST", VC, {}, { json: { code: "GEM", name: "Gems", product_grants: [{ product_ids: ["nope"], amount: 1 }] } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.param).toBe("product_grants");
    h.setNow(new Date(at.getTime() + 5000));
    await call("POST", VC, {}, { json: { code: "GEM", name: "Gems" } });

    const list = await call("GET", VC, {}, { query: "limit=1" });
    expect(list.body.items.map((x: any) => x.code)).toEqual(["GLD"]);
    expect(list.body.next_page).toContain("starting_after=GLD");
    expect((await call("GET", VCC, { virtual_currency_code: "GEM" })).body.name).toBe("Gems");
    expect((await call("GET", VCC, { virtual_currency_code: "NOPE" })).status).toBe(404);

    const upd = await call("POST", VCC, { virtual_currency_code: "GEM" }, { json: { name: "Gemstones", description: null } });
    expect(upd.body).toMatchObject({ name: "Gemstones", description: null });
    expect((await call("POST", VCC + "/actions/archive", { virtual_currency_code: "GEM" })).body.state).toBe("inactive");
    expect((await call("POST", VCC + "/actions/unarchive", { virtual_currency_code: "GEM" })).body.state).toBe("active");
    const del = await call("DELETE", VCC, { virtual_currency_code: "GEM" });
    expect(del.body).toMatchObject({ object: "virtual_currency", id: "GEM" });
    expect((await call("GET", VCC, { virtual_currency_code: "GEM" })).status).toBe(404);
  });

  it("adjusts balances: transactions are idempotent by key and cannot go below zero; update_balance changes the balance only", async () => {
    await call("POST", VC, {}, { json: { code: "GLD", name: "Gold" } });
    await call("POST", "/v2/projects/{project_id}/customers", {}, { json: { id: "gamer" } });
    const params = { customer_id: "gamer" };
    expect((await call("GET", BAL, params)).body.items).toEqual([]);
    expect((await call("GET", BAL, params, { query: "include_empty_balances=true" })).body.items).toEqual([{ object: "virtual_currency_balance", currency_code: "GLD", balance: 0, name: "Gold" }]);

    const credit = await call("POST", `${BAL}/transactions`, params, { json: { adjustments: { GLD: 50 }, reference: "welcome" }, headers: { "Idempotency-Key": "k1" } });
    expect(credit.status).toBe(200);
    expect(credit.body.items[0]).toMatchObject({ currency_code: "GLD", balance: 50 });
    const replay = await call("POST", `${BAL}/transactions`, params, { json: { adjustments: { GLD: 50 } }, headers: { "Idempotency-Key": "k1" } });
    expect(replay.body.items[0].balance).toBe(50);

    const spend = await call("POST", `${BAL}/transactions`, params, { json: { adjustments: { GLD: -20 } } });
    expect(spend.body.items[0].balance).toBe(30);
    const over = await call("POST", `${BAL}/transactions`, params, { json: { adjustments: { GLD: -31 } } });
    expect(over.status).toBe(422);
    expect((await call("GET", BAL, params)).body.items[0].balance).toBe(30);

    const set = await call("POST", `${BAL}/update_balance`, params, { json: { adjustments: { GLD: 10 } } });
    expect(set.body.items[0].balance).toBe(40);
    const ledger = await h.db.select().from(schema.virtualCurrencyTransactions);
    expect(ledger.map((x) => x.amount).sort((a, b) => a - b)).toEqual([-20, 50]);

    expect((await call("POST", `${BAL}/transactions`, params, { json: { adjustments: { NOPE: 1 } } })).status).toBe(404);
    expect((await call("POST", `${BAL}/transactions`, params, { json: { adjustments: {} } })).status).toBe(400);
    expect((await call("POST", `${BAL}/transactions`, { customer_id: "nobody" }, { json: { adjustments: { GLD: 1 } } })).status).toBe(404);
  });

  it("credits a balance once per store transaction when a granting product is bought, and the SDK reads it", async () => {
    await call("POST", VC, {}, { json: { code: "GLD", name: "Gold", product_grants: [{ product_ids: ["p6"], amount: 100 }, { product_ids: ["p4"], amount: 500, trial_amount: 10 }] } });
    expect((await buy(h, "buyer", "coins_100", at)).status).toBe(200);
    expect((await buy(h, "buyer", "coins_100", new Date(at.getTime() + 1000))).status).toBe(200);
    expect((await buy(h, "buyer", "pro_monthly", new Date(at.getTime() + 2000))).status).toBe(200);
    const bal = await call("GET", BAL, { customer_id: "buyer" });
    expect(bal.body.items[0]).toMatchObject({ currency_code: "GLD", balance: 100 + 100 + 500 });

    const sdk = await (await h.fetch("/v1/subscribers/buyer/virtual_currencies", { key: h.ids.testKey })).json() as any;
    expect(sdk.virtual_currencies.GLD).toMatchObject({ balance: 700, name: "Gold", code: "GLD" });
    const none = await (await h.fetch("/v1/subscribers/stranger/virtual_currencies", { key: h.ids.testKey })).json() as any;
    expect(none.virtual_currencies).toEqual({});
  });

  it("sends VIRTUAL_CURRENCY_TRANSACTION for purchase grants in RevenueCat's shape, and none for API adjustments", async () => {
    await call("POST", VC, {}, { json: { code: "CRD", name: "Credits", description: "The main currency unit", product_grants: [{ product_ids: ["p6"], amount: 100 }] } });
    await buy(h, "buyer", "coins_100", at);
    await call("POST", `${BAL}/transactions`, { customer_id: "buyer" }, { json: { adjustments: { CRD: 5 } } });
    const evs = await h.db.select().from(schema.events).where(eq(schema.events.type, "VIRTUAL_CURRENCY_TRANSACTION"));
    expect(evs).toHaveLength(1);
    const e = (evs[0]!.payload as any).event;
    expect(Object.keys(e).sort()).toEqual(["adjustments", "aliases", "app_id", "app_user_id", "event_timestamp_ms", "id", "product_display_name", "product_id", "purchase_environment", "source", "store", "subscriber_attributes", "transaction_id", "type", "virtual_currency_transaction_id"]);
    expect(e).toMatchObject({ type: "VIRTUAL_CURRENCY_TRANSACTION", source: "in_app_purchase", product_id: "coins_100", app_user_id: "buyer", purchase_environment: "SANDBOX",
      adjustments: [{ amount: 100, currency: { code: "CRD", name: "Credits", description: "The main currency unit" } }] });
    expect(e.virtual_currency_transaction_id).toMatch(/^vatx/);
  });

  it("an archived currency stops granting but keeps a non-zero balance visible", async () => {
    await call("POST", VC, {}, { json: { code: "GLD", name: "Gold", product_grants: [{ product_ids: ["p6"], amount: 100 }] } });
    await buy(h, "buyer", "coins_100", at);
    await call("POST", VCC + "/actions/archive", { virtual_currency_code: "GLD" });
    await buy(h, "buyer", "coins_100", new Date(at.getTime() + 1000));
    expect((await call("GET", BAL, { customer_id: "buyer" })).body.items[0].balance).toBe(100);
  });
});

describe("customer transfer", () => {
  it("moves subscriptions and purchases to another customer, records TRANSFER, and refuses empty or same-customer transfers", async () => {
    await buy(h, "from_user", "pro_monthly", at);
    await buy(h, "from_user", "coins_100", new Date(at.getTime() + 1000));
    const T = `${CUSTOMER}/actions/transfer`;
    expect((await call("POST", T, { customer_id: "from_user" }, { json: { target_customer_id: "from_user" } })).status).toBe(400);
    expect((await call("POST", T, { customer_id: "from_user" }, { json: {} })).status).toBe(400);
    expect((await call("POST", T, { customer_id: "nobody" }, { json: { target_customer_id: "to_user" } })).status).toBe(404);
    expect((await call("POST", T, { customer_id: "from_user" }, { json: { target_customer_id: "to_user", app_ids: ["app_nope"] } })).status).toBe(400);

    const res = await call("POST", T, { customer_id: "from_user" }, { json: { target_customer_id: "to_user" } });
    expect(res.status).toBe(200);
    expect(res.body.source_customer).toMatchObject({ object: "customer", id: "from_user", active_entitlements: { items: [] } });
    expect(res.body.target_customer.id).toBe("to_user");
    expect(res.body.target_customer.active_entitlements.items.map((e: any) => e.entitlement_id)).toEqual(["ent_pro"]);
    expect((await call("GET", `${CUSTOMER}/subscriptions`, { customer_id: "from_user" })).body.items).toEqual([]);
    expect((await call("GET", `${CUSTOMER}/subscriptions`, { customer_id: "to_user" })).body.items).toHaveLength(1);
    expect((await call("GET", `${CUSTOMER}/purchases`, { customer_id: "to_user" })).body.items).toHaveLength(1);

    const events = await h.db.select().from(schema.events).where(eq(schema.events.type, "TRANSFER"));
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as any).event).toMatchObject({ transferred_from: ["from_user"], transferred_to: ["to_user"] });
    expect((await call("POST", T, { customer_id: "from_user" }, { json: { target_customer_id: "to_user" } })).status).toBe(422);
  });

  it("only moves the listed apps", async () => {
    await buy(h, "src", "pro_monthly", at);
    const res = await call("POST", `${CUSTOMER}/actions/transfer`, { customer_id: "src" }, { json: { target_customer_id: "dst", app_ids: ["app_ios"] } });
    expect(res.status).toBe(422);
    const ok = await call("POST", `${CUSTOMER}/actions/transfer`, { customer_id: "src" }, { json: { target_customer_id: "dst", app_ids: ["app_test"] } });
    expect(ok.status).toBe(200);
  });
});

describe("customer center", () => {
  it("serves a default configuration to the SDK and the REST API, and merges a stored override", async () => {
    await h.fetch("/v1/subscribers/cc_user", { key: h.ids.testKey });
    const sdk = await h.fetch("/v1/customercenter/cc_user", { key: h.ids.testKey });
    expect(sdk.status).toBe(200);
    const cfg = (await sdk.json() as any).customer_center;
    expect(Object.keys(cfg.screens)).toEqual(["MANAGEMENT", "NO_ACTIVE"]);
    expect(cfg.screens.MANAGEMENT.paths.map((p: any) => p.type)).toEqual(["CANCEL", "REFUND_REQUEST", "MISSING_PURCHASE"]);
    expect(cfg.localization.locale).toBe("en_US");
    expect(typeof cfg.support.email).toBe("string");

    const v2cfg = await call("GET", `${CUSTOMER}/customer_center`, { customer_id: "cc_user" });
    expect(v2cfg.body).toMatchObject({ object: "customer_center_config" });
    expect(v2cfg.body.customer_center.screens.MANAGEMENT.title).toBe("Manage subscription");
    expect((await call("GET", `${CUSTOMER}/customer_center`, { customer_id: "cc_user" }, { query: "platform=toaster" })).status).toBe(400);
    expect((await call("GET", `${CUSTOMER}/customer_center`, { customer_id: "nobody" })).status).toBe(404);

    const set = await call("POST", "/v2/projects/{project_id}/customer_center_config", {}, { ext: true, json: { customer_center: { support: { email: "help@scanner.app" }, screens: { MANAGEMENT: { title: "Your plan" } } } } });
    expect(set.status).toBe(200);
    const merged = (await (await h.fetch("/v1/customercenter/cc_user", { key: h.ids.testKey })).json() as any).customer_center;
    expect(merged.support).toMatchObject({ email: "help@scanner.app", display_purchase_history_link: true });
    expect(merged.screens.MANAGEMENT).toMatchObject({ title: "Your plan", type: "MANAGEMENT" });
    expect(merged.screens.MANAGEMENT.paths).toHaveLength(3);

    const read = await call("GET", "/v2/projects/{project_id}/customer_center_config", {}, { ext: true });
    expect(read.body.overrides).toMatchObject({ support: { email: "help@scanner.app" } });
    expect(read.body.customer_center.support.display_purchase_history_link).toBe(true);
    await call("POST", "/v2/projects/{project_id}/customer_center_config", {}, { ext: true, json: { customer_center: null } });
    expect((await call("GET", "/v2/projects/{project_id}/customer_center_config", {}, { ext: true })).body.overrides).toBeNull();
  });
});

describe("store kit config, management url, revenue", () => {
  it("builds a StoreKit file for an App Store app only", async () => {
    const ok = await call("GET", "/v2/projects/{project_id}/apps/{app_id}/store_kit_config", { app_id: "app_ios" });
    expect(ok.status).toBe(200);
    const sub = ok.body.contents.subscriptionGroups[0].subscriptions.map((s: any) => [s.productID, s.recurringSubscriptionPeriod]);
    expect(sub).toEqual([["pro_annual", "P1Y"], ["pro_monthly", "P1M"]]);
    expect(ok.body.contents.version).toEqual({ major: 4, minor: 0 });
    expect((await call("GET", "/v2/projects/{project_id}/apps/{app_id}/store_kit_config", { app_id: "app_play" })).status).toBe(400);
    expect((await call("GET", "/v2/projects/{project_id}/apps/{app_id}/store_kit_config", { app_id: "app_nope" })).status).toBe(404);
  });

  it("answers a management url per store", async () => {
    await buy(h, "mg", "pro_monthly", at);
    const subs = await call("GET", `${CUSTOMER}/subscriptions`, { customer_id: "mg" });
    const id = subs.body.items[0].id;
    const r = await call("GET", "/v2/projects/{project_id}/subscriptions/{subscription_id}/authenticated_management_url", { subscription_id: id });
    expect(r.body).toEqual({ object: "authenticated_management_url", management_url: null });
    await h.db.update(schema.subscriptions).set({ store: "app_store" }).where(eq(schema.subscriptions.id, id));
    expect((await call("GET", "/v2/projects/{project_id}/subscriptions/{subscription_id}/authenticated_management_url", { subscription_id: id })).body.management_url).toBe("https://apps.apple.com/account/subscriptions");
    expect((await call("GET", "/v2/projects/{project_id}/subscriptions/{subscription_id}/authenticated_management_url", { subscription_id: "sub_nope" })).status).toBe(404);
  });

  it("sums revenue for an inclusive date range, with proceeds net of the store commission", async () => {
    await h.db.update(schema.apps).set({ type: "app_store" }).where(eq(schema.apps.id, "app_test")); // keep Test Store out of the way of sandbox filtering
    await buy(h, "r1", "pro_monthly", at, 10);
    await buy(h, "r2", "lifetime", new Date(Date.UTC(2026, 8, 3, 9)), 20);
    await h.db.update(schema.transactions).set({ isSandbox: false, store: "app_store" });
    const M = "/v2/projects/{project_id}/metrics/revenue";
    const all = await call("GET", M, {}, { query: "start_date=2026-09-01&end_date=2026-09-30" });
    expect(all.body).toMatchObject({ object: "revenue_metric", currency: "USD", revenue_type: "revenue", start_date: "2026-09-01", end_date: "2026-09-30" });
    expect(all.body.value).toBe(30);
    expect((await call("GET", M, {}, { query: "start_date=2026-09-01&end_date=2026-09-01" })).body.value).toBe(10);
    const net = await call("GET", M, {}, { query: "start_date=2026-09-01&end_date=2026-09-30&revenue_type=proceeds" });
    expect(net.body.value).toBeLessThan(30);
    expect(net.body.value).toBeGreaterThan(20);
    // Net of taxes: r2 bought in Germany (19% VAT inside the price), r1 in the US (no tax in the price).
    await h.db.update(schema.transactions).set({ countryCode: "DE" }).where(eq(schema.transactions.revenueUsd, 20));
    await h.db.update(schema.transactions).set({ countryCode: "US" }).where(eq(schema.transactions.revenueUsd, 10));
    const taxed = await call("GET", M, {}, { query: "start_date=2026-09-01&end_date=2026-09-30&revenue_type=revenue_net_of_taxes" });
    expect(taxed.body).toMatchObject({ revenue_type: "revenue_net_of_taxes", value: Math.round((10 + 20 / 1.19) * 100) / 100 });
    // A tax the store reported wins over the estimate: $2 of the $20.
    await h.db.update(schema.transactions).set({ taxAmount: 2, taxSource: "store", priceAmount: 20 }).where(eq(schema.transactions.revenueUsd, 20));
    expect((await call("GET", M, {}, { query: "start_date=2026-09-01&end_date=2026-09-30&revenue_type=revenue_net_of_taxes" })).body.value).toBe(28);
    expect((await call("GET", M, {}, { query: "start_date=2026-09-01&end_date=2026-09-30&revenue_type=proceeds" })).body.value).toBe(Math.round((10 * 0.7 + 18 * 0.7) * 100) / 100);
    for (const q of ["end_date=2026-09-30", "start_date=2026-09-30&end_date=2026-09-01", "start_date=nope&end_date=2026-09-01", "start_date=2026-09-01&end_date=2026-09-30&currency=EUR", "start_date=2026-09-01&end_date=2026-09-30&revenue_type=x"]) {
      expect((await call("GET", M, {}, { query: q })).status, q).toBe(400);
    }
  });
});

describe("audit log", () => {
  it("records successful writes with the actor, never reads or failures, and filters by date and pages", async () => {
    const tick = () => h.setNow(new Date(h.now().getTime() + 1000));
    await call("POST", "/v2/projects/{project_id}/entitlements", {}, { json: { lookup_key: "vip", display_name: "VIP" } });
    tick();
    await call("POST", "/v2/projects/{project_id}/entitlements", {}, { json: { lookup_key: "vip", display_name: "VIP again" } }); // 409: not logged
    await call("GET", "/v2/projects/{project_id}/entitlements");
    await call("POST", VC, {}, { json: { code: "GLD", name: "Gold" } });
    tick();
    await call("POST", VCC + "/actions/archive", { virtual_currency_code: "GLD" });
    tick();
    await call("DELETE", VCC, { virtual_currency_code: "GLD" });
    const log = await call("GET", "/v2/projects/{project_id}/audit_logs");
    expect(log.status).toBe(200);
    const kinds = log.body.items.map((x: any) => `${x.action_type}:${x.target_identifier === "GLD" ? "GLD" : "id"}`);
    expect(kinds).toEqual(["virtual_currency_deleted:GLD", "virtual_currency_archive:GLD", "virtual_currency_created:GLD", "entitlement_created:id"]);
    expect(log.body.items[0]).toMatchObject({ object: "audit_log", project_id: "proj1", actor_type: "api_key", target_type: "virtual_currency" });
    expect(log.body.items[3].target_identifier).toMatch(/^entl|^[a-z]/);

    const p1 = await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: "limit=2" });
    expect(p1.body.items).toHaveLength(2);
    const p2 = await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: `limit=2&starting_after=${p1.body.items[1].id}` });
    expect(p2.body.items.map((x: any) => x.action_type)).toEqual(["virtual_currency_created", "entitlement_created"]);
    const day = h.now().toISOString().slice(0, 10);
    expect((await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: `start_date=${day}&end_date=${day}` })).body.items).toHaveLength(4);
    expect((await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: "start_date=2001-01-01&end_date=2001-01-02" })).body.items).toEqual([]);
    expect((await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: "start_date=bad" })).status).toBe(400);
    expect((await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: "starting_after=nope" })).status).toBe(400);
  });

  it("names the dashboard user for session writes and OAuth clients for OAuth keys", async () => {
    const cookie = await signup(h, "owner@example.com", "Mine");
    const me = await (await h.fetch("/auth/me", { key: "", headers: { Cookie: cookie } })).json() as { projects: { id: string }[] };
    const projectId = me.projects[0]!.id;
    const res = await call("POST", "/v2/projects/{project_id}/entitlements", { project_id: projectId }, { cookie, json: { lookup_key: "vip", display_name: "VIP" } });
    expect(res.status).toBe(201);
    const rows = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionType: "entitlement_created", actorType: "user" });

    const oauth = (await createSecretKey(h.db, "proj1", "OAuth: Claude")).key;
    await call("POST", "/v2/projects/{project_id}/entitlements", {}, { key: oauth, json: { lookup_key: "viaoauth", display_name: "Via OAuth" } });
    const [log] = (await call("GET", "/v2/projects/{project_id}/audit_logs")).body.items;
    expect(log).toMatchObject({ action_type: "entitlement_created", actor_type: "oauth_client" });
  });
});
