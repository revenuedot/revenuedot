// RevenueDot Enterprise (ee/LICENSE). Organizations: members, projects, custom roles, group role mappings, data
// location, audit retention, the organization audit log and compliance exports. Dashboard session only (secret API
// keys belong to one project). Spec: prd/enterprise/PRD.md §3, §4, §8, §9, §10.
//
//   GET    /v2/organizations                                        organizations you belong to
//   POST   /v2/organizations                                        create one (you become its owner)
//   GET    /v2/organizations/{org_id}                               details, seats, settings
//   POST   /v2/organizations/{org_id}                               update name, default region, retention, SSO enforcement, seats, billing email
//   DELETE /v2/organizations/{org_id}                               owners; the organization must have no projects
//   GET    /v2/organizations/{org_id}/members                       members with organization roles
//   POST   /v2/organizations/{org_id}/members                       add an existing account by email
//   POST   /v2/organizations/{org_id}/members/{user_id}             change the organization role
//   DELETE /v2/organizations/{org_id}/members/{user_id}             remove (loses every organization project)
//   GET    /v2/organizations/{org_id}/projects                      projects with region and member counts
//   POST   /v2/organizations/{org_id}/projects                      move an existing project in
//   DELETE /v2/organizations/{org_id}/projects/{project_id}         move a project out
//   POST   /v2/organizations/{org_id}/projects/{project_id}/region  set the data location
//   GET    /v2/organizations/{org_id}/projects/{project_id}/members project members with their role names
//   POST   /v2/organizations/{org_id}/projects/{project_id}/members/{user_id}  assign a built-in or custom role
//   GET    /v2/organizations/{org_id}/scopes                        the scopes a custom role can hold
//   GET|POST /v2/organizations/{org_id}/roles, GET|POST|DELETE .../roles/{role_id}
//   GET|POST /v2/organizations/{org_id}/role_mappings, DELETE .../role_mappings/{mapping_id}
//   GET    /v2/organizations/{org_id}/overview                      details plus SSO and SCIM counts (the dashboard)
//   GET    /v2/organizations/{org_id}/audit_logs                    the organization's own log
//   GET    /v2/organizations/{org_id}/exports/{audit_logs|access_review}?format=csv|json   signed compliance exports
//   GET    /v2/organizations/{org_id}/exports/public_key
import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { body, listOf, pageParams, paramError, v2ErrorResponse } from "../../apps/server/src/routes/v2/common.js";
import {
  eeCustomRoles, eeMembershipSources, eeOrgAuditLogs, eeOrgMembers, eeOrgProjects, eeOrganizations, eeRoleMappings, eeScimTokens, eeSsoConnections, eeSsoDomains,
} from "./schema.js";
import {
  ADMIN_ONLY_SCOPES, ALL_SCOPES, SCOPE_GROUPS, demoteRoles, isBuiltin, reconcileMember, reconcileOrg, removeFromOrgProjects,
} from "./access.js";
import { REGIONS, REGION_NAMES, forgetProjectRegion, selectableRegions, type Region } from "./region.js";
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS } from "./retention.js";
import { exportRoutes } from "./exports.js";
import { ORG_ROLES, V2Error, id, isOrgAdmin, ms, needFeature, normEmail, orgAudit, orgFeatures, orgMembership, planFields, requireOrgAdmin, requireOwner, signedIn, userFeatures, type EeCtx } from "./util.js";
import type { Feature } from "./license.js";

const Name = z.string().trim().min(1, "must not be empty").max(100);
const OrgCreate = z.object({ name: Name, region: z.enum(REGIONS).optional() });
const OrgUpdate = z.object({
  name: Name.optional(),
  region: z.enum(REGIONS).optional(),
  audit_retention_days: z.number().int().min(RETENTION_MIN_DAYS, `must be at least ${RETENTION_MIN_DAYS}`).max(RETENTION_MAX_DAYS, `must be at most ${RETENTION_MAX_DAYS}`).nullable().optional(),
  sso_enforced: z.boolean().optional(),
  seats: z.number().int().min(1).max(100000).nullable().optional(),
  billing_email: z.string().trim().email("must be a valid email address").max(320).nullable().optional(),
});
const MemberAdd = z.object({ email: z.string().trim().email("must be a valid email address").max(320), role: z.enum(ORG_ROLES).default("member") });
const MemberRole = z.object({ role: z.enum(ORG_ROLES) });
const ProjectMove = z.object({ project_id: z.string().min(1).max(100) });
const RegionSet = z.object({ region: z.enum(REGIONS) });
const RoleBody = z.object({
  name: Name,
  description: z.string().trim().max(500).nullable().optional(),
  scopes: z.array(z.string()).max(200),
  project_id: z.string().max(100).nullable().optional(),
});
const RoleUpdate = RoleBody.partial();
const MemberProjectRole = z.object({ role: z.string().min(1).max(100) });
const MappingBody = z.object({ group: z.string().trim().min(1).max(256), project_id: z.string().min(1).max(100), role: z.string().min(1).max(100) });

type OrgRow = typeof eeOrganizations.$inferSelect;

