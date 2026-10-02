// RevenueDot Enterprise (ee/LICENSE). Single sign-on: SAML 2.0 and OpenID Connect connections, verified email domains,
// sign-in, and the password policy for organizations that require SSO. Spec: prd/enterprise/PRD.md §5.
//
// Admin (dashboard session, organization owners and admins):
//   GET|POST /v2/organizations/{org_id}/sso/connections
//   GET|POST|DELETE /v2/organizations/{org_id}/sso/connections/{connection_id}
//   GET|POST /v2/organizations/{org_id}/sso/domains, POST .../{domain}/actions/verify, DELETE .../{domain}   (domains.ts)
// Public (no session):
//   POST /sso/lookup {email}                 whether the address signs in with SSO, and where
//   GET  /sso/start?email=&next=             the organization of the email's verified domain → its identity provider
//   GET  /sso/connections/{id}/start?next=   one connection's identity provider
//   GET  /sso/saml/{id}/metadata             SP metadata (also the SP entity id)
//   POST /sso/saml/{id}/acs                  assertion consumer (HTTP-POST binding)
//   GET  /sso/oidc/{id}/callback             OpenID Connect redirect URI
// Failures redirect (303) to /login?sso_error=<message>; the precise reason goes to the organization's audit log.
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { PasswordRefusal } from "../../../apps/server/src/extensions.js";
import { body, listOf, paramError, v2ErrorResponse } from "../../../apps/server/src/routes/v2/common.js";
import { SESSION_COOKIE, createSession } from "../../../apps/server/src/services/sessions.js";
import { depsSecretKey, seal, unseal } from "../../../apps/server/src/services/secrets.js";
import { outboundUrlProblem } from "../../../apps/server/src/services/outbound.js";
import { clientIp, hit } from "../../../apps/server/src/services/rate-limit.js";
import { eeOrgMembers, eeOrganizations, eeSsoConnections, eeSsoDomains, eeSsoSessions, type OidcConfig, type SamlConfig } from "../schema.js";
import { domainVerifiedFor, ensureOrgMember, ensureUser, orgForEmail } from "../provision.js";
import { V2Error, emailDomain, id, needFeature, normEmail, orgAudit, orgMembership, publicBase, requireOrgAdmin, signedIn, type EeCtx } from "../util.js";
import { domainRoutes } from "./domains.js";
import { SamlConfigError, normalizeCertificate, parseIdpMetadata, samlConsume, samlMetadata, samlStartUrl, samlUrls, type SsoIdentity } from "./saml.js";
import { DEFAULT_SCOPES, OidcError, oidcFinish, oidcStartUrl, oidcUrls, takeState } from "./oidc.js";

const Name = z.string().trim().min(1, "must not be empty").max(100);
const Attr = z.string().trim().max(256).nullable().optional();
const SamlBody = z.object({
  metadata_xml: z.string().max(500_000).optional(),
  idp_entity_id: z.string().trim().min(1).max(1024).optional(),
  idp_sso_url: z.string().trim().min(1).max(2048).optional(),
  idp_certificates: z.array(z.string().max(20_000)).min(1).max(5).optional(),
  allow_idp_initiated: z.boolean().optional(),
  email_attribute: Attr, first_name_attribute: Attr, last_name_attribute: Attr, groups_attribute: Attr,
});
const OidcBody = z.object({
  issuer: z.string().trim().min(1).max(2048).optional(),
  client_id: z.string().trim().min(1).max(512).optional(),
  client_secret: z.string().max(4096).nullable().optional(),
  scopes: z.array(z.string().trim().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/, "must be a scope name")).max(30).optional(),
  groups_claim: Attr,
});
const ConnCreate = z.object({ kind: z.enum(["saml", "oidc"]), name: Name, enabled: z.boolean().optional(), jit: z.boolean().optional(), saml: SamlBody.optional(), oidc: OidcBody.optional() });
const ConnUpdate = z.object({ name: Name.optional(), enabled: z.boolean().optional(), jit: z.boolean().optional(), saml: SamlBody.optional(), oidc: OidcBody.optional() });
const Lookup = z.object({ email: z.string().trim().max(320), next: z.string().max(2000).optional() });

