import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { RCError } from "../errors.js";
import type { AppRow } from "../stores/types.js";
import { appleHttpFor } from "../stores/apple/index.js";
import { AppStoreConnectApi, ConnectError, connectCredentials, type Resource } from "../stores/apple/connect.js";
import { GoogleApiError, hasServiceAccount, type PlayInAppProduct, type PlayOneTimeProduct, type PlaySubscription } from "../stores/google/api.js";
import { googleClientFor } from "../stores/google/index.js";
import { StripeApiError, stripeKeyOf } from "../stores/stripe/api.js";
import { stripeClientFor } from "../stores/stripe/index.js";
import { fromMinor } from "../stores/stripe/map.js";
import { StoreOpError } from "./store-ops.js";
import { withStoreSecrets } from "./store-secrets.js";

/**
 * Import products from the store (prd/catalog/PRD.md, "Import from store"): list what App Store Connect, Google Play or
 * Stripe has for an app, mark what the catalog already has, and create the chosen products with their store type,
 * duration and name, optionally attached to entitlements. Uses the app's stored credentials through the existing store
 * clients; nothing is written to the store. Failures are StoreOpErrors (the route maps them to v2 errors).
 */

type App = typeof schema.apps.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;

export interface StoreListing {
  /** The catalog's store identifier: App Store product id, `subscription:base_plan` or the one-time product id on Google Play, a Stripe price id. */
  store_identifier: string;
  type: "subscription" | "consumable" | "non_consumable" | "non_renewing_subscription" | "one_time";
  display_name: string | null;
  /** ISO 8601 period for subscriptions. */
  duration: string | null;
  /** The store's own state (`APPROVED`, `READY_TO_SUBMIT`, `ACTIVE`, `DRAFT` ...), when it reports one. */
  store_state: string | null;
  /** The App Store subscription group, the Google Play subscription, or the Stripe product the item belongs to. */
  group: { id: string; name: string | null } | null;
  /** Stripe only: the price. */
  price: { amount_micros: number; currency: string } | null;
  importable: boolean;
  /** Why the item cannot be imported, or a caveat about it. */
  note: string | null;
  /** Stripe only, not in answers: what web billing needs to sell the price. */
  stripe?: { product: string; amount_minor: number | null; currency: string; interval: string | null; interval_count: number | null; trial_days: number | null };
}

export interface StoreListingResult { store: string; items: StoreListing[]; warnings: string[] }

const APPLE = new Set(["app_store", "mac_app_store"]);
const MAX_ITEMS = 5000;

const ASC_PERIOD: Record<string, string> = { ONE_WEEK: "P1W", ONE_MONTH: "P1M", TWO_MONTHS: "P2M", THREE_MONTHS: "P3M", SIX_MONTHS: "P6M", ONE_YEAR: "P1Y" };
const ASC_IAP_TYPE: Record<string, StoreListing["type"]> = { CONSUMABLE: "consumable", NON_CONSUMABLE: "non_consumable", NON_RENEWING_SUBSCRIPTION: "non_renewing_subscription" };
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What the store has for this app. Throws StoreOpError for missing credentials, refused permissions and outages. */
export async function listStoreProducts(deps: Deps, app: App): Promise<StoreListingResult> {
  if (APPLE.has(app.type)) return listAppStore(deps, app);
  if (app.type === "play_store") return listPlay(deps, app);
  if (app.type === "stripe") return listStripe(deps, app);
  if (app.type === "amazon") {
    throw new StoreOpError("unsupported", "Amazon has no API that lists an app's in-app items, so they cannot be imported. Add each product with New product: a subscription by its term SKU, a one-time product by its SKU.");
  }
  if (app.type === "test_store") throw new StoreOpError("unsupported", "Test Store products exist only in RevenueDot. Create them with New product.");
  throw new StoreOpError("unsupported", `Products can be imported from App Store Connect, Google Play and Stripe; this is a ${app.type} app.`);
}

// ---- App Store Connect --------------------------------------------------------------------------------------------

