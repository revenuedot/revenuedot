# Migration from RevenueCat (scope 1.9)

**Goal:** a team on RevenueCat moves one project to RevenueDot in an afternoon, and no customer loses access on switch day.

## What ships
- **`npx revenuedot import`** (`packages/importer`, MIT). Reads RevenueCat's REST API v2 with the customer's own read-only secret key and writes to RevenueDot's REST API. Catalog first (apps, production SDK keys, products, entitlements with attachments, offerings with metadata and the current flag, packages with attachments), then customers page by page (customer, aliases, attributes, subscriptions with their store transactions, purchases). Resumable through a state file; idempotent, so a re-run is also the incremental sync during the dual run. `--dry-run`, progress output, final report with counts and problems. Handles 429 with `Retry-After`, retries 5xx. Pages of 50 customers by default (`--page-size`, at most 100).
- **`revenuedot import verify`** compares, per customer, active entitlements (by lookup key) with their expiry and the number of subscriptions giving access, plus totals.
- **`revenuedot import plan`** prints the cutover steps with the project's own app ids and URLs.
- **`POST /v2/projects/{id}/import/customers`** (RevenueDot extension, `apps/server/src/routes/v2/import.ts`): up to 100 RevenueCat-shaped customers per call. Writes state directly, no events and no webhooks unless `emit_events: true`. Keeps first-seen, original purchase dates and store transaction ids. Keys chains like the store adapters do (Apple `original_transaction_id`, Google purchase token), so a later receipt post or notification updates the imported row. Merges existing customers across the imported aliases. Marks already-ended subscriptions as expired so the expiration job sends nothing for old history.
- `POST /v2/projects/{id}/import/apps/{app_id}/public_key` keeps shipped SDK keys; `GET /v2/projects/{id}/import/status` counts what still needs a Google token.

## Speed
Every SQL statement is one network round trip, and on Cloud each one goes Worker → Hyperdrive → Railway Postgres (about 20 to 25 ms). The endpoint first wrote row by row: about 29 statements per customer (alias and attribute lookups, one insert per attribute, alias, subscription and store transaction, one transaction per customer), so a page of 100 took 73 s on the development database and timed out the CLI (60 s) on Cloud; 0.5 s per customer means more than a day for 200,000 customers.

Since 2026-10-02 a page is written in a fixed number of statements (`apps/server/src/routes/v2/import-page.ts`): load everything the page can touch in 3 to 5 queries (aliases with their customers, attributes, subscriptions by chain key and by customer, one-time purchases), apply the import rules to each customer in order in memory, then write one multi-row `INSERT … ON CONFLICT` per table, all in one transaction per page. A merge of existing customers and `emit_events` still run in SQL: the working set is written first and loaded again after, so each customer sees exactly what the ones before it wrote. Apple lookups (with the In-App Purchase key) run six at a time. The result is row-for-row the same as the old code on the same input (compared on the development database; only generated ids differ).

| Page (development Postgres, 18 ms round trip; `scripts/bench/import-page.ts`) | Before | After |
|---|---|---|
| 100 new customers (133 aliases, 609 attributes, 75 subscriptions, 396 transactions, 6 purchases) | 73.2 s, 2,911 statements | 0.6 s, 19 statements |
| The same 100 again (nothing changes) | 73.7 s, 2,976 | 0.5 s, 15 |
| 100 customers, 10 already seen by the app, 5 merged | 73.8 s, 2,948 | 3.9 s, 146 |
| 25 new customers | 16.8 s, 652 | 0.5 s, 18 |

A merge still costs about 25 statements (the shared `mergeCustomers` plus a reload), roughly 0.6 s each. The CLI (0.2.1) reads pages of 50 by default (`--page-size`, at most 100), tries a timed-out page once more, then stops with the advice to rerun with a smaller `--page-size`; the state file resumes at that page.

Validation: journey `import` (`scripts/e2e/journeys/import.ts`) on the real Node server and a fresh Railway development database, 45 checks: a page of 100 in 0.5 to 0.8 s with every row checked in SQL and entitlements read through the SDK wire calls, the re-run with no row changed, the merge page, and the real `revenuedot import` CLI against the fake RevenueCat (126 customers, pages of 50, `import verify`, a second full run that creates nobody).

## Store identifiers
- **Apple:** RevenueCat exposes the latest transaction id and the subscription's transactions. The importer sends the earliest transaction as the chain key; when the app's In-App Purchase key is set, the server confirms `original_transaction_id` with Apple's Get Transaction Info (this matters for resubscribes after a lapse, which RevenueCat splits into a new subscription).
  Without the key, the row keeps `original_transaction_id` null (a guessed key). When the store later proves the real original id (a receipt post or an App Store notification), the imported row takes it: matched by any transaction id the store proves, by the imported transaction history, or, for the same customer and product, as the later half of a split chain. Two halves fold into one row with no events. A re-run of the import finds a re-keyed chain again by its transactions (`apps/server/src/services/imported-chains.ts`, tests in `apps/server/test/import.test.ts`).
- **Google:** RevenueCat exposes order ids, not purchase tokens. Tokens come from `--google-tokens` (a support export), from `orders.batchGet` with the app's service account (server side, on import), or later from renewal notifications and one `syncPurchases()`. Until then the chain key is `needs_token_refresh:<order id>`; a re-run with a token upgrades it in place. A token that arrives first through the device (`POST /v1/receipts`) or a real-time notification also takes over the placeholder row, matched by `latestOrderId` or the base order id; an upgrade whose `linkedPurchaseToken` is the imported purchase keys the old row by that token (Google's order ids for it come from `subscriptionsv2.get`) and ends it with PRODUCT_CHANGE. No second row and no false INITIAL_PURCHASE.

## Not in scope yet
Targeting rules, experiments, paywalls, integrations other than webhooks, virtual currency balances, RevenueCat Billing renewals (access is imported; renewals stay with RevenueCat). Subscription refunds are not exposed by RevenueCat's v2 subscription object, so a refunded subscription imports as expired.
