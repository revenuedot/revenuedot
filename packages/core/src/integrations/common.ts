/**
 * Shared pieces of the integration payload builders. Every builder takes the webhook `event` object (the RevenueCat
 * webhook shape that services/events.ts stores) plus the integration's settings and secrets, and returns the HTTP
 * requests to send, or a reason to skip. Builders are pure apart from WebCrypto hashing, so they run on Node and
 * Cloudflare Workers alike; the server's thin adapter (apps/server/src/services/integrations) does the sending.
 */

export type IntegrationKind =
  | "slack" | "segment" | "amplitude" | "mixpanel" | "posthog" | "firebase" | "bigquery" | "appsflyer" | "adjust" | "meta"
  // Batch D (prd/integrations/PRD.md, "Batch D partners"): analytics
  | "mparticle" | "statsig" | "superwall" | "telemetrydeck"
  // attribution
  | "apple_search_ads" | "appstack" | "asapty" | "branch" | "google_tag_manager" | "kochava" | "airbridge" | "splitmetrics" | "singular" | "solarengine" | "tenjin"
  // marketing
  | "airship" | "braze" | "clevertap" | "customerio" | "discord" | "intercom" | "iterable" | "onesignal"
  // ads and support: connections that send no events (AdMob loads ad units; the help desk apps read the support summary)
  | "admob" | "intercom_inbox" | "zendesk";

/**
 * One field of an integration's settings form. The API validates writes against it and the dashboard draws its forms
 * from it. `secret` fields are sealed at rest and never returned; `select` fields list their options.
 */
export interface IntegrationField {
  key: string;
  label: string;
  type: "text" | "secret" | "select" | "boolean" | "textarea" | "tokens";
  required?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
  placeholder?: string;
  /** Only shown when another select field has this value (`region: custom`). */
  when?: { key: string; value: string };
  /** The value is a URL the server will call: checked with the outbound URL guard on save (https only on Cloud). */
  url?: boolean;
}

export interface IntegrationSpec {
  kind: IntegrationKind;
  name: string;
  category: "core" | "analytics" | "attribution" | "marketing" | "ads" | "support";
  text: string;
  /** Environment default for a new integration ("production", "sandbox" or "both"). */
  environment: "production" | "both";
  /** Whether the dashboard offers event name overrides. */
  eventNames: boolean;
  fields: IntegrationField[];
  docs: string;
  /**
   * How the partner's API is known: "documented" (built from the partner's public API reference) or "webhook" (the
   * partner documents no public API for this; RevenueDot posts the RevenueCat-shaped webhook body to the URL the partner
   * gives you, which is how the partner itself asks RevenueCat customers to connect). Shown on the catalogue card.
   */
  api?: "documented" | "webhook";
  /** Sends no lifecycle events (AdMob, help desk apps): the dashboard shows a dedicated page instead of the event form. */
  connection?: boolean;
}

/**
 * Everything one partner needs: its catalogue entry, the lifecycle steps it sends, the payload builder, and optional
 * answer and save-time checks. Batch D partners register through these; the first ten are wired by hand in index.ts.
 */
export interface PartnerDef {
  spec: IntegrationSpec;
  /** Steps sent ("all": every event, like BigQuery). Steps outside the list are never queued. */
  events: Concept[] | "all";
  build: (i: BuildInput) => Promise<Plan>;
  /** The default event name per step, for the dashboard's "Event names" panel (null: the step has no name). */
  defaultName?: (c: Concept) => string | null;
  /** A 2xx answer that still means "rejected" (an error inside the body). Return the message, or null when accepted. */
  answerError?: (body: string, json: any) => string | null;
  /** Cross-field rule checked on save, on the merged settings and secrets. */
  validate?: (settings: Record<string, any>, secrets: Record<string, string>) => { param: string; message: string } | null;
}

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
  | "purchase_redeemed" | "experiment_enrollment" | "refund_reversed" | "test"
  | "funnel_viewed" | "funnel_step_completed" | "funnel_purchase"
  | "paywall_impression" | "paywall_close" | "paywall_cancel" | "paywall_exit_offer" | "paywall_component_interacted"
  | "paywall_purchase_initiated" | "paywall_purchase_error";

