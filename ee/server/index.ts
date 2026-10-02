// RevenueDot Enterprise (ee/LICENSE): the server extension the core loads through apps/server/src/extensions.ts.
// Spec: prd/enterprise/PRD.md.
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import type { ExtensionStatus, PasswordRefusal, ProjectAccess, ServerExtension } from "../../apps/server/src/extensions.js";
import { v2ErrorResponse } from "../../apps/server/src/routes/v2/common.js";
import { checkLicense, type LicenseState } from "./license.js";
import { regionConfigFrom, regionGuard, type RegionConfig } from "./region.js";
import { eeOrgMembers, eeOrgProjects, eeOrganizations, eeSsoDomains, eeSsoSessions } from "./schema.js";
import { ADMIN_ONLY_SCOPES, customRoleFor, isBuiltin } from "./access.js";
import { emailDomain, signedIn, type EeCtx } from "./util.js";
import { orgRoutes } from "./orgs.js";
import { ssoPasswordPolicy, ssoRoutes } from "./sso/routes.js";
import { scimRoutes } from "./scim/routes.js";
import { enterpriseTick } from "./retention.js";

export { checkLicense, issueLicense, FEATURES } from "./license.js";

/** Reads the licence from the environment and builds the extension (called by the core's loadExtensions). */
export async function createEnterprise(o: { env: Record<string, string | undefined>; edition?: "cloud" | "self-hosted"; publicKeys?: string[]; now?: number }): Promise<ServerExtension> {
  const license = await checkLicense({ key: o.env.REVENUEDOT_LICENSE_KEY, dev: o.env.REVENUEDOT_EE_DEV === "true", edition: o.edition, now: o.now ?? Date.now(), publicKeys: o.publicKeys });
  return enterpriseExtension(license, regionConfigFrom(o.env));
}

/** The extension for a checked licence. With no features (an invalid or expired licence) it only reports its status. */
export function enterpriseExtension(license: LicenseState, regions: RegionConfig = { current: "us", regions: {} }): ServerExtension {
  const features = new Set(license.features);
  const status = (): ExtensionStatus => ({ mode: license.mode, features: [...features], licensee: license.licensee, expires_at: license.expiresAt, message: license.message });
  const on = features.size > 0;
  let ctx: EeCtx | null = null;

  return {
    name: "RevenueDot Enterprise",
    status,

    mount(app, deps) {
      ctx = { deps, features, regions };
      const statusRoute = new Hono();
      statusRoute.onError((e, c) => v2ErrorResponse(c, e));
      // The licence state for the dashboard (any signed-in user).
      statusRoute.get("/v2/enterprise", async (c) => { await signedIn(c, deps); return c.json({ object: "enterprise", ...status() }); });
      app.route("/", statusRoute);
      if (!on) return;
      if (features.has("data_location")) app.use("*", regionGuard(deps.db, regions, deps.now));
      app.route("/", orgRoutes(ctx));
      if (features.has("sso")) app.route("/", ssoRoutes(ctx));
      if (features.has("scim")) app.route("/", scimRoutes(ctx));
    },

    projectAccess: on ? (a) => projectAccess(a.deps.db, features, a) : undefined,

    passwordPolicy: features.has("sso") ? async (a): Promise<PasswordRefusal | null> => ctx ? ssoPasswordPolicy(ctx, a.email) : null : undefined,

    async config() {
      return { sso: features.has("sso") };
    },

    async me(a) {
      const orgs = on && features.has("organizations")
        ? await a.deps.db.select({ id: eeOrganizations.id, name: eeOrganizations.name, role: eeOrgMembers.role }).from(eeOrgMembers)
          .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgMembers.orgId))
          .where(and(eq(eeOrgMembers.userId, a.userId), eq(eeOrgMembers.active, true)))
        : [];
      return { enterprise: { ...status(), organizations: orgs } };
    },

    tick: on ? (db, now) => enterpriseTick(db, now, features) : undefined,
  };
}

/**
 * Project access for dashboard users (the core calls this after it found the membership):
 * - a project in an organization that enforces single sign-on needs a session that began with that organization's
 *   SSO, for members whose email domain the organization verified (owners may still use a password: break-glass);
 * - a custom role gives exactly its scopes; a role id that no longer resolves gives none.
 */
async function projectAccess(db: DB, features: Set<string>, a: { userId: string; sessionId: string | null; projectId: string; role: string }): Promise<ProjectAccess | null> {
  const [row] = await db.select({ orgId: eeOrgProjects.orgId, enforced: eeOrganizations.ssoEnforced }).from(eeOrgProjects)
    .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgProjects.orgId)).where(eq(eeOrgProjects.projectId, a.projectId)).limit(1);
  if (row?.enforced && features.has("sso")) {
    const [member] = await db.select({ role: eeOrgMembers.role, active: eeOrgMembers.active }).from(eeOrgMembers)
      .where(and(eq(eeOrgMembers.orgId, row.orgId), eq(eeOrgMembers.userId, a.userId))).limit(1);
    if (member?.active === false) return { deny: { status: 404, message: "Project not found." } };
    if (member?.role !== "owner" && (await mustUseSso(db, row.orgId, a.userId))) {
      const [sso] = a.sessionId ? await db.select({ id: eeSsoSessions.sessionId }).from(eeSsoSessions)
        .where(and(eq(eeSsoSessions.sessionId, a.sessionId), eq(eeSsoSessions.orgId, row.orgId))).limit(1) : [];
      if (!sso) return { deny: { status: 403, message: "This project's organization requires single sign-on. Sign out, then sign in with SSO." } };
    }
  }
  if (isBuiltin(a.role)) return null;
  const role = row && features.has("custom_roles") ? await customRoleFor(db, a.projectId, a.role) : null;
  return { permissions: role ? role.scopes.filter((s) => !ADMIN_ONLY_SCOPES.has(s)) : [] };
}

/** Enforcement covers people whose email domain the organization verified. */
async function mustUseSso(db: DB, orgId: string, userId: string) {
  const [u] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) return true;
  const domains = await db.select({ d: eeSsoDomains.domain, v: eeSsoDomains.verifiedAt }).from(eeSsoDomains).where(eq(eeSsoDomains.orgId, orgId));
  return domains.some((d) => d.v && d.d === emailDomain(u.email));
}

export type { EeCtx };
