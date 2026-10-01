import { attr, conceptOf, isSandbox, json, nameFor, platformOf, revenueUsd, sha256Hex, skip, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Meta: app events through the Conversions API (https://developers.facebook.com/docs/marketing-api/conversions-api/app-events).
 * Settings: `dataset_id`, `sandbox_dataset_id`, `send_without_att` (send iOS events without ATT consent), `test_event_code`, `reporting`.
 * Secrets: `access_token`, `sandbox_access_token` (sandbox events are sent only to a sandbox dataset).
 * Sent: trial starts (StartTrial), purchases, trial conversions and renewals (Subscribe), one-time purchases
 * (fb_mobile_purchase). Meta takes no negative revenue, so refunds and other steps are not sent.
 * Matching needs `$fbAnonId` or an advertising id (`$idfa`, `$gpsAdId`, `$amazonAdId`), and on iOS
 * `$attConsentStatus` = authorized unless `send_without_att`. `$email` and `$phoneNumber` are SHA-256 hashed.
 */

export const META_GRAPH = "https://graph.facebook.com/v21.0";

export const META_NAMES: Partial<Record<Concept, string>> = {
  trial_started: "StartTrial", initial_purchase: "Subscribe", trial_converted: "Subscribe", renewal: "Subscribe",
  non_subscription_purchase: "fb_mobile_purchase", test: "Subscribe",
};

const ZERO_ID = /^[0-]+$/;
const validAdId = (v: string | null) => (v && !ZERO_ID.test(v) ? v : null);

export async function buildMeta(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  const name = c ? nameFor(c, (x) => META_NAMES[x] ?? null, i.eventNames) : null;
  if (!c || !name || !(c in META_NAMES)) return skip(`${e.type} events are not sent to Meta.`);
  const sandbox = isSandbox(e);
  const dataset = sandbox ? i.settings.sandbox_dataset_id : i.settings.dataset_id;
  const token = sandbox ? i.secrets.sandbox_access_token : i.secrets.access_token;
  if (!dataset || !token) return skip(sandbox ? "Sandbox events need a sandbox dataset ID and access token." : "No Meta dataset ID and access token are saved.");
  const platform = platformOf(e.store);
  const anon = attr(e, "$fbAnonId");
  const madid = platform === "ios" ? validAdId(attr(e, "$idfa")) : platform === "android" ? validAdId(attr(e, "$gpsAdId")) ?? validAdId(attr(e, "$amazonAdId")) : validAdId(attr(e, "$amazonAdId"));
  if (!anon && !madid) return skip("The customer has no $fbAnonId or advertising id, so Meta cannot match the event.");
  const att = attr(e, "$attConsentStatus");
  const attOk = platform !== "ios" || att === "authorized";
  if (!attOk && !i.settings.send_without_att) return skip("iOS customers need $attConsentStatus = authorized (or turn on sending without ATT consent).");
  const user_data: Record<string, unknown> = { external_id: [await sha256Hex(String(e.app_user_id ?? e.original_app_user_id))] };
  if (madid) user_data.madid = madid;
  if (anon) user_data.anon_id = anon;
  const email = attr(e, "$email");
  if (email) user_data.em = [await sha256Hex(email.trim().toLowerCase())];
  const phone = attr(e, "$phoneNumber");
  if (phone && phone.replace(/\D/g, "")) user_data.ph = [await sha256Hex(phone.replace(/\D/g, ""))];
  const ip = attr(e, "$ip");
  if (ip) user_data.client_ip_address = ip;
  const ctx = i.context ?? {};
  const extinfo = [platform === "android" ? "a2" : "i2", ctx.bundleId ?? "", "", ctx.appVersion ?? "", ctx.platformVersion ?? "", "", ctx.locale ?? "", "", "", 0, 0, "", 0, 0, 0, ""];
  const value = Math.max(0, revenueUsd(e, i.settings.reporting));
  const event: Record<string, unknown> = {
    event_name: name, event_time: Math.floor((e.event_timestamp_ms ?? i.now.getTime()) / 1000), event_id: String(e.id), action_source: "app", user_data,
    custom_data: { currency: "USD", value, order_id: String(e.transaction_id ?? e.id), content_type: "product", content_ids: [e.product_id], contents: [{ id: e.product_id, quantity: 1 }] },
    app_data: { advertiser_tracking_enabled: attOk ? 1 : 0, application_tracking_enabled: 1, extinfo, ...(attr(e, "$idfv") ? { vendor_id: attr(e, "$idfv") } : {}) },
  };
  const body: Record<string, unknown> = { data: [event], access_token: token, partner_agent: "revenuedot" };
  if (i.settings.test_event_code) body.test_event_code = i.settings.test_event_code;
  return { name, requests: [{ method: "POST", url: `${META_GRAPH}/${encodeURIComponent(dataset)}/events`, headers: { "content-type": "application/json" }, body: json(body) }], redact: [token] };
}
