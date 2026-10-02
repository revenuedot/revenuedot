import { and, asc, eq, lte, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { notMoving } from "./archive/moving.js";

const { webhookDeliveries, webhooks, events } = schema;

/** Retry schedule after a failed attempt: 5, 10, 20, 40, 80 minutes (RevenueCat's), then give up. */
export const RETRY_MINUTES = [5, 10, 20, 40, 80];

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** `X-RevenueCat-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, re-signed on every attempt. */
export async function signatureHeader(secret: string, body: string, now: Date): Promise<string> {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

export async function verifySignature(secret: string, body: string, header: string, toleranceSec = 300, now = new Date()): Promise<boolean> {
  const m = /t=(\d+),v1=([0-9a-f]+)/.exec(header);
  if (!m) return false;
  if (Math.abs(now.getTime() / 1000 - Number(m[1])) > toleranceSec) return false;
  return (await hmacHex(secret, `${m[1]}.${body}`)) === m[2];
}

/** Sends one delivery attempt. Only HTTP 200 counts as delivered. */
export async function attempt(db: DB, deliveryId: string, fetchImpl: typeof fetch, now: Date, timeoutMs = 60_000) {
  const [row] = await db.select({ d: webhookDeliveries, h: webhooks, e: events }).from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId)).innerJoin(events, eq(events.id, webhookDeliveries.eventId))
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row) return;
  const body = JSON.stringify(row.e.payload);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "RevenueDot-Webhooks/1.0" };
  if (row.h.authorizationHeader) headers.authorization = row.h.authorizationHeader;
  headers["X-RevenueCat-Webhook-Signature"] = await signatureHeader(row.h.signingSecret, body, now);
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetchImpl(row.h.url, { method: "POST", headers, body, signal: ctrl.signal });
    clearTimeout(timer);
    status = res.status;
    if (res.status !== 200) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const attempts = row.d.attempts + 1;
  const ok = status === 200;
  const retryIn = RETRY_MINUTES[attempts - 1];
  await db.update(webhookDeliveries).set({
    attempts, responseStatus: status, responseMs: Date.now() - started, lastError: ok ? null : error,
    status: ok ? "delivered" : retryIn === undefined ? "failed" : "pending",
    nextAttemptAt: ok || retryIn === undefined ? now : new Date(now.getTime() + retryIn * 60_000),
  }).where(eq(webhookDeliveries.id, deliveryId));
  // Attempts in a row that failed, per webhook: 5 or more opens the "webhook failing" alert (services/alerts.ts).
  await db.update(webhooks).set(ok ? { consecutiveFailures: 0, lastError: null } : { consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1`, lastError: error?.slice(0, 500) ?? null })
    .where(eq(webhooks.id, row.h.id));
}

/** Sends every due delivery. Retries for a disabled webhook wait until it is enabled again. */
export async function deliverDue(db: DB, fetchImpl: typeof fetch, now: Date, limit = 50) {
  const due = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now), eq(webhooks.enabled, true), notMoving(webhooks.projectId))).orderBy(asc(webhookDeliveries.nextAttemptAt)).limit(limit);
  for (const d of due) await attempt(db, d.id, fetchImpl, now);
  return due.length;
}

/** Manual retry from the dashboard or API: queue immediately. */
export async function retryDelivery(db: DB, deliveryId: string, now: Date) {
  await db.update(webhookDeliveries).set({ status: "pending", nextAttemptAt: now }).where(eq(webhookDeliveries.id, deliveryId));
}
