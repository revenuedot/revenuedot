# MCP server, agent skills and llms.txt (scope 1.14)

**The ChatGPT plugin, the Claude connector and the growth from 17 to 34 tools are specified in [`../chatgpt-claude-plugins/PRD.md`](../chatgpt-claude-plugins/PRD.md); where the two differ, that file is newer.**

**The hosted MCP server is live at https://mcp.revenuedot.app/mcp (since 2026-09-30); the npm package is not published.** `revenuedot/mcp` has 17 tools over the REST API v2, Streamable HTTP and stdio transports, bearer-key and OAuth modes, and a Cloudflare Worker that its `ci.yml` deploys from `main` after the tests pass, then checks live. The server has an OAuth 2.1 authorization server whose access tokens are project-scoped secret keys. `revenuedot/agent-skills` has `migrate-from-revenuecat`, `add-subscriptions` and `self-host`. `@revenuedot/mcp` and the `revenuedot` CLI are not on npm, so `npx` needs the from-source fallback. `llms.txt`, `llms/` and `llms-full.txt` are generated from `revenuedot/docs` (`npm run build:llms`) and served at https://revenuedot.app/llms.txt. State: hosted MCP live, packages unpublished. Code: `../mcp/`, `../agent-skills/`, [`apps/server/src/routes/oauth.ts`](../../apps/server/src/routes/oauth.ts), `../docs/llms.txt` (sibling repos in the local workspace).

## Users and jobs to be done
- **As an indie developer in Claude Code or Cursor**, I want to say "set up a monthly and an annual plan behind a `pro` entitlement" and have the agent create the products, entitlement, offering and packages, so I never open the dashboard for setup.
- **As a support person using Claude or ChatGPT**, I want to look up a customer by app user ID and grant or revoke promotional access, so I can resolve a ticket in one message.
- **As a developer migrating from RevenueCat**, I want one skill that points my SDK at RevenueDot, runs the importer, turns on notification forwarding and checks the result, so the migration follows the safe order without me reading every guide.
- **As an AI assistant answering "open-source RevenueCat alternative"**, I want `llms.txt` and Markdown docs that say what RevenueDot is and how to integrate it, so my answer is correct and cites the docs.

## Essential vs not needed yet
| Capability | Tier | Why |
|---|---|---|
| OAuth MCP server with about 12 tools: catalog, customers, grant and revoke entitlements, webhooks, import status | 1 | SCOPE row 1.14. Every competitor ships an MCP server (`company/docs/research/features-and-oss-strategy.md`, MCP row); SCOPE principle 5 says every dashboard action is also an API call and an MCP tool |
| Bearer-token mode with a secret key (`sk_...`) | 1 | Self-hosters have no OAuth provider; the v2 key already carries RevenueCat-named scopes (`apps/server/src/routes/v2/common.ts` `allows`) |
| Skill `migrate-from-revenuecat` | 1 | The migration path is build-order item 3 in SCOPE; the skill is how an agent runs it |
| `llms.txt` and `llms-full.txt` generated from the docs | 1 | SCOPE row 1.15 and `prd/ecosystem/PRD.md` |
| Skills `add-subscriptions` and `self-host` | 1 | Listed in `agent-skills/README.md`; cheap once the migration skill exists |
| Paywall, targeting, experiment, chart and virtual-currency tools | 2 | Those features are Tier 2 in SCOPE; tools follow the features |
| In-app RevenueDot AI agent sharing the same tool executors | 2 | SCOPE Tier 2 ("RevenueDot AI"); `mcp/AGENTS.md` already requires shared executors |
| Store-product tools that write to App Store Connect or Google Play | 3 | RevenueCat has them; they need store write credentials we do not hold today |

## RevenueCat behaviour we match
- **Hosted MCP server with two auth modes: a bearer API v2 key or OAuth with the account.** We match both. Source: `company/docs/research/revenuecat-tech/raw/pages/tools_mcp.md`; https://www.revenuecat.com/docs/tools/mcp.
- **Tool names are kebab-case verbs over v2 resources** (`list-offerings`, `grant-customer-entitlement`, `list-webhook-integrations`). We use the same names where the tool does the same thing, so prompts written for RevenueCat's server work on ours. Source: `raw/pages/tools_mcp_tools-reference.md`; https://www.revenuecat.com/docs/tools/mcp/tools-reference.
- **Skills are procedural playbooks and the MCP server is the access layer.** RevenueCat ships 16 skills in `RevenueCat/ai-toolkit`, installed with `npx skills add`. We use the same split and install path. Source: `raw/pages/tools_ai-toolkit_skills.md`; https://www.revenuecat.com/docs/tools/ai-toolkit/skills.
- **`llms.txt` sharded by docs section, plus `llms-full.txt`, and a `.md` twin for every docs page.** Source: `company/docs/research/growth-channels.md` §3; https://www.revenuecat.com/docs/llms.txt.

