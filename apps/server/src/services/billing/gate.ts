import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../../mail/index.js";
import { billingLiveEmail } from "../../mail/templates.js";
import { rowsOf } from "../archive/tables.js";
import { stripeProblem, type BillingConfig } from "./stripe.js";
import { PAID_KINDS, accountPlanOf } from "./plans.js";

/**
 * The go-live gate of RevenueDot Cloud (prd/cloud-billing/PRD.md, "The go-live gate"). Building and testing are free with
 * no card. An account's first live sale starts 14 days to start Pro; after them, without a plan, live data answers 402 in
 * the dashboard and the API, and webhook and integration deliveries of production events are held until Pro starts.
 * Nothing here touches the SDK, purchase verification, entitlements or store notifications: an app's paying customers
 * always get what they bought.
 */

export const GRACE_DAYS = 14;
/** Held deliveries older than this are marked failed instead of sent when Pro starts. */
export const HOLD_DAYS = 30;
const DAY = 86_400_000;

export type GateStage = "off" | "building" | "grace" | "paused" | "active";
export interface Gate { stage: GateStage; live_at: number | null; grace_ends_at: number | null }

type Account = Pick<typeof schema.billingAccounts.$inferSelect, "plan" | "liveAt" | "graceEndsAt">;

/** Whether this server gates at all: RevenueDot Cloud with its Stripe set up. Self-hosted servers never do. */
export const gateOn = (deps: { edition?: string; billing?: BillingConfig | null }) => deps.edition === "cloud" && !stripeProblem(deps.billing);

/** An account's stage. `on`: gateOn of the server. */
export function gateOf(acct: Account | null, now: Date, on: boolean): Gate {
  const live_at = acct?.liveAt?.getTime() ?? null;
  const grace_ends_at = acct?.graceEndsAt?.getTime() ?? null;
  if (!on) return { stage: "off", live_at, grace_ends_at };
  if (accountPlanOf(acct?.plan) !== "none") return { stage: "active", live_at, grace_ends_at };
  if (live_at === null) return { stage: "building", live_at, grace_ends_at };
  return { stage: grace_ends_at !== null && now.getTime() < grace_ends_at ? "grace" : "paused", live_at, grace_ends_at };
}

/** The gate of a project: its owner's account. A project without an owner is never paused. */
export async function projectGate(db: DB, projectId: string, now: Date, on: boolean): Promise<Gate & { owner: { id: string; name: string | null; email: string } | null }> {
  if (!on) return { stage: "off", live_at: null, grace_ends_at: null, owner: null };
  const [row] = await db.select({ ownerId: schema.projects.ownerUserId, name: schema.users.name, email: schema.users.email, plan: schema.billingAccounts.plan, liveAt: schema.billingAccounts.liveAt, graceEndsAt: schema.billingAccounts.graceEndsAt })
    .from(schema.projects)
    .leftJoin(schema.users, eq(schema.users.id, schema.projects.ownerUserId))
    .leftJoin(schema.billingAccounts, eq(schema.billingAccounts.userId, schema.projects.ownerUserId))
    .where(eq(schema.projects.id, projectId)).limit(1);
  if (!row?.ownerId) return { stage: "off", live_at: null, grace_ends_at: null, owner: null };
  return { ...gateOf(row.plan === null ? null : { plan: row.plan, liveAt: row.liveAt, graceEndsAt: row.graceEndsAt }, now, on), owner: { id: row.ownerId, name: row.name, email: row.email ?? "" } };
}

/** The words of a 402: the owner can start Pro; anyone else asks the owner. */
export function pausedMessage(owner: { id: string; name: string | null; email: string } | null, viewerId: string | null): string {
  if (!owner || owner.id === viewerId) return "Live data is paused because this account has no plan. Start Pro on the Billing page: it costs $0 until your apps make $10,000 a month.";
  // A secret key has no person behind it: say what to do without naming the owner.
  if (viewerId === null) return "Live data is paused because this project's owner has no plan. The owner can start Pro on the Billing page: it costs $0 until their apps make $10,000 a month.";
  return `Live data is paused because the project owner, ${owner.name || owner.email}, has not started Pro. Ask them to start it on their Billing page: it costs $0 until their apps make $10,000 a month.`;
}

/**
 * The day the gate shipped. Accounts whose first live sale came before it get 30 days instead of 14: the Terms of Service
 * (section 5) promise at least 30 days before anything changes for an account past a free limit.
 */
