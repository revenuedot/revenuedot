# Attribution, benchmarks and AI growth insights (Tier 3, batch H)

**Status:** built on branch `tier3-insights` (2026-10-02): unit, server and contract tests, a 70-check journey on a Railway development database, Playwright in the browser, and one real Workers AI (Kimi K2.6) run under `cf dev` against Railway (insights written and the digest emailed from the Worker's cron). Scope row: `prd/SCOPE.md` Tier 3, "More stores and tools: … attribution; benchmarks (cloud only, anonymized); AI growth insights". Migration `0027_attribution_benchmarks_insights` runs after 0022, 0025 and 0026: its journal `when` is later than all of theirs, and its snapshot chains from 0026.

## Users and jobs
- **Jordan, the growth operator** (company `docs/marketing/positioning.md`, avatar 2) buys installs on Meta and Apple Search Ads. He wants revenue, trial conversion and lifetime value per campaign, so he can move budget to the campaigns that pay back, and he wants the same split on every chart.
- **Maya, the founder** wants to know whether 38% trial conversion is good for a health app, and what to fix first.
- **Every admin** wants a short weekly note: what changed, why it matters, and the one or two things to do, with the numbers and a link to the chart.
- **Lena, the privacy-minded lead** must be sure no other company ever sees her numbers, and that self-hosted servers send nothing anywhere.

## What RevenueCat ships (checked 2026-10-01)
- **Attribution in Charts.** Charts filter and segment by Attribution Source (Apple Search Ads or organic), Apple Search Ads campaign, ad group, keyword and claim type, when the app collects Apple Search Ads attribution ([Charts](https://www.revenuecat.com/docs/dashboard-and-metrics/charts), [Apple Search Ads](https://www.revenuecat.com/docs/integrations/attribution/apple-search-ads)). Campaign names need Apple Ads API credentials. Reserved attributes `$mediaSource`, `$campaign`, `$adGroup`, `$ad`, `$keyword`, `$creative`, `$appleAds*`, `$claimType`, `$conversionType` hold attribution; partner ids such as `$appsflyerId` and `$adjustId` identify the device to attribution partners ([customer attributes](https://www.revenuecat.com/docs/customers/customer-attributes)).
- **Benchmarks** (Analytics → Benchmarks, April 2026): 7 metrics (initial conversion within 7 days, trial conversion, conversion to paying within 7 days, monthly churn, refund rate, realized LTV per customer and per paying customer within 30 days) against apps in the same store and primary category over the trailing 12 months, shown as percentile bands, with "your biggest improvement opportunity". Apps join automatically; groups need "enough apps … to ensure complete anonymization", threshold not published ([Benchmarks](https://www.revenuecat.com/docs/dashboard-and-metrics/benchmarks), [changelog](https://www.revenuecat.com/changelog/release/compare-subscription-metrics-against-industry-benchmarks-2026-04-13)).
- **AI insights.** Rico, the dashboard agent, answers "what do my metrics tell me" and compares against State of Subscription Apps data ([Rico](https://www.revenuecat.com/feature/ai-agent)). We found no scheduled digest.

## What we build

### 1. Attribution as first-class customer data
**Storage.** `customer_attribution`, one row per customer: `media_source`, `campaign`, `campaign_id`, `ad_group`, `ad_group_id`, `ad`, `ad_id`, `keyword`, `keyword_id`, `creative`, `claim_type`, `conversion_type`, `attribution_country`, `partner_ids` (`appsflyer_id`, `adjust_id`, `branch_id`, `kochava_device_id`, `singular_device_id`, `tenjin_id`, `airbridge_device_id`) and `updated_at`. The reserved attributes stay the source of truth; the row is rebuilt from them (`attributionFromAttributes` in `packages/core`) whenever one of them changes, by every writer: the SDK's attributes and attribution calls, the AdServices token, `aad_attribution_token` on a receipt, the REST API, web checkout, the importer and customer merges. Migration 0027 backfills it from the stored attributes.

**Mapping.** `$mediaSource` → media source; `$campaign`/`$adGroup`/`$ad`/`$keyword`/`$creative` → the names; `$appleAdsCampaignId`, `$appleAdsAdGroupId`, `$appleAdsKeywordId`, `$appleAdsAdId` → the ids. Apple Search Ads (AdServices) gives ids only, so `$campaign` holds the campaign id: when the project's Apple Search Ads connection has loaded campaign and ad group names (the existing **Load names**), the row carries the name and keeps the id; loading names later updates every row of the project. A customer with an Apple Search Ads id and no media source is "Apple Search Ads". Values are trimmed and capped at 200 characters; empty strings are no value.

**Charts.** Six customer dimensions in a new "Attribution" group, on every chart that has customer dimensions: `media_source`, `campaign`, `ad_group`, `keyword`, `ad`, `creative`. They filter customers and everything those customers did, like country. No value is "" and shows as "No attribution". This closes the "no attribution dimensions" gap in `prd/charts/PRD.md`.

**Revenue by campaign** (Analytics → Attribution, `/projects/:id/attribution`): new customers cohorted by their cohort date in a date range, grouped by media source, campaign, ad group or keyword (one media source can be picked first). Columns: new customers, trial starts, paying customers, conversion to paying, revenue on day 0, by day 7, by day 30 and to date (production, USD, net of refunds, ads excluded), revenue per customer, revenue per paying customer. Cohort windows are counted from each customer's cohort date; a window that has not closed for the whole cohort is marked incomplete. A **Spend** column takes the money spent per row (typed in, kept in this browser) and shows ROAS (revenue to date ÷ spend, plus day-7 and day-30 ROAS); the CSV download includes spend and ROAS. Each row links to the Revenue chart and to Customers, filtered to that row. API: `GET /v2/projects/{id}/attribution/report`.

**Customers and audiences.** The condition builder offers media source, campaign, ad group, keyword, ad and creative, with the values the project has as suggestions (`GET …/audiences/filter_options`, now read from `customer_attribution`). Conditions on these fields read the first-class row, so an Apple Search Ads campaign matches by its name once names are loaded (by its id before). The customer page shows an Attribution panel.

### 2. Benchmarks (RevenueDot Cloud only)
**Privacy decisions.**
- **Opt-in, off by default.** The privacy policy on revenuedot.app says "Anonymized, aggregated benchmarks would be offered only if you opt in", and positioning avatar 4 (teams that must own their purchase data) does not want a third party seeing its revenue. So nothing is shared until an admin turns on **Share anonymized benchmarks** in Project settings → Benchmarks (or on the Benchmarks page) and picks the app's category.
- **Give to get.** Only projects that share see peer numbers. A project that stops sharing has its own rows deleted at once and the aggregates rebuilt without it in the same request.
- **Self-host never takes part.** The job, the endpoints and the page exist only where `deps.benchmarks` is on (the Cloud Worker). On a self-hosted server the API answers `available: false`, the sidebar has no Benchmarks item and no data leaves the server.
- **Production data is never read from a laptop.** The nightly job runs inside the Worker's cron on Cloud; tests and journeys use their own databases.
- **k-anonymity.** A peer group (category × platform × country × metric) is published only when at least **10** different projects each contribute a value for that metric with enough data of their own (minimum samples below). The 10th and 90th percentiles need **20** projects; otherwise only the 25th, 50th and 75th are shown. The number of apps is shown rounded down to a multiple of 5 ("25+ apps"). No mean, minimum, maximum or project list is ever stored or returned. The API checks the threshold again when it reads, so a row can never leak through a lower setting.
- **No project is identifiable.** The aggregate table has no project ids. Per-project values (`benchmark_project_values`) are used only to build the aggregates and to show a project its own value; they are never returned for another project.

**Metrics** (trailing 12 complete months, production, USD; each uses the same definition as its chart, so "your value" matches the chart it links to):
| Metric | Definition | Better | Minimum sample per project |
|---|---|---|---|
| Initial conversion, 7 days | `initial_conversion` (`conversion_timeframe=7_days`): conversions ÷ new customers | higher | 100 new customers |
| Trial conversion | `trial_conversion_rate`: conversions ÷ trial starts (finished trials) | higher | 20 trial starts |
| Conversion to paying, 7 days | `conversion_to_paying` (7 days) | higher | 100 new customers |
| Monthly churn | `churn` by month: churned ÷ actives at month start, summed over months | lower | 50 active subscription-months |
| Refund rate | `refund_rate`: refunded ÷ paid transactions | lower | 50 transactions |
| Realized LTV per customer, 30 days | `ltv_per_customer` (`customer_lifetime=30_days`) | higher | 100 new customers |
| Realized LTV per paying customer, 30 days | `ltv_per_paying_customer` (30 days) | higher | 20 paying customers |
| ARPU, monthly | revenue ÷ active customers, summed over months (`revenue`, `customers_active`) | higher | 100 active customer-months |
| Monthly price (USD) | median price paid for 1-month subscriptions | neutral | 20 transactions |
| Annual price (USD) | median price paid for 1-year subscriptions | neutral | 20 transactions |

**Peer groups.** Category: the 11 categories RevenueCat uses (Business, Education, Gaming, Health & Fitness, Media & Entertainment, Photo & Video, Productivity, Shopping, Social & Lifestyle, Travel, Utilities) plus Other, chosen by an admin, and "All categories". Platform: all, iOS (customers last seen on iOS, iPadOS, macOS, tvOS, watchOS, visionOS) and Android. Country: all, plus each country a project has enough data in.

**Job.** On Cloud, every cron tick from 02:00 UTC computes a few sharing projects whose values are older than today (each slice reuses one load of the project's rows), within a 20-second budget per tick; once every sharing project is done, it rebuilds today's aggregates in one transaction (`benchmark_runs` records each day). Tests call the same functions.

**Page** (Analytics → Benchmarks): pickers for category, platform and country; one row per metric with your value, a hairline track showing the 25th–75th band, the median tick and your value as the gold square, the percentiles, and where you stand (top quarter, above median, below median, bottom quarter); "Your biggest opportunity" names the metric where you are furthest below the median of the "better" direction, with a link to its chart. States: not on Cloud, not sharing (call to action; admins can turn it on with a category), sharing but no run yet, a group with fewer than 10 apps, your sample too small for a metric, errors, phone width, dark mode.

**API.** `GET /v2/projects/{id}/benchmarks?category=&platform=&country=`; `GET …/benchmarks/settings`, `POST …/benchmarks/settings` `{ share, category }` (admins; audited as `benchmarks_settings_updated`).

### 3. AI growth insights
- **Overview.** Under the "Ask about insights or growth opportunities" box, a **Growth insights** panel shows this week's 3 to 5 recommendations: a title, the numbers they rest on (taken from our data, not from the model's text), what to do, and a link to the chart. **Ask about this** opens a RevenueDot AI conversation with the question filled in. Admins and developers can **Refresh** (once an hour per project; it counts as a question against the person's caps).
- **How they are made.** `generateInsights` builds a numbers pack from the project's own charts (MRR and revenue now against the 28 days before, new customers, trials, trial conversion, initial conversion, conversion to paying, churn, refund rate, the top campaigns by revenue, and benchmark positions when the project shares), then runs the RevenueDot AI agent with the **read tools only** (writes are never offered and the in-process API refuses any write from this actor) and the instruction to return 3 to 5 recommendations as JSON, each citing pack metric ids. The server validates the answer: unknown metric ids and links outside the project are dropped, 3 to 5 must remain, and one repair attempt is allowed. The pack's real values and chart links are attached to each recommendation.
- **Cache.** One row per project and ISO week (`ai_insights`, week starting Monday UTC). The Overview reads the cached row; nothing calls the model on page load.
- **Weekly digest.** From Monday 06:00 UTC, the tick generates the week's insights for projects that have RevenueDot AI on (not `disabled`), a model, and production revenue in the last 90 days, one project per tick, then emails them to the project's admins. Cloud always runs it; a self-hosted server runs it only with `REVENUEDOT_INSIGHTS_DIGEST=on`, because it spends the owner's model key. Each person can turn the digest off in Account → Notifications or with the one-click link in every digest (a signed token; the `List-Unsubscribe` header carries it too). Emails contain no customer ids.
- **Read-only, always.** The insights actor is marked read-only: the in-process API refuses any non-GET request from it, whatever the project's AI setting. Usage counts against the project's and the server's daily caps.

## Data (migration 0027)
Full exports and moves (prd/moves-export) carry `customer_attribution`; the benchmark tables and `ai_insights` stay on their server, and benchmark sharing is local to a server (a moved project starts not sharing).

`customer_attribution`; `projects.benchmarks_share`, `projects.benchmarks_category`, `projects.benchmarks_shared_at`; `benchmark_project_values`, `benchmark_aggregates`, `benchmark_runs`; `ai_insights`; `users.insights_emails`.

## Endpoints
| Method and path | What it does |
|---|---|
| `GET /v2/projects/{id}/attribution/report` | Revenue by campaign: `group_by` (`media_source`, `campaign`, `ad_group`, `keyword`), `media_source`, `start_date`, `end_date` |
| `GET /v2/projects/{id}/customers/{customer_id}/attribution` | The customer's attribution row |
| `GET /v2/projects/{id}/benchmarks` | Your values and the peer percentiles |
| `GET`/`POST /v2/projects/{id}/benchmarks/settings` | Sharing and category |
| `GET /v2/projects/{id}/ai/insights` | This week's cached insights |
| `POST /v2/projects/{id}/ai/insights/refresh` | Generate them again now |
| `GET /insights/unsubscribe?token=` | One-click digest opt-out |
| `POST /auth/me` `{ insights_emails }` | Digest on or off for this person (`GET /auth/me` adds `account.features`: `benchmarks`, `insights_digest`) |

RevenueDot AI gets two read tools: `get-benchmarks` and `get-attribution-report`.

## Tests that prove it
- `packages/core/test/attribution.test.ts`: attribute mapping (Apple Search Ads ids and names, AppsFlyer, Adjust, Branch, empty values, caps), the report windows.
- `packages/core/test/benchmarks.test.ts`: metric definitions against hand-built ledgers, k-anonymity (9 projects publish nothing, 10 publish the quartiles, 20 add the deciles, projects under the minimum sample do not count), percentiles, rounding of app counts, positions and the biggest opportunity.
- `packages/contract/test/v2-charts-attribution.test.ts`: attribution filters and segments on money, customer and conversion charts through the real purchase pipeline, options with labels, the report endpoint against hand-computed numbers.
- `apps/server/test/attribution.test.ts`: every writer keeps `customer_attribution` in step (SDK attributes, AdServices, REST, merge), name sync, audiences and Customers filters.
- `apps/server/test/benchmarks.test.ts`: the job on many projects, opt-in and opt-out (rows gone and aggregates rebuilt at once), self-host answers `available: false`, the API never returns a group under 10 even if one is stored, admins only for settings, audit entry.
- `apps/server/test/insights.test.ts`: the scripted fake model; read tools only; a write attempt refused; validation and repair; weekly cache; refresh limits; the digest email (admins only, opt-out, unsubscribe link, no customer ids).
- `scripts/e2e/journeys/insights.ts`: on a Railway development database of its own (dropped after), 12 projects seeded through the API and the purchase pipeline; the benchmark job, the attribution report and the insights digest, checked through the API and SQL.
- `apps/dashboard/e2e/insights.spec.ts`: the Attribution page, chart segments by campaign, Customers filter, Benchmarks (not sharing, sharing, below 10, full), the Overview insights panel and refresh, the digest switch, phone width and dark mode, no console errors.

## Verification (2026-10-02)
- `npx vitest run --maxWorkers=2 --minWorkers=1`: the whole suite, including `packages/core/test/attribution.test.ts` (10), `benchmarks.test.ts` (15), `apps/server/test/attribution.test.ts` (6), `benchmarks.test.ts` (10), `insights.test.ts` (17) and `packages/contract/test/v2-charts-attribution.test.ts` (7).
- `JOURNEY_PORT_BASE=5505 pnpm tsx scripts/e2e/journeys/run.ts insights`: 70 checks on the real Node server and a fresh Railway database (dropped after): SDK attributes and an AdServices token answered by the capture server; Revenue by campaign and the report equal to independent SQL; self-host refuses benchmarks; 12 sharing projects in the Cloud configuration; every published median equal to Postgres's `percentile_cont`, no group under 10 projects (annual price had 8 and was not published); opt-out removes a project at once; Refresh through the Anthropic provider (scripted Messages API) with read tools only; the digest email and its one-click opt-out on the real server.
- `E2E_PORT=5503 npx playwright test -c e2e/playwright.config.ts insights --workers=1` in `apps/dashboard` (4 tests), and the whole Playwright suite with one worker.
- Real model: `cf dev` with the remote `AI` binding against a Railway database: Refresh wrote 4 cited insights in 90 seconds; the Worker cron computed 12 projects' benchmarks, published 58 groups and emailed the digest. Kimi K2.6 sometimes ends a step with reasoning and no text; the no-tools retry then answers. It also once misread "below the median" for a lower-is-better metric, so the instructions now point it at `standing`, and the UI always shows the server's numbers.

## Known gaps
- Apple Search Ads keyword names are not loaded (Apple's keyword report needs one call per ad group); keywords show Apple's id unless the app sets `$keyword`.
- Ad spend is typed in on the Attribution page; it is not imported from Apple Search Ads, Meta or the attribution partners yet.
- Attribution attributes keep RevenueDot's attribute rule (the newest write wins) except the AdServices and legacy iAd paths, which stay write-once; RevenueCat documents attribution as write-once.
- Benchmarks start empty: a group shows numbers only once 10 sharing projects have enough data in it.
- The weekly digest is in English only and has no per-project schedule.
- In an organization that requires single sign-on (`ee/`), the scheduled run has no session, so its in-process reads are refused and that project's week is skipped; Refresh from the dashboard works (it carries the caller's session).
- The nightly job computes each project inside the Worker's CPU limit; a very large project may be cut off, which marks it done for the day without values (it does not block the others). Precomputed daily rollups would fix both charts and benchmarks.
