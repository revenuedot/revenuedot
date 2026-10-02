import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import { CHARTS, newId, parseStoreKitConfig, StoreKitParseError } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { assistantScope, AI_ACCESS } from "../../services/assistant/access.js";
import { loadAssistantContext, runAssistantTurn, titleFrom, toolNamesFor, type AssistantContext } from "../../services/assistant/agent.js";
import { DEFAULT_CAPS, startTurn, usageToday } from "../../services/assistant/limits.js";
import { displayInsights, generateInsights, InsightsError, weekOf } from "../../services/insights/generate.js";
import {
  activeStream, appendChunks, conversationShape, createConversation, deleteConversation, dropStream, findConversation, finishStream, lastStream, listConversations,
  loadMessages, readChunks, saveMessages, startStream, streamStatus, touchConversation,
} from "../../services/assistant/store.js";
import { firstSaleCard } from "../../services/assistant/first-sale.js";
import { allows, body, notFound, paramError, scope as needs, V2Error, type V2Context, type V2Router } from "./common.js";
import { publicOrigin } from "./setup.js";
import { hit } from "../../services/rate-limit.js";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../../services/sessions.js";

/**
 * RevenueDot AI (prd/ai-assistant/PRD.md §6):
 *   GET    /v2/projects/{id}/ai                                   status: model, runtime, access, role, usage
 *   POST   /v2/projects/{id}/ai/settings                          { access } (admins)
 *   GET    /v2/projects/{id}/ai/conversations?q=                  the signed-in user's conversations
 *   POST   /v2/projects/{id}/ai/conversations                     { title? }
 *   GET    /v2/projects/{id}/ai/conversations/{cid}               with messages (self-host runtime)
 *   POST   /v2/projects/{id}/ai/conversations/{cid}               rename { title }
 *   DELETE /v2/projects/{id}/ai/conversations/{cid}
 *   POST   /v2/projects/{id}/ai/conversations/{cid}/chat          { message, trigger } → UI message stream (SSE)
 *   GET    /v2/projects/{id}/ai/conversations/{cid}/stream        resume the answer being written (204 when none)
 *   POST   /v2/projects/{id}/ai/conversations/{cid}/stop
 *   POST   /v2/projects/{id}/ai/files?name=                       raw body: an image or a .storekit file
 *   GET    /v2/projects/{id}/ai/files/{fid}[?format=text|storekit]
 *   POST   /v2/projects/{id}/ai/storekit                          raw body → parsed products
 *   GET    /v2/projects/{id}/ai/mentions?q=                       customers, offerings, charts for @ mentions
 *   GET    /v2/projects/{id}/ai/first_sale, POST …/first_sale/dismiss
 * Conversations belong to one user; another member's conversation answers 404. Secret API keys can read the status and
 * change the setting, nothing else.
 */

const A = "/v2/projects/:project_id/ai";
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_STOREKIT = 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 4;
/** Stored chunks per answer (after merging text deltas); an answer longer than this ends with an error. */
const MAX_STREAM_CHUNKS = 20_000;
/** Uploads per person per hour (images are kept in Postgres). */
const UPLOADS_PER_HOUR = 60;

/** Leading bytes of each image type we accept, so a file is what its content type says. */
const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

/** Merges consecutive text deltas of the same part into one chunk, so a stored answer is one row per flush, not per token. */
export function coalesce(chunks: UIMessageChunk[]): UIMessageChunk[] {
  const out: UIMessageChunk[] = [];
  for (const ch of chunks) {
    const prev = out[out.length - 1];
    if (ch.type === "text-delta" && prev?.type === "text-delta" && prev.id === ch.id) out[out.length - 1] = { ...prev, delta: prev.delta + ch.delta };
    else out.push(ch);
  }
  return out;
}

/** Answers being written in this process, so Stop can cancel the model call (Node; Workers use the Durable Object). */
const running = new Map<string, AbortController>();

