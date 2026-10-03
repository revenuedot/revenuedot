import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

type AppRow = typeof schema.apps.$inferSelect;

/**
 * Whether an app's store notifications work. An app is Ready only once a notification was processed for a purchase we
 * know (or was the store's test notification): `apps.last_notification_at` moves only then. Notifications that fail
 * (another bundle id, an invalid token, our own error) keep their error and turn the status to failing until a later one
 * succeeds; notifications about purchases we do not track arrive without making the app Ready, like RevenueCat's "Last
 * received" (company research semantics.md, section 3.2).
 * Requests that fail authentication (unsigned, a bad signature: stores/rejected.ts) never count here: anyone who knows the
 * app id can send them. They are reported apart, as the rejected requests of the last 24 hours.
 *   notification_status: "ready" | "failing" | "received" | "waiting"
 */
export async function notificationHealth(db: DB, app: AppRow, now: Date) {
  const N = schema.storeNotifications;
  const real = and(eq(N.appId, app.id), eq(N.rejected, false));
  const [newest] = await db.select({ at: N.receivedAt, error: N.error, type: N.type }).from(N).where(real).orderBy(desc(N.receivedAt)).limit(1);
  const [failed] = await db.select({ at: N.receivedAt, error: N.error, type: N.type }).from(N)
    .where(and(real, isNotNull(N.error))).orderBy(desc(N.receivedAt)).limit(1);
  const [rejected] = await db.select({ n: count() }).from(N)
    .where(and(eq(N.appId, app.id), eq(N.rejected, true), gte(N.receivedAt, new Date(now.getTime() - 86400_000))));
  const [lastRejected] = rejected?.n ? await db.select({ at: N.receivedAt, error: N.error }).from(N)
    .where(and(eq(N.appId, app.id), eq(N.rejected, true))).orderBy(desc(N.receivedAt)).limit(1) : [];
  const ok = app.lastNotificationAt;
  const failing = !!newest?.error && (!ok || newest.at >= ok);
  return {
    last_notification_at: ok ? ok.getTime() : null,
    last_notification_received_at: newest ? newest.at.getTime() : null,
    last_notification_error: failed ? { at: failed.at.getTime(), type: failed.type ?? null, message: failed.error! } : null,
    notification_status: failing ? "failing" : ok ? "ready" : newest ? "received" : "waiting",
    /** Unauthenticated requests of the last 24 hours; they never change notification_status. */
    rejected_requests: {
      last_24h: Number(rejected?.n ?? 0),
      last: lastRejected ? { at: lastRejected.at.getTime(), message: lastRejected.error ?? "" } : null,
    },
  };
}
