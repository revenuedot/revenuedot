import { Codes, RCError } from "../../errors.js";
import type { AppRow, StoreAdapter, VerifiedPurchase, VerifiedSubscription } from "../types.js";
import { RokuApiError, RokuClient, rokuDate, toRCError, type RokuClientOptions, type RokuTransaction } from "./api.js";
import { isPending, mapTransaction, type Catalog, type Posted } from "./map.js";

export { RokuClient, RokuApiError, toRCError } from "./api.js";

export interface RokuStore extends StoreAdapter {
  client: RokuClient;
  now: () => Date;
}

const isRokuStore = (s: unknown): s is RokuStore => !!s && typeof s === "object" && (s as RokuStore).client instanceof RokuClient;

const minDate = (a: Date, b: Date) => (a < b ? a : b);

/**
 * The purchases one validated transaction proves: its own period (none while a downgrade is pending: Roku charges it when
 * the current plan ends), plus, for an upgrade, the plans it replaced, whose access ends when the upgrade starts
 * (RevenueCat lists PRODUCT_CHANGE as unsupported for Roku, so the old chain simply expires).
 */
export async function purchasesForTransaction(client: RokuClient, app: Pick<AppRow, "credentials">, t: RokuTransaction, ctx: { catalog: Catalog; now: Date; sandbox: boolean; posted?: Posted | null }): Promise<VerifiedPurchase[]> {
  const out: VerifiedPurchase[] = [];
  if (!isPending(t)) out.push(mapTransaction(t, ctx));
  const replaced = (t.cancelledTransactionIds ?? []).filter((id) => typeof id === "string" && id && id !== t.transactionId).slice(0, 3);
  const startsAt = rokuDate(t.purchaseDate) ?? ctx.now;
  for (const id of replaced) {
    let old: RokuTransaction;
    try { old = await client.validate(app, id); } catch (e) {
      if (e instanceof RokuApiError && e.kind === "invalid") continue;
      throw e;
    }
    const p = mapTransaction(old, { ...ctx, posted: null });
    if (p.kind !== "subscription") continue;
    if (!isPending(t)) {
      const s: VerifiedSubscription = { ...p, unsubscribeDetectedAt: null, billingIssuesDetectedAt: null, gracePeriodExpiresDate: null };
      if (s.expiresDate) s.expiresDate = minDate(s.expiresDate, minDate(startsAt, ctx.now));
      out.push(s);
    } else {
      // A downgrade: the current plan runs to its end and does not renew.
      out.push({ ...p, unsubscribeDetectedAt: p.unsubscribeDetectedAt ?? ctx.now });
    }
  }
  return out;
}

/**
 * Roku Pay adapter. The Roku SDK posts `fetch_token` = the Roku transaction id (the order's purchaseId) with
 * `X-Platform: roku`; price and currency come from Roku, because the SDK sends a formatted price and no currency.
 * Sandbox is the SDK's `X-Is-Sandbox` (a sideloaded channel), RevenueCat's rule.
 */
export function createRokuStore(opts: RokuClientOptions & { now?: () => Date } = {}): RokuStore {
  const client = new RokuClient(opts);
  const now = opts.now ?? (() => new Date());
  return {
    client, now,
    async verify(app, input, catalog) {
      const id = input.fetchToken?.trim();
      if (!id) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token (the Roku transaction id) is required.");
      try {
        const t = await client.validate(app, id);
        return await purchasesForTransaction(client, app, t, { catalog, now: now(), sandbox: input.isSandboxHeader, posted: { trialDuration: input.trialDuration ?? null, introDuration: input.introDuration ?? null } });
      } catch (e) {
        throw toRCError(e);
      }
    },
  };
}

export const rokuStore: RokuStore = createRokuStore();

export function rokuClientFor(stores: Record<string, StoreAdapter>, fallbackFetch?: typeof fetch): { client: RokuClient; now?: () => Date } {
  const s = stores.roku;
  if (isRokuStore(s) && (s.client.customFetch || !fallbackFetch)) return { client: s.client, now: s.now };
  if (fallbackFetch) {
    let c = fetchClients.get(fallbackFetch);
    if (!c) { c = new RokuClient({ fetch: fallbackFetch }); fetchClients.set(fallbackFetch, c); }
    return { client: c };
  }
  return { client: rokuStore.client };
}
const fetchClients = new WeakMap<typeof fetch, RokuClient>();
