import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { Codes, RCError } from "../../errors.js";
import { recordCredentialFailure } from "../../services/credential-health.js";
import { withStoreSecrets } from "../../services/store-secrets.js";
import { forwardStoreNotification } from "../forward.js";
import { PaddleApiError, paddleEnvOf, type PaddleEvent } from "./api.js";
import { paddleClientFor } from "./index.js";
import { PaddleSignatureError, verifyPaddleSignature } from "./signature.js";
import { handlePaddleEvent } from "./sync.js";

const { apps, storeNotifications } = schema;

/**
 * Paddle Billing webhooks: POST /v1/notifications/paddle/{appId}, a notification destination in the developer's Paddle
 * account. Every event must carry a valid Paddle-Signature for the destination's secret key. Paddle counts only HTTP 200 as
 * delivered and retries anything else (3 times in sandbox, 60 times over 3 days live), so handled, duplicate and ignored
 * events answer 200 and only temporary failures 500.
 */
export function paddleNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/:appId", async (c) => {
    const now = deps.now();
    const [row] = await deps.db.select().from(apps).where(eq(apps.id, c.req.param("appId"))).limit(1);
    if (!row || row.type !== "paddle") return c.json({ code: Codes.NOT_FOUND, message: "No Paddle app with this id." }, 404);
    let app: typeof row;
    try { app = await withStoreSecrets(deps, row); } catch (e) {
      console.error(`Paddle event for ${row.id}: ${e instanceof Error ? e.message : e}`);
      return c.json({ code: Codes.STORE_PROBLEM, message: "The app's Paddle credentials could not be opened; Paddle will retry." }, 500);
    }
    const { client } = paddleClientFor(deps.stores, deps.fetch);
    const creds = (app.credentials ?? {}) as Record<string, unknown>;
    const raw = await c.req.text();
    let event: PaddleEvent | null = null;
    try { const j = JSON.parse(raw); if (j && typeof j === "object" && typeof j.event_id === "string" && typeof j.event_type === "string") event = j; } catch { /* below */ }
    const objectId = typeof event?.data?.id === "string" ? event.data.id : null;
    const signature = c.req.header("paddle-signature");
    // A body that fails the checks is kept (the app's notification status shows why) under an id of its own, so an
    // unsigned body can never take a real event's id, and it is never forwarded.
    const reject = async (error: string, message: string) => {
      await deps.db.insert(storeNotifications).values({
        id: `paddle_${app.id}_rejected_${crypto.randomUUID()}`, projectId: app.projectId, appId: app.id, store: "paddle", type: event?.event_type ?? null, subtype: objectId, body: raw.slice(0, 64_000), receivedAt: now, error,
      });
      return c.json({ code: Codes.BAD_REQUEST, message }, 400);
    };

    const secret = typeof creds.paddle_webhook_secret === "string" ? creds.paddle_webhook_secret.trim() : "";
    if (!secret) return reject("rejected: no notification secret key is saved for this app", "Save the notification destination's secret key (pdl_ntfset_…) in the app's settings, or use Apply in Paddle.");
    try {
      await verifyPaddleSignature(raw, signature, secret, now);
    } catch (e) {
      const message = e instanceof PaddleSignatureError ? e.message : String(e);
      return reject(`rejected: ${message}`, message);
    }
    if (!event) return reject("The body is not a Paddle event.", "The body is not a Paddle event.");
    const environment = paddleEnvOf(app) === "sandbox" ? "sandbox" : "production";

    const id = `paddle_${app.id}_${event.event_id}`;
    const inserted = await deps.db.insert(storeNotifications).values({
      id, projectId: app.projectId, appId: app.id, store: "paddle", type: event.event_type, subtype: objectId, body: raw, receivedAt: now, environment,
    }).onConflictDoNothing().returning({ id: storeNotifications.id });
    if (!inserted.length) {
      const [prev] = await deps.db.select({ processedAt: storeNotifications.processedAt }).from(storeNotifications).where(eq(storeNotifications.id, id));
      if (prev?.processedAt) return c.json({ status: "duplicate" }, 200);
    }
    if (inserted.length && app.notificationForwardUrl) {
      forwardStoreNotification(c, { db: deps.db, fetchFn: deps.fetch ?? client.fetchImpl, url: app.notificationForwardUrl, notificationId: id, raw, strict: deps.edition === "cloud", headers: signature ? { "paddle-signature": signature } : {} });
    }
    const finish = (set: Partial<typeof storeNotifications.$inferInsert>) => deps.db.update(storeNotifications).set(set).where(eq(storeNotifications.id, id));

    // Simulated events (Paddle's "Simulate" tool) prove the URL and the secret work but name no real purchase; RevenueCat
    // ignores them too. They still count as received.
    if (event.event_id.startsWith("ntfsimevt_") || !event.notification_id) {
      await finish({ processedAt: now, error: null });
      await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
      return c.json({ status: "simulated" }, 200);
    }

    const eventTime = new Date(event.occurred_at);
    try {
      const result = await handlePaddleEvent({ db: deps.db, app, client, now, eventTime: Number.isNaN(eventTime.getTime()) ? now : eventTime }, event);
      await finish({ processedAt: now, error: null });
      if (result.status === "processed") await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
      deps.kick?.();
      return c.json({ status: result.status }, 200);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof PaddleApiError && (e.kind === "not_found" || e.kind === "invalid")) {
        await finish({ processedAt: now, error: `Paddle: ${message}` });
        return c.json({ status: "invalid" }, 200);
      }
      if (e instanceof RCError && e.status < 500) {
        await finish({ processedAt: now, error: message });
        return c.json({ status: "ignored" }, 200);
      }
      if (e instanceof PaddleApiError && e.kind === "credentials") await recordCredentialFailure(deps.db, app.id, e.message, now).catch(() => {});
      console.error(`Paddle event ${id} failed:`, e);
      await finish({ error: message });
      return c.json({ code: Codes.STORE_PROBLEM, message: "Temporary failure; Paddle will retry." }, 500);
    }
  });
  return r;
}
