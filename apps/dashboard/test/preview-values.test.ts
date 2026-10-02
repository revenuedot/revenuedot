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
    // A one-time product has no period words, as on devices; its offer price is its price.
    expect(productValues("$rc_lifetime")["product.period_with_unit"]).toBe("");
    expect(productValues("$rc_lifetime")["product.periodly"]).toBe("");
    expect(productValues("$rc_lifetime")["product.offer_price"]).toBe("$99.99");
    expect(productValues("$rc_lifetime")["product.offer_period"]).toBe("");
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
    // The SDKs' math: a year is 12 months, rounded down to cents. 59.99 a year is 4.99 a month against 9.99: 50% less.
    expect(a["product.price_per_month"]).toBe("$4.99");
    expect(a["product.relative_discount"]).toBe("50%");
    expect(m["product.price_per_year"]).toBe("$119.88");
    expect(m["product.price_per_week"]).toBe("$2.29");
    expect(m["product.price_per_day"]).toBe("$0.33");
    expect(productValues("w", { w: { price: { amount: 2.99, currency: "USD" }, duration: "P1W" } })["product.price_per_month"]).toBe("$12.99");
    const eur = productValues("custom", { custom: { price: { amount: 2.99, currency: "EUR" }, duration: "P1W" } });
    expect(eur["product.price_per_period"]).toBe("€2.99/week");
    expect(eur["product.currency_code"]).toBe("EUR");
    expect(eur["product.currency_symbol"]).toBe("€");
  });

  it("a known duration wins over the package identifier; a one-time product is lifetime", () => {
    const q = productValues("$rc_monthly", { $rc_monthly: { price: { amount: 19.99, currency: "USD" }, duration: "P3M" } });
    expect(q["product.price_per_period"]).toBe("$19.99/3 months");
    expect(q["product.price_per_period_abbreviated"]).toBe("$19.99/3mo");
    expect(q["product.period"]).toBe("3 months");
    expect(q["product.periodly"]).toBe("3 months");
    expect(q["product.period_in_months"]).toBe("3");
    expect(q["product.period_in_weeks"]).toBe("13");
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

  it("compares real prices with real ones only, follows the paywall's language and the currency's decimals", () => {
    // Only the annual package has a Test Store price: no discount against the invented monthly sample.
    const one = { $rc_annual: { price: { amount: 59.99, currency: "USD" }, duration: "P1Y" } };
    expect(productValues("$rc_annual", one, ["$rc_monthly", "$rc_annual"])["product.relative_discount"]).toBe("");
    // Samples are still compared with samples.
    expect(productValues("$rc_annual", undefined, ["$rc_monthly", "$rc_annual"])["product.relative_discount"]).toBe("52%");
    const es = productValues("$rc_monthly", undefined, undefined, "es_ES");
    expect(es["product.price_per_period"]).toBe("$6.99/mes");
    expect(es["product.periodly"]).toBe("mensual");
    const yen = productValues("j", { j: { price: { amount: 1200, currency: "JPY" }, duration: "P1M" } });
    expect(yen["product.price"]).toBe("¥1,200");
    expect(yen["product.price_per_week"]).toBe("¥276");
    // A malformed currency does not throw.
    expect(productValues("x", { x: { price: { amount: 1.5, currency: "us" }, duration: "P1M" } })["product.price"]).toBe("US 1.50");
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
      { id: "ios", type: "subscription", store_identifier: "pro_ios", display_name: "Pro (iOS)", subscription: { duration: "P1M" }, indicative_price: null },
      { id: "ts", type: "subscription", store_identifier: "pro_monthly", display_name: "Pro monthly", subscription: { duration: "P1M", trial_duration: null }, indicative_price: { amount_micros: 9_990_000, currency: "USD" } },
      { id: "life", type: "non_consumable", store_identifier: "pro_life", display_name: "Lifetime", indicative_price: { amount_micros: 149_000_000, currency: "USD" } },
    ];
    const out = previewProducts(offering, products);
    expect(out.$rc_monthly).toEqual({ price: { amount: 9.99, currency: "USD" }, duration: "P1M", name: "Pro monthly", trial: null });
    expect(out.$rc_lifetime).toEqual({ price: { amount: 149, currency: "USD" }, duration: null, name: "Lifetime", trial: null });
    expect(out.empty).toBeUndefined();
    expect(productValues("$rc_lifetime", out)["product.price"]).toBe("$149.00");
    // As the server sends Test Store products to the SDK: no stored duration is monthly, a consumable has no period, and
    // a missing display name is the store identifier.
    const sdk = previewProducts({ packages: { items: [
      { lookup_key: "$rc_annual", products: { items: [{ product: { id: "nodur" } }] } },
      { lookup_key: "$rc_monthly", products: { items: [{ product: { id: "coins" } }] } },
    ] } }, [
      { id: "nodur", type: "subscription", store_identifier: "pro_x", display_name: null, subscription: { duration: null }, indicative_price: { amount_micros: 4_990_000, currency: "USD" } },
      { id: "coins", type: "consumable", store_identifier: "coins_100", display_name: null, indicative_price: { amount_micros: 990_000, currency: "USD" } },
    ]);
    expect(sdk.$rc_annual).toMatchObject({ duration: "P1M", name: "pro_x" });
    expect(productValues("$rc_annual", sdk)["product.price_per_period"]).toBe("$4.99/month");
    expect(productValues("$rc_monthly", sdk)["product.price_per_period"]).toBe("$0.99");
  });
});

