# SDK-compatible API (scope 1.1, with the 1.0 contract harness)

**Status:** Every HTTP call the current RevenueCat iOS, Android and web SDKs can make is in the inventory below. 55 of the 58 method-and-path pairs have a route: 28 answer with real data and 27 are safe stubs. The other 3 are the SDKs' identity-provider login calls (`/auth/*`), used only in their internal token-login mode (IAM), which is off by default and cannot be turned on through a public API. The 15 subscriber-token paths of that mode (`/v1/customer/*`) are routed since branch `tier2-v2-events`: they take the access token from the v2 `authenticate` operation. The unmodified iOS 5.92 and Android 10.24 SDKs pass on a simulator and an emulator, including attributes and attribution, web purchase redemption, reward verification, virtual currencies and (iOS) the Customer Center fetch, each call made once with its documented status.

## Users and jobs
- **App developers** change only the SDK's proxy URL and keep their app code, their public API key and their paywalls.
- **End users** buy, restore and switch devices without noticing that the server changed.
- **Contributors** need a test that fails whenever a response shape drifts from what the SDKs decode, or when an SDK path loses its route.

## Essential now and later
Essential (Tier 1)
- Customer info, receipts, offerings, `logIn`, alias, attributes, attribution and promotional-offer signing, all backed by real data.
- A safe answer for every other call: the SDK behaves correctly, shows a clear result to the app and never retries in a loop.
- Temporary store failures on `POST /v1/receipts` return 5xx, so the SDK keeps the transaction and retries.
- Signed responses (Trusted Entitlements) when `REVENUEDOT_SIGNING_KEY` is set.

Later
- Customer Center configuration, virtual currency balances, paywall remote config, and ad reward verification. (Web purchases and their redemption are real since Tier 3 web billing: `prd/web-billing/PRD.md`.) (Amazon Appstore receipts are real since Tier 2: `prd/store-amazon/PRD.md`; SDK events are stored for the charts since Tier 2: `prd/charts/PRD.md`.)

## Endpoint inventory
Sources: iOS `Sources/Networking/HTTPClient/HTTPRequestPath.swift`, `WebBillingHTTPRequestPath.swift`, `EventsHTTPRequestPath.swift`, `DiagnosticsHTTPRequestPath.swift` and `SourceHealthChecker.swift` in `revenuedot/purchases-ios`; Android `purchases/src/main/kotlin/com/revenuecat/purchases/common/networking/Endpoint.kt` in `revenuedot/purchases-android`; web `src/networking/endpoints.ts` and `src/behavioural-events/events-tracker.ts` in `revenuedot/purchases-js`. All three forks were taken from upstream `main` on 2026-09-30. `purchases-hybrid-common` makes no HTTP calls of its own: it calls the native SDKs. The device harnesses use the published RevenueCat iOS 5.92.0 and Android 10.24.0.

**Real** means the answer comes from stored data or does the real work. **Stub** means a fixed, documented answer that the SDK handles as a normal result. **Absent** means no route. "Answer" starts with the HTTP status; a second number is the RevenueCat error code in the JSON body. `packages/contract/test/sdk-inventory.test.ts` reads this table and sends every routed row with the SDK's headers.

