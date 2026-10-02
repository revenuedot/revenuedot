import { and, eq, gte, lt } from "drizzle-orm";
import { commissionRate, periodsFrom, type CommissionSettings } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

/**
 * Store commission with the project's context (packages/core/src/commission.ts): each app's Small Business Program
 * (App Store) or Small Business Accelerator (Amazon) dates, and Google Play's $1M-a-year tier from the app's own sales.
 * Proceeds are derived when they are read, so changing program dates recomputes past proceeds everywhere they are
 * reported; events already sent to webhooks keep their values.
 */

/** App settings: `small_business_program` (App Store) and `small_business_accelerator` (Amazon), lists of entry/exit dates. */
export function programsOfApps(apps: Array<{ id: string; type: string; credentials: Record<string, unknown> | null }>): CommissionSettings {
  const programs: Record<string, ReturnType<typeof periodsFrom>> = {};
  for (const a of apps) {
    const cr = a.credentials ?? {};
    const raw = a.type === "app_store" || a.type === "mac_app_store" ? cr.small_business_program : a.type === "amazon" ? cr.small_business_accelerator : undefined;
    const enrolled = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (enrolled && enrolled.enrolled === false) continue;
    const periods = periodsFrom(enrolled ? enrolled.periods : raw);
    if (periods.length) programs[a.id] = periods;
  }
  return { programs };
}

export async function commissionSettingsOf(db: DB, projectId: string): Promise<CommissionSettings> {
  const apps = await db.select({ id: schema.apps.id, type: schema.apps.type, credentials: schema.apps.credentials }).from(schema.apps).where(eq(schema.apps.projectId, projectId));
  return programsOfApps(apps);
}

export interface RateInput { store: string; appId: string | null; at: Date | number; kind: string; isSandbox?: boolean; country?: string | null; firstSeen?: Date | number | null; id?: string }

const ms = (d: Date | number) => (typeof d === "number" ? d : d.getTime());
const yearStart = (at: number) => Date.UTC(new Date(at).getUTCFullYear(), 0, 1);

/**
 * A request's commission model: the settings once, and Google Play sales per app, environment and year for the tier,
 * loaded on first use. `rate()` is synchronous after `load()`.
 */
export async function commissionModel(db: DB, projectId: string) {
  const settings = await commissionSettingsOf(db, projectId);
  const T = schema.transactions;
  const play = await db.select({ id: T.id, appId: T.appId, at: T.purchasedAt, usd: T.revenueUsd, kind: T.kind, sandbox: T.isSandbox }).from(T)
    .where(and(eq(T.projectId, projectId), eq(T.store, "play_store")));
  // Running totals per app, environment and calendar year, in purchase order.
  const series = new Map<string, Array<{ at: number; id: string; before: number; after: number }>>();
  const sorted = play.map((p) => ({ ...p, at: p.at.getTime() })).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const totals = new Map<string, number>();
  for (const p of sorted) {
    const key = `${p.appId ?? ""}|${p.sandbox}|${new Date(p.at).getUTCFullYear()}`;
    const before = totals.get(key) ?? 0;
    const after = (p.kind === "purchase" || p.kind === "renewal" || p.kind === "one_time") && p.usd > 0 ? before + p.usd : before;
    (series.get(key) ?? series.set(key, []).get(key)!).push({ at: p.at, id: p.id, before, after });
    totals.set(key, after);
  }
  const ytdBefore = (r: RateInput, at: number) => {
    const list = series.get(`${r.appId ?? ""}|${!!r.isSandbox}|${new Date(at).getUTCFullYear()}`);
    if (!list?.length) return 0;
    if (r.id) { const hit = list.find((x) => x.id === r.id); if (hit) return hit.before; }
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]!.at < at) lo = mid + 1; else hi = mid; }
    return lo === 0 ? 0 : list[lo - 1]!.after;
  };
  return {
    settings,
    rate(r: RateInput): number {
      const at = ms(r.at);
      return commissionRate({ store: r.store, appId: r.appId, at, kind: r.kind, country: r.country ?? null, firstSeen: r.firstSeen === null || r.firstSeen === undefined ? null : ms(r.firstSeen) },
        settings, r.store === "play_store" && r.kind === "one_time" ? ytdBefore(r, at) : 0);
    },
  };
}
export type CommissionModel = Awaited<ReturnType<typeof commissionModel>>;

/** One rate without loading the project's whole Google Play history (webhook events): a sum for the year instead. */
export async function commissionRateFor(db: DB, projectId: string, r: RateInput): Promise<number> {
  const at = ms(r.at);
  const apps = r.appId ? await db.select({ id: schema.apps.id, type: schema.apps.type, credentials: schema.apps.credentials }).from(schema.apps).where(eq(schema.apps.id, r.appId)) : [];
  const settings = programsOfApps(apps);
  let ytd = 0;
  if (r.store === "play_store" && r.kind === "one_time" && r.appId) {
    const T = schema.transactions;
    const rows = await db.select({ usd: T.revenueUsd, kind: T.kind }).from(T).where(and(eq(T.projectId, projectId), eq(T.appId, r.appId), eq(T.store, "play_store"),
      eq(T.isSandbox, !!r.isSandbox), gte(T.purchasedAt, new Date(yearStart(at))), lt(T.purchasedAt, new Date(at))));
    for (const x of rows) if ((x.kind === "purchase" || x.kind === "renewal" || x.kind === "one_time") && x.usd > 0) ytd += x.usd;
  }
  return commissionRate({ store: r.store, appId: r.appId, at, kind: r.kind, country: r.country ?? null, firstSeen: r.firstSeen === null || r.firstSeen === undefined ? null : ms(r.firstSeen) }, settings, ytd);
}
