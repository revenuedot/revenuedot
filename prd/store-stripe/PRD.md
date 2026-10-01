# Stripe subscriptions from the customer's own Stripe account (Tier 2, "Stores: Stripe")

**Status:** A Stripe app holds a restricted API key and a webhook signing secret from the developer's own Stripe account. Subscriptions and Checkout Sessions posted to `POST /v1/receipts` with `X-Platform: stripe` are read from Stripe's API, and Stripe webhooks are accepted only with a valid `Stripe-Signature`. Every test runs against a mocked Stripe API with Stripe's documented object and event shapes; no real Stripe account or key is used.

## Users and jobs
- **Developers who sell on the web with their own Stripe Checkout or Billing** post each new subscription or Checkout Session from their backend, and the same entitlements unlock in their mobile apps.
- **Operators** add one webhook endpoint in Stripe so renewals, failed payments, cancellations and refunds arrive without polling.
- **End users** who pay on the web get access in the app as soon as they sign in with the same app user id.

## Essential now and later
Essential (Tier 2)
- Read every purchase from Stripe's API with the developer's key; never trust the posted body for state.
- Verify the `Stripe-Signature` HMAC (and its timestamp) on every webhook before acting on it.
- Map subscription status, trials, failed payments, cancellations, pauses, product changes and refunds to the core engine and RevenueCat's event names.
- Answer 5xx for every temporary failure on `POST /v1/receipts` (Stripe down, rate limited, an unpaid first invoice), 4xx only for what will never succeed.