<!-- inventory:start -->
| # | Method | Path | SDKs | RevenueDot | Answer | What the SDK does with it |
|---|---|---|---|---|---|---|
| 1 | GET | `/v1/subscribers/{app_user_id}` | iOS, Android, web | Real | 201 new customer, 200 known | Customer info on configure, foreground and `getCustomerInfo` |
| 2 | POST | `/v1/receipts` | iOS, Android, web | Real | 200 customer info with `purchased_products` | Finishes or consumes the purchase; 5xx keeps it for a retry |
| 3 | GET | `/v1/subscribers/{app_user_id}/offerings` | iOS, Android, web | Real | 200 offerings | `getOfferings`; the current offering follows the customer's override |
| 4 | GET | `/v1/offerings` | iOS, Android | Real | 200 offerings | Fallback path for offerings (off behind a proxy) |
| 5 | POST | `/v1/subscribers/identify` | iOS, Android, web | Real | 201 new user, 200 known | `logIn`; merges the anonymous customer by the transfer rules |
| 6 | POST | `/v1/subscribers/{app_user_id}/alias` | Android | Real | 200 `{}` | Block Store user-id recovery |
| 7 | POST | `/v1/subscribers/{app_user_id}/attributes` | iOS, Android, web | Real | 200 `{}`; 400 · 7263 for a bad `$email` | Marks attributes synced; `$ip` and `$deviceVersion` sent as "true" get the request's IP and device |
| 8 | GET | `/v1/product_entitlement_mapping` | iOS, Android | Real | 200 mapping | Offline entitlements while the server is down: the calling app's products, keyed the way each SDK looks them up (`prd/offline-entitlements/PRD.md`) |
| 9 | GET | `/rcbilling/v1/subscribers/{app_user_id}/products?id={product_id}` | iOS, Android, web | Real | 200 `product_details` | Test Store product details and prices |
| 10 | POST | `/v1/offers` | iOS | Real | 200 signed offer; 400 · 7234 without an In-App Purchase key | `promotionalOffer(forProductDiscount:product:)`; 7234 is `invalidAppleSubscriptionKeyError`, which fails only that offer |
| 11 | POST | `/v1/subscribers/{app_user_id}/attribution` | iOS | Real | 200 `{}` | Deprecated `addAttributionData`; stores `$idfa`, `$idfv`, `$gpsAdId`, `$ip` and Apple Search Ads campaign attributes |
| 12 | POST | `/v1/subscribers/{app_user_id}/adservices_attribution` | iOS | Real | 200 `{}` | `enableAdServicesAttributionTokenCollection`, once per install; the token is looked up with Apple and stored as `$mediaSource`, `$campaign`, `$adGroup`, `$keyword`, `$ad` and the `$appleAds*` attributes |
| 13 | POST | `/v1/subscribers/{app_user_id}/intro_eligibility` | iOS | Stub | 200 `null` for every product | StoreKit 1 only; `null` is "unknown" |
| 14 | GET | `/v1/health` | iOS | Stub | 200 `{"status":"ok"}` | Diagnostic call; the body is ignored |
| 15 | GET | `/v1/health/connectivity` | iOS | Stub | 200 `{"status":"ok"}` | API-source probe, internal failover setting only |
| 16 | GET | `/v1/subscribers/{app_user_id}/health_report_availability` | iOS | Stub | 200 `{"report_logs":false}` | Debug builds; `false` skips the health report |
| 17 | GET | `/v1/subscribers/{app_user_id}/health_report` | iOS | Stub | 200 passed, no checks | Debug builds, only after availability says yes |
| 18 | GET | `/v1/customercenter/{app_user_id}` | iOS, Android | Real | 200 | The project's Customer Center configuration: built-in default (management and no-active screens, support email of the first admin) merged with what `POST /v2/projects/{id}/customer_center_config` stored |
| 19 | POST | `/v1/customercenter/support/create-ticket` | iOS, Android | Stub | 200 `{"sent":false}` | The support form reports that nothing was sent |
| 20 | GET | `/v1/subscribers/{app_user_id}/virtual_currencies` | iOS, Android, web | Real | 200 `virtual_currencies` by code with balance, name, code, description | `virtualCurrencies()` returns the customer's balances (empty for a customer we have not seen) |
| 21 | POST | `/v1/subscribers/{app_user_id}/restore/eligibility` | iOS | Stub | 200 allowed | StoreKit 2 restore behaviour check |
| 22 | POST | `/v1/subscribers/redeem_purchase` | iOS, Android | Real | 200 customer info; 400 · 7849 for an invalid token (also 7852 when another user redeemed it, 7853 when it expired, with `purchase_redemption_error_info.obfuscated_email`) | `redeemWebPurchase` returns `success`, `invalidToken`, `purchaseBelongsToOtherUser` or `expired` (a new link is emailed). Web purchases come from RevenueDot's hosted checkout (`prd/web-billing/PRD.md` §4) |
| 23 | POST | `/v1/external_purchase_tokens` | iOS | Stub | 200 `{"id":…}` | Apple external-purchase token registered; the web checkout it leads to (row 29) fails |
| 24 | GET | `/v1/subscribers/{app_user_id}/ads/reward_verifications/{client_transaction_id}` | iOS, Android | Stub | 200 `status: failed` | `pollRewardVerification` stops after one request and returns failed |
| 25 | GET | `/v1/receipts/amazon/{store_user_id}/{receipt_id}` | Android | Real | 200 Amazon's receipt data with `termSku`; 400 · 7103 unknown receipt; 400 · 7662 for a key that is not an Amazon app's; 503 · 7101 while Amazon is unavailable | The SDK posts the term SKU as the product id; an error leaves the Amazon purchase unconsumed. Spec: `prd/store-amazon/PRD.md` |
| 26 | POST | `/v1/config/{domain}` | iOS, Android | Real | 200 RC Container (`application/x-rc-format`), 204 when the sent manifest is current | Remote config: published paywalls as workflows (one per offering) and `ui_config`, with every blob inline; how iOS 5.83+ and current Android load paywalls |
| 27 | GET | `/v1/config/{domain}` | iOS, Android | Stub | 204 | Remote config fallback path |
| 28 | GET | `/rcbilling/v1/subscribers/{app_user_id}/offering_products` | iOS | Stub | 200 `{"offerings":{}}` | Defined in the SDK with no caller |
| 29 | POST | `/rcbilling/v1/hosted-checkout` | iOS | Real | 200 `operation_session_id`, `checkout_url` (Stripe Checkout), `success_url`, `cancel_url`; 400 · 7000 when the package has no web product | Paywall web checkout opens the Stripe page and closes on the success or cancel URL (`prd/web-billing/PRD.md` §2) |
| 30 | POST | `/v1/events` | iOS, Android, web | Real | 200 `{}` | Paywall, customer center and ad events are stored for the charts (`sdk_events`, one row per SDK event id); a malformed batch still gets 200 so it is not resent |
| 31 | POST | `/v1/diagnostics` | iOS, Android | Stub | 200 `{}` | Diagnostics are accepted and not resent |
| 32 | GET | `/rcbilling/v1/branding` | web | Stub | 200 the app's name, default look | Web Billing (`rcb_` keys) checkout branding |
| 33 | POST | `/rcbilling/v1/checkout/prepare` | web | Stub | 400 · 7000 | Web Billing purchase fails with an error in the SDK's purchase screen |
| 34 | POST | `/rcbilling/v1/checkout/start` | web | Stub | 400 · 7000 | Same as row 33 |
| 35 | GET | `/rcbilling/v1/checkout/{operation_session_id}` | web | Stub | 400 · 7877 | No checkout session exists |
| 36 | PATCH | `/rcbilling/v1/checkout/{operation_session_id}` | web | Stub | 400 · 7877 | No checkout session exists |
| 37 | POST | `/rcbilling/v1/checkout/{operation_session_id}/complete` | web | Stub | 400 · 7877 | No checkout session exists |
| 38 | POST | `/rcbilling/v1/purchase` | web | Stub | 400 · 7000 | Defined in the SDK with no caller |
| 39 | GET | `/v1/subscribers/{app_user_id}/workflows?type=paywall` | web | Stub | 200 `{"workflows":[]}` | `presentPaywall` uses the offering's own paywall |
| 40 | GET | `/v1/subscribers/{app_user_id}/workflows/{workflow_id}` | web | Stub | 404 · 7259 | Never called, because the list in row 39 is empty |
| 41 | POST | `/v1/customer/virtual_currencies/spend` | iOS | Real | 200 `virtual_currencies` after the spend; 400 · 7226 for an unknown currency or a malformed body; 422 · 7000 when a balance would go below zero; 401 · 7224 with an app key | Spends the subscriber's in-app currency (`adjustments` by code, `reference`, `Idempotency-Key`); a ledger row with source `sdk`, no webhook (RevenueCat sends none for balance changes outside purchases and the dashboard) |
| 42 | GET | `/v1/customer` | iOS, Android | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 1 for the token's app user id |
| 43 | GET | `/v1/customer/offerings` | iOS, Android | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 3 |
| 44 | POST | `/v1/customer/intro_eligibility` | iOS | Stub | 200 with a subscriber token; 401 · 7224 with an app key | Row 13 |
| 45 | POST | `/v1/customer/attribution` | iOS | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 11 |
| 46 | POST | `/v1/customer/attributes` | iOS, Android | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 7 |
| 47 | POST | `/v1/customer/adservices_attribution` | iOS | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 12 |
| 48 | GET | `/v1/customer/health_report` | iOS | Stub | 200 with a subscriber token; 401 · 7224 with an app key | Row 17 |
| 49 | GET | `/v1/customer/customercenter` | iOS, Android | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 18 |
| 50 | POST | `/v1/customer/customercenter/support/create-ticket` | iOS, Android | Stub | 200 with a subscriber token; 401 · 7224 with an app key | Row 19 |
| 51 | GET | `/v1/customer/virtual_currencies` | iOS, Android | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 20 |
| 52 | POST | `/v1/customer/restore/eligibility` | iOS | Stub | 200 with a subscriber token; 401 · 7224 with an app key | Row 21 |
| 53 | GET | `/v1/customer/ads/reward_verifications/{client_transaction_id}` | iOS, Android | Stub | 200 with a subscriber token; 401 · 7224 with an app key | Row 24 |
| 54 | GET | `/rcbilling/v1/customer/offering_products` | iOS | Stub | 200 with a subscriber token; 401 · 7224 with an app key | Row 28 |
| 55 | GET | `/rcbilling/v1/customer/products?id={product_id}` | iOS, Android | Real | 200 with a subscriber token; 401 · 7224 with an app key | Row 9 |
| 56 | POST | `/auth/login`, `/auth/token`, `/auth/revoke` | iOS, Android | Absent | none | IAM user login with an identity provider, internal and off by default. `/auth/login` on RevenueDot is the dashboard's sign-in |
<!-- inventory:end -->

