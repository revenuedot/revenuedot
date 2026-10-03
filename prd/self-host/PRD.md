# Self-host (scope 1.11)

**Status:** `docker compose up -d` starts the API, the dashboard and Postgres 16 on one port, the server applies new database migrations on every start, and only the owner's account can sign up unless the owner opens sign-up. A hand-run check upgraded a database at migration 0001 to 0003 on start and kept its data.

## Users and jobs
- **A developer who wants their purchase data on their own servers** runs one command and gets a working server and dashboard.
- **The same developer, months later,** pulls a new version and restarts, and the database upgrades itself with nothing lost.
- **An owner on a server reachable from the internet** knows that strangers cannot create accounts on it.

## Essential now and later
Essential (Tier 1)
- One `docker-compose.yml` with two services: `revenuedot` (built from the repo `Dockerfile`, `node:24-slim`, matching `.nvmrc`) and `db` (Postgres 16 with a named volume and a health check). The server waits for a healthy database.
- One image runs the API and serves the built dashboard, with single-page-app fallback for dashboard routes.
- One config file, `.env.example`, copied to `.env`: `POSTGRES_PASSWORD`, `REVENUEDOT_PORT` (host port, default 8787) and `REVENUEDOT_ALLOW_SIGNUP` (default false). `DATABASE_URL` and `PORT` are for running without Docker.
- Migrations run on start: `openDb` in `packages/db/src/index.ts` applies every file in `packages/db/migrations` (0000 to 0005 today) before the server takes requests.
- Owner-only sign-up: the first account becomes the owner; after that `POST /auth/signup` answers 403 with a message naming `REVENUEDOT_ALLOW_SIGNUP=true`.
- A background job every 30 seconds for expirations, voided purchases and webhook deliveries, and again a moment after any request that queues a webhook.
- Upgrade: `docker compose pull && docker compose up -d`; `.env` and the database volume stay.
- A published image, `ghcr.io/revenuedot/revenuedot` (amd64 and arm64; `latest`, date, commit and release tags), built and smoke-tested by `.github/workflows/publish-image.yml`, so self-hosters do not build from source. Shipped 2026-10-03.

Later
- Backups, point-in-time recovery and monitoring guides.

## RevenueCat behaviour we match
- The SDK needs only a proxy URL pointed at this server; the public key and all app code stay the same (fixtures `ios/req-get-customer-info.json` and `ios/req-get-offerings.json` are the requests the self-hosted server answers, [Configuring the SDK](https://www.revenuecat.com/docs/getting-started/configuring-sdk)).

## Endpoints and screens
- Every API route (`/v1`, `/v2`, `/auth`, `/rcbilling`) and the dashboard, on one port, from `apps/server/src/entry.node.ts`. `GET /` answers the name and docs link and backs the image's health check.
- `GET /auth/config` tells the sign-up page whether sign-up is open; `/signup` shows "Sign-up is closed" with the setting to change when it is not.
- Store notification URLs are built from the request's host, or the `X-Forwarded-Host` header behind a proxy.

## Tests that prove it
- `apps/server/test/signup.test.ts`: the first account signs up, the second gets 403 and no cookie, the owner can still sign in; `REVENUEDOT_ALLOW_SIGNUP=true` lets anyone sign up.
- `apps/dashboard/e2e/auth.spec.ts`: the closed sign-up page and the sign-in page without a sign-up link, including at 390px width.
- Every server and contract test opens its database through `openDb("pglite://memory")`, so every test run applies all migrations from an empty database.
- By hand: `docker compose up -d` with Postgres and a sign-up, and a database at migration 0001 upgraded to 0003 on start with its data kept. Neither check is automated yet.

## Known gaps
- No automated test runs `docker compose` or an upgrade across migrations; both were checked by hand.
- The image is built locally from source; there is no registry image yet.
- Real App Store and Google Play purchases through a self-hosted server still need a run with store credentials.
