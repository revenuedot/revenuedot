import { and, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import {
  BIGQUERY_SCOPE, bigQueryCreateTable, buildIntegration, responseError, retryableStatus, type EventContext, type IntegrationKind, type OutRequest,
} from "@revenuedot/core/integrations";
import { schema, type DB } from "@revenuedot/db";
import { RETRY_MINUTES } from "../webhooks.js";
import { SecretsError, unseal, type SecretKey } from "../secrets.js";
import { GoogleAuthError, googleAccessToken, parseServiceAccount } from "../google-sa.js";
import { outboundUrlProblem } from "../outbound.js";

/**
 * Sends queued integration deliveries: build the partner's request from the stored event (pure builders in
 * @revenuedot/core/integrations), send it, and log the outcome. The retry schedule is the webhooks' one (5, 10, 20, 40
 * and 80 minutes); timeouts, 429 and 5xx retry, any other 4xx fails at once because resending the same request cannot
 * succeed (fix the settings, then replay). A builder that has nothing to send (no device id, no key for sandbox) marks
 * the delivery `skipped` with the reason.
 *
 * Each tick claims a delivery before sending it (a lease on next_attempt_at), so overlapping ticks never send it twice,
 * takes at most PER_INTEGRATION due deliveries from any one integration (a big replay cannot starve other projects),
 * sends CONCURRENCY at a time and starts nothing new once the time budget is spent. A delivery that throws is logged
 * as a failed attempt; it never stops the others.
 */

const { integrationDeliveries: D, integrations: I, events: E } = schema;

export interface IntegrationRuntime {
  fetch: typeof fetch;
  now: Date;
  secretKey: SecretKey | null;
  /** Dashboard origin for links in Slack messages. */
  publicUrl?: string;
  timeoutMs?: number;
  /** RevenueDot Cloud: also refuse URLs on private networks (services/outbound.ts). */
  strictUrls?: boolean;
  /** No new delivery starts after this many milliseconds (default 15 s), so the tick stays short on Workers. */
  budgetMs?: number;
}

const LOG_BODY = 4000, LOG_RESPONSE = 1000;
/** A claimed delivery whose tick died is picked up again after this long. */
const LEASE_MS = 10 * 60_000;
const PER_INTEGRATION = 10, CONCURRENCY = 4;

function scrub(s: string, secrets: string[]) {
  let out = s;
  for (const v of secrets) if (v && v.length >= 4) out = out.split(v).join("[redacted]");
  return out;
}

async function send(r: OutRequest, f: typeof fetch, timeoutMs: number): Promise<{ status: number | null; body: string; error: string | null }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // Redirects are not followed: the URL guard checked only this URL, and a redirect could point anywhere,
    // including a cloud metadata address whose answer would land in the delivery log.
    const res = await f(r.url, { method: r.method, headers: r.headers, body: r.method === "GET" || r.method === "HEAD" ? undefined : r.body, signal: ctl.signal, redirect: "manual" });
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      return { status: res.status || null, body: "", error: "The partner answered with a redirect, which is not followed. Use the final URL." };
    }
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

