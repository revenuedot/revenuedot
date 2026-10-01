# REST API (scope 1.8)

**Status:** The v1 secret-key endpoints and API v2 are live. RevenueCat's v2 spec has 128 operations and every one has a route: 116 do the real work, and the 12 that exist only for RevenueCat Billing (discounts and invoices) answer with deliberate, schema-valid RevenueCat responses that say why (branch `tier2-v2-events`, 2026-10-01). It uses RevenueCat's shapes, pagination and errors, and adds dashboard extensions. Store actions reach Google and Apple, but only mocked stores have been tested.

## Users and jobs
- **Backend developers** point existing RevenueCat server code at a new base URL and keep their secret-key calls.
- **Support tools** look up a customer, grant access, refund or extend a subscription, or move a customer to another offering.
- **The dashboard and the MCP server** use the same v2 API, with a session cookie or an OAuth-issued key.

## Essential now and later
Essential (Tier 1)
- The v1 secret-key endpoints for customers, promotional access, offering overrides and store actions.
- v2 reads and writes for the catalog and customers, with key permissions, project isolation, `starting_after` and `limit` pagination, and RevenueCat's error body.
- Store actions: Google revoke, cancel, defer and order refund, and Apple extend and mass extend.

Tier 2 (this change, the last 15 operations)
- `POST .../customers/{customer_id}/actions/restore_purchase_by_order_id`: finds a store purchase by its order id and gives it to the customer.
- `POST .../products/{product_id}/create_in_store`: creates the product in App Store Connect (RevenueCat's operation) and, as an extension, a subscription in Google Play.
- `POST .../apps/{app_id}/authenticate`: a short-lived subscriber access token, accepted by the SDK endpoints (`prd/sdk-api/PRD.md`, IAM rows).
- Discounts (10 operations) and invoices (2): excluded by the scope rule, answered on purpose (below).

Later
- Nothing left in RevenueCat's v2 spec. RevenueCat Billing itself (a billing engine with invoices, tax and discount codes) is not planned; Stripe Billing on the customer's own account is the web path (`prd/store-stripe/PRD.md`, PR #3).

## RevenueCat behaviour we match
- v2 sends lists as `{ object: "list", items, next_page, url }`, clamps `limit` to 1 to 100 with a default of 20, and returns errors as `{ object: "error", type, message, param, doc_url, retryable }` (https://www.revenuecat.com/docs/api-v2).
- Permissions follow RevenueCat's names, such as `customer_information:subscriptions:read`. `read_write` implies `read`. Another project's ID answers 404 (https://www.revenuecat.com/docs/api-v2).
- Subscription transactions list one item per store order. They can be sorted by `id` or `purchased_at`, in either direction. A refunded order's `effective_expiration_date` is the refund time (https://www.revenuecat.com/docs/api-v2).
- The v1 store actions answer RevenueCat's codes: 7259 for an unknown subscription, 7000 for an action the store does not offer, 7226 for bad parameters, and 7101 when the store refuses (400) or cannot be reached (503) (https://www.revenuecat.com/docs/api-v1).
- Where the OpenAPI file is present, responses are checked against RevenueCat's published OpenAPI v2 response schemas (`packages/contract/src/openapi.ts`).

## The last 15 operations
**Restore a purchase by order id** (`customer_information:customers:read_write`). RevenueCat's operation is Google Play only; RevenueDot also accepts an App Store order id (the id on the customer's Apple receipt email).
- A Google order id (`GPA.…`, renewal suffixes `..0`, `..1` included) goes to `orders.batchGet` on each Play app of the project that has a service account, the same call the importer uses. The order's purchase token is verified like a device receipt (`subscriptionsv2` or `products`), and the purchase is applied.
- Any other id goes to Apple's Look Up Order ID (`GET /inApps/v1/lookup/{orderId}`, production then sandbox) on each App Store app with an In-App Purchase key. Status 0 returns signed transactions; the first one fetches the full history and renewal state, as a receipt post does.
- The purchase goes to the customer under the project's transfer behaviour, like a restore from the device: a purchase owned by an anonymous customer merges, one owned by another identified customer moves (`TRANSFER`), and with "keep" the answer is 409 `resource_already_exists`.
- Answers: 200 with the customer object. 404 `resource_missing` (param `order_id`) when no store knows the order, 404 for an unknown customer, 422 `unprocessable_entity_error` when no app has the store credentials the lookup needs, 503 `store_error` (retryable) when the store cannot be reached.

**Create a product in the store** (`project_configuration:products:read_write`).
- App Store and Mac App Store products, with the app's App Store Connect API key (`app_store_connect_api_key`, `_id`, `_issuer`, the key RevenueCat asks for to import products). The app is found by bundle id (`GET /v1/apps?filter[bundleId]=`). A subscription needs `store_information` with `duration` (`ONE_WEEK` … `ONE_YEAR`) and `subscription_group_name`, or `subscription_group_id`; the group is reused by reference name, else created (`POST /v1/subscriptionGroups`), then `POST /v1/subscriptions`. Consumables, non-consumables and non-renewing subscriptions need no body (`POST /v2/inAppPurchases`). The App Store name is the product's display name, else its identifier.
- Google Play subscriptions (extension): `monetization.subscriptions.create` with one listing (title = display name) in the app's default language, read from an edit (`edits.insert`, `edits.details.get`, `edits.delete`). Base plans and prices are added in Play Console, because the request carries no price. Play one-time products answer 422: Google needs a price to create them.
- Answers: 201 `{ created_product: { object: "store_product", id, name, product_identifier } }`. 422 `unprocessable_entity_error` without the key (the message names the fields), for other stores, and for a subscription without `store_information`; 409 `resource_already_exists` when the store already has the product id; 503 `store_error` when the store is down; 400 `parameter_error` for a bad body. A product created in the store is not marked anywhere else: the catalog row already exists.

**Authenticate a subscriber** (`iam:authorization:issue_token`). Body `{ app_user_id }` (1 to 100 characters, the SDK's limit). Answers 200 `{ object: "authentication", access_token, expires_at }`. The token starts with `rdat_`, lives one hour, is stored only as a SHA-256 hash (`subscriber_tokens`, migration 0015), is bound to the app and the app user id, and cannot be refreshed. 404 for an app outside the project. RevenueCat does not publish the lifetime; one hour is ours.

**Discounts and invoices (12 operations) are excluded.** RevenueCat's spec says each discount operation acts on "RevenueCat Billing discounts", and invoices are issued by RevenueCat Billing (its data model: `Customer ──< Invoice` "RevenueCat Billing"). That is the billing engine RevenueCat runs for web checkout, which RevenueDot does not have; the scope rule leaves them out. They are routed anyway, so a client never sees an unknown-route 404, and every answer is valid against RevenueCat's schema for that operation:
- Writes (`POST` and `DELETE /discounts`, `PATCH`, `actions/enable`, `actions/disable`, `POST` and `DELETE` discount codes): 422 `unprocessable_entity_error`, not retryable, with the message "Discounts are part of RevenueCat Billing (Web Billing), which RevenueDot does not have." 422 is the documented answer for a valid request the server cannot carry out.
- Reads: `GET /discounts` and `GET .../customers/{id}/invoices` return an empty list, which is true. `GET /discounts/{id}`, `GET /discounts/{id}/discount_codes` and `GET .../invoices/{id}/file` answer 404 `resource_missing` with the same explanation in the message. RevenueCat declares no 422 for these reads, so a 422 there would break the contract.
- Permissions are checked first (`project_configuration:discounts:*`, `customer_information:invoices:read`), so a key without them still gets 403.

## Endpoints and screens
v1, secret key only (`apps/server/src/routes/rest-v1.ts`, on top of the SDK routes in `prd/sdk-api/PRD.md`):
- `DELETE /v1/subscribers/{id}`, `POST .../entitlements/{ent}/promotional`, `POST .../entitlements/{ent}/revoke_promotionals`, `POST .../offerings/{offering}/override` and `DELETE .../offerings/override`.
- `POST .../subscriptions/{product}/revoke` (Play), `POST .../subscriptions/{product}/defer` (Play), `POST .../transactions/{id}/refund` (Play), `POST .../subscriptions/{id}/cancel` (Play) and `POST .../subscriptions/{id}/extend` (App Store).

v2, under `/v2/projects/{project_id}` (`apps/server/src/routes/v2/`):
- `GET`, `POST /v2/projects`. Apps: list, create, get, update, delete, and `public_api_keys`. Products: list, create, get, update, delete, archive and unarchive. Entitlements: list, create, get, update, delete, archive and unarchive, `products`, and attach or detach products. Offerings: list, create, get, update, delete, archive and unarchive, and `packages`. Packages: get, update, delete, `products`, and attach or detach products.
- Customers: list and search, create, get, delete, `aliases`, `attributes` (get and set), `active_entitlements`, `subscriptions`, `purchases`, `events`, `invoices` (always empty), and the actions `grant_entitlement`, `revoke_granted_entitlement`, `assign_offering` and `restore_purchase_by_order_id`.
- Products: `create_in_store`. Apps: `authenticate`. Discounts and discount codes (excluded, see above).
- Subscriptions: lookup by `store_subscription_identifier`, get, `entitlements` and `transactions`, the actions `cancel`, `refund` and `extend`, and `transactions/{id}/actions/refund`. Purchases: lookup by `store_purchase_identifier`, get, `entitlements` and `actions/refund`.
- `integrations/webhooks` (CRUD), `GET metrics/overview` and `GET collaborators`.
- RevenueDot extensions: `GET .../customers/{id}/win_back_offers` (`prd/win-back-offers/PRD.md`), `GET`, `POST` and `DELETE /v2/projects/{id}`, `transactions`, `events`, webhook `deliveries` and `retry`, `setup_health`, `api_keys`, `test_purchases`, `metrics/history`, `customer_summaries`, app `store_settings`, `verify_credentials`, `mass_extend` and `mass_extensions/{id}`, webhook `test`, and `import/*` (`prd/migration/PRD.md`).
- Dashboard: API keys at `/projects/:projectId/api-keys`. The customer page shows grant, revoke and offering override.

## Tests that prove it
- `packages/contract/test/v2-catalog.test.ts` (14 tests) covers projects, apps, products, entitlements, offerings, packages, webhook integrations, pagination, and the schema check of every catalog operation.
- `packages/contract/test/v2-customers.test.ts` (11 tests) covers customers, search, aliases, attributes, subscription transactions (sorting, paging, 404 and 400), subscriptions and purchases, promotional grants, offering overrides, metrics, and the schema check of every customer operation.
- `packages/contract/test/v2-auth-extensions.test.ts` (12 tests) covers 401 and 403, permissions, the error format, the session cookie, cross-project isolation and each extension.
- `packages/contract/test/v2-project-settings.test.ts`, `v2-dashboard-overview.test.ts` and `test-purchase-scenarios.test.ts` cover settings, metric history and the Test Store scenarios.
- `packages/contract/test/rest-webhooks.test.ts` ("REST API v1", 7 tests) covers public keys refused, attributes only for secret keys, promotional access, overrides and deletes.
- `apps/server/test/store-actions.test.ts` (10 tests) covers every v1 and v2 store action against mocked Google and Apple.
- `packages/contract/test/v2-remaining.test.ts` covers the last 15 operations against fake Google, Apple and App Store Connect servers: restore by Google and Apple order id (customer object, transfer, 404, 422, 503), create in App Store Connect (subscription with a new and an existing group, consumable, 409, 422 without the key) and in Play, subscriber tokens (issue, use on the SDK endpoints, expiry, wrong user), and the 12 Billing operations (status, body and the 403 for a key without the scope), each validated against RevenueCat's schema.

## Known gaps
- Restore by order id and create in store are tested against fake stores only. Apple's Look Up Order ID, App Store Connect's subscription and in-app purchase creation, and Play's `monetization.subscriptions.create` need one real run each.
- Store actions are tested against mocked Google and Apple only. The Google `revoke`, `cancel` and `defer` request bodies need one real sandbox run.
- Cancel and refund work only for Google Play. App Store subscriptions answer 422 in v2, and App Store refunds go through Apple.
- The OpenAPI schema checks need RevenueCat's spec file, which is not in this repo. Without it, for example in public CI, those tests pass without checking anything.
