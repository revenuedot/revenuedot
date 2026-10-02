import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FunnelDoc, FunnelTheme, PageLook, PagePackage } from "@revenuedot/core/funnels";
import { api } from "../../lib/api";
import { listAll, v2, type Product } from "../catalog/lib";

/** Web billing data (prd/web-billing/PRD.md): RevenueDot's extension endpoints and RevenueCat's v2 discounts. */

export interface Domain {
  object: "web_domain"; slug: string; pay_base: string; default_base: string; base: string; custom_domain: string | null;
  status: "none" | "pending" | "verified" | "failed"; verified_at: number | null; checked_at: number | null; error: string | null;
  dns: { type: "CNAME" | "TXT"; name: string; value: string }[]; cloud_note: string | null; found?: { cname: string[] | null; txt: string[] | null };
}
export interface StripeKeyHint { configured: boolean; mode: "test" | "live" | null; kind: "restricted" | "secret" | "other" | null; last4: string | null }
export interface Provider {
  object: "web_provider"; id: string; name: string; type: "stripe"; public_key: string; key: StripeKeyHint; web_config: boolean; created_at: number;
  /** How the app reaches Stripe: "Connect with Stripe", a restricted key, or not yet (prd/web-billing/PRD.md §8). */
  connection: "stripe_connect" | "restricted_key" | null; connected_account: string | null; mode: "live" | "test" | null;
}
export interface WebOverview {
  object: "web_overview"; pay_base: string; project_base: string; domain: Domain; providers: Provider[];
  checklist: { connect_stripe: boolean; web_config: boolean; web_products: boolean; offering: boolean };
  web_products: number; offerings_with_web_products: string[];
}
export interface WebConfig {
  object: "web_config"; app_id: string; saved: boolean; updated_at: number | null; presets: { name: string; theme: FunnelTheme }[];
  app_name: string; logo_url: string | null; theme: FunnelTheme; terms_url: string | null; privacy_url: string | null; support_email: string | null;
  success_mode: "show_redemption" | "redirect"; success_redirect_url: string | null; success_title: string | null; success_body: string | null;
  cancel_url: string | null; app_scheme: string; app_store_url: string | null; play_store_url: string | null; redemption_link_hours: number;
}
export interface WebProduct {
  object: "web_product"; product: Product; stripe_product_id: string; stripe_price_id: string;
  price: { amount: number; amount_minor: number; currency: string }; interval: string | null; interval_count: number | null; trial_days: number | null; created_at: number;
}
export interface PurchaseLink {
  object: "purchase_link"; id: string; name: string; slug: string; app_id: string; offering_id: string; offering_lookup_key: string | null; offering_display_name: string | null;
  discount_id: string | null; expires_at: number | null; disabled_at: number | null; status: "active" | "disabled" | "expired"; url: string; checkouts: number; purchases: number; created_at: number;
}
export interface FunnelSummary {
  object: "funnel"; id: string; name: string; slug: string; app_id: string | null; status: "published" | "draft"; has_unpublished_changes: boolean; url: string;
  published_at: number | null; created_at: number; updated_at: number; steps: number; views_30d?: number; purchases_30d?: number;
}
export interface Funnel extends FunnelSummary { draft: FunnelDoc; problems: { path: string; message: string }[] }
export interface PreviewData {
  object: "funnel_preview_data"; app_id: string | null; look: PageLook; packages: Record<string, PagePackage[]>; presets: { name: string; theme: FunnelTheme }[];
  offerings: { id: string; lookup_key: string; display_name: string; is_current: boolean; web_packages: number }[];
  discounts: { id: string; name: string; identifier: string }[];
}
export interface FunnelAnalytics {
  object: "funnel_analytics"; funnel_id: string; days: number; views: number; checkouts: number; purchases: number; conversion: number; revenue_usd: number;
  steps: { id: string; type: string; title: string; viewed: number; completed: number; drop_off: number }[];
  daily: { date: string; views: number; purchases: number }[];
}
export interface WebDiscount {
  object: "web_discount"; id: string; identifier: string; customer_facing_name: string; type: "percentage" | "fixed_amount"; percentage?: number; fixed_amount?: Record<string, number>;
  duration_mode: "one_time" | "time_window" | "forever"; time_window: string | null; eligibility: string; disabled_at: number | null; created_at: number; updated_at: number;
  label: string; product_identifiers: string[]; max_redemptions: number | null; expires_at: number | null; times_redeemed: number;
  status: "active" | "disabled" | "expired" | "used_up"; stripe: { app_id: string; coupon_id: string }[];
  codes: { code: string; times_redeemed: number; created_at: number }[];
}