export const GATE_SHIPPED = new Date("2026-10-06T00:00:00Z");
export const EXISTING_GRACE_DAYS = 30;

/**
 * Records accounts that went live: owners of a project with a live sale (production money, not imported, not copied in
 * by a move) and no `live_at` yet. Their days to start Pro count from now (when the sale is seen), 14 of them, or 30 for
 * accounts that were live before the gate shipped. Returns the accounts marked.
 */
export async function markLive(db: DB, now: Date): Promise<string[]> {
  const kinds = sql.join(PAID_KINDS.map((k) => sql`${k}`), sql`, `);
  // Only owners not live yet, and per project only its first live sale (an index walk on (project_id, created_at)): a
  // join of every transaction would read the whole table every 10 minutes.
  const owners = rowsOf<{ owner: string; first: Date | string }>(await db.execute(sql`
    SELECT p.owner_user_id AS owner, min(f.created_at) AS first FROM projects p
    CROSS JOIN LATERAL (SELECT t.created_at FROM transactions t WHERE t.project_id = p.id
      AND t.created_at >= coalesce(p.moved_in_at, '-infinity'::timestamptz) AND t.source IS NULL AND NOT t.is_sandbox AND t.revenue_usd > 0
      AND t.kind IN (${kinds}) ORDER BY t.created_at LIMIT 1) f
    WHERE p.owner_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM billing_accounts b WHERE b.user_id = p.owner_user_id AND b.live_at IS NOT NULL)
    GROUP BY p.owner_user_id`));
  const marked: string[] = [];
  for (const { owner: userId, first } of owners) {
    const days = new Date(first).getTime() < GATE_SHIPPED.getTime() ? EXISTING_GRACE_DAYS : GRACE_DAYS;
    const v = { liveAt: now, graceEndsAt: new Date(now.getTime() + days * DAY) };
    const [row] = await db.insert(schema.billingAccounts).values({ userId, ...v, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: schema.billingAccounts.userId, set: v, setWhere: sql`${schema.billingAccounts.liveAt} IS NULL` }).returning({ userId: schema.billingAccounts.userId });
    if (row) marked.push(row.userId);
  }
  return marked;
}

/** Accounts paused now: no plan, live, past their 14 days. As SQL, for the delivery updates. "standard" is Pro's old id (accountPlanOf). */
const pausedOwners = (now: Date) => sql`(SELECT b.user_id FROM billing_accounts b WHERE b.plan NOT IN ('pro', 'standard', 'enterprise') AND b.grace_ends_at IS NOT NULL AND b.grace_ends_at <= ${now.toISOString()}::timestamptz)`;

/**
 * True for a delivery whose event a paused account must not send: a production event (not a TEST the developer sent to
 * check the endpoint) of a project whose owner is paused. holdAndRelease holds these; the senders skip them too, so one
 * queued after this run's hold (by a request, while another run is sending) never goes out.
 */
export const pausedEvent = (eventId: SQLWrapper, now: Date) => sql`EXISTS (SELECT 1 FROM events e JOIN projects p ON p.id = e.project_id
  WHERE e.id = ${eventId} AND e.environment = 'production' AND e.type <> 'TEST' AND p.owner_user_id IN ${pausedOwners(now)})`;

/** True for a project whose owner is paused: its scheduled exports of live data wait for Pro (exports/run.ts). */
export const pausedProject = (projectId: SQLWrapper, now: Date) => sql`${projectId} IN (SELECT p.id FROM projects p WHERE p.owner_user_id IN ${pausedOwners(now)})`;

/**
 * Holds production deliveries of paused projects; with `release`, also sends held ones whose project is no longer paused
 * (oldest first: each goes back to the queue at the time it was created, ahead of anything newer) and fails held ones
 * older than 30 days. The cron runs all three every minute before deliveries go out; a request-kicked run only holds.
 */
