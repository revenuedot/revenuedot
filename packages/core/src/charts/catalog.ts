import type { Resolution } from "./time.js";

/**
 * The chart catalog: every chart RevenueCat's dashboard and API offer, with RevenueCat's API names, grouped the way
 * its chart rail groups them. Definitions are ours; prd/charts/PRD.md explains each one.
 */

export type Unit = "$" | "#" | "%";
export interface MeasureDef {
  id: string;
  display_name: string;
  description: string;
  unit: Unit;
  decimal_precision: number;
  chartable: boolean;
  tabulable: boolean;
  /** A flow (summed over periods) rather than a snapshot or a rate: only flows get a `total` in the summary. */
  flow: boolean;
}
export interface SelectorDef { id: string; display_name: string; default: string; options: { id: string; display_name: string }[] }

export type Dim = "app" | "store" | "product" | "product_duration" | "offering" | "country" | "platform" | "app_version" | "paywall" | "survey_option";
export const DIM_LABEL: Record<Dim, { display_name: string; group: string }> = {
  app: { display_name: "App", group: "Store and product" },
  store: { display_name: "Store", group: "Store and product" },
  product: { display_name: "Product", group: "Store and product" },
  product_duration: { display_name: "Product duration", group: "Store and product" },
  offering: { display_name: "Offering", group: "Store and product" },
  country: { display_name: "Country", group: "Customer" },
  platform: { display_name: "Platform", group: "Customer" },
  app_version: { display_name: "App version", group: "Customer" },
  paywall: { display_name: "Paywall", group: "Paywall" },
  survey_option: { display_name: "Survey option", group: "Customer Center" },
};

export type GroupId = "revenue" | "subscriptions" | "ads" | "ltv" | "customers" | "conversion" | "paywalls" | "trials" | "churn" | "retention";
export const GROUPS: { id: GroupId; display_name: string }[] = [
  { id: "revenue", display_name: "Revenue" },
  { id: "subscriptions", display_name: "Subscriptions" },
  { id: "ads", display_name: "Ads" },
  { id: "ltv", display_name: "LTV" },
  { id: "customers", display_name: "Customers" },
  { id: "conversion", display_name: "Conversion" },
  { id: "paywalls", display_name: "Paywalls" },
  { id: "trials", display_name: "Trials" },
  { id: "churn", display_name: "Churn and refunds" },
  { id: "retention", display_name: "Retention" },
];

/**
 * - stock: a snapshot at the end of each period (active subscriptions, MRR).
 * - flow: things that happened during each period.
 * - cohort_series: a time series whose x axis is a cohort date (conversion, LTV); recent periods stay incomplete.
 * - cohort_table: cohorts × periods of age (`{cohort, period, value}` values with `periods` metadata).
 */
export type Shape = "stock" | "flow" | "cohort_series" | "cohort_table";

export interface ChartDef {
  name: string;
  display_name: string;
  group: GroupId;
  display_type: "line" | "bar" | "stacked_bar" | "cohort";
  shape: Shape;
  description: string;
  measures: MeasureDef[];
  selectors: SelectorDef[];
  dims: Dim[];
  segmentable: boolean;
  defaultResolution: Resolution;
  /** A RevenueDot name for a chart RevenueCat shows only in its dashboard. */
  extension?: boolean;
  /** Listed in the dashboard's chart rail. */
  inRail: boolean;
  /** Measures change with the data (one per survey option or cancel reason). */
  dynamicMeasures?: boolean;
}

const m = (id: string, display_name: string, unit: Unit, description: string, o: { flow?: boolean; precision?: number; chartable?: boolean } = {}): MeasureDef => ({
  id, display_name, description, unit, decimal_precision: o.precision ?? (unit === "#" ? 0 : 2), chartable: o.chartable ?? true, tabulable: true, flow: o.flow ?? false,
});
const flowM = (id: string, name: string, unit: Unit, d: string, o: { precision?: number; chartable?: boolean } = {}) => m(id, name, unit, d, { ...o, flow: true });
const pct = (id: string, name: string, d: string) => m(id, name, "%", d, { precision: 1 });

