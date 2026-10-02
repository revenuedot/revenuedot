import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { schema, type StorePrice } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { appleHttpFor } from "../stores/apple/index.js";
import { AppStoreConnectApi, ConnectError, connectCredentials, type AscPrice } from "../stores/apple/connect.js";
import { hasServiceAccount, moneyMicros, type PlayBasePlan } from "../stores/google/api.js";
import { listStoreProducts, type StoreListing } from "./store-import.js";
import { StoreOpError } from "./store-ops.js";

/**
 * Store prices and status (prd/catalog/PRD.md "Store prices and status"): what App Store Connect and Google Play charge
 * for each product in every territory, the period and the store's state, read through the existing store clients and
 * cached per app (`store_listings`, `store_listing_syncs`). Nothing is written to the store here.
 */

type App = typeof schema.apps.$inferSelect;
export type ListingRow = typeof schema.storeListings.$inferSelect;
export type SyncRow = typeof schema.storeListingSyncs.$inferSelect;

export interface PricedListing extends StoreListing {
  prices: StorePrice[];
  base: StorePrice | null;
  /** App Store: the subscription or in-app purchase id; Google Play: the product id. */
  storeRef: string | null;
  editable: boolean;
}

const APPLE = new Set(["app_store", "mac_app_store"]);
/** The stores whose prices RevenueDot reads (and the product editor writes). */
export const PRICE_STORES = new Set(["app_store", "mac_app_store", "play_store"]);
/** Store calls running at once while reading prices. */
const CONCURRENCY = 4;
/** The background tick refreshes an app's prices once a day. */
export const STALE_MS = 24 * 3600_000;

/** "9.99" → 9_990_000. Null for anything that is not a non-negative decimal. */
export function decimalMicros(v: string | number | null | undefined): number | null {
  const t = typeof v === "number" ? String(v) : (v ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 1_000_000 + Number((frac + "000000").slice(0, 6));
}

/** The price shown for a product: the United States when it has one there, else `preferred` (App Store base territory), else the first. */
export function basePrice(prices: StorePrice[], preferred?: string | null): StorePrice | null {
  return prices.find((p) => p.territory === "USA" || p.territory === "US") ?? (preferred ? prices.find((p) => p.territory === preferred) : undefined) ?? prices[0] ?? null;
}

const fromAscPrices = (list: AscPrice[]): StorePrice[] => list.flatMap((p) => {
  const micros = decimalMicros(p.customerPrice);
  return micros === null || !p.currency ? [] : [{ territory: p.territory, currency: p.currency, amount_micros: micros }];
});

/** A base plan's prices: one per region with a price. */
export function basePlanPrices(b: PlayBasePlan): StorePrice[] {
  return (b.regionalConfigs ?? []).flatMap((r) => {
    const micros = moneyMicros(r.price);
    return micros === null || !r.price?.currencyCode ? [] : [{ territory: r.regionCode, currency: r.price.currencyCode, amount_micros: micros }];
  }).sort((a, b) => a.territory.localeCompare(b.territory));
}

/** Errors from App Store Connect while reading prices, in the store-operation vocabulary. */
export function fromConnect(e: unknown): unknown {
  if (!(e instanceof ConnectError)) return e;
  if (e.kind === "credentials") {
    return new StoreOpError("credentials", e.status
      ? `App Store Connect refused the API key (${e.status}). Reading and changing prices needs a team key with the App Manager role (Users and Access → Integrations → App Store Connect API). An In-App Purchase key (a SubscriptionKey_….p8 file) only works with the App Store Server API and cannot read prices.`
      : `${e.message} Save the .p8 file of a team key with the App Manager role in the app's App Store Connect API key section.`);
  }
  return new StoreOpError(e.kind === "conflict" ? "invalid" : e.kind, e.message);
}

async function inBatches<T, R>(items: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) out.push(...await Promise.all(items.slice(i, i + CONCURRENCY).map(fn)));
  return out;
}