export const CONCEPTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "transfer",
  "purchase_redeemed", "experiment_enrollment", "refund_reversed", "test",
  "funnel_viewed", "funnel_step_completed", "funnel_purchase",
  "paywall_impression", "paywall_close", "paywall_cancel", "paywall_exit_offer", "paywall_component_interacted",
  "paywall_purchase_initiated", "paywall_purchase_error",
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
    case "REFUND_REVERSED": return "refund_reversed";
    case "TEST": return "test";
    case "FUNNEL_VIEWED": return "funnel_viewed";
    case "FUNNEL_STEP_COMPLETED": return "funnel_step_completed";
    case "FUNNEL_PURCHASE": return "funnel_purchase";
    case "PAYWALL_IMPRESSION": return "paywall_impression";
    case "PAYWALL_CLOSE": return "paywall_close";
    case "PAYWALL_CANCEL": return "paywall_cancel";
    case "PAYWALL_EXIT_OFFER": return "paywall_exit_offer";
    case "PAYWALL_COMPONENT_INTERACTED": return "paywall_component_interacted";
    case "PAYWALL_PURCHASE_INITIATED": return "paywall_purchase_initiated";
    case "PAYWALL_PURCHASE_ERROR": return "paywall_purchase_error";
    default: return null;
  }
}

/**
 * The analytics tools' default event names (`rc_<step>_event`), the same names RevenueCat's integrations use. Paywall
 * events keep their SDK names (`paywall_impression` …), which are RevenueCat's defaults for them too.
 */
export function defaultAnalyticsName(c: Concept): string {
  if (isPaywallConcept(c)) return c;
  if (c === "purchase_redeemed") return "rc_purchase_redeemed";
  if (c === "funnel_viewed" || c === "funnel_step_completed" || c === "funnel_purchase") return `rd_${c}`;
  if (c === "non_subscription_purchase") return "rc_non_subscription_purchase_event";
  return `rc_${c}_event`;
}

export interface OutRequest {
  method: "POST" | "PUT" | "PATCH" | "GET" | "HEAD";
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

/**
 * Whether a field applies with these settings: always, or only while the select it depends on (`when`) has the given
 * value. An unset select counts as its first option, which is what the form shows and the builders assume. A `required`
 * field is required only while it applies (the API and the dashboard both use this).
 */
export function fieldApplies(spec: { fields: IntegrationField[] }, f: IntegrationField, settings: Record<string, unknown>): boolean {
  if (!f.when) return true;
  const dep = spec.fields.find((x) => x.key === f.when!.key);
  const v = settings[f.when.key];
  const value = v === undefined || v === null || v === "" ? dep?.options?.[0]?.value : v;
  return value === f.when.value;
}

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

export const iso = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null);

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

/**
 * The webhook store name → the platform the event's app runs on. Test Store purchases come from the app on whatever
 * platform it runs on, so for TEST_STORE the platform is the one the customer's SDK last reported (`x-platform`, passed
 * as `sdkPlatform` from the event context): a Test Store purchase in the iOS app goes to the iOS app's sandbox keys of
 * AppsFlyer, Adjust, Firebase, Branch and Kochava, which is how developers test those integrations before the stores.
 */
export const platformOf = (store: unknown, sdkPlatform?: string | null): "ios" | "android" | "web" | "other" => {
  if (store === "TEST_STORE") {
    const p = (sdkPlatform ?? "").trim().toLowerCase();
    return ["ios", "ipados", "macos", "tvos", "watchos", "visionos"].includes(p) ? "ios" : p === "android" ? "android" : "other";
  }
  return store === "APP_STORE" || store === "MAC_APP_STORE" ? "ios" : store === "PLAY_STORE" ? "android" : store === "STRIPE" || store === "RC_BILLING" || store === "PADDLE" ? "web" : "other";
};

export const json = (o: unknown) => JSON.stringify(o);

/** RevenueDot funnel events (prd/web-billing/PRD.md §5): the funnel, step, answer and utm_* fields, for the analytics tools. */
export function funnelProperties(e: WebhookEvent): Record<string, unknown> {
  if (typeof e.type !== "string" || !e.type.startsWith("FUNNEL_")) return {};
  const out: Record<string, unknown> = {};
  for (const k of ["funnel_id", "funnel_name", "funnel_slug", "session_id", "step_id", "step_type", "step_index", "answer", "product_id", "package"]) if (e[k] !== undefined) out[k] = e[k];
  for (const [k, v] of Object.entries(e)) if (/^utm_/.test(k)) out[k] = v;
  return out;
}

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

/** The "Sales reporting" field every revenue-sending integration has. */
export const REPORTING: IntegrationField = {
  key: "reporting", label: "Sales reporting", type: "select", options: [{ value: "gross", label: "Gross revenue" }, { value: "proceeds", label: "After store commission and taxes" }],
  hint: "Revenue is sent in US dollars.",
};
/** The integrations guide; each catalogue entry links to its section. */
export const DOCS = "https://revenuedot.app/docs/guides/integrations";


