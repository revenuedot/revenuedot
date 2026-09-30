import { and, eq, gt, gte, inArray, isNotNull } from "drizzle-orm";
import { newId } from "@revenuedot/core";
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
 * One email when an issue opens, at most one reminder per REMIND_AFTER_MS while it stays open, one when it resolves.
 * Admins who turned off alert emails (users.alert_emails) get none.
 */
export const WEBHOOK_FAILURE_THRESHOLD = 5;
export const REMIND_AFTER_MS = 24 * 3600_000;
const RECENT_MS = 7 * 24 * 3600_000;
const STORE_TYPES = ["app_store", "mac_app_store", "play_store"];

interface Failing { projectId: string; kind: AlertKind; subjectId: string; subjectName: string; detail: string | null }

type AlertDeps = { db: DB; mailer?: Mailer; publicUrl?: string };

export async function runAlerts(deps: AlertDeps, now: Date) {
  const { db } = deps;
  const A = schema.alerts;
  const failing: Failing[] = [];

  // 1. Store notifications: apps with a recent failed notification, and apps whose alert is open.
  const open = await db.select().from(A).where(eq(A.status, "open"));
  const N = schema.storeNotifications;
  const recent = await db.selectDistinct({ appId: N.appId }).from(N).where(and(isNotNull(N.error), gt(N.receivedAt, new Date(now.getTime() - RECENT_MS))));
  const notifAppIds = [...new Set([...recent.map((r) => r.appId), ...open.filter((a) => a.kind === "store_notifications").map((a) => a.subjectId)])];
  if (notifAppIds.length) {
    const apps = await db.select().from(schema.apps).where(and(inArray(schema.apps.id, notifAppIds), inArray(schema.apps.type, STORE_TYPES)));
    for (const app of apps) {
      const h = await notificationHealth(db, app);
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

  let opened = 0, reminded = 0, resolved = 0;
  const key = (kind: string, id: string) => `${kind}|${id}`;
  const failingKeys = new Set(failing.map((f) => key(f.kind, f.subjectId)));
  const existing = failing.length
    ? await db.select().from(A).where(inArray(A.subjectId, [...new Set(failing.map((f) => f.subjectId))]))
    : [];
  const byKey = new Map(existing.map((a) => [key(a.kind, a.subjectId), a]));

  for (const f of failing) {
    const row = byKey.get(key(f.kind, f.subjectId));
    if (!row || row.status !== "open") {
      await notify(deps, f, "open");
      if (row) await db.update(A).set({ status: "open", projectId: f.projectId, message: f.detail, openedAt: now, lastNotifiedAt: now, resolvedAt: null }).where(eq(A.id, row.id));
      else await db.insert(A).values({ id: newId("alrt_", 12), projectId: f.projectId, kind: f.kind, subjectId: f.subjectId, status: "open", message: f.detail, openedAt: now, lastNotifiedAt: now }).onConflictDoNothing();
      opened++;
    } else if (!row.lastNotifiedAt || now.getTime() - row.lastNotifiedAt.getTime() >= REMIND_AFTER_MS) {
      await notify(deps, f, "reminder");
      await db.update(A).set({ message: f.detail, lastNotifiedAt: now }).where(eq(A.id, row.id));
      reminded++;
    } else if (row.message !== f.detail) {
      await db.update(A).set({ message: f.detail }).where(eq(A.id, row.id));
    }
  }

  for (const row of open) {
    if (failingKeys.has(key(row.kind, row.subjectId))) continue;
    await db.update(A).set({ status: "resolved", resolvedAt: now }).where(eq(A.id, row.id));
    const subject = await subjectOf(db, row.kind as AlertKind, row.subjectId);
    // A deleted app or webhook resolves without an email.
    if (subject && row.lastNotifiedAt) await notify(deps, { projectId: row.projectId, kind: row.kind as AlertKind, subjectId: row.subjectId, subjectName: subject.name, detail: null }, "resolved");
    resolved++;
  }
  return { opened, reminded, resolved };
}

async function subjectOf(db: DB, kind: AlertKind, id: string) {
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
    .where(and(eq(schema.memberships.projectId, f.projectId), eq(schema.memberships.role, "admin"), eq(schema.users.alertEmails, true)));
  const base = linkBase(deps);
  const path = f.kind === "webhook" ? `integrations/webhooks/${f.subjectId}` : `apps/${f.subjectId}`;
  const mail = alertEmail({ base, state, kind: f.kind, projectName: project.name, subjectName: f.subjectName, detail: f.detail, url: `${base}/projects/${project.id}/${path}` });
  let sent = 0;
  for (const a of admins) if (await trySend(deps.mailer, { to: a.email, ...mail })) sent++;
  return sent;
}

