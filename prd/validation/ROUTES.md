# Route coverage

**436 routes; 298 are called by a passing real-server journey and 418 by the test suite; 0 by neither.** Generated 2026-10-02 by `pnpm tsx scripts/e2e/journeys/coverage.ts` from the app's own route table, the request logs of the latest passing run of each journey (ads-rewards, android, assistant, dashboard-ui, identity, importer, integrations, ios, lifecycle, lifecycle-tools, onboarding, self-host, settings-auth, stores, targeting, web-billing, web-sdk) and a test-suite run with `REVENUEDOT_TEST_REQUEST_LOG`. Feature-level status is in [COVERAGE.md](COVERAGE.md).

- Both a journey and a test: 280
- A journey only: 18
- Tests only: 138
- Neither: 0

A journey cell lists the journey and the HTTP statuses it saw. Test cells name the test files.


## /

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | node-dashboard |

## /.well-known

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/.well-known/jwks.json` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth |
| GET | `/.well-known/oauth-authorization-server` | — | oauth |
| GET | `/.well-known/revenuedot-signing-key` | — | signing |

## /assets

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/assets/:project_id/:object` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | v2-paywall-builder, v2-paywalls |
| GET | `/assets/icons/:file` | android (200), ios (200) | v2-paywall-builder |

## /auth

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/auth/config` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | signup |
| POST | `/auth/email/verify` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | account-email |
| POST | `/auth/email/verify/resend` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | account-email |
| GET | `/auth/invites/:token` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | invites |
| POST | `/auth/invites/:token/accept` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | invites |
| POST | `/auth/login` | onboarding (200/400/401/403), web-sdk (200/400/401/403), assistant (200/400/401/403), importer (200/400/401/403), lifecycle (200/400/401/403), identity (200/400/401/403), targeting (200/400/401/403), integrations (200/400/401/403), self-host (200/400/401/403), web-billing (200/400/401/403), ads-rewards (200/400/401/403), lifecycle-tools (200/400/401/403), stores (200/400/401/403), dashboard-ui (200/400/401/403), settings-auth (200/400/401/403), android (200/400/401/403), ios (200/400/401/403) | account-email, identity-auth, oauth, signup, sdk-inventory |
| POST | `/auth/logout` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions |
| GET | `/auth/me` | onboarding (200/401), web-sdk (200/401), assistant (200/401), importer (200/401), lifecycle (200/401), identity (200/401), targeting (200/401), integrations (200/401), self-host (200/401), web-billing (200/401), ads-rewards (200/401), lifecycle-tools (200/401), stores (200/401), dashboard-ui (200/401), settings-auth (200/401), android (200/401), ios (200/401) | account-email, alerts, assistant-agent, assistant-security, assistant-stream, assistant-tools, invites, oauth, project-settings-tabs, v2-extras |
| POST | `/auth/me` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | account-email, alerts |
| POST | `/auth/password/check` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | account-email |
| POST | `/auth/password/forgot` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | account-email, signup |
| POST | `/auth/password/reset` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | account-email |
| POST | `/auth/revoke` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth, sdk-inventory |
| POST | `/auth/signup` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201/409), ios (201/409) | account-email, alerts, assistant-agent, assistant-security, assistant-stream, assistant-tools, invites, oauth, project-settings-tabs, signup, v2-auth-extensions, v2-catalog, v2-extras, v2-project-settings |
| POST | `/auth/token` | onboarding (200/401/403), web-sdk (200/401/403), assistant (200/401/403), importer (200/401/403), lifecycle (200/401/403), identity (200/401/403), targeting (200/401/403), integrations (200/401/403), self-host (200/401/403), web-billing (200/401/403), ads-rewards (200/401/403), lifecycle-tools (200/401/403), stores (200/401/403), dashboard-ui (200/401/403), settings-auth (200/401/403), android (200/401/403), ios (200/401/403) | identity-auth, sdk-inventory |

## /blobs

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/blobs/:ref` | — | remote-config |

## /oauth

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/oauth/authorize` | — | oauth |
| POST | `/oauth/authorize` | — | oauth |
| POST | `/oauth/register` | — | oauth |
| POST | `/oauth/token` | — | oauth |

## /pay

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/pay/:project/_/cancel` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | — |
| GET | `/pay/:project/_/success` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | web-billing |
| GET | `/pay/:project/:slug` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | funnel-ads, funnels, web-billing, web-safety |
| GET | `/pay/:project/:slug/success` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnel-ads, funnels, web-billing, web-safety, redemption, v2-discounts |
| POST | `/pay/api/checkout` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnel-ads, funnels, web-billing, web-safety, redemption, v2-discounts |
| POST | `/pay/api/discount` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-discounts |
| POST | `/pay/api/events` | onboarding (204), web-sdk (204), assistant (204), importer (204), lifecycle (204), identity (204), targeting (204), integrations (204), self-host (204), web-billing (204), ads-rewards (204), lifecycle-tools (204), stores (204), dashboard-ui (204), settings-auth (204), android (204), ios (204) | funnel-ads, funnels |
| GET | `/pay/r/:token` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | web-billing, web-safety, redemption |

## /rcbilling

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/rcbilling/v1/branding` | — | sdk-endpoints, sdk-inventory |
| GET | `/rcbilling/v1/checkout/:session` | — | sdk-endpoints, sdk-inventory |
| PATCH | `/rcbilling/v1/checkout/:session` | — | sdk-endpoints, sdk-inventory |
| POST | `/rcbilling/v1/checkout/:session/complete` | — | sdk-endpoints, sdk-inventory |
| POST | `/rcbilling/v1/checkout/prepare` | — | sdk-endpoints, sdk-inventory |
| POST | `/rcbilling/v1/checkout/start` | — | sdk-endpoints, sdk-inventory |
| GET | `/rcbilling/v1/customer/offering_products` | — | sdk-inventory |
| GET | `/rcbilling/v1/customer/products` | — | sdk-inventory, v2-remaining |
| POST | `/rcbilling/v1/hosted-checkout` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | web-billing, sdk-endpoints, sdk-inventory |
| POST | `/rcbilling/v1/purchase` | — | sdk-endpoints, sdk-inventory |
| GET | `/rcbilling/v1/subscribers/:id/offering_products` | — | sdk-endpoints, sdk-inventory |
| GET | `/rcbilling/v1/subscribers/:id/products` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | sdk-inventory, sdk, v2-catalog, v2-remaining |

## /share

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/share/first-sale/:token` | — | assistant-stream |