async function listAppStore(deps: Deps, app: App): Promise<StoreListingResult> {
  const creds = connectCredentials(app);
  if (!creds) {
    throw new StoreOpError("credentials", "Importing from App Store Connect needs the app's App Store Connect API key (a team key with the App Manager role): add the .p8 file, its key ID and the issuer ID in the app's settings. The In-App Purchase key cannot read the product list.");
  }
  if (!app.bundleId) throw new StoreOpError("credentials", "The app has no bundle ID. Add it in the app's settings.");
  const { fetchFn, now } = appleHttpFor(deps.stores, deps.fetch, deps.now);
  const api = new AppStoreConnectApi(creds, fetchFn, now);
  const warnings: string[] = [];
  const items: StoreListing[] = [];
  try {
    const ascApp = await api.appByBundleId(app.bundleId);
    if (!ascApp) throw new StoreOpError("invalid", `App Store Connect has no app with bundle ID ${app.bundleId} that this API key can see. Check the bundle ID, or use a key from the team that owns the app.`);
    const groups = await api.subscriptionGroups(ascApp.id);
    if (groups.truncated) warnings.push("App Store Connect has more subscription groups than RevenueDot reads at once; only the first 5,000 are listed.");
    for (const g of groups.data) {
      const subs = await api.subscriptions(g.id);
      if (subs.truncated) warnings.push(`Only the first 5,000 subscriptions of the group ${str(g.attributes?.referenceName) ?? g.id} are listed.`);
      const sorted = [...subs.data].sort((a, b) => Number(a.attributes?.groupLevel ?? 0) - Number(b.attributes?.groupLevel ?? 0));
      for (const s of sorted) items.push(appleSubscription(s, g));
    }
    const iaps = await api.inAppPurchases(ascApp.id);
    if (iaps.truncated) warnings.push("Only the first 5,000 in-app purchases are listed.");
    for (const p of iaps.data) items.push(appleIap(p));
  } catch (e) {
    if (e instanceof ConnectError) {
      // Status 0: the saved .p8 could not be read, so App Store Connect was never asked.
      if (e.kind === "credentials" && !e.status) throw new StoreOpError("credentials", `${e.message} Save the .p8 file of a team key with the App Manager role in the app's App Store Connect API key section.`);
      if (e.kind === "credentials") {
        const c = app.credentials ?? {};
        const iapKeyId = typeof c.subscription_key_id === "string" ? c.subscription_key_id : typeof c.key_id === "string" ? c.key_id : null;
        if (e.status === 401 && iapKeyId && iapKeyId.trim() === creds.keyId) {
          throw new StoreOpError("credentials", `The App Store Connect API key saved for this app is its In-App Purchase key (key ID ${creds.keyId}), and App Store Connect does not accept In-App Purchase keys. Create a team key with the App Manager role under Users and Access → Integrations → App Store Connect API, and save it in the app's App Store Connect API key section.`);
        }
        const said = e.message.replace(/^App Store Connect refused the API key \((.*)\)\. It needs the App Manager role\.$/s, "$1");
        throw new StoreOpError("credentials", `App Store Connect refused the API key (${e.status || "no answer"}). Reading in-app purchases and subscriptions needs a team key with the App Manager role (Users and Access → Integrations → App Store Connect API); a Developer or Finance key is not enough.${e.status === 401 ? " An In-App Purchase key (a SubscriptionKey_….p8 file) only works with the App Store Server API and cannot read the product list." : ""} Apple said: ${said.replace(/[^.]$/, "$&.")}`);
      }
      throw new StoreOpError(e.kind === "conflict" ? "invalid" : e.kind, e.message);
    }
    throw e;
  }
  return { store: app.type, items: items.filter((i) => i.store_identifier).slice(0, MAX_ITEMS), warnings };
}