const days = (ids: [string, string][], def: string, id: string, name: string): SelectorDef => ({ id, display_name: name, default: def, options: ids.map(([i, n]) => ({ id: i, display_name: n })) });
export const CONVERSION_TIMEFRAME = days([["0_days", "Day 0"], ["3_days", "3 days"], ["7_days", "7 days"], ["14_days", "14 days"], ["30_days", "30 days"], ["unbounded", "Unbounded"]], "7_days", "conversion_timeframe", "Conversion timeframe");
export const CUSTOMER_LIFETIME = days([["0_days", "Day 0"], ["7_days", "7 days"], ["14_days", "14 days"], ["30_days", "30 days"], ["60_days", "60 days"], ["90_days", "90 days"], ["180_days", "180 days"], ["365_days", "1 year"], ["unbounded", "Unbounded"]], "30_days", "customer_lifetime", "Customer lifetime");
const REVENUE_TYPE: SelectorDef = { id: "revenue_type", display_name: "Revenue type", default: "revenue", options: [{ id: "revenue", display_name: "Revenue" }, { id: "revenue_net_of_taxes", display_name: "Revenue (net of taxes)" }, { id: "proceeds", display_name: "Proceeds" }] };

const MONEY: Dim[] = ["app", "store", "product", "product_duration", "offering", "country", "platform", "app_version"];
const SUBS: Dim[] = MONEY;
const CUSTOMER: Dim[] = ["country", "platform", "app_version"];
const CUSTOMER_AND_PURCHASE: Dim[] = MONEY;
const ADS: Dim[] = ["app", "country", "platform", "app_version"];
const PAYWALL: Dim[] = ["paywall", "app", "country", "platform", "app_version"];

const def = (d: Omit<ChartDef, "selectors" | "segmentable" | "inRail" | "defaultResolution"> & Partial<Pick<ChartDef, "selectors" | "segmentable" | "inRail" | "defaultResolution">>): ChartDef =>
  ({ selectors: [], segmentable: true, inRail: true, defaultResolution: d.shape === "cohort_table" ? "month" : "day", ...d });

