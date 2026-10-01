# Charts (scope Tier 2)

**Status:** Built on branch `tier2-charts`. All 43 charts answer `GET /v2/projects/{project_id}/charts/{chart_name}` and `/options`, and the dashboard has a Charts page. The numbers come from our own tables, computed when asked. Definitions match RevenueCat's Charts v3 where we hold the same data; every difference is listed under "Known gaps".

## Users and jobs
- **A founder** checks MRR, revenue, churn and trial conversion every morning, and wants the same numbers RevenueCat showed so the switch does not break their spreadsheet.
- **A growth person** compares conversion and retention across countries, stores, products and offerings, then exports the table to CSV.
- **A backend or an AI agent** reads the same charts through the REST API with a secret key (`charts_metrics:charts:read`), using RevenueCat's request parameters and response shape.

## What we match
- RevenueCat's chart names, request parameters (`resolution`, `start_date`, `end_date`, `expand_periods`, `filters`, `selectors`, `segment`, `limit_num_segments`, `aggregate`, `currency`, `include_annotations`) and the `ChartData` and `ChartOptions` response schemas of its OpenAPI v2 spec. Every chart response in the contract tests validates against that spec when the spec is on disk.
- RevenueCat's metric definitions ([Charts](https://www.revenuecat.com/docs/dashboard-and-metrics/charts), [Charts v3](https://www.revenuecat.com/docs/dashboard-and-metrics/charts/real-time-charts)). The rules every chart shares:
  - **Sandbox purchases are excluded.** The RevenueDot extension `environment=sandbox` shows only sandbox and Test Store data instead. Customer counts (new and active customers, the denominators of conversion charts) do not depend on the environment, as on the Overview.
  - **Granted (promotional) access and Family Sharing purchases are excluded** from every money and subscription measure.
  - **Money is converted to USD at the exchange rate of the purchase date.** Another display currency (`currency=EUR` …, the 14 currencies RevenueCat lists) converts that USD value at the same date's rate, so a subscription's MRR keeps its purchase-date rate.
  - **Times are UTC.** Days start at 00:00 UTC, weeks on Monday, months, quarters and years on their first day.
  - **Stock measures are end-of-period snapshots** (active subscriptions, active trials, MRR, ARR). The current period's snapshot is taken now.
  - **Refunds count on the refund date**, not the purchase date (Charts v3).
  - **A resubscription is a new subscription** on every store (Charts v3), and a product change ends one subscription and starts another.

## How a "subscription" is built from our tables
Every chart reads the `transactions` ledger (one row per trial start, purchase, renewal, one-time purchase, refund and refund reversal, written by the purchase pipeline and the importer). Pure code in `packages/core/src/charts/` turns it into subscriptions:
1. **Periods.** Each `trial`, `purchase` and `renewal` row is one period `[purchased_at, expires_at)`. A `refund` row for the same store transaction ends that period at the refund time; a `refund_reversal` gives it back.
2. **Subscriptions.** Periods of one customer, store, app and product, in time order, form one subscription while each period starts no later than one hour after the previous one ended. A gap starts a new subscription (a resubscription), unless the store reported a billing issue for that product in the gap and the next period is a renewal: then it is a **billing recovery** and the subscription continues (it was inactive during the gap).
3. **Grace periods.** The last period of a subscription that is in a grace period now (`subscriptions.grace_period_expires_date`) stays active until the grace period ends.
4. **Product changes.** When a customer's subscription in one store and app starts while another product's subscription of theirs is active (or within an hour of its end), the old one ends at that moment and the new one is a **product change**.
5. **Paid start.** A subscription's paid start is its first non-trial period. A subscription that starts with a trial and has a paid period after it is a **trial conversion**.
6. **Monthly value** of a paid period (for MRR) is its USD price times a factor from the product's duration: 1 day ×30, 3 days ×10, 1 week ×4, 2 weeks ×2, 4 weeks ×1, 1 month ×1, 2 months ×½, 3 months ×⅓, 6 months ×⅙, 1 year ×1/12 (in general: ×30/days, ×4/weeks, ×1/months). Without a catalog duration, the period's own length is used (×30/days).
7. **Customer cohort date** is the earlier of the customer's first seen time and their first transaction.

