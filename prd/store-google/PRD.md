# Google ingestion (scope 1.3)

**Status:** Google Play purchase tokens are checked with the Play Developer API (subscriptions v2 and one-time products) and acknowledged. Real-time notifications arrive through Pub/Sub push, and a daily scan catches voided purchases. Every test runs against a mocked Google. No real sandbox purchase has run yet, because that needs store credentials.

## Users and jobs
- **Android developers** upload a service account once. After that, renewals, holds, pauses and refunds arrive without extra code.
- **End users** do not lose purchases to Google's rule that refunds anything left unacknowledged for 3 days.
- **Operators on a dual run** forward the raw Pub/Sub messages to RevenueCat until they switch over.

## Essential now and later
Essential (Tier 1)
- Verify tokens, acknowledge subscriptions and non-consumables, and leave consumables for the SDK to consume.
- Map grace period, account hold, pause, cancel, restore, upgrades, downgrades and voided purchases to RevenueCat events.
- Answer 5xx for temporary failures so the SDK and Pub/Sub retry, and 2xx for messages that can never succeed.
- Support store actions: revoke, cancel, defer and order refunds (see `prd/rest-api/PRD.md`).

Later
- Anything beyond single-item subscriptions. The mapping tracks one line item per purchase.

## RevenueCat behaviour we match
- The receipt response says `should_consume: true` only for consumables, and the server never consumes them itself (https://www.revenuecat.com/docs/getting-started/making-purchases).
- The product mapping lists both the bare Play product ID and `product:base_plan` (`android/product_entitlement_mapping.json`).
- A grace period is BILLING_ISSUE plus CANCELLATION with reason BILLING_ERROR, and access continues until the grace period ends. Account hold ends access, and recovery is a RENEWAL (https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work).
- A scheduled pause sends SUBSCRIPTION_PAUSED with `auto_resume_at_ms` and keeps access until the pause starts (https://www.revenuecat.com/docs/subscription-guidance/managing-subscriptions).
- An upgrade starts a new chain with INITIAL_PURCHASE, and the replaced chain gets PRODUCT_CHANGE and ends (https://www.revenuecat.com/docs/subscription-guidance/managing-subscriptions).
- A voided purchase of the current period is CANCELLATION with reason CUSTOMER_SUPPORT and a negative price. Voided earlier periods are left alone (https://www.revenuecat.com/docs/subscription-guidance/refunds).
- A license tester purchase is sandbox (https://www.revenuecat.com/docs/test-and-launch/sandbox/google-play-store).
- Price increase consent sends PRICE_INCREASE_CONSENT_REQUIRED and then PRICE_INCREASE_CONSENT_APPROVED once each (https://www.revenuecat.com/docs/subscription-guidance/price-changes).

## Endpoints and screens
- `POST /v1/receipts` with a Play app. `fetch_token` is the purchase token. The code is in `apps/server/src/stores/google/index.ts`, `map.ts` and `sync.ts`.
- `POST /v1/notifications/google/{appId}` is the Pub/Sub push endpoint (`notifications.ts`). It stores every message, forwards the raw body, and checks the push's OIDC token when `pubsub_audience` is set.
- The daily voided-purchases scan runs inside the one-minute job in `apps/server/src/services/tick.ts` (`voided.ts`). A failed scan retries an hour later.
- `orders.batchGet` turns order IDs into purchase tokens for the importer (`api.ts`).
- `POST /v2/projects/{id}/apps/{app_id}/actions/verify_credentials` checks the service account.
- Dashboard: the app page `/projects/:projectId/apps/:appId` holds the service account, the Pub/Sub URL with its last received time, and the forwarding URL.

## Tests that prove it
- `apps/server/test/google.test.ts` (26 tests) covers the service-account token, `orders.batchGet`, receipt verification and acknowledgement, trials, testers, bad tokens (400, code 7103), outages (503, code 7101), consumables and non-consumables, and each notification kind: renewal, trial conversion, grace, hold, pause, cancel and restore, voided purchases, upgrades, unknown purchases, redelivery and OIDC checks.
- `apps/server/test/lifecycle-events.test.ts` (Google part) covers upgrades posted by the device, deferred replacements, price increase consent, system cancellation during a price increase, and the voided-purchases scan with its retry.
- `apps/server/test/store-actions.test.ts` covers revoke, defer, cancel and refund against a mocked Google.
- `apps/server/test/setup-endpoints.test.ts` covers credential checks and their error messages.

## Known gaps
- No real Play sandbox purchase has run end to end. It needs store credentials.
- The request bodies for `subscriptionsv2.revoke`, `cancel` and `defer` follow Google's reference but were tested only against mocks. Each needs one real sandbox run.
- CANCELLATION with reason PRICE_INCREASE is inferred: a system cancellation while a price change is still outstanding. RevenueCat does not document its Google rule.
- If an acknowledgement call fails, the server only logs it and relies on the SDK, which also acknowledges.