describe("Test Store price field", () => {
  it("requires a price above zero for new Test Store products", () => {
    expect(testStorePrice("", "USD", true)).toEqual({ error: expect.stringContaining("Enter the price"), field: "amount" });
    expect(testStorePrice("0", "USD", true)).toEqual({ error: expect.stringContaining("above 0"), field: "amount" });
    expect(testStorePrice("9.99", "usd", true)).toEqual({ value: { amount_micros: 9_990_000, currency: "USD" } });
    expect(testStorePrice("-1", "USD", true)).toEqual({ error: "A price cannot be negative.", field: "amount" });
    expect(testStorePrice("9.99", "US", true)).toEqual({ error: expect.stringContaining("three-letter"), field: "currency" });
  });
  it("reads a decimal comma, refuses an ambiguous one, and checks the currency's decimals and code", () => {
    // What an iPhone's decimal keypad types in a comma-decimal region.
    expect(testStorePrice("4,99", "EUR", true)).toEqual({ value: { amount_micros: 4_990_000, currency: "EUR" } });
    expect(testStorePrice("1,000", "USD", true)).toEqual({ error: expect.stringContaining("dot"), field: "amount" });
    expect(testStorePrice("9.999", "USD", true)).toEqual({ error: "Use at most 2 decimals for USD.", field: "amount" });
    expect(testStorePrice("4.99", "JPY", true)).toEqual({ error: "JPY has no decimals. Enter a whole amount.", field: "amount" });
    expect(testStorePrice("1200", "JPY", true)).toEqual({ value: { amount_micros: 1_200_000_000, currency: "JPY" } });
    expect(testStorePrice("1.234", "KWD", true)).toEqual({ value: { amount_micros: 1_234_000, currency: "KWD" } });
    expect(testStorePrice("9.99", "XYZ", true)).toEqual({ error: expect.stringContaining("not a currency code"), field: "currency" });
  });
  it("allows IDR and VND prices up to the server's limit", () => {
    expect(testStorePrice("1199000", "IDR", true)).toEqual({ value: { amount_micros: 1_199_000_000_000, currency: "IDR" } });
    expect(testStorePrice("2000000000", "USD", true)).toEqual({ error: expect.stringContaining("1,000,000,000"), field: "amount" });
  });
  it("is optional when editing: empty means no price, 0 is allowed", () => {
    expect(testStorePrice("", "USD")).toEqual({ value: null });
    expect(testStorePrice("0", "EUR")).toEqual({ value: { amount_micros: 0, currency: "EUR" } });
  });
});
