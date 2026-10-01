import type { UIMessage, UIMessageChunk } from "ai";
import { and, asc, desc, eq, gt, gte, ilike, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

/**
 * Conversation storage (prd/ai-assistant/PRD.md §1). Conversations are listed in Postgres on every edition. On self-host
 * the transcript (`ai_messages`) and the answer being streamed (`ai_streams`, `ai_stream_chunks`) live here too, so a
 * reload or a second tab resumes mid-answer.
 */
const C = schema.aiConversations, M = schema.aiMessages, S = schema.aiStreams, K = schema.aiStreamChunks;
export type ConversationRow = typeof C.$inferSelect;

/** A stream with no new chunk for this long is treated as dead (the server restarted mid-answer). */
export const STALE_STREAM_MS = 60_000;

export const conversationShape = (c: ConversationRow) => ({
  object: "ai_conversation" as const, id: c.id, title: c.title, runtime: c.runtime, created_at: c.createdAt.getTime(), updated_at: c.updatedAt.getTime(),
});

export async function createConversation(db: DB, i: { projectId: string; userId: string; title?: string | null; runtime: string; now: Date }) {
  const [row] = await db.insert(C).values({
    id: newId("aic", 16), projectId: i.projectId, userId: i.userId, title: i.title?.trim() || "New conversation", runtime: i.runtime, createdAt: i.now, updatedAt: i.now,
  }).returning();
  return row!;
}

export async function listConversations(db: DB, projectId: string, userId: string, q?: string | null, limit = 100) {
  const conds = [eq(C.projectId, projectId), eq(C.userId, userId)];
  if (q?.trim()) conds.push(ilike(C.title, `%${q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
  return db.select().from(C).where(and(...conds)).orderBy(desc(C.updatedAt), desc(C.id)).limit(limit);
}

/** The conversation if it belongs to this user in this project; another person's conversation is "not found". */
export async function findConversation(db: DB, id: string, projectId: string, userId: string) {
  const [row] = await db.select().from(C).where(and(eq(C.id, id), eq(C.projectId, projectId), eq(C.userId, userId))).limit(1);
  return row ?? null;
}

export async function touchConversation(db: DB, id: string, now: Date, title?: string) {
  await db.update(C).set({ updatedAt: now, ...(title ? { title } : {}) }).where(eq(C.id, id));
}

export async function deleteConversation(db: DB, id: string) {
  await db.delete(C).where(eq(C.id, id));
}

export async function loadMessages(db: DB, conversationId: string): Promise<UIMessage[]> {
  const rows = await db.select({ message: M.message }).from(M).where(eq(M.conversationId, conversationId)).orderBy(asc(M.position));
  return rows.map((r) => r.message as unknown as UIMessage);
}

/** Writes the whole transcript (upsert by message id, in order) and drops rows past its end. */
export async function saveMessages(db: DB, conversationId: string, messages: UIMessage[], now: Date) {
  for (const [position, m] of messages.entries()) {
    await db.insert(M).values({ conversationId, id: m.id, position, role: m.role, message: m as unknown as Record<string, unknown>, createdAt: now })
      .onConflictDoUpdate({ target: [M.conversationId, M.id], set: { position, role: m.role, message: m as unknown as Record<string, unknown> } });
  }
  await db.delete(M).where(and(eq(M.conversationId, conversationId), gte(M.position, messages.length)));
}

export async function startStream(db: DB, conversationId: string, now: Date) {
  const id = newId("ais", 16);
  await db.insert(S).values({ id, conversationId, status: "streaming", createdAt: now, updatedAt: now });
  return id;
}

export async function appendChunks(db: DB, streamId: string, fromSeq: number, chunks: UIMessageChunk[], now: Date) {
  if (!chunks.length) return;
  await db.insert(K).values(chunks.map((chunk, i) => ({ streamId, seq: fromSeq + i, chunk: chunk as unknown as Record<string, unknown> }))).onConflictDoNothing();
  await db.update(S).set({ updatedAt: now }).where(eq(S.id, streamId));
}

export async function finishStream(db: DB, streamId: string, status: "done" | "error" | "stopped" | "interrupted", now: Date, error?: string) {
  await db.update(S).set({ status, updatedAt: now, error: error ?? null }).where(and(eq(S.id, streamId), eq(S.status, "streaming")));
}

/**
 * The answer still being written for this conversation, if any. A stream that has not moved for STALE_STREAM_MS is
 * marked interrupted and not returned.
 */
export async function activeStream(db: DB, conversationId: string, now: Date) {
  const [s] = await db.select().from(S).where(and(eq(S.conversationId, conversationId), eq(S.status, "streaming"))).orderBy(desc(S.createdAt)).limit(1);
  if (!s) return null;
  if (now.getTime() - s.updatedAt.getTime() > STALE_STREAM_MS) {
    await finishStream(db, s.id, "interrupted", now, "The answer stopped before it finished (the server restarted or lost its connection).");
    return null;
  }
  return s;
}

export async function streamStatus(db: DB, streamId: string) {
  const [s] = await db.select({ status: S.status }).from(S).where(eq(S.id, streamId)).limit(1);
  return s?.status ?? null;
}

export async function readChunks(db: DB, streamId: string, afterSeq: number) {
  const rows = await db.select().from(K).where(and(eq(K.streamId, streamId), gt(K.seq, afterSeq))).orderBy(asc(K.seq)).limit(500);
  return rows.map((r) => ({ seq: r.seq, chunk: r.chunk as unknown as UIMessageChunk }));
}

/** The last stream's end state, so the UI can say an answer was interrupted and offer Retry. */
export async function lastStream(db: DB, conversationId: string) {
  const [s] = await db.select({ id: S.id, status: S.status, error: S.error }).from(S).where(eq(S.conversationId, conversationId)).orderBy(desc(S.createdAt)).limit(1);
  return s ?? null;
}

/** Old chunks are only needed to resume; keep the last day's. */
export async function pruneStreams(db: DB, now: Date) {
  await db.delete(S).where(and(sql`${S.status} <> 'streaming'`, sql`${S.updatedAt} < ${new Date(now.getTime() - 86400_000).toISOString()}::timestamptz`));
}
