import { and, eq, gt, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { integrationSpec } from "@revenuedot/core/integrations";
import { schema, type DB } from "@revenuedot/db";
import { trySend, type Mailer } from "../mail/index.js";
import { alertEmail, type AlertKind } from "../mail/templates.js";
import { notificationHealth } from "../routes/v2/notification-health.js";
import { linkBase } from "./account-email.js";

/**
 * Alert emails to project admins (prd/account-email/PRD.md), run by the every-minute tick:
 *   store_notifications  an App Store or Google Play app whose setup health says notifications are failing
 *   webhook              a webhook whose last WEBHOOK_FAILURE_THRESHOLD delivery attempts all failed
 *   store_credentials    an app whose credentials Apple or Google rejected (apps.credentials_status = "failing")
 *   integration          an enabled integration whose last INTEGRATION_FAILED_DELIVERIES deliveries ended failed, or
 *                        more than INTEGRATION_FAILURE_RATE of its delivery attempts in the last INTEGRATION_WINDOW_MS
 *                        failed (at least INTEGRATION_MIN_ATTEMPTS attempts). It stays open until a delivery succeeds
 *                        and neither rule holds any more, or the integration is turned off or deleted.
 * One email when an issue opens, at most one reminder per REMIND_AFTER_MS while it stays open, one when it resolves.
 * Admins who turned off alert emails (users.alert_emails) get none; integration alerts also need
 * users.integration_alert_emails.
 */
export const WEBHOOK_FAILURE_THRESHOLD = 5;
/** Deliveries in a row that ended failed (integrations.failed_deliveries_in_row) that open an integration alert. */
export const INTEGRATION_FAILED_DELIVERIES = 10;
/** Share of delivery attempts in the window that must fail (strictly more than this) to open an integration alert. */
export const INTEGRATION_FAILURE_RATE = 0.5;
/** Fewest attempts in the window for the failure-rate rule to count. Skipped deliveries are not attempts. */
export const INTEGRATION_MIN_ATTEMPTS = 10;
export const INTEGRATION_WINDOW_MS = 3600_000;
/** An open integration alert resolves only once the window's failure rate is at or under this share (hysteresis). */
export const INTEGRATION_RECOVERED_RATE = 0.25;
/** An open integration alert with no failed attempt for this long, and no rule holding, closes as idle. */
export const INTEGRATION_IDLE_MS = 7 * 24 * 3600_000;
export const REMIND_AFTER_MS = 24 * 3600_000;
const RECENT_MS = 7 * 24 * 3600_000;
const STORE_TYPES = ["app_store", "mac_app_store", "play_store"];

interface Failing {
  projectId: string; kind: AlertKind; subjectId: string; subjectName: string; detail: string | null;
  /** Integrations: the partner's name, the numbers behind the alert, and the dashboard path of the delivery log. */
  partner?: string | null; facts?: string[]; path?: string; turnedOff?: boolean; idle?: boolean;
}

type AlertDeps = { db: DB; mailer?: Mailer; publicUrl?: string };

export async function runAlerts(deps: AlertDeps, now: Date) {
  const { db } = deps;
  const A = schema.alerts;
  const failing: Failing[] = [];

  // 1. Store notifications: apps with a recent failed notification, and apps whose alert is open.
  const open = await db.select().from(A).where(eq(A.status, "open"));
  const N = schema.storeNotifications;
  const recent = await db.selectDistinct({ appId: N.appId }).from(N).where(and(isNotNull(N.error), eq(N.rejected, false), gt(N.receivedAt, new Date(now.getTime() - RECENT_MS))));
  const notifAppIds = [...new Set([...recent.map((r) => r.appId), ...open.filter((a) => a.kind === "store_notifications").map((a) => a.subjectId)])];
  if (notifAppIds.length) {
    const apps = await db.select().from(schema.apps).where(and(inArray(schema.apps.id, notifAppIds), inArray(schema.apps.type, STORE_TYPES)));
    for (const app of apps) {
      const h = await notificationHealth(db, app, now);
      if (h.notification_status === "failing") failing.push({ projectId: app.projectId, kind: "store_notifications", subjectId: app.id, subjectName: app.name, detail: h.last_notification_error?.message ?? null });
    }
  }

  // 2. Webhooks with WEBHOOK_FAILURE_THRESHOLD failed attempts in a row (paused webhooks do not alert).
  const W = schema.webhooks;
  for (const w of await db.select().from(W).where(and(eq(W.enabled, true), gte(W.consecutiveFailures, WEBHOOK_FAILURE_THRESHOLD)))) {
    failing.push({ projectId: w.projectId, kind: "webhook", subjectId: w.id, subjectName: w.name, detail: w.lastError });
  }

  // 3. Store credentials the store rejected.
  for (const app of await db.select().from(schema.apps).where(eq(schema.apps.credentialsStatus, "failing"))) {
    failing.push({ projectId: app.projectId, kind: "store_credentials", subjectId: app.id, subjectName: app.name, detail: app.credentialsError });
  }

  // 4. Integrations: one aggregate over the last hour's attempts, then only the integrations that trip a rule or have an alert open.
  const openIntegrations = open.filter((a) => a.kind === "integration");
  let idle = new Set<string>(), integrationsChecked = true;
  try {
    const r = await failingIntegrations(db, now, openIntegrations);
    failing.push(...r.failing);
    idle = r.idle;
  } catch (e) {
    // Never resolve integration alerts on a failed check: they stay as they are until the next run.
    console.error("alerts: integration check failed", e);
    integrationsChecked = false;
  }

  let opened = 0, reminded = 0, resolved = 0;
  const key = (kind: string, id: string) => `${kind}|${id}`;
  const failingKeys = new Set(failing.map((f) => key(f.kind, f.subjectId)));
  if (!integrationsChecked) for (const a of openIntegrations) failingKeys.add(key(a.kind, a.subjectId));
  const existing = failing.length
    ? await db.select().from(A).where(inArray(A.subjectId, [...new Set(failing.map((f) => f.subjectId))]))
    : [];
  const byKey = new Map(existing.map((a) => [key(a.kind, a.subjectId), a]));

  // Each email is sent only by the run whose write changed the alert row (insert, or an update conditioned on the state it
  // read), so two runs at once (several replicas, or the Worker's cron and a request-kicked run) never email twice.
  for (const f of failing) {
    const row = byKey.get(key(f.kind, f.subjectId));
    if (row && row.status !== "open" && f.kind === "integration" && row.resolvedAt && now.getTime() - row.resolvedAt.getTime() < REMIND_AFTER_MS) {
      // Failing again within a day of resolving: reopen quietly; the reminder schedule continues from the last email.
      await db.update(A).set({ status: "open", projectId: f.projectId, message: f.detail, openedAt: now, resolvedAt: null }).where(and(eq(A.id, row.id), ne(A.status, "open")));
      continue;
    }
    if (!row || row.status !== "open") {
      const won = row
        ? await db.update(A).set({ status: "open", projectId: f.projectId, message: f.detail, openedAt: now, lastNotifiedAt: now, resolvedAt: null }).where(and(eq(A.id, row.id), ne(A.status, "open"))).returning({ id: A.id })
        : await db.insert(A).values({ id: newId("alrt_", 12), projectId: f.projectId, kind: f.kind, subjectId: f.subjectId, status: "open", message: f.detail, openedAt: now, lastNotifiedAt: now }).onConflictDoNothing().returning({ id: A.id });
      if (!won.length) continue;
      await notify(deps, f, "open");
      opened++;
    } else if (!row.lastNotifiedAt || now.getTime() - row.lastNotifiedAt.getTime() >= REMIND_AFTER_MS) {
      const won = await db.update(A).set({ message: f.detail, lastNotifiedAt: now })
        .where(and(eq(A.id, row.id), eq(A.status, "open"), row.lastNotifiedAt ? eq(A.lastNotifiedAt, row.lastNotifiedAt) : isNull(A.lastNotifiedAt))).returning({ id: A.id });
      if (!won.length) continue;
      await notify(deps, f, "reminder");
      reminded++;
    } else if (row.message !== f.detail) {
      await db.update(A).set({ message: f.detail }).where(eq(A.id, row.id));
    }
  }

  for (const row of open) {
    if (failingKeys.has(key(row.kind, row.subjectId))) continue;
    const won = await db.update(A).set({ status: "resolved", resolvedAt: now }).where(and(eq(A.id, row.id), eq(A.status, "open"))).returning({ id: A.id });
    if (!won.length) continue;
    const subject = await subjectOf(db, row.kind as AlertKind, row.subjectId);
    // A deleted app, webhook or integration resolves without an email.
    if (subject && row.lastNotifiedAt) await notify(deps, { projectId: row.projectId, kind: row.kind as AlertKind, subjectId: row.subjectId, detail: null, ...subject, idle: idle.has(row.subjectId) && !subject.turnedOff }, "resolved");
    resolved++;
  }
  return { opened, reminded, resolved };
}

async function subjectOf(db: DB, kind: AlertKind, id: string): Promise<Pick<Failing, "subjectName" | "partner" | "path" | "turnedOff"> | null> {
  if (kind === "integration") {
    const [i] = await db.select({ name: schema.integrations.name, kind: schema.integrations.kind, enabled: schema.integrations.enabled }).from(schema.integrations).where(eq(schema.integrations.id, id));
    return i ? { subjectName: i.name, partner: integrationSpec(i.kind)?.name ?? i.kind, path: deliveryLogPath(i.kind, id), turnedOff: !i.enabled } : null;
  }
  const row = await subjectRow(db, kind, id);
  return row ? { subjectName: row.name } : null;
}

async function subjectRow(db: DB, kind: AlertKind, id: string) {
  if (kind === "webhook") return (await db.select({ name: schema.webhooks.name }).from(schema.webhooks).where(eq(schema.webhooks.id, id)))[0] ?? null;
  return (await db.select({ name: schema.apps.name }).from(schema.apps).where(eq(schema.apps.id, id)))[0] ?? null;
}

/** Emails every admin of the project who has alert emails on. */
async function notify(deps: AlertDeps, f: Failing, state: "open" | "reminder" | "resolved") {
  const { db } = deps;
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, f.projectId));
  if (!project) return 0;
  const admins = await db.select({ email: schema.users.email }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.projectId, f.projectId), eq(schema.memberships.role, "admin"), eq(schema.users.alertEmails, true),
      ...(f.kind === "integration" ? [eq(schema.users.integrationAlertEmails, true)] : [])));
  const base = linkBase(deps);
  const path = f.path ?? (f.kind === "webhook" ? `integrations/webhooks/${f.subjectId}` : `apps/${f.subjectId}`);
  const mail = alertEmail({
    base, state, kind: f.kind, projectName: project.name, subjectName: f.subjectName, detail: f.detail, url: `${base}/projects/${project.id}/${path}`,
    partner: f.partner, facts: f.facts, turnedOff: f.turnedOff, idle: f.idle,
  });
  let sent = 0;
  for (const a of admins) if (await trySend(deps.mailer, { to: a.email, ...mail })) sent++;
  return sent;
}


