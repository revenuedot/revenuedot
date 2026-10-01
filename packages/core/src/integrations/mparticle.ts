import {
  DOCS, REPORTING, attr, basicAuth, conceptOf, isSandbox, json, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type PartnerDef, type Plan,
} from "./common.js";

/**
 * mParticle: one batch per event through the Events API (https://docs.mparticle.com/developers/apis/http/), `POST
 * {pod}/v2/events` with Basic auth (server-to-server feed key and secret). Batch fields per the JSON reference
 * (https://docs.mparticle.com/developers/apis/json-reference/).
 * Settings: `pod` (us1 | us2 | eu1 | au1), `reporting`. Secrets: `api_key`, `api_secret` (a server-to-server feed input).
 * Identity: `$mparticleId` as `mpid` when set (sent as a JSON integer, since mParticle ids are 64-bit), always the app
 * user id as `customer_id`, `$email` as `email`, and `$idfa`, `$idfv`, `$gpsAdId`, `$attConsentStatus`, `$ip` as device info.
 * Sent: money (revenue other than 0) as a `commerce_event` with a `purchase` product action, refunds as a `refund`
 * product action with the amount refunded (mParticle's refund action takes positive amounts); every other step as a
 * `custom_event` of type `transaction`. Revenue is USD. The event name (RevenueCat's mParticle names: initial_purchase,
 * renewal, …) is the custom event name and `revenuecat_event` on commerce events. `source_message_id` is the event id,
 * so mParticle drops a retried duplicate. `rc_subscription_status` is set as a user attribute.
 * Sandbox: sent to the same feed with `environment: development`, which mParticle keeps out of production data.
 */

export const MPARTICLE_HOSTS = {
  us1: "https://s2s.us1.mparticle.com", us2: "https://s2s.us2.mparticle.com", eu1: "https://s2s.eu1.mparticle.com", au1: "https://s2s.au1.mparticle.com",
} as const;

/** RevenueCat's default mParticle event names. */
export const MPARTICLE_NAMES: Partial<Record<Concept, string>> = {
  initial_purchase: "initial_purchase", trial_started: "trial_started", trial_converted: "trial_converted", trial_cancelled: "trial_cancelled",
  renewal: "renewal", cancellation: "cancellation", uncancellation: "uncancellation", non_subscription_purchase: "non_renewing_purchase",
  subscription_paused: "rc_subscription_paused_event", expiration: "expiration", billing_issue: "billing_issue", product_change: "product_change",
  transfer: "rc_transfer_event", test: "rc_test_event",
};
export const MPARTICLE_EVENTS = Object.keys(MPARTICLE_NAMES) as Concept[];

const ATT: Record<string, string> = { authorized: "authorized", denied: "denied", restricted: "restricted", notDetermined: "not_determined" };

