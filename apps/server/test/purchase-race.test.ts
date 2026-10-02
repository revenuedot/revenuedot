// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the same purchase recorded by two requests at once (a web checkout's success page and Stripe's webhook, or
// two receipt posts). Both read "no subscription yet" before either inserts; the second insert used to fail with a
// duplicate key on subscriptions_store_key (a 500 to Stripe). Found by CI's test-postgres run of web-safety.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { getOrCreateCustomer } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import type { VerifiedPurchase } from "../src/stores/types.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00Z");
let h: Harness;
beforeEach(async () => { h = await harness(); h.setNow(new Date(NOW)); });
afterEach(async () => { await h.close(); });

describe("one purchase applied by several requests at once", () => {
  it("records one subscription, one INITIAL_PURCHASE and one transaction, with no error", async () => {
    const user = "racer";
    const { customer } = await getOrCreateCustomer(h.db, "proj1", user, new Date(NOW));
    const purchase = {
      kind: "subscription", store: "stripe", storeKey: "sub_race", productIdentifier: "pro_monthly", isSandbox: true,
      purchaseDate: new Date(NOW), originalPurchaseDate: new Date(NOW), expiresDate: new Date(NOW + 30 * DAY),
      periodType: "normal", ownershipType: "PURCHASED", storeTransactionId: "in_race", originalTransactionId: "sub_race",
      unsubscribeDetectedAt: null, price: { amount: 9.99, currency: "USD" },
    } as unknown as VerifiedPurchase;
    const ctx = { projectId: "proj1", appId: "app_ios", appUserId: user, now: new Date(NOW), fromDevice: false };
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => applyPurchases(h.db, customer, [purchase], ctx)));
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    const subs = await h.db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, "proj1"), eq(schema.subscriptions.storeKey, "sub_race")));
    expect(subs).toHaveLength(1);
    const events = await h.db.select().from(schema.events).where(and(eq(schema.events.projectId, "proj1"), eq(schema.events.type, "INITIAL_PURCHASE")));
    expect(events).toHaveLength(1);
    const txns = await h.db.select().from(schema.transactions).where(and(eq(schema.transactions.projectId, "proj1"), eq(schema.transactions.storeTransactionId, "in_race")));
    expect(txns).toHaveLength(1);
  });
});
