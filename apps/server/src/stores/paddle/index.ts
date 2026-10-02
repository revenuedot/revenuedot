import { Codes, RCError } from "../../errors.js";
import { withStoreSecrets } from "../../services/store-secrets.js";
import type { AppRow, StoreAdapter, VerifiedPurchase } from "../types.js";
import { PaddleApiError, PaddleClient, paddleEnvOf, toRCError, type PaddleClientOptions, type PaddleSubscription, type PaddleTransaction } from "./api.js";
import { isPeriodPayment, mapOneTime, mapSubscription, PaddleNotYetPaid, type Catalog, type StoredPeriod } from "./map.js";

export { PaddleClient, PaddleApiError, toRCError } from "./api.js";

export interface PaddleStore extends StoreAdapter {
  client: PaddleClient;
  now: () => Date;
}

const isPaddleStore = (s: unknown): s is PaddleStore => !!s && typeof s === "object" && (s as PaddleStore).client instanceof PaddleClient;

/** A subscription with the transactions that decide its period: the newest that paid for a period, and the newest of any kind. */
export async function readSubscription(client: PaddleClient, app: Pick<AppRow, "credentials">, id: string) {
  const sub = await client.subscription(app, id);
  const txns = await client.recentTransactions(app, sub.id);
  return { sub, paid: txns.find(isPeriodPayment) ?? null, latest: txns[0] ?? null };
}

export function mapRead(app: Pick<AppRow, "credentials">, r: { sub: PaddleSubscription; paid: PaddleTransaction | null; latest: PaddleTransaction | null }, ctx: { catalog: Catalog; now: Date; stored?: StoredPeriod | null }) {
  return mapSubscription(r.sub, { ...ctx, paid: r.paid, latest: r.latest, sandbox: paddleEnvOf(app) === "sandbox" });
}

/**
 * Purchases from a `sub_…` or `txn_…` token (RevenueCat accepts both): the subscription, a subscription's transaction
 * (its subscription), or the items of a one-time transaction.
 */
export async function purchasesForToken(client: PaddleClient, app: Pick<AppRow, "credentials">, token: string, ctx: { catalog: Catalog; now: Date; stored?: (subId: string) => Promise<StoredPeriod | null> }): Promise<{ purchases: VerifiedPurchase[]; customData: Record<string, unknown> | null; customer: string | null }> {
  const sandbox = paddleEnvOf(app) === "sandbox";
  let subId: string | null = null;
  let txnData: Record<string, unknown> | null = null;
  if (/^sub_[a-z0-9]+$/.test(token)) subId = token;
  else if (/^txn_[a-z0-9]+$/.test(token)) {
    const t = await client.transaction(app, token);
    if (t.status === "canceled") throw new PaddleApiError("invalid", "The Paddle transaction was canceled without a payment.");
    if (t.status === "draft" || t.status === "ready") throw new PaddleNotYetPaid("The Paddle transaction is not paid yet (checkout not completed).");
    if (!t.subscription_id) {
      if (t.status === "billed" || t.status === "past_due") throw new PaddleNotYetPaid("The Paddle transaction is billed but not paid yet.");
      return { purchases: mapOneTime(t, { ...ctx, sandbox }), customData: t.custom_data, customer: t.customer_id };
    }
    subId = t.subscription_id;
    txnData = t.custom_data;
  } else {
    throw new PaddleApiError("invalid", "fetch_token must be a Paddle subscription id (sub_…) or transaction id (txn_…).");
  }
  const r = await readSubscription(client, app, subId);
  const p = mapRead(app, r, { catalog: ctx.catalog, now: ctx.now, stored: await ctx.stored?.(r.sub.id) });
  return { purchases: [p], customData: { ...(txnData ?? {}), ...(r.paid?.custom_data ?? {}), ...(r.sub.custom_data ?? {}) }, customer: r.sub.customer_id };
}

/** Paddle failures for the receipt endpoint, including "not paid yet", which the backend should retry (5xx). */
export function paddleReceiptError(e: unknown): unknown {
  if (e instanceof PaddleNotYetPaid) return new RCError(503, Codes.STORE_PROBLEM, `${e.message} Post it again once Paddle reports the payment.`);
  return toRCError(e);
}

/**
 * Paddle Billing adapter: the developer's backend posts `fetch_token` = `sub_…` or `txn_…` with `X-Platform: paddle`.
 * Everything is read from Paddle's API with the app's key.
 */
export function createPaddleStore(opts: PaddleClientOptions & { now?: () => Date } = {}): PaddleStore {
  const client = new PaddleClient(opts);
  const now = opts.now ?? (() => new Date());
  return {
    client, now,
    async verify(app, input, catalog, extra) {
      const token = input.fetchToken?.trim();
      if (!token) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token (a Paddle subscription or transaction id) is required.");
      try {
        return (await purchasesForToken(client, app, token, { catalog, now: now(), stored: extra?.storedPeriod ? async (id) => extra.storedPeriod!("paddle", id) : undefined })).purchases;
      } catch (e) {
        throw paddleReceiptError(e);
      }
    },
  };
}

export const paddleStore: PaddleStore = createPaddleStore();

/** The Paddle client behind an adapter map (tests inject one through `createPaddleStore({ fetch })`). */
export function paddleClientFor(stores: Record<string, StoreAdapter>, fallbackFetch?: typeof fetch): { client: PaddleClient; now?: () => Date } {
  const s = stores.paddle;
  if (isPaddleStore(s) && (s.client.customFetch || !fallbackFetch)) return { client: s.client, now: s.now };
  if (fallbackFetch) {
    let c = fetchClients.get(fallbackFetch);
    if (!c) { c = new PaddleClient({ fetch: fallbackFetch }); fetchClients.set(fallbackFetch, c); }
    return { client: c };
  }
  return { client: paddleStore.client };
}
const fetchClients = new WeakMap<typeof fetch, PaddleClient>();

/**
 * Where a Paddle customer manages a subscription: a short-lived authenticated customer portal link (needs the key's
 * Customer portal sessions write access), else the subscription's own `management_urls.cancel` (the customer signs in by
 * email), else null.
 */
export async function paddleManagementUrl(deps: { stores: Record<string, StoreAdapter>; fetch?: typeof fetch; encryptionKey?: string; signingKey?: string }, row: AppRow & { secrets?: string | null; secretHints?: Record<string, string> | null }, subscriptionId: string): Promise<string | null> {
  let app;
  try { app = await withStoreSecrets(deps, row); } catch { return null; }
  const { client } = paddleClientFor(deps.stores, deps.fetch);
  let sub: PaddleSubscription;
  try { sub = await client.subscription(app, subscriptionId); } catch { return null; }
  try {
    const url = await client.portalSession(app, sub.customer_id, sub.id);
    if (url) return url;
  } catch { /* no permission or Paddle down: the plain link below */ }
  return sub.management_urls?.cancel ?? null;
}
