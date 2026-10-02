// RevenueDot Enterprise (ee/LICENSE). Shared helpers for the enterprise routes.
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import type { DB } from "@revenuedot/db";
import type { Deps } from "../../apps/server/src/context.js";
import { SESSION_COOKIE, sessionUser } from "../../apps/server/src/services/sessions.js";
import { V2Error } from "../../apps/server/src/routes/v2/common.js";
import { eeOrgAuditLogs, eeOrgMembers, eeOrganizations } from "./schema.js";
import type { Feature } from "./license.js";

export { V2Error };
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const BUILTIN_ROLES = ["admin", "developer", "viewer"] as const;

export const id = (prefix: string, len = 12) => newId(prefix, len);
export const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
export const normEmail = (e: string) => e.trim().toLowerCase();
export const emailDomain = (e: string) => normEmail(e).split("@")[1] ?? "";

/** What every enterprise route needs: the app's dependencies and the licence's features. */
export interface EeCtx {
  deps: Deps;
  features: Set<Feature>;
  /** Where the data of each region is served (region.ts); empty on self-hosted servers. */
  regions: import("./region.js").RegionConfig;
}

export function needFeature(ctx: EeCtx, f: Feature) {
  if (!ctx.features.has(f)) throw new V2Error(403, "authorization_error", `Your RevenueDot Enterprise licence does not include ${f.replace(/_/g, " ")}.`);
}

/** The signed-in dashboard user (session cookie). Writes must come from the dashboard's own origin, like the core API. */
export async function signedIn(c: Context, deps: Deps) {
  const site = c.req.header("sec-fetch-site");
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && (site === "cross-site" || site === "same-site")) {
    throw new V2Error(403, "authorization_error", "Dashboard requests must come from the dashboard.");
  }
  const sid = getCookie(c, SESSION_COOKIE) ?? null;
  const user = await sessionUser(deps.db, sid ?? undefined, deps.now());
  if (!user) throw new V2Error(401, "authentication_error", "Not signed in.");
  return { user, sessionId: sid };
}

/** The caller's membership in an organization; other organizations answer 404 so ids cannot be probed. */
export async function orgMembership(db: DB, orgId: string, userId: string) {
  const [row] = await db.select({ org: eeOrganizations, member: eeOrgMembers }).from(eeOrgMembers)
    .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgMembers.orgId))
    .where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))).limit(1);
  if (!row || !row.member.active) throw new V2Error(404, "resource_missing", "Organization not found.");
  return row;
}

export const isOrgAdmin = (role: string) => role === "owner" || role === "admin";

export function requireOrgAdmin(role: string) {
  if (!isOrgAdmin(role)) throw new V2Error(403, "authorization_error", "Only organization owners and admins can do this.");
}

export function requireOwner(role: string) {
  if (role !== "owner") throw new V2Error(403, "authorization_error", "Only organization owners can do this.");
}

/** Writes one organization audit log row. Never stores secrets: callers pass ids and names only. */
export async function orgAudit(db: DB, now: Date, e: { orgId: string; action: string; actor: { type: "user" | "scim" | "sso" | "system"; id?: string | null }; target: { type: string; id?: string | null }; data?: Record<string, unknown> }) {
  await db.insert(eeOrgAuditLogs).values({
    id: id("oal_", 16), orgId: e.orgId, action: e.action, actorType: e.actor.type, actorId: e.actor.id ?? null,
    targetType: e.target.type, targetId: e.target.id ?? null, data: e.data ?? {}, occurredAt: now,
  });
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The dashboard origin for links and SSO callbacks: REVENUEDOT_PUBLIC_URL, else the request's origin. */
export function publicBase(deps: Deps, c: Context): string {
  if (deps.publicUrl) return deps.publicUrl.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const host = c.req.header("x-forwarded-host") ?? url.host;
  const proto = (c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0]!.trim();
  return `${proto === "http" ? "http" : "https"}://${host}`;
}
