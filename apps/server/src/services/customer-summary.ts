import { eq, inArray } from "drizzle-orm";
import { computeEntitlements, isActive } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { entitlementMap } from "../repo/catalog.js";
import { aliasesOf, loadState, type CustomerRow } from "../repo/customers.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What the dashboard shows about a customer beyond RevenueCat's v2 customer object: revenue, entitlement names and
 * their source, the offering override, and each subscription's price and period type (v2 subscriptions carry neither).
 */
export async function customerSummary(db: DB, cust: CustomerRow, requestedId: string, now: Date) {
  const [aliases, state, map, ents, subs, ones, txns] = await Promise.all([
    aliasesOf(db, cust.id), loadState(db, cust), entitlementMap(db, cust.projectId),
    db.select().from(schema.entitlements).where(eq(schema.entitlements.projectId, cust.projectId)),
    db.select().from(schema.subscriptions).where(eq(schema.subscriptions.customerId, cust.id)),
    db.select().from(schema.nonSubscriptions).where(eq(schema.nonSubscriptions.customerId, cust.id)),
    db.select().from(schema.transactions).where(eq(schema.transactions.customerId, cust.id)),
  ]);
  const productIds = [...new Set([...subs.map((s) => s.productIdentifier), ...ones.map((p) => p.productIdentifier)])];
  const products = productIds.length ? await db.select().from(schema.products).where(inArray(schema.products.storeIdentifier, productIds)) : [];
  const product = (storeId: string, appId: string | null) => {
    const own = products.filter((p) => p.projectId === cust.projectId && p.storeIdentifier === storeId);
    return own.find((p) => p.appId === appId) ?? own[0] ?? null;
  };
  const [override] = cust.offeringOverrideId
    ? await db.select().from(schema.offerings).where(eq(schema.offerings.id, cust.offeringOverrideId)).limit(1) : [];

  const active = computeEntitlements(state, map).filter((e) => isActive(e, now));
  const entRow = (lookupKey: string) => ents.find((e) => e.lookupKey === lookupKey);
  const lastTxn = [...txns].sort((a, b) => b.purchasedAt.getTime() - a.purchasedAt.getTime()).find((t) => t.countryCode);
  const revenue = (sandbox: boolean) => round2(txns.filter((t) => t.isSandbox === sandbox).reduce((s, t) => s + t.revenueUsd, 0));

  return {
    object: "customer_summary" as const,
    id: requestedId,
    original_app_user_id: cust.originalAppUserId,
    aliases: aliases.sort(),
    total_revenue_in_usd: revenue(false),
    sandbox_revenue_in_usd: revenue(true),
    country: (lastTxn?.countryCode ?? cust.lastSeenCountry ?? null)?.toUpperCase() ?? null,
    platform: cust.lastSeenPlatform ?? null,
    stores: [...new Set([...subs.map((s) => s.store), ...ones.map((p) => p.store)])].sort(),
    offering_override: override ? { id: override.id, lookup_key: override.lookupKey, display_name: override.displayName } : null,
    active_entitlements: active.flatMap((e) => {
      const row = entRow(e.identifier);
      if (!row) return [];
      const promo = e.productIdentifier.startsWith("rc_promo_");
      return [{
        entitlement_id: row.id, lookup_key: row.lookupKey, display_name: row.displayName, expires_at: e.expiresDate ? e.expiresDate.getTime() : null,
        source: promo ? "promotional" as const : "purchase" as const, product_identifier: promo ? null : e.productIdentifier,
      }];
    }),
    granted_entitlements: subs.filter((s) => s.store === "promotional" && (s.expiresDate === null || s.expiresDate > now) && s.entitlementIdentifier).flatMap((s) => {
      const row = entRow(s.entitlementIdentifier!);
      return row ? [{ entitlement_id: row.id, lookup_key: row.lookupKey, display_name: row.displayName, granted_at: s.purchaseDate.getTime(), expires_at: s.expiresDate ? s.expiresDate.getTime() : null }] : [];
    }),
    subscriptions: subs.map((s) => {
      const p = s.store === "promotional" ? null : product(s.productIdentifier, s.appId);
      return {
        id: s.id, product_identifier: s.productIdentifier, product_display_name: p?.displayName ?? null, duration: p?.duration ?? null,
        period_type: s.periodType, price: s.priceAmount !== null && s.priceCurrency ? { amount: s.priceAmount, currency: s.priceCurrency } : null,
        price_in_usd: s.priceUsd, will_renew_product_identifier: s.autoRenewProductId,
      };
    }),
    purchases: ones.map((o) => {
      const p = product(o.productIdentifier, o.appId);
      return {
        id: o.id, product_identifier: o.productIdentifier, product_display_name: p?.displayName ?? null, is_consumable: o.isConsumable,
        price: o.priceAmount !== null && o.priceCurrency ? { amount: o.priceAmount, currency: o.priceCurrency } : null,
      };
    }),
  };
}