type ConnRow = typeof eeSsoConnections.$inferSelect;
const GENERIC = "Single sign-on failed. Try again, or ask your administrator to check the connection.";
const OFF = "This single sign-on connection is turned off.";
const COOKIE_MAX_AGE = 30 * 86400;
const BIND_COOKIE = "rd_sso";

/** The InResponseTo on the (unsigned) Response element, read only to match it against this browser's requests. */
function responseInResponseTo(b64: string): string | null {
  try {
    const xml = new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0)));
    return /^\s*(?:<\?xml[^>]*>\s*)?<(?:[\w.-]+:)?Response\b[^>]*?\sInResponseTo="([^"]{1,200})"/.exec(xml)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A relative path on this site ("/" when missing or unsafe): never "//host", "/\host" or an absolute URL. */
export function safeNext(n: unknown): string {
  if (typeof n !== "string" || !n.startsWith("/") || n.startsWith("//") || n.includes("\\") || n.length > 2000 || /[\u0000-\u001f\u007f]/.test(n)) return "/";
  return n;
}

function samlConfigFrom(prev: SamlConfig | null, b: z.infer<typeof SamlBody> | undefined, cloud: boolean): SamlConfig {
  let cfg: Partial<SamlConfig> = prev ? { ...prev } : { allow_idp_initiated: false };
  if (b?.metadata_xml) {
    try { cfg = { ...cfg, ...parseIdpMetadata(b.metadata_xml) }; } catch (e) { throw paramError(`saml.metadata_xml: ${e instanceof Error ? e.message : "could not be read"}`, "saml.metadata_xml"); }
  }
  if (b) {
    const { metadata_xml: _m, idp_certificates, ...rest } = b;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (cfg as Record<string, unknown>)[k] = typeof v === "string" ? v || null : v;
    if (idp_certificates) {
      cfg.idp_certificates = idp_certificates.map((pem, i) => {
        try { return normalizeCertificate(pem); } catch (e) { throw paramError(`saml.idp_certificates[${i}] ${e instanceof SamlConfigError ? e.message : "is not a certificate."}`, "saml.idp_certificates"); }
      });
    }
  }
  if (!cfg.idp_entity_id) throw paramError("saml.idp_entity_id is required (or saml.metadata_xml).", "saml.idp_entity_id");
  if (!cfg.idp_sso_url) throw paramError("saml.idp_sso_url is required (or saml.metadata_xml).", "saml.idp_sso_url");
  let u: URL | null = null;
  try { u = new URL(cfg.idp_sso_url); } catch { /* checked below */ }
  if (!u || !["https:", "http:"].includes(u.protocol) || (cloud && u.protocol !== "https:")) throw paramError("saml.idp_sso_url must be an https URL.", "saml.idp_sso_url");
  if (!cfg.idp_certificates?.length) throw paramError("saml.idp_certificates needs at least one certificate (or saml.metadata_xml).", "saml.idp_certificates");
  return {
    idp_entity_id: cfg.idp_entity_id, idp_sso_url: cfg.idp_sso_url, idp_certificates: cfg.idp_certificates, allow_idp_initiated: cfg.allow_idp_initiated ?? false,
    email_attribute: cfg.email_attribute ?? null, first_name_attribute: cfg.first_name_attribute ?? null, last_name_attribute: cfg.last_name_attribute ?? null, groups_attribute: cfg.groups_attribute ?? null,
  };
}

