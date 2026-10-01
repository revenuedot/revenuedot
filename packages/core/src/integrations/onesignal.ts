import { attr, conceptOf, json, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";
import { isAnonymous } from "../ids.js";

/**
 * OneSignal: the customer's subscription as user tags, through Update user
 * (`PATCH https://api.onesignal.com/apps/{app_id}/users/by/{alias_label}/{alias_id}`,
 * https://documentation.onesignal.com/reference/update-user), `Authorization: Key <App API key>`.
 * RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/onesignal
 * Settings: `app_id`. Secrets: `api_key`. Sandbox events update the same app's tags (`environment: SANDBOX`) when the
 * integration's environment includes sandbox, as RevenueCat does.
 * Identity: the `$onesignalUserId` attribute (the OneSignal ID from the v5 SDKs) as the `onesignal_id` alias, else the
 * app user id as `external_id` (set with `OneSignal.login`). Anonymous app user ids are never external ids, so those
 * events skip. The v4 SDKs' `$onesignalId` is a device (subscription) id in OneSignal's user model, which Update user
 * cannot address, so it is not used.
 * Tags (RevenueCat's names, string values): app_user_id, period_type, purchased_at, expiration_at (epoch seconds), store,
 * environment, last_event_type, product_id, entitlement_ids (comma separated), active_subscription,
 * subscription_status, grace_period_expiration_at. A test event sets only app_user_id, environment and last_event_type.
 * Tags are absolute values, so a retried update is harmless.
 */

export const ONESIGNAL_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "test",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const oneSignalAppIdOk = (v: unknown) => typeof v === "string" && UUID.test(v.trim());

const secs = (ms: unknown) => (typeof ms === "number" ? String(Math.floor(ms / 1000)) : null);

export async function buildOneSignal(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const key = i.secrets.api_key;
  const appId = String(i.settings.app_id ?? "").trim();
  if (!key || !appId) return skip("No OneSignal app ID and API key are saved.");
  const c = conceptOf(e);
  if (!c || !ONESIGNAL_EVENTS.includes(c)) return skip(`${e.type} events are not sent to OneSignal.`);
  const osId = attr(e, "$onesignalUserId")?.trim();
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  if (!osId && (!appUserId || isAnonymous(appUserId))) return skip("Anonymous customers need the $onesignalUserId attribute: OneSignal knows them only by OneSignal ID, or by the external id you log in with.");
  const [label, id] = osId ? ["onesignal_id", osId] : ["external_id", appUserId];
  const lastEvent = c.toUpperCase();
  let tags: Record<string, string>;
  if (c === "test") {
    tags = { app_user_id: appUserId, environment: String(e.environment ?? "PRODUCTION"), last_event_type: lastEvent };
  } else {
    const status = subscriptionStatusOf(e);
    const raw: Record<string, string | null> = {
      app_user_id: appUserId, period_type: e.period_type ?? null, purchased_at: secs(e.purchased_at_ms), expiration_at: secs(e.expiration_at_ms),
      store: e.store ?? null, environment: e.environment ?? null, last_event_type: lastEvent, product_id: e.product_id ?? null,
      entitlement_ids: Array.isArray(e.entitlement_ids) ? e.entitlement_ids.join(",") : null,
      active_subscription: status ? String(!["expired", "expired_promotional", "paused"].includes(status)) : null,
      subscription_status: status, grace_period_expiration_at: secs(e.grace_period_expiration_at_ms),
    };
    tags = Object.fromEntries(Object.entries(raw).filter((x): x is [string, string] => x[1] !== null));
  }
  const method = "PATCH" as const;
  return {
    name: c,
    requests: [{
      method, url: `https://api.onesignal.com/apps/${encodeURIComponent(appId)}/users/by/${label}/${encodeURIComponent(id!)}`,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Key ${key}` },
      body: json({ properties: { tags } }),
    }],
    redact: [key],
  };
}

/** OneSignal reports problems as `{ errors: [...] }`. */
export function oneSignalAnswerError(_body: string, j: any): string | null {
  if (j && typeof j === "object" && Array.isArray(j.errors) && j.errors.length) {
    const first = j.errors[0];
    return `OneSignal answered: ${typeof first === "string" ? first : first?.title ?? first?.code ?? JSON.stringify(first).slice(0, 200)}`;
  }
  return null;
}
