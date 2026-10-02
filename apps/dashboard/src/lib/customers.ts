import { formatUsd } from "./prefs";
/** Types and wording shared by the Overview and the customer pages. Shapes follow RevenueCat's API v2 plus our extensions. */
import { STORE_LABEL } from "../components/ui";

export interface Customer {
  object: "customer"; id: string; project_id: string; first_seen_at: number; last_seen_at: number | null;
  last_seen_app_version: string | null; last_seen_country: string | null; last_seen_platform: string | null;
  active_entitlements?: { items: { entitlement_id: string; expires_at: number | null }[] };
  attributes?: { items: Attribute[] };
  experiment?: { id: string; name: string; variant: string } | null;
}
export interface Attribute { name: string; value: string; updated_at: number }

export interface CustomerSummary {
  id: string; original_app_user_id: string; aliases: string[]; total_revenue_in_usd: number; sandbox_revenue_in_usd: number;
  country: string | null; platform: string | null; stores: string[];
  offering_override: { id: string; lookup_key: string; display_name: string } | null;
  /** Older servers leave it out. */
  current_offering?: { id: string; lookup_key: string; display_name: string; source: "override" | "experiment" | "targeting" | "default"; rule_id?: string; rule_name?: string | null; experiment_id?: string; experiment_name?: string | null; variant?: string; variant_name?: string } | null;
  /** On the project's block list (through any alias): no entitlements anywhere. */
  blocked?: boolean;
  active_entitlements: { entitlement_id: string; lookup_key: string; display_name: string; expires_at: number | null; source: "purchase" | "promotional"; product_identifier: string | null }[];
  granted_entitlements: { entitlement_id: string; lookup_key: string; display_name: string; granted_at: number; expires_at: number | null }[];
  subscriptions: { id: string; product_identifier: string; product_display_name: string | null; duration: string | null; period_type: string; price: { amount: number; currency: string } | null; price_in_usd: number | null; will_renew_product_identifier: string | null }[];
  purchases: { id: string; product_identifier: string; product_display_name: string | null; is_consumable: boolean; price: { amount: number; currency: string } | null }[];
}

export interface Money { currency: string; gross: number; commission: number; tax: number; proceeds: number }
export interface Subscription {
  id: string; product_id: string | null; starts_at: number; current_period_starts_at: number; current_period_ends_at: number | null; ends_at: number | null;
  gives_access: boolean; pending_payment: boolean; auto_renewal_status: string; status: string; total_revenue_in_usd: Money;
  environment: "production" | "sandbox"; store: string; store_subscription_identifier: string; ownership: string; country?: string;
  entitlements: { items: { id: string; lookup_key: string; display_name: string }[] };
}
export interface Purchase {
  id: string; product_id: string; purchased_at: number; revenue_in_usd: Money; quantity: number; status: "owned" | "refunded";
  environment: "production" | "sandbox"; store: string; store_purchase_identifier: string; country?: string;
  entitlements: { items: { id: string; lookup_key: string; display_name: string }[] };
}
export interface CustomerEvent { id: string; app_id: string | null; type: string; body: Record<string, unknown>; created_at: number; occurred_at: number }

export interface Transaction {
  id: string; customer_id: string; app_id: string | null; store: string; store_transaction_id: string; product_identifier: string;
  kind: "trial" | "purchase" | "renewal" | "refund" | "one_time" | string; environment: "production" | "sandbox";
  purchased_at: number; expires_at: number | null; revenue_in_usd: number; price: { amount: number; currency: string } | null; country: string | null;
  /** On the account overview (GET /v2/transactions): the project the transaction belongs to. */
  project_id?: string;
}
export interface Entitlement { id: string; lookup_key: string; display_name: string; state?: string }
export interface Offering { id: string; lookup_key: string; display_name: string; is_current: boolean; state?: string }
export interface Product {
  id: string; store_identifier: string; type: string; display_name: string | null; app_id: string; subscription?: { duration: string | null };
  /** With expand=items.indicative_price: the Test Store price, null when there is none. */
  indicative_price?: { amount_micros: number; currency: string } | null;
}
export interface App { id: string; name: string; type: string; created_at: number }

