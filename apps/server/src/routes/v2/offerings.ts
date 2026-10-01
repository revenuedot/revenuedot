import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { V2Error, body, conflict, expands, notFound, paginate, paramError, scope, type V2Router } from "./common.js";
import { offeringShape, packageProducts, packageShape, productShape } from "./shapes.js";

const Metadata = z.record(z.unknown()).nullable().optional();
const OfferingCreate = z.object({ lookup_key: z.string().trim().min(1).max(200), display_name: z.string().trim().min(1).max(1500), metadata: Metadata });
const OfferingUpdate = z.object({ display_name: z.string().trim().min(1).max(1500).optional(), is_current: z.boolean().optional(), metadata: Metadata });
const Unarchive = z.object({ unarchive_referenced_entities: z.boolean().optional() });
const PackageCreate = z.object({ lookup_key: z.string().trim().min(1).max(200), display_name: z.string().trim().min(1).max(1500), position: z.number().int().min(0).optional() });
const PackageUpdate = z.object({ display_name: z.string().trim().min(1).max(1500).optional(), position: z.number().int().min(0).optional() });
const ELIGIBILITY = ["all", "google_sdk_lt_6", "google_sdk_ge_6"] as const;
const Attach = z.object({ products: z.array(z.object({ product_id: z.string().min(1), eligibility_criteria: z.enum(ELIGIBILITY) })).min(1).max(50) });
const Detach = z.object({ product_ids: z.array(z.string().min(1)).min(1).max(50) });

/** Two products of the same app can share a package only when their Google SDK eligibility ranges do not overlap. */
const overlaps = (a: string, b: string) => a === "all" || b === "all" || a === b;

