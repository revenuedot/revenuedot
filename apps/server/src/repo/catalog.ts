import { fontConfig, paywallLocales, publishedByOffering, sdkPaywallComponents, uiConfig } from "../services/paywalls.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { EntitlementMap } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { brandColors, projectBrand } from "../services/brand.js";
import { priceFor, pricesOf } from "../services/test-store-prices.js";

const { entitlements, entitlementProducts, products, offerings, packages, packageProducts, apps } = schema;

/** entitlement lookup key -> store identifiers (all apps) that unlock it. */
export async function entitlementMap(db: DB, projectId: string): Promise<EntitlementMap> {
  const rows = await db
    .select({ key: entitlements.lookupKey, storeId: products.storeIdentifier })
    .from(entitlements)
    .leftJoin(entitlementProducts, eq(entitlementProducts.entitlementId, entitlements.id))
    .leftJoin(products, eq(products.id, entitlementProducts.productId))
    .where(and(eq(entitlements.projectId, projectId), eq(entitlements.state, "active")));
  const map: EntitlementMap = {};
  for (const r of rows) {
    map[r.key] ??= [];
    if (r.storeId) map[r.key]!.push(r.storeId);
  }
  return map;
}

export async function productInfo(db: DB, appId: string) {
  const rows = await db.select().from(products).where(eq(products.appId, appId));
  const byId = new Map(rows.map((r) => [r.storeIdentifier, r]));
  const prices = await pricesOf(db, rows.filter((r) => r.testStorePriceMicros !== null));
  return {
    productType: (id: string) => byId.get(id)?.type ?? byId.get(id.split(":")[0]!)?.type ?? null,
    productDuration: (id: string) => byId.get(id)?.duration ?? null,
    /**
     * The Test Store price set in the catalog (the SDKs show it; purchases-js posts Test Store receipts without a price),
     * in the currency the purchase was shown in (`want`), else the default price.
     */
    productPrice: (id: string, want: { currency?: string | null; country?: string | null } = {}) => {
      const p = byId.get(id);
      const chosen = p ? priceFor(prices.get(p.id), want) : null;
      return chosen ? { amount: chosen.amount_micros / 1_000_000, currency: chosen.currency } : null;
    },
  };
}

/**
 * `GET /v1/subscribers/{id}/offerings` body for one app: only packages with an active product for that app.
 * Archived products are left out of packages, as in RevenueCat: archiving a product hides it from offerings
 * ("kept on file, hidden from new Offerings", RevenueCat CLI reference, company research raw/pages/tools_cli_commands.md), and an
 * active offering cannot serve archived products (unarchiving an offering offers `unarchive_referenced_entities` to
 * reactivate "any archived products referenced by this offering's packages", raw/openapi/openapi-v2-offering.dump.txt).
 * Archived products still unlock entitlements for customers who bought them (the entitlement mapping keeps them).
 */
export async function offeringsJSON(db: DB, projectId: string, appId: string, opts: { assetBaseUrl?: string } = {}) {
  const offs = await db.select().from(offerings).where(and(eq(offerings.projectId, projectId), eq(offerings.state, "active"))).orderBy(asc(offerings.createdAt));
  const ids = offs.map((o) => o.id);
  const pkgs = ids.length ? await db.select().from(packages).where(inArray(packages.offeringId, ids)).orderBy(asc(packages.position), asc(packages.createdAt)) : [];
  const pkgIds = pkgs.map((p) => p.id);
  const pp = pkgIds.length
    ? await db.select({ packageId: packageProducts.packageId, storeId: products.storeIdentifier, appId: products.appId, type: products.type })
        .from(packageProducts).innerJoin(products, eq(products.id, packageProducts.productId))
        .where(and(inArray(packageProducts.packageId, pkgIds), eq(products.state, "active")))
    : [];
  const current = offs.find((o) => o.isCurrent) ?? null;
  const pw = await publishedByOffering(db, projectId);
  const assetBase = opts.assetBaseUrl ?? "";
  return {
    current_offering_id: current?.lookupKey ?? null,
    offerings: offs.map((o) => ({
      description: o.displayName,
      identifier: o.lookupKey,
      metadata: o.metadata ?? null,
      ...(pw.get(o.id) ? { has_paywall_components: true, paywall_components: sdkPaywallComponents(pw.get(o.id)!, assetBase) } : { has_paywall_components: false }),
      packages: pkgs.filter((p) => p.offeringId === o.id).flatMap((p) => {
        const prod = pp.find((x) => x.packageId === p.id && x.appId === appId);
        if (!prod) return [];
        const [productId, basePlan] = prod.storeId.split(":");
        return [{ identifier: p.lookupKey, platform_product_identifier: productId!, ...(basePlan ? { platform_product_plan_identifier: basePlan } : {}) }];
      }),
    })),
    placements: { fallback_offering_id: current?.lookupKey ?? null, offering_ids_by_placement: {} },
    ui_config: uiConfig(await fontConfig(db, projectId, assetBase), paywallLocales(pw.values()), brandColors(await projectBrand(db, projectId))),
  };
}

