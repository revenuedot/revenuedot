import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@revenuedot/db";
import { getOrCreateCustomer } from "@revenuedot/server/repo/customers.js";
import { harness, type Harness } from "../src/harness.js";
import { buy, v2 } from "./v2-helpers.js";

/** RevenueDot extensions behind the dashboard's Overview cards and customer pages. */
let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const P = "/v2/projects/{project_id}";
const DAY = 86400_000;
const history = (query: string) => call("GET", `${P}/metrics/history`, {}, { ext: true, query });

describe("metrics history", () => {
  it("revenue and new customers: daily sums, rolling total equal to /metrics/overview, previous window", async () => {
    // now = 2026-09-01T12:00Z. Two purchases inside the last 7 days, one in the 7 days before.
    await buy(h, "h_a", "pro_monthly", new Date("2026-08-31T09:00:00Z"), 9.99);
    await buy(h, "h_b", "pro_monthly", new Date("2026-09-01T08:00:00Z"), 4.99);
    await buy(h, "h_c", "lifetime", new Date("2026-08-22T08:00:00Z"), 30);
    const r = await history("metric=revenue&days=7&environment=sandbox");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "metric_history", id: "revenue", days: 7, environment: "sandbox", resolution: "day", value: 14.98, previous_value: 30 });
    expect(r.body.values).toHaveLength(7);
    expect(r.body.values.at(-1)).toEqual({ date: "2026-09-01", value: 4.99 });
    expect(r.body.values.at(-2)).toEqual({ date: "2026-08-31", value: 9.99 });
    expect(r.body.values[0].date).toBe("2026-08-26");

    const overview = await call("GET", `${P}/metrics/overview`, {}, { query: "environment=sandbox" });
    const r28 = await history("metric=revenue&days=28&environment=sandbox");
    expect(r28.body.value).toBe(overview.body.metrics.find((m: any) => m.id === "revenue").value);
    expect((await history("metric=revenue&days=7")).body).toMatchObject({ environment: "production", value: 0, previous_value: 0 });

    // A customer created by posting an older purchase was first seen at that purchase: h_c (Aug 22) is outside the 7 days.
    const nc = await history("metric=new_customers&days=7");
    expect(nc.body.value).toBe(2);
    expect(nc.body.values.at(-1).value).toBe(1);
    expect(nc.body.values.at(-2).value).toBe(1);
    const au = await history("metric=active_users&days=90");
    expect(au.body).toMatchObject({ value: 3, previous_value: null, values: null });
  });

  it("subscriptions, trials and MRR are rebuilt per day from transactions and cut short by refunds", async () => {
    const { customer: c1 } = await getOrCreateCustomer(h.db, "proj1", "apple_user", h.now());
    const { customer: c2 } = await getOrCreateCustomer(h.db, "proj1", "apple_trial", h.now());
    const tx = (id: string, customerId: string, kind: string, from: string, days: number, usd: number, product = "pro_monthly") => ({
      id, projectId: "proj1", customerId, appId: "app_ios", store: "app_store", storeTransactionId: id, productIdentifier: product, kind,
      purchasedAt: new Date(from), expiresAt: new Date(new Date(from).getTime() + days * DAY), revenueUsd: usd,
    });
    await h.db.insert(schema.transactions).values([
      // Paid monthly from Aug 10, renewed Aug 10 → Sep 10 (so active through today).
      tx("t1", c1.id, "purchase", "2026-07-10T00:00:00Z", 31, 10),
      tx("t2", c1.id, "renewal", "2026-08-10T00:00:00Z", 31, 10),
      // A 7-day trial that started Aug 20 and ended Aug 27; nothing after.
      tx("t3", c2.id, "trial", "2026-08-20T00:00:00Z", 7, 0),
      // An annual plan bought Aug 25 and refunded Aug 28.
      tx("t4", c2.id, "purchase", "2026-08-25T00:00:00Z", 365, 120, "pro_annual"),
      { ...tx("t4", c2.id, "refund", "2026-08-28T00:00:00Z", 0, -120, "pro_annual"), id: "t4r", expiresAt: null },
    ]);
    const trials = await history("metric=active_trials&days=14");
    const byDate = (r: any) => Object.fromEntries(r.body.values.map((v: any) => [v.date, v.value]));
    expect(byDate(trials)["2026-08-20"]).toBe(1);
    expect(byDate(trials)["2026-08-27"]).toBe(0);
    const subs = byDate(await history("metric=active_subscriptions&days=14"));
    expect(subs["2026-08-24"]).toBe(1);
    expect(subs["2026-08-25"]).toBe(2);
    expect(subs["2026-08-28"]).toBe(1);
    const mrr = await history("metric=mrr&days=14");
    expect(byDate(mrr)["2026-08-25"]).toBe(20);
    expect(byDate(mrr)["2026-08-28"]).toBe(10);
    // Today's point is the live value (no subscription rows exist, so the live snapshot is 0) and the previous value is 14 days ago.
    expect(mrr.body.values.at(-1).value).toBe(mrr.body.value);
    expect(mrr.body.previous_value).toBe(10);
  });

  it("validates metric, days and environment", async () => {
    expect((await history("metric=churn")).body).toMatchObject({ object: "error", type: "parameter_error", param: "metric" });
    expect((await history("metric=mrr&days=0")).body.param).toBe("days");
    expect((await history("metric=mrr&days=400")).body.param).toBe("days");
    expect((await history("metric=mrr&environment=staging")).body.param).toBe("environment");
    expect((await history("metric=mrr")).body.values).toHaveLength(28);
  });
});

