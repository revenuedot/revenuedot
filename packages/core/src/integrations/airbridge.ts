import { DOCS, REPORTING, attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, platformOf, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";

/**
 * Airbridge: in-app events through the Server To Server Event API
 * (https://help.airbridge.io/en/references/s2s-event/send-in-app-events), `POST
 * https://api.airbridge.io/events/v2/apps/{app_name}/mobile-app/9360` with `Authorization: Bearer {API token}`.
 * Airbridge drops events whose timestamp is more than 24 hours old, so older events (replays) are skipped with that reason.
 * Settings: `app_name` (the workspace's app subdomain), `sandbox_app_name` (a second Airbridge app for sandbox events;
 * sandbox events are sent only to it), `reporting`. Secrets: `api_token`, `sandbox_api_token` (defaults to `api_token`).
 * Identity: the app user id as `user.externalUserID` (always; Airbridge matches on it when the SDK sets the same user
 * id), `$email`, and `$airbridgeDeviceId` as `device.deviceUUID` with `$idfa` (ifa), `$idfv` (ifv), `$gpsAdId` (gaid),
 * `$attConsentStatus` and the OS name and version. Airbridge needs the OS version with a deviceUUID, so the device id
 * is sent only when the customer's last request reported one. `$ip` goes in `X-Forwarded-For`, as Airbridge asks.
 * Sent: trial starts as airbridge.startTrial, purchases, trial conversions and renewals as airbridge.subscribe
 * (`isRenewal`), one-time purchases as airbridge.ecommerce.order.completed, cancellations as airbridge.unsubscribe
 * (Airbridge standard events), other steps as rc_<step>_event. `value` and `totalValue` are the USD revenue; Airbridge
 * takes no negative value, so refunds carry none. `eventUUID` is the event id, so Airbridge drops a retried duplicate.
 */

export const AIRBRIDGE_API = "https://api.airbridge.io/events/v2/apps";

export const AIRBRIDGE_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation",
  "non_subscription_purchase", "expiration", "billing_issue", "product_change", "test",
];

export function airbridgeName(c: Concept): string | null {
  if (!AIRBRIDGE_EVENTS.includes(c)) return null;
  if (c === "trial_started") return "airbridge.startTrial";
  if (c === "initial_purchase" || c === "trial_converted" || c === "renewal") return "airbridge.subscribe";
  if (c === "non_subscription_purchase") return "airbridge.ecommerce.order.completed";
  if (c === "cancellation" || c === "trial_cancelled") return "airbridge.unsubscribe";
  return defaultAnalyticsName(c);
}