export async function buildMParticle(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !MPARTICLE_EVENTS.includes(c)) return skip(`${e.type} events are not sent to mParticle.`);
  const key = i.secrets.api_key, secret = i.secrets.api_secret;
  if (!key || !secret) return skip("No mParticle server-to-server key and secret are saved.");
  const name = nameFor(c, (x) => MPARTICLE_NAMES[x] ?? null, i.eventNames)!;
  const host = MPARTICLE_HOSTS[i.settings.pod as keyof typeof MPARTICLE_HOSTS] ?? MPARTICLE_HOSTS.us1;
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  const revenue = revenueUsd(e, i.settings.reporting);
  const attrs: Record<string, string> = {};
  const put = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== "") attrs[k] = Array.isArray(v) ? v.join(",") : String(v); };
  put("revenuecat_event", name); put("revenuecat_event_type", e.type); put("revenuecat_product_id", e.product_id);
  put("app_user_id", appUserId); put("original_app_user_id", e.original_app_user_id); put("aliases", e.aliases);
  put("store", e.store); put("environment", e.environment); put("period_type", e.period_type); put("entitlement_ids", e.entitlement_ids);
  put("presented_offering_id", e.presented_offering_id); put("transaction_id", e.transaction_id); put("original_transaction_id", e.original_transaction_id);
  put("country_code", e.country_code); put("purchased_currency", e.currency); put("price_in_purchased_currency", e.price_in_purchased_currency);
  put("cancel_reason", e.cancel_reason); put("expiration_reason", e.expiration_reason); put("new_product_id", e.new_product_id);
  if (e.is_trial_conversion !== undefined) put("is_trial_conversion", e.is_trial_conversion);
  const common = { timestamp_unixtime_ms: e.event_timestamp_ms ?? i.now.getTime(), source_message_id: String(e.id), custom_attributes: attrs };
  const event = revenue !== 0
    ? {
      event_type: "commerce_event",
      data: {
        ...common, currency_code: "USD",
        product_action: {
          action: revenue < 0 ? "refund" : "purchase", transaction_id: String(e.transaction_id ?? e.id), total_amount: Math.abs(revenue),
          products: [{ id: e.product_id ?? null, name: e.product_id ?? null, price: Math.abs(revenue), quantity: 1, total_product_amount: Math.abs(revenue) }],
        },
      },
    }
    : { event_type: "custom_event", data: { ...common, event_name: name, custom_event_type: "transaction" } };
  const batch: Record<string, unknown> = { events: [event], environment: isSandbox(e) ? "development" : "production", schema_version: 2, source_request_id: String(e.id) };
  const mpid = attr(e, "$mparticleId");
  const numericMpid = mpid && /^-?\d{1,20}$/.test(mpid.trim()) ? mpid.trim() : null;
  if (numericMpid) batch.mpid = numericMpid;
  const email = attr(e, "$email");
  batch.user_identities = { customer_id: appUserId, ...(email ? { email: email.trim() } : {}) };
  const status = subscriptionStatusOf(e);
  if (status) batch.user_attributes = { rc_subscription_status: status };
  const device: Record<string, string> = {};
  const idfa = attr(e, "$idfa"), idfv = attr(e, "$idfv"), gaid = attr(e, "$gpsAdId"), att = attr(e, "$attConsentStatus");
  if (idfa) device.ios_advertising_id = idfa;
  if (idfv) device.ios_idfv = idfv;
  if (gaid) device.android_advertising_id = gaid;
  if (att && ATT[att]) device.att_authorization_status = ATT[att]!;
  if (Object.keys(device).length) batch.device_info = device;
  const ip = attr(e, "$ip");
  if (ip) batch.ip = ip;
  let body = json(batch);
  // mParticle ids are 64-bit integers, past what a JS number holds exactly: write the digits as a JSON number.
  if (numericMpid) body = body.replace(`"mpid":${JSON.stringify(numericMpid)}`, `"mpid":${numericMpid}`);
  return {
    name,
    requests: [{ method: "POST", url: `${host}/v2/events`, headers: { "content-type": "application/json", authorization: basicAuth(key, secret) }, body }],
    redact: [key, secret, btoa(`${key}:${secret}`)],
  };
}

export const MPARTICLE: PartnerDef = {
  spec: {
    kind: "mparticle", name: "mParticle", category: "analytics", environment: "both", eventNames: true, docs: `${DOCS}#mparticle`, api: "documented",
    text: "Send subscription events and revenue to mParticle, and from there to every tool connected to it.",
    fields: [
      { key: "api_key", label: "Server-to-server key", type: "secret", required: true, hint: "In mParticle, Setup → Inputs → Feeds: add a Custom Feed (server-to-server) and copy its key." },
      { key: "api_secret", label: "Server-to-server secret", type: "secret", required: true, hint: "The same feed's secret." },
      { key: "pod", label: "Data center", type: "select", options: [{ value: "us1", label: "US1" }, { value: "us2", label: "US2" }, { value: "eu1", label: "EU1" }, { value: "au1", label: "AU1" }], hint: "The pod your mParticle workspace runs in. Defaults to US1." },
      REPORTING,
    ],
  },
  events: MPARTICLE_EVENTS,
  build: buildMParticle,
  defaultName: (c) => MPARTICLE_NAMES[c] ?? null,
};