describe("customer summaries", () => {
  it("revenue, active entitlements with their source, grants, offering override and subscription prices", async () => {
    await buy(h, "sum_a", "pro_monthly", new Date("2026-08-31T00:00:00Z"), 7.99);
    await call("POST", `${P}/customers`, {}, { json: { id: "sum_b" } });
    await call("POST", `${P}/customers/{customer_id}/actions/grant_entitlement`, { customer_id: "sum_b" }, { json: { entitlement_id: "ent_pro", expires_at: h.now().getTime() + 7 * DAY } });
    await call("POST", `${P}/customers/{customer_id}/actions/assign_offering`, { customer_id: "sum_b" }, { json: { offering_id: "ofr_default" } });

    const r = await call("GET", `${P}/customer_summaries`, {}, { ext: true, query: "ids=sum_a,sum_b,missing" });
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.id)).toEqual(["sum_a", "sum_b"]);
    const [a, b] = r.body.items;
    expect(a).toMatchObject({
      object: "customer_summary", original_app_user_id: "sum_a", aliases: ["sum_a"], total_revenue_in_usd: 0, sandbox_revenue_in_usd: 7.99,
      stores: ["test_store"], offering_override: null, granted_entitlements: [],
      active_entitlements: [{ entitlement_id: "ent_pro", lookup_key: "pro", display_name: "Pro access", source: "purchase", product_identifier: "pro_monthly" }],
      subscriptions: [{ product_identifier: "pro_monthly", product_display_name: "pro_monthly", duration: "P1M", period_type: "normal", price: { amount: 7.99, currency: "USD" } }],
    });
    expect(b).toMatchObject({
      total_revenue_in_usd: 0, stores: ["promotional"], offering_override: { id: "ofr_default", lookup_key: "default" },
      active_entitlements: [{ entitlement_id: "ent_pro", source: "promotional", product_identifier: null, expires_at: h.now().getTime() + 7 * DAY }],
      granted_entitlements: [{ entitlement_id: "ent_pro", lookup_key: "pro", expires_at: h.now().getTime() + 7 * DAY }],
    });

    await call("POST", `${P}/customers/{customer_id}/actions/revoke_granted_entitlement`, { customer_id: "sum_b" }, { json: { entitlement_id: "ent_pro" } });
    const after = await call("GET", `${P}/customer_summaries`, {}, { ext: true, query: "ids=sum_b" });
    expect(after.body.items[0]).toMatchObject({ active_entitlements: [], granted_entitlements: [] });

    expect((await call("GET", `${P}/customer_summaries`, {}, { ext: true })).body.param).toBe("ids");
    const many = Array.from({ length: 101 }, (_, i) => `u${i}`).join(",");
    expect((await call("GET", `${P}/customer_summaries`, {}, { ext: true, query: `ids=${many}` })).body.param).toBe("ids");
  });
});
