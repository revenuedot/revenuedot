import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { isAnonymous, newId } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { AppRecord, Deps } from "../../context.js";
import { getOrCreateCustomer, identify } from "../../repo/customers.js";
import { recordSubscriberAlias } from "../events.js";
import { SUBSCRIBER_TOKEN_TTL_MS, sha256Hex } from "../auth.js";
import { fromBase64 } from "../signing.js";
import { b64url, decodeJwt, signEdDsa } from "./jwt.js";
import { TokenInvalid, verifyIdToken, type ProviderConfig } from "./verify.js";

/**
 * Auth sign-in sessions (prd/auth §4–5). A verified ID token signs in as an app user id with logIn semantics and gets:
 * - an access token: a subscriber token (one hour, stored hashed beside `rdat_` tokens, pinned to the app user id). The SDK
 *   decodes it as a JWT and reads `rc.app_user_id`, so it is one, but the server only ever looks it up by hash;
 * - a refresh token `rdrf_…` (30 days, rotated on every use, stored hashed), the handle of the session;
 * - an ID token: an Ed25519 JWT any backend can verify with GET /.well-known/jwks.json.
 */

export const REFRESH_PREFIX = "rdrf_";
export const REFRESH_TTL_MS = 30 * 86400_000;
export const METHODS = ["anonymous", "firebase", "oidc", "google", "apple", "facebook"] as const;
export type Method = (typeof METHODS)[number];

export class AuthUnavailable extends Error {}
export class AuthRefused extends Error {}

// ---- RevenueDot's identity key -----------------------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
interface Signer { key: CryptoKey; kid: string; x: string }
const signers = new Map<string, Promise<Signer>>();

/** The Ed25519 key for Auth tokens, derived with HKDF from the signing key (else the encryption key). Null when neither is set. */
export function identitySigner(deps: Pick<Deps, "signingKey" | "encryptionKey">): Promise<Signer> | null {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const root = (deps.signingKey ?? env?.REVENUEDOT_SIGNING_KEY ?? "").trim() || (deps.encryptionKey ?? env?.REVENUEDOT_ENCRYPTION_KEY ?? "").trim();
  if (!root) return null;
  let s = signers.get(root);
  if (!s) {
    s = (async () => {
      const ikm = await crypto.subtle.importKey("raw", fromBase64(root), "HKDF", false, ["deriveBits"]);
      const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("revenuedot"), info: new TextEncoder().encode("identity tokens v1") }, ikm, 256));
      const pkcs8 = new Uint8Array(48); pkcs8.set(PKCS8_ED25519_PREFIX); pkcs8.set(seed, 16);
      const extractable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
      const x = (await crypto.subtle.exportKey("jwk", extractable)).x!;
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
      return { key, x, kid: (await sha256Hex(x)).slice(0, 16) };
    })();
    // A key that is not base64 fails every call the same way; do not keep the rejected promise.
    s.catch(() => signers.delete(root));
    signers.set(root, s);
  }
  return s;
}

