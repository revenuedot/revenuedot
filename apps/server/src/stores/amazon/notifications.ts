import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { Codes, RCError } from "../../errors.js";
import { recordCredentialFailure } from "../../services/credential-health.js";
import { forwardStoreNotification } from "../forward.js";
import { AmazonApiError } from "./api.js";
import { amazonClientFor } from "./index.js";
import { isSnsHost, parseSns, SnsError, verifySns } from "./sns.js";
import { syncAmazonNotification, type AmazonNotification } from "./sync.js";

const { apps, storeNotifications } = schema;

/**
 * Amazon Appstore Real-time Notifications: POST /v1/notifications/amazon/{appId}, an HTTPS subscription to Amazon's SNS
 * topic. Every SNS message must carry a valid SNS signature (sns.ts). The subscription confirmation is accepted by
 * fetching its SubscribeURL (Amazon's console then shows "Verified"). SNS retries anything but 2xx, so we answer 2xx once a
 * message is handled or can never be handled, and 5xx for temporary failures.
 */
export function amazonNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/:appId", async (c) => {
    const now = deps.now();
    const [app] = await deps.db.select().from(apps).where(eq(apps.id, c.req.param("appId"))).limit(1);
    if (!app || app.type !== "amazon") return c.json({ code: Codes.NOT_FOUND, message: "No Amazon Appstore app with this id." }, 404);
    const { client } = amazonClientFor(deps.stores, deps.fetch);
    const fetchFn = deps.fetch ?? client.fetchImpl;
    const creds = (app.credentials ?? {}) as Record<string, unknown>;

    const raw = await c.req.text();
    const m = parseSns(raw);
    if (!m) return c.json({ code: Codes.BAD_REQUEST, message: "Expected an Amazon SNS message." }, 400);

    let n: AmazonNotification | null = null;
    if (m.Type === "Notification") { try { n = JSON.parse(m.Message); } catch { n = null; } }
    const type = m.Type === "Notification" ? (n?.notificationType ?? "UNKNOWN") : m.Type === "SubscriptionConfirmation" ? "SUBSCRIPTION_CONFIRMATION" : m.Type === "UnsubscribeConfirmation" ? "UNSUBSCRIBE_CONFIRMATION" : m.Type;
    const id = `amz_${app.id}_${m.MessageId}`;
    const inserted = await deps.db.insert(storeNotifications).values({
      id, projectId: app.projectId, appId: app.id, store: "amazon", type, subtype: n?.receiptId ? n.receiptId.slice(0, 120) : null, body: raw, receivedAt: now,
    }).onConflictDoNothing().returning({ id: storeNotifications.id });
    if (!inserted.length) {
      const [prev] = await deps.db.select({ processedAt: storeNotifications.processedAt }).from(storeNotifications).where(eq(storeNotifications.id, id));
      if (prev?.processedAt) return c.json({ status: "duplicate" });
    }
    if (inserted.length && app.notificationForwardUrl) {
      forwardStoreNotification(c, { db: deps.db, fetchFn, url: app.notificationForwardUrl, notificationId: id, raw, headers: { "content-type": "text/plain; charset=UTF-8", "x-amz-sns-message-type": m.Type } });
    }
    const finish = (set: Partial<typeof storeNotifications.$inferInsert>) => deps.db.update(storeNotifications).set(set).where(eq(storeNotifications.id, id));

    try {
      await verifySns(m, fetchFn, now);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof SnsError && e.transient) {
        await finish({ error: msg });
        return c.json({ code: Codes.STORE_PROBLEM, message: "Could not load the SNS signing certificate; SNS will retry." }, 503);
      }
      await finish({ error: `rejected: ${msg}` });
      return c.json({ code: Codes.BAD_REQUEST, message: msg }, 400);
    }
    const pinned = typeof creds.sns_topic_arn === "string" && creds.sns_topic_arn.trim() ? creds.sns_topic_arn.trim() : null;
    if (pinned && m.TopicArn !== pinned) {
      await finish({ error: `rejected: topic ${m.TopicArn} is not the app's SNS topic` });
      return c.json({ code: Codes.BAD_REQUEST, message: "This SNS topic is not the one configured for the app." }, 400);
    }

    if (m.Type === "SubscriptionConfirmation") {
      if (!m.SubscribeURL || !isSnsHost(m.SubscribeURL)) {
        await finish({ error: "rejected: SubscribeURL is not an Amazon SNS URL" });
        return c.json({ code: Codes.BAD_REQUEST, message: "SubscribeURL is not an Amazon SNS URL." }, 400);
      }
      try {
        const res = await fetchFn(m.SubscribeURL, { method: "GET", signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`SNS answered ${res.status}`);
      } catch (e) {
        await finish({ error: `confirming the SNS subscription failed: ${e instanceof Error ? e.message : e}` });
        return c.json({ code: Codes.STORE_PROBLEM, message: "Confirming the subscription failed; SNS will retry." }, 503);
      }
      await finish({ processedAt: now, error: null });
      // Amazon's endpoint check: the app now receives notifications (the console shows "Verified").
      await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
      return c.json({ status: "confirmed" });
    }
    if (m.Type !== "Notification") {
      await finish({ processedAt: now, error: null });
      return c.json({ status: "ignored" });
    }
    if (!n || typeof n !== "object") {
      await finish({ processedAt: now, error: "Message is not an Amazon Real-time Notification" });
      return c.json({ status: "ignored" });
    }
    if (n.appPackageName && app.bundleId && n.appPackageName !== app.bundleId) {
      await finish({ processedAt: now, error: `package ${n.appPackageName} does not match the app's ${app.bundleId}` });
      return c.json({ status: "ignored" });
    }

    const eventTime = typeof n.timestamp === "number" ? new Date(n.timestamp) : now;
    try {
      const result = await syncAmazonNotification({ db: deps.db, app, client, now, eventTime: Number.isNaN(eventTime.getTime()) ? now : eventTime }, n);
      await finish({ processedAt: now, error: null, environment: result.sandbox === undefined ? null : result.sandbox ? "sandbox" : "production" });
      if (result.status === "processed") await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
      deps.kick?.();
      return c.json({ status: result.status });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof AmazonApiError && e.kind === "invalid_receipt") {
        await finish({ processedAt: now, error: `invalid receipt: ${message}` });
        return c.json({ status: "invalid_receipt" });
      }
      if (e instanceof RCError && e.status < 500) {
        await finish({ processedAt: now, error: message });
        return c.json({ status: "ignored" });
      }
      if (e instanceof AmazonApiError && e.kind === "credentials") await recordCredentialFailure(deps.db, app.id, e.message, now).catch(() => {});
      console.error(`Amazon notification ${id} failed:`, e);
      await finish({ error: message });
      return c.json({ code: Codes.STORE_PROBLEM, message: "Temporary failure; SNS will retry." }, 500);
    }
  });
  return r;
}
