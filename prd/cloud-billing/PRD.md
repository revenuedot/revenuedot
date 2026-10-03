# Cloud billing: plans and metering (Tier 2, batch G)

**Status:** live since 2026-10-03 (live Stripe keys on the Cloud Worker). Hardened the same day so Stripe is the source of truth (below). Proven against a fake Stripe (`apps/server/test/billing.test.ts`), Stripe's real test mode (`scripts/e2e/real-stripe/billing.ts`) and a manual real-browser run on the sandbox.

## Users and jobs
- **A developer on Cloud** sees which plan they are on, how much revenue their apps tracked this month, what that will cost, and their invoices; upgrades with Stripe Checkout and manages the card or cancels in Stripe's Customer Portal.
- **The same developer when a payment fails** gets an email and a banner with a link to fix the card; their apps keep working.
- **RevenueDot** gets paid 0.5% of tracked revenue above $10,000 a month, never more than $999 a month per account.

## Prices (decided 2026-09-30, `company/docs/business-model.md`; working assumptions, untested)
| Plan | Price | Limit |
|---|---|---|
| Free (`free`) | $0 | $10,000 tracked revenue a month |
| Standard (`standard`) | 0.5% of tracked revenue above $10,000 a month, capped at $999 a month; the rate never rises | apps up to $1,000,000 a month |
| Enterprise (`enterprise`) | from $50,000 a year, standard terms | none; set by RevenueDot staff, no self-serve checkout |

The table lives in code (`apps/server/src/services/billing/plans.ts`) and can be replaced without a deploy with `REVENUEDOT_BILLING_PLANS` (JSON). **Open for Kai:** the cap is $999 in `business-model.md` and on the live pricing page, but `company/docs/STATUS.md` says $499 (updated the same day). The code uses $999.

## Definitions
- **Tracked revenue** of a month: the sum of `revenue_usd` (USD at the purchase-date rate) of the project's production transactions that earned money (`purchase`, `renewal`, `one_time`) and were purchased in that calendar month (UTC). Sandbox, trials, refunds and refund reversals do not count, and refunds are not subtracted (a refunded purchase still counted when it was made). Transactions copied in by a move into Cloud (recorded before the project's `moved_in_at`) do not count, so revenue tracked by another server is never billed.
- **An account** is a user; it is billed for every project it owns (`projects.owner_user_id`). Usage rows keep the owner at the time they were computed.
- **The bill** for a month: Free: $0. Standard: `min(999, 0.005 × max(0, tracked − 10,000))`, rounded to the cent. Enterprise: invoiced outside this system (shown as "By contract").

## Essential now and later
Essential (this batch)
- Metering in the Cloud tick (cron only), at most once an hour per month: tracked revenue per project into `billing_usage`; the first two days of a month also recompute the month before.
- Stripe on RevenueDot's own account, through plain HTTPS (Workers and Node): Checkout (`mode=subscription`, the Standard price, billing anchored to the 1st of next month with no proration), Customer Portal, a Billing Meter (`default_aggregation.formula = last`) that receives the month's bill in cents (`value`) for the account's Stripe customer every hour it changes, with a unique identifier per report (Stripe refuses a repeated identifier for 24 hours, and "last" never double-counts). Stripe multiplies by the price ($0.01 a unit), so the invoice equals our bill.
- Webhook `POST /v2/billing/stripe/webhook` (signature checked with `REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET`): `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.created|finalized|paid|payment_failed|voided|marked_uncollectible`.
- Dunning states on the account: `active`, `past_due` (a payment failed; Stripe retries), `unpaid` (retries ran out), `canceled`. Payment failure emails the owner once per invoice; `unpaid` and `canceled` put the account back on Free. **Apps never stop working**: no SDK, REST or webhook behaviour depends on the plan or the payment status.
- Usage alert emails, once per account, month and threshold: Free at 80% and 100% of $10,000 (with the upgrade link); Standard when the bill reaches the $999 cap ("you will not pay more this month") and at 80% and 100% of $1,000,000 (Enterprise).
- Billing page `/account/billing` (Cloud only): plan and status, this month's tracked revenue (total, per project, against the limit), the bill so far, the three plans with Upgrade (Checkout), Manage billing (Portal) or Contact us (Enterprise), invoices with links to Stripe's hosted page and PDF, and banners for past due, unpaid, over the Free limit and over the Standard ceiling.
- Guard: a live key (`sk_live_` / `rk_live_`) is refused unless `REVENUEDOT_BILLING_LIVE=true`, so a development machine can never charge anyone.

