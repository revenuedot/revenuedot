/**
 * RevenueDot Cloud plans (prd/cloud-billing/PRD.md; company/docs/business-model.md, decided 2026-10-05): Pro, $0 until
 * tracked revenue reaches $10,000 in a month, then 0.5% of tracked revenue above $10,000, capped at $999 a month, for apps
 * up to $1,000,000 a month; Enterprise from $50,000 a year by contract. An account with neither has no plan ("none"): the
 * build stage, free with no card, until its first live sale (services/billing/gate.ts).
 * REVENUEDOT_BILLING_PLANS (JSON, same shape) replaces the table without a deploy; a plan it gives without `includes`,
 * `ee_features` or `audit_log_days` keeps the built-in plan's values for them. Older tables name Pro "standard" and have a
 * "free" plan: "standard" is read as Pro and "free" is dropped.
 */

export type PlanId = "pro" | "enterprise";
/** An account's plan: a plan, or "none" before it starts Pro. */
export type AccountPlan = PlanId | "none";

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
  /** Started through Stripe Checkout (Pro), or by talking to us (Enterprise). */
  self_serve: boolean;
  /** What the plan includes, one short line each, for the Billing page. */
  includes: string[];
  /**
   * The `ee/` features this plan turns on for its account's organizations on RevenueDot Cloud (ee/server/plans.ts reads
   * it; names as in ee/server/license.ts, "*" for all). Decided 2026-10-02 (company/docs/business-model.md, "Plans").
   */
  ee_features: string[];
  /** Days RevenueDot Cloud keeps audit log entries (project and organization logs); null: the organization chooses. */
  audit_log_days: number | null;
  /** Features that are not `ee/` code: the uptime SLA and the support promise (docs/guides/sla.md). */
  features: { sla: boolean };
}

/** Organizations, custom roles and single sign-on: the team features Pro includes. */
export const PRO_EE_FEATURES = ["organizations", "custom_roles", "sso"];
/** Pro, and accounts with no plan, keep audit log entries this many days. */
export const CLOUD_AUDIT_LOG_DAYS = 90;

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "pro", name: "Pro", price_label: "$0 until $10K a month", description: "$0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month. The rate never rises.",
    free_up_to_usd: 10_000, rate: 0.005, cap_usd: 999, limit_usd: 1_000_000, self_serve: true,
    includes: ["Every feature: paywalls, experiments, charts, integrations and webhooks", "Unlimited apps, projects and teammates", "Organizations, custom roles and single sign-on", "Email support, first reply within 2 business days"],
    ee_features: PRO_EE_FEATURES, audit_log_days: CLOUD_AUDIT_LOG_DAYS, features: { sla: false },
  },
  {
    id: "enterprise", name: "Enterprise", price_label: "From $50K a year", description: "Custom pricing for apps above $1M a month or with security, legal or support requirements.",
    free_up_to_usd: 0, rate: 0, cap_usd: null, limit_usd: null, self_serve: false,
    includes: ["Everything in Pro, with volume pricing", "SCIM provisioning and compliance exports", "Audit log kept 30 days to 10 years", "99.9% uptime SLA, 1-hour support when purchases fail", "Commercial licence to run it on your own servers"],
    ee_features: ["*"], audit_log_days: null, features: { sla: true },
  },
];

/**
 * What an account with no plan computes with: nothing billed, no `ee/` features, the Pro audit log. Never listed as a plan
 * and never sold: it is the build stage before Pro.
 */
export const NO_PLAN: Plan = {
  id: "pro", name: "No plan", price_label: "$0", description: "Building and testing are free. Start Pro to go live.",
  free_up_to_usd: 10_000, rate: 0, cap_usd: 0, limit_usd: null, self_serve: false, includes: [], ee_features: [], audit_log_days: CLOUD_AUDIT_LOG_DAYS, features: { sla: false },
};

/** Transaction kinds that earn money: tracked revenue and the first live sale count only these. */
export const PAID_KINDS = ["purchase", "renewal", "one_time"];

/** Plan ids written before 2026-10-05 ("standard" was Pro, "free" was no plan). */
export function accountPlanOf(id: string | null | undefined): AccountPlan {
  if (id === "pro" || id === "standard") return "pro";
  if (id === "enterprise") return "enterprise";
  return "none";
}

export function plansFrom(json: string | undefined | null): Plan[] {
  if (!json?.trim()) return DEFAULT_PLANS;
  try {
    const parsed = JSON.parse(json) as (Omit<Plan, "id"> & { id: string })[];
    if (!Array.isArray(parsed)) throw new Error("needs a list of plans");
    const plans = parsed.filter((p) => p.id !== "free").map((p) => ({ ...p, id: accountPlanOf(p.id) })).filter((p): p is typeof p & { id: PlanId } => p.id !== "none");
    if (!plans.some((p) => p.id === "pro")) throw new Error("needs a pro plan");
    // Older tables (before 2026-10-02) have no feature fields: keep the built-in plan's, so the gates never fall open or shut by accident.
    return plans.map((p) => {
      const d = DEFAULT_PLANS.find((x) => x.id === p.id)!;
      return { ...p, name: p.name === "Cloud Standard" ? d.name : p.name, includes: p.includes ?? d.includes, ee_features: Array.isArray(p.ee_features) ? p.ee_features : d.ee_features, audit_log_days: p.audit_log_days === undefined ? d.audit_log_days : p.audit_log_days, features: { sla: !!p.features?.sla } };
    });
  } catch (e) {
    console.error(`REVENUEDOT_BILLING_PLANS is not valid (${e instanceof Error ? e.message : e}); using the built-in plans.`);
    return DEFAULT_PLANS;
  }
}

/** The plan an account computes with; "none" (or anything unknown) is NO_PLAN. */
export const planOf = (plans: Plan[], id: string | null | undefined): Plan => {
  const a = accountPlanOf(id);
  return a === "none" ? NO_PLAN : plans.find((p) => p.id === a) ?? (a === "pro" ? DEFAULT_PLANS[0]! : DEFAULT_PLANS[1]!);
};

/**
 * The bill for a month's tracked revenue, in cents, computed in whole cents so it never drifts: the part above the free
 * amount times the rate, rounded to the cent, then capped. Enterprise is billed by contract (0 here).
 */
export function billCents(plan: Plan, trackedUsd: number): number {
  if (plan.id === "enterprise" || plan === NO_PLAN || plan.rate <= 0) return 0;
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