## /v1

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v1/ads/admob/oauth/callback` | onboarding (302), web-sdk (302), assistant (302), importer (302), lifecycle (302), identity (302), targeting (302), integrations (302), self-host (302), web-billing (302), ads-rewards (302), lifecycle-tools (302), stores (302), dashboard-ui (302), settings-auth (302), android (302), ios (302) | ads |
| GET | `/v1/ads/admob/ssv` | onboarding (200/400/403), web-sdk (200/400/403), assistant (200/400/403), importer (200/400/403), lifecycle (200/400/403), identity (200/400/403), targeting (200/400/403), integrations (200/400/403), self-host (200/400/403), web-billing (200/400/403), ads-rewards (200/400/403), lifecycle-tools (200/400/403), stores (200/400/403), dashboard-ui (200/400/403), settings-auth (200/400/403), android (200/400/403), ios (200/400/403) | ads |
| POST | `/v1/auth/login` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | — |
| POST | `/v1/auth/revoke` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | identity-auth |
| POST | `/v1/auth/token` | onboarding (200/401), web-sdk (200/401), assistant (200/401), importer (200/401), lifecycle (200/401), identity (200/401), targeting (200/401), integrations (200/401), self-host (200/401), web-billing (200/401), ads-rewards (200/401), lifecycle-tools (200/401), stores (200/401), dashboard-ui (200/401), settings-auth (200/401) | — |
| GET | `/v1/config/:domain` | — | sdk-inventory |
| POST | `/v1/config/:domain` | android (200/204), ios (200/204) | remote-config, sdk-inventory, sdk, v2-paywall-builder |
| GET | `/v1/customer` | onboarding (200/401), web-sdk (200/401), assistant (200/401), importer (200/401), lifecycle (200/401), identity (200/401), targeting (200/401), integrations (200/401), self-host (200/401), web-billing (200/401), ads-rewards (200/401), lifecycle-tools (200/401), stores (200/401), dashboard-ui (200/401), settings-auth (200/401), android (200/401), ios (200/401) | identity-auth, sdk-inventory, v2-remaining |
| GET | `/v1/customer/ads/reward_verifications/:client_transaction_id` | — | ads, sdk-inventory |
| POST | `/v1/customer/adservices_attribution` | — | sdk-inventory |
| GET | `/v1/customer/attributes` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth |
| POST | `/v1/customer/attributes` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth, sdk-inventory, v2-remaining |
| POST | `/v1/customer/attribution` | — | sdk-inventory |
| GET | `/v1/customer/customercenter` | — | sdk-inventory, v2-remaining |
| POST | `/v1/customer/customercenter/support/create-ticket` | — | sdk-inventory |
| GET | `/v1/customer/health_report` | — | sdk-inventory |
| POST | `/v1/customer/intro_eligibility` | — | sdk-inventory |
| GET | `/v1/customer/offerings` | — | sdk-inventory, v2-remaining |
| POST | `/v1/customer/restore/eligibility` | — | sdk-inventory |
| GET | `/v1/customer/virtual_currencies` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth, sdk-inventory, v2-remaining |
| POST | `/v1/customer/virtual_currencies/spend` | onboarding (200/422), web-sdk (200/422), assistant (200/422), importer (200/422), lifecycle (200/422), identity (200/422), targeting (200/422), integrations (200/422), self-host (200/422), web-billing (200/422), ads-rewards (200/422), lifecycle-tools (200/422), stores (200/422), dashboard-ui (200/422), settings-auth (200/422), android (200/422), ios (200/422) | sdk-inventory, v2-remaining |
| GET | `/v1/customercenter/:id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | retention, support, customer-center, sdk-inventory, v2-extras, v2-remaining |
| POST | `/v1/customercenter/support/create-ticket` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | client-ip, support, sdk-inventory |
| POST | `/v1/diagnostics` | — | sdk-inventory, sdk |
| POST | `/v1/events` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads, charts-sql, sdk-inventory, sdk, v2-charts, v2-remaining |
| POST | `/v1/external_purchase_tokens` | — | sdk-endpoints, sdk-inventory |
| GET | `/v1/health` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | node-dashboard, signing, sdk-endpoints, sdk-inventory, sdk |
| GET | `/v1/health/connectivity` | — | sdk-endpoints, sdk-inventory |
| POST | `/v1/notifications/amazon/:appId` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | amazon |
| POST | `/v1/notifications/apple/:appId` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | apple-notifications, import, lifecycle-events, refund-control, win-back |
| POST | `/v1/notifications/google/:appId` | onboarding (200/401), web-sdk (200/401), assistant (200/401), importer (200/401), lifecycle (200/401), identity (200/401), targeting (200/401), integrations (200/401), self-host (200/401), web-billing (200/401), ads-rewards (200/401), lifecycle-tools (200/401), stores (200/401), dashboard-ui (200/401), settings-auth (200/401), android (200/401), ios (200/401) | google, import, lifecycle-events, setup-health |
| POST | `/v1/notifications/stripe/:appId` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | stripe, web-billing, web-safety |
| GET | `/v1/offerings` | — | sdk-inventory, sdk |
| POST | `/v1/offers` | — | sdk-endpoints, sdk-inventory, v2-remaining |
| GET | `/v1/product_entitlement_mapping` | android (200), ios (200) | store-import, offline-entitlements, sdk-inventory, sdk, v2-catalog |
| POST | `/v1/receipts` | onboarding (200/400/401), web-sdk (200/400/401), assistant (200/400/401), importer (200/400/401), lifecycle (200/400/401), identity (200/400/401), targeting (200/400/401), integrations (200/400/401), self-host (200/400/401), web-billing (200/400/401), ads-rewards (200/400/401), lifecycle-tools (200/400/401), stores (200/400/401), dashboard-ui (200/400/401), settings-auth (200/400/401), android (200/400/401), ios (200/400/401) | alerts, amazon, apple-notifications, apple, fx, google, identity-auth, import, lifecycle-events, project-settings-tabs, refund-control, setup-health, store-actions, store-ops, stripe, web-safety, win-back, charts-sql, redemption, rest-webhooks, sdk-endpoints, sdk-inventory, sdk, test-purchase-scenarios, test-store-web-price, v2-auth-extensions, v2-charts, v2-customers, v2-dashboard-overview, v2-discounts, v2-extras, v2-import, v2-project-settings, v2-remaining, v2-targeting, webhook-payloads |
| GET | `/v1/receipts/amazon/:storeUserId/:receiptId` | — | amazon, sdk-inventory |
| POST | `/v1/retention/apple/:appId` | onboarding (400/404), web-sdk (400/404), assistant (400/404), importer (400/404), lifecycle (400/404), identity (400/404), targeting (400/404), integrations (400/404), self-host (400/404), web-billing (400/404), ads-rewards (400/404), lifecycle-tools (400/404), stores (400/404), dashboard-ui (400/404), settings-auth (400/404), android (400/404), ios (400/404) | retention |
| DELETE | `/v1/subscribers/:id` | — | rest-webhooks |
| GET | `/v1/subscribers/:id` | onboarding (200/201), web-sdk (200/201), assistant (200/201), importer (200/201), lifecycle (200/201), identity (200/201), targeting (200/201), integrations (200/201), self-host (200/201), web-billing (200/201), ads-rewards (200/201), lifecycle-tools (200/201), stores (200/201), dashboard-ui (200/201), settings-auth (200/201), android (200/201), ios (200/201) | ads, amazon, apple-notifications, apple, google, identity-auth, import, lifecycle-events, merge-currency, project-settings-tabs, setup-health, signing, stripe, support, web-billing, web-safety, win-back, charts-sql, concurrency, customer-center, redemption, rest-webhooks, sdk-endpoints, sdk-inventory, sdk, test-purchase-scenarios, v2-auth-extensions, v2-catalog, v2-charts, v2-customers, v2-extras, v2-import, v2-remaining, v2-targeting, webhook-payloads, importer |
| GET | `/v1/subscribers/:id/ads/reward_verifications/:tx` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads, sdk-endpoints, sdk-inventory |
| POST | `/v1/subscribers/:id/adservices_attribution` | — | sdk-endpoints, sdk-inventory |
| POST | `/v1/subscribers/:id/alias` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | sdk-inventory, v2-remaining, webhook-payloads |
| GET | `/v1/subscribers/:id/attributes` | onboarding (401), web-sdk (401), assistant (401), importer (401), lifecycle (401), identity (401), targeting (401), integrations (401), self-host (401), web-billing (401), ads-rewards (401), lifecycle-tools (401), stores (401), dashboard-ui (401), settings-auth (401), android (401), ios (401) | identity-auth |
| POST | `/v1/subscribers/:id/attributes` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth, web-safety, concurrency, rest-webhooks, sdk-endpoints, sdk-inventory, sdk, v2-customers, v2-remaining, webhook-payloads |
| POST | `/v1/subscribers/:id/attribution` | android (200), ios (200) | sdk-endpoints, sdk-inventory |
| POST | `/v1/subscribers/:id/entitlements/:ent/promotional` | — | rest-webhooks, webhook-payloads |
| POST | `/v1/subscribers/:id/entitlements/:ent/revoke_promotionals` | — | rest-webhooks |
| GET | `/v1/subscribers/:id/health_report` | — | sdk-inventory |
| GET | `/v1/subscribers/:id/health_report_availability` | android (200), ios (200) | sdk-endpoints, sdk-inventory |
| POST | `/v1/subscribers/:id/intro_eligibility` | — | sdk-inventory |
| GET | `/v1/subscribers/:id/offerings` | onboarding (200/401), web-sdk (200/401), assistant (200/401), importer (200/401), lifecycle (200/401), identity (200/401), targeting (200/401), integrations (200/401), self-host (200/401), web-billing (200/401), ads-rewards (200/401), lifecycle-tools (200/401), stores (200/401), dashboard-ui (200/401), settings-auth (200/401), android (200/401), ios (200/401) | project-settings-tabs, setup-health, signing, rest-webhooks, sdk-inventory, sdk, v2-catalog, v2-customers, v2-paywall-builder, v2-paywalls, v2-remaining, v2-targeting, webhook-payloads |
| POST | `/v1/subscribers/:id/offerings/:offering/override` | — | rest-webhooks |
| DELETE | `/v1/subscribers/:id/offerings/override` | — | rest-webhooks |
| POST | `/v1/subscribers/:id/restore/eligibility` | — | sdk-inventory |
| POST | `/v1/subscribers/:id/subscriptions/:pid/cancel` | — | store-actions |
| POST | `/v1/subscribers/:id/subscriptions/:pid/defer` | — | store-actions |
| POST | `/v1/subscribers/:id/subscriptions/:pid/extend` | — | store-actions |
| POST | `/v1/subscribers/:id/subscriptions/:pid/revoke` | — | store-actions |
| POST | `/v1/subscribers/:id/transactions/:pid/refund` | — | store-actions |
| GET | `/v1/subscribers/:id/virtual_currencies` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads, identity-auth, merge-currency, sdk-inventory, v2-extras, v2-remaining |
| GET | `/v1/subscribers/:id/workflows` | — | sdk-endpoints, sdk-inventory |
| GET | `/v1/subscribers/:id/workflows/:workflow` | — | sdk-endpoints, sdk-inventory |
| POST | `/v1/subscribers/identify` | onboarding (200/201), web-sdk (200/201), assistant (200/201), importer (200/201), lifecycle (200/201), identity (200/201), targeting (200/201), integrations (200/201), self-host (200/201), web-billing (200/201), ads-rewards (200/201), lifecycle-tools (200/201), stores (200/201), dashboard-ui (200/201), settings-auth (200/201), android (200/201), ios (200/201) | merge-currency, project-settings-tabs, signing, sdk-inventory, sdk, v2-customers, v2-remaining, webhook-payloads |
| POST | `/v1/subscribers/redeem_purchase` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | web-safety, redemption, sdk-endpoints, sdk-inventory |
| POST | `/v1/support/intercom/:projectId/canvas` | onboarding (200/401), web-sdk (200/401), assistant (200/401), importer (200/401), lifecycle (200/401), identity (200/401), targeting (200/401), integrations (200/401), self-host (200/401), web-billing (200/401), ads-rewards (200/401), lifecycle-tools (200/401), stores (200/401), dashboard-ui (200/401), settings-auth (200/401), android (200/401), ios (200/401) | ads |
| GET | `/v1/winback/c/:token` | onboarding (302/404), web-sdk (302/404), assistant (302/404), importer (302/404), lifecycle (302/404), identity (302/404), targeting (302/404), integrations (302/404), self-host (302/404), web-billing (302/404), ads-rewards (302/404), lifecycle-tools (302/404), stores (302/404), dashboard-ui (302/404), settings-auth (302/404), android (302/404), ios (302/404) | winback |
| GET | `/v1/winback/o/:token` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback |
| GET | `/v1/winback/u/:token` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback |
| POST | `/v1/winback/u/:token` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback |

