import { basicAuth, conceptOf, defaultAnalyticsName, json, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";
import { isAnonymous } from "../ids.js";

/**
 * Segment: a `track` call per event plus an `identify` call with the customer's traits, through the HTTP Tracking API
 * (https://segment.com/docs/connections/sources/catalog/libraries/server/http-api/). Basic auth with the source's write key.
 * Secrets: `write_key`. Settings: `region` (us | eu), `anonymous_id` (send anonymous app
 * user ids as `anonymousId`), `reporting`. `messageId` is the event id, so a retried call is deduplicated by Segment.
 */

export const SEGMENT_HOSTS = { us: "https://api.segment.io", eu: "https://events.eu1.segmentapis.com" } as const;

export const SEGMENT_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "purchase_redeemed", "test",
];

const secs = (ms: unknown) => (typeof ms === "number" ? Math.floor(ms / 1000) : null);

export async function buildSegment(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const key = i.secrets.write_key;
  if (!key) return skip("No Segment write key is saved.");
  const c = conceptOf(e);
  if (!c || !SEGMENT_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Segment.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const host = SEGMENT_HOSTS[(i.settings.region as keyof typeof SEGMENT_HOSTS) ?? "us"] ?? SEGMENT_HOSTS.us;
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  const who = i.settings.anonymous_id && isAnonymous(appUserId) ? { anonymousId: appUserId } : { userId: appUserId };
  const context = { environment: String(e.environment ?? "PRODUCTION").toLowerCase(), library: { name: "RevenueDot Segment events", version: "1.0" } };
  const timestamp = new Date(e.event_timestamp_ms ?? i.now.getTime()).toISOString();
  const properties: Record<string, unknown> = {
    revenue: revenueUsd(e, i.settings.reporting), currency: "USD", price_in_purchased_currency: e.price_in_purchased_currency ?? null,
    purchased_currency: e.currency ?? null, store: e.store ?? null, product_id: e.product_id ?? null,
    entitlement: e.entitlement_id ?? e.entitlement_ids?.[0] ?? null, entitlements: e.entitlement_ids ?? null,
    purchased_at: secs(e.purchased_at_ms), expires_at: secs(e.expiration_at_ms), period_type: e.period_type ?? null, environment: e.environment ?? null,
    presented_offering_id: e.presented_offering_id ?? null, transaction_id: e.transaction_id ?? null, original_transaction_id: e.original_transaction_id ?? null,
    app_user_id: appUserId, original_app_user_id: e.original_app_user_id ?? null, aliases: e.aliases ?? [], app_id: e.app_id ?? null,
    country_code: e.country_code ?? null, subscriber_attributes: e.subscriber_attributes ?? {},
  };
  if (e.cancel_reason) properties.cancel_reason = e.cancel_reason;
  if (e.expiration_reason) properties.expiration_reason = e.expiration_reason;
  if (e.new_product_id) properties.new_product_id = e.new_product_id;
  if (e.auto_resume_at_ms !== undefined) properties.auto_resumes_at = secs(e.auto_resume_at_ms);
  if (e.is_trial_conversion !== undefined) properties.is_trial_conversion = e.is_trial_conversion;
  const status = subscriptionStatusOf(e);
  const traits: Record<string, unknown> = { last_seen_app_user_id: appUserId, aliases: e.aliases ?? [] };
  if (status) traits.rc_subscription_status = status;
  const headers = { "content-type": "application/json", authorization: basicAuth(key) };
  const id = String(e.id);
  return {
    name,
    requests: [
      { method: "POST", url: `${host}/v1/track`, headers, body: json({ ...who, event: name, properties, context, timestamp, messageId: id }) },
      { method: "POST", url: `${host}/v1/identify`, headers, body: json({ ...who, traits, context, timestamp, messageId: `${id}-identify` }) },
    ],
    redact: [key, btoa(`${key}:`)],
  };
}
