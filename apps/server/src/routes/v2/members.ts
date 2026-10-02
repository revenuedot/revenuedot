import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { linkBase, needsVerification, requestOrigin } from "../../services/account-email.js";
import { ROLES, adminCount, apiRole, createInvite, inviteShape, normEmail, openInvites, resendInvite } from "../../services/members.js";
import { hit } from "../../services/rate-limit.js";
import { V2Error, body, listOf, notFound, paramError, scope, type V2Context, type V2Router } from "./common.js";

/**
 * Project members and invites (extension; dashboard session only). Spec: prd/account-email/PRD.md
 *   GET    /v2/projects/{project_id}/invites                               open invites (pending or expired)
 *   POST   /v2/projects/{project_id}/invites                               invite by email with a role (admins; verified email on Cloud)
 *   POST   /v2/projects/{project_id}/invites/{invite_id}/actions/resend    new link, 7 more days (admins)
 *   DELETE /v2/projects/{project_id}/invites/{invite_id}                   revoke (admins)
 *   POST   /v2/projects/{project_id}/collaborators/{user_id}               change a member's role (admins)
 *   DELETE /v2/projects/{project_id}/collaborators/{user_id}               remove a member (admins), or leave the project (yourself)
 * A project always keeps at least one admin, and its owner stays an admin member until they transfer ownership
 * (prd/project-settings §1): otherwise another admin could remove or demote the owner and then take the project over.
 */

const Role = z.enum(ROLES);
const InviteCreate = z.object({ email: z.string().trim().email("must be a valid email address").max(320), role: Role });
const RoleUpdate = z.object({ role: Role });
/** Invites per project per day, so a compromised account cannot turn the server into a mail cannon. */
export const INVITE_LIMIT = { perProject: 50, windowMs: 86400_000 };

