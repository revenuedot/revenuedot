import { Codes, RCError } from "../../errors.js";
import type { AppRow, StoreAdapter, VerifiedPurchase } from "../types.js";
import { idOf, StripeApiError, StripeClient, toRCError, type StripeClientOptions, type StripeSubscription } from "./api.js";
import { mapCheckoutOneTime, mapSubscription, StripeNotYetPaid, type Catalog, type RegisterOn, type StoredPeriod } from "./map.js";

export { StripeClient, StripeApiError, toRCError } from "./api.js";

export interface StripeStore extends StoreAdapter {
  client: StripeClient;
  now: () => Date;
}

const isStripeStore = (s: unknown): s is StripeStore => !!s && typeof s === "object" && (s as StripeStore).client instanceof StripeClient;

export const registerOnOf = (app: Pick<AppRow, "credentials">): RegisterOn => (app.credentials?.register_on === "invoice_created" ? "invoice_created" : "invoice_paid");

/**
 * Purchases from a `sub_…` or `cs_…` token: the subscription, or the Checkout Session's subscription or one-time items.
 * `stored` gives the chain's current paid period, so an unpaid renewal does not replace it.
 */
export async function purchasesForToken(client: StripeClient, app: Pick<AppRow, "credentials">, token: string, ctx: { catalog: Catalog; now: Date; stored?: (subId: string) => Promise<StoredPeriod | null> }): Promise<{ purchases: VerifiedPurchase[]; subscription: StripeSubscription | null; metadata: Record<string, string> | null; customer: string | null }> {
  const registerOn = registerOnOf(app);
  if (token.startsWith("sub_")) {
    const sub = await client.subscription(app, token);
    return { purchases: [mapSubscription(sub, { ...ctx, registerOn, stored: await ctx.stored?.(sub.id) })], subscription: sub, metadata: sub.metadata ?? null, customer: idOf(sub.customer) };
  }
  if (token.startsWith("cs_")) {
    const s = await client.checkoutSession(app, token);
    if (s.status === "expired") throw new StripeApiError("invalid", "The Checkout Session expired without a purchase.");
    if (s.status === "open") throw new StripeNotYetPaid("The Checkout Session is not completed yet.");
    if (s.mode === "subscription") {
      const subId = idOf(s.subscription as { id: string } | string | null);
      if (!subId) throw new StripeApiError("invalid", "The Checkout Session has no subscription.");
      const sub = await client.subscription(app, subId);
      // The session's metadata is where the app user id usually is; the subscription's wins when both have it.
      return { purchases: [mapSubscription(sub, { ...ctx, registerOn, stored: await ctx.stored?.(sub.id) })], subscription: sub, metadata: { ...(s.metadata ?? {}), ...(sub.metadata ?? {}) }, customer: idOf(sub.customer) ?? idOf(s.customer ?? null) };
    }
    if (s.mode === "payment") {
      if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") throw new StripeNotYetPaid("The Checkout Session's payment is not complete yet.");
      return { purchases: mapCheckoutOneTime(s, ctx), subscription: null, metadata: s.metadata ?? null, customer: idOf(s.customer ?? null) };
    }
    throw new StripeApiError("invalid", `A ${s.mode} Checkout Session is not a purchase.`);
  }
  throw new StripeApiError("invalid", "fetch_token must be a Stripe subscription id (sub_…) or Checkout Session id (cs_…).");
}

/** Stripe failures for the receipt endpoint, including "not paid yet", which the backend should retry (5xx). */
export function stripeReceiptError(e: unknown): unknown {
  if (e instanceof StripeNotYetPaid) return new RCError(503, Codes.STORE_PROBLEM, `${e.message} Post it again once Stripe reports the payment.`);
  return toRCError(e);
}

/**
 * Stripe adapter: the developer's backend posts `fetch_token` = `sub_…` or `cs_…` with `X-Platform: stripe`. Everything is
 * read from Stripe's API with the app's restricted key.
 */
export function createStripeStore(opts: StripeClientOptions & { now?: () => Date } = {}): StripeStore {
  const client = new StripeClient(opts);
  const now = opts.now ?? (() => new Date());
  return {
    client, now,
    async verify(app, input, catalog, extra) {
      const token = input.fetchToken?.trim();
      if (!token) throw new RCError(400, Codes.INVALID_RECEIPT, "fetch_token (a Stripe subscription or Checkout Session id) is required.");
      try {
        return (await purchasesForToken(client, app, token, { catalog, now: now(), stored: extra?.storedPeriod ? (id) => extra.storedPeriod!("stripe", id) : undefined })).purchases;
      } catch (e) {
        throw stripeReceiptError(e);
      }
    },
  };
}

export const stripeStore: StripeStore = createStripeStore();

/** The Stripe client behind an adapter map (tests inject one through `createStripeStore({ fetch })`). */
export function stripeClientFor(stores: Record<string, StoreAdapter>, fallbackFetch?: typeof fetch): { client: StripeClient; now?: () => Date } {
  const s = stores.stripe;
  if (isStripeStore(s) && (s.client.customFetch || !fallbackFetch)) return { client: s.client, now: s.now };
  if (fallbackFetch) {
    let c = fetchClients.get(fallbackFetch);
    if (!c) { c = new StripeClient({ fetch: fallbackFetch }); fetchClients.set(fallbackFetch, c); }
    return { client: c };
  }
  return { client: stripeStore.client };
}
const fetchClients = new WeakMap<typeof fetch, StripeClient>();
