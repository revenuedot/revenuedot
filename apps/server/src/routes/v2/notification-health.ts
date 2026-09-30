import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

type AppRow = typeof schema.apps.$inferSelect;

/**
 * Whether an app's store notifications work. An app is Ready only once a notification was processed for a purchase we
 * know (or was the store's test notification): `apps.last_notification_at` moves only then. Notifications that fail
 * (bad signature, another bundle id, an invalid token, our own error) keep their error and turn the status to failing
 * until a later one succeeds; notifications about purchases we do not track arrive without making the app Ready,
 * like RevenueCat's "Last received" (company research semantics.md, section 3.2).
 *   notification_status: "ready" | "failing" | "received" | "waiting"
 */
export async function notificationHealth(db: DB, app: AppRow) {
  const N = schema.storeNotifications;
  const [newest] = await db.select({ at: N.receivedAt, error: N.error, type: N.type }).from(N).where(eq(N.appId, app.id)).orderBy(desc(N.receivedAt)).limit(1);
  const [failed] = await db.select({ at: N.receivedAt, error: N.error, type: N.type }).from(N)
    .where(and(eq(N.appId, app.id), isNotNull(N.error))).orderBy(desc(N.receivedAt)).limit(1);
  const ok = app.lastNotificationAt;
  const failing = !!newest?.error && (!ok || newest.at >= ok);
  return {
    last_notification_at: ok ? ok.getTime() : null,
    last_notification_received_at: newest ? newest.at.getTime() : null,
    last_notification_error: failed ? { at: failed.at.getTime(), type: failed.type ?? null, message: failed.error! } : null,
    notification_status: failing ? "failing" : ok ? "ready" : newest ? "received" : "waiting",
  };
}
