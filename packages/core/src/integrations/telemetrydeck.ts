import { DOCS, REPORTING, attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";

/**
 * TelemetryDeck: one signal per RevenueDot event through the ingest API v2 (https://telemetrydeck.com/docs/ingest/v2),
 * `POST https://nom.telemetrydeck.com/v2/` (or `/v2/namespace/{namespace}/`), a JSON array of signals. No auth: the
 * app ID routes the signal.
 * Settings: `app_id` (used when the customer has no `$telemetryDeckAppId`), `namespace` (optional), `reporting`.
 * Identity: `$telemetryDeckUserId` as `clientUser` (the already-hashed id the TelemetryDeck SDK uses; RevenueDot cannot
 * recreate TelemetryDeck's hash), required, and `$telemetryDeckAppId` as `appID` when set.
 * Sent: RevenueCat's rc_<step>_event names as the signal type; `floatValue` is the USD revenue (negative for refunds,
 * which TelemetryDeck sums as-is); the payload is flat `RevenueCat.event.<field>` keys, the parameter names
 * TelemetryDeck documents for RevenueCat (https://telemetrydeck.com/docs/api/default-parameters).
 * Sandbox: sent with `isTestMode: true`, which TelemetryDeck keeps out of production queries.
 */

export const TELEMETRYDECK_HOST = "https://nom.telemetrydeck.com";

export const TELEMETRYDECK_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "transfer", "refund_reversed", "test",
];

export async function buildTelemetryDeck(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !TELEMETRYDECK_EVENTS.includes(c)) return skip(`${e.type} events are not sent to TelemetryDeck.`);
  const clientUser = attr(e, "$telemetryDeckUserId");
  if (!clientUser) return skip("The customer has no $telemetryDeckUserId attribute (the hashed user id from the TelemetryDeck SDK), so TelemetryDeck cannot match the event.");
  const appId = attr(e, "$telemetryDeckAppId") ?? (typeof i.settings.app_id === "string" && i.settings.app_id.trim() ? i.settings.app_id.trim() : null);
  if (!appId) return skip("No TelemetryDeck app ID: set the $telemetryDeckAppId attribute in the app or save an app ID.");
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const payload: Record<string, string | number | boolean> = {};
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return;
    payload[`RevenueCat.event.${k}`] = Array.isArray(v) ? v.join(",") : typeof v === "number" || typeof v === "boolean" ? v : String(v);
  };
  put("id", e.id); put("type", e.type); put("app_user_id", e.app_user_id); put("original_app_user_id", e.original_app_user_id);
  put("product_id", e.product_id); put("store", e.store); put("environment", e.environment); put("period_type", e.period_type);
  put("entitlement_ids", e.entitlement_ids); put("presented_offering_id", e.presented_offering_id); put("transaction_id", e.transaction_id);
  put("original_transaction_id", e.original_transaction_id); put("country_code", e.country_code); put("currency", e.currency);
  put("price", e.price); put("price_in_purchased_currency", e.price_in_purchased_currency); put("commission_percentage", e.commission_percentage);
  put("tax_percentage", e.tax_percentage); put("takehome_percentage", e.takehome_percentage); put("cancel_reason", e.cancel_reason);
  put("expiration_reason", e.expiration_reason); put("new_product_id", e.new_product_id); put("is_trial_conversion", e.is_trial_conversion);
  const signal: Record<string, unknown> = { appID: appId, clientUser, type: name, isTestMode: isSandbox(e), payload };
  const revenue = revenueUsd(e, i.settings.reporting);
  if (revenue !== 0) signal.floatValue = revenue;
  const ns = typeof i.settings.namespace === "string" ? i.settings.namespace.trim() : "";
  const url = ns ? `${TELEMETRYDECK_HOST}/v2/namespace/${encodeURIComponent(ns)}/` : `${TELEMETRYDECK_HOST}/v2/`;
  return { name, requests: [{ method: "POST", url, headers: { "content-type": "application/json; charset=utf-8" }, body: json([signal]) }], redact: [] };
}

export const TELEMETRYDECK: PartnerDef = {
  spec: {
    kind: "telemetrydeck", name: "TelemetryDeck", category: "analytics", environment: "both", eventNames: true, docs: `${DOCS}#telemetrydeck`, api: "documented",
    text: "Send subscription events and revenue to TelemetryDeck as signals from the same users your app already tracks.",
    fields: [
      { key: "app_id", label: "App ID", type: "text", placeholder: "AAAA-BBBBBBBB-CCCC-DDDD", hint: "Optional. Used for customers without the $telemetryDeckAppId attribute. In TelemetryDeck, the app's settings." },
      { key: "namespace", label: "Namespace", type: "text", hint: "Optional. Your organization's namespace from the TelemetryDeck dashboard, if TelemetryDeck gave you one." },
      REPORTING,
    ],
  },
  events: TELEMETRYDECK_EVENTS,
  build: buildTelemetryDeck,
  defaultName: defaultAnalyticsName,
  validate: (settings) =>
    typeof settings.namespace === "string" && settings.namespace && !/^[A-Za-z0-9._-]+$/.test(settings.namespace)
      ? { param: "settings.namespace", message: "use letters, digits, dots, dashes and underscores only." }
      : null,
};
