import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { catalogMatch, catalogOf, importStoreProducts, listStoreProducts, projectEntitlements } from "../../services/store-import.js";
import { body, listOf, notFound, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { productShape } from "./shapes.js";
import { v2StoreError } from "./store-ops.js";

const Import = z.object({
  store_identifiers: z.array(z.string().trim().min(1).max(255)).min(1).max(1000),
  entitlement_ids: z.array(z.string().min(1)).max(50).optional(),
});

/**
 * Import products from the store (extension; prd/catalog/PRD.md "Import from store"):
 *   GET  /v2/projects/{id}/apps/{app_id}/store_products                   what the store has, with `in_catalog`
 *   POST /v2/projects/{id}/apps/{app_id}/store_products/actions/import    create the chosen ones (+ attach to entitlements)
 * Uses the app's App Store Connect API key, Play service account or Stripe restricted key; never writes to the store.
 */
export function storeImportRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const A = "/v2/projects/:project_id/apps/:app_id/store_products";
  const findApp = async (c: V2Context) => {
    const [app] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, c.get("projectId")), eq(schema.apps.id, c.req.param("app_id")!))).limit(1);
    if (!app) throw notFound("App");
    return app;
  };

  r.get(A, scope("project_configuration:products:read"), async (c) => {
    const app = await findApp(c);
    let listing;
    try { listing = await listStoreProducts(deps, app); } catch (e) { throw v2StoreError(e); }
    const catalog = await catalogOf(deps, app);
    const items = listing.items.map((item) => {
      const match = catalogMatch(item, catalog);
      const { stripe: _, ref: __, ...shown } = item;
      return { object: "store_product_listing" as const, ...shown, in_catalog: !!match, product_id: match?.id ?? null };
    });
    return c.json({ ...listOf(c, items, null), app_id: app.id, store: listing.store, warnings: listing.warnings });
  });

  r.post(`${A}/actions/import`, scope("project_configuration:products:read_write"), async (c) => {
    const app = await findApp(c);
    const b = await body(c, Import);
    const entitlementIds = [...new Set(b.entitlement_ids ?? [])];
    if (entitlementIds.length) {
      // Attaching changes entitlements too: an API key needs that permission as well.
      await scope("project_configuration:entitlements:read_write")(c, async () => {});
      const { missing } = await projectEntitlements(deps, app.projectId, entitlementIds);
      if (missing) throw paramError(`entitlement_ids: ${missing} is not an entitlement in this project.`, "entitlement_ids");
    }
    let result;
    try { result = await importStoreProducts(deps, app, [...new Set(b.store_identifiers)], entitlementIds); } catch (e) { throw v2StoreError(e); }
    return c.json({
      object: "store_product_import", app_id: app.id,
      created: result.created.map((p) => productShape(p)), existing: result.existing.map((p) => productShape(p)),
      failed: result.failed, entitlement_ids: result.entitlement_ids,
    }, result.created.length ? 201 : 200);
  });
}
