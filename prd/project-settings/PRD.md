# Project settings: General, Brand, Blocked customers, Verified Metrics (batch F)

**Status:** built on branch `tier2-settings-auth` (2026-10-01). Migration 0021. The AI features tab comes from batch E (`tier2-ai-assistant`, PR #10) and is not duplicated here; Audit logs, Collaborators and Domains already existed.

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
| **Transfer project ownership** | Only the owner may do it (an admin when the project has no recorded owner). The new owner must already be an **Admin** collaborator. A dialog names the person and asks to type the project name. Both people get an email. The old owner stays an Admin. |
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
  - New purchases credit no in-app currency.
  - **Webhooks keep being sent** for the customer's store events (renewals, refunds, cancellations), so revenue reporting stays right; their `entitlement_ids` still name what the product unlocks. Developers who gate access from webhooks must check the block list (`GET /v2/projects/{id}/blocked_customers/{app_user_id}` answers 200 or 404).
- Endpoints (RevenueDot extensions): `GET /v2/projects/{id}/blocked_customers` (list, `?search=`, paging), `POST /v2/projects/{id}/blocked_customers` `{ app_user_id, note? }` (201; 200 if already blocked), `GET` and `DELETE /v2/projects/{id}/blocked_customers/{app_user_id}`. Scope `customer_information:customers:read(_write)`. Every block and unblock is in the audit log (`blocked_customer` target).

## 4. Verified Metrics
- A public page at **`/verified/<slug>`** on the API host (Cloud: `https://api.revenuedot.app/verified/<slug>`), plus `/verified/<slug>/og.png` (1200×630 PNG for link previews) and `/verified/<slug>/metrics.json`.
- **Settings:** status (Never published, Published, Inactive), share URL slug (3–40 characters, `a-z0-9-`, not starting or ending with `-`, unique across the server, reserved words refused), display name (1–60), chart type "Number & sparklines" (the only type, as in RevenueCat), metric order and visibility of the 6 overview metrics (MRR, Revenue, Active subscriptions, Active trials, New customers, Active customers), show project icon (an uploaded image) and show store links (App Store and Google Play URLs, https only, on `apps.apple.com` and `play.google.com`). **Publish** and **Unpublish** buttons; saving a published page republishes it.
- **What is shown:** only aggregate **production** numbers from the overview (`overviewValues`, `metricHistory`): the value and a 28-day sparkline per visible metric, "Verified by RevenueDot", the time the numbers were computed. No customer data, no app user ids, no sandbox data, no project id.
- **Caching:** HTML and JSON `Cache-Control: public, max-age=300, s-maxage=900`, ETag with 304; the Worker also keeps a copy in the edge cache for 15 minutes keyed by path. Unpublished or unknown slugs answer 404 with `Cache-Control: no-store`.
- **OG image:** drawn on the server as a PNG (no fonts or headless browser needed): display name and up to 3 visible metrics with sparklines in DESIGN.md's tokens, using a built-in pixel font.
- Endpoints: `GET/POST /v2/projects/{id}/verified_metrics`, `POST …/verified_metrics/actions/publish`, `POST …/verified_metrics/actions/unpublish`, `GET /v2/projects/{id}/verified_metrics/slug_availability?slug=`.

## 5. Dashboard
- `/projects/:id/settings/:tab` with tabs in RevenueCat's order. New tabs: `brand`, `blocked-customers`, `verified-metrics`. AI features stays a placeholder on this branch until PR #10 merges.
- Every tab uses DESIGN.md: square hairline panels, uppercase labels, the gold accent only for the live state ("Published" dot).
- Phone width: forms stack, tables hide secondary columns.

## Tests
- `packages/contract/test/v2-project-settings.test.ts` (sandbox access, ownership), `apps/server/test/blocked-customers.test.ts`, `apps/server/test/brand.test.ts`, `apps/server/test/verified-metrics.test.ts`.
- `apps/dashboard/e2e/settings.spec.ts`: each tab in a real browser; `settings-shots.spec.ts` with `SHOTS=<dir>` at 1440×900, compared with frame 28.

## Not built
- RevenueCat's Operations, Growth and Support roles.
- Chart types other than "Number & sparklines" on Verified Metrics; a custom domain for the verified page.
- A per-paywall "uses this preset" lookup before deleting a preset (paywalls keep the copied value, so deleting a preset breaks nothing that was picked in the editor; JSON paywalls that reference an alias fall back to the SDK's error colour).
