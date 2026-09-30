import { rcDate } from "./dates.js";
import { computeEntitlements } from "./entitlements.js";
import type { CustomerState, EntitlementMap, NonSubscription, Subscription } from "./types.js";

/** JSON shape of `GET /v1/subscribers/{id}` (and receipts, identify, redeem). Matches the RevenueCat SDKs' decoders. */
export interface CustomerInfoJSON {
  request_date: string;
  request_date_ms: number;
  subscriber: {
    original_app_user_id: string;
    original_application_version: string | null;
    original_purchase_date: string | null;
    management_url: string | null;
    first_seen: string;
    last_seen: string;
    entitlements: Record<string, { expires_date: string | null; grace_period_expires_date: string | null; product_identifier: string; product_plan_identifier?: string | null; purchase_date: string }>;
    subscriptions: Record<string, Record<string, unknown>>;
    non_subscriptions: Record<string, Record<string, unknown>[]>;
    other_purchases: Record<string, { purchase_date: string }>;
    subscriber_attributes?: Record<string, { value: string | null; updated_at_ms: number }>;
  };
}

function subJSON(s: Subscription): Record<string, unknown> {
  const o: Record<string, unknown> = {
    auto_resume_date: rcDate(s.autoResumeDate),
    billing_issues_detected_at: rcDate(s.billingIssuesDetectedAt),
    display_name: s.displayName ?? null,
    expires_date: rcDate(s.expiresDate),
    grace_period_expires_date: rcDate(s.gracePeriodExpiresDate),
    is_sandbox: s.isSandbox,
    management_url: s.managementUrl ?? null,
    original_purchase_date: rcDate(s.originalPurchaseDate),
    ownership_type: s.ownershipType ?? "PURCHASED",
    period_type: s.periodType,
    purchase_date: rcDate(s.purchaseDate),
    refunded_at: rcDate(s.refundedAt),
    store: s.store,
    store_transaction_id: s.storeTransactionId ?? null,
    unsubscribe_detected_at: rcDate(s.unsubscribeDetectedAt),
  };
  if (s.productPlanIdentifier) o.product_plan_identifier = s.productPlanIdentifier;
  if (s.price) o.price = { amount: s.price.amount, currency: s.price.currency };
  return o;
}

function nonSubJSON(p: NonSubscription): Record<string, unknown> {
  const o: Record<string, unknown> = {
    display_name: p.displayName ?? null,
    id: p.id,
    is_sandbox: p.isSandbox,
    original_purchase_date: rcDate(p.originalPurchaseDate ?? p.purchaseDate),
    purchase_date: rcDate(p.purchaseDate),
    store: p.store,
    store_transaction_id: p.storeTransactionId,
  };
  if (p.price) o.price = { amount: p.price.amount, currency: p.price.currency };
  return o;
}

/**
 * Builds the customer info response.
 * subscriptions: one entry per product, the latest subscription for that product.
 * non_subscriptions: arrays ordered oldest first (the SDK treats the last element as the latest).
 */
export function buildCustomerInfo(state: CustomerState, map: EntitlementMap, now: Date = new Date(), opts: { includeAttributes?: boolean } = {}): CustomerInfoJSON {
  const subscriptions: Record<string, Record<string, unknown>> = {};
  const latestByProduct = new Map<string, Subscription>();
  for (const s of state.subscriptions) {
    const cur = latestByProduct.get(s.productIdentifier);
    if (!cur || s.purchaseDate > cur.purchaseDate) latestByProduct.set(s.productIdentifier, s);
  }
  for (const [k, s] of [...latestByProduct].sort((a, b) => a[0].localeCompare(b[0]))) subscriptions[k] = subJSON(s);

  const nonSubs: Record<string, Record<string, unknown>[]> = {};
  for (const p of [...state.nonSubscriptions].sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime())) {
    (nonSubs[p.productIdentifier] ??= []).push(nonSubJSON(p));
  }

  const entitlements: CustomerInfoJSON["subscriber"]["entitlements"] = {};
  for (const e of computeEntitlements(state, map)) {
    entitlements[e.identifier] = {
      expires_date: rcDate(e.expiresDate),
      grace_period_expires_date: rcDate(e.gracePeriodExpiresDate),
      product_identifier: e.productIdentifier,
      ...(e.productPlanIdentifier ? { product_plan_identifier: e.productPlanIdentifier } : {}),
      purchase_date: rcDate(e.purchaseDate)!,
    };
  }

  const attrs: CustomerInfoJSON["subscriber"]["subscriber_attributes"] = {};
  for (const [k, v] of Object.entries(state.attributes)) attrs[k] = { value: v.value, updated_at_ms: v.updatedAtMs };

  return {
    request_date: rcDate(now)!,
    request_date_ms: now.getTime(),
    subscriber: {
      entitlements,
      first_seen: rcDate(state.firstSeen)!,
      last_seen: rcDate(state.lastSeen)!,
      management_url: state.managementUrl ?? null,
      non_subscriptions: nonSubs,
      original_app_user_id: state.originalAppUserId,
      original_application_version: state.originalApplicationVersion ?? null,
      original_purchase_date: rcDate(state.originalPurchaseDate),
      other_purchases: {},
      ...(opts.includeAttributes ? { subscriber_attributes: attrs } : {}),
      subscriptions,
    },
  };
}
