// RevenueDot Enterprise (ee/LICENSE). SCIM 2.0 provisioning (RFC 7643, RFC 7644) for Okta, Microsoft Entra ID and other
// identity providers, plus the dashboard routes that manage SCIM tokens. Spec: prd/enterprise/PRD.md §6.
//
// Dashboard (session cookie, organization owners and admins):
//   GET    /v2/organizations/{org_id}/scim/tokens               tokens (never the secret)
//   POST   /v2/organizations/{org_id}/scim/tokens               create one {name}: returns the token once and the SCIM base URL
//   DELETE /v2/organizations/{org_id}/scim/tokens/{token_id}    revoke
//   GET    /v2/organizations/{org_id}/scim/groups               SCIM groups with member counts (the role-mapping editor suggests them)
// Identity provider (Authorization: Bearer rdscim_..., the token's organization):
//   GET /scim/v2/ServiceProviderConfig, /ResourceTypes[/{name}], /Schemas[/{id}]
//   GET|POST /scim/v2/Users, GET|PUT|PATCH|DELETE /scim/v2/Users/{id}
//   GET|POST /scim/v2/Groups, GET|PUT|PATCH|DELETE /scim/v2/Groups/{id}
//
// A User is a RevenueDot account in the organization. Its email must be on a domain the organization verified, so an
// identity provider can never claim someone else's account. active false (or DELETE) deprovisions: the person loses
// every membership in the organization's projects and every session. Group changes re-apply role mappings at once.
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { body, listOf, v2ErrorResponse } from "../../../apps/server/src/routes/v2/common.js";
import { eeOrgMembers, eeScimGroupMembers, eeScimGroups, eeScimTokens, eeScimUsers } from "../schema.js";
import { reconcileMember } from "../access.js";
import { deprovision, domainVerifiedFor, ensureOrgMember, ensureUser } from "../provision.js";
import { V2Error, id, ms, needFeature, normEmail, orgAudit, orgFeatures, orgMembership, publicBase, randomHex, requireOrgAdmin, sha256Hex, signedIn, type EeCtx } from "../util.js";
import { matches, mentions, parseFilter, ScimFilterError, simpleEq, type Filter } from "./filter.js";
import { applyPatch, parsePatchBody, ScimPatchError } from "./patch.js";
import {
  GROUP_SCHEMA, LIST_SCHEMA, MAX_RESULTS, ScimError, USER_SCHEMA, displayNameOf, emailOf, errorBody, groupInput, project,
  resourceTypes, schemaDocs, serviceProviderConfig, userInput, type GroupInput, type UserInput,
} from "./resources.js";

type UserRow = typeof eeScimUsers.$inferSelect;
type GroupRow = typeof eeScimGroups.$inferSelect;
type Ref = { value: string; display: string };
type Vars = { Variables: { scim: { orgId: string; tokenId: string } } };

const TOKEN = /^rdscim_[0-9a-f]{64}$/;
const CONTENT_TYPE = "application/scim+json";
const MAX_BODY = 1024 * 1024;
const TokenCreate = z.object({ name: z.string().trim().min(1, "must not be empty").max(100) });

const isUniqueViolation = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: unknown } | null;
  return !!x && (x.code === "23505" || (x.cause !== undefined && isUniqueViolation(x.cause)));
};

