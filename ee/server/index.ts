// RevenueDot Enterprise (ee/LICENSE): the server extension the core loads through apps/server/src/extensions.ts.
// Spec: prd/enterprise/PRD.md.
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@revenuedot/db";
import type { ExtensionStatus, PasswordRefusal, ProjectAccess, ServerExtension } from "../../apps/server/src/extensions.js";
import { v2ErrorResponse } from "../../apps/server/src/routes/v2/common.js";
import { FEATURES, checkLicense, type LicenseState } from "./license.js";
import { regionConfigFrom, regionGuard, type RegionConfig } from "./region.js";
import { eeOrgMembers, eeOrgProjects, eeOrganizations, eeSsoConnections, eeSsoSessions } from "./schema.js";
import { ADMIN_ONLY_SCOPES, customRoleFor, isBuiltin } from "./access.js";
import { mustUseSso, orgFeatures, signedIn, type EeCtx } from "./util.js";
import { cloudPlansFrom, planFeatures, planFor, userPlan, type CloudPlans } from "./plans.js";
import { planOf } from "../../apps/server/src/services/billing/plans.js";
import { orgRoutes } from "./orgs.js";
import { ssoPasswordPolicy, ssoRoutes } from "./sso/routes.js";
import { scimRoutes } from "./scim/routes.js";
import { enterpriseTick } from "./retention.js";

export { checkLicense, issueLicense, FEATURES } from "./license.js";

/**
 * Builds the extension (called by the core's loadExtensions). Self-hosted: from the licence key. RevenueDot Cloud: every
 * route is mounted and each organization's plan decides what it may use (plans.ts; company decision 2026-10-02), so
 * Cloud needs no licence key and ignores one.
 */
export async function createEnterprise(o: { env: Record<string, string | undefined>; edition?: "cloud" | "self-hosted"; publicKeys?: string[]; now?: number }): Promise<ServerExtension> {
  if (o.edition === "cloud") return enterpriseExtension(CLOUD_LICENSE, regionConfigFrom(o.env), cloudPlansFrom(o.env.REVENUEDOT_BILLING_PLANS));
  const license = await checkLicense({ key: o.env.REVENUEDOT_LICENSE_KEY, dev: o.env.REVENUEDOT_EE_DEV === "true", edition: o.edition, now: o.now ?? Date.now(), publicKeys: o.publicKeys });
  return enterpriseExtension(license, regionConfigFrom(o.env));
}

/** RevenueDot Cloud: every feature exists on the server; the plans decide who may use it. */
const CLOUD_LICENSE: LicenseState = { mode: "licensed", features: [...FEATURES], licensee: null, expiresAt: null, maxOrgs: null, message: null };

/**
 * The extension for a checked licence. With no features (an invalid or expired licence) it only reports its status.
 * `cloud`: RevenueDot Cloud, where features are per organization (its owners' best plan) instead of per server.
 */
export function enterpriseExtension(license: LicenseState, regions: RegionConfig = { current: "us", regions: {} }, cloud?: CloudPlans): ServerExtension {
  const features = new Set(license.features);
  const status = (): ExtensionStatus => cloud
    ? { mode: "cloud", features: [], licensee: null, expires_at: null, message: null }
    : { mode: license.mode, features: [...features], licensee: license.licensee, expires_at: license.expiresAt, message: license.message };
  /** On Cloud, what a signed-in person's own plan includes, and their plan. */
  const statusFor = async (db: DB, userId: string): Promise<ExtensionStatus & { plan?: string; locked: { feature: string; plan: string }[] }> => {
    if (!cloud) return { ...status(), locked: FEATURES.filter((f) => !features.has(f)).map((f) => ({ feature: f, plan: "enterprise" })) };
    const plan = await userPlan(db, userId);
    const mine = planFeatures(planOf(cloud.plans, plan));
    return { ...status(), features: [...mine], plan, locked: FEATURES.filter((f) => !mine.has(f)).map((f) => ({ feature: f, plan: planFor(cloud.plans, f) })) };
  };
  const on = features.size > 0;
  let ctx: EeCtx | null = null;

  return {
    name: "RevenueDot Enterprise",
    status,

    mount(app, deps) {
      ctx = { deps, features, regions, maxOrgs: license.maxOrgs, cloud };
      const statusRoute = new Hono();
      statusRoute.onError((e, c) => v2ErrorResponse(c, e));
      // The licence state, or on Cloud the person's plan, for the dashboard (any signed-in user).
      statusRoute.get("/v2/enterprise", async (c) => { const { user } = await signedIn(c, deps); return c.json({ object: "enterprise", ...(await statusFor(deps.db, user.id)) }); });
      app.route("/", statusRoute);
      if (!on) return;
      if (features.has("data_location")) app.use("*", regionGuard(deps.db, regions, deps.now));
      app.route("/", orgRoutes(ctx));
      if (features.has("sso")) app.route("/", ssoRoutes(ctx));
      if (features.has("scim")) app.route("/", scimRoutes(ctx));
    },

    projectAccess: on ? async (a) => projectAccess(a.deps.db, (orgId) => ctx ? orgFeatures(ctx, orgId) : Promise.resolve(features), a) : undefined,

    passwordPolicy: features.has("sso") ? async (a): Promise<PasswordRefusal | null> => ctx ? ssoPasswordPolicy(ctx, a.email) : null : undefined,

    async config() {
      // Cloud: "Continue with SSO" is offered to everyone; /sso/lookup finds out whether the address's organization has it.
      return { sso: features.has("sso") };
    },

    async me(a) {
      const orgs = on && features.has("organizations")
        ? await a.deps.db.select({ id: eeOrganizations.id, name: eeOrganizations.name, role: eeOrgMembers.role }).from(eeOrgMembers)
          .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgMembers.orgId))
          .where(and(eq(eeOrgMembers.userId, a.userId), eq(eeOrgMembers.active, true)))
        : [];
      return { enterprise: { ...(await statusFor(a.deps.db, a.userId)), organizations: orgs } };
    },

    // An organization must keep an owner: its last owner cannot delete their account while others are still in it.
    beforeAccountDelete: on && features.has("organizations") ? async (a) => {
      const db = a.deps.db;
      const mine = await db.select({ orgId: eeOrgMembers.orgId, name: eeOrganizations.name }).from(eeOrgMembers)
        .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgMembers.orgId))
        .where(and(eq(eeOrgMembers.userId, a.userId), eq(eeOrgMembers.role, "owner"), eq(eeOrgMembers.active, true)));
      for (const o of mine) {
        const people = await db.select({ u: eeOrgMembers.userId, role: eeOrgMembers.role }).from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, o.orgId), eq(eeOrgMembers.active, true)));
        const others = people.filter((p) => p.u !== a.userId);
        if (others.length && !others.some((p) => p.role === "owner")) return { message: `You are the only owner of the organization ${o.name}, which has other members. Make someone else an owner first.` };
      }
      return null;
    } : undefined,

    // Always, licensed or not: a key rotation must reach every SSO client secret.
    sealedColumns: () => [{ table: eeSsoConnections, id: eeSsoConnections.id, column: eeSsoConnections.secret }],
    tick: on ? (db, now) => enterpriseTick(db, now, features, cloud) : undefined,
  };
}