## /v2

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | oauth, v2-auth-extensions, v2-catalog, v2-project-settings, importer |
| POST | `/v2/projects` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | assistant-tools, v2-catalog |
| DELETE | `/v2/projects/:project_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | invites, v2-project-settings |
| GET | `/v2/projects/:project_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | invites, project-settings-tabs, v2-project-settings |
| POST | `/v2/projects/:project_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | invites, project-settings-tabs, v2-project-settings |

## /v2 actions

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| POST | `/v2/projects/:project_id/actions/transfer_ownership` | onboarding (200/403), web-sdk (200/403), assistant (200/403), importer (200/403), lifecycle (200/403), identity (200/403), targeting (200/403), integrations (200/403), self-host (200/403), web-billing (200/403), ads-rewards (200/403), lifecycle-tools (200/403), stores (200/403), dashboard-ui (200/403), settings-auth (200/403), android (200/403), ios (200/403) | invites, project-settings-tabs |

## /v2 ads

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| DELETE | `/v2/projects/:project_id/ads/admob` | — | ads |
| GET | `/v2/projects/:project_id/ads/admob` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads |
| POST | `/v2/projects/:project_id/ads/admob/connect` | onboarding (200/422), web-sdk (200/422), assistant (200/422), importer (200/422), lifecycle (200/422), identity (200/422), targeting (200/422), integrations (200/422), self-host (200/422), web-billing (200/422), ads-rewards (200/422), lifecycle-tools (200/422), stores (200/422), dashboard-ui (200/422), settings-auth (200/422), android (200/422), ios (200/422) | ads |
| POST | `/v2/projects/:project_id/ads/admob/finish` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | ads |
| POST | `/v2/projects/:project_id/ads/admob/refresh` | — | ads |
| GET | `/v2/projects/:project_id/ads/apple_search_ads/report` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads |
| POST | `/v2/projects/:project_id/ads/apple_search_ads/sync` | — | ads |
| GET | `/v2/projects/:project_id/ads/overview` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | ads |
| GET | `/v2/projects/:project_id/ads/reward_rules` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/ads/reward_rules` | onboarding (201/400), web-sdk (201/400), assistant (201/400), importer (201/400), lifecycle (201/400), identity (201/400), targeting (201/400), integrations (201/400), self-host (201/400), web-billing (201/400), ads-rewards (201/400), lifecycle-tools (201/400), stores (201/400), dashboard-ui (201/400), settings-auth (201/400), android (201/400), ios (201/400) | ads, sdk-endpoints |
| DELETE | `/v2/projects/:project_id/ads/reward_rules/:rule_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | ads |
| POST | `/v2/projects/:project_id/ads/reward_rules/:rule_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | ads |
| POST | `/v2/projects/:project_id/ads/reward_rules/actions/reorder` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | ads |
| GET | `/v2/projects/:project_id/ads/reward_verifications` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads |
| POST | `/v2/projects/:project_id/ads/reward_verifications/test` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | ads, sdk-endpoints |

## /v2 ai

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/ai` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-stream |
| GET | `/v2/projects/:project_id/ai/conversations` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-security, assistant-stream |
| POST | `/v2/projects/:project_id/ai/conversations` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | assistant-agent, assistant-security, assistant-stream |
| DELETE | `/v2/projects/:project_id/ai/conversations/:conversation_id` | — | assistant-stream |
| GET | `/v2/projects/:project_id/ai/conversations/:conversation_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-agent, assistant-security, assistant-stream |
| POST | `/v2/projects/:project_id/ai/conversations/:conversation_id` | — | assistant-security, assistant-stream |
| POST | `/v2/projects/:project_id/ai/conversations/:conversation_id/chat` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-agent, assistant-security, assistant-stream |
| POST | `/v2/projects/:project_id/ai/conversations/:conversation_id/stop` | — | assistant-stream |
| GET | `/v2/projects/:project_id/ai/conversations/:conversation_id/stream` | — | assistant-stream |
| POST | `/v2/projects/:project_id/ai/files` | — | assistant-security, assistant-stream |
| GET | `/v2/projects/:project_id/ai/files/:file_id` | — | assistant-security, assistant-stream |
| GET | `/v2/projects/:project_id/ai/first_sale` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-stream |
| POST | `/v2/projects/:project_id/ai/first_sale/dismiss` | — | assistant-security, assistant-stream |
| GET | `/v2/projects/:project_id/ai/mentions` | — | assistant-stream |
| POST | `/v2/projects/:project_id/ai/settings` | onboarding (200/403), web-sdk (200/403), assistant (200/403), importer (200/403), lifecycle (200/403), identity (200/403), targeting (200/403), integrations (200/403), self-host (200/403), web-billing (200/403), ads-rewards (200/403), lifecycle-tools (200/403), stores (200/403), dashboard-ui (200/403), settings-auth (200/403), android (200/403), ios (200/403) | assistant-agent, assistant-security, assistant-stream, assistant-tools |
| POST | `/v2/projects/:project_id/ai/storekit` | — | assistant-stream |

