# RevenueDot AI: the in-app assistant (Tier 2, batch E) and its Tier 3 extras

**Status:** built on branch `tier2-ai-assistant` (2026-10-01). Tested with a fake model only; no real model has answered yet. Live model runs (Workers AI on Cloud, Anthropic or OpenAI on self-host) wait for a deploy and a key.

Scope rows: `prd/SCOPE.md` Tier 2 "RevenueDot AI: an in-app durable agent (Cloudflare Agents, ai-elements UI) that shares its tools with the MCP server" and Tier 3 "AI extras: composer mentions, a `.storekit` file viewer that imports products, a shareable first-sale card". Parity rows: `company/docs/research/parity-matrix.md` ("Rico AI chat", Overview "Ask AI" bar, Project settings → AI features) and frame 29 (`contact-sheets/revenuecat/frames/29-rico-ai.jpg`).

## Users and jobs
- **Founders and growth people** ask questions in plain words ("why did MRR drop this week?", "which offering converts best?") and want an answer grounded in their own numbers, with the chart or customer it came from.
- **Support** looks up a customer from a screenshot or an email, reads their history, and grants a week of Pro without opening four pages.
- **Developers** check setup health, failing webhooks and the catalog, and fix small things (attach a product, set the current offering, replay a failed delivery) from one place.
- **Admins** decide what the assistant may do in a project: read and write with permission, read only, or nothing.

## What RevenueCat ships (frame 29, parity notes)
- A full page: a history rail ("chat history", search, **New conversation**, a Configuration → Settings link), a greeting by first name and time of day ("Morning, Kai"), one line about what the assistant does, and a composer ("Ask about insights or growth opportunities for your apps") with **Attach image** and a send arrow.
- An Overview bar with the same prompt that opens a conversation.
- Project settings → **AI features**: read and write with permission, read only, or disabled. A collaborator's role limits it further.

## What we build

### 1. Two runtimes, one agent
| | RevenueDot Cloud (Workers) | Self-host (Node) |
|---|---|---|
| Where a conversation lives | One Cloudflare Agents Durable Object per conversation (`AssistantAgent`, `@cloudflare/ai-chat` `AIChatAgent`, SQLite storage) | Postgres: `ai_messages`, `ai_streams`, `ai_stream_chunks` |
| Transport | WebSocket (`useAgentChat`), resumable streams built in | HTTP POST that answers with a UI message stream over SSE; `GET …/stream` resumes from the stored chunks |
| Crash and deploy recovery | Agents' durable chat turns (`chatRecovery`) | Chunks are written as they stream; a stream with no chunk for 60 s is marked interrupted and the UI offers Retry |
| Model | Workers AI binding `AI` (no key, billed to the Circo account), `@cf/moonshotai/kimi-k2.6` | `AI_GATEWAY_API_KEY` → Vercel AI Gateway `anthropic/claude-opus-5.5` (Cloud too: it wins over Workers AI), else `ANTHROPIC_API_KEY` → `claude-opus-5-5`, else `OPENAI_API_KEY` → `gpt-6-astra` |

- Both runtimes call one function, `runAssistantTurn` (`apps/server/src/services/assistant/agent.ts`): AI SDK 7 `streamText` with the same instructions, tools, approval rules and caps. Only storage and transport differ.
- The conversation list (title, owner, project, dates) is always in Postgres (`ai_conversations`), so the history rail, rename, delete and search work the same on both.
- **Model choice:** the strongest tool-calling model each provider offers on 2026-10-01: Workers AI's Kimi K2.6 (1T parameters, 262k context, function calling and vision), Anthropic's Claude Opus 5.5, OpenAI's GPT-6 Astra. `REVENUEDOT_ASSISTANT_MODEL` overrides the model id. No temperature is sent (Opus 5.5 rejects it) and tool choice stays `auto`.
- **No model, no assistant.** Without a model the `/ai` page, the Overview bar and the AI features tab say how to turn it on (self-host: set a key), and every assistant route answers 503.
- Pins: `ai@7.0.60`, `@ai-sdk/react@4.0.63` (exact; 7.0.61 breaks the post-approval resume), `agents@0.24.0`, `@cloudflare/ai-chat@0.12.0`.