function appleSubscription(s: Resource, g: Resource): StoreListing {
  const a = s.attributes ?? {};
  const period = str(a.subscriptionPeriod);
  const duration = period ? ASC_PERIOD[period] ?? null : null;
  return {
    store_identifier: str(a.productId) ?? "", type: "subscription", display_name: str(a.name), duration, store_state: str(a.state),
    group: { id: g.id, name: str(g.attributes?.referenceName) }, price: null, importable: true,
    note: period && !duration ? `App Store Connect reports the period ${period}, which RevenueDot does not know. Set the duration after importing.` : !period ? "No duration is set in App Store Connect yet. Set it after importing; MRR uses it." : null,
  };
}

function appleIap(p: Resource): StoreListing {
  const a = p.attributes ?? {};
  const kind = str(a.inAppPurchaseType);
  return {
    store_identifier: str(a.productId) ?? "", type: (kind && ASC_IAP_TYPE[kind]) || "non_consumable", display_name: str(a.name), duration: null,
    store_state: str(a.state), group: null, price: null, importable: true,
    note: kind && !ASC_IAP_TYPE[kind] ? `App Store Connect reports the type ${kind}; it is imported as non-consumable. Change the type after importing if needed.` : null,
  };
}

// ---- Google Play --------------------------------------------------------------------------------------------------

const PLAY_READ_PERMISSION = "\"View app information and download bulk reports (read-only)\"";

/** The title in English when there is one, else the first listing's. */
function playTitle(listings: Array<{ languageCode?: string; title?: string }> | undefined): string | null {
  const l = listings ?? [];
  const pick = l.find((x) => x.languageCode === "en-US") ?? l.find((x) => x.languageCode?.startsWith("en")) ?? l[0];
  return str(pick?.title);
}

function fromPlay(e: unknown): unknown {
  if (!(e instanceof GoogleApiError)) return e;
  if (e.kind === "credentials" && e.status === 403) {
    return new StoreOpError("credentials", `Google Play refused the service account (403). Listing products needs the ${PLAY_READ_PERMISSION} permission for this app: Play Console → Users and permissions → the service account → App permissions. Google said: ${e.message.replace(/\. Grant the service account access to this app in Play Console\.$/, ".")}`);
  }
  if (e.kind === "credentials") return new StoreOpError("credentials", `Google Play refused the service account: ${e.message}`);
  if (e.kind === "transient") return new StoreOpError("unavailable", `Google Play could not be reached: ${e.message}`);
  return new StoreOpError("invalid", `Google Play refused the request: ${e.message}`);
}

async function listPlay(deps: Deps, app: App): Promise<StoreListingResult> {
  if (!hasServiceAccount(app)) {
    throw new StoreOpError("credentials", `Importing from Google Play needs the app's service account JSON, with the ${PLAY_READ_PERMISSION} permission in Play Console. Add it in the app's settings.`);
  }
  const { client } = googleClientFor(deps.stores, deps.fetch);
  const row = app as AppRow;
  const items: StoreListing[] = [];
  const warnings: string[] = [];
  try {
    const subs = await client.listSubscriptions(row);
    if (subs.truncated) warnings.push("Only the first 2,500 Google Play subscriptions are listed.");
    for (const s of subs.items) items.push(...playSubscription(s));
    let oneTime: StoreListing[];
    try {
      const r = await client.listOneTimeProducts(row);
      if (r.truncated) warnings.push("Only the first 2,500 Google Play one-time products are listed.");
      oneTime = r.items.map(playOneTime);
    } catch (e) {
      // Older Play setups without the one-time products API: the legacy in-app products list has the same products.
      if (!(e instanceof GoogleApiError) || (e.status !== 404 && e.status !== 400)) throw e;
      const r = await client.listInAppProducts(row);
      if (r.truncated) warnings.push("Only the first 2,500 Google Play in-app products are listed.");
      oneTime = r.items.filter((p) => p.purchaseType !== "subscription").map(playInAppProduct);
    }
    items.push(...oneTime);
  } catch (e) {
    throw fromPlay(e);
  }
  return { store: "play_store", items: items.slice(0, MAX_ITEMS), warnings };
}