const ATT: Record<string, number> = { notDetermined: 0, restricted: 1, denied: 2, authorized: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildAirbridge(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !AIRBRIDGE_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Airbridge.`);
  const sandbox = isSandbox(e);
  const app = (sandbox ? i.settings.sandbox_app_name : i.settings.app_name) as string | undefined;
  const token = sandbox ? i.secrets.sandbox_api_token || i.secrets.api_token : i.secrets.api_token;
  if (!app || !token) return skip(sandbox ? "Sandbox events need a sandbox Airbridge app name." : "No Airbridge app name and API token are saved.");
  const platform = platformOf(e.store);
  if (platform !== "ios" && platform !== "android") return skip(`${e.store} purchases are not sent to Airbridge's app events.`);
  const packageName = i.context?.bundleId;
  if (!packageName) return skip("The app has no bundle ID or package name saved, which Airbridge needs.");
  const ts = e.event_timestamp_ms ?? i.now.getTime();
  if (i.now.getTime() - ts > DAY_MS) return skip("Airbridge drops events more than 24 hours old, so this event is not sent.");
  const name = nameFor(c, airbridgeName, i.eventNames)!;
  const user: Record<string, unknown> = { externalUserID: String(e.app_user_id ?? e.original_app_user_id ?? "") };
  const email = attr(e, "$email");
  if (email) user.externalUserEmail = email.trim();
  const device: Record<string, unknown> = { osName: platform === "ios" ? "iOS" : "Android" };
  const osVersion = i.context?.platformVersion;
  if (osVersion) device.osVersion = osVersion;
  const deviceUUID = attr(e, "$airbridgeDeviceId");
  if (deviceUUID && osVersion) device.deviceUUID = deviceUUID;
  const ids: [string, string][] = platform === "ios" ? [["$idfa", "ifa"], ["$idfv", "ifv"]] : [["$gpsAdId", "gaid"]];
  for (const [a, k] of ids) { const v = attr(e, a); if (v) device[k] = v; }
  const att = attr(e, "$attConsentStatus");
  if (platform === "ios" && att && att in ATT) device.appTrackingTransparency = ATT[att];
  const revenue = revenueUsd(e, i.settings.reporting);
  const semantic: Record<string, unknown> = { currency: "USD", transactionID: String(e.transaction_id ?? e.id) };
  if (c === "renewal" || c === "trial_converted" || c === "initial_purchase") semantic.isRenewal = c === "renewal";
  if (revenue > 0) {
    semantic.totalValue = revenue;
    semantic.products = [{ productID: e.product_id, name: e.product_id, price: revenue, currency: "USD", quantity: 1 }];
  }
  const customAttributes: Record<string, unknown> = {
    event_id: String(e.id), event_type: e.type, product_id: e.product_id ?? null, store: e.store ?? null, environment: e.environment ?? null,
    period_type: e.period_type ?? null, original_transaction_id: e.original_transaction_id ?? null,
  };
  if (e.cancel_reason) customAttributes.cancel_reason = e.cancel_reason;
  if (e.expiration_reason) customAttributes.expiration_reason = e.expiration_reason;
  const goal: Record<string, unknown> = { category: name, semanticAttributes: semantic, customAttributes };
  if (revenue > 0) goal.value = revenue;
  const body: Record<string, unknown> = {
    eventTimestamp: ts, user, device, app: { packageName, ...(i.context?.appVersion ? { version: i.context.appVersion } : {}) }, eventData: { goal },
  };
  if (UUID.test(String(e.id))) body.eventUUID = String(e.id).toLowerCase();
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const ip = attr(e, "$ip");
  if (ip) headers["x-forwarded-for"] = ip;
  return { name, requests: [{ method: "POST", url: `${AIRBRIDGE_API}/${encodeURIComponent(app)}/mobile-app/9360`, headers, body: json(body) }], redact: [token] };
}

export const AIRBRIDGE: PartnerDef = {
  spec: {
    kind: "airbridge", name: "Airbridge", category: "attribution", environment: "both", eventNames: true, docs: `${DOCS}#airbridge`, api: "documented",
    text: "Send trials and subscriptions to Airbridge to attribute revenue to the campaigns behind each install.",
    fields: [
      { key: "app_name", label: "App name", type: "text", required: true, placeholder: "testapp", hint: "The app's subdomain, exactly as it appears in your Airbridge workspace." },
      { key: "api_token", label: "API token", type: "secret", required: true, hint: "In Airbridge, Settings → Tokens: the API token for server-to-server events." },
      { key: "sandbox_app_name", label: "Sandbox app name", type: "text", hint: "A second Airbridge app for sandbox events. Without it sandbox events are not sent." },
      { key: "sandbox_api_token", label: "Sandbox API token", type: "secret", hint: "Only if the sandbox app has its own token." },
      REPORTING,
    ],
  },
  events: AIRBRIDGE_EVENTS,
  build: buildAirbridge,
  defaultName: airbridgeName,
  answerError: (_body, j) => (j && typeof j === "object" && j.error ? `Airbridge rejected the event: ${j.error}` : null),
  validate: (settings) => {
    for (const k of ["app_name", "sandbox_app_name"]) {
      const v = settings[k];
      if (typeof v === "string" && v && !/^[a-z0-9-]+$/i.test(v)) return { param: `settings.${k}`, message: "must be the Airbridge app name (letters, digits and dashes), not a URL." };
    }
    return null;
  },
};
