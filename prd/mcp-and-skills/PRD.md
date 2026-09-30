# MCP server, agent skills and llms.txt (scope 1.14)

**This is a plan: no MCP tool, OAuth flow or skill exists yet.** The repos `revenuedot/mcp` and `revenuedot/agent-skills` hold only a README, an `AGENTS.md` and an MIT license, and `revenuedot/docs/llms.txt` is a hand-written index. What does exist is the REST API v2 that every planned tool calls: each tool below maps to an endpoint that is already built and tested. State: not started (scaffolds only). Code: `../mcp/`, `../agent-skills/`, `../docs/llms.txt` (sibling repos in the local workspace).

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
**Planned Tier 1 tools, each a thin call to an existing v2 endpoint** (all under `/v2/projects/{project_id}`):

| Tool | Endpoint | Scope checked by the server |
|---|---|---|
| `list-projects` | `GET /v2/projects` | `project_configuration:projects:read` |
| `list-apps` | `GET /apps` | `project_configuration:apps:read` |
| `list-products`, `create-product` | `GET`, `POST /products` | `project_configuration:products:read`, `:read_write` |
| `list-entitlements`, `create-entitlement`, `attach-products-to-entitlement` | `GET`, `POST /entitlements`, `POST /entitlements/{id}/actions/attach_products` | `project_configuration:entitlements:read`, `:read_write` |
| `list-offerings`, `create-offering`, `create-packages` | `GET`, `POST /offerings`, `POST /offerings/{id}/packages` | `project_configuration:offerings:read_write`, `project_configuration:packages:read_write` |
| `get-customer` | `GET /customers/{id}` plus `/active_entitlements`, `/subscriptions` | `customer_information:customers:read` |
| `grant-customer-entitlement`, `revoke-customer-entitlement` | `POST /customers/{id}/actions/grant_entitlement`, `/actions/revoke_granted_entitlement` | `customer_information:customers:read_write` |
| `list-webhook-integrations`, `create-webhook-integration` | `GET`, `POST /integrations/webhooks` | `project_configuration:integrations:read`, `:read_write` |
| `get-import-status` | `GET /import/status` | `customer_information:customers:read` |

- **Auth:** bearer `sk_...` key passed through to the v2 API (resolved by `apps/server/src/services/auth.ts` `resolveKey`). OAuth needs a new authorization-code flow on the server that issues project-scoped tokens; no such code exists (`grep -ri oauth apps packages` finds nothing).
- **Transport:** Streamable HTTP at `https://mcp.revenuedot.app/mcp` for the cloud, and `npx @revenuedot/mcp --url <server>` over stdio for self-hosters (proposed names, unverified availability).
- **Skills:** `agent-skills/<skill>/SKILL.md`, one folder each. `migrate-from-revenuecat` reuses `examples/migrate-from-revenuecat/` (catalog copy, `forward-notifications.sh`, per-SDK diffs) and `npx revenuedot import`.
- **Data:** no new tables for bearer mode. OAuth adds a clients table and a tokens table (not designed yet).

## Acceptance tests
| Criterion | Proven by |
|---|---|
| Every endpoint the tools call exists and returns RevenueCat's v2 shapes | [`v2-catalog.test.ts`](../../packages/contract/test/v2-catalog.test.ts), [`v2-customers.test.ts`](../../packages/contract/test/v2-customers.test.ts), [`rest-webhooks.test.ts`](../../packages/contract/test/rest-webhooks.test.ts), [`v2-import.test.ts`](../../packages/contract/test/v2-import.test.ts) |
| A key without a scope gets a 403 `authorization_error`; `read_write` implies `read` | [`v2-auth-extensions.test.ts`](../../packages/contract/test/v2-auth-extensions.test.ts) "honours key permissions: read_write implies read, prefixes with :*, and nothing else" |

No test yet:
- The MCP server lists about 12 tools, each with a description and input schema, and each call returns the v2 response.
- A read-only key cannot call a write tool, and the tool error says which scope is missing.
- OAuth sign-in from Claude Desktop grants access to one project only.
- An agent following `migrate-from-revenuecat` on a sample app reaches a working dual-run (every command in the skill runs as written; `agent-skills/AGENTS.md` requires this before merge).
- `llms.txt` and `llms-full.txt` regenerate from the docs on every change and link only to pages that exist.

## Known gaps and next steps
1. Build the MCP server in `revenuedot/mcp` in bearer mode first, with the tools above, against a local `docker compose up` server.
2. Add a contract test that calls every tool against the in-memory harness (`packages/contract/src/harness.ts`).
3. Design the OAuth flow (authorization code with PKCE, project picker, revocable tokens) and add it to the server.
4. Write `migrate-from-revenuecat/SKILL.md` from `examples/migrate-from-revenuecat/README.md`, then `add-subscriptions` and `self-host`.
5. Generate `llms.txt` and `llms-full.txt` from `revenuedot/docs` instead of maintaining them by hand.
6. Put the tool executors in a shared package so the Tier 2 in-app agent reuses them, as `mcp/AGENTS.md` requires.

## Contact-sheet references
- [`frames/29-rico-ai.jpg`](../../../company/docs/research/contact-sheets/revenuecat/frames/29-rico-ai.jpg): RevenueCat's in-app AI chat (history rail, new conversation, attachments). Reference for the Tier 2 in-app agent, not for the MCP server.
- MCP setup and tool pages: not captured as screenshots; the text is saved in `company/docs/research/revenuecat-tech/raw/pages/tools_mcp*.md`.

## Discrepancies
- **SCOPE row 1.14 and `AGENTS.md` say every dashboard action is also an MCP tool (principle 5), but no MCP tool exists**, and several dashboard actions have no planned tool (store actions such as refund and extend, test purchases, API key management).
- **`company/docs/architecture.md` puts the MCP server, skills and `llms.txt` in one repo named `agent-kit`**; the workspace (`../AGENTS.md`) and SCOPE's repo table use two repos, `revenuedot/mcp` and `revenuedot/agent-skills`, and `llms.txt` lives in `revenuedot/docs`. The workspace layout is what exists on disk.
