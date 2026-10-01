import { DOCS, REPORTING, attr, conceptOf, defaultAnalyticsName, isSandbox, json, nameFor, platformOf, revenueUsd, skip, type BuildInput, type Concept, type PartnerDef, type Plan } from "./common.js";

/**
 * Branch: app events through the v2 Events API (https://help.branch.io/apidocs/events-api), `POST
 * https://api2.branch.io/v2/event/standard` for Branch's standard events and `/v2/event/custom` for any other name.
 * Secrets: `branch_key` (key_live_…), `sandbox_branch_key` (key_test_…; sandbox events are sent only with it).
 * Settings: `reporting`.
 * Identity: `$branchId` (else the app user id) as `developer_identity`; device ids from attributes: on iOS `$idfa` or
 * `$idfv` (one is needed, else the event is skipped), on Android `$gpsAdId` (aaid) or `$androidId` (one is needed);
 * `$ip`, `$attConsentStatus` (limit_ad_tracking), and the app and OS version from the customer's last request.
 * Sent: trial starts as START_TRIAL, purchases, trial conversions and renewals as SUBSCRIBE, one-time purchases as
 * PURCHASE (Branch standard events, with `event_data.revenue` in USD and the product as a content item); other steps
 * as custom events named rc_<step>_event. Branch takes no negative revenue, so refunds carry no revenue.
 * Branch has no event id field for dedupe; the RevenueCat event id goes in `custom_data.event_id`.
 */

export const BRANCH_API = "https://api2.branch.io/v2/event";

/** Branch's standard event names (commerce, content and lifecycle): these go to /standard, anything else to /custom. */
export const BRANCH_STANDARD = new Set([
  "ADD_TO_CART", "ADD_TO_WISHLIST", "VIEW_CART", "INITIATE_PURCHASE", "ADD_PAYMENT_INFO", "CLICK_AD", "PURCHASE", "SPEND_CREDITS", "RESERVE", "VIEW_AD",
  "SEARCH", "VIEW_ITEM", "VIEW_ITEMS", "RATE", "SHARE", "INITIATE_STREAM", "COMPLETE_STREAM",
  "COMPLETE_REGISTRATION", "COMPLETE_TUTORIAL", "ACHIEVE_LEVEL", "UNLOCK_ACHIEVEMENT", "INVITE", "LOGIN", "START_TRIAL", "SUBSCRIBE",
]);

export const BRANCH_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "expiration", "product_change", "test",
];

export function branchName(c: Concept): string | null {
  if (!BRANCH_EVENTS.includes(c)) return null;
  if (c === "trial_started") return "START_TRIAL";
  if (c === "initial_purchase" || c === "trial_converted" || c === "renewal") return "SUBSCRIBE";
  if (c === "non_subscription_purchase") return "PURCHASE";
  return defaultAnalyticsName(c);
}

