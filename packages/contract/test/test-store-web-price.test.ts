// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a Test Store purchase from purchases-js records the catalog's Test Store price. purchases-js (1.67) posts
// Test Store receipts with `price: null` and only the currency; before the fix the purchase was stored at $0, so
// revenue, MRR and the charts never moved for web Test Store purchases. Found by scripts/e2e/journeys/web-sdk.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

/** The body purchases-js 1.67.1 sends after "Test valid purchase" (postReceipt in Purchases.es.js). */
const webReceipt = (user: string, product: string) => ({
  fetch_token: `test_${h.now().getTime()}_${crypto.randomUUID()}`, product_id: product, currency: "USD", app_user_id: user,
  presented_offering_identifier: "default", presented_placement_identifier: null, applied_targeting_rule: null,
  initiation_source: "purchase", is_restore: false, price: null,
});

describe("Test Store receipts without a price (purchases-js)", () => {
  it("use the product's Test Store price for the transaction, revenue and the event", async () => {
    await h.db.update(schema.products).set({ testStorePriceMicros: 9_990_000, testStorePriceCurrency: "USD" }).where(eq(schema.products.id, "p4"));
    const res = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, headers: { "x-platform": "web" }, json: webReceipt("web_buyer", "pro_monthly") });
    expect(res.status).toBe(200);
    const [t] = await h.db.select().from(schema.transactions);
    expect({ amount: t!.priceAmount, currency: t!.priceCurrency, usd: t!.revenueUsd }).toEqual({ amount: 9.99, currency: "USD", usd: 9.99 });
    const [e] = await h.db.select().from(schema.events).where(eq(schema.events.type, "INITIAL_PURCHASE"));
    expect((e!.payload as any).event).toMatchObject({ price: 9.99, currency: "USD", price_in_purchased_currency: 9.99 });
  });

  it("a price the SDK sends still wins, and a product without a Test Store price stays unpriced", async () => {
    await h.db.update(schema.products).set({ testStorePriceMicros: 9_990_000, testStorePriceCurrency: "USD" }).where(eq(schema.products.id, "p4"));
    await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { ...webReceipt("native_buyer", "pro_monthly"), price: 4.99 } });
    await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: webReceipt("lifetime_buyer", "lifetime") });
    const rows = await h.db.select().from(schema.transactions);
    expect(rows.map((r) => [r.productIdentifier, r.priceAmount]).sort()).toEqual([["lifetime", null], ["pro_monthly", 4.99]]);
  });

  it("POST /v2/projects/{id}/test_purchases without a price uses the catalog price for every step (found by the lifecycle journey)", async () => {
    await h.db.update(schema.products).set({ testStorePriceMicros: 9_990_000, testStorePriceCurrency: "USD" }).where(eq(schema.products.id, "p4"));
    const r = await h.fetch(`/v2/projects/${h.ids.project}/test_purchases`, { method: "POST", key: h.ids.secretKey, json: { app_user_id: "refunded", product_id: "pro_monthly", scenario: "refund", offset_days: 2 } });
    expect(r.status).toBe(201);
    const evs = (await h.db.select().from(schema.events)).map((e) => (e.payload as any).event).sort((a, b) => a.event_timestamp_ms - b.event_timestamp_ms);
    expect(evs.map((e) => [e.type, e.price])).toEqual([["INITIAL_PURCHASE", 9.99], ["CANCELLATION", -9.99]]);
    const rows = await h.db.select().from(schema.transactions);
    expect(rows.map((t) => [t.kind, t.revenueUsd]).sort()).toEqual([["purchase", 9.99], ["refund", -9.99]]);
  });
});

describe("events of the same instant keep their order (found by the lifecycle journey on real Postgres)", () => {
  it("each later event of a customer at the same instant gets a later created_at, so lists and the API order them as recorded", async () => {
    const run = async (user: string, scenario: string) => (await h.fetch(`/v2/projects/${h.ids.project}/test_purchases`, { method: "POST", key: h.ids.secretKey, json: { app_user_id: user, product_id: "pro_monthly", scenario } })).json() as Promise<any>;
    expect((await run("expirer", "expire")).event_types).toEqual(["INITIAL_PURCHASE", "CANCELLATION", "EXPIRATION"]);
    expect((await run("lapser", "billing_issue")).event_types).toEqual(["INITIAL_PURCHASE", "BILLING_ISSUE", "CANCELLATION"]);
    const rows = await h.db.select().from(schema.events);
    const byInstant = new Map<string, typeof rows>();
    for (const r of rows) byInstant.set(`${r.customerId}:${r.eventTimestampMs}`, [...(byInstant.get(`${r.customerId}:${r.eventTimestampMs}`) ?? []), r]);
    const ties = [...byInstant.values()].filter((g) => g.length > 1);
    expect(ties.length).toBeGreaterThanOrEqual(2);
    for (const g of ties) expect(new Set(g.map((r) => r.createdAt.getTime())).size).toBe(g.length);
  });
});
