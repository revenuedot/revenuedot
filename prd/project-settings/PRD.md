# Project settings: General, Brand, Blocked customers, Verified Metrics (batch F)

**Status:** built on branch `tier2-settings-auth` (2026-10-01). Migration 0021. The AI features tab comes from batch E (`tier2-ai-assistant`) and is not duplicated here; Audit logs, Collaborators and Domains already existed.

Scope rows: parity matrix "Project settings tabs" (batch F). Contact-sheet frame 28 (RevenueCat's Project Settings, General tab). Tabs in RevenueCat's order: **General · AI features · Brand · Audit logs · Blocked customers · Collaborators · Verified Metrics · Domains**.

## Users and jobs
- **Admins** rename the project, copy its ID for API calls, decide who may unlock paid features with sandbox purchases, hand the project to a co-founder when they leave, and delete a test project.
- **Designers** keep the app's colours, gradients and fonts in one place so every paywall uses them.
- **Support** blocks an abusive or fraudulent app user ID so it loses paid features on every platform at once, and unblocks it later.
- **Founders** publish verified revenue numbers on a public page (for investors, acquirers, "open startup" posts) that RevenueDot computes, so nobody has to trust a screenshot.

## 1. General
| Field | Behaviour |
|---|---|
| Project name | Required, 1 to 100 characters. |
| Project ID | Read-only `proj…` with a copy button; "Used in REST API v2 paths". |
| Handling multiple app user IDs | Existing: transfer behaviour, optional different sandbox behaviour. |
| **Sandbox testing access** | "Allow testing entitlements and in-app currency for": **Anybody** (default, RevenueCat's default), **Allowlisted app user IDs** (a list of up to 500 ids, one per line), **Nobody**. |
| **Transfer project ownership** | Only the owner may do it (any admin when the project has no recorded owner, which happens only when the owner's account is deleted). The new owner must already be an **Admin** collaborator. A dialog names the person and asks to type the project name. Both people get an email. The old owner stays an Admin. The owner always stays an Admin member: other admins cannot remove or demote them (422), and the owner transfers before leaving; otherwise an admin could remove the owner and then take the project. |
| Delete project | Existing: admins only, dashboard only, typed project name, cascades everything. |

**Sandbox testing access is enforced on the server**, not in the dashboard:
- When access is *Allowlisted* or *Nobody*, sandbox subscriptions and purchases (`is_sandbox`, which includes every Test Store purchase) of a customer none of whose app user IDs is allowlisted **grant no entitlements**: customer info (`GET /v1/subscribers/{id}`, receipts, logIn, the v1 REST API), API v2 `active_entitlements`, targeting and audiences all leave them out. The purchase is still recorded and still sends webhooks, so testers see what happened.
- Sandbox purchases of such customers **credit no in-app currency** (product grants are skipped; no VIRTUAL_CURRENCY_TRANSACTION event).
- Production purchases are never affected. Allowlist matching looks at every alias of the customer.
- `POST /v2/projects/{id}` takes `sandbox_testing_access` (`anybody`, `allowlist`, `nobody`) and `sandbox_testers` (array of app user ids).

**Ownership** is stored as `projects.owner_user_id` (backfilled by the migration with the earliest admin). `GET /v2/projects/{id}` returns `owner: { id, email, name }`. `POST /v2/projects/{id}/actions/transfer_ownership` `{ user_id }` (dashboard session only; 403 for anyone but the owner; 422 when the target is not an admin of the project) records an audit log row.

## 2. Brand
- **Colour presets:** up to 50 named colours, each a light hex and an optional dark hex (`#RRGGBB` or `#RRGGBBAA`).
- **Gradient presets:** up to 50 named gradients, linear (angle 0–360) or radial, 2 to 10 stops (hex + percent 0–100), light and optional dark.
- Names become a key (`a-z0-9_`, unique). `GET/POST /v2/projects/{id}/brand` returns and replaces `{ color_presets, gradient_presets }`.
- **Fonts:** the existing paywall font upload (`GET/POST /v2/projects/{id}/fonts`, TTF or OTF up to 5 MB) grouped by family, plus `DELETE /v2/projects/{id}/fonts/{font_id}`.
- **Used by the paywall editor** (PR #6): every colour field shows the project's colour presets (and gradient presets for backgrounds) as swatches; picking one writes its value. The text "Font" section picks from the project's uploaded fonts (by font key) or a system font, with an upload button.
- **Sent to the SDKs:** presets are also served as `ui_config.app.colors` in the offerings response, keyed by the preset key, with the dark value defaulting to the light one (the iOS SDK resolves `{ "type": "alias", "value": "<key>" }` there and fails when the dark side is missing).

## 3. Blocked customers
- Block an app user ID (up to 100 characters; it need not exist yet), with an optional note. Unblock from the table. Table columns: App user ID (links to the customer), blocked at, blocked by, note, actions. Search.
- **Effect** (RevenueCat: the customer "loses access to paid features across all platforms"): a customer is blocked when **any** of its app user IDs is blocked.
  - Customer info has **no entitlements** (the `entitlements` object is empty) on every SDK path, the subscriber-token paths and the v1 REST API. Subscriptions and purchases stay listed, because they are store facts.
  - API v2 customer `active_entitlements` is empty and the customer page shows a "Blocked" tag; audiences and targeting see no entitlements.
  - API v2 subscriptions of a blocked customer show `gives_access: false` (sandbox subscriptions outside sandbox testing access too).
  - New purchases credit no in-app currency.
  - Their purchases never move to another app user ID: a restore on another ID answers 400 · 7102 (receipt already in use) under the `transfer` and `transfer_if_no_active` behaviours, so a fresh account cannot take the access back. `share` merges the restorer into the blocked customer, which stays blocked.
  - **Webhooks keep being sent** for the customer's store events (renewals, refunds, cancellations), so revenue reporting stays right; their `entitlement_ids` still name what the product unlocks. Developers who gate access from webhooks must check the block list (`GET /v2/projects/{id}/blocked_customers/{app_user_id}` answers 200 or 404).
- Endpoints (RevenueDot extensions): `GET /v2/projects/{id}/blocked_customers` (list, `?search=`, paging), `POST /v2/projects/{id}/blocked_customers` `{ app_user_id, note? }` (201; 200 if already blocked), `GET` and `DELETE /v2/projects/{id}/blocked_customers/{app_user_id}`. Scope `customer_information:customers:read(_write)`. Every block and unblock is in the audit log (`blocked_customer` target).

## 4. Verified Metrics
- A public page at **`/verified/<slug>`** on the API host (Cloud: `https://api.revenuedot.app/verified/<slug>`), plus `/verified/<slug>/og.png` (1200×630 PNG for link previews) and `/verified/<slug>/metrics.json`.
- **Settings:** status (Never published, Published, Inactive), share URL slug (3–40 characters, `a-z0-9-`, not starting or ending with `-`, unique across the server, reserved words refused), display name (1–60), chart type (below), metric order and visibility of the 6 overview metrics (MRR, Revenue, Active subscriptions, Active trials, New customers, Active customers), show project icon (an uploaded image) and show store links (App Store and Google Play URLs, https only, on `apps.apple.com` and `play.google.com`). **Publish** and **Unpublish** buttons; saving a published page republishes it.
- **What is shown:** only aggregate **production** numbers from the overview (`overviewValues`, `metricHistory`): the value and a 28-day sparkline per visible metric, "Verified by RevenueDot", the time the numbers were computed. No customer data, no app user ids, no sandbox data, no project id. The icon is served at `/verified/<slug>/icon` (the asset URL would name the project).
- **Chart types:** "Number & sparklines" (`number_sparkline`, the default: each value with its 28-day sparkline) and "Only numbers" (`numbers_only`), as in RevenueCat, plus RevenueDot's own "Line charts" (`line`): a larger chart per metric over the last 12 calendar months, one point per month (MRR, active subscriptions and active trials at each month's end, the current month live; revenue and new customers as monthly totals; active customers has no monthly history and shows its value only), two metrics per row, with the first and last month and the peak under it. The JSON carries `history` (`[{ date: "YYYY-MM", value }]`) for the line type. The OG image draws the same series.
- **Custom domain** (`PUT /v2/projects/{id}/verified_metrics/domain` `{ custom_domain }`, `POST …/domain/actions/verify`): a subdomain the developer owns (metrics.yourapp.com) proven like a web domain: a TXT record `_revenuedot.<domain>` = `revenuedot-verify=<token>` and a CNAME to `REVENUEDOT_CUSTOM_DOMAIN_TARGET` (else the API host), read over DNS over HTTPS, 6 checks a minute. Once verified, that host serves the page at `/`, `/metrics.json`, `/og.png` and `/icon` (links and the canonical URL name the domain) and nothing else: every other path and method answers 404, never the API, sign-in or OAuth. Only one verified claim per domain (unique index), and a domain verified for hosted web pages is refused. Changing or removing the domain resets the proof.
- **TLS certificate:** self-hosted servers terminate TLS themselves. On Cloud, when the server has `REVENUEDOT_CF_SAAS_ZONE_ID` and `REVENUEDOT_CF_SAAS_API_TOKEN` (a token with "SSL and Certificates: Edit" on the zone), Verify adds a Cloudflare for SaaS custom hostname (DV, HTTP validation) once DNS proves the domain, and later checks report its certificate status; removing the domain deletes the hostname. Without them the API and the dashboard say RevenueDot adds the certificate by hand (docs/cloud.md).
- Data (migration 0039): `verified_pages.custom_domain`, `domain_token`, `domain_status` (none, pending, verified, failed), `domain_verified_at`, `domain_checked_at`, `domain_error`, `domain_hostname_id`, `domain_ssl_status`.
- **Caching:** HTML and JSON `Cache-Control: public, max-age=300, s-maxage=900`, ETag with 304. Every request first reads the page row (one indexed lookup), so an unpublished or unknown slug answers 404 with `Cache-Control: no-store` at once in every data centre; the Worker's edge-cache copy is keyed by the row's `updated_at`, so a saved page is never served stale from another data centre's copy (Cloudflare's `cache.delete` only purges the local one). Slugs are case-insensitive.
- **OG image:** drawn on the server as a PNG (no fonts or headless browser needed): display name and up to 3 visible metrics with sparklines in DESIGN.md's tokens, using a built-in pixel font.
- Endpoints: `GET/POST /v2/projects/{id}/verified_metrics`, `POST …/verified_metrics/actions/publish`, `POST …/verified_metrics/actions/unpublish`, `GET /v2/projects/{id}/verified_metrics/slug_availability?slug=`, `GET …/verified_metrics/monthly_history` (the line type's preview), `PUT …/verified_metrics/domain`, `POST …/verified_metrics/domain/actions/verify`.

## 5. Dashboard
- `/projects/:id/settings/:tab` with tabs in RevenueCat's order. New tabs: `brand`, `blocked-customers`, `verified-metrics`; AI features comes from batch E.
- Every tab uses DESIGN.md: square hairline panels, uppercase labels, the gold accent only for the live state ("Published" dot).
- Phone width: forms stack, tables hide secondary columns.

## Tests
- `apps/server/test/verified-extras.test.ts`: the three chart types (HTML, JSON history, OG image), the custom domain's DNS proof, routing by host and what the host refuses, the web-domain conflict, the manual certificate note on Cloud, and Cloudflare for SaaS hostnames against a recorded API.
- `apps/server/test/project-settings-tabs.test.ts` (sandbox access, ownership and its protections, blocked customers and restores, `gives_access`, brand, Verified Metrics with a Workers-style edge cache), `apps/server/test/invites.test.ts`.
- `scripts/e2e/journeys/settings-auth.ts`: the same features end to end on a real server and a Railway development database (Test Store, test purchase tool and Stripe sandbox purchases, a live-mode Stripe subscription for the verified page, the emailed invite and ownership emails through the SMTP sink), every state checked through the API and SQL.
- `apps/dashboard/e2e/settings.spec.ts`: each tab in a real browser; `settings-shots.spec.ts` with `SHOTS=<dir>` at 1440×900, compared with frame 28.

## Not built
- RevenueCat's Operations, Growth and Support roles.
- A per-paywall "uses this preset" lookup before deleting a preset (paywalls keep the copied value, so deleting a preset breaks nothing that was picked in the editor; JSON paywalls that reference an alias fall back to the SDK's error colour).