function playSubscription(s: PlaySubscription): StoreListing[] {
  if (s.archived) return [];
  const title = playTitle(s.listings);
  const plans = s.basePlans ?? [];
  if (!plans.length) {
    return [{
      store_identifier: s.productId, type: "subscription", display_name: title, duration: null, store_state: null, group: { id: s.productId, name: title },
      price: null, importable: false, note: "This subscription has no base plan yet. Add one in Play Console, then import it as subscription:base_plan.",
    }];
  }
  return plans.map((b) => {
    const period = b.autoRenewingBasePlanType?.billingPeriodDuration ?? b.prepaidBasePlanType?.billingPeriodDuration ?? b.installmentsBasePlanType?.billingPeriodDuration ?? null;
    return {
      store_identifier: `${s.productId}:${b.basePlanId}`, type: "subscription" as const,
      display_name: title ? (plans.length > 1 ? `${title} (${b.basePlanId})` : title) : null,
      duration: period && /^P(?=\d)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?$/.test(period) ? period : null,
      store_state: b.state ?? null, group: { id: s.productId, name: title }, price: null, importable: true,
      note: b.prepaidBasePlanType ? "Prepaid base plan: it does not renew by itself." : b.installmentsBasePlanType ? "Installment base plan." : null,
    };
  });
}

function playOneTime(p: PlayOneTimeProduct): StoreListing {
  const options = p.purchaseOptions ?? [];
  const active = options.some((o) => o.state === "ACTIVE");
  const legacy = options.some((o) => o.buyOption?.legacyCompatible);
  return {
    store_identifier: p.productId, type: "one_time", display_name: playTitle(p.listings), duration: null,
    store_state: active ? "ACTIVE" : options[0]?.state ?? null, group: null, price: null, importable: true,
    note: options.length && !legacy ? "No purchase option is marked backwards compatible in Play Console; SDK versions that predate purchase options cannot buy it." : null,
  };
}

function playInAppProduct(p: PlayInAppProduct): StoreListing {
  const l = p.listings ?? {};
  const title = str((p.defaultLanguage ? l[p.defaultLanguage]?.title : undefined) ?? l["en-US"]?.title ?? Object.values(l)[0]?.title);
  return {
    store_identifier: p.sku, type: "one_time", display_name: title, duration: null, store_state: p.status ? p.status.toUpperCase() : null,
    group: null, price: null, importable: true, note: null,
  };
}

// ---- Stripe -------------------------------------------------------------------------------------------------------

interface StripeProductObj { id: string; name?: string; active?: boolean; default_price?: string | { id: string } | null }
interface StripePriceObj {
  id: string; product: string | { id: string }; active?: boolean; type?: string; unit_amount?: number | null; currency: string; nickname?: string | null;
  billing_scheme?: string; recurring?: { interval?: string; interval_count?: number; usage_type?: string; trial_period_days?: number | null } | null;
}

const STRIPE_PERMISSION = "the \"Products\" permission set to Read (it covers products and prices)";

function fromStripe(e: unknown): unknown {
  if (e instanceof RCError) return new StoreOpError("credentials", e.message);
  if (!(e instanceof StripeApiError)) return e;
  if (e.kind === "credentials") {
    const named = /rak_(product|price|plan)_read/.test(e.message) || e.status === 403;
    return new StoreOpError("credentials", named
      ? `Stripe refused the restricted key (${e.status}). Listing products needs ${STRIPE_PERMISSION}. Stripe said: ${e.message}`
      : `Stripe refused the key (${e.status}). Check the app's restricted key. Stripe said: ${e.message}`);
  }
  if (e.kind === "transient") return new StoreOpError("unavailable", `Stripe could not be reached: ${e.message}`);
  return new StoreOpError("invalid", `Stripe refused the request: ${e.message}`);
}

