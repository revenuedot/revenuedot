/**
 * Experiment types, metrics and the defaults each type starts with (prd/experiments/PRD.md §1 and §4). The server, the
 * dashboard and RevenueDot AI read these lists, so a metric id means the same thing everywhere.
 */

export const EXPERIMENT_TYPES = [
  { id: "introductory_offer", name: "Introductory offer", hint: "Test an introductory price, such as the first month for $1.99, against the price you charge today." },
  { id: "free_trial_offer", name: "Free trial offer", hint: "Test a longer or shorter free trial, or a trial against none." },
  { id: "paywall_design", name: "Paywall design", hint: "Keep the products and change the paywall: layout, copy, images or the plan selected first." },
  { id: "price_point", name: "Price point", hint: "Test a higher or lower price for the same plan." },
  { id: "subscription_duration", name: "Subscription duration", hint: "Test plan lengths against each other, such as annual against monthly or weekly." },
  { id: "subscription_ordering", name: "Subscription ordering", hint: "Show the same plans in another order, or with another plan first." },
  { id: "other", name: "Other", hint: "Any other change of offerings or placements." },
] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number]["id"];
export const EXPERIMENT_TYPE_IDS = EXPERIMENT_TYPES.map((t) => t.id) as [ExperimentType, ...ExperimentType[]];

/**
 * `rate`: numerator ÷ denominator, Wilson interval. `mean`: per-customer average, normal interval. `count` and `total`:
 * no interval. `better` says which direction wins (refunds and churn are better when lower).
 */
export type MetricKind = "rate" | "mean" | "count" | "total";
export interface MetricDef {
  id: string;
  name: string;
  kind: MetricKind;
  unit: "%" | "$" | "#";
  better: "higher" | "lower";
  description: string;
}

export const EXPERIMENT_METRICS: MetricDef[] = [
  { id: "initial_conversion_rate", name: "Initial conversion rate", kind: "rate", unit: "%", better: "higher", description: "Customers who started a trial, a subscription or bought anything, divided by customers." },
  { id: "initial_conversions", name: "Initial conversions", kind: "count", unit: "#", better: "higher", description: "Customers who started a trial, a subscription or bought anything after joining." },
  { id: "trials_started", name: "Trials started", kind: "count", unit: "#", better: "higher", description: "Free trials started after joining." },
  { id: "trials_completed", name: "Trials completed", kind: "count", unit: "#", better: "higher", description: "Trials that ended or turned into a paid subscription." },
  { id: "trials_converted", name: "Trials converted", kind: "count", unit: "#", better: "higher", description: "Trials followed by a paid period, also through a product change." },
  { id: "trial_conversion_rate", name: "Trial conversion rate", kind: "rate", unit: "%", better: "higher", description: "Trials converted divided by trials completed." },
  { id: "paid_customers", name: "Paid customers", kind: "count", unit: "#", better: "higher", description: "Customers who paid at least once (trials excluded)." },
  { id: "conversion_to_paying", name: "Conversion to paying", kind: "rate", unit: "%", better: "higher", description: "Paid customers divided by customers." },
  { id: "active_subscribers", name: "Active subscribers", kind: "count", unit: "#", better: "higher", description: "Customers with a paid subscription active now." },
  { id: "churned_subscribers", name: "Churned subscribers", kind: "count", unit: "#", better: "lower", description: "Customers who had a paid subscription and have none active now." },
  { id: "refunded_customers", name: "Refunded customers", kind: "count", unit: "#", better: "lower", description: "Customers with at least one refund." },
  { id: "refund_rate", name: "Refund rate", kind: "rate", unit: "%", better: "lower", description: "Refunded customers divided by paid customers." },
  { id: "realized_ltv", name: "Realized LTV", kind: "total", unit: "$", better: "higher", description: "Revenue so far, net of refunds, in USD." },
  { id: "realized_ltv_per_customer", name: "Realized LTV per customer", kind: "mean", unit: "$", better: "higher", description: "Revenue so far divided by customers." },
  { id: "realized_ltv_per_paying_customer", name: "Realized LTV per paying customer", kind: "mean", unit: "$", better: "higher", description: "Revenue so far divided by paid customers." },
  { id: "mrr", name: "MRR", kind: "total", unit: "$", better: "higher", description: "Monthly value of the paid subscriptions active now." },
  { id: "mrr_per_customer", name: "MRR per customer", kind: "mean", unit: "$", better: "higher", description: "MRR divided by customers." },
  { id: "mrr_per_paying_customer", name: "MRR per paying customer", kind: "mean", unit: "$", better: "higher", description: "MRR divided by paid customers." },
];
export const METRIC_IDS = EXPERIMENT_METRICS.map((m) => m.id);
export const metricDef = (id: string) => EXPERIMENT_METRICS.find((m) => m.id === id);
/** A primary metric needs an interval: rates and per-customer means. */
export const PRIMARY_METRIC_IDS = EXPERIMENT_METRICS.filter((m) => m.kind === "rate" || m.kind === "mean").map((m) => m.id);

export const TYPE_DEFAULTS: Record<ExperimentType, { primary: string; secondary: string[] }> = {
  introductory_offer: { primary: "conversion_to_paying", secondary: ["initial_conversion_rate", "realized_ltv_per_customer", "churned_subscribers"] },
  free_trial_offer: { primary: "conversion_to_paying", secondary: ["initial_conversion_rate", "trial_conversion_rate", "realized_ltv_per_customer"] },
  paywall_design: { primary: "initial_conversion_rate", secondary: ["conversion_to_paying", "realized_ltv_per_customer"] },
  price_point: { primary: "realized_ltv_per_customer", secondary: ["conversion_to_paying", "initial_conversion_rate", "refund_rate"] },
  subscription_duration: { primary: "realized_ltv_per_customer", secondary: ["conversion_to_paying", "mrr_per_customer", "churned_subscribers"] },
  subscription_ordering: { primary: "initial_conversion_rate", secondary: ["conversion_to_paying", "realized_ltv_per_customer"] },
  other: { primary: "initial_conversion_rate", secondary: ["conversion_to_paying", "realized_ltv_per_customer"] },
};

export const VARIANT_IDS = ["a", "b", "c", "d"] as const;
export const MAX_VARIANTS = 4;
export const variantDefaultName = (id: string) => (id === "a" ? "Control" : `Treatment ${id.toUpperCase()}`);
export const PLACEMENT_ID = /^[a-zA-Z0-9_.-]{1,100}$/;

/** What makes two variants the same test arm: one offering and the same placement offerings. */
export function variantSignature(v: { offering_id: string; placements: Record<string, string | null> }) {
  return JSON.stringify([v.offering_id, Object.entries(v.placements).sort(([a], [b]) => a.localeCompare(b))]);
}
