import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
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

/** Attempts kept per delivery, and how much of each answer. */
export const ATTEMPT_LOG_MAX = 10, RESPONSE_LOG_CHARS = 4096;

/** Replaces the delivery's own secrets and anything that looks like a bearer token or secret key. */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, "$1[redacted]").replace(/\b(sk|rk|whsec)_[A-Za-z0-9_]{8,}/g, "$1_[redacted]");
}

/** The first `max` characters of a response body, without reading the rest of it. */
export async function readCapped(res: Response, max = RESPONSE_LOG_CHARS): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } finally { reader.cancel().catch(() => {}); }
  return out.slice(0, max);
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
  let responseBody: string | null = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(row.h.url, { method: "POST", headers, body, signal: ctrl.signal });
    status = res.status;
    if (res.status !== 200) error = `HTTP ${res.status}`;
    // The answer is kept for the delivery details (first 4 KB); a body that fails to arrive does not change the outcome.
    responseBody = await readCapped(res).catch(() => null);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const secrets = [row.h.authorizationHeader, row.h.signingSecret];
  const entry = {
    at: now.getTime(), status, ms, error: error ? scrubSecrets(error, secrets).slice(0, 500) : null,
    response_body: responseBody === null ? null : scrubSecrets(responseBody, secrets), signature: headers["X-RevenueCat-Webhook-Signature"]!,
  };
  const attempts = row.d.attempts + 1;
  const ok = status === 200;
  const retryIn = RETRY_MINUTES[attempts - 1];
  await db.update(webhookDeliveries).set({
    attempts, responseStatus: status, responseMs: ms, lastError: ok ? null : error, attemptLog: [...(row.d.attemptLog ?? []), entry].slice(-ATTEMPT_LOG_MAX),
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

const DAY = 86400_000;
/** How long attempt details (response bodies, signatures) are kept. Delivery rows and events stay. */
export const ATTEMPT_LOG_DAYS = 30;
let lastPrune = 0;

/**
 * Clears attempt details older than 30 days on webhook and integration deliveries, at most once an hour and 5,000 rows
 * per table a run (a partial index finds them). The deliveries keep their status, attempt count and last answer status.
 */
export async function pruneAttemptLogs(db: DB, now: Date, force = false) {
  if (!force && now.getTime() - lastPrune < 3600_000) return 0;
  lastPrune = now.getTime();
  const cutoff = new Date(now.getTime() - ATTEMPT_LOG_DAYS * DAY);
  let n = 0;
  for (const T of [webhookDeliveries, schema.integrationDeliveries]) {
    const old = db.select({ id: T.id }).from(T).where(and(lt(T.createdAt, cutoff), sql`${T.attemptLog} <> '[]'::jsonb`)).limit(5000);
    const done = await db.update(T).set({ attemptLog: [] }).where(inArray(T.id, old)).returning({ id: T.id });
    n += done.length;
  }
  return n;
}

/** "Bearer ••••••••": the scheme stays, the credential never leaves the server. */
export function maskAuthorization(v: string): string {
  const m = /^(\w+)\s+\S/.exec(v);
  return m ? `${m[1]} ••••••••` : "••••••••";
}
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** A cURL command that repeats a JSON POST, with credentials left as placeholders. */
export function curlFor(method: string, url: string, headers: { name: string; value: string }[], body: string | null): string {
  const lines = [`curl -X ${method} ${shq(url)}`, ...headers.map((h) => `-H ${shq(`${h.name}: ${h.value}`)}`)];
  if (body !== null) lines.push("--data-binary @- <<'JSON'");
  return lines.join(" \\\n  ") + (body !== null ? `\n${body}\nJSON` : "");
}

/** What a webhook delivery sends: method, URL, headers (Authorization masked) and the exact body. */
export function webhookRequest(w: { url: string; authorizationHeader: string | null }, payload: unknown, lastSignature: string | null) {
  const body = JSON.stringify(payload);
  const headers = [
    { name: "Content-Type", value: "application/json" }, { name: "User-Agent", value: "RevenueDot-Webhooks/1.0" },
    ...(w.authorizationHeader ? [{ name: "Authorization", value: maskAuthorization(w.authorizationHeader) }] : []),
    { name: "X-RevenueCat-Webhook-Signature", value: lastSignature ?? "t=<unix seconds>,v1=<HMAC-SHA256 of t.body>" },
  ];
  const curlHeaders = headers.map((h) => (h.name === "Authorization" ? { name: h.name, value: "<your Authorization header value>" } : h));
  return { method: "POST", url: w.url, headers, body, curl: curlFor("POST", w.url, curlHeaders, body) };
}
