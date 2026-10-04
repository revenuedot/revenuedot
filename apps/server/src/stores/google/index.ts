import type { AppRow, StoreAdapter } from "../types.js";
import { Codes, RCError } from "../../errors.js";
import { GoogleApiError, GooglePlayClient, toRCError, type GoogleClientOptions, type GoogleMoney, type Order } from "./api.js";
import type { VerifiedPurchase } from "../types.js";
import { baseOrderId, mapProduct, mapSubscription, S, type Catalog, type Posted } from "./map.js";

export { GooglePlayClient, GoogleApiError, toRCError } from "./api.js";

export interface GoogleStore extends StoreAdapter {
  client: GooglePlayClient;
  now: () => Date;
}

const isPlayStore = (s: unknown): s is GoogleStore => !!s && typeof s === "object" && (s as GoogleStore).client instanceof GooglePlayClient;

/**
 * Google Play adapter. `verify` checks the purchase token the Android SDK posts to /v1/receipts with the Play Developer API
 * and acknowledges it (Google refunds purchases left unacknowledged for 3 days). Consumables are never consumed here:
 * the SDK consumes them when the response says `should_consume: true`.
 */
export function createGoogleStore(opts: GoogleClientOptions & { now?: () => Date } = {}): GoogleStore {
  const client = new GooglePlayClient(opts);
  const now = opts.now ?? (() => new Date());
  return {
    client, now,
    async verify(app, input, catalog) {
      const token = input.fetchToken;
      if (!token) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token (the Google Play purchase token) is required.");
      const productId = input.productIds[0] ?? input.platformProducts[0]?.productId ?? null;
      const basePlan = input.platformProducts.find((p) => p.productId === productId)?.basePlanId ?? input.platformProducts[0]?.basePlanId;
      const type = productId ? (basePlan ? catalog.productType(`${productId}:${basePlan}`) : null) ?? catalog.productType(productId) : null;
      const posted: Posted = { productId, price: input.price, currency: input.currency };
      try {
        if (type === "subscription" || (!type && (basePlan || input.normalDuration))) {
          return [await verifySubscription(client, app, token, catalog, now(), posted)];
        }
        if (type) {
          if (!productId) throw new RCError(400, Codes.INVALID_RECEIPT, "product_ids is required for Google Play one-time purchases.");
          return [await verifyProduct(client, app, productId, token, catalog, now(), posted)];
        }
        // Unknown product: a subscription token first, then a one-time product.
        try {
          return [await verifySubscription(client, app, token, catalog, now(), posted)];
        } catch (e) {
          if (!(e instanceof GoogleApiError && e.kind === "invalid_token") || !productId) throw e;
          return [await verifyProduct(client, app, productId, token, catalog, now(), posted)];
        }
      } catch (e) {
        throw toRCError(e);
      }
    },
  };
}

export const googleStore: GoogleStore = createGoogleStore();

/** The Play client behind an adapter map (tests inject one through `createGoogleStore({ fetch })`). */
export function googleClientFor(stores: Record<string, StoreAdapter>, fallbackFetch?: typeof fetch): { client: GooglePlayClient; now?: () => Date } {
  const s = stores.play_store;
  if (isPlayStore(s) && (s.client.customFetch || !fallbackFetch)) return { client: s.client, now: s.now };
  if (fallbackFetch) {
    let c = fetchClients.get(fallbackFetch);
    if (!c) { c = new GooglePlayClient({ fetch: fallbackFetch }); fetchClients.set(fallbackFetch, c); }
    return { client: c };
  }
  return { client: googleStore.client };
}
const fetchClients = new WeakMap<typeof fetch, GooglePlayClient>();

export async function verifySubscription(client: GooglePlayClient, app: AppRow, token: string, catalog: Catalog, now: Date, posted: Posted | null) {
  const sub = await client.getSubscriptionV2(app, token);
  const state = sub.subscriptionState;
  if (state === S.PENDING) throw new RCError(503, Codes.STORE_PROBLEM, "The Google Play purchase is still pending payment. Try again later.");
  if (state === S.PENDING_CANCELED) throw new RCError(400, Codes.INVALID_RECEIPT, "The pending Google Play purchase was cancelled.");
  const verified = mapSubscription(sub, token, { catalog, now, posted });
  // An upgrade or downgrade posted by the device ends the replaced chain now (PRODUCT_CHANGE), not only when the notification comes.
  if (verified.replacesStoreKey) {
    const r = await replacedInfo(client, app, verified.replacesStoreKey);
    verified.replacedExpiresDate = r.expiry;
    verified.replacedOrderIds = r.orderIds;
  }
  await acknowledgeSubscriptionIfNeeded(client, app, token, sub);
  return verified;
}

/** A replaced purchase token's end of access and its order ids (empty when Google no longer knows the token). */
export async function replacedInfo(client: GooglePlayClient, app: AppRow, oldToken: string): Promise<{ expiry: Date | null; orderIds: string[] }> {
  try {
    const s = await client.getSubscriptionV2(app, oldToken);
    const li = s.lineItems?.[0];
    const orderIds = [s.latestOrderId, li?.latestSuccessfulOrderId].filter((x): x is string => !!x);
    return { expiry: li?.expiryTime ? new Date(li.expiryTime) : null, orderIds };
  } catch (e) {
    if (e instanceof GoogleApiError && e.kind === "invalid_token") return { expiry: null, orderIds: [] };
    throw e;
  }
}