/** GET /.well-known/jwks.json */
export async function identityJwks(deps: Pick<Deps, "signingKey" | "encryptionKey">) {
  const s = identitySigner(deps);
  const signer = s ? await s.catch(() => null) : null;
  if (!signer) return { keys: [] };
  const { x, kid } = signer;
  return { keys: [{ kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" }] };
}

// ---- Providers and settings -------------------------------------------------------------------------------------------

export type ProviderRow = typeof schema.authProviders.$inferSelect;
export const providerConfig = (p: ProviderRow): ProviderConfig => ({
  id: p.id, kind: p.kind, issuer: p.issuer, audiences: p.audiences, jwksUrl: p.jwksUrl, appUserIdClaim: p.appUserIdClaim, appUserIdPrefix: p.appUserIdPrefix,
});

/** Methods each provider kind answers: Firebase tokens for "firebase", any OIDC provider for the rest. */
const kindsFor = (m: Method) => (m === "firebase" ? ["firebase"] : ["oidc"]);

export interface Tokens { access_token: string; refresh_token: string; id_token: string; scope: string; expires_in: number; token_type: "Bearer" }
export interface SignedIn { tokens: Tokens; appUserId: string; created: boolean }

const randomHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

async function issue(deps: Deps, o: { app: AppRecord; appUserId: string; method: string; providerId: string | null; sessionId: string; refresh: string; issuer: string; scope: string }): Promise<Tokens> {
  const signer = identitySigner(deps);
  if (!signer) throw new AuthUnavailable("Auth needs REVENUEDOT_SIGNING_KEY or REVENUEDOT_ENCRYPTION_KEY on this server to sign tokens.");
  const { key, kid } = await signer.catch(() => { throw new AuthUnavailable("The server's REVENUEDOT_SIGNING_KEY or REVENUEDOT_ENCRYPTION_KEY is not valid base64, so Auth cannot sign tokens."); });
  const now = deps.now();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + SUBSCRIBER_TOKEN_TTL_MS / 1000;
  const claims = { iss: o.issuer, sub: o.appUserId, aud: o.app.id, "rc.app_user_id": o.appUserId, amr: [o.method], iat, exp };
  const access = await signEdDsa({ typ: "at+jwt", kid }, { ...claims, client_id: o.app.id, scope: o.scope, jti: b64url(crypto.getRandomValues(new Uint8Array(24))) }, key);
  const id = await signEdDsa({ typ: "JWT", kid }, { ...claims, auth_time: iat, ...(o.providerId ? { idp: o.providerId } : {}) }, key);
  await deps.db.insert(schema.subscriberTokens).values({
    hash: await sha256Hex(access), projectId: o.app.projectId, appId: o.app.id, appUserId: o.appUserId, sessionId: o.sessionId,
    expiresAt: new Date(now.getTime() + SUBSCRIBER_TOKEN_TTL_MS), createdAt: now,
  });
  return { access_token: access, refresh_token: o.refresh, id_token: id, scope: o.scope, expires_in: SUBSCRIBER_TOKEN_TTL_MS / 1000, token_type: "Bearer" };
}

/** POST /auth/login */
export async function signIn(deps: Deps, o: { app: AppRecord; method: string; idToken?: string; linkToId?: string; scope?: string; issuer: string; sandbox: boolean }): Promise<SignedIn> {
  const db = deps.db;
  const [project] = await db.select({ auth: schema.projects.authSettings }).from(schema.projects).where(eq(schema.projects.id, o.app.projectId)).limit(1);
  const settings = project?.auth ?? {};
  if (!settings.enabled) throw new AuthRefused("Auth is turned off for this project. Turn it on in the dashboard under Auth.");
  if (!(METHODS as readonly string[]).includes(o.method)) throw new AuthRefused(`Sign-in method ${JSON.stringify(o.method)} is not supported.`);
  const method = o.method as Method;
  const now = deps.now();
  let appUserId: string, providerId: string | null = null, subject: string | null = null, created = false;

  if (method === "anonymous") {
    if (!settings.allow_anonymous) throw new AuthRefused("Anonymous sign-in is turned off for this project.");
    appUserId = `$RCAnonymousID:${randomHex(16)}`;
    created = (await getOrCreateCustomer(db, o.app.projectId, appUserId, now)).created;
  } else {
    if (!o.idToken) throw new TokenInvalid("id_token is required.");
    const providers = (await db.select().from(schema.authProviders).where(and(eq(schema.authProviders.projectId, o.app.projectId), eq(schema.authProviders.enabled, true))))
      .filter((p) => kindsFor(method).includes(p.kind));
    if (!providers.length) throw new AuthRefused(`No enabled ${method === "firebase" ? "Firebase" : "OpenID Connect"} provider is set up for this project.`);
    // A token is tried against each provider whose issuer it names (an OIDC project may have several).
    let iss: unknown = null;
    try { iss = decodeJwt(o.idToken).payload.iss; } catch { /* verifyIdToken reports it */ }
    const p = providers.find((x) => x.issuer === iss) ?? providers[0]!;
    const v = await verifyIdToken(deps, providerConfig(p), o.idToken);
    providerId = p.id; subject = v.subject;
    const [link] = await db.select().from(schema.identityLinks).where(and(eq(schema.identityLinks.providerId, p.id), eq(schema.identityLinks.subject, v.subject))).limit(1);
    appUserId = link?.appUserId ?? v.appUserId;
    // logIn semantics: an anonymous id the app was using merges into the signed-in user.
    const link_to = o.linkToId && o.linkToId.length <= 100 && isAnonymous(o.linkToId) ? o.linkToId : null;
    if (link_to) {
      const r = await identify(db, o.app.projectId, link_to, appUserId, now);
      created = r.created;
      if (r.aliased) await recordSubscriberAlias(db, { projectId: o.app.projectId, appId: o.app.id, customerId: r.customer.id, appUserId, sandbox: o.sandbox, now });
    } else {
      created = (await getOrCreateCustomer(db, o.app.projectId, appUserId, now)).created;
    }
    if (link) {
      await db.update(schema.identityLinks).set({ lastLoginAt: now, logins: sql`${schema.identityLinks.logins} + 1` })
        .where(and(eq(schema.identityLinks.providerId, p.id), eq(schema.identityLinks.subject, v.subject)));
    } else {
      await db.insert(schema.identityLinks).values({ projectId: o.app.projectId, providerId: p.id, subject: v.subject, appUserId, lastLoginAt: now, createdAt: now }).onConflictDoNothing();
    }
  }

  const refresh = `${REFRESH_PREFIX}${randomHex(32)}`;
  const sessionId = newId("ses_", 16);
  await db.insert(schema.identitySessions).values({
    id: sessionId, projectId: o.app.projectId, appId: o.app.id, appUserId, providerId, subject, method,
    refreshHash: await sha256Hex(refresh), expiresAt: new Date(now.getTime() + REFRESH_TTL_MS), createdAt: now, lastUsedAt: now,
  });
  // Ended sessions are kept a day for "revoked" answers, then dropped with their tokens.
  await db.delete(schema.identitySessions).where(and(eq(schema.identitySessions.projectId, o.app.projectId), lt(schema.identitySessions.expiresAt, new Date(now.getTime() - 86400_000))));
  const tokens = await issue(deps, { app: o.app, appUserId, method, providerId, sessionId, refresh, issuer: o.issuer, scope: o.scope || "openid offline_access" });
  return { tokens, appUserId, created };
}

/** POST /auth/token: a new access and ID token for a live session; the refresh token rotates. */
export async function refresh(deps: Deps, o: { app: AppRecord; refreshToken: string; issuer: string; scope?: string }): Promise<SignedIn> {
  const db = deps.db;
  const now = deps.now();
  const S = schema.identitySessions;
  const hash = await sha256Hex(o.refreshToken);
  const [s] = await db.select().from(S).where(eq(S.refreshHash, hash)).limit(1);
  if (!s) {
    // Reuse detection (OAuth 2.0 Security BCP §4.14): a refresh token that was already rotated away is a replay, by a thief
    // or by the app after a thief. Either way the session ends, so a stolen token stops working for both.
    const [replayed] = await db.select({ id: S.id, appId: S.appId }).from(S).where(eq(S.previousRefreshHash, hash)).limit(1);
    if (replayed && replayed.appId === o.app.id) await endSession(db, replayed.id, now);
    throw new TokenInvalid(replayed ? "The refresh token was already used. The session has ended; sign in again." : "The refresh token is not valid. Sign in again.");
  }
  if (s.appId !== o.app.id || s.revokedAt || s.expiresAt <= now) throw new TokenInvalid("The refresh token is not valid. Sign in again.");
  // A session lives only while Auth, its sign-in method and its provider are still turned on.
  const [project] = await db.select({ auth: schema.projects.authSettings }).from(schema.projects).where(eq(schema.projects.id, s.projectId)).limit(1);
  const settings = project?.auth ?? {};
  if (!settings.enabled) throw new AuthRefused("Auth is turned off for this project.");
  if (s.method === "anonymous" && !settings.allow_anonymous) throw new AuthRefused("Anonymous sign-in is turned off for this project.");
  if (s.providerId) {
    const [p] = await db.select({ enabled: schema.authProviders.enabled }).from(schema.authProviders).where(eq(schema.authProviders.id, s.providerId)).limit(1);
    if (!p?.enabled) throw new AuthRefused("The identity provider of this session is turned off. Sign in again.");
  }
  const next = `${REFRESH_PREFIX}${randomHex(32)}`;
  // Only one concurrent refresh wins the rotation; the other is refused like a reused token.
  const rotated = await db.update(S).set({ refreshHash: await sha256Hex(next), previousRefreshHash: s.refreshHash, lastUsedAt: now, expiresAt: new Date(now.getTime() + REFRESH_TTL_MS) })
    .where(and(eq(S.id, s.id), eq(S.refreshHash, s.refreshHash), isNull(S.revokedAt))).returning({ id: S.id });
  if (!rotated.length) throw new TokenInvalid("The refresh token was already used. Sign in again.");
  const tokens = await issue(deps, { app: o.app, appUserId: s.appUserId, method: s.method, providerId: s.providerId, sessionId: s.id, refresh: next, issuer: o.issuer, scope: o.scope || "openid offline_access" });
  return { tokens, appUserId: s.appUserId, created: false };
}

/** Ends a session: refresh refused from now on, and every access token it issued stops working at once. */
async function endSession(db: DB, sessionId: string, now: Date) {
  await db.update(schema.identitySessions).set({ revokedAt: now }).where(and(eq(schema.identitySessions.id, sessionId), isNull(schema.identitySessions.revokedAt)));
  await db.delete(schema.subscriberTokens).where(eq(schema.subscriberTokens.sessionId, sessionId));
}

/**
 * POST /auth/revoke (RFC 7009: unknown tokens are not an error, and a wrong `token_type_hint` only changes the search
 * order). A refresh token ends its session and every access token it issued; an access token stops working by itself.
 */
export async function revoke(deps: Deps, o: { app: AppRecord; token: string }) {
  const db = deps.db;
  const hash = await sha256Hex(o.token);
  const [s] = await db.select({ id: schema.identitySessions.id }).from(schema.identitySessions)
    .where(and(eq(schema.identitySessions.refreshHash, hash), eq(schema.identitySessions.appId, o.app.id))).limit(1);
  if (s) return endSession(db, s.id, deps.now());
  await db.delete(schema.subscriberTokens).where(and(eq(schema.subscriberTokens.hash, hash), eq(schema.subscriberTokens.appId, o.app.id)));
}

/** Ends every session of these identity links (an unlinked identity, a deleted provider). */
export async function revokeSessions(db: DB, projectId: string, where: { providerId: string; subjects?: string[] }) {
  const S = schema.identitySessions;
  const conds = [eq(S.projectId, projectId), eq(S.providerId, where.providerId), ...(where.subjects ? [inArray(S.subject, where.subjects)] : [])];
  const ids = (await db.select({ id: S.id }).from(S).where(and(...conds))).map((x) => x.id);
  if (ids.length) await db.delete(S).where(inArray(S.id, ids));
}