/** The dashboard page of an integration, that integration selected, scrolled to its delivery log. */
export const deliveryLogPath = (kind: string, id: string) => `integrations/${encodeURIComponent(kind)}?id=${encodeURIComponent(id)}#deliveries`;

/**
 * Delivery attempts and failed attempts per enabled integration in the last INTEGRATION_WINDOW_MS, from the deliveries'
 * attempt logs. A delivery with an attempt in the window has next_attempt_at in the window or later (it is the time of
 * the last attempt, plus the retry wait while one is scheduled), so the (status, next_attempt_at) index bounds the scan.
 * Only integrations with a pending or failed delivery in the window are counted: the ones that deliver everything are
 * skipped. Attempts before the integration's last change (settings saved, turned back on) do not count: a fix starts afresh.
 * A skipped delivery logs no attempt; one skipped after a replay keeps its earlier, real attempts.
 */
export async function integrationFailureRates(db: DB, now: Date): Promise<Map<string, { attempts: number; failed: number }>> {
  const since = new Date(now.getTime() - INTEGRATION_WINDOW_MS);
  const res = await db.execute(sql`select d.integration_id as id, count(*)::int as attempts, (count(*) filter (where a.x->>'error' is not null))::int as failed
    from integration_deliveries d
    join integrations i on i.id = d.integration_id and i.enabled
    cross join lateral jsonb_array_elements(d.attempt_log) as a(x)
    where d.status in ('pending', 'sending', 'delivered', 'failed', 'skipped') and d.next_attempt_at >= ${since.toISOString()}::timestamptz
      and exists (select 1 from integration_deliveries h where h.integration_id = d.integration_id and h.status in ('pending', 'sending', 'failed')
        and h.next_attempt_at >= ${since.toISOString()}::timestamptz)
      and (a.x->>'at')::bigint >= greatest(${since.getTime()}::bigint, (extract(epoch from coalesce(i.updated_at, i.created_at)) * 1000)::bigint)
    group by d.integration_id`);
  const rows = (res as unknown as { rows?: { id: string; attempts: number; failed: number }[] }).rows ?? (res as unknown as { id: string; attempts: number; failed: number }[]);
  return new Map(rows.map((r) => [r.id, { attempts: Number(r.attempts), failed: Number(r.failed) }]));
}

