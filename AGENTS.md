# AGENTS.md

RevenueDot is an open-source, self-hostable server for in-app purchases and subscriptions that speaks the RevenueCat SDK protocol. Apps switch by changing the SDK's proxy URL.

## Rules
- **Memory lives in the repo.** Record every decision, status change and research result in files and commit it. Chat sessions can end at any time. This repo is public: anything confidential goes to the private `revenuedot/company` repo instead.
- **Specs first.** Every feature has `prd/<feature>/PRD.md` before code. The tiered scope is in `prd/SCOPE.md`.
- **Compatibility is the contract.** Never change a response shape the RevenueCat SDKs decode without a passing contract test. Temporary failures on `POST /v1/receipts` must return 5xx, never 4xx.
- **Business logic is pure.** `apply(state, event) -> { state, effects }` in `packages/core`. Only thin adapters differ between Workers and Node.
- **Never copy RevenueCat's docs text or use its name, logo or domains** in our product names. Plain "works with the RevenueCat SDK" wording is fine.
- **No AGPL or other copyleft code from other projects.** Reading it for ideas is fine.
- Keep `docs/STATUS.md` current. Commit and push as you go.
- **Keep README.md rich and current.** When a feature ships, update its status in the Features table, add a real screenshot or short GIF to `docs/assets/`, and extend the FAQ with questions people search for. Every claim about RevenueCat or other vendors needs a source link.

## Index
- `prd/ecosystem/PRD.md`: the plan for examples, cookbook and public docs. Every example and docs page follows its format and comment standard (header comment with links to revenuedot.app/docs). Training future LLMs on our public repos is a goal.
- `LICENSING.md`: AGPL-3.0 core, `ee/` under the Enterprise License, MIT for SDKs and CLI; `TRADEMARKS.md`; CLA in `.github/CLA.md` (individual) and `.github/CLA-entity.md`. Never import `ee/` code from outside `ee/`. **Never draft legal text.** `ee/LICENSE` is the n8n Enterprise License, the CLAs are the Harmony CLAs 1.0 and `TRADEMARKS.md` is the Model Trademark Guidelines, each with only names, contacts and template blanks filled in. Change them only by adopting a newer version of the same source; the sources and every change are recorded in the private `company/legal/`.
- Website and API domain: `revenuedot.app` (Cloudflare, Circo account). Live hosts: `revenuedot.app` (site, docs, blog), `api.revenuedot.app`, `app.revenuedot.app`, `mcp.revenuedot.app`. Runbook: `docs/cloud.md`.
- `docs/analytics.md` + `prd/analytics/PRD.md`: DataFast web analytics, goals, user profile, Stripe revenue attribution and bot tracking. A new Cloud step or page link gets a goal.
- `prd/SCOPE.md`: tiers and build order.
- `docs/STATUS.md`: current phase, feature table, blockers.
- `docs/architecture.md`: stack and portability rules (to be added).
- `DESIGN.md` + `design/tokens.css`: the locked design system (RevenueCat sidebar IA, Superwall tokens, Vercel restraint, gold accent). Every UI uses these tokens; reference screen `prd/dashboard/mockup.html`.
- Sibling repos and the org map: `../AGENTS.md` (= `company/WORKSPACE.md`, private).

## Databases
Use the Railway Postgres, never a local one. Development: `source ~/.config/revenuedot/dev.env` sets `REVENUEDOT_DEV_DATABASE_URL` (Railway environment `development`); each task creates its own database on it (`CREATE DATABASE rd_<task>`). CI deploys on every push to `main` with the GitHub `production` environment's secrets. On a maintainer's machine, production, store and registry secrets are in `~/.config/revenuedot/prod.env` (outside every repo): load them by name with `set -a; source ~/.config/revenuedot/prod.env; set +a` and never print, cat or commit a value. Details are in the workspace `AGENTS.md` (`company/WORKSPACE.md`, private). Unit tests use in-memory PGlite. Never commit or print either URL.

## Toolchain
Node 24 (`.nvmrc`, `engines`), also in CI. Deploys use the `cf` CLI, not wrangler (`cf` needs Node 22.18 or newer). pnpm for the monorepo.

## CI and deploys
`.github/workflows/ci.yml` runs on pull requests: a `changes` job picks the jobs a change can affect (images, site pages, prose and email wording start no unit, browser, Docker or Postgres jobs; tests-only changes start no browser or Docker jobs), the unit tests run in 4 parallel shards, the suites that use a database run again on real Postgres in 3 (the pure suites are not repeated), the dashboard's Playwright suite (`apps/dashboard/e2e`, no secrets) in 4 (a failed test uploads its trace as `e2e-traces-<shard>`), and the `CI result` job is the single check to watch. When adding a job or a folder, extend the path rules in the `changes` job rather than running everything. `.github/workflows/deploy.yml` runs on every push to `main`: CI (skipped when the merged tree is exactly the one its pull request's CI passed, recorded as the artifact `tested-tree-<tree>`; otherwise only the jobs the changes since the last successful deploy can affect), then (by changed paths) migrations, the Worker for `api.` and `app.revenuedot.app` and live smoke checks, and the site in parallel. Tests open a snapshot of a migrated PGlite database (`packages/contract/src/test-db.ts`); never migrate per test. The site build keeps Astro's image cache (`apps/site/node_modules/.astro`) in the Actions cache. A pull request that changes API routes (`apps/server/src`, `ee/server`) also runs `docs-drift`, which compares the routes with the OpenAPI document in revenuedot/docs. Open the matching docs pull request from a branch with the same name as this one; both repos' CI then check against each other's branch (else against the other's `main`). Merge the server pull request first, then the docs one. revenuedot/docs has its own pull request CI (docs checks plus the site build and check), so a title over 70 characters or a missing route fails the pull request, not the deploy. Docs changes deploy the site from revenuedot/docs (`deploy-site.yml`); the MCP server deploys from revenuedot/mcp (`ci.yml`). Pushing to `main` is a production deploy.
