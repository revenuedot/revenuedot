import { and, eq, inArray } from "drizzle-orm";
import { accessEndsAt, commission, computeEntitlements, isActive, willRenew, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { entitlementMap } from "../../repo/catalog.js";
import { loadState, subRowToDomain, type CustomerRow } from "../../repo/customers.js";
import type { Access } from "../../repo/access.js";
import { embeddedList, ms, round2 } from "./common.js";
import { storeSecretSet } from "../../services/store-secrets.js";
import { hasServiceAccount } from "../../stores/google/api.js";

/** Serializers from our rows to RevenueCat API v2 objects. */

type AppRow = typeof schema.apps.$inferSelect;
type ProductRow = typeof schema.products.$inferSelect;
type EntitlementRow = typeof schema.entitlements.$inferSelect;
type OfferingRow = typeof schema.offerings.$inferSelect;
type PackageRow = typeof schema.packages.$inferSelect;
type SubRow = typeof schema.subscriptions.$inferSelect;
type NonSubRow = typeof schema.nonSubscriptions.$inferSelect;

export const base = (projectId: string) => `/v2/projects/${encodeURIComponent(projectId)}`;

export function projectShape(p: typeof schema.projects.$inferSelect) {
  return { object: "project" as const, id: p.id, name: p.name, created_at: p.createdAt.getTime(), icon_url: null, icon_url_large: null };
}

/**
 * Store credentials live in `apps.credentials` under RevenueCat's create/update field names
 * (`subscription_private_key`, `subscription_key_id`, `subscription_key_issuer`, `shared_secret`,
 * `app_store_connect_api_key*`, `play_service_account_credentials_json` ...). Secrets are never returned.
 */
const has = (cr: Record<string, unknown>, ...keys: string[]) => keys.every((k) => typeof cr[k] === "string" && (cr[k] as string).length > 0);
export const appleKeyConfigured = (cr: Record<string, unknown>) => has(cr, "subscription_private_key", "subscription_key_id", "subscription_key_issuer");
/** A Play service account under either field the Play adapter reads (RevenueCat's name, or `service_account`, as JSON text or an object). */
export const googleKeyConfigured = (cr: Record<string, unknown>) => hasServiceAccount({ credentials: cr });
/** Amazon and Stripe secrets are sealed in apps.secrets; their hints say whether they are set (services/store-secrets.ts). */
export const amazonKeyConfigured = (a: Pick<AppRow, "type" | "credentials" | "secretHints">) => storeSecretSet(a, "shared_secret");
export const stripeKeyConfigured = (a: Pick<AppRow, "type" | "credentials" | "secretHints">) => storeSecretSet(a, "stripe_secret_key");
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The store segment of an app's notification URL (`/v1/notifications/{store}/{app_id}`), or null when it has none. */
export const notificationStoreOf = (type: string) =>
  type === "app_store" || type === "mac_app_store" ? "apple" : type === "play_store" ? "google" : type === "amazon" ? "amazon" : type === "stripe" ? "stripe" : null;

/** Whether the credentials RevenueDot needs to check purchases are saved. */
export function storeCredentialsConfigured(a: Pick<AppRow, "type" | "credentials" | "secretHints">): boolean {
  const cr = a.credentials ?? {};
  switch (notificationStoreOf(a.type)) {
    case "apple": return appleKeyConfigured(cr);
    case "google": return googleKeyConfigured(cr);
    case "amazon": return amazonKeyConfigured(a);
    case "stripe": return stripeKeyConfigured(a);
    default: return a.type === "test_store" || Object.keys(cr).length > 0;
  }
}

export function appShape(a: AppRow) {
  const cr = a.credentials ?? {};
  const common = { object: "app" as const, id: a.id, name: a.name, created_at: a.createdAt.getTime(), type: a.type, project_id: a.projectId, custom_url_scheme: `rc-${a.publicKey.replace(/^[a-z]+_/, "").slice(0, 10).toLowerCase()}` };
  switch (a.type) {
    case "app_store":
      return { ...common, app_store: { bundle_id: a.bundleId ?? "", app_store_connect_api_key_configured: has(cr, "app_store_connect_api_key", "app_store_connect_api_key_id", "app_store_connect_api_key_issuer"), subscription_key_configured: appleKeyConfigured(cr), app_store_connect_vendor_number: str(cr.app_store_connect_vendor_number) } };
    case "mac_app_store":
      return { ...common, mac_app_store: { bundle_id: a.bundleId ?? "" } };
    case "play_store":
      return { ...common, play_store: { package_name: a.bundleId ?? "", play_service_account_credentials_configured: googleKeyConfigured(cr) } };
    case "amazon":
      return { ...common, amazon: { package_name: a.bundleId ?? "" } };
    case "stripe":
      return { ...common, stripe: { stripe_account_id: str(cr.stripe_account_id) } };
    case "rc_billing": {
      const name = str(cr.app_name) ?? a.name;
      return { ...common, rc_billing: { stripe_account_id: str(cr.stripe_account_id), seller_company_name: name, app_name: name, support_email: str(cr.support_email), default_currency: str(cr.default_currency) ?? "USD" } };
    }
    case "roku":
      return { ...common, roku: { roku_channel_id: str(cr.roku_channel_id), roku_channel_name: str(cr.roku_channel_name) } };
    case "paddle":
      return { ...common, paddle: { paddle_is_sandbox: cr.paddle_is_sandbox === true, paddle_api_key: null } };
    default:
      return common;
  }
}

/**
 * `expand=indicative_price` (RevenueCat's name): the Test Store price when the product has one. RevenueDot has no
 * App Store or Google Play price source yet, so every other product reports null.
 */
export function indicativePrice(p: ProductRow) {
  return p.testStorePriceMicros !== null && p.testStorePriceCurrency
    ? { object: "indicative_price" as const, currency: p.testStorePriceCurrency, country: null, amount_micros: p.testStorePriceMicros }
    : null;
}

export function productShape(p: ProductRow, app?: AppRow | null, withPrice = false) {
  const isSub = p.type === "subscription";
  const oneTime = p.type === "consumable" || p.type === "non_consumable" || p.type === "one_time" || p.type === "non_renewing_subscription";
  return {
    object: "product" as const, id: p.id, store_identifier: p.storeIdentifier, type: p.type, state: p.state,
    ...(isSub ? { subscription: { duration: p.duration ?? null, grace_period_duration: null, trial_duration: null } } : {}),
    ...(oneTime ? { one_time: { is_consumable: p.type === "consumable" ? true : p.type === "non_consumable" ? false : null } } : {}),
    created_at: p.createdAt.getTime(), app_id: p.appId, display_name: p.displayName ?? null,
    ...(withPrice ? { indicative_price: indicativePrice(p) } : {}),
    ...(app ? { app: appShape(app) } : {}),
  };
}

export function entitlementShape(e: EntitlementRow, products?: { rows: ProductRow[]; apps?: Map<string, AppRow> }) {
  return {
    object: "entitlement" as const, id: e.id, project_id: e.projectId, lookup_key: e.lookupKey, display_name: e.displayName,
    created_at: e.createdAt.getTime(), state: e.state,
    ...(products ? { products: embeddedList(`${base(e.projectId)}/entitlements/${e.id}/products`, products.rows.map((p) => productShape(p, products.apps?.get(p.appId)))) } : {}),
  };
}

export interface PackageExpansion { products: { product: ProductRow; eligibility: string }[] }

export function packageShape(pk: PackageRow, projectId: string, exp?: PackageExpansion) {
  return {
    object: "package" as const, id: pk.id, lookup_key: pk.lookupKey, display_name: pk.displayName, position: pk.position, created_at: pk.createdAt.getTime(),
    ...(exp ? { products: embeddedList(`${base(projectId)}/packages/${pk.id}/products`, exp.products.map((x) => ({ product: productShape(x.product), eligibility_criteria: x.eligibility }))) } : {}),
  };
}

export function offeringShape(o: OfferingRow, pkgs?: { rows: PackageRow[]; products?: Map<string, PackageExpansion> }, paywallId: string | null = null) {
  return {
    object: "offering" as const, id: o.id, lookup_key: o.lookupKey, display_name: o.displayName, is_current: o.isCurrent,
    created_at: o.createdAt.getTime(), project_id: o.projectId, state: o.state, paywall_id: paywallId, metadata: o.metadata ?? null,
    ...(pkgs ? { packages: embeddedList(`${base(o.projectId)}/offerings/${o.id}/packages`, pkgs.rows.map((p) => packageShape(p, o.projectId, pkgs.products?.get(p.id)))) } : {}),
  };
}

/** Products attached to packages, for expansion. */
export async function packageProducts(db: DB, packageIds: string[]): Promise<Map<string, PackageExpansion>> {
  const out = new Map<string, PackageExpansion>();
  for (const id of packageIds) out.set(id, { products: [] });
  if (!packageIds.length) return out;
  const rows = await db.select({ pp: schema.packageProducts, p: schema.products }).from(schema.packageProducts)
    .innerJoin(schema.products, eq(schema.products.id, schema.packageProducts.productId)).where(inArray(schema.packageProducts.packageId, packageIds));
  rows.sort((a, b) => a.p.createdAt.getTime() - b.p.createdAt.getTime() || a.p.id.localeCompare(b.p.id));
  for (const r of rows) out.get(r.pp.packageId)!.products.push({ product: r.p, eligibility: r.pp.eligibilityCriteria });
  return out;
}

/** Products per entitlement, for expansion. */
export async function entitlementProducts(db: DB, entitlementIds: string[]): Promise<Map<string, ProductRow[]>> {
  const out = new Map<string, ProductRow[]>();
  for (const id of entitlementIds) out.set(id, []);
  if (!entitlementIds.length) return out;
  const rows = await db.select({ ep: schema.entitlementProducts, p: schema.products }).from(schema.entitlementProducts)
    .innerJoin(schema.products, eq(schema.products.id, schema.entitlementProducts.productId)).where(inArray(schema.entitlementProducts.entitlementId, entitlementIds));
  rows.sort((a, b) => a.p.createdAt.getTime() - b.p.createdAt.getTime() || a.p.id.localeCompare(b.p.id));
  for (const r of rows) out.get(r.ep.entitlementId)!.push(r.p);
  return out;
}

/** The project's catalog, for resolving store identifiers to product ids and entitlements in customer objects. */
export async function loadCatalog(db: DB, projectId: string) {
  const [products, ents, offers] = await Promise.all([
    db.select().from(schema.products).where(eq(schema.products.projectId, projectId)),
    db.select().from(schema.entitlements).where(eq(schema.entitlements.projectId, projectId)),
    db.select({ id: schema.offerings.id, lookupKey: schema.offerings.lookupKey }).from(schema.offerings).where(eq(schema.offerings.projectId, projectId)),
  ]);
  const links = ents.length ? await db.select().from(schema.entitlementProducts).where(inArray(schema.entitlementProducts.entitlementId, ents.map((e) => e.id))) : [];
  const findProduct = (storeId: string, plan: string | null | undefined, appId: string | null | undefined) => {
    const keys = plan ? [`${storeId}:${plan}`, storeId] : [storeId];
    for (const k of keys) {
      const hit = products.find((p) => p.storeIdentifier === k && (!appId || p.appId === appId)) ?? products.find((p) => p.storeIdentifier === k);
      if (hit) return hit;
    }
    return null;
  };
  const entitlementsFor = (productIds: string[], promoLookupKey?: string | null) =>
    ents.filter((e) => (promoLookupKey && e.lookupKey === promoLookupKey) || links.some((l) => l.entitlementId === e.id && productIds.includes(l.productId)));
  const productIdsFor = (storeId: string, plan?: string | null) => {
    const keys = plan ? [`${storeId}:${plan}`, storeId] : [storeId];
    return products.filter((p) => keys.includes(p.storeIdentifier)).map((p) => p.id);
  };
  /** The SDK sends the offering's identifier (lookup key); REST objects carry the offering id, or the identifier when it is gone. */
  const offeringId = (identifier: string | null | undefined) => (identifier ? offers.find((o) => o.lookupKey === identifier)?.id ?? identifier : null);
  return { products, ents, links, findProduct, entitlementsFor, productIdsFor, offeringId };
}
export type Catalog = Awaited<ReturnType<typeof loadCatalog>>;

export function monetary(gross: number, store: string) {
  const comm = round2(gross * commission(store as Store));
  return { currency: "USD", gross: round2(gross), commission: comm, tax: 0, proceeds: round2(gross - comm) };
}

/** RevenueCat's v2 subscription status from our chain state. */
export function subscriptionStatus(s: SubRow, now: Date) {
  const d = subRowToDomain(s);
  const end = accessEndsAt(d);
  const access = end === null || end > now;
  let status: string;
  // Billing retry: the store is still retrying (no EXPIRATION recorded yet) after access ended.
  if (!access) status = s.autoResumeDate ? "paused" : s.billingIssuesDetectedAt && !s.refundedAt && !s.expiredEventAt ? "in_billing_retry" : "expired";
  else if (s.expiresDate && s.expiresDate <= now && s.gracePeriodExpiresDate && s.gracePeriodExpiresDate > now) status = "in_grace_period";
  else if (s.periodType === "trial") status = "trialing";
  else status = "active";
  let renewal = "will_renew";
  if (s.autoResumeDate) renewal = "will_pause";
  else if (!willRenew(d)) renewal = "will_not_renew";
  else if (s.autoRenewProductId && s.autoRenewProductId !== s.productIdentifier) renewal = "will_change_product";
  return { status, access, renewal };
}

/**
 * `access` is the customer's project access (repo/access.ts): a blocked customer's subscriptions, and sandbox ones outside
 * sandbox testing access, give no access even while the store period runs, like their entitlements.
 */
export function subscriptionShape(s: SubRow, customerAppUserId: string, cat: Catalog, revenueUsd: number, now: Date, access?: Access) {
  const prod = s.store === "promotional" ? null : cat.findProduct(s.productIdentifier, s.productPlanIdentifier, s.appId);
  const ents = cat.entitlementsFor(prod ? cat.productIdsFor(s.productIdentifier, s.productPlanIdentifier) : [], s.store === "promotional" ? s.entitlementIdentifier : null);
  const st = subscriptionStatus(s, now);
  return {
    object: "subscription" as const, id: s.id, customer_id: customerAppUserId, original_customer_id: customerAppUserId,
    product_id: prod?.id ?? null, starts_at: s.originalPurchaseDate.getTime(), current_period_starts_at: s.purchaseDate.getTime(),
    current_period_ends_at: ms(s.expiresDate), ends_at: ms(s.expiresDate),
    gives_access: st.access && !access?.blocked && (access?.sandbox !== false || !s.isSandbox),
    pending_payment: st.status === "in_billing_retry" || st.status === "in_grace_period", auto_renewal_status: st.renewal, status: st.status,
    total_revenue_in_usd: monetary(revenueUsd, s.store), presented_offering_id: cat.offeringId(s.presentedOfferingId),
    entitlements: embeddedList(`/v2/projects/${s.projectId}/subscriptions/${s.id}/entitlements`, ents.map((e) => entitlementShape(e))),
    environment: s.isSandbox ? "sandbox" : "production", store: s.store, store_subscription_identifier: s.storeTransactionId ?? s.storeKey,
    ownership: s.ownershipType === "FAMILY_SHARED" ? "family_shared" : "purchased",
    ...(s.countryCode ? { country: s.countryCode.toUpperCase() } : {}), management_url: null,
  };
}

export function purchaseShape(p: NonSubRow, customerAppUserId: string, cat: Catalog) {
  const prod = cat.findProduct(p.productIdentifier, null, p.appId);
  const ents = p.isConsumable ? [] : cat.entitlementsFor(cat.productIdsFor(p.productIdentifier));
  const gross = p.priceUsd ?? (p.priceCurrency === "USD" ? p.priceAmount ?? 0 : 0);
  return {
    object: "purchase" as const, id: p.id, customer_id: customerAppUserId, original_customer_id: customerAppUserId,
    product_id: prod?.id ?? p.productIdentifier, purchased_at: p.purchaseDate.getTime(), revenue_in_usd: monetary(gross, p.store),
    quantity: 1, status: p.refundedAt ? "refunded" : "owned", presented_offering_id: cat.offeringId(p.presentedOfferingId),
    entitlements: embeddedList(`/v2/projects/${p.projectId}/purchases/${p.id}/entitlements`, ents.map((e) => entitlementShape(e))),
    environment: p.isSandbox ? "sandbox" : "production", store: p.store, store_purchase_identifier: p.storeTransactionId, ownership: "purchased",
    ...(p.countryCode ? { country: p.countryCode.toUpperCase() } : {}),
  };
}

/** Revenue per subscription chain: the sum of its customer's transactions for that store and product. */
export async function subscriptionRevenue(db: DB, subs: SubRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const customerIds = [...new Set(subs.map((s) => s.customerId))];
  const txns = customerIds.length ? await db.select().from(schema.transactions).where(inArray(schema.transactions.customerId, customerIds)) : [];
  for (const s of subs) {
    const sum = txns.filter((t) => t.customerId === s.customerId && t.store === s.store && t.productIdentifier === s.productIdentifier).reduce((a, t) => a + t.revenueUsd, 0);
    out.set(s.id, sum);
  }
  return out;
}

/** Entitlements that are active right now, keyed by our entitlement id (RevenueCat's `entitlement_id`). */
export async function activeEntitlements(db: DB, customer: CustomerRow, now: Date) {
  const state = await loadState(db, customer);
  const map = await entitlementMap(db, customer.projectId);
  const ents = await db.select().from(schema.entitlements).where(eq(schema.entitlements.projectId, customer.projectId));
  return computeEntitlements(state, map).filter((e) => isActive(e, now)).flatMap((e) => {
    const row = ents.find((x) => x.lookupKey === e.identifier);
    return row ? [{ object: "customer.active_entitlement" as const, entitlement_id: row.id, expires_at: ms(e.expiresDate) }] : [];
  });
}

export async function customerShape(db: DB, c: CustomerRow, opts: { now: Date; detail?: boolean; attributes?: boolean }) {
  const id = c.originalAppUserId;
  const out: Record<string, unknown> = {
    object: "customer", id, project_id: c.projectId, first_seen_at: c.firstSeen.getTime(), last_seen_at: ms(c.lastSeen),
    last_seen_app_version: c.lastSeenAppVersion ?? null, last_seen_country: c.lastSeenCountry ?? null,
    last_seen_platform: c.lastSeenPlatform ?? null, last_seen_platform_version: null,
  };
  const url = `${base(c.projectId)}/customers/${encodeURIComponent(id)}`;
  if (opts.detail) {
    out.active_entitlements = embeddedList(`${url}/active_entitlements`, await activeEntitlements(db, c, opts.now));
    out.experiment = null;
  }
  if (opts.attributes) out.attributes = embeddedList(`${url}/attributes`, await attributeItems(db, c.id));
  return out;
}

export async function attributeItems(db: DB, customerId: string) {
  const rows = await db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.customerId, customerId));
  return rows.filter((a) => a.value !== null).sort((a, b) => a.key.localeCompare(b.key))
    .map((a) => ({ object: "customer.attribute" as const, name: a.key, value: a.value, updated_at: a.updatedAtMs }));
}

export async function appsById(db: DB, projectId: string) {
  const rows = await db.select().from(schema.apps).where(eq(schema.apps.projectId, projectId));
  return new Map(rows.map((a) => [a.id, a]));
}

export { and, eq };
