# Cloud billing: Pro, Enterprise and the go-live gate

**Status:** billing live since 2026-10-03 (live Stripe keys on the Cloud Worker). Rebuilt on 2026-10-05 into two plans, Pro and Enterprise, with a card required to go live (Kai: "users are expected to subscribe to use our cloud platform; they can complete setup but they need Stripe with a credit card on the equivalent of the RevenueCat Pro plan"). Stripe stays the source of truth (below).

## The model in one line
**Building and testing are free with no card. Going live needs Pro, which costs $0 until your apps make $10,000 a month.**

## Users and jobs
- **A developer setting up** signs up with an email, creates projects and apps, connects stores, installs the SDK, builds paywalls and experiments, and makes sandbox and Test Store purchases. No card, no time limit.
- **The same developer at launch** sees their first live sale, adds a card through Stripe Checkout ($0 today) and keeps every feature. Without a card they get 14 days, then live data and webhooks pause.
- **A growing app** pays 0.5% of tracked revenue above $10,000 a month, never more than $999, charged to the card on file each month.
- **A large company** talks to sales for Enterprise.
- **RevenueDot** gets a card on file from every live app, so the first month above $10,000 is billed with no further step.

## Plans (decided 2026-10-05, `company/docs/business-model.md`)
| Plan | Price | Who |
|---|---|---|
| **Pro** (`pro`) | $0 until tracked revenue reaches $10,000 in a month, then 0.5% of tracked revenue above $10,000, never more than $999 a month. The rate never rises. Card on file through Stripe Checkout | Every app on RevenueDot Cloud, up to $1,000,000 a month |
| **Enterprise** (`enterprise`) | Custom, from $50,000 a year, contact sales | Above $1M a month, or SCIM, long audit retention, compliance exports, the SLA, the commercial licence or a support promise |

An account with neither has **no plan** (`none`): every new account until it starts Pro. It is not a plan anyone picks; it is the build stage.
Self-hosting the AGPL server is not a plan and is never sold on pricing surfaces; it stays a quiet, factual option in the self-host docs (Kai, 2026-10-05: "self hosting on github is just what they do on their own, not a business model"). Enterprise includes the commercial licence to self-host with every `ee/` feature.

The table lives in `apps/server/src/services/billing/plans.ts`; `REVENUEDOT_BILLING_PLANS` (JSON) can replace it without a deploy (older tables with `free`/`standard` ids are read as `pro`).

