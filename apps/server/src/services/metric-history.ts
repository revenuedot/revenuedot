import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { monthlyFactor, overviewValues, type OverviewValues } from "../routes/v2/metrics.js";

const DAY = 86400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type HistoryMetric = keyof OverviewValues;
export const HISTORY_METRICS: HistoryMetric[] = ["active_trials", "active_subscriptions", "mrr", "revenue", "new_customers", "active_users"];

export interface MetricHistory {
  metric: HistoryMetric;
  /** The value now: a live snapshot (trials, subscriptions, MRR) or the total over the last `days` days. */
  value: number;
  /** The same number `days` days earlier (a snapshot) or over the `days` before that (a total). Null when it cannot be known. */
  previous_value: number | null;
  /** One point per UTC day, oldest first; the last point is today. Null when no daily history can be computed. */
  values: { date: string; value: number }[] | null;
}

/**
 * Daily history behind the Overview cards, computed from stored transactions and customers.
 * - revenue / new_customers: sums per day; `value` is the rolling total for (now − days, now], like /metrics/overview.
 * - active_users: customers last seen in the window. Only the latest "last seen" is stored, so there is no daily
 *   series and no previous window.
 * - active_trials / active_subscriptions / mrr: snapshots at the end of each day, rebuilt from each transaction's
 *   [purchased_at, expires_at) and cut short by a refund of the same store transaction. A customer counts once per
 *   store and app at any instant (an upgrade overlaps the old period for a moment). Today's point is the live value.
 * Customers are not split by environment, matching RevenueCat's Overview (the sandbox toggle leaves customer cards alone).
 */
export async function metricHistory(db: DB, projectId: string, now: Date, metric: HistoryMetric, days: number, environment: "production" | "sandbox"): Promise<MetricHistory> {
  const sandbox = environment === "sandbox";
  const t = now.getTime();
  const since = t - days * DAY;
  const prevSince = t - 2 * days * DAY;
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const starts = Array.from({ length: days }, (_, i) => todayStart - (days - 1 - i) * DAY);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (metric === "new_customers" || metric === "active_users") {
    const custs = await db.select({ firstSeen: schema.customers.firstSeen, lastSeen: schema.customers.lastSeen }).from(schema.customers).where(eq(schema.customers.projectId, projectId));
    const inWindow = (x: number) => x >= since && x <= t;
    if (metric === "active_users") return { metric, value: custs.filter((c) => inWindow(c.lastSeen.getTime())).length, previous_value: null, values: null };
    const first = custs.map((c) => c.firstSeen.getTime());
    return {
      metric, value: first.filter(inWindow).length,
      previous_value: first.filter((x) => x >= prevSince && x < since).length,
      values: starts.map((s) => ({ date: day(s), value: first.filter((x) => x >= s && x < s + DAY && x <= t).length })),
    };
  }

  const { txns, snapshot: at } = await ledger(db, projectId, now, sandbox, new Date(Math.min(prevSince, starts[0]!)));

  if (metric === "revenue") {
    const inRange = (a: number, b: number) => round2(txns.filter((x) => x.purchasedAt.getTime() >= a && x.purchasedAt.getTime() < b).reduce((s, x) => s + x.revenueUsd, 0));
    return {
      metric, value: inRange(since, t + 1), previous_value: inRange(prevSince, since),
      values: starts.map((s) => ({ date: day(s), value: inRange(s, Math.min(s + DAY, t + 1)) })),
    };
  }

  const live = await overviewValues(db, projectId, now, environment);
  const snapshot = (ms: number) => pick(at(ms), metric);
  const values = starts.map((s, i) => ({ date: day(s), value: i === starts.length - 1 ? live[metric] : snapshot(s + DAY - 1) }));
  return { metric, value: live[metric], previous_value: snapshot(since), values };
}

type Snapshot = { trials: number; subs: number; mrr: number };
const pick = (s: Snapshot, metric: "active_trials" | "active_subscriptions" | "mrr") => metric === "active_trials" ? s.trials : metric === "active_subscriptions" ? s.subs : round2(s.mrr);

/**
 * The project's transactions of one environment touching [from, now], and a snapshot function over them: trials,
 * subscriptions and MRR at an instant, rebuilt from each paid period [purchased_at, expires_at) cut short by a refund.
 */