export const webKey = (pid: string) => ["web", pid] as const;

export const useWeb = (pid: string) => useQuery({ queryKey: [...webKey(pid), "overview"], queryFn: () => api<WebOverview>(`${v2(pid)}/web`), enabled: !!pid });
export const useWebConfig = (pid: string, appId: string | null | undefined) =>
  useQuery({ queryKey: [...webKey(pid), "config", appId], queryFn: () => api<WebConfig>(`${v2(pid)}/apps/${appId}/web_config`), enabled: !!pid && !!appId });
/** Web products of every Stripe app in the project. */
export const useWebProducts = (pid: string, appIds: string[]) => useQuery({
  queryKey: [...webKey(pid), "products", appIds.join(",")], enabled: !!pid && appIds.length > 0,
  queryFn: async () => (await Promise.all(appIds.map((a) => listAll<WebProduct>(`${v2(pid)}/apps/${a}/web_products`)))).flat().sort((a, b) => a.created_at - b.created_at),
});
export const usePurchaseLinks = (pid: string) => useQuery({ queryKey: [...webKey(pid), "links"], queryFn: () => listAll<PurchaseLink>(`${v2(pid)}/purchase_links`), enabled: !!pid });
export const useFunnels = (pid: string) => useQuery({ queryKey: [...webKey(pid), "funnels"], queryFn: () => listAll<FunnelSummary>(`${v2(pid)}/funnels`), enabled: !!pid });
export const useFunnelAi = (pid: string) => useQuery({ queryKey: [...webKey(pid), "funnel-ai"], queryFn: () => api<{ available: boolean; max_prompt_length: number }>(`${v2(pid)}/funnels/ai`), enabled: !!pid, staleTime: 300_000 });
export const useWebDiscounts = (pid: string) => useQuery({ queryKey: [...webKey(pid), "discounts"], queryFn: () => listAll<WebDiscount>(`${v2(pid)}/web_discounts`), enabled: !!pid });
export const useDomain = (pid: string) => useQuery({ queryKey: [...webKey(pid), "domain"], queryFn: () => api<Domain>(`${v2(pid)}/web_domain`), enabled: !!pid });

/** Every web mutation refreshes all web data: the checklist, links, funnels and discounts read each other. */
export function useRefreshWeb(pid: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: webKey(pid) }), qc.invalidateQueries({ queryKey: ["catalog", pid] })]);
}

const PERIOD: Record<string, string> = { P1W: "week", P1M: "month", P3M: "3 months", P6M: "6 months", P1Y: "year" };
export const WEB_DURATIONS: { iso: string; label: string }[] = [
  { iso: "P1W", label: "Weekly" }, { iso: "P1M", label: "Monthly" }, { iso: "P3M", label: "Every 3 months" }, { iso: "P6M", label: "Every 6 months" }, { iso: "P1Y", label: "Yearly" },
];

/** "$9.99 / month", "$99.00 once". */
export function webPrice(w: Pick<WebProduct, "price" | "interval" | "interval_count">) {
  let amount: string;
  try { amount = w.price.amount.toLocaleString("en-US", { style: "currency", currency: w.price.currency }); } catch { amount = `${w.price.amount} ${w.price.currency}`; }
  if (!w.interval) return `${amount} once`;
  const n = w.interval_count ?? 1;
  const iso = `P${n}${w.interval === "week" ? "W" : w.interval === "month" ? "M" : w.interval === "year" ? "Y" : "D"}`;
  return `${amount} / ${PERIOD[iso] ?? `${n} ${w.interval}${n === 1 ? "" : "s"}`}`;
}

export const ELIGIBILITY: { value: string; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "never_purchased", label: "Customers who never bought anything" },
  { value: "never_subscribed", label: "Customers who never subscribed" },
  { value: "never_subscribed_to_the_same_product", label: "Customers who never had this product" },
];

/** A date input (yyyy-mm-dd) as the end of that day in ms; null when empty. */
export const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).getTime() : null);
export const dateInput = (ms: number | null | undefined) => {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
