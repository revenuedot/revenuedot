import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { body, conflict, expands, notFound, paginate, paramError, scope, type V2Router } from "./common.js";
import { appsById, productShape } from "./shapes.js";

export const PRODUCT_TYPES = ["subscription", "one_time", "consumable", "non_consumable", "non_renewing_subscription"] as const;
/**
 * ISO 8601 period (P1W, P1M, P2M, P3M, P6M, P1Y, or a custom one such as P3D or P2W).
 * RevenueCat takes only its six presets and only for Test Store products. RevenueDot has no store import yet, so it
 * keeps the duration for every store: MRR normalisation and the dashboard read it.
 */
const Duration = z.string().trim().regex(/^P(?=\d)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?$/, "must be an ISO 8601 period such as P1M, P1Y or P3D");

/**
 * Test Store price in RevenueCat's price field names (`amount_micros`, `currency`). RevenueCat sets Test Store prices with
 * `POST …/products/{id}/test_store_prices`; RevenueDot takes one price on product create and update instead (null clears it).
 * Responses carry it as RevenueCat's `indicative_price` with `expand=indicative_price` (`items.indicative_price` on lists),
 * and the SDK shows it for Test Store products (`/rcbilling/v1/subscribers/:id/products`).
 */
const TestStorePrice = z.object({
  amount_micros: z.number().int().min(0).max(1e15),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "must be an ISO 4217 code such as USD").transform((c) => c.toUpperCase()),
}).nullable();

const ProductCreate = z.object({
  store_identifier: z.string().trim().min(1).max(255),
  app_id: z.string().min(1),
  type: z.enum(PRODUCT_TYPES),
  display_name: z.string().max(255).nullable().optional(),
  price_identifier: z.string().nullable().optional(),
  subscription: z.object({ duration: Duration.nullable().optional() }).nullable().optional(),
  title: z.string().max(255).nullable().optional(),
  test_store_price: TestStorePrice.optional(),
});
const ProductUpdate = z.object({
  display_name: z.string().max(255).optional(), type: z.enum(PRODUCT_TYPES).optional(),
  // RevenueDot extension: the duration can be corrected later (null clears it).
  subscription: z.object({ duration: Duration.nullable() }).optional(),
  test_store_price: TestStorePrice.optional(),
});
const priceColumns = (p: z.infer<typeof TestStorePrice>) => ({ testStorePriceMicros: p?.amount_micros ?? null, testStorePriceCurrency: p?.currency ?? null });
const onlyTestStore = () => paramError("test_store_price is only supported for Test Store products.", "test_store_price");

export function productRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/products";
  const find = async (projectId: string, id: string) => {
    const [p] = await db.select().from(schema.products).where(and(eq(schema.products.projectId, projectId), eq(schema.products.id, id))).limit(1);
    if (!p) throw notFound("Product");
    return p;
  };
  const withApp = async (c: { get: (k: "projectId") => string }, exp: Set<string>, key: string) => (exp.has(key) ? await appsById(db, c.get("projectId")) : null);

  r.get(P, scope("project_configuration:products:read"), async (c) => {
    const appId = c.req.query("app_id");
    const rows = await db.select().from(schema.products).where(and(eq(schema.products.projectId, c.get("projectId")), ...(appId ? [eq(schema.products.appId, appId)] : [])));
    const exp = expands(c);
    const apps = await withApp(c, exp, "items.app");
    return c.json(paginate(c, rows, (p) => p.id, (p) => p.createdAt.getTime(), (p) => productShape(p, apps?.get(p.appId), exp.has("items.indicative_price"))));
  });

  r.post(P, scope("project_configuration:products:read_write"), async (c) => {
    const b = await body(c, ProductCreate);
    const projectId = c.get("projectId");
    const [app] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, b.app_id))).limit(1);
    if (!app) throw paramError("app_id does not match an app in this project.", "app_id");
    const [dup] = await db.select({ id: schema.products.id }).from(schema.products).where(and(eq(schema.products.appId, app.id), eq(schema.products.storeIdentifier, b.store_identifier))).limit(1);
    if (dup) throw conflict(`A product with store_identifier ${b.store_identifier} already exists for this app.`, "store_identifier");
    if (b.test_store_price && app.type !== "test_store") throw onlyTestStore();
    const [row] = await db.insert(schema.products).values({
      id: newId("prod", 10), projectId, appId: app.id, storeIdentifier: b.store_identifier, type: b.type,
      displayName: b.display_name ?? b.title ?? null, duration: b.subscription?.duration ?? null, createdAt: deps.now(),
      ...priceColumns(b.test_store_price ?? null),
    }).returning();
    return c.json(productShape(row!, null, expands(c).has("indicative_price")), 201);
  });

  r.get(`${P}/:product_id`, scope("project_configuration:products:read"), async (c) => {
    const p = await find(c.get("projectId"), c.req.param("product_id"));
    const exp = expands(c);
    const apps = await withApp(c, exp, "app");
    return c.json(productShape(p, apps?.get(p.appId), exp.has("indicative_price")));
  });

  r.post(`${P}/:product_id`, scope("project_configuration:products:read_write"), async (c) => {
    const p = await find(c.get("projectId"), c.req.param("product_id"));
    const b = await body(c, ProductUpdate);
    if (b.test_store_price) {
      const [app] = await db.select({ type: schema.apps.type }).from(schema.apps).where(eq(schema.apps.id, p.appId)).limit(1);
      if (app?.type !== "test_store") throw onlyTestStore();
    }
    const [row] = await db.update(schema.products).set({
      ...(b.display_name !== undefined ? { displayName: b.display_name } : {}), ...(b.type ? { type: b.type } : {}),
      ...(b.subscription ? { duration: b.subscription.duration } : {}),
      ...(b.test_store_price !== undefined ? priceColumns(b.test_store_price) : {}),
    })
      .where(and(eq(schema.products.projectId, p.projectId), eq(schema.products.id, p.id))).returning();
    const exp = expands(c);
    const apps = await withApp(c, exp, "app");
    return c.json(productShape(row!, apps?.get(row!.appId), exp.has("indicative_price")));
  });

  // Deleting a product detaches it from entitlements and packages (FK cascade). Purchase history keeps the store id.
  r.delete(`${P}/:product_id`, scope("project_configuration:products:read_write"), async (c) => {
    const p = await find(c.get("projectId"), c.req.param("product_id"));
    await db.delete(schema.products).where(and(eq(schema.products.projectId, p.projectId), eq(schema.products.id, p.id)));
    return c.json({ object: "product", id: p.id, deleted_at: deps.now().getTime() });
  });

  for (const [action, state] of [["archive", "inactive"], ["unarchive", "active"]] as const) {
    r.post(`${P}/:product_id/actions/${action}`, scope("project_configuration:products:read_write"), async (c) => {
      const p = await find(c.get("projectId"), c.req.param("product_id"));
      const [row] = await db.update(schema.products).set({ state }).where(and(eq(schema.products.projectId, p.projectId), eq(schema.products.id, p.id))).returning();
      return c.json(productShape(row!));
    });
  }
}
