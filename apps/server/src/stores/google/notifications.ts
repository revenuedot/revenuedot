import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { schema } from "@revenuedot/db";
import type { AppRecord, Deps } from "../../context.js";
import { Codes, RCError } from "../../errors.js";
import { GoogleApiError, type GooglePlayClient } from "./api.js";
import { googleClientFor } from "./index.js";
import { applyVoided, syncOneTime, syncSubscription, type SyncCtx, type SyncResult } from "./sync.js";
import { demoteToRejected, logRejected } from "../rejected.js";
import { withStoreSecretsOrNone } from "../../services/store-secrets.js";

const { apps, storeNotifications } = schema;

/** Google Play real-time developer notification (the base64 JSON inside a Pub/Sub message). */
export interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: { version?: string; notificationType: number; purchaseToken: string; subscriptionId?: string };
  oneTimeProductNotification?: { version?: string; notificationType: number; purchaseToken: string; sku: string };
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string; productType?: number; refundType?: number };
  testNotification?: { version?: string };
}

export const SUBSCRIPTION_NOTIFICATION_TYPES: Record<number, string> = {
  1: "SUBSCRIPTION_RECOVERED", 2: "SUBSCRIPTION_RENEWED", 3: "SUBSCRIPTION_CANCELED", 4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD", 6: "SUBSCRIPTION_IN_GRACE_PERIOD", 7: "SUBSCRIPTION_RESTARTED", 8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9: "SUBSCRIPTION_DEFERRED", 10: "SUBSCRIPTION_PAUSED", 11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED", 12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED", 17: "SUBSCRIPTION_ITEMS_CHANGED", 18: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  19: "SUBSCRIPTION_PRICE_CHANGE_UPDATED", 20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED", 22: "SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED",
};
const ONE_TIME_TYPES: Record<number, string> = { 1: "ONE_TIME_PRODUCT_PURCHASED", 2: "ONE_TIME_PRODUCT_CANCELED" };

function typeOf(n: DeveloperNotification | null): { type: string | null; subtype: string | null } {
  if (!n) return { type: null, subtype: null };
  if (n.testNotification) return { type: "TEST", subtype: null };
  if (n.subscriptionNotification) {
    const t = n.subscriptionNotification.notificationType;
    return { type: SUBSCRIPTION_NOTIFICATION_TYPES[t] ?? `SUBSCRIPTION_${t}`, subtype: n.subscriptionNotification.subscriptionId ?? null };
  }
  if (n.oneTimeProductNotification) {
    const t = n.oneTimeProductNotification.notificationType;
    return { type: ONE_TIME_TYPES[t] ?? `ONE_TIME_PRODUCT_${t}`, subtype: n.oneTimeProductNotification.sku ?? null };
  }
  if (n.voidedPurchaseNotification) return { type: "VOIDED_PURCHASE", subtype: n.voidedPurchaseNotification.productType === 2 ? "one_time" : "subscription" };
  return { type: "UNKNOWN", subtype: null };
}

function decodeData(data: unknown): DeveloperNotification | null {
  if (typeof data !== "string" || !data) return null;
  try {
    const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    return json && typeof json === "object" ? json as DeveloperNotification : null;
  } catch {
    return null;
  }
}

/** A short hash of the message data: Pub/Sub redelivers the same data under the same message id. */
async function dataHash(data: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof data === "string" ? data : ""));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Forwards still in flight (tests await them; Workers hand them to waitUntil). */
const inflight = new Set<Promise<void>>();
export async function flushGoogleForwards() { await Promise.all([...inflight]); }

const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const jwksCache = new WeakMap<GooglePlayClient, { at: number; jwks: ReturnType<typeof createLocalJWKSet> }>();

/**
 * Pub/Sub push authentication: when `credentials.pubsub_audience` is set, the push must carry a Google-signed OIDC token
 * for that audience (and, when `credentials.pubsub_service_account` is set, for that service account).
 */
async function verifyPushToken(client: GooglePlayClient, header: string | undefined, creds: Record<string, unknown>): Promise<boolean> {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const load = async (force: boolean) => {
    const c = jwksCache.get(client);
    if (c && !force && Date.now() - c.at < 3_600_000) return c.jwks;
    const res = await client.http(GOOGLE_CERTS);
    if (!res.ok) throw new GoogleApiError("transient", `Google certs answered ${res.status}`, res.status);
    const jwks = createLocalJWKSet(await res.json());
    jwksCache.set(client, { at: Date.now(), jwks });
    return jwks;
  };
  for (const force of [false, true]) {
    try {
      const { payload } = await jwtVerify(token, await load(force), {
        issuer: ["https://accounts.google.com", "accounts.google.com"], audience: String(creds.pubsub_audience),
      });
      const email = creds.pubsub_service_account;
      if (typeof email === "string" && email && (payload.email !== email || payload.email_verified !== true)) return false;
      return true;
    } catch (e) {
      if (e instanceof GoogleApiError) throw e;
      if ((e as { code?: string })?.code !== "ERR_JWKS_NO_MATCHING_KEY") return false;
    }
  }
  return false;
}

