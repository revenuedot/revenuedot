# Webhooks out (scope 1.7)

**Status:** Every purchase event is posted in RevenueCat's payload shape, with an optional Authorization header and an HMAC signature. Failed deliveries retry 5 times and are logged, and the dashboard can resend them. Payloads match RevenueCat's samples key by key for 12 event types (14 sample payloads).

## Users and jobs
- **Backend developers** reuse the webhook handler they wrote for RevenueCat without changes.
- **Operators** see which deliveries failed and send them again.
- **Teams** send sandbox and production events to different URLs and pick which event types each URL gets.

## Essential now and later
Essential (Tier 1)
- Match RevenueCat's payload shape: the same keys, nulls where RevenueCat sends nulls, and timestamps in milliseconds.
- Send the Authorization header and the `X-RevenueCat-Webhook-Signature` HMAC, with a new signature on every attempt.
- Retry 5 times, filter by environment, event type and app, keep a delivery log, retry by hand, and send a test event.

Later
- The `renewal_number` and `experiments` fields.
- Events for features RevenueDot does not have yet (see `prd/entitlements-identity/PRD.md`).

## RevenueCat behaviour we match
- Only an HTTP 200 counts as delivered. Retries come after 5, 10, 20, 40 and 80 minutes, and the request times out after 60 seconds (https://www.revenuecat.com/docs/integrations/webhooks).
- The signature header is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (https://www.revenuecat.com/docs/integrations/webhooks).
- The body is `{ "api_version": "1.0", "event": {...} }` with the keys of each sample payload, compared against `packages/contract/fixtures/webhooks/*.json` (https://www.revenuecat.com/docs/integrations/webhooks/sample-events).
- Store names are upper case, refunds carry a negative price, and events without money movement report price 0 (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
- Promotional grants leave `app_id` out, as RevenueCat does for the PROMOTIONAL store (https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).
- TRANSFER carries `transferred_from` and `transferred_to` (`fixtures/webhooks/transfer.json`).

## Endpoints and screens
- Delivery code: `apps/server/src/services/webhooks.ts` (signing, one attempt, `deliverDue`, retry). Events are queued in `services/events.ts`. The one-minute job in `services/tick.ts` sends due deliveries and records EXPIRATION.
- `GET`, `POST` `/v2/projects/{id}/integrations/webhooks`, plus `GET`, `POST` and `DELETE .../{webhook_integration_id}`. RevenueCat's API returns the signing secret only when a webhook is created.
- Extensions: `GET /v2/projects/{id}/webhooks/{webhook_id}/deliveries` (`?status=`), `POST .../deliveries/{delivery_id}/retry`, and `POST /v2/projects/{id}/integrations/webhooks/{id}/test`.
- The same queue also feeds the third-party integrations (Slack, Segment, Amplitude ...): `queueDeliveries` queues each event to matching integrations too, and the tick sends them with the same retry schedule. See `prd/integrations/PRD.md`.
- Dashboard: `/projects/:projectId/integrations/webhooks` (list), `/new`, `/:webhookId` (details and delivery log with retry) and `/:webhookId/edit` (`apps/dashboard/src/pages/setup/Webhooks.tsx`).

## Tests that prove it
- `packages/contract/test/webhook-payloads.test.ts` (2 tests) drives one of every event type through the real pipeline. It then compares keys, nulls and millisecond fields with RevenueCat's samples, and checks promotional events without `app_id`.
- `packages/contract/test/rest-webhooks.test.ts` ("webhooks", 3 tests) covers the Authorization header, a valid HMAC, 200 as the only success, the 5-step retry schedule, and environment and event type filters.
- `packages/contract/test/v2-catalog.test.ts` ("webhook integrations") covers the one-time signing secret and event type and environment mapping.
- `packages/contract/test/v2-auth-extensions.test.ts` covers the delivery log, manual retry, and setup health that reports failing endpoints.
- `apps/server/test/setup-endpoints.test.ts` covers the signed TEST event and all 21 event types in the filter.
- `apps/dashboard/e2e/setup.spec.ts` creates a webhook with an event filter in the browser, shows the signing secret once, and checks signed deliveries, retry and the test event.
- Outside this repo, `scripts/e2e-webhook.sh` in `revenuedot/examples` delivers a real signed webhook to 17 sample receivers.

## Known gaps
- `renewal_number` and `experiments` are not sent. RevenueCat marks both as sometimes present, and RevenueDot has no experiments.
- `metadata` is not sent. It exists only for RevenueCat Billing.
- TEMPORARY_ENTITLEMENT_GRANT, INVOICE_ISSUANCE, PURCHASE_REDEEMED, VIRTUAL_CURRENCY_TRANSACTION, EXPERIMENT_ENROLLMENT and SUBSCRIBER_ALIAS can be selected as filters but are never sent.
