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

/**
 * Records one lifecycle event in RevenueCat's webhook shape and queues a delivery to every matching webhook.
 * The stored payload is exactly what webhooks receive, so the dashboard and the API show the same thing.
 */
export async function recordEvent(db: DB, opts: {
  projectId: string; appId: string | null; customer: CustomerRow; appUserId: string; derived: DerivedEvent; subject: EventSubject; now: Date;
  extra?: Record<string, unknown>;
}) {
  const { projectId, appId, customer, appUserId, derived, subject, now } = opts;
  const map = await entitlementMap(db, projectId);
  const productKey = subject.productPlanId ? `${subject.productId}:${subject.productPlanId}` : subject.productId;
  const entitlementIds = Object.entries(map).filter(([, p]) => p.includes(productKey) || p.includes(subject.productId)).map(([k]) => k);
  const aliases = await aliasesOf(db, customer.id);
  const attrs = await db.select().from(customerAttributes).where(eq(customerAttributes.customerId, customer.id));
  const subscriber_attributes: Record<string, { value: string | null; updated_at_ms: number }> = {};
  for (const a of attrs) subscriber_attributes[a.key] = { value: a.value, updated_at_ms: a.updatedAtMs };
  const sign = derived.isRefund ? -1 : 1;
  const comm = commission(subject.store);
  const id = crypto.randomUUID().toUpperCase();
  const environment = subject.isSandbox ? "SANDBOX" : "PRODUCTION";
  const event: Record<string, unknown> = {
    id, type: derived.type, event_timestamp_ms: now.getTime(), app_id: appId, app_user_id: appUserId,
    original_app_user_id: customer.originalAppUserId, aliases, product_id: subject.productId,
    period_type: subject.periodType.toUpperCase(), purchased_at_ms: subject.purchasedAt.getTime(),
    expiration_at_ms: subject.expiresAt ? subject.expiresAt.getTime() : null, environment,
    entitlement_id: null, entitlement_ids: entitlementIds.length ? entitlementIds : null,
    presented_offering_id: subject.presentedOfferingId ?? null, transaction_id: subject.transactionId,
    original_transaction_id: subject.originalTransactionId, is_family_share: subject.isFamilyShare,
    country_code: subject.countryCode ?? null, currency: subject.price?.currency ?? null,
    price: subject.priceUsd !== undefined && subject.priceUsd !== null ? sign * subject.priceUsd : subject.price ? sign * subject.price.amount : null,
    price_in_purchased_currency: subject.price ? sign * subject.price.amount : null,
    subscriber_attributes, store: webhookStore(subject.store), takehome_percentage: 1 - comm,
    tax_percentage: 0, commission_percentage: comm, offer_code: null,
  };
  if (subject.gracePeriodExpiresAt) event.grace_period_expiration_at_ms = subject.gracePeriodExpiresAt.getTime();
  if (subject.autoResumeAt) event.auto_resume_at_ms = subject.autoResumeAt.getTime();
  if (derived.cancelReason) event.cancel_reason = derived.cancelReason;
  if (derived.expirationReason) event.expiration_reason = derived.expirationReason;
  if (derived.type === "RENEWAL") event.is_trial_conversion = derived.isTrialConversion ?? false;
  if (derived.newProductId) event.new_product_id = derived.newProductId;
  Object.assign(event, opts.extra ?? {});
  const payload = { api_version: "1.0", event };
  await db.insert(events).values({
    id, projectId, customerId: customer.id, type: derived.type, environment: environment.toLowerCase(), appId,
    payload, eventTimestampMs: now.getTime(),
  });
  await queueDeliveries(db, projectId, id, derived.type, environment.toLowerCase(), appId, now);
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