type Rate = { attempts: number; failed: number } | undefined;
const tripsRate = (r: Rate) => !!r && r.attempts >= INTEGRATION_MIN_ATTEMPTS && r.failed > r.attempts * INTEGRATION_FAILURE_RATE;
const rateRecovered = (r: Rate) => !r || r.attempts < INTEGRATION_MIN_ATTEMPTS || r.failed <= r.attempts * INTEGRATION_RECOVERED_RATE;

/** When each integration last had a failed attempt (a failed delivery, or one waiting to retry after a failure). */
async function lastFailures(db: DB, ids: string[]): Promise<Map<string, Date>> {
  if (!ids.length) return new Map();
  const D = schema.integrationDeliveries;
  const rows = await db.select({ id: D.integrationId, at: sql<string>`max(${D.nextAttemptAt})` }).from(D)
    .where(and(inArray(D.integrationId, ids), inArray(D.status, ["pending", "sending", "failed"]), isNotNull(D.lastError))).groupBy(D.integrationId);
  return new Map(rows.map((r) => [r.id, new Date(r.at)]));
}

/**
 * Integrations whose alert should be open. An open alert stays open (hysteresis, so it does not flap) until a delivery
 * succeeded after it opened, none has ended failed since, and the window's failure rate is at most
 * INTEGRATION_RECOVERED_RATE. It also closes as idle when no rule holds and no attempt failed in INTEGRATION_IDLE_MS.
 */
