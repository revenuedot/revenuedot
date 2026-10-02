// RevenueDot Enterprise (ee/LICENSE). OpenID Connect relying party: discovery, authorization code flow with PKCE (S256),
// state and nonce, token exchange and id_token verification with jose. Spec: prd/enterprise/PRD.md §5.
import { createLocalJWKSet, jwtVerify, errors as joseErrors, type JSONWebKeySet, type JWTPayload } from "jose";
import { and, eq } from "drizzle-orm";
import type { DB } from "@revenuedot/db";
import { outboundUrlProblem } from "../../../apps/server/src/services/outbound.js";
import { eeSsoRequests, type OidcConfig } from "../schema.js";
import { randomHex } from "../util.js";
import { EMAIL_RE, type SsoIdentity } from "./saml.js";

const STATE_TTL_MS = 10 * 60_000;
const CACHE_MS = 10 * 60_000;
export const DEFAULT_SCOPES = ["openid", "email", "profile"];

export const oidcUrls = (base: string, id: string) => ({ redirect_uri: `${base}/sso/oidc/${id}/callback`, start_url: `${base}/sso/connections/${id}/start` });

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** An error whose message is safe for the organization's audit log (never contains a token or secret). */
export class OidcError extends Error {}

type FetchFn = typeof fetch;
// Per fetch implementation, so tests with their own fake identity providers never share entries.
const discoveryCache = new WeakMap<object, Map<string, { at: number; doc: Discovery }>>();
const jwksCache = new WeakMap<object, Map<string, { at: number; jwks: JSONWebKeySet }>>();
const cacheFor = <T>(m: WeakMap<object, Map<string, T>>, f: FetchFn) => { let c = m.get(f); if (!c) { c = new Map(); m.set(f, c); } return c; };

