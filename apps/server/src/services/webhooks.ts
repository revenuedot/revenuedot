import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { schema, type DB, type DeliveryAttempt } from "@revenuedot/db";
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

// Names whose values are credentials: JSON fields and header-like "name: value" text end with one of these; query and
// form parameters also match `key`, `sig` and `signature` (Google API keys, signed URLs).
const SECRET_FIELD = "[A-Za-z0-9_-]*(?:token|secret|password|passwd|api_?key|apikey|api-key|authorization|private_key|credentials?)";
const SECRET_PARAM = `${SECRET_FIELD}|[A-Za-z0-9_-]*(?:key|sig|signature)|x-amz-credential`;
const SCRUB: [RegExp, string][] = [
  // https://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi, "$1[redacted]@"],
  [new RegExp(`("${SECRET_FIELD}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi"), '$1"[redacted]"'],
  [new RegExp(`(^|[?&;\\s"'])((?:${SECRET_PARAM})=)[^&#;\\s"'<>]+`, "gi"), "$1$2[redacted]"],
  // "X-Api-Key: 3f9a…" (a value long enough, with a digit, to be a credential rather than a word)
  [new RegExp(`(^|[\\s{,;])(${SECRET_FIELD}\\s*:\\s*)(?!Bearer\\b|Basic\\b)(?=[^\\s"',;}]*\\d)[^\\s"',;}]{12,}`, "gim"), "$1$2[redacted]"],
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1$2[redacted]"],
  // Secret keys (sk_, rk_, whsec_), JWTs, Google API keys, Slack, GitHub and AWS access keys.
  [/\b(sk|rk|whsec)_[A-Za-z0-9_]{8,}/g, "$1_[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted]"],
  [/\b(?:AIza[0-9A-Za-z_-]{30,}|xox[abposr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, "[redacted]"],
];

/**
 * Replaces the delivery's own secrets (an Authorization value also by its credential alone) and anything that looks
 * like one: bearer and basic credentials, URL passwords, secret-looking JSON fields, query and form parameters, secret
 * keys and well-known token formats. For logs and answers shown in the dashboard, never for what is sent.
 */
export function scrubSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  const all = secrets.flatMap((s) => (s ? [s, /^\w+\s+(\S.*)$/.exec(s.trim())?.[1] ?? ""] : []));
  for (const s of all.sort((a, b) => b.length - a.length)) if (s.length >= 4) out = out.split(s).join("[redacted]");
  for (const [re, to] of SCRUB) out = out.replace(re, to);
  return out;
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
  // Errors are shown to every role in the delivery log, answers to Admins and Developers: neither may carry a secret.
  const secrets = [row.h.authorizationHeader, row.h.signingSecret];
  if (error) error = scrubSecrets(error, secrets);
  const entry: DeliveryAttempt = {
    at: now.getTime(), status, ms, error: error?.slice(0, 500) ?? null,
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

/** How long a claimed delivery is held by the job that claimed it: longer than one attempt's 60-second timeout. */
export const DELIVERY_LEASE_MS = 2 * 60_000;

/** Webhooks sent to at once by one job run (deliveries to the same webhook stay one at a time). */
const WEBHOOK_CONCURRENCY = 8;

/**
 * Sends every due delivery, in batches of `limit`, claiming no more after `budgetMs`. Retries for a disabled webhook
 * wait until it is enabled again. Deliveries to one webhook go out one at a time, oldest first; different webhooks are
 * sent to in parallel. Each delivery is claimed first (its next attempt moved 2 minutes past the claim, only if it is
 * still due), so two jobs running at once (several self-hosted replicas, or the Worker's cron and a request-kicked run)
 * never send it twice. A job that dies mid-attempt leaves the claim to lapse, and the delivery is sent again after it
 * (at least once, as RevenueCat does). `signal` (a replica draining on SIGTERM) stops it after the attempts in flight.
 */
export async function deliverDue(db: DB, fetchImpl: typeof fetch, now: Date, limit = 50, budgetMs = 20_000, signal?: AbortSignal) {
  const started = Date.now();
  const stop = () => signal?.aborted === true || Date.now() - started >= budgetMs;
  // `now` is when the job run started, possibly a while ago; a lease counts from the claim itself.
  const lease = () => new Date(Math.max(now.getTime(), Date.now()) + DELIVERY_LEASE_MS);
  // A webhook whose send broke off with an error (not an HTTP failure, which schedules a retry) gets nothing more in this
  // run, so its later deliveries do not overtake the one whose result is unknown.
  const broken = new Set<string>();
  let sent = 0;
  for (;;) {
    const due = await db.select({ id: webhookDeliveries.id, webhookId: webhookDeliveries.webhookId }).from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId)).innerJoin(events, eq(events.id, webhookDeliveries.eventId))
      .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now), eq(webhooks.enabled, true), notMoving(webhooks.projectId)))
      // Events recorded at the same instant (one store notification can make two) keep the order they were recorded in.
      .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(events.createdAt)).limit(limit);
    const byHook = new Map<string, string[]>();
    for (const d of due) if (!broken.has(d.webhookId)) byHook.set(d.webhookId, [...(byHook.get(d.webhookId) ?? []), d.id]);
    let claimedAny = false;
    const queues = [...byHook];
    const worker = async () => {
      for (let q = queues.shift(); q; q = queues.shift()) {
        const [webhookId, ids] = q;
        for (const id of ids) {
          // A replica that is shutting down, or a run out of time, finishes the attempts in flight and claims no more.
          if (stop()) return;
          try {
            const [claimed] = await db.update(webhookDeliveries).set({ nextAttemptAt: lease() })
              .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now))).returning({ id: webhookDeliveries.id });
            if (!claimed) continue;
            claimedAny = true;
            await attempt(db, id, fetchImpl, now);
            sent++;
          } catch (e) {
            // The claim stays and lapses, so the delivery is tried again later.
            console.error(`webhook delivery ${id} failed`, e);
            broken.add(webhookId);
            break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WEBHOOK_CONCURRENCY, queues.length) }, worker));
    // Another full batch may be waiting (a burst of purchases); stop when the batch was short, nothing could be claimed
    // (another job holds them), or the time is up.
    if (due.length < limit || !claimedAny || stop()) return sent;
  }
}

