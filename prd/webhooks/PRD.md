# Webhooks out (scope 1.7)

**Status:** RevenueDot sends 18 of RevenueCat's 21 event types, in RevenueCat's payload shape, with an optional Authorization header and an HMAC signature. The other 3 describe things RevenueDot never does (below), so they stay filters that never fire. Failed deliveries retry 5 times and are logged, and the dashboard can resend them. Every sent type is checked key by key against RevenueCat's sample payload or, where RevenueCat publishes none, its field table (branch `tier2-v2-events`, 2026-10-01).

## Users and jobs
- **Backend developers** reuse the webhook handler they wrote for RevenueCat without changes.
- **Operators** see which deliveries failed and send them again.
- **Teams** send sandbox and production events to different URLs and pick which event types each URL gets.

## Essential now and later
Essential (Tier 1)
- Match RevenueCat's payload shape: the same keys, nulls where RevenueCat sends nulls, and timestamps in milliseconds.
- Send the Authorization header and the `X-RevenueCat-Webhook-Signature` HMAC, with a new signature on every attempt.
- Retry 5 times, filter by environment, event type and app, keep a delivery log, retry by hand, and send a test event.

Tier 2 (this change)
- All 21 event types decided, one by one (table below). SUBSCRIBER_ALIAS is now sent; the three that need facts RevenueDot never has stay filter-only, with the reason written down.
- `offer_code` carries the App Store or Google Play offer id (`prd/win-back-offers/PRD.md`).

## The 21 event types
| Event | Sent | When RevenueDot sends it | Checked against |
|---|---|---|---|
| TEST | yes | `POST .../integrations/webhooks/{id}/test` | purchase shape (`apps/server/test/setup-endpoints.test.ts`) |
| INITIAL_PURCHASE | yes | first purchase of a chain (paid or trial), promotional grants | `initial_purchase.json`, `trial_started.json` |
| RENEWAL | yes | new period, resubscription (win-back included), trial conversion | `renewal.json` |
| CANCELLATION | yes | auto-renew off, billing error, refund (`CUSTOMER_SUPPORT`) | `cancellation.json`, `refund.json` |
| UNCANCELLATION | yes | auto-renew back on | `uncancellation.json` |
| NON_RENEWING_PURCHASE | yes | one-time purchases | `non_renewing_purchase.json` |
| SUBSCRIPTION_PAUSED | yes | Google Play pause scheduled | `subscription_paused.json` |
| EXPIRATION | yes | access ends (the one-minute tick and store notifications) | `expiration.json` |
| BILLING_ISSUE | yes | charge failed | `billing_issue.json` |
| PRODUCT_CHANGE | yes | upgrade, downgrade, crossgrade | `product_change.json` |
| SUBSCRIPTION_EXTENDED | yes | Apple extend, Google defer, a longer expiry in the same period | `subscription_extended.json` |
| REFUND_REVERSED | yes | Apple refund reversed | `refund_reversed.json` |
| TRANSFER | yes | a purchase moves to another app user id | `transfer.json` |
| VIRTUAL_CURRENCY_TRANSACTION | yes | a product grant credits a balance, an API adjustment, an SDK spend | `in-app_currency_transaction.json` |
| EXPERIMENT_ENROLLMENT | yes | a customer joins an offering experiment | `experiment_enrollment.json` |
| PRICE_INCREASE_CONSENT_REQUIRED | yes | the store asks the customer to accept a higher price | RevenueCat's field table |
| PRICE_INCREASE_CONSENT_APPROVED | yes | the customer accepted | RevenueCat's field table |
| SUBSCRIBER_ALIAS | yes, opt-in | a new app user id joins an existing customer | RevenueCat's field table (no sample) |
| TEMPORARY_ENTITLEMENT_GRANT | never | RevenueDot never grants unverified access | `temporary_entitlement_grant.json` kept for the day it does |
| INVOICE_ISSUANCE | never | RevenueCat Billing only | `invoice_issued.json` kept |
| PURCHASE_REDEEMED | never | no web purchases to redeem yet | `purchase_redeemed.json` kept |

**SUBSCRIBER_ALIAS.** RevenueCat: "a new App User ID was registered for an existing subscriber", deprecated, "new projects don't receive this webhook", with the common and subscriber identity fields (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields). RevenueDot records it whenever an app user id joins an existing customer: `logIn` of a new id on an anonymous customer, `logIn` that merges the anonymous customer into an existing one, Android's `POST /v1/subscribers/{id}/alias`, and the receipt merges (an anonymous owner merged into the poster, an anonymous poster merged into the owner, and the "share" transfer behaviour). `app_user_id` is the new id. It is always in the customer's event history, but it is delivered only to webhooks and integrations whose event filter names it. A webhook with no filter, like a new RevenueCat project, never gets it.

