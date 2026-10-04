import { describe, expect, it } from "vitest";
import { offerOfInvoice } from "../src/stores/stripe/map.js";

// The offer type a Stripe period records (transactions.offer_type), for the chart's Offer type dimension.
describe("Stripe offer types", () => {
  const inv = { id: "in_1" };
  it("records a trial as a free trial", () => expect(offerOfInvoice(true, null)).toEqual({ offerType: "free_trial", offerId: null }));
  it("records a full-price invoice as no offer", () => expect(offerOfInvoice(false, { ...inv, total_discount_amounts: [{ amount: 0 }] })).toEqual({ offerType: null, offerId: null }));
  it("records a coupon as a promotional offer", () =>
    expect(offerOfInvoice(false, { ...inv, discounts: [{ id: "di_1", coupon: { id: "SPRING" }, promotion_code: null }], total_discount_amounts: [{ amount: 500 }] })).toEqual({ offerType: "promotional", offerId: "SPRING" }));
  it("records a redeemed promotion code as an offer code", () =>
    expect(offerOfInvoice(false, { ...inv, discounts: [{ id: "di_1", promotion_code: "promo_9" }], total_discount_amounts: [{ amount: 500 }] })).toEqual({ offerType: "offer_code", offerId: "promo_9" }));
  it("records an unexpanded discount as promotional", () => expect(offerOfInvoice(false, { ...inv, discounts: ["di_1"] })).toEqual({ offerType: "promotional", offerId: null }));
  it("keeps the stored offer when the invoice is not a new period", () =>
    expect(offerOfInvoice(false, null, { storeTransactionId: "in_0", purchaseDate: new Date(0), price: null })).toEqual({}));
});
