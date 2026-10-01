import { eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

/** Forwards still in flight (tests await them; Workers hand them to waitUntil). */
const inflight = new Set<Promise<void>>();
export async function flushStoreForwards() { await Promise.all([...inflight]); }

export const STORE_FORWARD_TIMEOUT_MS = 10_000;

/**
 * Fire-and-forget copy of a store notification's raw body to the app's forward URL (a dual run with RevenueCat).
 * The answer's status is recorded on the stored notification (0 = no answer).
 */
export function forwardStoreNotification(c: { executionCtx?: unknown }, o: {
  db: DB; fetchFn: (url: string, init?: RequestInit) => Promise<Response>; url: string; notificationId: string; raw: string; headers?: Record<string, string>;
}) {
  const p = (async () => {
    let status = 0;
    try {
      const res = await o.fetchFn(o.url, { method: "POST", headers: { "content-type": "application/json", ...o.headers }, body: o.raw, signal: AbortSignal.timeout(STORE_FORWARD_TIMEOUT_MS) });
      status = res.status;
    } catch { status = 0; }
    await o.db.update(schema.storeNotifications).set({ forwardStatus: status }).where(eq(schema.storeNotifications.id, o.notificationId));
  })().catch((e) => console.error("Store notification forward failed:", e)).finally(() => inflight.delete(p));
  inflight.add(p);
  try { (c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined)?.waitUntil?.(p); } catch { /* Node has no execution context */ }
}
