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

/**
 * The entitlements block of customer info, computed from the catalog mapping.
 * Every entitlement that any purchase has ever unlocked is listed (active or expired), like RevenueCat;
 * the SDK decides `isActive` by comparing `expires_date` with the request date.
 * Choice per entitlement: a lifetime unlock wins; otherwise the purchase whose access ends last.
 */
export function computeEntitlements(state: CustomerState, map: EntitlementMap): ActiveEntitlement[] {
  const out: ActiveEntitlement[] = [];
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
      if (!products.has(s.productIdentifier) && !(s.productPlanIdentifier && products.has(`${s.productIdentifier}:${s.productPlanIdentifier}`))) continue;
      const c: ActiveEntitlement = {
        identifier, productIdentifier: s.productIdentifier, productPlanIdentifier: s.productPlanIdentifier ?? null,
        purchaseDate: s.purchaseDate, expiresDate: accessEndsAt(s), gracePeriodExpiresDate: s.gracePeriodExpiresDate ?? null,
      };
      if (better(c)) best = c;
    }
    for (const p of state.nonSubscriptions) {
      if (!products.has(p.productIdentifier) || p.isConsumable) continue;
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
