import { Codes, RCError } from "../../errors.js";
import type { AppRow, StoreAdapter, VerifiedPurchase } from "../types.js";
import { GalaxyApiError, GalaxyClient, toRCError, type GalaxyClientOptions } from "./api.js";
import { isSubscriptionReceipt, mapItem, mapSubscription, type Catalog, type Posted } from "./map.js";

export { GalaxyClient, GalaxyApiError, toRCError } from "./api.js";

export interface GalaxyStore extends StoreAdapter {
  client: GalaxyClient;
  now: () => Date;
}

const isGalaxyStore = (s: unknown): s is GalaxyStore => !!s && typeof s === "object" && (s as GalaxyStore).client instanceof GalaxyClient;

/**
 * The purchase a Samsung purchase id proves: the receipt (no credentials), and for a subscription its state from the
 * subscription API (the service account). A receipt for another package is not this app's purchase.
 */
export async function purchaseForId(client: GalaxyClient, app: Pick<AppRow, "credentials" | "bundleId">, purchaseId: string, ctx: { catalog: Catalog; now: Date; posted?: Posted | null }): Promise<VerifiedPurchase> {
  const r = await client.receipt(purchaseId);
  if (r.packageName && app.bundleId && r.packageName !== app.bundleId) {
    throw new GalaxyApiError("invalid", `This purchase belongs to ${r.packageName}, not to this app's package ${app.bundleId}.`);
  }
  if (isSubscriptionReceipt(r, ctx.catalog)) {
    const s = await client.subscription(app, purchaseId);
    return mapSubscription(r, s, { ...ctx, purchaseId });
  }
  return mapItem(r, { ...ctx, purchaseId });
}

/**
 * Samsung Galaxy Store adapter. The Android SDK built with `purchases-store-galaxy` posts `X-Platform: android` with the
 * app's `galx_` key (which is how the store is known) and `fetch_token` = Samsung's purchase id.
 */
export function createGalaxyStore(opts: GalaxyClientOptions = {}): GalaxyStore {
  const client = new GalaxyClient(opts);
  const now = opts.now ?? (() => new Date());
  return {
    client, now,
    async verify(app, input, catalog) {
      const purchaseId = input.fetchToken?.trim();
      if (!purchaseId) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token (the Samsung purchase id) is required.");
      try {
        return [await purchaseForId(client, app, purchaseId, { catalog, now: now(), posted: { price: input.price, currency: input.currency } })];
      } catch (e) {
        throw toRCError(e);
      }
    },
  };
}

export const galaxyStore: GalaxyStore = createGalaxyStore();

export function galaxyClientFor(stores: Record<string, StoreAdapter>, fallbackFetch?: typeof fetch): { client: GalaxyClient; now?: () => Date } {
  const s = stores.galaxy;
  if (isGalaxyStore(s) && (s.client.customFetch || !fallbackFetch)) return { client: s.client, now: s.now };
  if (fallbackFetch) {
    let c = fetchClients.get(fallbackFetch);
    if (!c) { c = new GalaxyClient({ fetch: fallbackFetch }); fetchClients.set(fallbackFetch, c); }
    return { client: c };
  }
  return { client: galaxyStore.client };
}
const fetchClients = new WeakMap<typeof fetch, GalaxyClient>();
