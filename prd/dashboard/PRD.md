# Dashboard (scope 1.10)

**Status:** The dashboard ships Overview, Customers, Product catalog, Apps, API keys, Integrations with Webhooks, Project settings and New project on RevenueCat's sidebar layout, and 10 browser tests run it against a real API and database. Later-tier areas show as "Soon". The reference screen is `prd/dashboard/mockup.html`.

## Users and jobs
- **A team leaving RevenueCat** finds every page where it expects it, so nobody relearns the product.
- **A founder** opens Overview each morning to see revenue, subscriptions and trials, and whether anything in setup is broken.
- **A developer testing purchases** flips to sandbox data and makes a test purchase without a store account.

## Essential now and later
Essential (Tier 1)
- Shell: a 232px sidebar with the project switcher and RevenueCat's items in order, pinned Apps, Web, API keys, Integrations and Project settings, and a top bar with breadcrumb and customer search.
- Overview: six live cards (active trials, active subscriptions, MRR, revenue, new customers, active customers) with deltas and sparklines; periods 7D, 28D, 90D and 12M kept in the URL.
- A Sandbox switch that moves the cards and the transaction feed to sandbox data (`?environment=sandbox`).
- Recent transactions, newest first, each linking to its customer.
- Setup health: store notification state per app with the store's error, missing credentials with a "Fix" link, and webhook delivery rate over 24 hours.
- First run: a six-step setup checklist, the SDK proxy line in Swift and Kotlin, and a Test Store purchase.
- The locked design system: tokens from `design/tokens.css` imported by `apps/dashboard/src/styles/app.css`, square corners, hairlines, one gold accent, light and dark themes.
- The pages in `prd/catalog/PRD.md`, `prd/customers/PRD.md` and `prd/apps-setup/PRD.md`, plus Webhooks (scope 1.7).

Later
- Charts and Benchmarks, Paywalls, Targeting, Experiments, Funnels, Ads, Lifecycle, Web, In-app currencies and Web discounts (Tier 2 and 3).
- The "Ask about revenue" AI bar (shown, labelled coming soon).
- Project filter chips on Overview, and cards that open a chart.

## RevenueCat behaviour we match
- The sidebar order and the pinned bottom group follow RevenueCat's sidebar, as set in `DESIGN.md`, and dashboard URL paths mirror RevenueCat's (for example `/product-catalog/offerings`), per `apps/dashboard/src/routes.tsx`.
- The Overview cards and their definitions follow RevenueCat's Overview ([Overview](https://www.revenuecat.com/docs/dashboard-and-metrics/overview), operation `get-overview-metrics`); `/v2/projects/{id}/metrics/overview` returns RevenueCat's response shape.
- Sandbox data is kept apart from production and has its own view ([Sandbox testing](https://www.revenuecat.com/docs/test-and-launch/sandbox)).
- Test purchases run through a Test Store with no store account ([Test Store](https://www.revenuecat.com/docs/test-and-launch/sandbox/test-store)).

## Endpoints and screens
- Overview (`pages/Overview.tsx`): `GET /v2/projects/{id}/metrics/overview`, and the RevenueDot extensions `GET /metrics/history?metric=&days=&environment=`, `GET /transactions`, `GET /setup_health`, `POST /test_purchases`.
- Shell (`components/Shell.tsx`): `GET /auth/me` for the user and project list.
- Routes (`apps/dashboard/src/routes.tsx`, `main.tsx`): `/login`, `/signup`, `/projects/new`, and under `/projects/:projectId/`: `overview`, `customers`, `customers/:appUserId`, `product-catalog/offerings|products|entitlements` and their detail and edit pages, `apps`, `apps/:appId`, `api-keys`, `integrations`, `integrations/webhooks` (list, `new`, detail, `edit`), `settings`, `settings/:tab`. Later-tier paths render the `Soon` page.
- Self-host serves the built dashboard from the same process as the API (`apps/server/src/entry.node.ts`); the cloud build serves it from Workers assets.

## Tests that prove it
Run with `pnpm --filter @revenuedot/dashboard e2e`. `apps/dashboard/e2e/server.ts` boots the API on in-memory Postgres (PGlite), seeds it (`e2e/seed.ts`) and serves the built dashboard.
- `overview-customers.spec.ts` (6 tests): first-run checklist and test purchase; cards equal to the API values, period and sandbox switches, transactions, setup health; customer list and search; customer page; 390px width with no page-level horizontal scroll; no console errors.
- `catalog.spec.ts`: the catalog pages and what the SDK receives.
- `setup.spec.ts`: project, apps, credentials, API keys, webhooks with a signed delivery to a local listener, settings.
- `sdk-compat.spec.ts`: the SDK compatibility panel and a failing app on Apps and Overview.
- `auth.spec.ts`: the closed sign-up page.
- `packages/contract/test/v2-dashboard-overview.test.ts` and `v2-customers.test.ts` ("metrics overview"): the numbers behind the cards.

## Known gaps
- Active customers has no sparkline, because only each customer's latest visit is stored.
- Currency is USD only; the API refuses other currencies rather than mislabel them.
- Card definitions live in a title attribute, not an info tooltip.
- The Overview's setup health has no SDK-version or migration row; the SDK versions show on the Apps page only.
- Integrations other than Webhooks are marked "Soon".