function oidcConfigFrom(prev: OidcConfig | null, b: z.infer<typeof OidcBody> | undefined, cloud: boolean): OidcConfig {
  const cfg: OidcConfig = {
    issuer: b?.issuer ?? prev?.issuer ?? "", client_id: b?.client_id ?? prev?.client_id ?? "",
    scopes: b?.scopes ?? prev?.scopes ?? DEFAULT_SCOPES, groups_claim: b?.groups_claim !== undefined ? b.groups_claim || null : prev?.groups_claim ?? null,
  };
  if (!cfg.issuer) throw paramError("oidc.issuer is required.", "oidc.issuer");
  const problem = outboundUrlProblem(cfg.issuer, cloud);
  if (problem) throw paramError(`oidc.issuer ${problem}.`, "oidc.issuer");
  if (!cfg.client_id) throw paramError("oidc.client_id is required.", "oidc.client_id");
  if (!cfg.scopes!.includes("openid")) cfg.scopes = ["openid", ...cfg.scopes!];
  return cfg;
}

export function ssoRoutes(ctx: EeCtx) {
  const { deps } = ctx;
  const { db } = deps;
  const r = new Hono();
  r.onError((e, c) => v2ErrorResponse(c, e));
  const cloud = deps.edition === "cloud";
  const fetchFn = () => deps.fetch ?? fetch;

  const admin = async (c: Context) => {
    needFeature(ctx, "sso");
    const { user } = await signedIn(c, deps);
    const { org, member } = await orgMembership(db, c.req.param("org_id")!, user.id);
    requireOrgAdmin(member.role);
    return { user, org };
  };
  const audit = (orgId: string, userId: string, action: string, connId: string, data?: Record<string, unknown>) =>
    orgAudit(db, deps.now(), { orgId, action, actor: { type: "user", id: userId }, target: { type: "sso_connection", id: connId }, data });

  const shape = (c: Context, row: ConnRow) => {
    const base = publicBase(deps, c);
    const common = { object: "sso_connection", id: row.id, org_id: row.orgId, kind: row.kind, name: row.name, enabled: row.enabled, jit: row.jit, created_at: row.createdAt.getTime(), updated_at: row.updatedAt.getTime() };
    if (row.kind === "saml") {
      const s = row.config as SamlConfig;
      return { ...common, saml: { idp_entity_id: s.idp_entity_id, idp_sso_url: s.idp_sso_url, idp_certificates: s.idp_certificates, allow_idp_initiated: s.allow_idp_initiated, email_attribute: s.email_attribute ?? null, first_name_attribute: s.first_name_attribute ?? null, last_name_attribute: s.last_name_attribute ?? null, groups_attribute: s.groups_attribute ?? null }, sp: samlUrls(base, row.id) };
    }
    const o = row.config as OidcConfig;
    return { ...common, oidc: { issuer: o.issuer, client_id: o.client_id, scopes: o.scopes ?? DEFAULT_SCOPES, groups_claim: o.groups_claim ?? null, has_client_secret: !!row.secret }, sp: oidcUrls(base, row.id) };
  };
  const owned = async (orgId: string, connId: string) => {
    const [row] = await db.select().from(eeSsoConnections).where(and(eq(eeSsoConnections.id, connId), eq(eeSsoConnections.orgId, orgId))).limit(1);
    if (!row) throw new V2Error(404, "resource_missing", "Connection not found.");
    return row;
  };
  /** An organization that requires SSO keeps at least one enabled connection, or nobody could sign in. */
  const keepsEnforcementWorking = async (org: { id: string; ssoEnforced: boolean }, row: ConnRow) => {
    if (!org.ssoEnforced || !row.enabled) return;
    const [other] = await db.select({ id: eeSsoConnections.id }).from(eeSsoConnections)
      .where(and(eq(eeSsoConnections.orgId, org.id), eq(eeSsoConnections.enabled, true), ne(eeSsoConnections.id, row.id))).limit(1);
    if (!other) throw new V2Error(422, "unprocessable_entity_error", "This organization requires single sign-on and this is its only enabled connection. Turn off required single sign-on first.", "enabled");
  };

  const C = "/v2/organizations/:org_id/sso/connections";
  r.get(C, async (c) => {
    const m = await admin(c);
    const rows = await db.select().from(eeSsoConnections).where(eq(eeSsoConnections.orgId, m.org.id)).orderBy(asc(eeSsoConnections.createdAt));
    return c.json(listOf(c, rows.map((x) => shape(c, x)), null));
  });

  r.post(C, async (c) => {
    const m = await admin(c);
    const b = await body(c, ConnCreate);
    const now = deps.now();
    let config: SamlConfig | OidcConfig;
    let secret: string | null = null;
    if (b.kind === "saml") {
      if (!b.saml) throw paramError("saml is required for a SAML connection.", "saml");
      config = samlConfigFrom(null, b.saml, cloud);
    } else {
      if (!b.oidc) throw paramError("oidc is required for an OpenID Connect connection.", "oidc");
      config = oidcConfigFrom(null, b.oidc, cloud);
      if (b.oidc.client_secret) secret = await seal({ client_secret: b.oidc.client_secret }, await depsSecretKey(deps));
    }
    const [row] = await db.insert(eeSsoConnections).values({ id: id("ssoc_"), orgId: m.org.id, kind: b.kind, name: b.name, enabled: b.enabled ?? false, jit: b.jit ?? true, config, secret, createdAt: now, updatedAt: now }).returning();
    await audit(m.org.id, m.user.id, "sso_connection_created", row!.id, { name: row!.name, kind: row!.kind, enabled: row!.enabled, jit: row!.jit });
    return c.json(shape(c, row!), 201);
  });

  r.get(`${C}/:connection_id`, async (c) => {
    const m = await admin(c);
    return c.json(shape(c, await owned(m.org.id, c.req.param("connection_id")!)));
  });

  r.post(`${C}/:connection_id`, async (c) => {
    const m = await admin(c);
    const row = await owned(m.org.id, c.req.param("connection_id")!);
    const b = await body(c, ConnUpdate);
    const set: Partial<typeof eeSsoConnections.$inferInsert> = { updatedAt: deps.now() };
    const changed: string[] = [];
    if (b.name !== undefined) { set.name = b.name; changed.push("name"); }
    if (b.jit !== undefined) { set.jit = b.jit; changed.push("jit"); }
    if (b.enabled !== undefined) {
      if (!b.enabled) await keepsEnforcementWorking(m.org, row);
      set.enabled = b.enabled; changed.push("enabled");
    }
    if (b.saml) {
      if (row.kind !== "saml") throw paramError("This is an OpenID Connect connection; send oidc.", "saml");
      set.config = samlConfigFrom(row.config as SamlConfig, b.saml, cloud); changed.push(...Object.keys(b.saml).map((k) => `saml.${k}`));
    }
    if (b.oidc) {
      if (row.kind !== "oidc") throw paramError("This is a SAML connection; send saml.", "oidc");
      set.config = oidcConfigFrom(row.config as OidcConfig, b.oidc, cloud); changed.push(...Object.keys(b.oidc).map((k) => `oidc.${k}`));
      if (b.oidc.client_secret !== undefined) set.secret = b.oidc.client_secret ? await seal({ client_secret: b.oidc.client_secret }, await depsSecretKey(deps)) : null;
    }
    const [updated] = await db.update(eeSsoConnections).set(set).where(and(eq(eeSsoConnections.id, row.id), eq(eeSsoConnections.orgId, m.org.id))).returning();
    await audit(m.org.id, m.user.id, "sso_connection_updated", row.id, { name: updated!.name, changed, enabled: updated!.enabled, jit: updated!.jit });
    return c.json(shape(c, updated!));
  });

  r.delete(`${C}/:connection_id`, async (c) => {
    const m = await admin(c);
    const row = await owned(m.org.id, c.req.param("connection_id")!);
    await keepsEnforcementWorking(m.org, row);
    await db.delete(eeSsoConnections).where(and(eq(eeSsoConnections.id, row.id), eq(eeSsoConnections.orgId, m.org.id)));
    await audit(m.org.id, m.user.id, "sso_connection_deleted", row.id, { name: row.name, kind: row.kind });
    return c.json({ object: "sso_connection", id: row.id, deleted: true });
  });

  domainRoutes(ctx, r, admin);

  // ---- Public sign-in ----------------------------------------------------------------------------------------------

  const fail = (c: Context, message: string) => c.redirect(`/login?sso_error=${encodeURIComponent(message)}`, 303);
  const auditFail = (conn: ConnRow, reason: string, email?: string) =>
    orgAudit(db, deps.now(), { orgId: conn.orgId, action: "sso_sign_in_failed", actor: { type: "sso", id: conn.id }, target: { type: "sso_connection", id: conn.id }, data: { reason, kind: conn.kind, ...(email ? { email } : {}) } });
  const connection = async (connId: string) => {
    const [row] = await db.select().from(eeSsoConnections).where(eq(eeSsoConnections.id, connId)).limit(1);
    return row ?? null;
  };
  const firstEnabled = async (orgId: string) => {
    const [row] = await db.select().from(eeSsoConnections).where(and(eq(eeSsoConnections.orgId, orgId), eq(eeSsoConnections.enabled, true))).orderBy(asc(eeSsoConnections.createdAt)).limit(1);
    return row ?? null;
  };
  /** The enabled connection for an address on a verified domain, if any. */
  const connectionForEmail = async (email: string) => {
    const orgId = await orgForEmail(db, email);
    return orgId ? firstEnabled(orgId) : null;
  };
  const startUrl = (email: string, next: string) => `/sso/start?email=${encodeURIComponent(email)}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;

  const start = async (c: Context, conn: ConnRow | null, nextRaw: unknown, email: string | null) => {
    const now = deps.now();
    if (!(await hit(db, `sso-start:ip:${clientIp((n) => c.req.header(n))}`, 30, 60_000, now))) return fail(c, "Too many sign-in attempts. Try again in a minute.");
    if (!conn) return fail(c, "Single sign-on is not set up for this email address.");
    if (!conn.enabled) return fail(c, OFF);
    const next = safeNext(nextRaw);
    const base = publicBase(deps, c);
    try {
      const started = conn.kind === "saml"
        ? await samlStartUrl(db, deps.now, base, conn.id, conn.config as SamlConfig, next).then((x) => ({ url: x.url, key: x.requestId }))
        : await oidcStartUrl({ db, fetch: fetchFn(), strict: cloud, now, base, connectionId: conn.id, cfg: conn.config as OidcConfig, next, loginHint: email }).then((x) => ({ url: x.url, key: x.state }));
      bind(c, started.key);
      return c.redirect(started.url, 303);
    } catch (e) {
      await auditFail(conn, `start: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
      return fail(c, GENERIC);
    }
  };

  /**
   * Login CSRF defence: the browser that started a sign-in keeps its request ids (SAML AuthnRequest id, OpenID Connect
   * state) in a short-lived cookie, and only that browser may finish it. Otherwise an attacker could start a sign-in,
   * complete it at the identity provider as themselves, and make a victim's browser post the answer, signing the victim
   * into the attacker's account. The SAML answer arrives as a cross-site POST, so on https the cookie is SameSite=None.
   */
  const bind = (c: Context, key: string) => {
    const keys = [key, ...(getCookie(c, BIND_COOKIE) ?? "").split(".").filter((k) => /^[A-Za-z0-9_]{8,80}$/.test(k))].slice(0, 5);
    const https = c.req.url.startsWith("https:") || publicBase(deps, c).startsWith("https:");
    setCookie(c, BIND_COOKIE, keys.join("."), { httpOnly: true, path: "/sso", maxAge: 600, ...(https ? { sameSite: "None", secure: true } : { sameSite: "Lax" }) });
  };
  const bound = (c: Context, key: string | null) => !!key && (getCookie(c, BIND_COOKIE) ?? "").split(".").includes(key);

  /** A sign-in the identity provider vouched for: domain, membership and JIT checks, then a session. */
  const finish = async (c: Context, conn: ConnRow, identity: SsoIdentity, next: string, extra: Record<string, unknown> = {}) => {
    const now = deps.now();
    const email = normEmail(identity.email);
    if (!(await domainVerifiedFor(db, conn.orgId, email))) {
      await auditFail(conn, `email domain ${emailDomain(email)} is not verified by this organization`, email);
      return fail(c, "Your email address is not on a domain this organization verified.");
    }
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    const [member] = existing ? await db.select().from(eeOrgMembers).where(and(eq(eeOrgMembers.orgId, conn.orgId), eq(eeOrgMembers.userId, existing.id))).limit(1) : [];
    if (member && !member.active) {
      await auditFail(conn, "the person was deactivated in this organization", email);
      return fail(c, "Your access to this organization was removed. Ask your administrator.");
    }
    if (!conn.jit && !member) {
      await auditFail(conn, "just-in-time provisioning is off and the person is not an organization member", email);
      return fail(c, "Ask your administrator to add you to the organization before you sign in with SSO.");
    }
    const { user, created } = await ensureUser(db, email, identity.name, now, conn.orgId);
    await ensureOrgMember(db, conn.orgId, user.id, "sso", { ssoGroups: identity.groups, now });
    const sid = await createSession(db, user.id, now);
    await db.insert(eeSsoSessions).values({ sessionId: sid, orgId: conn.orgId, connectionId: conn.id, userId: user.id, createdAt: now });
    setCookie(c, SESSION_COOKIE, sid, { httpOnly: true, sameSite: "Lax", secure: c.req.url.startsWith("https:"), path: "/", maxAge: COOKIE_MAX_AGE });
    await orgAudit(db, now, { orgId: conn.orgId, action: "sso_sign_in", actor: { type: "sso", id: conn.id }, target: { type: "user", id: user.id }, data: { connection_id: conn.id, kind: conn.kind, email, account_created: created, groups: identity.groups.slice(0, 50), ...extra } });
    return c.redirect(next, 303);
  };

  r.post("/sso/lookup", async (c) => {
    const b = await body(c, Lookup);
    const email = normEmail(b.email);
    const conn = email.includes("@") ? await connectionForEmail(email) : null;
    return c.json(conn ? { sso: true, url: startUrl(email, safeNext(b.next)) } : { sso: false });
  });

  r.get("/sso/start", async (c) => {
    const email = normEmail(c.req.query("email") ?? "").slice(0, 320);
    return start(c, email.includes("@") ? await connectionForEmail(email) : null, c.req.query("next"), email || null);
  });

  r.get("/sso/connections/:id/start", async (c) => start(c, await connection(c.req.param("id")), c.req.query("next"), null));

  r.get("/sso/saml/:id/metadata", async (c) => {
    const conn = await connection(c.req.param("id"));
    if (!conn || conn.kind !== "saml") return c.text("Not found.", 404);
    return c.body(samlMetadata(publicBase(deps, c), conn.id, conn.config as SamlConfig), 200, { "content-type": "application/samlmetadata+xml; charset=utf-8" });
  });

  r.post("/sso/saml/:id/acs", async (c) => {
    const conn = await connection(c.req.param("id"));
    if (!conn || conn.kind !== "saml") return fail(c, GENERIC);
    if (!conn.enabled) return fail(c, OFF);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const samlResponse = form.SAMLResponse, relayState = form.RelayState;
    if (typeof samlResponse !== "string" || !samlResponse || samlResponse.length > 1_000_000) {
      await auditFail(conn, "the POST has no SAMLResponse");
      return fail(c, GENERIC);
    }
    // Refuse an answer to a request this browser did not start before it is checked, so it cannot use up the request.
    const claimed = responseInResponseTo(samlResponse);
    if (claimed && !bound(c, claimed)) {
      await auditFail(conn, "the sign-in was started in another browser (login CSRF defence)");
      return fail(c, "This sign-in was started in another browser or has expired. Start it again here.");
    }
    const res = await samlConsume(db, deps.now, publicBase(deps, c), conn.id, conn.config as SamlConfig, { SAMLResponse: samlResponse, RelayState: typeof relayState === "string" ? relayState : undefined });
    if (!res.ok) {
      await auditFail(conn, res.reason);
      return fail(c, GENERIC);
    }
    if (!res.idpInitiated && !bound(c, res.requestId)) {
      await auditFail(conn, "the sign-in was started in another browser (login CSRF defence)");
      return fail(c, "This sign-in was started in another browser or has expired. Start it again here.");
    }
    return finish(c, conn, res.identity, res.idpInitiated ? safeNext(relayState) : safeNext(res.next), { idp_initiated: res.idpInitiated, assertion_id: res.assertionId });
  });

  r.get("/sso/oidc/:id/callback", async (c) => {
    const conn = await connection(c.req.param("id"));
    if (!conn || conn.kind !== "oidc") return fail(c, GENERIC);
    if (!conn.enabled) return fail(c, OFF);
    const now = deps.now();
    if (!bound(c, c.req.query("state") ?? null)) {
      await auditFail(conn, "the sign-in was started in another browser (login CSRF defence)");
      return fail(c, "This sign-in was started in another browser or has expired. Start it again here.");
    }
    const st = await takeState(db, conn.id, c.req.query("state") ?? "", now);
    if (!st) {
      await auditFail(conn, "the state is unknown, expired or already used");
      return fail(c, GENERIC);
    }
    const error = c.req.query("error");
    if (error) {
      await auditFail(conn, `the identity provider returned error ${error.slice(0, 100)}`);
      return fail(c, "Your identity provider did not complete the sign-in.");
    }
    const code = c.req.query("code");
    if (!code) {
      await auditFail(conn, "the callback has no code");
      return fail(c, GENERIC);
    }
    let identity: SsoIdentity;
    try {
      const secret = conn.secret ? (await unseal(conn.secret, await depsSecretKey(deps))).client_secret ?? null : null;
      identity = await oidcFinish({ fetch: fetchFn(), strict: cloud, now, base: publicBase(deps, c), connectionId: conn.id, cfg: conn.config as OidcConfig, clientSecret: secret, code, nonce: st.nonce, verifier: st.verifier });
    } catch (e) {
      await auditFail(conn, (e instanceof OidcError ? e.message : `${e instanceof Error ? e.name : "error"}: ${e instanceof Error ? e.message : String(e)}`).slice(0, 300));
      return fail(c, GENERIC);
    }
    return finish(c, conn, identity, safeNext(st.next));
  });

  return r;
}