## /v2 api_keys

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/api_keys` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | invites, oauth, v2-auth-extensions |
| POST | `/v2/projects/:project_id/api_keys` | onboarding (201/403), web-sdk (201/403), assistant (201/403), importer (201/403), lifecycle (201/403), identity (201/403), targeting (201/403), integrations (201/403), self-host (201/403), web-billing (201/403), ads-rewards (201/403), lifecycle-tools (201/403), stores (201/403), dashboard-ui (201/403), settings-auth (201/403), android (201), ios (201) | account-email, assistant-security, assistant-stream, invites, v2-auth-extensions |
| DELETE | `/v2/projects/:project_id/api_keys/:key_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | oauth, v2-auth-extensions |

## /v2 apps

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/apps` | onboarding (200/401), web-sdk (200/401), assistant (200/401), importer (200/401), lifecycle (200/401), identity (200/401), targeting (200/401), integrations (200/401), self-host (200/401), web-billing (200/401), ads-rewards (200/401), lifecycle-tools (200/401), stores (200/401), dashboard-ui (200/401), settings-auth (200/401), android (200/401), ios (200/401) | assistant-security, v2-auth-extensions, v2-catalog, v2-remaining, importer |
| POST | `/v2/projects/:project_id/apps` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | alerts, amazon, assistant-agent, assistant-security, assistant-stream, assistant-tools, stripe, v2-auth-extensions, v2-catalog, v2-project-settings, importer |
| DELETE | `/v2/projects/:project_id/apps/:app_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | alerts, v2-auth-extensions, v2-catalog |
| GET | `/v2/projects/:project_id/apps/:app_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | setup-health, v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/apps/:app_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | alerts, amazon, setup-endpoints, stripe, v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/apps/:app_id/actions/mass_extend` | — | store-actions |
| POST | `/v2/projects/:project_id/apps/:app_id/actions/verify_credentials` | onboarding (200/500), web-sdk (200/500), assistant (200/500), importer (200/500), lifecycle (200/500), identity (200/500), targeting (200/500), integrations (200/500), self-host (200/500), web-billing (200/500), ads-rewards (200/500), lifecycle-tools (200/500), stores (200/500), dashboard-ui (200/500), settings-auth (200/500), android (200), ios (200) | alerts, amazon, setup-endpoints, stripe |
| POST | `/v2/projects/:project_id/apps/:app_id/authenticate` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads, sdk-inventory, v2-remaining |
| GET | `/v2/projects/:project_id/apps/:app_id/mass_extensions/:request_id` | — | store-actions |
| GET | `/v2/projects/:project_id/apps/:app_id/public_api_keys` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | alerts, stripe, v2-auth-extensions, v2-catalog |
| GET | `/v2/projects/:project_id/apps/:app_id/retention_messaging` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/apps/:app_id/retention_messaging` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | retention |
| POST | `/v2/projects/:project_id/apps/:app_id/retention_messaging/actions/sync` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | retention |
| GET | `/v2/projects/:project_id/apps/:app_id/store_kit_config` | — | v2-extras |
| GET | `/v2/projects/:project_id/apps/:app_id/store_products` | onboarding (200/422), web-sdk (200/422), assistant (200/422), importer (200/422), lifecycle (200/422), identity (200/422), targeting (200/422), integrations (200/422), self-host (200/422), web-billing (200/422), ads-rewards (200/422), lifecycle-tools (200/422), stores (200/422), dashboard-ui (200/422), settings-auth (200/422) | store-import |
| POST | `/v2/projects/:project_id/apps/:app_id/store_products/actions/import` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201) | store-import |
| GET | `/v2/projects/:project_id/apps/:app_id/store_settings` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | amazon, setup-endpoints, setup-health, stripe |
| GET | `/v2/projects/:project_id/apps/:app_id/web_config` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | web-billing |
| PUT | `/v2/projects/:project_id/apps/:app_id/web_config` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnel-ads, funnels, web-billing, web-safety, redemption, v2-discounts |
| GET | `/v2/projects/:project_id/apps/:app_id/web_products` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | web-billing |
| POST | `/v2/projects/:project_id/apps/:app_id/web_products` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | funnel-ads, funnels, web-billing, web-safety, redemption, v2-discounts |

## /v2 audiences

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/audiences` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |
| POST | `/v2/projects/:project_id/audiences` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | customer-lists, winback, v2-targeting |
| DELETE | `/v2/projects/:project_id/audiences/:audience_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback, v2-targeting |
| GET | `/v2/projects/:project_id/audiences/:audience_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |
| POST | `/v2/projects/:project_id/audiences/:audience_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |
| POST | `/v2/projects/:project_id/audiences/actions/preview` | — | v2-targeting |
| GET | `/v2/projects/:project_id/audiences/filter_options` | — | v2-targeting |

## /v2 audit_logs

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/audit_logs` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-extras |

## /v2 auth

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/auth/identities` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth |
| DELETE | `/v2/projects/:project_id/auth/identities/:provider_id/:subject` | — | identity-auth |
| GET | `/v2/projects/:project_id/auth/identities/:provider_id/:subject` | onboarding (200/403/404), web-sdk (200/403/404), assistant (200/403/404), importer (200/403/404), lifecycle (200/403/404), identity (200/403/404), targeting (200/403/404), integrations (200/403/404), self-host (200/403/404), web-billing (200/403/404), ads-rewards (200/403/404), lifecycle-tools (200/403/404), stores (200/403/404), dashboard-ui (200/403/404), settings-auth (200/403/404), android (200/403/404), ios (200/403/404) | identity-auth |
| GET | `/v2/projects/:project_id/auth/providers` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | — |
| POST | `/v2/projects/:project_id/auth/providers` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | identity-auth |
| DELETE | `/v2/projects/:project_id/auth/providers/:provider_id` | — | identity-auth |
| GET | `/v2/projects/:project_id/auth/providers/:provider_id` | — | identity-auth |
| POST | `/v2/projects/:project_id/auth/providers/:provider_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth |
| POST | `/v2/projects/:project_id/auth/providers/:provider_id/actions/test` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth |
| GET | `/v2/projects/:project_id/auth/settings` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | — |
| POST | `/v2/projects/:project_id/auth/settings` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | identity-auth |

## /v2 blocked_customers

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/blocked_customers` | — | project-settings-tabs |
| POST | `/v2/projects/:project_id/blocked_customers` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | project-settings-tabs |
| DELETE | `/v2/projects/:project_id/blocked_customers/:app_user_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |
| GET | `/v2/projects/:project_id/blocked_customers/:app_user_id` | — | project-settings-tabs |

## /v2 brand

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/brand` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |
| POST | `/v2/projects/:project_id/brand` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |

## /v2 charts

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/charts/:chart_name` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-tools, charts-sql, v2-charts |
| GET | `/v2/projects/:project_id/charts/:chart_name/options` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-charts |

