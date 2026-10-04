import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { CONVERTIBLE_CURRENCIES } from "../../services/fx.js";
import { fromMinor } from "../../stores/stripe/map.js";
import { body, conflict, expands, notFound, paginate, paramError, scope, type V2Router } from "./common.js";
import { appsById, priceContext, productShape } from "./shapes.js";
import { addPrices, priceShape, pricesOf, removePrice, setDefaultPrice, updatePrice } from "../../services/test-store-prices.js";

export const PRODUCT_TYPES = ["subscription", "one_time", "consumable", "non_consumable", "non_renewing_subscription"] as const;
/**
 * ISO 8601 period (P1W, P1M, P2M, P3M, P6M, P1Y, or a custom one such as P3D or P2W).
 * RevenueCat takes only its six presets and only for Test Store products. RevenueDot has no store import yet, so it
 * keeps the duration for every store: MRR normalisation and the dashboard read it.
 */
const Duration = z.string().trim().regex(/^P(?=\d)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?$/, "must be an ISO 8601 period such as P1M, P1Y or P3D");

const Micros = z.number().int().min(0).max(1e15);
const Currency = z.string().trim().regex(/^[A-Za-z]{3}$/, "must be an ISO 4217 code such as USD").transform((c) => c.toUpperCase())
  .refine((c) => CONVERTIBLE_CURRENCIES.has(c), "is not a currency RevenueDot can convert to USD; use an ISO 4217 code such as USD or EUR");
/**
 * Test Store price in RevenueCat's price field names (`amount_micros`, `currency`). A product has one price per currency
 * (`…/test_store_prices`, `…/prices` below); `test_store_price` on product create and update sets the default one (null
 * clears every price). Responses carry the default as RevenueCat's `indicative_price` with `expand=indicative_price`
 * (`items.indicative_price` on lists). The SDK shows the price in the customer's currency (`/rcbilling/v1/subscribers/:id/products`).
 */
const TestStorePrice = z.object({ amount_micros: Micros, currency: Currency }).nullable();
/** `POST …/test_store_prices` body, as the RevenueCat CLI sends it (`rc products prices set`). */
const PricesCreate = z.object({
  prices: z.array(z.object({ amount_micros: Micros, currency: Currency })).min(1).max(200)
    .refine((ps) => new Set(ps.map((p) => p.currency)).size === ps.length, "must list each currency once"),
});
const PriceUpdate = z.object({ amount_micros: Micros });

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
const onlyTestStore = (param = "test_store_price") => paramError(`${param === "test_store_price" ? "test_store_price is" : "Prices by currency are"} only supported for Test Store products.`, param);
const currencyParam = (raw: string) => {
  const r = Currency.safeParse(raw);
  if (!r.success) throw paramError(`currency ${r.error.issues[0]!.message}.`, "currency");
  return r.data;
};