**TEMPORARY_ENTITLEMENT_GRANT** is RevenueCat granting up to 24 hours of access when it cannot validate a purchase with the store. RevenueDot never grants access it has not verified. During a store outage `POST /v1/receipts` answers 5xx, so the SDK keeps the transaction, retries it, and grants access on the device from the cached product mapping (`prd/offline-entitlements/PRD.md`). The customer keeps access either way, without the server trusting an unchecked purchase token.

**INVOICE_ISSUANCE** fires when RevenueCat Billing issues an unpaid invoice, and RevenueCat's table marks it RevenueCat Billing only, not even Stripe. RevenueDot has no billing engine of its own. The Stripe store (PR #3) uses the customer's own Stripe Billing, where RevenueCat does not send it either.

**PURCHASE_REDEEMED** fires when a web purchase (Stripe, Paddle or RevenueCat Billing) is redeemed in the app through a redemption link. RevenueDot issues no redemption links, so `POST /v1/subscribers/redeem_purchase` answers 7849 and nothing is ever redeemed. PR #3 adds Stripe purchases but no redemption links. When redemption lands, the event's fields are RevenueCat's sample (`purchase_redeemed.json`).

Later
- PURCHASE_REDEEMED with web purchase redemption.

## RevenueCat behaviour we match
- Only an HTTP 200 counts as delivered. Retries come after 5, 10, 20, 40 and 80 minutes, and the request times out after 60 seconds (https://www.revenuecat.com/docs/integrations/webhooks).
- The signature header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (https://www.revenuecat.com/docs/integrations/webhooks).
- The body is `{ "api_version": "1.0", "event": {...} }` with the keys of each sample payload, compared against `packages/contract/fixtures/webhooks/*.json` (https://www.revenuecat.com/docs/integrations/webhooks/sample-events).
- Store names are upper case, refunds carry a negative price, and events without money movement report price 0 (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
- Promotional grants leave `app_id` out, as RevenueCat does for the PROMOTIONAL store (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
- TRANSFER carries `transferred_from` and `transferred_to` (`fixtures/webhooks/transfer.json`).

## Endpoints and screens
- Delivery code: `apps/server/src/services/webhooks.ts` (signing, one attempt, `deliverDue`, retry). Events are queued in `services/events.ts`. The one-minute job in `services/tick.ts` sends due deliveries and records EXPIRATION.
- `GET`, `POST` `/v2/projects/{id}/integrations/webhooks`, plus `GET`, `POST` and `DELETE .../{webhook_integration_id}`. RevenueCat's API returns the signing secret only when a webhook is created.
- Extensions: `GET /v2/projects/{id}/webhooks/{webhook_id}/deliveries` (`?status=`), `POST .../deliveries/{delivery_id}/retry`, and `POST /v2/projects/{id}/integrations/webhooks/{id}/test`.
- The same queue also feeds the third-party integrations (Slack, Segment, Amplitude ...): `queueDeliveries` queues each event to matching integrations too, and the tick sends them with the same retry schedule. See `prd/integrations/PRD.md`.
- Dashboard: `/projects/:projectId/integrations/webhooks` (list), `/new`, `/:webhookId` (details and delivery log with retry) and `/:webhookId/edit` (`apps/dashboard/src/pages/setup/Webhooks.tsx`).

## Tests that prove it
- `packages/contract/test/webhook-payloads.test.ts` drives one of every sent event type through the real pipeline. It compares keys, nulls and millisecond fields with RevenueCat's samples (17 samples), checks the price-consent pair and SUBSCRIBER_ALIAS against RevenueCat's field table, checks that SUBSCRIBER_ALIAS reaches only webhooks that ask for it, checks promotional events without `app_id`, and checks that the three filter-only types are never produced.
- `packages/contract/test/rest-webhooks.test.ts` ("webhooks", 3 tests) covers the Authorization header, a valid HMAC, 200 as the only success, the 5-step retry schedule, and environment and event type filters.
- `packages/contract/test/v2-catalog.test.ts` ("webhook integrations") covers the one-time signing secret and event type and environment mapping.
- `packages/contract/test/v2-auth-extensions.test.ts` covers the delivery log, manual retry, and setup health that reports failing endpoints.
- `apps/server/test/setup-endpoints.test.ts` covers the signed TEST event and all 21 event types in the filter.
- `apps/dashboard/e2e/setup.spec.ts` creates a webhook with an event filter in the browser, shows the signing secret once, and checks signed deliveries, retry and the test event.
- Outside this repo, `scripts/e2e-webhook.sh` in `revenuedot/examples` delivers a real signed webhook to 17 sample receivers.

## Known gaps
- `renewal_number` is sent on REFUND_REVERSED only, where RevenueCat's sample has it.
- `metadata` is not sent. It exists only for RevenueCat Billing.
- TEMPORARY_ENTITLEMENT_GRANT, INVOICE_ISSUANCE and PURCHASE_REDEEMED can be selected as filters but are never sent (reasons above).
