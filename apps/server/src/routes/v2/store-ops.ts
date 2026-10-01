import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { findCustomer } from "../../repo/customers.js";
import { StoreOpError, createInStore, restoreByOrderId } from "../../services/store-ops.js";
import { V2Error, body, listOf, ms, notFound, scope, type V2Context, type V2Router } from "./common.js";
import { customerShape } from "./shapes.js";

const Restore = z.object({ order_id: z.string().trim().min(1).max(255) });
const DURATIONS = ["ONE_WEEK", "ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR"] as const;
const CreateInStore = z.object({
  store_information: z.union([
    z.object({ duration: z.enum(DURATIONS), subscription_group_name: z.string().trim().min(1).max(255), subscription_group_id: z.string().min(1).nullable().optional() }),
    z.object({}).strict(),
  ]).nullable().optional(),
});

/** Store operation failures in API v2's error vocabulary. */
function v2StoreError(e: unknown): unknown {
  if (!(e instanceof StoreOpError)) return e;
  switch (e.kind) {
    case "not_found": return new V2Error(404, "resource_missing", e.message, e.param);
    case "conflict": return new V2Error(409, "resource_already_exists", e.message, e.param);
    case "credentials": case "unsupported": return new V2Error(422, "unprocessable_entity_error", e.message, e.param);
    case "invalid": return new V2Error(422, "store_error", e.message, e.param);
    default: return new V2Error(503, "store_error", e.message, e.param, true);
  }
}

/**
 * `restore_purchase_by_order_id`, `create_in_store` (prd/rest-api/PRD.md) and the win-back eligibility extension
 * (prd/win-back-offers/PRD.md).
 */
export function storeOpRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const C = "/v2/projects/:project_id/customers";
  const findCust = async (c: V2Context) => {
    const cust = await findCustomer(db, c.get("projectId"), c.req.param("customer_id")!);
    if (!cust || cust.projectId !== c.get("projectId")) throw notFound("Customer");
    return cust;
  };

  r.post(`${C}/:customer_id/actions/restore_purchase_by_order_id`, scope("customer_information:customers:read_write"), async (c) => {
    const cust = await findCust(c);
    const b = await body(c, Restore);
    let owner;
    try { owner = await restoreByOrderId(deps, cust, c.req.param("customer_id")!, b.order_id); } catch (e) { throw v2StoreError(e); }
    return c.json(await customerShape(db, owner, { now: deps.now(), detail: true }));
  });

  r.post("/v2/projects/:project_id/products/:product_id/create_in_store", scope("project_configuration:products:read_write"), async (c) => {
    const [p] = await db.select().from(schema.products).where(and(eq(schema.products.projectId, c.get("projectId")), eq(schema.products.id, c.req.param("product_id")!))).limit(1);
    if (!p) throw notFound("Product");
    const b = await body(c, CreateInStore);
    const info = b.store_information && "duration" in b.store_information ? b.store_information : null;
    try {
      return c.json({ created_product: await createInStore(deps, p, info) }, 201);
    } catch (e) { throw v2StoreError(e); }
  });

  // Extension: the win-back offers Apple says this customer may redeem, per App Store subscription chain.
  r.get(`${C}/:customer_id/win_back_offers`, scope("customer_information:subscriptions:read"), async (c) => {
    const cust = await findCust(c);
    const subs = await db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.customerId, cust.id), inArray(schema.subscriptions.store, ["app_store", "mac_app_store"])));
    const items = subs.sort((a, b) => a.originalPurchaseDate.getTime() - b.originalPurchaseDate.getTime()).map((s) => ({
      object: "win_back_offer_eligibility" as const, subscription_id: s.id, product_id: s.productIdentifier, store: s.store,
      offer_ids: s.eligibleWinBackOfferIds ?? [], updated_at: ms(s.winBackOffersAt),
    }));
    return c.json(listOf(c, items, null));
  });
}
