/** Shapes and wording shared by the Lifecycle pages (prd/lifecycle/PRD.md). The API objects are RevenueDot extensions. */
import type { Rules } from "../../components/conditions";

export type Preference = "prefer_refund" | "prefer_prorated_refund" | "prefer_no_refund" | "consumption_only" | "do_not_respond";
export const PREFERENCES: { value: Preference; label: string }[] = [
  { value: "prefer_refund", label: "Prefer full refund" },
  { value: "prefer_prorated_refund", label: "Prefer prorated refund" },
  { value: "prefer_no_refund", label: "Prefer no refund" },
  { value: "consumption_only", label: "Send consumption data only" },
  { value: "do_not_respond", label: "Do not respond to refund requests" },
];
export const preferenceLabel = (p: string | null | undefined) => PREFERENCES.find((x) => x.value === p)?.label ?? "—";

export type Template = "first_purchase_date" | "platform" | "recent_renewal" | "custom";
export interface RefundPolicy { object: "refund_policy"; id: string; name: string; template: Template; rules: Rules; preference: Preference; position: number; customer_count: number }
export interface RefundControl {
  settings: { default_preference: Preference; customer_consented: boolean };
  default_policy: { customer_count: number };
  policies: RefundPolicy[];
  templates: Record<Template, Rules>;
  counts_are_approximate: boolean;
  /** A large project's first exact count is still running (services/customer-counts.ts); the counts are 0 until then. */
  counts_are_counting: boolean;
  counts_counted_at: number | null;
}
export interface RefundStats {
  refund_rate: number | null;
  requests: { approved: number; declined: number; pending: number; total: number };
  amount_in_usd: { approved: number; declined: number; pending: number };
  consumption: Record<string, number>;
}
export interface RefundRequest {
  id: string; app_user_id: string | null; store: string; environment: "production" | "sandbox"; product_id: string | null; amount_in_usd: number | null; reason: string | null;
  requested_at: number; deadline_at: number | null; policy_name: string | null; preference: Preference | null; consumption_status: string; last_error: string | null;
  sent_at: number | null; outcome: "pending" | "approved" | "declined"; outcome_at: number | null;
}

export interface RetentionOffer { id: string; trigger: "cancel" | "refund"; name: string; title: string; subtitle: string; store: "app_store" | "play_store"; product_mapping: Record<string, string>; active: boolean }
export type AppleEnv = "sandbox" | "production";
export interface RetentionMessage { id: string; kind: "text" | "switch_plan" | "promotional_offer"; header: string; body: string; alternate_product_id?: string | null; promotional_offer_id?: string | null; uploaded?: AppleEnv[]; error?: string | null }
export interface Messaging {
  app_id: string; enabled: boolean; messages: RetentionMessage[];
  defaults: { product_id: string; locale: string; message_id: string; configured?: AppleEnv[] }[];
  rules: { product_id: string | null; message_id: string }[];
  realtime_url: string; realtime_url_configured?: Partial<Record<AppleEnv, number>>;
  stats: { requests: number; answered: number; last_request_at: number | null; last_environment: string | null };
  app_apple_id: string | null; has_in_app_purchase_key: boolean;
  sync?: { environment: AppleEnv; errors: string[] };
}
export const MESSAGE_KINDS: { value: RetentionMessage["kind"]; label: string; help: string }[] = [
  { value: "text", label: "Message", help: "Text only. Default messages must be this kind." },
  { value: "switch_plan", label: "Switch plan", help: "Suggests another product in the same subscription group." },
  { value: "promotional_offer", label: "Promotional offer", help: "Offers a discount; RevenueDot signs it with the In-App Purchase key." },
];

export interface WinbackStats { sent: number; failed: number; opened: number; clicked: number; unsubscribed: number; reactivated: number; reactivated_revenue_in_usd: number }
export interface WinbackCampaign {
  id: string; name: string; status: "draft" | "active" | "paused";
  audience: { churned_min_days: number; churned_max_days: number; product_ids: string[]; stores: string[]; audience_id: string | null };
  email: { subject: string; heading: string; body: string; button_label: string; sender_name?: string | null };
  offer: { type: "store" | "url"; url?: string | null };
  send_hour_utc: number; track_opens: boolean; last_run_at: number | null; created_at: number; updated_at: number | null;
  stats?: WinbackStats;
  recent_sends?: { id: string; email: string; sent_at: number; opened_at: number | null; clicked_at: number | null; unsubscribed_at: number | null; error: string | null }[];
}
export const CAMPAIGN_STATUS: Record<WinbackCampaign["status"], { label: string; tone: "up" | "muted" | "gold" }> = {
  draft: { label: "Draft", tone: "muted" }, active: { label: "Active", tone: "up" }, paused: { label: "Paused", tone: "gold" },
};

export interface SupportTicket { id: string; app_id: string | null; app_user_id: string; customer_email: string; description: string; status: "open" | "closed"; emailed_to: string | null; emailed: boolean; created_at: number; closed_at: number | null }

export interface Audience { id: string; name: string; rules: Rules }

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(n * 100 < 10 && n > 0 ? 1 : 0)}%`);
