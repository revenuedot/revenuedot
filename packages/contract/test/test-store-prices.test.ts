// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: Test Store prices by currency (prd/catalog/PRD.md "Test Store prices by currency"). The v2 endpoints take and
// return the bodies RevenueCat's CLI sends and decodes (github.com/RevenueCat/cli internal/api/products.go): POST
// …/test_store_prices `{ prices: [{ currency, amount_micros }] }`, GET …/prices a bare array of `{ id, currency,
// amount_micros }`, PATCH …/prices/{currency} `{ amount_micros }`. The SDK's Test Store products and purchases use the
// price in the customer's currency.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const PRODUCT = "/v2/projects/{project_id}/products/{product_id}";
const PRICES = `${PRODUCT}/prices`;
const CREATE = `${PRODUCT}/test_store_prices`;
const ONE = `${PRODUCT}/prices/{currency}`;
const ext = { ext: true };
const amounts = (items: Array<{ currency: string; amount_micros: number }>) => items.map((p) => [p.currency, p.amount_micros]);
const indicative = async (id: string) => (await call("GET", PRODUCT, { product_id: id }, { query: "expand=indicative_price" })).body.indicative_price;

describe("v2 Test Store prices", () => {
  it("creates, lists (also through the deprecated alias), updates and the default stays the product's indicative_price", async () => {
    expect((await call("GET", PRICES, { product_id: "p4" }, ext)).body).toEqual([]);
    const created = await call("POST", CREATE, { product_id: "p4" }, { ...ext, json: { prices: [{ currency: "eur", amount_micros: 8_990_000 }, { currency: "USD", amount_micros: 9_990_000 }] } });
    expect(created.status).toBe(201);
    expect(amounts(created.body)).toEqual([["EUR", 8_990_000], ["USD", 9_990_000]]);
    expect(created.body[0].id).toMatch(/^prc/);
    // No price before: USD becomes the default.
    expect(await indicative("p4")).toMatchObject({ currency: "USD", amount_micros: 9_990_000 });
    const list = await call("GET", PRICES, { product_id: "p4" }, ext);
    expect(list.status).toBe(200);
    expect(list.body.map((p: any) => Object.keys(p).sort())).toEqual([["amount_micros", "currency", "id"], ["amount_micros", "currency", "id"]]);
    expect(amounts(list.body)).toEqual([["USD", 9_990_000], ["EUR", 8_990_000]]);
    expect((await call("GET", CREATE, { product_id: "p4" }, ext)).body).toEqual(list.body);

    const eur = await call("PATCH", ONE, { product_id: "p4", currency: "eur" }, { ...ext, json: { amount_micros: 7_490_000 } });
    expect(eur.status).toBe(200);
    expect(eur.body).toEqual({ id: list.body[1].id, currency: "EUR", amount_micros: 7_490_000 });
    await call("PATCH", ONE, { product_id: "p4", currency: "USD" }, { ...ext, json: { amount_micros: 10_990_000 } });
    expect(await indicative("p4")).toMatchObject({ currency: "USD", amount_micros: 10_990_000 });
    // Creating an existing currency sets its amount; a new one is added.
    await call("POST", CREATE, { product_id: "p4" }, { ...ext, json: { prices: [{ currency: "EUR", amount_micros: 6_990_000 }, { currency: "GBP", amount_micros: 5_990_000 }] } });
    expect(amounts((await call("GET", PRICES, { product_id: "p4" }, ext)).body)).toEqual([["USD", 10_990_000], ["EUR", 6_990_000], ["GBP", 5_990_000]]);
  });

  it("refuses other stores, unknown currencies, duplicates and a currency the product has no price in", async () => {
    const ios = await call("POST", CREATE, { product_id: "p1" }, { ...ext, json: { prices: [{ currency: "USD", amount_micros: 1 }] } });
    expect(ios.status).toBe(400);
    expect(ios.body).toMatchObject({ type: "parameter_error", message: expect.stringContaining("Test Store") });
    expect((await call("PATCH", ONE, { product_id: "p1", currency: "USD" }, { ...ext, json: { amount_micros: 1 } })).status).toBe(400);
    expect((await call("GET", PRICES, { product_id: "p1" }, ext)).status).toBe(400);
    expect((await call("GET", PRICES, { product_id: "nope" }, ext)).status).toBe(404);
    const bad = async (json: unknown) => (await call("POST", CREATE, { product_id: "p4" }, { ...ext, json })).status;
    expect(await bad({ prices: [] })).toBe(400);
    expect(await bad({ prices: [{ currency: "XYZ", amount_micros: 1 }] })).toBe(400);
    expect(await bad({ prices: [{ currency: "USD", amount_micros: 1.5 }] })).toBe(400);
    expect(await bad({ prices: [{ currency: "USD", amount_micros: 1 }, { currency: "usd", amount_micros: 2 }] })).toBe(400);
    expect((await call("PATCH", ONE, { product_id: "p4", currency: "GBP" }, { ...ext, json: { amount_micros: 1 } })).status).toBe(404);
    expect((await call("PATCH", ONE, { product_id: "p4", currency: "dollars" }, { ...ext, json: { amount_micros: 1 } })).status).toBe(400);
    expect((await h.db.select().from(schema.productPrices))).toEqual([]);
  });

  it("a read-only key lists but cannot write", async () => {
    const { createSecretKey } = await import("@revenuedot/server/services/auth.js");
    const ro = (await createSecretKey(h.db, h.ids.project, "ro", ["project_configuration:products:read"])).key;
    expect((await call("GET", PRICES, { product_id: "p4" }, { ...ext, key: ro })).status).toBe(200);
    expect((await call("POST", CREATE, { product_id: "p4" }, { ...ext, key: ro, json: { prices: [{ currency: "USD", amount_micros: 1 }] } })).status).toBe(403);
  });

  it("test_store_price on product update sets the default and keeps the other currencies; null clears every price", async () => {
    await call("POST", CREATE, { product_id: "p4" }, { ...ext, json: { prices: [{ currency: "USD", amount_micros: 9_990_000 }, { currency: "EUR", amount_micros: 8_990_000 }] } });
    await call("POST", PRODUCT, { product_id: "p4" }, { json: { test_store_price: { amount_micros: 7_990_000, currency: "EUR" } } });
    expect(await indicative("p4")).toMatchObject({ currency: "EUR", amount_micros: 7_990_000 });
    expect(amounts((await call("GET", PRICES, { product_id: "p4" }, ext)).body)).toEqual([["EUR", 7_990_000], ["USD", 9_990_000]]);
    await call("POST", PRODUCT, { product_id: "p4" }, { json: { test_store_price: null } });
    expect(await indicative("p4")).toBeNull();
    expect((await call("GET", PRICES, { product_id: "p4" }, ext)).body).toEqual([]);
  });

  it("a price set before prices by currency existed is listed, kept when the default changes currency, and editable", async () => {
    await h.db.update(schema.products).set({ testStorePriceMicros: 4_990_000, testStorePriceCurrency: "USD" }).where(eq(schema.products.id, "p4"));
    expect((await call("GET", PRICES, { product_id: "p4" }, ext)).body).toEqual([{ id: null, currency: "USD", amount_micros: 4_990_000 }]);
    expect((await call("PATCH", ONE, { product_id: "p4", currency: "USD" }, { ...ext, json: { amount_micros: 5_990_000 } })).body).toMatchObject({ id: expect.stringMatching(/^prc/), amount_micros: 5_990_000 });
    await h.db.update(schema.products).set({ testStorePriceMicros: 3_990_000, testStorePriceCurrency: "USD" }).where(eq(schema.products.id, "p6"));
    await call("POST", PRODUCT, { product_id: "p6" }, { json: { test_store_price: { amount_micros: 2_990_000, currency: "GBP" } } });
    expect(amounts((await call("GET", PRICES, { product_id: "p6" }, ext)).body)).toEqual([["GBP", 2_990_000], ["USD", 3_990_000]]);
  });

  it("DELETE …/prices/{currency} (extension) removes a currency; the default moves to USD, the last one leaves no price", async () => {
    await call("POST", CREATE, { product_id: "p4" }, { ...ext, json: { prices: [{ currency: "GBP", amount_micros: 1_000_000 }, { currency: "EUR", amount_micros: 2_000_000 }, { currency: "USD", amount_micros: 3_000_000 }] } });
    await call("POST", PRODUCT, { product_id: "p4" }, { json: { test_store_price: { amount_micros: 1_000_000, currency: "GBP" } } });
    const del = await call("DELETE", ONE, { product_id: "p4", currency: "GBP" }, ext);
    expect(del.body).toMatchObject({ object: "product_price", id: expect.stringMatching(/^prc/), currency: "GBP", deleted_at: expect.any(Number) });
    expect(await indicative("p4")).toMatchObject({ currency: "USD", amount_micros: 3_000_000 });
    await call("DELETE", ONE, { product_id: "p4", currency: "USD" }, ext);
    expect(await indicative("p4")).toMatchObject({ currency: "EUR" });
    expect((await call("DELETE", ONE, { product_id: "p4", currency: "USD" }, ext)).status).toBe(404);
    await call("DELETE", ONE, { product_id: "p4", currency: "EUR" }, ext);
    expect(await indicative("p4")).toBeNull();
  });

  it("PATCH and DELETE of one price are in the audit log as product_price_updated and product_price_deleted", async () => {
    await call("POST", CREATE, { product_id: "p4" }, { ...ext, json: { prices: [{ currency: "USD", amount_micros: 1_000_000 }, { currency: "EUR", amount_micros: 2_000_000 }] } });
    h.setNow(new Date(h.now().getTime() + 1000));
    await call("PATCH", ONE, { product_id: "p4", currency: "EUR" }, { ...ext, json: { amount_micros: 3_000_000 } });
    h.setNow(new Date(h.now().getTime() + 1000));
    await call("DELETE", ONE, { product_id: "p4", currency: "EUR" }, ext);
    const log = await call("GET", "/v2/projects/{project_id}/audit_logs");
    expect(log.body.items.slice(0, 2).map((x: any) => [x.action_type, x.target_type, x.target_identifier]))
      .toEqual([["product_price_deleted", "product", "p4"], ["product_price_updated", "product", "p4"]]);
  });

  it("GET …/prices on a Stripe web product lists its Stripe price; JPY has no minor unit", async () => {
    await h.db.insert(schema.apps).values({ id: "app_stripe", projectId: h.ids.project, name: "Web", type: "stripe", publicKey: "strp_prices" });
    await h.db.insert(schema.products).values({ id: "p_web", projectId: h.ids.project, appId: "app_stripe", storeIdentifier: "price_1Web", type: "subscription", duration: "P1M" });
    await h.db.insert(schema.webProducts).values({ productId: "p_web", projectId: h.ids.project, appId: "app_stripe", stripeProductId: "prod_W", stripePriceId: "price_1Web", amountMinor: 1200, currency: "jpy", interval: "month", intervalCount: 1 });
    const r = await call("GET", PRICES, { product_id: "p_web" }, ext);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: "price_1Web", currency: "JPY", amount_micros: 1_200_000_000 }]);
    expect((await call("POST", CREATE, { product_id: "p_web" }, { ...ext, json: { prices: [{ currency: "USD", amount_micros: 1 }] } })).status).toBe(400);
  });

  it("deleting the product deletes its prices", async () => {
    await call("POST", CREATE, { product_id: "p4" }, { ...ext, json: { prices: [{ currency: "USD", amount_micros: 1 }] } });
    await call("DELETE", PRODUCT, { product_id: "p4" });
    expect(await h.db.select().from(schema.productPrices)).toEqual([]);
  });
});