/** One attempt at one delivery; `attempts` counts this one (set when the tick claimed it). */
export async function attemptIntegration(db: DB, deliveryId: string, rt: IntegrationRuntime, attempts?: number) {
  const [row] = await db.select({ d: D, i: I, e: E }).from(D).innerJoin(I, eq(I.id, D.integrationId)).innerJoin(E, eq(E.id, D.eventId)).where(eq(D.id, deliveryId));
  if (!row) return;
  const attempt = attempts ?? row.d.attempts + 1;
  const started = Date.now();
  let redact: string[] = [];
  const fail = async (error: string, opts: { retry: boolean; status?: number | null; request?: string | null; requestBody?: string | null; responseBody?: string | null; sentAs?: string | null }) => {
    const retryIn = opts.retry ? RETRY_MINUTES[attempt - 1] : undefined;
    const message = scrub(error, redact);
    await db.update(D).set({
      attempts: attempt, status: retryIn === undefined ? "failed" : "pending", nextAttemptAt: retryIn === undefined ? rt.now : new Date(rt.now.getTime() + retryIn * 60_000),
      lastError: message.slice(0, 1000), responseStatus: opts.status ?? null, responseMs: Date.now() - started,
      request: opts.request ?? null, requestBody: opts.requestBody ?? null, responseBody: opts.responseBody ?? null, sentAs: opts.sentAs ?? null,
    }).where(eq(D.id, deliveryId));
    await db.update(I).set({ consecutiveFailures: sql`${I.consecutiveFailures} + 1`, lastError: message.slice(0, 500) }).where(eq(I.id, row.i.id));
  };

  try {
    const kind = row.i.kind as IntegrationKind;
    let secrets: Record<string, string>;
    try {
      secrets = await unseal(row.i.secrets, rt.secretKey);
    } catch (e) {
      // Retried on the usual schedule: a deploy that lost its key can be fixed before the deliveries give up.
      return await fail(e instanceof SecretsError ? e.message : "The saved credentials could not be read.", { retry: true });
    }
    redact = Object.values(secrets);
    const event = await withCurrentAttributes(db, row.e);
    const ctx = await contextFor(db, row, rt);
    const settings = { ...row.i.settings };
    if (kind === "bigquery") {
      try {
        const sa = parseServiceAccount(secrets.service_account_json);
        if (!settings.project_id && sa.project_id) settings.project_id = sa.project_id;
        ctx.accessToken = await googleAccessToken(sa, BIGQUERY_SCOPE, rt.fetch, rt.now.getTime());
      } catch (e) {
        const transient = e instanceof GoogleAuthError && e.transient;
        return await fail(e instanceof Error ? e.message : String(e), { retry: transient });
      }
    }
    const plan = await buildIntegration(kind, { event, settings, secrets, eventNames: row.i.eventNames, context: ctx, now: rt.now });
    if ("skip" in plan) {
      // Nothing was sent, so the claim does not count as an attempt.
      await db.update(D).set({ attempts: attempt - 1, status: "skipped", lastError: plan.skip, responseMs: null, nextAttemptAt: rt.now }).where(eq(D.id, deliveryId));
      return;
    }
    redact = [...plan.redact, ...Object.values(secrets), ...(ctx.accessToken ? [ctx.accessToken] : [])];
    const lines: string[] = [], bodies: string[] = [];
    const timeout = rt.timeoutMs ?? 20_000;
    let last: { status: number | null; body: string; error: string | null } = { status: null, body: "", error: null };
    for (const r of plan.requests) {
      lines.push(`${r.method} ${scrub(r.url, redact)}`);
      bodies.push(scrub(r.body, redact));
      const problem = outboundUrlProblem(r.url, !!rt.strictUrls);
      if (problem) return await fail(`The ${kind} URL ${problem}. Fix the integration's settings, then replay.`, { retry: false, request: lines.join("\n"), sentAs: plan.name });
      last = await send(r, rt.fetch, timeout);
      // BigQuery: create the table with RevenueDot's schema the first time, then insert again.
      if (kind === "bigquery" && last.status === 404 && /not found: table/i.test(last.body) && ctx.accessToken) {
        const created = await send(bigQueryCreateTable(settings, ctx.accessToken), rt.fetch, timeout);
        if ((created.status !== null && created.status < 300) || created.status === 409) last = await send(r, rt.fetch, timeout);
      }
      const err = last.error ?? (last.status !== null ? responseError(kind, last.status, last.body) : "No answer.");
      if (err) {
        return await fail(err, {
          retry: last.error !== null || retryableStatus(last.status), status: last.status, request: lines.join("\n"),
          requestBody: bodies.join("\n").slice(0, LOG_BODY), responseBody: scrub(last.body, redact).slice(0, LOG_RESPONSE), sentAs: plan.name,
        });
      }
    }
    await db.update(D).set({
      attempts: attempt, status: "delivered", nextAttemptAt: rt.now, lastError: null, responseStatus: last.status, responseMs: Date.now() - started,
      request: lines.join("\n"), requestBody: bodies.join("\n").slice(0, LOG_BODY), responseBody: scrub(last.body, redact).slice(0, LOG_RESPONSE), sentAs: plan.name,
    }).where(eq(D.id, deliveryId));
    await db.update(I).set({ consecutiveFailures: 0, lastError: null, lastDeliveredAt: rt.now }).where(eq(I.id, row.i.id));
  } catch (e) {
    // A builder or the database threw: record it against this delivery only and move on.
    console.error(`integration delivery ${deliveryId} failed`, e);
    await fail(`RevenueDot could not send this event: ${e instanceof Error ? e.message : String(e)}`, { retry: true }).catch((e2) => console.error(`integration delivery ${deliveryId}: could not record the failure`, e2));
  }
}

