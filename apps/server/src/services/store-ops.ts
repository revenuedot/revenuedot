import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { Codes, RCError } from "../errors.js";
import { productInfo } from "../repo/catalog.js";
import type { CustomerRow } from "../repo/customers.js";
import { applyPurchases } from "./purchases.js";
import type { AppRow, VerifiedPurchase } from "../stores/types.js";
import { appleCredentials } from "../stores/apple/api.js";
import { appleHttpFor, purchasesForAppleOrder } from "../stores/apple/index.js";
import { AppStoreConnectApi, ConnectError, connectCredentials } from "../stores/apple/connect.js";
import { GoogleApiError, hasServiceAccount } from "../stores/google/api.js";
import { googleClientFor, purchaseForGoogleOrder } from "../stores/google/index.js";

/**
 * Store operations behind two v2 actions: restoring a purchase by its store order id, and creating a catalog product in
 * the store (prd/rest-api/PRD.md, "The last 15 operations"). Failures are StoreOpErrors; the route maps them to v2 errors.
 */
export class StoreOpError extends Error {
  constructor(public kind: "not_found" | "credentials" | "unavailable" | "conflict" | "invalid" | "unsupported", message: string, public param?: string) { super(message); }
}

type App = typeof schema.apps.$inferSelect;
const APPLE = new Set(["app_store", "mac_app_store"]);

/** Google order ids: `GPA.1234-5678-9012-34567` (with `..N` for renewals), or the legacy `<digits>.<digits>` merchant order number. */
export const isGoogleOrderId = (id: string) => /^GPA\.[0-9-]+(\.\.\d+)?$/.test(id) || /^\d{10,}\.\d+$/.test(id);

const fromGoogle = (e: unknown): unknown => {
  if (!(e instanceof GoogleApiError)) return e;
  if (e.kind === "credentials") return new StoreOpError("credentials", `Google Play refused the service account: ${e.message}`);
  if (e.kind === "conflict") return new StoreOpError("conflict", e.message);
  if (e.kind === "invalid_token") return new StoreOpError("invalid", `Google Play refused the request: ${e.message}`);
  return new StoreOpError("unavailable", `Google Play could not be reached: ${e.message}`);
};
const fromApple = (e: unknown): unknown => {
  if (!(e instanceof RCError)) return e;
  if (e.code === Codes.INVALID_APPLE_SUBSCRIPTION_KEY) return new StoreOpError("credentials", e.message);
  if (e.status >= 500) return new StoreOpError("unavailable", e.message);
  return new StoreOpError("invalid", e.message);
};

/**
 * Finds the purchase an order id paid for and gives it to the customer, like a restore from the device (the project's
 * transfer behaviour applies). Google order ids go to orders.batchGet on each Play app with a service account; anything else
 * to Apple's Look Up Order ID on each App Store app with an In-App Purchase key. Returns the owning customer afterwards.
 */
export async function restoreByOrderId(deps: Deps, customer: CustomerRow, appUserId: string, orderId: string): Promise<CustomerRow> {
  const apps = await deps.db.select().from(schema.apps).where(eq(schema.apps.projectId, customer.projectId));
  const google = isGoogleOrderId(orderId);
  const candidates = apps.filter((a) => (google ? a.type === "play_store" && hasServiceAccount(a) : APPLE.has(a.type) && safeHasAppleKey(a)));
  if (!candidates.length) {
    throw new StoreOpError("credentials", google
      ? "Restoring a Google Play order needs a Play app with a service account (\"View financial data\" permission)."
      : "Restoring an App Store order needs an App Store app with its In-App Purchase key.", "order_id");
  }
  const now = deps.now();
  for (const app of candidates) {
    let purchases: VerifiedPurchase[] | null;
    try {
      if (google) {
        const p = await purchaseForGoogleOrder(googleClientFor(deps.stores, deps.fetch).client, app as AppRow, orderId, await productInfo(deps.db, app.id), now);
        purchases = p ? [p] : null;
      } else {
        purchases = await purchasesForAppleOrder(app as AppRow, orderId, appleHttpFor(deps.stores, deps.fetch, deps.now));
      }
    } catch (e) {
      throw google ? fromGoogle(e) : fromApple(e);
    }
    if (!purchases?.length) continue;
    try {
      const owner = await applyPurchases(deps.db, customer, purchases, { projectId: customer.projectId, appId: app.id, appUserId, now, fromDevice: true, fetch: deps.fetch });
      deps.kick?.();
      return owner;
    } catch (e) {
      if (e instanceof RCError && e.code === Codes.RECEIPT_ALREADY_IN_USE) throw new StoreOpError("conflict", `${e.message} The project's transfer behaviour keeps purchases with their owner.`, "order_id");
      throw e;
    }
  }
  throw new StoreOpError("not_found", `No ${google ? "Google Play" : "App Store"} order ${orderId} was found for this project's apps.`, "order_id");
}

function safeHasAppleKey(app: App) {
  try { return appleCredentials(app as AppRow) !== null; } catch { return true; }
}

