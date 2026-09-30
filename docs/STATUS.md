# RevenueDot status

**Phase:** 2 · build-product, Tier 1 in progress. Scope: `prd/SCOPE.md`. Design: `DESIGN.md` + `design/tokens.css` (locked). Brand: `brand/`.

## Features (Tier 1)
| Feature | State | Notes |
|---|---|---|
| 1.0 Foundations (monorepo, schema, contract harness) | browser-n/a · tests passing | 39 contract tests from RevenueCat SDK fixtures |
| 1.1 SDK-compatible API | done · tested | 37 endpoints, fixtures-verified; Apple/Google receipts included |
| 1.2 Apple ingestion | done · tested | JWS, receipts, ASN v2; real sandbox test needs credentials |
| 1.3 Google ingestion | done · tested | Play API, RTDN push; real sandbox test needs credentials |
| 1.4 Entitlement engine | done · tested | grace, refunds, promotional, lifetime, transfers; `packages/core` |
| 1.5 Identity | done · tested | aliasing, merge, transfer behaviours |
| 1.6 Catalog | done · browser-validated | Offerings, Products, Entitlements pages; SDK offerings response decoded in e2e |
| 1.7 Webhooks out | done · tested | HMAC, Authorization, 5 retries, filters |
| 1.8 REST API | done · tested | v1 + v2 validated against RevenueCat OpenAPI, plus dashboard extensions |
| 1.9 Migration importer | done · tested | `npx revenuedot import` / `import verify` / `import plan` (`packages/importer`), bulk import endpoint `POST /v2/projects/{id}/import/customers`; fake-RevenueCat e2e tests with fixtures checked against RevenueCat's OpenAPI; not yet run against a real RevenueCat project. Spec: `prd/migration/PRD.md` |
| 1.10 Dashboard | pages built · browser-validated | Overview, Customers, Catalog, Apps, API keys, Integrations/Webhooks, Project settings, New project. Later-tier: Analytics, Paywalls, Targeting, Experiments, Funnels, Ads, Lifecycle. `pnpm --filter @revenuedot/dashboard e2e` (8 tests) |
| 1.11 Self-host (Docker) | done · smoke-tested | `docker compose up -d` with Postgres, signup works; `REVENUEDOT_PORT` sets the host port |
| 1.12 Cloud (Workers) | not started | |
| 1.13 SDK forks | forked · pipeline not started | 10 repos at upstream main |
| 1.14 MCP + skills | scaffolds | |
| 1.15 Docs | README done | |
| 1.16 Brand and site | brand kit done · site not started | |

## Blockers and notes
- RevenueCat dashboard side-by-side studies are saved under `company/docs/research/contact-sheets/revenuecat/`.
- Real App Store/Google Play sandbox purchases need store credentials (Kai) for end-to-end device tests.
- Customer pages of the RevenueCat dashboard were blocked by the agent's personal-data guard.

## Known gaps (next up)
- Importer: without the App Store In-App Purchase key, an Apple chain that RevenueCat split after a lapse is keyed by its first known transaction, so a later receipt for it can create a second row; refunded subscriptions import as expired (RevenueCat's v2 subscription has no refund field); paywalls, targeting, experiments and virtual currencies are not imported.
- Google PRODUCT_CHANGE only fires from notifications; REFUND_REVERSED for one-time purchases, price-increase events, daily voided-purchase scan.
- Store actions (refund, revoke, defer, extend) not wired to the stores; SDK versions not recorded.
- Setup health marks an app Ready when a notification arrives even if it failed to process.
- SDK offerings response includes archived products in packages.
- Test Store cannot create trials, renewals or refunds through the API.
- Breadcrumbs overlap top-bar icons at 390px.
