import { attr, conceptOf, json, platformOf, revenueLocal, revenueUsd, skip, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Firebase (Google Analytics 4): events through the Measurement Protocol for app streams
 * (https://developers.google.com/analytics/devguides/collection/protocol/ga4). Needs the `$firebaseAppInstanceId`
 * attribute (the app instance id from Firebase Analytics); without it the event is skipped.
 * Settings: `ios_firebase_app_id`, `android_firebase_app_id`, `currency` (usd | local), `reporting`.
 * Secrets: `ios_api_secret`, `android_api_secret` (the stream's Measurement Protocol API secret).
 * Money events are GA's `purchase` (with `is_renewal` and `is_trial_conversion`); the rest are `rc_*` events.
 * Refunds are not sent as purchases (GA4 has no negative purchase); sandbox events carry `environment: SANDBOX`.
 */

export const GA4_COLLECT = "https://www.google-analytics.com/mp/collect";

export const FIREBASE_NAMES: Partial<Record<Concept, string>> = {
  initial_purchase: "purchase", trial_converted: "purchase", renewal: "purchase", non_subscription_purchase: "purchase",
  trial_started: "rc_trial_start", trial_cancelled: "rc_cancellation", cancellation: "rc_cancellation", uncancellation: "rc_uncancellation",
  subscription_paused: "rc_subscription_paused", expiration: "rc_expiration", billing_issue: "rc_billing_issue", product_change: "rc_product_change",
  transfer: "rc_transfer", test: "rc_test",
};

const micros = (ms: unknown) => (typeof ms === "number" ? ms * 1000 : undefined);

export async function buildFirebase(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  const name = c ? FIREBASE_NAMES[c] : undefined;
  if (!c || !name) return skip(`${e.type} events are not sent to Firebase.`);
  const platform = platformOf(e.store, i.context?.platform);
  const p = platform === "android" ? "android" : "ios";
  if (platform !== "ios" && platform !== "android" && e.type !== "TEST") return skip(`${e.store} purchases have no Firebase app stream.`);
  const appId = i.settings[`${p}_firebase_app_id`] as string | undefined;
  const secret = i.secrets[`${p}_api_secret`];
  if (!appId || !secret) return skip(`No Firebase app ID and API secret are saved for ${p === "ios" ? "iOS" : "Android"}.`);
  const instance = attr(e, "$firebaseAppInstanceId");
  if (!instance) return skip("The customer has no $firebaseAppInstanceId attribute, so Google Analytics cannot match the event.");
  const local = i.settings.currency === "local";
  const params: Record<string, unknown> = {
    event_id: String(e.id), product_id: e.product_id ?? undefined, period_type: e.period_type ?? undefined, purchased_at: micros(e.purchased_at_ms),
    expiration_at: micros(e.expiration_at_ms ?? undefined), environment: e.environment ?? undefined, presented_offering_id: e.presented_offering_id ?? "",
    transaction_id: e.transaction_id ?? undefined, original_transaction_id: e.original_transaction_id ?? undefined, affiliation: e.store ?? undefined,
    original_app_user_id: e.original_app_user_id ?? undefined, app_id: e.app_id ?? undefined,
  };
  if (name === "purchase") {
    Object.assign(params, {
      currency: local ? e.currency ?? "USD" : "USD", value: local ? revenueLocal(e, i.settings.reporting) : revenueUsd(e, i.settings.reporting), coupon: e.offer_code ?? "",
      is_trial_conversion: c === "trial_converted", is_renewal: c === "renewal", items: [{ item_id: e.product_id, affiliation: e.store }],
    });
  }
  if (e.cancel_reason) params.cancel_reason = e.cancel_reason;
  if (e.expiration_reason) params.expiration_reason = e.expiration_reason;
  if (e.auto_resume_at_ms !== undefined) params.auto_resumes_at = micros(e.auto_resume_at_ms);
  if (e.new_product_id) params.new_product_id = e.new_product_id;
  if (c === "transfer") { params.transferred_from = (e.transferred_from ?? []).join(","); params.transferred_to = (e.transferred_to ?? []).join(","); }
  const body = {
    app_instance_id: instance, user_id: String(e.app_user_id ?? e.original_app_user_id ?? ""),
    timestamp_micros: micros(e.event_timestamp_ms ?? i.now.getTime()), events: [{ name, params }],
  };
  const url = `${GA4_COLLECT}?firebase_app_id=${encodeURIComponent(appId)}&api_secret=${encodeURIComponent(secret)}`;
  return { name, requests: [{ method: "POST", url, headers: { "content-type": "application/json" }, body: json(body) }], redact: [secret, encodeURIComponent(secret)] };
}
