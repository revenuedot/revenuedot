import { DOCS, FUNNEL_CONCEPTS, REPORTING, conceptOf, defaultAnalyticsName, funnelAdContext, isFunnelConcept, isSandbox, json, nameFor, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";

/**
 * Google Tag Manager server-side container: events in the GA4 Measurement Protocol format
 * (https://developers.google.com/analytics/devguides/collection/protocol/ga4), POSTed to your server container's
 * `/mp/collect` instead of www.google-analytics.com, which Google documents for sending Measurement Protocol data to a
 * server container (https://developers.google.com/tag-platform/tag-manager/server-side/send-data). The container's
 * Measurement Protocol (GA4) client claims the request; its tags send it on to GA4, Google Ads or any other destination.
 * Settings: `server_container_url` (called by the server, checked by the URL guard), `measurement_id` (G-…),
 * `sandbox_measurement_id`, `reporting`. Secrets: `api_secret`, `sandbox_api_secret` (the GA4 stream's Measurement
 * Protocol API secret; optional, only if your client or GA4 tag needs it).
 * Identity: the app user id as `user_id` and `client_id` (an app has no GA browser cookie).
 * Sent: purchases, trial conversions, renewals and one-time purchases as GA4's recommended `purchase` (value in USD,
 * `transaction_id`, `items`, `is_renewal`, `is_trial_conversion`); other steps as rc_<step>_event. GA4 has no negative
 * purchase, so refunds carry no value. `event_id` is the RevenueCat event id, for dedupe in your tags.
 * Sandbox: sent only with a sandbox measurement ID (a separate GA4 stream), else skipped.
 */

export const GTM_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "transfer",
  "purchase_redeemed", "refund_reversed", "test", ...FUNNEL_CONCEPTS,
];

const MONEY: Concept[] = ["initial_purchase", "trial_converted", "renewal", "non_subscription_purchase"];

/** Funnel steps (opt-in) use GA4's web events: page_view, generate_lead (email steps) or rd_funnel_step_completed, purchase. */
export const gtmName = (c: Concept): string | null => (!GTM_EVENTS.includes(c) ? null : MONEY.includes(c) || c === "funnel_purchase" ? "purchase" : c === "funnel_viewed" ? "page_view" : defaultAnalyticsName(c));

const micros = (ms: number) => ms * 1000;

