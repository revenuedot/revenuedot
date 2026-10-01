import { and, asc, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { priceLabels, type PagePackage } from "@revenuedot/core/funnels";

/**
 * What an offering sells on the web: its packages that hold a web product of the given Stripe app, in package order,
 * with the Stripe price and the labels the hosted pages show (prd/web-billing/PRD.md §2).
 */

export type WebProductRow = typeof schema.webProducts.$inferSelect;
export interface WebPackage {
  packageId: string;
  key: string;
  name: string;
  product: typeof schema.products.$inferSelect;
  web: WebProductRow;
  page: PagePackage;
}

export async function offeringByKey(db: DB, projectId: string, key: string | null | undefined) {
  const rows = await db.select().from(schema.offerings).where(eq(schema.offerings.projectId, projectId));
  return (key ? rows.find((o) => o.lookupKey === key || o.id === key) : rows.find((o) => o.isCurrent)) ?? null;
}

/** Monthly equivalent in minor units, to label the best-value package ("Save 33%"). */
function perMonth(w: WebProductRow): number | null {
  if (!w.interval) return null;
  const n = w.intervalCount ?? 1;
  const months = w.interval === "year" ? 12 * n : w.interval === "month" ? n : w.interval === "week" ? (7 * n) / 30.4 : n / 30.4;
  return w.amountMinor / months;
}

export async function webPackages(db: DB, projectId: string, appId: string, offeringId: string): Promise<WebPackage[]> {
  const pkgs = await db.select().from(schema.packages).where(eq(schema.packages.offeringId, offeringId)).orderBy(asc(schema.packages.position), asc(schema.packages.createdAt));
  if (!pkgs.length) return [];
  const links = await db.select({ packageId: schema.packageProducts.packageId, product: schema.products, web: schema.webProducts })
    .from(schema.packageProducts)
    .innerJoin(schema.products, eq(schema.products.id, schema.packageProducts.productId))
    .innerJoin(schema.webProducts, eq(schema.webProducts.productId, schema.products.id))
    .where(and(inArray(schema.packageProducts.packageId, pkgs.map((p) => p.id)), eq(schema.products.appId, appId), eq(schema.products.projectId, projectId)));
  const out: WebPackage[] = [];
  for (const p of pkgs) {
    const l = links.find((x) => x.packageId === p.id);
    if (!l) continue;
    const labels = priceLabels({ amount_minor: l.web.amountMinor, currency: l.web.currency, interval: l.web.interval, interval_count: l.web.intervalCount, trial_days: l.web.trialDays });
    out.push({ packageId: p.id, key: p.lookupKey, name: p.displayName || l.product.displayName || p.lookupKey, product: l.product, web: l.web, page: { id: p.lookupKey, name: p.displayName || l.product.displayName || p.lookupKey, ...labels, badge: null } });
  }
  // "Save N%" on the cheapest per-month package when there is a pricier one in the same currency.
  const monthly = out.map((x) => ({ x, m: perMonth(x.web) })).filter((y) => y.m !== null) as { x: WebPackage; m: number }[];
  if (monthly.length > 1) {
    const best = monthly.reduce((a, b) => (b.m < a.m ? b : a));
    const worst = monthly.filter((y) => y.x.web.currency === best.x.web.currency).reduce((a, b) => (b.m > a.m ? b : a));
    const save = Math.round((1 - best.m / worst.m) * 100);
    if (save >= 5) best.x.page.badge = `Save ${save}%`;
  }
  return out;
}

export async function webProductsOf(db: DB, projectId: string, appId?: string) {
  return db.select({ product: schema.products, web: schema.webProducts }).from(schema.webProducts)
    .innerJoin(schema.products, eq(schema.products.id, schema.webProducts.productId))
    .where(appId ? and(eq(schema.webProducts.projectId, projectId), eq(schema.webProducts.appId, appId)) : eq(schema.webProducts.projectId, projectId));
}
