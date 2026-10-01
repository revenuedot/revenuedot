import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { computeEntitlements, isActive, newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { entitlementMap } from "../../repo/catalog.js";
import { findCustomer, loadState } from "../../repo/customers.js";
import { balancesOf } from "../../services/virtual-currencies.js";
import { providerConfig, revokeSessions, type ProviderRow } from "../../services/identity/sessions.js";
import { FIREBASE_JWKS, KeysUnavailable, TokenInvalid, firebaseIssuer, verifyIdToken } from "../../services/identity/verify.js";
import { OutboundRefused, outboundUrlProblem } from "../../services/outbound.js";
import { V2Error, body, listOf, notFound, pageParams, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";

/**
 * Auth configuration and identities (prd/auth), RevenueDot extensions:
 *   GET    /v2/projects/{project_id}/auth/settings                                   { enabled, allow_anonymous }
 *   POST   /v2/projects/{project_id}/auth/settings
 *   GET    /v2/projects/{project_id}/auth/providers                                  Firebase and OpenID Connect providers
 *   POST   /v2/projects/{project_id}/auth/providers
 *   GET    /v2/projects/{project_id}/auth/providers/{provider_id}
 *   POST   /v2/projects/{project_id}/auth/providers/{provider_id}
 *   DELETE /v2/projects/{project_id}/auth/providers/{provider_id}                    also ends its sign-in sessions
 *   POST   /v2/projects/{project_id}/auth/providers/{provider_id}/actions/test       verify a pasted ID token, sign no one in
 *   GET    /v2/projects/{project_id}/auth/identities                                 ?provider_id=&subject=&app_user_id=
 *   GET    /v2/projects/{project_id}/auth/identities/{provider_id}/{subject}         app user id, entitlements, currency balances
 *   DELETE /v2/projects/{project_id}/auth/identities/{provider_id}/{subject}         unlink and end its sessions
 */

const MAX_PROVIDERS = 10;
const Settings = z.object({ enabled: z.boolean().optional(), allow_anonymous: z.boolean().optional() });
const Claim = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/, "must be a claim name such as sub or email");
const ProviderIn = z.object({
  kind: z.enum(["firebase", "oidc"]),
  name: z.string().trim().min(1).max(60).optional(),
  firebase_project_id: z.string().trim().min(1).max(100).regex(/^[a-z0-9-]+$/, "must be a Firebase project ID such as my-app-1a2b3").optional(),
  issuer: z.string().trim().max(500).optional(),
  audiences: z.array(z.string().trim().min(1).max(500)).min(1).max(10).optional(),
  jwks_url: z.string().trim().max(1000).nullable().optional(),
  app_user_id_claim: Claim.optional(),
  app_user_id_prefix: z.string().max(40).regex(/^[^\s]*$/, "must not contain spaces").optional(),
  enabled: z.boolean().optional(),
});
const ProviderUpdate = ProviderIn.omit({ kind: true });
const TestToken = z.object({ id_token: z.string().min(1).max(16_384) });

export function authRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/auth";
  const strict = deps.edition === "cloud";

  // ---- Settings -------------------------------------------------------------------------------------------------------
  const settingsOut = (s: { enabled?: boolean; allow_anonymous?: boolean } | null | undefined) => ({ object: "auth_settings" as const, enabled: !!s?.enabled, allow_anonymous: !!s?.allow_anonymous });
  r.get(`${P}/settings`, scope("project_configuration:projects:read"), async (c) => {
    const [p] = await db.select({ s: schema.projects.authSettings }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    return c.json(settingsOut(p?.s));
  });
  r.post(`${P}/settings`, scope("project_configuration:projects:read_write"), async (c) => {
    const b = await body(c, Settings);
    const [p] = await db.select({ s: schema.projects.authSettings }).from(schema.projects).where(eq(schema.projects.id, c.get("projectId"))).limit(1);
    const next = { ...settingsOut(p?.s), ...b };
    await db.update(schema.projects).set({ authSettings: { enabled: next.enabled, allow_anonymous: next.allow_anonymous } }).where(eq(schema.projects.id, c.get("projectId")));
    return c.json(settingsOut(next));
  });

  // ---- Providers ------------------------------------------------------------------------------------------------------
  const A = schema.authProviders;
  const providerOut = (p: ProviderRow) => ({
    object: "auth_provider" as const, id: p.id, kind: p.kind, name: p.name, issuer: p.issuer, audiences: p.audiences,
    firebase_project_id: p.firebaseProjectId, jwks_url: p.jwksUrl ?? (p.kind === "firebase" ? FIREBASE_JWKS : null), jwks_source: p.jwksUrl ? "configured" : p.kind === "firebase" ? "firebase" : "discovery",
    app_user_id_claim: p.appUserIdClaim, app_user_id_prefix: p.appUserIdPrefix, enabled: p.enabled, created_at: p.createdAt.getTime(), updated_at: p.updatedAt.getTime(),
  });
  const urlCheck = (v: string, param: string) => {
    const problem = outboundUrlProblem(v, strict) ?? (strict && !/^https:/i.test(v) ? "must be an https URL" : null);
    if (problem) throw paramError(`${param} ${problem}.`, param);
  };
  /** The stored columns for a provider from the request, merged over the current row. */
  const columns = (kind: string, b: z.infer<typeof ProviderUpdate>, cur?: ProviderRow) => {
    if (kind === "firebase") {
      const fid = b.firebase_project_id ?? cur?.firebaseProjectId;
      if (!fid) throw paramError("firebase_project_id is required for a Firebase provider.", "firebase_project_id");
      return { name: b.name ?? cur?.name ?? `Firebase (${fid})`, firebaseProjectId: fid, issuer: firebaseIssuer(fid), audiences: [fid], jwksUrl: null };
    }
    // Kept exactly as entered: an ID token's iss must match it character for character (Auth0's ends in a slash).
    const issuer = (b.issuer ?? cur?.issuer ?? "").trim();
    if (!issuer) throw paramError("issuer is required for an OpenID Connect provider.", "issuer");
    urlCheck(issuer, "issuer");
    const audiences = b.audiences ?? cur?.audiences;
    if (!audiences?.length) throw paramError("audiences needs at least one client ID your app's tokens are issued to.", "audiences");
    const jwks = b.jwks_url !== undefined ? (b.jwks_url || null) : cur?.jwksUrl ?? null;
    if (jwks) urlCheck(jwks, "jwks_url");
    return { name: b.name ?? cur?.name ?? new URL(issuer).host, firebaseProjectId: null, issuer, audiences, jwksUrl: jwks };
  };
  const findProvider = async (c: V2Context) => {
    const [p] = await db.select().from(A).where(and(eq(A.projectId, c.get("projectId")), eq(A.id, c.req.param("provider_id")!))).limit(1);
    if (!p) throw notFound("Auth provider");
    return p;
  };

  r.get(`${P}/providers`, scope("project_configuration:projects:read"), async (c) => {
    const rows = await db.select().from(A).where(eq(A.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), providerOut));
  });
  r.post(`${P}/providers`, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, ProviderIn);
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(A).where(eq(A.projectId, projectId));
    if ((n?.n ?? 0) >= MAX_PROVIDERS) throw new V2Error(422, "unprocessable_entity_error", `A project can have ${MAX_PROVIDERS} Auth providers.`);
    const now = deps.now();
    const [row] = await db.insert(A).values({
      id: newId("idp", 12), projectId, kind: b.kind, ...columns(b.kind, b), appUserIdClaim: b.app_user_id_claim ?? "sub", appUserIdPrefix: b.app_user_id_prefix ?? "",
      enabled: b.enabled ?? true, createdAt: now, updatedAt: now,
    }).returning();
    return c.json(providerOut(row!), 201);
  });
  r.get(`${P}/providers/:provider_id`, scope("project_configuration:projects:read"), async (c) => c.json(providerOut(await findProvider(c))));
  r.post(`${P}/providers/:provider_id`, scope("project_configuration:projects:read_write"), async (c) => {
    const cur = await findProvider(c);
    const b = await body(c, ProviderUpdate);
    const [row] = await db.update(A).set({
      ...columns(cur.kind, b, cur), ...(b.app_user_id_claim !== undefined ? { appUserIdClaim: b.app_user_id_claim } : {}),
      ...(b.app_user_id_prefix !== undefined ? { appUserIdPrefix: b.app_user_id_prefix } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), updatedAt: deps.now(),
    }).where(eq(A.id, cur.id)).returning();
    return c.json(providerOut(row!));
  });
  r.delete(`${P}/providers/:provider_id`, scope("project_configuration:projects:read_write"), async (c) => {
    const cur = await findProvider(c);
    await revokeSessions(db, cur.projectId, { providerId: cur.id });
    await db.delete(A).where(eq(A.id, cur.id));
    return c.json({ object: "auth_provider", id: cur.id, deleted_at: deps.now().getTime() });
  });
  // Checks a token the way sign-in would, so a developer can see why theirs fails. Nothing is stored.
  r.post(`${P}/providers/:provider_id/actions/test`, scope("project_configuration:projects:read"), async (c) => {
    const p = await findProvider(c);
    const b = await body(c, TestToken);
    try {
      const v = await verifyIdToken(deps, providerConfig(p), b.id_token.trim());
      const [link] = await db.select().from(schema.identityLinks).where(and(eq(schema.identityLinks.providerId, p.id), eq(schema.identityLinks.subject, v.subject))).limit(1);
      const claims = Object.fromEntries(Object.entries(v.claims).filter(([k]) => ["iss", "aud", "sub", "exp", "iat", "auth_time", "email_verified", "firebase", "azp", p.appUserIdClaim].includes(k)));
      return c.json({ object: "auth_token_test", valid: true, subject: v.subject, app_user_id: link?.appUserId ?? v.appUserId, linked: !!link, claims, error: null });
    } catch (e) {
      if (e instanceof TokenInvalid || e instanceof KeysUnavailable || e instanceof OutboundRefused) return c.json({ object: "auth_token_test", valid: false, subject: null, app_user_id: null, linked: false, claims: null, error: e.message });
      throw e;
    }
  });

  // ---- Identities -----------------------------------------------------------------------------------------------------
  const L = schema.identityLinks;
  const linkOut = (l: typeof L.$inferSelect) => ({
    object: "auth_identity" as const, provider_id: l.providerId, subject: l.subject, app_user_id: l.appUserId, logins: l.logins,
    last_login_at: l.lastLoginAt.getTime(), created_at: l.createdAt.getTime(),
  });
  r.get(`${P}/identities`, scope("customer_information:customers:read"), async (c) => {
    const projectId = c.get("projectId");
    const { limit, startingAfter } = pageParams(c);
    const conds = [eq(L.projectId, projectId)];
    for (const [q, col] of [["provider_id", L.providerId], ["subject", L.subject], ["app_user_id", L.appUserId]] as const) {
      const v = c.req.query(q);
      if (v) conds.push(eq(col, v));
    }
    if (startingAfter) {
      const [prov, ...rest] = startingAfter.split("/");
      const [cur] = await db.select().from(L).where(and(eq(L.projectId, projectId), eq(L.providerId, prov ?? ""), eq(L.subject, rest.join("/")))).limit(1);
      if (!cur) throw paramError("starting_after does not match an identity.", "starting_after");
      conds.push(sql`(${L.lastLoginAt}, ${L.providerId}, ${L.subject}) < (${cur.lastLoginAt.toISOString()}::timestamptz, ${cur.providerId}, ${cur.subject})`);
    }
    const rows = await db.select().from(L).where(and(...conds)).orderBy(desc(L.lastLoginAt), desc(L.providerId), desc(L.subject)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json(listOf(c, page.map(linkOut), rows.length > limit && last ? `${last.providerId}/${last.subject}` : null));
  });
  const findLink = async (c: V2Context) => {
    const [l] = await db.select().from(L).where(and(eq(L.projectId, c.get("projectId")), eq(L.providerId, c.req.param("provider_id")!), eq(L.subject, c.req.param("subject")!))).limit(1);
    if (!l) throw notFound("Identity");
    return l;
  };
  // "Build on top of identity": a backend reads what a signed-in user has by the provider's user id.
  r.get(`${P}/identities/:provider_id/:subject`, scope("customer_information:customers:read"), async (c) => {
    const l = await findLink(c);
    const now = deps.now();
    const cust = await findCustomer(db, l.projectId, l.appUserId);
    let entitlements: { lookup_key: string; expires_at: number | null }[] = [];
    let currencies: Record<string, { balance: number; name: string; code: string }> = {};
    if (cust) {
      const [state, map, bal] = await Promise.all([loadState(db, cust), entitlementMap(db, l.projectId), balancesOf(db, l.projectId, cust.id, { includeEmpty: true })]);
      entitlements = computeEntitlements(state, map).filter((e) => isActive(e, now)).map((e) => ({ lookup_key: e.identifier, expires_at: e.expiresDate?.getTime() ?? null }));
      currencies = Object.fromEntries(bal.map((b) => [b.code, { balance: b.balance, name: b.name, code: b.code }]));
    }
    return c.json({ ...linkOut(l), customer_id: cust?.originalAppUserId ?? null, active_entitlements: entitlements, virtual_currencies: currencies });
  });
  r.delete(`${P}/identities/:provider_id/:subject`, scope("customer_information:customers:read_write"), async (c) => {
    const l = await findLink(c);
    await revokeSessions(db, l.projectId, { providerId: l.providerId, subjects: [l.subject] });
    await db.delete(L).where(and(eq(L.providerId, l.providerId), eq(L.subject, l.subject)));
    return c.json({ object: "auth_identity", provider_id: l.providerId, subject: l.subject, deleted_at: deps.now().getTime() });
  });
}
