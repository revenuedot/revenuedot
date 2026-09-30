import { describe, expect, it } from "vitest";
import { diffSubscription, type Subscription } from "../src/index.js";

const day = 86_400_000;
const base = new Date("2026-01-01T00:00:00Z");
const sub = (over: Partial<Subscription>): Subscription => ({
  productIdentifier: "pro_monthly", store: "app_store", isSandbox: false, purchaseDate: base, originalPurchaseDate: base,
  expiresDate: new Date(+base + 7 * day), periodType: "trial", storeTransactionId: "t1", ...over,
});

describe("diffSubscription RENEWAL", () => {
  it("flags the first paid period after a trial as a trial conversion", () => {
    const prev = sub({});
    const next = sub({ periodType: "normal", purchaseDate: new Date(+base + 7 * day), expiresDate: new Date(+base + 37 * day), storeTransactionId: "t2" });
    expect(diffSubscription(prev, next, new Date(+base + 8 * day))).toEqual([{ type: "RENEWAL", isTrialConversion: true }]);
  });

  it("does not flag an ordinary renewal", () => {
    const prev = sub({ periodType: "normal" });
    const next = sub({ periodType: "normal", purchaseDate: new Date(+base + 7 * day), expiresDate: new Date(+base + 14 * day), storeTransactionId: "t2" });
    expect(diffSubscription(prev, next, new Date(+base + 8 * day))).toEqual([{ type: "RENEWAL", isTrialConversion: false }]);
  });
});