/** A country code as its flag (data, not decoration: DESIGN.md allows flags in customer rows). */
export function flag(cc: string | null | undefined) {
  if (!cc || !/^[A-Za-z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export const storeLabel = (s: string) => STORE_LABEL[s] ?? STORE_LABEL[s.toLowerCase()] ?? s;

/** Long ids shortened in the middle, like the mockup's "wjqx…2rn1"; the full id goes in a title or copy button. */
export function shortId(id: string, max = 14) {
  if (id.length <= max) return id;
  const body = id.startsWith("$RCAnonymousID:") ? id.slice(15) : id;
  return `${body.slice(0, 5)}…${body.slice(-4)}`;
}

export const isAnonymous = (id: string) => id.startsWith("$RCAnonymousID:");

/**
 * Money with cents, or "—". Negative amounts (refunds) keep a real minus sign. Without a currency the amount is one of
 * the API's USD values and is shown in the display currency; with one (a store price) it stays in that currency.
 */
export function money(n: number | null | undefined, currency?: string) {
  if (n === null || n === undefined) return "—";
  const s = currency ? Math.abs(n).toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }) : formatUsd(Math.abs(n), true);
  return n < 0 ? `−${s}` : s;
}

const UNITS: Record<string, [string, string]> = { D: ["day", "days"], W: ["week", "weeks"], M: ["month", "months"], Y: ["year", "years"] };
/** ISO 8601 duration as words: P1M → "1 month", P1Y → "1 year". */
export function durationWords(iso: string | null | undefined) {
  const m = iso ? /^P(\d+)([DWMY])$/.exec(iso) : null;
  if (!m) return iso ?? null;
  const n = Number(m[1]);
  return `${n} ${UNITS[m[2]!]![n === 1 ? 0 : 1]}`;
}

/** Per-period suffix: P1M → "month", P3M → "3 months". */
export function per(iso: string | null | undefined) {
  const m = iso ? /^P(\d+)([DWMY])$/.exec(iso) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return n === 1 ? UNITS[m[2]!]![0] : `${n} ${UNITS[m[2]!]![1]}`;
}

/** Relative time in either direction: "in 6 days", "3 h ago". */
export function relative(ms: number | null | undefined, now = Date.now()) {
  if (!ms) return "—";
  const diff = ms - now;
  const s = Math.round(Math.abs(diff) / 1000);
  const v = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
  return diff >= 0 ? `in ${v}` : `${v} ago`;
}

export const TX_TAG: Record<string, { label: string; tone: "up" | "down" | "info" | "gold" | "muted" }> = {
  trial: { label: "Trial", tone: "info" }, purchase: { label: "Initial", tone: "gold" }, renewal: { label: "Renewal", tone: "up" },
  refund: { label: "Refund", tone: "down" }, one_time: { label: "One-time", tone: "gold" },
};

export const SUB_STATUS: Record<string, { label: string; tone: "up" | "down" | "info" | "gold" | "muted" }> = {
  trialing: { label: "Trial", tone: "info" }, active: { label: "Active", tone: "up" }, expired: { label: "Expired", tone: "muted" },
  in_grace_period: { label: "Grace period", tone: "down" }, in_billing_retry: { label: "Billing retry", tone: "down" }, paused: { label: "Paused", tone: "muted" },
  unknown: { label: "Unknown", tone: "muted" }, incomplete: { label: "Incomplete", tone: "muted" },
};
export const RENEWAL: Record<string, string> = {
  will_renew: "Will renew", will_not_renew: "Will not renew", will_change_product: "Will change product", will_pause: "Will pause",
  requires_price_increase_consent: "Needs price consent", has_already_renewed: "Already renewed",
};
export const PERIOD_TYPE: Record<string, string> = { normal: "Normal", trial: "Trial", intro: "Intro offer", promotional: "Promotional", prepaid: "Prepaid" };

const CANCEL: Record<string, string> = {
  UNSUBSCRIBE: "Opted out of renewal", BILLING_ERROR: "Cancelled due to a billing error", PRICE_INCREASE: "Cancelled after not agreeing to a price increase",
  CUSTOMER_SUPPORT: "Was issued a refund", DEVELOPER_INITIATED: "Subscription cancelled by the developer", UNKNOWN: "Cancelled for unknown reasons",
};
const EXPIRE: Record<string, string> = {
  UNSUBSCRIBE: "after opting out of renewal", BILLING_ERROR: "after a billing error", PRICE_INCREASE: "after a declined price increase",
  CUSTOMER_SUPPORT: "after a refund", DEVELOPER_INITIATED: "after the developer cancelled it", SUBSCRIPTION_PAUSED: "because it was paused",
};

/** The customer-history sentence for a webhook event, following RevenueCat's timeline wording where it has one. */
export function eventLabel(e: { type: string; body: Record<string, unknown> }, entitlementName?: (lookupKey: string) => string) {
  const b = e.body;
  const promo = String(b.store ?? "").toUpperCase() === "PROMOTIONAL";
  const ents = (b.entitlement_ids as string[] | null | undefined) ?? [];
  const keys = ents.length ? ents : [String(b.product_id ?? "").replace(/^rc_promo_(.+)_\w+$/, "$1")];
  const entName = keys.map((x) => entitlementName?.(x) ?? x).join(", ");
  switch (e.type) {
    case "INITIAL_PURCHASE":
      if (promo) return `Was granted the ${entName} entitlement`;
      return String(b.period_type).toUpperCase() === "TRIAL" ? "Started a trial" : "Started a subscription";
    case "NON_RENEWING_PURCHASE": return promo ? `Was granted the ${entName} entitlement` : "Made a purchase";
    case "RENEWAL": return b.is_trial_conversion ? "Converted from a trial" : "Renewed";
    case "PRODUCT_CHANGE": return b.new_product_id ? `Changed product to ${String(b.new_product_id)}` : "Changed renewal preference";
    case "CANCELLATION":
      if (promo) return "Had their granted entitlement removed";
      return CANCEL[String(b.cancel_reason ?? "UNKNOWN")] ?? "Cancelled";
    case "UNCANCELLATION": return "Resubscribed";
    case "BILLING_ISSUE": return "Had a billing issue";
    case "EXPIRATION": {
      if (promo) return "Granted entitlement expired";
      const why = EXPIRE[String(b.expiration_reason ?? "")];
      return why ? `Subscription expired ${why}` : "Subscription expired";
    }
    case "SUBSCRIPTION_PAUSED": return "Paused the subscription";
    case "SUBSCRIPTION_EXTENDED": return "Subscription was extended";
    case "REFUND_REVERSED": return "Refund was reversed";
    case "TRANSFER": return "Purchases were transferred";
    case "SUBSCRIBER_ALIAS": return "Created a new alias";
    case "TEMPORARY_ENTITLEMENT_GRANT": return "Was granted temporary access during a store outage";
    case "VIRTUAL_CURRENCY_TRANSACTION": return "In-app currency balance changed";
    case "EXPERIMENT_ENROLLMENT": return "Enrolled in an experiment";
    case "PRICE_INCREASE_CONSENT_REQUIRED": return "Was asked to consent to a price increase";
    case "PRICE_INCREASE_CONSENT_APPROVED": return "Consented to a price increase";
    case "INVOICE_ISSUANCE": return "Was issued an invoice";
    case "PURCHASE_REDEEMED": return "Redeemed a web purchase";
    case "TEST": return "Test event";
    default: return e.type.toLowerCase().replace(/_/g, " ");
  }
}

/** Reserved attribute names (RevenueCat's `$` keys) as readable labels, grouped like the customer page's cards. */
export const RESERVED: Record<string, { label: string; group: "Contact" | "Device" | "Attribution" | "Integrations" }> = {
  $email: { label: "Email", group: "Contact" }, $displayName: { label: "Display name", group: "Contact" }, $phoneNumber: { label: "Phone number", group: "Contact" },
  $apnsTokens: { label: "APNs push tokens", group: "Contact" }, $fcmTokens: { label: "FCM push tokens", group: "Contact" },
  $attConsentStatus: { label: "Tracking consent (ATT)", group: "Device" }, $deviceVersion: { label: "Device", group: "Device" }, $ip: { label: "IP address", group: "Device" },
  $idfa: { label: "IDFA", group: "Device" }, $idfv: { label: "IDFV", group: "Device" }, $gpsAdId: { label: "Google advertising ID", group: "Device" },
  $androidId: { label: "Android ID", group: "Device" }, $amazonAdId: { label: "Amazon advertising ID", group: "Device" }, $userAgent: { label: "User agent", group: "Device" },
  $pageUrl: { label: "Page URL", group: "Device" }, $appleRefundHandlingPreference: { label: "Apple refund preference", group: "Device" }, $limitDataSharing: { label: "Limit data sharing", group: "Device" },
  $mediaSource: { label: "Network", group: "Attribution" }, $campaign: { label: "Campaign", group: "Attribution" }, $adGroup: { label: "Ad group", group: "Attribution" },
  $ad: { label: "Ad", group: "Attribution" }, $keyword: { label: "Keyword", group: "Attribution" }, $creative: { label: "Creative", group: "Attribution" },
  $appleAdsCampaignId: { label: "Apple Ads campaign ID", group: "Attribution" }, $appleAdsAdGroupId: { label: "Apple Ads ad group ID", group: "Attribution" },
  $appleAdsKeywordId: { label: "Apple Ads keyword ID", group: "Attribution" }, $appleAdsOrgId: { label: "Apple Ads org ID", group: "Attribution" },
  $appleAdsAdId: { label: "Apple Ads ad ID", group: "Attribution" }, $appleAdsCountryOrRegion: { label: "Apple Ads country", group: "Attribution" },
  $claimType: { label: "Claim type", group: "Attribution" }, $conversionType: { label: "Conversion type", group: "Attribution" }, $supplyPlacement: { label: "Supply placement", group: "Attribution" },
  $fbc: { label: "Meta click ID (fbc)", group: "Attribution" }, $fbp: { label: "Meta browser ID (fbp)", group: "Attribution" },
};
export function attributeLabel(name: string) {
  if (RESERVED[name]) return RESERVED[name];
  if (name.startsWith("$")) return { label: name.slice(1).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()), group: "Integrations" as const };
  return { label: name, group: "Custom" as const };
}
