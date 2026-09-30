<!-- Source of the docs page "Migrate from RevenueCat" (docs-src/importer.md, published at https://revenuedot.app/docs/migrate). Edit here. -->

# Migrate from RevenueCat with `npx revenuedot import`

`revenuedot import` copies a RevenueCat project into your RevenueDot server: apps, SDK keys, products, entitlements, offerings, packages, customers, aliases, attributes, subscriptions and one-time purchases. It fires no webhooks, so nothing downstream sees duplicate purchases. Every customer keeps the access they have today.

It runs on your machine, reads RevenueCat through its REST API v2, and writes to RevenueDot through its REST API. You can stop it and run it again at any time: it resumes where it stopped, and a second run changes nothing that is already right.

## What you need

1. **A RevenueCat secret API key (v2).** In RevenueCat, open Project settings > API keys > New secret API key, choose version V2, and give it read access to:
   - Project configuration: apps, products, entitlements, offerings, packages
   - Customer information: customers, subscriptions, purchases
2. **Your RevenueCat project id.** It starts with `proj` and is in the dashboard URL.
3. **A RevenueDot server**: RevenueDot Cloud (`https://api.revenuedot.app`, sign up at https://app.revenuedot.app) or your own (for example `docker compose up`, then `http://localhost:8787`), and **a RevenueDot secret key** for the project you are importing into (Dashboard > API keys).
4. Node.js 18.17 or newer.

You can pass the keys as environment variables instead of flags, so they stay out of your shell history: `REVENUECAT_API_KEY`, `REVENUEDOT_API_KEY`, `REVENUEDOT_URL`.

The `revenuedot` package is not on npm yet (2026-09-30), so `npx revenuedot` answers 404. Until it is published, run it from a clone of [revenuedot/revenuedot](https://github.com/revenuedot/revenuedot): `pnpm install`, then replace `npx revenuedot` with `pnpm --filter revenuedot cli` in the commands below. pnpm runs it in `packages/importer`, so give file flags such as `--google-tokens` absolute paths.

## Step 1: dry run

```sh
npx revenuedot import --from-revenuecat --rc-key sk_... --rc-project proj... \
  --to http://localhost:8787 --to-key sk_... --dry-run
```

This reads everything and prints what it would create. It writes nothing.

## Step 2: import

Run the same command without `--dry-run`:

```sh
npx revenuedot import --from-revenuecat --rc-key sk_... --rc-project proj... \
  --to http://localhost:8787 --to-key sk_...
```

Progress shows on one line. At the end you get a report: what was created, what already existed, how many customers, subscriptions and purchases came over, and a list of problems.

The import makes about 5 requests per customer. RevenueCat allows 480 requests a minute, so expect about 90 customers a minute (100,000 customers take about 18 hours). When RevenueCat answers 429, the importer waits for the time in `Retry-After` and carries on.

If it stops (a network error, Ctrl-C, a closed laptop), run the same command again. The state file `revenuedot-import-<project>.json` records the last page that finished, and the import continues from there.

## Step 3: enter your store credentials

Store secrets cannot be read back out of RevenueCat. The report lists every app that needs them. Add them in the RevenueDot dashboard (Apps > your app):

- **App Store:** the In-App Purchase key (.p8 file, key ID, issuer ID).
- **Google Play:** the service account JSON, with the "View financial data" permission.
- **Amazon, Stripe, Paddle, Roku:** their API key or shared key.

Then run the import once more. With the keys in place, RevenueDot:

- asks Apple for the `original_transaction_id` of every App Store subscription, and
- looks up the Google Play purchase token of every Play subscription from its order id (`orders.batchGet`).

Both matter: they are how RevenueDot recognises the imported subscription when the store or the app reports on it later, instead of creating a second one.

## Step 4: verify

```sh
npx revenuedot import verify --rc-key sk_... --rc-project proj... \
  --to http://localhost:8787 --to-key sk_...
```

For every customer it compares the active entitlements, their expiry dates and the number of subscriptions that give access. It prints the totals and every difference, and exits with code 1 when there is one. Purchases made since the import show up as differences: run the import again, then verify again.

## Step 5: cut over

```sh
npx revenuedot import plan --to http://localhost:8787 --to-key sk_... --rc-project proj...
```

This prints the cutover steps for your project, with your app ids and URLs filled in:

1. **Run side by side.** Point App Store Server Notifications at RevenueDot and set each app's forwarding URL to RevenueCat's notification URL, so RevenueCat keeps working. For Google Play, add a second push subscription to your Pub/Sub topic that points at RevenueDot.
2. **Ship an app update** that sets the SDK's proxy URL to your RevenueDot server (`Purchases.proxyURL` on iOS and Android, `Purchases.setProxyURL` in React Native and Flutter). Your SDK keys stay the same: the import kept them.
3. **Keep re-running the import** while older app versions still talk to RevenueCat. It is idempotent, so a daily run is safe.
4. **Finish:** when verify shows no differences, remove the forwarding URLs, create your webhooks in RevenueDot and turn off RevenueCat's.

Do not add webhooks in RevenueDot before step 4, or both systems will send them for the same purchase.

## What comes over

| Data | How |
|---|---|
| Apps | Matched by store and bundle id or package name, created if missing |
| SDK keys (`appl_`, `goog_` ...) | The production key of each app, so shipped app builds keep working |
| Store credentials | **Not exportable.** The report lists what to re-enter |
| Products | Matched by app and store product id; archived ones stay archived |
| Entitlements | Matched by identifier; product attachments added |
| Offerings and packages | Matched by identifier; metadata, positions, product attachments and the current offering follow RevenueCat |
| Customers | First seen and last seen dates, platform, country, app version |
| Aliases | Every app user id; customers RevenueDot already has under any of them are merged into one |
| Attributes | With their original update times |
| Subscriptions | Current period, status, auto-renew, grace period, billing issues, sandbox flag, family sharing, price, every store transaction id |
| One-time purchases | Transaction id, date, price, refunds, consumable or not |
| Promotional access | As promotional grants for the same entitlements |
| Revenue history | One row per store transaction, for charts |
| Targeting rules, experiments, paywalls, integrations | Not yet |

## Google Play purchase tokens

RevenueCat's API gives order ids, not purchase tokens, and Google needs the token. RevenueDot fills them in three ways:

1. **Your service account** (step 3): RevenueDot looks up each token by order id.
2. **A token file:** if you have the tokens (RevenueCat support can export them), pass `--google-tokens tokens.csv`. The CSV needs a `purchase_token` column plus either `order_id`, or `app_user_id` and `product_id`.
3. **Later, automatically:** the next renewal notification from Google carries the token, and so does the app when it calls `syncPurchases()` once after the update.

Until a subscription has its token it is marked `needs_token_refresh`. The customer keeps access either way. `GET /v2/projects/{id}/import/status` shows how many are left.

## Options

| Flag | Meaning |
|---|---|
| `--rc-key` | RevenueCat secret key, v2 (or `REVENUECAT_API_KEY`) |
| `--rc-project` | RevenueCat project id |
| `--to` | RevenueDot server URL (or `REVENUEDOT_URL`) |
| `--to-key` | RevenueDot secret key (or `REVENUEDOT_API_KEY`) |
| `--to-project` | RevenueDot project id, when the key can see several |
| `--state <file>` | Where to keep progress (default `./revenuedot-import-<project>.json`) |
| `--dry-run` | Read and report only |
| `--restart` | Ignore the state file and start from the first customer |
| `--concurrency <n>` | Customers fetched in parallel (default 4) |
| `--limit <n>` | Import only the first n customers, for a trial |
| `--google-tokens <csv>` | Google purchase tokens you already have |
| `--no-public-keys` | Keep RevenueDot's own SDK keys |
| `--emit-events` | Record lifecycle events and send webhooks for imported purchases (off by default) |
| `--json` | Machine-readable report |

Exit codes: 0 success, 1 failure (or differences, for `verify`), 2 wrong usage.

## Import from another system

The importer writes through one endpoint that you can call yourself, for example to import from your own database:

```http
POST /v2/projects/{project_id}/import/customers
Authorization: Bearer sk_...
Content-Type: application/json

{
  "customers": [{
    "id": "user_123",
    "aliases": ["$RCAnonymousID:0f3c..."],
    "first_seen_at": 1719830400000,
    "attributes": [{ "name": "$email", "value": "a@example.com", "updated_at": 1719830400000 }],
    "subscriptions": [{
      "app_id": "app1a2b3c4d", "store": "app_store", "product_identifier": "pro_monthly", "environment": "production",
      "starts_at": 1719830400000, "current_period_starts_at": 1725105600000, "current_period_ends_at": 1727784000000,
      "status": "active", "auto_renewal_status": "will_renew",
      "store_subscription_identifier": "2000000712345678", "original_transaction_id": "2000000612345678"
    }],
    "purchases": [{
      "app_id": "app1a2b3c4d", "store": "app_store", "product_identifier": "lifetime", "purchased_at": 1719830400000,
      "store_purchase_identifier": "2000000512345678", "status": "owned"
    }]
  }]
}
```

- Up to 100 customers per call. Dates are milliseconds since 1970.
- Subscriptions are keyed the way the stores report them: App Store by `original_transaction_id`, Google Play by `purchase_token` (send it when you have it), others by `store_subscription_identifier`.
- Nothing is sent to webhooks unless you add `"emit_events": true`.
- `POST /v2/projects/{project_id}/import/apps/{app_id}/public_key` with `{"public_key": "appl_..."}` keeps an app's existing SDK key.

## Use it from code

```ts
import { runImport, formatReport } from "revenuedot";

const report = await runImport({
  rcKey: process.env.REVENUECAT_API_KEY!, rcProject: "proj1ab2c3d4",
  to: "http://localhost:8787", toKey: process.env.REVENUEDOT_API_KEY!,
  statePath: "./import-state.json",
});
console.log(formatReport(report));
```

`verifyImport` and `buildPlan` are exported too.

## Developing

From the repository root: `pnpm --filter revenuedot cli import --help`. Tests (`npx vitest run packages/importer`) run the importer against a fake RevenueCat API, whose responses are checked against RevenueCat's published OpenAPI schemas, and the real RevenueDot server.

License: MIT.