Other sources: `customers` (first seen, last seen country, platform and app version), `customer_activity` (one row per customer per UTC day with SDK activity), `subscriptions` (current renewal state: auto-renew, billing issue, grace period, Google cancel survey reason, presented offering), `events` (cancellation, uncancellation and billing-issue times for trial cancellations), `store_notifications` (Apple refund requests and their outcomes), and `sdk_events` (paywall, Customer Center and ad events the SDKs post to `/v1/events`).

## The chart list
42 charts in the dashboard rail, grouped as RevenueCat groups them, plus App Store Save Outcomes, which RevenueCat's API lists but its rail keeps under Retention. 41 names are in RevenueCat's API enum; the two marked "extension" are RevenueDot names for dashboard-only charts.

| Group | Chart (API name) | Shape | What it measures |
|---|---|---|---|
| Revenue | Revenue (`revenue`) | flow | Money received in the period from purchases, renewals, one-time purchases and ad revenue, minus refunds recorded in the period; and the number of paid transactions (not reduced by refunds, ads excluded). Selector `revenue_type`: `revenue` (gross), `revenue_net_of_taxes` (equal to gross: stores do not tell us the tax), `proceeds` (gross minus the store commission). |
| Revenue | ARR (`arr`) | stock | MRR × 12. |
| Revenue | MRR (`mrr`) | stock | Sum of the monthly value of every active paid subscription at the end of the period. Cancelled subscriptions count until they expire. |
| Revenue | MRR Movement (`mrr_movement`) | flow | New MRR, resubscription MRR, expansion MRR (a product change or renewal at a higher monthly value), churned MRR and contraction MRR (negative), and their sum, which equals the change in MRR over the period. |
| Revenue | Non-subscription Purchases (`non-subscription_purchases`) | flow | Count of one-time purchases (consumable, non-consumable, lifetime). |
| Revenue | Ad Revenue (`ad_revenue`) | flow | Ad revenue the SDK reported (`rc_ads_ad_revenue` events), converted to USD at the event date. |
| Subscriptions | Active Subscriptions (`actives`) | stock | Paid subscriptions with access at the end of the period, including cancelled ones not yet expired and ones in a grace period. Trials do not count. |
| Subscriptions | Active Subscriptions Movement (`actives_movement`) | flow | New actives + resubscription actives − churned actives (net of billing recoveries) = movement. A paid-to-paid product change counts in neither. |
| Subscriptions | Paid Subscriptions (`actives_new`) | flow | Subscriptions whose paid start falls in the period: trial conversions, direct purchases, product changes and resubscriptions, and their total. |
| Subscriptions | Subscription Retention (`subscription_retention`) | cohort | Subscriptions cohorted by paid start. Period *n* is the share of the cohort that reached its *n*-th paid period, among subscriptions that had time to reach it. Selector `retention_scale`: `relative` (%) or `absolute` (#). |
| Subscriptions | Subscription Status (`subscription_status`) | stock | Active subscriptions (or trials, MRR, ARR; selector `status_measure`) at the end of each period, split by each subscription's current renewal state: set to renew, set to cancel, billing issue. |
| Ads | eCPM (`ad_rpm`) | flow | Ad revenue per thousand impressions. |
| Ads | Impressions (`ad_impressions`) | flow | Ads displayed (`rc_ads_ad_displayed`). |
| Ads | Fill Rate (`ad_fill_rate`) | flow | Loaded ads ÷ (loaded + failed to load). |
| Ads | Ad Monetized Customers (`ad_monetized_customers`) | flow | Customers with at least one ad revenue event per day, averaged over the days of the period. |
| Ads | Clicks (`ad_clicks`) | flow | Ads opened (`rc_ads_ad_opened`). |
| Ads | CTR (`ad_ctr`) | flow | Clicks ÷ impressions. |
| Ads | ARPDAU (`ad_arpdau`) | flow | Ad revenue ÷ the sum over the period's days of that day's ad-monetized customers. |
| LTV | Cohort Explorer (`cohort_explorer`) | cohort | Customers cohorted by `cohorting_date` (`new_customers`, `initial_conversions`, `new_paying_customers`), measured per month of each customer's own age by `cohort_measure`: revenue, proceeds, realized LTV (cumulative), realized LTV per customer, retained subscriptions (paid access at the end of the month), subscriptions set to renew. |
| LTV | Realized LTV per Customer (`ltv_per_customer`) | cohort-as-series | Revenue of the period's new customers within their lifetime window (day 0 through day *N*, selector `customer_lifetime`), minus refunds inside the window, ÷ new customers. |
| LTV | Realized LTV per Paying Customer (`ltv_per_paying_customer`) | cohort-as-series | The same revenue ÷ the customers whose first payment fell in the window and was not refunded in it. |
| LTV | Prediction Explorer (`prediction_explorer`) | cohort | Cohort Explorer's realized LTV per customer, with future months predicted by the chain-ladder method: each later month grows by the average month-over-month growth that older cohorts showed at the same age. Predicted cells carry `predicted: true`. Up to 24 months. |
| Customers | New Customers (`customers_new`) | flow | Customers whose cohort date falls in the period; aliases count once. |
| Customers | Active Customers (`customers_active`) | flow | Customers with SDK activity on at least one day of the period, each counted once. |
| Conversion | Initial Conversion (`initial_conversion`) | cohort-as-series | New customers who started a trial or bought anything within the conversion timeframe (selector `conversion_timeframe`: day 0, 3, 7, 14, 30 days, or unbounded) ÷ new customers. |
| Conversion | Trial Conversion Funnel (`trial_conversion`) | cohort-as-series | New customers, trials started, and each trial's outcome counted once per customer at the highest status: converted, set to convert, set to cancel, billing issue, abandoned; start rate and conversion rate. |
| Conversion | Trial Conversion Rate (`trial_conversion_rate`) | cohort-as-series | Customers who started a trial in the period (once each), how many converted to paid, how many trials are still running, and the conversion rate. |
| Conversion | Conversion to Paying (`conversion_to_paying`) | cohort-as-series | New customers whose first payment (paid start, trial conversion or first one-time purchase) fell in the conversion timeframe and was not refunded in it ÷ new customers. |
| Paywalls | Paywall Encounter (`paywall_encounter`) | cohort-as-series | Share of new customers who saw a paywall (`paywall_impression`) on day 0, by day 1, 3, 7 and 14. |
| Paywalls | Paywall Conversion (`paywall_conversion`) | cohort-as-series | Customer–paywall pairs cohorted by first impression; initial conversions on calendar days 0–3, paid conversions, trial starts and trial conversions that follow from them, and their rates. |
| Paywalls | Paywall LTV (`paywall_ltv`) | cohort-as-series | Revenue within the lifetime window of the customers whose initial conversion followed a paywall pair, per viewer and per converted pair. |
| Paywalls | Paywall Abandonment (`paywall_abandonment`) | cohort-as-series | Pairs with no initial conversion on days 0–3: bounces (no purchase started), purchase cancellations (a purchase started and not completed), and the abandonment rate. |
| Trials | Active Trials (`trials`) | stock | Free trials with access at the end of the period, whatever their auto-renew state. |
| Trials | Active Trials Movement (`trials_movement`) | flow | New trials − trials that converted − trials that ended without converting = movement. |
| Trials | New Trials (`trials_new`) | flow | Trials started in the period. |
| Trials | Trial Cancellation Rate (`trial_cancellation`) | cohort-as-series | Customers who started a trial in the period; how many trials ended without converting after an in-trial opt-out within the selected timeframe (selector `cancellation_timeframe`: 1, 2, 5, 7 days or unbounded), ended with a billing issue, or just elapsed; the cancellation rate. |
| Churn and refunds | Churn (`churn`) | flow | Paid subscriptions active at the start of the period, churned subscriptions (expirations and product-change replacements, minus billing recoveries) and the churn rate. It can be negative or above 100%. |
| Churn and refunds | Refund Rate (`refund_rate`) | cohort-as-series | Paid transactions in the period, how many of them were refunded since, and the rate. |
| Churn and refunds | Refunds (`refunds`) | flow | Refunded money and refunded transactions by refund date, net of reversals. |
| Churn and refunds | Refund Request Outcomes (`refund_request`) | flow | Apple refund requests (`CONSUMPTION_REQUEST`) received in the period, by outcome: granted, declined, reversed, no resolution (fewer than 2 days old); after 2 days without a grant a request counts as declined. |
| Churn and refunds | Play Store Cancel Reasons (`play_store_cancel_reasons`, extension) | flow | Google Play cancellations in the period by the answer to Google's cancel survey. |
| Churn and refunds | Customer Center Survey Responses (`customer_center_survey_responses`, extension) | flow | Customer Center survey answers (`customer_center_survey_option_chosen`) per option. |
| Retention (API only) | App Store Save Outcomes (`app_store_save_outcomes`) | flow | Saves after Apple retention messages by outcome. Always zero: RevenueDot does not use Apple's Retention Messaging API yet. |

"cohort-as-series" charts are time series whose x axis is a cohort date: the newest periods stay `incomplete: true` until their window (conversion timeframe, lifetime, trial length) has passed.

## Request and response
`GET /v2/projects/{project_id}/charts/{chart_name}`, scope `charts_metrics:charts:read`.
- `resolution`: `0`–`4` or `day`, `week`, `month`, `quarter`, `year`. Default `day` for time series and `month` for cohort tables. At most 1,000 periods per request.
- `start_date`, `end_date` (YYYY-MM-DD, inclusive). Default: the last 30 days (time series) or the last 12 months (cohort tables).
- `expand_periods`: `true` counts the whole first period. `false` (default) counts flows from `start_date` and marks a partial first period incomplete. Stock charts ignore it.
- `filters`: JSON `[{"name":"country","values":["US"]}]`; values within one filter are OR-ed, filters are AND-ed. `segment`: one dimension; `limit_num_segments`: top N by the chart's first measure, the rest in "Other".
- `selectors`: JSON object of the chart's selectors (`/options` lists them).
- `aggregate=average,total`: `values` is empty and `summary` holds only those operations.
- `currency`: one of RevenueCat's 14 codes.
- `include_annotations=true` adds `annotations: []` (RevenueDot has no annotations yet).
- RevenueDot extension: `environment=sandbox`.
- Unknown chart name: 404. Unsupported segment or filter, bad dates, bad selectors: 400 `parameter_error` naming the parameter and listing what is supported.

Response (`object: "chart_data"`): `category`, `display_type` (`line`, `bar`, `stacked_bar`, `cohort`), `display_name`, `description`, `documentation_link` (our docs), `last_computed_at`, `start_date` and `end_date` (ms), `yaxis_currency`, `filtering_allowed`, `segmenting_allowed`, `resolution`, `yaxis` (the first measure's unit), `measures` (`id`, `display_name`, `description`, `unit`, `decimal_precision`, `chartable`, `tabulable`), `user_selectors`, `summary` (`{average, total}` keyed by measure display name; totals only for flow measures).
- Time series: `values` are `{cohort, measure, value, incomplete}` with `cohort` the period start in Unix seconds and `measure` the index into `measures`; segmented charts add `segment`, the index into `segments`.
- Cohort tables: `values` are `{cohort, period, value, incomplete}` (plus `predicted` on the Prediction Explorer) and `periods` describes the columns: `periods[0]` is the cohort size (unit `#`), `periods[1]` is the first measured period.

`GET /v2/projects/{project_id}/charts/{chart_name}/options` (`object: "chart_options"`): `resolutions` (`{id, display_name}`), `segments` and `filters` (with the values present in the project's data), and `user_selectors` (`{default, display_name, options}`).

## Filters and segments
| Dimension | Applies to | Source |
|---|---|---|
| `app` | money, subscriptions, ads, paywalls | the app the purchase or event came from |
| `store` | money, subscriptions | `app_store`, `play_store`, `test_store` … |
| `product` | money, subscriptions | store product identifier |
| `product_duration` | subscriptions | the catalog duration (`P1W`, `P1M`, `P1Y` …) |
| `offering` | money, subscriptions | the offering the SDK presented with the purchase |
| `country` | everything | the purchase's storefront country, else the customer's last seen country |
| `platform` | everything | the customer's last seen platform |
| `app_version` | customers | the customer's last seen app version |
| `paywall` | paywall charts | `paywall_id` of the impression |
| `survey_option` | Customer Center survey | the option id |

Customer dimensions filter customers and everything they did; purchase dimensions filter purchases but never the new-customer denominators (as RevenueCat: product filters do not apply to new customers).

## Published SQL
`apps/server/src/services/charts/reference-sql.ts` holds PostgreSQL for the core charts (revenue, transactions, non-subscription purchases, refunds, new trials, new customers, active subscriptions, active trials, MRR), written against our schema. `packages/contract/test/charts-sql.test.ts` runs each query on the test database and checks it returns the same numbers as the API. The docs page `revenuedot.app/docs/guides/charts` prints them.

## Data we now store (migration 0012)
- `sdk_events`: the paywall, Customer Center and ad events the SDKs post to `/v1/events` (deduplicated by the SDK's event id), with the customer resolved from `app_user_id`. Before this, `/v1/events` was accepted and dropped.
- `customer_activity`: one row per customer per UTC day on which the SDK called us (written when a request touches the customer). Backfilled from `first_seen` and `last_seen`.
- `subscriptions.cancel_survey_reason`: Google Play's cancel survey answer.

## Endpoints and screens
- `apps/server/src/routes/v2/charts.ts`: the two endpoints, parameters, errors and response shape.
- `apps/server/src/services/charts/`: loading rows, FX, filters, segments; `reference-sql.ts`.
- `packages/core/src/charts/`: periods, subscription building, every chart's computation, the catalog of names, groups, measures, selectors and definitions.
- Dashboard `/projects/:projectId/charts` and `/projects/:projectId/charts/:chartName` (`pages/charts/Charts.tsx`): grouped chart rail with search, date range, resolution, filters, segment, selectors, sandbox switch, line, bar or stacked chart (cohort charts as a heat table), the data table and CSV download.

## Tests that prove it
- `packages/core/test/charts.test.ts`: periods, subscription building (refunds, resubscriptions, billing recoveries, product changes, grace), MRR factors and each chart on hand-built ledgers.
- `packages/contract/test/v2-charts.test.ts`: realistic histories through the purchase pipeline with the clock set back; every chart's numbers against hand-computed values; filters, segments, selectors, currency, sandbox, errors; every response validated against RevenueCat's OpenAPI when the spec is on disk.
- `packages/contract/test/charts-sql.test.ts`: the published SQL equals the API.
- `apps/dashboard/e2e/charts.spec.ts`: the Charts page against the seeded server.

## Known gaps
- **Taxes:** stores do not report tax, so "revenue net of taxes" equals revenue, and proceeds subtract only the store commission (as `/metrics/revenue` does).
- **Paid introductory offers** are not told apart from regular paid periods (the ledger has no offer type), so Paid Subscriptions shows them as direct purchases.
- **Renewal cycle, offer type, first purchase month, install month, attribution and custom-attribute dimensions** are not offered yet.
- **Platform and app version** are the customer's last seen values, not the first seen ones RevenueCat uses.
- **Subscription Status** splits each period by the subscription's current state (as RevenueCat does); past states are not kept.
- **Prediction Explorer** uses a chain-ladder projection of our own data, not RevenueCat's cross-customer survival model.
- **App Store Save Outcomes** is always zero, and **Refund Request Outcomes** covers Apple only (Google sends no refund requests we can see).
- **Active Customers** starts counting from migration 0012; earlier days only have each customer's first and last seen day.
- Charts are computed on request from the project's rows. Large projects will need precomputed daily tables; the definitions will not change.
