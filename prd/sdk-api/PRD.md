# SDK-compatible API (scope 1.1, with the 1.0 contract harness)

**Status:** The unmodified RevenueCat SDKs can configure, read customer info and offerings, buy through the Test Store, the App Store or Google Play, log in and set attributes against RevenueDot. 23 SDK routes answer. Six request paths in the upstream fixtures have no route yet.

## Users and jobs
- **App developers** change only the SDK's proxy URL and keep their app code, their public API key and their paywalls.
- **End users** buy, restore and switch devices without noticing that the server changed.
- **Contributors** need a test that fails whenever a response shape drifts from what the SDKs decode.

## Essential now and later
Essential (Tier 1)
- Customer info, receipts, offerings, `logIn`, alias and attributes, all backed by real data.
- Safe answers for every other call the SDK makes on its own, so the SDK never blocks or retries forever.
- Temporary store failures on `POST /v1/receipts` return 5xx, so the SDK keeps the transaction and retries.
- Signed responses (Trusted Entitlements) when `REVENUEDOT_SIGNING_KEY` is set.

Later
- Customer Center configuration, virtual currencies, paywall remote config, web purchase redemption, promotional offer signing and ad reward verification.

## RevenueCat behaviour we match
- New customers answer 201 and known customers 200 on `GET /v1/subscribers/{id}` and on `logIn` (fixtures `ios/req-login.json` and `ios/resp-login-real-signed.json`; https://www.revenuecat.com/docs/customers/identifying-customers).
- The customer info keys, including `subscriber_attributes` only for secret keys, match a real response (`ios/resp-customer-info-real-signed.json`, `android/customer_info_full.json`; https://www.revenuecat.com/docs/customers/customer-info).
- The receipt response lists `purchased_products` with `should_consume` so Android consumes consumables, and consumables appear in `non_subscriptions` with `store_transaction_id` so iOS can finish them (`ios/req-post-receipt-sk2-jws.json`).
- Offerings and the product-to-entitlement mapping decode with the SDK schemas (`ios/resp-offerings-real-signed.json`, `android/get_offerings_with_placements.json`, `ios/resp-product-entitlement-mapping.json`).
- An invalid key is 401 with code 7225, and an invalid `$email` attribute is 400 with code 7263 and `attribute_errors` (`ios/resp-error-server-7225.json`, `ios/resp-error-attribute-errors.json`).
- Every SDK response carries `X-RevenueCat-Request-Time`. Signed responses verify with the SDK's own verifier (https://www.revenuecat.com/docs/customers/trusted-entitlements).
- Test Store products carry a numeric `cycle_count`, because the SDKs refuse a null (`ios/resp-web-billing-products.json`).

## Endpoints and screens
Routes are in `apps/server/src/routes/sdk.ts`. All need `Authorization: Bearer <public key>`, except health.
- Real data: `GET /v1/subscribers/{id}`, `POST /v1/receipts`, `GET /v1/subscribers/{id}/offerings`, `GET /v1/offerings`, `POST /v1/subscribers/identify`, `POST /v1/subscribers/{id}/alias`, `POST /v1/subscribers/{id}/attributes`, `GET /v1/product_entitlement_mapping` and `GET /rcbilling/v1/subscribers/{id}/products`.
- Fixed answers: `POST /v1/subscribers/{id}/intro_eligibility` (null, which means "unknown", for every product), `POST .../attribution` and `.../adservices_attribution` (`{}`), `GET /v1/health`, `GET .../health_report_availability`, `GET .../health_report`, `GET /v1/customercenter/{id}` (404), `POST /v1/customercenter/support/create-ticket`, `GET .../virtual_currencies` (empty), `POST .../restore/eligibility` (always allowed), `GET` and `POST /v1/config/{domain}` (204), `POST /v1/events` and `POST /v1/diagnostics` (`{}`).
- Signing key: `apps/server/src/services/signing.ts` serves the root public key and signs `/v1/*` and `/rcbilling/*` responses.
- Screens: the dashboard's Apps page lists which SDK builds call the server, using `setup_health.sdk_versions` (`apps/dashboard/src/pages/setup/Apps.tsx`).

## Tests that prove it
- `packages/contract/test/sdk.test.ts` (29 tests) covers fixture sanity against the SDK schemas, auth errors, customer info, Test Store receipts (idempotency, consumables, lifetime), ownership and transfers, attributes, offerings and mapping, and the calls the SDK makes on its own. The schemas are in `packages/contract/src/sdk-schemas.ts`.
- `apps/server/test/signing.test.ts` (10 tests) verifies RevenueCat's published signature vectors, signs our own responses, rejects tampering and rotates the intermediate key.
- `apps/server/test/setup-health.test.ts` records SDK builds from the SDK headers.
- `scripts/e2e/ios/run.ts` with `scripts/e2e/ios/RDHarnessUITests/HarnessUITests.swift` drives the unmodified iOS SDK on a booted simulator: configure, `getCustomerInfo`, `getOfferings`, a Test Store purchase and `logIn`. It then checks what the server stored. It needs Xcode and XcodeGen and runs by hand.
- `apps/dashboard/e2e/sdk-compat.spec.ts` sends real SDK headers and checks the compatibility panel.

## Known gaps
- These request paths from the upstream iOS fixtures have no route: `POST /v1/offers` (promotional offer signing), `POST /v1/subscribers/redeem_purchase`, `POST /v1/external_purchase_tokens`, `POST /rcbilling/v1/hosted-checkout`, `GET /rcbilling/v1/subscribers/{id}/offering_products` and `GET /v1/subscribers/{id}/ads/reward_verifications/{id}`.
- The contract tests use the request fixtures only for their headers. They do not replay every request fixture.
- There is no Android emulator run, and there is no real sandbox purchase on any device, because both need store credentials.
- Attribution calls are accepted but not stored, although the code comment says they are stored.
- Test Store product prices are 0 until the catalog stores Test Store prices.
- Customer Center, virtual currencies and paywall remote config are Tier 2.