/**
 * Sends due deliveries of enabled integrations, fairly across integrations. Retries for a disabled integration wait
 * until it is enabled again. Returns how many were attempted.
 */
export async function deliverDueIntegrations(db: DB, rt: IntegrationRuntime, limit = 50) {
  const started = Date.now();
  const budget = rt.budgetMs ?? 15_000;
  const ranked = db.select({ id: D.id, at: D.nextAttemptAt, rank: sql<number>`row_number() over (partition by ${D.integrationId} order by ${D.nextAttemptAt}, ${D.id})`.as("rank") })
    .from(D).innerJoin(I, eq(I.id, D.integrationId))
    .where(and(inArray(D.status, ["pending", "sending"]), lte(D.nextAttemptAt, rt.now), eq(I.enabled, true))).as("ranked");
  const due = await db.select({ id: ranked.id }).from(ranked).where(lte(ranked.rank, PER_INTEGRATION)).orderBy(ranked.at, ranked.id).limit(limit);
  let next = 0, attempted = 0;
  const lease = new Date(rt.now.getTime() + LEASE_MS);
  const worker = async () => {
    while (next < due.length && Date.now() - started < budget) {
      const id = due[next++]!.id;
      try {
        // Claim it: another tick that picked the same row finds it leased and skips it.
        // "sending" marks the lease; a lease that runs out (the tick died) is due again like a pending delivery.
        const [claimed] = await db.update(D).set({ status: "sending", nextAttemptAt: lease, attempts: sql`${D.attempts} + 1` })
          .where(and(eq(D.id, id), inArray(D.status, ["pending", "sending"]), lte(D.nextAttemptAt, rt.now))).returning({ attempts: D.attempts });
        if (!claimed) continue;
        attempted++;
        // A delivery that keeps killing the tick never reaches fail(); stop after the normal number of attempts.
        if (claimed.attempts > RETRY_MINUTES.length + 1) {
          await db.update(D).set({ status: "failed", nextAttemptAt: rt.now, lastError: "Gave up: the delivery stopped the sender on every attempt." }).where(eq(D.id, id));
          continue;
        }
        await attemptIntegration(db, id, rt, claimed.attempts);
      } catch (e) {
        console.error(`integration delivery ${id} failed`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker));
  return attempted;
}

/**
 * Manual retry: queue the delivery again now with a fresh retry schedule (a skipped one is rebuilt, so new attributes
 * or keys count). A delivery waiting for its next scheduled attempt (after a 5xx or a timeout) is sent now instead of
 * waiting, as webhook deliveries are. Returns false only while a tick holds the delivery's lease (it is being sent).
 */
export async function requeueIntegrationDelivery(db: DB, deliveryId: string, now: Date): Promise<boolean> {
  const rows = await db.update(D).set({ status: "pending", nextAttemptAt: now, attempts: 0 })
    .where(and(eq(D.id, deliveryId), or(ne(D.status, "sending"), lte(D.nextAttemptAt, now)))).returning({ id: D.id });
  return rows.length > 0;
}
