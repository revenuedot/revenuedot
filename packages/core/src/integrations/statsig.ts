import { DOCS, REPORTING, attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";

/**
 * Statsig: one custom event per RevenueDot event through the log_event HTTP API
 * (https://docs.statsig.com/api-reference/events/log-custom-events), `POST https://events.statsigapi.net/v1/log_event`
 * with the `statsig-api-key` header. Statsig answers 202 `{"success":true}`; `{"success":false}` is a rejection.
 * Secrets: `server_secret` (the project's Server Secret Key, `secret-…`). Settings: `reporting`.
 * Identity: the app user id as `user.userID` (it must match the Statsig SDK's userID), `$email`, `$ip` and the
 * country as user fields.
 * Sent: RevenueCat's rc_<step>_event names; `value` is the USD revenue (negative for refunds, which Statsig accepts);
 * `metadata` carries the product, store, transaction ids and the RevenueCat event id (Statsig metadata is string-only).
 * Sandbox: sent with `user.statsigEnvironment.tier = development`, so it stays out of production metrics.
 */

export const STATSIG_URL = "https://events.statsigapi.net/v1/log_event";

export const STATSIG_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "transfer", "refund_reversed", "test",
];

export async function buildStatsig(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !STATSIG_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Statsig.`);
  const key = i.secrets.server_secret;
  if (!key) return skip("No Statsig server secret key is saved.");
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const metadata: Record<string, string> = {};
  const put = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== "") metadata[k] = Array.isArray(v) ? v.join(",") : String(v); };
  put("event_id", e.id); put("event_type", e.type); put("product_id", e.product_id); put("store", e.store); put("environment", e.environment);
  put("period_type", e.period_type); put("entitlement_ids", e.entitlement_ids); put("presented_offering_id", e.presented_offering_id);
  put("transaction_id", e.transaction_id); put("original_transaction_id", e.original_transaction_id); put("original_app_user_id", e.original_app_user_id);
  put("app_id", e.app_id); put("currency", "USD"); put("purchased_currency", e.currency); put("price_in_purchased_currency", e.price_in_purchased_currency);
  put("cancel_reason", e.cancel_reason); put("expiration_reason", e.expiration_reason); put("new_product_id", e.new_product_id);
  if (e.is_trial_conversion !== undefined) put("is_trial_conversion", e.is_trial_conversion);
  const user: Record<string, unknown> = { userID: String(e.app_user_id ?? e.original_app_user_id ?? "") };
  const email = attr(e, "$email"), ip = attr(e, "$ip");
  if (email) user.email = email.trim();
  if (ip) user.ip = ip;
  if (e.country_code) user.country = e.country_code;
  user.statsigEnvironment = { tier: isSandbox(e) ? "development" : "production" };
  const event: Record<string, unknown> = { eventName: name, user, time: e.event_timestamp_ms ?? i.now.getTime(), metadata };
  const revenue = revenueUsd(e, i.settings.reporting);
  if (revenue !== 0) event.value = revenue;
  return {
    name,
    requests: [{ method: "POST", url: STATSIG_URL, headers: { "content-type": "application/json", "statsig-api-key": key }, body: json({ events: [event] }) }],
    redact: [key],
  };
}

export const STATSIG: PartnerDef = {
  spec: {
    kind: "statsig", name: "Statsig", category: "analytics", environment: "both", eventNames: true, docs: `${DOCS}#statsig`, api: "documented",
    text: "Send subscription events and revenue to Statsig to measure experiments and feature gates by what customers pay.",
    fields: [
      { key: "server_secret", label: "Server secret key", type: "secret", required: true, placeholder: "secret-…", hint: "In Statsig, Settings → Keys & Environments → Server Secret Key." },
      REPORTING,
    ],
  },
  events: STATSIG_EVENTS,
  build: buildStatsig,
  defaultName: defaultAnalyticsName,
  answerError: (_body, j) => (j && typeof j === "object" && j.success === false ? `Statsig rejected the event: ${JSON.stringify(j).slice(0, 300)}` : null),
  validate: (_settings, secrets) =>
    secrets.server_secret && !secrets.server_secret.startsWith("secret-")
      ? { param: "settings.server_secret", message: "use the Server Secret Key, which starts with secret-. Client keys cannot log server events." }
      : null,
};