describe("the SDK sees the price in the customer's currency", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/ios/resp-web-billing-products.json", import.meta.url), "utf8")).product_details[0];
  const products = async (path: string, headers: Record<string, string> = {}) => {
    const res = await h.fetch(path, { key: h.ids.testKey, headers });
    expect(res.status).toBe(200);
    const body = await res.json() as { product_details: any[] };
    const p = body.product_details.find((x) => x.identifier === "pro_monthly")!;
    expect(Object.keys(p).sort()).toEqual(Object.keys(fixture).sort());
    expect(p.current_price).toEqual(p.purchase_options.base.base.price);
    return p.current_price;
  };
  beforeEach(async () => {
    await call("POST", CREATE, { product_id: "p4" }, { ...ext, json: { prices: [{ currency: "USD", amount_micros: 9_990_000 }, { currency: "EUR", amount_micros: 8_990_000 }, { currency: "GBP", amount_micros: 7_990_000 }] } });
  });

  it("from the storefront header (alpha-3 on iOS, alpha-2 on Android), the currency purchases-js asks for, else the default", async () => {
    expect(await products("/rcbilling/v1/subscribers/u1/products?id=pro_monthly", { "x-storefront": "DEU" })).toEqual({ amount: 8.99, amount_micros: 8_990_000, currency: "EUR" });
    expect(await products("/rcbilling/v1/subscribers/u1/products?id=pro_monthly", { "x-storefront": "GB" })).toMatchObject({ currency: "GBP", amount_micros: 7_990_000 });
    expect(await products("/rcbilling/v1/subscribers/u1/products?id=pro_monthly&currency=GBP", { "x-storefront": "FRA" })).toMatchObject({ currency: "GBP" });
    // No JPY price: the default.
    expect(await products("/rcbilling/v1/subscribers/u1/products?id=pro_monthly", { "x-storefront": "JPN" })).toMatchObject({ currency: "USD", amount_micros: 9_990_000 });
    expect(await products("/rcbilling/v1/subscribers/u1/products?id=pro_monthly")).toMatchObject({ currency: "USD" });
  });

  it("without a storefront, the country the customer was last seen in", async () => {
    await h.fetch("/v1/subscribers/fr_user", { key: h.ids.testKey, headers: { "x-storefront": "FRA" } });
    expect(await products("/rcbilling/v1/subscribers/fr_user/products?id=pro_monthly")).toMatchObject({ currency: "EUR" });
  });

  it("a purchases-js receipt without a price records the price in its currency; a native receipt records what it sent", async () => {
    const receipt = (user: string, extra: Record<string, unknown>) => h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: {
      fetch_token: `test_${h.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", app_user_id: user, is_restore: false, ...extra,
    } });
    expect((await receipt("web_eur", { price: null, currency: "EUR" })).status).toBe(200);
    expect((await receipt("native_gbp", { price: 7.99, currency: "GBP", store_country: "GBR" })).status).toBe(200);
    const rows = await h.db.select().from(schema.transactions);
    expect(rows.map((t) => [t.priceAmount, t.priceCurrency]).sort()).toEqual([[7.99, "GBP"], [8.99, "EUR"]]);
  });

  it("POST /v2/projects/{id}/test_purchases without a price charges the price in `currency`", async () => {
    const r = await call("POST", "/v2/projects/{project_id}/test_purchases", {}, { ...ext, json: { app_user_id: "tp_eur", product_id: "pro_monthly", currency: "EUR" } });
    expect(r.status).toBe(201);
    const [t] = await h.db.select().from(schema.transactions);
    expect([t!.priceAmount, t!.priceCurrency]).toEqual([8.99, "EUR"]);
  });
});
