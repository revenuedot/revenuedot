/**
 * Shared pieces of the integration payload builders. Every builder takes the webhook `event` object (the RevenueCat
 * webhook shape that services/events.ts stores) plus the integration's settings and secrets, and returns the HTTP
 * requests to send, or a reason to skip. Builders are pure apart from WebCrypto hashing, so they run on Node and
 * Cloudflare Workers alike; the server's thin adapter (apps/server/src/services/integrations) does the sending.
 */

export type IntegrationKind =
  | "slack" | "segment" | "amplitude" | "mixpanel" | "posthog" | "firebase" | "bigquery" | "appsflyer" | "adjust" | "meta";

/** A stored webhook event: `{ api_version, event }`'s `event`. */
export type WebhookEvent = Record<string, any>;

/**
 * The lifecycle step an event stands for. Integrations name trials apart from paid purchases, so a webhook type maps
 * to one of these first: INITIAL_PURCHASE with period_type TRIAL is a trial start, RENEWAL with is_trial_conversion is
 * a trial conversion, CANCELLATION during a trial is a trial cancellation.
 */
export type Concept =
  | "initial_purchase" | "trial_started" | "trial_converted" | "trial_cancelled" | "renewal" | "cancellation" | "uncancellation"
  | "non_subscription_purchase" | "subscription_paused" | "expiration" | "billing_issue" | "product_change" | "transfer"
  | "purchase_redeemed" | "experiment_enrollment" | "test";

export const CONCEPTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "transfer",
  "purchase_redeemed", "experiment_enrollment", "test",
];

export function conceptOf(e: WebhookEvent): Concept | null {
  const trial = e.period_type === "TRIAL";
  switch (e.type) {
    case "INITIAL_PURCHASE": return trial ? "trial_started" : "initial_purchase";
    case "RENEWAL": return e.is_trial_conversion ? "trial_converted" : "renewal";
    case "CANCELLATION": return trial ? "trial_cancelled" : "cancellation";
    case "UNCANCELLATION": return "uncancellation";
    case "NON_RENEWING_PURCHASE": return "non_subscription_purchase";
    case "SUBSCRIPTION_PAUSED": return "subscription_paused";
    case "EXPIRATION": return "expiration";
    case "BILLING_ISSUE": return "billing_issue";
    case "PRODUCT_CHANGE": return "product_change";
    case "TRANSFER": return "transfer";
    case "PURCHASE_REDEEMED": return "purchase_redeemed";
    case "EXPERIMENT_ENROLLMENT": return "experiment_enrollment";
    case "TEST": return "test";
    default: return null;
  }
}

/** The analytics tools' default event names (`rc_<step>_event`), the same names RevenueCat's integrations use. */
export function defaultAnalyticsName(c: Concept): string {
  if (c === "purchase_redeemed") return "rc_purchase_redeemed";
  if (c === "non_subscription_purchase") return "rc_non_subscription_purchase_event";
  return `rc_${c}_event`;
}

export interface OutRequest {
  method: "POST" | "PUT" | "GET" | "HEAD";
  url: string;
  headers: Record<string, string>;
  body: string;
}

export type Plan =
  | { skip: string }
  | { name: string; requests: OutRequest[]; /** Secret values to scrub from anything the delivery log keeps. */ redact: string[] };

export interface BuildInput {
  event: WebhookEvent;
  settings: Record<string, any>;
  secrets: Record<string, string>;
  /** Event name overrides by concept (`initial_purchase` → `my_purchase`). */
  eventNames?: Record<string, string>;
  /** Where the event came from, for builders that send device and app details (Meta's extinfo, AppsFlyer's bundle). */
  context?: EventContext;
  now: Date;
}

export interface EventContext {
  projectId?: string;
  /** Dashboard origin for links (Slack). */
  dashboardUrl?: string;
  /** The app's bundle id or package name. */
  bundleId?: string | null;
  appVersion?: string | null;
  platformVersion?: string | null;
  platform?: string | null;
  locale?: string | null;
  /** BigQuery: an OAuth access token the adapter fetched with the service account. */
  accessToken?: string;
}

export const skip = (reason: string): Plan => ({ skip: reason });

export const nameFor = (c: Concept, defaults: (c: Concept) => string | null, overrides?: Record<string, string>) => {
  const o = overrides?.[c]?.trim();
  return o || defaults(c);
};

