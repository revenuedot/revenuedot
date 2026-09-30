# RevenueDot scope

Status: draft for review (2026-09-30). Nothing here is built yet.

## The product in one line
An open-source server that the RevenueCat SDKs already talk to. An app moves by changing one line (the SDK's proxy URL) and keeps the rest of its code, its offerings and its customers.

## Principles
1. **Wire-compatible first, better second.** Match RevenueCat's SDK protocol, REST API v1/v2 and webhook payloads field for field. Innovate only in places that do not break a migration.
2. **Upstream fixtures are the spec.** The 142 JSON fixtures from the SDKs' own tests, plus RevenueCat's published OpenAPI files, become our contract tests. A change that breaks one of them does not merge.
3. **Same answers self-hosted and in the cloud.** One codebase: Hono + Postgres, run on Cloudflare Workers with Hyperdrive or in Docker.
4. **No brand borrowing.** We say "works with the RevenueCat SDK" in plain text. No RevenueCat names, logos or domains in our names.
5. **AI-native from day one.** Every dashboard action is also an API call and an MCP tool.

## How apps connect (three modes)
| Mode | What the developer changes | Limits | Tier |
|---|---|---|---|
| Proxy mode | One line: `Purchases.proxyURL = "https://api.revenuedot.com"` and turn signature checks off | Signature checks fail, so they must be turned off; Android still sends paywall and ad events to RevenueCat | 1 |
| Forked SDKs | Swap the package (`Purchases` class and methods keep their names) | None of the above | 1 (all SDKs) |
| Our own API keys | Nothing: the importer keeps the app's existing public key strings working | | 1 |

## Tier 1: minimal lovable product
Goal: an indie or small team on iOS, Android, React Native or Flutter moves off RevenueCat in one afternoon, with no data loss, and pays nothing to self-host.

| # | Feature | What "done" means |
|---|---|---|
| 1.1 | **SDK-compatible API** | All 37 SDK endpoints answer correctly. The core six (customer info, offerings, receipts, identify, config, attributes) are real, and the rest are safe stubs. Passes all upstream fixtures, plus a real purchase in sandbox on the iOS simulator and an Android emulator using the unmodified SDK |
| 1.2 | **Apple ingestion** | StoreKit 2 signed transactions and StoreKit 1 receipts through the App Store Server API; App Store Server Notifications v2 endpoint with signature checks; sandbox kept apart from production |
| 1.3 | **Google ingestion** | Play Developer API (subscriptions v2, one-time products); real-time notifications through Pub/Sub push; acknowledgement within Google's 3-day limit; voided purchases |
| 1.4 | **Entitlement engine** | Pure state machine: grace periods, billing retry, pause, refunds, upgrades and downgrades, lifetime, consumables, promotional grants. Every Apple and Google notification type is mapped to RevenueCat's event names |
| 1.5 | **Identity** | Anonymous IDs, `logIn`, aliasing and merging, and the four "restore belongs to whom" transfer settings, with the default matching RevenueCat's |
| 1.6 | **Catalog** | Projects, apps, products, entitlements, offerings, packages, metadata, current offering |
| 1.7 | **Webhooks out** | RevenueCat's payload shape and the core subscription events; authorization header plus HMAC signature; 5 retries; delivery log with replay |
| 1.8 | **REST API** | All 15 v1 endpoints; v2 for customers, subscriptions, purchases, entitlements, offerings, packages, products, apps and projects, with the same shapes, pagination and errors |
| 1.9 | **Migration** | `npx revenuedot import`, which runs on the customer's machine with their own export. It brings over the catalog, the public key strings, customers, attributes and transactions, and fires no webhooks. Current access is imported from the export, so no user loses access on switch day. Apple purchases are rebuilt from original transaction IDs through Apple's API. Google purchase tokens are looked up from the exported order IDs through Google's Orders API (`orders.batchget`, which returns `purchaseToken`), using the customer's own service account. Two backups fill any gaps: Google's renewal notifications carry the token, and the app calls `syncPurchases()` once after the update. **Notification forwarding** passes Apple and Google notifications on to RevenueCat during a dual-run |
| 1.10 | **Dashboard** | Sign-in, project setup wizard (Apple and Google keys, each validated with a live test call; notification URL with a "last received" time; forwarding URL), catalog editor, customer list and customer page with timeline, Overview cards (MRR, active subscriptions, trials, revenue, new and active customers) and live transaction feed, webhooks with delivery log, API keys, sandbox toggle, the "purchases seen on several user IDs" transfer setting, and an **SDK compatibility panel** (which SDK versions call us, and whether each is fully supported). Layout follows the RevenueCat study in `company/docs/research/contact-sheets/revenuecat/` |
| 1.11 | **Self-host** | `docker compose up` gives a working server, dashboard and Postgres. Upgrades run migrations automatically. There is one config file |
| 1.12 | **Cloud** | The same build on Workers plus Hyperdrive, with sign-up and a free plan. Billing plans come in Tier 2 |
| 1.13 | **SDK forks, all of them** | An automated fork pipeline (upstream tag → rename script → our signing key → our host → contract tests → publish) for iOS, Android, the shared hybrid layer, React Native (and its paywall UI), Flutter, web, Capacitor, Kotlin Multiplatform, Unity and Cordova. Order: the three core repos first, since every wrapper depends on them, then by downloads. Also fixes the Flutter web proxy bug and the web SDK's key-prefix check |
| 1.14 | **AI-native basics** | OAuth MCP server with about 12 tools (catalog, customers, grant and revoke entitlements, webhooks, import status); `llms.txt`; a "migrate from RevenueCat" agent skill |
| 1.15 | **Docs** | Quickstart, migration guide, a compatibility table by SDK version, self-host guide, API reference built from our OpenAPI |

**Tier 1 is out when** a real app runs a dual-run for a week, and its customer info and webhooks match RevenueCat's for every event.

## Tier 2: best-in-class, head to head
Goal: nothing a normal RevenueCat customer uses is missing, and we are clearly better on price, openness and data ownership.
- **Full v2 REST API** (128 endpoints, except the ones that only serve RevenueCat's own billing), plus the audit log and team roles.
- **All 21 webhook events**, and the top integrations: Slack, Segment, Amplitude, Mixpanel, PostHog, Firebase and BigQuery, AppsFlyer, Adjust, Meta. Scheduled data exports in CSV or Parquet to S3, R2 or GCS.
- **Charts:** all 41 named charts, matching RevenueCat's definitions (USD at the purchase-date rate, sandbox excluded), with the SQL published.
- **Paywalls:** serve the paywall JSON the SDKs already render (17 component types), a visual editor, an AI paywall generator and an asset CDN.
- **Targeting and placements; experiments** (offering A/B tests with statistics).
- **Customer Center config, virtual currencies, offline entitlements, promotional-offer signing, win-back offers.**
- **Stores:** Amazon, plus Stripe subscriptions from the customer's own Stripe account.
- **RevenueDot AI:** an in-app durable agent (Cloudflare Agents, ai-elements UI) that shares its tools with the MCP server.
- **One-line moves** between self-host and cloud, and a full export out.
- **Cloud billing:** plans and metering.

## Tier 3: dominant, enterprise-ready
Goal: the obvious default, including for regulated and very large apps.
- **The paid `ee/` folder:** SSO/SAML, SCIM, custom roles, several organizations, data-location controls (EU and US regions), long audit retention, compliance exports.
- **High-availability self-host:** Helm and Terraform reference setups, clustering, an SLA, AWS Marketplace listing.
- **Web billing:** hosted checkout on our own Stripe Connect platform, web-to-app funnels, redemption links.
- **Revenue recovery:** failed-payment recovery, refund defense (Apple consumption info), win-back flows. These are priced as a share of the money recovered.
- **More stores and tools:** Paddle, Roku, Galaxy; attribution; benchmarks (cloud only, anonymized); AI growth insights.

## Where the value is, in build order
1. **Contract test harness** from the upstream fixtures and a real-SDK sample app. Everything else is measured against it.
2. **Wire-compatible core:** endpoints 1.1, plus the Apple and Google ingestion and the entitlement engine (1.2 to 1.5).
3. **Migration path:** the importer and notification forwarding (1.9). This is what makes switching safe.
4. **Dashboard essentials and one-command self-host** (1.10, 1.11).
5. **SDK forks** (1.13), starting with the three core repos.
6. **Distribution:** docs, MCP, `llms.txt` (1.14, 1.15).

## Known limits and risks
- **Proxy mode.** Signature checks read as failed until the developer turns them off, or switches to our fork. Android still sends paywall and ad events to RevenueCat.
- **Transaction timing.** A 4xx from us on a receipt tells the SDK to finish the transaction for good, so any temporary failure must return 5xx.
- **Google Play migrations.** RevenueCat does not export purchase tokens; we recover them from order IDs through Google's Orders API. Still to test: how far back `orders.batchget` returns old orders, and its batch size limit.
- **Chart figures.** Prices, taxes and store fees in charts are RevenueCat's own estimates, so our revenue figures will differ slightly. We publish our method.
- **Undocumented mappings.** About 10 Apple and Google notification mappings are undocumented. We verify them during the first dual-run.

## Repos
One brand-named flagship monorepo plus one repo per SDK, as Supabase, PostHog and E2B do. The full map is in `revenuedot/company/WORKSPACE.md`; locally, `~/Developer/revenuedot/` mirrors the GitHub org.

| Repo | Visibility | Contents |
|---|---|---|
| `revenuedot/revenuedot` | public | server, dashboard, core, store adapters, db, CLI, docs, `ee/`, Docker self-host |
| `revenuedot/mcp` | public | OAuth MCP server (shares tool executors with the in-app agent) |
| `revenuedot/agent-skills` | public | agent skills, e.g. migrate from RevenueCat |
| `revenuedot/purchases-ios`, `purchases-android`, `purchases-hybrid-common`, `react-native-purchases`, `purchases-flutter`, `purchases-js`, `purchases-capacitor`, `purchases-kmp`, `purchases-unity`, `cordova-plugin-purchases` | public (MIT forks) | one repo per SDK, rebuilt from each upstream tag by the fork pipeline |
| `revenuedot/company` | private | research, business model, contact sheets, marketing logs |
