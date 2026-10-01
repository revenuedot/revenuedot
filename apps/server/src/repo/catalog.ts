import { fontConfig, publishedByOffering, sdkPaywallComponents, uiConfig } from "../services/paywalls.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { EntitlementMap } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

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
  return {
    productType: (id: string) => byId.get(id)?.type ?? byId.get(id.split(":")[0]!)?.type ?? null,
    productDuration: (id: string) => byId.get(id)?.duration ?? null,
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
    ui_config: uiConfig(await fontConfig(db, projectId, assetBase)),
  };
}

/** `GET /v1/product_entitlement_mapping`: keyed by product id and, for Play, also by product:basePlan (Android looks up the bare id). */
export async function productEntitlementMappingJSON(db: DB, projectId: string) {
  const map = await entitlementMap(db, projectId);
  const out: Record<string, { product_identifier: string; base_plan_id?: string; entitlements: string[] }> = {};
  for (const [ent, prods] of Object.entries(map)) {
    for (const storeId of prods) {
      const [productId, basePlan] = storeId.split(":");
      for (const key of basePlan ? [storeId, productId!] : [storeId]) {
        out[key] ??= { product_identifier: productId!, ...(basePlan ? { base_plan_id: basePlan } : {}), entitlements: [] };
        if (!out[key]!.entitlements.includes(ent)) out[key]!.entitlements.push(ent);
      }
    }
  }
  return { product_entitlement_mapping: out };
}

export async function appByPublicKey(db: DB, key: string) {
  const [row] = await db.select().from(apps).where(eq(apps.publicKey, key)).limit(1);
  return row ?? null;
}