/** Reads every product of an App Store or Google Play app with its prices, period and state, live from the store. */
export async function readStorePrices(deps: Deps, app: App): Promise<{ store: string; items: PricedListing[]; warnings: string[] }> {
  if (!PRICE_STORES.has(app.type)) throw new StoreOpError("unsupported", `Store prices are read from App Store Connect and Google Play; this is a ${app.type} app.`);
  if (APPLE.has(app.type) && !connectCredentials(app)) {
    throw new StoreOpError("credentials", "Reading prices from App Store Connect needs the app's App Store Connect API key: a team key with the App Manager role (.p8 file, key ID and issuer ID). The In-App Purchase key cannot list or change prices.");
  }
  if (app.type === "play_store" && !hasServiceAccount(app)) {
    throw new StoreOpError("credentials", "Reading prices from Google Play needs the app's service account JSON, with the \"View app information and download bulk reports (read-only)\" permission in Play Console.");
  }
  const listing = await listStoreProducts(deps, app);
  const today = deps.now().toISOString().slice(0, 10);
  if (APPLE.has(app.type)) {
    const { fetchFn, now } = appleHttpFor(deps.stores, deps.fetch, deps.now);
    const api = new AppStoreConnectApi(connectCredentials(app)!, fetchFn, now);
    try {
      const items = await inBatches(listing.items, async (item): Promise<PricedListing> => {
        const ref = item.ref;
        if (ref?.kind === "asc_subscription") {
          const prices = fromAscPrices(await api.subscriptionPrices(ref.id, today));
          return { ...item, prices, base: basePrice(prices), storeRef: ref.id, editable: true };
        }
        if (ref?.kind === "asc_iap") {
          const schedule = await api.inAppPurchaseSchedule(ref.id, today);
          const byTerritory = new Map<string, AscPrice>();
          for (const p of schedule?.automatic ?? []) byTerritory.set(p.territory, p);
          for (const p of schedule?.manual ?? []) byTerritory.set(p.territory, p);
          const prices = fromAscPrices([...byTerritory.values()]).sort((a, b) => a.territory.localeCompare(b.territory));
          return { ...item, prices, base: basePrice(prices, schedule?.baseTerritory), storeRef: ref.id, editable: true };
        }
        return { ...item, prices: [], base: null, storeRef: null, editable: false };
      });
      return { store: listing.store, items, warnings: listing.warnings };
    } catch (e) {
      throw fromConnect(e);
    }
  }
  const items = listing.items.map((item): PricedListing => {
    const ref = item.ref;
    if (ref?.kind === "play_subscription") {
      const prices = basePlanPrices(ref.basePlan);
      return { ...item, prices, base: basePrice(prices), storeRef: ref.sub.productId, editable: true };
    }
    if (ref?.kind === "play_one_time") {
      const options = ref.product.purchaseOptions ?? [];
      const option = options.find((o) => o.state === "ACTIVE") ?? options[0];
      const prices = (option?.regionalPricingAndAvailabilityConfigs ?? []).flatMap((r) => {
        const micros = moneyMicros(r.price);
        return micros === null || !r.price?.currencyCode ? [] : [{ territory: r.regionCode, currency: r.price.currencyCode, amount_micros: micros }];
      }).sort((a, b) => a.territory.localeCompare(b.territory));
      return { ...item, prices, base: basePrice(prices), storeRef: ref.product.productId, editable: false };
    }
    if (ref?.kind === "play_inapp") {
      const prices = Object.entries(ref.product.prices ?? {}).flatMap(([region, p]) => {
        const micros = p.priceMicros !== undefined ? Number(p.priceMicros) : NaN;
        return Number.isFinite(micros) && p.currency ? [{ territory: region, currency: p.currency, amount_micros: micros }] : [];
      }).sort((a, b) => a.territory.localeCompare(b.territory));
      return { ...item, prices, base: basePrice(prices), storeRef: ref.product.sku, editable: false };
    }
    // A subscription without a base plan: nothing to price yet.
    return { ...item, prices: [], base: null, storeRef: item.group?.id ?? null, editable: false };
  });
  return { store: listing.store, items, warnings: listing.warnings };
}

/** Writes a fresh read into the cache, replacing what was there for the app. */
export async function saveListings(deps: Deps, app: App, items: PricedListing[]) {
  const now = deps.now();
  const rows = items.filter((i) => i.store_identifier).map((i) => ({
    appId: app.id, projectId: app.projectId, storeIdentifier: i.store_identifier, type: i.type, displayName: i.display_name, duration: i.duration,
    storeState: i.store_state, groupId: i.group?.id ?? null, groupName: i.group?.name ?? null, storeRef: i.storeRef,
    baseTerritory: i.base?.territory ?? null, baseCurrency: i.base?.currency ?? null, basePriceMicros: i.base?.amount_micros ?? null,
    prices: i.prices, editable: i.editable, note: i.note, refreshedAt: now,
  }));
  // One identifier once (a store never lists one twice, but a cache row per identifier is the key).
  const unique = [...new Map(rows.map((r) => [r.storeIdentifier, r])).values()];
  await deps.db.transaction(async (tx) => {
    await tx.delete(schema.storeListings).where(eq(schema.storeListings.appId, app.id));
    for (let i = 0; i < unique.length; i += 200) await tx.insert(schema.storeListings).values(unique.slice(i, i + 200));
    await tx.insert(schema.storeListingSyncs).values({ appId: app.id, projectId: app.projectId, status: "ok", error: null, itemCount: unique.length, refreshedAt: now })
      .onConflictDoUpdate({ target: schema.storeListingSyncs.appId, set: { status: "ok", error: null, itemCount: unique.length, refreshedAt: now } });
  });
}

