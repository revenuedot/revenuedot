# ChatGPT plugin and Claude connector (scope 1.14b, extends 1.14)

**One hosted OAuth MCP server (https://mcp.revenuedot.app/mcp) becomes both a ChatGPT plugin and a Claude connector.** The server grows from 17 to 34 tools so an agent can run the whole project, the OAuth server learns what both directories require, and the repo `revenuedot/agent-skills` becomes the installable plugin bundle for ChatGPT, Codex and Claude (skills, MCP address, manifests). The panels inside ChatGPT (sidebar, thread panel) and MCP Events are Tier 2.

## What each product is (researched 2026-09-30)
- **ChatGPT plugin** (OpenAI, DevDay 2026-09-29): a bundle of an MCP server, optional skills and optional UI. Manifest is a root `plugin.json` (portable Agent Plugins format) with OpenAI fields under `extensions.com.openai`; `.codex-plugin/plugin.json` is the older fallback. UI entry points (sidebar, thread panel, file viewer) are declared per tool in `_meta` and rendered from MCP Apps `ui://` resources. Docs: https://developers.openai.com/codex/plugins/build, https://developers.openai.com/apps-sdk/app-submission-guidelines.
- **Claude connector** (Anthropic): a remote HTTPS MCP server listed in the connector directory, plus optionally a plugin (`.claude-plugin/plugin.json`, `skills/`, `.mcp.json`) installed from a GitHub marketplace. Docs: https://code.claude.com/docs/en/plugins-reference, https://claude.com/docs/connectors/building/submission.
- **Same core for both:** Streamable HTTP, OAuth 2.1 with PKCE S256, tool annotations, no secrets in tool arguments.

## Users and jobs to be done
- **As an indie developer in ChatGPT or Claude**, I want to say "set up monthly and annual Pro plans on iOS and Android, then check Apple and Google are connected," so one chat replaces the dashboard.
- **As a support person**, I want to find a customer by email, see why they lost access, then grant a week free, extend or refund, so a ticket closes in one chat.
- **As an owner on my phone**, I want "how is revenue this month and did any webhook fail," so I get numbers and failures without opening a laptop.
- **As a developer migrating from RevenueCat**, I want the migration skill to arrive with the connector, so the agent can run import status checks itself.

## Tier placement
| Capability | Tier | Why |
|---|---|---|
| 34-tool OAuth MCP server with annotations, `title`, security schemes, structured results | 1 | SCOPE 1.14 says every dashboard action is also an MCP tool (principle 5); both directories reject servers without annotations and titles |
| OAuth additions: client ID metadata documents, `iss` in the redirect, a third scope for refunds, insufficient-scope step-up | 1 | MCP spec 2025-11-25 prefers metadata documents; ChatGPT prefers them too; refunds need their own consent |
| Plugin bundle in `revenuedot/agent-skills`: ChatGPT manifest, Claude manifest, `.mcp.json`, 5 skills | 1 | One repo installs on both products |
| Directory submissions (ChatGPT app directory, Claude connector directory) and their materials | 1 | Distribution; needs Kai's accounts, domain verification and test account |
| Sidebar and thread-panel UI (overview card, customer card) as MCP Apps resources | 2 | Polish; the tools work without it |
| MCP Events (push a chat message on a failed webhook or a refund) | 2 | ChatGPT-only and new; needs the event bus from the in-app agent |
| Tools that write to App Store Connect or Google Play | 3 | Same as `prd/mcp-and-skills/PRD.md` |

## The 34 tools
Names are RevenueCat's where the tool is the same (`revenuedot/mcp` PRD). Every name is at most 64 characters; every tool has a `title`; no tool takes a store secret, a private key, an API key or a header credential, and the only secret a result carries is a webhook's signing secret, once, when it is created; every tool takes an optional `project_id` (default: the connection's only project). Kinds: **R** read-only, **W** writes without deleting, **D** destructive (clients ask the user first).

| Group | Tool | Kind | OAuth scope |
|---|---|---|---|
| Account | `list-projects` | R | read |
| | `get-project-health` (setup health: apps wired, webhooks flowing) | R | read |
| | `get-metrics` (overview, or history of one metric over N days) | R | read |
| Catalog | `list-apps`, `list-products`, `list-entitlements`, `list-offerings` | R | read |
| | `create-product`, `create-entitlement`, `create-offering`, `create-packages` | W | write |
| | `attach-products-to-entitlement`, `attach-products-to-package` | W | write |
| | `archive-offering` | D | write |
| Customers | `list-customers` (search by app user id, email, transaction id), `get-customer` | R | read |
| | `list-transactions`, `list-events` | R | read |
| | `grant-customer-entitlement`, `set-customer-attributes` | W | write |
| | `revoke-customer-entitlement`, `delete-customer` | D | write |
| Support actions | `extend-subscription` | W | support |
| | `cancel-subscription`, `refund-subscription` | D | support |
| | `create-test-purchase` (Test Store only) | W | support |
| Webhooks | `list-webhook-integrations`, `list-webhook-deliveries` | R | read |
| | `create-webhook-integration`, `send-test-webhook`, `retry-webhook-delivery` | W | write |
| | `delete-webhook-integration` | D | write |
| Stores | `verify-store-credentials` (checks the saved Apple or Google key; never accepts a key) | R, open world | read |
| Migration | `get-import-status` | R | read |

The listing test asserts the exact counts.

**Differences from RevenueCat's tools, on purpose:** `create-webhook-integration` has no `authorization_header` input (a header is a credential; it is set in the dashboard). `verify-store-credentials` takes only an app id.

**Left out on purpose:** API key tools (an agent must not mint keys), app creation (needs store credentials that belong in the dashboard), member and invite tools, project deletion, and anything that accepts a credential.

## OAuth changes (`apps/server/src/routes/oauth.ts`, `mcp/src/http.ts`)
1. **Third scope `project:support`**: subscriptions and purchases read and write (cancel, refund, extend, test purchases). The consent page shows it as its own checkbox, off by default. `project:read` and `project:write` stay as they are.
2. **Step-up:** when a tool needs a scope the token lacks, the result is an error that carries `_meta["mcp/www_authenticate"]` (`Bearer error="insufficient_scope", scope="project:support", resource_metadata=...`), which makes ChatGPT and Claude re-run consent for the missing scope.
3. **Client ID metadata documents:** a `client_id` that is an `https` URL is fetched (HTTPS only, no private addresses, 5 second timeout, 10 KB, JSON, `client_id` must equal the URL, redirect URIs validated by the same rules as registration) and cached for an hour. `client_id_metadata_document_supported: true` is published. Dynamic registration stays for clients that need it.
4. **`iss` parameter** on the authorization response (RFC 9207) and `authorization_response_iss_parameter_supported: true`.
5. **`resource` checked:** when sent it must be an absolute URL without a fragment (RFC 8707); it is stored on the code, and a token request that names a different `resource` gets `invalid_target`.
6. **Per-tool security schemes:** every tool descriptor carries `_meta.securitySchemes = [{ type: "oauth2", scopes: [...] }]`. Every MCP call without a token still answers 401 with `WWW-Authenticate` (a first connection asks for read and change; money actions are asked for later).
7. **Domain verification:** `GET /.well-known/openai-apps-challenge` returns the value of `OPENAI_APPS_CHALLENGE` (Worker variable) as plain text; 404 when unset.

Still true: tokens are project-scoped secret keys that do not expire, shown in API keys, revoked by deleting the key. Refresh tokens stay in Known gaps.

## Results the model can use
Each tool returns `structuredContent` (an object; lists are `{ items, next_page }`) next to the JSON text, so ChatGPT panels and Claude can render fields without parsing text. List results over 100 items are paged with `starting_after`. Money is in USD with the unit named.

## Skills in the bundle (`revenuedot/agent-skills`)
`migrate-from-revenuecat`, `add-subscriptions`, `self-host` (exist) plus two new playbooks that use the tools:
- `support-playbook`: find the customer, explain access in plain words, choose grant, extend or refund by the rules in the skill (refund only after the user says yes in chat).
- `weekly-revenue-check`: metrics, failed webhooks, setup health, then a three-line summary.

## Packaging
- `plugin.json` (portable, with `extensions.com.openai.interface`: display name, descriptions, category, capabilities, privacy and terms URLs, default prompts, logo, screenshots), `.claude-plugin/plugin.json`, `.mcp.json` (`https://mcp.revenuedot.app/mcp`, streamable HTTP), `skills/`, `assets/`.
- `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` so `/plugin marketplace add revenuedot/agent-skills` and Codex's marketplace add both work from the same repo.

## Acceptance tests
| Criterion | Proven by |
|---|---|
| Exactly 34 tools; unique names of 64 characters or fewer; each has title, description over 40 characters, annotations, input schema, security scheme; destructive tools say so; no property named like a secret | `../../mcp/test/listing.test.ts` |
| Every new tool works against a live server in a realistic order (support flow, catalog flow, webhook flow) | `../../mcp/test/tools.test.ts` |
| A read-only token cannot write; a write token cannot refund; the error carries `mcp/www_authenticate` naming the scope | `../../mcp/test/e2e.test.ts` |
| Metadata-document client: discovery, fetch, consent, code, token; bad cases (HTTP URL, private address, mismatched `client_id`, redirect not in document, oversize, secret-based client, not JSON, 404) are refused | [`oauth.test.ts`](../../apps/server/test/oauth.test.ts) (19 tests) |
| `iss` returned; `resource` mismatch refused; `project:support` shown and granted only when ticked | [`oauth.test.ts`](../../apps/server/test/oauth.test.ts) |
| Both manifests parse; `claude plugin validate` passes; paths exist; skills have front matter | `../../../agent-skills/test/plugin.test.mjs` |
| The deployed server passes the same listing checks over the internet | `mcp/scripts/verify-live.mjs` in CI after deploy |

No test yet (needs Kai's accounts): a real sign-in from ChatGPT developer mode and Claude Desktop; directory review.

## Submission checklist (Kai's part, with the exact materials prepared by us)
- ChatGPT: verify the domain (value from the dashboard into `OPENAI_APPS_CHALLENGE`), privacy policy URL (https://revenuedot.app/legal/privacy), test account on production with a seeded sandbox project, 5 positive and 3 negative test prompts, demo recording.
- Claude: submit the connector form, same test account, 3 to 5 screenshots of at least 1000 px, privacy policy URL.
- Materials live in `revenuedot/agent-skills/submission/` and are written by us.

## Known gaps and next steps
1. Tokens never expire and have no refresh token (both products work with that; add refresh when a directory asks).
2. Panels and MCP Events are Tier 2.
3. `create-test-purchase` needs the `project:support` scope because purchase refunds share the same API permission.
4. The directories' reviews take days; listing is not under our control.