Later (Tier 3, with RevenueDot's own Stripe platform)
- Stripe Connect OAuth ("Connect with Stripe" button) instead of pasting a restricted key; hosted checkout and Web Billing.
- Subscription schedules (a downgrade scheduled for the next period through a schedule), metered and tiered prices, multi-item subscriptions.
- A periodic re-check of active subscriptions without webhooks.

## Credentials
Stored in `apps.credentials` like the other stores' credentials; secrets are never returned by the API.

| Field | What it is |
|---|---|
| `stripe_secret_key` | A restricted key (`rk_live_…` or `rk_test_…`) with read access to Subscriptions, Invoices, Checkout Sessions, Charges, Customers, Products and Prices. A secret key (`sk_…`) also works; a publishable key (`pk_…`) is refused |
| `stripe_webhook_secret` | The endpoint's signing secret (`whsec_…`) |
| `stripe_account_id` | Optional `acct_…`: sent as `Stripe-Account` when the key is a Connect platform key acting for a connected account (RevenueCat's v2 field) |
| `app_user_id_source` | How a purchase first seen in a webhook finds its customer: `metadata` (default), `customer_id` or `anonymous` |
| `app_user_id_metadata_key` | The metadata key read on the Checkout Session or Subscription (default `app_user_id`) |
| `register_on` | `invoice_paid` (default): a subscription counts once its latest invoice is paid. `invoice_created`: it counts while that invoice is still open |
| `track_new_purchases` | Record purchases first seen in a webhook |
| `notification_forward_url` | Optional copy of every webhook body (dual run) |

Live and test mode: a key's mode decides the environment. Objects with `livemode: false` (test-mode keys and Stripe sandboxes) are sandbox data. Like RevenueCat, use one Stripe app per Stripe account or sandbox.

`POST /v2/projects/{id}/apps/{app_id}/actions/verify_credentials` with `stripe: { stripe_secret_key }` lists one subscription and one Checkout Session: 401 means a bad key, 403 names the missing permission, and the answer says whether the key is live or test.

## Entry points
- **REST, from the developer's backend:** `POST /v1/receipts` with `X-Platform: stripe`, `Authorization: Bearer <the Stripe app's public key strp_…>` (or a secret `sk_` key), and `{ app_user_id, fetch_token }`, where `fetch_token` is a subscription id (`sub_…`) or a Checkout Session id (`cs_…`). Send it after `customer.subscription.created` or `checkout.session.completed`.
- **Webhooks:** `POST /v1/notifications/stripe/{app_id}`.

### Verification flow
1. `sub_…`: `GET /v1/subscriptions/{id}?expand[]=latest_invoice`.
2. `cs_…`: `GET /v1/checkout/sessions/{id}?expand[]=line_items`. `mode: subscription` continues with its subscription; `mode: payment` with `payment_status: paid` is a one-time purchase per line item, keyed by the PaymentIntent id. A session still `open` (payment not done) is 503 · 7101, so the backend retries; an `expired` session is 400 · 7103.
3. The result becomes `VerifiedPurchase`s (`apps/server/src/stores/stripe/map.ts`) and goes through the shared purchase pipeline.

| Stripe answer | `POST /v1/receipts` |
|---|---|
| 200 | 200 with customer info |
| 404 `resource_missing`, a token that is neither `sub_` nor `cs_`, an `incomplete_expired` subscription | 400 · 7103 |
| 401, 403 (bad or under-permissioned key) | 500 · 7101, and the app's credentials are marked failing |
| No key saved | 500 · 7101 |
| 429, 5xx, network error, timeout | 503 · 7101 |
| First invoice not paid yet under `register_on: invoice_paid` | 503 · 7101 |

## Webhooks
- Signature: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`. We compute HMAC-SHA256 with the signing secret over `"<t>.<raw body>"`, compare in constant time against every `v1`, and refuse a timestamp more than 5 minutes from the server clock. Missing secret, missing header or a mismatch is 400 (Stripe retries; RevenueCat also answers 400 for a wrong secret).
- Events handled; each re-reads the subscription from Stripe so out-of-order delivery cannot roll state back:

| Event | What happens |
|---|---|
| `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.trial_will_end` | Sync the subscription |
| `invoice.updated`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed` | Sync the invoice's subscription |
| `checkout.session.completed` | Subscription mode: sync it with the session's metadata as the app user id hint. Payment mode: record the one-time purchase |
| `charge.refunded` | A full refund of the latest subscription invoice marks that period refunded; a full refund of a one-time purchase marks it refunded |
| anything else | 200, stored and ignored (RevenueCat answers 400 and Stripe ends up disabling the endpoint; we do not) |

- Every event is stored raw in `store_notifications` (id `stripe_{app}_{event id}`), so redelivered events are processed once, and forwarded to `notification_forward_url` when set.
- Unknown purchases answer 200 and are ignored unless `track_new_purchases` is on; then the customer comes from `app_user_id_source`.
- Temporary failures answer 500, so Stripe retries for up to three days.

## Mapping to the core engine

| Stripe state | RevenueDot state | RevenueCat event |
|---|---|---|
| `active`, latest invoice paid | Chain keyed by subscription id; period = `current_period_start` to `current_period_end` (read from the subscription item on API versions from 2025-03-31); transaction id = the paid invoice id | INITIAL_PURCHASE |
| `trialing` | `period_type` trial, price 0, access until `trial_end` | INITIAL_PURCHASE with TRIAL |
| A new paid invoice for the next period (`billing_reason: subscription_cycle`) | New period | RENEWAL (`is_trial_conversion` after a trial) |
| `cancel_at_period_end: true` or a future `cancel_at` | `unsubscribe_detected_at` = `canceled_at` | CANCELLATION (UNSUBSCRIBE; BILLING_ERROR when `cancellation_details.reason` is `payment_failed`) |
| Cancellation undone | cleared | UNCANCELLATION |
| `past_due` (renewal invoice open) | Billing issue; access to the end of the paid period, and grace until the invoice's `next_payment_attempt` | BILLING_ISSUE, CANCELLATION (BILLING_ERROR) |
| Paid after `past_due` | New period | RENEWAL |
| `unpaid`, or `past_due` with no retry left | Access ends at the end of the paid period | EXPIRATION (BILLING_ERROR) |
| `canceled` (`customer.subscription.deleted`) | Access ends at `ended_at` | CANCELLATION if not seen before, EXPIRATION |
| `pause_collection` with `resumes_at` | `auto_resume_date`; access to the end of the paid period | SUBSCRIPTION_PAUSED, later EXPIRATION (SUBSCRIPTION_PAUSED) |
| `paused` status (trial ended without a payment method) | Access ends now | EXPIRATION |
| Price or product of the item changed | `product_id` changes on the same chain; with immediate proration the paid period stays | PRODUCT_CHANGE (RENEWAL as well when a new period starts) |
| `charge.refunded` (full) for the latest period | `refunded_at`; access ends at the refund | CANCELLATION (CUSTOMER_SUPPORT), negative transaction |
| `checkout.session.completed` in payment mode | One-time purchase (consumable or not, by the catalog) | NON_RENEWING_PURCHASE |
| One-time charge fully refunded | `refunded_at` | CANCELLATION (CUSTOMER_SUPPORT) |

- **Prorations:** a proration invoice in the middle of a period is not a new period, so it records no RENEWAL; its amount is not counted as revenue (RevenueCat also leaves prorations out of MRR and revenue).
- **A renewal after a refunded period** is a RENEWAL, not REFUND_REVERSED (`packages/core/src/events.ts`).
- **Coupons:** the period's price is what the invoice charged (`amount_paid`), so discounts show in revenue; the period type stays NORMAL.

## Products, prices and USD
- **Product identifiers.** A catalog product of a Stripe app is the Stripe product id (`prod_…`, RevenueCat's rule) or a price id (`price_…`, to sell several prices of one product as separate products). The price id wins when both exist.
- **Prices** come from the invoice (`amount_paid`, or the price's `unit_amount × quantity` for an open invoice), in the invoice currency. Zero-decimal currencies (JPY, KRW, …) are not divided by 100.
- **USD** is converted at the period start's rate with the shared `usdValue` (`services/fx.ts`). Webhooks report `store: STRIPE` with no store commission.
- **Country** is the customer's address country when Stripe returns it on the invoice (`customer_address.country`).

## RevenueCat behaviour we match
- Purchases are tracked by posting `fetch_token` = `sub_…` or a Checkout Session id with `X-Platform: stripe` and the Stripe app's public key; one-time purchases need a Checkout Session (https://www.revenuecat.com/docs/web/integrations/stripe/track-external-purchases).
- "Subscription purchase recognition": register on invoice created or on invoice paid, paid being the default (same page).
- Webhook events: `customer.subscription.updated`, `.deleted`, `charge.refunded`, `invoice.updated`, plus `customer.subscription.created` and `checkout.session.completed` to track new purchases; the webhook signing secret is stored; app user ids come from anonymous ids, the Stripe customer id or a metadata key (https://www.revenuecat.com/docs/platform-resources/server-notifications/stripe-server-notifications).
- Stripe products are identified by their `prod_` id (https://www.revenuecat.com/docs/getting-started/entitlements/stripe-products).
- Test mode and Stripe sandboxes are sandbox data, one config per sandbox (https://www.revenuecat.com/docs/web/integrations/stripe).
- Failed payments follow Stripe's own retry settings: cancel, mark unpaid or leave past due (https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work).

## Endpoints and screens
- `POST /v1/receipts` with a Stripe app (`apps/server/src/stores/stripe/index.ts`); the API client is `api.ts`, the mapping `map.ts`, webhooks `notifications.ts` and the signature check `signature.ts`.
- `POST /v1/notifications/stripe/{app_id}`.
- `POST /v2/projects/{id}/apps` and `…/apps/{app_id}` accept `stripe: { stripe_account_id, stripe_secret_key, stripe_webhook_secret, app_user_id_source, app_user_id_metadata_key, register_on, track_new_purchases, notification_forward_url }`. `GET …/store_settings` shows which secrets are set (the key's mode and last four characters, never the key), the webhook URL and its last received time.
- Dashboard: Add app → Stripe; the app page holds the restricted key with "Check credentials", the webhook URL with the events to select and its live status, the signing secret, how app user ids are found, and when purchases count.

## Tests that prove it
- `apps/server/test/stripe.test.ts` (22 tests, fake Stripe API in `stripe-helpers.ts` with objects in Stripe's documented shapes): the signature scheme checked against an independent HMAC, several `v1` values, tolerance and tampering; receipts for subscriptions and Checkout Sessions in both modes (a zero-decimal currency included), price ids over product ids, secret keys, `Stripe-Account`; every error class and its status (a rejected key marks the app's credentials failing); `register_on`; webhooks refused without a secret or with a bad signature; renewal, redelivery, trial conversion, cancel and uncancel, deletion, past due with grace and recovery, unpaid, pause, product change with proration, refund then renewal, one-time refund through the PaymentIntent, API 2025-03-31 shapes, unknown purchases with each app user id source, outages and retry, forwarding with the signature; app creation and `verify_credentials` (401, 403 naming the permission, outages).
- `packages/core/test/events.test.ts`: a renewal after a refunded period is RENEWAL, a refund taken back in the same period REFUND_REVERSED.
- `apps/dashboard/e2e/stores.spec.ts`: Add app → Stripe, the restricted key and signing secret with validation and a live check against the e2e server's in-process Stripe fake, the purchase rules, a subscription posted to `/v1/receipts` and a Stripe-signed webhook that turns the open page green, no secret in any API answer, phone width.

## Known gaps
- No real Stripe account has been used; every call is checked against mocks built from Stripe's documented shapes.
- Connect OAuth, subscription schedules, multi-item and metered subscriptions are not supported (see Later).
- There is no scheduled re-check without webhooks; a cancellation shows when its webhook arrives or the backend posts the subscription again.
