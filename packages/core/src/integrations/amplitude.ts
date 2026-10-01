import { attr, conceptOf, defaultAnalyticsName, funnelProperties, isSandbox, json, lifecycleProperties, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Amplitude: one event per RevenueDot event through the HTTP V2 API (https://amplitude.com/docs/apis/analytics/http-v2).
 * Secrets: `api_key`, `sandbox_api_key` (sandbox events are sent only with it). Settings: `region` (us | eu), `reporting`.
 * Identity: `$amplitudeUserId` and `$amplitudeDeviceId` attributes when set, else the app user id as `user_id`.
 * `insert_id` is the event id, so Amplitude drops a retried duplicate.
 */

export const AMPLITUDE_URLS = { us: "https://api2.amplitude.com/2/httpapi", eu: "https://api.eu.amplitude.com/2/httpapi" } as const;

export const AMPLITUDE_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "purchase_redeemed",
  "experiment_enrollment", "refund_reversed", "test",
  "funnel_viewed", "funnel_step_completed", "funnel_purchase",
];

const PLATFORMS: Record<string, string> = { APP_STORE: "iOS", MAC_APP_STORE: "macOS", PLAY_STORE: "Android", AMAZON: "Amazon", STRIPE: "Web", RC_BILLING: "Web", PADDLE: "Web" };

export async function buildAmplitude(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const key = isSandbox(e) ? i.secrets.sandbox_api_key : i.secrets.api_key;
  if (!key) return skip(isSandbox(e) ? "Sandbox events need a sandbox API key." : "No Amplitude API key is saved.");
  const c = conceptOf(e);
  if (!c || !AMPLITUDE_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Amplitude.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const userId = attr(e, "$amplitudeUserId"), deviceId = attr(e, "$amplitudeDeviceId");
  const ids: Record<string, string> = userId || deviceId
    ? { ...(userId ? { user_id: userId } : {}), ...(deviceId ? { device_id: deviceId } : {}) }
    : { user_id: String(e.app_user_id ?? e.original_app_user_id) };
  const revenue = revenueUsd(e, i.settings.reporting);
  const status = subscriptionStatusOf(e);
  const event: Record<string, unknown> = {
    ...ids, event_type: name, time: e.event_timestamp_ms ?? i.now.getTime(), insert_id: String(e.id), partner_id: "revenuedot",
    platform: PLATFORMS[e.store as string] ?? undefined, event_properties: { ...lifecycleProperties(e, i.settings.reporting), ...funnelProperties(e) },
  };
  if (["initial_purchase", "trial_converted", "renewal", "non_subscription_purchase", "cancellation", "refund_reversed"].includes(c) && revenue !== 0) {
    Object.assign(event, { revenue, price: revenue, quantity: 1, productId: e.product_id, revenueType: revenue < 0 ? "refund" : c === "renewal" || c === "trial_converted" ? "renewal" : "purchase" });
  }
  if (e.country_code) event.country = e.country_code;
  if (status) event.user_properties = { $set: { rc_subscription_status: status } };
  const body = { api_key: key, events: [event], options: { min_id_length: 1 } };
  const url = AMPLITUDE_URLS[(i.settings.region as keyof typeof AMPLITUDE_URLS) ?? "us"] ?? AMPLITUDE_URLS.us;
  return { name, requests: [{ method: "POST", url, headers: { "content-type": "application/json", accept: "*/*" }, body: json(body) }], redact: [key] };
}