export function orgRoutes(ctx: EeCtx) {
  const { deps } = ctx;
  const { db } = deps;
  const r = new Hono();
  r.onError((e, c) => v2ErrorResponse(c, e));
  const O = "/v2/organizations/:org_id";

  if (!ctx.cloud) {
    // Self-hosted: the licence decides for the whole server.
    r.use("/v2/organizations/*", async (_c, next) => { needFeature(ctx, "organizations"); await next(); });
    r.use("/v2/organizations", async (_c, next) => { needFeature(ctx, "organizations"); await next(); });
  } else {
    // RevenueDot Cloud: each organization's plan decides (plans.ts). After a downgrade its people can still read it, move
    // projects out, leave and delete it; changing anything needs the plan again.
    const gate = async (c: Context, next: () => Promise<void>) => {
      if (!["GET", "HEAD", "DELETE"].includes(c.req.method)) needFeature(ctx, "organizations", await orgFeatures(ctx, c.req.param("org_id")!));
      await next();
    };
    r.use(O, gate);
    r.use(`${O}/*`, gate);
  }

  /** Signed in and an active member of the organization in the path, with the features the organization has. */
  const member = async (c: Context) => {
    const { user, sessionId } = await signedIn(c, deps);
    const orgId = c.req.param("org_id")!;
    const features = await orgFeatures(ctx, orgId);
    const { org, member: m } = await orgMembership(db, orgId, user.id, { sessionId, features });
    return { user, sessionId, org, role: m.role, features };
  };
  const admin = async (c: Context) => { const m = await member(c); requireOrgAdmin(m.role); return m; };
  const audit = (orgId: string, userId: string, action: string, target: { type: string; id?: string | null }, data?: Record<string, unknown>) =>
    orgAudit(db, deps.now(), { orgId, action, actor: { type: "user", id: userId }, target, data });

  const orgProjects = async (orgId: string) => db.select({ projectId: eeOrgProjects.projectId, region: eeOrgProjects.region, addedAt: eeOrgProjects.addedAt, name: schema.projects.name })
    .from(eeOrgProjects).innerJoin(schema.projects, eq(schema.projects.id, eeOrgProjects.projectId)).where(eq(eeOrgProjects.orgId, orgId));

  /** Seats used: everyone with access to the organization, as a member or through a project. */
  const seatsUsed = async (orgId: string) => {
    const ids = new Set((await db.select({ u: eeOrgMembers.userId }).from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.active, true)))).map((x) => x.u));
    const projects = (await orgProjects(orgId)).map((p) => p.projectId);
    if (projects.length) for (const m of await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(inArray(schema.memberships.projectId, projects))) ids.add(m.u);
    return ids.size;
  };

  const orgShape = async (o: OrgRow, role: string, features: Set<Feature>) => {
    const projects = await orgProjects(o.id);
    const [members] = await db.select({ n: count() }).from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, o.id), eq(eeOrgMembers.active, true)));
    return {
      object: "organization", id: o.id, name: o.name, your_role: role, region: o.region, region_name: REGION_NAMES[o.region as Region] ?? o.region,
      selectable_regions: selectableRegions(ctx.regions, deps.edition === "cloud"), region_enforced: Object.keys(ctx.regions.regions).length > 1, cloud: deps.edition === "cloud",
      audit_retention_days: o.auditRetentionDays, sso_enforced: o.ssoEnforced,
      seats: { purchased: o.seats, used: await seatsUsed(o.id) }, billing_email: o.billingEmail,
      member_count: Number(members?.n ?? 0), project_count: projects.length, features: [...features], ...(await planFields(ctx, o.id, features)),
      created_at: o.createdAt.getTime(), updated_at: o.updatedAt.getTime(),
    };
  };

  r.get("/v2/organizations", async (c) => {
    const { user } = await signedIn(c, deps);
    const rows = await db.select({ org: eeOrganizations, role: eeOrgMembers.role }).from(eeOrgMembers)
      .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgMembers.orgId))
      .where(and(eq(eeOrgMembers.userId, user.id), eq(eeOrgMembers.active, true))).orderBy(eeOrganizations.createdAt);
    return c.json(listOf(c, await Promise.all(rows.map(async (x) => orgShape(x.org, x.role, await orgFeatures(ctx, x.org.id)))), null));
  });

  r.post("/v2/organizations", async (c) => {
    const { user } = await signedIn(c, deps);
    const b = await body(c, OrgCreate);
    // Cloud: creating an organization needs a plan that includes organizations (Cloud Standard or Enterprise).
    if (ctx.cloud) needFeature(ctx, "organizations", await userFeatures(ctx, user.id));
    if (ctx.maxOrgs) {
      const [n] = await db.select({ n: count() }).from(eeOrganizations);
      if (Number(n?.n ?? 0) >= ctx.maxOrgs) throw new V2Error(403, "authorization_error", `Your RevenueDot Enterprise licence covers ${ctx.maxOrgs} organization${ctx.maxOrgs === 1 ? "" : "s"} on this server.`);
    }
    const now = deps.now();
    const orgId = id("org_");
    await db.insert(eeOrganizations).values({ id: orgId, name: b.name, region: b.region ?? ctx.regions.current, createdBy: user.id, createdAt: now, updatedAt: now });
    await db.insert(eeOrgMembers).values({ orgId, userId: user.id, role: "owner", source: "manual", createdAt: now });
    await audit(orgId, user.id, "organization_created", { type: "organization", id: orgId }, { name: b.name });
    const [o] = await db.select().from(eeOrganizations).where(eq(eeOrganizations.id, orgId));
    return c.json(await orgShape(o!, "owner", await orgFeatures(ctx, o!.id)), 201);
  });

  r.get(O, async (c) => { const m = await member(c); return c.json(await orgShape(m.org, m.role, m.features)); });

  r.post(O, async (c) => {
    const m = await admin(c);
    const b = await body(c, OrgUpdate);
    const set: Partial<typeof eeOrganizations.$inferInsert> = { updatedAt: deps.now() };
    const changed: Record<string, unknown> = {};
    if (b.name !== undefined) { set.name = b.name; changed.name = b.name; }
    if (b.region !== undefined) {
      needFeature(ctx, "data_location", m.features);
      if (!selectableRegions(ctx.regions, deps.edition === "cloud").includes(b.region)) throw paramError(`New projects of this organization are created in the ${REGION_NAMES[ctx.regions.current]} region on this server. Use the ${REGION_NAMES[b.region]} dashboard for projects stored there.`, "region");
      set.region = b.region; changed.region = b.region;
    }
    if (b.audit_retention_days !== undefined) {
      needFeature(ctx, "audit_retention", m.features);
      // Shortening retention deletes history for good, so only owners may change it.
      requireOwner(m.role);
      set.auditRetentionDays = b.audit_retention_days; changed.audit_retention_days = b.audit_retention_days;
    }
    if (b.sso_enforced !== undefined) {
      needFeature(ctx, "sso", m.features);
      if (b.sso_enforced) {
        const [conn] = await db.select({ id: eeSsoConnections.id }).from(eeSsoConnections).where(and(eq(eeSsoConnections.orgId, m.org.id), eq(eeSsoConnections.enabled, true))).limit(1);
        const [dom] = await db.select({ d: eeSsoDomains.domain }).from(eeSsoDomains).where(and(eq(eeSsoDomains.orgId, m.org.id), sql`${eeSsoDomains.verifiedAt} is not null`)).limit(1);
        if (!conn || !dom) throw new V2Error(422, "unprocessable_entity_error", "Turn on a single sign-on connection and verify at least one email domain before you require single sign-on.", "sso_enforced");
      }
      set.ssoEnforced = b.sso_enforced; changed.sso_enforced = b.sso_enforced;
    }
    if (b.seats !== undefined) { requireOwner(m.role); set.seats = b.seats; changed.seats = b.seats; }
    if (b.billing_email !== undefined) { requireOwner(m.role); set.billingEmail = b.billing_email ? normEmail(b.billing_email) : null; changed.billing_email = set.billingEmail; }
    const [o] = await db.update(eeOrganizations).set(set).where(eq(eeOrganizations.id, m.org.id)).returning();
    if (Object.keys(changed).length) await audit(m.org.id, m.user.id, "organization_updated", { type: "organization", id: m.org.id }, changed);
    return c.json(await orgShape(o!, m.role, m.features));
  });

  r.delete(O, async (c) => {
    const m = await member(c);
    requireOwner(m.role);
    if ((await orgProjects(m.org.id)).length) throw new V2Error(422, "unprocessable_entity_error", "Move every project out of the organization before you delete it.");
    await db.delete(eeOrganizations).where(eq(eeOrganizations.id, m.org.id));
    return c.json({ object: "organization", id: m.org.id, deleted_at: deps.now().getTime() });
  });

  // ---- Members ----
  const memberShape = (x: { m: typeof eeOrgMembers.$inferSelect; u: typeof schema.users.$inferSelect }) => ({
    object: "organization_member", user_id: x.u.id, email: x.u.email, name: x.u.name, role: x.m.role, source: x.m.source, active: x.m.active,
    sso_groups: x.m.ssoGroups, last_sso_at: ms(x.m.lastSsoAt), password_sign_in: !!x.u.passwordHash, created_at: x.m.createdAt.getTime(),
  });

  r.get(`${O}/members`, async (c) => {
    const m = await member(c);
    const rows = await db.select({ m: eeOrgMembers, u: schema.users }).from(eeOrgMembers).innerJoin(schema.users, eq(schema.users.id, eeOrgMembers.userId))
      .where(eq(eeOrgMembers.orgId, m.org.id)).orderBy(eeOrgMembers.createdAt);
    return c.json(listOf(c, rows.map(memberShape), null));
  });

  r.post(`${O}/members`, async (c) => {
    const m = await admin(c);
    const b = await body(c, MemberAdd);
    if (b.role === "owner") requireOwner(m.role);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, normEmail(b.email))).limit(1);
    if (!u) throw new V2Error(404, "resource_missing", `No account uses ${normEmail(b.email)}. People join through single sign-on or SCIM, or invite them to a project first.`, "email");
    const [exists] = await db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, m.org.id), eq(eeOrgMembers.userId, u.id))).limit(1);
    if (exists?.active) throw new V2Error(409, "resource_already_exists", `${u.email} is already a member.`, "email");
    if (exists) await db.update(eeOrgMembers).set({ active: true, role: b.role }).where(and(eq(eeOrgMembers.orgId, m.org.id), eq(eeOrgMembers.userId, u.id)));
    else await db.insert(eeOrgMembers).values({ orgId: m.org.id, userId: u.id, role: b.role, source: "manual", createdAt: deps.now() });
    await reconcileMember(db, m.org.id, u.id);
    await audit(m.org.id, m.user.id, "member_added", { type: "user", id: u.id }, { email: u.email, role: b.role });
    const [row] = await db.select({ m: eeOrgMembers, u: schema.users }).from(eeOrgMembers).innerJoin(schema.users, eq(schema.users.id, eeOrgMembers.userId))
      .where(and(eq(eeOrgMembers.orgId, m.org.id), eq(eeOrgMembers.userId, u.id)));
    return c.json(memberShape(row!), 201);
  });

  const owners = async (orgId: string) => (await db.select({ u: eeOrgMembers.userId }).from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.role, "owner"), eq(eeOrgMembers.active, true)))).map((x) => x.u);
  const findMember = async (orgId: string, userId: string) => {
    const [row] = await db.select({ m: eeOrgMembers, u: schema.users }).from(eeOrgMembers).innerJoin(schema.users, eq(schema.users.id, eeOrgMembers.userId))
      .where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))).limit(1);
    if (!row) throw new V2Error(404, "resource_missing", "Member not found.");
    return row;
  };

  r.post(`${O}/members/:user_id`, async (c) => {
    const m = await admin(c);
    const b = await body(c, MemberRole);
    const t = await findMember(m.org.id, c.req.param("user_id")!);
    // Owners are made and unmade by owners only.
    if (b.role === "owner" || t.m.role === "owner") requireOwner(m.role);
    if (t.m.role === "owner" && b.role !== "owner" && (await owners(m.org.id)).length <= 1) throw paramError("An organization needs at least one owner. Make someone else an owner first.", "role");
    await db.update(eeOrgMembers).set({ role: b.role }).where(and(eq(eeOrgMembers.orgId, m.org.id), eq(eeOrgMembers.userId, t.u.id)));
    await reconcileMember(db, m.org.id, t.u.id);
    await audit(m.org.id, m.user.id, "member_role_changed", { type: "user", id: t.u.id }, { email: t.u.email, from: t.m.role, to: b.role });
    return c.json(memberShape(await findMember(m.org.id, t.u.id)));
  });

  r.delete(`${O}/members/:user_id`, async (c) => {
    const m = await member(c);
    const t = await findMember(m.org.id, c.req.param("user_id")!);
    if (t.u.id !== m.user.id) requireOrgAdmin(m.role);
    if (t.m.role === "owner") {
      if (t.u.id !== m.user.id) requireOwner(m.role);
      if ((await owners(m.org.id)).length <= 1) throw new V2Error(422, "unprocessable_entity_error", "An organization needs at least one owner.");
    }
    // Leaving the organization ends access to every one of its projects, including memberships added by hand. The
    // memberships go first, so a request of theirs running meanwhile cannot make them an organization member again.
    await removeFromOrgProjects(db, m.org.id, t.u.id);
    await db.delete(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, m.org.id), eq(eeOrgMembers.userId, t.u.id)));
    await audit(m.org.id, m.user.id, "member_removed", { type: "user", id: t.u.id }, { email: t.u.email });
    return c.json({ object: "organization_member", user_id: t.u.id, deleted_at: deps.now().getTime() });
  });

  // ---- Projects ----
  const projectMembers = async (projectIds: string[]) => projectIds.length
    ? db.select({ projectId: schema.memberships.projectId, n: count() }).from(schema.memberships).where(inArray(schema.memberships.projectId, projectIds)).groupBy(schema.memberships.projectId)
    : [];

  r.get(`${O}/projects`, async (c) => {
    const m = await member(c);
    const rows = await orgProjects(m.org.id);
    const counts = new Map((await projectMembers(rows.map((p) => p.projectId))).map((x) => [x.projectId, Number(x.n)]));
    const mine = new Map((await db.select().from(schema.memberships).where(eq(schema.memberships.userId, m.user.id))).map((x) => [x.projectId, x.role]));
    return c.json(listOf(c, rows.map((p) => ({
      object: "organization_project", id: p.projectId, name: p.name, region: p.region, region_name: REGION_NAMES[p.region as Region] ?? p.region,
      member_count: counts.get(p.projectId) ?? 0, your_role: mine.get(p.projectId) ?? null, added_at: p.addedAt.getTime(),
    })), null));
  });

  r.post(`${O}/projects`, async (c) => {
    const m = await admin(c);
    const b = await body(c, ProjectMove);
    const [mine] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, m.user.id), eq(schema.memberships.projectId, b.project_id))).limit(1);
    if (!mine) throw new V2Error(404, "resource_missing", "Project not found.", "project_id");
    if (mine.role !== "admin") throw new V2Error(403, "authorization_error", "Only an admin of the project can move it into an organization.");
    const [already] = await db.select().from(eeOrgProjects).where(eq(eeOrgProjects.projectId, b.project_id)).limit(1);
    if (already?.orgId === m.org.id) throw new V2Error(409, "resource_already_exists", "The project is already in this organization.", "project_id");
    if (already) throw new V2Error(409, "resource_already_exists", "The project belongs to another organization. Move it out there first.", "project_id");
    // The project's data stays where it is: it is recorded in this deployment's region.
    await db.insert(eeOrgProjects).values({ projectId: b.project_id, orgId: m.org.id, region: ctx.regions.current, addedAt: deps.now() });
    forgetProjectRegion(b.project_id);
    // Everyone who already works on the project becomes an organization member, so seats and access reviews see them.
    for (const pm of await db.select().from(schema.memberships).where(eq(schema.memberships.projectId, b.project_id))) {
      await db.insert(eeOrgMembers).values({ orgId: m.org.id, userId: pm.userId, role: "member", source: "project", createdAt: deps.now() }).onConflictDoNothing();
    }
    await reconcileOrg(db, m.org.id);
    const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, b.project_id));
    await audit(m.org.id, m.user.id, "project_added", { type: "project", id: b.project_id }, { name: p?.name });
    return c.json({ object: "organization_project", id: b.project_id, name: p?.name ?? null, region: ctx.regions.current }, 201);
  });

  const orgProject = async (orgId: string, projectId: string) => {
    const [p] = await db.select().from(eeOrgProjects).where(and(eq(eeOrgProjects.orgId, orgId), eq(eeOrgProjects.projectId, projectId))).limit(1);
    if (!p) throw new V2Error(404, "resource_missing", "Project not found.");
    return p;
  };

  r.delete(`${O}/projects/:project_id`, async (c) => {
    const m = await admin(c);
    const p = await orgProject(m.org.id, c.req.param("project_id")!);
    await db.delete(eeOrgProjects).where(eq(eeOrgProjects.projectId, p.projectId));
    forgetProjectRegion(p.projectId);
    // Memberships stay as they are; custom roles of this organization no longer apply there, so they become Viewer.
    await db.delete(eeMembershipSources).where(eq(eeMembershipSources.projectId, p.projectId));
    await demoteRoles(db, [p.projectId]);
    await audit(m.org.id, m.user.id, "project_removed", { type: "project", id: p.projectId });
    return c.json({ object: "organization_project", id: p.projectId, deleted_at: deps.now().getTime() });
  });

  r.post(`${O}/projects/:project_id/region`, async (c) => {
    const m = await admin(c);
    needFeature(ctx, "data_location", m.features);
    const p = await orgProject(m.org.id, c.req.param("project_id")!);
    const b = await body(c, RegionSet);
    if (b.region === p.region) return c.json({ object: "organization_project", id: p.projectId, region: p.region });
    if (!selectableRegions(ctx.regions, deps.edition === "cloud").includes(b.region)) {
      const there = ctx.regions.regions[b.region];
      throw new V2Error(422, "unprocessable_entity_error", there
        ? `A project's data stays in the region where it was created. Create projects for the ${REGION_NAMES[b.region]} region at ${there.app}, or ask RevenueDot support (support@revenuedot.app) to move this one.`
        : `The ${REGION_NAMES[b.region]} region is not available yet.`, "region");
    }
    await db.update(eeOrgProjects).set({ region: b.region }).where(eq(eeOrgProjects.projectId, p.projectId));
    forgetProjectRegion(p.projectId);
    await audit(m.org.id, m.user.id, "project_region_changed", { type: "project", id: p.projectId }, { from: p.region, to: b.region });
    return c.json({ object: "organization_project", id: p.projectId, region: b.region });
  });

  /** Role names for display: built-in names, else the custom role's name. */
  const roleNames = async (orgId: string) => {
    const roles = await db.select({ id: eeCustomRoles.id, name: eeCustomRoles.name }).from(eeCustomRoles).where(eq(eeCustomRoles.orgId, orgId));
    const map = new Map<string, string>([["admin", "Admin"], ["developer", "Developer"], ["viewer", "Viewer"], ...roles.map((x) => [x.id, x.name] as [string, string])]);
    return (role: string) => map.get(role) ?? "No access (role removed)";
  };

  r.get(`${O}/projects/:project_id/members`, async (c) => {
    const m = await member(c);
    const p = await orgProject(m.org.id, c.req.param("project_id")!);
    const name = await roleNames(m.org.id);
    const rows = await db.select({ m: schema.memberships, u: schema.users }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.projectId, p.projectId));
    const src = new Map((await db.select().from(eeMembershipSources).where(eq(eeMembershipSources.projectId, p.projectId))).map((s) => [s.userId, s.source]));
    return c.json(listOf(c, rows.map((x) => ({ object: "project_member", user_id: x.u.id, email: x.u.email, name: x.u.name, role: x.m.role, role_name: name(x.m.role), source: src.get(x.u.id) ?? "manual" })), null));
  });

  r.post(`${O}/projects/:project_id/members/:user_id`, async (c) => {
    const m = await member(c);
    const p = await orgProject(m.org.id, c.req.param("project_id")!);
    // Organization admins, or admins of this project.
    if (!isOrgAdmin(m.role)) {
      const [mine] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, m.user.id), eq(schema.memberships.projectId, p.projectId))).limit(1);
      if (mine?.role !== "admin") throw new V2Error(403, "authorization_error", "Only organization admins and project admins can change roles.");
    }
    const b = await body(c, MemberProjectRole);
    if (!isBuiltin(b.role)) {
      needFeature(ctx, "custom_roles", m.features);
      const [role] = await db.select().from(eeCustomRoles).where(and(eq(eeCustomRoles.id, b.role), eq(eeCustomRoles.orgId, m.org.id))).limit(1);
      if (!role || (role.projectId && role.projectId !== p.projectId)) throw paramError("Unknown role for this project.", "role");
    }
    const userId = c.req.param("user_id")!;
    const [t] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.projectId, p.projectId))).limit(1);
    if (!t) throw new V2Error(404, "resource_missing", "Collaborator not found. Invite them to the project first.");
    if (t.role === "admin" && b.role !== "admin") {
      const admins = await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.projectId, p.projectId), eq(schema.memberships.role, "admin")));
      if (admins.length <= 1) throw paramError("A project needs at least one admin. Make someone else an admin first.", "role");
      const [proj] = await db.select({ owner: schema.projects.ownerUserId }).from(schema.projects).where(eq(schema.projects.id, p.projectId));
      if (proj?.owner === userId) throw new V2Error(422, "unprocessable_entity_error", "The project owner must stay an Admin.", "role");
    }
    await db.update(schema.memberships).set({ role: b.role }).where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.projectId, p.projectId)));
    // Set by hand: provisioning leaves it alone from now on.
    await db.delete(eeMembershipSources).where(and(eq(eeMembershipSources.userId, userId), eq(eeMembershipSources.projectId, p.projectId)));
    await audit(m.org.id, m.user.id, "project_role_changed", { type: "user", id: userId }, { project_id: p.projectId, from: t.role, to: b.role });
    const name = await roleNames(m.org.id);
    return c.json({ object: "project_member", user_id: userId, project_id: p.projectId, role: b.role, role_name: name(b.role) });
  });

  // ---- Custom roles ----
  r.get(`${O}/scopes`, async (c) => { await member(c); return c.json({ object: "scope_catalogue", groups: SCOPE_GROUPS }); });

  const roleShape = (x: typeof eeCustomRoles.$inferSelect, used = 0) => ({
    object: "custom_role", id: x.id, name: x.name, description: x.description, scopes: x.scopes, project_id: x.projectId, member_count: used,
    created_at: x.createdAt.getTime(), updated_at: x.updatedAt.getTime(),
  });
  const checkScopes = (scopes: string[]) => {
    const bad = scopes.filter((s) => !ALL_SCOPES.has(s) || ADMIN_ONLY_SCOPES.has(s));
    if (bad.length) throw paramError(`Unknown or admin-only scope(s): ${bad.join(", ")}.`, "scopes");
    return [...new Set(scopes)].sort();
  };
  const checkRoleProject = async (orgId: string, projectId: string | null | undefined) => {
    if (projectId) await orgProject(orgId, projectId).catch(() => { throw paramError("project_id must be a project of this organization.", "project_id"); });
  };
  const findRole = async (orgId: string, roleId: string) => {
    const [x] = await db.select().from(eeCustomRoles).where(and(eq(eeCustomRoles.orgId, orgId), eq(eeCustomRoles.id, roleId))).limit(1);
    if (!x) throw new V2Error(404, "resource_missing", "Role not found.");
    return x;
  };
  const roleUse = async (roleIds: string[]) => roleIds.length
    ? new Map((await db.select({ role: schema.memberships.role, n: count() }).from(schema.memberships).where(inArray(schema.memberships.role, roleIds)).groupBy(schema.memberships.role)).map((x) => [x.role, Number(x.n)]))
    : new Map<string, number>();

  r.get(`${O}/roles`, async (c) => {
    const m = await member(c);
    needFeature(ctx, "custom_roles", m.features);
    const rows = await db.select().from(eeCustomRoles).where(eq(eeCustomRoles.orgId, m.org.id)).orderBy(eeCustomRoles.createdAt);
    const use = await roleUse(rows.map((x) => x.id));
    return c.json(listOf(c, rows.map((x) => roleShape(x, use.get(x.id) ?? 0)), null));
  });

  r.post(`${O}/roles`, async (c) => {
    const m = await admin(c);
    needFeature(ctx, "custom_roles", m.features);
    const b = await body(c, RoleBody);
    await checkRoleProject(m.org.id, b.project_id);
    const scopes = checkScopes(b.scopes);
    const [dupe] = await db.select({ id: eeCustomRoles.id }).from(eeCustomRoles).where(and(eq(eeCustomRoles.orgId, m.org.id), eq(eeCustomRoles.name, b.name))).limit(1);
    if (dupe) throw new V2Error(409, "resource_already_exists", `A role named ${b.name} already exists.`, "name");
    const now = deps.now();
    const [x] = await db.insert(eeCustomRoles).values({ id: id("role_"), orgId: m.org.id, projectId: b.project_id ?? null, name: b.name, description: b.description ?? null, scopes, createdAt: now, updatedAt: now }).returning();
    await audit(m.org.id, m.user.id, "role_created", { type: "custom_role", id: x!.id }, { name: x!.name, scopes });
    return c.json(roleShape(x!), 201);
  });

  r.get(`${O}/roles/:role_id`, async (c) => {
    const m = await member(c);
    needFeature(ctx, "custom_roles", m.features);
    const x = await findRole(m.org.id, c.req.param("role_id")!);
    return c.json(roleShape(x, (await roleUse([x.id])).get(x.id) ?? 0));
  });

  r.post(`${O}/roles/:role_id`, async (c) => {
    const m = await admin(c);
    needFeature(ctx, "custom_roles", m.features);
    const x = await findRole(m.org.id, c.req.param("role_id")!);
    const b = await body(c, RoleUpdate);
    const set: Partial<typeof eeCustomRoles.$inferInsert> = { updatedAt: deps.now() };
    if (b.name !== undefined && b.name !== x.name) {
      const [dupe] = await db.select({ id: eeCustomRoles.id }).from(eeCustomRoles).where(and(eq(eeCustomRoles.orgId, m.org.id), eq(eeCustomRoles.name, b.name))).limit(1);
      if (dupe) throw new V2Error(409, "resource_already_exists", `A role named ${b.name} already exists.`, "name");
      set.name = b.name;
    }
    if (b.description !== undefined) set.description = b.description;
    if (b.scopes !== undefined) set.scopes = checkScopes(b.scopes);
    if (b.project_id !== undefined && b.project_id !== x.projectId) {
      // Narrowing a role to one project would leave members elsewhere with a role that no longer applies.
      if ((await roleUse([x.id])).get(x.id)) throw paramError("A role in use cannot change its project. Create a new role instead.", "project_id");
      await checkRoleProject(m.org.id, b.project_id);
      set.projectId = b.project_id;
    }
    const [y] = await db.update(eeCustomRoles).set(set).where(eq(eeCustomRoles.id, x.id)).returning();
    await audit(m.org.id, m.user.id, "role_updated", { type: "custom_role", id: x.id }, { name: y!.name, scopes: y!.scopes });
    return c.json(roleShape(y!, (await roleUse([x.id])).get(x.id) ?? 0));
  });

  r.delete(`${O}/roles/:role_id`, async (c) => {
    const m = await admin(c);
    needFeature(ctx, "custom_roles", m.features);
    const x = await findRole(m.org.id, c.req.param("role_id")!);
    // Members with the role become Viewers; mappings that gave it are removed.
    await demoteRoles(db, (await orgProjects(m.org.id)).map((p) => p.projectId), [x.id]);
    await db.delete(eeRoleMappings).where(and(eq(eeRoleMappings.orgId, m.org.id), eq(eeRoleMappings.role, x.id)));
    await db.delete(eeCustomRoles).where(eq(eeCustomRoles.id, x.id));
    await reconcileOrg(db, m.org.id);
    await audit(m.org.id, m.user.id, "role_deleted", { type: "custom_role", id: x.id }, { name: x.name });
    return c.json({ object: "custom_role", id: x.id, deleted_at: deps.now().getTime() });
  });

  // ---- Group role mappings ----
  const mappingShape = (x: typeof eeRoleMappings.$inferSelect, name: (r: string) => string, projectName: string | null) => ({
    object: "role_mapping", id: x.id, group: x.groupName, project_id: x.projectId, project_name: projectName, role: x.role, role_name: name(x.role), created_at: x.createdAt.getTime(),
  });

  r.get(`${O}/role_mappings`, async (c) => {
    const m = await member(c);
    const rows = await db.select({ x: eeRoleMappings, p: schema.projects.name }).from(eeRoleMappings).innerJoin(schema.projects, eq(schema.projects.id, eeRoleMappings.projectId))
      .where(eq(eeRoleMappings.orgId, m.org.id)).orderBy(eeRoleMappings.groupKey, eeRoleMappings.createdAt);
    const name = await roleNames(m.org.id);
    return c.json(listOf(c, rows.map((r) => mappingShape(r.x, name, r.p)), null));
  });

  r.post(`${O}/role_mappings`, async (c) => {
    const m = await admin(c);
    const b = await body(c, MappingBody);
    await orgProject(m.org.id, b.project_id).catch(() => { throw paramError("project_id must be a project of this organization.", "project_id"); });
    if (!isBuiltin(b.role)) {
      needFeature(ctx, "custom_roles", m.features);
      const [role] = await db.select().from(eeCustomRoles).where(and(eq(eeCustomRoles.id, b.role), eq(eeCustomRoles.orgId, m.org.id))).limit(1);
      if (!role || (role.projectId && role.projectId !== b.project_id)) throw paramError("Unknown role for this project.", "role");
    }
    const key = b.group.trim().toLowerCase();
    const [existing] = await db.select().from(eeRoleMappings).where(and(eq(eeRoleMappings.orgId, m.org.id), eq(eeRoleMappings.groupKey, key), eq(eeRoleMappings.projectId, b.project_id))).limit(1);
    let row: typeof eeRoleMappings.$inferSelect;
    if (existing) [row] = (await db.update(eeRoleMappings).set({ role: b.role, groupName: b.group.trim() }).where(eq(eeRoleMappings.id, existing.id)).returning()) as [typeof eeRoleMappings.$inferSelect];
    else [row] = (await db.insert(eeRoleMappings).values({ id: id("map_"), orgId: m.org.id, groupName: b.group.trim(), groupKey: key, projectId: b.project_id, role: b.role, createdAt: deps.now() }).returning()) as [typeof eeRoleMappings.$inferSelect];
    const changed = await reconcileOrg(db, m.org.id);
    await audit(m.org.id, m.user.id, "role_mapping_saved", { type: "role_mapping", id: row.id }, { group: row.groupName, project_id: row.projectId, role: row.role, memberships_changed: changed });
    const [p] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, row.projectId));
    return c.json({ ...mappingShape(row, await roleNames(m.org.id), p?.name ?? null), memberships_changed: changed }, existing ? 200 : 201);
  });

  r.delete(`${O}/role_mappings/:mapping_id`, async (c) => {
    const m = await admin(c);
    const [x] = await db.delete(eeRoleMappings).where(and(eq(eeRoleMappings.orgId, m.org.id), eq(eeRoleMappings.id, c.req.param("mapping_id")!))).returning();
    if (!x) throw new V2Error(404, "resource_missing", "Role mapping not found.");
    const changed = await reconcileOrg(db, m.org.id);
    await audit(m.org.id, m.user.id, "role_mapping_deleted", { type: "role_mapping", id: x.id }, { group: x.groupName, project_id: x.projectId, memberships_changed: changed });
    return c.json({ object: "role_mapping", id: x.id, deleted_at: deps.now().getTime(), memberships_changed: changed });
  });

  // ---- Organization audit log ----
  r.get(`${O}/audit_logs`, async (c) => {
    const m = await admin(c);
    const { limit, startingAfter } = pageParams(c);
    const start = Number(c.req.query("start_time")), end = Number(c.req.query("end_time"));
    const conds = [eq(eeOrgAuditLogs.orgId, m.org.id)];
    if (Number.isFinite(start) && c.req.query("start_time")) conds.push(gte(eeOrgAuditLogs.occurredAt, new Date(start)));
    if (Number.isFinite(end) && c.req.query("end_time")) conds.push(lt(eeOrgAuditLogs.occurredAt, new Date(end)));
    if (startingAfter) {
      const [cur] = await db.select().from(eeOrgAuditLogs).where(and(eq(eeOrgAuditLogs.orgId, m.org.id), eq(eeOrgAuditLogs.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match an object in this list.", "starting_after");
      conds.push(sql`(${eeOrgAuditLogs.occurredAt}, ${eeOrgAuditLogs.id}) < (${cur.occurredAt}, ${cur.id})`);
    }
    const rows = await db.select().from(eeOrgAuditLogs).where(and(...conds)).orderBy(desc(eeOrgAuditLogs.occurredAt), desc(eeOrgAuditLogs.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const emails = await emailsOf(db, page.map((x) => x.actorId).filter((x): x is string => !!x));
    return c.json(listOf(c, page.map((x) => ({
      object: "organization_audit_log", id: x.id, action: x.action, actor: { type: x.actorType, id: x.actorId, email: x.actorId ? emails.get(x.actorId) ?? null : null },
      target: { type: x.targetType, id: x.targetId }, data: x.data, occurred_at: x.occurredAt.getTime(),
    })), rows.length > limit ? page[page.length - 1]!.id : null));
  });

  // ---- Compliance exports ----
  exportRoutes(r, ctx, { member: admin, orgProjects });

  // ---- SCIM token count for the overview (the token routes live in scim/routes.ts) ----
  r.get(`${O}/overview`, async (c) => {
    const m = await member(c);
    const [tokens] = await db.select({ n: count() }).from(eeScimTokens).where(and(eq(eeScimTokens.orgId, m.org.id), sql`${eeScimTokens.revokedAt} is null`));
    const conns = await db.select({ id: eeSsoConnections.id, kind: eeSsoConnections.kind, enabled: eeSsoConnections.enabled }).from(eeSsoConnections).where(eq(eeSsoConnections.orgId, m.org.id));
    const domains = await db.select({ d: eeSsoDomains.domain, v: eeSsoDomains.verifiedAt }).from(eeSsoDomains).where(eq(eeSsoDomains.orgId, m.org.id));
    return c.json({
      ...(await orgShape(m.org, m.role, m.features)), object: "organization_overview",
      sso: { connections: conns.length, enabled: conns.filter((x) => x.enabled).length, verified_domains: domains.filter((d) => d.v).map((d) => d.d) },
      scim: { active_tokens: Number(tokens?.n ?? 0) },
    });
  });

  return r;
}

export async function emailsOf(db: DB, userIds: string[]) {
  if (!userIds.length) return new Map<string, string>();
  const rows = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).where(inArray(schema.users.id, [...new Set(userIds)]));
  return new Map(rows.map((r) => [r.id, r.email]));
}
