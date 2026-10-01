import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseStoreKitConfig, STOREKIT_MAX_PRODUCTS, StoreKitParseError } from "../src/storekit.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/storekit/${name}`, import.meta.url), "utf8");

describe("parseStoreKitConfig", () => {
  it("reads every product type of an Xcode 16 (format 4) file", () => {
    const c = parseStoreKitConfig(fixture("Scanner.storekit"));
    expect(c.formatVersion).toBe(4);
    expect(c.storefront).toBe("USA");
    expect(c.locale).toBe("en_US");
    expect(c.warnings).toEqual([]);
    expect(c.products.map((p) => [p.productId, p.type])).toEqual([
      ["com.example.scanner.credits100", "consumable"],
      ["com.example.scanner.lifetime", "non_consumable"],
      ["com.example.scanner.pro.monthly", "subscription"],
      ["com.example.scanner.pro.yearly", "subscription"],
      ["com.example.scanner.season", "non_renewing_subscription"],
    ]);
    const monthly = c.products.find((p) => p.productId === "com.example.scanner.pro.monthly")!;
    expect(monthly).toMatchObject({ price: 9.99, duration: "P1M", group: "Pro", groupLevel: 2, displayName: "Pro Monthly", promotionalOffers: 1, offerCodes: 0 });
    expect(monthly.introOffer).toEqual({ mode: "free_trial", period: "P1W", periods: 1, price: 0 });
    const yearly = c.products.find((p) => p.productId === "com.example.scanner.pro.yearly")!;
    expect(yearly.introOffer).toEqual({ mode: "pay_as_you_go", period: "P1M", periods: 2, price: 1.99 });
    expect(yearly.offerCodes).toBe(1);
    const credits = c.products.find((p) => p.productId === "com.example.scanner.credits100")!;
    expect(credits).toMatchObject({ price: 0.99, duration: null, group: null, locales: ["en_US", "fr"], displayName: "100 Credits" });
    expect(c.products.find((p) => p.productId === "com.example.scanner.lifetime")!.familyShareable).toBe(true);
    expect(c.groups).toEqual([{ id: "21582731", name: "Pro", products: ["com.example.scanner.pro.monthly", "com.example.scanner.pro.yearly"] }]);
  });

  it("reads a format 1 file, skips duplicates and says so", () => {
    const c = parseStoreKitConfig(fixture("Legacy-v1.storekit"));
    expect(c.formatVersion).toBe(1);
    expect(c.storefront).toBeNull();
    expect(c.products.map((p) => p.productId)).toEqual(["com.example.noads", "com.example.premium.weekly"]);
    expect(c.products[1]).toMatchObject({ duration: "P1W", introOffer: null, price: 4.99 });
    expect(c.warnings).toEqual(["com.example.premium.weekly appears twice; the second one is skipped."]);
  });

  it("accepts a byte order mark", () => {
    expect(parseStoreKitConfig(`﻿${fixture("Legacy-v1.storekit")}`).products).toHaveLength(2);
  });

  it("refuses files that are not StoreKit configurations", () => {
    expect(() => parseStoreKitConfig("not json")).toThrow(StoreKitParseError);
    expect(() => parseStoreKitConfig(JSON.stringify({ name: "package.json" }))).toThrow(/no products/);
  });

  it("warns about entries it cannot read instead of failing", () => {
    const c = parseStoreKitConfig(JSON.stringify({
      products: [{ type: "Consumable" }, { productID: "x", type: "Mystery" }, 3],
      subscriptionGroups: [{ name: "G", subscriptions: [{ productID: "s", type: "RecurringSubscription", recurringSubscriptionPeriod: "monthly" }] }],
    }));
    expect(c.products.map((p) => p.productId)).toEqual(["s"]);
    expect(c.products[0]!.duration).toBeNull();
    expect(c.warnings).toEqual([
      "products[0]: skipped a product with no productID.",
      "x: unknown type \"Mystery\", skipped.",
      "products[2]: skipped an entry that is not an object.",
      "s: no valid recurringSubscriptionPeriod.",
    ]);
  });
  it("never reads Object.prototype for a type or offer mode named in the file", () => {
    const c = parseStoreKitConfig(JSON.stringify({
      products: [{ productID: "a", type: "constructor" }, { productID: "b", type: "Consumable", introductoryOffer: { paymentMode: "__proto__" } }],
    }));
    expect(c.products.map((p) => [p.productId, p.type, p.introOffer])).toEqual([["b", "consumable", null]]);
    expect(c.warnings).toEqual(["a: unknown type \"constructor\", skipped."]);
  });

  it("keeps at most 500 products and 50 warnings, and says what it left out", () => {
    const c = parseStoreKitConfig(JSON.stringify({ products: [...Array.from({ length: 700 }, (_, i) => ({ productID: `p${i}`, type: "Consumable", referenceName: "x".repeat(5000) })), ...Array.from({ length: 80 }, () => 1)] }));
    expect(c.products).toHaveLength(STOREKIT_MAX_PRODUCTS);
    expect(c.products[0]!.referenceName.length).toBe(300);
    expect(c.warnings).toHaveLength(52);
    expect(c.warnings.slice(-2)).toEqual(["30 more warnings are not listed.", "Only the first 500 products are read; 200 more are left out."]);
  });
});
