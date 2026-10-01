import { and, eq } from "drizzle-orm";
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

export function matches(i: Row, o: { type: string; environment: string; appId: string | null; event: Record<string, unknown> }) {
  if (i.environment !== "both" && i.environment !== o.environment) return false;
  if (i.appId && i.appId !== o.appId) return false;
  if (i.eventTypes && i.eventTypes.length && !i.eventTypes.includes(o.type)) return false;
  return sendsEvent(i.kind as IntegrationKind, o.event);
}
