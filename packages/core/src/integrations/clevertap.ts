import { attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * CleverTap: one `POST /1/upload` per event with the event record and, when the event changes it, a profile record
 * setting `rc_subscription_status` (https://developer.clevertap.com/docs/upload-events-api,
 * https://developer.clevertap.com/docs/upload-user-profiles-api). Headers `X-CleverTap-Account-Id` and
 * `X-CleverTap-Passcode`. Hosts by region (https://developer.clevertap.com/docs/common-api-components): api.clevertap.com
 * (Europe, the default), in1, sg1, us1, aps3 (Indonesia), mec1 (UAE).
 * RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/clevertap
 * Settings: `account_id`, `sandbox_account_id`, `region`, `reporting`. Secrets: `passcode`, `sandbox_passcode` (a
 * second account; sandbox events are sent only with both sandbox values).
 * Identity: the `$clevertapId` attribute (the CleverTap ID) as `objectId` when set, else the app user id as `identity`.
 * Event properties are flat (CleverTap accepts nested values only in Charged items), so entitlement ids are joined with
 * commas. CleverTap documents no idempotency key: a replayed event is recorded again.
 */

export const CLEVERTAP_REGIONS: { value: string; label: string; host: string }[] = [
  { value: "eu", label: "Europe (api.clevertap.com)", host: "https://api.clevertap.com" },
  { value: "in1", label: "India (in1)", host: "https://in1.api.clevertap.com" },
  { value: "sg1", label: "Singapore (sg1)", host: "https://sg1.api.clevertap.com" },
  { value: "us1", label: "United States (us1)", host: "https://us1.api.clevertap.com" },
  { value: "aps3", label: "Indonesia (aps3)", host: "https://aps3.api.clevertap.com" },
  { value: "mec1", label: "Middle East, UAE (mec1)", host: "https://mec1.api.clevertap.com" },
];

export const CLEVERTAP_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "expiration", "billing_issue", "product_change", "test",
];

const secs = (ms: unknown) => (typeof ms === "number" ? Math.floor(ms / 1000) : null);
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

export async function buildCleverTap(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const sb = isSandbox(e);
  const account = String((sb ? i.settings.sandbox_account_id : i.settings.account_id) ?? "").trim();
  const passcode = sb ? i.secrets.sandbox_passcode : i.secrets.passcode;
  if (!account || !passcode) return skip(sb ? "Sandbox events need a sandbox account ID and passcode (a second CleverTap account)." : "No CleverTap account ID and passcode are saved.");
  const c = conceptOf(e);
  if (!c || !CLEVERTAP_EVENTS.includes(c)) return skip(`${e.type} events are not sent to CleverTap.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const host = (CLEVERTAP_REGIONS.find((r) => r.value === i.settings.region) ?? CLEVERTAP_REGIONS[0]!).host;
  const ctId = attr(e, "$clevertapId")?.trim();
  const who = ctId ? { objectId: ctId } : { identity: String(e.app_user_id ?? e.original_app_user_id) };
  const ts = secs(e.event_timestamp_ms ?? i.now.getTime());
  const evtData = compact({
    product_id: e.product_id, store: e.store, environment: e.environment, period_type: e.period_type,
    entitlement_ids: Array.isArray(e.entitlement_ids) ? e.entitlement_ids.join(",") : null, presented_offering_id: e.presented_offering_id,
    transaction_id: e.transaction_id, original_transaction_id: e.original_transaction_id, app_user_id: e.app_user_id, original_app_user_id: e.original_app_user_id,
    country_code: e.country_code, revenue: revenueUsd(e, i.settings.reporting), currency: "USD", price_in_purchased_currency: e.price_in_purchased_currency,
    purchased_currency: e.currency, purchased_at: secs(e.purchased_at_ms), expiration_at: secs(e.expiration_at_ms), event_id: e.id,
    cancel_reason: e.cancel_reason, expiration_reason: e.expiration_reason, new_product_id: e.new_product_id, is_trial_conversion: e.is_trial_conversion, offer_code: e.offer_code,
  });
  const d: Record<string, unknown>[] = [{ ...who, ts, type: "event", evtName: name, evtData }];
  const status = subscriptionStatusOf(e);
  if (status) d.push({ ...who, ts, type: "profile", profileData: { rc_subscription_status: status } });
  return {
    name,
    requests: [{
      method: "POST", url: `${host}/1/upload`,
      headers: { "content-type": "application/json; charset=utf-8", "x-clevertap-account-id": account, "x-clevertap-passcode": passcode },
      body: json({ d }),
    }],
    redact: [passcode],
  };
}

/** CleverTap answers 200 with `status: "partial"` or `"fail"` and the rejected records in `unprocessed`. */
export function cleverTapAnswerError(_body: string, j: any): string | null {
  if (!j || typeof j !== "object" || j.status === undefined || j.status === "success") return null;
  const u = Array.isArray(j.unprocessed) ? j.unprocessed[0] : null;
  return `CleverTap answered ${j.status}${u ? `: ${u.error ?? JSON.stringify(u).slice(0, 200)}${u.code ? ` (code ${u.code})` : ""}` : j.error ? `: ${j.error}` : ""}`;
}