/**
 * Project access for dashboard users (the core calls this after it found the membership):
 * - a project in an organization that enforces single sign-on needs a session that began with that organization's
 *   SSO, for members whose email domain the organization verified (owners may still use a password: break-glass),
 *   unless the caller checked the session already (`sessionChecked`: the OAuth token exchange after its consent screen);
 * - a custom role gives exactly its scopes; a role id that no longer resolves gives none.
 */
async function projectAccess(db: DB, featuresOf: (orgId: string) => Promise<Set<string>>, a: { userId: string; sessionId: string | null; projectId: string; role: string; sessionChecked?: boolean }): Promise<ProjectAccess | null> {
  const [row] = await db.select({ orgId: eeOrgProjects.orgId, enforced: eeOrganizations.ssoEnforced }).from(eeOrgProjects)
    .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgProjects.orgId)).where(eq(eeOrgProjects.projectId, a.projectId)).limit(1);
  // A project outside any organization: built-in roles only, so no plan lookup is needed.
  const features = row ? await featuresOf(row.orgId) : new Set<string>();
  if (row) {
    const [member] = await db.select({ role: eeOrgMembers.role, active: eeOrgMembers.active }).from(eeOrgMembers)
      .where(and(eq(eeOrgMembers.orgId, row.orgId), eq(eeOrgMembers.userId, a.userId))).limit(1);
    // Deprovisioned people keep no access, even through a membership added later by hand.
    if (member?.active === false) return { deny: { status: 404, message: "Project not found." } };
    // Someone who joined an organization project through a project invite becomes an organization member, so the
    // organization's member list, seats and access reviews include them. Only while the project membership still exists
    // when the row is written: a request that raced the person's removal must not add them back.
    if (!member) {
      await db.execute(sql`insert into ee_org_members (org_id, user_id, role, source) select ${row.orgId}, ${a.userId}, 'member', 'project'
        where exists (select 1 from memberships where user_id = ${a.userId} and project_id = ${a.projectId}) on conflict do nothing`);
    }
    if (row.enforced && features.has("sso") && !a.sessionChecked && member?.role !== "owner" && (await mustUseSso(db, row.orgId, a.userId))) {
      const [sso] = a.sessionId ? await db.select({ id: eeSsoSessions.sessionId }).from(eeSsoSessions)
        .where(and(eq(eeSsoSessions.sessionId, a.sessionId), eq(eeSsoSessions.orgId, row.orgId))).limit(1) : [];
      if (!sso) return { deny: { status: 403, message: "This project's organization requires single sign-on. Sign out, then sign in with SSO." } };
    }
  }
  if (isBuiltin(a.role)) return null;
  const role = row && features.has("custom_roles") ? await customRoleFor(db, a.projectId, a.role) : null;
  return { permissions: role ? role.scopes.filter((s) => !ADMIN_ONLY_SCOPES.has(s)) : [] };
}


export type { EeCtx };