## Why this model (research 2026-10-05, `company/docs/research/rc-monetization-2026-10.md`)
1. **RevenueCat runs one self-serve plan.** Pro is "Start for free": $0 to $2,500 a month, then 1% of all of it; Enterprise is custom ([pricing](https://www.revenuecat.com/pricing)). It merged Free, Starter and Pro into this one plan on 2023-09-20. We match the shape: Pro plus Enterprise.
2. **RevenueCat's card is optional, so its gate is late.** Without a card, crossing $2,500 locks charts, customer lists, customer history and paywall and experiment editing (30 days' grace in the first month only; [docs](https://www.revenuecat.com/docs/welcome/set-up-revenuecat/account-management)). It never stops the SDK or purchases, and neither do Adapty, Qonversion or Apphud.
3. **We ask earlier but for less.** We ask for the card at the first live sale, not at a revenue limit, and it costs $0 until $10,000 a month. Card-required funnels convert 30% to 49% of signups to paying versus 8% to 18% without a card (First Page Sage 2025; ChartMogul and Kyle Poyar 2026), and the usual cost, about 70% fewer signups, does not apply because sign-up and building stay card-free.
4. **Nobody's end users are punished.** Purchases are always verified and access always granted: an app's paying customers must never lose what they bought because their developer skipped a form. The gate falls on the developer's tools (live data, exports, webhooks, integrations, paywall and experiment editing), exactly the surfaces a real business cannot run without.

## The go-live gate
**Live** means the account's first live sale: a production transaction that earned money (`purchase`, `renewal`, `one_time`, `revenue_usd > 0`, not imported, not copied in by a move) in any project it owns. The billing pass records it on `billing_accounts.live_at` and sets `grace_ends_at` to 14 days after it was seen. Accounts whose first live sale came before the gate shipped (2026-10-06) get 30 days from the first pass, because the Terms of Service (section 5) promise at least 30 days before anything changes for an account past a free limit.

| Stage | When | What the developer sees |
|---|---|---|
| **Building** | No live sale yet, no plan | Everything works. Setup checklist ends with "Start Pro before you release"; sign-up and Billing say "Building and testing are free" |
| **Grace** | Live, no plan, before `grace_ends_at` | Everything works. A banner on every page with the date; the go-live email at once and a reminder 2 days before the end |
| **Paused** | Live, no plan, after `grace_ends_at` | Live data and outbound deliveries pause (below). Red banner; one email when it happens |
| **Active** | Pro (`active` or `past_due`) or Enterprise | Everything works. Held deliveries are sent |

**Never gated, in any stage:** the SDK and every SDK endpoint, receipt and purchase verification, entitlements and customer info, store server notifications, the REST v1 subscriber endpoints and REST v2 reads of one customer with a secret key (backends check access with these), sandbox and Test Store data everywhere, sign-up, projects, apps, store credentials, products, entitlements, offerings, paywalls and experiments already running, imports, moves, members and API keys.

**Paused** (Cloud, billing set up, the project's owner is paused):
- Dashboard and API reads of live data answer `402 plan_required`: overview metrics, charts, saved charts, attribution, benchmarks, customer lists, the customer list and customer pages in the dashboard, transactions, subscriptions and purchases lists, scheduled data exports, ads revenue, payment recovery, win-back and RevenueDot AI conversations and insights. A move's full export is never gated: the data can always leave. The same reads with `environment=sandbox` keep working where the handler filters on it (a handler that ignores it, such as the customer list or `metrics/revenue`, stays paused). Settings stay open: payment recovery's switch, benchmark sharing, AdMob and reward rules, and pausing or deleting a win-back campaign.
- Creating or editing paywalls, experiments and targeting answers `402` (RevenueCat locks the same); live ones keep serving.
- Webhook and integration deliveries of production events are **held**, not dropped: they show "Held: start Pro to send" and go out, oldest first, when Pro starts. Held for more than 30 days they are marked failed. A TEST event the developer sends is never held. Scheduled exports of live data wait and run from their cursors once Pro starts; sandbox-only exports keep running.
- The organization and team features of `ee/` keep needing Pro, as before.

The `402` body: `{ "type": "plan_required", "message": "...", "upgrade_url": "https://app.revenuedot.app/account/billing" }`. For the owner: "Live data is paused because this account has no plan. Start Pro on the Billing page: it costs $0 until your apps make $10,000 a month." For other members: "Live data is paused because the project owner, <name>, has not started Pro. Ask them to start it on their Billing page."

**Who pays:** the project's owner (`projects.owner_user_id`), as before. An organization project follows its owner.
**Not on Cloud:** self-hosted servers and a Cloud server without Stripe set up have no gate.
**Lapsed:** `unpaid` (every Stripe retry failed) or `canceled` puts the account back to no plan; a live account is then paused at once (its grace was used). `past_due` keeps Pro while Stripe retries.

## Checkout
Stripe Checkout, `mode=subscription`, the metered Pro price, $0 due today, card collected (`payment_method_collection=always`), billing anchored to the 1st of next month. The submit button text explains the price: "$0 today. Pro costs nothing until your apps make $10,000 in a month; then 0.5% of revenue above $10,000, never more than $999 a month. Cancel any time." Stripe product name: **RevenueDot Pro**.

## Emails (only to live accounts without a plan; three at most, ASCII, the global layout)
1. `live_grace` at the first live sale: "Your app made its first live sale" / "Start Pro by <date> to keep live data and webhooks running. It costs $0 until your apps make $10,000 a month." Button "Start Pro".
2. `live_reminder` 2 days before `grace_ends_at`.
3. `live_paused` when paused: "Live data and webhooks are paused" / "Your app still works and every purchase still unlocks. Start Pro to see your data and send the held webhooks." 
Pro accounts keep the cap and ceiling emails. The old Free 80% and 100% emails are gone.

## Canonical copy (every surface uses these words)
- Plan names: **Pro**, **Enterprise**. Never "Cloud Free", "Cloud Standard", "Standard" or "free plan".
- Price: "$0 until your apps make $10,000 a month, then 0.5% of revenue above $10,000, never more than $999 a month."
- Short price: "Free until $10K a month, then 0.5%, capped at $999."
- Card rule: "Building and testing are free, no card needed. Add a card when you go live; Pro costs $0 until your apps make $10,000 a month."
- Primary CTA on the site: **Start for free** (https://app.revenuedot.app/signup). In the dashboard: **Start Pro**.
- Enterprise: "Custom pricing from $50,000 a year" and **Contact sales**.
- Banned: "no credit card", "free forever", "free plan", "Self-host free" as a pricing option.

## Definitions
- **Tracked revenue** of a month: the sum of `revenue_usd` (USD at the purchase-date rate) of the project's production transactions that earned money (`purchase`, `renewal`, `one_time`) and were purchased in that calendar month (UTC). Sandbox, trials, refunds and refund reversals do not count, and refunds are not subtracted (a refunded purchase still counted when it was made). Transactions copied in by a move into Cloud (recorded before the project's `moved_in_at`) and history written by a RevenueCat import (`source = 'import'`) do not count, so revenue tracked by another server is never billed.
- **An account** is a user; it is billed for every project it owns (`projects.owner_user_id`). Usage rows keep the owner at the time they were computed.
- **The bill** for a month: no plan: $0. Pro: `min(999, 0.005 × max(0, tracked − 10,000))`, rounded to the cent. Enterprise: invoiced outside this system (shown as "By contract").

## Essential now and later
Essential (this batch)
- Metering in the Cloud tick (cron only), at most once an hour per month: tracked revenue per project into `billing_usage`; the first two days of a month also recompute the month before.
- Stripe on RevenueDot's own account, through plain HTTPS (Workers and Node): Checkout (`mode=subscription`, the Pro price, card always collected, billing anchored to the 1st of next month with no proration), Customer Portal, a Billing Meter (`default_aggregation.formula = last`) that receives the month's bill in cents (`value`) for the account's Stripe customer every hour it changes, with a unique identifier per report (Stripe refuses a repeated identifier for 24 hours, and "last" never double-counts). Stripe multiplies by the price ($0.01 a unit), so the invoice equals our bill.
- Webhook `POST /v2/billing/stripe/webhook` (signature checked with `REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET`): `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.created|finalized|paid|payment_failed|voided|marked_uncollectible`.
- Dunning states on the account: `active`, `past_due` (a payment failed; Stripe retries), `unpaid` (retries ran out), `canceled`. Payment failure emails the owner once per invoice; `unpaid` and `canceled` take Pro away (no plan); a live account is then paused by the go-live gate. **Apps never stop working**: no SDK or purchase behaviour depends on the plan or the payment status.
- Usage alert emails, once per account, month and threshold: Pro when the bill reaches the $999 cap ("you will not pay more this month") and at 80% and 100% of $1,000,000 (Enterprise). The go-live gate's three emails are above.
- Billing page `/account/billing` (Cloud only): the account's stage (building, grace with its date, paused, Pro, Enterprise) with Start Pro, this month's tracked revenue (total and per project), the bill so far, the two plans with Start Pro (Checkout), Manage billing (Portal) or Contact sales (Enterprise), invoices with links to Stripe's hosted page and PDF, and banners for past due, unpaid and over Pro's ceiling. A banner on every page in grace and when paused; a panel with Start Pro wherever a 402 lands.
- Guard: a live key (`sk_live_` / `rk_live_`) is refused unless `REVENUEDOT_BILLING_LIVE=true`, so a development machine can never charge anyone.

Later
- Outcome add-ons (a share of recovered revenue, `business-model.md`): needs the revenue recovery features first.
- Annual prepay, Enterprise self-serve checkout, tax (Stripe Tax) and VAT ids.
- ~~Plan gates~~ decided 2026-10-02 and built: each plan lists `ee_features` (Pro: organizations, custom roles, single sign-on; Enterprise: all) and `audit_log_days` (90 on Pro and with no plan), and the Billing page shows each plan's `includes`. Apps and SDK calls never depend on the plan. Spec: `prd/enterprise/PRD.md` §2a.
- ~~What happens when a Free account passes $10,000~~ decided 2026-10-05: there is no Free plan; the go-live gate above.

## RevenueCat behaviour we match
RevenueCat bills on monthly tracked revenue too: free up to $2,500 a month, then 1% of all of it ([pricing](https://www.revenuecat.com/pricing)). We measure the same thing (gross USD revenue of production purchases in the month) and charge less: only the part above $10,000, at half the rate, with a cap. RevenueCat locks charts, customer lists, customer history and paywall and experiment editing for accounts over its limit without a card and never stops purchases; our paused stage locks the same kind of surfaces, earlier (at the first live sale plus 14 days) because a card costs nothing until $10,000.

## Endpoints and screens
- `GET /v2/billing` (session): `{ edition, account: { plan: none|pro|enterprise, status, cancel_at, current_period_end, has_payment_method }, gate: { stage, live_at, grace_ends_at, grace_days }, plans, usage: { month, tracked_revenue_usd, projects[], bill_usd, pro_bill_usd, free_up_to_usd, ceiling_usd, cap_usd }, flags, invoices[], stripe_ready }`. Self-host answers 404 "Billing is only on RevenueDot Cloud."
- `POST /v2/billing/checkout { plan: "pro" }` → `{ url }` (Stripe Checkout; `"standard"` is accepted as Pro's old name).
- `POST /v2/billing/portal` → `{ url }` (Customer Portal).
- `POST /v2/billing/stripe/webhook` (Stripe only).
- `GET /auth/me` keeps `account.plan` (none, pro, enterprise) and `account.billing_status`, and adds `account.gate` and `account.project_gates` (each project's owner's stage, `owner_is_you`, `owner_name`).
- Any API v2 project route in the paused list answers `402 plan_required` (`routes/v2/live-gate.ts`).

## Configuration (Cloud Worker secrets and vars)
| Name | What |
|---|---|
| `REVENUEDOT_BILLING_STRIPE_SECRET_KEY` | RevenueDot's own Stripe secret or restricted key (Circo). Test mode until launch |
| `REVENUEDOT_BILLING_STRIPE_WEBHOOK_SECRET` | `whsec_…` of the endpoint `https://api.revenuedot.app/v2/billing/stripe/webhook` |
| `REVENUEDOT_BILLING_PRICE_PRO` (or its old name `REVENUEDOT_BILLING_PRICE_STANDARD`) | The metered Pro price (`price_…`, $0.01 per unit, on the meter below) |
| `REVENUEDOT_BILLING_METER_EVENT` | The meter's event name (default `revenuedot_cloud_bill_cents`) |
| `REVENUEDOT_BILLING_LIVE` | `true` only in production, with live keys |
| `REVENUEDOT_BILLING_PLANS` | Optional JSON plan table |

Stripe setup (test mode first, then live): a meter `revenuedot_cloud_bill_cents` (aggregation `last`, customer mapping `stripe_customer_id`, value key `value`); a product "RevenueDot Pro" (renamed from "RevenueDot Cloud Standard" on 2026-10-05; the price is unchanged) with a monthly metered price of $0.01 per unit on that meter; the Customer Portal with cancellation at period end and payment method updates on; the webhook endpoint above with the events listed. Steps: `docs/cloud.md`.

## Stripe is the source of truth (hardening, 2026-10-03)
Stripe delivers webhooks at least once, in no guaranteed order, and retries for three days; a delivery can also be lost. So no event body decides an account's state:
1. **Every billing event re-reads Stripe.** Subscription, checkout and invoice events only say *which customer changed*. The handler lists that customer's subscriptions (`GET /v1/subscriptions?customer=…&status=all`) and the invoice (`GET /v1/invoices/{id}`), then writes what Stripe says now. An old event arriving late, the same event twice, or `checkout.session.completed` after `customer.subscription.deleted` all end in the same, current state.
2. **Which subscription counts.** A paying one (`active`, `trialing`, `past_due`) wins over one that is not (`unpaid`, `incomplete` from an abandoned Checkout, `paused`). Among paying ones: not set to end, then active over past due, then the one on file, then the oldest. Without a paying one, the live one on file, else the oldest live; with none live, the newest one (its end state). Any second `active`/`trialing`/`past_due` subscription is a duplicate: it is cancelled at once without proration (it would bill the same meter twice), and the server logs an error if Stripe refuses.
3. **Status and plan.** `active`/`trialing` → Pro, active; `past_due` → Pro, past due (everything keeps working, Stripe retries); `unpaid`, `incomplete`, `paused`, `canceled`, `incomplete_expired` → no plan with that status. `cancel_at` (or the period end when `cancel_at_period_end`) is shown as the end date.
4. **Emails follow the invoice, not the event.** "Payment failed" goes once per invoice, only while Stripe still has it open after a failed attempt; "payment recovered" only for an invoice that had the failed email and is now paid; "unpaid" once per subscription and invoice. A late `invoice.payment_failed` for an invoice that is already paid sends nothing.
5. **If Stripe cannot be read**, the webhook answers 500 so Stripe retries; nothing is written from the event body. An object Stripe does not have (`resource_missing`: deleted, or from the other mode) is acknowledged, never retried; an account whose customer Stripe no longer has loses its plan (the customer id is kept, so a wrong key heals once fixed) and its next Checkout makes a new customer.
5b. **One sync per customer at a time.** Each sync is a transaction holding a Postgres advisory lock on the customer (10-second lock timeout, then 500 and Stripe retries), with Stripe read inside it, so concurrent webhooks cannot write a stale read. Invoice events take the same lock. Emails are sent after the commit. The row is written only when something changed.
6. **Hourly reconcile.** Once an hour (claimed with a `billing_notices` row of the system user `__billing__`, so overlapping cron runs never repeat it), the billing pass re-reads every account that has a Stripe customer and is not settled (a live status, or changed in the last 7 days), at most 200 a run in a window that moves each hour. For past-due and unpaid accounts it also re-reads the latest invoice, so a lost invoice webhook is repaired too.
7. **One subscription per account.** Checkout first re-reads the customer's subscriptions: an active or past-due one means 409 "already on Pro"; an unpaid one is cancelled first (its open invoice stays payable), so the new subscription never shares the meter with it. Enterprise accounts get 409. Older open Checkout Sessions of the customer are expired before a new one is created, so two tabs cannot make two subscriptions.
8. **Return from Checkout.** `GET /v2/billing?sync=1` (the Billing page after `?checkout=success`) re-reads Stripe at most once every 5 seconds per account, so the plan shows even before the webhook lands.
9. **Stripe dunning setting.** When every retry fails, Stripe marks the subscription **unpaid** (Revenue recovery → Retries), which this code expects.

The billing key needs read on Subscriptions and Invoices and write on Subscriptions (to cancel a duplicate), besides Customers, Checkout Sessions, Customer portal and Billing Meter Events. The live key was checked for all of these on 2026-10-03.

## Plan access
The plan decides the bill, the `ee/` team features, and, for live accounts, the go-live gate. The SDK, purchase verification, entitlements and store notifications never depend on it: an app's paying customers must never lose what they bought because their developer's card failed or was never added.

## Tests that prove it
- `apps/server/test/billing.test.ts` against `packages/contract/src/fake-billing-stripe.ts`: the bill at $0, $9,999.99, $10,000, $10,001, $50,000, $209,800 (cap) and $2M; tracked revenue skips sandbox, trials, refunds and moved-in history; metering per owner across projects; Checkout and Portal requests; every webhook (signed, wrong signature refused, replay safe); dunning `past_due` → `active`, `unpaid` → no plan; meter events only when the bill changes, identifier per value; alert emails once per threshold; self-host has no billing; a live key is refused without `REVENUEDOT_BILLING_LIVE`.
- Journey `scripts/e2e/journeys/billing.ts`: a Cloud-edition server, real sign-up, a production Stripe purchase above the free limit, metering, the upgrade through the fake Checkout page, the signed webhooks, the meter event, a failed payment, the email and recovery.
- `apps/server/test/live-gate.test.ts`: the four stages, what marks an account live (not sandbox, not imported), the 402 list for session and secret key, sandbox reads, SDK untouched, held and released webhooks and integrations, emails once each, Pro and Enterprise never gated, self-host and Cloud without Stripe never gated.
- Playwright `apps/dashboard/e2e/billing.spec.ts`: the Billing page in each stage, Start Pro to the fake Checkout and back, Manage billing, the grace and paused banners, the 402 panel with the sandbox view still working.

## Known gaps
- Live mode is on (2026-10-03). The first real customer's month-end invoice is the first live charge; everything before it is proven on the sandbox with the same code (`scripts/e2e/real-stripe/billing.ts` and a manual run on 2026-10-03: real Checkout, a real $100.00 metered invoice on a test clock, a declined renewal, recovery, replayed and out-of-order events, a lost webhook repaired by the hourly pass).
- Stripe holds a usage invoice in draft until every webhook endpoint accepts `invoice.created` (up to 72 hours), then charges it. In live mode both endpoints (ours and DataFast's) answer 2xx.
- Metering reads the month's transactions of every project in one query per tick; fine for now, a rollup later.
- Enterprise accounts are set by hand (`billing_accounts.plan = 'enterprise'`); Stripe events never change them.