async function failingIntegrations(db: DB, now: Date, open: (typeof schema.alerts.$inferSelect)[]): Promise<{ failing: Failing[]; idle: Set<string> }> {
  const I = schema.integrations;
  const rates = await integrationFailureRates(db, now);
  const ids = [...new Set([...[...rates].filter(([, r]) => tripsRate(r)).map(([id]) => id), ...open.map((a) => a.subjectId)])];
  const which: SQL[] = [gte(I.failedDeliveriesInRow, INTEGRATION_FAILED_DELIVERIES)];
  if (ids.length) which.push(inArray(I.id, ids));
  const failed = await lastFailures(db, open.map((a) => a.subjectId));
  const out: Failing[] = [];
  const idle = new Set<string>();
  // Turned-off integrations never alert, and turning one off resolves its alert (as for paused webhooks).
  for (const i of await db.select().from(I).where(and(eq(I.enabled, true), or(...which)))) {
    const r = rates.get(i.id);
    const inRow = i.failedDeliveriesInRow >= INTEGRATION_FAILED_DELIVERIES, rate = tripsRate(r);
    const alert = open.find((a) => a.subjectId === i.id);
    let holding = false;
    if (alert && !inRow && !rate) {
      const recovered = i.failedDeliveriesInRow === 0 && !!i.lastDeliveredAt && i.lastDeliveredAt > alert.openedAt && rateRecovered(r);
      const lastFailed = failed.get(i.id);
      const quiet = !lastFailed || now.getTime() - lastFailed.getTime() >= INTEGRATION_IDLE_MS;
      if (recovered) continue;
      if (quiet) { idle.add(i.id); continue; }
      holding = true;
    }
    if (!inRow && !rate && !holding) continue;
    const facts: string[] = [];
    if (inRow) facts.push(`The last ${i.failedDeliveriesInRow} deliveries failed, one after the other.`);
    if (rate) facts.push(`${r!.failed} of ${r!.attempts} delivery attempts in the last hour failed (${Math.round((r!.failed / r!.attempts) * 100)}%).`);
    if (!facts.length) facts.push(r && r.attempts ? `${r.failed} of ${r.attempts} delivery attempts in the last hour failed.` : "Deliveries are still failing since the first email about this.");
    out.push({
      projectId: i.projectId, kind: "integration", subjectId: i.id, subjectName: i.name, detail: i.lastError,
      partner: integrationSpec(i.kind)?.name ?? i.kind, facts, path: deliveryLogPath(i.kind, i.id),
    });
  }
  return { failing: out, idle };
}
