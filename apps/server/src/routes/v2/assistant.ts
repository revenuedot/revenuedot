import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage, type UIMessageChunk } from "ai";
import { z } from "zod";
import { and, asc, desc, eq, ilike, or } from "drizzle-orm";
import { CHARTS, newId, parseStoreKitConfig, StoreKitParseError } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { assistantScope, AI_ACCESS } from "../../services/assistant/access.js";
import { loadAssistantContext, runAssistantTurn, titleFrom, toolNamesFor, type AssistantContext } from "../../services/assistant/agent.js";
import { DEFAULT_CAPS, usageToday } from "../../services/assistant/limits.js";
import {
  activeStream, appendChunks, conversationShape, createConversation, deleteConversation, findConversation, finishStream, lastStream, listConversations,
  loadMessages, readChunks, saveMessages, startStream, streamStatus, touchConversation,
} from "../../services/assistant/store.js";
import { firstSaleCard } from "../../services/assistant/first-sale.js";
import { allows, body, notFound, paramError, V2Error, type V2Context, type V2Router } from "./common.js";
import { publicOrigin } from "./setup.js";

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

/** Answers being written in this process, so Stop can cancel the model call (Node; Workers use the Durable Object). */
const running = new Map<string, AbortController>();

const Mention = z.object({ type: z.enum(["customer", "offering", "chart"]), id: z.string().min(1).max(200), label: z.string().max(200).optional() });
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
    const ctx = await loadAssistantContext(deps, model(), p.userId, c.get("projectId"), conversationId);
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
    if (await activeStream(db, conv.id, now)) throw new V2Error(423, "resource_locked_error", "An answer is still being written. Wait for it or press Stop.");
    let messages = await loadMessages(db, conv.id);
    let title: string | undefined;

    if (b.trigger === "regenerate-message") {
      while (messages.length && messages[messages.length - 1]!.role === "assistant") messages = messages.slice(0, -1);
      if (!messages.length) throw paramError("There is nothing to regenerate.");
    } else if (b.message?.role === "user") {
      if (messages.some((m) => m.id === b.message!.id)) throw paramError("This message was already sent.", "message.id");
      const parts: UIMessage["parts"] = [];
      for (const raw of b.message.parts) {
        const ok = IncomingPart.safeParse(raw);
        if (!ok.success) continue;
        const part = ok.data;
        if (part.type === "file" && !new RegExp(`^/v2/projects/${c.get("projectId")}/ai/files/aif[A-Za-z0-9]+$`).test(part.url)) throw paramError("Attach files with POST /ai/files first.", "message.parts");
        parts.push(part.type === "text" ? { type: "text", text: part.text } : { type: "file", url: part.url, mediaType: part.mediaType, filename: part.filename });
      }
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

    const abort = new AbortController();
    const turn = await runAssistantTurn(ctx, messages, { abortSignal: abort.signal });
    if ("refused" in turn) return refusalResponse(turn.refused);
    await saveMessages(db, conv.id, messages, now);
    await touchConversation(db, conv.id, now, title);
    const streamId = await startStream(db, conv.id, now);
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
    // reading after the browser goes away, so the answer always finishes and is saved.
    const persist = (async () => {
      const reader = toStore.getReader();
      let seq = 0, buf: UIMessageChunk[] = [], last = Date.now();
      const flush = async () => { if (!buf.length) return; const batch = buf; buf = []; await appendChunks(db, streamId, seq, batch, deps.now()); seq += batch.length; };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf.push(value);
          if (buf.length >= 16 || Date.now() - last > 150) { await flush(); last = Date.now(); }
        }
        await flush();
        await Promise.race([savedP, sleep(10_000)]);
        await finishStream(db, streamId, "done", deps.now());
      } catch (e) {
        await flush().catch(() => {});
        await finishStream(db, streamId, "error", deps.now(), e instanceof Error ? e.message : String(e)).catch(() => {});
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
    let seq = -1;
    const started = Date.now();
    const stream = new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        for (;;) {
          const rows = await readChunks(db, s.id, seq);
          if (rows.length) { for (const row of rows) controller.enqueue(row.chunk); seq = rows[rows.length - 1]!.seq; return; }
          const status = await streamStatus(db, s.id);
          if (status !== "streaming" || Date.now() - started > 10 * 60_000) {
            const rest = await readChunks(db, s.id, seq);
            for (const row of rest) controller.enqueue(row.chunk);
            controller.close();
            return;
          }
          if (!(await activeStream(db, conv.id, deps.now()))) { controller.close(); return; }
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
    const name = (c.req.query("name") ?? "attachment").slice(0, 200);
    const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
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
      mediaType = declared;
    } else throw paramError("Attach a PNG, JPEG, WebP or GIF image, or a .storekit file.", "content-type");
    const id = newId("aif", 16);
    const projectId = c.get("projectId");
    await db.insert(schema.aiFiles).values({ id, projectId, userId: p.userId, name, mediaType, size: bytes.length, dataBase64: b64(bytes), createdAt: deps.now() });
    return c.json({ object: "ai_file", id, name, media_type: mediaType, size: bytes.length, url: `/v2/projects/${projectId}/ai/files/${id}`, ...(storekit ? { storekit } : {}) }, 201);
  });

  r.get(`${A}/files/:file_id`, async (c) => {
    const [f] = await db.select().from(schema.aiFiles).where(and(eq(schema.aiFiles.projectId, c.get("projectId")), eq(schema.aiFiles.id, c.req.param("file_id")))).limit(1);
    if (!f) throw notFound("File");
    const format = c.req.query("format");
    if (format === "text" || format === "storekit") {
      if (f.mediaType.startsWith("image/")) throw paramError("This file is an image.", "format");
      const text = new TextDecoder().decode(unb64(f.dataBase64));
      return c.json(format === "text" ? { object: "ai_file_text", id: f.id, name: f.name, text } : { object: "ai_file_storekit", id: f.id, name: f.name, storekit: parseStoreKitConfig(text) });
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

  // ---- First-sale card
  r.get(`${A}/first_sale`, async (c) => {
    const card = await firstSaleCard(db, c.get("projectId"));
    if (!card) return c.json({ object: "first_sale", card: null });
    const [proj] = await db.select({ dismissed: schema.projects.firstSaleDismissedAt }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    const origin = (deps.apiUrl ?? deps.publicUrl ?? publicOrigin(c)).replace(/\/+$/, "");
    return c.json({ object: "first_sale", card: { ...card.data, id: card.id, share_url: `${origin}/share/first-sale/${card.id}`, image_url: `${origin}/share/first-sale/${card.id}.svg`, dismissed: !!proj?.dismissed } });
  });

  r.post(`${A}/first_sale/dismiss`, async (c) => {
    user(c);
    await db.update(schema.projects).set({ firstSaleDismissedAt: deps.now() }).where(eq(schema.projects.id, c.get("projectId")));
    return c.json({ object: "first_sale", dismissed: true });
  });
}