/** Manual retry from the dashboard or API: queue immediately. */
export async function retryDelivery(db: DB, deliveryId: string, now: Date) {
  await db.update(webhookDeliveries).set({ status: "pending", nextAttemptAt: now }).where(eq(webhookDeliveries.id, deliveryId));
}

const DAY = 86400_000;
/** How long attempt details (answers, signatures) are kept after each attempt. Delivery rows and events stay. */
export const ATTEMPT_LOG_DAYS = 30;

/**
 * Removes attempt details older than 30 days from webhook and integration deliveries; the deliveries keep their status,
 * attempt count and last answer status. A partial index on created_at finds rows that still hold details, so a run with
 * nothing to do costs one index probe a table. Works in batches until done or `budgetMs` is spent (the rest waits for the
 * next tick), so a backlog never grows faster than it is cleared. Returns how many deliveries changed.
 */
export async function pruneAttemptLogs(db: DB, now: Date, { batch = 1000, budgetMs = 3000 } = {}) {
  const started = Date.now();
  const cutoff = new Date(now.getTime() - ATTEMPT_LOG_DAYS * DAY);
  const cutoffMs = cutoff.getTime();
  let n = 0;
  for (const T of [webhookDeliveries, schema.integrationDeliveries]) {
    for (;;) {
      // Attempts are kept oldest first, so a row is due when its first attempt is older than the cutoff.
      const due = db.select({ id: T.id }).from(T)
        .where(and(lt(T.createdAt, cutoff), sql`${T.attemptLog} <> '[]'::jsonb`, sql`(${T.attemptLog}->0->>'at')::bigint < ${cutoffMs}`)).limit(batch);
      const done = await db.update(T).set({
        attemptLog: sql`coalesce((select jsonb_agg(a.x order by a.i) from jsonb_array_elements(${T.attemptLog}) with ordinality as a(x, i) where (a.x->>'at')::bigint >= ${cutoffMs}), '[]'::jsonb)`,
      }).where(inArray(T.id, due)).returning({ id: T.id });
      n += done.length;
      if (done.length < batch || Date.now() - started > budgetMs) break;
    }
  }
  return n;
}

/** "Bearer ••••••••": the scheme stays, the credential never leaves the server. */
export function maskAuthorization(v: string): string {
  const m = /^(\w+)\s+\S/.exec(v);
  return m ? `${m[1]} ••••••••` : "••••••••";
}
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** A cURL command that repeats a request, with credentials left as placeholders (the caller's header values). */
export function curlFor(method: string, url: string, headers: { name: string; value: string }[], body: string | null): string {
  const lines = [`curl -X ${method} ${shq(url)}`, ...headers.map((h) => `-H ${shq(`${h.name}: ${h.value}`)}`)];
  if (body !== null) lines.push("--data-binary @- <<'BODY'");
  return lines.join(" \\\n  ") + (body !== null ? `\n${body}\nBODY` : "");
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