const intervalLabel = (interval: string | null | undefined, n: number | null | undefined) => {
  const c = n ?? 1;
  if (!interval) return "one-time";
  if (c === 1) return { day: "daily", week: "weekly", month: "monthly", year: "yearly" }[interval] ?? interval;
  return `every ${c} ${interval}s`;
};
const stripeDuration = (interval: string | undefined, n: number | undefined) => {
  const c = n ?? 1;
  return interval === "day" ? `P${c}D` : interval === "week" ? `P${c}W` : interval === "month" ? (c % 12 === 0 ? `P${c / 12}Y` : `P${c}M`) : interval === "year" ? `P${c}Y` : null;
};

async function listStripe(deps: Deps, a: App): Promise<StoreListingResult> {
  const app = await withStoreSecrets(deps, a);
  if (!stripeKeyOf(app)) throw new StoreOpError("credentials", `Importing from Stripe needs the app's restricted key with ${STRIPE_PERMISSION}. Add it in the app's settings.`);
  const { client } = stripeClientFor(deps.stores, deps.fetch);
  const warnings: string[] = [];
  let products: StripeProductObj[];
  let prices: StripePriceObj[];
  try {
    const p = await client.listAll<StripeProductObj>(app, "/v1/products", { active: "true" });
    const q = await client.listAll<StripePriceObj>(app, "/v1/prices", { active: "true" });
    if (p.truncated || q.truncated) warnings.push("Only the first 5,000 Stripe products and prices are listed.");
    products = p.data; prices = q.data;
  } catch (e) {
    throw fromStripe(e);
  }
  const byProduct = new Map<string, StripePriceObj[]>();
  for (const pr of prices) {
    const pid = typeof pr.product === "string" ? pr.product : pr.product?.id;
    if (!pid) continue;
    byProduct.set(pid, [...(byProduct.get(pid) ?? []), pr]);
  }
  const items: StoreListing[] = [];
  for (const prod of products) {
    const name = str(prod.name);
    const own = byProduct.get(prod.id) ?? [];
    const group = { id: prod.id, name };
    if (!own.length) {
      items.push({ store_identifier: prod.id, type: "non_consumable", display_name: name, duration: null, store_state: null, group, price: null, importable: false, note: "This product has no active price in Stripe. Add a price, then import it." });
      continue;
    }
    const defaultPrice = typeof prod.default_price === "string" ? prod.default_price : prod.default_price?.id;
    own.sort((x, y) => (x.id === defaultPrice ? -1 : y.id === defaultPrice ? 1 : 0));
    for (const pr of own) {
      const rec = pr.recurring ?? null;
      const metered = rec?.usage_type === "metered";
      const label = str(pr.nickname) ?? intervalLabel(rec?.interval, rec?.interval_count);
      items.push({
        store_identifier: pr.id, type: rec ? "subscription" : "non_consumable",
        display_name: name ? (own.length > 1 ? `${name} (${label})` : name) : str(pr.nickname),
        duration: rec ? stripeDuration(rec.interval, rec.interval_count) : null, store_state: "ACTIVE", group,
        price: typeof pr.unit_amount === "number" ? { amount_micros: Math.round(fromMinor(pr.unit_amount, pr.currency) * 1_000_000), currency: pr.currency.toUpperCase() } : null,
        importable: !metered,
        note: metered ? "Metered (usage-based) prices cannot be tracked as app purchases." : pr.billing_scheme === "tiered" ? "Tiered price: purchases are tracked, but RevenueDot's checkout cannot sell it." : !rec ? "One-time price: imported as non-consumable. Change it to consumable after importing if it can be bought again." : null,
        stripe: { product: prod.id, amount_minor: typeof pr.unit_amount === "number" && pr.billing_scheme !== "tiered" ? pr.unit_amount : null, currency: pr.currency.toLowerCase(), interval: rec?.interval ?? null, interval_count: rec?.interval_count ?? null, trial_days: rec?.trial_period_days ?? null },
      });
    }
  }
  return { store: "stripe", items: items.slice(0, MAX_ITEMS), warnings };
}

// ---- Catalog --------------------------------------------------------------------------------------------------------

/** The catalog product an item is already in: its own identifier, or for a Stripe price the product id it belongs to. */
export function catalogMatch(item: StoreListing, byIdentifier: Map<string, ProductRow>): ProductRow | null {
  return byIdentifier.get(item.store_identifier) ?? (item.stripe ? byIdentifier.get(item.stripe.product) ?? null : null);
}

