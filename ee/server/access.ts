// RevenueDot Enterprise (ee/LICENSE). Custom roles, group role mappings and provisioning of project memberships.
// Spec: prd/enterprise/PRD.md §4 (custom roles) and §7 (provisioning).
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import {
  eeCustomRoles, eeMembershipSources, eeOrgMembers, eeOrgProjects, eeRoleMappings, eeScimGroupMembers, eeScimGroups, eeScimUsers, eeSsoSessions,
} from "./schema.js";
import { BUILTIN_ROLES, isOrgAdmin } from "./util.js";

/**
 * Every API v2 scope a route checks (apps/server/src/routes/v2/common.ts `scope()`), grouped for the role editor.
 * A `read_write` scope includes its `read` scope. Collaborators (invites and members) and secret API keys stay with
 * the built-in Admin role: a custom role can read collaborators but never manage them.
 */
export const SCOPE_GROUPS: { group: string; scopes: { scope: string; label: string }[] }[] = [
  { group: "Customers", scopes: [
    { scope: "customer_information:customers:read", label: "View customers" },
    { scope: "customer_information:customers:read_write", label: "Edit customers (attributes, grants, delete)" },
    { scope: "customer_information:subscriptions:read", label: "View subscriptions" },
    { scope: "customer_information:subscriptions:read_write", label: "Cancel, refund and extend subscriptions" },
    { scope: "customer_information:purchases:read", label: "View purchases" },
    { scope: "customer_information:purchases:read_write", label: "Refund purchases and make test purchases" },
    { scope: "customer_information:invoices:read", label: "View invoices" },
  ] },
  { group: "Product catalog", scopes: [
    { scope: "project_configuration:products:read", label: "View products" },
    { scope: "project_configuration:products:read_write", label: "Edit products" },
    { scope: "project_configuration:entitlements:read", label: "View entitlements" },
    { scope: "project_configuration:entitlements:read_write", label: "Edit entitlements" },
    { scope: "project_configuration:offerings:read", label: "View offerings, paywalls, web and funnels" },
    { scope: "project_configuration:offerings:read_write", label: "Edit offerings, paywalls, web and funnels" },
    { scope: "project_configuration:packages:read", label: "View packages" },
    { scope: "project_configuration:packages:read_write", label: "Edit packages" },
    { scope: "project_configuration:virtual_currencies:read", label: "View in-app currencies" },
    { scope: "project_configuration:virtual_currencies:read_write", label: "Edit in-app currencies" },
    { scope: "project_configuration:discounts:read", label: "View web discounts" },
    { scope: "project_configuration:discounts:read_write", label: "Edit web discounts" },
  ] },
  { group: "Targeting", scopes: [
    { scope: "audiences:audiences:read", label: "View audiences, targeting and experiments" },
    { scope: "audiences:audiences:read_write", label: "Edit audiences, targeting and experiments" },
  ] },
  { group: "Charts", scopes: [
    { scope: "charts_metrics:overview:read", label: "View the overview metrics" },
    { scope: "charts_metrics:charts:read", label: "View charts" },
    { scope: "charts_metrics:charts:read_write", label: "Save charts" },
  ] },
  { group: "Project", scopes: [
    { scope: "project_configuration:projects:read", label: "View project settings" },
    { scope: "project_configuration:projects:read_write", label: "Edit project settings" },
    { scope: "project_configuration:apps:read", label: "View apps and store credentials status" },
    { scope: "project_configuration:apps:read_write", label: "Edit apps and store credentials" },
    { scope: "project_configuration:integrations:read", label: "View webhooks, integrations and exports" },
    { scope: "project_configuration:integrations:read_write", label: "Edit webhooks, integrations and exports" },
    { scope: "project_configuration:audit_logs:read", label: "View the audit log" },
    { scope: "project_configuration:collaborators:read", label: "View collaborators" },
    { scope: "project_configuration:api_keys:read", label: "View API keys" },
  ] },
];
export const ALL_SCOPES = new Set(SCOPE_GROUPS.flatMap((g) => g.scopes.map((s) => s.scope)));
/** Scopes a custom role may never hold: only built-in Admins manage secret API keys. */
export const ADMIN_ONLY_SCOPES = new Set(["project_configuration:api_keys:read_write"]);

