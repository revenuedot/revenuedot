import { and, eq, inArray, sql } from "drizzle-orm";
import { newId, nextDefault, pickPrice, priceList, type CurrencyPrice } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

/**
 * Test Store prices by currency (prd/catalog/PRD.md "Test Store prices by currency"). Rows live in `product_prices`; the
 * product's `test_store_price_*` columns are the default price and always match one row. Every write goes through here
 * so the two stay consistent.
 */
type Product = typeof schema.products.$inferSelect;
export interface ProductPrice extends CurrencyPrice { id: string | null }

const P = schema.productPrices;
const defaultOf = (p: Pick<Product, "testStorePriceMicros" | "testStorePriceCurrency">): CurrencyPrice | null =>
  p.testStorePriceMicros !== null && p.testStorePriceCurrency ? { currency: p.testStorePriceCurrency, amount_micros: p.testStorePriceMicros } : null;

/** Every Test Store price of each product, default first (`priceList`), keyed by product id. */
export async function pricesOf(db: DB, products: Product[]): Promise<Map<string, ProductPrice[]>> {
  const ids = products.map((p) => p.id);
  const rows = ids.length ? await db.select().from(P).where(inArray(P.productId, ids)) : [];
  const out = new Map<string, ProductPrice[]>();
  for (const p of products) {
    const own = rows.filter((r) => r.productId === p.id);
    const idOf = new Map(own.map((r) => [r.currency, r.id]));
    out.set(p.id, priceList(defaultOf(p), own.map((r) => ({ currency: r.currency, amount_micros: r.amountMicros })))
      .map((x) => ({ id: idOf.get(x.currency) ?? null, ...x })));
  }
  return out;
}

export const priceShape = (p: ProductPrice) => ({ id: p.id, currency: p.currency, amount_micros: p.amount_micros });

/** The price to show or charge for a product: the customer's currency (`want`), else the default. */
export function priceFor(prices: CurrencyPrice[] | undefined, want: { currency?: string | null; country?: string | null }): CurrencyPrice | null {
  return pickPrice(prices ?? [], want);
}

async function upsertRows(db: DB, p: Product, prices: CurrencyPrice[]) {
  if (!prices.length) return;
  await db.insert(P).values(prices.map((x) => ({ id: newId("prc", 12), productId: p.id, projectId: p.projectId, currency: x.currency, amountMicros: x.amount_micros })))
    .onConflictDoUpdate({ target: [P.productId, P.currency], set: { amountMicros: sql`excluded.amount_micros` } });
}
const setDefault = (db: DB, p: Product, d: CurrencyPrice | null) =>
  db.update(schema.products).set({ testStorePriceMicros: d?.amount_micros ?? null, testStorePriceCurrency: d?.currency ?? null })
    .where(eq(schema.products.id, p.id)).returning().then((r) => r[0]!);

/**
 * Runs one price write in a transaction with the product row locked, on the product as it is now: two writes at once
 * (two dashboard tabs, an API script) cannot leave the default pointing at a deleted row or at an old amount.
 */
async function locked<T>(db: DB, p: Product, fn: (tx: DB, current: Product) => Promise<T>): Promise<T> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as DB;
    const [current] = await tx.select().from(schema.products).where(eq(schema.products.id, p.id)).for("update");
    return fn(tx, current ?? p);
  });
}

/**
 * `test_store_price` on product create and update: sets the default price (adding or updating its currency's row) and
 * keeps the other currencies. Null clears every price.
 */
export function setDefaultPrice(db: DB, product: Product, price: CurrencyPrice | null): Promise<Product> {
  return locked(db, product, async (tx, p) => {
    if (!price) {
      await tx.delete(P).where(eq(P.productId, p.id));
      return setDefault(tx, p, null);
    }
    // A default from before prices by currency existed gets its row first, so changing the currency keeps the old price.
    const old = defaultOf(p);
    await upsertRows(tx, p, old && old.currency !== price.currency ? [old, price] : [price]);
    return setDefault(tx, p, price);
  });
}

/**
 * `POST …/test_store_prices`: adds the currencies (an existing currency gets the new amount). A product without a price
 * gets a default: USD when it is among them, else the first given.
 */
export function addPrices(db: DB, product: Product, prices: CurrencyPrice[]): Promise<Product> {
  return locked(db, product, async (tx, p) => {
    const old = defaultOf(p);
    await upsertRows(tx, p, old && !prices.some((x) => x.currency === old.currency) ? [old, ...prices] : prices);
    const same = old && prices.find((x) => x.currency === old.currency);
    if (same) return setDefault(tx, p, same);
    if (!old) return setDefault(tx, p, prices.find((x) => x.currency === "USD") ?? prices[0]!);
    return p;
  });
}

/** `PATCH …/prices/{currency}`: the new amount, or null when the product has no price in that currency. */
export function updatePrice(db: DB, product: Product, currency: string, amountMicros: number): Promise<ProductPrice | null> {
  return locked(db, product, async (tx, p) => {
    const current = (await pricesOf(tx, [p])).get(p.id)!.find((x) => x.currency === currency);
    if (!current) return null;
    let [row] = await tx.update(P).set({ amountMicros }).where(and(eq(P.productId, p.id), eq(P.currency, currency))).returning({ id: P.id });
    // A default written before prices by currency existed has no row yet; it gets one now.
    if (!row) [row] = await tx.insert(P).values({ id: newId("prc", 12), productId: p.id, projectId: p.projectId, currency, amountMicros }).returning({ id: P.id });
    if (p.testStorePriceCurrency === currency) await setDefault(tx, p, { currency, amount_micros: amountMicros });
    return { id: row?.id ?? null, currency, amount_micros: amountMicros };
  });
}

/**
 * `DELETE …/prices/{currency}` (extension): removes one currency. Removing the default makes USD (else the first
 * currency) the default; removing the last price leaves the product without one. Null when there was no such price,
 * else the removed price.
 */
export function removePrice(db: DB, product: Product, currency: string): Promise<ProductPrice | null> {
  return locked(db, product, async (tx, p) => {
    const all = (await pricesOf(tx, [p])).get(p.id)!;
    const gone = all.find((x) => x.currency === currency);
    if (!gone) return null;
    await tx.delete(P).where(and(eq(P.productId, p.id), eq(P.currency, currency)));
    if (p.testStorePriceCurrency === currency) {
      const next = nextDefault(all, currency);
      await setDefault(tx, p, next ? { currency: next.currency, amount_micros: next.amount_micros } : null);
    }
    return gone;
  });
}
