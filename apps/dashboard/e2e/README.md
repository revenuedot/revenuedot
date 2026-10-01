# Dashboard end-to-end tests

Real browser, real API, real database: `e2e/server.ts` boots the API on an in-memory Postgres (PGlite), seeds it, and serves the built dashboard on one port (5199). Nothing touches your dev database.

## Run

```bash
pnpm --filter @revenuedot/dashboard e2e                          # build, start the e2e server, run every spec
pnpm --filter @revenuedot/dashboard e2e -- overview-customers     # one spec file
```

Browsers come from the Playwright cache (`~/Library/Caches/ms-playwright`); if none match, run `pnpm --filter @revenuedot/dashboard exec playwright install chromium` once.

## What the server seeds

- `e2e@revenuedot.test` / `e2e-password-1`: project "Scanner" with a Test Store app and catalog, about 40 sandbox customers made through the API (`e2e/seed.ts`), a promotional grant, an offering override, and App Store production history (trials, trial conversions, renewals, a refund, a cancellation, a billing issue) that goes through the server's own purchase pipeline with the clock set back.
- Lifecycle data for the demo project: two lapsed App Store subscribers, `$email` on four churned customers, two refund policies and eight refund requests over the last 28 days, a Customer Center retention offer and two support tickets.
- `fresh@revenuedot.test` / `e2e-password-1`: an empty project for the first-run checklist.

Specs that need their own data sign up a fresh account instead of changing the demo one.

## Look at it yourself

```bash
pnpm --filter @revenuedot/dashboard build && pnpm --filter @revenuedot/dashboard e2e:server   # then open http://localhost:5199
pnpm --filter @revenuedot/dashboard seed    # or: fill the dev server (localhost:8787) with the API-made demo data
```

## Specs

| File | Covers |
|---|---|
| `overview-customers.spec.ts` | First-run checklist and test purchase flow; Overview cards against `/metrics/overview` and `/metrics/history`, period and sandbox switches, transactions, setup health; customer list, pagination and search; customer page history, grant and revoke, offering override, attributes, delete; phone width; console errors |
| `account-email.spec.ts` | Forgot and reset password (the link works once), invite and accept as a new and an existing user, role changes, the last admin, resend, revoke, remove, leave, alert email settings, the unverified-email banner and verify link; every page at 390px. Emails come from the e2e server's in-memory mailer, `GET /__mail?to=<address>` |
| `catalog.spec.ts` | Products, entitlements, offerings and what the SDK receives |
| `lifecycle.spec.ts` | Refund Control (cards against the API, a recent-renewal policy, preference, drag and keyboard order, consent, Save and Cancel), Retention (Apple message, rule, sync error without a key; Customer Center cancel offer), Win-back (empty state, create, preview, send test read back from `/__mail`, start, send now), Support (ticket settings, a Customer Center ticket posted with the Test Store key, close it), Customers (lists, summary cards, filter, Save audience, CSV export, search); phone width and dark theme; console errors. Seeded by `seedLifecycle()` in `e2e/server.ts` |
| `shots.spec.ts` | `SHOTS=<dir>` only: 1440×900 screenshots of the Lifecycle and Customers pages on the clean seed (light, plus two dark), for `docs/assets/lifecycle/`. Run it alone on a fresh server |
| `stores.spec.ts` | Amazon Appstore and Stripe apps: Add app for each, the shared key, restricted key and signing secret fields with their validation, the live "Check credentials" against the e2e server's in-process Amazon and Stripe fakes (`e2e/store-fakes.ts`; neither store is called), the notification URLs with live status, a Stripe subscription posted to `/v1/receipts` and a Stripe-signed webhook that turns the open page green, no secret in any API answer, phone width. `SHOTS=<dir>` saves the README screenshots |
| `charts.spec.ts` | Charts: the grouped rail (42 charts) and search, MRR against the API and the Overview card, range and resolution in the URL, hover and arrow keys, segment by country, a product filter, the sandbox switch, CSV download, measure picker and selectors, cohort tables (retention, prediction, cohort explorer), every chart loads, phone width |
| `integrations.spec.ts` | Integrations and data exports against a local fake partner and bucket (one Node server in the spec): the catalogue, Slack connect with validation, Send test event, a Test Store purchase arriving in Slack, the delivery log with the scrubbed request, turning Slack off, PostHog on a self-hosted URL with a sandbox key and a renamed event, an S3-compatible export (missing secret, Check bucket, Run now, the gzip CSV read back, run history), phone width |
| `setup.spec.ts` | New project; Apps (App Store, Google Play, Test Store) with credential upload, mocked "Check credentials", forwarding URL (a real notification is forwarded), live notification status, test purchase, SDK snippets, masked keys with reveal and copy; API keys (full and scoped secret keys used against `/v2`, revoke); webhooks (21-type event filter, signing secret once, signed test event and real purchase received by a local listener, failing delivery and Retry, edit, delete); project settings (transfer behaviour checked against real receipt posts, sandbox override), collaborators, app and project deletion; console errors |

### Setup areas (`setup.spec.ts`)

```bash
pnpm --filter @revenuedot/dashboard e2e -- setup                                        # against the e2e server, like the others
cd apps/dashboard && RD_WEB=http://localhost:5178 npx playwright test e2e/setup.spec.ts  # against your running dev API (:8787) and dashboard (:5178)
```

- It signs up a fresh account each run, so it is safe against the dev database.
- It starts its own webhook listener on a random local port and checks the `X-RevenueCat-Webhook-Signature` HMAC of what arrives. The e2e server runs the delivery tick every 5 seconds (and right after writes) once seeding is done.
- Apple and Google are never called. The "Check credentials" answers are mocked in the browser; the server side of that check (a signed App Store Server API request, the Google token and Play API call) is covered by `apps/server/test/setup-endpoints.test.ts`.
- `SHOTS=<dir>` saves a screenshot of each dialog and state along the way.

## Product catalog (`catalog.spec.ts`)

```bash
pnpm --filter @revenuedot/dashboard e2e -- catalog
```

One serial test on its own fresh account (it never touches the seeded demo data). It creates three apps through the API, then drives the UI:

- **Empty states** on Offerings, Products and Entitlements.
- **Products:** five app-scoped products through the New product dialog (subscription with duration, non-consumable); a duplicate store identifier shows the API's 409 inline.
- **Entitlement `pro`:** create, a duplicate identifier shows the 409 inline, attach every product, detach one with the confirm dialog.
- **Offering `default`:** the New offering form with Monthly and Annual packages, one product per app, an inline "New product" that selects itself, metadata JSON validation; the first offering becomes the default.
- **What the SDK receives:** `GET /v1/subscribers/{id}/offerings` with the iOS app's public key, decoded with `OfferingsSchema` from `packages/contract/src/sdk-schemas.ts` (current offering, package identifiers, product ids, metadata).
- **Offering `sale`:** a taken identifier shows the 409 inline and a reserved `$rc_` custom package identifier is rejected; then "Make default" by keyboard only, and the SDK's `current_offering_id` follows.
- **Duplicate, make inactive, make active, delete** from the row menu, each checked against the API and the SDK.
- **Edit:** reorder packages with the keyboard, rename, remove a product.
- **Products:** archive, unarchive, delete with confirmation.
- No browser console errors (the 409s the test provokes are expected).
