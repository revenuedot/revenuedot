// RevenueDot Enterprise (ee/LICENSE). Periodic enterprise work: audit log retention and clean-up of expired sign-in
// state. Spec: prd/enterprise/PRD.md §9.
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { eeJobRuns, eeOrgAuditLogs, eeOrgProjects, eeOrganizations, eeSamlAssertions, eeSsoRequests } from "./schema.js";
import { orgAudit } from "./util.js";

/** Retention an organization may choose, in days (null keeps rows forever, which is the default). */
export const RETENTION_MIN_DAYS = 30;
export const RETENTION_MAX_DAYS = 3650;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** True once per `everyMs` across every server process (the row update is the lock). */
export async function due(db: DB, name: string, now: Date, everyMs: number): Promise<boolean> {
  const before = new Date(now.getTime() - everyMs);
  const rows = await db.insert(eeJobRuns).values({ name, lastRunAt: now })
    .onConflictDoUpdate({ target: eeJobRuns.name, set: { lastRunAt: now }, setWhere: lt(eeJobRuns.lastRunAt, before) })
    .returning({ name: eeJobRuns.name });
  return rows.length > 0;
}

/**
 * Deletes audit log rows older than each organization's retention: its own log and the logs of its projects.
 * Organizations without a retention keep everything. Returns the number of rows deleted.
 */
export async function purgeAuditLogs(db: DB, now: Date): Promise<number> {
  const orgs = await db.select({ id: eeOrganizations.id, days: eeOrganizations.auditRetentionDays }).from(eeOrganizations).where(isNotNull(eeOrganizations.auditRetentionDays));
  let total = 0;
  for (const o of orgs) {
    const days = Math.max(RETENTION_MIN_DAYS, Math.min(RETENTION_MAX_DAYS, o.days!));
    const cutoff = new Date(now.getTime() - days * DAY);
    const own = await db.delete(eeOrgAuditLogs).where(and(eq(eeOrgAuditLogs.orgId, o.id), lt(eeOrgAuditLogs.occurredAt, cutoff))).returning({ id: eeOrgAuditLogs.id });
    const projects = (await db.select({ id: eeOrgProjects.projectId }).from(eeOrgProjects).where(eq(eeOrgProjects.orgId, o.id))).map((p) => p.id);
    const proj = projects.length
      ? await db.delete(schema.auditLogs).where(and(inArray(schema.auditLogs.projectId, projects), lt(schema.auditLogs.occurredAt, cutoff))).returning({ id: schema.auditLogs.id })
      : [];
    const n = own.length + proj.length;
    if (n) await orgAudit(db, now, { orgId: o.id, action: "audit_logs_purged", actor: { type: "system" }, target: { type: "organization", id: o.id }, data: { rows: n, retention_days: days, before: cutoff.toISOString() } });
    total += n;
  }
  return total;
}

export async function enterpriseTick(db: DB, now: Date, features: Set<string>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // Sign-ins that never came back, and SAML assertion ids past their validity (replays of those fail on time anyway).
  await db.delete(eeSsoRequests).where(lt(eeSsoRequests.expiresAt, now));
  await db.delete(eeSamlAssertions).where(lt(eeSamlAssertions.expiresAt, now));
  if (features.has("audit_retention") && (await due(db, "audit_retention", now, HOUR))) {
    const n = await purgeAuditLogs(db, now);
    if (n) out.audit_rows_purged = n;
  }
  return out;
}