### 2. Tools
Tools are defined in the MCP server's format (`name`, `title`, `description`, zod `inputSchema`, `annotations`, `scopes`, `run(client, args)`) in `apps/server/src/services/assistant/tools.ts`, with the MCP server's names and behaviour where a tool exists there, so one module can serve both later. `run` gets a client with the MCP client's interface (`request(method, path, { query, body })`), but the client calls the REST API v2 router in-process as the signed-in user. Every role check, validation and audit entry is the API's own.

**Read tools** (always shown when the project allows the assistant): `get-metrics` (overview cards or one metric's history), `list-charts`, `get-chart` (any of the 43 charts, compacted to at most 60 rows), `list-customers` (search by app user id, email or transaction id), `get-customer`, `list-events` and `list-transactions` (a customer's history), `list-apps`, `list-products`, `list-entitlements`, `list-offerings`, `list-paywalls`, `list-targeting-rules`, `list-experiments`, `get-experiment-results`, `get-project-health`, `list-webhook-integrations`, `list-webhook-deliveries`, `list-integrations` (partner integrations with their delivery health), `get-import-status`, and since batch H `get-attribution-report` and `get-benchmarks` (prd/attribution-benchmarks-insights). Weekly growth insights reuse these read tools with a read-only actor.

**Write tools** (always behind an in-chat approval card): `grant-customer-entitlement`, `revoke-customer-entitlement`, `create-product`, `attach-products-to-entitlement`, `attach-products-to-package`, `set-current-offering`, `start-experiment`, `pause-experiment`, `retry-webhook-delivery`, `replay-failed-webhook-deliveries` (every failed delivery of one webhook in the last N days, at most 100), `import-storekit-products`.

**Scoping**, decided per turn on the server:
- The project's AI setting (`projects.ai_access`): `read_write` (default; write tools ask first), `read_only` (write tools are not offered), `disabled` (no assistant for anyone in the project).
- The collaborator's role: a Viewer gets read tools only; a Developer and an Admin get every tool their role allows in the API (`allows()` in `routes/v2/common.ts`). A tool whose scopes the role lacks is not offered, and the API refuses it anyway.
- **Confirmation:** every write tool has `needsApproval: true`. The turn stops with the tool part in `approval-requested`; the UI shows a card that says what will change ("Grant Pro to wjqx8kd2rn1 until Nov 8, 2026") and every argument the write will run with, with Approve and Deny. Approval requests are signed with an HMAC over the approval id, tool call id, tool name and input (`experimental_toolApprovalSecret`, keyed from `REVENUEDOT_ENCRYPTION_KEY` or the signing key), so a browser cannot forge an approval or change the input after approving. On self-host the server only takes the approval decision from the client, never message content. On Cloud the Durable Object stores what the browser sends, so without a key to sign with the write tools are not offered there. The object's own copy of an answer keeps no signature (agents 0.24), so it records each signature it issues in its storage and puts it back on that approval before the next turn.
- **Each approval runs once:** before a write runs, its tool call is claimed in `ai_tool_runs` (conversation, tool call id). A replayed, resent or concurrently submitted approval of the same call finds the row and is refused. On self-host one answer streams at a time per conversation (a unique index on the running stream is the lock), so two tabs approving the same card run it once.
- **Prompt injection:** customer attributes, product names and files reach the model as data. Approval is the guard for writes. Answers render markdown without raw HTML and without images (an image URL could carry data out without a click); links are dashboard paths or https URLs.
- **No secrets:** tool results pass through a redactor that replaces any key named like a secret, password, private key, credentials, token or signing key with `[hidden]`; the assistant has no tool that creates keys, webhooks with secrets or store credentials.
- **Audit:** writes go through the v2 audit middleware with actor type `assistant`, actor = the user's id, and `additional_data.actor_display = "assistant on behalf of <email>"`, plus the conversation id. The Audit logs tab shows "RevenueDot AI on behalf of kai@…". A change to the AI setting is logged as `ai_settings_updated`; chats, uploads and conversations are not project changes and are not logged.
- **Requests:** writes with the session cookie must come from the dashboard's own origin (`Sec-Fetch-Site` same-origin), so a page on a sibling host cannot drive a chat or approve a card. The Durable Object socket checks the same, plus the Origin.

