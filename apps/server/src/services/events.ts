import { and, eq } from "drizzle-orm";
import { commission, rcDate, webhookStore, type DerivedEvent, type EventType, type Store } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { aliasesOf, type CustomerRow } from "../repo/customers.js";
import { entitlementMap } from "../repo/catalog.js";

const { events, webhooks, webhookDeliveries, customerAttributes } = schema;

export interface EventSubject {
  store: Store;
  productId: string;
  productPlanId?: string | null;
  periodType: string;
  purchasedAt: Date;
  expiresAt: Date | null;
  gracePeriodExpiresAt?: Date | null;
  autoResumeAt?: Date | null;
  transactionId: string | null;
  originalTransactionId: string | null;
  isSandbox: boolean;
  isFamilyShare: boolean;
  countryCode?: string | null;
  price?: { amount: number; currency: string } | null;
  priceUsd?: number | null;
  presentedOfferingId?: string | null;
}

/** Events whose `price` is the money that moved: purchases, renewals, refunds (negative) and refund reversals. Every other event reports 0. */
const REVENUE_EVENTS = new Set<string>(["INITIAL_PURCHASE", "RENEWAL", "NON_RENEWING_PURCHASE", "REFUND_REVERSED"]);
const PRICE_CONSENT_EVENTS = new Set<string>(["PRICE_INCREASE_CONSENT_REQUIRED", "PRICE_INCREASE_CONSENT_APPROVED"]);

/**
 * Records one lifecycle event in RevenueCat's webhook shape and queues a delivery to every matching webhook.
 * The stored payload is exactly what webhooks receive, so the dashboard and the API show the same thing.
 *
 * Field groups follow RevenueCat's "Event Types and Fields" page (company research raw/pages/integrations_webhooks_event-types-and-fields.md):
 * - every event: `type`, `id`, `event_timestamp_ms`, `app_id` (left out for the PROMOTIONAL store);
 * - lifecycle events and TEST: subscriber identity plus the subscription lifecycle group. `price` and `price_in_purchased_currency`
 *   carry money only for purchases, renewals, refunds and refund reversals, and are 0 on every other event (as in RevenueCat's samples);
 *   `grace_period_expiration_at_ms` only on BILLING_ISSUE (always present there, may be null), `auto_resume_at_ms` only on
 *   SUBSCRIPTION_PAUSED, `is_trial_conversion` only on RENEWAL, `cancel_reason` / `expiration_reason` only on CANCELLATION /
 *   EXPIRATION, `new_product_id` only on PRODUCT_CHANGE and omitted when null;
 * - TRANSFER: `transferred_from`, `transferred_to`, `subscriber_attributes`, `store`, `environment` only;
 * - price-increase consent: subscriber identity plus `product_id`, `transaction_id`, `original_transaction_id`, `store`,
 *   `environment`, `currency`, `country_code`.
 * All timestamps are epoch milliseconds.
 */
