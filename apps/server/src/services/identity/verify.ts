import { ANON_PREFIX, isAnonymous } from "@revenuedot/core";
import type { Deps } from "../../context.js";
import { OutboundRefused, outboundUrlProblem } from "../outbound.js";
import { ALGS, decodeJwt, importJwk, jwkFits, verifySignature, type Alg, type Jwk } from "./jwt.js";

/**
 * Verifies identity provider ID tokens for Auth (prd/auth §3). Keys come from the provider's JWKS, fetched through the
 * outbound guard (public https only on Cloud, never a redirect, 10 s, 256 KB) and kept per URL for the response's max-age
 * (5 minutes to 24 hours, else 1 hour). An unknown `kid` fetches again at most once a minute. A refetch that fails keeps
 * the old keys, so a provider outage does not sign everyone out; with no keys at all the caller answers 503.
 */

export const FIREBASE_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
export const firebaseIssuer = (projectId: string) => `https://securetoken.google.com/${projectId}`;
const LEEWAY_S = 60;
const MAX_TOKEN = 16_384;
const MIN_TTL = 5 * 60_000, MAX_TTL = 24 * 3600_000, DEFAULT_TTL = 3600_000, REFETCH_MS = 60_000, MAX_BODY = 256_000;

export class TokenInvalid extends Error {}
export class KeysUnavailable extends Error {}

export interface ProviderConfig {
  id: string; kind: string; issuer: string; audiences: string[]; jwksUrl: string | null;
  appUserIdClaim: string; appUserIdPrefix: string;
}

interface Entry { keys: Jwk[]; imported: Map<string, CryptoKey>; fetchedAt: number; ttl: number; lastAttempt: number }
const cache = new Map<string, Entry>();
const discovery = new Map<string, { jwksUri: string; at: number }>();
/** When a discovery document last failed to load, so a provider that is down is asked at most once a minute. */
const discoveryFailed = new Map<string, number>();
/** Tests start from an empty cache. */
export const clearIdentityCaches = () => { cache.clear(); discovery.clear(); discoveryFailed.clear(); };

async function getJson(deps: Deps, url: string): Promise<{ json: unknown; maxAge: number | null }> {
  const problem = outboundUrlProblem(url, deps.edition === "cloud");
  if (problem) throw new OutboundRefused(`The key URL ${problem}.`);
  const f = deps.fetch ?? fetch;
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(10_000) : undefined;
  const res = await f(url, { headers: { accept: "application/json" }, redirect: "manual", ...(signal ? { signal } : {}) });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new OutboundRefused(`The key URL answered with a redirect (${res.status}), which is not followed.`);
  if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`HTTP ${res.status}`); }
  const text = await readCapped(res, MAX_BODY);
  const m = /max-age=(\d+)/i.exec(res.headers.get("cache-control") ?? "");
  return { json: JSON.parse(text), maxAge: m ? Number(m[1]) * 1000 : null };
}

