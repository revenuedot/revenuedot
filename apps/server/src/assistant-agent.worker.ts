// RevenueDot AI on RevenueDot Cloud (prd/ai-assistant/PRD.md §1): one Cloudflare Agents Durable Object per conversation.
// `AIChatAgent` (@cloudflare/ai-chat) keeps the transcript in the object's SQLite, streams over a WebSocket, buffers
// chunks so a reload resumes mid-answer, recovers turns after a deploy or eviction, and parks write tools until the user
// approves. Each turn calls the same `runAssistantTurn` as the self-host runtime, with its own Postgres connection
// (Hyperdrive). Exported from entry.worker.ts; bound as `AssistantAgent` in cloudflare.config.ts.
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import { and, eq } from "drizzle-orm";
import { connectPostgres, schema, type DB } from "@revenuedot/db/worker";
import { createApp } from "./app.js";
import { loadAssistantContext, runAssistantTurn, titleFrom } from "./services/assistant/agent.js";
import { touchConversation } from "./services/assistant/store.js";
import { refusalResponse } from "./routes/v2/assistant.js";
import { SESSION_COOKIE, sessionUser } from "./services/sessions.js";
import { baseDeps, type Env } from "./worker-deps.js";

/** Set by the Worker after it checked the session; the Durable Object is never reachable without passing through it. */
const USER_HEADER = "x-revenuedot-ai-user";
const PROJECT_HEADER = "x-revenuedot-ai-project";
const PATH = /^\/agents\/assistant-agent\/(aic[A-Za-z0-9]+)(?:\/.*)?$/;

const json = (status: number, message: string) => new Response(JSON.stringify({ object: "error", type: status === 401 ? "authentication_error" : "resource_missing", message }), { status, headers: { "content-type": "application/json" } });

function cookie(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/**
 * `/agents/assistant-agent/<conversation id>`: the dashboard's session must own the conversation (and still be a member
 * of its project), and a WebSocket must come from the same origin (no cross-site socket hijacking). Then the request
 * goes to the conversation's Durable Object with the user and project in headers the browser cannot set.
 */
export async function routeAssistantAgent(req: Request, env: Env, db: DB): Promise<Response> {
  const url = new URL(req.url);
  const m = PATH.exec(url.pathname);
  if (!m || !env.AssistantAgent) return json(404, "Not found.");
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json(404, "Not found.");
  const user = await sessionUser(db, cookie(req, SESSION_COOKIE), new Date());
  if (!user) return json(401, "Sign in to use RevenueDot AI.");
  const [conv] = await db.select({ projectId: schema.aiConversations.projectId }).from(schema.aiConversations)
    .innerJoin(schema.memberships, and(eq(schema.memberships.projectId, schema.aiConversations.projectId), eq(schema.memberships.userId, user.id)))
    .where(and(eq(schema.aiConversations.id, m[1]!), eq(schema.aiConversations.userId, user.id), eq(schema.aiConversations.runtime, "durable_object"))).limit(1);
  if (!conv) return json(404, "Conversation not found.");
  const headers = new Headers(req.headers);
  headers.set(USER_HEADER, user.id);
  headers.set(PROJECT_HEADER, conv.projectId);
  const res = await routeAgentRequest(new Request(req, { headers }), env);
  return res ?? json(404, "Not found.");
}

interface Owner { userId: string; projectId: string }

export class AssistantAgent extends AIChatAgent<Env> {
  /** Old turns stay in the conversation; the model sees what `runAssistantTurn` prepares. */
  maxPersistedMessages = 400;
  /** A provider that stops streaming for 2 minutes is treated like an interruption and recovered. */
  chatStreamStallTimeoutMs = 120_000;
  private conn: { db: DB; close(): Promise<void> } | null = null;
  // From DurableObject (cloudflare:workers); declared here because the shared tsconfig has no Workers types.
  declare readonly ctx: { storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> } };
  declare readonly env: Env;

  private async owner(): Promise<Owner | null> {
    return (await this.ctx.storage.get<Owner>("owner")) ?? null;
  }

  /** The first connection claims the conversation for its user and project; any other user is refused. */
  override async onConnect(connection: Parameters<AIChatAgent<Env>["onConnect"]>[0], context: Parameters<AIChatAgent<Env>["onConnect"]>[1]) {
    const userId = context.request.headers.get(USER_HEADER);
    const projectId = context.request.headers.get(PROJECT_HEADER);
    if (!userId || !projectId) { connection.close(4401, "Unauthorized"); return; }
    const owner = await this.owner();
    if (!owner) await this.ctx.storage.put<Owner>("owner", { userId, projectId });
    else if (owner.userId !== userId || owner.projectId !== projectId) { connection.close(4403, "Forbidden"); return; }
    return super.onConnect(connection, context);
  }

  override async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions): Promise<Response | undefined> {
    const owner = await this.owner();
    if (!owner) return refusalResponse("This conversation has no owner yet. Reload the page.");
    await this.closeConnection();
    const conn = connectPostgres(this.env.HYPERDRIVE.connectionString);
    this.conn = conn;
    // A fresh app on this turn's connection; the assistant's tools call its REST API v2 in-process.
    const deps = { ...baseDeps(this.env), db: conn.db };
    const app = createApp(deps);
    const withDispatch = { ...deps, dispatch: (req: Request) => Promise.resolve(app.fetch(req)) };
    if (!deps.assistant) return refusalResponse("RevenueDot AI has no model on this server.");
    const ctx = await loadAssistantContext(withDispatch, deps.assistant, owner.userId, owner.projectId, this.name);
    if (!ctx) return refusalResponse("You are no longer a member of this project.");
    const turn = await runAssistantTurn(ctx, this.messages, { abortSignal: options?.abortSignal });
    if ("refused" in turn) return refusalResponse(turn.refused);
    const users = this.messages.filter((x) => x.role === "user");
    const first = users.length === 1 && !options?.continuation ? users[0]!.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ") : "";
    await this.touch(first ? titleFrom(first) : undefined);
    return turn.result.toUIMessageStreamResponse({ sendReasoning: false, onError: (e: unknown) => (e instanceof Error ? e.message : String(e)) } as never);
  }

  /** After every turn (completed, failed or stopped): bump the conversation in the history rail, then close Postgres. */
  protected override async onChatResponse() {
    await this.touch().catch(() => {});
    await this.closeConnection();
  }

  private async touch(title?: string) {
    if (!this.conn) return;
    const now = new Date();
    if (title) {
      await this.conn.db.update(schema.aiConversations).set({ title, updatedAt: now })
        .where(and(eq(schema.aiConversations.id, this.name), eq(schema.aiConversations.title, "New conversation")));
    }
    await touchConversation(this.conn.db, this.name, now);
  }

  private async closeConnection() {
    const c = this.conn;
    this.conn = null;
    await c?.close().catch(() => {});
  }
}