/** Acknowledges an unacknowledged subscription. Failures are logged, not fatal: the SDK acknowledges too. Returns false on failure. */
export async function acknowledgeSubscriptionIfNeeded(client: GooglePlayClient, app: AppRow, token: string, sub: { acknowledgementState?: string; subscriptionState?: string; lineItems?: Array<{ productId: string }> }): Promise<boolean> {
  if (sub.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING") return true;
  if (sub.subscriptionState === S.PENDING || sub.subscriptionState === S.PENDING_CANCELED || sub.subscriptionState === S.EXPIRED) return true;
  const subscriptionId = sub.lineItems?.[0]?.productId;
  if (!subscriptionId) return true;
  try {
    await client.acknowledgeSubscription(app, subscriptionId, token);
    return true;
  } catch (e) {
    console.warn(`Google Play acknowledge failed for ${app.id}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

export async function verifyProduct(client: GooglePlayClient, app: AppRow, productId: string, token: string, catalog: Catalog, now: Date, posted: Posted | null) {
  const p = await client.getProduct(app, productId, token);
  if (p.purchaseState === 2) throw new RCError(503, Codes.STORE_PROBLEM, "The Google Play purchase is still pending payment. Try again later.");
  const verified = mapProduct(p, productId, token, { catalog, now, posted });
  await acknowledgeProductIfNeeded(client, app, productId, token, p, verified.isConsumable);
  return verified;
}

/** Non-consumables are acknowledged here; consumables are left for the device to consume (consuming also acknowledges). */
export async function acknowledgeProductIfNeeded(client: GooglePlayClient, app: AppRow, productId: string, token: string, p: { acknowledgementState?: number; purchaseState?: number }, isConsumable: boolean): Promise<boolean> {
  if (isConsumable || p.acknowledgementState !== 0 || p.purchaseState !== 0) return true;
  try {
    await client.acknowledgeProduct(app, productId, token);
    return true;
  } catch (e) {
    console.warn(`Google Play acknowledge failed for ${app.id}: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Order id → purchase token via orders.batchGet (for importing RevenueCat exports, which list order ids).
 * Orders Google does not return are left out. Needs the "View financial data" permission in Play Console.
 */
export async function purchaseTokensForOrders(app: AppRow, orderIds: string[], client: GooglePlayClient = googleStore.client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!orderIds.length) return out;
  try {
    for (const o of await client.batchGetOrders(app, [...new Set(orderIds)])) if (o.orderId && o.purchaseToken) out[o.orderId] = o.purchaseToken;
  } catch (e) {
    throw toRCError(e);
  }
  return out;
}

/** Voided purchases (refunds, chargebacks, revocations) from the last 30 days; `type: 1` includes subscriptions. */
export async function listVoidedPurchases(app: AppRow, opts: { startTime?: Date; endTime?: Date; type?: 0 | 1 } = {}, client: GooglePlayClient = googleStore.client) {
  try { return await client.listVoidedPurchases(app, opts); } catch (e) { throw toRCError(e); }
}

/**
 * The purchase a Google Play order paid for (`orders.batchGet` gives the purchase token), verified like a device receipt.
 * The order's line item says whether it is a subscription or a one-time product; the catalog decides otherwise. null
 * when Google does not know the order. Google errors are thrown as GoogleApiError for the caller to map.
 */
export async function purchaseForGoogleOrder(client: GooglePlayClient, app: AppRow, orderId: string, catalog: Catalog, now: Date): Promise<VerifiedPurchase | null> {
  let orders;
  try {
    orders = await client.batchGetOrders(app, [orderId]);
  } catch (e) {
    if (e instanceof GoogleApiError && e.kind === "invalid_token") return null;
    throw e;
  }
  const order = orders.find((o) => o.orderId === orderId) ?? orders.find((o) => o.orderId && baseOrderId(o.orderId) === baseOrderId(orderId));
  if (!order?.purchaseToken) return null;
  const li = order.lineItems?.[0];
  const productId = li?.productId ?? null;
  const catalogType = productId ? catalog.productType(productId) : null;
  const kind = li?.subscriptionDetails ? "subscription" : li?.oneTimePurchaseDetails ? "one_time" : catalogType ? (catalogType === "subscription" ? "subscription" : "one_time") : null;
  if (kind !== "one_time") {
    try {
      return withOrderTax(await verifySubscription(client, app, order.purchaseToken, catalog, now, null), order);
    } catch (e) {
      if (kind === "subscription" || !productId || !(e instanceof GoogleApiError && e.kind === "invalid_token")) throw e;
    }
  }
  if (!productId) return null;
  return withOrderTax(await verifyProduct(client, app, productId, order.purchaseToken, catalog, now, null), order);
}

const moneyOf = (m: GoogleMoney | undefined) => (m?.units === undefined && m?.nanos === undefined ? null : Number(m?.units ?? 0) + (m?.nanos ?? 0) / 1e9);

/**
 * The order's tax on the purchase it paid for (core tax.ts): only when the purchase's period is this order and the
 * price is in the order's currency. Google receipts carry no tax; only the orders API reports it.
 */
export function withOrderTax<P extends VerifiedPurchase | null>(p: P, order: Order): P {
  if (!p?.price || p.storeTransactionId !== order.orderId) return p;
  const tax = moneyOf(order.tax);
  if (tax === null || !Number.isFinite(tax) || (order.tax?.currencyCode ?? "").toUpperCase() !== p.price.currency.toUpperCase()) return p;
  return { ...p, price: { ...p.price, tax: Math.min(Math.abs(p.price.amount), Math.max(0, tax)) } };
}
