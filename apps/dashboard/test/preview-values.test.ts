import { describe, expect, it } from "vitest";
import { parsePeriod, previewProducts, productValues } from "../src/pages/paywalls/preview-values";
import { testStorePrice } from "../src/pages/catalog/lib";

describe("paywall preview values", () => {
  it("falls back to sample prices by package identifier", () => {
    const v = productValues("$rc_monthly");
    expect(v["product.price"]).toBe("$6.99");
    expect(v["product.price_per_period"]).toBe("$6.99/month");
    expect(v["product.price_per_period_abbreviated"]).toBe("$6.99/mo");
    expect(productValues("$rc_annual")["product.price_per_period"]).toBe("$39.99/year");
    expect(productValues("$rc_lifetime")["product.price_per_period"]).toBe("$99.99");
    expect(productValues("$rc_lifetime")["product.period_with_unit"]).toBe("lifetime");
  });

  it("uses the real Test Store price, currency, duration and name", () => {
    const real = { $rc_monthly: { price: { amount: 9.99, currency: "USD" }, duration: "P1M", name: "Pro monthly" }, $rc_annual: { price: { amount: 59.99, currency: "USD" }, duration: "P1Y", name: "Pro yearly" } };
    const m = productValues("$rc_monthly", real, ["$rc_monthly", "$rc_annual"]);
    expect(m["product.price"]).toBe("$9.99");
    expect(m["product.price_per_period"]).toBe("$9.99/month");
    expect(m["product.store_product_name"]).toBe("Pro monthly");
    expect(m["product.relative_discount"]).toBe("");
    const a = productValues("$rc_annual", real, ["$rc_monthly", "$rc_annual"]);
    expect(a["product.price_per_period_abbreviated"]).toBe("$59.99/yr");
    expect(a["product.price_per_month"]).toBe("$4.93");
    // 59.99 a year is 4.93 a month against 9.99: 51% less.
    expect(a["product.relative_discount"]).toBe("51%");
    const eur = productValues("custom", { custom: { price: { amount: 2.99, currency: "EUR" }, duration: "P1W" } });
    expect(eur["product.price_per_period"]).toBe("€2.99/week");
    expect(eur["product.currency_code"]).toBe("EUR");
    expect(eur["product.currency_symbol"]).toBe("€");
  });

  it("a known duration wins over the package identifier; a one-time product is lifetime", () => {
    expect(productValues("$rc_monthly", { $rc_monthly: { price: { amount: 19.99, currency: "USD" }, duration: "P3M" } })["product.price_per_period"]).toBe("$19.99/3 months");
    expect(productValues("$rc_annual", { $rc_annual: { price: { amount: 49, currency: "USD" }, duration: null } })["product.price_per_period"]).toBe("$49.00");
    // No price known: the sample price with the real duration.
    expect(productValues("$rc_monthly", { $rc_monthly: { price: null, duration: "P1W" } })["product.price_per_period"]).toBe("$6.99/week");
  });

  it("the intro offer uses the product's trial length when known", () => {
    expect(productValues("$rc_monthly")["product.offer_period_with_unit"]).toBe("1 week");
    const v = productValues("$rc_monthly", { $rc_monthly: { trial: "P3D" } });
    expect(v["product.offer_period_with_unit"]).toBe("3 days");
    expect(v["product.offer_end_date"]).toBe("in 3 days");
  });

  it("parses ISO periods", () => {
    expect(parsePeriod("P1M")).toEqual({ n: 1, unit: "month", days: 30 });
    expect(parsePeriod("P12M")).toEqual({ n: 1, unit: "year", days: 365 });
    expect(parsePeriod("P2W")).toEqual({ n: 2, unit: "week", days: 14 });
    expect(parsePeriod("P1Y6M")?.unit).toBe("day");
    expect(parsePeriod("P")).toBeNull();
    expect(parsePeriod("bad")).toBeNull();
  });

  it("maps an offering's packages to their priced products", () => {
    const offering = { packages: { items: [
      { lookup_key: "$rc_monthly", products: { items: [{ product: { id: "ios" } }, { product: { id: "ts" } }] } },
      { lookup_key: "$rc_lifetime", products: { items: [{ product: { id: "life" } }] } },
      { lookup_key: "empty", products: { items: [] } },
    ] } };
    const products = [
      { id: "ios", type: "subscription", display_name: "Pro (iOS)", subscription: { duration: "P1M" }, indicative_price: null },
      { id: "ts", type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M", trial_duration: null }, indicative_price: { amount_micros: 9_990_000, currency: "USD" } },
      { id: "life", type: "non_consumable", display_name: "Lifetime", indicative_price: { amount_micros: 149_000_000, currency: "USD" } },
    ];
    const out = previewProducts(offering, products);
    expect(out.$rc_monthly).toEqual({ price: { amount: 9.99, currency: "USD" }, duration: "P1M", name: "Pro monthly", trial: null });
    expect(out.$rc_lifetime).toEqual({ price: { amount: 149, currency: "USD" }, duration: null, name: "Lifetime", trial: null });
    expect(out.empty).toBeUndefined();
    expect(productValues("$rc_lifetime", out)["product.price"]).toBe("$149.00");
  });
});

describe("Test Store price field", () => {
  it("requires a price above zero for new Test Store products", () => {
    expect(testStorePrice("", "USD", true)).toEqual({ error: expect.stringContaining("Enter the price") });
    expect(testStorePrice("0", "USD", true)).toEqual({ error: expect.stringContaining("above 0") });
    expect(testStorePrice("9.99", "usd", true)).toEqual({ value: { amount_micros: 9_990_000, currency: "USD" } });
    expect(testStorePrice("9,99", "USD", true)).toEqual({ error: expect.stringContaining("dot") });
    expect(testStorePrice("-1", "USD", true)).toHaveProperty("error");
    expect(testStorePrice("9.99", "US", true)).toEqual({ error: expect.stringContaining("three-letter") });
    expect(testStorePrice("2000000", "USD", true)).toEqual({ error: expect.stringContaining("1,000,000") });
  });
  it("is optional when editing: empty means no price, 0 is allowed", () => {
    expect(testStorePrice("", "USD")).toEqual({ value: null });
    expect(testStorePrice("0", "EUR")).toEqual({ value: { amount_micros: 0, currency: "EUR" } });
  });
});