## /v2 collaborators

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/collaborators` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | invites, v2-project-settings |
| DELETE | `/v2/projects/:project_id/collaborators/:user_id` | onboarding (200/422), web-sdk (200/422), assistant (200/422), importer (200/422), lifecycle (200/422), identity (200/422), targeting (200/422), integrations (200/422), self-host (200/422), web-billing (200/422), ads-rewards (200/422), lifecycle-tools (200/422), stores (200/422), dashboard-ui (200/422), settings-auth (200/422), android (200/422), ios (200/422) | invites, project-settings-tabs |
| POST | `/v2/projects/:project_id/collaborators/:user_id` | onboarding (200/422), web-sdk (200/422), assistant (200/422), importer (200/422), lifecycle (200/422), identity (200/422), targeting (200/422), integrations (200/422), self-host (200/422), web-billing (200/422), ads-rewards (200/422), lifecycle-tools (200/422), stores (200/422), dashboard-ui (200/422), settings-auth (200/422), android (200/422), ios (200/422) | invites, project-settings-tabs |

## /v2 customer_center_config

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/customer_center_config` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | customer-center, v2-extras |
| POST | `/v2/projects/:project_id/customer_center_config` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | customer-center, support, customer-center, v2-extras |

## /v2 customer_lists

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/customer_lists` | onboarding (200/400/404), web-sdk (200/400/404), assistant (200/400/404), importer (200/400/404), lifecycle (200/400/404), identity (200/400/404), targeting (200/400/404), integrations (200/400/404), self-host (200/400/404), web-billing (200/400/404), ads-rewards (200/400/404), lifecycle-tools (200/400/404), stores (200/400/404), dashboard-ui (200/400/404), settings-auth (200/400/404), android (200/400/404), ios (200/400/404) | customer-lists |
| GET | `/v2/projects/:project_id/customer_lists/export` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | customer-lists |

## /v2 customer_summaries

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/customer_summaries` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs, v2-dashboard-overview, v2-targeting |

## /v2 customers

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/customers` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-customers, importer |
| POST | `/v2/projects/:project_id/customers` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | assistant-agent, assistant-security, assistant-stream, merge-currency, store-ops, v2-customers, v2-dashboard-overview, v2-extras, v2-remaining |
| DELETE | `/v2/projects/:project_id/customers/:customer_id` | — | v2-auth-extensions, v2-customers, v2-remaining |
| GET | `/v2/projects/:project_id/customers/:customer_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | assistant-agent, assistant-security, assistant-stream, project-settings-tabs, setup-health, sdk-endpoints, v2-auth-extensions, v2-customers, v2-import, importer |
| POST | `/v2/projects/:project_id/customers/:customer_id/actions/assign_offering` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-customers, v2-dashboard-overview, v2-targeting |
| POST | `/v2/projects/:project_id/customers/:customer_id/actions/grant_entitlement` | onboarding (201/403), web-sdk (201/403), assistant (201/403), importer (201/403), lifecycle (201/403), identity (201/403), targeting (201/403), integrations (201/403), self-host (201/403), web-billing (201/403), ads-rewards (201/403), lifecycle-tools (201/403), stores (201/403), dashboard-ui (201/403), settings-auth (201/403), android (201/403), ios (201/403) | assistant-agent, assistant-security, assistant-tools, project-settings-tabs, v2-customers, v2-dashboard-overview |
| POST | `/v2/projects/:project_id/customers/:customer_id/actions/restore_purchase_by_order_id` | — | store-ops, v2-remaining |
| POST | `/v2/projects/:project_id/customers/:customer_id/actions/revoke_granted_entitlement` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-customers, v2-dashboard-overview |
| POST | `/v2/projects/:project_id/customers/:customer_id/actions/transfer` | — | v2-extras |
| GET | `/v2/projects/:project_id/customers/:customer_id/active_entitlements` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-agent, v2-customers |
| GET | `/v2/projects/:project_id/customers/:customer_id/aliases` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-customers, v2-import |
| GET | `/v2/projects/:project_id/customers/:customer_id/attributes` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-customers |
| POST | `/v2/projects/:project_id/customers/:customer_id/attributes` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | ads, support, v2-customers, v2-targeting |
| GET | `/v2/projects/:project_id/customers/:customer_id/customer_center` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | customer-center, v2-extras |
| GET | `/v2/projects/:project_id/customers/:customer_id/events` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-customers, v2-import |
| GET | `/v2/projects/:project_id/customers/:customer_id/invoices` | — | v2-remaining |
| GET | `/v2/projects/:project_id/customers/:customer_id/invoices/:invoice_id/file` | — | v2-remaining |
| GET | `/v2/projects/:project_id/customers/:customer_id/purchases` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-stream, v2-customers, v2-extras, v2-import |
| GET | `/v2/projects/:project_id/customers/:customer_id/subscriptions` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-stream, project-settings-tabs, v2-auth-extensions, v2-customers, v2-extras, v2-import, importer |
| GET | `/v2/projects/:project_id/customers/:customer_id/support_summary` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | support |
| GET | `/v2/projects/:project_id/customers/:customer_id/virtual_currencies` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs, v2-extras |
| POST | `/v2/projects/:project_id/customers/:customer_id/virtual_currencies/transactions` | onboarding (200/422), web-sdk (200/422), assistant (200/422), importer (200/422), lifecycle (200/422), identity (200/422), targeting (200/422), integrations (200/422), self-host (200/422), web-billing (200/422), ads-rewards (200/422), lifecycle-tools (200/422), stores (200/422), dashboard-ui (200/422), settings-auth (200/422), android (200), ios (200) | identity-auth, merge-currency, v2-extras, v2-remaining |
| POST | `/v2/projects/:project_id/customers/:customer_id/virtual_currencies/update_balance` | — | v2-extras |
| GET | `/v2/projects/:project_id/customers/:customer_id/win_back_offers` | — | win-back |

## /v2 discounts

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/discounts` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-discounts, v2-remaining |
| POST | `/v2/projects/:project_id/discounts` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | web-safety, v2-discounts, v2-remaining |
| DELETE | `/v2/projects/:project_id/discounts/:discount_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-discounts, v2-remaining |
| GET | `/v2/projects/:project_id/discounts/:discount_id` | — | v2-discounts, v2-remaining |
| PATCH | `/v2/projects/:project_id/discounts/:discount_id` | — | web-safety, v2-discounts |
| POST | `/v2/projects/:project_id/discounts/:discount_id/actions/disable` | — | v2-discounts |
| POST | `/v2/projects/:project_id/discounts/:discount_id/actions/enable` | — | v2-discounts |
| GET | `/v2/projects/:project_id/discounts/:discount_id/discount_codes` | — | v2-discounts, v2-remaining |
| POST | `/v2/projects/:project_id/discounts/:discount_id/discount_codes` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | web-safety, v2-discounts |
| DELETE | `/v2/projects/:project_id/discounts/:discount_id/discount_codes/:discount_code` | — | v2-discounts |

## /v2 entitlements

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/entitlements` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-agent, assistant-security, assistant-tools, oauth, v2-auth-extensions, v2-catalog, v2-extras, importer |
| POST | `/v2/projects/:project_id/entitlements` | onboarding (201/409), web-sdk (201/409), assistant (201/409), importer (201/409), lifecycle (201/409), identity (201/409), targeting (201/409), integrations (201/409), self-host (201/409), web-billing (201/409), ads-rewards (201/409), lifecycle-tools (201/409), stores (201/409), dashboard-ui (201/409), settings-auth (201/409), android (201), ios (201) | assistant-agent, assistant-security, assistant-stream, assistant-tools, invites, oauth, v2-auth-extensions, v2-catalog, v2-extras, importer |
| DELETE | `/v2/projects/:project_id/entitlements/:entitlement_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog |
| GET | `/v2/projects/:project_id/entitlements/:entitlement_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/entitlements/:entitlement_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-catalog |
| POST | `/v2/projects/:project_id/entitlements/:entitlement_id/actions/archive` | — | v2-catalog |
| POST | `/v2/projects/:project_id/entitlements/:entitlement_id/actions/attach_products` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-agent, assistant-security, assistant-stream, assistant-tools, v2-auth-extensions, v2-catalog, importer |
| POST | `/v2/projects/:project_id/entitlements/:entitlement_id/actions/detach_products` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-catalog |
| POST | `/v2/projects/:project_id/entitlements/:entitlement_id/actions/unarchive` | — | v2-catalog |
| GET | `/v2/projects/:project_id/entitlements/:entitlement_id/products` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-catalog |

## /v2 events

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/events` | — | v2-auth-extensions |

