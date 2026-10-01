import { attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, platformOf, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type OutRequest, type Plan } from "./common.js";
import { isAnonymous } from "../ids.js";

/**
 * Airship: a custom event through `POST /api/custom-events`
 * (https://www.airship.com/docs/developer/rest-api/ua/operations/custom-events/), and optionally the
 * `rc_subscription_status` attribute on the named user (`POST /api/named_users/{id}/attributes`) or channel
 * (`POST /api/channels/attributes`) (https://www.airship.com/docs/developer/rest-api/ua/operations/named-users/).
 * Hosts: go.urbanairship.com (US cloud site) or go.airship.eu (EU). Auth: `Authorization: Bearer <token>` plus
 * `X-UA-Appkey`, with Airship's versioned Accept header.
 * RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/airship
 * Settings: `app_key`, `sandbox_app_key`, `region` (us | eu), `set_attributes`, `reporting`. Secrets: `token`,
 * `sandbox_token` (a second project; sandbox events are sent only with both sandbox values).
 * Identity: the `$airshipChannelId` attribute as the device's channel (ios_channel, android_channel or amazon_channel by
 * store), else the app user id as the named user. Anonymous app user ids are never named users, so those events skip.
 * Event names are lowercased (Airship rejects uppercase). Airship attributes must be created in the Airship dashboard
 * first, so setting `rc_subscription_status` is opt-in. The event id is the event's `transaction`; Airship documents no
 * deduplication, so a replayed event is recorded again.
 */

export const AIRSHIP_HOSTS = { us: "https://go.urbanairship.com", eu: "https://go.airship.eu" } as const;

export const AIRSHIP_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "test",
];

const MONEY: Concept[] = ["initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"];
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
/** Airship's occurred format: ISO 8601 without a zone (UTC). */
const occurred = (ms: number) => new Date(ms).toISOString().slice(0, 19);

function channelKey(store: unknown): string {
  if (store === "AMAZON") return "amazon_channel";
  const p = platformOf(store);
  return p === "ios" ? "ios_channel" : p === "android" ? "android_channel" : "channel";
}

export async function buildAirship(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const sb = isSandbox(e);
  const appKey = String((sb ? i.settings.sandbox_app_key : i.settings.app_key) ?? "").trim();
  const token = sb ? i.secrets.sandbox_token : i.secrets.token;
  if (!appKey || !token) return skip(sb ? "Sandbox events need a sandbox app key and token (a second Airship project)." : "No Airship app key and token are saved.");
  const c = conceptOf(e);
  if (!c || !AIRSHIP_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Airship.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!.toLowerCase();
  const channel = attr(e, "$airshipChannelId")?.trim();
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  if (!channel && (!appUserId || isAnonymous(appUserId))) return skip("Anonymous customers need the $airshipChannelId attribute: Airship knows them only by channel, or by a named user that matches the app user id.");
  const user = channel ? { [channelKey(e.store)]: channel } : { named_user_id: appUserId };
  const host = AIRSHIP_HOSTS[(i.settings.region as keyof typeof AIRSHIP_HOSTS) ?? "us"] ?? AIRSHIP_HOSTS.us;
  const headers = { "content-type": "application/json", accept: "application/vnd.urbanairship+json; version=3", authorization: `Bearer ${token}`, "x-ua-appkey": appKey };
  const timeMs = e.event_timestamp_ms ?? i.now.getTime();
  const revenue = revenueUsd(e, i.settings.reporting);
  const properties = compact({
    product_id: e.product_id, store: e.store, environment: e.environment, period_type: e.period_type, entitlement_ids: e.entitlement_ids,
    presented_offering_id: e.presented_offering_id, transaction_id: e.transaction_id, original_transaction_id: e.original_transaction_id,
    app_user_id: e.app_user_id, original_app_user_id: e.original_app_user_id, country_code: e.country_code,
    revenue, currency: "USD", price_in_purchased_currency: e.price_in_purchased_currency, purchased_currency: e.currency,
    purchased_at: e.purchased_at_ms ? occurred(e.purchased_at_ms) : null, expiration_at: e.expiration_at_ms ? occurred(e.expiration_at_ms) : null,
    cancel_reason: e.cancel_reason, expiration_reason: e.expiration_reason, new_product_id: e.new_product_id, is_trial_conversion: e.is_trial_conversion, offer_code: e.offer_code,
  });
  const body = compact({ name, value: MONEY.includes(c) && revenue > 0 ? revenue : undefined, transaction: String(e.id), properties });
  const requests: OutRequest[] = [{ method: "POST", url: `${host}/api/custom-events`, headers, body: json([{ occurred: occurred(timeMs), user, body }]) }];
  const status = subscriptionStatusOf(e);
  if (i.settings.set_attributes && status) {
    const attributes = [{ action: "set", key: "rc_subscription_status", value: status, timestamp: occurred(timeMs).replace("T", " ") }];
    requests.push(channel
      ? { method: "POST", url: `${host}/api/channels/attributes`, headers, body: json({ audience: { [channelKey(e.store)]: channel }, attributes }) }
      : { method: "POST", url: `${host}/api/named_users/${encodeURIComponent(appUserId)}/attributes`, headers, body: json({ attributes }) });
  }
  return { name, requests, redact: [token] };
}

/** Airship answers `{ ok: false, error }` for a rejected request. */
export function airshipAnswerError(_body: string, j: any): string | null {
  return j && typeof j === "object" && j.ok === false ? `Airship answered: ${String(j.error ?? JSON.stringify(j)).slice(0, 200)}` : null;
}
