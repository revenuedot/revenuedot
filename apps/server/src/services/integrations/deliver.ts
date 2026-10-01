import { and, asc, eq, lte, sql } from "drizzle-orm";
import {
  BIGQUERY_SCOPE, bigQueryCreateTable, buildIntegration, responseError, retryableStatus, type EventContext, type IntegrationKind, type OutRequest,
} from "@revenuedot/core/integrations";
import { schema, type DB } from "@revenuedot/db";
import { RETRY_MINUTES } from "../webhooks.js";
import { SecretsError, unseal, type SecretKey } from "../secrets.js";
import { GoogleAuthError, googleAccessToken, parseServiceAccount } from "../google-sa.js";

/**
 * Sends queued integration deliveries: build the partner's request from the stored event (pure builders in
 * @revenuedot/core/integrations), send it, and log the outcome. The retry schedule is the webhooks' one (5, 10, 20, 40
 * and 80 minutes); timeouts, 429 and 5xx retry, any other 4xx fails at once because resending the same request cannot
 * succeed (fix the settings, then replay). A builder that has nothing to send (no device id, no key for sandbox) marks
 * the delivery `skipped` with the reason.
 */

const { integrationDeliveries: D, integrations: I, events: E } = schema;

export interface IntegrationRuntime {
  fetch: typeof fetch;
  now: Date;
  secretKey: SecretKey | null;
  /** Dashboard origin for links in Slack messages. */
  publicUrl?: string;
  timeoutMs?: number;
}

const LOG_BODY = 4000, LOG_RESPONSE = 1000;

function scrub(s: string, secrets: string[]) {
  let out = s;
  for (const v of secrets) if (v && v.length >= 4) out = out.split(v).join("[redacted]");
  return out;
}

