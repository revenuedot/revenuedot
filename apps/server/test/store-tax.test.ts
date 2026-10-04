import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { invoiceTax, mapCheckoutOneTime } from "../src/stores/stripe/map.js";
import { mapOneTime, transactionPrice } from "../src/stores/paddle/map.js";
import { withOrderTax } from "../src/stores/google/index.js";
import type { PaddleTransaction } from "../src/stores/paddle/api.js";
import type { VerifiedSubscription } from "../src/stores/types.js";
import { getOrCreateCustomer } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import { harness } from "../../../packages/contract/src/harness.js";

// The tax stores report inside a price (core tax.ts), stored in transactions.tax_amount with tax_source 'store'.
const catalog = { productType: () => "non_consumable", productDuration: () => null };

describe("Stripe", () => {
  it("reads the invoice tax on every API version", () => {
    expect(invoiceTax({ id: "in", total_taxes: [{ amount: 120 }, { amount: 30 }] })).toBe(150);
    expect(invoiceTax({ id: "in", tax: 200 })).toBe(200);
    expect(invoiceTax({ id: "in", total: 1190, total_excluding_tax: 1000 })).toBe(190);
    expect(invoiceTax({ id: "in", total: 1000 })).toBeNull();
  });
  it("puts a Checkout line item's tax inside its price", () => {
    const [p] = mapCheckoutOneTime({ id: "cs", mode: "payment", livemode: true, payment_intent: "pi_1", created: 1, currency: "eur",
      line_items: { data: [{ price: { id: "price_1", product: "prod_1" } as never, amount_total: 1190, amount_tax: 190, currency: "eur" }] } }, { catalog, now: new Date() });
    expect(p!.price).toEqual({ amount: 11.9, currency: "EUR", tax: 1.9 });
  });
});

describe("Paddle", () => {
  const t = (o: Partial<PaddleTransaction>): PaddleTransaction => ({
    id: "txn_1", status: "completed", customer_id: "ctm", custom_data: null, currency_code: "EUR", origin: "web", subscription_id: null,
    billing_period: null, items: [{ price: { id: "pri_1" } as never, quantity: 1 }], created_at: "2026-09-01T00:00:00Z", billed_at: "2026-09-01T00:00:00Z", ...o,
  });
  it("records the tax Paddle collected as merchant of record", () => {
    expect(transactionPrice(t({ details: { totals: { subtotal: "1000", tax: "190", total: "1190", currency_code: "EUR" } } }))).toEqual({ amount: 11.9, currency: "EUR", tax: 1.9 });
    expect(transactionPrice(t({ details: { totals: { subtotal: "1000", tax: "", total: "1000", currency_code: "EUR" } } }))).toEqual({ amount: 10, currency: "EUR" });
  });
  it("splits the tax per line item of a multi-item purchase", () => {
    const out = mapOneTime(t({
      items: [{ price: { id: "pri_1" } as never, quantity: 1 }, { price: { id: "pri_2" } as never, quantity: 1 }],
      details: { totals: { subtotal: "2000", tax: "380", total: "2380", currency_code: "EUR" }, line_items: [{ price_id: "pri_1", quantity: 1, totals: { total: "1190", tax: "190" } }, { price_id: "pri_2", quantity: 1, totals: { total: "1190", tax: "190" } }] },
    }), { catalog, now: new Date(), sandbox: false });
    expect(out.map((p) => p.price)).toEqual([{ amount: 11.9, currency: "EUR", tax: 1.9 }, { amount: 11.9, currency: "EUR", tax: 1.9 }]);
  });
});

describe("Google Play", () => {
  const sub = { kind: "subscription", storeTransactionId: "GPA.1234-5678-9012-34567..2", price: { amount: 4.99, currency: "EUR" } } as VerifiedSubscription;
  it("adds the order's tax to the period it paid for", () => {
    expect(withOrderTax(sub, { orderId: "GPA.1234-5678-9012-34567..2", tax: { currencyCode: "EUR", units: "0", nanos: 800_000_000 } })!.price).toEqual({ amount: 4.99, currency: "EUR", tax: 0.8 });
  });
  it("leaves other periods, other currencies and orders without tax alone", () => {
    expect(withOrderTax(sub, { orderId: "GPA.1234-5678-9012-34567..1", tax: { currencyCode: "EUR", units: "1" } })!.price).toEqual(sub.price);
    expect(withOrderTax(sub, { orderId: sub.storeTransactionId, tax: { currencyCode: "USD", units: "1" } })!.price).toEqual(sub.price);
    expect(withOrderTax(sub, { orderId: sub.storeTransactionId })!.price).toEqual(sub.price);
  });
});

describe("the ledger", () => {
  it("stores a reported tax and leaves the columns empty without one", async () => {
    const h = await harness();
    const now = new Date("2026-09-01T00:00:00Z");
    const { customer } = await getOrCreateCustomer(h.db, "proj1", "taxed", now);
    const ctx = { projectId: "proj1", appId: "app_ios", appUserId: "taxed", now, fromDevice: false };
    const one = (id: string, tax?: number) => ({ kind: "non_subscription" as const, store: "stripe" as const, productIdentifier: "lifetime", storeTransactionId: id, isSandbox: false, isConsumable: false, purchaseDate: now, price: { amount: 11.9, currency: "USD", ...(tax === undefined ? {} : { tax }) }, countryCode: "DE" });
    await applyPurchases(h.db, customer, [one("pi_taxed", 1.9), one("pi_plain")], ctx);
    const rows = await h.db.select({ id: schema.transactions.storeTransactionId, tax: schema.transactions.taxAmount, source: schema.transactions.taxSource }).from(schema.transactions).where(eq(schema.transactions.customerId, customer.id));
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: "pi_plain", tax: null, source: null }, { id: "pi_taxed", tax: 1.9, source: "store" }]);
    await h.close();
  });
});
