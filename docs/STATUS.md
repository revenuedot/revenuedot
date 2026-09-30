# RevenueDot status

**Phase:** 2 · build-product, Tier 1 in progress. Scope: `prd/SCOPE.md`. Design: `DESIGN.md` + `design/tokens.css` (locked). Brand: `brand/`.

## Features (Tier 1)
| Feature | State | Notes |
|---|---|---|
| 1.0 Foundations (monorepo, schema, contract harness) | browser-n/a · tests passing | 39 contract tests from RevenueCat SDK fixtures |
| 1.1 SDK-compatible API | building | customer info, receipts (Test Store), identify, attributes, offerings, mapping, stubs done; Apple/Google receipts in progress |
| 1.2 Apple ingestion | building (parallel builder) | |
| 1.3 Google ingestion | building (parallel builder) | |
| 1.4 Entitlement engine | done · tested | grace, refunds, promotional, lifetime, transfers; `packages/core` |
| 1.5 Identity | done · tested | aliasing, merge, transfer behaviours |
| 1.6 Catalog | API pending v2 | schema and SDK reads done |
| 1.7 Webhooks out | done · tested | HMAC, Authorization, 5 retries, filters |
| 1.8 REST API | v1 done · v2 building | |
| 1.9 Migration importer | not started | |
| 1.10 Dashboard | shell done · pages building | sign-in, sidebar, theme |
| 1.11 Self-host (Docker) | not started | |
| 1.12 Cloud (Workers) | not started | |
| 1.13 SDK forks | forked · pipeline not started | 10 repos at upstream main |
| 1.14 MCP + skills | scaffolds | |
| 1.15 Docs | README done | |
| 1.16 Brand and site | brand kit done · site not started | |

## Blockers and notes
- RevenueCat dashboard side-by-side studies are saved under `company/docs/research/contact-sheets/revenuecat/`.
- Real App Store/Google Play sandbox purchases need store credentials (Kai) for end-to-end device tests.
- Customer pages of the RevenueCat dashboard were blocked by the agent's personal-data guard.
