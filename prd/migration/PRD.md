# Migration from RevenueCat (scope 1.9)

**Goal:** a team on RevenueCat moves one project to RevenueDot in an afternoon, and no customer loses access on switch day.

## What ships
- **`npx revenuedot import`** (`packages/importer`, MIT). Reads RevenueCat's REST API v2 with the customer's own read-only secret key and writes to RevenueDot's REST API. Catalog first (apps, production SDK keys, products, entitlements with attachments, offerings with metadata and the current flag, packages with attachments), then customers page by page (customer, aliases, attributes, subscriptions with their store transactions, purchases). Resumable through a state file; idempotent, so a re-run is also the incremental sync during the dual run. `--dry-run`, progress output, final report with counts and problems. Handles 429 with `Retry-After`, retries 5xx.
- **`revenuedot import verify`** compares, per customer, active entitlements (by lookup key) with their expiry and the number of subscriptions giving access, plus totals.
- **`revenuedot import plan`** prints the cutover steps with the project's own app ids and URLs.
- **`POST /v2/projects/{id}/import/customers`** (RevenueDot extension, `apps/server/src/routes/v2/import.ts`): up to 100 RevenueCat-shaped customers per call. Writes state directly, no events and no webhooks unless `emit_events: true`. Keeps first-seen, original purchase dates and store transaction ids. Keys chains like the store adapters do (Apple `original_transaction_id`, Google purchase token), so a later receipt post or notification updates the imported row. Merges existing customers across the imported aliases. Marks already-ended subscriptions as expired so the expiration job sends nothing for old history.
- `POST /v2/projects/{id}/import/apps/{app_id}/public_key` keeps shipped SDK keys; `GET /v2/projects/{id}/import/status` counts what still needs a Google token.

## Store identifiers
- **Apple:** RevenueCat exposes the latest transaction id and the subscription's transactions. The importer sends the earliest transaction as the chain key; when the app's In-App Purchase key is set, the server confirms `original_transaction_id` with Apple's Get Transaction Info (this matters for resubscribes after a lapse, which RevenueCat splits into a new subscription).
- **Google:** RevenueCat exposes order ids, not purchase tokens. Tokens come from `--google-tokens` (a support export), from `orders.batchGet` with the app's service account (server side, on import), or later from renewal notifications and one `syncPurchases()`. Until then the chain key is `needs_token_refresh:<order id>`; a re-run with a token upgrades it in place.

## Not in scope yet
Targeting rules, experiments, paywalls, integrations other than webhooks, virtual currency balances, RevenueCat Billing renewals (access is imported; renewals stay with RevenueCat). Subscription refunds are not exposed by RevenueCat's v2 subscription object, so a refunded subscription imports as expired.