/** The body as text, read no further than `max` bytes: a provider (or a URL a project typed) cannot make us buffer more. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) { await res.body?.cancel().catch(() => {}); throw new Error("the answer is larger than 256 KB"); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error("the answer is larger than 256 KB"); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** The JWKS URL of a provider: configured, Firebase's, or `jwks_uri` from the issuer's discovery document (kept 24 hours). */
export async function jwksUrlOf(deps: Deps, p: ProviderConfig, now: number): Promise<string> {
  if (p.jwksUrl) return p.jwksUrl;
  if (p.kind === "firebase") return FIREBASE_JWKS;
  const hit = discovery.get(p.issuer);
  if (hit && now - hit.at < MAX_TTL) return hit.jwksUri;
  const failedAt = discoveryFailed.get(p.issuer);
  if (failedAt !== undefined && now - failedAt <= REFETCH_MS) {
    if (hit) return hit.jwksUri;
    throw new KeysUnavailable("The provider's discovery document is not available right now.");
  }
  let doc: { issuer?: unknown; jwks_uri?: unknown };
  try {
    doc = (await getJson(deps, `${p.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`)).json as typeof doc;
  } catch (e) {
    discoveryFailed.set(p.issuer, now);
    if (hit) return hit.jwksUri;
    throw new KeysUnavailable(`The provider's discovery document could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
  // OpenID Connect Discovery 1.0 §4.3: the document's issuer must be the one we asked for.
  if (typeof doc?.jwks_uri !== "string" || doc.issuer !== p.issuer) {
    discoveryFailed.set(p.issuer, now);
    throw new KeysUnavailable("The provider's discovery document has no jwks_uri or names a different issuer.");
  }
  discoveryFailed.delete(p.issuer);
  discovery.set(p.issuer, { jwksUri: doc.jwks_uri, at: now });
  return doc.jwks_uri;
}

async function load(deps: Deps, url: string, now: number, entry: Entry | undefined): Promise<Entry> {
  if (entry) entry.lastAttempt = now;
  try {
    const { json, maxAge } = await getJson(deps, url);
    const keys = (Array.isArray((json as { keys?: unknown })?.keys) ? (json as { keys: Jwk[] }).keys : []).filter((k) => k && typeof k === "object").slice(0, 100);
    if (!keys.length) throw new Error("no keys in the answer");
    const next: Entry = { keys, imported: new Map(), fetchedAt: now, ttl: Math.min(MAX_TTL, Math.max(MIN_TTL, maxAge ?? DEFAULT_TTL)), lastAttempt: now };
    cache.set(url, next);
    return next;
  } catch (e) {
    if (entry) return entry;
    cache.set(url, { keys: [], imported: new Map(), fetchedAt: 0, ttl: 0, lastAttempt: now });
    throw new KeysUnavailable(`The provider's signing keys could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Keys that may have signed this token, fetching or refreshing the JWKS as the rules above allow. */
async function candidates(deps: Deps, url: string, kid: string | undefined, alg: Alg, now: number): Promise<{ jwk: Jwk; entry: Entry }[]> {
  let e = cache.get(url);
  const mayFetch = () => !e || now - e.lastAttempt > REFETCH_MS;
  if (!e || !e.keys.length) {
    if (e && !mayFetch()) throw new KeysUnavailable("The provider's signing keys are not available right now.");
    e = await load(deps, url, now, e?.keys.length ? e : undefined);
  } else if (now - e.fetchedAt > e.ttl && mayFetch()) {
    e = await load(deps, url, now, e);
  }
  const pick = (x: Entry) => x.keys.filter((k) => (kid ? k.kid === kid : true) && jwkFits(k, alg)).map((jwk) => ({ jwk, entry: x }));
  let found = pick(e);
  if (!found.length && kid && mayFetch()) { e = await load(deps, url, now, e); found = pick(e); }
  return found;
}

export interface VerifiedIdentity { subject: string; appUserId: string; claims: Record<string, unknown> }

/** Verifies an ID token for one provider and maps it to an app user id. Throws TokenInvalid or KeysUnavailable. */
export async function verifyIdToken(deps: Deps, p: ProviderConfig, token: string): Promise<VerifiedIdentity> {
  if (!token || token.length > MAX_TOKEN) throw new TokenInvalid("The ID token is missing or longer than 16 KB.");
  let d;
  try { d = decodeJwt(token.trim()); } catch { throw new TokenInvalid("The ID token is not a JWT."); }
  const alg = d.header.alg as Alg;
  if (!ALGS.includes(alg)) throw new TokenInvalid(`ID tokens signed with ${JSON.stringify(d.header.alg)} are not accepted.`);
  if (d.header.crit !== undefined) throw new TokenInvalid("ID tokens with critical header parameters are not accepted.");
  const kid = typeof d.header.kid === "string" ? d.header.kid : undefined;
  const now = deps.now().getTime();
  const url = await jwksUrlOf(deps, p, now);
  const keys = await candidates(deps, url, kid, alg, now);
  if (!keys.length) throw new TokenInvalid(kid ? `No signing key with kid ${kid} for ${alg}.` : `No signing key for ${alg}.`);
  let ok = false;
  for (const { jwk, entry } of keys) {
    const id = `${jwk.kid ?? ""}:${alg}:${entry.keys.indexOf(jwk)}`;
    let key = entry.imported.get(id);
    if (!key) { try { key = await importJwk(jwk, alg); entry.imported.set(id, key); } catch { continue; } }
    if (await verifySignature(d, alg, key)) { ok = true; break; }
  }
  if (!ok) throw new TokenInvalid("The ID token's signature does not verify.");
  const c = d.payload;
  const s = now / 1000;
  if (c.iss !== p.issuer) throw new TokenInvalid(`The ID token's issuer ${JSON.stringify(c.iss)} is not ${p.issuer}.`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.some((a) => typeof a === "string" && p.audiences.includes(a))) throw new TokenInvalid("The ID token's audience is not one this provider accepts.");
  if (typeof c.exp !== "number" || c.exp + LEEWAY_S <= s) throw new TokenInvalid("The ID token has expired.");
  if (typeof c.nbf === "number" && c.nbf - LEEWAY_S > s) throw new TokenInvalid("The ID token is not valid yet.");
  if (typeof c.iat === "number" && c.iat - LEEWAY_S > s) throw new TokenInvalid("The ID token was issued in the future.");
  if (p.kind === "firebase" && (typeof c.auth_time !== "number" || c.auth_time - LEEWAY_S > s)) throw new TokenInvalid("The Firebase ID token has no valid auth_time.");
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 255) throw new TokenInvalid("The ID token has no subject.");
  const raw = c[p.appUserIdClaim];
  if (typeof raw !== "string" && typeof raw !== "number") throw new TokenInvalid(`The ID token has no ${p.appUserIdClaim} claim to use as the app user ID.`);
  const appUserId = `${p.appUserIdPrefix}${raw}`;
  if (!appUserId || appUserId.length > 100) throw new TokenInvalid("The mapped app user ID must be 1 to 100 characters.");
  // A signed-in user is never anonymous: an id in the anonymous format would let a later sign-in's link_to_id merge into it.
  if (isAnonymous(appUserId)) throw new TokenInvalid(`The mapped app user ID must not start with ${ANON_PREFIX}.`);
  return { subject: c.sub, appUserId, claims: c };
}