export async function recordEvent(db: DB, opts: {
  projectId: string; appId: string | null; customer: CustomerRow; appUserId: string; derived: DerivedEvent; subject: EventSubject; now: Date;
  extra?: Record<string, unknown>;
}) {
  const { projectId, appId, customer, appUserId, derived, now } = opts;
  const subject: EventSubject = derived.fromProduct
    ? { ...opts.subject, productId: derived.fromProduct.productId, productPlanId: derived.fromProduct.productPlanId ?? null }
    : opts.subject;
  const type = derived.type;
  const aliases = await aliasesOf(db, customer.id);
  const attrs = await db.select().from(customerAttributes).where(eq(customerAttributes.customerId, customer.id));
  const subscriber_attributes: Record<string, { value: string | null; updated_at_ms: number }> = {};
  for (const a of attrs) subscriber_attributes[a.key] = { value: a.value, updated_at_ms: a.updatedAtMs };
  const id = crypto.randomUUID().toUpperCase();
  const environment = subject.isSandbox ? "SANDBOX" : "PRODUCTION";
  const common: Record<string, unknown> = { id, type, event_timestamp_ms: now.getTime() };
  if (subject.store !== "promotional") common.app_id = appId;
  const identity = { app_user_id: appUserId, original_app_user_id: customer.originalAppUserId, aliases };

  let event: Record<string, unknown>;
  if (type === "TRANSFER") {
    event = { ...common, store: webhookStore(subject.store), environment, subscriber_attributes, ...(opts.extra ?? {}) };
  } else if (PRICE_CONSENT_EVENTS.has(type)) {
    event = {
      ...common, ...identity, product_id: subject.productId, transaction_id: subject.transactionId, original_transaction_id: subject.originalTransactionId,
      store: webhookStore(subject.store), environment, currency: subject.price?.currency ?? null, country_code: subject.countryCode ?? null, subscriber_attributes,
      ...(opts.extra ?? {}),
    };
  } else {
    const map = await entitlementMap(db, projectId);
    const productKey = subject.productPlanId ? `${subject.productId}:${subject.productPlanId}` : subject.productId;
    const entitlementIds = Object.entries(map).filter(([, p]) => p.includes(productKey) || p.includes(subject.productId)).map(([k]) => k);
    const comm = commission(subject.store);
    const moves = REVENUE_EVENTS.has(type) || (type === "CANCELLATION" && derived.isRefund);
    const sign = derived.isRefund ? -1 : 1;
    const usd = subject.priceUsd !== undefined && subject.priceUsd !== null ? subject.priceUsd : subject.price ? subject.price.amount : null;
    const local = subject.price ? subject.price.amount : null;
    const money = (v: number | null) => (v === null ? null : moves ? sign * v : 0);
    event = {
      ...common, ...identity, product_id: subject.productId,
      period_type: subject.periodType.toUpperCase(), purchased_at_ms: subject.purchasedAt.getTime(),
      expiration_at_ms: subject.expiresAt ? subject.expiresAt.getTime() : null, environment,
      entitlement_id: null, entitlement_ids: entitlementIds.length ? entitlementIds : null,
      presented_offering_id: subject.presentedOfferingId ?? null, transaction_id: subject.transactionId,
      original_transaction_id: subject.originalTransactionId, is_family_share: subject.isFamilyShare,
      country_code: subject.countryCode ?? null, currency: subject.price?.currency ?? null,
      price: money(usd), price_in_purchased_currency: money(local),
      subscriber_attributes, store: webhookStore(subject.store), takehome_percentage: 1 - comm,
      tax_percentage: 0, commission_percentage: comm, offer_code: null,
    };
    if (type === "BILLING_ISSUE") event.grace_period_expiration_at_ms = subject.gracePeriodExpiresAt ? subject.gracePeriodExpiresAt.getTime() : null;
    if (type === "SUBSCRIPTION_PAUSED") event.auto_resume_at_ms = subject.autoResumeAt ? subject.autoResumeAt.getTime() : null;
    if (type === "RENEWAL") event.is_trial_conversion = derived.isTrialConversion ?? false;
    if (type === "CANCELLATION" && derived.cancelReason) event.cancel_reason = derived.cancelReason;
    if (type === "EXPIRATION" && derived.expirationReason) event.expiration_reason = derived.expirationReason;
    if (type === "PRODUCT_CHANGE" && derived.newProductId) event.new_product_id = derived.newProductId;
    Object.assign(event, opts.extra ?? {});
  }
  const payload = { api_version: "1.0", event };
  await db.insert(events).values({
    id, projectId, customerId: customer.id, type, environment: environment.toLowerCase(), appId,
    payload, eventTimestampMs: now.getTime(),
  });
  await queueDeliveries(db, projectId, id, type, environment.toLowerCase(), appId, now);
  return payload;
}

export async function queueDeliveries(db: DB, projectId: string, eventId: string, type: EventType | string, environment: string, appId: string | null, now: Date = new Date()) {
  const hooks = await db.select().from(webhooks).where(and(eq(webhooks.projectId, projectId), eq(webhooks.enabled, true)));
  for (const h of hooks) {
    if (h.environment !== "both" && h.environment !== environment) continue;
    if (h.appId && h.appId !== appId) continue;
    if (h.eventTypes && h.eventTypes.length && !h.eventTypes.includes(type)) continue;
    await db.insert(webhookDeliveries).values({ id: crypto.randomUUID(), webhookId: h.id, eventId, nextAttemptAt: now, createdAt: now }).onConflictDoNothing();
  }
}

export { rcDate };
