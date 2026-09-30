# RevenueDot status

**Phase:** 2 · build-product, Tier 1 in progress. Scope: `prd/SCOPE.md`. Design: `DESIGN.md` + `design/tokens.css` (locked). Brand: `brand/`.

## Features (Tier 1)
| Feature | State | Notes |
|---|---|---|
| 1.0 Foundations (monorepo, schema, contract harness) | browser-n/a · tests passing | 39 contract tests from RevenueCat SDK fixtures |
| 1.1 SDK-compatible API | done · tested | 37 endpoints, fixtures-verified; Apple/Google receipts included |
| 1.2 Apple ingestion | done · tested | JWS, receipts, ASN v2; real sandbox test needs credentials |
| 1.3 Google ingestion | done · tested | Play API, RTDN push, daily voided-purchases scan; real sandbox test needs credentials |
| 1.4 Entitlement engine | done · tested | grace, refunds, promotional, lifetime, transfers; `packages/core` |
| 1.5 Identity | done · tested | aliasing, merge, transfer behaviours |
| 1.6 Catalog | done · browser-validated | Offerings, Products, Entitlements pages; SDK offerings response decoded in e2e |
| 1.7 Webhooks out | done · tested | HMAC, Authorization, 5 retries, filters; every event type checked key by key against RevenueCat's sample payloads (`packages/contract/test/webhook-payloads.test.ts`) |
| 1.8 REST API | done · tested | v1 + v2 validated against RevenueCat OpenAPI, plus dashboard extensions; store actions call Google (revoke, cancel, defer, order refund) and Apple (extend, mass extend); Test Store scenarios through `POST /v2/projects/{id}/test_purchases` |
| 1.9 Migration importer | done · tested | `npx revenuedot import` / `import verify` / `import plan` (`packages/importer`), bulk import endpoint `POST /v2/projects/{id}/import/customers`; fake-RevenueCat e2e tests with fixtures checked against RevenueCat's OpenAPI; not yet run against a real RevenueCat project. Spec: `prd/migration/PRD.md` |
| 1.10 Dashboard | pages built · browser-validated | Overview, Customers, Catalog, Apps, API keys, Integrations/Webhooks, Project settings, New project. Later-tier: Analytics, Paywalls, Targeting, Experiments, Funnels, Ads, Lifecycle. `pnpm --filter @revenuedot/dashboard e2e` (8 tests) |
| 1.11 Self-host (Docker) | done · smoke-tested | `docker compose up -d` with Postgres, signup works; `REVENUEDOT_PORT` sets the host port |
| 1.12 Cloud (Workers) | not started | |
| 1.13 SDK forks | pipeline done · web SDK e2e-tested | All 10 forks patched on `revenuedot/main-patches` (host, signing key, registry names, leak scan clean); server response signing so Trusted Entitlements verify. Not published: needs npm, CocoaPods, Maven Central credentials. Spec: `prd/sdk-forks/PRD.md` |
| 1.14 MCP + skills | done · tested · not published | 17 tools (15 with RevenueCat's names), secret-key and OAuth 2.1 sign-in (`apps/server/src/routes/oauth.ts`), 16 MCP tests; skills migrate-from-revenuecat, add-subscriptions, self-host. npm packages and mcp.revenuedot.app not live yet |
| 1.15 Docs | in progress | Docs builder writing all sections, OpenAPI reference and llms.txt in `revenuedot/docs` |
| 1.17 Examples | done · 17 backends live-tested | 34 examples in `revenuedot/examples`; `scripts/e2e-webhook.sh` delivers a real signed webhook to 17 receivers; web and entitlement-check examples tested; Spring Boot, Ktor, PHP, Laravel, ASP.NET, Elixir, Android Compose and Flutter written but not built here (no toolchain) |
| 1.16 Brand and site | site built · browser-validated · not deployed | `apps/site` (Astro, static): home, pricing, compare, migrate, self-host, docs hub, blog, changelog, legal, security; SEO/JSON-LD/llms.txt; Lighthouse 100/96+/100/100. Deploy (`pnpm --filter site run deploy`), DNS and email routing await approval. Spec: `prd/site/PRD.md` |

## Blockers and notes
- RevenueCat dashboard side-by-side studies are saved under `company/docs/research/contact-sheets/revenuecat/`.
- Real App Store/Google Play sandbox purchases need store credentials (Kai) for end-to-end device tests.
- Customer pages of the RevenueCat dashboard were blocked by the agent's personal-data guard.

## Known gaps (next up)
- Importer: without the App Store In-App Purchase key, an Apple chain that RevenueCat split after a lapse is keyed by its first known transaction, so a later receipt for it can create a second row; refunded subscriptions import as expired (RevenueCat's v2 subscription has no refund field); paywalls, targeting, experiments and virtual currencies are not imported.
- Store actions are tested against mocked Google and Apple APIs only. The request bodies for `subscriptionsv2.revoke` (`fullRefund`), `cancel` (`DEVELOPER_REQUESTED_STOP_PAYMENTS`) and `defer` (`deferDuration` with the etag) follow Google's reference and need one real sandbox run with store credentials.
- Webhooks do not send `renewal_number` or `experiments` yet (RevenueCat marks both "Sometimes"); there are no experiments.
- Google `CANCELLATION` with `PRICE_INCREASE` is inferred: a system cancellation while `priceChangeDetails` is still `OUTSTANDING` (or a price step-up is `PENDING`). RevenueCat does not document its Google rule.
- The dashboard does not show `setup_health.notification_status` "failing" in the Apps list yet (it says "Waiting for store notifications"; the app page shows the error), and the SDK compatibility panel is not built; `setup_health.sdk_versions` is ready for it.
- `GET /v2/projects/{id}/subscriptions/{id}/transactions` is not implemented; the refund-a-transaction action is.
- Apple consumption information (Refund Control) is not sent; RevenueCat does not require it.
