import { useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router-dom";
import { EXPERIMENT_METRICS, EXPERIMENT_TYPES, type MetricDef } from "@revenuedot/core";
import { api, type List } from "../../lib/api";
import { useMe } from "../../components/Shell";
import { errMsg, listAll, v2, type Offering } from "../catalog/lib";
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
  /** Null when every enrolled customer is counted; otherwise the random sample the numbers come from. */
  sample?: { customers: number; enrolled_customers: number; enrolled_by_variant: Record<string, number> } | null;
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
/** A chance as a whole percentage; never "100%" or "0%", which would claim certainty. */
export const pct0 = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v > 0.99 ? ">99%" : v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);

export const useExperiments = (pid: string) => useQuery({ queryKey: ["experiments", pid], enabled: !!pid, queryFn: () => listAll<Experiment>(`${v2(pid)}/experiments`) });
export const useAudiences = (pid: string) => useQuery({ queryKey: ["audiences", pid], enabled: !!pid, queryFn: async () => (await api<List<Audience>>(`${v2(pid)}/audiences`)).items });
export const useRules = (pid: string) => useQuery({ queryKey: ["targeting-rules", pid], enabled: !!pid, queryFn: async () => (await api<List<TargetingRule>>(`${v2(pid)}/targeting_rules`)).items });
/** Offerings with their packages and products (the duplicate dialog swaps products). */
export const useOfferingsFull = (pid: string) => useQuery({ queryKey: ["offering-list-full", pid], enabled: !!pid, queryFn: () => listAll<Offering>(`${v2(pid)}/offerings?expand=items.package.product`) });

/**
 * Whether the signed-in person may change experiments and targeting in this project. Viewers only read, so their pages
 * show no write controls; the server checks every write (custom roles included) whatever the page shows.
 */
export function useCanEdit(pid: string) {
  const me = useMe();
  return !!me.data && me.data.projects.find((p) => p.id === pid)?.role !== "viewer";
}

/**
 * Saves a drag or arrow-key order: the list moves at once (optimistic), saves run one at a time, and only the latest
 * order is sent after a save in flight, so quick moves never interleave on the server. The list reloads once the
 * last save is done (or failed, which puts the saved order back).
 */
export function useOrderSaver<T>(queryKey: unknown[], apply: (rows: T[], ids: string[]) => T[], post: (ids: string[]) => Promise<unknown>, onDone: (error: string | null) => void) {
  const qc = useQueryClient();
  const busy = useRef(false);
  const next = useRef<string[] | null>(null);
  const send = async (ids: string[]): Promise<void> => {
    if (busy.current) { next.current = ids; return; }
    busy.current = true;
    let error: string | null = null;
    try { await post(ids); } catch (e) { error = errMsg(e); }
    busy.current = false;
    const queued = next.current;
    next.current = null;
    if (queued && !error) return send(queued);
    await qc.invalidateQueries({ queryKey });
    onDone(error);
  };
  return async (ids: string[]) => {
    await qc.cancelQueries({ queryKey });
    qc.setQueryData<T[]>(queryKey, (rows) => (rows ? apply(rows, ids) : rows));
    await send(ids);
  };
}

/** Downloads a CSV export with fetch, so an error shows as a toast instead of replacing the page. */
export async function downloadCsv(url: string, fallbackName: string) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Export failed (${r.status})`);
  }
  const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Opens RevenueDot AI on a new conversation that asks `text`, the way the Overview's Ask bar does. */
export async function askAssistant(pid: string, text: string, nav: NavigateFunction, onCreated?: () => void) {
  const conv = await api<{ id: string }>(`${v2(pid)}/ai/conversations`, { method: "POST", json: {} });
  onCreated?.();
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