export function memberRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";

  const signedIn = (c: V2Context) => {
    const p = c.get("principal");
    if (p.kind !== "user") throw new V2Error(403, "authorization_error", "Members and invites are managed from the dashboard. Secret API keys cannot change them.");
    return p;
  };
  const admin = async (c: V2Context) => {
    const p = signedIn(c);
    if (p.role !== "admin") throw new V2Error(403, "authorization_error", "Only project admins can manage members and invites.");
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, p.userId));
    if (!u) throw new V2Error(401, "authentication_error", "Not signed in.");
    return u;
  };
  const base = (c: V2Context) => linkBase(deps, requestOrigin(c.req.url, (n) => c.req.header(n)));
  const findInvite = async (c: V2Context) => {
    const [i] = await db.select().from(schema.invites).where(and(eq(schema.invites.projectId, c.get("projectId")), eq(schema.invites.id, c.req.param("invite_id")!))).limit(1);
    if (!i || i.acceptedAt || i.revokedAt) throw notFound("Invite");
    return i;
  };
  const findMember = async (c: V2Context) => {
    const [m] = await db.select().from(schema.memberships).where(and(eq(schema.memberships.projectId, c.get("projectId")), eq(schema.memberships.userId, c.req.param("user_id")!))).limit(1);
    if (!m) throw notFound("Collaborator");
    return m;
  };
  const ownerOf = async (projectId: string) => {
    const [p] = await db.select({ owner: schema.projects.ownerUserId }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    return p?.owner ?? null;
  };
  const collaborator = async (userId: string, role: string) => {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return { object: "collaborator", id: userId, name: u?.name ?? null, email: u?.email ?? null, role: apiRole(role), accepted_at: u ? u.createdAt.getTime() : null, has_mfa: !!u?.totpEnabledAt && !!u?.totpSecret };
  };

  r.get(`${P}/invites`, scope("project_configuration:collaborators:read"), async (c) => {
    signedIn(c);
    const now = deps.now();
    const rows = (await openInvites(db, c.get("projectId"))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return c.json(listOf(c, rows.map((i) => inviteShape(i, now)), null));
  });

  r.post(`${P}/invites`, async (c) => {
    const u = await admin(c);
    if (needsVerification(deps, u)) throw new V2Error(403, "authorization_error", "Confirm your email address before inviting people. We sent you a link when you signed up; you can send a new one from the banner.");
    const b = await body(c, InviteCreate);
    const projectId = c.get("projectId");
    const email = normEmail(b.email);
    const [member] = await db.select({ id: schema.users.id }).from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(and(eq(schema.memberships.projectId, projectId), eq(schema.users.email, email))).limit(1);
    if (member) throw new V2Error(409, "resource_already_exists", `${email} is already a member of this project.`, "email");
    if (!(await hit(db, `invite:project:${projectId}`, INVITE_LIMIT.perProject, INVITE_LIMIT.windowMs, deps.now()))) {
      throw new V2Error(429, "rate_limit_error", "This project sent too many invites today. Try again tomorrow.", undefined, true);
    }
    const { invite, sent } = await createInvite(deps, { projectId, email, role: b.role, inviter: u, base: base(c) });
    return c.json({ ...inviteShape(invite, deps.now()), email_sent: sent }, 201);
  });

  r.post(`${P}/invites/:invite_id/actions/resend`, async (c) => {
    const u = await admin(c);
    const i = await findInvite(c);
    if (!(await hit(db, `invite:project:${i.projectId}`, INVITE_LIMIT.perProject, INVITE_LIMIT.windowMs, deps.now()))) {
      throw new V2Error(429, "rate_limit_error", "This project sent too many invites today. Try again tomorrow.", undefined, true);
    }
    const { invite, sent } = await resendInvite(deps, i, u, base(c));
    return c.json({ ...inviteShape(invite, deps.now()), email_sent: sent });
  });

  r.delete(`${P}/invites/:invite_id`, async (c) => {
    await admin(c);
    const i = await findInvite(c);
    const now = deps.now();
    await db.update(schema.invites).set({ revokedAt: now }).where(eq(schema.invites.id, i.id));
    return c.json({ object: "invite", id: i.id, deleted_at: now.getTime() });
  });

  r.post(`${P}/collaborators/:user_id`, async (c) => {
    await admin(c);
    const m = await findMember(c);
    const b = await body(c, RoleUpdate);
    if (m.role === "admin" && b.role !== "admin" && (await adminCount(db, m.projectId)) <= 1) {
      throw paramError("A project needs at least one admin. Make someone else an admin first.", "role");
    }
    if (b.role !== "admin" && (await ownerOf(m.projectId)) === m.userId) {
      throw new V2Error(422, "unprocessable_entity_error", "The project owner must stay an Admin. The owner can transfer ownership first in Project settings.", "role");
    }
    await db.update(schema.memberships).set({ role: b.role }).where(and(eq(schema.memberships.projectId, m.projectId), eq(schema.memberships.userId, m.userId)));
    return c.json(await collaborator(m.userId, b.role));
  });

  r.delete(`${P}/collaborators/:user_id`, async (c) => {
    const p = signedIn(c);
    const m = await findMember(c);
    // Anyone may leave; removing someone else takes an admin.
    if (m.userId !== p.userId) await admin(c);
    if (m.role === "admin" && (await adminCount(db, m.projectId)) <= 1) {
      throw new V2Error(422, "unprocessable_entity_error", m.userId === p.userId ? "You are the only admin. Make someone else an admin before you leave, or delete the project." : "A project needs at least one admin.");
    }
    if ((await ownerOf(m.projectId)) === m.userId) {
      throw new V2Error(422, "unprocessable_entity_error", m.userId === p.userId
        ? "You own this project. Transfer ownership to another admin in Project settings before you leave."
        : "The project owner cannot be removed. The owner can transfer ownership first in Project settings.");
    }
    await db.delete(schema.memberships).where(and(eq(schema.memberships.projectId, m.projectId), eq(schema.memberships.userId, m.userId)));
    return c.json({ object: "collaborator", id: m.userId, deleted_at: deps.now().getTime() });
  });
}
