import { and, eq, gte, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { FunnelDoc } from "@revenuedot/core/funnels";
import { queueDeliveries } from "../events.js";

/**
 * Funnel events (prd/web-billing/PRD.md §5). Visitors' steps are stored in `funnel_events` for the funnel analytics.
 * FUNNEL_VIEWED, FUNNEL_STEP_COMPLETED and FUNNEL_PURCHASE also go to webhooks and integrations whose event filter names
 * them (they are opt-in, like SUBSCRIBER_ALIAS), so receivers that only know RevenueCat's types never see them.
 */

export const FUNNEL_EVENT_TYPES = ["funnel_viewed", "step_viewed", "step_completed", "checkout_started", "purchase"] as const;
export type FunnelEventType = (typeof FUNNEL_EVENT_TYPES)[number];
const DELIVERED: Partial<Record<FunnelEventType, string>> = { funnel_viewed: "FUNNEL_VIEWED", step_completed: "FUNNEL_STEP_COMPLETED", purchase: "FUNNEL_PURCHASE" };

export type FunnelRow = typeof schema.funnels.$inferSelect;

const CLICK_IDS = ["fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"];
const FUNNEL_TYPES = Object.values(DELIVERED);

/** Whether an enabled integration (not a webhook) of the project has a funnel event type in its filter. */
async function integrationsWantFunnels(db: DB, projectId: string): Promise<boolean> {
  const ints = await db.select({ t: schema.integrations.eventTypes }).from(schema.integrations).where(and(eq(schema.integrations.projectId, projectId), eq(schema.integrations.enabled, true)));
  return ints.some((i) => (i.t ?? []).some((t) => FUNNEL_TYPES.includes(t)));
}

/** Whether any enabled webhook or integration of the project asks for this type (the event row is only written then). */
async function wanted(db: DB, projectId: string, type: string): Promise<boolean> {
  const hooks = await db.select({ t: schema.webhooks.eventTypes }).from(schema.webhooks).where(and(eq(schema.webhooks.projectId, projectId), eq(schema.webhooks.enabled, true)));
  if (hooks.some((h) => (h.t ?? []).includes(type))) return true;
  const ints = await db.select({ t: schema.integrations.eventTypes }).from(schema.integrations).where(and(eq(schema.integrations.projectId, projectId), eq(schema.integrations.enabled, true)));
  return ints.some((i) => (i.t ?? []).includes(type));
}

export async function recordFunnelEvent(db: DB, o: {
  projectId: string; funnel: FunnelRow; sessionId: string; type: FunnelEventType; stepId?: string | null; stepIndex?: number | null; stepType?: string | null;
  appUserId?: string | null; answer?: unknown; query?: Record<string, string>; revenueUsd?: number | null; customerId?: string | null; sandbox?: boolean; now: Date;
  extra?: Record<string, unknown>;
  /** The visitor's browser (the page's own requests only): ad networks match web events with it (Batch D, prd/integrations/PRD.md). */
  client?: { ip?: string | null; userAgent?: string | null; pageUrl?: string | null };
}) {
  const utm: Record<string, string> = Object.fromEntries(Object.entries(o.query ?? {}).filter(([k, v]) => /^utm_[a-z_]{1,20}$/.test(k) && typeof v === "string").map(([k, v]) => [k, String(v).slice(0, 200)]));
  // Ad click ids from the landing URL, for Meta (fbclid → fbc), Google (gclid, gbraid, wbraid), TikTok and Microsoft.
  let clickIds: Record<string, string> = Object.fromEntries(Object.entries(o.query ?? {}).filter(([k, v]) => CLICK_IDS.includes(k) && typeof v === "string" && /^[\w.~-]{1,500}$/.test(v)).map(([k, v]) => [k, String(v)]));
  // The browser context is kept only when an integration asks for funnel events: no visitor IP is stored otherwise.
  const forAds = await integrationsWantFunnels(db, o.projectId);
  let client: Record<string, string> = {};
  if (forAds) {
    const pageUrl = o.client?.pageUrl && /^https?:\/\/[^\s?#]{1,300}$/.test(o.client.pageUrl) ? o.client.pageUrl : null;
    client = Object.fromEntries(Object.entries({ client_ip: o.client?.ip?.slice(0, 64) ?? null, client_user_agent: o.client?.userAgent?.slice(0, 500) ?? null, page_url: pageUrl })
      .filter((x): x is [string, string] => typeof x[1] === "string" && !!x[1]));
    // Checkouts and purchases are recorded by the server (Stripe's webhook): they inherit the session's landing context.
    if (o.type !== "funnel_viewed") {
      const [landing] = await db.select({ p: schema.funnelEvents.properties }).from(schema.funnelEvents)
        .where(and(eq(schema.funnelEvents.funnelId, o.funnel.id), eq(schema.funnelEvents.sessionId, o.sessionId.slice(0, 80)), eq(schema.funnelEvents.type, "funnel_viewed"))).limit(1);
      const lp = (landing?.p ?? {}) as Record<string, unknown>;
      if (!Object.keys(clickIds).length && lp.click_ids && typeof lp.click_ids === "object") clickIds = lp.click_ids as Record<string, string>;
      for (const k of ["client_ip", "client_user_agent", "page_url"]) if (!client[k] && typeof lp[k] === "string") client[k] = lp[k] as string;
      if (!Object.keys(utm).length) for (const [k, v] of Object.entries(lp)) if (/^utm_[a-z_]{1,20}$/.test(k) && typeof v === "string") utm[k] = v;
    }
  }
  const adContext: Record<string, unknown> = { ...(Object.keys(clickIds).length ? { click_ids: clickIds } : {}), ...client };
  const properties: Record<string, unknown> = { ...utm, ...adContext, ...(o.stepType ? { step_type: o.stepType } : {}), ...(o.answer !== undefined && o.answer !== null ? { answer: o.answer } : {}), ...(o.extra ?? {}) };
  await db.insert(schema.funnelEvents).values({
    id: crypto.randomUUID(), projectId: o.projectId, funnelId: o.funnel.id, sessionId: o.sessionId.slice(0, 80), type: o.type, stepId: o.stepId ?? null, stepIndex: o.stepIndex ?? null,
    appUserId: o.appUserId ?? null, properties, revenueUsd: o.revenueUsd ?? null, createdAt: o.now,
  });
  const delivered = DELIVERED[o.type];
  if (!delivered || !(await wanted(db, o.projectId, delivered))) return;
  const id = crypto.randomUUID().toUpperCase();
  const environment = o.sandbox ? "SANDBOX" : "PRODUCTION";
  const event: Record<string, unknown> = {
    id, type: delivered, event_timestamp_ms: o.now.getTime(), app_id: o.funnel.appId, app_user_id: o.appUserId ?? null, aliases: o.appUserId ? [o.appUserId] : [],
    environment, store: "STRIPE", funnel_id: o.funnel.id, funnel_name: o.funnel.name, funnel_slug: o.funnel.slug, session_id: o.sessionId,
    step_id: o.stepId ?? null, step_type: o.stepType ?? null, step_index: o.stepIndex ?? null, answer: o.answer ?? null, ...utm, ...adContext, ...(o.extra ?? {}), subscriber_attributes: {},
    ...(o.type === "purchase" && typeof o.revenueUsd === "number" ? { revenue_usd: o.revenueUsd, currency: "USD" } : {}),
  };
  await db.insert(schema.events).values({ id, projectId: o.projectId, customerId: o.customerId ?? null, type: delivered, environment: environment.toLowerCase(), appId: o.funnel.appId, payload: { api_version: "1.0", event }, eventTimestampMs: o.now.getTime(), createdAt: o.now });
  await queueDeliveries(db, o.projectId, id, delivered, environment.toLowerCase(), o.funnel.appId, o.now, event);
}

export interface FunnelAnalytics {
  object: "funnel_analytics"; funnel_id: string; days: number;
  views: number; checkouts: number; purchases: number; conversion: number; revenue_usd: number;
  steps: { id: string; type: string; title: string; viewed: number; completed: number; drop_off: number }[];
  daily: { date: string; views: number; purchases: number }[];
}

export async function funnelAnalytics(db: DB, f: FunnelRow, days: number, now: Date): Promise<FunnelAnalytics> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const where = and(eq(schema.funnelEvents.funnelId, f.id), gte(schema.funnelEvents.createdAt, since));
  const rows = await db.select({ type: schema.funnelEvents.type, step: schema.funnelEvents.stepId, n: sql<number>`count(distinct ${schema.funnelEvents.sessionId})::int`, total: sql<number>`count(*)::int`, revenue: sql<number>`coalesce(sum(${schema.funnelEvents.revenueUsd}), 0)::float8` })
    .from(schema.funnelEvents).where(where).groupBy(schema.funnelEvents.type, schema.funnelEvents.stepId);
  const daily = await db.select({ d: sql<string>`to_char(${schema.funnelEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, type: schema.funnelEvents.type, n: sql<number>`count(distinct ${schema.funnelEvents.sessionId})::int` })
    .from(schema.funnelEvents).where(and(where, sql`${schema.funnelEvents.type} in ('funnel_viewed', 'purchase')`)).groupBy(sql`1`, schema.funnelEvents.type);
  const count = (type: string, step: string | null = null) => rows.filter((r) => r.type === type && (step === null || r.step === step)).reduce((a, r) => a + r.n, 0);
  const views = count("funnel_viewed");
  const purchases = rows.filter((r) => r.type === "purchase").reduce((a, r) => a + r.total, 0);
  const revenue = rows.filter((r) => r.type === "purchase").reduce((a, r) => a + r.revenue, 0);
  const doc = (f.published ?? f.draft) as unknown as FunnelDoc;
  const steps = (doc.steps ?? []).map((s) => {
    // The success step is the page Stripe returns paying visitors to: every purchase saw it.
    const viewed = s.type === "success" ? Math.max(purchases, count("step_viewed", s.id)) : count("step_viewed", s.id);
    const completed = s.type === "success" ? purchases : count("step_completed", s.id);
    return { id: s.id, type: s.type, title: s.title, viewed, completed, drop_off: viewed ? Math.max(0, Math.round((1 - completed / viewed) * 1000) / 1000) : 0 };
  });
  const byDay = new Map<string, { views: number; purchases: number }>();
  for (let i = days - 1; i >= 0; i--) byDay.set(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10), { views: 0, purchases: 0 });
  for (const r of daily) { const d = byDay.get(r.d); if (d) { if (r.type === "funnel_viewed") d.views = r.n; else d.purchases = r.n; } }
  return {
    object: "funnel_analytics", funnel_id: f.id, days, views, checkouts: count("checkout_started"), purchases,
    conversion: views ? Math.round((purchases / views) * 10000) / 10000 : 0, revenue_usd: Math.round(revenue * 100) / 100, steps,
    daily: [...byDay].map(([date, v]) => ({ date, ...v })),
  };
}