async function ledger(db: DB, projectId: string, now: Date, sandbox: boolean, from: Date) {
  const T = schema.transactions;
  const txns = await db.select().from(T).where(and(eq(T.projectId, projectId), eq(T.isSandbox, sandbox), lte(T.purchasedAt, now),
    or(gte(T.purchasedAt, from), gte(T.expiresAt, from), isNull(T.expiresAt))));
  const products = await db.select().from(schema.products).where(eq(schema.products.projectId, projectId));
  const refundAt = new Map<string, number>();
  for (const x of txns) if (x.kind === "refund") refundAt.set(`${x.store}:${x.storeTransactionId}`, x.purchasedAt.getTime());
  // A reversed refund gives the period back (the refund row stays in the ledger, the reversal cancels it out).
  for (const x of txns) if (x.kind === "refund_reversal") refundAt.delete(`${x.store}:${x.storeTransactionId}`);
  const periods = txns.filter((x) => (x.kind === "trial" || x.kind === "purchase" || x.kind === "renewal") && x.store !== "promotional");
  const factor = (x: typeof periods[number]) => {
    const p = products.find((q) => q.storeIdentifier === x.productIdentifier && q.appId === x.appId) ?? products.find((q) => q.storeIdentifier === x.productIdentifier);
    return monthlyFactor(p?.duration) ?? (x.expiresAt ? 30 * DAY / Math.max(DAY, x.expiresAt.getTime() - x.purchasedAt.getTime()) : 0);
  };
  const snapshot = (at: number): Snapshot => {
    const current = new Map<string, typeof periods[number]>();
    for (const x of periods) {
      const start = x.purchasedAt.getTime();
      const end = Math.min(x.expiresAt ? x.expiresAt.getTime() : Infinity, refundAt.get(`${x.store}:${x.storeTransactionId}`) ?? Infinity);
      if (start > at || end <= at) continue;
      const k = `${x.customerId}:${x.store}:${x.appId ?? ""}`;
      const cur = current.get(k);
      if (!cur || cur.purchasedAt < x.purchasedAt) current.set(k, x);
    }
    let trials = 0, subs = 0, mrr = 0;
    for (const x of current.values()) {
      if (x.kind === "trial") { trials++; continue; }
      subs++;
      mrr += x.revenueUsd * factor(x);
    }
    return { trials, subs, mrr };
  };
  return { txns, snapshot };
}

/**
 * One point per UTC calendar month, oldest first, the last being the month so far (Verified Metrics' line charts):
 * - mrr / active_subscriptions / active_trials: the value at the end of each month; the current month's point is the live value.
 * - revenue / new_customers: the month's total (the current month up to now).
 * - active_users: no history is stored (only the latest "last seen"), so null.
 * One read of the ledger and one of the customers, whatever the number of metrics.
 */
export async function monthlyHistories(db: DB, projectId: string, now: Date, metrics: HistoryMetric[], months: number, environment: "production" | "sandbox"): Promise<Partial<Record<HistoryMetric, { date: string; value: number }[] | null>>> {
  const t = now.getTime();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const starts = Array.from({ length: months }, (_, i) => Date.UTC(y, m - (months - 1 - i), 1));
  const ends = starts.map((s, i) => (i === starts.length - 1 ? t + 1 : starts[i + 1]!));
  const label = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  const out: Partial<Record<HistoryMetric, { date: string; value: number }[] | null>> = {};
  const want = new Set(metrics);
  if (want.has("active_users")) out.active_users = null;
  if (want.has("new_customers")) {
    const first = (await db.select({ firstSeen: schema.customers.firstSeen }).from(schema.customers)
      .where(and(eq(schema.customers.projectId, projectId), gte(schema.customers.firstSeen, new Date(starts[0]!)), lte(schema.customers.firstSeen, now)))).map((c) => c.firstSeen.getTime());
    out.new_customers = starts.map((s, i) => ({ date: label(s), value: first.filter((x) => x >= s && x < ends[i]!).length }));
  }
  const ledgerMetrics = metrics.filter((x) => x === "revenue" || x === "mrr" || x === "active_subscriptions" || x === "active_trials");
  if (ledgerMetrics.length) {
    const { txns, snapshot } = await ledger(db, projectId, now, environment === "sandbox", new Date(starts[0]!));
    if (want.has("revenue")) out.revenue = starts.map((s, i) => ({ date: label(s), value: round2(txns.filter((x) => x.purchasedAt.getTime() >= s && x.purchasedAt.getTime() < ends[i]!).reduce((a, x) => a + x.revenueUsd, 0)) }));
    const snaps = ledgerMetrics.some((x) => x !== "revenue") ? starts.map((_, i) => (i === starts.length - 1 ? null : snapshot(ends[i]! - 1))) : [];
    const live = snaps.length ? await overviewValues(db, projectId, now, environment) : null;
    for (const metric of ["mrr", "active_subscriptions", "active_trials"] as const) {
      if (!want.has(metric)) continue;
      out[metric] = starts.map((s, i) => ({ date: label(s), value: snaps[i] ? pick(snaps[i]!, metric) : live![metric] }));
    }
  }
  return out;
}