async function handle(ctx: SyncCtx, n: DeveloperNotification): Promise<SyncResult & { test?: boolean }> {
  if (n.testNotification) return { status: "processed", test: true };
  const s = n.subscriptionNotification;
  if (s) {
    if (!s.purchaseToken || s.notificationType === 20) return { status: "ignored" };
    if (s.notificationType === 12) return syncSubscription(ctx, s.purchaseToken, { refundAt: ctx.eventTime < ctx.now ? ctx.eventTime : ctx.now });
    if (s.notificationType === 11) return syncSubscription(ctx, s.purchaseToken, { pauseScheduleFor: s.subscriptionId ?? null });
    return syncSubscription(ctx, s.purchaseToken);
  }
  const o = n.oneTimeProductNotification;
  if (o) {
    if (o.notificationType !== 1 || !o.purchaseToken || !o.sku) return { status: "ignored" };
    return syncOneTime(ctx, o.sku, o.purchaseToken);
  }
  if (n.voidedPurchaseNotification) return applyVoided(ctx, n.voidedPurchaseNotification);
  return { status: "ignored" };
}

/**
 * Google Play real-time developer notifications: POST /v1/notifications/google/{appId}, a Pub/Sub push subscription.
 * Every message is stored raw and forwarded (when configured). Pub/Sub redelivers anything but 2xx, so we answer 2xx
 * once a message is handled or can never be handled (bad token, other package), and 5xx for our own or Google's
 * temporary failures so it comes back.
 * With `pubsub_audience` set, a push without a valid token is a rejected request (stores/rejected.ts). Only with
 * `pubsub_service_account` set as well does a token prove the push is the developer's own subscription (anyone can make a
 * Google-signed token for any audience from their own project). Without that, nothing proves a message is the developer's,
 * so a message that cannot be handled (unreadable data, another package, a purchase token Google does not know) is a
 * rejected request too, not a failure, and its stored id carries a hash of its data so it cannot take a real message's id.
 */