### 3. UI (ai-elements on the design tokens)
- `/projects/:id/ai` and `/projects/:id/ai/:conversationId`, linked as **RevenueDot AI** in the sidebar under Overview.
- History rail (232px, hairline): search, **New conversation**, conversations newest first with rename and delete in a menu, "Settings" linking to the AI features tab.
- Empty conversation: gold sparkle, "Morning, Kai" (morning before 12, afternoon before 18, evening after), one line ("I'm RevenueDot AI. I read your revenue, customers and catalog, and I change things only after you approve."), the composer, and four example prompts.
- Messages: AI Elements `Conversation`, `Message`, `MessageResponse` (Streamdown markdown), `Tool` cards (title, status, input, compact result), `Confirmation` cards for writes, `Shimmer` while thinking, an error banner with **Retry**, Stop while streaming.
- Composer: AI Elements `PromptInput` with **Attach image** (PNG, JPEG, WebP, GIF up to 5 MB, four per message, stored in Postgres `ai_files`), **Attach .storekit**, and `@` mentions.
- Overview: the AI bar becomes a real input ("Ask about insights or growth opportunities"); Enter creates a conversation with that question and opens it. `/` focuses it.
- Project settings → **AI features**: three radio cards (read and write with permission, read only, disabled), what each role can do, the model in use, and today's usage against the caps. Only admins can change it.
- Square corners, hairlines, one gold accent (the sparkle and the focus ring), both themes. ai-elements and shadcn components are copied into `apps/dashboard/src/components/{ai-elements,ui}` and themed by mapping shadcn's variables to our tokens (`src/styles/ai.css`). Tailwind's utilities load in a layer above `app.css`; Tailwind's preflight is not loaded.