export function offeringRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const O = "/v2/projects/:project_id/offerings";
  const K = "/v2/projects/:project_id/packages";
  const findOffering = async (projectId: string, id: string) => {
    const [o] = await db.select().from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.id, id))).limit(1);
    if (!o) throw notFound("Offering");
    return o;
  };
  // Packages carry no project id: scope them through their offering.
  const findPackage = async (projectId: string, id: string) => {
    const [row] = await db.select({ p: schema.packages, o: schema.offerings }).from(schema.packages)
      .innerJoin(schema.offerings, eq(schema.offerings.id, schema.packages.offeringId))
      .where(and(eq(schema.offerings.projectId, projectId), eq(schema.packages.id, id))).limit(1);
    if (!row) throw notFound("Package");
    return row;
  };

  /** The paywall attached to each offering, by offering id. */
  const paywallIds = async (offeringIds: string[]) => {
    const rows = offeringIds.length ? await db.select({ id: schema.paywalls.id, o: schema.paywalls.offeringId }).from(schema.paywalls).where(inArray(schema.paywalls.offeringId, offeringIds)) : [];
    return new Map(rows.map((x) => [x.o!, x.id]));
  };
  const shapeOne = async (o: typeof schema.offerings.$inferSelect) => offeringShape(o, undefined, (await paywallIds([o.id])).get(o.id) ?? null);

  /** Offering with packages expanded (`package`) and their products (`package.product`). */
  const shapeOfferings = async (rows: (typeof schema.offerings.$inferSelect)[], exp: Set<string>, prefix: string) => {
    const pw = await paywallIds(rows.map((o) => o.id));
    if (!exp.has(`${prefix}package`) && !exp.has(`${prefix}package.product`)) return new Map(rows.map((o) => [o.id, offeringShape(o, undefined, pw.get(o.id) ?? null)]));
    const pkgs = rows.length ? await db.select().from(schema.packages).where(inArray(schema.packages.offeringId, rows.map((o) => o.id))) : [];
    pkgs.sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const prods = exp.has(`${prefix}package.product`) ? await packageProducts(db, pkgs.map((p) => p.id)) : undefined;
    return new Map(rows.map((o) => [o.id, offeringShape(o, { rows: pkgs.filter((p) => p.offeringId === o.id), products: prods }, pw.get(o.id) ?? null)]));
  };

  r.get(O, scope("project_configuration:offerings:read"), async (c) => {
    const rows = await db.select().from(schema.offerings).where(eq(schema.offerings.projectId, c.get("projectId")));
    const shaped = await shapeOfferings(rows, expands(c), "items.");
    return c.json(paginate(c, rows, (o) => o.id, (o) => o.createdAt.getTime(), (o) => shaped.get(o.id)));
  });

  r.post(O, scope("project_configuration:offerings:read_write"), async (c) => {
    const b = await body(c, OfferingCreate);
    const projectId = c.get("projectId");
    const [dup] = await db.select({ id: schema.offerings.id }).from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.lookupKey, b.lookup_key))).limit(1);
    if (dup) throw conflict(`An offering with lookup_key ${b.lookup_key} already exists.`, "lookup_key");
    // The project's first offering becomes current, like RevenueCat's default offering.
    const [any] = await db.select({ id: schema.offerings.id }).from(schema.offerings).where(eq(schema.offerings.projectId, projectId)).limit(1);
    const [row] = await db.insert(schema.offerings).values({
      id: newId("ofrng", 10), projectId, lookupKey: b.lookup_key, displayName: b.display_name, metadata: b.metadata ?? null, isCurrent: !any, createdAt: deps.now(),
    }).returning();
    return c.json(await shapeOne(row!), 201);
  });

  r.get(`${O}/:offering_id`, scope("project_configuration:offerings:read"), async (c) => {
    const o = await findOffering(c.get("projectId"), c.req.param("offering_id"));
    return c.json((await shapeOfferings([o], expands(c), "")).get(o.id));
  });

  r.post(`${O}/:offering_id`, scope("project_configuration:offerings:read_write"), async (c) => {
    const o = await findOffering(c.get("projectId"), c.req.param("offering_id"));
    const b = await body(c, OfferingUpdate);
    if (b.is_current === true) {
      if (o.state !== "active") throw new V2Error(422, "entity_references_archived_entities", "An archived offering cannot be made current. Unarchive it first.", "is_current");
      // Exactly one current offering per project.
      await db.update(schema.offerings).set({ isCurrent: false }).where(and(eq(schema.offerings.projectId, o.projectId), ne(schema.offerings.id, o.id)));
    }
    const [row] = await db.update(schema.offerings).set({
      ...(b.display_name !== undefined ? { displayName: b.display_name } : {}),
      ...(b.is_current !== undefined ? { isCurrent: b.is_current } : {}),
      ...(b.metadata !== undefined ? { metadata: b.metadata } : {}),
    }).where(and(eq(schema.offerings.projectId, o.projectId), eq(schema.offerings.id, o.id))).returning();
    return c.json(await shapeOne(row!));
  });

  // Deletes the offering and its packages (FK cascade).
  r.delete(`${O}/:offering_id`, scope("project_configuration:offerings:read_write"), async (c) => {
    const o = await findOffering(c.get("projectId"), c.req.param("offering_id"));
    await db.delete(schema.offerings).where(and(eq(schema.offerings.projectId, o.projectId), eq(schema.offerings.id, o.id)));
    await db.update(schema.customers).set({ offeringOverrideId: null }).where(and(eq(schema.customers.projectId, o.projectId), eq(schema.customers.offeringOverrideId, o.id)));
    return c.json({ object: "offering", id: o.id, deleted_at: deps.now().getTime() });
  });

  r.post(`${O}/:offering_id/actions/archive`, scope("project_configuration:offerings:read_write"), async (c) => {
    const o = await findOffering(c.get("projectId"), c.req.param("offering_id"));
    if (o.isCurrent) throw new V2Error(422, "unprocessable_entity_error", "The current offering cannot be archived. Make another offering current first.");
    const [row] = await db.update(schema.offerings).set({ state: "inactive" }).where(and(eq(schema.offerings.projectId, o.projectId), eq(schema.offerings.id, o.id))).returning();
    return c.json(await shapeOne(row!));
  });

  r.post(`${O}/:offering_id/actions/unarchive`, scope("project_configuration:offerings:read_write"), async (c) => {
    const o = await findOffering(c.get("projectId"), c.req.param("offering_id"));
    const b = await body(c, Unarchive);
    if (b.unarchive_referenced_entities) {
      const pkgs = await db.select({ id: schema.packages.id }).from(schema.packages).where(eq(schema.packages.offeringId, o.id));
      const prods = await packageProducts(db, pkgs.map((p) => p.id));
      const ids = [...prods.values()].flatMap((x) => x.products.map((p) => p.product.id));
      if (ids.length) await db.update(schema.products).set({ state: "active" }).where(and(eq(schema.products.projectId, o.projectId), inArray(schema.products.id, ids)));
    }
    const [row] = await db.update(schema.offerings).set({ state: "active" }).where(and(eq(schema.offerings.projectId, o.projectId), eq(schema.offerings.id, o.id))).returning();
    return c.json(await shapeOne(row!));
  });

  // Packages
  r.get(`${O}/:offering_id/packages`, scope("project_configuration:packages:read"), async (c) => {
    const o = await findOffering(c.get("projectId"), c.req.param("offering_id"));
    const rows = await db.select().from(schema.packages).where(eq(schema.packages.offeringId, o.id));
    const prods = expands(c).has("items.product") ? await packageProducts(db, rows.map((p) => p.id)) : undefined;
    // Ordered by position, then creation (the order the SDK shows them in).
    const order = [...rows].sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return c.json(paginate(c, rows, (p) => p.id, (p) => order.indexOf(p), (p) => packageShape(p, o.projectId, prods?.get(p.id))));
  });

  r.post(`${O}/:offering_id/packages`, scope("project_configuration:packages:read_write"), async (c) => {
    const o = await findOffering(c.get("projectId"), c.req.param("offering_id"));
    const b = await body(c, PackageCreate);
    const existing = await db.select().from(schema.packages).where(eq(schema.packages.offeringId, o.id));
    if (existing.some((p) => p.lookupKey === b.lookup_key)) throw conflict(`A package with lookup_key ${b.lookup_key} already exists in this offering.`, "lookup_key");
    const position = b.position ?? (existing.length ? Math.max(...existing.map((p) => p.position)) + 1 : 0);
    const [row] = await db.insert(schema.packages).values({ id: newId("pkge", 10), offeringId: o.id, lookupKey: b.lookup_key, displayName: b.display_name, position, createdAt: deps.now() }).returning();
    return c.json(packageShape(row!, o.projectId), 201);
  });

  r.get(`${K}/:package_id`, scope("project_configuration:packages:read"), async (c) => {
    const { p, o } = await findPackage(c.get("projectId"), c.req.param("package_id"));
    const prods = expands(c).has("product") ? await packageProducts(db, [p.id]) : undefined;
    return c.json(packageShape(p, o.projectId, prods?.get(p.id)));
  });

  r.post(`${K}/:package_id`, scope("project_configuration:packages:read_write"), async (c) => {
    const { p, o } = await findPackage(c.get("projectId"), c.req.param("package_id"));
    const b = await body(c, PackageUpdate);
    const [row] = await db.update(schema.packages).set({ ...(b.display_name !== undefined ? { displayName: b.display_name } : {}), ...(b.position !== undefined ? { position: b.position } : {}) })
      .where(eq(schema.packages.id, p.id)).returning();
    return c.json(packageShape(row!, o.projectId));
  });

  r.delete(`${K}/:package_id`, scope("project_configuration:packages:read_write"), async (c) => {
    const { p } = await findPackage(c.get("projectId"), c.req.param("package_id"));
    await db.delete(schema.packages).where(eq(schema.packages.id, p.id));
    return c.json({ object: "package", id: p.id, deleted_at: deps.now().getTime() });
  });

  r.get(`${K}/:package_id/products`, scope("project_configuration:packages:read"), async (c) => {
    const { p } = await findPackage(c.get("projectId"), c.req.param("package_id"));
    const rows = (await packageProducts(db, [p.id])).get(p.id)!.products;
    return c.json(paginate(c, rows, (x) => x.product.id, (x) => x.product.createdAt.getTime(), (x) => ({ product: productShape(x.product), eligibility_criteria: x.eligibility })));
  });

  r.post(`${K}/:package_id/actions/attach_products`, scope("project_configuration:packages:read_write"), async (c) => {
    const { p, o } = await findPackage(c.get("projectId"), c.req.param("package_id"));
    const b = await body(c, Attach);
    const ids = b.products.map((x) => x.product_id);
    if (new Set(ids).size !== ids.length) throw paramError("Each product can only be attached once.", "products");
    const prods = await db.select().from(schema.products).where(and(eq(schema.products.projectId, o.projectId), inArray(schema.products.id, ids)));
    const missing = ids.filter((id) => !prods.some((x) => x.id === id));
    if (missing.length) throw paramError(`Products not found in this project: ${missing.join(", ")}.`, "products");
    const current = (await packageProducts(db, [p.id])).get(p.id)!.products.filter((x) => !ids.includes(x.product.id));
    const incoming = b.products.map((x) => ({ product: prods.find((y) => y.id === x.product_id)!, eligibility: x.eligibility_criteria as string }));
    const all = [...current, ...incoming];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!, z2 = all[j]!;
      if (a.product.appId === z2.product.appId && overlaps(a.eligibility, z2.eligibility)) {
        throw new V2Error(409, "invalid_request", `The package already has a product for app ${a.product.appId} (${a.product.id}); detach it first or use non-overlapping eligibility_criteria.`, "products");
      }
    }
    for (const x of b.products) {
      await db.insert(schema.packageProducts).values({ packageId: p.id, productId: x.product_id, eligibilityCriteria: x.eligibility_criteria })
        .onConflictDoUpdate({ target: [schema.packageProducts.packageId, schema.packageProducts.productId], set: { eligibilityCriteria: x.eligibility_criteria } });
    }
    return c.json(packageShape(p, o.projectId, (await packageProducts(db, [p.id])).get(p.id)));
  });

  r.post(`${K}/:package_id/actions/detach_products`, scope("project_configuration:packages:read_write"), async (c) => {
    const { p, o } = await findPackage(c.get("projectId"), c.req.param("package_id"));
    const b = await body(c, Detach);
    await db.delete(schema.packageProducts).where(and(eq(schema.packageProducts.packageId, p.id), inArray(schema.packageProducts.productId, b.product_ids)));
    return c.json(packageShape(p, o.projectId, (await packageProducts(db, [p.id])).get(p.id)));
  });
}
