# ChatGPT plugin, Claude connector and MCP server (scope 1.14b, extends 1.14)

**One hosted OAuth MCP server (https://mcp.revenuedot.app) is the ChatGPT plugin, the Claude connector and the MCP server for every other assistant, and it is RevenueDot's main discovery channel.** Tier 1 ships the 34 tools, the OAuth upgrades, the install bundle, a sign-up path that works from inside the chat, and both directory listings. Tier 2 adds the interface: cards that show in ChatGPT and Claude, a RevenueDot sidebar app and conversation panels in ChatGPT, safe confirmation forms, plugin settings, and MCP Events, which push "your first sale just arrived" into the chat. Tier 3 holds composer mentions, a StoreKit file viewer and store-writing tools.

## What each product is (researched 2026-09-30; sources in the notes at the end of this section)
- **ChatGPT plugin** (OpenAI DevDay, 2026-09-29): a zipped folder with `plugin.json`, `mcp.json`, `skills/`, a README and icons, listed in ChatGPT's plugin directory. A **plugin extension** puts the plugin inside ChatGPT's own interface. There are nine surfaces: sidebar app, conversation panel, plugin settings, file viewers, display modes, deep links, model-app context, composer mentions (desktop only) and rich forms. Each tool declares them in `_meta` (`ui.resourceUri`, `openai/ui` with entry point type `global`, `thread` or `file`); the UI is an MCP App, an HTML resource at a `ui://` address. Extensions need no separate review (a daily scan checks new tools), so the plugin can be listed first and gain screens later.
- **MCP Events** (launched with it): ChatGPT subscribes to events a server publishes and acts on them in the chat where the user asked ("tell me here when a webhook fails"). It needs MCP protocol `2026-07-28` (MCP 2.0), three methods (`events/list`, `events/subscribe`, `events/unsubscribe`) and signed one-event-per-request webhook deliveries of at most 256 KiB.
- **Claude connector** (Anthropic): a remote HTTPS MCP server in the connector directory, submitted at claude.ai/directory/manage from a paid plan. Claude shows the same MCP Apps cards inline and fullscreen. It has no sidebar app, plugin settings or MCP Events. Skills ship as a separate Claude plugin from a public GitHub repo, not inside the connector.
- **Same core for both:** Streamable HTTP, OAuth 2.1 with PKCE S256, tool annotations, no credentials in tool inputs. A card built once on MCP Apps works in both products.
- Notes and sources: [what ChatGPT plugin extensions are](https://app.notion.com/p/3ec290cd31be81bab21cdd04b1555eaf) (Notion, checked 2026-09-30), https://developers.openai.com/plugins/build/extensions, https://developers.openai.com/plugins/build/mcp-events, https://developers.openai.com/plugins/plugin-guidelines, https://github.com/openai/mcp-extensions/blob/main/docs/spec.md, https://developers.openai.com/apps-sdk/deploy/submission, https://code.claude.com/docs/en/plugins-reference.

## Users and jobs to be done
- **As an indie developer in ChatGPT or Claude**, I want to say "set up monthly and annual Pro plans on iOS and Android, then check Apple and Google are connected," so one chat replaces the dashboard.
- **As a support person**, I want to find a customer by email, see why they lost access, then grant a week free, extend or refund, so a ticket closes in one chat.
- **As an owner on my phone**, I want "how is revenue this month and did any webhook fail," so I get numbers and failures without opening a laptop.
- **As a developer migrating from RevenueCat**, I want the migration skill to arrive with the connector, so the agent can run import status checks itself.

## Tier placement
| Capability | Tier | Why |
|---|---|---|
| 34 tools with annotations, titles, security schemes, structured results; OAuth upgrades (client ID metadata documents, `iss`, `project:support` step-up) | 1 | SCOPE principle 5; both directories reject lists without annotations and titles. **Built and live** |
| Plugin bundle in `revenuedot/agent-skills` (ChatGPT, Codex and Claude manifests, `.mcp.json`, 5 skills) | 1 | One repo installs on every product. **Built** |
| **ChatGPT tool profile at `/chatgpt/mcp`**: the same tools minus `refund-subscription` | 1 | OpenAI bans plugins that facilitate "money transfers"; a refund moves a customer's money. Claude and bearer-key users keep all 34 at `/mcp` |
| **Sign-up and sample project on the consent page** ("Create free account", "Start with sample data") plus `signup_source` | 1 | A stranger from a directory must reach a connected project with data in about 5 minutes, without leaving the chat. This is the activation step of the growth loop below |
| **Annotation justifications** for every tool, an upload ZIP (`plugin.json`, `mcp.json`, `skills/`, README, icons only), a support page, a listing that obeys OpenAI's copy rules | 1 | OpenAI's submission asks for each; the origin `https://mcp.revenuedot.app` cannot change after submission |
| Directory submissions: ChatGPT plugin directory, Claude connector directory, Claude Code and Codex marketplaces (GitHub, no review), MCP registries (official, Smithery, Glama, PulseMCP, Cursor directory) | 1 | Discovery. Needs Kai's verified OpenAI organization and a review account |
| Funnel numbers: connections per client, tool calls per tool, activation and 7-day return (no customer data) | 1 | Without them we cannot tell which listing works |
| **MCP 2.0 migration** of the Worker to `@modelcontextprotocol/server` (protocol `2026-07-28`) | 2 | Rich forms and MCP Events need it; plain tools keep working on the old protocol until then |
| **Cards** (MCP Apps): overview, customer, catalog map, webhook inspector, setup checklist, metric chart | 2 | Visible in ChatGPT and Claude, they carry the "run your subscriptions from chat" idea in one screenshot. Built once |
| **ChatGPT sidebar app "RevenueDot Home"** and conversation panels, deep links, model-app context | 2 | The daily-use surface for owners; extends the cards |
| **Confirmation forms** for cancel, refund and delete (typed customer id, reason) | 2 | The model cannot skip a human check that the host draws itself |
| **Plugin settings** (default project and environment, event preferences) | 2 | Removes repeated `project_id` and environment questions |
| **MCP Events** (first production sale, billing issue, cancellation, refund, webhook failing, store key invalid, MRR milestone, SDK first seen) | 2 | Pulls the owner back into ChatGPT every time money or trouble happens; ChatGPT only |
| Dashboard-side RevenueCat import (key saved in the dashboard, a tool starts and reads it) | 2 | The migration wedge without a credential in chat; today the importer is a CLI |
| Composer mentions (`@RevenueDot customer`), `.storekit` file viewer that imports products, shareable first-sale card, tools that write to App Store Connect and Google Play | 3 | Desktop-only or niche; the Play and Apple write tools need store write credentials we do not hold |

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
| | `grant-customer-entitlement` | W | write |
| | `set-customer-attributes`, `revoke-customer-entitlement`, `delete-customer` | D | write |
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

## Why this drives discovery, adoption and revenue
RevenueDot's promise in one line, as it appears in the ChatGPT subtitle (30 characters at most): **"Run subscriptions from chat"**. The promise rests on three facts the plugin makes visible through use, not through claims: every dashboard action is a tool (SCOPE principle 5); the data stays on a server the owner can run themselves (the Home screen names the server it talks to); and apps keep their existing SDK (the setup checklist shows the one-line change).

| Stage | What the user does | What we build | Number we watch |
|---|---|---|---|
| **Discover** | Searches a directory or asks an assistant for "set up in-app subscriptions" or "why can't my customer get Pro" | Listings in two directories and six registries; starter prompts that state jobs ("How is revenue this month?"); docs, `llms.txt` and blog pages for "RevenueCat alternative", which may compare because they are not reviewed by OpenAI | Directory views to connections |
| **Connect** | Taps Connect | The consent page takes a new person from nothing to a connected project: sign in or **create a free account** (email verification on Cloud), pick **sample data** or an empty project, choose read or change, money actions off by default | Consent page starts to completed connections (target 60%) |
| **Activate** | Asks the first question | Sample project answers it at once (a Test Store subscription, a `pro` entitlement, two customers). The **setup checklist** card then walks: first test purchase, Apple key, Google key, SDK seen, webhook, first real sale. Store keys are typed in the dashboard, never in chat | Connected to first test purchase or SDK seen within 24 hours (target 40%) |
| **Habit** | Comes back | **MCP Events** and the weekly check skill: "tell me here when a sale or a billing problem happens"; the Home sidebar app | Connections active 7 days later (target 35%) |
| **Pay** | Goes live and starts Pro | Cloud billing sits in the dashboard (SCOPE Tier 2). **Nothing in the plugin sells or links to checkout**, because OpenAI bans it; activation and habit feed the dashboard, where the plan page lives | Plugin-sourced signups that become paying |
| **Advocate** | Tells another developer | Tier 3 share card for the first sale; the open-source repos and skills people can star and fork | Stars, installs of the skills |

Customer value, stated as numbers we can test: a connected project with data in about 5 minutes; a support ticket closed in at most three tool calls (`list-customers`, `get-customer`, one remedy); the owner learns of a billing problem or a failing webhook in chat within a minute instead of at the next dashboard visit.

## What each surface shows and which tool declares it
Cards and panels read data through the same tools and keep bulk data in the result's `_meta`, because ChatGPT shows `structuredContent` to the model. They use the locked neutral design (`design/tokens.css`, white and grey, dark mode, no tinted backgrounds) and work at phone width.

| Surface | Product | Tier | What it shows and does |
|---|---|---|---|
| **Overview card** (`get-metrics`) | ChatGPT, Claude | 2 | MRR, revenue, active subscriptions, trials, new customers for 28 days with a sparkline; a one-line "Connected to api.revenuedot.app" footer (or the self-hosted address) |
| **Customer card** (`get-customer`) | ChatGPT, Claude | 2 | A banner that says in words whether and why they have access ("Pro until 12 Oct through Google Play"), their subscriptions, the last events as a timeline, and buttons: grant 7 days, extend, cancel (money actions open the confirmation form) |
| **Catalog map** (`list-offerings`, `list-entitlements`) | ChatGPT, Claude | 2 | Products to entitlements to offerings as a tree; a warning where a product is not attached to an entitlement or package, with a fix button |
| **Webhook inspector** (`list-webhook-deliveries`) | ChatGPT, Claude | 2 | Deliveries with status, HTTP code and last error; Retry and Send test buttons |
| **Setup checklist** (`get-project-health`) | ChatGPT, Claude | 2 | The six steps above with green ticks, the project's proxy URL to copy, SDK versions seen |
| **Test purchase card** (`create-test-purchase`) | ChatGPT, Claude | 2 | The lifecycle that ran and the events it produced; the proof that the setup works |
| **Sidebar app "RevenueDot Home"** (`global` entry point) | ChatGPT | 2 | Fullscreen: overview, checklist until done, "needs attention" (failing webhook, billing issues, a store key that stopped working) with fix buttons, live event feed, customer search |
| **Conversation panel** (`thread` entry point) | ChatGPT | 2 | The customer card or catalog map open beside the chat while the user keeps asking |
| **Confirmation form** (rich form, `openai/elicitation/create`, multi-round-trip) | ChatGPT; Claude uses its own approval prompt | 2 | Names the customer and product, asks for a reason and the customer id typed back; the only way `cancel-subscription` and `delete-customer` run |
| **Plugin settings** (`openai/settings` read and update tools) | ChatGPT | 2 | Default project, default environment (production or sandbox), which events to push; the money-action confirmation cannot be turned off |
| **Model-app context** (`ui/update-model-context`) | ChatGPT | 2 | The open customer or project is shared with the chat, so "extend this one by 3 days" needs no id |
| **Deep links** | ChatGPT | 2 | An event message links to that customer in the sidebar app |
| Composer mentions, `.storekit` viewer | ChatGPT | 3 | `@RevenueDot` searches customers, products and offerings (desktop only); opening an Xcode `.storekit` file lists its products with an Import button |

## MCP Events
Events let ChatGPT watch the project on the user's behalf: the user says "tell me here when my first real purchase arrives" and ChatGPT subscribes. The RevenueDot server already records every store event and delivers webhooks with signing and retries; MCP Events reuse that machinery.

| Event | Filters | Payload (ids and amounts only, no email or name) |
|---|---|---|
| `purchase.first_production` | `app_id` | app, product, price in USD, time. The first real sale in the project, the moment the owner has been waiting for |
| `subscription.started`, `subscription.renewed`, `subscription.cancelled`, `subscription.billing_issue`, `subscription.expired`, `subscription.refunded` | `environment`, `app_id`, `product_id`, `min_amount_usd` | customer id, product, store, amount, time |
| `webhook.failing` | `webhook_id` | webhook, last error, HTTP status |
| `store.credentials_invalid`, `store.notifications_stopped` | `app_id` | app, store, since when (from the existing alert checks) |
| `metric.milestone` | `metric` (`mrr`), thresholds from $100 | metric, value, threshold crossed |
| `sdk.first_seen` | `app_id` | platform, SDK version |

- **Server side:** three JSON-RPC methods on the MCP Worker, backed by a table of subscriptions in the API (project, the OAuth key that subscribed, event name, canonical arguments, callback URL, signing secret, expiry). A subscription is the same for the same key, callback, event and arguments (idempotent). Deleting the OAuth key deletes its subscriptions.
- **Delivery:** one POST per event with Standard Webhooks headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) and `X-MCP-Subscription-Id`, at most 256 KiB, through the existing retry queue with the same event id on each retry; a `410` or `413` stops it. The callback must be HTTPS and not a private or local address, and redirects are not followed; a signed one-time challenge is sent on subscribe.
- **Expiry:** subscriptions last 30 days and ChatGPT refreshes them before `refreshBefore`.
- **Claude and others** have no events: they get the same facts from the existing webhooks, the alert emails (SCOPE 1.18) and the weekly check skill.
- **Needs** MCP protocol `2026-07-28`. The installed SDK `@modelcontextprotocol/sdk` 1.31.0 does not speak it; `@modelcontextprotocol/server` 2.2.0 does. A spike on the migration comes first in Tier 2.

## Rules from the directories that shape the design
- **OpenAI listing copy** (name and subtitle at most 30 characters, up to 3 starter prompts, exactly 5 positive and 3 negative test cases, a demo video, a support page, a login for a fully featured demo account) must not mention pricing, free plans, trials, discounts or comparisons. RevenueCat appears only in docs, skills and the Claude listing, never in the OpenAI listing text.
- **No selling and no checkout links.** OpenAI bans plugins that sell subscriptions or link to a page that starts a purchase or upgrade. RevenueDot administers the owner's own app data and sells nothing in the chat; the review notes say so. No card, widget or tool result carries an upgrade or checkout link.
- **No money movement.** `refund-subscription` is left out of the ChatGPT profile. Cancelling and extending stay.
- **No credentials.** No input takes a key, password or token. Store keys go through the dashboard; the checklist links there.
- **One tool per operation, annotations justified.** Each tool is its own reviewed operation (no generic "run any action" tool). `submission/annotation-justifications.md` gives the reason for every `readOnlyHint`, `destructiveHint` and `openWorldHint`; a test fails when a tool lacks one.
- **Minimal responses.** Results carry what the question needs; lists are paged. A slimmer default shape for `get-customer` is a Tier 2 task if review asks for it.
- **Widget data goes in `_meta`**, text the model should read goes in `structuredContent`.
- **The server origin never changes** after submission: `https://mcp.revenuedot.app`.

## Build order
1. **Tier 1 now:** fix listing copy (30 characters, no comparisons or pricing), the `/chatgpt/mcp` profile, annotation justifications with their test, the upload ZIP, support page link, the consent page sign-up and sample data, `signup_source`, funnel counters. Then Kai's steps: verified OpenAI organization, review account, domain token, demo video, submit both directories; list on the marketplaces and registries the same day.
2. **Tier 2, first week after listing:** the MCP 2.0 spike; the six cards (they appear in both products); confirmation form; sidebar app and panels; settings; MCP Events in the order `purchase.first_production`, `subscription.billing_issue`, `webhook.failing`, then the rest.
3. **Tier 2 follow-ups:** dashboard-side RevenueCat import and its tool; slimmer result shapes if review asks.
4. **Tier 3:** composer mentions, `.storekit` viewer, share card.

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

| ChatGPT profile: `/chatgpt/mcp` lists 33 tools without `refund-subscription`; `/mcp` lists 34; both pass the listing checks | `../../mcp/test/listing.test.ts` |
| Every tool has an annotation justification; the listing copy has a name and subtitle of at most 30 characters and no price, free, trial or comparison words; the upload ZIP holds only `plugin.json`, `mcp.json`, `skills/`, README and icons | `../../../agent-skills/test/plugin.test.mjs` |
| Consent page: create an account, load sample data, connect; the sample project answers `get-metrics`, `list-customers` and `get-project-health`; `signup_source` is saved | `../../apps/server/test/oauth.test.ts`, `signup.test.ts` |
| Tier 2: card resources render without errors in an MCP Apps host test; events: subscribe, verify, deliver, retry, 410 stops, key deletion removes subscriptions | `../../mcp/test/apps.test.ts`, `events.test.ts` |

No test yet (needs Kai's accounts): a real sign-in from ChatGPT developer mode and Claude Desktop; directory review.

## Submission checklist (Kai's part, with the exact materials prepared by us)
- ChatGPT: verify the domain (value from the dashboard into `OPENAI_APPS_CHALLENGE`), privacy policy URL (https://revenuedot.app/legal/privacy), test account on production with a seeded sandbox project, 5 positive and 3 negative test prompts, demo recording.
- Claude: submit the connector form, same test account, 3 to 5 screenshots of at least 1000 px, privacy policy URL.
- Materials live in `revenuedot/agent-skills/submission/` and are written by us.

## Known gaps and next steps
1. Tokens never expire and have no refresh token (both products work with that; add refresh when a directory asks).
2. Cards, sidebar app, forms, settings and MCP Events are Tier 2 and need the MCP 2.0 migration for forms and events.
3. `create-test-purchase` needs the `project:support` scope because purchase refunds share the same API permission.
4. The directories' reviews take days; listing is not under our control.