Later
- Outcome add-ons (a share of recovered revenue, `business-model.md`): needs the revenue recovery features first.
- Annual prepay, Enterprise self-serve checkout, tax (Stripe Tax) and VAT ids.
- **Plan gates:** `business-model.md` says Standard does not include an SLA, SSO, audit logs or region choice. SSO, SLA and regions do not exist yet. The audit log already ships to everyone as v2 parity (`prd/SCOPE.md` Tier 2) while the Tier 3 `ee/` folder has "long audit retention", so nothing is gated today; each plan carries `features` for when Kai decides.
- **What happens when a Free account passes $10,000:** today a banner and two emails, never a block. Kai to decide whether a grace period ends in something stronger.

## RevenueCat behaviour we match
RevenueCat bills on monthly tracked revenue too: free up to $2,500 a month, then 1% of all of it ([pricing](https://www.revenuecat.com/pricing)). We measure the same thing (gross USD revenue of production purchases in the month) and charge less: only the part above $10,000, at half the rate, with a cap.

## Endpoints and screens
- `GET /v2/billing` (session): `{ edition, account: { plan, status, cancel_at, current_period_end }, plans, usage: { month, tracked_revenue_usd, projects[], bill_usd, free_limit_usd, ceiling_usd, cap_usd }, invoices[], stripe_ready }`. Self-host answers 404 "Billing is only on RevenueDot Cloud."
- `POST /v2/billing/checkout { plan: "standard" }` → `{ url }` (Stripe Checkout).
- `POST /v2/billing/portal` → `{ url }` (Customer Portal).
- `POST /v2/billing/stripe/webhook` (Stripe only).
- `GET /auth/me` keeps `account.plan` and adds `account.billing_status`.

## Configuration (Cloud Worker secrets and vars)
| Name | What |
|---|---|
| `REVENUEDOT_BILLING_STRIPE_SECRET_KEY` | RevenueDot's own Stripe secret or restricted key (Circo). Test mode until launch |
| `REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET` | `whsec_…` of the endpoint `https://api.revenuedot.app/v2/billing/stripe/webhook` |
| `REVENUEDOT_BILLING_PRICE_STANDARD` | The metered price (`price_…`, $0.01 per unit, on the meter below) |
| `REVENUEDOT_BILLING_METER_EVENT` | The meter's event name (default `revenuedot_cloud_bill_cents`) |
| `REVENUEDOT_BILLING_LIVE` | `true` only in production, with live keys |
| `REVENUEDOT_BILLING_PLANS` | Optional JSON plan table |

Stripe setup (test mode first, then live): a meter `revenuedot_cloud_bill_cents` (aggregation `last`, customer mapping `stripe_customer_id`, value key `value`); a product "RevenueDot Cloud Standard" with a monthly metered price of $0.01 per unit on that meter; the Customer Portal with cancellation at period end and payment method updates on; the webhook endpoint above with the events listed. Steps: `docs/cloud.md`.

## Stripe is the source of truth (hardening, 2026-10-03)
Stripe delivers webhooks at least once, in no guaranteed order, and retries for three days; a delivery can also be lost. So no event body decides an account's state:
1. **Every billing event re-reads Stripe.** Subscription, checkout and invoice events only say *which customer changed*. The handler lists that customer's subscriptions (`GET /v1/subscriptions?customer=…&status=all`) and the invoice (`GET /v1/invoices/{id}`), then writes what Stripe says now. An old event arriving late, the same event twice, or `checkout.session.completed` after `customer.subscription.deleted` all end in the same, current state.
2. **Which subscription counts.** A paying one (`active`, `trialing`, `past_due`) wins over one that is not (`unpaid`, `incomplete` from an abandoned Checkout, `paused`). Among paying ones: not set to end, then active over past due, then the one on file, then the oldest. Without a paying one, the live one on file, else the oldest live; with none live, the newest one (its end state). Any second `active`/`trialing`/`past_due` subscription is a duplicate: it is cancelled at once without proration (it would bill the same meter twice), and the server logs an error if Stripe refuses.
3. **Status and plan.** `active`/`trialing` → Standard, active; `past_due` → Standard, past due (apps keep working, Stripe retries); `unpaid`, `incomplete`, `paused`, `canceled`, `incomplete_expired` → Free with that status. `cancel_at` (or the period end when `cancel_at_period_end`) is shown as the end date.
4. **Emails follow the invoice, not the event.** "Payment failed" goes once per invoice, only while Stripe still has it open after a failed attempt; "payment recovered" only for an invoice that had the failed email and is now paid; "unpaid" once per subscription and invoice. A late `invoice.payment_failed` for an invoice that is already paid sends nothing.
5. **If Stripe cannot be read**, the webhook answers 500 so Stripe retries; nothing is written from the event body. An object Stripe does not have (`resource_missing`: deleted, or from the other mode) is acknowledged, never retried; an account whose customer Stripe no longer has goes to Free (the customer id is kept, so a wrong key heals once fixed) and its next Checkout makes a new customer.
5b. **One sync per customer at a time.** Each sync is a transaction holding a Postgres advisory lock on the customer (10-second lock timeout, then 500 and Stripe retries), with Stripe read inside it, so concurrent webhooks cannot write a stale read. Invoice events take the same lock. Emails are sent after the commit. The row is written only when something changed.
6. **Hourly reconcile.** Once an hour (claimed with a `billing_notices` row of the system user `__billing__`, so overlapping cron runs never repeat it), the billing pass re-reads every account that has a Stripe customer and is not settled (a live status, or changed in the last 7 days), at most 200 a run in a window that moves each hour. For past-due and unpaid accounts it also re-reads the latest invoice, so a lost invoice webhook is repaired too.
7. **One subscription per account.** Checkout first re-reads the customer's subscriptions: an active or past-due one means 409 "already on Standard"; an unpaid one is cancelled first (its open invoice stays payable), so the new subscription never shares the meter with it. Enterprise accounts get 409. Older open Checkout Sessions of the customer are expired before a new one is created, so two tabs cannot make two subscriptions.
8. **Return from Checkout.** `GET /v2/billing?sync=1` (the Billing page after `?checkout=success`) re-reads Stripe at most once every 5 seconds per account, so the plan shows even before the webhook lands.
9. **Stripe dunning setting.** When every retry fails, Stripe marks the subscription **unpaid** (Revenue recovery → Retries), which this code expects.

The billing key needs read on Subscriptions and Invoices and write on Subscriptions (to cancel a duplicate), besides Customers, Checkout Sessions, Customer portal and Billing Meter Events. The live key was checked for all of these on 2026-10-03.

## Plan access
The plan decides only the bill. No feature, API, SDK or webhook behaviour depends on it, on purpose: an app must never break because its developer's card failed. A Free account above $10,000 a month keeps working, with a banner and two emails. Changing this is Kai's call (`company/docs/business-model.md`).

## Tests that prove it
- `apps/server/test/billing.test.ts` against `packages/contract/src/fake-billing-stripe.ts`: the bill at $0, $9,999.99, $10,000, $10,001, $50,000, $209,800 (cap) and $2M; tracked revenue skips sandbox, trials, refunds and moved-in history; metering per owner across projects; Checkout and Portal requests; every webhook (signed, wrong signature refused, replay safe); dunning `past_due` → `active`, `unpaid` → Free; meter events only when the bill changes, identifier per value; alert emails once per threshold; self-host has no billing; a live key is refused without `REVENUEDOT_BILLING_LIVE`.
- Journey `scripts/e2e/journeys/billing.ts`: a Cloud-edition server, real sign-up, a production Stripe purchase above the free limit, metering, the upgrade through the fake Checkout page, the signed webhooks, the meter event, a failed payment, the email and recovery.
- Playwright `apps/dashboard/e2e/billing.spec.ts`: the Billing page in each state, Upgrade to the fake Checkout and back, Manage billing.

## Known gaps
- Live mode is on (2026-10-03). The first real customer's month-end invoice is the first live charge; everything before it is proven on the sandbox with the same code (`scripts/e2e/real-stripe/billing.ts` and a manual run on 2026-10-03: real Checkout, a real $100.00 metered invoice on a test clock, a declined renewal, recovery, replayed and out-of-order events, a lost webhook repaired by the hourly pass).
- Stripe holds a usage invoice in draft until every webhook endpoint accepts `invoice.created` (up to 72 hours), then charges it. In live mode both endpoints (ours and DataFast's) answer 2xx.
- Metering reads the month's transactions of every project in one query per tick; fine for now, a rollup later.
- Enterprise accounts are set by hand (`billing_accounts.plan = 'enterprise'`); Stripe events never change them.