export const isBuiltin = (role: string) => (BUILTIN_ROLES as readonly string[]).includes(role);
export const isCustomRoleId = (role: string) => role.startsWith("role_");

export type CustomRole = typeof eeCustomRoles.$inferSelect;

/** A custom role usable in this project: one of the organization's roles, for every project or for this one. */
export async function customRoleFor(db: DB, projectId: string, roleId: string): Promise<CustomRole | null> {
  const [row] = await db.select({ role: eeCustomRoles }).from(eeCustomRoles)
    .innerJoin(eeOrgProjects, eq(eeOrgProjects.orgId, eeCustomRoles.orgId))
    .where(and(eq(eeCustomRoles.id, roleId), eq(eeOrgProjects.projectId, projectId), or(isNull(eeCustomRoles.projectId), eq(eeCustomRoles.projectId, projectId)))).limit(1);
  return row?.role ?? null;
}

/**
 * Ranks roles when several group mappings give one person roles in the same project: Admin, then Developer, then
 * custom roles (the one with more scopes first), then Viewer.
 */
export function rank(role: string, customScopes: Map<string, number>): number {
  if (role === "admin") return 4000;
  if (role === "developer") return 3000;
  if (role === "viewer") return 1000;
  return 2000 + Math.min(999, customScopes.get(role) ?? 0);
}

/** The groups a person is in: SCIM group memberships plus the groups their identity provider sent at the last SSO. */
export async function groupsOf(db: DB, orgId: string, userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const scim = await db.select({ name: eeScimGroups.displayKey }).from(eeScimGroupMembers)
    .innerJoin(eeScimGroups, eq(eeScimGroups.id, eeScimGroupMembers.groupId))
    .innerJoin(eeScimUsers, eq(eeScimUsers.id, eeScimGroupMembers.scimUserId))
    .where(and(eq(eeScimUsers.orgId, orgId), eq(eeScimUsers.userId, userId), eq(eeScimUsers.active, true)));
  for (const g of scim) out.add(g.name);
  const [m] = await db.select({ g: eeOrgMembers.ssoGroups }).from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId)));
  for (const g of m?.g ?? []) out.add(g.trim().toLowerCase());
  return out;
}

/**
 * Brings one person's memberships in the organization's projects in line with their organization role and groups:
 * - inactive (deprovisioned) or no longer a member: every membership in the organization's projects is removed;
 * - owners and admins are Admins of every organization project (source "org");
 * - group mappings give the highest mapped role per project (source "idp"); a mapping that no longer applies removes
 *   the membership it made. Memberships added by hand (no source row) are never changed while the person is active.
 * Returns how many memberships changed.
 */
