import { inArray, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { hit } from "../rate-limit.js";

/**
 * Rate limits and cost caps for RevenueDot AI (prd/ai-assistant/PRD.md §5), kept in Postgres so they hold across Workers
 * isolates, Durable Objects and Node restarts. Turns per minute use `rate_limits` (like the paywall generator); daily
 * turns and tokens per person, project and server use `ai_usage`.
 */
export interface AssistantCaps {
  userPerMinute: number;
  userTurnsPerDay: number;
  userTokensPerDay: number;
  projectTurnsPerDay: number;
  projectTokensPerDay: number;
  serverTurnsPerDay: number;
  serverTokensPerDay: number;
}

export const DEFAULT_CAPS: AssistantCaps = {
  userPerMinute: 20, userTurnsPerDay: 200, userTokensPerDay: 2_000_000,
  projectTurnsPerDay: 600, projectTokensPerDay: 6_000_000,
  serverTurnsPerDay: 20_000, serverTokensPerDay: 200_000_000,
};

/** REVENUEDOT_ASSISTANT_CAPS: JSON with any of the fields above. Bad JSON keeps the defaults. */
export function capsFromEnv(raw: string | undefined): AssistantCaps {
  if (!raw?.trim()) return DEFAULT_CAPS;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_CAPS };
    for (const k of Object.keys(DEFAULT_CAPS) as (keyof AssistantCaps)[]) if (typeof o[k] === "number" && o[k] >= 0) out[k] = o[k] as number;
    return out;
  } catch { return DEFAULT_CAPS; }
}

export const dayOf = (now: Date) => now.toISOString().slice(0, 10);
const keys = (userId: string, projectId: string) => ({ user: `user:${userId}`, project: `project:${projectId}`, server: "server" });

export interface UsageToday { user: { turns: number; tokens: number }; project: { turns: number; tokens: number }; server: { turns: number; tokens: number } }

export async function usageToday(db: DB, userId: string, projectId: string, now: Date): Promise<UsageToday> {
  const k = keys(userId, projectId);
  const U = schema.aiUsage;
  const rows = await db.select().from(U).where(sql`${U.day} = ${dayOf(now)} and ${inArray(U.key, [k.user, k.project, k.server])}`);
  const of = (key: string) => { const r = rows.find((x) => x.key === key); return { turns: r?.turns ?? 0, tokens: (r?.inputTokens ?? 0) + (r?.outputTokens ?? 0) }; };
  return { user: of(k.user), project: of(k.project), server: of(k.server) };
}

/**
 * Checks the caps and, when a turn may run, counts it. Returns the sentence the chat shows when it may not.
 * The per-minute limit counts every attempt; the daily caps are checked against what has been used.
 */
export async function startTurn(db: DB, caps: AssistantCaps, userId: string, projectId: string, now: Date): Promise<string | null> {
  if (!(await hit(db, `ai-turn:${userId}`, caps.userPerMinute, 60_000, now))) return `You can ask ${caps.userPerMinute} questions a minute. Wait a moment and try again.`;
  const u = await usageToday(db, userId, projectId, now);
  if (u.user.turns >= caps.userTurnsPerDay) return `You have used today's ${caps.userTurnsPerDay} questions. The limit resets at midnight UTC.`;
  if (u.user.tokens >= caps.userTokensPerDay) return "You have used today's RevenueDot AI allowance. It resets at midnight UTC.";
  if (u.project.turns >= caps.projectTurnsPerDay || u.project.tokens >= caps.projectTokensPerDay) return "This project has used today's RevenueDot AI allowance. It resets at midnight UTC.";
  if (u.server.turns >= caps.serverTurnsPerDay || u.server.tokens >= caps.serverTokensPerDay) return "RevenueDot AI is busy today. Try again tomorrow.";
  await addUsage(db, userId, projectId, now, { turns: 1 });
  return null;
}

/** Adds turns and tokens to today's rows for the person, the project and the server. */
export async function addUsage(db: DB, userId: string, projectId: string, now: Date, d: { turns?: number; inputTokens?: number; outputTokens?: number }) {
  const k = keys(userId, projectId);
  const U = schema.aiUsage;
  const day = dayOf(now);
  const turns = d.turns ?? 0, inp = Math.max(0, Math.round(d.inputTokens ?? 0)), out = Math.max(0, Math.round(d.outputTokens ?? 0));
  if (!turns && !inp && !out) return;
  await db.insert(U).values([k.user, k.project, k.server].map((key) => ({ key, day, turns, inputTokens: inp, outputTokens: out })))
    .onConflictDoUpdate({
      target: [U.key, U.day],
      set: { turns: sql`${U.turns} + excluded.turns`, inputTokens: sql`${U.inputTokens} + excluded.input_tokens`, outputTokens: sql`${U.outputTokens} + excluded.output_tokens` },
    });
}