/** A customer attribute's value from the event's `subscriber_attributes`. */
export function attr(e: WebhookEvent, key: string): string | null {
  const a = e.subscriber_attributes?.[key];
  const v = a && typeof a === "object" ? a.value : null;
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export const isSandbox = (e: WebhookEvent) => e.environment === "SANDBOX";

/**
 * Revenue in USD for the event, as the integration's "sales reporting" setting asks: `gross` (what the customer paid),
 * or `proceeds` (after the store's commission and estimated taxes). Refunds are negative; events without money are 0.
 */
export function revenueUsd(e: WebhookEvent, reporting: unknown = "gross"): number {
  const p = typeof e.price === "number" ? e.price : 0;
  if (reporting !== "proceeds") return round(p);
  const comm = typeof e.commission_percentage === "number" ? e.commission_percentage : 0;
  const tax = typeof e.tax_percentage === "number" ? e.tax_percentage : 0;
  return round(p * (1 - comm - tax));
}

/** The same in the currency the customer paid in (`price_in_purchased_currency`). */
export function revenueLocal(e: WebhookEvent, reporting: unknown = "gross"): number {
  const p = typeof e.price_in_purchased_currency === "number" ? e.price_in_purchased_currency : 0;
  if (reporting !== "proceeds") return round(p);
  const comm = typeof e.commission_percentage === "number" ? e.commission_percentage : 0;
  const tax = typeof e.tax_percentage === "number" ? e.tax_percentage : 0;
  return round(p * (1 - comm - tax));
}

export const round = (n: number) => Math.round(n * 1e6) / 1e6;

export const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null);

/**
 * The subscription status after the event, for the `rc_subscription_status` user property: active, intro, cancelled,
 * grace_period, trial, cancelled_trial, grace_period_trial, expired, promotional, expired_promotional, paused.
 * Null for events that say nothing about a subscription (one-time purchases, tests, transfers).
 */
export function subscriptionStatusOf(e: WebhookEvent): string | null {
  const c = conceptOf(e);
  const trial = e.period_type === "TRIAL";
  const promo = e.store === "PROMOTIONAL" || e.period_type === "PROMOTIONAL";
  switch (c) {
    case "trial_started": return "trial";
    case "initial_purchase": case "renewal": case "trial_converted": case "uncancellation": case "product_change":
      return promo ? "promotional" : trial ? "trial" : e.period_type === "INTRO" ? "intro" : "active";
    case "trial_cancelled": return "cancelled_trial";
    case "cancellation": return e.cancel_reason === "CUSTOMER_SUPPORT" ? "expired" : "cancelled";
    case "billing_issue": return trial ? "grace_period_trial" : "grace_period";
    case "expiration": return promo ? "expired_promotional" : "expired";
    case "subscription_paused": return "paused";
    default: return null;
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const basicAuth = (user: string, pass = "") => `Basic ${btoa(`${user}:${pass}`)}`;

/** The webhook store name → the platform the event's app runs on. */
export const platformOf = (store: unknown): "ios" | "android" | "web" | "other" =>
  store === "APP_STORE" || store === "MAC_APP_STORE" ? "ios" : store === "PLAY_STORE" ? "android" : store === "STRIPE" || store === "RC_BILLING" || store === "PADDLE" ? "web" : "other";

export const json = (o: unknown) => JSON.stringify(o);

/** Common event properties the analytics tools receive, with ISO dates (Amplitude, PostHog). */
export function lifecycleProperties(e: WebhookEvent, reporting: unknown) {
  const props: Record<string, unknown> = {
    app_user_id: e.app_user_id ?? null, original_app_user_id: e.original_app_user_id ?? null, aliases: e.aliases ?? [],
    product_id: e.product_id ?? null, period_type: e.period_type ?? null,
    purchased_at: iso(e.purchased_at_ms), expiration_at: iso(e.expiration_at_ms),
    environment: e.environment ?? null, store: e.store ?? null, entitlement_id: e.entitlement_id ?? null, entitlement_ids: e.entitlement_ids ?? null,
    presented_offering_id: e.presented_offering_id ?? null, transaction_id: e.transaction_id ?? null, original_transaction_id: e.original_transaction_id ?? null,
    country_code: e.country_code ?? null, currency: e.currency ?? null, revenue: revenueUsd(e, reporting), app_id: e.app_id ?? null,
    subscriber_attributes: e.subscriber_attributes ?? {},
  };
  if (e.cancel_reason) props.cancel_reason = e.cancel_reason;
  if (e.expiration_reason) props.expiration_reason = e.expiration_reason;
  if (e.new_product_id) props.new_product_id = e.new_product_id;
  if (e.auto_resume_at_ms !== undefined) props.auto_resume_at = iso(e.auto_resume_at_ms);
  if (e.is_trial_conversion !== undefined) props.is_trial_conversion = e.is_trial_conversion;
  if (e.offer_code) props.offer_code = e.offer_code;
  if (e.type === "TRANSFER") { props.transferred_from = e.transferred_from ?? []; props.transferred_to = e.transferred_to ?? []; }
  return props;
}
