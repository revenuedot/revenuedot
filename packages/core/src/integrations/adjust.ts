import { attr, conceptOf, isSandbox, platformOf, revenueUsd, skip, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Adjust: server-to-server events (https://dev.adjust.com/en/api/s2s-api/events). Adjust identifies events by
 * tokens you create in Adjust, so each lifecycle step needs its token in `event_tokens` (a step without one is skipped).
 * Needs the `$adjustId` attribute (the device's Adjust id); without it the event is skipped.
 * Settings: `ios_app_token`, `android_app_token`, `event_tokens` ({ initial_purchase: "abc123", ... }), `reporting`.
 * Secrets: `oauth_token` (only when S2S authentication is on in Adjust).
 * Revenue is USD; Adjust rejects amounts below 0.001, so trials and refunds are sent without revenue.
 * Sandbox events go to Adjust's sandbox environment (`environment=sandbox`).
 */

export const ADJUST_URL = "https://s2s.adjust.com/event";

export const ADJUST_STEPS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation",
  "non_subscription_purchase", "expiration", "product_change", "test",
];

export async function buildAdjust(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !ADJUST_STEPS.includes(c)) return skip(`${e.type} events are not sent to Adjust.`);
  const tokens = (i.settings.event_tokens ?? {}) as Record<string, string>;
  const eventToken = tokens[c]?.trim();
  if (!eventToken) return skip(`No Adjust event token is set for ${c}.`);
  const platform = platformOf(e.store, i.context?.platform);
  const appToken = platform === "android" ? i.settings.android_app_token : platform === "ios" ? i.settings.ios_app_token : null;
  if (!appToken) return skip(platform === "ios" || platform === "android" ? `No Adjust app token is saved for ${platform === "ios" ? "iOS" : "Android"}.` : `${e.store} purchases are not sent to Adjust.`);
  const adid = attr(e, "$adjustId");
  if (!adid) return skip("The customer has no $adjustId attribute, so Adjust cannot match the event.");
  const p = new URLSearchParams({
    s2s: "1", app_token: appToken, event_token: eventToken, adid,
    created_at_unix: String(Math.floor((e.event_timestamp_ms ?? i.now.getTime()) / 1000)), environment: isSandbox(e) ? "sandbox" : "production",
  });
  const ids: [string, string][] = [["$idfa", "idfa"], ["$idfv", "idfv"], ["$gpsAdId", "gps_adid"], ["$ip", "ip_address"]];
  for (const [a, k] of ids) { const v = attr(e, a); if (v) p.set(k, v); }
  const revenue = revenueUsd(e, i.settings.reporting);
  if (revenue >= 0.001) { p.set("revenue", String(revenue)); p.set("currency", "USD"); }
  p.set("callback_params", JSON.stringify({ app_user_id: String(e.app_user_id ?? e.original_app_user_id), app_id: e.app_id ?? null, product_id: e.product_id ?? null }));
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const oauth = i.secrets.oauth_token;
  if (oauth) headers.authorization = `Bearer ${oauth}`;
  return { name: eventToken, requests: [{ method: "POST", url: ADJUST_URL, headers, body: p.toString() }], redact: oauth ? [oauth] : [] };
}
