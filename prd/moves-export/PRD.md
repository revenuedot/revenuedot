# Full export and one-line moves between self-host and Cloud (Tier 2, batch G)

**Status:** built on branch `tier2-moves-billing` (migration `0022_moves_billing`). A project's whole state leaves any RevenueDot server as one versioned archive, and `npx revenuedot move` copies a project from one server to another with its ids, public SDK keys, secret API keys and webhook signing secrets, so apps and webhook receivers keep working after the switch.

## Users and jobs
- **A developer on self-host** moves to RevenueDot Cloud with one command (or the dashboard's "Move this project to Cloud"), keeps every customer, purchase and webhook, and changes nothing in the app if the old server forwards.
- **A developer on Cloud** moves to their own server the same way, because data ownership is the promise.
- **Anyone** downloads everything a project owns as files they can read (JSON Lines), keep as a backup, or load somewhere else.
- **Their apps and backends** keep working through the switch: the same public keys (`appl_`, `goog_`, `test_` …), the same `sk_` keys, the same project, app and customer ids in REST paths, the same webhook signatures.

## Essential now and later
Essential (this batch)
- `POST /v2/projects/{id}/exports`: an async export job, multi-tick and bounded for Workers, that writes a versioned archive (JSON Lines per table, gzip, plus a manifest with schema version, row counts and checksums). Secrets are left out unless the owner gives an export passphrase; then they are encrypted with it.
- Storage: R2 on Cloud when the `EXPORTS` bucket binding is set, otherwise Postgres (`archive_blobs`); on self-host the local disk (`REVENUEDOT_ARCHIVE_DIR`, default `.data/archives`), S3 or R2 (`REVENUEDOT_ARCHIVE_S3_*`), or Postgres. Archives are deleted after 7 days; download links expire after 1 hour.
- Import on the target: an account-level import token (`rdi_`, 24 hours) from "Receive a project", then `/v2/imports` accepts the manifest and the files, upserting rows by primary key (idempotent, resumable).
- `npx revenuedot export` and `npx revenuedot move` (dry run with a diff, resumable state file, verification of counts and checksums per table, cutover with `--finish`).
- Move states on the source (`paused`, `forwarded`) and the target (`incoming`): writes wait while data is copied, and a forwarded project proxies every SDK, REST and store notification request to the new server.
- Dashboard: Project settings → **Export and move** (export button with download, move to Cloud or to another server with progress, verify, finish and cancel), **Receive a project** on the target, and a banner on a moved project.

Later
- Incremental sync by change time (today every sync re-reads every table; fine up to a few million rows).
- An archive upload page in the dashboard (the CLI handles `--from-archive`).
- Moving RevenueDot AI conversations (they belong to a person, and on Cloud they live in Durable Objects).

## RevenueCat behaviour we match
RevenueCat has no way to move a project to another server and no full export: its scheduled data exports cover transactions only, and its project settings have no export button ([Scheduled data exports](https://www.revenuecat.com/docs/integrations/scheduled-data-exports)). There is nothing to match; the bar is our own promise in `prd/SCOPE.md` ("one line to move from self-host to cloud … one-command data export and import").

## 1. The archive
One archive per export, stored as separate objects under `exports/<project>/<export id>/` and downloaded as one uncompressed `.tar` built on the fly (each member is already gzip):

```
manifest.json
members.json                      email and role of each collaborator (no passwords)
tables/<table>/0001.jsonl.gz      one row per line: Postgres row_to_json of the stored row, UTC timestamps
secrets/<table>/0001.json.enc     only with a passphrase: secret columns, AES-256-GCM, PBKDF2-SHA-256 (100,000 rounds)
```

`manifest.json`:
- `format: "revenuedot-export"`, `version: 1`, `schema` (the last migration tag of the server that wrote it), `created_at`, `source` (`url`, `edition`), `project` (`id`, `name`).
- `tables[]`: `name`, `columns` (as stored), `rows`, `checksum` (hex of the sum, modulo 2^256, of the SHA-256 of every row line: independent of order and file boundaries, so a target can recompute it in any number of passes), `files[]` (`name`, `rows`, `bytes`, `sha256` of the gzip bytes).
- `secrets`: `{ included: false, columns }`, or `{ included: true, kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt }, files[] }`.
- `excluded[]`: what is not in the archive and why (below).

Rows are written exactly as stored (`row_to_json` with `TimeZone = UTC`), so an import is lossless: `json_populate_recordset` turns every value back into the same column type, arrays and JSON included.

### Tables
Every table that belongs to a project, 69 in all, in foreign-key order (`apps/server/src/services/archive/tables.ts`): the project row, apps, API keys (hashes only), catalog (products, entitlements, offerings, packages and their links), customers, aliases, attributes, subscriptions, one-time purchases, transactions, events, webhooks and their delivery log, integrations and their delivery log, data export jobs and runs, store notifications, alerts, SDK versions, in-app currencies (definitions, balances, ledger), audit log, paywalls with versions and media assets, saved charts, chart annotations and share links, audiences, targeting rules, experiments and enrollments, SDK events, customer activity, Refund Control, retention offers, support tickets, win-back campaigns and sends, email suppressions, web configs, web products, domains, purchase links, funnels and funnel events, web checkouts, discounts and codes, ad reward rules, verifications and ad units, share cards, Auth providers, identity links and sessions, blocked customers, Verified Metrics, Stripe Connect connections and payment recovery cases and emails.

### Secrets
Left out of the table files (the column is emptied and named in `manifest.secrets.columns`), and written to `secrets/` only with a passphrase:
- `apps.credentials` (App Store in-app purchase key, Google service account, shared secrets) and `apps.secrets` (Amazon and Stripe keys, sealed), with their hints.
- `integrations.secrets` and `export_jobs.secrets` (sealed), with their hints.
- `webhooks.signing_secret` and `webhooks.authorization_header`.
- `web_checkouts.redemption_seed`.

Sealed values are opened with the source server's key and sealed again with the target's (`REVENUEDOT_ENCRYPTION_KEY` or the signing-key derivation, `services/secrets.ts`). Without a passphrase the target gives each webhook a new signing secret, and lists the apps whose store credentials must be entered again. `npx revenuedot move` always uses a random passphrase it never prints, so a move keeps every secret.

### Not exported
- Collaborators' accounts and passwords: `members.json` lists email and role; on import everyone is listed to invite (nobody is added directly: members.json is client input, and adding the accounts it names would put people into a project without their consent and reveal which emails have an account). The importing user owns the project on the target.
- A custom domain's verification (`web_domains.verification_token`, `status`, `verified_at`, `checked_at`, `error`): DNS proves a domain to one server. The target gives the domain its own token and leaves it `pending`; the finish report lists it under `domains_to_verify`.
- RevenueDot AI conversations, files and usage (they belong to one person; on Cloud they live in Durable Objects).
- Pending invites, subscriber access tokens (one hour long), sessions, rate limits, OAuth codes.
- Exchange rates and remote-config blobs (shared by every project; the target has or rebuilds them).

## 2. Endpoints
Source (secret key with `project_configuration:projects:read_write`, or an Admin session):
- `POST /v2/projects/{id}/exports` `{ include_secrets?, passphrase? }` → 202, the export (`status: queued`). A passphrase needs 12 or more characters.
- `GET /v2/projects/{id}/exports`, `GET …/exports/{export_id}` (with `manifest` and a `download_url` once `succeeded`), `GET /v2/projects/{id}/export` (the latest), `DELETE …/exports/{export_id}`.
- `POST …/exports/{export_id}/actions/advance`: does one bounded slice now (about 10 seconds of work) and returns the export. The CLI drives exports with it; the tick also advances queued exports.
- `GET …/exports/{export_id}/files/{name}`: one archive file (the CLI reads files one by one).
- `GET /v2/exports/download/{token}`: the whole archive as a `.tar`, no other auth; the token is an HMAC of the export id and an expiry 1 hour ahead.
- `GET /v2/projects/{id}/move`, `POST …/move/pause`, `POST …/move/forward { to_url }`, `POST …/move/cancel`.
- Dashboard flow: `POST /v2/projects/{id}/move` `{ to_url, to_token, dry_run? }` starts a move this server runs (step machine in the tick and in `POST …/move/actions/advance`); `POST …/move/finish` cuts over; `POST …/move/cancel` stops it.

Target:
- `POST /v2/imports/tokens` (session; on Cloud a verified email) → `{ token: "rdi_…", expires_at }`, shown once.
- `POST /v2/imports` (`Authorization: Bearer rdi_…`) `{ manifest, passphrase?, dry_run?, replace? }` → the import (`id`, `project_id`, `plan`): schema check, conflicts (project id, public keys, slugs, domains), and per table the rows the target has now. `dry_run` writes nothing.
- `PUT /v2/imports/{import_id}/files/{name}`: one file; its SHA-256 must match the manifest. Tables upsert by primary key, only rows of this project: a key that belongs to another project's row is never updated. A row whose parent (by foreign key) is not on the target is left out and counted with its checksum (the source keeps serving while it is exported table by table, so a customer created after the customers table was read can have an alias in a later table); verification adds those rows back to the target's numbers and reports `skipped_rows`. A file already applied answers `{ applied: false }`. Sending a new manifest to the same import starts the incoming copy over.
- `POST /v2/imports/{import_id}/members` with `members.json`: returns them as `invite` (see Not exported).
- `POST /v2/imports/{import_id}/verify` → per table `rows` and `checksum` recomputed on the target (multi-call: answers `done: false` with a cursor until finished).
- `POST /v2/imports/{import_id}/finish` → the project goes live on the target and the answer lists the store notification URLs to change.
- `GET /v2/imports/{import_id}`.

## 3. Move states
`projects.move_state`:
- `incoming` (target, from the first file until finish): the tick does nothing for the project (no expirations, deliveries, exports, win-back sends), and SDK, notification and v2 writes answer 503 / 423, so the copy stays exactly the source's. An Admin may still delete the project (`DELETE /v2/projects/{id}`), so a copy that never finishes is not stuck.
- `paused` (source, during the final copy): reads are served; SDK writes (`POST /v1/receipts` …) and store notifications answer **503** with `Retry-After: 60` (the SDK keeps the transaction and retries; Apple and Google retry notifications); v2 writes answer 423 `resource_locked_error`. The tick does nothing for the project, so pending webhook deliveries move with the data and are sent exactly once, by the target.
- `forwarded` (source, after finish): every `/v1`, `/rcbilling` and secret-key `/v2` request for the project is proxied to `moved_to_url` with the same method, path, headers and body, and the target's answer (signature included) is returned. Store notifications too. The dashboard shows "This project moved to …" and refuses writes. A loop (a forwarded request arriving at a forwarded project) answers 508.
- `null`: normal.

Which project a request belongs to comes from the app's public key, the `sk_` key's hash, the subscriber token, the app id in a notification URL or the project id in a v2 path. The server keeps the short list of moving projects in memory for 5 seconds, so the common case costs nothing; the CLI waits 10 seconds after `pause` before the final copy.

## 4. `npx revenuedot move`
```
npx revenuedot move --from http://old-server:8787 --to https://api.revenuedot.app [--dry-run] [--finish] [--state file]
```
- Asks for the source secret key and the target import token with hidden input (or `REVENUEDOT_FROM_KEY`, `REVENUEDOT_TO_TOKEN`).
- Steps: export on the source (driven with `advance`), check on the target (`dry_run` diff: rows per table there now against the archive), copy every file (skipping files the state file says are done), the secrets and members, verify, and print the store notification URLs to change.
- `--dry-run` stops after the diff and writes nothing on either server.
- `--finish` (run after a copy, or alone): pause the source, wait 10 seconds, copy again (the target's incoming copy starts over, so rows deleted on the source since the first copy do not linger), verify, put the target live, forward the source. Any failure before the target goes live (verification, the network) cancels the pause, so the source keeps serving; running again pauses again.
- `--from-archive <file.tar>` reads an archive downloaded with `npx revenuedot export` instead of a server.
- Exit codes: 0 done, 1 failed or verification found differences, 2 usage error, 130 cancelled.

`npx revenuedot export --from <url> [--out file.tar] [--include-secrets]` (the passphrase is asked with hidden input, or `REVENUEDOT_EXPORT_PASSPHRASE`) creates an export, waits, and saves the archive.

## 5. Store notification URLs
The paths keep the app id, so only the host changes: `<new server>/v1/notifications/{apple|google|amazon|stripe}/{app_id}`. The finish answer and the CLI print, per app, where to change it: App Store Connect → App Information → App Store Server Notifications (production and sandbox URL), Play Console → Monetize → Monetization setup → Real-time developer notifications (the Pub/Sub push subscription's endpoint), Amazon Developer Console → Real-time Notifications (SNS subscription), Stripe Dashboard → Developers → Webhooks. Until they change, the old server forwards each notification (forwarded state), so nothing is lost.

## 6. Screens
- **Project settings → Export and move** (`/projects/:id/settings/export`): "Export project" (optional passphrase), a list of exports with status, size, rows and Download; **Move this project**: destination (RevenueDot Cloud, `https://api.revenuedot.app`, first; or another server's URL), the import token from the destination, "Check" (dry run with the diff table), "Copy data", progress, the verification table, "Finish move" (with the store URL list) and "Cancel".
- **Receive a project** (`/projects/receive`, linked from New project and the project switcher): creates the import token, shows the command and the token once.
- A project in `forwarded` state shows a banner with the new server's link; one in `incoming` shows "Being copied from …".

## Tests that prove it
- `apps/server/test/archive.test.ts`: a project seeded with every table exports and imports into a fresh database; every table's rows compare equal (secrets with a passphrase; without one the secret columns are empty and webhooks get new signing secrets); checksums match on both sides; resume after a part; a wrong passphrase is refused; a newer schema is refused.
- `apps/server/test/archive.test.ts` (move states): finish pauses the source, puts the target live and forwards SDK calls, notifications and REST calls; a forwarding loop answers 508; the dashboard's server-run move (dry run, copy, verify, finish).
- `apps/server/test/archive.test.ts` (a live source, import safety): a new app user created while the export runs is left out and counted, and the copy verifies; an archive row with another project's primary key changes nothing; a dry run hides another account's row counts; members are only listed; a verified custom domain arrives `pending` with a new token; an unfinished copy can be deleted; a passphrase export never reuses one with another passphrase; an expired download link stops at once.
- `packages/importer/test/move.test.ts`: two in-process servers on two databases; `revenuedot move` (dry run diff, copy, verify, finish with forwarding), bad keys and tokens refused before any work, `revenuedot export` to a tar that then moves into another server.
- Journey `scripts/e2e/journeys/move.ts`: two real Node servers on two Railway development databases; the unmodified purchases-js buys in Chromium before the move, `npx revenuedot move` moves the project, the old app build (still pointing at the old server) and a new build (pointing at the new one) both see the entitlement, a second purchase on the new server delivers a webhook signed with the original secret.
- Playwright `apps/dashboard/e2e/moves.spec.ts`: export and download, receive token, move with dry run, copy, verify and finish between two projects on the e2e server.

## Known gaps
- Each sync re-reads every table; a very large project (tens of millions of rows) takes long and the pause lasts as long as the last copy.
- Requests during the 5-second state cache window after `pause` can still write on Workers isolates that have not refreshed; the CLI waits 10 seconds before the final copy to cover it.
- Moving a project back to a server that still holds its forwarded copy needs `replace` (the CLI asks).
- The archive download is one `.tar` of gzip members, not a `.tar.gz`.
