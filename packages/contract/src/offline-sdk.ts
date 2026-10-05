/**
 * The RevenueCat SDKs' offline entitlement lookups, re-implemented from purchases-ios Sources/OfflineEntitlements and
 * purchases-android common/offlineentitlements (prd/offline-entitlements/PRD.md), to compare with what the server grants online.
 */
export type Mapping = Record<string, { product_identifier: string; base_plan_id?: string; entitlements: string[] }>;

/**
 * iOS: every entry re-keyed by product_identifier plus the billing-plan component ("monthly" kept, "upFront" and none
 * dropped), and a transaction looked up by its product id plus its StoreKit `billingPlanType` component the same way.
 */
export const iosLookup = (m: Mapping, productId: string, billingPlan?: string) => {
  const byCompound = new Map<string, string[]>();
  for (const e of Object.values(m)) {
    const plan = e.base_plan_id && e.base_plan_id !== "upFront" ? e.base_plan_id : null;
    byCompound.set(plan ? `${e.product_identifier}:${plan}` : e.product_identifier, e.entitlements);
  }
  const plan = billingPlan && billingPlan !== "upFront" ? billingPlan : null;
  return [...(byCompound.get(plan ? `${productId}:${plan}` : productId) ?? [])].sort();
};

/** Android: Play purchases carry only the subscription id, looked up by dictionary key. */
export const androidLookup = (m: Mapping, productId: string) => [...(m[productId]?.entitlements ?? [])].sort();
