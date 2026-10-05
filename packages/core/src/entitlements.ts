import type { ActiveEntitlement, CustomerState, EntitlementMap, Subscription } from "./types.js";

/**
 * When a subscription stops granting access.
 * Refund ends access at the refund time; a grace period extends access to its end; otherwise the store expiry.
 * null means it never ends (promotional lifetime).
 */
export function accessEndsAt(s: Subscription): Date | null {
  if (s.refundedAt) return s.refundedAt;
  if (s.expiresDate === null) return null;
  const grace = s.gracePeriodExpiresDate;
  if (grace && grace.getTime() > s.expiresDate.getTime()) return grace;
  return s.expiresDate;
}

const APPLE_STORES: ReadonlySet<string> = new Set(["app_store", "mac_app_store"]);

/**
 * The catalog store identifiers a subscription matches, most specific first (prd/offline-entitlements/PRD.md):
 * - with a plan (a Google Play base plan, an App Store billing plan such as `monthly`): `product:plan`, then the bare `product`;
 * - an App Store purchase without a billing plan (paid up front, or bought before iOS 26.4): `product`, then
 *   `product:upFront`, the key iOS files under the bare product for offline entitlements.
 */
export function productKeysFor(s: { store: string; productIdentifier: string; productPlanIdentifier?: string | null }): string[] {
  if (s.productPlanIdentifier) return [`${s.productIdentifier}:${s.productPlanIdentifier}`, s.productIdentifier];
  return APPLE_STORES.has(s.store) ? [s.productIdentifier, `${s.productIdentifier}:upFront`] : [s.productIdentifier];
}

/**
 * The entitlements block of customer info, computed from the catalog mapping.
 * Every entitlement that any purchase has ever unlocked is listed (active or expired), like RevenueCat;
 * the SDK decides `isActive` by comparing `expires_date` with the request date.
 * Choice per entitlement: a lifetime unlock wins; otherwise the purchase whose access ends last.
 */
export function computeEntitlements(state: CustomerState, catalog: EntitlementMap): ActiveEntitlement[] {
  const out: ActiveEntitlement[] = [];
  // A blocked customer has no paid features anywhere; a customer outside sandbox testing access gets nothing from sandbox purchases.
  if (state.access?.blocked) return out;
  const counts = (p: { isSandbox?: boolean }) => state.access?.sandbox !== false || !p.isSandbox;
  const map: EntitlementMap = { ...catalog };
  for (const s of state.subscriptions) if (s.store === "promotional" && s.entitlementIdentifier) map[s.entitlementIdentifier] ??= [];
  for (const [identifier, productIds] of Object.entries(map)) {
    const products = new Set(productIds);
    let best: ActiveEntitlement | null = null;
    const better = (c: ActiveEntitlement) => {
      if (!best) return true;
      if (best.expiresDate === null) return false;
      if (c.expiresDate === null) return true;
      if (c.expiresDate.getTime() !== best.expiresDate.getTime()) return c.expiresDate > best.expiresDate;
      return c.purchaseDate > best.purchaseDate;
    };
    for (const s of state.subscriptions) {
      if (!counts(s)) continue;
      const promo = s.store === "promotional" && s.entitlementIdentifier === identifier;
      if (!promo && !productKeysFor(s).some((k) => products.has(k))) continue;
      const c: ActiveEntitlement = {
        identifier, productIdentifier: s.productIdentifier, productPlanIdentifier: s.productPlanIdentifier ?? null,
        purchaseDate: s.purchaseDate, expiresDate: accessEndsAt(s), gracePeriodExpiresDate: s.gracePeriodExpiresDate ?? null,
      };
      if (better(c)) best = c;
    }
    for (const p of state.nonSubscriptions) {
      if (!products.has(p.productIdentifier) || p.isConsumable || !counts(p)) continue;
      const c: ActiveEntitlement = {
        identifier, productIdentifier: p.productIdentifier, purchaseDate: p.purchaseDate,
        expiresDate: p.refundedAt ?? null,
      };
      if (better(c)) best = c;
    }
    if (best) out.push(best);
  }
  return out;
}

export function isActive(e: ActiveEntitlement, now: Date): boolean {
  return e.expiresDate === null || e.expiresDate.getTime() > now.getTime();
}

/** RevenueCat's willRenew rule, used by dashboards and webhooks. */
export function willRenew(s: Subscription): boolean {
  return !(s.store === "promotional" || s.expiresDate === null || s.unsubscribeDetectedAt || s.billingIssuesDetectedAt || s.periodType === "prepaid" || s.refundedAt);
}