export async function reconcileMember(db: DB, orgId: string, userId: string): Promise<number> {
  const projects = (await db.select({ id: eeOrgProjects.projectId }).from(eeOrgProjects).where(eq(eeOrgProjects.orgId, orgId))).map((p) => p.id);
  if (!projects.length) return 0;
  const [member] = await db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))).limit(1);
  const existing = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, userId), inArray(schema.memberships.projectId, projects)));
  const sourceRows = await db.select().from(eeMembershipSources).where(and(eq(eeMembershipSources.userId, userId), inArray(eeMembershipSources.projectId, projects)));
  const sources = new Map<string, string>();
  for (const s of sourceRows) {
    const have = existing.find((e) => e.projectId === s.projectId);
    // A role changed elsewhere (for example in the project's Collaborators settings) since provisioning set it is now a
    // hand-set role: provisioning lets go of it.
    if (have && s.role && have.role !== s.role) await db.delete(eeMembershipSources).where(and(eq(eeMembershipSources.userId, userId), eq(eeMembershipSources.projectId, s.projectId)));
    else sources.set(s.projectId, s.source);
  }
  let changed = 0;
  if (!member || !member.active) {
    if (existing.length) {
      await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, userId), inArray(schema.memberships.projectId, projects)));
      await db.delete(eeMembershipSources).where(and(eq(eeMembershipSources.userId, userId), inArray(eeMembershipSources.projectId, projects)));
      changed = existing.length;
    }
    return changed;
  }
  const desired = new Map<string, { role: string; source: "org" | "idp" }>();
  if (isOrgAdmin(member.role)) for (const p of projects) desired.set(p, { role: "admin", source: "org" });
  const groups = await groupsOf(db, orgId, userId);
  if (groups.size) {
    const maps = await db.select().from(eeRoleMappings).where(and(eq(eeRoleMappings.orgId, orgId), inArray(eeRoleMappings.groupKey, [...groups])));
    const customs = await db.select({ id: eeCustomRoles.id, scopes: eeCustomRoles.scopes }).from(eeCustomRoles).where(eq(eeCustomRoles.orgId, orgId));
    const sizes = new Map(customs.map((r) => [r.id, r.scopes.length]));
    for (const m of maps) {
      if (!projects.includes(m.projectId)) continue;
      if (!isBuiltin(m.role) && !sizes.has(m.role)) continue;
      const cur = desired.get(m.projectId);
      if (!cur || (cur.source === "idp" && rank(m.role, sizes) > rank(cur.role, sizes))) desired.set(m.projectId, { role: m.role, source: "idp" });
    }
  }
  for (const p of projects) {
    const have = existing.find((e) => e.projectId === p);
    const src = sources.get(p);
    const want = desired.get(p);
    if (have && !src) continue; // added by hand: provisioning leaves it alone
    if (want) {
      if (!have) {
        await db.insert(schema.memberships).values({ userId, projectId: p, role: want.role }).onConflictDoNothing();
        changed++;
      } else if (have.role !== want.role) {
        await db.update(schema.memberships).set({ role: want.role }).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.projectId, p)));
        changed++;
      }
      await db.insert(eeMembershipSources).values({ projectId: p, userId, source: want.source, role: want.role }).onConflictDoUpdate({ target: [eeMembershipSources.projectId, eeMembershipSources.userId], set: { source: want.source, role: want.role } });
    } else if (have && src) {
      await db.delete(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.projectId, p)));
      await db.delete(eeMembershipSources).where(and(eq(eeMembershipSources.userId, userId), eq(eeMembershipSources.projectId, p)));
      changed++;
    }
  }
  return changed;
}

/** Reconciles every member of an organization (after a role mapping, group or project change). */
export async function reconcileOrg(db: DB, orgId: string): Promise<number> {
  const members = await db.select({ userId: eeOrgMembers.userId }).from(eeOrgMembers).where(eq(eeOrgMembers.orgId, orgId));
  let n = 0;
  for (const m of members) n += await reconcileMember(db, orgId, m.userId);
  return n;
}

/** Signs a person out everywhere (deprovisioning): their sessions end at once. */
export async function endSessions(db: DB, userId: string) {
  await db.delete(eeSsoSessions).where(eq(eeSsoSessions.userId, userId));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

/**
 * Turns custom roles that can no longer apply (the role was deleted, or the project left the organization) into
 * Viewer, so nobody keeps a role id the core would read as "no access".
 */
export async function demoteRoles(db: DB, projectIds: string[], roleIds?: string[]) {
  if (!projectIds.length) return;
  const rows = await db.select().from(schema.memberships).where(inArray(schema.memberships.projectId, projectIds));
  for (const m of rows) {
    if (isBuiltin(m.role)) continue;
    if (roleIds && !roleIds.includes(m.role)) continue;
    await db.update(schema.memberships).set({ role: "viewer" }).where(and(eq(schema.memberships.userId, m.userId), eq(schema.memberships.projectId, m.projectId)));
  }
}
