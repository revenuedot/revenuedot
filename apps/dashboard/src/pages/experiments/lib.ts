import { useQuery } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";
import { EXPERIMENT_METRICS, EXPERIMENT_TYPES, type MetricDef } from "@revenuedot/core";
import { api, type List } from "../../lib/api";
import { listAll, v2, type Offering } from "../catalog/lib";
import type { Rules } from "../../components/conditions";

/** Experiments in the dashboard (prd/experiments/PRD.md): API shapes, queries and words shared by the pages. */

export interface Variant { id: string; name: string; offering_id: string; placements: Record<string, string | null> }
export type Status = "draft" | "running" | "paused" | "stopped";
export interface Experiment {
  id: string; name: string; type: string; status: Status; primary_metric: string; secondary_metrics: string[]; notes: string;
  enrollment: "new" | "new_and_existing"; track_paywall_views: boolean; audience_id: string | null; audience_rules: Rules | null;
  enrollment_percent: number; priority: number; variants: Variant[]; started_at: number | null; paused_at: number | null; stopped_at: number | null;
  created_at: number; updated_at: number | null; enrolled_customers?: number;
}
export interface Audience { id: string; name: string; rules: Rules; created_at: number }
export interface TargetingRule { id: string; name: string; audience_id: string | null; offering_id: string; placements: Record<string, string | null>; position: number; state: "active" | "inactive"; starts_at: number | null; ends_at: number | null; revision: number }

export interface MetricValue { value: number | null; numerator?: number; denominator?: number; lower?: number | null; upper?: number | null; lift?: number | null; lift_lower?: number | null; lift_upper?: number | null; chance_to_beat_control?: number | null }
export interface VariantResult { id: string; name: string; offering_id: string | null; customers: number; paywall_viewers: number; metrics: Record<string, MetricValue> }
export interface Results {
  experiment_id: string; environment: "production" | "sandbox"; computed_at: number; primary_metric: string; secondary_metrics: string[]; control_variant_id: string;
  filters: { platform: string | null; country: string | null; paywall: "all" | "viewed" | "not_viewed" }; filter_options: { platforms: string[]; countries: string[] };
  variants: List<VariantResult>;
  guidance: { enough_data: boolean; min_customers: number; min_events: number; customers_needed_per_variant: number | null; leader: { variant_id: string; chance_to_beat_control: number } | null; message: string };
  series: { days: number[]; values: Record<string, Record<string, (number | null)[]>> };
}

export const STATUS_TONE: Record<Status, "up" | "gold" | "muted" | "info"> = { draft: "muted", running: "up", paused: "gold", stopped: "info" };
export const statusLabel = (s: Status) => s[0]!.toUpperCase() + s.slice(1);
export const typeName = (id: string) => EXPERIMENT_TYPES.find((t) => t.id === id)?.name ?? "Other";
export const metric = (id: string): MetricDef => EXPERIMENT_METRICS.find((m) => m.id === id) ?? { id, name: id, kind: "count", unit: "#", better: "higher", description: "" };

/** A metric value in its unit: 12.4%, $3.20, 1,204. */
export function formatMetric(id: string, v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const m = metric(id);
  if (m.unit === "%") return `${(v * 100).toFixed(v * 100 < 10 ? 1 : 0).replace(/\.0$/, "")}%`;
  if (m.unit === "$") return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Math.round(v).toLocaleString("en-US");
}
export const signedPct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
export const pct0 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

export const useExperiments = (pid: string) => useQuery({ queryKey: ["experiments", pid], enabled: !!pid, queryFn: () => listAll<Experiment>(`${v2(pid)}/experiments`) });
export const useAudiences = (pid: string) => useQuery({ queryKey: ["audiences", pid], enabled: !!pid, queryFn: async () => (await api<List<Audience>>(`${v2(pid)}/audiences`)).items });
export const useRules = (pid: string) => useQuery({ queryKey: ["targeting-rules", pid], enabled: !!pid, queryFn: async () => (await api<List<TargetingRule>>(`${v2(pid)}/targeting_rules`)).items });
/** Offerings with their packages and products (the duplicate dialog swaps products). */
export const useOfferingsFull = (pid: string) => useQuery({ queryKey: ["offering-list-full", pid], enabled: !!pid, queryFn: () => listAll<Offering>(`${v2(pid)}/offerings?expand=items.package.product`) });

/** Opens RevenueDot AI on a new conversation that asks `text`, the way the Overview's Ask bar does. */
export async function askAssistant(pid: string, text: string, nav: NavigateFunction) {
  const conv = await api<{ id: string }>(`${v2(pid)}/ai/conversations`, { method: "POST", json: {} });
  nav(`/projects/${pid}/ai/${conv.id}`, { state: { pending: { text, files: [] } } });
}

/** What each starter category asks the user to change in the treatment offering. */
export const TREATMENT_HELP: Record<string, string> = {
  introductory_offer: "Swap each package's product for one with an introductory price, set up in the store.",
  free_trial_offer: "Swap each package's product for one with a longer, shorter or no free trial.",
  paywall_design: "Keep the packages; a copy of the control's paywall is made for you to change.",
  price_point: "Swap each package's product for one with another price.",
  subscription_duration: "Swap a package's product for one with another period, such as annual for monthly.",
  subscription_ordering: "Drag the packages into another order. The first package is the one the paywall selects by default.",
  other: "Change any package's product or the order.",
};
