# Cloud (scope 1.12)

**Status:** The cloud build is written but not deployed. The same Hono app runs on Cloudflare Workers with Postgres through Hyperdrive, one worker serves `api.revenuedot.app` and `app.revenuedot.app`, anyone can sign up, and every account is on the free plan. There is no Workers test yet.

## Users and jobs
- **A developer who does not want to run servers** signs up at `app.revenuedot.app`, creates a project and points the SDK at `api.revenuedot.app`.
- **The RevenueDot team** deploys one build with one command and gets the same behaviour as self-host.

## Essential now and later
Essential (Tier 1)
- Worker entry `apps/server/src/entry.worker.ts`: builds the app once per isolate with `edition: "cloud"`, and gives each request its own Postgres connection through Hyperdrive, closed after the response and any queued webhook work.
- Hostnames: `api.revenuedot.app` is all API; on `app.revenuedot.app` the paths `/v1`, `/v2`, `/auth`, `/rcbilling` and `/.well-known` go to the API and everything else is the dashboard from Workers assets, with single-page-app fallback.
- A cron trigger every minute runs expirations, the daily Google voided-purchases scan and webhook deliveries.
- `apps/server/cloudflare.config.ts` (the `cf` CLI, Circo account): the Hyperdrive binding (id from `REVENUEDOT_HYPERDRIVE_ID`, no connection string in the file), dashboard assets from `apps/dashboard/dist` (copied in by `vite.config.ts`), the cron, both custom domains, and `REVENUEDOT_SIGNING_KEY` as a secret for response signing.
- The Workers build of the database package, `packages/db/src/worker.ts`, has the schema and a connection but no PGlite, migrations or file access.
- Migrations run from Node before each deploy: `scripts/migrate.ts` (`pnpm migrate`) calls `openDb`, which applies `packages/db/migrations`.
- `scripts/deploy-cloud.sh` (`pnpm deploy:cloud`): builds the dashboard, finds or creates the Hyperdrive config `revenuedot`, migrates the production Postgres and runs `cf deploy`. `--dry-run` builds and bundles without migrating or deploying; `--secrets-file` uploads the signing key.
- Open sign-up: the cloud edition ignores `REVENUEDOT_ALLOW_SIGNUP`, and `GET /auth/config` answers `{ edition: "cloud", signup: "open" }`.
- Free plan: `users.plan` (migration `0002_account_plan.sql`) defaults to `free`, and `GET /auth/me` returns `account: { edition, plan }`.

Later
- Paid plans and billing (Tier 2); the dashboard does not show the plan yet.
- Failover, point-in-time recovery, monitoring and support, as the README promises for Cloud.

## RevenueCat behaviour we match
- The SDK endpoints and responses are the same code as self-host, so every contract test from the upstream fixtures (for example `ios/resp-customer-info-full.json`, `android/customer_info_full.json`) applies to the cloud build too.
- Response signing for Trusted Entitlements uses the same signer as self-host, keyed by `REVENUEDOT_SIGNING_KEY` ([Trusted Entitlements](https://www.revenuecat.com/docs/customers/trusted-entitlements), fixture `ios/resp-customer-info-real-signed.json`).

## Endpoints and screens
- Every route of the self-host server (see `prd/self-host/PRD.md`), on `api.revenuedot.app` and on `app.revenuedot.app`.
- `GET /auth/config` and `GET /auth/me` carry the edition and plan (`apps/server/src/routes/auth.ts`).
- Cron: `scheduled()` in `entry.worker.ts`; local runs go through `cf dev`'s explorer (`POST /cdn-cgi/local/explorer/api/local/scheduled?worker=revenuedot`, see `docs/cloud.md`).

## Tests that prove it
- `apps/server/test/signup.test.ts`: with `edition: "cloud"` two accounts sign up even when `signup` is `owner_only`, and `/auth/config` says `cloud` and `open`.
- All server, contract and dashboard tests run the shared `createApp` that the worker also runs, on PGlite through the Node build.
- `scripts/smoke-cloud.mjs` runs `entry.worker.ts` under `cf dev` against a Railway development database: sign-up, Test Store app, product, secret key, test purchase, subscriber with a verified `X-Signature`, dashboard SPA fallback and the scheduled handler. `--read-only` checks production without writes. Not in CI.

## Known gaps
- Live since 2026-09-30 at https://api.revenuedot.app and https://app.revenuedot.app (Hyperdrive `29af8eac2bfb43fe801c51d5bd20ee33`).
- No automated test in CI covers the worker entry, the per-request connection handling or the cron.
- Password hashes use 100,000 PBKDF2 iterations on both builds (the Workers cap), so hashes made with more iterations by older self-host builds cannot be verified on Workers.
- Nothing in the dashboard shows the plan.