export function scimRoutes(ctx: EeCtx) {
  const { deps } = ctx;
  const { db } = deps;
  const r = new Hono<Vars>();

  r.onError((e, c) => {
    if (!new URL(c.req.url).pathname.startsWith("/scim/")) return v2ErrorResponse(c, e);
    if (e instanceof ScimError) return send(c, errorBody(e.status, e.message, e.scimType), e.status, e.status === 401 ? { "WWW-Authenticate": 'Bearer realm="RevenueDot SCIM"' } : {});
    if (e instanceof ScimFilterError) return send(c, errorBody(400, e.message, "invalidFilter"), 400);
    if (e instanceof ScimPatchError) return send(c, errorBody(400, e.message, e.scimType), 400);
    if (e instanceof V2Error) return send(c, errorBody(e.status, e.message), e.status);
    console.error(e);
    return send(c, errorBody(500, "There was an internal server error."), 500);
  });

  const send = (c: Context, obj: unknown, status = 200, headers: Record<string, string> = {}) =>
    c.body(JSON.stringify(obj), status as ContentfulStatusCode, { "content-type": CONTENT_TYPE, ...headers });

  // ---- Dashboard: tokens and groups ----

  const admin = async (c: Context) => {
    if (!ctx.cloud) needFeature(ctx, "scim");
    const { user, sessionId } = await signedIn(c, deps);
    const orgId = c.req.param("org_id")!;
    const features = await orgFeatures(ctx, orgId);
    const { org, member } = await orgMembership(db, orgId, user.id, { sessionId, features });
    requireOrgAdmin(member.role);
    // Cloud: the organization's plan must include SCIM (Enterprise).
    needFeature(ctx, "scim", features);
    return { user, org };
  };
  const tokenShape = (t: typeof eeScimTokens.$inferSelect) => ({
    object: "scim_token", id: t.id, name: t.name, prefix: t.prefix, created_by: t.createdBy,
    created_at: t.createdAt.getTime(), last_used_at: ms(t.lastUsedAt), revoked_at: ms(t.revokedAt),
  });
  const T = "/v2/organizations/:org_id/scim";

  r.get(`${T}/tokens`, async (c) => {
    const { org } = await admin(c);
    const rows = await db.select().from(eeScimTokens).where(eq(eeScimTokens.orgId, org.id)).orderBy(asc(eeScimTokens.createdAt));
    return c.json(listOf(c, rows.map(tokenShape), null));
  });

  r.post(`${T}/tokens`, async (c) => {
    const { user, org } = await admin(c);
    const b = await body(c, TokenCreate);
    const token = `rdscim_${randomHex(32)}`;
    const now = deps.now();
    const [row] = await db.insert(eeScimTokens).values({
      id: id("sct_"), orgId: org.id, name: b.name, tokenHash: await sha256Hex(token), prefix: token.slice(0, 13), createdBy: user.id, createdAt: now,
    }).returning();
    await orgAudit(db, now, { orgId: org.id, action: "scim_token_created", actor: { type: "user", id: user.id }, target: { type: "scim_token", id: row!.id }, data: { name: b.name, prefix: row!.prefix } });
    return c.json({ ...tokenShape(row!), token, base_url: `${publicBase(deps, c)}/scim/v2` }, 201);
  });

  r.delete(`${T}/tokens/:token_id`, async (c) => {
    const { user, org } = await admin(c);
    const [t] = await db.select().from(eeScimTokens).where(and(eq(eeScimTokens.orgId, org.id), eq(eeScimTokens.id, c.req.param("token_id")!))).limit(1);
    if (!t) throw new V2Error(404, "resource_missing", "SCIM token not found.");
    if (t.revokedAt) return c.json(tokenShape(t));
    const now = deps.now();
    const [row] = await db.update(eeScimTokens).set({ revokedAt: now }).where(eq(eeScimTokens.id, t.id)).returning();
    await orgAudit(db, now, { orgId: org.id, action: "scim_token_revoked", actor: { type: "user", id: user.id }, target: { type: "scim_token", id: t.id }, data: { name: t.name, prefix: t.prefix } });
    return c.json(tokenShape(row!));
  });

  r.get(`${T}/groups`, async (c) => {
    const { org } = await admin(c);
    const rows = await db.select({ g: eeScimGroups, n: count(eeScimGroupMembers.scimUserId) }).from(eeScimGroups)
      .leftJoin(eeScimGroupMembers, eq(eeScimGroupMembers.groupId, eeScimGroups.id))
      .where(eq(eeScimGroups.orgId, org.id)).groupBy(eeScimGroups.id).orderBy(asc(eeScimGroups.displayKey));
    return c.json(listOf(c, rows.map(({ g, n }) => ({
      object: "scim_group", id: g.id, display_name: g.displayName, external_id: g.externalId, member_count: Number(n),
      created_at: g.createdAt.getTime(), updated_at: g.updatedAt.getTime(),
    })), null));
  });

  // ---- SCIM: authentication ----

  r.use("/scim/v2/*", async (c, next) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
    if (!m) throw new ScimError(401, "Send the SCIM token as Authorization: Bearer <token>.");
    if (!TOKEN.test(m[1]!)) throw new ScimError(401, "This SCIM token is not valid.");
    const [t] = await db.select().from(eeScimTokens).where(eq(eeScimTokens.tokenHash, await sha256Hex(m[1]!))).limit(1);
    if (!t || t.revokedAt) throw new ScimError(401, "This SCIM token is not valid or was revoked.");
    // A token of an organization whose plan no longer includes SCIM stops working until the plan comes back (Cloud).
    if (!(await orgFeatures(ctx, t.orgId)).has("scim")) throw new ScimError(403, "SCIM provisioning is not part of this organization's RevenueDot plan. Contact sales at https://revenuedot.app/contact-sales.");
    const now = deps.now();
    if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() >= 60_000) await db.update(eeScimTokens).set({ lastUsedAt: now }).where(eq(eeScimTokens.id, t.id));
    c.set("scim", { orgId: t.orgId, tokenId: t.id });
    await next();
  });

  const S = "/scim/v2";
  const base = (c: Context) => `${publicBase(deps, c)}${S}`;
  const scimOf = (c: Context<Vars>) => c.get("scim");
  const audit = (c: Context<Vars>, action: string, target: { type: string; id: string }, data: Record<string, unknown>) =>
    orgAudit(db, deps.now(), { orgId: scimOf(c).orgId, action, actor: { type: "scim", id: scimOf(c).tokenId }, target, data });

  const readBody = async (c: Context): Promise<unknown> => {
    const text = await c.req.text();
    if (text.length > MAX_BODY) throw new ScimError(413, "The request body is larger than 1 MB.");
    if (!text.trim()) throw new ScimError(400, "The request body is empty.", "invalidSyntax");
    try { return JSON.parse(text); } catch { throw new ScimError(400, "The request body is not valid JSON.", "invalidSyntax"); }
  };

  const etag = (v: number) => `W/"${v}"`;
  /** If-Match: the client's copy must be the current version (412 otherwise). */
  const checkIfMatch = (c: Context, version: number) => {
    const h = c.req.header("if-match");
    if (!h) return;
    const tags = h.split(",").map((s) => s.trim());
    if (tags.includes("*") || tags.some((t) => t.replace(/^W\//, "") === `"${version}"`)) return;
    throw new ScimError(412, `The resource changed: its current version is ${etag(version)}.`);
  };
  const notModified = (c: Context, version: number) => {
    const h = c.req.header("if-none-match");
    return !!h && h.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(`"${version}"`);
  };

  /** startIndex (1-based), count (default 100, at most 200), filter, attributes, excludedAttributes. */
  const listParams = (c: Context) => {
    const si = Number.parseInt(c.req.query("startIndex") ?? "", 10);
    const ct = Number.parseInt(c.req.query("count") ?? "", 10);
    const raw = c.req.query("filter");
    return {
      startIndex: Number.isFinite(si) && si > 1 ? si : 1,
      count: Number.isFinite(ct) ? Math.min(MAX_RESULTS, Math.max(0, ct)) : 100,
      filter: raw && raw.trim() ? parseFilter(raw) : null,
      attributes: c.req.query("attributes") || undefined,
      excluded: c.req.query("excludedAttributes") || undefined,
    };
  };
  const listResponse = (c: Context, all: Record<string, unknown>[], p: ReturnType<typeof listParams>, coreSchema: string) => {
    const page = all.slice(p.startIndex - 1, p.startIndex - 1 + p.count);
    return send(c, { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex: p.startIndex, itemsPerPage: page.length, Resources: page.map((x) => project(x, coreSchema, p.attributes, p.excluded)) });
  };

  // ---- Discovery ----

  r.get(`${S}/ServiceProviderConfig`, (c) => send(c, serviceProviderConfig(base(c))));
  r.get(`${S}/ResourceTypes`, (c) => { const all = resourceTypes(base(c)); return send(c, { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex: 1, itemsPerPage: all.length, Resources: all }); });
  r.get(`${S}/ResourceTypes/:name`, (c) => {
    const x = resourceTypes(base(c)).find((t) => t.id.toLowerCase() === c.req.param("name").toLowerCase());
    if (!x) throw new ScimError(404, "Resource type not found.");
    return send(c, x);
  });
  r.get(`${S}/Schemas`, (c) => { const all = schemaDocs(base(c)); return send(c, { schemas: [LIST_SCHEMA], totalResults: all.length, startIndex: 1, itemsPerPage: all.length, Resources: all }); });
  r.get(`${S}/Schemas/:id`, (c) => {
    const x = schemaDocs(base(c)).find((s) => s.id.toLowerCase() === c.req.param("id").toLowerCase());
    if (!x) throw new ScimError(404, "Schema not found.");
    return send(c, x);
  });

  // ---- Users ----

  const groupsOfUsers = async (orgId: string, userIds?: string[]) => {
    const out = new Map<string, Ref[]>();
    if (userIds && !userIds.length) return out;
    const rows = await db.select({ u: eeScimGroupMembers.scimUserId, g: eeScimGroups.id, name: eeScimGroups.displayName }).from(eeScimGroupMembers)
      .innerJoin(eeScimGroups, eq(eeScimGroups.id, eeScimGroupMembers.groupId))
      .where(userIds ? and(eq(eeScimGroups.orgId, orgId), inArray(eeScimGroupMembers.scimUserId, userIds)) : eq(eeScimGroups.orgId, orgId));
    for (const x of rows) { const l = out.get(x.u) ?? []; l.push({ value: x.g, display: x.name }); out.set(x.u, l); }
    return out;
  };

  const userResource = (c: Context, u: UserRow, groups: Ref[]): Record<string, unknown> => {
    const b = base(c);
    const schemas = [USER_SCHEMA, ...Object.keys(u.data).filter((k) => /^urn:/i.test(k))];
    return {
      schemas, id: u.id, ...(u.externalId ? { externalId: u.externalId } : {}), userName: u.userName, ...u.data, active: u.active,
      ...(groups.length ? { groups: groups.map((g) => ({ value: g.value, display: g.display, $ref: `${b}/Groups/${g.value}` })) } : {}),
      meta: { resourceType: "User", created: u.createdAt.toISOString(), lastModified: u.updatedAt.toISOString(), location: `${b}/Users/${u.id}`, version: etag(u.version) },
    };
  };
  const sendUser = async (c: Context<Vars>, u: UserRow, status = 200) => {
    const groups = (await groupsOfUsers(u.orgId, [u.id])).get(u.id) ?? [];
    const res = userResource(c, u, groups);
    return send(c, project(res, USER_SCHEMA, c.req.query("attributes") || undefined, c.req.query("excludedAttributes") || undefined), status,
      { ETag: etag(u.version), ...(status === 201 ? { Location: `${base(c)}/Users/${u.id}` } : {}) });
  };
  const findUser = async (c: Context<Vars>) => {
    const [u] = await db.select().from(eeScimUsers).where(and(eq(eeScimUsers.orgId, scimOf(c).orgId), eq(eeScimUsers.id, c.req.param("id")!))).limit(1);
    if (!u) throw new ScimError(404, "User not found.");
    return u;
  };

  /** The email an input resolves to, on a domain the organization verified. */
  const verifiedEmail = async (orgId: string, input: UserInput) => {
    const email = emailOf(input);
    if (!email) throw new ScimError(400, "A RevenueDot account needs an email address: send emails[].value, or a userName that is an email address.", "invalidValue");
    if (!(await domainVerifiedFor(db, orgId, email))) {
      throw new ScimError(400, `${normEmail(email)} is not on a domain this organization verified. Verify the domain in the RevenueDot dashboard (Organization settings, Single sign-on) first.`, "invalidValue");
    }
    return normEmail(email);
  };

  /** Refuses to deactivate the organization's last active owner: the organization would have nobody to manage it. */
  const guardLastOwner = async (orgId: string, userId: string) => {
    const [m] = await db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))).limit(1);
    if (m?.role !== "owner" || !m.active) return;
    const [o] = await db.select({ n: count() }).from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.role, "owner"), eq(eeOrgMembers.active, true)));
    if (Number(o?.n ?? 0) <= 1) throw new ScimError(400, "This person is the organization's only owner; make someone else an owner in RevenueDot before deactivating them.", "mutability");
  };

  const userNameTaken = async (orgId: string, key: string, except?: string) => {
    const [x] = await db.select({ id: eeScimUsers.id }).from(eeScimUsers)
      .where(and(eq(eeScimUsers.orgId, orgId), eq(eeScimUsers.userNameKey, key), ...(except ? [ne(eeScimUsers.id, except)] : []))).limit(1);
    return !!x;
  };

  r.get(`${S}/Users`, async (c) => {
    const { orgId } = scimOf(c);
    const p = listParams(c);
    const eqf = p.filter ? simpleEq(p.filter) : null;
    const where = [eq(eeScimUsers.orgId, orgId)];
    // The lookups Okta and Entra make before every create use an index; the filter still runs on the rows below.
    if (eqf?.attr === "username" && typeof eqf.value === "string") where.push(eq(eeScimUsers.userNameKey, eqf.value.toLowerCase()));
    if (eqf?.attr === "externalid" && typeof eqf.value === "string") where.push(eq(eeScimUsers.externalId, eqf.value));
    if (eqf?.attr === "id" && typeof eqf.value === "string") where.push(eq(eeScimUsers.id, eqf.value));
    const rows = await db.select().from(eeScimUsers).where(and(...where)).orderBy(asc(eeScimUsers.createdAt), asc(eeScimUsers.id));
    const groups = await groupsOfUsers(orgId, rows.length <= 500 ? rows.map((u) => u.id) : undefined);
    let all = rows.map((u) => userResource(c, u, groups.get(u.id) ?? []));
    if (p.filter) all = all.filter((x) => matches(x, p.filter!, { coreSchema: USER_SCHEMA }));
    return listResponse(c, all, p, USER_SCHEMA);
  });

  r.get(`${S}/Users/:id`, async (c) => {
    const u = await findUser(c);
    if (notModified(c, u.version)) return c.body(null, 304, { ETag: etag(u.version) });
    return sendUser(c, u);
  });

  r.post(`${S}/Users`, async (c) => {
    const { orgId } = scimOf(c);
    const input = userInput(await readBody(c));
    const key = input.userName.toLowerCase();
    if (await userNameTaken(orgId, key)) throw new ScimError(409, `A user with userName "${input.userName}" already exists in this organization.`, "uniqueness");
    const email = await verifiedEmail(orgId, input);
    const now = deps.now();
    const { user, created } = await ensureUser(db, email, displayNameOf(input), now, orgId);
    const [linked] = await db.select({ id: eeScimUsers.id }).from(eeScimUsers).where(and(eq(eeScimUsers.orgId, orgId), eq(eeScimUsers.userId, user.id))).limit(1);
    if (linked) throw new ScimError(409, `Another SCIM user in this organization (${linked.id}) already uses ${email}.`, "uniqueness");
    if (!input.active) await guardLastOwner(orgId, user.id);
    let row: UserRow;
    try {
      [row] = (await db.insert(eeScimUsers).values({
        id: id("scu_", 16), orgId, userId: user.id, userName: input.userName, userNameKey: key, externalId: input.externalId, active: input.active,
        data: input.data, version: 1, createdAt: now, updatedAt: now,
      }).returning()) as [UserRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw new ScimError(409, `A user with userName "${input.userName}" or email ${email} already exists in this organization.`, "uniqueness");
      throw e;
    }
    if (input.active) await ensureOrgMember(db, orgId, user.id, "scim");
    else await deprovision(db, orgId, user.id);
    await audit(c, "scim_user_created", { type: "scim_user", id: row.id }, { scim_user_id: row.id, user_id: user.id, user_name: row.userName, email, active: row.active, account_created: created });
    return sendUser(c, row, 201);
  });

  /** Saves a full User (PUT, or a PATCH's result) and applies what changed: email, activation, memberships. */
  const saveUser = async (c: Context<Vars>, row: UserRow, input: UserInput) => {
    const { orgId } = scimOf(c);
    const key = input.userName.toLowerCase();
    if (key !== row.userNameKey && (await userNameTaken(orgId, key, row.id))) throw new ScimError(409, `A user with userName "${input.userName}" already exists in this organization.`, "uniqueness");
    const deactivating = row.active && !input.active;
    const reactivating = !row.active && input.active;
    const [account] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId)).limit(1);
    const resolved = emailOf(input);
    // A new address, or a reactivation, needs a verified domain again; deactivation always works, even after the
    // organization removed the domain.
    const email = resolved && normEmail(resolved) === account?.email && !reactivating ? normEmail(resolved) : await verifiedEmail(orgId, input);
    if (deactivating) await guardLastOwner(orgId, row.userId);

    // The account's own email follows only when the new address is free and the old one is also on this organization's domains.
    let emailChanged: string | null = null;
    if (account && account.email !== email && (await domainVerifiedFor(db, orgId, account.email))) {
      const [taken] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (!taken) { await db.update(schema.users).set({ email }).where(eq(schema.users.id, row.userId)); emailChanged = account.email; }
    }

    const now = deps.now();
    let saved: UserRow | undefined;
    try {
      [saved] = await db.update(eeScimUsers).set({
        userName: input.userName, userNameKey: key, externalId: input.externalId, active: input.active, data: input.data, version: row.version + 1, updatedAt: now,
      }).where(and(eq(eeScimUsers.id, row.id), eq(eeScimUsers.version, row.version))).returning();
    } catch (e) {
      if (isUniqueViolation(e)) throw new ScimError(409, `A user with userName "${input.userName}" already exists in this organization.`, "uniqueness");
      throw e;
    }
    if (!saved) throw new ScimError(412, "The resource changed while this request ran; read it again and retry.");

    if (deactivating) await deprovision(db, orgId, row.userId);
    else if (input.active) await ensureOrgMember(db, orgId, row.userId, "scim");
    const target = { type: "scim_user", id: row.id };
    const ids = { scim_user_id: row.id, user_id: row.userId, user_name: saved.userName };
    if (deactivating) await audit(c, "scim_user_deactivated", target, ids);
    if (reactivating) await audit(c, "scim_user_reactivated", target, ids);
    const changed = [
      row.userName !== saved.userName && "userName", row.externalId !== saved.externalId && "externalId",
      JSON.stringify(row.data) !== JSON.stringify(saved.data) && "attributes", emailChanged && "email",
    ].filter(Boolean);
    if (changed.length) await audit(c, "scim_user_updated", target, { ...ids, changed, ...(emailChanged ? { email_from: emailChanged, email_to: email } : {}) });
    return saved;
  };

  r.put(`${S}/Users/:id`, async (c) => {
    const u = await findUser(c);
    checkIfMatch(c, u.version);
    return sendUser(c, await saveUser(c, u, userInput(await readBody(c))));
  });

  r.patch(`${S}/Users/:id`, async (c) => {
    const u = await findUser(c);
    checkIfMatch(c, u.version);
    const ops = parsePatchBody(await readBody(c));
    const current = { schemas: [USER_SCHEMA], userName: u.userName, ...(u.externalId ? { externalId: u.externalId } : {}), active: u.active, ...structuredClone(u.data) };
    const next = applyPatch(current, ops, { coreSchema: USER_SCHEMA, readOnly: new Set(["id", "meta", "groups"]) });
    return sendUser(c, await saveUser(c, u, userInput(next)));
  });

  r.delete(`${S}/Users/:id`, async (c) => {
    const u = await findUser(c);
    checkIfMatch(c, u.version);
    const { orgId } = scimOf(c);
    if (u.active) await guardLastOwner(orgId, u.userId);
    await deprovision(db, orgId, u.userId);
    await db.delete(eeScimUsers).where(eq(eeScimUsers.id, u.id));
    await audit(c, "scim_user_deleted", { type: "scim_user", id: u.id }, { scim_user_id: u.id, user_id: u.userId, user_name: u.userName });
    return c.body(null, 204);
  });

  // ---- Groups ----

  const membersOf = async (orgId: string, groupIds?: string[]) => {
    const out = new Map<string, Ref[]>();
    if (groupIds && !groupIds.length) return out;
    const rows = await db.select({ g: eeScimGroupMembers.groupId, u: eeScimUsers.id, userName: eeScimUsers.userName, data: eeScimUsers.data }).from(eeScimGroupMembers)
      .innerJoin(eeScimUsers, eq(eeScimUsers.id, eeScimGroupMembers.scimUserId))
      .where(groupIds ? and(eq(eeScimUsers.orgId, orgId), inArray(eeScimGroupMembers.groupId, groupIds)) : eq(eeScimUsers.orgId, orgId))
      .orderBy(asc(eeScimUsers.userNameKey));
    for (const x of rows) {
      const l = out.get(x.g) ?? [];
      l.push({ value: x.u, display: typeof x.data.displayName === "string" && x.data.displayName ? x.data.displayName : x.userName });
      out.set(x.g, l);
    }
    return out;
  };

  const groupResource = (c: Context, g: GroupRow, members: Ref[] | null): Record<string, unknown> => {
    const b = base(c);
    return {
      schemas: [GROUP_SCHEMA], id: g.id, ...(g.externalId ? { externalId: g.externalId } : {}), displayName: g.displayName,
      ...(members ? { members: members.map((m) => ({ value: m.value, display: m.display, type: "User", $ref: `${b}/Users/${m.value}` })) } : {}),
      meta: { resourceType: "Group", created: g.createdAt.toISOString(), lastModified: g.updatedAt.toISOString(), location: `${b}/Groups/${g.id}`, version: etag(g.version) },
    };
  };
  const wantsMembers = (c: Context, f?: Filter | null) => {
    const ex = (c.req.query("excludedAttributes") ?? "").toLowerCase().split(",").map((s) => s.trim());
    return !ex.includes("members") || (!!f && mentions(f, "members"));
  };
  const sendGroup = async (c: Context<Vars>, g: GroupRow, status = 200) => {
    const members = wantsMembers(c) ? (await membersOf(g.orgId, [g.id])).get(g.id) ?? [] : null;
    return send(c, project(groupResource(c, g, members), GROUP_SCHEMA, c.req.query("attributes") || undefined, c.req.query("excludedAttributes") || undefined), status,
      { ETag: etag(g.version), ...(status === 201 ? { Location: `${base(c)}/Groups/${g.id}` } : {}) });
  };
  const findGroup = async (c: Context<Vars>) => {
    const [g] = await db.select().from(eeScimGroups).where(and(eq(eeScimGroups.orgId, scimOf(c).orgId), eq(eeScimGroups.id, c.req.param("id")!))).limit(1);
    if (!g) throw new ScimError(404, "Group not found.");
    return g;
  };

  /** Creates or replaces a group with its members, then re-applies role mappings for everyone whose groups changed. */
  const saveGroup = async (c: Context<Vars>, row: GroupRow | null, input: GroupInput): Promise<GroupRow> => {
    const { orgId } = scimOf(c);
    const key = input.displayName.toLowerCase();
    if (!row || key !== row.displayKey) {
      const [dup] = await db.select({ id: eeScimGroups.id }).from(eeScimGroups).where(and(eq(eeScimGroups.orgId, orgId), eq(eeScimGroups.displayKey, key))).limit(1);
      if (dup && dup.id !== row?.id) throw new ScimError(409, `A group named "${input.displayName}" already exists in this organization.`, "uniqueness");
    }
    const users = input.members.length
      ? await db.select({ id: eeScimUsers.id, userId: eeScimUsers.userId }).from(eeScimUsers).where(and(eq(eeScimUsers.orgId, orgId), inArray(eeScimUsers.id, input.members)))
      : [];
    const unknown = input.members.filter((m) => !users.some((u) => u.id === m));
    if (unknown.length) throw new ScimError(400, `Unknown member${unknown.length > 1 ? "s" : ""}: ${unknown.slice(0, 5).join(", ")}. Members must be SCIM Users of this organization.`, "invalidValue");

    const now = deps.now();
    let saved: GroupRow | undefined;
    try {
      if (row) {
        [saved] = await db.update(eeScimGroups).set({ displayName: input.displayName, displayKey: key, externalId: input.externalId, version: row.version + 1, updatedAt: now })
          .where(and(eq(eeScimGroups.id, row.id), eq(eeScimGroups.version, row.version))).returning();
        if (!saved) throw new ScimError(412, "The resource changed while this request ran; read it again and retry.");
      } else {
        [saved] = await db.insert(eeScimGroups).values({ id: id("scg_", 16), orgId, displayName: input.displayName, displayKey: key, externalId: input.externalId, version: 1, createdAt: now, updatedAt: now }).returning();
      }
    } catch (e) {
      if (isUniqueViolation(e)) throw new ScimError(409, `A group named "${input.displayName}" already exists in this organization.`, "uniqueness");
      throw e;
    }
    const g = saved!;
    const before = row ? (await db.select({ u: eeScimGroupMembers.scimUserId }).from(eeScimGroupMembers).where(eq(eeScimGroupMembers.groupId, g.id))).map((x) => x.u) : [];
    const want = new Set(input.members);
    const removed = before.filter((u) => !want.has(u));
    const added = input.members.filter((u) => !before.includes(u));
    if (removed.length) await db.delete(eeScimGroupMembers).where(and(eq(eeScimGroupMembers.groupId, g.id), inArray(eeScimGroupMembers.scimUserId, removed)));
    for (let i = 0; i < added.length; i += 500) {
      await db.insert(eeScimGroupMembers).values(added.slice(i, i + 500).map((u) => ({ groupId: g.id, scimUserId: u }))).onConflictDoNothing();
    }
    // A rename changes which role mappings match, so it affects every member.
    const renamed = !!row && row.displayKey !== key;
    const affected = new Set([...removed, ...added, ...(renamed ? [...before, ...input.members] : [])]);
    const changed = await reconcileScimUsers(orgId, [...affected]);
    const target = { type: "scim_group", id: g.id };
    if (!row) await audit(c, "scim_group_created", target, { scim_group_id: g.id, display_name: g.displayName, members: input.members.length, memberships_changed: changed });
    else if (renamed || row.displayName !== g.displayName || row.externalId !== g.externalId || removed.length || added.length) {
      await audit(c, "scim_group_updated", target, {
        scim_group_id: g.id, display_name: g.displayName, ...(row.displayName !== g.displayName ? { display_name_from: row.displayName } : {}),
        members_added: added, members_removed: removed, memberships_changed: changed,
      });
    }
    return g;
  };

  /** Re-applies role mappings for these SCIM users' accounts. */
  const reconcileScimUsers = async (orgId: string, scimUserIds: string[]) => {
    if (!scimUserIds.length) return 0;
    const rows = await db.select({ userId: eeScimUsers.userId }).from(eeScimUsers).where(and(eq(eeScimUsers.orgId, orgId), inArray(eeScimUsers.id, scimUserIds)));
    let n = 0;
    for (const x of rows) n += await reconcileMember(db, orgId, x.userId);
    return n;
  };

  r.get(`${S}/Groups`, async (c) => {
    const { orgId } = scimOf(c);
    const p = listParams(c);
    const eqf = p.filter ? simpleEq(p.filter) : null;
    const where = [eq(eeScimGroups.orgId, orgId)];
    if (eqf?.attr === "displayname" && typeof eqf.value === "string") where.push(eq(eeScimGroups.displayKey, eqf.value.toLowerCase()));
    if (eqf?.attr === "externalid" && typeof eqf.value === "string") where.push(eq(eeScimGroups.externalId, eqf.value));
    if (eqf?.attr === "id" && typeof eqf.value === "string") where.push(eq(eeScimGroups.id, eqf.value));
    const rows = await db.select().from(eeScimGroups).where(and(...where)).orderBy(asc(eeScimGroups.createdAt), asc(eeScimGroups.id));
    const members = wantsMembers(c, p.filter) ? await membersOf(orgId, rows.length <= 500 ? rows.map((g) => g.id) : undefined) : null;
    let all = rows.map((g) => groupResource(c, g, members ? members.get(g.id) ?? [] : null));
    if (p.filter) all = all.filter((x) => matches(x, p.filter!, { coreSchema: GROUP_SCHEMA }));
    return listResponse(c, all, p, GROUP_SCHEMA);
  });

  r.get(`${S}/Groups/:id`, async (c) => {
    const g = await findGroup(c);
    if (notModified(c, g.version)) return c.body(null, 304, { ETag: etag(g.version) });
    return sendGroup(c, g);
  });

  r.post(`${S}/Groups`, async (c) => sendGroup(c, await saveGroup(c, null, groupInput(await readBody(c))), 201));

  r.put(`${S}/Groups/:id`, async (c) => {
    const g = await findGroup(c);
    checkIfMatch(c, g.version);
    return sendGroup(c, await saveGroup(c, g, groupInput(await readBody(c))));
  });

  r.patch(`${S}/Groups/:id`, async (c) => {
    const g = await findGroup(c);
    checkIfMatch(c, g.version);
    const ops = parsePatchBody(await readBody(c));
    const members = (await membersOf(g.orgId, [g.id])).get(g.id) ?? [];
    const current = { schemas: [GROUP_SCHEMA], displayName: g.displayName, ...(g.externalId ? { externalId: g.externalId } : {}), members: members.map((m) => ({ value: m.value })) };
    const next = applyPatch(current, ops, { coreSchema: GROUP_SCHEMA, readOnly: new Set(["id", "meta"]) });
    return sendGroup(c, await saveGroup(c, g, groupInput(next)));
  });

  r.delete(`${S}/Groups/:id`, async (c) => {
    const g = await findGroup(c);
    checkIfMatch(c, g.version);
    const { orgId } = scimOf(c);
    const former = (await db.select({ u: eeScimGroupMembers.scimUserId }).from(eeScimGroupMembers).where(eq(eeScimGroupMembers.groupId, g.id))).map((x) => x.u);
    await db.delete(eeScimGroups).where(eq(eeScimGroups.id, g.id));
    const changed = await reconcileScimUsers(orgId, former);
    await audit(c, "scim_group_deleted", { type: "scim_group", id: g.id }, { scim_group_id: g.id, display_name: g.displayName, members: former.length, memberships_changed: changed });
    return c.body(null, 204);
  });

  r.all(`${S}/*`, () => { throw new ScimError(404, "This SCIM endpoint does not exist. Bulk and /Me are not supported."); });

  return r;
}

