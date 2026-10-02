import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { Codes, RCError } from "../../errors.js";
import { recordCredentialFailure } from "../../services/credential-health.js";
import { withStoreSecrets } from "../../services/store-secrets.js";
import { forwardStoreNotification } from "../forward.js";
import { RokuApiError } from "./api.js";
import { rokuClientFor } from "./index.js";
import { RokuPushError, verifyRokuPush } from "./push.js";
import { handleRokuPush } from "./sync.js";

const { apps, storeNotifications } = schema;

const channelOf = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "");

/**
 * Roku Pay push notifications: POST /v1/notifications/roku/{appId}, the "push notification URL" of the developer's Roku
 * account. Each push is a JWS signed by Roku (stores/roku/push.ts). Roku has one URL per developer account, so a push for
 * another channel goes to the project's Roku app with that `roku_channel_id`. Answers 200 with the push's `responseKey`
 * once handled; Roku retries failures for 36 hours.
 */
export function rokuNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/:appId", async (c) => {
    const now = deps.now();
    const [row] = await deps.db.select().from(apps).where(eq(apps.id, c.req.param("appId"))).limit(1);
    if (!row || row.type !== "roku") return c.json({ code: Codes.NOT_FOUND, message: "No Roku app with this id." }, 404);
    const { client } = rokuClientFor(deps.stores, deps.fetch);
    const raw = await c.req.text();
    const reject = async (error: string, message: string) => {
      await deps.db.insert(storeNotifications).values({
        id: `roku_${row.id}_rejected_${crypto.randomUUID()}`, projectId: row.projectId, appId: row.id, store: "roku", type: null, subtype: null, body: raw.slice(0, 64_000), receivedAt: now, error,
      });
      return c.json({ code: Codes.BAD_REQUEST, message }, 400);
    };
    let push;
    // Roku's key set through the Roku client's own fetch (the same one that validates transactions).
    try { push = await verifyRokuPush(raw, client.fetchImpl, now); } catch (e) {
      const message = e instanceof RokuPushError ? e.message : String(e);
      return reject(`rejected: ${message}`, message);
    }
    const m = push.message;
    // The channel the push is about: this app's, or another Roku app of the project with that channel id.
    let target = row;
    const channel = channelOf(m.channelId);
    const own = channelOf((row.credentials ?? {}).roku_channel_id);
    if (channel && own && channel !== own) {
      const all = await deps.db.select().from(apps).where(and(eq(apps.projectId, row.projectId), eq(apps.type, "roku")));
      target = all.find((a) => channelOf((a.credentials ?? {}).roku_channel_id) === channel) ?? row;
    }
    const environment = push.test ? "sandbox" : "production";
    const id = `roku_${target.id}_${push.messageKey}`.slice(0, 500);
    const inserted = await deps.db.insert(storeNotifications).values({
      id, projectId: target.projectId, appId: target.id, store: "roku", type: m.transactionType, subtype: m.transactionId.slice(0, 200), body: raw, receivedAt: now, environment,
    }).onConflictDoNothing().returning({ id: storeNotifications.id });
    const ack = () => c.text(m.responseKey ?? "", 200);
    if (!inserted.length) {
      const [prev] = await deps.db.select({ processedAt: storeNotifications.processedAt }).from(storeNotifications).where(eq(storeNotifications.id, id));
      if (prev?.processedAt) return ack();
    }
    if (inserted.length && target.notificationForwardUrl) {
      forwardStoreNotification(c, { db: deps.db, fetchFn: deps.fetch ?? client.fetchImpl, url: target.notificationForwardUrl, notificationId: id, raw, strict: deps.edition === "cloud", headers: { "content-type": "text/plain" } });
    }
    const finish = (set: Partial<typeof storeNotifications.$inferInsert>) => deps.db.update(storeNotifications).set(set).where(eq(storeNotifications.id, id));
    if (channel && own && channel !== own && target.id === row.id) {
      await finish({ processedAt: now, error: null });
      return ack();
    }
    let app: typeof target;
    try { app = await withStoreSecrets(deps, target); } catch (e) {
      await finish({ error: e instanceof Error ? e.message : String(e) });
      return c.json({ code: Codes.STORE_PROBLEM, message: "The app's Roku credentials could not be opened; Roku will retry." }, 500);
    }
    try {
      const result = await handleRokuPush({ db: deps.db, app, client, now }, m);
      await finish({ processedAt: now, error: null });
      if (result.status === "processed") await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
      deps.kick?.();
      return ack();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof RokuApiError && e.kind === "invalid") {
        await finish({ processedAt: now, error: `Roku: ${message}` });
        return ack();
      }
      if (e instanceof RCError && e.status < 500) {
        await finish({ processedAt: now, error: message });
        return ack();
      }
      if (e instanceof RokuApiError && e.kind === "credentials") await recordCredentialFailure(deps.db, app.id, e.message, now).catch(() => {});
      console.error(`Roku push ${id} failed: ${message}`);
      await finish({ error: message });
      return c.json({ code: Codes.STORE_PROBLEM, message: "Temporary failure; Roku will retry." }, 500);
    }
  });
  return r;
}