// A chart mention may carry the chart page's view (prd/charts/PRD.md "Ask AI"); agent.ts keeps only the keys it knows.
const Mention = z.object({ type: z.enum(["customer", "offering", "chart"]), id: z.string().min(1).max(200), label: z.string().max(200).optional(), params: z.record(z.string(), z.string().max(4000)).optional() });
const IncomingPart = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(20_000) }),
  z.object({ type: z.literal("file"), url: z.string().max(500), mediaType: z.string().max(100), filename: z.string().max(255).optional() }),
]);
const ChatBody = z.object({
  trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
  messageId: z.string().optional(),
  message: z.object({
    id: z.string().min(1).max(100),
    role: z.enum(["user", "assistant"]),
    parts: z.array(z.record(z.string(), z.unknown())).max(200),
    metadata: z.object({ mentions: z.array(Mention).max(5).optional() }).passthrough().optional(),
  }).optional(),
});

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isStoreKitName = (n: string) => /\.storekit$/i.test(n);

/** A stream response with one error chunk: how a refused turn shows in the chat (no model call was made). */
export function refusalResponse(errorText: string) {
  return createUIMessageStreamResponse({ stream: createUIMessageStream({ execute: ({ writer }) => { writer.write({ type: "error", errorText }); } }) });
}

/**
 * Applies only the approval decisions from a message the browser sent back. Everything else comes from the stored
 * transcript, so a client cannot change tool inputs, results or earlier messages. Returns how many approvals applied.
 */
export function applyApprovals(stored: UIMessage, incoming: { parts: Record<string, unknown>[] }): number {
  let n = 0;
  for (const p of incoming.parts) {
    const ap = p.approval as { id?: unknown; approved?: unknown; reason?: unknown } | undefined;
    if (!ap || typeof ap.id !== "string" || typeof ap.approved !== "boolean") continue;
    const target = stored.parts.find((x) => (x as { toolCallId?: string }).toolCallId === p.toolCallId && (x as { state?: string }).state === "approval-requested"
      && (x as { approval?: { id?: string } }).approval?.id === ap.id) as Record<string, unknown> | undefined;
    if (!target) continue;
    target.state = "approval-responded";
    target.approval = { ...(target.approval as object), approved: ap.approved, ...(typeof ap.reason === "string" ? { reason: ap.reason.slice(0, 500) } : {}) };
    n++;
  }
  return n;
}