## /v2 experiments

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/experiments` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/experiments` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | v2-targeting, webhook-payloads |
| DELETE | `/v2/projects/:project_id/experiments/:experiment_id` | — | v2-targeting |
| GET | `/v2/projects/:project_id/experiments/:experiment_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/experiments/:experiment_id` | — | v2-targeting |
| POST | `/v2/projects/:project_id/experiments/:experiment_id/actions/pause` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |
| POST | `/v2/projects/:project_id/experiments/:experiment_id/actions/start` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting, webhook-payloads |
| POST | `/v2/projects/:project_id/experiments/:experiment_id/actions/stop` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |
| GET | `/v2/projects/:project_id/experiments/:experiment_id/results` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |

## /v2 fonts

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/fonts` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywalls |
| POST | `/v2/projects/:project_id/fonts` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | v2-paywalls |
| DELETE | `/v2/projects/:project_id/fonts/:font_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |

## /v2 funnels

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/funnels` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnels |
| POST | `/v2/projects/:project_id/funnels` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | funnel-ads, funnels, web-billing, web-safety |
| DELETE | `/v2/projects/:project_id/funnels/:funnel_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| GET | `/v2/projects/:project_id/funnels/:funnel_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | — |
| PATCH | `/v2/projects/:project_id/funnels/:funnel_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnel-ads, funnels, web-safety |
| POST | `/v2/projects/:project_id/funnels/:funnel_id/actions/publish` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnel-ads, funnels, web-safety |
| POST | `/v2/projects/:project_id/funnels/:funnel_id/actions/unpublish` | — | funnels |
| GET | `/v2/projects/:project_id/funnels/:funnel_id/analytics` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnels |
| GET | `/v2/projects/:project_id/funnels/:funnel_id/preview_data` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnels |
| GET | `/v2/projects/:project_id/funnels/ai` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnels |
| POST | `/v2/projects/:project_id/funnels/generate` | — | funnels |

## /v2 import

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| POST | `/v2/projects/:project_id/import/apps/:app_id/public_key` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | import, importer |
| POST | `/v2/projects/:project_id/import/customers` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | import, v2-import, importer |
| GET | `/v2/projects/:project_id/import/status` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | import, v2-import, importer |

## /v2 integrations

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/integrations/catalog` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | integrations |
| GET | `/v2/projects/:project_id/integrations/exports` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/integrations/exports` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | exports |
| DELETE | `/v2/projects/:project_id/integrations/exports/:export_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| GET | `/v2/projects/:project_id/integrations/exports/:export_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | exports |
| POST | `/v2/projects/:project_id/integrations/exports/:export_id` | — | exports |
| POST | `/v2/projects/:project_id/integrations/exports/:export_id/actions/check` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | exports |
| POST | `/v2/projects/:project_id/integrations/exports/:export_id/actions/run` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | exports |
| GET | `/v2/projects/:project_id/integrations/exports/:export_id/runs` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | exports |
| GET | `/v2/projects/:project_id/integrations/partners` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | integrations |
| POST | `/v2/projects/:project_id/integrations/partners` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | ads, funnel-ads, integrations |
| DELETE | `/v2/projects/:project_id/integrations/partners/:integration_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| GET | `/v2/projects/:project_id/integrations/partners/:integration_id` | onboarding (404), web-sdk (404), assistant (404), importer (404), lifecycle (404), identity (404), targeting (404), integrations (404), self-host (404), web-billing (404), ads-rewards (404), lifecycle-tools (404), stores (404), dashboard-ui (404), settings-auth (404), android (404), ios (404) | integrations |
| POST | `/v2/projects/:project_id/integrations/partners/:integration_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | integrations |
| POST | `/v2/projects/:project_id/integrations/partners/:integration_id/actions/replay` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | integrations |
| GET | `/v2/projects/:project_id/integrations/partners/:integration_id/deliveries` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | integrations |
| POST | `/v2/projects/:project_id/integrations/partners/:integration_id/deliveries/:delivery_id/retry` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | integrations |
| POST | `/v2/projects/:project_id/integrations/partners/:integration_id/test` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | integrations |
| GET | `/v2/projects/:project_id/integrations/webhooks` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/integrations/webhooks` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | alerts, funnel-ads, funnels, setup-endpoints, v2-auth-extensions, v2-catalog, webhook-payloads |
| DELETE | `/v2/projects/:project_id/integrations/webhooks/:webhook_integration_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog |
| GET | `/v2/projects/:project_id/integrations/webhooks/:webhook_integration_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/integrations/webhooks/:webhook_integration_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | rest-webhooks, v2-catalog |
| POST | `/v2/projects/:project_id/integrations/webhooks/:webhook_integration_id/test` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | alerts, setup-endpoints, rest-webhooks, webhook-payloads |

## /v2 invites

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/invites` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | invites |
| POST | `/v2/projects/:project_id/invites` | onboarding (201/403), web-sdk (201/403), assistant (201/403), importer (201/403), lifecycle (201/403), identity (201/403), targeting (201/403), integrations (201/403), self-host (201/403), web-billing (201/403), ads-rewards (201/403), lifecycle-tools (201/403), stores (201/403), dashboard-ui (201/403), settings-auth (201/403), android (201), ios (201) | account-email, alerts, invites |
| DELETE | `/v2/projects/:project_id/invites/:invite_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | invites |
| POST | `/v2/projects/:project_id/invites/:invite_id/actions/resend` | — | invites |

## /v2 media_assets

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/media_assets` | — | v2-paywalls |
| POST | `/v2/projects/:project_id/media_assets` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | v2-paywall-builder, v2-paywalls |

## /v2 metrics

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/metrics/history` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200/401), ios (200/401) | v2-dashboard-overview |
| GET | `/v2/projects/:project_id/metrics/overview` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | assistant-agent, assistant-security, assistant-stream, v2-auth-extensions, v2-customers, v2-dashboard-overview |
| GET | `/v2/projects/:project_id/metrics/revenue` | — | v2-extras |

## /v2 offerings

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/offerings` | onboarding (200/403), web-sdk (200/403), assistant (200/403), importer (200/403), lifecycle (200/403), identity (200/403), targeting (200/403), integrations (200/403), self-host (200/403), web-billing (200/403), ads-rewards (200/403), lifecycle-tools (200/403), stores (200/403), dashboard-ui (200/403), settings-auth (200/403), android (200/401/403), ios (200/401/403) | web-billing, web-safety, redemption, remote-config, v2-auth-extensions, v2-catalog, v2-discounts, importer |
| POST | `/v2/projects/:project_id/offerings` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | assistant-stream, funnel-ads, funnels, web-billing, web-safety, redemption, v2-catalog, v2-discounts, v2-paywall-builder, v2-paywalls, v2-targeting, webhook-payloads, importer |
| DELETE | `/v2/projects/:project_id/offerings/:offering_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog |
| GET | `/v2/projects/:project_id/offerings/:offering_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog, v2-paywalls |
| POST | `/v2/projects/:project_id/offerings/:offering_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog, importer |
| POST | `/v2/projects/:project_id/offerings/:offering_id/actions/archive` | — | v2-catalog |
| POST | `/v2/projects/:project_id/offerings/:offering_id/actions/unarchive` | — | v2-catalog |
| GET | `/v2/projects/:project_id/offerings/:offering_id/packages` | — | v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/offerings/:offering_id/packages` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | funnel-ads, funnels, web-billing, web-safety, redemption, v2-catalog, v2-discounts, v2-paywall-builder, importer |

