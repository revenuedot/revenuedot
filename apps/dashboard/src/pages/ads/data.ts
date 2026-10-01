/** Shapes of the Ads API (RevenueDot extension; prd/ads/PRD.md) and shared wording for the Ads pages. */
import { useQuery } from "@tanstack/react-query";
import { api, type List } from "../../lib/api";

export const v2 = (pid: string) => `/v2/projects/${encodeURIComponent(pid)}`;

export interface AdTotals {
  ad_revenue: number; impressions: number; ecpm: number | null; clicks: number; ctr: number | null; loaded: number; failed_to_load: number; fill_rate: number | null; revenue_events: number;
}
export interface Breakdown { key: string; ad_revenue: number; impressions: number; ecpm: number | null; clicks: number; share: number; name?: string | null; unit_format?: string | null }
export interface AdsOverview {
  object: "ads_overview"; range: string; environment: "production" | "sandbox"; start_date: string; end_date: string; has_ad_events: boolean;
  totals: AdTotals & { ad_customers: number; subscription_revenue: number; total_revenue: number; ad_share: number | null };
  previous: AdTotals & { subscription_revenue: number };
  series: { date: string; ad_revenue: number; impressions: number; ecpm: number | null; clicks: number; subscription_revenue: number }[];
  by_network: Breakdown[]; by_format: Breakdown[]; by_placement: Breakdown[]; by_ad_unit: Breakdown[]; by_mediator: Breakdown[];
  unconverted: { currency: string; amount: number }[];
  ad_units_loaded: number;
}

export interface RewardRule {
  object: "ad_reward_rule"; id: string; name: string; enabled: boolean; position: number; app_id: string | null; ad_unit_id: string | null; reward_item: string | null;
  kind: "virtual_currency" | "entitlement"; currency_code: string | null; amount: number | null; multiplier: number | null; entitlement_id: string | null; duration_minutes: number | null;
}
export type SdkReward = { type: "virtual_currency"; code: string; amount: number } | { type: "entitlement"; identifier: string; expires_at: string };
export interface RewardVerification {
  object: "ad_reward_verification"; id: string; app_id: string | null; app_user_id: string; client_transaction_id: string; network: string; network_transaction_id: string;
  ad_unit_id: string | null; reward_item: string | null; reward_amount: number | null; status: "verified" | "failed" | "pending"; failure_reason: string | null; failure_message: string | null;
  rule_id: string | null; rewards: SdkReward[]; is_sandbox: boolean; occurred_at: number; created_at: number;
}
export interface AdMobConnection {
  object: "admob_connection"; connected: boolean; oauth_client: "server" | "project" | null; client_id: string | null; client_secret: { configured: boolean; hint: string | null };
  connected_at: number | null; accounts: { id: string; currency: string | null }[]; last_sync_at: number | null; last_sync_error: string | null;
  ad_units: { ad_unit_id: string; name: string; format: string | null; account_id: string | null; app_id: string | null; updated_at: number }[];
  redirect_uri: string; ssv_callback_url: string;
}

export const useAdMob = (pid: string) => useQuery({ queryKey: ["admob", pid], queryFn: () => api<AdMobConnection>(`${v2(pid)}/ads/admob`), enabled: !!pid });
export const useRewardRules = (pid: string) => useQuery({ queryKey: ["reward_rules", pid], queryFn: async () => (await api<List<RewardRule>>(`${v2(pid)}/ads/reward_rules`)).items, enabled: !!pid });

export const FORMAT_LABEL: Record<string, string> = {
  banner: "Banner", interstitial: "Interstitial", rewarded: "Rewarded", rewarded_interstitial: "Rewarded interstitial", native: "Native", app_open: "App open", other: "Other",
};

export function rewardText(r: SdkReward): string {
  return r.type === "virtual_currency" ? `${r.amount.toLocaleString("en-US")} ${r.code}` : `${r.identifier} until ${new Date(r.expires_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

export function ruleGrantText(r: RewardRule): string {
  if (r.kind === "virtual_currency") return r.multiplier ? `${r.multiplier}× the network's amount of ${r.currency_code}` : `${(r.amount ?? 0).toLocaleString("en-US")} ${r.currency_code}`;
  const m = r.duration_minutes ?? 0;
  const span = m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`;
  return `${r.entitlement_id} for ${span}`;
}