/** GET or POST to an identity provider URL that passed the outbound guard; redirects are not followed. */
async function idpFetch(fetchFn: FetchFn, url: string, strict: boolean, init: RequestInit = {}): Promise<Response> {
  const problem = outboundUrlProblem(url, strict);
  if (problem) throw new OidcError(`The identity provider URL ${problem}.`);
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new OidcError(`The identity provider could not be reached (${new URL(url).host}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 300 && res.status < 400) throw new OidcError(`The identity provider answered with a redirect (${res.status}), which is not followed.`);
  return res;
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export async function discover(fetchFn: FetchFn, issuer: string, strict: boolean, nowMs: number): Promise<Discovery> {
  const cache = cacheFor(discoveryCache, fetchFn);
  const hit = cache.get(issuer);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.doc;
  const res = await idpFetch(fetchFn, `${trimSlash(issuer)}/.well-known/openid-configuration`, strict, { headers: { accept: "application/json" } });
  if (!res.ok) throw new OidcError(`Discovery answered ${res.status}.`);
  const doc = (await res.json().catch(() => null)) as Partial<Discovery> | null;
  if (!doc || typeof doc.issuer !== "string" || typeof doc.authorization_endpoint !== "string" || typeof doc.token_endpoint !== "string" || typeof doc.jwks_uri !== "string") {
    throw new OidcError("Discovery did not return issuer, authorization_endpoint, token_endpoint and jwks_uri.");
  }
  if (trimSlash(doc.issuer) !== trimSlash(issuer)) throw new OidcError(`Discovery issuer ${doc.issuer.slice(0, 200)} is not the configured issuer.`);
  for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
    const p = outboundUrlProblem(u, strict);
    if (p) throw new OidcError(`A discovery endpoint ${p}.`);
  }
  const clean: Discovery = {
    issuer: doc.issuer, authorization_endpoint: doc.authorization_endpoint, token_endpoint: doc.token_endpoint, jwks_uri: doc.jwks_uri,
    token_endpoint_auth_methods_supported: Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported.filter((x) => typeof x === "string") : undefined,
  };
  if (cache.size > 500) cache.clear();
  cache.set(issuer, { at: nowMs, doc: clean });
  return clean;
}

async function jwks(fetchFn: FetchFn, uri: string, strict: boolean, nowMs: number, fresh: boolean): Promise<JSONWebKeySet> {
  const cache = cacheFor(jwksCache, fetchFn);
  const hit = cache.get(uri);
  if (!fresh && hit && nowMs - hit.at < CACHE_MS) return hit.jwks;
  const res = await idpFetch(fetchFn, uri, strict, { headers: { accept: "application/json" } });
  if (!res.ok) throw new OidcError(`The JWKS endpoint answered ${res.status}.`);
  const set = (await res.json().catch(() => null)) as JSONWebKeySet | null;
  if (!set || !Array.isArray(set.keys)) throw new OidcError("The JWKS endpoint did not return a key set.");
  if (cache.size > 500) cache.clear();
  cache.set(uri, { at: nowMs, jwks: set });
  return set;
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Stores the state row (nonce and PKCE verifier) and returns the identity provider's authorization URL. */
export async function oidcStartUrl(o: { db: DB; fetch: FetchFn; strict: boolean; now: Date; base: string; connectionId: string; cfg: OidcConfig; next: string; loginHint?: string | null }): Promise<{ url: string; state: string }> {
  const d = await discover(o.fetch, o.cfg.issuer, o.strict, o.now.getTime());
  const state = `st_${randomHex(24)}`;
  const nonce = randomHex(24);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await o.db.insert(eeSsoRequests).values({ id: state, connectionId: o.connectionId, value: JSON.stringify({ nonce, verifier }), returnTo: o.next, expiresAt: new Date(o.now.getTime() + STATE_TTL_MS), createdAt: o.now });
  const url = new URL(d.authorization_endpoint);
  const scopes = o.cfg.scopes?.length ? o.cfg.scopes : DEFAULT_SCOPES;
  const params: Record<string, string> = {
    response_type: "code", client_id: o.cfg.client_id, redirect_uri: oidcUrls(o.base, o.connectionId).redirect_uri, scope: (scopes.includes("openid") ? scopes : ["openid", ...scopes]).join(" "),
    state, nonce, code_challenge: challenge, code_challenge_method: "S256",
  };
  if (o.loginHint) params.login_hint = o.loginHint;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { url: url.toString(), state };
}

/** Consumes a state row (single use, even when the sign-in then fails). */
export async function takeState(db: DB, connectionId: string, state: string, now: Date): Promise<{ nonce: string; verifier: string; next: string | null } | null> {
  if (!state || state.length > 200) return null;
  const [row] = await db.delete(eeSsoRequests).where(and(eq(eeSsoRequests.id, state), eq(eeSsoRequests.connectionId, connectionId))).returning();
  if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
  try {
    const v = JSON.parse(row.value) as { nonce?: unknown; verifier?: unknown };
    if (typeof v.nonce !== "string" || typeof v.verifier !== "string") return null;
    return { nonce: v.nonce, verifier: v.verifier, next: row.returnTo };
  } catch {
    return null;
  }
}

/** Exchanges the code and verifies the id_token. Throws OidcError with a reason for the audit log. */
export async function oidcFinish(o: { fetch: FetchFn; strict: boolean; now: Date; base: string; connectionId: string; cfg: OidcConfig; clientSecret: string | null; code: string; nonce: string; verifier: string }): Promise<SsoIdentity> {
  const d = await discover(o.fetch, o.cfg.issuer, o.strict, o.now.getTime());
  const form = new URLSearchParams({ grant_type: "authorization_code", code: o.code, redirect_uri: oidcUrls(o.base, o.connectionId).redirect_uri, code_verifier: o.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  // OpenID Connect Discovery: client_secret_basic is the default when the provider lists no methods.
  const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (o.clientSecret && methods.includes("client_secret_basic")) {
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
    headers.authorization = `Basic ${btoa(`${enc(o.cfg.client_id)}:${enc(o.clientSecret)}`)}`;
  } else {
    form.set("client_id", o.cfg.client_id);
    if (o.clientSecret) form.set("client_secret", o.clientSecret);
  }
  const res = await idpFetch(o.fetch, d.token_endpoint, o.strict, { method: "POST", headers, body: form.toString() });
  const tok = (await res.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null;
  if (!res.ok) throw new OidcError(`The token endpoint answered ${res.status}${typeof tok?.error === "string" ? ` (${tok.error.slice(0, 100)})` : ""}.`);
  if (typeof tok?.id_token !== "string") throw new OidcError("The token endpoint returned no id_token.");

  const verify = async (fresh: boolean) => jwtVerify(tok.id_token as string, createLocalJWKSet(await jwks(o.fetch, d.jwks_uri, o.strict, o.now.getTime(), fresh)), {
    issuer: d.issuer, audience: o.cfg.client_id, clockTolerance: 60, algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"], currentDate: o.now, requiredClaims: ["exp", "iat", "sub"],
  });
  let payload: JWTPayload;
  try {
    payload = (await verify(false)).payload;
  } catch (e) {
    // The provider may have rotated its keys since the key set was cached.
    if (!(e instanceof joseErrors.JWKSNoMatchingKey)) throw new OidcError(`id_token: ${e instanceof Error ? e.message : String(e)}`);
    try { payload = (await verify(true)).payload; } catch (e2) { throw new OidcError(`id_token: ${e2 instanceof Error ? e2.message : String(e2)}`); }
  }
  if (payload.nonce !== o.nonce) throw new OidcError("id_token nonce does not match the sign-in request.");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if ((aud.length > 1 || payload.azp !== undefined) && payload.azp !== o.cfg.client_id) throw new OidcError("id_token azp is not this client.");
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) throw new OidcError("id_token has no email claim (add the email scope).");
  if (payload.email_verified === false || payload.email_verified === "false") throw new OidcError("id_token says the email address is not verified.");
  const raw = o.cfg.groups_claim ? payload[o.cfg.groups_claim] : undefined;
  const groups = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((g): g is string => typeof g === "string");
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string).trim() : "");
  const name = str("name") || [str("given_name"), str("family_name")].filter(Boolean).join(" ") || null;
  return { email, name: name ? name.slice(0, 100) : null, groups };
}