export function productRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/products";
  const find = async (projectId: string, id: string) => {
    const [p] = await db.select().from(schema.products).where(and(eq(schema.products.projectId, projectId), eq(schema.products.id, id))).limit(1);
    if (!p) throw notFound("Product");
    return p;
  };
  const withApp = async (c: { get: (k: "projectId") => string }, exp: Set<string>, key: string) => (exp.has(key) ? await appsById(db, c.get("projectId")) : null);
  // Store prices for one product: `indicative_price` and the `store_details` extension.
  const single = async (projectId: string, p: typeof schema.products.$inferSelect, exp: Set<string>) =>
    (exp.has("indicative_price") || exp.has("store_details") ? priceContext(db, projectId, [p], exp.has("store_details")) : null);

  r.get(P, scope("project_configuration:products:read"), async (c) => {
    const appId = c.req.query("app_id");
    const rows = await db.select().from(schema.products).where(and(eq(schema.products.projectId, c.get("projectId")), ...(appId ? [eq(schema.products.appId, appId)] : [])));
    const exp = expands(c);
    const apps = await withApp(c, exp, "items.app");
    const priced = exp.has("items.indicative_price") || exp.has("items.store_details");
    const ctx = priced ? await priceContext(db, c.get("projectId"), rows, exp.has("items.store_details")) : null;
    return c.json(paginate(c, rows, (p) => p.id, (p) => p.createdAt.getTime(), (p) => productShape(p, apps?.get(p.appId), exp.has("items.indicative_price"), ctx)));
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
    }).returning();
    const saved = b.test_store_price ? await setDefaultPrice(db, row!, b.test_store_price) : row!;
    const exp = expands(c);
    return c.json(productShape(saved, null, exp.has("indicative_price"), await single(c.get("projectId"), row!, exp)), 201);
  });

  r.get(`${P}/:product_id`, scope("project_configuration:products:read"), async (c) => {
    const p = await find(c.get("projectId"), c.req.param("product_id"));
    const exp = expands(c);
    const apps = await withApp(c, exp, "app");
    return c.json(productShape(p, apps?.get(p.appId), exp.has("indicative_price"), await single(c.get("projectId"), p, exp)));
  });

  r.post(`${P}/:product_id`, scope("project_configuration:products:read_write"), async (c) => {
    const p = await find(c.get("projectId"), c.req.param("product_id"));
    const b = await body(c, ProductUpdate);
    if (b.test_store_price) {
      const [app] = await db.select({ type: schema.apps.type }).from(schema.apps).where(eq(schema.apps.id, p.appId)).limit(1);
      if (app?.type !== "test_store") throw onlyTestStore();
    }
    const fields = {
      ...(b.display_name !== undefined ? { displayName: b.display_name } : {}), ...(b.type ? { type: b.type } : {}),
      ...(b.subscription ? { duration: b.subscription.duration } : {}),
    };
    let [row] = Object.keys(fields).length
      ? await db.update(schema.products).set(fields).where(and(eq(schema.products.projectId, p.projectId), eq(schema.products.id, p.id))).returning()
      : [p];
    if (b.test_store_price !== undefined) row = await setDefaultPrice(db, row!, b.test_store_price);
    const exp = expands(c);
    const apps = await withApp(c, exp, "app");
    return c.json(productShape(row!, apps?.get(row!.appId), exp.has("indicative_price"), await single(c.get("projectId"), row!, exp)));
  });

  // Prices by currency (RevenueCat's beta `list-prices`, `create-product-prices`, `update-product-price`). Bodies follow the
  // RevenueCat CLI (internal/api/products.go): lists are bare arrays of `{ id, currency, amount_micros }`, default first.
  const testStoreProduct = async (c: { get: (k: "projectId") => string; req: { param: (k: "product_id") => string } }, param: string) => {
    const p = await find(c.get("projectId"), c.req.param("product_id"));
    const [app] = await db.select({ type: schema.apps.type }).from(schema.apps).where(eq(schema.apps.id, p.appId)).limit(1);
    if (app?.type !== "test_store") throw onlyTestStore(param);
    return p;
  };
  const listPrices = async (c: Parameters<typeof testStoreProduct>[0]) => {
    const p = await find(c.get("projectId"), c.req.param("product_id"));
    const [app] = await db.select({ type: schema.apps.type }).from(schema.apps).where(eq(schema.apps.id, p.appId)).limit(1);
    if (app?.type === "test_store") return (await pricesOf(db, [p])).get(p.id)!.map(priceShape);
    // Web Billing: the Stripe price the product was created from (RevenueCat lists "Web Billing and Test Store" prices).
    const [web] = await db.select().from(schema.webProducts).where(eq(schema.webProducts.productId, p.id)).limit(1);
    if (web) return [{ id: web.stripePriceId, currency: web.currency.toUpperCase(), amount_micros: Math.round(fromMinor(web.amountMinor, web.currency) * 1_000_000) }];
    throw paramError("Prices are only listed for Test Store and Web Billing products.", "product_id");
  };
  r.get(`${P}/:product_id/prices`, scope("project_configuration:products:read"), async (c) => c.json(await listPrices(c)));
  // Deprecated alias of GET …/prices in RevenueCat.
  r.get(`${P}/:product_id/test_store_prices`, scope("project_configuration:products:read"), async (c) => c.json(await listPrices(c)));
  r.post(`${P}/:product_id/test_store_prices`, scope("project_configuration:products:read_write"), async (c) => {
    const p = await testStoreProduct(c, "product_id");
    const b = await body(c, PricesCreate);
    const saved = await addPrices(db, p, b.prices.map((x) => ({ currency: x.currency, amount_micros: x.amount_micros })));
    const all = (await pricesOf(db, [saved])).get(saved.id)!;
    return c.json(b.prices.map((x) => priceShape(all.find((a) => a.currency === x.currency)!)), 201);
  });
  r.patch(`${P}/:product_id/prices/:currency`, scope("project_configuration:products:read_write"), async (c) => {
    const p = await testStoreProduct(c, "product_id");
    const currency = currencyParam(c.req.param("currency"));
    const b = await body(c, PriceUpdate);
    const out = await updatePrice(db, p, currency, b.amount_micros);
    if (!out) throw notFound(`${currency} price`);
    return c.json(priceShape(out));
  });
  // Extension: RevenueCat has no way to remove a currency; the dashboard's price editor needs one.
  r.delete(`${P}/:product_id/prices/:currency`, scope("project_configuration:products:read_write"), async (c) => {
    const p = await testStoreProduct(c, "product_id");
    const currency = currencyParam(c.req.param("currency"));
    if (!(await removePrice(db, p, currency))) throw notFound(`${currency} price`);
    return c.json({ object: "product_price", currency, deleted_at: deps.now().getTime() });
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
