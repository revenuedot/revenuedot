import { and, eq } from "drizzle-orm";
import { OPT_IN_EVENT_TYPES, PAYWALL_WEBHOOK_TYPES } from "@revenuedot/core";
import { sendsEvent, type IntegrationKind } from "@revenuedot/core/integrations";
import { schema, type DB } from "@revenuedot/db";

/**
 * Fan-out: every event that webhooks get is also queued to each enabled integration of the project whose filters
 * match (environment, app, event types) and that sends this kind of event at all. Delivery runs in the same
 * every-minute tick as webhooks (services/integrations/deliver.ts).
 */
export async function queueIntegrationDeliveries(db: DB, o: {
  projectId: string; eventId: string; type: string; environment: string; appId: string | null; event: Record<string, unknown>; now: Date;
}) {
  const rows = await db.select().from(schema.integrations).where(and(eq(schema.integrations.projectId, o.projectId), eq(schema.integrations.enabled, true)));
  for (const i of rows) {
    if (!matches(i, o)) continue;
    await db.insert(schema.integrationDeliveries).values({ id: crypto.randomUUID(), integrationId: i.id, eventId: o.eventId, nextAttemptAt: o.now, createdAt: o.now }).onConflictDoNothing();
  }
}

type Row = typeof schema.integrations.$inferSelect;

const PAYWALL_TYPES: ReadonlySet<string> = new Set(PAYWALL_WEBHOOK_TYPES);

/**
 * An integration's event filter: opt-in types are sent only when named. Paywall types named in it add to the other
 * events instead of narrowing the filter, so ticking "Send paywall events" keeps every purchase event flowing. Every
 * other type (funnel and alias types included) narrows it as before: a funnel-only filter still means funnel events only.
 */
export function matches(i: Row, o: { type: string; environment: string; appId: string | null; event: Record<string, unknown> }) {
  if (i.environment !== "both" && i.environment !== o.environment) return false;
  if (i.appId && i.appId !== o.appId) return false;
  const filter = i.eventTypes ?? [];
  if (OPT_IN_EVENT_TYPES.has(o.type)) { if (!filter.includes(o.type)) return false; }
  else {
    const regular = filter.filter((t) => !PAYWALL_TYPES.has(t));
    if (regular.length && !regular.includes(o.type)) return false;
  }
  return sendsEvent(i.kind as IntegrationKind, o.event);
}
