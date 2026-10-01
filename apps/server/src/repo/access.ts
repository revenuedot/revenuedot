import { eq, sql } from "drizzle-orm";
import type { CustomerState } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";

/**
 * Project rules that take paid features away from a customer (prd/project-settings §1 and §3):
 * - the block list: a customer is blocked when any of its app user ids is blocked;
 * - sandbox testing access: "anybody" (default), "allowlist" (only customers with an allowlisted app user id) or "nobody".
 * The result goes into CustomerState.access, which computeEntitlements (packages/core) applies everywhere customer info,
 * API v2 entitlements, targeting and audiences are computed.
 */
export type Access = NonNullable<CustomerState["access"]>;

export const SANDBOX_ACCESS = ["anybody", "allowlist", "nobody"] as const;
export type SandboxAccess = (typeof SANDBOX_ACCESS)[number];

/** One query: the project's sandbox rule and whether the customer is blocked or allowlisted. */
export async function accessOf(db: DB, customer: { id: string; projectId: string }): Promise<Access> {
  const [row] = await db.select({
    mode: schema.projects.sandboxTestingAccess,
    blocked: sql<boolean>`exists (select 1 from ${schema.blockedCustomers} b join ${schema.customerAliases} a on a.project_id = b.project_id and a.app_user_id = b.app_user_id where a.customer_id = ${customer.id})`,
    tester: sql<boolean>`exists (select 1 from ${schema.customerAliases} a where a.customer_id = ${customer.id} and a.app_user_id = any(${schema.projects.sandboxTesters}))`,
  }).from(schema.projects).where(eq(schema.projects.id, customer.projectId)).limit(1);
  if (!row) return {};
  return { blocked: !!row.blocked, sandbox: sandboxAllowed(row.mode, !!row.tester) };
}

const sandboxAllowed = (mode: string, tester: boolean) => mode === "anybody" || (mode === "allowlist" && tester);

/** The rules of a whole project, for computing many customers at once (lists, audiences). */
export interface ProjectAccess { mode: string; testers: Set<string>; blocked: Set<string> }

export async function projectAccess(db: DB, projectId: string): Promise<ProjectAccess> {
  const [[p], blocked] = await Promise.all([
    db.select({ mode: schema.projects.sandboxTestingAccess, testers: schema.projects.sandboxTesters }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1),
    db.select({ id: schema.blockedCustomers.appUserId }).from(schema.blockedCustomers).where(eq(schema.blockedCustomers.projectId, projectId)),
  ]);
  return { mode: p?.mode ?? "anybody", testers: new Set(p?.testers ?? []), blocked: new Set(blocked.map((b) => b.id)) };
}

/** A customer's access from its app user ids. */
export function accessFor(pa: ProjectAccess, appUserIds: string[]): Access {
  return { blocked: appUserIds.some((id) => pa.blocked.has(id)), sandbox: sandboxAllowed(pa.mode, appUserIds.some((id) => pa.testers.has(id))) };
}
