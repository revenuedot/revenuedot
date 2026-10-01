/**
 * RevenueDot Cloud plans (prd/cloud-billing/PRD.md). The numbers are company/docs/business-model.md, decided 2026-09-30
 * and still working assumptions: Free up to $10,000 tracked revenue a month; Standard 0.5% of tracked revenue above
 * $10,000, capped at $999 a month, for apps up to $1,000,000 a month; Enterprise from $50,000 a year by contract.
 * REVENUEDOT_BILLING_PLANS (JSON, same shape) replaces the table without a deploy.
 */

export type PlanId = "free" | "standard" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  price_label: string;
  description: string;
  /** Tracked revenue a month that costs nothing (USD). */
  free_up_to_usd: number;
  /** Share of tracked revenue above `free_up_to_usd` (0.005 = 0.5%). */
  rate: number;
  /** Most a month can cost (USD); null: no cap. */
  cap_usd: number | null;
  /** Tracked revenue a month this plan is meant for (USD); above it the next plan fits. Null: no limit. */
  limit_usd: number | null;
  /** Upgrade through Stripe Checkout (Standard), or talk to us (Enterprise). */
  self_serve: boolean;
  /** Features a plan includes, for gates Kai may turn on later (none is enforced today). */
  features: { sla: boolean; sso: boolean; audit_log_retention: boolean; region_choice: boolean };
}

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free", name: "Cloud Free", price_label: "$0", description: "Up to $10,000 tracked revenue a month.",
    free_up_to_usd: 10_000, rate: 0, cap_usd: 0, limit_usd: 10_000, self_serve: false,
    features: { sla: false, sso: false, audit_log_retention: false, region_choice: false },
  },
  {
    id: "standard", name: "Cloud Standard", price_label: "0.5% above $10K", description: "0.5% of tracked revenue above $10,000 a month, never more than $999 a month. The rate never rises. For apps up to $1M a month.",
    free_up_to_usd: 10_000, rate: 0.005, cap_usd: 999, limit_usd: 1_000_000, self_serve: true,
    features: { sla: false, sso: false, audit_log_retention: false, region_choice: false },
  },
  {
    id: "enterprise", name: "Enterprise", price_label: "From $50K a year", description: "A support promise, single sign-on, audit log retention and data-location controls, on standard terms.",
    free_up_to_usd: 0, rate: 0, cap_usd: null, limit_usd: null, self_serve: false,
    features: { sla: true, sso: true, audit_log_retention: true, region_choice: true },
  },
];

export function plansFrom(json: string | undefined | null): Plan[] {
  if (!json?.trim()) return DEFAULT_PLANS;
  try {
    const parsed = JSON.parse(json) as Plan[];
    if (!Array.isArray(parsed) || !parsed.some((p) => p.id === "free")) throw new Error("needs a free plan");
    return parsed;
  } catch (e) {
    console.error(`REVENUEDOT_BILLING_PLANS is not valid (${e instanceof Error ? e.message : e}); using the built-in plans.`);
    return DEFAULT_PLANS;
  }
}

export const planOf = (plans: Plan[], id: string | null | undefined): Plan => plans.find((p) => p.id === id) ?? plans.find((p) => p.id === "free")!;

/**
 * The bill for a month's tracked revenue, in cents, computed in whole cents so it never drifts: the part above the free
 * amount times the rate, rounded to the cent, then capped. Enterprise is billed by contract (0 here).
 */
export function billCents(plan: Plan, trackedUsd: number): number {
  if (plan.id === "enterprise" || plan.rate <= 0) return 0;
  const tracked = Math.round(Math.max(0, trackedUsd) * 100);
  const over = Math.max(0, tracked - Math.round(plan.free_up_to_usd * 100));
  const bill = Math.round(over * plan.rate);
  return plan.cap_usd === null ? bill : Math.min(bill, Math.round(plan.cap_usd * 100));
}

/** "YYYY-MM" of a date (UTC) and the month's bounds. */
export const monthOf = (d: Date) => d.toISOString().slice(0, 7);
export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}
export const previousMonth = (month: string) => monthOf(new Date(monthBounds(month).start.getTime() - 86_400_000));
