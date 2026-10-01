import { attr, conceptOf, funnelAdContext, isFunnelConcept, isSandbox, json, nameFor, platformOf, revenueUsd, sha256Hex, skip, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * Meta: app events through the Conversions API (https://developers.facebook.com/docs/marketing-api/conversions-api/app-events).
 * Settings: `dataset_id`, `sandbox_dataset_id`, `send_without_att` (send iOS events without ATT consent), `test_event_code`, `reporting`.
 * Secrets: `access_token`, `sandbox_access_token` (sandbox events are sent only to a sandbox dataset).
 * Sent: trial starts (StartTrial), purchases, trial conversions and renewals (Subscribe), one-time purchases
 * (fb_mobile_purchase). Meta takes no negative revenue, so refunds and other steps are not sent.
 * Matching needs `$fbAnonId` or an advertising id (`$idfa`, `$gpsAdId`, `$amazonAdId`), and on iOS
 * `$attConsentStatus` = authorized unless `send_without_att`. `$email` and `$phoneNumber` are SHA-256 hashed.
 */

export const META_GRAPH = "https://graph.facebook.com/v21.0";

export const META_NAMES: Partial<Record<Concept, string>> = {
  trial_started: "StartTrial", initial_purchase: "Subscribe", trial_converted: "Subscribe", renewal: "Subscribe",
  non_subscription_purchase: "fb_mobile_purchase", test: "Subscribe",
  // Web funnels (opt-in): website events. A funnel's email step completes as Lead (see buildMetaWeb).
  funnel_viewed: "ViewContent", funnel_step_completed: "FunnelStepCompleted", funnel_purchase: "Purchase",
};

const ZERO_ID = /^[0-]+$/;
const validAdId = (v: string | null) => (v && !ZERO_ID.test(v) ? v : null);

export async function buildMeta(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  const name = c ? nameFor(c, (x) => META_NAMES[x] ?? null, i.eventNames) : null;
  if (!c || !name || !(c in META_NAMES)) return skip(`${e.type} events are not sent to Meta.`);
  // A test event would count as a real conversion and steer ad delivery; send it only to Events Manager's Test Events.
  if (c === "test" && !i.settings.test_event_code) return skip("Test events are sent to Meta only with a test event code, so they never count as real conversions.");
  const sandbox = isSandbox(e);
  const dataset = sandbox ? i.settings.sandbox_dataset_id : i.settings.dataset_id;
  const token = sandbox ? i.secrets.sandbox_access_token : i.secrets.access_token;
  if (!dataset || !token) return skip(sandbox ? "Sandbox events need a sandbox dataset ID and access token." : "No Meta dataset ID and access token are saved.");
  if (isFunnelConcept(c)) return buildMetaWeb(i, c, name, dataset, token);
  const platform = platformOf(e.store, i.context?.platform);
  const anon = attr(e, "$fbAnonId");
  const madid = platform === "ios" ? validAdId(attr(e, "$idfa")) : platform === "android" ? validAdId(attr(e, "$gpsAdId")) ?? validAdId(attr(e, "$amazonAdId")) : validAdId(attr(e, "$amazonAdId"));
  if (!anon && !madid) return skip("The customer has no $fbAnonId or advertising id, so Meta cannot match the event.");
  const att = attr(e, "$attConsentStatus");
  const attOk = platform !== "ios" || att === "authorized";
  if (!attOk && !i.settings.send_without_att) return skip("iOS customers need $attConsentStatus = authorized (or turn on sending without ATT consent).");
  const user_data: Record<string, unknown> = { external_id: [await sha256Hex(String(e.app_user_id ?? e.original_app_user_id))] };
  if (madid) user_data.madid = madid;
  if (anon) user_data.anon_id = anon;
  const email = attr(e, "$email");
  if (email) user_data.em = [await sha256Hex(email.trim().toLowerCase())];
  const phone = attr(e, "$phoneNumber");
  if (phone && phone.replace(/\D/g, "")) user_data.ph = [await sha256Hex(phone.replace(/\D/g, ""))];
  const ip = attr(e, "$ip");
  if (ip) user_data.client_ip_address = ip;
  const ctx = i.context ?? {};
  const extinfo = [platform === "android" ? "a2" : "i2", ctx.bundleId ?? "", "", ctx.appVersion ?? "", ctx.platformVersion ?? "", "", ctx.locale ?? "", "", "", 0, 0, "", 0, 0, 0, ""];
  const value = Math.max(0, revenueUsd(e, i.settings.reporting));
  const event: Record<string, unknown> = {
    event_name: name, event_time: Math.floor((e.event_timestamp_ms ?? i.now.getTime()) / 1000), event_id: String(e.id), action_source: "app", user_data,
    custom_data: { currency: "USD", value, order_id: String(e.transaction_id ?? e.id), content_type: "product", content_ids: [e.product_id], contents: [{ id: e.product_id, quantity: 1 }] },
    app_data: { advertiser_tracking_enabled: attOk ? 1 : 0, application_tracking_enabled: 1, extinfo, ...(attr(e, "$idfv") ? { vendor_id: attr(e, "$idfv") } : {}) },
  };
  const body: Record<string, unknown> = { data: [event], access_token: token, partner_agent: "revenuedot" };
  if (i.settings.test_event_code) body.test_event_code = i.settings.test_event_code;
  return { name, requests: [{ method: "POST", url: `${META_GRAPH}/${encodeURIComponent(dataset)}/events`, headers: { "content-type": "application/json" }, body: json(body) }], redact: [token] };
}

/**
 * Web funnel events as website events (https://developers.facebook.com/docs/marketing-api/conversions-api/parameters):
 * `action_source: website` with `event_source_url` and the visitor's `client_user_agent` (both required for website
 * events), `client_ip_address`, `fbc` built from the landing URL's fbclid (`fb.1.<ms>.<fbclid>`), and `external_id`
 * (SHA-256 of the visitor's anonymous app user id, the same id the purchase is made under). The purchase carries its USD
 * value. Web purchases also arrive as INITIAL_PURCHASE from the Stripe store, which Meta's app events skip (no device id),
 * so a funnel purchase is counted once.
 */
async function buildMetaWeb(i: BuildInput, c: Concept, name: string, dataset: string, token: string): Promise<Plan> {
  const e = i.event;
  const ctx = funnelAdContext(e);
  if (!ctx.userAgent || !ctx.pageUrl) return skip("Meta website events need the visitor's browser user agent and page URL; RevenueDot records them for funnel visits that start after an integration asks for funnel events.");
  const finalName = c === "funnel_step_completed" && ctx.emailStep && !i.eventNames?.[c] ? "Lead" : name;
  const at = e.event_timestamp_ms ?? i.now.getTime();
  const user_data: Record<string, unknown> = { external_id: [await sha256Hex(String(e.app_user_id ?? ""))], client_user_agent: ctx.userAgent };
  if (ctx.ip) user_data.client_ip_address = ctx.ip;
  if (ctx.clickIds.fbclid) user_data.fbc = `fb.1.${at}.${ctx.clickIds.fbclid}`;
  const custom_data: Record<string, unknown> = { content_name: e.funnel_name ?? undefined, content_category: "funnel", funnel_id: e.funnel_id ?? undefined };
  if (c === "funnel_step_completed") Object.assign(custom_data, { step_id: e.step_id ?? undefined, step_type: e.step_type ?? undefined });
  if (c === "funnel_purchase") Object.assign(custom_data, { currency: "USD", value: ctx.revenue, content_type: "product", content_ids: e.product_id ? [e.product_id] : undefined });
  const event = { event_name: finalName, event_time: Math.floor(at / 1000), event_id: String(e.id), action_source: "website", event_source_url: ctx.pageUrl, user_data, custom_data };
  const body: Record<string, unknown> = { data: [event], access_token: token, partner_agent: "revenuedot" };
  if (i.settings.test_event_code) body.test_event_code = i.settings.test_event_code;
  return { name: finalName, requests: [{ method: "POST", url: `${META_GRAPH}/${encodeURIComponent(dataset)}/events`, headers: { "content-type": "application/json" }, body: json(body) }], redact: [token] };
}
