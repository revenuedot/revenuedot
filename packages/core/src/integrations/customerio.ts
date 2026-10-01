import { attr, basicAuth, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, platformOf, revenueUsd, sha256Hex, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Customer.io: an identify (`PUT /api/v1/customers/{id}`, which creates the person when missing) then the event
 * (`POST /api/v1/customers/{id}/events`) through the Track API v1 (https://docs.customer.io/integrations/api/track/),
 * on track.customer.io (US) or track-eu.customer.io (EU), Basic auth with `site_id:api_key`.
 * RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/customerio
 * Settings: `site_id`, `sandbox_site_id`, `region` (us | eu), `reporting`. Secrets: `api_key`, `sandbox_api_key`
 * (a second workspace; sandbox events are sent only with both sandbox values).
 * Identity: the `$customerioId` attribute when set, else the app user id, as the person's id. `$email` is set as the
 * person's `email` attribute.
 * Sent: `rc_subscription_status` and `app_user_id` on the person; the `rc_*_event` with the purchase details as event
 * data. The event `id` is a ULID derived from the event id (Customer.io requires a ULID and drops a repeated one), so a
 * retried event is not recorded twice.
 */

export const CUSTOMERIO_HOSTS = { us: "https://track.customer.io", eu: "https://track-eu.customer.io" } as const;

export const CUSTOMERIO_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "test",
];

const secs = (ms: unknown) => (typeof ms === "number" ? Math.floor(ms / 1000) : null);
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID that is the same for the same event: the event time (ms) as the 48-bit time part, then 80 bits of the
 * SHA-256 of the event id.
 */
export async function eventUlid(eventId: string, timeMs: number): Promise<string> {
  const hash = await sha256Hex(eventId);
  let n = (BigInt(Math.max(0, Math.min(Math.floor(timeMs), 2 ** 48 - 1))) << 80n) | BigInt(`0x${hash.slice(0, 20)}`);
  let out = "";
  for (let k = 0; k < 26; k++) { out = CROCKFORD[Number(n & 31n)] + out; n >>= 5n; }
  return out;
}

export async function buildCustomerio(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const sb = isSandbox(e);
  const site = String((sb ? i.settings.sandbox_site_id : i.settings.site_id) ?? "").trim();
  const key = sb ? i.secrets.sandbox_api_key : i.secrets.api_key;
  if (!site || !key) return skip(sb ? "Sandbox events need a sandbox site ID and API key (a second Customer.io workspace)." : "No Customer.io site ID and API key are saved.");
  const c = conceptOf(e);
  if (!c || !CUSTOMERIO_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Customer.io.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const host = CUSTOMERIO_HOSTS[(i.settings.region as keyof typeof CUSTOMERIO_HOSTS) ?? "us"] ?? CUSTOMERIO_HOSTS.us;
  const person = attr(e, "$customerioId")?.trim() || String(e.app_user_id ?? e.original_app_user_id);
  const path = `${host}/api/v1/customers/${encodeURIComponent(person)}`;
  const timeMs = e.event_timestamp_ms ?? i.now.getTime();
  const status = subscriptionStatusOf(e);
  const email = attr(e, "$email")?.trim();
  const identify = compact({ email: email || undefined, app_user_id: e.app_user_id, rc_subscription_status: status });
  const data = compact({
    app_id: e.app_id, app_user_id: e.app_user_id, original_app_user_id: e.original_app_user_id, platform: platformOf(e.store, i.context?.platform), rc_subscription_status: status,
    entitlement_ids: e.entitlement_ids, product_id: e.product_id, currency: "USD", revenue: revenueUsd(e, i.settings.reporting),
    price_in_purchased_currency: e.price_in_purchased_currency, purchased_currency: e.currency,
    purchased_at: secs(e.purchased_at_ms), expiration_at: secs(e.expiration_at_ms), transaction_id: e.transaction_id, original_transaction_id: e.original_transaction_id,
    period_type: e.period_type, store: e.store, environment: e.environment, is_family_share: e.is_family_share, presented_offering_id: e.presented_offering_id,
    country_code: e.country_code, cancel_reason: e.cancel_reason, expiration_reason: e.expiration_reason, new_product_id: e.new_product_id,
    is_trial_conversion: e.is_trial_conversion, offer_code: e.offer_code,
  });
  const headers = { "content-type": "application/json", authorization: basicAuth(site, key) };
  return {
    name,
    requests: [
      { method: "PUT", url: path, headers, body: json(identify) },
      { method: "POST", url: `${path}/events`, headers, body: json({ name, id: await eventUlid(String(e.id), timeMs), timestamp: secs(timeMs), data }) },
    ],
    redact: [key, btoa(`${site}:${key}`)],
  };
}
