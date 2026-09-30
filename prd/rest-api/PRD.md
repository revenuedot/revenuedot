# REST API (scope 1.8)

**Status:** The v1 secret-key endpoints and API v2 are live. API v2 covers projects, apps, products, entitlements, offerings, packages, customers, subscriptions (including `GET .../subscriptions/{id}/transactions`), purchases, webhook integrations and metrics. It uses RevenueCat's shapes, pagination and errors, and adds dashboard extensions. Store actions reach Google and Apple, but only mocked stores have been tested.

## Users and jobs
- **Backend developers** point existing RevenueCat server code at a new base URL and keep their secret-key calls.
- **Support tools** look up a customer, grant access, refund or extend a subscription, or move a customer to another offering.
- **The dashboard and the MCP server** use the same v2 API, with a session cookie or an OAuth-issued key.

## Essential now and later
Essential (Tier 1)
- The v1 secret-key endpoints for customers, promotional access, offering overrides and store actions.
- v2 reads and writes for the catalog and customers, with key permissions, project isolation, `starting_after` and `limit` pagination, and RevenueCat's error body.
- Store actions: Google revoke, cancel, defer and order refund, and Apple extend and mass extend.

Later
- The rest of RevenueCat's v2 surface for features RevenueDot does not have, such as paywalls, experiments and virtual currencies.

## RevenueCat behaviour we match
- v2 sends lists as `{ object: "list", items, next_page, url }`, clamps `limit` to 1 to 100 with a default of 20, and returns errors as `{ object: "error", type, message, param, doc_url, retryable }` (https://www.revenuecat.com/docs/api-v2).
- Permissions follow RevenueCat's names, such as `customer_information:subscriptions:read`. `read_write` implies `read`. Another project's ID answers 404 (https://www.revenuecat.com/docs/api-v2).
- Subscription transactions list one item per store order. They can be sorted by `id` or `purchased_at`, in either direction. A refunded order's `effective_expiration_date` is the refund time (https://www.revenuecat.com/docs/api-v2).
- The v1 store actions answer RevenueCat's codes: 7259 for an unknown subscription, 7000 for an action the store does not offer, 7226 for bad parameters, and 7101 when the store refuses (400) or cannot be reached (503) (https://www.revenuecat.com/docs/api-v1).
- Where the OpenAPI file is present, responses are checked against RevenueCat's published OpenAPI v2 response schemas (`packages/contract/src/openapi.ts`).

## Endpoints and screens
v1, secret key only (`apps/server/src/routes/rest-v1.ts`, on top of the SDK routes in `prd/sdk-api/PRD.md`):
- `DELETE /v1/subscribers/{id}`, `POST .../entitlements/{ent}/promotional`, `POST .../entitlements/{ent}/revoke_promotionals`, `POST .../offerings/{offering}/override` and `DELETE .../offerings/override`.
- `POST .../subscriptions/{product}/revoke` (Play), `POST .../subscriptions/{product}/defer` (Play), `POST .../transactions/{id}/refund` (Play), `POST .../subscriptions/{id}/cancel` (Play) and `POST .../subscriptions/{id}/extend` (App Store).

v2, under `/v2/projects/{project_id}` (`apps/server/src/routes/v2/`):
- `GET`, `POST /v2/projects`. Apps: list, create, get, update, delete, and `public_api_keys`. Products: list, create, get, update, delete, archive and unarchive. Entitlements: list, create, get, update, delete, archive and unarchive, `products`, and attach or detach products. Offerings: list, create, get, update, delete, archive and unarchive, and `packages`. Packages: get, update, delete, `products`, and attach or detach products.
- Customers: list and search, create, get, delete, `aliases`, `attributes` (get and set), `active_entitlements`, `subscriptions`, `purchases`, `events`, and the actions `grant_entitlement`, `revoke_granted_entitlement` and `assign_offering`.
- Subscriptions: lookup by `store_subscription_identifier`, get, `entitlements` and `transactions`, the actions `cancel`, `refund` and `extend`, and `transactions/{id}/actions/refund`. Purchases: lookup by `store_purchase_identifier`, get, `entitlements` and `actions/refund`.
- `integrations/webhooks` (CRUD), `GET metrics/overview` and `GET collaborators`.
- RevenueDot extensions: `GET`, `POST` and `DELETE /v2/projects/{id}`, `transactions`, `events`, webhook `deliveries` and `retry`, `setup_health`, `api_keys`, `test_purchases`, `metrics/history`, `customer_summaries`, app `store_settings`, `verify_credentials`, `mass_extend` and `mass_extensions/{id}`, webhook `test`, and `import/*` (`prd/migration/PRD.md`).
- Dashboard: API keys at `/projects/:projectId/api-keys`. The customer page shows grant, revoke and offering override.

## Tests that prove it
- `packages/contract/test/v2-catalog.test.ts` (14 tests) covers projects, apps, products, entitlements, offerings, packages, webhook integrations, pagination, and the schema check of every catalog operation.
- `packages/contract/test/v2-customers.test.ts` (11 tests) covers customers, search, aliases, attributes, subscription transactions (sorting, paging, 404 and 400), subscriptions and purchases, promotional grants, offering overrides, metrics, and the schema check of every customer operation.
- `packages/contract/test/v2-auth-extensions.test.ts` (12 tests) covers 401 and 403, permissions, the error format, the session cookie, cross-project isolation and each extension.
- `packages/contract/test/v2-project-settings.test.ts`, `v2-dashboard-overview.test.ts` and `test-purchase-scenarios.test.ts` cover settings, metric history and the Test Store scenarios.
- `packages/contract/test/rest-webhooks.test.ts` ("REST API v1", 7 tests) covers public keys refused, attributes only for secret keys, promotional access, overrides and deletes.
- `apps/server/test/store-actions.test.ts` (10 tests) covers every v1 and v2 store action against mocked Google and Apple.

## Known gaps
- Store actions are tested against mocked Google and Apple only. The Google `revoke`, `cancel` and `defer` request bodies need one real sandbox run.
- Cancel and refund work only for Google Play. App Store subscriptions answer 422 in v2, and App Store refunds go through Apple.
- The OpenAPI schema checks need RevenueCat's spec file, which is not in this repo. Without it, for example in public CI, those tests pass without checking anything.