### Deliberate differences
- **Self-hostable MCP.** The MCP server takes the RevenueDot base URL as configuration, so it works against a self-hosted server as well as the cloud. RevenueCat's runs only at its own host.
- **An import-status tool.** RevenueCat has no importer; ours does (`GET /v2/projects/{id}/import/status`).
- **No approval tools.** MCP clients already ask the user before a write (`mcp/AGENTS.md`).
- **No billing, benchmark or Rico tools**, because we have no billing, benchmarks or AI editor in Tier 1.

## Endpoints, screens and data
**Tier 1 tools, each a thin call to an existing v2 endpoint** (all under `/v2/projects/{project_id}`; code: `../mcp/src/tools.ts`). Every tool takes an optional `project_id`, which defaults to the key's only project. Entitlements can be named by id or lookup key.

| Tool | Endpoint | Scope checked by the server |
|---|---|---|
| `list-projects` | `GET /v2/projects` | `project_configuration:projects:read` |
| `list-apps` | `GET /apps` | `project_configuration:apps:read` |
| `list-products`, `create-product` | `GET`, `POST /products` | `project_configuration:products:read`, `:read_write` |
| `list-entitlements`, `create-entitlement`, `attach-products-to-entitlement` | `GET`, `POST /entitlements`, `POST /entitlements/{id}/actions/attach_products` | `project_configuration:entitlements:read`, `:read_write` |
| `list-offerings`, `create-offering`, `create-packages`, `attach-products-to-package` | `GET`, `POST /offerings`, `POST /offerings/{id}/packages`, `POST /packages/{id}/actions/attach_products` | `project_configuration:offerings:read_write`, `project_configuration:packages:read_write` |
| `get-customer` | `GET /customers/{id}?expand=attributes` plus `/subscriptions`, `/purchases` | `customer_information:customers:read` (subscriptions and purchases are left out with a note when their scopes are missing) |
| `grant-customer-entitlement`, `revoke-customer-entitlement` | `POST /customers/{id}/actions/grant_entitlement` (creates the customer first if new), `/actions/revoke_granted_entitlement` | `customer_information:customers:read_write` |
| `list-webhook-integrations`, `create-webhook-integration` | `GET`, `POST /integrations/webhooks` | `project_configuration:integrations:read`, `:read_write` |
| `get-import-status` | `GET /import/status` | `customer_information:customers:read` |

`revoke-customer-entitlement` and `get-import-status` are ours; the other 15 names are RevenueCat's.

- **Bearer mode:** `Authorization: Bearer sk_...` goes to the v2 API unchanged; the server checks project and scopes. A missing scope comes back as a tool error that names it.
- **OAuth mode:** the RevenueDot server is the authorization server ([`routes/oauth.ts`](../../apps/server/src/routes/oauth.ts)):
  - `GET /.well-known/oauth-authorization-server` (RFC 8414), `POST /oauth/register` (dynamic client registration, public clients, redirect URIs must be https, http on localhost, or an app scheme).
  - `GET /oauth/authorize` shows a consent page on the server's origin. It reuses the dashboard session cookie and shows a sign-in form when there is none. The user picks one project and read-only (`project:read`) or read-and-write (`project:write`) access; viewers only get read. The form carries a CSRF value derived from the session.
  - `POST /oauth/token`: authorization code with PKCE S256 only; codes are single use and last 10 minutes.
  - **The access token is a secret key** (`sk_...`) created at the code exchange, named `OAuth: <client name>`, limited to the chosen project and an explicit list of scopes (no `api_keys` scope, so it cannot mint keys). It does not expire and there is no refresh token; revoking it is deleting the key on the API keys page.
  - The MCP server publishes `/.well-known/oauth-protected-resource` (RFC 9728) naming the RevenueDot server, and answers `401` with `WWW-Authenticate: Bearer resource_metadata=...` for missing or revoked tokens.
