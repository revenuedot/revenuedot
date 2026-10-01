import { DOCS, REPORTING, attr, conceptOf, defaultAnalyticsName, isSandbox, nameFor, platformOf, revenueUsd, secretForms, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";
import { isAnonymous } from "../ids.js";

/**
 * Singular: server-to-server events through the EVENT endpoint
 * (https://support.singular.net/hc/en-us/articles/31496864868635), with the parameters RevenueCat documents for its own
 * Singular delivery (https://www.revenuecat.com/docs/integrations/attribution/reference/singular).
 * V2 (default; required for Singular accounts created from July 15, 2026): `POST https://s2s.singular.net/api/v2/evt`,
 * form-encoded, matched on `sdid`. V1 (legacy accounts): `GET https://s2s.singular.net/api/v1/evt`, matched on the
 * advertising ids. Singular answers `{"status":"ok"}`; anything else is a rejection.
 * Settings: `api_version` (v2 | v1), `reporting`. Secrets: `sdk_key`, `sandbox_sdk_key` (sandbox events are sent only with it).
 * Identity: V2 needs `$singularDeviceId` as `sdid`; V1 needs `$idfa` and `$idfv` on iOS, `$gpsAdId` (aifa) or
 * `$androidId` (andi) on Android. Without them the event is skipped. `$ip` is sent as `ip` (else the country),
 * `$attConsentStatus` as `att_authorization_status` (0–3) on iOS, `$limitDataSharing` as `data_sharing_options`,
 * and the app user id as `custom_user_id` unless it is anonymous.
 * Sent: rc_<step>_event names; `amt` is the USD revenue, negative for refunds (Singular accepts negative revenue).
 */

export const SINGULAR_HOST = "https://s2s.singular.net/api";

export const SINGULAR_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "test",
];

const ATT: Record<string, string> = { notDetermined: "0", restricted: "1", denied: "2", authorized: "3" };

export async function buildSingular(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !SINGULAR_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Singular.`);
  const key = isSandbox(e) ? i.secrets.sandbox_sdk_key : i.secrets.sdk_key;
  if (!key) return skip(isSandbox(e) ? "Sandbox events need a sandbox Singular SDK key." : "No Singular SDK key is saved.");
  const platform = e.store === "AMAZON" ? "android" : platformOf(e.store);
  if (platform !== "ios" && platform !== "android") return skip(`${e.store} purchases are not sent to Singular's app events.`);
  const bundle = i.context?.bundleId;
  if (!bundle) return skip("The app has no bundle ID or package name saved, which Singular needs.");
  const v1 = i.settings.api_version === "v1";
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const p = new URLSearchParams({ a: key, n: name });
  if (!v1) {
    const sdid = attr(e, "$singularDeviceId");
    if (!sdid) return skip("The customer has no $singularDeviceId attribute, so Singular cannot match the event.");
    p.set("sdid", sdid);
  } else if (platform === "ios") {
    const idfa = attr(e, "$idfa"), idfv = attr(e, "$idfv");
    if (!idfa || !idfv) return skip("Singular's V1 endpoint needs both $idfa and $idfv on iOS; the customer is missing one.");
    p.set("idfa", idfa); p.set("idfv", idfv);
  } else {
    const aifa = attr(e, "$gpsAdId"), andi = attr(e, "$androidId");
    if (!aifa && !andi) return skip("Singular's V1 endpoint needs $gpsAdId or $androidId on Android; the customer has neither.");
    if (aifa) p.set("aifa", aifa);
    if (andi) p.set("andi", andi);
  }
  p.set("p", platform === "ios" ? "iOS" : "Android");
  p.set("i", bundle);
  const revenue = revenueUsd(e, i.settings.reporting);
  if (revenue !== 0) { p.set("amt", String(revenue)); p.set("cur", "USD"); }
  p.set("umilisec", String(e.event_timestamp_ms ?? i.now.getTime()));
  if (e.product_id) p.set("purchase_product_id", String(e.product_id));
  if (e.transaction_id) p.set("purchase_transaction_id", String(e.transaction_id));
  const ip = attr(e, "$ip");
  if (ip) p.set("ip", ip);
  else if (e.country_code) p.set("country", String(e.country_code));
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  if (appUserId && !isAnonymous(appUserId)) p.set("custom_user_id", appUserId);
  const att = attr(e, "$attConsentStatus");
  if (platform === "ios" && att && ATT[att]) p.set("att_authorization_status", ATT[att]!);
  const lds = attr(e, "$limitDataSharing");
  if (lds === "true" || lds === "false") p.set("data_sharing_options", JSON.stringify({ limit_data_sharing: lds === "true" }));
  const args: Record<string, unknown> = { rc_app_user_id: appUserId, rc_event_id: String(e.id) };
  if (revenue !== 0) Object.assign(args, { pn: "", pq: 1, pp: revenue, pk: e.product_id ?? "" });
  p.set("e", JSON.stringify(args));
  return {
    name,
    requests: [v1
      ? { method: "GET", url: `${SINGULAR_HOST}/v1/evt?${p.toString()}`, headers: {}, body: "" }
      : { method: "POST", url: `${SINGULAR_HOST}/v2/evt`, headers: { "content-type": "application/x-www-form-urlencoded" }, body: p.toString() }],
    redact: secretForms(key),
  };
}

export const SINGULAR: PartnerDef = {
  spec: {
    kind: "singular", name: "Singular", category: "attribution", environment: "both", eventNames: true, docs: `${DOCS}#singular`, api: "documented",
    text: "Send trials, subscriptions and refunds to Singular to attribute revenue to the campaigns behind each install.",
    fields: [
      { key: "sdk_key", label: "SDK key", type: "secret", required: true, hint: "In Singular, Developer Tools → SDK Keys: the SDK Key." },
      { key: "sandbox_sdk_key", label: "Sandbox SDK key", type: "secret", hint: "Without it sandbox events are not sent." },
      { key: "api_version", label: "Event endpoint", type: "select", options: [{ value: "v2", label: "V2 (matched on the Singular device ID)" }, { value: "v1", label: "V1, legacy (matched on advertising IDs)" }], hint: "Accounts created from July 15, 2026 must use V2." },
      REPORTING,
    ],
  },
  events: SINGULAR_EVENTS,
  build: buildSingular,
  defaultName: defaultAnalyticsName,
  answerError: (body, j) => (j && typeof j === "object" && j.status === "ok" ? null : `Singular rejected the event: ${j?.reason ?? (body ? body.slice(0, 300) : "empty answer")}`),
};