## /v2 packages

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| DELETE | `/v2/projects/:project_id/packages/:package_id` | — | v2-auth-extensions, v2-catalog |
| GET | `/v2/projects/:project_id/packages/:package_id` | — | v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/packages/:package_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-catalog |
| POST | `/v2/projects/:project_id/packages/:package_id/actions/attach_products` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnel-ads, funnels, web-billing, web-safety, redemption, v2-auth-extensions, v2-catalog, v2-discounts, importer |
| POST | `/v2/projects/:project_id/packages/:package_id/actions/detach_products` | — | v2-catalog |
| GET | `/v2/projects/:project_id/packages/:package_id/products` | — | v2-catalog |

## /v2 paywall_templates

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/paywall_templates` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywall-builder |

## /v2 paywalls

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/paywalls` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywall-builder, v2-paywalls |
| POST | `/v2/projects/:project_id/paywalls` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | remote-config, v2-paywall-builder, v2-paywalls |
| DELETE | `/v2/projects/:project_id/paywalls/:paywall_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywalls |
| GET | `/v2/projects/:project_id/paywalls/:paywall_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | v2-paywall-builder, v2-paywalls |
| PATCH | `/v2/projects/:project_id/paywalls/:paywall_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywall-builder, v2-paywalls |
| POST | `/v2/projects/:project_id/paywalls/:paywall_id/actions/attach_offering` | — | v2-paywalls |
| POST | `/v2/projects/:project_id/paywalls/:paywall_id/actions/detach_offering` | — | v2-paywalls |
| POST | `/v2/projects/:project_id/paywalls/:paywall_id/actions/duplicate` | — | v2-paywalls |
| POST | `/v2/projects/:project_id/paywalls/:paywall_id/actions/publish` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | remote-config, v2-paywall-builder, v2-paywalls |
| POST | `/v2/projects/:project_id/paywalls/:paywall_id/actions/unpublish` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | remote-config, v2-paywalls |
| GET | `/v2/projects/:project_id/paywalls/:paywall_id/template` | — | v2-paywalls |
| PUT | `/v2/projects/:project_id/paywalls/:paywall_id/template` | — | v2-paywalls |
| GET | `/v2/projects/:project_id/paywalls/:paywall_id/versions` | — | v2-paywall-builder |
| POST | `/v2/projects/:project_id/paywalls/:paywall_id/versions` | — | v2-paywall-builder, v2-paywalls |
| GET | `/v2/projects/:project_id/paywalls/:paywall_id/versions/:version_id` | — | v2-paywalls |
| POST | `/v2/projects/:project_id/paywalls/:paywall_id/versions/:version_id/actions/restore` | — | v2-paywall-builder |
| GET | `/v2/projects/:project_id/paywalls/ai` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywall-builder |
| POST | `/v2/projects/:project_id/paywalls/generate` | — | v2-paywall-builder |
| POST | `/v2/projects/:project_id/paywalls/validate` | — | v2-paywall-builder |

## /v2 products

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/products` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200/401), ios (200/401) | assistant-stream, assistant-tools, v2-auth-extensions, v2-catalog, importer |
| POST | `/v2/projects/:project_id/products` | onboarding (201/403/409), web-sdk (201/403/409), assistant (201/403/409), importer (201/403/409), lifecycle (201/403/409), identity (201/403/409), targeting (201/403/409), integrations (201/403/409), self-host (201/403/409), web-billing (201/403/409), ads-rewards (201/403/409), lifecycle-tools (201/403/409), stores (201/403/409), dashboard-ui (201/403/409), settings-auth (201/403/409), android (201), ios (201) | assistant-agent, assistant-security, assistant-stream, assistant-tools, v2-catalog, importer |
| DELETE | `/v2/projects/:project_id/products/:product_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog |
| GET | `/v2/projects/:project_id/products/:product_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-auth-extensions, v2-catalog |
| POST | `/v2/projects/:project_id/products/:product_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-catalog |
| POST | `/v2/projects/:project_id/products/:product_id/actions/archive` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | sdk, v2-auth-extensions, v2-catalog, importer |
| POST | `/v2/projects/:project_id/products/:product_id/actions/unarchive` | — | sdk, v2-catalog |
| POST | `/v2/projects/:project_id/products/:product_id/create_in_store` | — | store-ops, v2-remaining |

## /v2 purchase_links

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/purchase_links` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | redemption |
| POST | `/v2/projects/:project_id/purchase_links` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | web-billing, web-safety, redemption, v2-discounts |
| DELETE | `/v2/projects/:project_id/purchase_links/:link_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| GET | `/v2/projects/:project_id/purchase_links/:link_id` | — | web-billing |
| PATCH | `/v2/projects/:project_id/purchase_links/:link_id` | — | v2-discounts |

## /v2 purchases

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/purchases` | — | v2-auth-extensions, v2-customers |
| GET | `/v2/projects/:project_id/purchases/:purchase_id` | — | v2-auth-extensions, v2-customers |
| POST | `/v2/projects/:project_id/purchases/:purchase_id/actions/refund` | — | store-actions |
| GET | `/v2/projects/:project_id/purchases/:purchase_id/entitlements` | — | v2-customers |

## /v2 refund_control

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/refund_control` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | refund-control |
| POST | `/v2/projects/:project_id/refund_control` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | refund-control |
| GET | `/v2/projects/:project_id/refund_control/stats` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | refund-control |

## /v2 refund_requests

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/refund_requests` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | refund-control |

## /v2 retention_offers

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/retention_offers` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | retention |
| POST | `/v2/projects/:project_id/retention_offers` | onboarding (201/400), web-sdk (201/400), assistant (201/400), importer (201/400), lifecycle (201/400), identity (201/400), targeting (201/400), integrations (201/400), self-host (201/400), web-billing (201/400), ads-rewards (201/400), lifecycle-tools (201/400), stores (201/400), dashboard-ui (201/400), settings-auth (201/400), android (201/400), ios (201/400) | customer-center, retention, customer-center |
| DELETE | `/v2/projects/:project_id/retention_offers/:offer_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | customer-center |
| POST | `/v2/projects/:project_id/retention_offers/:offer_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | retention |

## /v2 saved_charts

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/saved_charts` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywall-builder |
| POST | `/v2/projects/:project_id/saved_charts` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | v2-paywall-builder |
| DELETE | `/v2/projects/:project_id/saved_charts/:saved_chart_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-paywall-builder |
| GET | `/v2/projects/:project_id/saved_charts/:saved_chart_id` | — | v2-paywall-builder |
| PATCH | `/v2/projects/:project_id/saved_charts/:saved_chart_id` | — | v2-paywall-builder |

## /v2 setup_health

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/setup_health` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200/401), ios (200/401) | amazon, setup-health, v2-auth-extensions |