export function googleNotificationRoutes(deps: Deps) {
  const r = new Hono();
  r.post("/:appId", async (c) => {
    const now = deps.now();
    const [row] = await deps.db.select().from(apps).where(eq(apps.id, c.req.param("appId"))).limit(1);
    if (!row || row.type !== "play_store") return c.json({ code: Codes.NOT_FOUND, message: "No Google Play app with this id." }, 404);
    // The service account is sealed; opened in memory for this request only.
    const app = await withStoreSecretsOrNone(deps, row);
    const { client } = googleClientFor(deps.stores, deps.fetch);
    const creds = (app.credentials ?? {}) as Record<string, unknown>;

    const tokenRequired = typeof creds.pubsub_audience === "string" && !!creds.pubsub_audience;
    const authenticated = tokenRequired && typeof creds.pubsub_service_account === "string" && !!creds.pubsub_service_account;
    if (tokenRequired) {
      let ok = false;
      try { ok = await verifyPushToken(client, c.req.header("authorization"), creds); } catch {
        return c.json({ code: Codes.STORE_PROBLEM, message: "Could not load Google's signing keys." }, 503);
      }
      if (!ok) {
        // Over the limit it is just not kept; the answer stays 401 (Pub/Sub retries a 429 the same way).
        await logRejected(deps, c, app, { store: "play_store", raw: await c.req.text(), error: "rejected: the Pub/Sub push token is missing or invalid" });
        return c.json({ code: Codes.INVALID_AUTH_TOKEN, message: "The Pub/Sub push token is missing or invalid." }, 401);
      }
    }

    const raw = await c.req.text();
    let envelope: { message?: { data?: string; messageId?: string; message_id?: string; publishTime?: string } } | null = null;
    try { envelope = JSON.parse(raw); } catch { /* handled below */ }
    const msg = envelope?.message;
    if (!msg || typeof msg !== "object") return c.json({ code: Codes.BAD_REQUEST, message: "Expected a Pub/Sub push body with a message." }, 400);

    const n = decodeData(msg.data);
    const { type, subtype } = typeOf(n);
    // Without push authentication, a message that is not a developer notification for this app is someone else's:
    // rejected before it is stored, so it never takes a message id.
    if (!authenticated) {
      const problem = !n ? "message.data is not a base64 JSON developer notification"
        : n.packageName && app.bundleId && n.packageName !== app.bundleId ? `package ${n.packageName} does not match the app's ${app.bundleId}` : null;
      // 200 either way (over the limit it is just not kept): a shared Play topic sends other packages here for good.
      if (problem) {
        await logRejected(deps, c, app, { store: "play_store", raw, type, subtype, error: `rejected: ${problem}` });
        return c.json({ status: "ignored" });
      }
    }
    const messageId = String(msg.messageId ?? msg.message_id ?? crypto.randomUUID());
    const id = authenticated ? `gpn_${app.id}_${messageId}` : `gpn_${app.id}_${messageId}_${await dataHash(msg.data)}`;
    const inserted = await deps.db.insert(storeNotifications).values({
      id, projectId: app.projectId, appId: app.id, store: "play_store", type, subtype, body: raw, receivedAt: now,
    }).onConflictDoNothing().returning({ id: storeNotifications.id });
    if (!inserted.length) {
      const [prev] = await deps.db.select({ processedAt: storeNotifications.processedAt }).from(storeNotifications).where(eq(storeNotifications.id, id));
      if (prev?.processedAt) return c.json({ status: "duplicate" });
    }
    if (inserted.length && app.notificationForwardUrl) forward(c, deps, client, app, id, raw);

    const finish = (set: Partial<typeof storeNotifications.$inferInsert>) => deps.db.update(storeNotifications).set(set).where(eq(storeNotifications.id, id));
    if (!n) {
      await finish({ processedAt: now, error: "message.data is not a base64 JSON developer notification" });
      return c.json({ status: "ignored" });
    }
    if (n.packageName && app.bundleId && n.packageName !== app.bundleId) {
      await finish({ processedAt: now, error: `package ${n.packageName} does not match the app's ${app.bundleId}` });
      return c.json({ status: "ignored" });
    }

    const eventTime = n.eventTimeMillis ? new Date(Number(n.eventTimeMillis)) : now;
    try {
      const result = await handle({ db: deps.db, app, client, now, eventTime: Number.isNaN(eventTime.getTime()) ? now : eventTime }, n);
      await finish({ processedAt: now, error: null, environment: result.sandbox === undefined ? null : result.sandbox ? "sandbox" : "production" });
      // "Ready" in setup health means a notification was processed for a purchase we know (or Google's test message).
      if (result.status === "processed") await deps.db.update(apps).set({ lastNotificationAt: now }).where(eq(apps.id, app.id));
      deps.kick?.();
      return c.json({ status: result.status });
    } catch (e) {
      const permanent = (e instanceof GoogleApiError && e.kind === "invalid_token") || (e instanceof RCError && e.status < 500 && e.code === Codes.INVALID_RECEIPT);
      const message = e instanceof Error ? e.message : String(e);
      if (permanent) {
        // Unauthenticated, a token Google does not know proves the message is not Google's.
        if (authenticated) await finish({ processedAt: now, error: `invalid purchase token: ${message}` });
        else await demoteToRejected(deps, c, app, "play_store", id, `rejected: invalid purchase token: ${message}`);
        return c.json({ status: "invalid_token" });
      }
      console.error(`Google notification ${id} failed:`, e);
      await finish({ error: message });
      return c.json({ code: Codes.STORE_PROBLEM, message: "Temporary failure; Pub/Sub will retry." }, 500);
    }
  });
  return r;
}

/** A forward that has not answered in 10 seconds is recorded as no answer (status 0). */
export const FORWARD_TIMEOUT_MS = 10_000;

/** Fire-and-forget copy of the raw body to the app's forward URL; the answer's status is recorded (0 = no answer). */
function forward(c: { executionCtx?: unknown }, deps: Deps, client: GooglePlayClient, app: AppRecord, id: string, raw: string) {
  const url = app.notificationForwardUrl!;
  const p = (async () => {
    let status = 0;
    try {
      const f = deps.fetch ?? client.fetchImpl;
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: raw, signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) });
      status = res.status;
    } catch { status = 0; }
    await deps.db.update(storeNotifications).set({ forwardStatus: status }).where(eq(storeNotifications.id, id));
  })().catch((e) => console.error("Google notification forward failed:", e)).finally(() => inflight.delete(p));
  inflight.add(p);
  try { (c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined)?.waitUntil?.(p); } catch { /* Node has no execution context */ }
}
