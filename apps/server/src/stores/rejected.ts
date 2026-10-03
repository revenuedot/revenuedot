import type { Context } from "hono";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { Codes } from "../errors.js";
import { clientIp, hit } from "../services/rate-limit.js";

/**
 * Store notification requests that fail authentication: no or a bad signature, a sender the store cannot vouch for. They
 * are kept (rejected = true) so the app's settings show them as "rejected requests", but they never change the app's
 * notification status: only failures of authenticated notifications and our own processing errors do. Anyone who knows an
 * app id can send them, so each (app, IP) may log REJECTED_LIMIT of them per window, and each app REJECTED_APP_LIMIT;
 * past that they are not kept (and answered 429 where the store would not retry forever). The tick deletes rejected rows
 * after REJECTED_KEEP_MS.
 */
export const REJECTED_LIMIT = 30;
export const REJECTED_APP_LIMIT = 300;
export const REJECTED_WINDOW_MS = 10 * 60_000;
export const REJECTED_KEEP_MS = 7 * 86_400_000;

const { storeNotifications } = schema;

interface Target { id: string; projectId: string }
interface Rejection { store: string; raw: string; error: string; type?: string | null; subtype?: string | null }

/** An IPv6 address counts by its /64 (one subscriber's block); IPv4 by the address. */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Counts the request against the (app, IP) and the app's limits; true while it may still be logged. */
async function withinLimit(deps: Deps, c: Context, app: Target): Promise<boolean> {
  const now = deps.now();
  const ip = ipBucket(clientIp((h) => c.req.header(h), c.env));
  if (!(await hit(deps.db, `ntf-rejected:${app.id}:${ip}`, REJECTED_LIMIT, REJECTED_WINDOW_MS, now))) return false;
  return hit(deps.db, `ntf-rejected:${app.id}`, REJECTED_APP_LIMIT, REJECTED_WINDOW_MS, now);
}

/** A random id of its own, so a rejected body can never take the id a real notification will have. */
const rejectedId = (store: string, appId: string) => `${store}_${appId}_rejected_${crypto.randomUUID()}`;

/**
 * Logs one rejected request (unless the (app, IP) is over its limit) and returns its id. Returns null when it was over the
 * limit: the caller answers 429 instead of its usual 4xx.
 */
export async function logRejected(deps: Deps, c: Context, app: Target, r: Rejection): Promise<string | null> {
  if (!(await withinLimit(deps, c, app))) return null;
  const id = rejectedId(r.store, app.id);
  await deps.db.insert(storeNotifications).values({
    id, projectId: app.projectId, appId: app.id, store: r.store, type: r.type ?? null, subtype: r.subtype ?? null,
    body: r.raw.slice(0, 64_000), receivedAt: deps.now(), processedAt: deps.now(), error: r.error, rejected: true,
  });
  return id;
}

/** The answer for a request that was not logged because its (app, IP) is over the limit. */
export const tooManyRejected = (c: Context) => c.json({ code: Codes.BAD_REQUEST, message: "Too many rejected notifications from this address. Try again later." }, 429);

/**
 * A notification that was stored before its sender could be trusted (a store with no authentication set up: Google Play
 * without Pub/Sub push authentication, Galaxy Store without the IAP public key) and that turned out not to be one the
 * store vouches for (an invalid purchase token, another package): it becomes a rejected request under an id of its own, so
 * the id it claimed stays free for the real message. Over the (app, IP) limit it is dropped.
 */
export async function demoteToRejected(deps: Deps, c: Context, app: Target, store: string, id: string, error: string): Promise<void> {
  const N = storeNotifications;
  if (!(await withinLimit(deps, c, app))) { await deps.db.delete(N).where(eq(N.id, id)); return; }
  await deps.db.update(N).set({ id: rejectedId(store, app.id), rejected: true, error, processedAt: deps.now() }).where(eq(N.id, id));
}

/**
 * Marks as rejected the stored rows of requests that failed authentication before rejected requests existed (migration
 * 0033 runs the same statement over every project; archive imports of older archives run it for the imported project).
 */
export async function backfillRejected(db: Deps["db"], projectId: string) {
  await db.execute(sql`UPDATE store_notifications n SET rejected = true FROM apps a
    WHERE n.app_id = a.id AND n.project_id = ${projectId} AND n.rejected = false AND n.error IS NOT NULL AND (${REJECTED_BACKFILL_WHERE})`);
}

/** Which old errors were unauthenticated requests (keep in sync with migrations/0033_rejected_notifications.sql). */
const REJECTED_BACKFILL_WHERE = sql.raw(`n.error LIKE 'rejected:%'
  OR (n.store IN ('app_store', 'mac_app_store') AND (n.error LIKE 'The signed payload is not valid:%' OR n.error IN ('The body is not JSON.', 'signedPayload is missing.', 'The signed payload is not an App Store notification.')
    OR n.error LIKE 'The notification is for bundle id %' OR n.error LIKE 'The notification is for Apple app id %'))
  OR (n.store = 'play_store' AND (coalesce(a.credentials->>'pubsub_audience', '') = '' OR coalesce(a.credentials->>'pubsub_service_account', '') = '')
    AND (n.error LIKE 'invalid purchase token:%' OR n.error LIKE 'package % does not match the app''s %' OR n.error = 'message.data is not a base64 JSON developer notification'))
  OR (n.store = 'galaxy' AND coalesce(a.credentials->>'galaxy_iap_public_key', '') = '' AND n.error LIKE 'Galaxy Store:%')`);

/** Deletes rejected requests older than REJECTED_KEEP_MS. */
export async function pruneRejected(db: Deps["db"], now: Date) {
  const N = storeNotifications;
  await db.delete(N).where(sql`${N.rejected} AND ${N.receivedAt} < ${new Date(now.getTime() - REJECTED_KEEP_MS).toISOString()}::timestamptz`);
}