### 4. Tier 3 extras
- **Composer mentions:** typing `@` opens a list of customers (search), offerings and charts; picking one inserts `@label` and attaches `{ type, id }` to the message metadata. The server loads each mention's context (customer summary, offering with packages, chart summary) into the model's view of that message, not into the saved transcript.
- **`.storekit` viewer and import:** a StoreKit configuration file (Xcode's JSON, `"identifier"`, `"products"`, `"subscriptionGroups"`, `"nonRenewingSubscriptions"`) is parsed by `parseStoreKitConfig` in `packages/core` (types, durations, prices, intro offers, localizations, group names). The chat shows a card with the products; "Import into catalog" asks the assistant to run `import-storekit-products`, which creates the missing products on a chosen App Store app (skipping ones that exist) after approval.
- **First-sale card:** when a project's first production purchase arrives (the tick checks projects without a card), RevenueDot saves a card (`ai_share_cards`: product, price, store, country, time, project name) with an unguessable token (18 random bytes). The tick starts from projects without a card and probes each one's recent transactions by index. The Overview shows it once with Share and Dismiss. `GET /share/first-sale/<token>` is a public page with Open Graph tags; `GET /share/first-sale/<token>.svg` is the 1200×630 image. Nothing personal is shown (no app user id).

### 5. Rate limits and cost caps (Postgres)
- Per person: 20 turns a minute, 200 turns and 2,000,000 tokens a day. Per project: 600 turns and 6,000,000 tokens a day. Per server: 20,000 turns and 200,000,000 tokens a day. Override with `REVENUEDOT_ASSISTANT_CAPS` (JSON).
- Turns per minute use the `rate_limits` table (`hit()`, as the paywall generator does). Daily turns are taken atomically: one statement adds the turn to the person's, the project's and the server's `ai_usage` rows and the turn is taken back when any row went over its cap, so concurrent turns on any number of isolates cannot pass a cap together. Tokens are added from the model's usage per step; a turn stops after the step that used up a token cap. A refused turn answers with an error the chat shows ("You have used today's 200 questions"); no model call is made.
- The model reads the last 60 messages of a conversation and screenshots from the last 3 user messages; a `.storekit` summary lists at most 200 products. Uploads: 60 an hour per person, the image's bytes must match its type.
- One turn runs at most 8 model steps; tool results are cut to 12,000 characters.

### 6. API (all session or secret-key authenticated, under `/v2/projects/{project_id}`)
| Method and path | What it does |
|---|---|
| `GET /ai` | Status: available, provider, model, runtime (`durable_object` or `sse`), access, role, can_read, can_write, greeting name, today's usage and caps |
| `POST /ai/settings` | `{ access }`, admins only |
| `GET /ai/conversations?q=` / `POST /ai/conversations` | List (newest first, search titles) / create `{ title? }` |
| `GET /ai/conversations/{id}` | One conversation with its messages (self-host) |
| `POST /ai/conversations/{id}` / `DELETE /ai/conversations/{id}` | Rename `{ title }` / delete (and its Durable Object on Cloud) |
| `POST /ai/conversations/{id}/chat` | Send `{ message, trigger }`; answers a UI message stream (SSE) |
| `GET /ai/conversations/{id}/stream` | Resume the running answer; 204 when nothing runs |
| `POST /ai/conversations/{id}/stop` | Stop the running answer |
| `POST /ai/files` / `GET /ai/files/{id}` | Upload an image or `.storekit` file (raw body, `?name=`) / read it back (members only, not secret keys) |
| `POST /ai/storekit` | Parse a `.storekit` file and return its products |
| `GET /ai/mentions?q=` | Customers, offerings and charts for `@` mentions |
| `GET /ai/first_sale` / `POST /ai/first_sale/dismiss` | The first-sale card, if any / hide it on the Overview (admins and developers) |
| `GET /agents/assistant-agent/{conversation_id}` | Cloud only: the conversation's Durable Object (WebSocket), after the same session and ownership checks |

### 7. Data (migration 0020)
`projects.ai_access`, `ai_conversations`, `ai_messages`, `ai_streams` (with `ai_streams_one_running`, a unique index on the conversation while an answer streams), `ai_stream_chunks` (text deltas merged per write, at most 20,000 rows an answer, pruned a day after the answer ends), `ai_files`, `ai_tool_runs`, `ai_usage`, `ai_share_cards`, `projects.first_sale_dismissed_at`.

## Tests
- `apps/server/test/assistant-tools.test.ts`: scoping by role and AI setting, confirmation required for every write tool, audit entries with the assistant actor, secrets redacted.
- `apps/server/test/assistant-agent.test.ts`: the agent loop with a scripted fake model: a read tool call → result → answer; a write tool call → approval card → approve → the write runs and is audited; deny → nothing changes; caps refuse a turn.
- `apps/server/test/assistant-stream.test.ts`: SSE streaming, resume from stored chunks mid-answer, stale streams marked interrupted, conversations CRUD and ownership.
- `apps/server/test/assistant-security.test.ts`: an approval runs once (two tabs at once, a replayed signed approval in a browser-held transcript), an edited input fails the signature, no write tools without a signing key on the Durable Object path, the audit log keeps chats out, cross-site cookie writes are refused, model ids cannot leave their route, upload checks, caps under concurrency, token caps stop a turn, the model's message window.
- `packages/core/test/storekit.test.ts`: the parser against real-format `.storekit` fixtures (subscriptions with intro offers, consumables, non-consumables, non-renewing), names like `constructor` in the file, and the limits (500 products, 50 warnings, 300 characters a string).
- `apps/dashboard/e2e/do-smoke.mjs`: the Durable Object runtime under `cf dev` with the fake model.
- `apps/dashboard/e2e/assistant.spec.ts` (fake model, `E2E_PORT=5408`, one worker): open `/ai`, ask, see a tool card, approve a write, see the result; the Overview bar; the settings tab; screenshots at 1440×900 light and dark.

## Gaps
- No live model run yet (needs a deploy for Workers AI, a key for self-host).
- The Durable Object path is not in the Playwright run (which uses the Node runtime); it passed a local run under `cf dev` with the fake model and a signing key (`apps/dashboard/e2e/do-smoke.mjs`, steps in `docs/cloud.md`), not yet on Cloudflare.
- Tools that write to App Store Connect and Google Play (Tier 3) are not built; `create_in_store` exists in the API and can become a tool later.
- The assistant's own settings (instructions, memory) from RevenueCat's assistant are not built.
