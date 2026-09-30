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

  const T = schema.transactions;
  const from = new Date(Math.min(prevSince, starts[0]!));
  const txns = await db.select().from(T).where(and(eq(T.projectId, projectId), eq(T.isSandbox, sandbox), lte(T.purchasedAt, now),
    or(gte(T.purchasedAt, from), gte(T.expiresAt, from), isNull(T.expiresAt))));

  if (metric === "revenue") {
    const inRange = (a: number, b: number) => round2(txns.filter((x) => x.purchasedAt.getTime() >= a && x.purchasedAt.getTime() < b).reduce((s, x) => s + x.revenueUsd, 0));
    return {
      metric, value: inRange(since, t + 1), previous_value: inRange(prevSince, since),
      values: starts.map((s) => ({ date: day(s), value: inRange(s, Math.min(s + DAY, t + 1)) })),
    };
  }

  const live = await overviewValues(db, projectId, now, environment);
  const products = await db.select().from(schema.products).where(eq(schema.products.projectId, projectId));
  const refundAt = new Map<string, number>();
  for (const x of txns) if (x.kind === "refund") refundAt.set(`${x.store}:${x.storeTransactionId}`, x.purchasedAt.getTime());
  const periods = txns.filter((x) => (x.kind === "trial" || x.kind === "purchase" || x.kind === "renewal") && x.store !== "promotional");
  const factor = (x: typeof periods[number]) => {
    const p = products.find((q) => q.storeIdentifier === x.productIdentifier && q.appId === x.appId) ?? products.find((q) => q.storeIdentifier === x.productIdentifier);
    return monthlyFactor(p?.duration) ?? (x.expiresAt ? 30 * DAY / Math.max(DAY, x.expiresAt.getTime() - x.purchasedAt.getTime()) : 0);
  };
  const snapshot = (at: number) => {
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
    return metric === "active_trials" ? trials : metric === "active_subscriptions" ? subs : round2(mrr);
  };
  const values = starts.map((s, i) => ({ date: day(s), value: i === starts.length - 1 ? live[metric] : snapshot(s + DAY - 1) }));
  return { metric, value: live[metric], previous_value: snapshot(since), values };
}
