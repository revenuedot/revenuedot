import { Codes, RCError } from "../errors.js";
import type { StoreAdapter, VerifiedPurchase } from "./types.js";

/** ISO 8601 duration (P1W, P1M, P1Y, P3D) added to a date. */
export function addDuration(d: Date, iso: string, times = 1): Date {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso);
  if (!m) throw new Error(`Bad duration ${iso}`);
  const r = new Date(d);
  r.setUTCFullYear(r.getUTCFullYear() + Number(m[1] ?? 0) * times);
  r.setUTCMonth(r.getUTCMonth() + Number(m[2] ?? 0) * times);
  r.setUTCDate(r.getUTCDate() + (Number(m[3] ?? 0) * 7 + Number(m[4] ?? 0)) * times);
  return r;
}

/**
 * The Test Store: purchases made with `test_` API keys, no App Store or Google Play involved.
 * The SDK posts `fetch_token = test_<epoch ms>_<uuid>`; we trust it and use the catalog for the product's type and period.
 * Always sandbox.
 */
export const testStore: StoreAdapter = {
  async verify(_app, input, catalog) {
    const token = input.fetchToken;
    const m = token ? /^test_(\d+)_([\w-]+)$/.exec(token) : null;
    if (!m) throw new RCError(400, Codes.INVALID_RECEIPT, "The receipt is not a valid Test Store purchase token.");
    const productId = input.productIds[0] ?? input.platformProducts[0]?.productId;
    if (!productId) throw new RCError(400, Codes.INVALID_RECEIPT, "product_id is required for Test Store purchases.");
    const purchaseDate = new Date(Number(m[1]));
    const type = catalog.productType(productId) ?? (input.normalDuration ? "subscription" : "non_consumable");
    const price = input.price !== null && input.currency ? { amount: input.price, currency: input.currency } : null;
    const out: VerifiedPurchase[] = [];
    if (type === "subscription") {
      const dur = catalog.productDuration(productId) ?? input.normalDuration ?? "P1M";
      out.push({
        kind: "subscription", store: "test_store", storeKey: token!, productIdentifier: productId, isSandbox: true,
        purchaseDate, originalPurchaseDate: purchaseDate, expiresDate: addDuration(purchaseDate, dur), periodType: "normal",
        storeTransactionId: token!, originalTransactionId: token!, price, countryCode: input.storeCountry,
      });
    } else {
      out.push({
        kind: "non_subscription", store: "test_store", productIdentifier: productId, storeTransactionId: token!, isSandbox: true,
        isConsumable: type === "consumable", purchaseDate, price, countryCode: input.storeCountry,
      });
    }
    return out;
  },
};
