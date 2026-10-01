import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../../mail/index.js";
import { billingUsageEmail } from "../../mail/templates.js";
import { rowsOf } from "../archive/tables.js";
import { billCents, monthBounds, monthOf, planOf, plansFrom, previousMonth, type Plan } from "./plans.js";
import { billingStripe, stripeProblem, type BillingConfig } from "./stripe.js";

/**
 * Metering for RevenueDot Cloud (prd/cloud-billing/PRD.md): tracked revenue per project and month, the bill per account
 * (the user who owns the projects), the bill reported to Stripe's meter, and usage emails. Run from the Cloud tick at most
 * once an hour; the first two days of a month also settle the month before.
 */

const U = schema.billingUsage;
export const PAID_KINDS = ["purchase", "renewal", "one_time"];
const EVERY_MS = 3_600_000;

export interface BillingRuntime { db: DB; now: Date; fetch?: typeof fetch; mailer?: Mailer; publicUrl?: string; config: BillingConfig | null; force?: boolean }

/** Tracked revenue of every project in a month: production money, refunds not subtracted, moved-in history left out. */
export async function meterMonth(db: DB, month: string, now: Date): Promise<number> {
  const { start, end } = monthBounds(month);
  const rows = rowsOf<{ project_id: string; name: string; owner: string | null; usd: number; n: number }>(await db.execute(sql`
    SELECT p.id AS project_id, p.name, p.owner_user_id AS owner,
      coalesce(sum(t.revenue_usd) FILTER (WHERE t.id IS NOT NULL), 0)::float8 AS usd, count(t.id)::int AS n
    FROM projects p
    JOIN transactions t ON t.project_id = p.id
      AND t.purchased_at >= ${start} AND t.purchased_at < ${end} AND t.is_sandbox = false AND t.revenue_usd > 0
      AND t.kind IN (${sql.join(PAID_KINDS.map((k) => sql`${k}`), sql`, `)})
      AND (p.moved_in_at IS NULL OR t.created_at >= p.moved_in_at)
    GROUP BY p.id, p.name, p.owner_user_id`));
  for (const r of rows) {
    const v = { ownerUserId: r.owner, projectName: r.name, trackedRevenueUsd: Math.round(Number(r.usd) * 100) / 100, transactions: Number(r.n), computedAt: now };
    await db.insert(U).values({ projectId: r.project_id, month, ...v }).onConflictDoUpdate({ target: [U.projectId, U.month], set: v });
  }
  return rows.length;
}

export interface AccountUsage {
  month: string;
  tracked_revenue_usd: number;
  projects: { project_id: string; name: string | null; tracked_revenue_usd: number; transactions: number }[];
  computed_at: number | null;
}

export async function accountUsage(db: DB, userId: string, month: string): Promise<AccountUsage> {
  const rows = await db.select().from(U).where(and(eq(U.ownerUserId, userId), eq(U.month, month)));
  const projects = rows.map((r) => ({ project_id: r.projectId, name: r.projectName, tracked_revenue_usd: r.trackedRevenueUsd, transactions: r.transactions })).sort((a, b) => b.tracked_revenue_usd - a.tracked_revenue_usd);
  const total = Math.round(projects.reduce((s, p) => s + p.tracked_revenue_usd, 0) * 100) / 100;
  return { month, tracked_revenue_usd: total, projects, computed_at: rows.length ? Math.max(...rows.map((r) => r.computedAt.getTime())) : null };
}

export async function accountOf(db: DB, userId: string) {
  const [a] = await db.select().from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, userId));
  return a ?? null;
}