export interface StoreInformation { duration?: string; subscription_group_name?: string; subscription_group_id?: string | null }
export interface StoreProduct { object: "store_product"; id: string; name: string | null; product_identifier: string }

const IAP_TYPES: Record<string, "CONSUMABLE" | "NON_CONSUMABLE" | "NON_RENEWING_SUBSCRIPTION"> = {
  consumable: "CONSUMABLE", non_consumable: "NON_CONSUMABLE", one_time: "NON_CONSUMABLE", non_renewing_subscription: "NON_RENEWING_SUBSCRIPTION",
};

/**
 * Creates a catalog product in its store. App Store (RevenueCat's operation): a subscription in a subscription group
 * found or created by reference name, or an in-app purchase. Google Play (our extension): a subscription with one listing in
 * the app's default language and no base plan, because the request carries no price.
 */
export async function createInStore(deps: Deps, product: typeof schema.products.$inferSelect, info: StoreInformation | null): Promise<StoreProduct> {
  const [app] = await deps.db.select().from(schema.apps).where(and(eq(schema.apps.projectId, product.projectId), eq(schema.apps.id, product.appId))).limit(1);
  if (!app) throw new StoreOpError("not_found", "The product's app was not found.");
  const productId = product.storeIdentifier.split(":")[0]!;
  const name = (product.displayName?.trim() || productId);
  if (APPLE.has(app.type)) return createInAppStore(deps, app, product, productId, name, info);
  if (app.type === "play_store") return createInPlay(deps, app, product, productId, name);
  throw new StoreOpError("unsupported", `Products can be created in App Store Connect and Google Play; this product belongs to a ${app.type} app.`);
}

async function createInAppStore(deps: Deps, app: App, product: typeof schema.products.$inferSelect, productId: string, name: string, info: StoreInformation | null): Promise<StoreProduct> {
  const creds = connectCredentials(app);
  if (!creds) throw new StoreOpError("credentials", "Creating products in App Store Connect needs the app's App Store Connect API key: app_store_connect_api_key (.p8), app_store_connect_api_key_id and app_store_connect_api_key_issuer.");
  if (!app.bundleId) throw new StoreOpError("credentials", "The app has no bundle id.");
  const subscription = product.type === "subscription";
  if (subscription && (!info?.duration || !(info.subscription_group_name || info.subscription_group_id))) {
    throw new StoreOpError("unsupported", "A subscription needs store_information with duration and subscription_group_name.", "store_information");
  }
  const iapType = IAP_TYPES[product.type];
  if (!subscription && !iapType) throw new StoreOpError("unsupported", `App Store Connect has no in-app purchase type for a ${product.type} product.`);
  const { fetchFn, now } = appleHttpFor(deps.stores, deps.fetch, deps.now);
  const api = new AppStoreConnectApi(creds, fetchFn, now);
  const ascName = name.slice(0, 64);
  try {
    const ascApp = await api.appByBundleId(app.bundleId);
    if (!ascApp) throw new StoreOpError("invalid", `App Store Connect has no app with bundle id ${app.bundleId} for this API key.`);
    if (subscription) {
      const groupId = info!.subscription_group_id || (await api.subscriptionGroup(ascApp.id, info!.subscription_group_name!));
      const r = await api.createSubscription(groupId, { name: ascName, productId, subscriptionPeriod: info!.duration! });
      return { object: "store_product", id: r.data.id, name: (r.data.attributes?.name as string | undefined) ?? ascName, product_identifier: (r.data.attributes?.productId as string | undefined) ?? productId };
    }
    const r = await api.createInAppPurchase(ascApp.id, { name: ascName, productId, inAppPurchaseType: iapType! });
    return { object: "store_product", id: r.data.id, name: (r.data.attributes?.name as string | undefined) ?? ascName, product_identifier: (r.data.attributes?.productId as string | undefined) ?? productId };
  } catch (e) {
    if (e instanceof ConnectError) throw new StoreOpError(e.kind === "invalid" ? "invalid" : e.kind, e.message);
    throw e;
  }
}

async function createInPlay(deps: Deps, app: App, product: typeof schema.products.$inferSelect, productId: string, name: string): Promise<StoreProduct> {
  if (!hasServiceAccount(app)) throw new StoreOpError("credentials", "Creating products in Google Play needs the app's service account (play_service_account_credentials_json) with the \"Manage store presence\" permission.");
  if (product.type !== "subscription") throw new StoreOpError("unsupported", "Google Play needs a price to create a one-time product, and this request carries none. Create it in Play Console.");
  const { client } = googleClientFor(deps.stores, deps.fetch);
  const title = name.slice(0, 55);
  try {
    const languageCode = await client.defaultLanguage(app as AppRow);
    const r = await client.createSubscription(app as AppRow, productId, { languageCode, title });
    return { object: "store_product", id: r.productId ?? productId, name: r.listings?.[0]?.title ?? title, product_identifier: r.productId ?? productId };
  } catch (e) {
    throw fromGoogle(e);
  }
}
