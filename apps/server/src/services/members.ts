import { and, eq, gt, isNull } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { trySend } from "../mail/index.js";
import { inviteEmail } from "../mail/templates.js";
import { randomToken } from "./account-email.js";
import { sha256Hex } from "./auth.js";

/**
 * Project members and invites (prd/account-email/PRD.md). Roles, from RevenueCat's collaborator roles:
 *   admin      everything, including invites, members, secret API keys and deleting the project
 *   developer  edits apps, catalog, customers and integrations; no secret API keys, members or project deletion
 *   viewer     read only (RevenueCat's "View Only")
 */
export const ROLES = ["admin", "developer", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const INVITE_TTL_DAYS = 7;

/** RevenueCat's collaborator role names in API v2. Any other role (a custom role id from an extension) is returned as it is. */
export const apiRole = (role: string) => (role === "viewer" ? "read_only" : role);

export const normEmail = (e: string) => e.trim().toLowerCase();

type InviteRow = typeof schema.invites.$inferSelect;

export function inviteShape(i: InviteRow, now: Date) {
  return {
    object: "invite" as const, id: i.id, email: i.email, role: i.role,
    status: i.acceptedAt ? "accepted" : i.revokedAt ? "revoked" : i.expiresAt <= now ? "expired" : "pending",
    invited_by: i.invitedBy, created_at: i.createdAt.getTime(), last_sent_at: i.lastSentAt.getTime(), expires_at: i.expiresAt.getTime(),
  };
}

/** Invites not yet accepted or revoked (expired ones stay listed so they can be resent). */
export async function openInvites(db: DB, projectId: string) {
  return db.select().from(schema.invites).where(and(eq(schema.invites.projectId, projectId), isNull(schema.invites.acceptedAt), isNull(schema.invites.revokedAt)));
}

async function sendInvite(deps: Deps, invite: InviteRow, token: string, base: string, inviterName: string) {
  const [project] = await deps.db.select().from(schema.projects).where(eq(schema.projects.id, invite.projectId));
  const mail = inviteEmail({ base, url: `${base}/invite?token=${encodeURIComponent(token)}`, projectName: project?.name ?? "a project", inviter: inviterName, role: invite.role, expiresInDays: INVITE_TTL_DAYS });
  return trySend(deps.mailer, { to: invite.email, ...mail });
}

export const displayName = (u: { name: string | null; email: string }) => u.name?.trim() || u.email;

/** Creates an invite, or refreshes the open one for the same address (new link and role), and emails it. */
export async function createInvite(deps: Deps, o: { projectId: string; email: string; role: Role; inviter: { id: string; name: string | null; email: string }; base: string }) {
  const now = deps.now();
  const email = normEmail(o.email);
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 86400_000);
  const [open] = (await openInvites(deps.db, o.projectId)).filter((i) => i.email === email);
  let row: InviteRow;
  if (open) {
    [row] = await deps.db.update(schema.invites).set({ role: o.role, tokenHash: await sha256Hex(token), expiresAt, lastSentAt: now, invitedBy: o.inviter.id })
      .where(eq(schema.invites.id, open.id)).returning() as [InviteRow];
  } else {
    [row] = await deps.db.insert(schema.invites).values({ id: newId("inv_", 12), projectId: o.projectId, email, role: o.role, tokenHash: await sha256Hex(token), invitedBy: o.inviter.id, expiresAt, lastSentAt: now, createdAt: now }).returning() as [InviteRow];
  }
  const sent = await sendInvite(deps, row, token, o.base, displayName(o.inviter));
  return { invite: row, sent };
}

/** A new link (the old one stops working) and a fresh 7 days. */
export async function resendInvite(deps: Deps, invite: InviteRow, inviter: { id: string; name: string | null; email: string }, base: string) {
  const now = deps.now();
  const token = randomToken();
  const [row] = await deps.db.update(schema.invites).set({ tokenHash: await sha256Hex(token), expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 86400_000), lastSentAt: now })
    .where(eq(schema.invites.id, invite.id)).returning() as [InviteRow];
  const sent = await sendInvite(deps, row, token, base, displayName(inviter));
  return { invite: row, sent };
}

export type InviteLookup =
  | { ok: true; invite: InviteRow; project: typeof schema.projects.$inferSelect; inviter: { name: string | null; email: string } | null }
  | { ok: false; reason: "invalid" | "expired" | "accepted" | "revoked" };

export async function inviteByToken(db: DB, token: string, now: Date): Promise<InviteLookup> {
  if (!token || token.length > 200) return { ok: false, reason: "invalid" };
  const [row] = await db.select({ i: schema.invites, p: schema.projects }).from(schema.invites)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.invites.projectId))
    .where(eq(schema.invites.tokenHash, await sha256Hex(token))).limit(1);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.i.acceptedAt) return { ok: false, reason: "accepted" };
  if (row.i.revokedAt) return { ok: false, reason: "revoked" };
  if (row.i.expiresAt <= now) return { ok: false, reason: "expired" };
  const [inviter] = row.i.invitedBy ? await db.select({ name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, row.i.invitedBy)) : [];
  return { ok: true, invite: row.i, project: row.p, inviter: inviter ?? null };
}

/**
 * Adds the user to the project with the invite's role and marks the invite accepted, once. An existing member keeps
 * their current role (an invite never demotes anyone). Returns false when someone else accepted it first.
 */
export async function acceptInvite(db: DB, invite: InviteRow, userId: string, now: Date): Promise<boolean> {
  const done = await db.update(schema.invites).set({ acceptedAt: now, acceptedBy: userId })
    .where(and(eq(schema.invites.id, invite.id), isNull(schema.invites.acceptedAt), isNull(schema.invites.revokedAt), gt(schema.invites.expiresAt, now))).returning({ id: schema.invites.id });
  if (!done.length) return false;
  await db.insert(schema.memberships).values({ userId, projectId: invite.projectId, role: invite.role }).onConflictDoNothing();
  return true;
}

export async function adminCount(db: DB, projectId: string) {
  const rows = await db.select({ u: schema.memberships.userId }).from(schema.memberships).where(and(eq(schema.memberships.projectId, projectId), eq(schema.memberships.role, "admin")));
  return rows.length;
}