## /v2 subscriptions

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/subscriptions` | — | v2-auth-extensions, v2-customers |
| GET | `/v2/projects/:project_id/subscriptions/:subscription_id` | — | v2-auth-extensions, v2-customers |
| POST | `/v2/projects/:project_id/subscriptions/:subscription_id/actions/cancel` | onboarding (422), web-sdk (422), assistant (422), importer (422), lifecycle (422), identity (422), targeting (422), integrations (422), self-host (422), web-billing (422), ads-rewards (422), lifecycle-tools (422), stores (422), dashboard-ui (422), settings-auth (422), android (422), ios (422) | store-actions |
| POST | `/v2/projects/:project_id/subscriptions/:subscription_id/actions/extend` | — | store-actions |
| POST | `/v2/projects/:project_id/subscriptions/:subscription_id/actions/refund` | — | store-actions |
| GET | `/v2/projects/:project_id/subscriptions/:subscription_id/authenticated_management_url` | — | v2-extras |
| GET | `/v2/projects/:project_id/subscriptions/:subscription_id/entitlements` | — | v2-customers |
| GET | `/v2/projects/:project_id/subscriptions/:subscription_id/transactions` | — | v2-customers |
| POST | `/v2/projects/:project_id/subscriptions/:subscription_id/transactions/:transaction_id/actions/refund` | — | store-actions |

## /v2 support_summaries

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/support_summaries` | onboarding (200/400), web-sdk (200/400), assistant (200/400), importer (200/400), lifecycle (200/400), identity (200/400), targeting (200/400), integrations (200/400), self-host (200/400), web-billing (200/400), ads-rewards (200/400), lifecycle-tools (200/400), stores (200/400), dashboard-ui (200/400), settings-auth (200/400), android (200/400), ios (200/400) | support |

## /v2 support_tickets

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/support_tickets` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | support |
| GET | `/v2/projects/:project_id/support_tickets/:ticket_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | support |
| POST | `/v2/projects/:project_id/support_tickets/:ticket_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | support |

## /v2 targeting_rules

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/targeting_rules` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/targeting_rules` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | v2-targeting |
| DELETE | `/v2/projects/:project_id/targeting_rules/:rule_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |
| GET | `/v2/projects/:project_id/targeting_rules/:rule_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/targeting_rules/:rule_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-targeting |
| POST | `/v2/projects/:project_id/targeting_rules/actions/reorder` | — | v2-targeting |

## /v2 test_purchases

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| POST | `/v2/projects/:project_id/test_purchases` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | ads, support, test-purchase-scenarios, test-store-web-price, v2-auth-extensions, webhook-payloads |

## /v2 transactions

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/transactions` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200/401), ios (200/401) | v2-auth-extensions |

## /v2 verified_metrics

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/verified_metrics` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |
| POST | `/v2/projects/:project_id/verified_metrics` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |
| POST | `/v2/projects/:project_id/verified_metrics/actions/publish` | onboarding (200/409), web-sdk (200/409), assistant (200/409), importer (200/409), lifecycle (200/409), identity (200/409), targeting (200/409), integrations (200/409), self-host (200/409), web-billing (200/409), ads-rewards (200/409), lifecycle-tools (200/409), stores (200/409), dashboard-ui (200/409), settings-auth (200/409), android (200/409), ios (200/409) | project-settings-tabs |
| POST | `/v2/projects/:project_id/verified_metrics/actions/unpublish` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |
| GET | `/v2/projects/:project_id/verified_metrics/slug_availability` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | project-settings-tabs |

## /v2 virtual_currencies

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/virtual_currencies` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-extras |
| POST | `/v2/projects/:project_id/virtual_currencies` | onboarding (201), web-sdk (201), assistant (201), importer (201), lifecycle (201), identity (201), targeting (201), integrations (201), self-host (201), web-billing (201), ads-rewards (201), lifecycle-tools (201), stores (201), dashboard-ui (201), settings-auth (201), android (201), ios (201) | ads, identity-auth, merge-currency, project-settings-tabs, sdk-endpoints, v2-extras, v2-remaining, webhook-payloads |
| DELETE | `/v2/projects/:project_id/virtual_currencies/:virtual_currency_code` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-extras |
| GET | `/v2/projects/:project_id/virtual_currencies/:virtual_currency_code` | — | v2-extras |
| POST | `/v2/projects/:project_id/virtual_currencies/:virtual_currency_code` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-extras |
| POST | `/v2/projects/:project_id/virtual_currencies/:virtual_currency_code/actions/archive` | — | v2-extras |
| POST | `/v2/projects/:project_id/virtual_currencies/:virtual_currency_code/actions/unarchive` | — | v2-extras |

## /v2 web

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/web` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | web-billing |

## /v2 web_discounts

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/web_discounts` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-discounts |

## /v2 web_domain

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/web_domain` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | funnel-ads, funnels, web-billing, web-safety, redemption, v2-discounts |
| PUT | `/v2/projects/:project_id/web_domain` | — | web-billing, web-safety |
| POST | `/v2/projects/:project_id/web_domain/actions/verify` | — | web-billing, web-safety |

## /v2 webhooks

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/webhooks` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | v2-catalog |
| GET | `/v2/projects/:project_id/webhooks/:webhook_id/deliveries` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | setup-endpoints, v2-auth-extensions |
| POST | `/v2/projects/:project_id/webhooks/:webhook_id/deliveries/:delivery_id/retry` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200) | v2-auth-extensions |

## /v2 winback_campaigns

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/v2/projects/:project_id/winback_campaigns` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | — |
| POST | `/v2/projects/:project_id/winback_campaigns` | onboarding (201/400), web-sdk (201/400), assistant (201/400), importer (201/400), lifecycle (201/400), identity (201/400), targeting (201/400), integrations (201/400), self-host (201/400), web-billing (201/400), ads-rewards (201/400), lifecycle-tools (201/400), stores (201/400), dashboard-ui (201/400), settings-auth (201/400), android (201/400), ios (201/400) | winback |
| DELETE | `/v2/projects/:project_id/winback_campaigns/:campaign_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback |
| GET | `/v2/projects/:project_id/winback_campaigns/:campaign_id` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | winback |
| POST | `/v2/projects/:project_id/winback_campaigns/:campaign_id` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback |
| POST | `/v2/projects/:project_id/winback_campaigns/:campaign_id/actions/preview` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback |
| POST | `/v2/projects/:project_id/winback_campaigns/:campaign_id/actions/run` | onboarding (200/422), web-sdk (200/422), assistant (200/422), importer (200/422), lifecycle (200/422), identity (200/422), targeting (200/422), integrations (200/422), self-host (200/422), web-billing (200/422), ads-rewards (200/422), lifecycle-tools (200/422), stores (200/422), dashboard-ui (200/422), settings-auth (200/422), android (200/422), ios (200/422) | winback |
| POST | `/v2/projects/:project_id/winback_campaigns/:campaign_id/actions/send_test` | onboarding (200), web-sdk (200), assistant (200), importer (200), lifecycle (200), identity (200), targeting (200), integrations (200), self-host (200), web-billing (200), ads-rewards (200), lifecycle-tools (200), stores (200), dashboard-ui (200), settings-auth (200), android (200), ios (200) | winback |

## /verified

| Method | Path | Journeys (statuses) | Tests |
|---|---|---|---|
| GET | `/verified/:slug` | onboarding (200/304/404), web-sdk (200/304/404), assistant (200/304/404), importer (200/304/404), lifecycle (200/304/404), identity (200/304/404), targeting (200/304/404), integrations (200/304/404), self-host (200/304/404), web-billing (200/304/404), ads-rewards (200/304/404), lifecycle-tools (200/304/404), stores (200/304/404), dashboard-ui (200/304/404), settings-auth (200/304/404), android (200/304/404), ios (200/304/404) | project-settings-tabs |
| GET | `/verified/:slug/icon` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | project-settings-tabs |
| GET | `/verified/:slug/metrics.json` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | project-settings-tabs |
| GET | `/verified/:slug/og.png` | onboarding (200/404), web-sdk (200/404), assistant (200/404), importer (200/404), lifecycle (200/404), identity (200/404), targeting (200/404), integrations (200/404), self-host (200/404), web-billing (200/404), ads-rewards (200/404), lifecycle-tools (200/404), stores (200/404), dashboard-ui (200/404), settings-auth (200/404), android (200/404), ios (200/404) | project-settings-tabs |