/** App Store products: iOS files an up-front billing plan under the bare product id (`BillingPlanType.compoundProductIDPlanComponent`). */
const APPLE_STORES = new Set(["app_store", "mac_app_store"]);
const UP_FRONT = "upFront";
const MONTHLY = "monthly";

type MappingEntry = { product_identifier: string; base_plan_id?: string; entitlements: string[] };

/**
 * `GET /v1/product_entitlement_mapping`, the table the SDKs use for offline entitlements (prd/offline-entitlements/PRD.md).
 * With an app (public keys), only that app's products; without one (a secret key), the whole project.
 * - App Store: key `product`, or `product:plan` for a billing plan other than up-front, which is how iOS re-keys entries
 *   (`ProductEntitlementMapping.swift`). No bare duplicate: iOS ignores the key and would file it under the plan. A
 *   `product:monthly` key also carries the bare `product`'s entitlements, as the server grants them online, and a bare
 *   subscription gets one even when the catalog has no `product:monthly`, so monthly-plan buyers keep access offline.
 * - Google Play and other stores: `sub:plan` with that plan's entitlements, plus the bare `sub` that Android looks up
 *   (`PurchasedProductsFetcher.kt`) with the union of all its plans' entitlements and the first plan as `base_plan_id`.
 * Only active entitlements; archived products keep mapping; consumables never unlock an entitlement, so they are left out.
 */
export async function productEntitlementMappingJSON(db: DB, projectId: string, appId?: string | null) {
  const rows = await db
    .select({ ent: entitlements.lookupKey, storeId: products.storeIdentifier, type: products.type, appType: apps.type, created: products.createdAt, productId: products.id })
    .from(entitlementProducts)
    .innerJoin(entitlements, eq(entitlements.id, entitlementProducts.entitlementId))
    .innerJoin(products, eq(products.id, entitlementProducts.productId))
    .innerJoin(apps, eq(apps.id, products.appId))
    .where(and(eq(entitlements.projectId, projectId), eq(entitlements.state, "active"), ...(appId ? [eq(products.appId, appId)] : [])))
    .orderBy(asc(products.createdAt), asc(products.id), asc(entitlements.createdAt), asc(entitlements.lookupKey));
  const out: Record<string, MappingEntry> = {};
  const add = (key: string, entry: Omit<MappingEntry, "entitlements">, ent: string) => {
    const e = (out[key] ??= { ...entry, entitlements: [] });
    if (!e.entitlements.includes(ent)) e.entitlements.push(ent);
  };
  const appleBare = new Map<string, string[]>();
  const applePlanKeys = new Set<string>();
  for (const r of rows) {
    if (r.type === "consumable") continue;
    const [productId, plan] = r.storeId.split(":") as [string, string | undefined];
    const entry = { product_identifier: productId, ...(plan ? { base_plan_id: plan } : {}) };
    if (APPLE_STORES.has(r.appType)) {
      if (plan && plan !== UP_FRONT) applePlanKeys.add(`${productId}:${plan}`);
      else if (!plan) {
        appleBare.set(productId, [...(appleBare.get(productId) ?? []), r.ent]);
        // A bare subscription is also bought on the monthly plan (iOS 26.4), which iOS looks up as `product:monthly`.
        if (r.type === "subscription") applePlanKeys.add(`${productId}:${MONTHLY}`);
      }
      add(plan && plan !== UP_FRONT ? `${productId}:${plan}` : productId, entry, r.ent);
      continue;
    }
    add(r.storeId, entry, r.ent);
    if (plan) add(productId, entry, r.ent);
  }
  // Online, a billing-plan purchase also matches the bare product (core productKeysFor), so its key carries both.
  for (const key of applePlanKeys) {
    const [productId, plan] = key.split(":") as [string, string];
    for (const ent of appleBare.get(productId) ?? []) add(key, { product_identifier: productId, base_plan_id: plan }, ent);
  }
  return { product_entitlement_mapping: out };
}

export async function appByPublicKey(db: DB, key: string) {
  const [row] = await db.select().from(apps).where(eq(apps.publicKey, key)).limit(1);
  return row ?? null;
}
