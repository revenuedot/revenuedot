import { attr, conceptOf, defaultAnalyticsName, isSandbox, iso, json, nameFor, revenueUsd, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Braze: one `POST /users/track` per event on the workspace's REST endpoint
 * (https://www.braze.com/docs/api/endpoints/user_data/post_user_track), Bearer auth with a REST API key that has the
 * users.track permission. RevenueCat's behaviour: https://www.revenuecat.com/docs/integrations/third-party-integrations/braze
 * Settings: `rest_endpoint` (the instance's REST URL, e.g. https://rest.iad-01.braze.com), `app_id` (optional Braze
 * app identifier), `revenue_format` (ecommerce | purchase), `reporting`. Secrets: `api_key`, `sandbox_api_key`
 * (a second workspace; sandbox events are sent only with it).
 * Identity: the `$brazeAliasName` + `$brazeAliasLabel` attributes as a user alias when both are set, else the app user
 * id as `external_id`.
 * Sent in one request: a custom event (`rc_*_event`), the `rc_subscription_status` attribute, and for positive money
 * events either an `ecommerce.order_placed` event (Braze's recommended eCommerce event) or a legacy purchase object.
 * Refunds are not sent as negative purchases. Braze has no idempotency key: a replayed event is recorded again.
 */

export const BRAZE_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "test",
];

/** Braze REST endpoints by instance (https://www.braze.com/docs/api/basics/#endpoints). */
export const BRAZE_ENDPOINTS: { value: string; label: string }[] = [
  ...["01", "02", "03", "04", "05", "06", "07", "08"].map((n) => ({ value: `https://rest.iad-${n}.braze.com`, label: `US-${n} (rest.iad-${n}.braze.com)` })),
  { value: "https://rest.us-10.braze.com", label: "US-10 (rest.us-10.braze.com)" },
  { value: "https://rest.fra-01.braze.eu", label: "EU-01 (rest.fra-01.braze.eu)" },
  { value: "https://rest.fra-02.braze.eu", label: "EU-02 (rest.fra-02.braze.eu)" },
  { value: "https://rest.au-01.braze.com", label: "AU-01 (rest.au-01.braze.com)" },
  { value: "https://rest.id-01.braze.com", label: "ID-01 (rest.id-01.braze.com)" },
  { value: "https://rest.jp-01.braze.com", label: "JP-01 (rest.jp-01.braze.com)" },
  { value: "https://rest.kr-01.braze.com", label: "KR-01 (rest.kr-01.braze.com)" },
];

/** A Braze REST host: https://rest.<cluster>.braze.com or .braze.eu, nothing after it. */
export const brazeEndpointOk = (v: unknown) => typeof v === "string" && /^https:\/\/rest\.[a-z0-9-]+\.braze\.(com|eu)\/?$/.test(v);

const MONEY: Concept[] = ["initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"];

const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

export async function buildBraze(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const key = isSandbox(e) ? i.secrets.sandbox_api_key : i.secrets.api_key;
  if (!key) return skip(isSandbox(e) ? "Sandbox events need a sandbox REST API key." : "No Braze REST API key is saved.");
  const endpoint = String(i.settings.rest_endpoint ?? "");
  if (!brazeEndpointOk(endpoint)) return skip("Set your Braze REST endpoint, such as https://rest.iad-01.braze.com.");
  const c = conceptOf(e);
  if (!c || !BRAZE_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Braze.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const aliasName = attr(e, "$brazeAliasName"), aliasLabel = attr(e, "$brazeAliasLabel");
  const who: Record<string, unknown> = aliasName && aliasLabel
    ? { user_alias: { alias_name: aliasName, alias_label: aliasLabel } }
    : { external_id: String(e.app_user_id ?? e.original_app_user_id) };
  const app = i.settings.app_id ? { app_id: String(i.settings.app_id) } : {};
  const time = iso(e.event_timestamp_ms ?? i.now.getTime())!;
  const revenue = revenueUsd(e, i.settings.reporting);
  const properties = compact({
    product_id: e.product_id, store: e.store, environment: e.environment, period_type: e.period_type, entitlement_ids: e.entitlement_ids,
    presented_offering_id: e.presented_offering_id, transaction_id: e.transaction_id, original_transaction_id: e.original_transaction_id,
    app_user_id: e.app_user_id, original_app_user_id: e.original_app_user_id, country_code: e.country_code,
    revenue, currency: "USD", price_in_purchased_currency: e.price_in_purchased_currency, purchased_currency: e.currency,
    purchased_at: iso(e.purchased_at_ms), expiration_at: iso(e.expiration_at_ms), cancel_reason: e.cancel_reason, expiration_reason: e.expiration_reason,
    new_product_id: e.new_product_id, is_trial_conversion: e.is_trial_conversion, offer_code: e.offer_code,
  });
  const events: Record<string, unknown>[] = [{ ...who, ...app, name, time, properties }];
  const body: Record<string, unknown> = {};
  const status = subscriptionStatusOf(e);
  if (status) body.attributes = [{ ...who, rc_subscription_status: status }];
  body.events = events;
  if (MONEY.includes(c) && revenue > 0) {
    const product = String(e.product_id ?? "unknown");
    if (i.settings.revenue_format === "purchase") {
      body.purchases = [{ ...who, ...app, product_id: product, currency: "USD", price: revenue, quantity: 1, time, properties: compact({ rc_event_name: name, store: e.store, environment: e.environment, transaction_id: e.transaction_id }) }];
    } else {
      events.push({
        ...who, ...app, name: "ecommerce.order_placed", time,
        properties: {
          order_id: String(e.transaction_id ?? e.id), total_value: revenue, currency: "USD", total_discounts: 0, source: String(e.store ?? "unknown"),
          products: [{ product_id: product, product_name: product, variant_id: product, quantity: 1, price: revenue }],
          metadata: compact({ rc_event_name: name, environment: e.environment, period_type: e.period_type }),
        },
      });
    }
  }
  return {
    name,
    requests: [{ method: "POST", url: `${endpoint.replace(/\/$/, "")}/users/track`, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: json(body) }],
    redact: [key],
  };
}

/** Braze answers 201 when some objects were rejected, with `errors`; a `message` other than "success" is a failure. */
export function brazeAnswerError(_body: string, j: any): string | null {
  if (!j || typeof j !== "object") return null;
  if (Array.isArray(j.errors) && j.errors.length) {
    const first = j.errors[0];
    return `Braze rejected part of the request: ${typeof first === "string" ? first : first?.type ?? JSON.stringify(first)}${first?.input_array ? ` (${first.input_array})` : ""}`;
  }
  if (typeof j.message === "string" && j.message !== "success" && j.message !== "queued") return `Braze answered: ${j.message}`;
  return null;
}
