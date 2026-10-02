# RevenueDot Cloud (Cloudflare Workers)

RevenueDot Cloud is the same Hono app as self-host, run on Cloudflare Workers with Postgres through Hyperdrive. It has
been live since 2026-09-30: sign-up is open at https://app.revenuedot.app and every account is on the free plan.
Everything is built and deployed with the [`cf` CLI](https://www.npmjs.com/package/cf) (not wrangler), on the
Cloudflare account **Circo** (`5a8f4d72ace5f438725e1dfd1b0380ff`), zone `revenuedot.app`. Production deploys run from
GitHub Actions on every push to `main` (see [Deploy](#deploy)).

| Host | Worker | Source | What it serves |
| --- | --- | --- | --- |
| https://api.revenuedot.app | `revenuedot` | `apps/server` | The whole API (SDK `/v1`, REST `/v2`, `/auth`, OAuth, `/.well-known`) |
| https://app.revenuedot.app | `revenuedot` | `apps/server` + `apps/dashboard` | The dashboard (static assets, single-page fallback) plus same-origin API calls |
| https://mcp.revenuedot.app | `revenuedot-mcp` | [revenuedot/mcp](https://github.com/revenuedot/mcp) | The hosted MCP server (`/mcp`), pointed at `https://api.revenuedot.app` |
| https://revenuedot.app | `revenuedot-site` | `apps/site` | The marketing site and docs (static assets only) |
| https://www.revenuedot.app | `revenuedot-site` | zone redirect rule | 301 to `https://revenuedot.app` with the path and query kept |

| Piece | Where |
| --- | --- |
| Worker entry | `apps/server/src/entry.worker.ts` |
| Config | `apps/server/cloudflare.config.ts` (worker, domains, cron, bindings) and `apps/server/vite.config.ts` (bundling, dashboard assets) |
| Workers build of the db package | `packages/db/src/worker.ts` (picked by the `workerd` export condition) |
| Postgres | Railway `production` environment, through the Hyperdrive config `revenuedot` (id `29af8eac2bfb43fe801c51d5bd20ee33`) |
| Migrations | `scripts/migrate.ts` (`pnpm migrate`), run from Node before each deploy |
| Deploy | `scripts/deploy-cloud.sh` (`pnpm deploy:cloud`) |
| Smoke test | `scripts/smoke-cloud.mjs <base URL>` |

Every account is on the `free` plan (`users.plan`) until billing plans ship. `/auth/me` returns
`account: { edition: "cloud", plan }` on the cloud build.

## Requirements

- **Node 24** (`.nvmrc`; CI uses the same file). `cf` itself needs Node 22.18 or newer: it loads `cloudflare.config.ts`
  with Node's module hooks and refuses older versions.
- **`cf auth login`** as a user with access to the Circo account. The account is selected by `accountId` in each
  `cloudflare.config.ts` (the Circo id); set `CLOUDFLARE_ACCOUNT_ID` to override it. Run `cf` from the folder that has
  the `cloudflare.config.ts` so it picks up that account.
- `WRANGLER_DOCKER_BIN=false` if Docker is installed but not running: the Vite plugin otherwise waits forever on
  `docker image ls`. The deploy scripts set it; none of the workers use containers.

## Local development

No local Postgres. Use the Railway Postgres in the `development` environment (project RevenueDot) with a database of your own on it. The `production` environment is only for RevenueDot Cloud.

```sh
source ~/.config/revenuedot/dev.env            # REVENUEDOT_DEV_DATABASE_URL; never print or commit it
psql "$REVENUEDOT_DEV_DATABASE_URL" -c 'CREATE DATABASE rd_yourname'
export REVENUEDOT_LOCAL_DATABASE_URL=$(node -e 'const u=new URL(process.env.REVENUEDOT_DEV_DATABASE_URL);u.pathname="/rd_yourname";console.log(u.toString())')
pnpm migrate "$REVENUEDOT_LOCAL_DATABASE_URL"
pnpm --filter @revenuedot/dashboard build      # the worker serves apps/dashboard/dist
cd apps/server && pnpm exec cf dev             # prints the local URL (http://localhost:5173 unless taken)
node ../../scripts/smoke-cloud.mjs http://localhost:5173
```

- `cf dev` connects the `HYPERDRIVE` binding to `REVENUEDOT_LOCAL_DATABASE_URL`.
- Set `REVENUEDOT_API_URL` and `REVENUEDOT_PUBLIC_URL` to the local URL in the shell that runs `cf dev` (for example
  `REVENUEDOT_API_URL=http://localhost:5615 REVENUEDOT_PUBLIC_URL=http://localhost:5615 pnpm exec cf dev --port 5615`).
  Without them, SDK snippets, paywall assets, web pay pages and email links point at api. and app.revenuedot.app.
  `.dev.vars` only fills secrets declared in `cloudflare.config.ts`, so these do not work from there.
- To test response signing, put `REVENUEDOT_SIGNING_KEY=...` (from `pnpm tsx scripts/signing-keygen.ts`) in
  `apps/server/.dev.vars` (gitignored) and restart `cf dev`.
- The smoke test signs up, creates a Test Store app, a product and a secret key, makes a test purchase, reads the
  subscriber back and verifies its `X-Signature`, checks the dashboard and runs the scheduled handler through the local
  explorer (`POST /cdn-cgi/local/explorer/api/local/scheduled?worker=revenuedot`). Drop your database when you are done.

### RevenueDot AI locally
Each conversation is a Cloudflare Agents Durable Object (`AssistantAgent`, prd/ai-assistant/PRD.md). Workers AI needs a
remote binding, so locally run the scripted fake model instead:

```sh
cd apps/server && REVENUEDOT_ASSISTANT_FAKE=1 WRANGLER_DOCKER_BIN=false pnpm exec cf dev --port 5409
cd apps/dashboard && node e2e/do-smoke.mjs http://localhost:5409
```

The smoke test asks a question, reloads (the transcript comes back from the Durable Object), approves a grant, checks
the audit log, checks that another user and a signed-out browser cannot open the conversation's socket, and deletes it.
`REVENUEDOT_ASSISTANT_FAKE` is read only when set in the shell that runs `cf dev`; never set it for a deploy.
Approval cards are signed with `REVENUEDOT_ENCRYPTION_KEY` (else `REVENUEDOT_SIGNING_KEY`). The Durable Object keeps
the transcript the browser sends, so without either key it offers no write tools: put `REVENUEDOT_SIGNING_KEY` in
`.dev.vars` (above) before the smoke test. Production has the signing key.

## Deploy

```sh
pnpm deploy:cloud --dry-run    # builds and bundles, no migrations, no upload
pnpm deploy:cloud              # dashboard build, Hyperdrive lookup, migrations, cf deploy
node scripts/smoke-cloud.mjs https://api.revenuedot.app --read-only --app https://app.revenuedot.app \
  --public-key gXdn2hmqR/TbdtQwK02laE0YgFz0Rtf918LICLrgZhg=
```

Production deploys run from GitHub Actions (`.github/workflows/deploy.yml`) on every push to `main` once CI passes, with
the GitHub `production` environment's secrets. The workflow looks at the changed paths: server, dashboard, package and
migration changes run migrations, deploy the Worker and run the read-only smoke test above against production; site,
design and brand changes deploy the site. `scripts/deploy-cloud.sh` reads the production URL from `CLOUD_DATABASE_URL`
(a manual deploy must set it too). Unless `REVENUEDOT_HYPERDRIVE_ID`
is set (CI sets it), it looks up the Hyperdrive config named `revenuedot` and passes its id to
`cloudflare.config.ts` as `REVENUEDOT_HYPERDRIVE_ID`. If there is none, it creates one, writing the connection details
to a mode-600 temp file that it deletes. Deploy from a clean checkout of `main`: the script deploys and migrates whatever
is in the working tree. Never run the full smoke test against production; `--read-only` makes no writes.

The response-signing root key is the secret `REVENUEDOT_SIGNING_KEY` (public key
`gXdn2hmqR/TbdtQwK02laE0YgFz0Rtf918LICLrgZhg=`). It was uploaded on the first deploy with
`pnpm deploy:cloud --secrets-file <file>`; later versions keep it. The master copy is kept in the team's password
manager, not on disk. To rotate it, write a new key to a temp file, pass it with the same flag, then delete the file.

The site and the MCP server also deploy from CI: a push to `main` in [revenuedot/docs](https://github.com/revenuedot/docs)
runs its `deploy-site.yml` (docs checks, then the site), and a push to `main` in
[revenuedot/mcp](https://github.com/revenuedot/mcp) runs its `ci.yml` (tests, deploy, then a live check). By hand:

```sh
pnpm --filter site run deploy               # Astro build, checks, then cf deploy --prebuilt (apps/site/cloudflare.config.ts)
cd ../mcp && pnpm run deploy                # cf deploy (mcp/cloudflare.config.ts)
```

The site's build reads the docs repo at `../docs` (override with `DOCS_DIR`). `cf build` on its own would run
`astro build` without the Pagefind step, so the site's deploy script runs its own build and packages `dist/` with the
Cloudflare Vite plugin.

## Zone settings

- Custom domains (apex, `www`, `app`, `api`, `mcp`) are attached by `cf deploy` from each `cloudflare.config.ts`; each
  gets a proxied DNS record and a Google Trust Services edge certificate.
- `www.revenuedot.app` → `https://revenuedot.app` is a Single Redirect rule in the zone's
  `http_request_dynamic_redirect` phase (301, path and query kept).
- The site sends HSTS and its security headers from `apps/site/public/_headers`.
- `http://` requests on every host answer 301 to `https://` (checked 2026-09-30). `api.revenuedot.app` sends
  `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Change zone settings with
  `cf zones settings edit <setting> -z revenuedot.app`.

## Hosted web pages and custom domains (manual steps, need Kai's approval)

Purchase links, funnels and redemption links (`prd/web-billing/PRD.md`) are served by the `revenuedot` Worker. Until the
steps below are done, Cloud serves them at `https://api.revenuedot.app/pay/<project>/<page>` (the default `payUrl` in
`entry.worker.ts`), which works today without any account change.

1. **`pay.revenuedot.app`** (nicer links): add `pay.revenuedot.app` to `domains` in `apps/server/cloudflare.config.ts`
   (`cf deploy` then creates the proxied DNS record and the certificate) and set the Worker variable
   `REVENUEDOT_PAY_URL=https://pay.revenuedot.app`. The Worker already serves any host other than `app.` at the root
   (`entry.worker.ts`), and `app.ts` serves the pay host's paths without the `/pay` prefix. Existing links on
   `api.revenuedot.app/pay/…` keep working.
2. **Customers' custom domains** (Cloudflare for SaaS, on the `revenuedot.app` zone):
   - Enable Cloudflare for SaaS on the zone and create a fallback origin, for example `domains.revenuedot.app`
     (a proxied DNS record; the Worker route `*/*` on the zone's custom hostnames, or a route for the fallback host,
     sends the traffic to the `revenuedot` Worker).
   - Set `REVENUEDOT_CUSTOM_DOMAIN_TARGET=domains.revenuedot.app`, so the dashboard tells customers to CNAME there.
   - For each customer domain that the dashboard shows as verified (CNAME and TXT checked by the server), add a custom
     hostname: SSL/TLS → Custom Hostnames → Add, the customer's hostname, HTTP DCV. The certificate is issued once the
     CNAME resolves. Automating this needs an API token with "SSL and Certificates: Edit" on the zone, which is an
     account change; until then it is done by hand.
   - Self-hosted servers need none of this: the custom domain points at the server, which answers the verified host.

## Workers differences from self-host

- Password hashing uses 100,000 PBKDF2 iterations (the Workers WebCrypto cap) on both builds. Hashes made with more
  iterations by older self-host builds cannot be verified on Workers.
- Each request opens its own Postgres connection (Hyperdrive pools). Webhook deliveries kicked by a request run after
  the response on that request's connection; the every-minute cron runs expirations, voided purchases and deliveries.
