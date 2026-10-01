import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { AD_EVENT_TYPES, AD_TYPES, adTotals, adsOverview, periodDays, type AdEventGroup } from "@revenuedot/core/ads";
import { schema, type DB } from "@revenuedot/db";
import { ensureEcbRange, fxLookup, type FxFetch } from "../fx.js";

/**
 * The Ads Overview (prd/ads/PRD.md): SDK ad events aggregated in SQL by day, type and dimensions, converted to US
 * dollars per day in @revenuedot/core/ads, next to subscription revenue for the same period and environment.
 */

const X = schema.sdkEvents;
const T = schema.transactions;

export type AdsRange = "7d" | "28d" | "90d" | "12m";

async function groups(db: DB, o: { projectId: string; sandbox: boolean; appId: string | null; start: Date; end: Date }): Promise<AdEventGroup[]> {
  const p = (k: string) => sql<string | null>`${X.payload}->>${k}`;
  const rows = await db.select({
    day: sql<string>`to_char(${X.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`, type: X.type, currency: p("currency"), network: p("network_name"), format: p("ad_format"),
    placement: p("placement"), adUnitId: p("ad_unit_id"), mediator: p("mediator_name"), count: sql<number>`count(*)::int`,
    // revenue_micros is an integer in both SDKs; anything else counts as 0 rather than failing the query.
    micros: sql<number>`coalesce(sum(CASE WHEN ${X.type} = ${AD_TYPES.revenue} AND (${X.payload}->>'revenue_micros') ~ '^-?[0-9]{1,18}$' THEN (${X.payload}->>'revenue_micros')::float8 ELSE 0 END), 0)::float8`,
  }).from(X).where(and(eq(X.projectId, o.projectId), eq(X.isSandbox, o.sandbox), inArray(X.type, AD_EVENT_TYPES), gte(X.occurredAt, o.start), lt(X.occurredAt, o.end),
    ...(o.appId ? [eq(X.appId, o.appId)] : [])))
    .groupBy(sql`1, 2, 3, 4, 5, 6, 7, 8`);
  return rows.map((r) => ({ ...r, count: Number(r.count), micros: Number(r.micros) }));
}

export async function loadAdsOverview(db: DB, o: { projectId: string; range: AdsRange; sandbox: boolean; appId: string | null; now: Date; fetch?: FxFetch | null }) {
  const { days, start, end, previousStart } = periodDays(o.range, o.now);
  const [current, previous, subs, customers, any, units] = await Promise.all([
    groups(db, { ...o, start, end }),
    groups(db, { ...o, start: previousStart, end: start }),
    db.select({ day: sql<string>`to_char(${T.purchasedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`, usd: sql<number>`coalesce(sum(${T.revenueUsd}), 0)::float8` }).from(T)
      .where(and(eq(T.projectId, o.projectId), eq(T.isSandbox, o.sandbox), gte(T.purchasedAt, previousStart), lt(T.purchasedAt, end), ...(o.appId ? [eq(T.appId, o.appId)] : [])))
      .groupBy(sql`1`),
    db.select({ n: sql<number>`count(distinct coalesce(${X.customerId}, ${X.appUserId}))::int` }).from(X)
      .where(and(eq(X.projectId, o.projectId), eq(X.isSandbox, o.sandbox), inArray(X.type, AD_EVENT_TYPES), gte(X.occurredAt, start), lt(X.occurredAt, end), ...(o.appId ? [eq(X.appId, o.appId)] : []))),
    db.select({ type: X.type, sandbox: X.isSandbox }).from(X).where(and(eq(X.projectId, o.projectId), sql`${X.type} LIKE 'rc_ads_%'`)).limit(1),
    db.select().from(schema.adUnits).where(eq(schema.adUnits.projectId, o.projectId)),
  ]);
  if ([...current, ...previous].some((g) => g.type === AD_TYPES.revenue && (g.currency ?? "USD").toUpperCase() !== "USD")) {
    await ensureEcbRange(db, previousStart, o.now, o.fetch ?? null);
  }
  const fxl = await fxLookup(db);
  const fx = (amount: number, currency: string, at: number) => fxl.toUsd(amount, currency, at);
  const subByDay: Record<string, number> = {};
  let subPrevious = 0;
  const firstDay = days[0]!;
  for (const s of subs) {
    if (s.day >= firstDay) subByDay[s.day] = Number(s.usd);
    else subPrevious += Number(s.usd);
  }
  const ov = adsOverview({ groups: current, days, fx, subscriptionRevenueByDay: subByDay, adCustomers: Number(customers[0]?.n ?? 0) });
  const prev = adTotals(previous, fx);
  const names = new Map(units.map((u) => [u.adUnitId, u]));
  // AdMob ad unit ids are "ca-app-pub-…/123"; the SDK sends the same id, so names match directly.
  const adUnitRows = ov.breakdowns.ad_unit.map((r) => ({ ...r, name: names.get(r.key)?.displayName ?? null, unit_format: names.get(r.key)?.format ?? null }));
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    object: "ads_overview" as const, currency: "USD", range: o.range, environment: o.sandbox ? "sandbox" : "production", app_id: o.appId,
    start_date: start.toISOString().slice(0, 10), end_date: days[days.length - 1]!, has_ad_events: any.length > 0,
    totals: ov.totals,
    previous: { ...prev, subscription_revenue: round2(subPrevious) },
    series: ov.series,
    by_network: ov.breakdowns.network, by_format: ov.breakdowns.format, by_placement: ov.breakdowns.placement, by_ad_unit: adUnitRows, by_mediator: ov.breakdowns.mediator,
    unconverted: ov.unconverted,
    ad_units_loaded: units.length,
  };
}
