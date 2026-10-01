# Amazon Appstore ingestion (Tier 2, "Stores: Amazon")

**Status:** Amazon receipts are checked with Amazon's Receipt Verification Service (RVS), and Amazon Real-time Notifications arrive through Amazon SNS with the SNS signature checked. The SDK's Amazon receipt route answers with real receipt data. Every test runs against a mocked Amazon and a test SNS certificate; no real Amazon purchase has run yet, because that needs an Amazon developer account and a Live App Testing build.

## Users and jobs
- **Android developers who also ship on Fire tablets and Fire TV** add one Amazon app with the package name and the shared key. Purchases from the RevenueCat Android SDK built with the Amazon store then unlock the same entitlements as Google Play purchases.
- **Operators** paste one notification URL into the Amazon Appstore Console so renewals, cancellations and one-time refunds arrive without the app opening.
- **End users** keep access through Amazon's grace period and see the same customer info on every device.

## Essential now and later
Essential (Tier 2)
- Verify every receipt with RVS before granting anything; never trust what the device posts about dates or state.
- Answer the SDK's `GET /v1/receipts/amazon/{store_user_id}/{receipt_id}` with Amazon's receipt data, so the SDK learns the term SKU and posts the purchase.
- Accept Amazon Real-time Notifications only with a valid SNS signature, confirm the SNS subscription by itself (Amazon's "Verified" label), and re-read the receipt from RVS for each notification.
- Answer 5xx for every temporary failure (Amazon down, throttled, our own errors) on `POST /v1/receipts`, so the SDK keeps the purchase unfulfilled and retries.

Later
- A periodic RVS re-check of active Amazon subscriptions without notifications (needs the Amazon user id stored per chain).
- Amazon tiered subscriptions with add-ons (`baseReceipts`).

## Credentials
Stored in `apps.credentials` like the other stores' credentials (no secret is ever returned by the API; `store_settings` says only whether it is set).

| Field | What it is | Where the developer finds it |
|---|---|---|
| `package_name` | The app's package name (stored in `apps.bundle_id`) | Amazon Appstore Console, app details |
| `shared_secret` | The Amazon developer "Shared Key", which RVS needs on every call | Developer Console → Settings → Identity → Shared Key |
| `sns_topic_arn` | Optional. When set, notifications from any other SNS topic are refused | The `TopicArn` of the first notification |
| `track_new_purchases` | Optional. Record purchases first seen in a notification (on an anonymous customer) | Dashboard switch |
| `notification_forward_url` | Optional. Every SNS message is copied there unchanged (dual run) | Dashboard field |

`POST /v2/projects/{id}/apps/{app_id}/actions/verify_credentials` calls RVS once with a made-up user and receipt: Amazon answers 496 for a wrong shared key and 400, 410 or 497 for a good one.

## Verification flow
1. The SDK buys through the Amazon Appstore. For subscriptions it first calls `GET /v1/receipts/amazon/{store_user_id}/{receipt_id}`; we call RVS and answer Amazon's JSON unchanged (the SDK reads `termSku`).
2. The SDK posts `POST /v1/receipts` with `X-Platform: amazon`, the Amazon app's public key (`amzn_…`), `fetch_token` = the receipt id, `store_user_id` = the Amazon user id, `product_ids` = [term SKU or SKU], `price` and `currency`, and the `marketplace` header.
3. The server calls RVS: `GET https://appstore-sdk.amazon.com/version/1.0/verifyReceiptId/developer/{shared_secret}/user/{store_user_id}/receiptId/{receipt_id}`. When production answers 400 (unknown receipt), it asks the RVS cloud sandbox (`…/sandbox/version/1.0/…`); a receipt found there is sandbox.
4. The receipt becomes a `VerifiedPurchase` (`apps/server/src/stores/amazon/map.ts`) and goes through the same purchase pipeline as Apple and Google: ownership and transfer rules, the core engine's `diffSubscription`, events, transactions and webhooks.

RVS answers and what the SDK sees:

| RVS | Meaning | `POST /v1/receipts` and the receipt-data route |
|---|---|---|
| 200 | Valid | 200 |
| 400 (production and sandbox) | Unknown receipt | 400 · 7103 (the SDK finishes it as invalid) |
| 410 | Receipt no longer valid (cancelled) | One-time purchases are recorded as refunded; a new subscription is 400 · 7103 |
| 496 | Wrong shared key | 500 · 7101, and the app's credentials are marked failing (alert email) |
| 497 | Unknown Amazon user | 400 · 7103 |
| 429, 5xx, timeout | Amazon temporarily unavailable | 503 · 7101 |
| No shared key saved | Configuration missing | 500 · 7101 |

## Notifications (Amazon Real-time Notifications)
- Endpoint: `POST /v1/notifications/amazon/{app_id}`. Amazon delivers RTN through Amazon SNS as JSON (`Content-Type: text/plain`).
- Every message's SNS signature is checked: `SigningCertURL` must be `https://sns.<region>.amazonaws.com/…pem`, the certificate is fetched (and cached) and the canonical string of the message is verified with RSA PKCS#1 v1.5 and SHA-1 (`SignatureVersion` 1) or SHA-256 (`SignatureVersion` 2). A bad signature, a foreign certificate host or another `TopicArn` than the pinned one is 400 and nothing else happens.
- `SubscriptionConfirmation` is confirmed by fetching its `SubscribeURL` (only on an SNS host). That is what turns Amazon's endpoint label to "Verified", and it counts as the app's first received notification.
- `Notification`: the `Message` is Amazon's JSON (`appPackageName`, `notificationType`, `appUserId`, `receiptId`, `relatedReceipts`, `timestamp`, `betaProductTransaction`). A package name other than the app's is stored and ignored. The receipt is re-read from RVS with `appUserId`, and the result is applied as a store update (never a transfer).
- Unknown receipts answer 200 and are ignored unless `track_new_purchases` is on.
- Every message is stored raw in `store_notifications` (id `amz_{app}_{MessageId}`, so SNS redeliveries are processed once) and forwarded to `notification_forward_url` when set.
- Temporary failures (RVS down, our own errors) answer 500 so SNS retries; permanent ones (bad receipt) answer 200 with the error stored.

## Mapping to the core engine
`VerifiedPurchase` fields come from RVS; the core engine (`packages/core/src/events.ts`) turns state changes into RevenueCat events.

| Amazon state | RevenueDot state | RevenueCat event |
|---|---|---|
| New `SUBSCRIPTION` receipt (`SUBSCRIPTION_PURCHASED`) | Chain keyed by receipt id; access until `renewalDate` | INITIAL_PURCHASE |
| `freeTrialEndDate` after the period start | `period_type` trial, price 0, access until the trial end | INITIAL_PURCHASE with TRIAL |
| Introductory promotion `InProgress` | `period_type` intro | INITIAL_PURCHASE with INTRO |
| `renewalDate` moved one term later (`SUBSCRIPTION_RENEWED`, `…_CONVERTED_FREE_TRIAL_TO_PAID`) | New period; transaction id `{receipt}.{period start ms}` | RENEWAL (with `is_trial_conversion`) |
| `autoRenewing` false (`SUBSCRIPTION_AUTO_RENEWAL_OFF`, `…_SCHEDULED_TO_END`) | `unsubscribe_detected_at` | CANCELLATION (UNSUBSCRIBE) |
| `autoRenewing` true again (`SUBSCRIPTION_AUTO_RENEWAL_ON`) | cleared | UNCANCELLATION |
| `gracePeriodEndDate` in the future (`SUBSCRIPTION_IN_GRACE_PERIOD`) | billing issue, grace until `gracePeriodEndDate` | BILLING_ISSUE, CANCELLATION (BILLING_ERROR) |
| Grace over (`SUBSCRIPTION_OUT_OF_GRACE_PERIOD`) or `cancelDate` passed (`SUBSCRIPTION_EXPIRED`, `SUBSCRIPTION_CANCELLED`) | access ends at `cancelDate` | EXPIRATION |
| `deferredSku` (`SUBSCRIPTION_MODIFIED_DEFERRED`) | `auto_renew_product_id` = deferred SKU | PRODUCT_CHANGE at the next renewal |
| `SUBSCRIPTION_MODIFIED_IMMEDIATE` with `relatedReceipts.cancelledReceiptId` | New chain; the cancelled receipt's chain ends now | INITIAL_PURCHASE, PRODUCT_CHANGE on the old chain |
| `CONSUMABLE_PURCHASED`, `ENTITLEMENT_PURCHASED` | One-time purchase keyed by receipt id | NON_RENEWING_PURCHASE |
| `CONSUMABLE_CANCELLED`, `ENTITLEMENT_CANCELLED`, or RVS `cancelDate` / 410 on a one-time receipt | `refunded_at` | CANCELLATION (CUSTOMER_SUPPORT), negative transaction |

- **Pause:** Amazon has no subscription pause, so SUBSCRIPTION_PAUSED never comes from Amazon.
- **Refunds of subscriptions:** RevenueCat never detects them, and neither do we: a subscription that Amazon cancels early ends at `cancelDate` with EXPIRATION.
- **Prorations:** Amazon handles tier changes itself; we record the new receipt's price as posted by the device.

## Products, prices, sandbox and USD
- **Product identifiers.** Subscriptions are identified by the term SKU (`termSku`, what the SDK posts), consumables and entitlements by their SKU. Catalog products for an Amazon app use those strings as `store_identifier`. A catalog product with the parent SKU also matches when no term SKU product exists.
- **Durations** come from RVS `term` ("1 Week", "1 Month", "3 Months", "1 Year", …), else from the catalog product's duration.
- **Prices.** RVS has no price. The receipt path takes the price and currency the SDK posts (the marketplace's local price); notifications keep the last known price for renewals.
- **USD** is converted at the purchase date's rate by the same `usdValue` as other stores (`services/fx.ts`).
- **Sandbox.** `testTransaction`, `betaProduct` (Live App Testing) or a receipt found only in the RVS cloud sandbox (App Tester) is sandbox, so it never counts in production charts. Amazon's accelerated test timelines are not supported, as with RevenueCat.

## RevenueCat behaviour we match
- The Amazon app needs the package name and the Shared Key from Developer Console → Settings → Identity (https://www.revenuecat.com/docs/service-credentials/amazon-appstore-credentials).
- Real-time notifications are optional; a notification for a receipt the server has never seen is ignored, and the console shows "Verified" once the endpoint answers (https://www.revenuecat.com/docs/platform-resources/server-notifications/amazon-server-notifications).
- Amazon has no grace period setting of its own in RevenueCat's table, and Amazon refunds are not detected for subscriptions (https://www.revenuecat.com/docs/subscription-guidance/refunds, https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work). We still honour `gracePeriodEndDate` when RVS sends it.
- Live App Testing purchases are validated and are sandbox (https://www.revenuecat.com/docs/test-and-launch/sandbox/amazon-store-sandbox-testing).
- The SDK reads only `termSku` from the receipt-data route, which needs the shared secret (`AmazonBilling.kt` in `revenuedot/purchases-android`; fixture `android/amazon_receipt_response.json`).
- Webhooks report `store: AMAZON` and a flat 30% commission.

## Endpoints and screens
- `POST /v1/receipts` with an Amazon app (`apps/server/src/stores/amazon/index.ts`).
- `GET /v1/receipts/amazon/{store_user_id}/{receipt_id}` (`apps/server/src/routes/sdk.ts`); the receipt id is not URL-encoded by the SDK and can contain `/`.
- `POST /v1/notifications/amazon/{app_id}` (`apps/server/src/stores/amazon/notifications.ts`); SNS checks in `sns.ts`, the RVS client in `api.ts`, the mapping in `map.ts`.
- `POST /v2/projects/{id}/apps` and `POST /v2/projects/{id}/apps/{app_id}` accept `amazon: { package_name, shared_secret, sns_topic_arn, track_new_purchases, notification_forward_url }`.
- `GET …/store_settings` shows `shared_secret.configured`, the notification URL and its last received time; `POST …/actions/verify_credentials` takes `amazon: { package_name, shared_secret }`.
- Dashboard: Add app → Amazon Appstore; the app page holds the package name, the Shared Key with "Check credentials", the RTN URL with its live status, and the forwarding URL.

## Tests that prove it
- `apps/server/test/amazon.test.ts` (25 tests, fake RVS in `amazon-helpers.ts`): RVS URLs and the cloud-sandbox fallback; term names; the receipt-data route (a receipt id with `/`, `=` and `:`; 7103, 7662, 503 and 500 answers); receipts for subscriptions, trials, intro offers, consumables, entitlements, Live App Testing and App Tester; every RVS error code and its SDK answer, with a rejected key marking the app's credentials failing; SNS signatures (SignatureVersion 1 and 2, a tampered message, a foreign or plain-HTTP certificate host, an expired certificate) with an RSA certificate generated in the test; a pinned topic; subscription confirmation; renewal, trial conversion, auto-renew off and on, expiration, grace and out of grace, deferred and immediate tier changes, one-time refunds by notification and by RVS 410, unknown receipts with and without tracking, another package, outages and retry, redelivery, forwarding, and the expiration worker; app creation with the shared key and `verify_credentials`.
- `packages/contract/test/sdk-inventory.test.ts`: the receipt-data row (#25) is Real; `sdk-endpoints.test.ts`: a non-Amazon key gets 7662.
- `apps/dashboard/e2e/stores.spec.ts`: Add app → Amazon Appstore, the shared key with a live check against the e2e server's in-process RVS fake, the SNS topic field, the notification URL and status, the SDK snippet.

## Known gaps
- No real Amazon purchase has run end to end; it needs an Amazon developer account, a Live App Testing build and the shared key.
- RVS is called again only when the device posts or a notification arrives; there is no scheduled re-check yet.
- Prices come from the device; Amazon notifications never carry a price.
