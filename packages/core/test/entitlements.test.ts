import { describe, expect, it } from "vitest";
import { computeEntitlements, productKeysFor, type CustomerState, type Subscription } from "../src/index.js";

const now = new Date("2026-09-01T12:00:00Z");
const sub = (over: Partial<Subscription>): Subscription => ({
  productIdentifier: "max", store: "app_store", isSandbox: false, purchaseDate: now, originalPurchaseDate: now,
  expiresDate: new Date(now.getTime() + 86_400_000), periodType: "normal", ...over,
});
const state = (s: Subscription): CustomerState => ({
  originalAppUserId: "u", firstSeen: now, lastSeen: now, originalApplicationVersion: null, originalPurchaseDate: now, attributes: {}, subscriptions: [s], nonSubscriptions: [],
});
const ents = (s: Subscription, map: Record<string, string[]>) => computeEntitlements(state(s), map).map((e) => e.identifier).sort();

describe("productKeysFor: the catalog identifiers a subscription matches", () => {
  it("a plan matches product:plan, then the bare product (Play base plans, App Store billing plans)", () => {
    expect(productKeysFor({ store: "play_store", productIdentifier: "pro", productPlanIdentifier: "monthly" })).toEqual(["pro:monthly", "pro"]);
    expect(productKeysFor({ store: "app_store", productIdentifier: "max", productPlanIdentifier: "monthly" })).toEqual(["max:monthly", "max"]);
  });

  it("an App Store purchase without a billing plan also matches product:upFront, which iOS files under the bare id", () => {
    expect(productKeysFor({ store: "app_store", productIdentifier: "max" })).toEqual(["max", "max:upFront"]);
    expect(productKeysFor({ store: "mac_app_store", productIdentifier: "max", productPlanIdentifier: null })).toEqual(["max", "max:upFront"]);
    expect(productKeysFor({ store: "play_store", productIdentifier: "legacy" })).toEqual(["legacy"]);
    expect(productKeysFor({ store: "stripe", productIdentifier: "prod_1" })).toEqual(["prod_1"]);
  });
});

describe("computeEntitlements with App Store billing plans", () => {
  const map = { max: ["max:monthly", "max:upFront"], pro: ["max:upFront"], plus: ["plus"] };

  it("a monthly purchase unlocks product:monthly; an up-front or older purchase unlocks product:upFront", () => {
    expect(ents(sub({ productPlanIdentifier: "monthly" }), map)).toEqual(["max"]);
    expect(ents(sub({}), map)).toEqual(["max", "pro"]);
  });

  it("a bare product keeps unlocking for any plan", () => {
    expect(ents(sub({ productIdentifier: "plus", productPlanIdentifier: "monthly" }), map)).toEqual(["plus"]);
    expect(ents(sub({ productIdentifier: "plus" }), map)).toEqual(["plus"]);
  });

  it("product:upFront is App Store only", () => {
    expect(ents(sub({ store: "play_store" }), map)).toEqual([]);
  });
});
