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

Manual checks on a real Postgres: `E2E_DATABASE_URL=<a database of your own on the Railway development server>` runs the same server there instead of PGlite (then `E2E_BASE_URL=http://localhost:<port> npx playwright test -c e2e/playwright.config.ts <spec>` runs specs against it without starting another server); add `E2E_SEED=off` to skip the demo data (a persistent database keeps it across restarts, and seeding twice fails). `E2E_REAL_STORES=1` lets App Store Connect and Google Play be called for real with credentials you save on an app, read-only: anything but a GET (and Google's OAuth token request) is refused, so nothing in the store can change.

## Specs

| File | Covers |
|---|---|
| `browser-pass-3.spec.ts` | Test Store price on the app page's inline form (validation, the purchase records it), Products at 1200px, Attach creating an entitlement, Offerings header link, paywall preview with real prices and the intro switch, Overview "All projects" (sums, chips, sandbox, periods, left-out projects), checklist opening Add app; phone width and dark theme |
| `layout.spec.ts` | No page, table or tab row scrolls sideways at 1024, 1200 and 1440px on 40 pages; only `data-scroll="x"` areas and code blocks may |
| `overview-customers.spec.ts` | First-run checklist and test purchase flow; Overview cards against `/metrics/overview` and `/metrics/history`, period and sandbox switches, transactions, setup health; customer list, pagination and search; customer page history, grant and revoke, offering override, attributes, delete; phone width; console errors |
| `account-email.spec.ts` | Forgot and reset password (the link works once), invite and accept as a new and an existing user, role changes, the last admin, resend, revoke, remove, leave, alert email settings, the unverified-email banner and verify link; every page at 390px. Emails come from the e2e server's in-memory mailer, `GET /__mail?to=<address>` |
| `account-settings.spec.ts` | Account settings (`E2E_PORT=5530`): General (name, email change with the link read from `/__mail`, an expired link through `POST /__tokens/expire`, a cancelled one, log out of all sessions), Security (wrong current password, two-factor setup with codes computed in the spec, sign-in with a code and a recovery code, sessions, an OAuth token connected and revoked, new codes, turning it off), deletion blocked then allowed, Notifications (a weekly summary through `POST /__notifications/run`), Interface (theme and tint on other pages), Date and region (Sunday weeks in the calendar and the weekly chart, EUR on the Overview, Customers and Charts with revenue from `POST /__revenue`), Billing on both servers; phone width, dark mode, console errors |
| `catalog.spec.ts` | Products, entitlements, offerings and what the SDK receives |
| `experiments.spec.ts` | Experiments v2 (`prd/experiments/PRD.md`): the six starter categories and their defaults; the create form (duplicate the control offering with a swapped product, a placement on every variant, a third variant, validations, the notes preview, enrollment and paywall tracking, custom audience with the live 7-day estimate); draft, edit, start, the locked form of a started experiment; customers through the SDK endpoints split three ways with placements; results against the API (guidance, intervals, lift, chance to beat the control, all metrics, the chart, platform and paywall filters) and both CSV downloads; pause, resume, stop; the 409 on an offering in use; priority by keyboard, drag and menu; Create with RevenueDot AI approving a draft (scripted model); the Sandbox switch kept in the URL; a viewer's read-only Experiments, experiment, form and Targeting pages (and the server's 403); phone width and dark theme |
| `targeting.spec.ts` | Targeting (`prd/experiments/PRD.md` §6): an audience, a rule with a placement, rule cards in Live, Scheduled (start date ahead) and Inactive (off or ended), duplicate, order by keyboard and drag, the default offering picker, what the SDK serves, Create with RevenueDot AI approving a rule that stays off; phone width and dark theme |
| `lifecycle.spec.ts` | Refund Control (cards against the API, a recent-renewal policy, preference, drag and keyboard order, consent, Save and Cancel), Retention (Apple message, rule, sync error without a key; Customer Center cancel offer), Win-back (empty state, create, preview, send test read back from `/__mail`, start, send now), Support (ticket settings, a Customer Center ticket posted with the Test Store key, close it), Customers (lists, summary cards, filter, Save audience, CSV export, search); phone width and dark theme; console errors. Seeded by `seedLifecycle()` in `e2e/server.ts` |
| `shots.spec.ts` | `SHOTS=<dir>` only: 1440×900 screenshots of the Lifecycle and Customers pages on the clean seed (light, plus two dark), for `docs/assets/lifecycle/`. Run it alone on a fresh server |
| `stores.spec.ts` | Amazon Appstore and Stripe apps: Add app for each, the shared key, restricted key and signing secret fields with their validation, the live "Check credentials" against the e2e server's in-process Amazon and Stripe fakes (`e2e/store-fakes.ts`; neither store is called), the notification URLs with live status, a Stripe subscription posted to `/v1/receipts` and a Stripe-signed webhook that turns the open page green, no secret in any API answer, phone width. `SHOTS=<dir>` saves the README screenshots |
| `store-import.spec.ts` | Import products: the dialog on the Products page and on an app page against the e2e server's fake App Store Connect and Google Play (`storeCatalogFetch` in `e2e/store-fakes.ts`, which answers only the key ids and service account in `store-values.ts`; the spec generates the keys) and its in-memory Stripe account (seeded through `POST /__stripe/seed`): search, select all, a row already in the catalog disabled, the entitlement picker, the result summary, re-opening with only the rest left, Play base plans, Stripe prices, Amazon's explanation, a refused App Store Connect key naming the App Manager role, phone width. `SHOTS=<dir>` saves the dialog |
| `charts.spec.ts` | Charts: the grouped rail (42 charts) and search, MRR against the API and the Overview card, range and resolution in the URL, hover and arrow keys, segment by country, a product filter, the sandbox switch, CSV download, measure picker and selectors, cohort tables (retention, prediction, cohort explorer), every chart loads, phone width |
| `charts-page-extras.spec.ts` | The chart page's RevenueCat-parity extras: all five chart types (stacked only with two series, in the URL and saved charts), the Customers tab against the API and its CSV (contributors plus unattributed ad revenue equal the chart's total), annotations by click and drag, on other charts, edit and delete, a Viewer invited through `/__mail` who reads only, Share preview opened in a signed-out context (no customer ids, `og.png`, phone and dark) and revoked (410), Refresh, Ask AI handoff with the chart's view, phone width and dark theme. `E2E_PORT=5540` |
| `integrations.spec.ts` | Integrations and data exports against a local fake partner and bucket (one Node server in the spec): the catalogue, Slack connect with validation, Send test event, a Test Store purchase arriving in Slack, the delivery log with the scrubbed request, turning Slack off, PostHog on a self-hosted URL with a sandbox key and a renamed event, an S3-compatible export (missing secret, Check bucket, Run now, the gzip CSV read back, run history), phone width |
| `web.spec.ts` | Web billing on the e2e server's in-memory Stripe account (`FakeStripeAccount`, key `FAKE_STRIPE_KEY`; Stripe is never called): Web page and its four-step checklist, Add web provider → Stripe app with a checked key, web config (preset, deep link scheme), a web product created through the dialog, Web discounts with codes, a purchase link (copy, copy for a signed-in user), the hosted page with a discount code, the fake Stripe Checkout page (`GET /__stripe/checkout/<id>`, Pay completes the session), the success page and redemption link, `POST /v1/subscribers/redeem_purchase` with PURCHASE_REDEEMED, the funnel builder (edit, add, reorder, problems, live preview), a published funnel bought end to end, funnel analytics, Domains with DNS from `POST /__dns`, phone width. `SHOTS=<dir>` saves the screenshots in `docs/assets/web/` |
| `stripe-connect.spec.ts` | Connect with Stripe on the e2e server's fake Connect platform (`connectPlatform` in `e2e/store-fakes.ts`; Stripe is never called): the button disabled with the reason while `POST /__connect { available: false }`, Cancel on the fake consent page (`/__stripe/connect/authorize`, Stripe's URL is routed there), connect in test mode, the connected state and Check connection, the Web page row, a purchase link paid on the connected account, a refund through the Connect endpoint (`POST /__stripe/refund`), Disconnect, reconnect, `account.application.deauthorized` (`POST /__stripe/deauthorize`), then a restricted key on the same app; phone width and dark mode. `E2E_PORT=5471` |
| `payment-recovery.spec.ts` | Lifecycle → Payment recovery: the off and empty states, Turn on with the settings dialog (edit an email, preview, Send test from `/__mail`, order validation, sandbox), billing issues on the App Store, Google Play and Amazon through the purchase pipeline (`POST /__store/billing_issue`, `/__store/renew`) and on a connected Stripe account (`POST /__stripe/fail_renewal`), Send due emails, each store's link, the fake Stripe customer portal (`/__stripe/portal/<id>`) paying the invoice, recovered revenue on the page and in the API, unsubscribe; phone width and dark mode. `E2E_PORT=5472` |
| `settings.spec.ts` | Project settings tabs and Auth on a fresh account: sandbox testing access through the form, checked against real Test Store receipts; an invited admin signs up and receives ownership (both emails read from `/__mail`); Brand colour and gradient presets, a font upload, the presets in the paywall editor and in the SDK's `ui_config`; Blocked customers (block, the SDK's customer info loses the entitlement, search, unblock, audit log); Verified Metrics (slug check, order and visibility, publish, the public page, its PNG and caching, unpublish); Auth with an OpenID Connect provider whose keys a local server in the spec publishes (the token tester, a real `/v1/auth/login`, recent sign-ins); every page at 390px. The e2e server has a fixed `encryptionKey`, from which Auth derives its token key |
| `settings-shots.spec.ts` | `SHOTS=<dir>` only: 1440×900 screenshots of the settings tabs, the verified page and its image, and Auth (light, plus dark), for `docs/assets/settings/`. Compared with RevenueCat's frames 28 and 30. Run it alone on a fresh server |
| `setup.spec.ts` | New project; Apps (App Store, Google Play, Test Store) with credential upload, mocked "Check credentials", forwarding URL (a real notification is forwarded), live notification status, test purchase, SDK snippets, masked keys with reveal and copy; API keys (full and scoped secret keys used against `/v2`, revoke); webhooks (24-type event filter, signing secret once, signed test event and real purchase received by a local listener, failing delivery and Retry, edit, delete); project settings (transfer behaviour checked against real receipt posts, sandbox override), collaborators, app and project deletion; console errors |

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