export function assistantRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const runtime = () => (deps.assistantRuntime ?? "sse");

  const user = (c: V2Context) => {
    const p = c.get("principal");
    if (p.kind !== "user" || p.via === "assistant") throw new V2Error(403, "authorization_error", "RevenueDot AI conversations belong to a signed-in user. Secret API keys cannot use them.");
    return p;
  };
  const model = () => {
    if (!deps.assistant) throw new V2Error(503, "server_error", "RevenueDot AI is not set up on this server. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and restart (prd/ai-assistant/PRD.md).");
    return deps.assistant;
  };
  const conversation = async (c: V2Context) => {
    const p = user(c);
    const conv = await findConversation(db, c.req.param("conversation_id")!, c.get("projectId"), p.userId);
    if (!conv) throw notFound("Conversation");
    return { p, conv };
  };
  const context = async (c: V2Context, conversationId: string): Promise<AssistantContext> => {
    const p = user(c);
    const ctx = await loadAssistantContext(deps, model(), p.userId, c.get("projectId"), conversationId, getCookie(c, SESSION_COOKIE) ?? null);
    if (!ctx) throw notFound("Project");
    return ctx;
  };

  // ---- Status and settings
  r.get(A, async (c) => {
    const p = c.get("principal");
    const projectId = c.get("projectId");
    const [proj] = await db.select({ aiAccess: schema.projects.aiAccess }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    const role = p.kind === "user" ? p.role ?? "viewer" : "api_key";
    const scope = assistantScope(proj?.aiAccess ?? "read_write", role === "api_key" ? "admin" : role);
    let greeting: string | null = null;
    let usage = null;
    if (p.kind === "user") {
      const [u] = await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, p.userId)).limit(1);
      greeting = u?.name?.trim().split(/\s+/)[0] || u?.email.split("@")[0] || null;
      usage = await usageToday(db, p.userId, projectId, deps.now());
    }
    const m = deps.assistant;
    return c.json({
      object: "ai_status", configured: !!m, available: !!m && scope.canRead, provider: m?.provider ?? null, model: m?.model ?? null, runtime: runtime(),
      access: scope.access, role, can_read: !!m && scope.canRead, can_write: !!m && scope.canWrite, reason: !m ? "No model is configured on this server." : scope.reason,
      greeting_name: greeting, tools: toolNamesFor(scope), usage, caps: deps.assistantCaps ?? DEFAULT_CAPS,
    });
  });

  r.post(`${A}/settings`, async (c) => {
    const p = c.get("principal");
    if (p.kind === "user" ? p.via === "assistant" || p.role !== "admin" : !allows(p, "project_configuration:projects:read_write")) {
      throw new V2Error(403, "authorization_error", "Only project admins can change what RevenueDot AI may do.");
    }
    const b = await body(c, z.object({ access: z.enum(AI_ACCESS as [string, ...string[]]) }));
    await db.update(schema.projects).set({ aiAccess: b.access }).where(eq(schema.projects.id, c.get("projectId")));
    return c.json({ object: "ai_settings", access: b.access });
  });

  // ---- Conversations
  r.get(`${A}/conversations`, async (c) => {
    const p = user(c);
    const rows = await listConversations(db, c.get("projectId"), p.userId, c.req.query("q"));
    return c.json({ object: "list", items: rows.map(conversationShape), next_page: null, url: new URL(c.req.url).pathname });
  });

  r.post(`${A}/conversations`, async (c) => {
    const p = user(c);
    model();
    const b = await body(c, z.object({ title: z.string().max(200).nullable().optional() }));
    const row = await createConversation(db, { projectId: c.get("projectId"), userId: p.userId, title: b.title ? titleFrom(b.title) : null, runtime: runtime() === "durable_object" ? "durable_object" : "postgres", now: deps.now() });
    return c.json(conversationShape(row), 201);
  });

  r.get(`${A}/conversations/:conversation_id`, async (c) => {
    const { conv } = await conversation(c);
    const messages = conv.runtime === "postgres" ? await loadMessages(db, conv.id) : [];
    const streaming = conv.runtime === "postgres" ? !!(await activeStream(db, conv.id, deps.now())) : false;
    const last = conv.runtime === "postgres" ? await lastStream(db, conv.id) : null;
    return c.json({ ...conversationShape(conv), messages, streaming, last_stream: last && !streaming ? { status: last.status, error: last.error } : null });
  });

  r.post(`${A}/conversations/:conversation_id`, async (c) => {
    const { conv } = await conversation(c);
    const b = await body(c, z.object({ title: z.string().trim().min(1).max(200) }));
    await touchConversation(db, conv.id, conv.updatedAt, titleFrom(b.title));
    return c.json(conversationShape({ ...conv, title: titleFrom(b.title) }));
  });

  r.delete(`${A}/conversations/:conversation_id`, async (c) => {
    const { conv } = await conversation(c);
    running.get(conv.id)?.abort();
    await deleteConversation(db, conv.id);
    // Cloud: the transcript lives in the conversation's Durable Object. Wipe it after the row is gone.
    if (conv.runtime === "durable_object") await deps.destroyConversation?.(conv.id).catch((e) => console.error("assistant: destroy conversation", e));
    return c.json({ object: "ai_conversation", id: conv.id, deleted: true });
  });

  // ---- Chat (self-host runtime: Postgres + SSE)
  r.post(`${A}/conversations/:conversation_id/chat`, async (c) => {
    const { conv } = await conversation(c);
    if (conv.runtime !== "postgres") throw paramError("This conversation runs in a Durable Object; connect to /agents/assistant-agent/{id}.");
    const ctx = await context(c, conv.id);
    const b = await body(c, ChatBody);
    const now = deps.now();
    // One answer at a time: the stream row is the lock (a unique index allows one "streaming" row per conversation), taken
    // before the transcript is read, so two tabs approving the same change cannot both run it.
    await activeStream(db, conv.id, now);
    const streamId = await startStream(db, conv.id, now);
    if (!streamId) throw new V2Error(423, "resource_locked_error", "An answer is still being written. Wait for it or press Stop.");
    const release = () => dropStream(db, streamId).catch(() => {});

    let messages: UIMessage[];
    let title: string | undefined;
    let turn: Awaited<ReturnType<typeof runAssistantTurn>>;
    const abort = new AbortController();
    try {
      messages = await loadMessages(db, conv.id);
      if (b.trigger === "regenerate-message") {
        while (messages.length && messages[messages.length - 1]!.role === "assistant") messages = messages.slice(0, -1);
        if (!messages.length) throw paramError("There is nothing to regenerate.");
      } else if (b.message?.role === "user") {
        if (messages.some((m) => m.id === b.message!.id)) throw paramError("This message was already sent.", "message.id");
        const parts: UIMessage["parts"] = [];
        const fileUrl = new RegExp(`^/v2/projects/${c.get("projectId")}/ai/files/aif[A-Za-z0-9]+$`);
        for (const raw of b.message.parts) {
          const ok = IncomingPart.safeParse(raw);
          if (!ok.success) continue;
          const part = ok.data;
          if (part.type === "file" && !fileUrl.test(part.url)) throw paramError("Attach files with POST /ai/files first.", "message.parts");
          parts.push(part.type === "text" ? { type: "text", text: part.text } : { type: "file", url: part.url, mediaType: part.mediaType, filename: part.filename });
        }
        if (parts.filter((p) => p.type === "file").length > MAX_FILES_PER_MESSAGE) throw paramError(`Attach at most ${MAX_FILES_PER_MESSAGE} files to one message.`, "message.parts");
        if (!parts.some((p) => (p.type === "text" && p.text.trim()) || p.type === "file")) throw paramError("The message is empty.", "message.parts");
        const mentions = b.message.metadata?.mentions;
        messages.push({ id: b.message.id, role: "user", parts, ...(mentions?.length ? { metadata: { mentions } } : {}) });
        if (!messages.some((m, i) => m.role === "user" && i < messages.length - 1) && conv.title === "New conversation") {
          title = titleFrom(parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ") || "Attachment");
        }
      } else if (b.message?.role === "assistant") {
        // Approve or deny: take only the decisions, from the message the browser sent back.
        const stored = messages[messages.length - 1];
        if (!stored || stored.role !== "assistant" || stored.id !== b.message.id) throw paramError("Only the last answer's approvals can be answered.", "message.id");
        if (!applyApprovals(stored, b.message as { parts: Record<string, unknown>[] })) throw paramError("Nothing is waiting for approval in this answer.", "message");
      } else throw paramError("Send a message.", "message");

      turn = await runAssistantTurn(ctx, messages, { abortSignal: abort.signal });
      if ("refused" in turn) { await release(); return refusalResponse(turn.refused); }
      await saveMessages(db, conv.id, messages, now);
      await touchConversation(db, conv.id, now, title);
    } catch (e) {
      abort.abort();
      await release();
      throw e;
    }
    running.set(conv.id, abort);

    let saved: () => void = () => {};
    const savedP = new Promise<void>((res) => { saved = res; });
    const ui = turn.result.toUIMessageStream({
      originalMessages: messages,
      generateMessageId: () => newId("msg", 16),
      sendReasoning: false,
      onError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
      onFinish: async ({ messages: final, isAborted }: { messages: UIMessage[]; isAborted: boolean }) => {
        try {
          await saveMessages(db, conv.id, final, deps.now());
          await touchConversation(db, conv.id, deps.now());
          await finishStream(db, streamId, isAborted ? "stopped" : "done", deps.now());
        } catch (e) { console.error("assistant: save answer", e); } finally { saved(); }
      },
    } as never) as ReadableStream<UIMessageChunk>;
    const [toClient, toStore] = ui.tee();

    // Every chunk is written to Postgres as it streams, so a reload or another tab resumes mid-answer. This branch keeps
    // reading after the browser goes away, so the answer always finishes and is saved. Text deltas are merged per write
    // (one row per flush, not per token), and at most MAX_STREAM_CHUNKS rows are kept per answer. A Stop pressed on another
    // server process marks the stream stopped; this process sees it within a second and stops the model.
    const persist = (async () => {
      const reader = toStore.getReader();
      let seq = 0, buf: UIMessageChunk[] = [], last = Date.now(), checked = Date.now();
      const flush = async () => {
        if (!buf.length) return;
        const batch = coalesce(buf);
        buf = [];
        if (seq + batch.length > MAX_STREAM_CHUNKS) throw new Error("This answer is too long to keep. Ask a narrower question.");
        await appendChunks(db, streamId, seq, batch, deps.now());
        seq += batch.length;
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf.push(value);
          if (buf.length >= 64 || Date.now() - last > 150) { await flush(); last = Date.now(); }
          if (Date.now() - checked > 1000) {
            checked = Date.now();
            if ((await streamStatus(db, streamId)) === "stopped") abort.abort();
          }
        }
        await flush();
        await Promise.race([savedP, sleep(10_000)]);
        await finishStream(db, streamId, "done", deps.now());
      } catch (e) {
        abort.abort();
        await flush().catch(() => {});
        await finishStream(db, streamId, "error", deps.now(), e instanceof Error ? e.message : String(e)).catch(() => {});
        await reader.cancel().catch(() => {});
      } finally {
        if (running.get(conv.id) === abort) running.delete(conv.id);
      }
    })();
    if (deps.defer) deps.defer(() => persist); else void persist;
    return createUIMessageStreamResponse({ stream: toClient });
  });

  r.get(`${A}/conversations/:conversation_id/stream`, async (c) => {
    const { conv } = await conversation(c);
    if (conv.runtime !== "postgres") return c.body(null, 204);
    const s = await activeStream(db, conv.id, deps.now());
    if (!s) return c.body(null, 204);
    let seq = -1, cancelled = false;
    const started = Date.now();
    const stream = new ReadableStream<UIMessageChunk>({
      // A reader that went away stops the polling at once (not after the 10-minute limit).
      cancel() { cancelled = true; },
      async pull(controller) {
        for (;;) {
          if (cancelled) return;
          const rows = await readChunks(db, s.id, seq);
          if (rows.length) { for (const row of rows) controller.enqueue(row.chunk); seq = rows[rows.length - 1]!.seq; return; }
          const status = await streamStatus(db, s.id);
          if (status !== "streaming" || Date.now() - started > 10 * 60_000) {
            // Everything written before the end, in pages (readChunks returns at most 500 rows at a time).
            for (;;) {
              const rest = await readChunks(db, s.id, seq);
              for (const row of rest) controller.enqueue(row.chunk);
              if (!rest.length) break;
              seq = rest[rest.length - 1]!.seq;
            }
            controller.close();
            return;
          }
          // Marks a stream that stopped moving (the writer died) interrupted; the next pass then drains it and closes.
          await activeStream(db, conv.id, deps.now());
          await sleep(200);
        }
      },
    });
    return createUIMessageStreamResponse({ stream });
  });

  r.post(`${A}/conversations/:conversation_id/stop`, async (c) => {
    const { conv } = await conversation(c);
    running.get(conv.id)?.abort();
    const s = await activeStream(db, conv.id, deps.now());
    if (s) await finishStream(db, s.id, "stopped", deps.now());
    return c.json({ object: "ai_conversation", id: conv.id, stopped: !!s });
  });

  // ---- Files (both runtimes)
  r.post(`${A}/files`, async (c) => {
    const p = user(c);
    model();
    const name = (c.req.query("name") ?? "attachment").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "attachment";
    const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const max = isStoreKitName(name) ? MAX_STOREKIT : MAX_IMAGE;
    // Refuse a body we would not keep before reading it.
    if (Number(c.req.header("content-length") ?? 0) > max) throw paramError(isStoreKitName(name) ? "A .storekit file can be at most 1 MB." : "An image can be at most 5 MB.", "body");
    if (!(await hit(db, `ai-upload:${p.userId}`, UPLOADS_PER_HOUR, 3600_000, deps.now()))) throw new V2Error(429, "rate_limit_error", `You can attach ${UPLOADS_PER_HOUR} files an hour. Try again later.`);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) throw paramError("The file is empty.", "body");
    let mediaType: string;
    let storekit: ReturnType<typeof parseStoreKitConfig> | null = null;
    if (isStoreKitName(name)) {
      if (bytes.length > MAX_STOREKIT) throw paramError("A .storekit file can be at most 1 MB.", "body");
      try { storekit = parseStoreKitConfig(new TextDecoder().decode(bytes)); } catch (e) { if (e instanceof StoreKitParseError) throw paramError(e.message, "body"); throw e; }
      mediaType = "application/x-storekit+json";
    } else if (IMAGE_TYPES.includes(declared)) {
      if (bytes.length > MAX_IMAGE) throw paramError("An image can be at most 5 MB.", "body");
      if (!MAGIC[declared]!(bytes)) throw paramError(`This file is not a ${declared.slice(6).toUpperCase()} image.`, "body");
      mediaType = declared;
    } else throw paramError("Attach a PNG, JPEG, WebP or GIF image, or a .storekit file.", "content-type");
    const id = newId("aif", 16);
    const projectId = c.get("projectId");
    await db.insert(schema.aiFiles).values({ id, projectId, userId: p.userId, name, mediaType, size: bytes.length, dataBase64: b64(bytes), createdAt: deps.now() });
    return c.json({ object: "ai_file", id, name, media_type: mediaType, size: bytes.length, url: `/v2/projects/${projectId}/ai/files/${id}`, ...(storekit ? { storekit } : {}) }, 201);
  });

  r.get(`${A}/files/:file_id`, async (c) => {
    // Members of the project, and the assistant reading an attached .storekit file for them; not secret API keys.
    if (c.get("principal").kind !== "user") throw new V2Error(403, "authorization_error", "RevenueDot AI files belong to the project's members. Secret API keys cannot read them.");
    const [f] = await db.select().from(schema.aiFiles).where(and(eq(schema.aiFiles.projectId, c.get("projectId")), eq(schema.aiFiles.id, c.req.param("file_id")))).limit(1);
    if (!f) throw notFound("File");
    const format = c.req.query("format");
    if (format === "text" || format === "storekit") {
      if (f.mediaType.startsWith("image/")) throw paramError("This file is an image.", "format");
      const text = new TextDecoder().decode(unb64(f.dataBase64));
      if (format === "text") return c.json({ object: "ai_file_text", id: f.id, name: f.name, text });
      try { return c.json({ object: "ai_file_storekit", id: f.id, name: f.name, storekit: parseStoreKitConfig(text) }); } catch (e) { if (e instanceof StoreKitParseError) throw paramError(e.message, "format"); throw e; }
    }
    return new Response(unb64(f.dataBase64), {
      headers: {
        "content-type": f.mediaType.startsWith("image/") ? f.mediaType : "application/octet-stream", "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
        ...(f.mediaType.startsWith("image/") ? {} : { "content-disposition": `attachment; filename="${f.name.replace(/[^\w.-]/g, "_")}"` }),
      },
    });
  });

  r.post(`${A}/storekit`, async (c) => {
    user(c);
    if (Number(c.req.header("content-length") ?? 0) > MAX_STOREKIT) throw paramError("A .storekit file can be at most 1 MB.", "body");
    const text = await c.req.text();
    if (text.length > MAX_STOREKIT) throw paramError("A .storekit file can be at most 1 MB.", "body");
    try { return c.json({ object: "storekit_config", ...parseStoreKitConfig(text) }); } catch (e) { if (e instanceof StoreKitParseError) throw paramError(e.message, "body"); throw e; }
  });

  // ---- @ mentions
  r.get(`${A}/mentions`, async (c) => {
    const p = user(c);
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const projectId = c.get("projectId");
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const items: { type: string; id: string; label: string; detail: string }[] = [];
    const prole = { kind: "user" as const, userId: p.userId, role: p.role };
    if (allows(prole, "customer_information:customers:read")) {
      const al = schema.customerAliases;
      const rows = await db.select({ appUserId: al.appUserId }).from(al)
        .where(and(eq(al.projectId, projectId), q ? ilike(al.appUserId, `${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`) : undefined))
        .orderBy(asc(al.appUserId)).limit(5);
      for (const x of rows) items.push({ type: "customer", id: x.appUserId, label: x.appUserId, detail: "Customer" });
    }
    if (allows(prole, "project_configuration:offerings:read")) {
      const o = schema.offerings;
      const rows = await db.select().from(o).where(and(eq(o.projectId, projectId), q ? or(ilike(o.lookupKey, like), ilike(o.displayName, like)) : undefined)).orderBy(desc(o.isCurrent), asc(o.lookupKey)).limit(5);
      for (const x of rows) items.push({ type: "offering", id: x.id, label: x.lookupKey, detail: `Offering · ${x.displayName}${x.isCurrent ? " · current" : ""}` });
    }
    if (allows(prole, "charts_metrics:charts:read")) {
      const ql = q.toLowerCase();
      for (const ch of CHARTS.filter((x) => !ql || x.name.includes(ql) || x.display_name.toLowerCase().includes(ql)).slice(0, 5)) items.push({ type: "chart", id: ch.name, label: ch.display_name, detail: "Chart" });
    }
    return c.json({ object: "list", items });
  });

  // ---- AI growth insights (prd/attribution-benchmarks-insights §3)
  const insightsOut = async (c: V2Context) => {
    const projectId = c.get("projectId");
    const p = c.get("principal");
    const now = deps.now();
    const [proj] = await db.select({ aiAccess: schema.projects.aiAccess }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    const role = p.kind === "user" ? p.role ?? "viewer" : "api_key";
    const scope = assistantScope(proj?.aiAccess ?? "read_write", role === "api_key" ? "admin" : role);
    const { current, ready } = await displayInsights(db, projectId, now);
    let subscribed: boolean | null = null;
    if (p.kind === "user") subscribed = (await db.select({ on: schema.users.insightsEmails }).from(schema.users).where(eq(schema.users.id, p.userId)).limit(1))[0]?.on ?? null;
    const available = !!deps.assistant && scope.canRead;
    return {
      object: "ai_insights", available, reason: !deps.assistant ? "No model is configured on this server." : scope.reason,
      week: weekOf(now), status: current?.status ?? "none", error: current?.status === "error" ? current.error : null,
      insights_week: ready?.week ?? null, stale: !!ready && ready.week !== weekOf(now),
      generated_at: ready?.generatedAt?.getTime() ?? null, provider: ready?.provider ?? null, model: ready?.model ?? null,
      insights: ready?.insights ?? [], can_refresh: available && role !== "viewer" && role !== "api_key",
      digest: { available: !!deps.insightsDigest && !!deps.assistant, subscribed },
    };
  };
  // Insights carry revenue, MRR and conversion numbers: the same permission as Charts (an API key or custom role without
  // it reads nothing here).
  r.get(`${A}/insights`, needs("charts_metrics:charts:read"), async (c) => c.json(await insightsOut(c)));
  r.post(`${A}/insights/refresh`, needs("charts_metrics:charts:read"), async (c) => {
    const p = user(c);
    if (p.role === "viewer") throw new V2Error(403, "authorization_error", "Your role in this project (viewer) does not allow this. Ask a project admin.");
    model();
    const now = deps.now();
    const projectId = c.get("projectId");
    const { current } = await displayInsights(db, projectId, now);
    if (current?.status === "ready" && current.generatedAt && now.getTime() - current.generatedAt.getTime() < 3_600_000) {
      throw new V2Error(429, "rate_limit_error", "These insights were written less than an hour ago. Refresh again later.");
    }
    const refused = await startTurn(db, deps.assistantCaps ?? DEFAULT_CAPS, p.userId, projectId, now);
    if (refused) throw new V2Error(429, "rate_limit_error", refused);
    try {
      await generateInsights(deps, projectId, { by: { userId: p.userId, sessionId: getCookie(c, SESSION_COOKIE) ?? null }, now });
    } catch (e) {
      if (e instanceof InsightsError) throw new V2Error(e.status, e.status === 429 ? "rate_limit_error" : e.status === 403 ? "authorization_error" : e.status === 409 ? "resource_locked_error" : e.status === 400 ? "parameter_error" : "server_error", e.message, undefined, e.status === 503);
      throw e;
    }
    return c.json(await insightsOut(c));
  });

  // ---- First-sale card
  r.get(`${A}/first_sale`, async (c) => {
    const card = await firstSaleCard(db, c.get("projectId"));
    if (!card) return c.json({ object: "first_sale", card: null });
    const [proj] = await db.select({ dismissed: schema.projects.firstSaleDismissedAt }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    const origin = (deps.apiUrl ?? deps.publicUrl ?? publicOrigin(c)).replace(/\/+$/, "");
    return c.json({ object: "first_sale", card: { ...card.data, id: card.id, share_url: `${origin}/share/first-sale/${card.id}`, image_url: `${origin}/share/first-sale/${card.id}.svg`, dismissed: !!proj?.dismissed } });
  });

  r.post(`${A}/first_sale/dismiss`, async (c) => {
    const p = user(c);
    if (p.role === "viewer") throw new V2Error(403, "authorization_error", "Your role in this project (viewer) does not allow this. Ask a project admin.");
    await db.update(schema.projects).set({ firstSaleDismissedAt: deps.now() }).where(eq(schema.projects.id, c.get("projectId")));
    return c.json({ object: "first_sale", dismissed: true });
  });
}
