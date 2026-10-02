# Analytics (DataFast)

Web analytics and revenue attribution for RevenueDot Cloud run on [DataFast](https://datafa.st). Website `revenuedot.app`, id `dfid_D9m4bJCw2lmFrxMQaatXu` (public). Spec: `prd/analytics/PRD.md`.

## Where it runs
| Place | How |
|---|---|
| `revenuedot.app` pages and docs | `apps/site/src/components/Analytics.astro` (in `Base.astro`): the script, a goal for each tracked link, `data-fast-scroll` on sections. Constants in `apps/site/src/datafast.ts` |
| `app.revenuedot.app` dashboard | `apps/dashboard/src/lib/analytics.ts`: loads the script only on that host, identifies the user, records a goal for each step (`goalFor`) after the API call succeeds |
| Stripe Checkout (Cloud Standard) | `apps/server/src/services/billing/stripe.ts` `datafastIds` and `createCheckout`: the visitor and session cookies go into the session and subscription metadata |
| Crawlers | `apps/site/worker/bots.ts`: the site Worker tells DataFast when a known AI, search or training crawler requests a page |

## Goals
Site: `signup_click`, `login_click`, `app_click`, `contact_sales_click`, `migrate_click`, `self_host_click`, `github_click`, `email_click` (each with `location`: header, footer, cta_band, hero, docs or page); `contact_sales_started`, `contact_sales_submitted`; scroll goals `viewed_how_it_works`, `viewed_features`, `viewed_integrations`, `viewed_cost_comparison`, `viewed_faq`, `viewed_pricing_plans`, `viewed_pricing_calculator`.
Dashboard: `signup_completed`, `invite_accepted`, `project_created`, `app_created`, `api_key_created`, `product_created`, `entitlement_created`, `offering_created`, `paywall_created`, `webhook_created`, `test_purchase_made`, `stripe_connected`, `checkout_started`, `checkout_returned` (`result`), `billing_portal_opened`.
Revenue and subscription goals (`payment`, `subscription_started`, `subscription_renewed`, `subscription_ended`, …) come from the Stripe connection; never send those names ourselves.

Add a goal: dashboard step, one line in `STEPS` in `analytics.ts` (with a test in `analytics.test.ts`); site link, one row in `GOALS` in `Analytics.astro`; anything else, `window.datafast("name", { key: "value" })`. Names are lowercase letters, digits, `_`, `-`, `:`; at most 10 parameters of 255 characters.

## User properties
`identify` runs once the dashboard knows the user: `user_id` is the email (the same key the contact-sales form uses, so a lead, the signup and the payment are one profile), plus `name`, `plan`, `projects` (a count) and `email_verified`. It runs again when the plan or project count changes.

## Stripe revenue attribution
1. DataFast → Settings → Revenue → Stripe: paste a restricted read key from RevenueDot's Stripe account (the Circo account). Live mode only; DataFast has no test mode.
2. Checkout carries `datafast_visitor_id` and `datafast_session_id` in `metadata` and `subscription_data.metadata`. No webhook is needed on the DataFast side.
3. Cloud Standard is billed monthly at the end of the month, so the first payment shows then; `subscription_started` shows at checkout.


## Checking it works
```bash
datafast analytics realtime --website <websiteId>
datafast analytics goals --website <websiteId>
datafast visitors list --completed-goal signup_completed --period today
```
Bot traffic: the Bot traffic card in the DataFast dashboard. Test with `curl -A "GPTBot/1.2" https://revenuedot.app/pricing`.
