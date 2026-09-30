# Apple ingestion (scope 1.2)

**Status:** StoreKit 2 signed transactions, StoreKit 1 receipts, Xcode test receipts and App Store Server Notifications v2 are verified, stored and turned into RevenueCat events. Every test runs against a mocked Apple. No real sandbox purchase has run yet, because that needs store credentials.

## Users and jobs
- **iOS and macOS developers** add their In-App Purchase key once. After that, purchases, renewals and refunds show up without extra code.
- **Operators on a dual run** forward Apple's notifications to RevenueCat until they switch over.
- **End users** keep access through billing retry, grace periods and family sharing.

## Essential now and later
Essential (Tier 1)
- Verify every signed payload up to Apple Root CA G3 and refuse anything forged.
- Use the App Store Server API as the source of truth when credentials exist.
- Handle every notification type that changes a purchase, and keep sandbox data apart from production data.
- Extend one subscription or every subscriber of a product (store actions, see `prd/rest-api/PRD.md`).

Later
- Send consumption information for Apple's Refund Control.

## RevenueCat behaviour we match
- A temporary Apple failure answers 5xx, and a broken or missing key answers 500 with code 7234, so the SDK keeps the transaction and retries (https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration).
- A free offer is period type TRIAL, a paid introductory offer or offer code is INTRO, and a paid promotional offer is NORMAL (https://www.revenuecat.com/docs/subscription-guidance/subscription-offers/ios-subscription-offers).
- Family sharing sets `ownership_type` to FAMILY_SHARED, and REVOKE removes a family member's access (https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-family-sharing).
- A billing retry with a grace period sends BILLING_ISSUE and CANCELLATION with reason BILLING_ERROR, and access continues until the grace period ends (https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work).
- A refund is CANCELLATION with reason CUSTOMER_SUPPORT and a negative price, and a reversed refund restores access (https://www.revenuecat.com/docs/subscription-guidance/refunds).
- Notifications about unknown purchases answer 200 and are ignored unless the app opts in to tracking new purchases. An `appAccountToken` that matches an app user ID attaches the purchase to that customer (https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications).
- Sandbox purchases are marked sandbox and never count as production (https://www.revenuecat.com/docs/test-and-launch/sandbox/apple-app-store).

## Endpoints and screens
- `POST /v1/receipts` with an App Store app. `fetch_token` is a StoreKit 2 JWS, a StoreKit 1 base64 receipt or an Xcode StoreKit test receipt (`apps/server/src/stores/apple/index.ts`).
- `POST /v1/notifications/apple/{appId}` takes App Store Server Notifications v2 (`apps/server/src/stores/apple/notifications.ts`). It stores the raw body and forwards the exact body to the app's forwarding URL.
- Code: JWS checks in `jws.ts`, the receipt parser in `receipt.ts` and `asn1.ts`, the App Store Server API client in `api.ts` and the mapping in `map.ts`.
- `POST /v2/projects/{id}/apps/{app_id}/actions/verify_credentials` asks Apple whether the key works, and `GET .../store_settings` shows what is configured.
- Dashboard: the app page `/projects/:projectId/apps/:appId` (`AppConfig.tsx`) holds the key, the notification URL with its last received time, and the forwarding URL.

## Tests that prove it
- `apps/server/test/apple.test.ts` (30 tests) covers StoreKit 2 purchases, idempotency, trials and intro offers, consumables, lifetime unlocks, family sharing, revocations, sandbox, bundle ID checks, tampered and wrongly chained payloads, StoreKit 1 receipts, history and renewal info from the Server API, billing retry, outages as 503, and Xcode receipts.
- `apps/server/test/apple-notifications.test.ts` (29 tests) covers each notification type and subtype, rejected payloads (400 for bad signature or bundle, 404 for an unknown app) and forwarding.
- `apps/server/test/lifecycle-events.test.ts` (App Store part) covers declined price increases, upgrades, downgrades and reversed refunds.
- `apps/server/test/setup-endpoints.test.ts` covers credential checks against a mocked Apple.
- `apps/server/test/store-actions.test.ts` covers extend and mass extend.

## Known gaps
- No real App Store sandbox purchase has run end to end. It needs store credentials.
- Consumption information for Refund Control is not sent. RevenueCat does not require it.
- Without an In-App Purchase key, a StoreKit 1 receipt's signature is not checked. The server refuses it unless `allow_unsigned_receipts` is set, which is meant for development only.