export async function holdAndRelease(db: DB, now: Date, o: { release?: boolean } = {}): Promise<{ held: number; released: number; expired: number }> {
  const oldest = new Date(now.getTime() - HOLD_DAYS * DAY).toISOString();
  const paused = pausedOwners(now);
  const count = (r: unknown) => rowsOf(r).length;
  let expired = 0, released = 0;
  if (o.release !== false) {
    expired = count(await db.execute(sql`UPDATE webhook_deliveries SET status = 'failed', last_error = 'Held for 30 days while the account had no plan, then dropped.' WHERE status = 'held' AND created_at < ${oldest}::timestamptz RETURNING id`))
      + count(await db.execute(sql`UPDATE integration_deliveries SET status = 'failed', last_error = 'Held for 30 days while the account had no plan, then dropped.' WHERE status = 'held' AND created_at < ${oldest}::timestamptz RETURNING id`));
    released = count(await db.execute(sql`UPDATE webhook_deliveries d SET status = 'pending', next_attempt_at = d.created_at, last_error = NULL
        FROM webhooks w JOIN projects p ON p.id = w.project_id
        WHERE d.status = 'held' AND d.webhook_id = w.id AND (p.owner_user_id IS NULL OR p.owner_user_id NOT IN ${paused}) RETURNING d.id`))
      + count(await db.execute(sql`UPDATE integration_deliveries d SET status = 'pending', next_attempt_at = d.created_at, last_error = NULL
        FROM integrations i JOIN projects p ON p.id = i.project_id
        WHERE d.status = 'held' AND d.integration_id = i.id AND (p.owner_user_id IS NULL OR p.owner_user_id NOT IN ${paused}) RETURNING d.id`));
  }
  const held = count(await db.execute(sql`UPDATE webhook_deliveries d SET status = 'held', last_error = 'Held: the project owner has no plan. Start Pro to send it.'
      FROM webhooks w, projects p, events e
      WHERE d.status = 'pending' AND d.webhook_id = w.id AND p.id = w.project_id AND e.id = d.event_id AND e.environment = 'production' AND e.type <> 'TEST' AND p.owner_user_id IN ${paused} RETURNING d.id`))
    + count(await db.execute(sql`UPDATE integration_deliveries d SET status = 'held', last_error = 'Held: the project owner has no plan. Start Pro to send it.'
      FROM integrations i, projects p, events e
      WHERE d.status = 'pending' AND d.integration_id = i.id AND p.id = i.project_id AND e.id = d.event_id AND e.environment = 'production' AND e.type <> 'TEST' AND p.owner_user_id IN ${paused} RETURNING d.id`));
  return { held, released, expired };
}

/**
 * The gate's emails, at most three per go-live, only to accounts without a plan: the first live sale (with the date), a
 * reminder two days before the date, and the pause. Each once (billing_notices). An account that lost Pro because every
 * payment failed already got the unpaid email, which says the same, so it gets no pause email.
 */
export async function liveNotices(rt: { db: DB; now: Date; mailer?: Mailer; publicUrl?: string }): Promise<number> {
  const A = schema.billingAccounts;
  const rows = await rt.db.select({ userId: A.userId, plan: A.plan, status: A.status, liveAt: A.liveAt, graceEndsAt: A.graceEndsAt, email: schema.users.email })
    .from(A).innerJoin(schema.users, eq(schema.users.id, A.userId))
    .where(and(inArray(A.plan, ["none", "free"]), sql`${A.liveAt} IS NOT NULL AND ${A.graceEndsAt} IS NOT NULL`));
  const base = (rt.publicUrl ?? "https://app.revenuedot.app").replace(/\/+$/, "");
  const now = rt.now.getTime();
  let sent = 0;
  for (const r of rows) {
    const ends = r.graceEndsAt!.getTime();
    const tag = String(ends);
    const kind = now >= ends ? "paused" : now >= ends - 2 * DAY ? "reminder" : "grace";
    if (kind === "paused" && r.status === "unpaid") continue;
    // A reminder or pause first seen late still goes out once; the first-sale email is skipped once the reminder is due.
    const [won] = await rt.db.insert(schema.billingNotices).values({ userId: r.userId, key: `live_${kind}:${tag}`, sentAt: rt.now }).onConflictDoNothing().returning();
    if (kind !== "grace") await rt.db.insert(schema.billingNotices).values({ userId: r.userId, key: `live_grace:${tag}`, sentAt: rt.now }).onConflictDoNothing();
    if (kind === "paused") await rt.db.insert(schema.billingNotices).values({ userId: r.userId, key: `live_reminder:${tag}`, sentAt: rt.now }).onConflictDoNothing();
    if (!won) continue;
    // 30 days instead of 14: live before the gate shipped (markLive), so "your first live sale" would be wrong.
    const existing = r.liveAt !== null && ends - r.liveAt.getTime() > GRACE_DAYS * DAY;
    if (await trySend(rt.mailer, { to: r.email, ...billingLiveEmail({ base, kind, graceEndsAt: r.graceEndsAt!, existing }) })) sent++;
  }
  return sent;
}
