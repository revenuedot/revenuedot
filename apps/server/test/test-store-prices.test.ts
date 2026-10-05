// Test Store prices by currency (prd/catalog/PRD.md "Test Store prices by currency"): every write keeps the product's
// default price (`test_store_price_*`, RevenueCat's `indicative_price`) equal to one of its price rows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { openTestDb } from "../../../packages/contract/src/test-db.js";
import { parseWrite } from "../src/routes/v2/audit.js";
import { addPrices, pricesOf, priceFor, removePrice, setDefaultPrice, updatePrice } from "../src/services/test-store-prices.js";

let db: DB, close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await openTestDb());
  await db.insert(schema.projects).values({ id: "proj", name: "P" });
  await db.insert(schema.apps).values({ id: "app", projectId: "proj", name: "Test", type: "test_store", publicKey: "test_k" });
  await db.insert(schema.products).values({ id: "prod", projectId: "proj", appId: "app", storeIdentifier: "monthly" });
});
afterEach(async () => { await close(); });

const product = async () => (await db.select().from(schema.products).where(eq(schema.products.id, "prod")))[0]!;
const state = async () => {
  const p = await product();
  const list = (await pricesOf(db, [p])).get(p.id)!.map((x) => `${x.currency} ${x.amount_micros}`);
  const rows = await db.select().from(schema.productPrices);
  // The default is always a row (or there is no price at all).
  if (p.testStorePriceCurrency) expect(rows.find((r) => r.currency === p.testStorePriceCurrency)?.amountMicros).toBe(p.testStorePriceMicros);
  else expect(rows).toEqual([]);
  return { default: p.testStorePriceCurrency, list };
};

describe("Test Store price writes", () => {
  it("add, set the default, update, remove and clear stay consistent", async () => {
    await addPrices(db, await product(), [{ currency: "EUR", amount_micros: 2 }, { currency: "GBP", amount_micros: 3 }]);
    expect(await state()).toEqual({ default: "EUR", list: ["EUR 2", "GBP 3"] });
    await addPrices(db, await product(), [{ currency: "USD", amount_micros: 1 }]);
    expect(await state()).toEqual({ default: "EUR", list: ["EUR 2", "GBP 3", "USD 1"] });
    await setDefaultPrice(db, await product(), { currency: "USD", amount_micros: 5 });
    expect(await state()).toEqual({ default: "USD", list: ["USD 5", "EUR 2", "GBP 3"] });
    expect(await updatePrice(db, await product(), "JPY", 1)).toBeNull();
    expect(await updatePrice(db, await product(), "USD", 6)).toMatchObject({ currency: "USD", amount_micros: 6 });
    expect(await state()).toEqual({ default: "USD", list: ["USD 6", "EUR 2", "GBP 3"] });
    expect(await removePrice(db, await product(), "USD")).toMatchObject({ currency: "USD", amount_micros: 6, id: expect.stringMatching(/^prc/) });
    expect(await state()).toEqual({ default: "EUR", list: ["EUR 2", "GBP 3"] });
    expect(await removePrice(db, await product(), "USD")).toBeNull();
    await setDefaultPrice(db, await product(), null);
    expect(await state()).toEqual({ default: null, list: [] });
  });

  it("priceFor picks by currency, then country, then the default", async () => {
    await addPrices(db, await product(), [{ currency: "USD", amount_micros: 1 }, { currency: "EUR", amount_micros: 2 }]);
    const prices = (await pricesOf(db, [await product()])).get("prod");
    expect(priceFor(prices, { country: "AT" })?.currency).toBe("EUR");
    expect(priceFor(prices, { country: "JP" })?.currency).toBe("USD");
    expect(priceFor(undefined, { country: "JP" })).toBeNull();
  });
});

describe("audit log entries for prices", () => {
  it("names PATCH and DELETE of one price product_price_updated and product_price_deleted on the product", () => {
    const one = "/v2/projects/proj/products/prod/prices/EUR";
    expect(parseWrite("PATCH", one)).toEqual({ actionType: "product_price_updated", targetType: "product", targetId: "prod" });
    expect(parseWrite("DELETE", one)).toEqual({ actionType: "product_price_deleted", targetType: "product", targetId: "prod" });
    expect(parseWrite("POST", "/v2/projects/proj/products/prod/test_store_prices")).toEqual({ actionType: "product_test_store_price_created", targetType: "product", targetId: "prod" });
  });
});

describe("concurrent price writes", () => {
  it("two writes at once on a stale product leave the default equal to a row", async () => {
    const stale = await product();
    await Promise.all([
      addPrices(db, stale, [{ currency: "EUR", amount_micros: 2 }]),
      addPrices(db, stale, [{ currency: "USD", amount_micros: 1 }]),
    ]);
    const s = await state();
    expect(s.list).toHaveLength(2);
    expect(["EUR", "USD"]).toContain(s.default);
    expect(await removePrice(db, stale, s.default!)).not.toBeNull();
    expect((await state()).list).toHaveLength(1);
  });
});
