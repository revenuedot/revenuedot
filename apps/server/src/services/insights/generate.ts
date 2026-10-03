import { isStepCount, streamText, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod/v4";
import { and, asc, desc, eq, lt, ne, or } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { assistantScope } from "../assistant/access.js";
import { buildToolSet, dispatchOf, instructionsFor, type AssistantContext } from "../assistant/agent.js";
import { inProcessClient } from "../assistant/client.js";
import { addUsage, DEFAULT_CAPS, usageToday } from "../assistant/limits.js";
import { buildInsightPack, type InsightPack, type PackItem } from "./pack.js";

/**
 * AI growth insights (prd/attribution-benchmarks-insights §3): RevenueDot AI reads this week's numbers pack (pack.ts)
 * with its read tools and returns 3 to 5 recommendations. The server checks the answer: every recommendation must cite
 * pack items, unknown ids are dropped, and the real values and links are attached from the pack. One row per project and
 * ISO week (Monday, UTC) in `ai_insights`. Read-only: no write tool is offered and the API refuses writes from this actor.
 */

export const MIN_INSIGHTS = 3;
export const MAX_INSIGHTS = 5;
/** A "running" row older than this is taken over (the generating isolate died). */
const STALE_RUN_MS = 10 * 60_000;
/**
 * Output tokens per model step. A reasoning model (GPT-6 Luna) spends its reasoning from the same budget before it writes
 * the JSON, and now and then reasons for more than 4,000 tokens: with a 4,096 cap that step ended at "length" with no
 * text (SuperScan, 2026-10-02). The answer itself is under 1,000 tokens.
 */
export const INSIGHTS_MAX_OUTPUT_TOKENS = 16_000;
/** The repair attempt reasons briefly: it only has to rewrite the JSON from the pack it already has. */
export const REPAIR_REASONING = "low";

export interface Insight {
  id: string;
  title: string;
  finding: string;
  recommendation: string;
  metric_ids: string[];
  /** The pack items it rests on: the real numbers. */
  numbers: Pick<PackItem, "id" | "label" | "unit" | "value" | "previous" | "change_pct" | "window" | "lower_is_better">[];
  /** The page to open: the first cited item's link. */
  link: string;
  /** A question for "Ask about this". */
  ask: string;
}

/** Monday 00:00 UTC of the week `now` is in, as YYYY-MM-DD. */
export function weekOf(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const Answer = z.object({
  insights: z.array(z.object({
    title: z.string().trim().min(3).max(140),
    finding: z.string().trim().min(10).max(800),
    recommendation: z.string().trim().min(10).max(800),
    metric_ids: z.array(z.string()).min(1).max(6),
  })).min(1).max(10),
});

/** The JSON in a model answer: a fenced ```json block, else the outermost braces. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidates = [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter((x): x is string => !!x && x.trim().startsWith("{"));
  for (const c of candidates) { try { return JSON.parse(c); } catch { /* next */ } }
  const start = text.replace(/\s+/g, " ").trim().slice(0, 120);
  throw new Error(start ? `The answer has no JSON object (it began: "${start}").` : "The model gave no answer.");
}

