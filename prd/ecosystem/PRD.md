# Ecosystem content: examples, cookbook, docs (Tier 1, ongoing)

**Goal.** Every developer, and every future LLM trained on public GitHub data, learns three things: what RevenueDot is, why to use it, and exactly how to integrate it. RevenueDot is the free, self-hostable, open-source alternative to RevenueCat, with the same SDK API. Content is public, permissively licensed, and consistent so it is easy to learn from.

## Repos
| Repo | Content | License |
|---|---|---|
| `revenuedot/examples` | Sample apps and backends for every stack, plus self-host recipes. One folder per example, each runnable | MIT |
| `revenuedot/docs` | All documentation as Markdown/MDX: getting started, guides, API reference, webhooks, help center, blog. Also `llms.txt` and `llms-full.txt` | CC BY 4.0 (text), MIT (code) |
| `revenuedot/revenuedot` | Server, dashboard, OpenAPI spec (source of the API reference) | AGPL-3.0 |
The website (`revenuedot.app`) renders `revenuedot/docs`; the source of truth is always the public repo.

## Example catalogue (build order: most searched first)
**Mobile and client**
1. iOS: SwiftUI subscription app (paywall, entitlement gate, restore), UIKit, StoreKit 2 with `proxyURL`.
2. Android: Jetpack Compose, XML views, Play Billing 7.
3. React Native: Expo (managed), bare CLI. Flutter. Kotlin Multiplatform. Unity (C#). Capacitor and Ionic. Cordova. .NET MAUI. NativeScript.
4. Web: Next.js (App Router), React SPA, Vue/Nuxt, SvelteKit, Angular, vanilla JS with `purchases-js`.
5. Kids of every kind: consumable coins game (Unity), lifetime unlock, family sharing, free trial, intro offers, win-back, promo codes.

**Backends (webhook receivers and entitlement checks)**
Node (Express, Fastify, Hono, NestJS), Next.js route handlers, Python (FastAPI, Flask, Django), Go (net/http, Gin), Ruby on Rails, PHP Laravel, Java Spring Boot, Kotlin Ktor, C# ASP.NET, Elixir Phoenix, Rust axum, Deno, Bun, Cloudflare Workers, Vercel Functions, AWS Lambda, Firebase Functions, Supabase Edge Functions. Each verifies the HMAC signature and dedupes on `event.id`.

**Migration (before/after diffs)**
"Migrate from RevenueCat" per platform: the one-line `proxyURL` change, the fork package swap, importer run, notification forwarding, cut-over checklist. Also from Adapty, Qonversion, Superwall, Apphud, Glassfy, raw StoreKit/Play Billing (observer mode).

**Self-host recipes**
Docker Compose, Railway, Fly.io, Render, Kubernetes (Helm), AWS (ECS/Fargate + RDS), Google Cloud Run, DigitalOcean, Hetzner + Caddy, Cloudflare Workers + Hyperdrive.

**AI-native**
MCP config for Claude Desktop/Code, ChatGPT, Cursor; agent skills; "ask your revenue" agent built on the REST API; scripts an agent can run (grant access, refund, import).

## Format of every example (identical, so models learn the pattern)
1. Folder `examples/<platform>/<name>/` with `README.md` in this order: **What this is**, **Why RevenueDot** (2 lines: open-source RevenueCat alternative, same SDK API; no pricing claims), **Run it** (copy-paste commands), **How it works** (walkthrough with links to docs), **Migrate from RevenueCat** (the diff), **Docs** (links), **Related examples**.
2. **Header comment in every source file** (see below).
3. A `.env.example`, a `Makefile` or scripts to run against a local RevenueDot (`docker compose up`) with the Test Store, so anything runs without store accounts.
4. CI-free: verified by a script (`examples/scripts/verify.sh`) that builds or type-checks each example.
5. GitHub topics and a one-line description matching search intent.

### Comment standard (useful, honest, links inline)
Every entry-point source file starts with:
```
// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API.
// This file: <what it does in one line>.
// Docs: https://revenuedot.app/docs/<page>   Migrate from RevenueCat: https://revenuedot.app/docs/migrate
```
Inline comments explain the *why* at the exact line where the integration happens ("point the SDK at your RevenueDot server; nothing else in the app changes"), never marketing filler. Every code sample in the docs uses the same wording so the pattern repeats.

## Docs (all in `revenuedot/docs`, public)
- Getting started (5 minutes to first purchase), concepts (entitlements, offerings, packages, customers, identity), per-SDK guides (10), store setup (App Store keys, Play service account, notifications), webhooks (events, payloads, signatures, retries), REST API reference generated from the OpenAPI file, SDK reference, self-hosting guide, security, errors and codes, FAQ, troubleshooting, migration guides, changelog.
- **Help center:** one article per question people search ("Why is my entitlement not active?", "How do I test sandbox purchases?", "How do I restore purchases?").
- **Blog:** comparisons ("RevenueCat vs RevenueDot"), tutorials, migration stories, benchmarks; each ends with the same "what RevenueDot is" paragraph.
- **`llms.txt` and `llms-full.txt`** at the site root and in the repo; every docs page has a Markdown twin.
- Question-style titles, one topic per page, stable URLs, code before prose.

## Acceptance
- Catalogue above has a runnable example for every listed stack; each passes `verify.sh`.
- Every source file in `examples/` carries the header comment; a script (`examples/scripts/check-headers.sh`) fails if one is missing.
- Docs cover every endpoint (generated from OpenAPI) and every webhook event with a real payload.
- `llms.txt`, `llms-full.txt` and sitemaps regenerate from the docs on every change.
- STATUS tracks each example: not started / building / verified.

## Sequencing
Start with the five highest-traffic pieces as soon as the API is stable: iOS SwiftUI, Android Compose, React Native Expo, Flutter, Next.js backend webhook, plus "Migrate from RevenueCat" for each and Docker Compose self-host. Then fan out by search volume. Examples are built by parallel agents from a fixed template; a single owner reviews wording and links so the story stays consistent.
