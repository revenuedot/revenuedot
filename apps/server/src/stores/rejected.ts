import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { Codes } from "../errors.js";
import { clientIp, hit } from "../services/rate-limit.js";

/**
 * Store notification requests that fail authentication: no or a bad signature, a sender the store cannot vouch for. They
 * are kept (rejected = true) so the app's settings show them as "rejected requests", but they never change the app's
 * notification status: only failures of authenticated notifications and our own processing errors do. Anyone who knows an
 * app id can send them, so each (app, IP) may log REJECTED_LIMIT of them per window; past that they are answered 429 and
 * not kept.
 */
export const REJECTED_LIMIT = 30;
export const REJECTED_WINDOW_MS = 10 * 60_000;

const { storeNotifications } = schema;

interface Target { id: string; projectId: string }
interface Rejection { store: string; raw: string; error: string; type?: string | null; subtype?: string | null }

/** Counts the request against the (app, IP) limit; true while it may still be logged. */
function withinLimit(deps: Deps, c: Context, app: Target): Promise<boolean> {
  return hit(deps.db, `ntf-rejected:${app.id}:${clientIp((h) => c.req.header(h), c.env)}`, REJECTED_LIMIT, REJECTED_WINDOW_MS, deps.now());
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
    body: r.raw.slice(0, 64_000), receivedAt: deps.now(), error: r.error, rejected: true,
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