/**
 * Paywall events (opt-in event types PAYWALL_*): what a customer did on a paywall the SDK showed. They carry the paywall,
 * offering and session but no transaction, price or revenue.
 */
export const PAYWALL_CONCEPTS: Concept[] = [
  "paywall_impression", "paywall_close", "paywall_cancel", "paywall_exit_offer", "paywall_component_interacted",
  "paywall_purchase_initiated", "paywall_purchase_error",
];
export const isPaywallConcept = (c: Concept | null): c is Concept => !!c && PAYWALL_CONCEPTS.includes(c);

/**
 * The fields a paywall event carries (services/sdk-events.ts builds them from the SDK's event, with its snake_case keys),
 * in the order the analytics tools receive them. Fields the SDK did not send are left out.
 */
export const PAYWALL_EVENT_FIELDS = [
  "paywall_id", "paywall_name", "paywall_revision", "offering_id", "session_id", "display_mode", "dark_mode", "locale", "source",
  "placement_identifier", "targeting_revision", "targeting_rule_id", "workflow_id",
  "exit_offer_type", "exit_offering_id", "package_id", "product_id", "error_code", "error_message",
  "component_type", "component_name", "component_value", "component_url",
  "origin_index", "destination_index", "default_index", "origin_context_name", "destination_context_name",
  "origin_package_id", "destination_package_id", "default_package_id", "origin_product_id", "destination_product_id", "default_product_id",
  "current_package_id", "resulting_package_id", "current_product_id", "resulting_product_id",
] as const;

/** The event properties the analytics tools get for a paywall event: the paywall fields plus who and where. No revenue. */
export function paywallProperties(e: WebhookEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PAYWALL_EVENT_FIELDS) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  return {
    ...out, ...(e.sdk_version ? { sdk_version: e.sdk_version } : {}), ...(e.platform_version ? { platform_version: e.platform_version } : {}),
    environment: e.environment ?? null, store: e.store ?? null, app_id: e.app_id ?? null,
    app_user_id: e.app_user_id ?? null, original_app_user_id: e.original_app_user_id ?? null, subscriber_attributes: e.subscriber_attributes ?? {},
  };
}

/** RevenueDot web funnel steps (opt-in event types FUNNEL_VIEWED, FUNNEL_STEP_COMPLETED, FUNNEL_PURCHASE). */
export const FUNNEL_CONCEPTS: Concept[] = ["funnel_viewed", "funnel_step_completed", "funnel_purchase"];
export const isFunnelConcept = (c: Concept | null): c is Concept => !!c && FUNNEL_CONCEPTS.includes(c);

/**
 * The integrations whose funnel events carry the visitor's IP address and browser user agent (Meta's website events and
 * Branch's web events need them to match the visitor). services/web/funnels.ts records `client_ip` and
 * `client_user_agent` only while one of these asks for funnel events; every other integration gets neither.
 */
export const FUNNEL_CLIENT_KINDS: readonly IntegrationKind[] = ["meta", "branch"];

/** Event fields that hold the funnel visitor's IP address and user agent (personal data, kept for 7 days at most). */
export const FUNNEL_CLIENT_FIELDS = ["client_ip", "client_user_agent"] as const;

/**
 * The forms a secret takes in a request: as written, percent-encoded (encodeURIComponent) and form-encoded
 * (URLSearchParams, which encodes spaces as + and a few more characters), so the delivery log scrubs a secret that a
 * builder put in a query string or a form body whatever its characters.
 */
export function secretForms(s: string): string[] {
  return [...new Set([s, encodeURIComponent(s), new URLSearchParams({ x: s }).toString().slice(2)])];
}

/**
 * What an ad network needs from a funnel event to match a web visitor (services/web/funnels.ts records it when an
 * integration asks for funnel events): the browser's IP, user agent and page URL, the ad click ids from the landing URL
 * (fbclid, gclid, gbraid, wbraid, ttclid, msclkid), the utm_* parameters, and the purchase's USD revenue.
 */
export function funnelAdContext(e: WebhookEvent) {
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const clickIds = (e.click_ids && typeof e.click_ids === "object" ? e.click_ids : {}) as Record<string, string>;
  const utm = Object.fromEntries(Object.entries(e).filter(([k, v]) => /^utm_[a-z_]+$/.test(k) && typeof v === "string")) as Record<string, string>;
  return {
    ip: s(e.client_ip), userAgent: s(e.client_user_agent), pageUrl: s(e.page_url), clickIds, utm,
    revenue: typeof e.revenue_usd === "number" && e.revenue_usd > 0 ? round(e.revenue_usd) : 0,
    emailStep: e.step_type === "email",
  };
}
