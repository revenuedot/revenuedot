# Entitlement engine and identity (scope 1.4 and 1.5)

**Status:** Access follows RevenueCat's rules for grace periods, billing retry, pauses, refunds, product changes, lifetime unlocks, consumables and promotional grants. Anonymous IDs, `logIn`, aliases, merges and all four transfer settings work, and the default setting is RevenueCat's.

## Users and jobs
- **App developers** ask one question, "is this entitlement active?", and get the same answer RevenueCat would give.
- **End users** keep what they paid for when they log in, reinstall, restore on a new device or share a family plan.
- **Support staff** grant or revoke promotional access without a store purchase.

## Essential now and later
Essential (Tier 1)
- Compute entitlements from purchases and the catalog, as a pure function in `packages/core`.
- Turn a change to one purchase into RevenueCat's event names.
- Implement `logIn` and alias merge rules and the four "restore belongs to whom" settings, with a separate setting for sandbox.

Later
- Events that need features RevenueDot does not have yet: TEMPORARY_ENTITLEMENT_GRANT, INVOICE_ISSUANCE, PURCHASE_REDEEMED, VIRTUAL_CURRENCY_TRANSACTION, EXPERIMENT_ENROLLMENT and SUBSCRIBER_ALIAS. They are accepted as webhook filters but never sent.

## RevenueCat behaviour we match
- Customer info lists every entitlement a purchase ever unlocked, active or expired. A lifetime unlock wins, and otherwise the purchase whose access ends last wins (https://www.revenuecat.com/docs/getting-started/entitlements).
- Access ends at the refund time for a refund, at the grace end during a grace period, and otherwise at the store expiry (https://www.revenuecat.com/docs/subscription-guidance/how-grace-periods-work).
- A lapsed customer who resubscribes gets RENEWAL, not INITIAL_PURCHASE. The first paid period after a free trial is flagged as a trial conversion. Recovering a failed payment is RENEWAL, not UNCANCELLATION (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
- A promotional grant within 2 hours of an existing one for the same entitlement counts as a duplicate (https://www.revenuecat.com/docs/api-v1).
- Anonymous IDs start with `$RCAnonymousID:`. Logging an anonymous user into a new ID aliases the two IDs. Logging into an existing ID merges the anonymous customer, unless that customer already has an anonymous alias (https://www.revenuecat.com/docs/customers/identifying-customers).
- Transfer settings: transfer (the default), transfer only when the old owner has no active subscription, keep with the original ID (error 7102), and share (legacy merge). A transfer records a TRANSFER event with `transferred_from` and `transferred_to` (https://www.revenuecat.com/docs/projects/restore-behavior).
- Store notifications never transfer ownership. Only receipt posts from a device do.

## Endpoints and screens
- Pure logic: `packages/core/src/entitlements.ts` (`computeEntitlements`, `accessEndsAt`, `willRenew`), `events.ts` (`diffSubscription`, `diffNonSubscription`) and `customer-info.ts`.
- Applying purchases and ownership: `apps/server/src/services/purchases.ts`. Identity: `apps/server/src/repo/customers.ts` (`identify`, `mergeCustomers`).
- SDK: `POST /v1/subscribers/identify` and `POST /v1/subscribers/{id}/alias`.
- Promotional access: `POST /v1/subscribers/{id}/entitlements/{ent}/promotional`, `.../revoke_promotionals`, and v2 `POST .../customers/{id}/actions/grant_entitlement` and `revoke_granted_entitlement`.
- Settings: `GET` and `POST /v2/projects/{id}` read and set `transfer_behavior` and `sandbox_transfer_behavior`.
- Dashboard: the customer page `/projects/:projectId/customers/:appUserId` (grant and revoke) and Project settings (transfer setting).

## Tests that prove it
- `packages/core/test/events.test.ts` (2 tests) covers trial conversion.
- `packages/contract/test/sdk.test.ts`, "ownership and transfers" (4 tests), covers an anonymous purchase following `logIn`, the 200 for an existing user, the default transfer with TRANSFER, and "keep" with error 7102.
- `packages/contract/test/v2-project-settings.test.ts` covers how each transfer setting decides who gets a receipt.
- `packages/contract/test/test-purchase-scenarios.test.ts` (10 tests) covers trial, trial conversion, renewal, cancel, billing issue, refund and expire.
- `packages/contract/test/rest-webhooks.test.ts` covers promotional grants, lifetime grants, duplicates and EXPIRATION recorded once.
- `apps/server/test/apple-notifications.test.ts`, `google.test.ts` and `lifecycle-events.test.ts` cover each store state and the event it maps to.
- `apps/dashboard/e2e/overview-customers.spec.ts` grants and revokes access on the customer page.

## Known gaps
- Most of the engine is tested through the server, because `packages/core` has only 2 direct unit tests.
- Google CANCELLATION with reason PRICE_INCREASE is inferred from Google's price change state. RevenueCat does not document its rule.
- The six event types listed under "Later" are never produced.
