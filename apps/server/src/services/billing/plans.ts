/**
 * RevenueDot Cloud plans (prd/cloud-billing/PRD.md). The numbers are company/docs/business-model.md, decided 2026-09-30
 * and still working assumptions: Free up to $10,000 tracked revenue a month; Standard 0.5% of tracked revenue above
 * $10,000, capped at $999 a month, for apps up to $1,000,000 a month; Enterprise from $50,000 a year by contract.
 * REVENUEDOT_BILLING_PLANS (JSON, same shape) replaces the table without a deploy; a plan it gives without `includes`,
 * `ee_features` or `audit_log_days` keeps the built-in plan's values for them.
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
  /** What the plan adds, one short line each, for the Billing page. */
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

/** Organizations, custom roles and single sign-on: the team features Cloud Standard adds. */
export const STANDARD_EE_FEATURES = ["organizations", "custom_roles", "sso"];
/** Cloud Free and Standard keep audit log entries this many days. */
export const CLOUD_AUDIT_LOG_DAYS = 90;

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free", name: "Cloud Free", price_label: "$0", description: "Up to $10,000 tracked revenue a month.",
    free_up_to_usd: 10_000, rate: 0, cap_usd: 0, limit_usd: 10_000, self_serve: false,
    includes: ["Every open-source feature, unlimited apps and teammates", "Audit log kept 90 days", "Community and email support"],
    ee_features: [], audit_log_days: CLOUD_AUDIT_LOG_DAYS, features: { sla: false },
  },
  {
    id: "standard", name: "Cloud Standard", price_label: "0.5% above $10K", description: "0.5% of tracked revenue above $10,000 a month, never more than $999 a month. The rate never rises. For apps up to $1M a month.",
    free_up_to_usd: 10_000, rate: 0.005, cap_usd: 999, limit_usd: 1_000_000, self_serve: true,
    includes: ["Organizations and custom roles", "Single sign-on with SAML or OpenID Connect", "Email support, first reply within 2 business days"],
    ee_features: STANDARD_EE_FEATURES, audit_log_days: CLOUD_AUDIT_LOG_DAYS, features: { sla: false },
  },
  {
    id: "enterprise", name: "Enterprise", price_label: "From $50K a year", description: "Custom pricing for apps above $1M a month or with security, legal or support requirements.",
    free_up_to_usd: 0, rate: 0, cap_usd: null, limit_usd: null, self_serve: false,
    includes: ["SCIM provisioning and compliance exports", "Audit log kept 30 days to 10 years", "99.9% uptime SLA, 1-hour support when purchases fail", "Commercial licence to self-host"],
    ee_features: ["*"], audit_log_days: null, features: { sla: true },
  },
];

export function plansFrom(json: string | undefined | null): Plan[] {
  if (!json?.trim()) return DEFAULT_PLANS;
  try {
    const parsed = JSON.parse(json) as Plan[];
    if (!Array.isArray(parsed) || !parsed.some((p) => p.id === "free")) throw new Error("needs a free plan");
    // Older tables (before 2026-10-02) have no feature fields: keep the built-in plan's, so the gates never fall open or shut by accident.
    return parsed.map((p) => {
      const d = DEFAULT_PLANS.find((x) => x.id === p.id) ?? DEFAULT_PLANS[0]!;
      return { ...p, includes: p.includes ?? d.includes, ee_features: Array.isArray(p.ee_features) ? p.ee_features : d.ee_features, audit_log_days: p.audit_log_days === undefined ? d.audit_log_days : p.audit_log_days, features: { sla: !!p.features?.sla } };
    });
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