/** Usage emails once per account, month and threshold. */
async function usageNotices(rt: BillingRuntime, userId: string, plan: Plan, month: string, tracked: number, cents: number) {
  const keys: { key: "free_80" | "free_100" | "cap" | "ceiling_80" | "ceiling_100"; limit: number }[] = [];
  if (plan.id === "free" && plan.limit_usd) {
    if (tracked >= plan.limit_usd) keys.push({ key: "free_100", limit: plan.limit_usd });
    else if (tracked >= 0.8 * plan.limit_usd) keys.push({ key: "free_80", limit: plan.limit_usd });
  }
  if (plan.id === "standard") {
    if (plan.cap_usd !== null && cents >= Math.round(plan.cap_usd * 100)) keys.push({ key: "cap", limit: plan.cap_usd });
    if (plan.limit_usd && tracked >= plan.limit_usd) keys.push({ key: "ceiling_100", limit: plan.limit_usd });
    else if (plan.limit_usd && tracked >= 0.8 * plan.limit_usd) keys.push({ key: "ceiling_80", limit: plan.limit_usd });
  }
  if (!keys.length) return 0;
  const [user] = await rt.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) return 0;
  let sent = 0;
  for (const k of keys) {
    // 100% implies 80%: do not send both the same hour.
    const extra = k.key === "free_100" ? ["free_80"] : k.key === "ceiling_100" ? ["ceiling_80"] : [];
    const [won] = await rt.db.insert(schema.billingNotices).values({ userId, key: `${month}:${k.key}`, sentAt: rt.now }).onConflictDoNothing().returning();
    for (const x of extra) await rt.db.insert(schema.billingNotices).values({ userId, key: `${month}:${x}`, sentAt: rt.now }).onConflictDoNothing();
    if (!won) continue;
    const mail = billingUsageEmail({ base: (rt.publicUrl ?? "https://app.revenuedot.app").replace(/\/+$/, ""), kind: k.key, month, tracked, limit: k.limit, bill: cents / 100 });
    if (await trySend(rt.mailer, { to: user.email, ...mail })) sent++;
  }
  return sent;
}

/** One billing pass: meter, report each account's bill to Stripe when it changed, send usage emails. */
export async function runBilling(rt: BillingRuntime): Promise<number> {
  const month = monthOf(rt.now);
  if (!rt.force) {
    const [last] = rowsOf<{ at: Date | string | null }>(await rt.db.execute(sql`SELECT max(computed_at) AS at FROM billing_usage WHERE month = ${month}`));
    if (last?.at && rt.now.getTime() - new Date(last.at).getTime() < EVERY_MS) return 0;
  }
  const months = rt.now.getUTCDate() <= 2 ? [previousMonth(month), month] : [month];
  const plans = plansFrom(rt.config?.plansJson);
  let work = 0;
  for (const m of months) {
    work += await meterMonth(rt.db, m, rt.now);
    const owners = await rt.db.selectDistinct({ id: U.ownerUserId }).from(U).where(and(eq(U.month, m), sql`${U.ownerUserId} IS NOT NULL`));
    const ids = owners.map((o) => o.id!).filter(Boolean);
    const accounts = ids.length ? await rt.db.select().from(schema.billingAccounts).where(inArray(schema.billingAccounts.userId, ids)) : [];
    for (const userId of ids) {
      const acct = accounts.find((a) => a.userId === userId) ?? null;
      const plan = planOf(plans, acct?.plan ?? "free");
      const usage = await accountUsage(rt.db, userId, m);
      const cents = billCents(plan, usage.tracked_revenue_usd);
      if (m === month) await usageNotices(rt, userId, plan, m, usage.tracked_revenue_usd, cents);
      await reportMeter(rt, acct, plan, m, cents);
    }
  }
  return work;
}

/** Sends the month's bill (cents) to Stripe's meter when it changed since the last report. */
async function reportMeter(rt: BillingRuntime, acct: typeof schema.billingAccounts.$inferSelect | null, plan: Plan, month: string, cents: number) {
  if (!acct?.stripeCustomerId || plan.id !== "standard" || !["active", "past_due"].includes(acct.status) || stripeProblem(rt.config)) return;
  const R = schema.billingMeterReports;
  const [prev] = await rt.db.select().from(R).where(and(eq(R.userId, acct.userId), eq(R.month, month)));
  if (prev && prev.cents === cents) return;
  const { end } = monthBounds(month);
  // An event for a past month is dated its last second, so it lands in that month's period.
  const at = end <= rt.now ? new Date(end.getTime() - 1000) : rt.now;
  const identifier = `rd-${acct.userId}-${month}-${cents}`.slice(0, 100);
  try {
    await billingStripe(rt.config!, rt.fetch).meterEvent({ customer: acct.stripeCustomerId, cents, identifier, timestamp: at });
    await rt.db.insert(R).values({ userId: acct.userId, month, cents, identifier, reportedAt: rt.now }).onConflictDoUpdate({ target: [R.userId, R.month], set: { cents, identifier, reportedAt: rt.now } });
  } catch (e) {
    console.error(`billing: meter event for ${acct.userId} ${month} failed`, e);
  }
}