export async function buildBranch(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const c = conceptOf(e);
  if (!c || !BRANCH_EVENTS.includes(c)) return skip(`${e.type} events are not sent to Branch.`);
  const key = isSandbox(e) ? i.secrets.sandbox_branch_key : i.secrets.branch_key;
  if (!key) return skip(isSandbox(e) ? "Sandbox events need a sandbox Branch key (key_test_…)." : "No Branch key is saved.");
  const platform = platformOf(e.store);
  if (platform !== "ios" && platform !== "android") return skip(`${e.store} purchases are not sent to Branch's app events.`);
  const user: Record<string, unknown> = { os: platform === "ios" ? "iOS" : "Android" };
  if (platform === "ios") {
    const idfa = attr(e, "$idfa"), idfv = attr(e, "$idfv");
    if (!idfa && !idfv) return skip("The customer has no $idfa or $idfv attribute, so Branch cannot match the event.");
    if (idfa) user.idfa = idfa;
    if (idfv) user.idfv = idfv;
    const att = attr(e, "$attConsentStatus");
    if (att) user.limit_ad_tracking = att !== "authorized";
  } else {
    const aaid = attr(e, "$gpsAdId"), androidId = attr(e, "$androidId");
    if (!aaid && !androidId) return skip("The customer has no $gpsAdId or $androidId attribute, so Branch cannot match the event.");
    if (aaid) user.aaid = aaid;
    if (androidId) user.android_id = androidId;
  }
  user.developer_identity = attr(e, "$branchId") ?? String(e.app_user_id ?? e.original_app_user_id ?? "");
  user.environment = "FULL_APP";
  const ip = attr(e, "$ip");
  if (ip) user.ip = ip;
  if (i.context?.platformVersion) user.os_version = i.context.platformVersion;
  if (i.context?.appVersion) user.app_version = i.context.appVersion;
  if (e.country_code) user.country = e.country_code;
  const name = nameFor(c, branchName, i.eventNames)!;
  const standard = BRANCH_STANDARD.has(name);
  const custom: Record<string, string> = {};
  const put = (k: string, v: unknown) => { if (v !== null && v !== undefined && v !== "") custom[k] = Array.isArray(v) ? v.join(",") : String(v); };
  put("event_id", e.id); put("event_type", e.type); put("app_user_id", e.app_user_id); put("product_id", e.product_id); put("store", e.store);
  put("environment", e.environment); put("period_type", e.period_type); put("transaction_id", e.transaction_id);
  put("original_transaction_id", e.original_transaction_id); put("cancel_reason", e.cancel_reason); put("expiration_reason", e.expiration_reason);
  put("new_product_id", e.new_product_id);
  const body: Record<string, unknown> = { name, branch_key: key, user_data: user, custom_data: custom };
  const revenue = revenueUsd(e, i.settings.reporting);
  if (revenue > 0) {
    body.event_data = { transaction_id: String(e.transaction_id ?? e.id), currency: "USD", revenue, description: e.product_id ?? undefined };
    if (standard) {
      body.content_items = [{ $content_schema: "COMMERCE_PRODUCT", $canonical_identifier: e.product_id, $sku: e.product_id, $product_name: e.product_id, $price: revenue, $quantity: 1, $currency: "USD" }];
    }
  }
  return {
    name,
    requests: [{ method: "POST", url: `${BRANCH_API}/${standard ? "standard" : "custom"}`, headers: { "content-type": "application/json", accept: "application/json" }, body: json(body) }],
    redact: [key],
  };
}

export const BRANCH: PartnerDef = {
  spec: {
    kind: "branch", name: "Branch", category: "attribution", environment: "both", eventNames: true, docs: `${DOCS}#branch`, api: "documented",
    text: "Send trials, subscriptions and purchases to Branch to attribute revenue to the links and campaigns behind each install.",
    fields: [
      { key: "branch_key", label: "Branch key", type: "secret", required: true, placeholder: "key_live_…", hint: "In Branch, Account Settings → Profile: the live Branch Key." },
      { key: "sandbox_branch_key", label: "Sandbox Branch key", type: "secret", placeholder: "key_test_…", hint: "The test Branch Key. Without it sandbox events are not sent." },
      REPORTING,
    ],
  },
  events: BRANCH_EVENTS,
  build: buildBranch,
  defaultName: branchName,
  answerError: (_body, j) => (j && typeof j === "object" && j.error ? `Branch rejected the event: ${typeof j.error === "object" ? j.error.message ?? JSON.stringify(j.error) : j.error}` : null),
  validate: (_settings, secrets) => {
    if (secrets.branch_key && !secrets.branch_key.startsWith("key_live_")) return { param: "settings.branch_key", message: "use the live Branch key (key_live_…); the test key goes in Sandbox Branch key." };
    if (secrets.sandbox_branch_key && !secrets.sandbox_branch_key.startsWith("key_test_")) return { param: "settings.sandbox_branch_key", message: "use the test Branch key (key_test_…)." };
    return null;
  },
};
