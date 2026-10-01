import { DOCS, REPORTING, attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, platformOf, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";

/**
 * Kochava: server-to-server post-install events (https://support.kochava.com/server-to-server-integration/post-install-event-setup),
 * `POST https://control.kochava.com/track/json` with `action: event`, the app GUID and the Kochava device id.
 * Kochava answers 200 `{"success":"1"}`; any other `success` is a rejection.
 * Settings: `ios_app_guid`, `android_app_guid`, `sandbox_ios_app_guid`, `sandbox_android_app_guid` (Kochava test apps;
 * sandbox events are sent only to them), `reporting`. No secrets: Kochava's strict-authentication header for this
 * endpoint is not publicly documented, so apps with strict authentication on are not supported.
 * Identity: `$kochavaDeviceId` (required, else the event is skipped), and the platform's device ids, one of which
 * Kochava requires: on iOS `$idfa` or `$idfv`, on Android `$gpsAdId` (adid) or `$androidId`. `$ip` becomes
 * `origination_ip` and `$deviceVersion` `device_ver` (both keys are always sent, empty when unknown, as Kochava asks).
 * Sent: trial starts as Start Trial, purchases, trial conversions and renewals as Subscribe, one-time purchases as
 * Purchase (Kochava standard event names), other steps as rc_<step>_event. `event_data.sum` is the USD revenue,
 * negative for refunds (Kochava accepts negative sums).
 */

export const KOCHAVA_URL = "https://control.kochava.com/track/json";

export const KOCHAVA_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "expiration", "billing_issue", "product_change", "test",
];

export function kochavaName(c: Concept): string | null {
  if (!KOCHAVA_EVENTS.includes(c)) return null;
  if (c === "trial_started") return "Start Trial";
  if (c === "initial_purchase" || c === "trial_converted" || c === "renewal") return "Subscribe";
  if (c === "non_subscription_purchase") return "Purchase";
  return defaultAnalyticsName(c);
}

export async function buildKochava(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !KOCHAVA_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Kochava.`);
  const platform = platformOf(e.store, i.context?.platform);
  if (platform !== "ios" && platform !== "android") return skip(`${e.store} purchases are not sent to Kochava.`);
  const label = platform === "ios" ? "iOS" : "Android";
  const sandbox = isSandbox(e);
  const guid = i.settings[`${sandbox ? "sandbox_" : ""}${platform}_app_guid`] as string | undefined;
  if (!guid) return skip(sandbox ? `Sandbox events need a Kochava test app GUID for ${label}.` : `No Kochava app GUID is saved for ${label}.`);
  const deviceId = attr(e, "$kochavaDeviceId");
  if (!deviceId) return skip("The customer has no $kochavaDeviceId attribute, so Kochava cannot match the event.");
  const ids: Record<string, string> = {};
  const pairs: [string, string][] = platform === "ios" ? [["$idfa", "idfa"], ["$idfv", "idfv"]] : [["$gpsAdId", "adid"], ["$androidId", "android_id"]];
  for (const [a, k] of pairs) { const v = attr(e, a); if (v) ids[k] = v; }
  if (!Object.keys(ids).length) return skip(platform === "ios" ? "The customer has no $idfa or $idfv attribute, which Kochava needs with the device id." : "The customer has no $gpsAdId or $androidId attribute, which Kochava needs with the device id.");
  const name = nameFor(c, kochavaName, i.eventNames)!;
  const eventData: Record<string, unknown> = {
    name: e.product_id ?? null, product_id: e.product_id ?? null, event_id: String(e.id), event_type: e.type, app_user_id: e.app_user_id ?? null,
    original_app_user_id: e.original_app_user_id ?? null, store: e.store ?? null, environment: e.environment ?? null, period_type: e.period_type ?? null,
    transaction_id: e.transaction_id ?? null, original_transaction_id: e.original_transaction_id ?? null,
  };
  const revenue = revenueUsd(e, i.settings.reporting);
  if (revenue !== 0) eventData.sum = revenue;
  if (e.cancel_reason) eventData.cancel_reason = e.cancel_reason;
  if (e.expiration_reason) eventData.expiration_reason = e.expiration_reason;
  if (e.new_product_id) eventData.new_product_id = e.new_product_id;
  const body = {
    action: "event", kochava_app_id: guid, kochava_device_id: deviceId,
    data: {
      event_name: name, device_ids: ids, origination_ip: attr(e, "$ip") ?? "", device_ua: "", device_ver: attr(e, "$deviceVersion") ?? "",
      app_version: i.context?.appVersion ?? "", usertime: Math.floor((e.event_timestamp_ms ?? i.now.getTime()) / 1000), currency: "USD", event_data: eventData,
    },
  };
  return { name, requests: [{ method: "POST", url: KOCHAVA_URL, headers: { "content-type": "application/json" }, body: json(body) }], redact: [] };
}

export const KOCHAVA: PartnerDef = {
  spec: {
    kind: "kochava", name: "Kochava", category: "attribution", environment: "both", eventNames: true, docs: `${DOCS}#kochava`, api: "documented",
    text: "Send trials, subscriptions and refunds to Kochava to attribute revenue to the campaigns behind each install.",
    fields: [
      { key: "ios_app_guid", label: "iOS app GUID", type: "text", placeholder: "kocom-example-ios-abc123", hint: "In Kochava, the app's Edit App page." },
      { key: "android_app_guid", label: "Android app GUID", type: "text", placeholder: "kocom-example-android-abc123" },
      { key: "sandbox_ios_app_guid", label: "iOS test app GUID", type: "text", hint: "A Kochava test app for sandbox events. Without it iOS sandbox events are not sent." },
      { key: "sandbox_android_app_guid", label: "Android test app GUID", type: "text", hint: "Without it Android sandbox events are not sent." },
      REPORTING,
    ],
  },
  events: KOCHAVA_EVENTS,
  build: buildKochava,
  defaultName: kochavaName,
  answerError: (body, j) => (j && typeof j === "object" && "success" in j && String(j.success) !== "1" ? `Kochava rejected the event: ${body.slice(0, 300)}` : null),
  validate: (settings) => (!settings.ios_app_guid && !settings.android_app_guid ? { param: "settings", message: "set the Kochava app GUID for iOS, Android or both." } : null),
};
