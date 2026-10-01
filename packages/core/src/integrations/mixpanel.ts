import { attr, basicAuth, type OutRequest, conceptOf, funnelProperties, defaultAnalyticsName, isSandbox, json, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Mixpanel: the event through the Ingestion API, then a profile update with `rc_subscription_status` and, for money,
 * an entry in the reserved `$transactions` list (https://developer.mixpanel.com/reference/ingestion-api).
 * Secrets: `project_token`, `sandbox_project_token` (sandbox events go only to a sandbox project), and optionally
 * `api_secret`: with it events go to `/import` (any age, strict validation); without it to `/track` (last 5 days only).
 * Settings: `region` (us | eu | in), `reporting`. Identity: `$mixpanelDistinctId` when set, else the app user id.
 * `$insert_id` is derived from the event id, so a retried event is deduplicated.
 */

export const MIXPANEL_HOSTS = { us: "https://api.mixpanel.com", eu: "https://api-eu.mixpanel.com", in: "https://api-in.mixpanel.com" } as const;

export const MIXPANEL_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "purchase_redeemed", "refund_reversed", "test",
  "funnel_viewed", "funnel_step_completed", "funnel_purchase",
];

/** Mixpanel's $insert_id allows 36 alphanumeric characters or dashes. */
const insertId = (id: string) => id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 36);

export async function buildMixpanel(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const token = isSandbox(e) ? i.secrets.sandbox_project_token : i.secrets.project_token;
  if (!token) return skip(isSandbox(e) ? "Sandbox events need a sandbox project token." : "No Mixpanel project token is saved.");
  const c = conceptOf(e);
  if (!c || !MIXPANEL_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Mixpanel.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const host = MIXPANEL_HOSTS[(i.settings.region as keyof typeof MIXPANEL_HOSTS) ?? "us"] ?? MIXPANEL_HOSTS.us;
  const distinctId = attr(e, "$mixpanelDistinctId") ?? String(e.app_user_id ?? e.original_app_user_id);
  const revenue = revenueUsd(e, i.settings.reporting);
  const timeMs = e.event_timestamp_ms ?? i.now.getTime();
  const secret = i.secrets.api_secret;
  const properties: Record<string, unknown> = {
    token, distinct_id: distinctId, time: secret ? timeMs : Math.floor(timeMs / 1000), $insert_id: insertId(String(e.id)),
    revenue, currency: "USD", product_id: e.product_id ?? null, store: e.store ?? null, offer_code: e.offer_code ?? null,
    period_type: e.period_type ?? null, environment: e.environment ?? null, entitlement_ids: e.entitlement_ids ?? null,
    presented_offering_id: e.presented_offering_id ?? null, transaction_id: e.transaction_id ?? null, original_transaction_id: e.original_transaction_id ?? null,
    app_user_id: e.app_user_id ?? null, original_app_user_id: e.original_app_user_id ?? null, app_id: e.app_id ?? null,
    $country_code: e.country_code ?? undefined, price_in_purchased_currency: e.price_in_purchased_currency ?? null, purchased_currency: e.currency ?? null,
  };
  if (e.cancel_reason) properties.cancel_reason = e.cancel_reason;
  if (e.expiration_reason) properties.expiration_reason = e.expiration_reason;
  if (e.new_product_id) properties.new_product_id = e.new_product_id;
  if (e.is_trial_conversion !== undefined) properties.is_trial_conversion = e.is_trial_conversion;
  Object.assign(properties, funnelProperties(e));
  const track: OutRequest = secret
    ? { method: "POST" as const, url: `${host}/import?strict=1`, headers: { "content-type": "application/json", authorization: basicAuth(secret) }, body: json([{ event: name, properties }]) }
    : { method: "POST" as const, url: `${host}/track?verbose=1`, headers: { "content-type": "application/json" }, body: json([{ event: name, properties }]) };
  const profile: Record<string, unknown> = { $token: token, $distinct_id: distinctId, $ignore_time: true };
  const status = subscriptionStatusOf(e);
  const updates: Record<string, unknown>[] = [];
  if (status) updates.push({ ...profile, $set: { rc_subscription_status: status } });
  if (revenue !== 0) {
    updates.push({ ...profile, $append: { $transactions: { $time: new Date(timeMs).toISOString().slice(0, 19), $amount: revenue, product_id: e.product_id ?? null, store: e.store ?? null } } });
  }
  const requests: OutRequest[] = [track];
  if (updates.length) requests.push({ method: "POST", url: `${host}/engage?verbose=1`, headers: { "content-type": "application/json" }, body: json(updates) });
  return { name, requests, redact: [token, ...(secret ? [secret, btoa(`${secret}:`)] : [])] };
}