export async function buildGoogleTagManager(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !GTM_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Google Tag Manager.`);
  const base = typeof i.settings.server_container_url === "string" ? i.settings.server_container_url.trim().replace(/\/+$/, "") : "";
  if (!base) return skip("No server container URL is saved.");
  const sandbox = isSandbox(e);
  const measurementId = (sandbox ? i.settings.sandbox_measurement_id : i.settings.measurement_id) as string | undefined;
  if (!measurementId) return skip(sandbox ? "Sandbox events need a sandbox measurement ID." : "No measurement ID is saved.");
  const secret = sandbox ? i.secrets.sandbox_api_secret : i.secrets.api_secret;
  const name = nameFor(c, gtmName, i.eventNames)!;
  const appUserId = String(e.app_user_id ?? e.original_app_user_id ?? "");
  const params: Record<string, unknown> = {
    event_id: String(e.id), event_type: e.type, product_id: e.product_id ?? undefined, period_type: e.period_type ?? undefined,
    environment: e.environment ?? undefined, store: e.store ?? undefined, transaction_id: e.transaction_id ?? undefined,
    original_transaction_id: e.original_transaction_id ?? undefined, original_app_user_id: e.original_app_user_id ?? undefined, app_id: e.app_id ?? undefined,
  };
  const revenue = revenueUsd(e, i.settings.reporting);
  if (MONEY.includes(c) && revenue > 0) {
    Object.assign(params, {
      currency: "USD", value: revenue, transaction_id: String(e.transaction_id ?? e.id), coupon: e.offer_code ?? undefined,
      is_renewal: c === "renewal", is_trial_conversion: c === "trial_converted",
      items: [{ item_id: e.product_id, item_name: e.product_id, affiliation: e.store, price: revenue, quantity: 1 }],
    });
  }
  let eventName = name;
  if (isFunnelConcept(c)) {
    // The landing page with its utm_* and gclid, so GA4 attributes the session the way it does for a browser hit.
    const ctx = funnelAdContext(e);
    const q = new URLSearchParams({ ...ctx.utm, ...Object.fromEntries(["gclid", "gbraid", "wbraid"].filter((k) => ctx.clickIds[k]).map((k) => [k, ctx.clickIds[k]!])) }).toString();
    if (ctx.pageUrl) params.page_location = q ? `${ctx.pageUrl}?${q}` : ctx.pageUrl;
    Object.assign(params, { funnel_id: e.funnel_id ?? undefined, funnel_name: e.funnel_name ?? undefined, step_id: e.step_id ?? undefined, step_type: e.step_type ?? undefined });
    if (c === "funnel_step_completed" && ctx.emailStep && !i.eventNames?.[c]) eventName = "generate_lead";
    if (c === "funnel_purchase" && ctx.revenue > 0) {
      Object.assign(params, { currency: "USD", value: ctx.revenue, transaction_id: String(e.id), items: [{ item_id: e.product_id ?? "web", item_name: e.product_id ?? "web", affiliation: "STRIPE", price: ctx.revenue, quantity: 1 }] });
    }
  }
  if (e.cancel_reason) params.cancel_reason = e.cancel_reason;
  if (e.expiration_reason) params.expiration_reason = e.expiration_reason;
  if (e.new_product_id) params.new_product_id = e.new_product_id;
  const body = { client_id: appUserId, user_id: appUserId, timestamp_micros: micros(e.event_timestamp_ms ?? i.now.getTime()), events: [{ name: eventName, params }] };
  const q = new URLSearchParams({ measurement_id: measurementId });
  if (secret) q.set("api_secret", secret);
  return {
    name: eventName,
    requests: [{ method: "POST", url: `${base}/mp/collect?${q.toString()}`, headers: { "content-type": "application/json" }, body: json(body) }],
    redact: secret ? [secret, encodeURIComponent(secret)] : [],
  };
}

export const GOOGLE_TAG_MANAGER: PartnerDef = {
  spec: {
    kind: "google_tag_manager", name: "Google Tag Manager", category: "attribution", environment: "production", eventNames: true, docs: `${DOCS}#google_tag_manager`, api: "documented",
    text: "Send purchases and subscription events to your server-side Tag Manager container, for GA4, Google Ads and any tag it runs.",
    fields: [
      { key: "server_container_url", label: "Server container URL", type: "text", required: true, url: true, placeholder: "https://sgtm.example.com", hint: "In Tag Manager, open the server container, Admin → Container Settings → Server container URLs. Add a Measurement Protocol (GA4) client on the path /mp/collect." },
      { key: "measurement_id", label: "Measurement ID", type: "text", required: true, placeholder: "G-XXXXXXXXXX", hint: "The GA4 data stream's measurement ID." },
      { key: "api_secret", label: "Measurement Protocol API secret", type: "secret", hint: "Optional. In GA4, Admin → Data streams → the stream → Measurement Protocol API secrets." },
      { key: "sandbox_measurement_id", label: "Sandbox measurement ID", type: "text", placeholder: "G-XXXXXXXXXX", hint: "A second GA4 stream for sandbox events. Without it sandbox events are not sent." },
      { key: "sandbox_api_secret", label: "Sandbox API secret", type: "secret" },
      REPORTING,
    ],
  },
  events: GTM_EVENTS,
  build: buildGoogleTagManager,
  defaultName: gtmName,
  validate: (settings) => {
    const url = typeof settings.server_container_url === "string" ? settings.server_container_url : "";
    if (url && (url.includes("?") || url.includes("#"))) return { param: "settings.server_container_url", message: "must be the container address only, without ? or #." };
    for (const k of ["measurement_id", "sandbox_measurement_id"]) {
      const v = settings[k];
      if (typeof v === "string" && v && !/^G-[A-Z0-9]+$/.test(v)) return { param: `settings.${k}`, message: "must be a GA4 measurement ID, such as G-ABC123XYZ." };
    }
    return null;
  },
};
