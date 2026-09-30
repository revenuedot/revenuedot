# RevenueDot Cloud (Cloudflare Workers)

RevenueDot Cloud is the same Hono app as self-host, run on Cloudflare Workers with Postgres through Hyperdrive.
One worker serves `api.revenuedot.app` (all API) and `app.revenuedot.app` (dashboard plus same-origin API calls).

| Piece | Where |
| --- | --- |
| Worker entry | `apps/server/src/entry.worker.ts` |
| Config | `apps/server/wrangler.jsonc` |
| Workers build of the db package | `packages/db/src/worker.ts` (picked by the `workerd` export condition) |
| Migrations | `scripts/migrate.ts` (`pnpm migrate`), run from Node before each deploy |
| Deploy | `scripts/deploy-cloud.sh` (`pnpm deploy:cloud`) |

Every account is on the `free` plan (`users.plan`) until billing plans ship. `/auth/me` returns
`account: { edition: "cloud", plan }` on the cloud build.

## Local development

No local Postgres. Use the Railway dev Postgres (project RevenueDot) with a database of your own on it.

```sh
source ~/.config/revenuedot/dev.env            # REVENUEDOT_DEV_DATABASE_URL; never print or commit it
psql "$REVENUEDOT_DEV_DATABASE_URL" -c 'CREATE DATABASE rd_yourname'
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=$(node -e 'const u=new URL(process.env.REVENUEDOT_DEV_DATABASE_URL);u.pathname="/rd_yourname";console.log(u.toString())')
pnpm migrate "$CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE"
pnpm --filter @revenuedot/dashboard build      # the worker serves apps/dashboard/dist
cd apps/server && pnpm exec wrangler dev --test-scheduled
```

- To test response signing, put `REVENUEDOT_SIGNING_KEY=...` (from `pnpm tsx scripts/signing-keygen.ts`) in
  `apps/server/.dev.vars` (gitignored) and restart `wrangler dev`.
- Run the cron once with `curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'`.
- `wrangler dev` rewrites request URLs to the first route's host, so `app.revenuedot.app` stays first in `routes`.

## First deploy

1. `wrangler login` with the Circo account.
2. Create the production Postgres and the Hyperdrive config:
   `wrangler hyperdrive create revenuedot --connection-string=postgres://...`. Put the id in `wrangler.jsonc`.
3. Set the signing key once: `pnpm tsx scripts/signing-keygen.ts`, then `wrangler secret put REVENUEDOT_SIGNING_KEY`.
4. `CLOUD_DATABASE_URL=postgres://... pnpm deploy:cloud` (builds the dashboard, migrates, `wrangler deploy`).
   `pnpm deploy:cloud --dry-run` builds and bundles without migrating or deploying.

## Workers differences from self-host

- Password hashing uses 100,000 PBKDF2 iterations (the Workers WebCrypto cap) on both builds. Hashes made with more
  iterations by older self-host builds cannot be verified on Workers.
- Each request opens its own Postgres connection (Hyperdrive pools). Webhook deliveries kicked by a request run after
  the response on that request's connection; the every-minute cron runs expirations, voided purchases and deliveries.
