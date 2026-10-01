import { FUNNEL_CONCEPTS, attr, conceptOf, defaultAnalyticsName, funnelAdContext, isFunnelConcept, isSandbox, json, nameFor, platformOf, revenueUsd, skip, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * AppsFlyer: server-to-server in-app events (https://dev.appsflyer.com/hc/reference/s2s-events-api3-post).
 * Needs the `$appsflyerId` attribute (set by the app with the AppsFlyer SDK's id); without it the event is skipped.
 * Settings: `ios_app_id` (id123456789), `android_app_id` (package name), `s2s_token` (true when the key is an S2S token,
 * which uses api3), `reporting`. Secrets: `dev_key`, `sandbox_dev_key` (sandbox events are sent only with it).
 * Device ids from attributes: `$idfa`, `$idfv`, `$gpsAdId`, `$amazonAdId`, `$ip`; `$appsflyerSharingFilter` becomes
 * `sharing_filter`. Revenue is USD and negative for refunds (AppsFlyer accepts negative revenue).
 */

export const APPSFLYER_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation",
  "non_subscription_purchase", "expiration", "billing_issue", "product_change", "refund_reversed", "test", ...FUNNEL_CONCEPTS,
];

/** AppsFlyer's Web S2S API (the request RevenueCat publishes for its own web events: https://www.revenuecat.com/docs/integrations/attribution/reference/appsflyer). */
export const APPSFLYER_WEB_S2S = "https://events.appsflyer.com/v2.0/s2s/inapps/app/web";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** AppsFlyer's eventTime: "yyyy-MM-dd HH:mm:ss.SSS" in UTC. */
export const appsflyerTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
};

export async function buildAppsFlyer(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !APPSFLYER_EVENTS.includes(c)) return skip(`${e.type} events are not sent to AppsFlyer.`);
  if (isFunnelConcept(c)) return buildAppsFlyerWeb(i, c);
  const key = isSandbox(e) ? i.secrets.sandbox_dev_key : i.secrets.dev_key;
  if (!key) return skip(isSandbox(e) ? "Sandbox events need a sandbox developer key." : "No AppsFlyer developer key is saved.");
  const platform = platformOf(e.store, i.context?.platform);
  const appId = platform === "android" ? i.settings.android_app_id : platform === "ios" ? i.settings.ios_app_id : null;
  if (!appId) return skip(platform === "ios" || platform === "android" ? `No AppsFlyer app ID is saved for ${platform === "ios" ? "iOS" : "Android"}.` : `${e.store} purchases are not sent to AppsFlyer's mobile API.`);
  const afId = attr(e, "$appsflyerId");
  if (!afId) return skip("The customer has no $appsflyerId attribute, so AppsFlyer cannot attribute the event.");
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const revenue = revenueUsd(e, i.settings.reporting);
  const price = typeof e.price === "number" ? Math.abs(e.price) : 0;
  const eventValue = { af_revenue: String(revenue), af_price: price, renewal: String(c === "renewal" || c === "trial_converted"), af_content_id: e.product_id ?? null, af_currency: "USD" };
  const body: Record<string, unknown> = {
    appsflyer_id: afId, customer_user_id: String(e.app_user_id ?? e.original_app_user_id), eventName: name, eventValue: JSON.stringify(eventValue),
    eventCurrency: "USD", eventTime: appsflyerTime(e.event_timestamp_ms ?? i.now.getTime()), af_events_api: "true",
  };
  const ids: [string, string][] = [["$idfa", "idfa"], ["$idfv", "idfv"], ["$gpsAdId", "advertising_id"], ["$amazonAdId", "amazon_aid"], ["$ip", "ip"]];
  for (const [a, k] of ids) { const v = attr(e, a); if (v) body[k] = v; }
  if (i.context?.bundleId) body.bundleIdentifier = i.context.bundleId;
  const filter = attr(e, "$appsflyerSharingFilter");
  if (filter) {
    if (filter === "all") body.sharing_filter = "all";
    else {
      let list: string[];
      try { const p = JSON.parse(filter); list = Array.isArray(p) ? p.map(String) : [String(p)]; } catch { list = filter.split(",").map((s) => s.trim()).filter(Boolean); }
      body.sharing_filter = list.slice(0, 50);
    }
  }
  const host = i.settings.s2s_token ? "https://api3.appsflyer.com" : "https://api2.appsflyer.com";
  return {
    name,
    requests: [{ method: "POST", url: `${host}/inappevent/${encodeURIComponent(appId)}`, headers: { "content-type": "application/json", authentication: key }, body: json(body) }],
    redact: [key],
  };
}

/**
 * Web funnel events (opt-in) through AppsFlyer's Web S2S API: `POST https://events.appsflyer.com/v2.0/s2s/inapps/app/web/{web app id}`
 * with `Authorization: Bearer <Web S2S token>`; the visitor is `user_id.customer_user_id` (the anonymous app user id the
 * purchase is made under, which your AppsFlyer web SDK should set as its customer user id). Names are rd_funnel_*; the
 * purchase carries `event_revenue` in USD; `event_value` has the funnel, step, utm_* and ad click ids.
 * Settings: `web_app_id`; secret: `web_s2s_token`. Sandbox funnel events are not sent (AppsFlyer has no web sandbox).
 */
async function buildAppsFlyerWeb(i: BuildInput, c: Concept): Promise<Plan> {
  const e = i.event;
  if (isSandbox(e)) return skip("Sandbox funnel events are not sent to AppsFlyer, which has no web sandbox.");
  const app = typeof i.settings.web_app_id === "string" ? i.settings.web_app_id.trim() : "";
  const token = i.secrets.web_s2s_token;
  if (!app || !token) return skip("Funnel events need the AppsFlyer web app ID and Web S2S token.");
  const ctx = funnelAdContext(e);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const value: Record<string, unknown> = { event_id: e.id, funnel_id: e.funnel_id ?? null, funnel_name: e.funnel_name ?? null, step_id: e.step_id ?? null, step_type: e.step_type ?? null, product_id: e.product_id ?? null, ...ctx.utm, ...ctx.clickIds };
  const body: Record<string, unknown> = { event_name: name, event_value: value, user_id: { customer_user_id: String(e.app_user_id ?? "") } };
  if (c === "funnel_purchase" && ctx.revenue > 0) Object.assign(body, { event_revenue: ctx.revenue, event_revenue_currency: "USD" });
  return {
    name,
    requests: [{ method: "POST", url: `${APPSFLYER_WEB_S2S}/${encodeURIComponent(app)}`, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: json(body) }],
    redact: [token],
  };
}
