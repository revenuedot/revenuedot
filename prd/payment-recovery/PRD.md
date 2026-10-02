# Payment recovery (Tier 3, revenue recovery)

**Status:** built on branch `tier3-connect-recovery` (migration 0026). Tested with the fake Stripe, fake App Store and Google Play notifications, the in-memory mailer, journeys on the Railway development Postgres and the dashboard in a real browser. No real failed payment of a real customer has been recovered yet.

Scope row: `prd/SCOPE.md` Tier 3 "Revenue recovery: failed-payment recovery, refund defense (Apple consumption info), win-back flows. These are priced as a share of the money recovered." Refund defense is Refund Control and win-back flows are Win-back campaigns (`prd/lifecycle/PRD.md`); this spec is failed-payment recovery.

## Users and jobs
- **Developers** lose subscribers whose card fails. The stores retry the charge for days or weeks, but most customers never notice. They want those customers told, with one tap to fix the payment, without building email flows per store.
- **Founders** want to see what is at risk now and how much money came back, and pay RevenueDot a share of what it recovered, measured from purchase events only.
- **End customers** get a short, plain email from the app (not from RevenueDot) with a link that opens the right page: their Apple ID payment page, the Play Store subscription, or the developer's Stripe customer portal. They can unsubscribe.

## What the others do (the bar)
- RevenueCat sends a `BILLING_ISSUE` event to webhooks and integrations when a renewal fails ([event types](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields)); developers wire their own messaging tool to it.
- Stripe can email customers about failed payments and link them to update their card, for Stripe subscriptions only ([customer emails](https://docs.stripe.com/billing/revenue-recovery/customer-emails)).
- RevenueDot covers every store from the same purchase events, and keeps sending `BILLING_ISSUE` to webhooks and integrations as before.

## How it works
### A recovery case per billing issue
- A **case** opens when a subscription chain gets a billing issue: the purchase pipeline derives BILLING_ISSUE (App Store `DID_FAIL_TO_RENEW`, with or without grace; Google Play `SUBSCRIPTION_IN_GRACE_PERIOD` and `SUBSCRIPTION_ON_HOLD`; Stripe `past_due` and `unpaid`; Amazon grace; the Test Store's `billing_issue` scenario). One open case per chain; a repeat notification does nothing.
- The case remembers the customer, store, app, product, sandbox or production, when the issue started, the grace period end, and what the period is worth in USD (the at-risk amount).
- **Recovered**: a RENEWAL of the same chain (a new paid period) while the case is open and within the **recovery window** (default 30 days, 7 to 60). The case stores the renewal's transaction and revenue in USD.
- **Attributed**: recovered after at least one recovery email was sent. Attributed recoveries are the money RevenueDot recovered, the basis for the outcome price. Recoveries without an email (emails off, no address, unsubscribed, or the store's retry won before day 0's email) are shown separately as "recovered without a message".
- **Lost**: the window passed without a renewal, or the purchase was refunded.
- Customer merges move cases to the surviving customer.

### Messages
- Settings per project (`projects.recovery_settings`): on or off (default **off**), up to 5 steps with a day offset from the start of the billing issue (default day 0, 3 and 7), each with subject, heading, body and button label; sender name (default the project name); the recovery window; whether sandbox cases get emails too (default no, for testing with test-mode Stripe or the Test Store).
- The tick (every minute; on Workers from the cron only, like win-back) sends due steps: at most 100 emails a tick and 2,000 per project a day. A case that has several steps overdue (emails were just turned on) gets only the latest of them. Before each email the subscription is read again: if the billing issue is gone, the purchase was refunded or the case is closed, nothing is sent.
- **Address**: the customer's `$email` attribute; for Stripe subscriptions without one, the Stripe customer's email (read once through the app's key or Connect, and kept on the case).
- **Mailer and sender**: as win-back. Cloudflare Email Sending on Cloud (`no-reply@mail.revenuedot.app`, the app's name as the From name), SMTP or the log on self-host; Reply-To the project's support email from the Customer Center settings.
- **Unsubscribe**: every email has a one-click unsubscribe link (GET shows a button, POST unsubscribes; `List-Unsubscribe` and `List-Unsubscribe-Post` when the link is https). It adds the address to the project's suppression list, which win-back shares: an unsubscribed address gets no lifecycle email from that project.
- "Send test" sends one step to any address (10 an hour per project). "Run now" sends what is due for the project at once.

### The link in the email
`GET /v1/recovery/l/{token}` records the click and redirects:

| Store | Destination |
|---|---|
| App Store, Mac App Store | `https://apps.apple.com/account/billing` (the Apple ID payment methods page) |
| Google Play | `https://play.google.com/store/account/subscriptions?sku=<subscription>&package=<package>` (Play shows "Fix payment" there) |
| Amazon | `https://www.amazon.com/yourmembershipsandsubscriptions` |
| Stripe (web) | A new Stripe customer portal session for the subscription's customer (`POST /v1/billing_portal/sessions` with `flow_data[type]=payment_method_update` and the app's key or Connect), returning to `/v1/recovery/done/{token}`. When the portal is not set up in the developer's Stripe account, the open invoice's `hosted_invoice_url` instead. Otherwise a page that says to contact the app's support |
| Test Store | A page that explains this is a test purchase |

Portal sessions expire after a few minutes, so the session is made at the click, never put in the email. The restricted key needs **Customer portal: write** for this; "Check credentials" does not require it.

### Customer Center path
While a customer has an open case, customer info carries `management_url` (top level and on that subscription) = the same recovery link with `?via=customer_center`. The SDKs' Customer Center opens `management_url` from "Manage subscription" for purchases it cannot manage natively, so a web (Stripe) subscriber can fix their card from inside the app; App Store and Play customers land on their store's page. Without an open case, `management_url` stays null as before.

### Webhooks and integrations
Unchanged: BILLING_ISSUE, RENEWAL and EXPIRATION go out as they did. Integrations such as Braze or Customer.io can keep doing their own messaging from the same events.

## Dashboard: Lifecycle → Payment recovery
`/projects/:id/lifecycle/payment-recovery`, in the sidebar between Refund control and Win-back.
- Head: title, one line, the period segment (7D, 28D, 90D) and the Sandbox switch; **Turn on** or **Settings** on the right.
- Metric grid: **At risk now** (open cases and their USD value), **Messages sent**, **Recovered** (attributed count and recovery rate = recovered ÷ cases closed in the period), **Recovered revenue** (attributed USD, with "recovered without a message" under it).
- Table of cases: customer (link to the customer page), store tag, product, billing issue since, grace ends, messages sent, last message and click, status tag (BILLING ISSUE, RECOVERED, LOST, NO EMAIL, UNSUBSCRIBED), revenue. Filters: open, recovered, lost, all.
- Settings dialog: on/off, steps (day, subject, heading, body, button label; add, remove), recovery window, sandbox, sender name, email preview, Send test.
- Empty state (no billing issues yet) and an explanation of how money is counted.

## API (RevenueDot extensions, `/v2/projects/{project_id}`)
| Method and path | Scope | What |
|---|---|---|
| `GET /payment_recovery` | `project_configuration:projects:read` | Settings |
| `POST /payment_recovery` | `project_configuration:projects:read_write` | Replace settings |
| `GET /payment_recovery/stats?days=28&environment=production` | `customer_information:customers:read` | Cards: at risk, messages, recovered, recovered without a message, lost, rate, by store |
| `GET /payment_recovery/cases?status=&environment=&limit=&starting_after=` | `customer_information:customers:read` | Cases, newest first |
| `POST /payment_recovery/actions/send_test` | `project_configuration:projects:read_write` | One step to an address |
| `POST /payment_recovery/actions/run` | `project_configuration:projects:read_write` | Send what is due now |

Public (no key): `GET /v1/recovery/l/{token}` (link), `GET /v1/recovery/done/{token}` (return page), `GET` and `POST /v1/recovery/u/{token}` (unsubscribe).

## Data (migration 0026)
- `projects.recovery_settings` (jsonb).
- `recovery_cases`: project, customer, subscription, app, store, store key, product, sandbox, status (`open`, `recovered`, `lost`), detected at, grace end, at-risk USD, email, steps sent, next step due, first and last message, link token, click and unsubscribe times, resolved at, recovered transaction and USD, attributed, lost reason. One open case per chain (partial unique index).
- `recovery_messages`: case, step, address, sent at, error.

## Pricing
The outcome price is "a share of the money recovered" (`company/docs/business-model.md`); the share is not decided. RevenueDot measures it as the attributed recovered revenue in USD (`GET /payment_recovery/stats`), from its own purchase events only. Cloud billing does not charge it yet; that needs the share (Kai) and the Cloud billing branch.

## Tests
- `apps/server/test/payment-recovery.test.ts`: cases from a Stripe `past_due` webhook (restricted key and Connect), App Store `DID_FAIL_TO_RENEW` and `DID_RENEW` (BILLING_RECOVERY), Google Play `SUBSCRIPTION_ON_HOLD` and `SUBSCRIPTION_RECOVERED`, the Test Store; schedule and caps; overdue steps; no email, suppression, sandbox off; the Stripe customer's email; links per store, the portal session and the invoice fallback; unsubscribe; recovered, attributed, without a message, lost by window and by refund; stats; `management_url`; merges; settings validation.
- `scripts/e2e/journeys/payment-recovery.ts` (Railway development Postgres, real Node server, SMTP sink, fake Stripe and Play on the capture server, Chromium): Connect with Stripe through the fake OAuth page, a checkout paid on the connected account, a failed renewal, the email, its link to the portal, unsubscribe, the paid invoice, the recovered revenue in the API, SQL and the dashboard; a Play account hold recovered; the restricted-key path.
- `apps/dashboard/e2e/payment-recovery.spec.ts`: empty state, turn on, settings and preview, send test, a case from a Test Store billing issue, Run now, the email's links, recovered revenue, phone width, dark mode, no console errors.

## Known gaps
- Email only: no push or in-app messages yet.
- Amazon recovery opens Amazon's subscriptions page; Amazon has no deep link to a payment method.
- The Stripe portal must be configured in the developer's Stripe account; otherwise the open invoice page is used.
- Lists scan cases in Postgres per project; very large projects will want rollups.