/** Checks a model answer against the pack. Returns the insights, or why they cannot be used. */
export function validateInsights(text: string, pack: InsightPack): { insights: Insight[] } | { error: string } {
  let parsed: unknown;
  try { parsed = extractJson(text); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const r = Answer.safeParse(parsed);
  if (!r.success) return { error: `The JSON does not match the format: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}` };
  const byId = new Map(pack.items.map((i) => [i.id, i]));
  const out: Insight[] = [];
  for (const [n, x] of r.data.insights.entries()) {
    const ids = [...new Set(x.metric_ids)].filter((id) => byId.has(id));
    if (!ids.length) continue;
    const items = ids.map((id) => byId.get(id)!);
    out.push({
      id: `ins_${n + 1}`, title: oneLine(x.title, 120), finding: oneLine(x.finding, 700), recommendation: oneLine(x.recommendation, 700), metric_ids: ids,
      numbers: items.map(({ id, label, unit, value, previous, change_pct, window, lower_is_better }) => ({ id, label, unit, value, previous, change_pct, window, ...(lower_is_better ? { lower_is_better } : {}) })),
      link: items[0]!.link,
      ask: `Tell me more about this growth insight and how to act on it: "${oneLine(x.title, 120)}". ${oneLine(x.finding, 400)}`,
    });
    if (out.length === MAX_INSIGHTS) break;
  }
  if (out.length < MIN_INSIGHTS) return { error: `Only ${out.length} recommendations cite items of the data pack; ${MIN_INSIGHTS} to ${MAX_INSIGHTS} are needed, each with metric_ids from the pack.` };
  return { insights: out };
}
/**
 * One plain line: markdown links become their text, web addresses go (the model reads campaign names any app user can
 * set, and this text is emailed from RevenueDot), emphasis marks go, whitespace collapses, and long text is cut.
 */
const oneLine = (s: string, max: number) => {
  const t = noUrls(s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")).replace(/(\*\*|__|`)/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** Removes web addresses (http://, https://, www.) from text that ends up in an email. */
export const noUrls = (s: string) => s.replace(/\b(?:https?:\/\/|www\.)[^\s"'<>)]*/gi, "").replace(/[ \t]{2,}/g, " ");

export function insightInstructions(project: string): string {
  return [
    `You are writing this week's growth insights for the project "${project}".`,
    "The user message holds a data pack RevenueDot computed from the project's own data: items with an id, a label, a value, the value it is compared with, the change in %, and the window.",
    `Pick the ${MIN_INSIGHTS} to ${MAX_INSIGHTS} most useful, concrete recommendations a founder or growth lead can act on this week.`,
    "- Each finding quotes numbers from the pack (with their units) and says what changed or how the project compares. Never invent a number.",
    "- Each recommendation is one concrete action in RevenueDot or the app: for example an experiment on trial length or price, moving ad budget to a campaign with higher revenue per customer, a win-back campaign, Refund Control, a paywall change.",
    "- metric_ids lists the pack ids the insight rests on (at least one, from the pack only).",
    "- For benchmark_ items, `previous` is the peer median and `standing` says where the project is (top_quarter, above_median, below_median, bottom_quarter, already in the better direction); use it rather than comparing the numbers yourself. lower_is_better marks metrics such as churn and refunds.",
    "- Plain sentences only: no markdown, no links (the dashboard links each insight to its chart).",
    "- Prefer big changes, gaps to peer medians and campaign differences. If the data is thin, one insight may say what to collect first (for example attribution or more trial data).",
    "- You may call read tools (get-chart, get-attribution-report, get-benchmarks) to look closer; you cannot change anything.",
    'Answer with JSON only, no other text: {"insights":[{"title":"at most 80 characters","finding":"…","recommendation":"…","metric_ids":["…"]}]}',
  ].join("\n");
}

export interface GenerateOptions {
  /** Who asked: a user who pressed Refresh, or the weekly schedule. */
  /** Refresh carries the session it came from (an organization that requires single sign-on checks it). */
  by: { userId: string; sessionId?: string | null } | "schedule";
  now?: Date;
}

export class InsightsError extends Error {
  /** `server_cap`: the whole server used today's RevenueDot AI tokens (nothing runs for any project until tomorrow). */
  constructor(public status: 400 | 403 | 409 | 429 | 503, message: string, public code?: "server_cap") { super(message); }
}

/** The person the read-only actor acts as: the asker, or for the schedule the project's owner (else its first admin). */
async function actorUser(db: DB, projectId: string, by: GenerateOptions["by"]) {
  const M = schema.memberships, U = schema.users;
  const base = db.select({ id: U.id, email: U.email, name: U.name, role: M.role }).from(M).innerJoin(U, eq(U.id, M.userId));
  if (by !== "schedule") return (await base.where(and(eq(M.projectId, projectId), eq(M.userId, by.userId))).limit(1))[0] ?? null;
  const [proj] = await db.select({ owner: schema.projects.ownerUserId }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  const admins = await base.where(and(eq(M.projectId, projectId), eq(M.role, "admin"))).orderBy(asc(U.createdAt));
  return admins.find((a) => a.id === proj?.owner) ?? admins[0] ?? null;
}

const I = schema.aiInsights;

/** Claims this week's row for generation. False when another generation of it is running. */
async function claim(db: DB, projectId: string, week: string, now: Date): Promise<boolean> {
  const rows = await db.insert(I).values({ projectId, week, status: "running", updatedAt: now })
    .onConflictDoUpdate({ target: [I.projectId, I.week], set: { status: "running", error: null, updatedAt: now }, setWhere: or(ne(I.status, "running"), lt(I.updatedAt, new Date(now.getTime() - STALE_RUN_MS))) })
    .returning({ week: I.week });
  return rows.length > 0;
}

/** Generates (or regenerates) this week's insights and stores them. Throws InsightsError when it cannot run. */
export async function generateInsights(deps: Deps, projectId: string, o: GenerateOptions) {
  const now = o.now ?? deps.now();
  const { db } = deps;
  const model = deps.assistant;
  if (!model) throw new InsightsError(503, "No model is configured on this server.");
  const [proj] = await db.select({ name: schema.projects.name, aiAccess: schema.projects.aiAccess }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  if (!proj) throw new InsightsError(400, "Project not found.");
  if (proj.aiAccess === "disabled") throw new InsightsError(403, "An admin turned RevenueDot AI off for this project.");
  const user = await actorUser(db, projectId, o.by);
  if (!user) throw new InsightsError(403, "The project has no admin to read its data as.");
  const caps = deps.assistantCaps ?? DEFAULT_CAPS;
  const usageKey = o.by === "schedule" ? "insights-schedule" : user.id;
  const today = await usageToday(db, usageKey, projectId, now);
  if (today.project.tokens >= caps.projectTokensPerDay) throw new InsightsError(429, "This project has used today's RevenueDot AI allowance. It resets at midnight UTC.");
  if (today.server.tokens >= caps.serverTokensPerDay) throw new InsightsError(429, "RevenueDot AI is busy today. Try again tomorrow.", "server_cap");
  const week = weekOf(now);
  if (!(await claim(db, projectId, week, now))) throw new InsightsError(409, "This week's insights are being written right now.");

  try {
    const pack = await buildInsightPack(db, projectId, now);
    const ctx: AssistantContext = {
      deps, model, userName: user.name, caps,
      actor: { userId: user.id, email: user.email, projectId, conversationId: `insights:${week}`, readOnly: true, sessionId: o.by === "schedule" ? null : o.by.sessionId ?? null },
      project: { id: projectId, name: proj.name },
      // Read tools only, whatever the project allows and whoever asked.
      scope: assistantScope("read_only", user.role === "viewer" ? "viewer" : user.role),
    };
    const client = inProcessClient(dispatchOf(deps), ctx.actor);
    const tools: ToolSet = buildToolSet(ctx, client, { writes: false });
    const system = `${instructionsFor(ctx, now)}\n\n${insightInstructions(proj.name)}`;
    const messages: ModelMessage[] = [{ role: "user", content: `Weekly growth insights for the week of ${week}. Data pack:\n\`\`\`json\n${JSON.stringify({ project: pack.project, currency: pack.currency, items: pack.items })}\n\`\`\`` }];
    let result = await ask(ctx, system, messages, tools, usageKey);
    let checked = validateInsights(result, pack);
    if ("error" in checked) {
      // One repair attempt with the reason, without tools, so the model answers in text.
      messages.push({ role: "assistant", content: result || "(no answer)" }, { role: "user", content: `That answer could not be used: ${checked.error} Answer again with the JSON only.` });
      result = await ask(ctx, system, messages, {}, usageKey, { reasoning: REPAIR_REASONING });
      checked = validateInsights(result, pack);
    }
    if ("error" in checked) throw new Error(checked.error);
    await db.update(I).set({
      status: "ready", insights: checked.insights as unknown as Record<string, unknown>[], data: pack as unknown as Record<string, unknown>, provider: model.provider, model: model.model,
      error: null, generatedBy: o.by === "schedule" ? "schedule" : user.id, generatedAt: now, updatedAt: now,
    }).where(and(eq(I.projectId, projectId), eq(I.week, week)));
    return { week, insights: checked.insights, pack };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.update(I).set({ status: "error", error: message.slice(0, 500), updatedAt: now }).where(and(eq(I.projectId, projectId), eq(I.week, week)));
    throw e instanceof InsightsError ? e : new InsightsError(503, `The insights could not be written: ${message.slice(0, 300)}`);
  }
}

async function ask(ctx: AssistantContext, system: string, messages: ModelMessage[], tools: ToolSet, usageKey: string, o: { reasoning?: string } = {}): Promise<string> {
  const { db } = ctx.deps;
  let failure: unknown = null;
  const result = streamText({
    model: ctx.model.languageModel,
    instructions: system,
    messages,
    tools,
    stopWhen: isStepCount(6),
    // After three steps of looking, the model must write the answer (a model that keeps calling tools would end
    // without one).
    prepareStep: ({ stepNumber }: { stepNumber: number }) => (stepNumber >= 3 ? { toolChoice: "none" } : undefined),
    maxOutputTokens: INSIGHTS_MAX_OUTPUT_TOKENS,
    // Overrides the model's default effort (ai-gateway.ts) for OpenAI reasoning models; other providers ignore it.
    ...(o.reasoning ? { providerOptions: { openai: { reasoningEffort: o.reasoning } } } : {}),
    onError: ({ error }: { error: unknown }) => { failure = error; },
    onStepEnd: async (step: { usage?: { inputTokens?: number; outputTokens?: number } }) => {
      try { await addUsage(db, usageKey, ctx.project.id, ctx.deps.now(), { inputTokens: step.usage?.inputTokens ?? 0, outputTokens: step.usage?.outputTokens ?? 0 }); } catch (e) { console.error("insights usage", e); }
    },
  } as never) as unknown as { consumeStream(): PromiseLike<void>; steps: PromiseLike<StepLike[]> };
  await result.consumeStream();
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  // The answer is the last step's text, unless the model wrote its JSON in an earlier step next to a tool call.
  const steps = await result.steps;
  const texts = steps.map((x) => x.text ?? "").filter((t) => t.trim());
  const answer = [...texts].reverse().find((t) => t.includes("{")) ?? texts[texts.length - 1] ?? "";
  // Logged (never the content) when there is no answer: which step ended how, and how long the reasoning ran.
  if (!answer.includes("{")) console.warn("insights: no JSON from the model", JSON.stringify(steps.map((x) => ({ finish: x.finishReason, text: x.text?.length ?? 0, reasoning: x.reasoningText?.length ?? 0, tools: x.toolCalls?.length ?? 0, out: x.usage?.outputTokens, reasoning_tokens: x.usage?.outputTokenDetails?.reasoningTokens }))));
  return answer;
}
interface StepLike { text?: string; finishReason?: string; reasoningText?: string; toolCalls?: unknown[]; usage?: { outputTokens?: number; outputTokenDetails?: { reasoningTokens?: number } } }

/** A ready row of an earlier week stays visible while this week's is written or failed. */
export async function displayInsights(db: DB, projectId: string, now: Date) {
  const rows = await db.select().from(I).where(eq(I.projectId, projectId)).orderBy(desc(I.week)).limit(3);
  const current = rows.find((r) => r.week === weekOf(now)) ?? null;
  const ready = rows.find((r) => r.status === "ready") ?? null;
  return { current, ready };
}