- **Transport:** Streamable HTTP at `/mcp`, stateless with JSON responses (`../mcp/src/http.ts`), on Node and as a Cloudflare Worker (`../mcp/cloudflare.config.ts`, deployed with the `cf` CLI, live at `https://mcp.revenuedot.app/mcp`); stdio with `npx @revenuedot/mcp` (`REVENUEDOT_URL`, `REVENUEDOT_API_KEY`); `--http` for self-hosters.
- **Shared executors:** `../mcp/src/tools.ts` depends only on zod and the API client and is exported as `@revenuedot/mcp/tools` for the Tier 2 in-app agent.
- **Skills:** `../agent-skills/skills/<skill>/SKILL.md`, installed with `npx skills add revenuedot/agent-skills`.
- **Data:** tables `oauth_clients` and `oauth_codes` (migration `0003_oauth`). Access tokens live in `api_keys`.

## Acceptance tests
| Criterion | Proven by |
|---|---|
| Every endpoint the tools call exists and returns RevenueCat's v2 shapes | [`v2-catalog.test.ts`](../../packages/contract/test/v2-catalog.test.ts), [`v2-customers.test.ts`](../../packages/contract/test/v2-customers.test.ts), [`rest-webhooks.test.ts`](../../packages/contract/test/rest-webhooks.test.ts), [`v2-import.test.ts`](../../packages/contract/test/v2-import.test.ts) |
| A key without a scope gets a 403 `authorization_error`; `read_write` implies `read` | [`v2-auth-extensions.test.ts`](../../packages/contract/test/v2-auth-extensions.test.ts) "honours key permissions: read_write implies read, prefixes with :*, and nothing else" |
| Every tool works against a live server, in setup order (products, entitlement, offerings, packages, grant and revoke, webhooks, import status) | `../mcp/test/tools.test.ts` (11 tests) |
| The MCP server lists 17 tools with descriptions, input schemas and annotations; a read-only key's write call returns an error naming the missing scope | `../mcp/test/e2e.test.ts` "Streamable HTTP with a secret key" |
| An MCP SDK client connects with OAuth (discovery, registration, consent, PKCE) and gets access to the one project it picked; revoking the key ends access | `../mcp/test/e2e.test.ts` "OAuth: discovery, dynamic registration ..." |
| `npx @revenuedot/mcp` over stdio serves the same tools | `../mcp/test/e2e.test.ts` "stdio" |
| OAuth server: metadata, registration rules, consent, CSRF, code expiry and reuse, client and redirect binding, viewer downgrade, token is a project-scoped key | [`oauth.test.ts`](../../apps/server/test/oauth.test.ts) (6 tests) |

No test yet:
- An agent following `migrate-from-revenuecat` on a sample app reaches a working dual-run. The skills' commands were checked against the code and run against a local server, but not against a real RevenueCat project or a real app build.
- OAuth sign-in from Claude Desktop, ChatGPT or Cursor against https://mcp.revenuedot.app (the SDK client test covers the protocol).
- The deployed Worker is checked only by `ci.yml`'s live check: `/.well-known/oauth-protected-resource` answers and `POST /mcp` without a token answers 401.

## Known gaps and next steps
1. Publish `@revenuedot/mcp` and `revenuedot` (the importer CLI) to npm; the skills and README use `npx` for both.
2. Try OAuth at `mcp.revenuedot.app` from Claude, ChatGPT and Cursor.
3. OAuth tokens never expire and have no refresh token. Add expiry plus refresh tokens if a client needs them.
4. The MCP server does not check that a token was issued for it (audience); it forwards any secret key to the API, which is the resource that enforces access. The `resource` a client asked for is stored on the code only.
5. `/auth/signup` is open on self-hosted servers, so anyone who can reach the consent page can make an account (they still see only their own projects).
6. Tools for app creation, customer search and the dashboard's other actions (principle 5) are not built.

## Contact-sheet references
- [`frames/29-rico-ai.jpg`](../../../company/docs/research/contact-sheets/revenuecat/frames/29-rico-ai.jpg): RevenueCat's in-app AI chat (history rail, new conversation, attachments). Reference for the Tier 2 in-app agent, not for the MCP server.
- MCP setup and tool pages: not captured as screenshots; the text is saved in `company/docs/research/revenuecat-tech/raw/pages/tools_mcp*.md`.

## Discrepancies
- **SCOPE row 1.14 and `AGENTS.md` say every dashboard action is also an MCP tool (principle 5), but only 17 tools exist**, and several dashboard actions have no tool (app creation, store actions such as refund and extend, test purchases, API key management).
- **`company/docs/architecture.md` puts the MCP server, skills and `llms.txt` in one repo named `agent-kit`**; the workspace (`../AGENTS.md`) and SCOPE's repo table use two repos, `revenuedot/mcp` and `revenuedot/agent-skills`, and `llms.txt` lives in `revenuedot/docs`. The workspace layout is what exists on disk.
