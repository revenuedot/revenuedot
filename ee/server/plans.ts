// RevenueDot Enterprise (ee/LICENSE). On RevenueDot Cloud the account's plan, not a licence key, decides which features
// an organization has (company decision 2026-10-02; prd/enterprise/PRD.md §2a). Self-hosted servers never use this file.
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { accountPlanOf, planOf, plansFrom, type AccountPlan, type Plan, type PlanId } from "../../apps/server/src/services/billing/plans.js";
import { FEATURES, type Feature } from "./license.js";
import { eeOrgMembers } from "./schema.js";

const RANK: Record<AccountPlan, number> = { none: 0, pro: 1, enterprise: 2 };
const rank = (p: string) => RANK[accountPlanOf(p)];

/** The features a plan turns on (`ee_features` in the plan table; "*" for all). Organizations come with any feature. */
export function planFeatures(plan: Plan): Set<Feature> {
  const list = plan.ee_features.includes("*") ? [...FEATURES] : FEATURES.filter((f) => plan.ee_features.includes(f));
  if (list.length && !list.includes("organizations")) list.unshift("organizations");
  return new Set(list);
}

/** The cheapest plan that includes a feature: what the dashboard and error messages point to. */
export function planFor(plans: Plan[], f: Feature): PlanId {
  for (const id of ["pro", "enterprise"] as const) if (planFeatures(planOf(plans, id)).has(f)) return id;
  return "enterprise";
}

/** An account's plan (billing_accounts.plan; no row: none). Unpaid and cancelled accounts lose Pro through the billing webhook. */
export async function userPlan(db: DB, userId: string): Promise<AccountPlan> {
  const [row] = await db.select({ plan: schema.billingAccounts.plan }).from(schema.billingAccounts).where(eq(schema.billingAccounts.userId, userId)).limit(1);
  return accountPlanOf(row?.plan);
}

/** An organization's plan: the best plan among its active owners, so the owner who pays unlocks it for everyone. */
export async function orgPlan(db: DB, orgId: string): Promise<AccountPlan> {
  const rows = await db.select({ plan: schema.billingAccounts.plan }).from(eeOrgMembers)
    .innerJoin(schema.billingAccounts, eq(schema.billingAccounts.userId, eeOrgMembers.userId))
    .where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.role, "owner"), eq(eeOrgMembers.active, true)));
  let best: AccountPlan = "none";
  for (const r of rows) if (rank(r.plan) > rank(best)) best = accountPlanOf(r.plan);
  return best;
}

/** Organizations whose plan keeps audit logs as long as the organization chooses (Enterprise). */
export async function orgsWithPlans(db: DB, planIds: string[]): Promise<string[]> {
  if (!planIds.length) return [];
  const rows = await db.selectDistinct({ orgId: eeOrgMembers.orgId }).from(eeOrgMembers)
    .innerJoin(schema.billingAccounts, eq(schema.billingAccounts.userId, eeOrgMembers.userId))
    .where(and(eq(eeOrgMembers.role, "owner"), eq(eeOrgMembers.active, true), inArray(schema.billingAccounts.plan, planIds)));
  return rows.map((r) => r.orgId);
}

/** What the Cloud plan gate needs: the plan table (REVENUEDOT_BILLING_PLANS or the built-in one). */
export interface CloudPlans {
  plans: Plan[];
}

export const cloudPlansFrom = (json: string | undefined | null): CloudPlans => ({ plans: plansFrom(json) });

const DAY = 86_400_000;
/** Cloud kept every audit log entry until the plans shipped (2026-10-03); the 90 days count from then, so nothing is deleted before 2027-01-01. */
export const CLOUD_RETENTION_FROM = Date.UTC(2026, 9, 3);
/** An account whose plan changed in the last 30 days (a lapsed payment, a cancellation) keeps its history while it sorts that out. */
export const DOWNGRADE_GRACE_DAYS = 30;

/**
 * Pro, and accounts with no plan, keep audit log entries `audit_log_days` (90) days: deletes older project and organization log
 * rows, at most `budget` rows a call, except for projects owned by, or in an organization of, an account whose plan
 * lets the organization choose (Enterprise: `audit_log_days` null; its own retention setting applies, retention.ts).
 */
export async function purgeCloudAuditLogs(db: DB, now: Date, plans: Plan[], budget: number): Promise<{ deleted: number; more: boolean }> {
  const limited = plans.filter((p) => p.audit_log_days !== null);
  if (!limited.length) return { deleted: 0, more: false };
  const days = Math.max(...limited.map((p) => p.audit_log_days!));
  if (now.getTime() < CLOUD_RETENTION_FROM + days * DAY) return { deleted: 0, more: false };
  const graceFrom = new Date(now.getTime() - DOWNGRADE_GRACE_DAYS * DAY).toISOString();
  const keep = plans.filter((p) => p.audit_log_days === null).map((p) => p.id);
  const cutoff = new Date(now.getTime() - days * DAY);
  const keepOrgs = await orgsWithPlans(db, keep);
  const keepList = keep.length ? sql.join(keep.map((k) => sql`${k}`), sql`, `) : sql`''`;
  const orgList = keepOrgs.length ? sql.join(keepOrgs.map((o) => sql`${o}`), sql`, `) : sql`''`;
  const projectRows = await db.execute(sql`
    delete from audit_logs where id in (
      select a.id from audit_logs a
      join projects p on p.id = a.project_id
      left join billing_accounts b on b.user_id = p.owner_user_id
      where a.occurred_at < ${cutoff.toISOString()}::timestamptz
        and coalesce(b.plan, 'free') not in (${keepList})
        and (b.updated_at is null or b.updated_at < ${graceFrom}::timestamptz)
        and not exists (select 1 from ee_org_projects op where op.project_id = a.project_id and op.org_id in (${orgList}))
      limit ${budget}
    ) returning id`);
  const projectN = rowCount(projectRows);
  const left = budget - projectN;
  const orgN = left > 0 ? rowCount(await db.execute(sql`
    delete from ee_org_audit_logs where id in (
      select l.id from ee_org_audit_logs l
      where l.occurred_at < ${cutoff.toISOString()}::timestamptz and l.org_id not in (${orgList})
      limit ${left}
    ) returning id`)) : 0;
  return { deleted: projectN + orgN, more: projectN === budget || (left > 0 && orgN === left) };
}

const rowCount = (r: unknown): number => {
  if (Array.isArray(r)) return r.length;
  const o = r as { rows?: unknown[]; rowCount?: number | null; count?: number };
  return o.rows?.length ?? o.rowCount ?? o.count ?? 0;
};
