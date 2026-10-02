// RevenueDot Enterprise (ee/LICENSE). Accounts and organization memberships created by single sign-on (just-in-time)
// and SCIM. Spec: prd/enterprise/PRD.md §7.
import { and, eq } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import { eeOrgMembers, eeSsoDomains } from "./schema.js";
import { emailDomain, normEmail } from "./util.js";
import { endSessions, reconcileMember } from "./access.js";

/** The organization that verified this address's domain, if any. */
export async function orgForEmail(db: DB, email: string): Promise<string | null> {
  const d = emailDomain(email);
  if (!d) return null;
  const [row] = await db.select({ orgId: eeSsoDomains.orgId, verifiedAt: eeSsoDomains.verifiedAt }).from(eeSsoDomains).where(eq(eeSsoDomains.domain, d)).limit(1);
  return row?.verifiedAt ? row.orgId : null;
}

/** Whether the organization verified this address's domain. Single sign-on only ever signs in such addresses. */
export async function domainVerifiedFor(db: DB, orgId: string, email: string): Promise<boolean> {
  return (await orgForEmail(db, email)) === orgId;
}

/**
 * The account for an address, created without a password when there is none (it signs in with single sign-on).
 * The address counts as verified: the organization proved it owns the domain and its identity provider vouched for it.
 *
 * An existing account whose address was never verified may have been registered in advance by someone else (sign-up
 * is open on Cloud): that person never proved they read the inbox, so its password and sessions end before the real
 * owner is signed in, or they would share the account. Owners and admins of `orgId` keep theirs: the organization's
 * own admins put them there (a self-hosted server's first account is never verified).
 */
export async function ensureUser(db: DB, emailRaw: string, name: string | null, now: Date, orgId: string): Promise<{ user: typeof schema.users.$inferSelect; created: boolean }> {
  const email = normEmail(emailRaw);
  const [found] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (found) {
    const [m] = found.emailVerifiedAt ? [] : await db.select({ role: eeOrgMembers.role, active: eeOrgMembers.active }).from(eeOrgMembers)
      .where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, found.id))).limit(1);
    const trusted = !!m?.active && (m.role === "owner" || m.role === "admin");
    if (!found.emailVerifiedAt && !trusted) {
      await db.update(schema.users).set({ emailVerifiedAt: now, passwordHash: null }).where(eq(schema.users.id, found.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, found.id));
    } else if (!found.emailVerifiedAt) {
      await db.update(schema.users).set({ emailVerifiedAt: now }).where(eq(schema.users.id, found.id));
    }
    if (!found.name && name) await db.update(schema.users).set({ name }).where(eq(schema.users.id, found.id));
    return { user: { ...found, emailVerifiedAt: found.emailVerifiedAt ?? now, passwordHash: found.emailVerifiedAt || trusted ? found.passwordHash : null, name: found.name ?? name }, created: false };
  }
  const [user] = await db.insert(schema.users).values({ id: newId("usr_", 16), email, name, passwordHash: null, emailVerifiedAt: now }).onConflictDoNothing().returning();
  if (user) return { user, created: true };
  // Another request created it first.
  const [again] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return { user: again!, created: false };
}

/** Makes the account an active organization member (role "member" when new), then applies its group role mappings. */
export async function ensureOrgMember(db: DB, orgId: string, userId: string, source: "sso" | "scim" | "manual" | "project", o: { ssoGroups?: string[]; now?: Date } = {}) {
  const [m] = await db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))).limit(1);
  const set: Partial<typeof eeOrgMembers.$inferInsert> = {};
  if (o.ssoGroups) { set.ssoGroups = o.ssoGroups.map((g) => g.trim()).filter(Boolean).slice(0, 200); set.lastSsoAt = o.now ?? new Date(); }
  if (!m) {
    await db.insert(eeOrgMembers).values({ orgId, userId, role: "member", source, active: true, ...set }).onConflictDoNothing();
  } else {
    if (source === "scim" && !m.active) set.active = true;
    if (Object.keys(set).length) await db.update(eeOrgMembers).set(set).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId)));
  }
  await reconcileMember(db, orgId, userId);
}

/**
 * Deprovisioning (SCIM `active: false` or DELETE): the person loses every membership in the organization's projects
 * and every session at once. The account and the audit history stay.
 */
export async function deprovision(db: DB, orgId: string, userId: string) {
  await db.update(eeOrgMembers).set({ active: false }).where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId)));
  await reconcileMember(db, orgId, userId);
  await endSessions(db, userId);
}