/**
 * Password sign-in, sign-up and reset for an address on a domain verified by an organization that requires SSO (and
 * has an enabled connection) are refused, except for that organization's active owners (break-glass).
 */
export async function ssoPasswordPolicy(ctx: EeCtx, emailRaw: string): Promise<PasswordRefusal | null> {
  const { db } = ctx.deps;
  const email = normEmail(emailRaw);
  const domain = emailDomain(email);
  if (!domain) return null;
  const [row] = await db.select({ orgId: eeOrganizations.id, name: eeOrganizations.name, enforced: eeOrganizations.ssoEnforced }).from(eeSsoDomains)
    .innerJoin(eeOrganizations, eq(eeOrganizations.id, eeSsoDomains.orgId)).where(and(eq(eeSsoDomains.domain, domain), isNotNull(eeSsoDomains.verifiedAt))).limit(1);
  if (!row?.enforced) return null;
  const [conn] = await db.select({ id: eeSsoConnections.id }).from(eeSsoConnections).where(and(eq(eeSsoConnections.orgId, row.orgId), eq(eeSsoConnections.enabled, true))).limit(1);
  if (!conn) return null;
  const [owner] = await db.select({ id: eeOrgMembers.userId }).from(schema.users)
    .innerJoin(eeOrgMembers, and(eq(eeOrgMembers.userId, schema.users.id), eq(eeOrgMembers.orgId, row.orgId)))
    .where(and(eq(schema.users.email, email), eq(eeOrgMembers.role, "owner"), eq(eeOrgMembers.active, true))).limit(1);
  if (owner) return null;
  return { message: `${row.name} requires single sign-on for @${domain} addresses.`, sso_url: `/sso/start?email=${encodeURIComponent(email)}` };
}
