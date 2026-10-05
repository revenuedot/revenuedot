// RevenueDot Enterprise (ee/LICENSE). Shared helpers for the enterprise routes.
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import type { DB } from "@revenuedot/db";
import type { Deps } from "../../apps/server/src/context.js";
import { SESSION_COOKIE, sessionUser } from "../../apps/server/src/services/sessions.js";
import { V2Error } from "../../apps/server/src/routes/v2/common.js";
import { schema } from "@revenuedot/db";
import { eeOrgAuditLogs, eeOrgMembers, eeOrganizations, eeSsoDomains, eeSsoSessions } from "./schema.js";
import { FEATURES, type Feature } from "./license.js";
import { orgPlan, planFeatures, planFor, userPlan, type CloudPlans } from "./plans.js";
import { planOf, type PlanId } from "../../apps/server/src/services/billing/plans.js";

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
  /** Organizations the licence allows on this server (null: any number). */
  maxOrgs?: number | null;
  /** RevenueDot Cloud: each organization's features come from its plan (plans.ts), not from `features`. Absent when self-hosted. */
  cloud?: CloudPlans;
}

export const FEATURE_NAMES: Record<Feature, string> = {
  organizations: "Organizations", custom_roles: "Custom roles", sso: "Single sign-on", scim: "SCIM provisioning",
  data_location: "Data location", audit_retention: "Audit log retention", compliance_exports: "Compliance exports",
};
const PLURAL = new Set<Feature>(["organizations", "custom_roles", "compliance_exports"]);

/** "Custom roles are part of Pro. Start Pro in Billing." The words the dashboard and the API use for a locked feature. */
export function lockedMessage(f: Feature, plan: PlanId): string {
  const where = plan === "pro" ? "Pro, which costs $0 until your apps make $10,000 a month. Start Pro in Billing" : "Enterprise. Contact sales at https://revenuedot.app/contact-sales";
  return `${FEATURE_NAMES[f]} ${PLURAL.has(f) ? "are" : "is"} part of ${where}.`;
}

/**
 * Refuses a request whose organization (or server) lacks a feature. `features` is the organization's set (orgFeatures);
 * it defaults to the licence's, which is all a self-hosted server has.
 */
export function needFeature(ctx: EeCtx, f: Feature, features: Set<Feature> = ctx.features) {
  if (features.has(f)) return;
  if (ctx.cloud) throw new V2Error(403, "authorization_error", lockedMessage(f, planFor(ctx.cloud.plans, f)));
  throw new V2Error(403, "authorization_error", `Your RevenueDot Enterprise licence does not include ${f.replace(/_/g, " ")}.`);
}

/** An organization's features: the licence's on a self-hosted server; on RevenueDot Cloud, those of the best plan among its owners. */
export async function orgFeatures(ctx: EeCtx, orgId: string): Promise<Set<Feature>> {
  if (!ctx.cloud) return ctx.features;
  return planFeatures(planOf(ctx.cloud.plans, await orgPlan(ctx.deps.db, orgId)));
}

/** A person's own features on RevenueDot Cloud (their account's plan): what they may create. The licence's when self-hosted. */
export async function userFeatures(ctx: EeCtx, userId: string): Promise<Set<Feature>> {
  if (!ctx.cloud) return ctx.features;
  return planFeatures(planOf(ctx.cloud.plans, await userPlan(ctx.deps.db, userId)));
}

/**
 * Fields that tell the dashboard what is locked and where to get it: `locked` (features this organization lacks, with the
 * plan that has each) on every server, and `plan` on Cloud.
 */
export async function planFields(ctx: EeCtx, orgId: string, features: Set<Feature>) {
  const locked = FEATURES.filter((f) => !features.has(f)).map((f) => ({ feature: f, plan: ctx.cloud ? planFor(ctx.cloud.plans, f) : "enterprise" as PlanId }));
  return ctx.cloud ? { plan: await orgPlan(ctx.deps.db, orgId), locked } : { locked };
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

/**
 * The caller's membership in an organization; other organizations answer 404 so ids cannot be probed. With `sso`, an
 * organization that requires single sign-on needs a session that began with its SSO, as its projects do (owners keep
 * password access: break-glass), so a password session from before enforcement cannot manage it.
 */
export async function orgMembership(db: DB, orgId: string, userId: string, sso?: { sessionId: string | null; features: Set<string> }) {
  const [row] = await db.select({ org: eeOrganizations, member: eeOrgMembers }).from(eeOrgMembers)
    .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeOrgMembers.orgId))
    .where(and(eq(eeOrgMembers.orgId, orgId), eq(eeOrgMembers.userId, userId))).limit(1);
  if (!row || !row.member.active) throw new V2Error(404, "resource_missing", "Organization not found.");
  if (sso && row.org.ssoEnforced && sso.features.has("sso") && row.member.role !== "owner" && (await mustUseSso(db, orgId, userId))) {
    const [s] = sso.sessionId ? await db.select({ id: eeSsoSessions.sessionId }).from(eeSsoSessions)
      .where(and(eq(eeSsoSessions.sessionId, sso.sessionId), eq(eeSsoSessions.orgId, orgId))).limit(1) : [];
    if (!s) throw new V2Error(403, "authorization_error", "This organization requires single sign-on. Sign out, then sign in with SSO.");
  }
  return row;
}

/** Required single sign-on covers people whose email domain the organization verified. */
export async function mustUseSso(db: DB, orgId: string, userId: string) {
  const [u] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!u) return true;
  const domains = await db.select({ d: eeSsoDomains.domain, v: eeSsoDomains.verifiedAt }).from(eeSsoDomains).where(eq(eeSsoDomains.orgId, orgId));
  return domains.some((d) => d.v && d.d === emailDomain(u.email));
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
