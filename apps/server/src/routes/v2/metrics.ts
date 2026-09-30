import { and, eq, gte, lte } from "drizzle-orm";
import { accessEndsAt } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { subRowToDomain } from "../../repo/customers.js";
import { paramError, round2, scope, type V2Router } from "./common.js";

const DAY = 86400_000;

/**
 * How many times a period fits in a month (30 days): P1M = 1, P1Y = 1/12, P1W = 4.33, P3D = 10.
 * Weeks use 4.33 per month and days 30 per month, so weekly prices are normalised the way RevenueCat's charts do.
 */
export function monthlyFactor(iso: string | null | undefined): number | null {
  const m = iso ? /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?$/.exec(iso) : null;
  if (!m) return null;
  const months = Number(m[1] ?? 0) * 12 + Number(m[2] ?? 0) + Number(m[3] ?? 0) / 4.33 + Number(m[4] ?? 0) / 30;
  return months > 0 ? 1 / months : null;
}

export interface OverviewValues {
  active_trials: number; active_subscriptions: number; mrr: number; revenue: number; new_customers: number; active_users: number;
}

/**
 * The overview numbers, computed live from our tables.
 * - active_trials: trial-period subscriptions that currently give access.
 * - active_subscriptions: paid subscriptions that currently give access (no trials, no promotional grants, no refunds).
 * - mrr: those paid subscriptions' USD price normalised to one month by the product's duration.
 * - revenue: USD sum of transactions (refunds negative) in the last 28 days.
 * - new_customers / active_users: customers first seen / last seen in the last 28 days.
 * Subscriptions and revenue count one environment (production by default).
 */
export async function overviewValues(db: DB, projectId: string, now: Date, environment: "production" | "sandbox" = "production"): Promise<OverviewValues> {
  const sandbox = environment === "sandbox";
  const since = new Date(now.getTime() - 28 * DAY);
  const [subs, products, txns, custs] = await Promise.all([
    db.select().from(schema.subscriptions).where(and(eq(schema.subscriptions.projectId, projectId), eq(schema.subscriptions.isSandbox, sandbox))),
    db.select().from(schema.products).where(eq(schema.products.projectId, projectId)),
    db.select({ usd: schema.transactions.revenueUsd }).from(schema.transactions)
      .where(and(eq(schema.transactions.projectId, projectId), eq(schema.transactions.isSandbox, sandbox), gte(schema.transactions.purchasedAt, since), lte(schema.transactions.purchasedAt, now))),
    db.select({ firstSeen: schema.customers.firstSeen, lastSeen: schema.customers.lastSeen }).from(schema.customers).where(eq(schema.customers.projectId, projectId)),
  ]);
  const durationOf = (s: typeof subs[number]) => {
    const keys = s.productPlanIdentifier ? [`${s.productIdentifier}:${s.productPlanIdentifier}`, s.productIdentifier] : [s.productIdentifier];
    for (const k of keys) {
      const p = products.find((x) => x.storeIdentifier === k && x.appId === s.appId) ?? products.find((x) => x.storeIdentifier === k);
      if (p?.duration) return p.duration;
    }
    return null;
  };
  let trials = 0, active = 0, mrr = 0;
  for (const s of subs) {
    if (s.refundedAt || s.store === "promotional") continue;
    const end = accessEndsAt(subRowToDomain(s));
    if (end !== null && end <= now) continue;
    if (s.periodType === "trial") { trials++; continue; }
    active++;
    const usd = s.priceUsd ?? (s.priceCurrency === "USD" ? s.priceAmount : null) ?? 0;
    // Without a catalog duration, fall back to the length of the current period.
    const factor = monthlyFactor(durationOf(s)) ?? (s.expiresDate ? 30 * DAY / Math.max(DAY, s.expiresDate.getTime() - s.purchaseDate.getTime()) : 0);
    mrr += usd * factor;
  }
  return {
    active_trials: trials, active_subscriptions: active, mrr: round2(mrr),
    revenue: round2(txns.reduce((a, t) => a + t.usd, 0)),
    new_customers: custs.filter((c) => c.firstSeen >= since && c.firstSeen <= now).length,
    active_users: custs.filter((c) => c.lastSeen >= since && c.lastSeen <= now).length,
  };
}

const METRICS: { id: keyof OverviewValues; name: string; description: string; unit: string; period: "P0D" | "P28D" }[] = [
  { id: "active_trials", name: "Active Trials", description: "In total", unit: "#", period: "P0D" },
  { id: "active_subscriptions", name: "Active Subscriptions", description: "In total", unit: "#", period: "P0D" },
  { id: "mrr", name: "MRR", description: "Monthly Recurring Revenue", unit: "$", period: "P28D" },
  { id: "revenue", name: "Revenue", description: "Last 28 days", unit: "$", period: "P28D" },
  { id: "new_customers", name: "New Customers", description: "Last 28 days", unit: "#", period: "P28D" },
  { id: "active_users", name: "Active Customers", description: "Last 28 days", unit: "#", period: "P28D" },
];

export function metricsRoutes(r: V2Router, deps: Deps) {
  r.get("/v2/projects/:project_id/metrics/overview", scope("charts_metrics:overview:read"), async (c) => {
    const currency = c.req.query("currency") ?? "USD";
    // We only hold USD values (no FX table yet), so other currencies are refused rather than mislabelled.
    if (currency !== "USD") throw paramError("Only USD is supported for now.", "currency");
    // RevenueDot extension: ?environment=sandbox shows Test Store and sandbox purchases.
    const env = c.req.query("environment") ?? "production";
    if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
    const now = deps.now();
    const v = await overviewValues(deps.db, c.get("projectId"), now, env);
    return c.json({
      object: "overview_metrics",
      currency: "USD",
      metrics: METRICS.map((m) => ({ object: "overview_metric", ...m, value: v[m.id], last_updated_at: now.getTime(), last_updated_at_iso8601: now.toISOString() })),
    });
  });
}
