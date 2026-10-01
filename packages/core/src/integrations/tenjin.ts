import { DOCS, REPORTING, attr, basicAuth, conceptOf, defaultAnalyticsName, isSandbox, nameFor, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";
import { isAnonymous } from "../ids.js";

/**
 * Tenjin: server-to-server events (https://tenjin.com/docs/server-to-server-s2s-setup/). Purchases go to
 * `POST https://track.tenjin.com/v0/purchase`, other steps to `POST https://track.tenjin.com/v0/event`, form-encoded,
 * with Basic auth (the app's SDK key as the user name, empty password). Tenjin answers `{"code":200}` when it accepted.
 * Secrets: `ios_sdk_key`, `android_sdk_key` (Tenjin, Configure → Apps → the app → SDK key). Settings: `reporting`.
 * Identity: `$tenjinId` (the Tenjin SDK's analytics_installation_id) is required, else the event is skipped; advertising
 * id `$idfa` (iOS) or `$gpsAdId` (Android), sent as zeros when unknown as Tenjin asks for opted-out devices; `$idfv` as
 * `developer_device_id` on iOS; `$ip`, `$attConsentStatus` (tracking_status 0–3), the OS and app version from the
 * customer's last request, and the app user id as `customer_user_id` unless it is anonymous.
 * Sent: purchases, trial conversions, renewals and one-time purchases as purchases (price in USD, quantity 1; `postcut`
 * when reporting proceeds); other steps as events named rc_<step>_event. Tenjin takes no negative revenue, so refunds
 * are sent as an event, without money.
 * Sandbox: Tenjin keeps no sandbox data apart, so sandbox events are skipped.
 */

export const TENJIN_HOST = "https://track.tenjin.com/v0";

export const TENJIN_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation",
  "non_subscription_purchase", "expiration", "billing_issue", "product_change", "test",
];

/** Steps sent to the purchase endpoint, which takes no event name. */
const PURCHASES: Concept[] = ["initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"];

export const tenjinName = (c: Concept): string | null => (!TENJIN_EVENTS.includes(c) || PURCHASES.includes(c) ? null : defaultAnalyticsName(c));

const ATT: Record<string, string> = { notDetermined: "0", restricted: "1", denied: "2", authorized: "3" };
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

export async function buildTenjin(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !TENJIN_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Tenjin.`);
  if (isSandbox(e)) return skip("Tenjin keeps no sandbox data apart, so sandbox events are not sent.");
  const platform = e.store === "APP_STORE" || e.store === "MAC_APP_STORE" ? "ios" : e.store === "PLAY_STORE" ? "android" : e.store === "AMAZON" ? "amazon" : null;
  if (!platform) return skip(`${e.store} purchases are not sent to Tenjin.`);
  const key = platform === "ios" ? i.secrets.ios_sdk_key : i.secrets.android_sdk_key;
  if (!key) return skip(`No Tenjin SDK key is saved for ${platform === "ios" ? "iOS" : "Android"}.`);
  const aiid = attr(e, "$tenjinId");
  if (!aiid) return skip("The customer has no $tenjinId attribute (the Tenjin SDK's analytics installation id), so Tenjin cannot attribute the event.");
  const bundle = i.context?.bundleId;
  if (!bundle) return skip("The app has no bundle ID or package name saved, which Tenjin needs.");
  const revenue = revenueUsd(e, i.settings.reporting);
  const purchase = PURCHASES.includes(c) && revenue > 0;
  const p = new URLSearchParams({
    bundle_id: bundle, platform, os_version: i.context?.platformVersion ?? "", sdk_version: "server", analytics_installation_id: aiid,
    advertising_id: attr(e, platform === "ios" ? "$idfa" : "$gpsAdId") ?? ZERO_ID,
  });
  if (platform === "ios") {
    const idfv = attr(e, "$idfv");
    if (idfv) p.set("developer_device_id", idfv);
    const att = attr(e, "$attConsentStatus");
    if (att && ATT[att]) { p.set("tracking_status", ATT[att]!); p.set("limit_ad_tracking", att === "authorized" ? "0" : "1"); }
  }
  if (i.context?.appVersion) p.set("app_version", i.context.appVersion);
  const ip = attr(e, "$ip");
  if (ip) p.set("ip_address", ip);
  if (e.country_code) p.set("country", String(e.country_code));
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  if (appUserId && !isAnonymous(appUserId)) p.set("customer_user_id", appUserId);
  let name: string;
  if (purchase) {
    name = "purchase";
    p.set("product_id", String(e.product_id ?? "")); p.set("price", String(revenue)); p.set("quantity", "1"); p.set("currency", "USD");
    if (i.settings.reporting === "proceeds") p.set("postcut", "1");
  } else {
    name = nameFor(c, (x) => tenjinName(x) ?? defaultAnalyticsName(x), i.eventNames)!;
    p.set("event", name);
  }
  const headers = { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth(key) };
  return { name, requests: [{ method: "POST", url: `${TENJIN_HOST}/${purchase ? "purchase" : "event"}`, headers, body: p.toString() }], redact: [key, btoa(`${key}:`)] };
}

export const TENJIN: PartnerDef = {
  spec: {
    kind: "tenjin", name: "Tenjin", category: "attribution", environment: "production", eventNames: true, docs: `${DOCS}#tenjin`, api: "documented",
    text: "Send subscription purchases and renewals to Tenjin to see revenue by campaign next to your ad spend.",
    fields: [
      { key: "ios_sdk_key", label: "iOS SDK key", type: "secret", hint: "In Tenjin, Configure → Apps → the iOS app → SDK key." },
      { key: "android_sdk_key", label: "Android SDK key", type: "secret", hint: "The Android app's SDK key. Amazon purchases use it too." },
      REPORTING,
    ],
  },
  events: TENJIN_EVENTS,
  build: buildTenjin,
  defaultName: tenjinName,
  answerError: (body, j) => (j && typeof j === "object" && (("code" in j && Number(j.code) !== 200) || j.error) ? `Tenjin rejected the event: ${body.slice(0, 300)}` : null),
  validate: (_settings, secrets) => (!secrets.ios_sdk_key && !secrets.android_sdk_key ? { param: "settings", message: "set the Tenjin SDK key for iOS, Android or both." } : null),
};
