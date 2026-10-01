import { attr, conceptOf, defaultAnalyticsName, json, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";
import { isAnonymous } from "../ids.js";

/**
 * Intercom (the marketing integration, not the inbox app): one data event per RevenueDot event through
 * `POST /events` (https://developers.intercom.com/docs/references/rest-api/api.intercom.io/data-events/createdataevent)
 * on api.intercom.io, api.eu.intercom.io or api.au.intercom.io, Bearer auth with an access token, `Intercom-Version`.
 * RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/intercom
 * Settings: `region` (us | eu | au), `reporting`. Secrets: `access_token`. Sandbox events go to the same workspace
 * (with `environment: SANDBOX` in the metadata) when the integration's environment includes sandbox.
 * Identity: the app user id as `user_id` (the contact's external id); anonymous app user ids use `$email` instead, and
 * skip without it. Intercom answers 404 for an event about a contact it does not have.
 * Events only: contact custom attributes (`subscription_status` ...) need Intercom's contact id, which only a search by
 * external id returns, and a delivery plan cannot use the answer of an earlier request. `subscription_status` goes in
 * the event metadata instead. Metadata is capped at Intercom's 10 keys; revenue is a monetary amount in cents, on
 * positive money events only (Intercom does not document negative amounts, so refunds carry none).
 * Intercom deduplicates on contact, event name and `created_at`, so a retried event is not recorded twice.
 */

export const INTERCOM_HOSTS = { us: "https://api.intercom.io", eu: "https://api.eu.intercom.io", au: "https://api.au.intercom.io" } as const;
export const INTERCOM_VERSION = "2.11";

export const INTERCOM_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation",
  "non_subscription_purchase", "expiration", "billing_issue", "product_change", "test",
];

const MONEY: Concept[] = ["initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"];
const secs = (ms: unknown) => (typeof ms === "number" ? Math.floor(ms / 1000) : null);

export async function buildIntercom(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const token = i.secrets.access_token;
  if (!token) return skip("No Intercom access token is saved.");
  const c = conceptOf(e);
  if (!c || !INTERCOM_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Intercom.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  const email = attr(e, "$email")?.trim();
  let who: Record<string, string>;
  if (appUserId && !isAnonymous(appUserId)) who = { user_id: appUserId };
  else if (email) who = { email };
  else return skip("Anonymous customers need the $email attribute: Intercom finds contacts by your user id or their email.");
  const revenue = revenueUsd(e, i.settings.reporting);
  // Ten keys at most: Intercom ignores the rest.
  const metadata: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== "" && Object.keys(metadata).length < 10) metadata[k] = v; };
  put("product_identifier", e.product_id);
  put("entitlement", Array.isArray(e.entitlement_ids) && e.entitlement_ids.length ? e.entitlement_ids.join(",") : e.entitlement_id);
  put("store", e.store);
  put("environment", e.environment);
  put("subscription_status", subscriptionStatusOf(e));
  put("expires_at", secs(e.expiration_at_ms));
  if (MONEY.includes(c) && revenue > 0) put("price", { amount: Math.round(revenue * 100), currency: "usd" });
  put("period_type", e.period_type);
  put("cancellation_reason", e.cancel_reason);
  put("expiration_reason", e.expiration_reason);
  put("new_product_identifier", e.new_product_id);
  put("country_code", e.country_code);
  const body = { event_name: name, created_at: secs(e.event_timestamp_ms ?? i.now.getTime()), ...who, metadata };
  const host = INTERCOM_HOSTS[(i.settings.region as keyof typeof INTERCOM_HOSTS) ?? "us"] ?? INTERCOM_HOSTS.us;
  return {
    name,
    requests: [{
      method: "POST", url: `${host}/events`,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, "intercom-version": INTERCOM_VERSION },
      body: json(body),
    }],
    redact: [token],
  };
}

/** Intercom's errors come as `{ type: "error.list", errors: [{ code, message }] }`. */
export function intercomAnswerError(_body: string, j: any): string | null {
  if (j && typeof j === "object" && j.type === "error.list") {
    const first = Array.isArray(j.errors) ? j.errors[0] : null;
    return `Intercom answered: ${first?.message ?? first?.code ?? "error"}`;
  }
  return null;
}
