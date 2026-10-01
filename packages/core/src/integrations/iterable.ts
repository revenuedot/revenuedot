import { attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type OutRequest, type Plan } from "./common.js";

/**
 * Iterable: `POST /api/events/track` per event (or `POST /api/commerce/trackPurchase` for positive money events when
 * `track_purchases` is on), then `POST /api/users/update` with `rc_subscription_status`
 * (https://api.iterable.com/api/docs; EU projects on api.eu.iterable.com). Auth: the `Api-Key` header with a server-side key.
 * RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/iterable
 * Settings: `region` (us | eu), `track_purchases`, `reporting`. Secrets: `api_key`, `sandbox_api_key` (Iterable
 * recommends a separate sandbox project; sandbox events are sent only with it).
 * Identity, as RevenueCat: `$email` when set, else `$iterableUserId`, else the app user id as `userId`; Iterable takes
 * one of email or userId per request, never both. `$iterableCampaignId` and `$iterableTemplateId` attribute the event.
 * The event id is Iterable's event (or purchase) `id`, so a retried event updates the same record instead of adding one.
 * Refunds go as events with negative revenue in `dataFields`, never as purchases.
 */

export const ITERABLE_HOSTS = { us: "https://api.iterable.com", eu: "https://api.eu.iterable.com" } as const;

export const ITERABLE_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "test",
];

const MONEY: Concept[] = ["initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"];
const secs = (ms: unknown) => (typeof ms === "number" ? Math.floor(ms / 1000) : null);
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const intAttr = (v: string | null) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

export async function buildIterable(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const key = isSandbox(e) ? i.secrets.sandbox_api_key : i.secrets.api_key;
  if (!key) return skip(isSandbox(e) ? "Sandbox events need a sandbox API key (a separate Iterable project)." : "No Iterable API key is saved.");
  const c = conceptOf(e);
  if (!c || !ITERABLE_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Iterable.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const host = ITERABLE_HOSTS[(i.settings.region as keyof typeof ITERABLE_HOSTS) ?? "us"] ?? ITERABLE_HOSTS.us;
  const email = attr(e, "$email")?.trim() || null;
  const userId = attr(e, "$iterableUserId")?.trim() || String(e.app_user_id ?? e.original_app_user_id);
  const who: Record<string, unknown> = email ? { email } : { userId };
  const attribution = compact({ campaignId: intAttr(attr(e, "$iterableCampaignId")), templateId: intAttr(attr(e, "$iterableTemplateId")) });
  const createdAt = secs(e.event_timestamp_ms ?? i.now.getTime());
  const revenue = revenueUsd(e, i.settings.reporting);
  const dataFields = compact({
    rc_event_name: name, product_id: e.product_id, store: e.store, environment: e.environment, period_type: e.period_type, entitlement_ids: e.entitlement_ids,
    presented_offering_id: e.presented_offering_id, transaction_id: e.transaction_id, original_transaction_id: e.original_transaction_id,
    app_user_id: e.app_user_id, original_app_user_id: e.original_app_user_id, country_code: e.country_code,
    revenue, currency: "USD", price_in_purchased_currency: e.price_in_purchased_currency, purchased_currency: e.currency,
    purchased_at: secs(e.purchased_at_ms), expiration_at: secs(e.expiration_at_ms), cancel_reason: e.cancel_reason, expiration_reason: e.expiration_reason,
    new_product_id: e.new_product_id, is_trial_conversion: e.is_trial_conversion, offer_code: e.offer_code,
  });
  const headers = { "content-type": "application/json", "api-key": key };
  const id = String(e.id);
  const requests: OutRequest[] = [];
  if (i.settings.track_purchases && MONEY.includes(c) && revenue > 0) {
    const product = String(e.product_id ?? "unknown");
    requests.push({
      method: "POST", url: `${host}/api/commerce/trackPurchase`, headers,
      body: json({ id, user: { ...who, ...(email ? {} : { preferUserId: true }) }, items: [{ id: product, sku: product, name: product, price: revenue, quantity: 1 }], total: revenue, createdAt, dataFields, ...attribution }),
    });
  } else {
    requests.push({ method: "POST", url: `${host}/api/events/track`, headers, body: json({ ...who, eventName: name, id, createdAt, dataFields, ...attribution }) });
  }
  const status = subscriptionStatusOf(e);
  if (status) {
    requests.push({ method: "POST", url: `${host}/api/users/update`, headers, body: json({ ...who, dataFields: { rc_subscription_status: status }, ...(email ? {} : { preferUserId: true }) }) });
  }
  return { name, requests, redact: [key] };
}

/** Iterable answers `{ msg, code, params }`; any code other than "Success" is an error. */
export function iterableAnswerError(_body: string, j: any): string | null {
  if (j && typeof j === "object" && typeof j.code === "string" && j.code !== "Success") return `Iterable answered ${j.code}: ${String(j.msg ?? "").slice(0, 200)}`;
  return null;
}