async function send(r: OutRequest, f: typeof fetch, timeoutMs: number): Promise<{ status: number | null; body: string; error: string | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(r.url, { method: r.method, headers: r.headers, body: r.method === "GET" || r.method === "HEAD" ? undefined : r.body, signal: ctl.signal });
    const body = await res.text().catch(() => "");
    return { status: res.status, body, error: null };
  } catch (e) {
    return { status: null, body: "", error: ctl.signal.aborted ? "The request timed out." : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Device and app details for builders that send them (Meta's extinfo, AppsFlyer's bundle id). */
async function contextFor(db: DB, row: { e: typeof E.$inferSelect; i: typeof I.$inferSelect }, rt: IntegrationRuntime): Promise<EventContext> {
  const ctx: EventContext = { projectId: row.i.projectId, dashboardUrl: rt.publicUrl };
  if (row.e.appId) {
    const [a] = await db.select({ bundleId: schema.apps.bundleId }).from(schema.apps).where(eq(schema.apps.id, row.e.appId)).limit(1);
    ctx.bundleId = a?.bundleId ?? null;
  }
  if (row.e.customerId) {
    const [c] = await db.select().from(schema.customers).where(eq(schema.customers.id, row.e.customerId)).limit(1);
    if (c) { ctx.appVersion = c.lastSeenAppVersion; ctx.platform = c.lastSeenPlatform; ctx.platformVersion = c.lastSeenPlatformVersion; }
  }
  return ctx;
}

/**
 * The stored event with the customer's current attributes laid over the ones it was recorded with (the newer value of
 * each key wins). Attribution ids such as $appsflyerId often reach the server just after the first purchase, so a
 * delivery skipped for a missing id goes through when it is retried or replayed once the app has sent the id.
 */
async function withCurrentAttributes(db: DB, e: typeof E.$inferSelect): Promise<Record<string, unknown>> {
  const event = { ...(((e.payload as { event?: Record<string, unknown> }).event ?? {}) as Record<string, unknown>) };
  if (!e.customerId || e.type === "TRANSFER") return event;
  const current = await db.select().from(schema.customerAttributes).where(eq(schema.customerAttributes.customerId, e.customerId));
  if (!current.length) return event;
  const attrs = { ...((event.subscriber_attributes ?? {}) as Record<string, { value: string | null; updated_at_ms: number }>) };
  for (const a of current) {
    const had = attrs[a.key];
    if (!had || (had.updated_at_ms ?? 0) < a.updatedAtMs) attrs[a.key] = { value: a.value, updated_at_ms: a.updatedAtMs };
  }
  event.subscriber_attributes = attrs;
  return event;
}

/** One attempt at one delivery. */
export async function attemptIntegration(db: DB, deliveryId: string, rt: IntegrationRuntime) {
  const [row] = await db.select({ d: D, i: I, e: E }).from(D).innerJoin(I, eq(I.id, D.integrationId)).innerJoin(E, eq(E.id, D.eventId)).where(eq(D.id, deliveryId));
  if (!row) return;
  const started = Date.now();
  const kind = row.i.kind as IntegrationKind;
  const event = await withCurrentAttributes(db, row.e);
  let secrets: Record<string, string> = {};
  const fail = async (error: string, opts: { retry: boolean; status?: number | null; request?: string | null; requestBody?: string | null; responseBody?: string | null; sentAs?: string | null }) => {
    const attempts = row.d.attempts + 1;
    const retryIn = opts.retry ? RETRY_MINUTES[attempts - 1] : undefined;
    await db.update(D).set({
      attempts, status: retryIn === undefined ? "failed" : "pending", nextAttemptAt: retryIn === undefined ? rt.now : new Date(rt.now.getTime() + retryIn * 60_000),
      lastError: error.slice(0, 1000), responseStatus: opts.status ?? null, responseMs: Date.now() - started,
      request: opts.request ?? null, requestBody: opts.requestBody ?? null, responseBody: opts.responseBody ?? null, sentAs: opts.sentAs ?? null,
    }).where(eq(D.id, deliveryId));
    await db.update(I).set({ consecutiveFailures: sql`${I.consecutiveFailures} + 1`, lastError: error.slice(0, 500) }).where(eq(I.id, row.i.id));
  };

  try {
    secrets = await unseal(row.i.secrets, rt.secretKey);
  } catch (e) {
    return fail(e instanceof SecretsError ? e.message : "The saved credentials could not be read.", { retry: false });
  }
  const ctx = await contextFor(db, row, rt);
  const settings = { ...row.i.settings };
  if (kind === "bigquery") {
    try {
      const sa = parseServiceAccount(secrets.service_account_json);
      if (!settings.project_id && sa.project_id) settings.project_id = sa.project_id;
      ctx.accessToken = await googleAccessToken(sa, BIGQUERY_SCOPE, rt.fetch, rt.now.getTime());
    } catch (e) {
      const transient = e instanceof GoogleAuthError && e.transient;
      return fail(e instanceof Error ? e.message : String(e), { retry: transient });
    }
  }
  const plan = await buildIntegration(kind, { event, settings, secrets, eventNames: row.i.eventNames, context: ctx, now: rt.now });
  if ("skip" in plan) {
    await db.update(D).set({ status: "skipped", lastError: plan.skip, responseMs: null, nextAttemptAt: rt.now }).where(eq(D.id, deliveryId));
    return;
  }
  const redact = [...plan.redact, ...Object.values(secrets)];
  const lines: string[] = [], bodies: string[] = [];
  let last: { status: number | null; body: string; error: string | null } = { status: null, body: "", error: null };
  for (const r of plan.requests) {
    lines.push(`${r.method} ${scrub(r.url, redact)}`);
    bodies.push(scrub(r.body, redact));
    last = await send(r, rt.fetch, rt.timeoutMs ?? 30_000);
    // BigQuery: create the table with RevenueDot's schema the first time, then insert again.
    if (kind === "bigquery" && last.status === 404 && /not found: table/i.test(last.body) && ctx.accessToken) {
      const created = await send(bigQueryCreateTable(settings, ctx.accessToken), rt.fetch, rt.timeoutMs ?? 30_000);
      if (created.status !== null && created.status < 300 || created.status === 409) last = await send(r, rt.fetch, rt.timeoutMs ?? 30_000);
    }
    const err = last.error ?? (last.status !== null ? responseError(kind, last.status, last.body) : "No answer.");
    if (err) {
      return fail(err, {
        retry: last.error !== null || retryableStatus(last.status), status: last.status, request: lines.join("\n"),
        requestBody: bodies.join("\n").slice(0, LOG_BODY), responseBody: scrub(last.body, redact).slice(0, LOG_RESPONSE), sentAs: plan.name,
      });
    }
  }
  await db.update(D).set({
    attempts: row.d.attempts + 1, status: "delivered", nextAttemptAt: rt.now, lastError: null, responseStatus: last.status, responseMs: Date.now() - started,
    request: lines.join("\n"), requestBody: bodies.join("\n").slice(0, LOG_BODY), responseBody: scrub(last.body, redact).slice(0, LOG_RESPONSE), sentAs: plan.name,
  }).where(eq(D.id, deliveryId));
  await db.update(I).set({ consecutiveFailures: 0, lastError: null, lastDeliveredAt: rt.now }).where(eq(I.id, row.i.id));
}

/** Sends every due delivery of enabled integrations. Retries for a disabled integration wait until it is enabled again. */
export async function deliverDueIntegrations(db: DB, rt: IntegrationRuntime, limit = 50) {
  const due = await db.select({ id: D.id }).from(D).innerJoin(I, eq(I.id, D.integrationId))
    .where(and(eq(D.status, "pending"), lte(D.nextAttemptAt, rt.now), eq(I.enabled, true))).orderBy(asc(D.nextAttemptAt)).limit(limit);
  for (const d of due) await attemptIntegration(db, d.id, rt);
  return due.length;
}

/** Manual retry or replay: queue the delivery again now (a skipped one is rebuilt, so new attributes or keys count). */
export async function requeueIntegrationDelivery(db: DB, deliveryId: string, now: Date) {
  await db.update(D).set({ status: "pending", nextAttemptAt: now }).where(eq(D.id, deliveryId));
}
