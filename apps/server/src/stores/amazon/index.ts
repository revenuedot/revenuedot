import { Codes, RCError } from "../../errors.js";
import type { StoreAdapter } from "../types.js";
import { AmazonRvsClient, toRCError, type AmazonClientOptions } from "./api.js";
import { mapReceipt } from "./map.js";

export { AmazonRvsClient, AmazonApiError, toRCError } from "./api.js";

export interface AmazonStore extends StoreAdapter {
  client: AmazonRvsClient;
  now: () => Date;
}

const isAmazonStore = (s: unknown): s is AmazonStore => !!s && typeof s === "object" && (s as AmazonStore).client instanceof AmazonRvsClient;

/**
 * Amazon Appstore adapter. The Android SDK built for Amazon posts `fetch_token` = the receipt id and `store_user_id` =
 * the Amazon user id; both go to RVS, which is the only source of truth for dates and state.
 */
export function createAmazonStore(opts: AmazonClientOptions & { now?: () => Date } = {}): AmazonStore {
  const client = new AmazonRvsClient(opts);
  const now = opts.now ?? (() => new Date());
  return {
    client, now,
    async verify(app, input, catalog) {
      const receiptId = input.fetchToken;
      if (!receiptId) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token (the Amazon receipt id) is required.");
      if (!input.storeUserId) throw new RCError(400, Codes.INVALID_RECEIPT, "store_user_id (the Amazon user id) is required for Amazon receipts.");
      try {
        const { receipt, sandbox } = await client.verify(app, input.storeUserId, receiptId);
        if (receipt.receiptId && receipt.receiptId !== receiptId) throw new RCError(400, Codes.INVALID_RECEIPT, "Amazon returned a different receipt.");
        const posted = { productId: input.productIds[0] ?? null, price: input.price, currency: input.currency, country: input.storeCountry };
        return [mapReceipt({ ...receipt, receiptId }, { catalog, now: now(), sandbox, posted })];
      } catch (e) {
        throw toRCError(e);
      }
    },
  };
}

export const amazonStore: AmazonStore = createAmazonStore();

/** The RVS client behind an adapter map (tests inject one through `createAmazonStore({ fetch })`). */
export function amazonClientFor(stores: Record<string, StoreAdapter>, fallbackFetch?: typeof fetch): { client: AmazonRvsClient; now?: () => Date } {
  const s = stores.amazon;
  if (isAmazonStore(s) && (s.client.customFetch || !fallbackFetch)) return { client: s.client, now: s.now };
  if (fallbackFetch) {
    let c = fetchClients.get(fallbackFetch);
    if (!c) { c = new AmazonRvsClient({ fetch: fallbackFetch }); fetchClients.set(fallbackFetch, c); }
    return { client: c };
  }
  return { client: amazonStore.client };
}
const fetchClients = new WeakMap<typeof fetch, AmazonRvsClient>();

/** The SDK's receipt-data route: RVS's JSON as Amazon returned it (the SDK reads `termSku`). */
export async function amazonReceiptData(client: AmazonRvsClient, app: { credentials: Record<string, unknown> | null }, storeUserId: string, receiptId: string) {
  try {
    return (await client.verify({ credentials: app.credentials ?? {} }, storeUserId, receiptId)).receipt;
  } catch (e) {
    throw toRCError(e);
  }
}

