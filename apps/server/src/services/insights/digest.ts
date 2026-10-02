import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { trySend } from "../../mail/index.js";
import { insightsDigestEmail } from "../../mail/templates.js";
import { linkBase } from "../account-email.js";
import { generateInsights, InsightsError, weekOf, type Insight } from "./generate.js";

/**
 * The weekly digest (prd/attribution-benchmarks-insights §3). From Monday DIGEST_HOUR UTC, each call (the tick) handles
 * one project: it writes the week's insights if they are missing, then emails the project's admins who have the digest
 * on. Projects qualify when RevenueDot AI is not disabled and they had production revenue in the last 90 days.
 * Runs where `deps.insightsDigest` is on (Cloud; self-host with REVENUEDOT_INSIGHTS_DIGEST=on) and a model is set.
 */
export const DIGEST_HOUR = 6;
const I = schema.aiInsights;

/** Whether `now` is past this week's digest time (Monday DIGEST_HOUR UTC). */
export function digestOpen(now: Date): boolean {
  const monday = Date.parse(`${weekOf(now)}T00:00:00Z`) + DIGEST_HOUR * 3_600_000;
  return now.getTime() >= monday;
}

const fmtNumber = (v: number | null, unit: string) => {
  if (v === null) return "n/a";
  if (unit === "$") return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 });
  if (unit === "%") return `${v.toFixed(1)}%`;
  return v.toLocaleString("en-US");
};
/** "MRR $4,210 (−8.2% vs today vs 28 days ago)" for the email. */
export function numberLine(n: Insight["numbers"][number]): string {
  const ch = n.change_pct === null ? "" : ` (${n.change_pct > 0 ? "+" : n.change_pct < 0 ? "−" : ""}${Math.abs(n.change_pct).toFixed(1)}%)`;
  const label = n.label.replace(/\s*\(.*\)$/, "");
  return `${label} ${fmtNumber(n.value, n.unit)}${ch}`;
}

/** Signs a digest opt-out link for one person. Null without a server key (the email then points to the settings). */
export async function digestToken(userId: string, key: string | undefined): Promise<string | null> {
  if (!key) return null;
  const sig = await hmac(`revenuedot-insights-unsubscribe:${key}`, userId);
  return `${b64url(new TextEncoder().encode(userId))}.${sig}`;
}
export async function verifyDigestToken(token: string, key: string | undefined): Promise<string | null> {
  if (!key) return null;
  const [id, sig] = token.split(".");
  if (!id || !sig) return null;
  let userId: string;
  try { userId = new TextDecoder().decode(Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))); } catch { return null; }
  const want = await hmac(`revenuedot-insights-unsubscribe:${key}`, userId);
  // Constant-time comparison of two strings of the same alphabet.
  if (want.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? userId : null;
}
const b64url = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg))));
}
export const digestKey = (deps: Pick<Deps, "encryptionKey" | "signingKey">) => deps.encryptionKey || deps.signingKey || undefined;

/** Emails a project's ready insights for this week to its admins with the digest on, once. Returns how many were sent. */
export async function emailDigest(deps: Deps, projectId: string, week: string) {
  const { db } = deps;
  const [row] = await db.select().from(I).where(and(eq(I.projectId, projectId), eq(I.week, week))).limit(1);
  if (!row || row.status !== "ready" || row.emailedAt) return 0;
  // Claim the send first, so two ticks never email twice.
  const claimed = await db.update(I).set({ emailedAt: deps.now() }).where(and(eq(I.projectId, projectId), eq(I.week, week), isNull(I.emailedAt))).returning({ w: I.week });
  if (!claimed.length) return 0;
  const [project] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  const admins = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.projectId, projectId), eq(schema.memberships.role, "admin"), eq(schema.users.insightsEmails, true)));
  const base = linkBase(deps);
  const insights = row.insights as unknown as Insight[];
  let sent = 0;
  for (const a of admins) {
    const token = await digestToken(a.id, digestKey(deps));
    const unsubscribeUrl = token ? `${base}/auth/insights/unsubscribe?token=${encodeURIComponent(token)}` : null;
    const mail = insightsDigestEmail({
      base, projectName: project?.name ?? "your project", week, overviewUrl: `${base}/projects/${projectId}/overview`, unsubscribeUrl,
      insights: insights.map((i) => ({ title: i.title, finding: i.finding, recommendation: i.recommendation, numbers: i.numbers.map(numberLine), url: `${base}${i.link}` })),
    });
    const headers = unsubscribeUrl?.startsWith("https://") ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined;
    if (await trySend(deps.mailer, { to: a.email, ...mail, ...(headers ? { headers } : {}) })) sent++;
  }
  return sent;
}

/** One step of the weekly digest. Returns what it did (tests and logs). */
export async function runInsightsDigest(deps: Deps, now: Date, o: { force?: boolean } = {}) {
  const out = { generated: 0, emailed: 0, failed: 0, project: null as string | null };
  if (!deps.insightsDigest || !deps.assistant) return out;
  if (!o.force && !digestOpen(now)) return out;
  const { db } = deps;
  const week = weekOf(now);
  // First: insights written this week (by Refresh) that were never emailed.
  const [ready] = await db.select({ projectId: I.projectId }).from(I).innerJoin(schema.projects, eq(schema.projects.id, I.projectId))
    .where(and(eq(I.week, week), eq(I.status, "ready"), isNull(I.emailedAt), sql`${schema.projects.aiAccess} <> 'disabled'`)).limit(1);
  if (ready) {
    out.project = ready.projectId;
    out.emailed = await emailDigest({ ...deps, now: () => now }, ready.projectId, week);
    return out;
  }
  // An ISO string, not a Date: raw SQL parameters reach the Workers Postgres driver as they are.
  const since = new Date(now.getTime() - 90 * 86_400_000);
  const rows = await db.execute(sql`
    select p.id from projects p
    where p.ai_access <> 'disabled'
      and exists (select 1 from transactions t where t.project_id = p.id and t.is_sandbox = false and t.revenue_usd > 0 and t.purchased_at > ${since.toISOString()}::timestamptz)
      and not exists (select 1 from ai_insights i where i.project_id = p.id and i.week = ${week})
    order by p.id limit 1`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { id: string }[];
  const due = list[0];
  if (!due) return out;
  out.project = due.id;
  try {
    await generateInsights({ ...deps, now: () => now }, due.id, { by: "schedule", now });
    out.generated = 1;
    out.emailed = await emailDigest({ ...deps, now: () => now }, due.id, week);
  } catch (e) {
    // The row is marked "error" (or another run holds it); this week's digest for the project is skipped.
    out.failed = 1;
    if (!(e instanceof InsightsError && e.status === 409)) console.error(`insights digest: project ${due.id}`, e instanceof Error ? e.message : e);
    // A refusal before generation started (no admin, caps) leaves no row: record one so the next tick moves on.
    await db.insert(I).values({ projectId: due.id, week, status: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 500), generatedBy: "schedule", updatedAt: now }).onConflictDoNothing();
  }
  return out;
}
