# Paddle, Roku and Samsung Galaxy Store (Tier 3, "More stores")

**Status:** spec for branch `tier3-stores`. All three stores work like the Amazon and Stripe stores: an app type with sealed credentials and a live credential check, the receipt endpoint the SDKs call, signed server notifications, the mapping to the core engine, REST v2 shapes, charts, webhooks and integrations, Import products where the store has a catalog API, a dashboard setup page and docs. No account exists with any of the three stores yet, so every store call is tested against fakes built from the stores' documented shapes (`packages/contract/src/fake-paddle.ts`, `fake-roku.ts`, `fake-galaxy.ts`).

Research behind this spec (2026-10-01), with sources:
- RevenueCat: [Paddle Billing](https://www.revenuecat.com/docs/web/integrations/paddle), [Paddle server notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/paddle-server-notifications), [Roku install](https://www.revenuecat.com/docs/getting-started/installation/roku), [Roku credentials](https://www.revenuecat.com/docs/service-credentials/roku-credentials), [Galaxy setup](https://www.revenuecat.com/docs/platform-resources/galaxy-platform-resources/galaxy-setup-guide), [Galaxy server notifications](https://www.revenuecat.com/docs/platform-resources/server-notifications/galaxy-server-notifications), [Galaxy products](https://www.revenuecat.com/docs/getting-started/entitlements/galaxy-products), [event support per store](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields), [v1 transactions](https://www.revenuecat.com/docs/api-v1/transactions), [grace periods](https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work), and the v2 OpenAPI app objects (`PaddleApp`, `RokuApp`).
- SDKs: the RevenueCat Roku SDK ([RevenueCat/purchases-roku](https://github.com/RevenueCat/purchases-roku), `source/Purchases.brs`), and our forks `revenuedot/purchases-android` (`feature/galaxy`, artifact `purchases-store-galaxy`), `purchases-hybrid-common` and `react-native-purchases` (`react-native-purchases-store-galaxy`).
- Stores: [Paddle API](https://developer.paddle.com/api-reference/overview) and [webhook signatures](https://developer.paddle.com/webhooks/about/signature-verification); [Roku Pay web services](https://developer.roku.com/dev/docs/roku-web-service), [Roku push notifications (JWT)](https://developer.roku.com/dev/docs/push-notifications-jwt), [subscription on hold](https://developer.roku.com/dev/docs/subscription-on-hold); [Samsung IAP server API](https://developer.samsung.com/iap/programming-guide/samsung-iap-server-api.html), [subscription API](https://developer.samsung.com/iap/api/iap-subscription-api.html), [access tokens](https://developer.samsung.com/galaxy-store/galaxy-store-developer-api/create-an-access-token.html), [publish API](https://developer.samsung.com/iap/api/iap-publish-api.html), [Instant Server Notifications](https://developer.samsung.com/iap/isn/jwt/payload.html).

RevenueCat documents setup for all three but not how each store event becomes a RevenueCat event. Rows marked *inferred* below are our design, chosen to match how RevenueCat treats Stripe, Google Play and Amazon.

## Users and jobs
- **Web and desktop developers who sell through Paddle** (merchant of record, so tax is handled) post each Paddle subscription or transaction from their backend; the same entitlements unlock in their mobile apps.
- **TV developers on Roku** use RevenueCat's Roku SDK with the proxy URL pointed at RevenueDot; purchases made with Roku Pay unlock entitlements shared with their other platforms.
- **Android developers who also ship on Samsung Galaxy devices** build their app with `purchases-store-galaxy` (or `react-native-purchases-store-galaxy`) and a `galx_` key; Galaxy Store purchases unlock the same entitlements as Google Play.
- **Operators** paste one notification URL (or click Apply in Paddle) so renewals, failed payments, cancellations and refunds arrive without polling, and see each store's last notification on the app page.

## What is the same for all three
- Secrets are sealed with AES-256-GCM in `apps.secrets` (`services/store-secrets.ts`); `apps.secret_hints` holds only "set", or for a Paddle key its environment and last four characters. No API answer ever returns a secret.
- Every store call goes through the outbound guard (`guardedFetch`), never follows a redirect and never puts a secret into an error message.
- `POST /v1/receipts`: 400 · 7103 only for a purchase the store says does not exist or was never paid; 500 · 7101 for missing or rejected credentials (and the app's credentials are marked failing, which drives the alert email); 503 · 7101 for every temporary failure and for "not paid yet", so the SDK or backend retries.
- Notifications: verified before anything is stored under the store's own id or forwarded; a refused body is stored with the reason under an id of its own and answered 400. Verified bodies are stored raw in `store_notifications` (redeliveries are processed once), forwarded to `notification_forward_url` when set, and applied by re-reading the purchase from the store, so delivery order never rolls state back. Unknown purchases are ignored (200) unless `track_new_purchases` is on. Temporary failures answer 500 so the store retries.
- A purchase posted again keeps what notifications recorded (refunds, the first billing issue or cancellation seen): Paddle, Roku and Galaxy join Amazon and Stripe in `MERGED_ON_RECEIPT` (`stores/rows.ts`).
- Charts, the Overview, customer pages, REST v2, webhooks and integrations need no store-specific code: they read the same subscription, purchase, transaction and event rows. Store labels are added where lists name stores (charts' store segment, dashboard labels, the first-sale card). Webhooks report `store: PADDLE`, `ROKU` or `GALAXY`.
- Store commission for take-home estimates (`packages/core/src/events.ts` `commission`): Galaxy 30% (Samsung's standard share), Roku 20% (Roku Pay's standard share), Paddle 5% (Paddle's standard fee; the 50¢ per transaction is not modelled). RevenueCat publishes no rate for these stores, so these are estimates and say so in the docs.
- Moves between servers (`services/archive/import.ts`) list the three notification URLs to update, like the other stores.

## Paddle Billing

### Credentials (app type `paddle`, public key prefix `pdl_`)
| Field | What it is |
|---|---|
| `paddle_api_key` | Sealed. A server-side API key: `pdl_live_apikey_…` or `pdl_sdbx_apikey_…` (69 characters; the prefix decides live or sandbox), or a 50-character key from before 2025-05-06. RevenueCat's v2 field name. Needs read access to Subscriptions, Transactions, Adjustments, Customers, Products and Prices; write access to Notification settings (for Apply in Paddle) and Customer portal sessions (for management links) |
| `paddle_is_sandbox` | Only for 50-character keys, which carry no environment (RevenueCat's deprecated v2 field). New keys ignore it |
| `paddle_webhook_secret` | Sealed. The notification destination's secret key (`pdl_ntfset_…`). Set by Apply in Paddle, or pasted |
| `paddle_notification_setting_id` | The `ntfset_…` that Apply in Paddle created, so a second click updates it instead of adding another |
| `app_user_id_source` | How a purchase first seen in a notification finds its customer: `custom_data` (default) or `anonymous`, RevenueCat's two options |
| `app_user_id_custom_data_key` | The `custom_data` key read on the subscription and the transaction (default `app_user_id`) |
| `track_new_purchases`, `notification_forward_url` | As for the other stores |

- **Live check** (`verify_credentials` with `paddle: { paddle_api_key }`): `GET /event-types` proves the key works, then `GET /products?per_page=1` and `GET /subscriptions?per_page=1` prove read access. Paddle answers 403 for every authentication failure: `invalid_token` (a wrong, revoked or other-environment key) is "Paddle rejected the key", `forbidden` names the missing permission, `paddle_billing_not_enabled` says so. A 50-character key is tried on the live API, then on the sandbox API, and the answer says which one accepted it.
- **Apply in Paddle** (`POST /v2/projects/{id}/apps/{app_id}/actions/apply_notification_settings`, extension): creates a Paddle notification destination (`POST /notification-settings`, `type: url`, the app's notification URL, the subscribed events below, `traffic_source: all`) or updates the saved one, and seals its `endpoint_secret_key`. RevenueCat's dashboard has the same button.

### Purchases (`POST /v1/receipts`, `X-Platform: paddle`, the Paddle app's public key or a secret key)
`fetch_token` is a subscription id (`sub_…`) or a transaction id (`txn_…`), as RevenueCat's docs say.
1. `sub_…`: `GET /subscriptions/{id}`, plus the subscription's newest billed transaction for the period's price, transaction id and country.
2. `txn_…`: `GET /transactions/{id}?include=address`. A transaction with a `subscription_id` continues as step 1 *(inferred)*. One without is a one-time purchase per item, keyed by the transaction id (`{txn}:{n}` for further items).
3. `draft` or `ready` (checkout not finished) is 503 · 7101 so the backend posts again; `canceled` is 400 · 7103; `billed`, `paid`, `completed` and `past_due` are purchases.

| Paddle answer | `POST /v1/receipts` |
|---|---|
| 200 | 200 with customer info |
| 404 `not_found`, a token that is neither `sub_` nor `txn_`, a canceled transaction | 400 · 7103 |
| 403 (`invalid_token`, `forbidden`, `paddle_billing_not_enabled`) | 500 · 7101, credentials marked failing |
| No key saved | 500 · 7101 |
| 429, 5xx, network error, timeout; checkout not finished | 503 · 7101 |

### Products
A RevenueDot product of a Paddle app is a **Paddle price id** (`pri_…`): "a Price in Paddle maps to a Product" in RevenueCat, and purchases-js names the price id as the product identifier. A catalog product with the price's product id (`pro_…`) also matches when no price product exists, so a catalog set up by product still works. **Import products** lists every active price with its product's name, `subscription` with the duration from `billing_cycle` (`P1D`, `P1W`, `P1M`, `P3M`, `P6M`, `P1Y`, …) or `non_consumable` for one-time prices, and notes the trial length.

### Notifications (`POST /v1/notifications/paddle/{app_id}`)
- `Paddle-Signature: ts=<unix>;h1=<hex>`: HMAC-SHA256 with the secret key over `"<ts>:<raw body>"`, compared in constant time with every `h1` (several during a secret rotation), timestamp within 5 minutes. Missing secret, header or match is 400.
- Paddle counts only HTTP 200 as delivered, so every handled, duplicate or ignored event answers 200.
- Simulated events (`event_id` starting `ntfsimevt_`, or no `notification_id`) are stored and ignored, as RevenueCat does; the app's "last received" still updates so a test shows the URL works.
- Subscribed events (Apply in Paddle) and what each does:

| Event | What happens |
|---|---|
| `subscription.created`, `.activated`, `.trialing`, `.updated`, `.past_due`, `.paused`, `.resumed`, `.canceled`, `.imported` | Re-read the subscription and apply it |
| `transaction.completed`, `.paid`, `.past_due`, `.payment_failed`, `.billed`, `.updated` | With a `subscription_id`: re-read that subscription. Without: record the one-time purchase once paid |
| `adjustment.created`, `adjustment.updated` | An approved full `refund` or `chargeback` marks the transaction refunded; `chargeback_reverse` takes it back. Pending, rejected and partial adjustments change nothing |
| anything else | 200, stored and ignored |

### Mapping to the core engine *(inferred unless a source is given)*
| Paddle state | RevenueDot state | Event |
|---|---|---|
| `active`, period paid | Chain keyed by `sub_…`; period = `current_billing_period`; transaction id = the period's `txn_…` | INITIAL_PURCHASE |
| `trialing` (item `trial_dates`) | `period_type` trial, price 0, access to the trial end | INITIAL_PURCHASE (TRIAL) |
| A new `subscription_recurring` transaction completed | New period | RENEWAL (`is_trial_conversion` after a trial) |
| `scheduled_change.action: cancel` | `unsubscribe_detected_at`; access to `effective_at` | CANCELLATION (UNSUBSCRIBE) |
| `scheduled_change` removed | cleared | UNCANCELLATION |
| `past_due` | Billing issue; access continues for a grace period of 30 days from the failure ([RevenueCat: "event data always shows a 30-day grace period"](https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work)) | BILLING_ISSUE |
| Paid after `past_due` | New period | RENEWAL |
| `canceled` | Access ends at `canceled_at` (BILLING_ERROR when a billing issue was open) | CANCELLATION if not seen, EXPIRATION |
| `scheduled_change.action: pause` with `resume_at`, or `paused` | `auto_resume_date`; access ends when the pause starts | SUBSCRIPTION_PAUSED, EXPIRATION (SUBSCRIPTION_PAUSED) |
| `resumed` | New period | RENEWAL |
| The item's price changed | `product_id` changes; a `subscription_update` (proration) transaction keeps the period | PRODUCT_CHANGE |
| Approved full refund or chargeback of the period's transaction | `refunded_at`; access ends | CANCELLATION (CUSTOMER_SUPPORT), negative transaction |
| One-time transaction completed | One-time purchase (consumable or not by the catalog) | NON_RENEWING_PURCHASE |
| One-time transaction refunded | `refunded_at` | CANCELLATION (CUSTOMER_SUPPORT) |

- **Price** is the transaction's `details.totals.total` (what the customer paid, tax included, like Stripe's `amount_paid`) in its currency; amounts are strings in the lowest denomination. A trial is 0.
- **Sandbox** is a sandbox key's (or `paddle_is_sandbox`) purchases.
- **Country** is the transaction address's `country_code`.
- **App user id** for a purchase first seen in a notification: `custom_data[<key>]` on the subscription or its transaction, else anonymous.
- **Management link:** `GET /v2/projects/{id}/subscriptions/{id}/authenticated_management_url` creates a Paddle customer portal session for a Paddle subscription (RevenueCat's v2 behaviour), and falls back to the subscription's `management_urls.cancel` when the key may not create sessions.

## Roku Pay

### Credentials (app type `roku`, public key prefix `roku_`)
| Field | What it is |
|---|---|
| `roku_api_key` | Sealed. The Roku Pay web services API key (RevenueCat's v2 field). Roku puts it in the URL of every call |
| `roku_channel_id` | The channel's id. Roku has one push URL per developer account, so a push for another channel of the same account is routed to the project's Roku app with that channel id |
| `roku_channel_name` | Display only, as in RevenueCat |
| `track_new_purchases`, `notification_forward_url` | As for the other stores |

**Live check:** `validate-transaction` with a made-up transaction id. Roku answers HTTP 200 with `status: 1` and `errorMessage: "UNAUTHORIZED"` for a wrong key; any other answer means the key is right.

### Purchases
The Roku SDK sends `POST /v1/receipts` with `X-Platform: roku`, the `roku_` key, `X-Is-Sandbox` (true for sideloaded channels) and `{ fetch_token: <Roku transaction id>, app_user_id, product_id, price: "$4.99", intro_duration, trial_duration, presented_offering_identifier }`. The price is formatted text and no currency is sent, so both come from Roku.
1. `GET https://apipub.roku.com/listen/transaction-service.svc/validate-transaction/{api key}/{transaction id}` with `Accept: application/json`. Dates are `/Date(ms+0000)/`.
2. `status: 0` is valid. `UNAUTHORIZED` is 500 · 7101 (credentials). Any other `status: 1`, and HTTP 400 `Invalid URI format.` (not a Roku id), are 400 · 7103. 429, 5xx and timeouts are 503 · 7101.
3. A subscription chain is keyed by `OriginalTransactionId` (the first transaction); each renewal has its own transaction id. A product the catalog marks one-time, or a transaction without `expirationDate`, is a one-time purchase.

### Mapping *(inferred; RevenueCat lists INITIAL_PURCHASE, RENEWAL, CANCELLATION, UNCANCELLATION, NON_RENEWING_PURCHASE, EXPIRATION and BILLING_ISSUE as supported for Roku, and PRODUCT_CHANGE, REFUND_REVERSED and SUBSCRIPTION_PAUSED as not)*
| Roku state (`validate-transaction`) | RevenueDot state | Event |
|---|---|---|
| First transaction, `isEntitled`, future `expirationDate` | Chain keyed by the original transaction id | INITIAL_PURCHASE |
| First transaction with total 0, or the SDK posted `trial_duration` | `period_type` trial | INITIAL_PURCHASE (TRIAL) |
| First transaction with the SDK's `intro_duration` | `period_type` intro | INITIAL_PURCHASE (INTRO) |
| A later transaction of the chain (renewal `Sale`, `GraceRecovered`, `OnHoldRecovered`) | New period | RENEWAL |
| `isEntitled`, `expirationDate` passed, not cancelled (grace) | Billing issue; grace 3 days from the expiry ([Roku](https://developer.roku.com/dev/docs/subscription-on-hold)) | BILLING_ISSUE |
| Not entitled, not cancelled, expiry passed (on hold) | Billing issue; access ended | BILLING_ISSUE, EXPIRATION (BILLING_ERROR) |
| `cancelled` | `unsubscribe_detected_at`; access to `expirationDate` | CANCELLATION, later EXPIRATION |
| `Resubscribe` (cancelled turned off) | cleared | UNCANCELLATION |
| `Refund` push for the chain's current transaction | `refunded_at`; access ends | CANCELLATION (CUSTOMER_SUPPORT) |
| `purchaseType: UPGRADE` with `cancelledTransactionIds` (`UpgradeSale`) | A new chain; the replaced chain's access ends now | INITIAL_PURCHASE, EXPIRATION on the old chain |
| `DowngradeSale` (`purchaseStatus: PendingActive`, $0) | The current chain turns auto-renew off at its expiry; the downgraded plan's first charge is a new chain | CANCELLATION, later INITIAL_PURCHASE |
| `Credit`, `Chargeback`, `ChargebackReversed`, `SecondChargeback`, `CancellationOfferInitiated` | Stored, no change (RevenueCat: chargebacks unsupported for Roku) | none |

- **Price** is `total` in `currency` (Roku sends lowercase currency codes).
- **Sandbox** is `X-Is-Sandbox: true` on the receipt post (RevenueCat's rule: sideloaded channels are sandbox; beta and published channels are production even when the tester pays nothing). Notifications keep what the receipt recorded, and a purchase first seen in a notification is production.
- Roku never pushes "expired"; the tick's expiration worker records EXPIRATION when access ends, as for other stores.

### Notifications (`POST /v1/notifications/roku/{app_id}`, Roku's "push notification URL")
- The body is a compact JWS (`Content-Type: text/plain`), RS256, signed with a key from Roku's published key set (`https://assets.cs.roku.com/keys/partner-jwks.json`; the test endpoint's `partner-jwks-test.json` for kids `ROKU-PARTNER-SERVICE-TEST-…`). The key set is fetched by `kid`, cached for an hour and fetched again for an unknown `kid`. The token must have `iss: "Roku, Inc. urn:roku:apps:partner-service.roku.com"`, a current `nbf`/`exp`, and `x-Roku-message-type: roku.rpay.push`. Anything else is 400.
- The message is `x-Roku-message`, base64 (standard or URL-safe) UTF-8 JSON: `customerId`, `transactionType` (18 types), `transactionId`, `originalTransactionId`, `channelId`, `productCode`, `price`, `total`, `currency`, `isFreeTrial`, `expirationDate`, `eventDate`, `responseKey`.
- Stored once per `x-Roku-message-key`. Each push re-validates its transaction with Roku and applies the mapping above; the answer is 200 with the `responseKey` as the body (what Roku's unsigned mode required).
- `channelId` other than the app's `roku_channel_id` goes to the project's Roku app with that channel id; when there is none it is stored and ignored.

### Products
Roku has no catalog API, so Import products explains this and asks for each product's code (the Roku product's identifier). RevenueCat supports monthly and yearly subscriptions on Roku; RevenueDot accepts any duration and one-time products too.

## Samsung Galaxy Store

### Credentials (app type `galaxy`, a RevenueDot extension: RevenueCat's v2 API has no Galaxy app object; public key prefix `galx_`, the prefix the SDK requires)
| Field | What it is |
|---|---|
| `package_name` | The app's package name (`apps.bundle_id`) |
| `galaxy_service_account_id` | The Seller Portal service account id (Assistance → API Service), with the Publishing & Item and GSS scopes, as RevenueCat asks |
| `galaxy_service_account_private_key` | Sealed. The service account's private key file (PEM) |
| `galaxy_iap_public_key` | Optional. The seller's IAP public key (Assistance → API Service → IAP Key), to verify notification signatures. Without it a notification is only a trigger: nothing in it is trusted and the purchase is re-read from Samsung (RevenueCat asks for no such key, so it works this way too) |
| `track_new_purchases`, `notification_forward_url` | As for the other stores |

**Access tokens:** an RS256 JWT `{ iss: <service account id>, scopes: ["publishing", "gss"], iat, exp: iat + 20 min }` signed with the private key, exchanged at `POST https://devapi.samsungapps.com/auth/accessToken`. The token is cached per app (Samsung's tokens last until revoked; we renew after 50 minutes or on a 401). Calls send `Authorization: Bearer <token>` and `service-account-id`.

**Live check:** create an access token, then `GET …/iap/seller/v6/applications/{package}/purchases/subscriptions/{made-up id}`: 401 `AUTH_REQUIRE` is a bad account or key, 403 `NO_PERMISSION` names the missing scope, anything about the purchase id means the credentials work.

### Purchases
The SDK built with `purchases-store-galaxy` posts `POST /v1/receipts` with `X-Platform: android` and the `galx_` key (the key tells us the store), `fetch_token` = Samsung's `purchaseId`, `product_ids: [itemId]`, `price`, `currency`, and `normal_duration` for subscriptions. It never sends `X-Is-Sandbox`.
1. `GET https://iap.samsungapps.com/iap/v6/receipt?purchaseID=…` (no auth): `status: success|fail|cancel`, `itemType: Item|Subscription`, `mode: TEST|PRODUCTION`, `purchaseDate` (GMT `YYYY-MM-DD HH:mm:ss`), `paymentAmount`, `currencyCode`, `countryCode`, `orderId`, `packageName`.
2. A subscription is also read with the subscription API: `subscriptionFirstPurchaseID` (the chain key), `subscriptionPurchaseDate`, `subscriptionEndDate`, `subscriptionStatus: ACTIVE|CANCEL`, `freeTrial: Y|T|N` (trial, tiered intro price, normal), `realMode: N` (test purchase), `latestOrderId` (the period's transaction id), `gracePeriodYN`/`gracePeriodEndDate`, `cancelSubscriptionDate`, `price.localPrice`/`localCurrencyCode`.
3. `status: fail` (`errorCode` 9135 "not exist order", 9153 invalid id) is 400 · 7103, a receipt for another package is 400 · 7103, `status: cancel` on an item records it refunded. Subscriptions without a service account are 500 · 7101 (configuration missing); items need none.
4. The answer's `purchased_products.<itemId>.should_consume` (true for catalog consumables) tells the SDK to consume or acknowledge; the SDK only finishes a purchase after a 2xx or 4xx, so every temporary failure is 5xx.

### Mapping *(inferred)*
| Samsung state | RevenueDot state | Event |
|---|---|---|
| New subscription, `ACTIVE`, `freeTrial: N` | Chain keyed by the first purchase id; access to `subscriptionEndDate`; transaction id = `latestOrderId` | INITIAL_PURCHASE |
| `freeTrial: Y` / `T` | `period_type` trial / intro | INITIAL_PURCHASE (TRIAL / INTRO) |
| `latestOrderId` changed (`ARS_RENEWED`, `ARS_OUT_GRACE_PERIOD`) | New period | RENEWAL |
| `subscriptionStatus: CANCEL` with a future end (`ARS_UNSUBSCRIBED`) | `unsubscribe_detected_at` | CANCELLATION |
| `ACTIVE` again (`ARS_RESUBSCRIBED` within the period) | cleared | UNCANCELLATION |
| `gracePeriodYN: Y` (`ARS_IN_GRACE_PERIOD`) | Billing issue; access to `gracePeriodEndDate` | BILLING_ISSUE |
| End date passed without renewal | Access ended | EXPIRATION |
| `ARS_REFUNDED` for the chain's current order | `refunded_at`; access ends | CANCELLATION (CUSTOMER_SUPPORT) |
| `ARS_UPDOWNGRADED` | The new purchase is its own chain; the old chain renews into the new item: immediately, or at `scheduledTimeOfRenewal` | INITIAL_PURCHASE, PRODUCT_CHANGE on the old chain |
| `ARS_PRICECHANGE_AGREED` (`agreeYn: Y`) | price increase accepted | PRICE_INCREASE_CONSENT_APPROVED |
| Item purchase (`ITEM_PURCHASED`) | One-time purchase | NON_RENEWING_PURCHASE |
| `ITEM_REFUNDED`, or the receipt's `status: cancel` | `refunded_at` | CANCELLATION (CUSTOMER_SUPPORT) |

- **Sandbox** is `mode: TEST` on the receipt, `realMode: N` on the subscription, or `testPayYn: Y` / `betaTestYn: Y` in a notification.
- **Price** is the subscription's `price.localPrice` in `localCurrencyCode`, else the receipt's `paymentAmount` in `currencyCode`, else what the SDK posted.
- **Country** is the receipt's three-letter `countryCode`, converted to two letters.
- **Refunds and cancellations from the API:** RevenueCat's v2 "refund a Play Store or Galaxy subscription's transaction" works for Galaxy: `PATCH …/purchases/subscriptions/{purchase id}` with `{ action: "refund" }`; v2 cancel sends `{ action: "cancel" }`.

### Notifications (`POST /v1/notifications/galaxy/{app_id}`, Samsung's "Instant Server Notification" URL)
- The body is a compact JWT (RS256). With `galaxy_iap_public_key` saved its signature must verify; `iss` must be `iap.samsungapps.com` and `aud` must name the app's package. A body that is not such a JWT, or whose signature fails, is 400.
- Stored once per (event, purchase id, `iat`). `TEST` updates "last received" only. Every other event re-reads the receipt and the subscription from Samsung and applies the result; `ARS_UPDOWNGRADED` also re-reads the old purchase and records the product change; `ARS_REFUNDED` marks the refunded order's period refunded; `ITEM_REFUNDED` refunds the item; `ORDER_HISTORY_DELETED` is stored and ignored.

### Products
Samsung's publish API lists in-app items only (`GET …/iap/v6/applications/{package}/items`), so Import products lists items (consumable unless the developer changes it; Samsung does not say) and explains that subscriptions are added with New product, by their item id.

## Endpoints and screens
- `POST /v1/receipts` for `paddle`, `roku` and `galaxy` apps (`apps/server/src/stores/{paddle,roku,galaxy}/index.ts`).
- `POST /v1/notifications/paddle/{app_id}`, `/roku/{app_id}`, `/galaxy/{app_id}`.
- `POST /v2/projects/{id}/apps` and `…/apps/{app_id}`: `paddle: { paddle_api_key, paddle_is_sandbox, paddle_webhook_secret, app_user_id_source, app_user_id_custom_data_key, track_new_purchases, notification_forward_url }`, `roku: { roku_api_key, roku_channel_id, roku_channel_name, … }`, `galaxy: { package_name, galaxy_service_account_id, galaxy_service_account_private_key, galaxy_iap_public_key, … }`. App shapes follow RevenueCat's `PaddleApp` (`paddle_api_key: null`, never the key) and `RokuApp`; `galaxy: { package_name }`.
- `GET …/store_settings` adds `paddle`, `roku` and `galaxy` blocks (what is set, never a secret); `POST …/actions/verify_credentials` accepts each; `POST …/actions/apply_notification_settings` for Paddle.
- `GET …/store_products` and `POST …/actions/import_store_products` for Paddle (prices) and Galaxy (items); Roku explains why not.
- Dashboard: Add app offers Paddle, Roku and Samsung Galaxy Store (Roku is no longer "soon"). Each app page has the credentials with Check credentials, the notification URL with its live status (and Apply in Paddle), forwarding, track new purchases, and setup snippets (Paddle: curl and Node from a backend; Roku: BrightScript; Galaxy: Kotlin and React Native).

## Tests that prove it
- `apps/server/test/paddle.test.ts`, `roku.test.ts`, `galaxy.test.ts` against the fakes: signatures (an independent HMAC or RSA check, rotation, tolerance, tampering, wrong issuer or audience, unknown `kid`), every receipt answer class, every lifecycle row above, redelivery, forwarding, unknown purchases with and without tracking, outages and retry, app creation with sealed secrets, `verify_credentials`, Import products, management links and Galaxy refunds.
- `scripts/e2e/journeys/stores3.ts` on a Railway development database: the real Node server, the fakes on the capture server, real sign-up, each store's setup through the API, purchases through the SDK wire calls, every notification type and its effect read back through v2 and SQL, delivered webhooks.
- `apps/dashboard/e2e/stores3.spec.ts`: Add app for each store, bad and good credentials with the live check, the notification URL turning green after a signed notification, a purchase posted the way the SDK does, the customer page, phone width and dark mode, no console errors.

## Known gaps
- No real Paddle, Roku or Samsung purchase has run; each needs a store account (a Paddle sandbox account, a Roku developer account with Roku Pay, a Samsung seller account with license testers).
- No scheduled re-check without notifications (Roku recommends a daily check of subscriptions in grace).
- Paddle checkout from purchases-js (`/rcbilling/v1/checkout/*` with `paddle_billing_params`) is not built; purchases are posted from the developer's backend.
- Roku `cancel-subscription` and `refund-subscription` are not exposed through v2 actions yet.