Counts: rows 1-55 are 55 routed pairs (28 real, 27 stubs); row 56 is 3 absent pairs.

**Subscriber tokens (rows 41-55).** `POST /v2/projects/{project_id}/apps/{app_id}/authenticate` issues an `rdat_` token for one app user id of one app, valid for one hour (`prd/rest-api/PRD.md`). Sent as `Authorization: Bearer rdat_…`, it is accepted everywhere the app's public key is, pinned to its app user id: a `/v1/customer/*` path is served by the matching `/v1/subscribers/{app_user_id}/*` route, a `/v1/subscribers/{other id}` path, a receipt, offer signature, `logIn` or alias whose `app_user_id` or `new_app_user_id` is another app user id answers 401 · 7224, `POST /v1/events` keeps only the token's own events, and an expired token answers 401 · 7224 (the SDK's "invalid auth token"). Deleting the customer revokes its tokens. The currency spend runs in one transaction with a conditional decrement per currency, so concurrent spends never take a balance below zero. The app's public key on a `/v1/customer/*` path also answers 401 · 7224, because these paths name no app user id. Remote-config blob downloads and paywall asset URLs are not API calls: the SDK fetches whatever URL our own responses contain, and ours contain none.

## RevenueCat behaviour we match
- New customers answer 201 and known customers 200 on `GET /v1/subscribers/{id}` and on `logIn` (fixtures `ios/req-login.json` and `ios/resp-login-real-signed.json`; https://www.revenuecat.com/docs/customers/identifying-customers).
- The customer info keys, including `subscriber_attributes` only for secret keys, match a real response (`ios/resp-customer-info-real-signed.json`, `android/customer_info_full.json`; https://www.revenuecat.com/docs/customers/customer-info).
- The receipt response lists `purchased_products` with `should_consume` so Android consumes consumables, and consumables appear in `non_subscriptions` with `store_transaction_id` so iOS can finish them (`ios/req-post-receipt-sk2-jws.json`).
- Offerings and the product-to-entitlement mapping decode with the SDK schemas (`ios/resp-offerings-real-signed.json`, `android/get_offerings_with_placements.json`, `ios/resp-product-entitlement-mapping.json`).
- An invalid key is 401 with code 7225, and an invalid `$email` attribute is 400 with code 7263 and `attribute_errors` (`ios/resp-error-server-7225.json`, `ios/resp-error-attribute-errors.json`).
- Every SDK response carries `X-RevenueCat-Request-Time`, the unauthenticated health calls included. Signed responses verify with the SDK's own verifier (https://www.revenuecat.com/docs/customers/trusted-entitlements).
- Test Store products carry a numeric `cycle_count`, because the SDKs refuse a null (`ios/resp-web-billing-products.json`).
- Promotional offers are signed the way Apple specifies: ECDSA P-256 with SHA-256 over bundle id, key id, product id, offer id, app account token, nonce and timestamp, DER and base64, with the app's In-App Purchase key (https://developer.apple.com/documentation/storekit/generating-a-signature-for-promotional-offers). The app account token matches what the SDK puts on the payment: StoreKit 2 adds one only when the app user id is a UUID; StoreKit 1 uses the app user id. The response has the keys of `ios/resp-offer-signing.json`.
- Attribution uses the reserved attribute keys of both SDKs (`ReservedSubscriberAttributes.swift`, `SpecialSubscriberAttributes.kt`) and the Apple Search Ads attributes RevenueCat documents (https://www.revenuecat.com/docs/integrations/attribution/apple-search-ads). The AdServices token is resolved with Apple's public attribution API (https://developer.apple.com/documentation/adservices/aaattribution/attributiontoken()): a 404 or 5xx is retried 3 times, 5 seconds apart, after the response. Attribution is write-once, so the first campaign a customer came from is kept; advertising identifiers update like any attribute.
- Web purchase redemption errors use the codes both SDKs map to results: 7849 invalid token (`android/error_7849_invalid_web_redemption_token.json`).
- Reward verification answers `failed` with a `failure_reason`, the shape of `android/reward_verification_failed_with_reason.json`, so polling stops at once.

## Endpoints and screens
Routes are in `apps/server/src/routes/sdk.ts`; attribution is in `apps/server/src/services/attribution.ts` and offer signing in `apps/server/src/services/promo-offers.ts`. All need `Authorization: Bearer <public key>`, except the three health calls.
- Signing key: `apps/server/src/services/signing.ts` serves the root public key and signs `/v1/*` and `/rcbilling/*` responses.
- Screens: attribution and device attributes appear on the dashboard's customer page (`apps/dashboard/src/pages/CustomerDetail.tsx`, from `GET /v2/projects/{id}/customers/{id}?expand=attributes`) and in every webhook's `subscriber_attributes`. The Apps page lists which SDK builds call the server (`setup_health.sdk_versions`).

## Tests that prove it
- `packages/contract/test/sdk-inventory.test.ts` parses the inventory table above. It sends every routed row with the iOS SDK's request headers (the subscriber-token rows with a token from `authenticate`) and checks the documented status, the RevenueCat error code, that the answer is JSON (or 204) with `X-RevenueCat-Request-Time`, and that a JSON 404 is a deliberate RevenueCat error rather than a missing route. It also checks that the absent rows are really unrouted and that the counts in this file add up.
- `packages/contract/test/sdk.test.ts` covers fixture sanity against the SDK schemas, auth errors, customer info, Test Store receipts (idempotency, consumables, lifetime), ownership and transfers, attributes, offerings and mapping, and the calls the SDK makes on its own. The schemas are in `packages/contract/src/sdk-schemas.ts`.
- `packages/contract/test/sdk-endpoints.test.ts` covers every route added for the inventory: offer signatures verified with the key's public half, both app account token rules and 7234; legacy attribution and AdServices attributes in customer info, the v2 customer and a webhook payload; `$ip` and `$deviceVersion`; redemption, external purchase tokens, reward verification, Amazon (7662 for a non-Amazon key; the real route is in `apps/server/test/amazon.test.ts`), web offering products, hosted checkout, Web Billing and workflows, each against the keys of its fixture.
- `packages/contract/test/v2-remaining.test.ts` covers subscriber tokens end to end: issued by `authenticate`, served on `/v1/customer/*` with the same bodies as the `/v1/subscribers/{id}` routes, pinned to their app user id, refused after expiry, and the virtual currency spend (balance, idempotency key, 422 below zero).
- `packages/contract/test/offline-entitlements.test.ts` covers the product mapping per store (`prd/offline-entitlements/PRD.md`).
- `apps/server/test/signing.test.ts` verifies RevenueCat's published signature vectors, signs our own responses, rejects tampering and rotates the intermediate key.
- `scripts/e2e/ios/run.ts` (XCUITest, RevenueCat iOS 5.92.0, iPhone 17 Pro simulator) and `scripts/e2e/android/run.ts` (UIAutomator, RevenueCat Android 10.24.0, Android 15 emulator) drive the unmodified SDKs. Besides configure, customer info, offerings, a Test Store purchase and `logIn`, both call `setEmail`, `setDisplayName`, `setAttributes`, `setAdjustID`, `collectDeviceIdentifiers`, `syncAttributesAndOfferingsIfNeeded`, `syncPurchases`, the virtual currencies call, `redeemWebPurchase` with a deep link and `pollRewardVerification`. iOS also calls `addAttributionData` (Apple Search Ads), `enableAdServicesAttributionTokenCollection` and the Customer Center fetch; Android also calls `setMediaSource` and `setCampaign`. The runner reads the server's request log (`REVENUEDOT_REQUEST_LOG`): each new call happens exactly once with its documented status, and no SDK call reaches an unrouted path or gets a 5xx. It then checks the stored attributes on the v2 customer the dashboard reads (`$ip` and `$deviceVersion` filled in, the Apple Search Ads campaign on iOS) and in the purchase's webhook `subscriber_attributes`. Helpers: `scripts/e2e/sdk-calls.ts`.

## Known gaps
- Customer Center has no configuration, so its screen shows an error; virtual currencies have no balances; paywall remote config is empty (Tier 2).
- Web purchase redemption and the iOS hosted checkout are real since web billing (`prd/web-billing/PRD.md`). The purchases-js Web Billing flow (`rcb_` keys, `/rcbilling/v1/checkout/*`, Stripe Elements inside the SDK) still answers with the codes above: RevenueDot's checkout is a hosted page.
- Server-side ad reward verification is not supported.
- The iOS SDK sends no AdServices token from a simulator (it logs that the token is not available there), so `adservices_attribution` and the Apple lookup are tested only in `sdk-endpoints.test.ts`, with a stubbed Apple API.
- A promotional-offer request needs a real StoreKit subscription transaction on the device, so `POST /v1/offers` is tested only in `sdk-endpoints.test.ts`, where the signature is checked with the key's public half.
- Android's Customer Center fetch is internal to the SDK and runs only from the RevenueCatUI screen, which the Android harness does not include.
- The IAM identity-provider login (`/auth/login`, `/auth/token`, `/auth/revoke`, row 56) has no routes, and `/auth/login` is taken by the dashboard. Neither SDK can enable IAM mode through a public API, so the `/v1/customer/*` rows are reached only by apps that call them directly with a subscriber token.
- There is no real sandbox purchase on any device, because both stores need credentials.