export const CHARTS: ChartDef[] = [
  // Revenue
  def({ name: "revenue", display_name: "Revenue", group: "revenue", display_type: "bar", shape: "flow", dims: MONEY, selectors: [REVENUE_TYPE],
    description: "Money received in each period from subscriptions, one-time purchases and ads, minus refunds recorded in the period.",
    measures: [flowM("revenue", "Revenue", "$", "Gross purchases, renewals, one-time purchases and ad revenue, minus refunds recorded in the period."),
      flowM("transactions", "Transactions", "#", "Paid purchases and renewals in the period. Refunds do not reduce it; ad revenue is not a transaction.")] }),
  def({ name: "arr", display_name: "ARR", group: "revenue", display_type: "line", shape: "stock", dims: SUBS,
    description: "Annual recurring revenue: MRR at the end of each period times 12.",
    measures: [m("arr", "ARR", "$", "MRR at the end of the period × 12.")] }),
  def({ name: "mrr", display_name: "MRR", group: "revenue", display_type: "line", shape: "stock", dims: SUBS,
    description: "Monthly recurring revenue: every active paid subscription's price normalised to one month, at the end of each period.",
    measures: [m("mrr", "MRR", "$", "Sum of the monthly value of each paid subscription with access at the end of the period.")] }),
  def({ name: "mrr_movement", display_name: "MRR Movement", group: "revenue", display_type: "stacked_bar", shape: "flow", dims: SUBS,
    description: "How MRR changed in each period: new, resubscribed and expanded MRR added; churned and contracted MRR lost.",
    measures: [flowM("new_mrr", "New MRR", "$", "Monthly value of subscriptions that became paid, other than resubscriptions and product changes."),
      flowM("resubscription_mrr", "Resubscription MRR", "$", "Monthly value of subscriptions started by customers whose earlier subscription had ended."),
      flowM("expansion_mrr", "Expansion MRR", "$", "Increase from product changes and renewals at a higher monthly value."),
      flowM("churned_mrr", "Churned MRR", "$", "Monthly value lost when paid subscriptions ended, net of billing recoveries (negative)."),
      flowM("contraction_mrr", "Contraction MRR", "$", "Decrease from product changes and renewals at a lower monthly value (negative)."),
      flowM("movement", "MRR Movement", "$", "The sum of the other measures: MRR at the end of the period minus MRR at its start.", { chartable: false })] }),
  def({ name: "non-subscription_purchases", display_name: "Non-subscription Purchases", group: "revenue", display_type: "bar", shape: "flow", dims: MONEY,
    description: "One-time purchases (consumables, non-consumables and lifetime unlocks) made in each period.",
    measures: [flowM("purchases", "Non-subscription Purchases", "#", "One-time purchases in the period.")] }),
  def({ name: "ad_revenue", display_name: "Ad Revenue", group: "revenue", display_type: "bar", shape: "flow", dims: ADS,
    description: "Ad revenue the SDK reported in each period, converted at the date of each ad.",
    measures: [flowM("ad_revenue", "Ad Revenue", "$", "Revenue from rc_ads_ad_revenue events.")] }),
  // Subscriptions
  def({ name: "actives", display_name: "Active Subscriptions", group: "subscriptions", display_type: "line", shape: "stock", dims: SUBS,
    description: "Paid subscriptions with access at the end of each period, including cancelled ones that have not expired and ones in a grace period.",
    measures: [m("actives", "Active Subscriptions", "#", "Paid subscriptions with access at the end of the period. Trials are not counted.")] }),
  def({ name: "actives_movement", display_name: "Active Subscriptions Movement", group: "subscriptions", display_type: "stacked_bar", shape: "flow", dims: SUBS,
    description: "How the number of active subscriptions changed in each period.",
    measures: [flowM("new_actives", "New Actives", "#", "Subscriptions that became paid, other than resubscriptions and paid-to-paid product changes."),
      flowM("resubscription_actives", "Resubscription Actives", "#", "Paid subscriptions started by customers whose earlier subscription had ended."),
      flowM("churned_actives", "Churned Actives", "#", "Paid subscriptions that lost access, net of billing recoveries (negative)."),
      flowM("movement", "Active Subscriptions Movement", "#", "New + resubscription − churned actives.", { chartable: false })] }),
  def({ name: "actives_new", display_name: "Paid Subscriptions", group: "subscriptions", display_type: "stacked_bar", shape: "flow", dims: SUBS,
    description: "Subscriptions whose first paid period started in each period, by how they started.",
    measures: [flowM("new_paid", "New Paid Subscriptions", "#", "All subscriptions whose first paid period started in the period.", { chartable: false }),
      flowM("trial_conversions", "Trial Conversions", "#", "Subscriptions that started with a free trial and converted to paid."),
      flowM("direct", "Direct Purchases", "#", "Subscriptions bought without a trial (paid introductory offers included)."),
      flowM("product_changes", "Product Changes", "#", "Subscriptions started by changing from another product."),
      flowM("resubscriptions", "Resubscriptions", "#", "Subscriptions started by customers whose earlier subscription had ended.")] }),
  def({ name: "subscription_retention", display_name: "Subscription Retention", group: "subscriptions", display_type: "cohort", shape: "cohort_table", dims: SUBS, segmentable: false,
    selectors: [{ id: "retention_scale", display_name: "Show", default: "relative", options: [{ id: "relative", display_name: "Relative (%)" }, { id: "absolute", display_name: "Absolute (#)" }] }],
    description: "Paid subscriptions cohorted by their first paid date, and how many reached each later paid period.",
    measures: [m("retention", "Retention", "%", "Subscriptions that reached the paid period, among those that had time to reach it.", { precision: 1 })] }),
  def({ name: "subscription_status", display_name: "Subscription Status", group: "subscriptions", display_type: "stacked_bar", shape: "stock", dims: SUBS,
    selectors: [{ id: "status_measure", display_name: "Measure", default: "actives", options: [{ id: "actives", display_name: "Active Subscriptions" }, { id: "trials", display_name: "Active Trials" }, { id: "mrr", display_name: "MRR" }, { id: "arr", display_name: "ARR" }] }],
    description: "Active subscriptions, trials, MRR or ARR at the end of each period, split by each subscription's current renewal state.",
    measures: [m("set_to_renew", "Set to renew", "#", "Will renew at the end of the current period."),
      m("set_to_cancel", "Set to cancel", "#", "Auto-renew is off: access ends at the end of the current period."),
      m("billing_issue", "Billing issue", "#", "The renewal failed; the subscription is in a grace period or billing retry.")] }),
  // Ads
  def({ name: "ad_rpm", display_name: "eCPM", group: "ads", display_type: "line", shape: "flow", dims: ADS,
    description: "Ad revenue per thousand ad impressions.",
    measures: [m("ecpm", "eCPM", "$", "Ad revenue ÷ impressions × 1,000."), flowM("ad_revenue", "Ad Revenue", "$", "Revenue from rc_ads_ad_revenue events.", { chartable: false }), flowM("impressions", "Impressions", "#", "Ads displayed.", { chartable: false })] }),
  def({ name: "ad_impressions", display_name: "Impressions", group: "ads", display_type: "bar", shape: "flow", dims: ADS,
    description: "Ads displayed in each period.", measures: [flowM("impressions", "Impressions", "#", "rc_ads_ad_displayed events.")] }),
  def({ name: "ad_fill_rate", display_name: "Fill Rate", group: "ads", display_type: "line", shape: "flow", dims: ADS,
    description: "Share of ad requests that were filled with an ad.",
    measures: [pct("fill_rate", "Fill Rate", "Loaded ÷ (loaded + failed to load)."), flowM("requests", "Ad Requests", "#", "Ads loaded plus ads that failed to load.", { chartable: false }), flowM("filled", "Filled Requests", "#", "Ads loaded.", { chartable: false })] }),
  def({ name: "ad_monetized_customers", display_name: "Ad Monetized Customers", group: "ads", display_type: "line", shape: "flow", dims: ADS,
    description: "Customers who saw at least one monetized ad per day, averaged over the days of each period.",
    measures: [m("monetized_customers", "Ad Monetized Customers", "#", "Average daily customers with at least one ad revenue event.", { precision: 1 })] }),
  def({ name: "ad_clicks", display_name: "Clicks", group: "ads", display_type: "bar", shape: "flow", dims: ADS,
    description: "Ads opened in each period.", measures: [flowM("clicks", "Clicks", "#", "rc_ads_ad_opened events.")] }),
  def({ name: "ad_ctr", display_name: "CTR", group: "ads", display_type: "line", shape: "flow", dims: ADS,
    description: "Ad click-through rate: clicks over impressions.",
    measures: [pct("ctr", "CTR", "Clicks ÷ impressions."), flowM("clicks", "Clicks", "#", "Ads opened.", { chartable: false }), flowM("impressions", "Impressions", "#", "Ads displayed.", { chartable: false })] }),
  def({ name: "ad_arpdau", display_name: "ARPDAU (Ad Users)", group: "ads", display_type: "line", shape: "flow", dims: ADS,
    description: "Average ad revenue per daily ad-monetized customer.",
    measures: [m("arpdau", "ARPDAU", "$", "Ad revenue ÷ the sum over the period's days of that day's ad-monetized customers.", { precision: 4 })] }),
  // LTV
  def({ name: "cohort_explorer", display_name: "Cohort Explorer", group: "ltv", display_type: "cohort", shape: "cohort_table", dims: CUSTOMER_AND_PURCHASE, segmentable: false,
    selectors: [
      { id: "cohorting_date", display_name: "Cohort", default: "new_customers", options: [{ id: "new_customers", display_name: "New Customers" }, { id: "initial_conversions", display_name: "Initial Conversions" }, { id: "new_paying_customers", display_name: "New Paying Customers" }] },
      { id: "cohort_measure", display_name: "Measure", default: "realized_ltv_per_customer", options: [
        { id: "revenue", display_name: "Revenue" }, { id: "revenue_net_of_taxes", display_name: "Revenue (net of taxes)" }, { id: "proceeds", display_name: "Proceeds" },
        { id: "realized_ltv", display_name: "Realized LTV" }, { id: "realized_ltv_per_customer", display_name: "Realized LTV / Customer" },
        { id: "retained_subscriptions", display_name: "Retained Subscriptions" }, { id: "subscriptions_set_to_renew", display_name: "Subscriptions Set to Renew" }] },
    ],
    description: "Customer cohorts measured month by month of each customer's own age: revenue, realized LTV, retained subscriptions.",
    measures: [m("value", "Value", "$", "The selected measure.")] }),
  def({ name: "ltv_per_customer", display_name: "Realized LTV per Customer", group: "ltv", display_type: "line", shape: "cohort_series", dims: CUSTOMER_AND_PURCHASE, selectors: [CUSTOMER_LIFETIME],
    description: "Revenue of each period's new customers within their lifetime window, minus refunds inside it, per new customer.",
    measures: [m("ltv_per_customer", "Realized LTV per Customer", "$", "Revenue in the lifetime window ÷ new customers."),
      flowM("revenue", "Revenue", "$", "Revenue of the cohort within the lifetime window, net of refunds in the window.", { chartable: false }),
      flowM("customers", "New Customers", "#", "Customers whose cohort date is in the period.", { chartable: false })] }),
  def({ name: "ltv_per_paying_customer", display_name: "Realized LTV per Paying Customer", group: "ltv", display_type: "line", shape: "cohort_series", dims: CUSTOMER_AND_PURCHASE, selectors: [CUSTOMER_LIFETIME],
    description: "Revenue of each period's new customers within their lifetime window, per customer who paid in the window.",
    measures: [m("ltv_per_paying_customer", "Realized LTV per Paying Customer", "$", "Revenue in the lifetime window ÷ paying customers."),
      flowM("revenue", "Revenue", "$", "Revenue of the cohort within the lifetime window, net of refunds in the window.", { chartable: false }),
      flowM("paying_customers", "Paying Customers", "#", "New customers whose first payment fell in the window and was not refunded in it.", { chartable: false })] }),
  def({ name: "prediction_explorer", display_name: "Prediction Explorer", group: "ltv", display_type: "cohort", shape: "cohort_table", dims: CUSTOMER_AND_PURCHASE, segmentable: false,
    selectors: [{ id: "cohorting_date", display_name: "Cohort", default: "new_customers", options: [{ id: "new_customers", display_name: "New Customers" }, { id: "initial_conversions", display_name: "Initial Conversions" }, { id: "new_paying_customers", display_name: "New Paying Customers" }] }],
    description: "Realized LTV per customer by cohort, with the months ahead predicted from how older cohorts grew at the same age.",
    measures: [m("ltv_per_customer", "LTV / Customer", "$", "Realized, then predicted, cumulative revenue per cohort customer.")] }),
  // Customers
  def({ name: "customers_new", display_name: "New Customers", group: "customers", display_type: "bar", shape: "flow", dims: CUSTOMER,
    description: "Customers first seen (or first purchasing) in each period. Aliases of one customer count once.",
    measures: [flowM("new_customers", "New Customers", "#", "Customers whose cohort date is in the period.")] }),
  def({ name: "customers_active", display_name: "Active Customers", group: "customers", display_type: "bar", shape: "flow", dims: CUSTOMER,
    description: "Customers whose app called RevenueDot on at least one day of each period, counted once per period.",
    measures: [m("active_customers", "Active Customers", "#", "Customers with SDK activity in the period.")] }),
  // Conversion
  def({ name: "initial_conversion", display_name: "Initial Conversion", group: "conversion", display_type: "line", shape: "cohort_series", dims: CUSTOMER_AND_PURCHASE, selectors: [CONVERSION_TIMEFRAME],
    description: "Share of each period's new customers who started a trial or bought anything within the conversion timeframe.",
    measures: [pct("initial_conversion_rate", "Initial Conversion", "Initial conversions ÷ new customers."),
      flowM("initial_conversions", "Initial Conversions", "#", "New customers with a trial start or purchase in the timeframe.", { chartable: false }),
      flowM("customers", "New Customers", "#", "Customers whose cohort date is in the period.", { chartable: false })] }),
  def({ name: "trial_conversion", display_name: "Trial Conversion Funnel", group: "conversion", display_type: "stacked_bar", shape: "cohort_series", dims: CUSTOMER_AND_PURCHASE,
    description: "Each period's new customers, the trials they started and where each trial ended up.",
    measures: [flowM("customers", "New Customers", "#", "Customers whose cohort date is in the period.", { chartable: false }),
      flowM("trials_started", "Trials Started", "#", "New customers who started a free trial.", { chartable: false }),
      flowM("converted", "Converted", "#", "Trials that converted to paid."),
      flowM("set_to_convert", "Set to Convert", "#", "Trials running with auto-renew on."),
      flowM("set_to_cancel", "Set to Cancel", "#", "Trials running with auto-renew off."),
      flowM("billing_issue", "Billing Issue", "#", "Trials that ended in a billing retry or grace period."),
      flowM("abandoned", "Abandoned", "#", "Trials that ended without converting."),
      pct("start_rate", "Trial Start Rate", "Trials started ÷ new customers."),
      pct("conversion_rate", "Trial Conversion Rate", "Converted ÷ trials started.")] }),
  def({ name: "trial_conversion_rate", display_name: "Trial Conversion Rate", group: "conversion", display_type: "line", shape: "cohort_series", dims: SUBS,
    description: "Customers who started a trial in each period and the share whose trial converted to paid.",
    measures: [pct("conversion_rate", "Trial Conversion Rate", "Conversions ÷ trial starts."),
      flowM("trials", "Trial Starts", "#", "Customers who started a trial in the period, once each.", { chartable: false }),
      flowM("conversions", "Conversions", "#", "Of those, customers whose trial converted to paid.", { chartable: false }),
      flowM("pending", "Still in Trial", "#", "Of those, customers whose trial is still running.", { chartable: false })] }),
  def({ name: "conversion_to_paying", display_name: "Conversion to Paying", group: "conversion", display_type: "line", shape: "cohort_series", dims: CUSTOMER_AND_PURCHASE, selectors: [CONVERSION_TIMEFRAME],
    description: "Share of each period's new customers who paid within the conversion timeframe and were not refunded in it.",
    measures: [pct("conversion_rate", "Conversion to Paying", "Paying customers ÷ new customers."),
      flowM("paying_customers", "Paying Customers", "#", "New customers whose first payment fell in the timeframe and was not refunded in it.", { chartable: false }),
      flowM("customers", "New Customers", "#", "Customers whose cohort date is in the period.", { chartable: false })] }),
  // Paywalls
  def({ name: "paywall_encounter", display_name: "Paywall Encounter", group: "paywalls", display_type: "line", shape: "cohort_series", dims: CUSTOMER,
    description: "Share of each period's new customers who saw a paywall on their first day, and by day 1, 3, 7 and 14.",
    measures: [pct("day_0", "Day 0", "Saw a paywall on the day they were first seen."), pct("day_1", "Day 1", "Saw a paywall by day 1."),
      pct("day_3", "Day 3", "By day 3."), pct("day_7", "Day 7", "By day 7."), pct("day_14", "Day 14", "By day 14."),
      flowM("customers", "New Customers", "#", "Customers whose cohort date is in the period.", { chartable: false })] }),
  def({ name: "paywall_conversion", display_name: "Paywall Conversion", group: "paywalls", display_type: "line", shape: "cohort_series", dims: PAYWALL,
    description: "Customer–paywall pairs by first impression, and the share that converted on calendar days 0 to 3.",
    measures: [pct("initial_conversion_rate", "Initial Conversion Rate", "Initial conversions ÷ paywall viewers."),
      pct("paid_conversion_rate", "Paid Conversion Rate", "Paid conversions ÷ paywall viewers."),
      pct("trial_start_rate", "Trial Start Rate", "Trial starts ÷ paywall viewers."),
      pct("trial_conversion_rate", "Trial Conversion Rate", "Trial conversions ÷ paywall viewers."),
      flowM("viewers", "Paywall Viewers", "#", "Customer–paywall pairs first seen in the period.", { chartable: false }),
      flowM("initial_conversions", "Initial Conversions", "#", "Pairs with a trial start or purchase on days 0–3.", { chartable: false }),
      flowM("paid_conversions", "Paid Conversions", "#", "Pairs whose initial conversion was paid or whose trial converted.", { chartable: false }),
      flowM("trial_starts", "Trial Starts", "#", "Pairs whose initial conversion was a trial.", { chartable: false }),
      flowM("trial_conversions", "Trial Conversions", "#", "Pairs whose trial converted to paid.", { chartable: false })] }),
  def({ name: "paywall_ltv", display_name: "Paywall LTV", group: "paywalls", display_type: "line", shape: "cohort_series", dims: PAYWALL, selectors: [CUSTOMER_LIFETIME],
    description: "Revenue within the lifetime window from customers who converted after seeing a paywall, per paywall viewer.",
    measures: [m("ltv_per_viewer", "LTV per Viewer", "$", "Revenue ÷ paywall viewers."), m("ltv_per_conversion", "LTV per Conversion", "$", "Revenue ÷ initial conversions."),
      flowM("revenue", "Revenue", "$", "Revenue of converted pairs from the first impression through the lifetime window.", { chartable: false }),
      flowM("viewers", "Paywall Viewers", "#", "Customer–paywall pairs first seen in the period.", { chartable: false })] }),
  def({ name: "paywall_abandonment", display_name: "Paywall Abandonment", group: "paywalls", display_type: "line", shape: "cohort_series", dims: PAYWALL,
    description: "Share of customer–paywall pairs with no initial conversion on calendar days 0 to 3, split into bounces and purchase cancellations.",
    measures: [pct("abandonment_rate", "Abandonment Rate", "Abandoned ÷ paywall viewers."), pct("bounce_rate", "Bounce Rate", "Bounces ÷ paywall viewers."),
      pct("cancellation_rate", "Purchase Cancellation Rate", "Purchase cancellations ÷ paywall viewers."),
      flowM("viewers", "Paywall Viewers", "#", "Customer–paywall pairs first seen in the period.", { chartable: false }),
      flowM("bounces", "Bounced", "#", "Pairs that neither bought nor started a purchase on days 0–3.", { chartable: false }),
      flowM("cancellations", "Purchase Cancellations", "#", "Pairs that started a purchase and did not complete one on days 0–3.", { chartable: false })] }),
  // Trials
  def({ name: "trials", display_name: "Active Trials", group: "trials", display_type: "line", shape: "stock", dims: SUBS,
    description: "Free trials with access at the end of each period, whatever their auto-renew state.",
    measures: [m("trials", "Active Trials", "#", "Free trials with access at the end of the period.")] }),
  def({ name: "trials_movement", display_name: "Active Trials Movement", group: "trials", display_type: "stacked_bar", shape: "flow", dims: SUBS,
    description: "How the number of active trials changed in each period.",
    measures: [flowM("new_trials", "New Trials", "#", "Trials that started."), flowM("converted_trials", "Converted Trials", "#", "Trials that converted to paid (negative)."),
      flowM("expired_trials", "Expired Trials", "#", "Trials that ended without converting (negative)."), flowM("movement", "Active Trials Movement", "#", "New − converted − expired trials.", { chartable: false })] }),
  def({ name: "trials_new", display_name: "New Trials", group: "trials", display_type: "bar", shape: "flow", dims: SUBS,
    description: "Free trials started in each period.", measures: [flowM("new_trials", "New Trials", "#", "Trials that started in the period.")] }),
  def({ name: "trial_cancellation", display_name: "Trial Cancellation Rate", group: "trials", display_type: "line", shape: "cohort_series", dims: SUBS,
    selectors: [days([["1_days", "1 day"], ["2_days", "2 days"], ["5_days", "5 days"], ["7_days", "7 days"], ["unbounded", "Unbounded"]], "7_days", "cancellation_timeframe", "Cancellation timeframe")],
    description: "Customers who started a trial in each period, and the share whose trial ended without converting after they turned auto-renew off.",
    measures: [pct("cancellation_rate", "Trial Cancellation Rate", "Trial cancellations ÷ trial starts."),
      flowM("trial_starts", "Trial Starts", "#", "Customers who started a trial in the period, once each.", { chartable: false }),
      flowM("cancellations", "Trial Cancellations", "#", "Trials that ended without converting whose last in-trial opt-out fell in the timeframe.", { chartable: false }),
      flowM("billing_failures", "Trial Billing Failures", "#", "Trials that ended without converting during a billing issue.", { chartable: false }),
      flowM("elapsed", "Trial Elapsed", "#", "Trials that ended without converting and without an opt-out or billing issue.", { chartable: false })] }),
  // Churn and refunds
  def({ name: "churn", display_name: "Churn", group: "churn", display_type: "line", shape: "flow", dims: SUBS,
    description: "Paid subscriptions that ended in each period as a share of those active when it started.",
    measures: [pct("churn_rate", "Churn Rate", "Churned actives ÷ actives at the start of the period."),
      m("actives", "Actives", "#", "Paid subscriptions active at the start of the period.", { chartable: false }),
      flowM("churned_actives", "Churned Actives", "#", "Paid subscriptions that ended (including product-change replacements), net of billing recoveries.", { chartable: false })] }),
  def({ name: "refund_rate", display_name: "Refund Rate", group: "churn", display_type: "line", shape: "cohort_series", dims: MONEY,
    description: "Paid transactions of each period and the share that has been refunded since.",
    measures: [pct("refund_rate", "Refund Rate", "Refunded transactions ÷ transactions."),
      flowM("transactions", "Transactions", "#", "Paid purchases, renewals and one-time purchases in the period.", { chartable: false }),
      flowM("refunded", "Refunded Transactions", "#", "Of those, transactions refunded since (reversals excluded).", { chartable: false })] }),
  def({ name: "refunds", display_name: "Refunds", group: "churn", display_type: "bar", shape: "flow", dims: MONEY,
    description: "Money refunded and refunded transactions, by refund date, net of reversed refunds.",
    measures: [flowM("refunded_revenue", "Refunded Revenue", "$", "Money refunded in the period, minus refunds reversed in it."),
      flowM("refunded_transactions", "Refunded Transactions", "#", "Transactions refunded in the period, minus reversals.")] }),
  def({ name: "refund_request", display_name: "Refund Request Outcomes", group: "churn", display_type: "stacked_bar", shape: "flow", dims: ["app", "store", "country"],
    description: "App Store refund requests received in each period, by outcome.",
    measures: [flowM("granted", "Refund Granted", "#", "The store refunded the purchase."), flowM("declined", "Refund Declined", "#", "The store declined, or no grant arrived within 2 days."),
      flowM("reversed", "Refund Reversed", "#", "The store reversed a granted refund."), flowM("no_resolution", "No Resolution", "#", "Received less than 2 days ago, no outcome yet."),
      flowM("requests", "Total Requests", "#", "Refund requests received in the period.", { chartable: false }),
      flowM("amount", "Refund Request Amount", "$", "Price of the purchases the requests were about.", { chartable: false })] }),
  def({ name: "play_store_cancel_reasons", display_name: "Play Store Cancel Reasons", group: "churn", display_type: "stacked_bar", shape: "flow", dims: ["app", "product", "product_duration", "country", "platform"], extension: true,
    description: "Google Play subscriptions cancelled in each period, by the answer the customer gave to Google's cancel survey.",
    measures: [] }),
  def({ name: "customer_center_survey_responses", display_name: "Customer Center Survey Responses", group: "churn", display_type: "stacked_bar", shape: "flow", dims: ["app", "country", "platform", "app_version"], extension: true, dynamicMeasures: true,
    description: "Answers to the Customer Center's surveys in each period, per option.",
    measures: [] }),
  // Retention (API only)
  def({ name: "app_store_save_outcomes", display_name: "App Store Save Outcomes", group: "retention", display_type: "stacked_bar", shape: "flow", dims: ["app", "product"], inRail: false,
    description: "Saves after Apple retention messages, by outcome. RevenueDot does not use Apple's Retention Messaging API yet, so every value is zero.",
    measures: [flowM("promotional_offer", "Redeemed Promotional Offer", "#", "Accepted a promotional offer within 24 hours of the message."),
      flowM("alternate_plan", "Redeemed Alternate Plan", "#", "Switched plans within 24 hours of the message."), flowM("no_purchase", "No Purchase", "#", "Did not cancel and did not buy.")] }),
];

export const chartDef = (name: string) => CHARTS.find((c) => c.name === name) ?? null;

/** The 41 chart names in RevenueCat's API enum (everything but the two extensions). */
export const API_CHART_NAMES = CHARTS.filter((c) => !c.extension).map((c) => c.name);

/** Answers from Google Play's cancel survey (`cancelSurveyResult.reason`), in the order Google lists them. */
export const CANCEL_REASONS: { id: string; display_name: string }[] = [
  { id: "CANCEL_SURVEY_REASON_NOT_ENOUGH_USAGE", display_name: "Not enough usage" },
  { id: "CANCEL_SURVEY_REASON_TECHNICAL_ISSUES", display_name: "Technical issues" },
  { id: "CANCEL_SURVEY_REASON_COST_RELATED", display_name: "Cost related" },
  { id: "CANCEL_SURVEY_REASON_FOUND_BETTER_APP", display_name: "Found a better app" },
  { id: "CANCEL_SURVEY_REASON_OTHERS", display_name: "Other" },
  { id: "UNKNOWN", display_name: "No answer" },
];