export async function catalogOf(deps: Deps, app: App) {
  const rows = await deps.db.select().from(schema.products).where(and(eq(schema.products.projectId, app.projectId), eq(schema.products.appId, app.id)));
  return new Map(rows.map((r) => [r.storeIdentifier, r]));
}

export interface ImportResult {
  created: ProductRow[];
  existing: ProductRow[];
  failed: { store_identifier: string; reason: "not_in_store" | "not_importable"; message: string }[];
  entitlement_ids: string[];
}

/**
 * Creates the chosen store products in the catalog. Products already in the catalog are left as they are (and still
 * attached to the chosen entitlements), so running the same import twice changes nothing.
 */
export async function importStoreProducts(deps: Deps, app: App, identifiers: string[], entitlementIds: string[]): Promise<ImportResult> {
  const { db } = deps;
  const listing = await listStoreProducts(deps, app);
  const byId = new Map(listing.items.map((i) => [i.store_identifier, i]));
  const catalog = await catalogOf(deps, app);
  const out: ImportResult = { created: [], existing: [], failed: [], entitlement_ids: entitlementIds };
  const now = deps.now();
  for (const id of identifiers) {
    const item = byId.get(id);
    if (!item) {
      const known = catalog.get(id);
      if (known) { out.existing.push(known); continue; }
      out.failed.push({ store_identifier: id, reason: "not_in_store", message: `${id} was not found in the store for this app.` });
      continue;
    }
    const match = catalogMatch(item, catalog);
    if (match) { out.existing.push(match); continue; }
    if (!item.importable) { out.failed.push({ store_identifier: id, reason: "not_importable", message: item.note ?? `${id} cannot be imported.` }); continue; }
    const [row] = await db.insert(schema.products).values({
      id: newId("prod", 14), projectId: app.projectId, appId: app.id, storeIdentifier: item.store_identifier, type: item.type,
      displayName: item.display_name?.slice(0, 255) ?? null, duration: item.type === "subscription" ? item.duration : null, createdAt: now,
    }).onConflictDoNothing().returning();
    if (!row) {
      // Created by a concurrent import a moment ago.
      const [again] = await db.select().from(schema.products).where(and(eq(schema.products.appId, app.id), eq(schema.products.storeIdentifier, item.store_identifier))).limit(1);
      if (again) out.existing.push(again);
      continue;
    }
    catalog.set(row.storeIdentifier, row);
    out.created.push(row);
    // A flat-rate Stripe price can also be sold through RevenueDot's web checkout, like a product made on the Web page.
    const s = item.stripe;
    if (s && s.amount_minor !== null) {
      await db.insert(schema.webProducts).values({
        productId: row.id, projectId: app.projectId, appId: app.id, stripeProductId: s.product, stripePriceId: item.store_identifier, amountMinor: s.amount_minor,
        currency: s.currency, interval: s.interval, intervalCount: s.interval_count, trialDays: s.trial_days, createdAt: now,
      }).onConflictDoNothing();
    }
  }
  const productIds = [...new Set([...out.created, ...out.existing].map((p) => p.id))];
  if (entitlementIds.length && productIds.length) {
    await db.insert(schema.entitlementProducts).values(entitlementIds.flatMap((entitlementId) => productIds.map((productId) => ({ entitlementId, productId })))).onConflictDoNothing();
  }
  return out;
}

/** The entitlements of this project among `ids`, or the first id that is not one. */
export async function projectEntitlements(deps: Deps, projectId: string, ids: string[]) {
  if (!ids.length) return { rows: [], missing: null as string | null };
  const rows = await deps.db.select().from(schema.entitlements).where(and(eq(schema.entitlements.projectId, projectId), inArray(schema.entitlements.id, ids)));
  const found = new Set(rows.map((r) => r.id));
  return { rows, missing: ids.find((i) => !found.has(i)) ?? null };
}