async function recordFailure(deps: Deps, app: App, e: unknown) {
  const now = deps.now();
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
  await deps.db.insert(schema.storeListingSyncs).values({ appId: app.id, projectId: app.projectId, status: "failing", error: message, itemCount: 0, refreshedAt: now })
    .onConflictDoUpdate({ target: schema.storeListingSyncs.appId, set: { status: "failing", error: message, refreshedAt: now } });
}

/**
 * Reads the app's prices from the store and replaces its cache. A failure is recorded on the app's sync row (the old
 * prices stay, marked by the failed refresh) and thrown as a StoreOpError.
 */
export async function refreshStorePrices(deps: Deps, app: App) {
  let read;
  try {
    read = await readStorePrices(deps, app);
  } catch (e) {
    if (e instanceof StoreOpError) await recordFailure(deps, app, e);
    throw e;
  }
  await saveListings(deps, app, read.items);
  return read;
}

/** Cached store products of a project (optionally one app), with each app's last refresh. */
export async function cachedListings(deps: Deps, projectId: string, appId?: string): Promise<{ rows: ListingRow[]; syncs: SyncRow[] }> {
  const L = schema.storeListings, S = schema.storeListingSyncs;
  const rows = await deps.db.select().from(L).where(and(eq(L.projectId, projectId), ...(appId ? [eq(L.appId, appId)] : [])));
  const syncs = await deps.db.select().from(S).where(and(eq(S.projectId, projectId), ...(appId ? [eq(S.appId, appId)] : [])));
  return { rows: rows.sort((a, b) => a.appId.localeCompare(b.appId) || a.storeIdentifier.localeCompare(b.storeIdentifier)), syncs };
}

/**
 * RevenueCat's `indicative_price` ("in the default currency/country (USD / US)"): the Test Store price; else the store's
 * price in the United States, or its base territory; else a Stripe web product's price. Null when none is known.
 */
export function indicativePriceOf(p: { testStorePriceMicros: number | null; testStorePriceCurrency: string | null }, listing?: ListingRow | null, web?: { amountMinorMicros: number; currency: string } | null) {
  if (p.testStorePriceMicros !== null && p.testStorePriceCurrency) return { object: "indicative_price" as const, currency: p.testStorePriceCurrency, country: null, amount_micros: p.testStorePriceMicros };
  if (listing?.basePriceMicros !== null && listing?.basePriceMicros !== undefined && listing.baseCurrency) {
    const t = listing.baseTerritory;
    return { object: "indicative_price" as const, currency: listing.baseCurrency.toUpperCase(), country: t === "USA" || t === "US" ? "US" : t && /^[A-Z]{2}$/.test(t) ? t : null, amount_micros: listing.basePriceMicros };
  }
  if (web) return { object: "indicative_price" as const, currency: web.currency.toUpperCase(), country: null, amount_micros: web.amountMinorMicros };
  return null;
}

/** `store_details` (extension) for a product: the cached store status and base price. */
export function storeDetailsOf(listing: ListingRow | null | undefined, sync: SyncRow | null | undefined) {
  if (!listing) return null;
  return {
    object: "store_details" as const, status: listing.storeState ? listing.storeState.toLowerCase() : null, store_state: listing.storeState,
    price: listing.basePriceMicros !== null && listing.baseCurrency ? { amount_micros: listing.basePriceMicros, currency: listing.baseCurrency, territory: listing.baseTerritory } : null,
    territories: listing.prices.length, duration: listing.duration, display_name: listing.displayName, editable: listing.editable,
    refreshed_at: listing.refreshedAt.getTime(), refresh_status: sync?.status ?? null,
  };
}

/** Apps whose prices are due: App Store apps with an App Store Connect key and Play apps with a service account, not refreshed today. */
export async function refreshDueStorePrices(deps: Deps, max = 5): Promise<number> {
  const now = deps.now();
  const S = schema.storeListingSyncs, A = schema.apps;
  const due = await deps.db.select({ app: A }).from(A).leftJoin(S, eq(S.appId, A.id))
    .where(and(
      inArray(A.type, [...PRICE_STORES]),
      or(isNull(S.refreshedAt), lt(S.refreshedAt, new Date(now.getTime() - STALE_MS))),
      or(
        and(inArray(A.type, [...APPLE]), sql`(${A.credentials} ->> 'app_store_connect_api_key') is not null`),
        and(eq(A.type, "play_store"), sql`coalesce(${A.credentials} ->> 'play_service_account_credentials_json', ${A.credentials} ->> 'service_account') is not null`),
      ),
    ))
    .orderBy(sql`${S.refreshedAt} asc nulls first`).limit(max * 2);
  let done = 0;
  for (const { app } of due) {
    if (done >= max) break;
    if (APPLE.has(app.type) ? !connectCredentials(app) : !hasServiceAccount(app)) continue;
    done++;
    try { await refreshStorePrices(deps, app); } catch (e) {
      if (!(e instanceof StoreOpError)) console.error("store prices: refresh failed", app.id, e);
    }
  }
  return done;
}
