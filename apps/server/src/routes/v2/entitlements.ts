import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { body, conflict, expands, notFound, paginate, paramError, scope, type V2Router } from "./common.js";
import { entitlementProducts, entitlementShape, productShape } from "./shapes.js";

const EntitlementCreate = z.object({ lookup_key: z.string().trim().min(1).max(200), display_name: z.string().trim().min(1).max(1500) });
const EntitlementUpdate = z.object({ display_name: z.string().trim().min(1).max(1500) });
const ProductIds = z.object({ product_ids: z.array(z.string().min(1)).min(1).max(50) });

export function entitlementRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/entitlements";
  const find = async (projectId: string, id: string) => {
    const [e] = await db.select().from(schema.entitlements).where(and(eq(schema.entitlements.projectId, projectId), eq(schema.entitlements.id, id))).limit(1);
    if (!e) throw notFound("Entitlement");
    return e;
  };
  const withProducts = async (e: typeof schema.entitlements.$inferSelect) => entitlementShape(e, { rows: (await entitlementProducts(db, [e.id])).get(e.id)! });

  r.get(P, scope("project_configuration:entitlements:read"), async (c) => {
    const rows = await db.select().from(schema.entitlements).where(eq(schema.entitlements.projectId, c.get("projectId")));
    const prods = expands(c).has("items.product") ? await entitlementProducts(db, rows.map((e) => e.id)) : null;
    return c.json(paginate(c, rows, (e) => e.id, (e) => e.createdAt.getTime(), (e) => entitlementShape(e, prods ? { rows: prods.get(e.id)! } : undefined)));
  });

  r.post(P, scope("project_configuration:entitlements:read_write"), async (c) => {
    const b = await body(c, EntitlementCreate);
    const projectId = c.get("projectId");
    const [dup] = await db.select({ id: schema.entitlements.id }).from(schema.entitlements).where(and(eq(schema.entitlements.projectId, projectId), eq(schema.entitlements.lookupKey, b.lookup_key))).limit(1);
    if (dup) throw conflict(`An entitlement with lookup_key ${b.lookup_key} already exists.`, "lookup_key");
    const [row] = await db.insert(schema.entitlements).values({ id: newId("entl", 10), projectId, lookupKey: b.lookup_key, displayName: b.display_name, createdAt: deps.now() }).returning();
    return c.json(entitlementShape(row!), 201);
  });

  r.get(`${P}/:entitlement_id`, scope("project_configuration:entitlements:read"), async (c) => {
    const e = await find(c.get("projectId"), c.req.param("entitlement_id"));
    return c.json(expands(c).has("product") ? await withProducts(e) : entitlementShape(e));
  });

  r.post(`${P}/:entitlement_id`, scope("project_configuration:entitlements:read_write"), async (c) => {
    const e = await find(c.get("projectId"), c.req.param("entitlement_id"));
    const b = await body(c, EntitlementUpdate);
    const [row] = await db.update(schema.entitlements).set({ displayName: b.display_name }).where(and(eq(schema.entitlements.projectId, e.projectId), eq(schema.entitlements.id, e.id))).returning();
    return c.json(entitlementShape(row!));
  });

  r.delete(`${P}/:entitlement_id`, scope("project_configuration:entitlements:read_write"), async (c) => {
    const e = await find(c.get("projectId"), c.req.param("entitlement_id"));
    await db.delete(schema.entitlements).where(and(eq(schema.entitlements.projectId, e.projectId), eq(schema.entitlements.id, e.id)));
    return c.json({ object: "entitlement", id: e.id, deleted_at: deps.now().getTime() });
  });

  for (const [action, state] of [["archive", "inactive"], ["unarchive", "active"]] as const) {
    r.post(`${P}/:entitlement_id/actions/${action}`, scope("project_configuration:entitlements:read_write"), async (c) => {
      const e = await find(c.get("projectId"), c.req.param("entitlement_id"));
      const [row] = await db.update(schema.entitlements).set({ state }).where(and(eq(schema.entitlements.projectId, e.projectId), eq(schema.entitlements.id, e.id))).returning();
      return c.json(entitlementShape(row!));
    });
  }

  r.get(`${P}/:entitlement_id/products`, scope("project_configuration:entitlements:read"), async (c) => {
    const e = await find(c.get("projectId"), c.req.param("entitlement_id"));
    const rows = (await entitlementProducts(db, [e.id])).get(e.id)!;
    return c.json(paginate(c, rows, (p) => p.id, (p) => p.createdAt.getTime(), (p) => productShape(p)));
  });

  /** Every product id must belong to this project; otherwise nothing changes. */
  const projectProducts = async (projectId: string, ids: string[]) => {
    const rows = await db.select().from(schema.products).where(and(eq(schema.products.projectId, projectId), inArray(schema.products.id, ids)));
    const missing = ids.filter((id) => !rows.some((p) => p.id === id));
    if (missing.length) throw paramError(`Products not found in this project: ${missing.join(", ")}.`, "product_ids");
    return rows;
  };

  r.post(`${P}/:entitlement_id/actions/attach_products`, scope("project_configuration:entitlements:read_write"), async (c) => {
    const e = await find(c.get("projectId"), c.req.param("entitlement_id"));
    const b = await body(c, ProductIds);
    await projectProducts(e.projectId, b.product_ids);
    await db.insert(schema.entitlementProducts).values([...new Set(b.product_ids)].map((productId) => ({ entitlementId: e.id, productId }))).onConflictDoNothing();
    return c.json(await withProducts(e));
  });

  r.post(`${P}/:entitlement_id/actions/detach_products`, scope("project_configuration:entitlements:read_write"), async (c) => {
    const e = await find(c.get("projectId"), c.req.param("entitlement_id"));
    const b = await body(c, ProductIds);
    await projectProducts(e.projectId, b.product_ids);
    await db.delete(schema.entitlementProducts).where(and(eq(schema.entitlementProducts.entitlementId, e.id), inArray(schema.entitlementProducts.productId, b.product_ids)));
    return c.json(await withProducts(e));
  });
}
