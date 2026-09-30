# Customers (scope 1.8 and 1.10)

**Status:** The customer list, exact search and the customer page with history, grants, attributes, offering override and delete work in the dashboard and through the REST API, and the browser tests drive each of them.

## Users and jobs
- **A support person** finds a customer from an email, an app user id or a store receipt, sees what they paid for and what access they have, and grants access by hand when something went wrong.
- **A developer** debugging a purchase reads the customer's event history with the raw event body.
- **A backend** reads and changes customers through the REST API with a secret key, the same way it did with RevenueCat.

## Essential now and later
Essential (Tier 1)
- A list of customers, newest first by first seen, 25 per page, with revenue and active entitlement names per row.
- Exact search by app user id or alias, `$email` attribute, or a store transaction or purchase id; the same search from the top bar.
- A customer page: aliases, active entitlements with where each one came from, subscriptions, one-time purchases, total spent in USD, attributes, and the event history newest first.
- Grant an entitlement for a chosen time (1 day to lifetime) and revoke the grant.
- Set an attribute, set or clear an offering override, and delete the customer after typing DELETE.

Later
- Customer lists and filters by entitlement, country, store or attribute, and CSV export.
- Notes on a customer, and transferring purchases to another customer.
- Store actions (refund, cancel, extend, defer) on the customer page; the API already has them.
- Experiment enrollment and in-app currency balances (Tier 2).

## RevenueCat behaviour we match
- The customer id is the app user id, and any alias finds the same customer ([App user IDs](https://www.revenuecat.com/docs/customers/user-ids), operations `get-customer`, `list-customer-aliases`).
- Search matches whole values only: app user id, email or store transaction id (operation `list-customers`).
- The customer page shows entitlements, purchases, attributes and a history of events ([Customer profile](https://www.revenuecat.com/docs/dashboard-and-metrics/customer-profile), [Customer history](https://www.revenuecat.com/docs/dashboard-and-metrics/customer-history), operation `list-customer-events`).
- Attributes are key-value pairs with reserved `$` keys such as `$email` ([Customer attributes](https://www.revenuecat.com/docs/customers/customer-attributes), operations `set-customer-attributes`, `list-customer-attributes`).
- Granted access is a promotional subscription with store `promotional`, and a second grant with an expiry within two hours of an existing one is ignored ([Granting promotional access](https://www.revenuecat.com/docs/dashboard-and-metrics/customer-history/promotionals), operations `grant-customer-entitlement`, `revoke-customer-granted-entitlement`, v1 `grant-a-promotional-entitlement`).
- An offering override changes `current_offering_id` for that customer only (operations `assign-customer-offering`, `override-offering`, `delete-offering-override`).
- Every v2 customer response is validated against RevenueCat's OpenAPI v2 response schemas.

## Endpoints and screens
API v2 under `/v2/projects/{project_id}` (`apps/server/src/routes/v2/customers.ts`):
- `GET /customers` (`?search=`, `limit`, `starting_after`), `POST /customers`, `GET, DELETE /customers/{id}` (`?expand=attributes`).
- `GET /customers/{id}/aliases`, `/attributes`, `/active_entitlements`, `/subscriptions`, `/purchases`, `/events`; `POST /customers/{id}/attributes`.
- `POST /customers/{id}/actions/grant_entitlement`, `/revoke_granted_entitlement`, `/assign_offering`.
- `GET /subscriptions`, `/subscriptions/{id}`, `/subscriptions/{id}/entitlements`, `/subscriptions/{id}/transactions`; `GET /purchases`, `/purchases/{id}`, `/purchases/{id}/entitlements`.
- RevenueDot extension: `GET /customer_summaries?ids=a,b` (revenue, entitlement sources, prices, override) for the dashboard rows.

API v1 (`apps/server/src/routes/rest-v1.ts`, secret key): `DELETE /v1/subscribers/{id}`, `POST /v1/subscribers/{id}/entitlements/{ent}/promotional`, `/revoke_promotionals`, `POST /v1/subscribers/{id}/offerings/{offering}/override`, `DELETE /v1/subscribers/{id}/offerings/override`.

Dashboard: `/projects/:projectId/customers` (`pages/Customers.tsx`, `?q=` and `?after=` in the URL) and `/projects/:projectId/customers/:appUserId` (`pages/CustomerDetail.tsx`).

## Tests that prove it
- `packages/contract/test/v2-customers.test.ts`: create with attributes and reject duplicates, anonymous ids as path ids, newest-first pagination and search by id, alias, email and transaction id, aliases and attributes, subscription transactions, subscriptions and purchases, grant and revoke with the two-hour rule, offering override, OpenAPI coverage.
- `packages/contract/test/v2-dashboard-overview.test.ts` ("customer summaries"): revenue, entitlement sources, grants, override and prices.
- `packages/contract/test/rest-webhooks.test.ts`: v1 promotional grants and revoke, lifetime grants, override for one customer only, subscriber delete.
- `apps/dashboard/e2e/overview-customers.spec.ts`: list, pagination, exact search and top-bar search; the customer page's history labels, grant and revoke, override, attribute, delete; phone width at 390px.

## Known gaps
- Search is exact only; there are no filters or saved lists.
- The page has no notes, no purchase transfer and no store action buttons, although the API has refund, cancel and extend.
- Each event shows its raw body, not which integrations it was sent to.
- Total spent is in USD only.
