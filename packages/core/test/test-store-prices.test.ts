// Test Store prices by currency (prd/catalog/PRD.md "Test Store prices by currency"): which price a customer sees.
import { describe, expect, it } from "vitest";
import { currencyOfCountry, nextDefault, pickPrice, priceList } from "../src/test-store-prices.js";

const usd = { currency: "USD", amount_micros: 9_990_000 }, eur = { currency: "EUR", amount_micros: 8_990_000 }, gbp = { currency: "GBP", amount_micros: 7_990_000 };

describe("currencyOfCountry", () => {
  it("knows the euro area, shared currencies and single-country currencies", () => {
    expect(["DE", "fr", "HR", "XK"].map(currencyOfCountry)).toEqual(["EUR", "EUR", "EUR", "EUR"]);
    expect(["US", "EC", "PR", "GB", "JP", "CH", "LI", "SN", "BR", "IN", "KR"].map(currencyOfCountry)).toEqual(["USD", "USD", "USD", "GBP", "JPY", "CHF", "CHF", "XOF", "BRL", "INR", "KRW"]);
    // Bulgaria has used the euro since 2026-01-01; Curaçao and Sint Maarten the Caribbean guilder (XCG) since 2025-03-31.
    expect(["BG", "CW", "SX"].map(currencyOfCountry)).toEqual(["EUR", "XCG", "XCG"]);
    expect([null, "", "ZZ", "DEU"].map(currencyOfCountry)).toEqual([null, null, null, null]);
  });
});

describe("priceList", () => {
  it("puts the default first and the rest by currency, and lists a default that has no row", () => {
    expect(priceList(usd, [gbp, eur, { ...usd }])).toEqual([usd, eur, gbp]);
    expect(priceList({ currency: "usd", amount_micros: 1 }, [gbp])).toEqual([{ currency: "USD", amount_micros: 1 }, gbp]);
    expect(priceList(null, [gbp, eur])).toEqual([eur, gbp]);
    expect(priceList(null, [])).toEqual([]);
  });
});

describe("pickPrice", () => {
  const prices = [usd, eur, gbp];
  it("prefers the asked currency, then the country's currency, then the default", () => {
    expect(pickPrice(prices, { currency: "gbp", country: "DE" })).toBe(gbp);
    expect(pickPrice(prices, { currency: "JPY", country: "DE" })).toBe(eur);
    expect(pickPrice(prices, { country: "JP" })).toBe(usd);
    expect(pickPrice(prices, {})).toBe(usd);
    expect(pickPrice([], { country: "DE" })).toBeNull();
  });
});

describe("nextDefault", () => {
  it("is USD when there is one, else the first currency", () => {
    expect(nextDefault([gbp, eur, usd], "GBP")).toBe(usd);
    expect(nextDefault([usd, gbp, eur], "usd")).toBe(eur);
    expect(nextDefault([usd], "USD")).toBeNull();
  });
});
