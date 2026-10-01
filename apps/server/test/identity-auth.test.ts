import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { clearIdentityCaches, FIREBASE_JWKS } from "../src/services/identity/verify.js";
import { decodeJwt } from "../src/services/identity/jwt.js";

/**
 * Auth (prd/auth): Firebase and OpenID Connect sign-in in the SDKs' token-login wire format. The identity provider keys
 * are generated here and served by a fake fetch (Firebase's JWKS URL, an OIDC discovery document and JWKS); nothing
 * reaches a real provider. Covers every claim check, logIn semantics with link_to_id, the SDK's JWT decoding
 * (`rc.app_user_id`, `amr`), refresh rotation, revocation, the `/v1/customer/*` reads, balances by identity, the key
 * cache and the outbound guard.
 */

const FB_PROJECT = "scanner-1a2b3";
const FB_ISS = `https://securetoken.google.com/${FB_PROJECT}`;
const OIDC_ISS = "https://idp.example.com";
const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const part = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

interface Keys { rsa: CryptoKeyPair; rsaJwk: JsonWebKey; ec: CryptoKeyPair; ecJwk: JsonWebKey; rsa2: CryptoKeyPair; rsa2Jwk: JsonWebKey }
let keys: Keys;
async function makeKeys(): Promise<Keys> {
  const rsaAlg = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const rsa = await crypto.subtle.generateKey(rsaAlg, true, ["sign", "verify"]) as CryptoKeyPair;
  const rsa2 = await crypto.subtle.generateKey(rsaAlg, true, ["sign", "verify"]) as CryptoKeyPair;
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = async (k: CryptoKey, kid: string, alg: string) => { const j = await crypto.subtle.exportKey("jwk", k); return { kty: j.kty, n: j.n, e: j.e, crv: j.crv, x: j.x, y: j.y, kid, alg, use: "sig" } as JsonWebKey; };
  return { rsa, rsaJwk: await pub(rsa.publicKey, "fb1", "RS256"), ec, ecJwk: await pub(ec.publicKey, "ec1", "ES256"), rsa2, rsa2Jwk: await pub(rsa2.publicKey, "fb2", "RS256") };
}

async function jwt(header: Record<string, unknown>, payload: Record<string, unknown>, key?: CryptoKey): Promise<string> {
  const input = `${part(header)}.${part(payload)}`;
  if (!key) return `${input}.`;
  const alg = header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign(alg, key, enc.encode(input))))}`;
}

let h: Harness;
let fetched: Record<string, number>;
let jwks: Record<string, JsonWebKey[]>;
let failing = false;
/** A test's own answer for a URL (null: the fakes below answer). */
let override: ((url: string) => Response | null) | null = null;
const fakeFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetched[url] = (fetched[url] ?? 0) + 1;
  const own = override?.(url);
  if (own) return own;
  if (failing) return new Response("down", { status: 503 });
  if (url === `${OIDC_ISS}/.well-known/openid-configuration`) return Response.json({ issuer: OIDC_ISS, jwks_uri: `${OIDC_ISS}/jwks` });
  if (jwks[url]) return Response.json({ keys: jwks[url] }, { headers: { "cache-control": "public, max-age=3600" } });
  return new Response("not found", { status: 404 });
};

const P = () => `/v2/projects/${h.ids.project}`;
const v2 = async (method: string, path: string, json?: unknown, key = h.ids.secretKey) => {
  const res = await h.fetch(path, { method, key, ...(json === undefined ? {} : { json }) });
  return { status: res.status, body: await res.json() as any };
};
const login = async (body: Record<string, unknown>, key = h.ids.iosKey, path = "/auth/login") => {
  const res = await h.fetch(path, { method: "POST", key, json: { scope: "openid offline_access", ...body } });
  return { status: res.status, body: await res.json() as any, headers: res.headers };
};
const now = () => Math.floor(h.now().getTime() / 1000);
const firebaseToken = (over: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: CryptoKey = keys.rsa.privateKey) =>
  jwt({ alg: "RS256", kid: "fb1", typ: "JWT", ...header }, { iss: FB_ISS, aud: FB_PROJECT, sub: "uid_alice", auth_time: now() - 10, iat: now() - 10, exp: now() + 3600, email: "alice@example.com", ...over }, key);
const oidcToken = (over: Record<string, unknown> = {}) =>
  jwt({ alg: "ES256", kid: "ec1" }, { iss: OIDC_ISS, aud: "client-123", sub: "oidc|42", email: "bob@example.com", iat: now(), exp: now() + 600, ...over }, keys.ec.privateKey);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const getAs = (token: string, path: string) => h.fetch(path, { key: token });

beforeEach(async () => {
  keys ??= await makeKeys();
  clearIdentityCaches();
  fetched = {}; failing = false; override = null;
  jwks = { [FIREBASE_JWKS]: [keys.rsaJwk], [`${OIDC_ISS}/jwks`]: [keys.ecJwk] };
  const seed = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  h = await harness({ fetch: fakeFetch, signingKey: seed });
});
afterEach(async () => { await h.close(); });

async function enableFirebase(extra: Record<string, unknown> = {}) {
  expect((await v2("POST", `${P()}/auth/settings`, { enabled: true })).status).toBe(200);
  const p = await v2("POST", `${P()}/auth/providers`, { kind: "firebase", firebase_project_id: FB_PROJECT, ...extra });
  expect(p.status).toBe(201);
  return p.body as { id: string; issuer: string; audiences: string[] };
}

describe("Auth sign-in (POST /auth/login)", () => {
  it("is refused while Auth is off, then signs a Firebase user in with tokens the SDK can decode", async () => {
    expect((await login({ method: "firebase", id_token: await firebaseToken() })).body).toMatchObject({ code: 7224 });
    const prov = await enableFirebase();
    expect(prov).toMatchObject({ issuer: FB_ISS, audiences: [FB_PROJECT], jwks_source: "firebase" });

    const r = await login({ method: "firebase", id_token: await firebaseToken() });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-revenuecat-request-time")).toMatch(/^\d+$/);
    expect(r.body).toMatchObject({ scope: "openid offline_access", expires_in: 3600, token_type: "Bearer" });
    expect(r.body.refresh_token).toMatch(/^rdrf_[0-9a-f]{64}$/);
    // The SDKs (iOS Misc/JWT.swift, Android common/JWT.kt) split on dots, decode the payload and read these claims.
    const at = decodeJwt(r.body.access_token), idt = decodeJwt(r.body.id_token);
    expect(at.header).toMatchObject({ alg: "EdDSA", typ: "at+jwt" });
    expect(at.payload).toMatchObject({ "rc.app_user_id": "uid_alice", sub: "uid_alice", aud: h.ids.app, amr: ["firebase"] });
    expect(idt.payload).toMatchObject({ "rc.app_user_id": "uid_alice", amr: ["firebase"], idp: prov.id, iss: "http://localhost" });

    // The ID token verifies with the published key.
    const jwksRes = await (await h.fetch("/.well-known/jwks.json", { key: "" })).json() as { keys: JsonWebKey[] };
    expect(jwksRes.keys).toHaveLength(1);
    expect(jwksRes.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", kid: idt.header.kid });
    const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwksRes.keys[0]!.x }, { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, pub, idt.signature, idt.signingInput)).toBe(true);

    // The access token reads customer info, pinned to its app user id.
    const info = await getAs(r.body.access_token, "/v1/customer");
    expect(info.status).toBe(200);
    expect((await info.json() as any).subscriber.original_app_user_id).toBe("uid_alice");
    const other = await getAs(r.body.access_token, "/v1/subscribers/someone_else");
    expect(other.status).toBe(401);
    expect(await other.json()).toMatchObject({ code: 7224 });
    // Stored hashed only.
    const rows = await h.db.select().from(schema.subscriberTokens).where(eq(schema.subscriberTokens.appUserId, "uid_alice"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).not.toContain(".");
    const [link] = await h.db.select().from(schema.identityLinks);
    expect(link).toMatchObject({ providerId: prov.id, subject: "uid_alice", appUserId: "uid_alice", logins: 1 });
    // The key cache: one fetch of Firebase's keys for two sign-ins.
    await login({ method: "firebase", id_token: await firebaseToken() });
    expect(fetched[FIREBASE_JWKS]).toBe(1);
  });

  it("refuses tokens that fail any check, with the SDK's invalid-token code", async () => {
    await enableFirebase();
    const cases: [string, Promise<string>][] = [
      ["wrong audience", firebaseToken({ aud: "another-project" })],
      ["wrong issuer", firebaseToken({ iss: "https://securetoken.google.com/another-project" })],
      ["expired", firebaseToken({ exp: now() - 120 })],
      ["not yet valid", firebaseToken({ nbf: now() + 600 })],
      ["issued in the future", firebaseToken({ iat: now() + 600 })],
      ["no auth_time", firebaseToken({ auth_time: undefined })],
      ["no subject", firebaseToken({ sub: "" })],
      ["alg none", jwt({ alg: "none", kid: "fb1" }, { iss: FB_ISS, aud: FB_PROJECT, sub: "x", exp: now() + 60, auth_time: now() })],
      ["HMAC", jwt({ alg: "HS256", kid: "fb1" }, { iss: FB_ISS, aud: FB_PROJECT, sub: "x", exp: now() + 60, auth_time: now() }).then((t) => `${t}c2ln`)],
      ["signed by another key", firebaseToken({}, {}, keys.rsa2.privateKey)],
      ["not a JWT", Promise.resolve("hello")],
    ];
    for (const [what, t] of cases) {
      const r = await login({ method: "firebase", id_token: await t });
      expect(r.status, what).toBe(401);
      expect(r.body.code, what).toBe(7224);
    }
    // A tampered payload breaks the signature.
    const good = await firebaseToken();
    const [hd, , sig] = good.split(".");
    const tampered = `${hd}.${part({ iss: FB_ISS, aud: FB_PROJECT, sub: "uid_mallory", auth_time: now(), exp: now() + 600 })}.${sig}`;
    expect((await login({ method: "firebase", id_token: tampered })).body.message).toMatch(/signature/);
    // Malformed requests and the wrong key.
    expect((await login({ id_token: good })).body).toMatchObject({ code: 7226 });
    expect((await login({ method: "firebase", id_token: good }, h.ids.secretKey)).body).toMatchObject({ code: 7225 });
    expect((await login({ method: "oidc", id_token: good })).status).toBe(403); // no OIDC provider
    expect(await h.db.select().from(schema.identityLinks)).toHaveLength(0);
  });

  it("picks up a rotated key once a minute at most, keeps working through an outage, and answers 503 without keys", async () => {
    await enableFirebase();
    expect((await login({ method: "firebase", id_token: await firebaseToken() })).status).toBe(200);
    // Google rotates: the new kid is unknown, so the keys are fetched again (more than a minute after the last fetch).
    jwks[FIREBASE_JWKS] = [keys.rsaJwk, keys.rsa2Jwk];
    h.setNow(new Date(h.now().getTime() + 61_000));
    const rotated = await firebaseToken({}, { kid: "fb2" }, keys.rsa2.privateKey);
    expect((await login({ method: "firebase", id_token: rotated })).status).toBe(200);
    expect(fetched[FIREBASE_JWKS]).toBe(2);
    // An unknown kid right after does not fetch again within the minute.
    expect((await login({ method: "firebase", id_token: await firebaseToken({}, { kid: "zzz" }) })).status).toBe(401);
    expect(fetched[FIREBASE_JWKS]).toBe(2);
    // Past the cache lifetime with the provider down: the cached keys still verify.
    failing = true;
    h.setNow(new Date(h.now().getTime() + 2 * 3600_000));
    expect((await login({ method: "firebase", id_token: await firebaseToken() })).status).toBe(200);
    // A cold cache with the provider down: 503 so the app retries.
    clearIdentityCaches();
    const down = await login({ method: "firebase", id_token: await firebaseToken() });
    expect(down.status).toBe(503);
    expect(down.body.message).toMatch(/could not be loaded/);
  });

  it("merges the anonymous id the app was using into the signed-in user (logIn semantics)", async () => {
    await enableFirebase();
    const anon = "$RCAnonymousID:0123456789abcdef0123456789abcdef";
    const buy = await h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: anon, fetch_token: `test_${h.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect(buy.status).toBe(200);
    const r = await login({ method: "firebase", id_token: await firebaseToken(), link_to_id: anon });
    expect(r.status).toBe(200);
    const info = await (await getAs(r.body.access_token, "/v1/customer")).json() as any;
    expect(Object.keys(info.subscriber.entitlements)).toContain("pro");
    const events = await h.db.select().from(schema.events).where(and(eq(schema.events.projectId, h.ids.project), eq(schema.events.type, "SUBSCRIBER_ALIAS")));
    expect(events).toHaveLength(1);
    // A non-anonymous link_to_id is ignored: it never merges another account.
    const bob = await login({ method: "firebase", id_token: await firebaseToken({ sub: "uid_bob" }), link_to_id: "uid_alice" });
    expect(decodeJwt(bob.body.access_token).payload["rc.app_user_id"]).toBe("uid_bob");
    const alice = await (await getAs(r.body.access_token, "/v1/customer")).json() as any;
    expect(alice.subscriber.original_app_user_id).toBe(anon);
  });

  it("maps OIDC identities with discovery, a claim and a prefix, and keeps an existing link when the mapping changes", async () => {
    await v2("POST", `${P()}/auth/settings`, { enabled: true });
    const prov = (await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: OIDC_ISS, audiences: ["client-123"], app_user_id_claim: "email", app_user_id_prefix: "oidc:" })).body;
    expect(prov).toMatchObject({ jwks_source: "discovery", jwks_url: null });
    const r = await login({ method: "oidc", id_token: await oidcToken() });
    expect(r.status).toBe(200);
    expect(decodeJwt(r.body.access_token).payload).toMatchObject({ "rc.app_user_id": "oidc:bob@example.com", amr: ["oidc"] });
    expect(fetched[`${OIDC_ISS}/.well-known/openid-configuration`]).toBe(1);
    // A test of a pasted token shows the mapping without signing in.
    const test = await v2("POST", `${P()}/auth/providers/${prov.id}/actions/test`, { id_token: await oidcToken() });
    expect(test.body).toMatchObject({ valid: true, subject: "oidc|42", app_user_id: "oidc:bob@example.com", linked: true });
    expect((await v2("POST", `${P()}/auth/providers/${prov.id}/actions/test`, { id_token: await oidcToken({ aud: "other" }) })).body).toMatchObject({ valid: false, error: expect.stringMatching(/audience/) });
    // Change the mapping: the linked identity keeps its app user id.
    await v2("POST", `${P()}/auth/providers/${prov.id}`, { app_user_id_claim: "sub", app_user_id_prefix: "" });
    const again = await login({ method: "oidc", id_token: await oidcToken() });
    expect(decodeJwt(again.body.access_token).payload["rc.app_user_id"]).toBe("oidc:bob@example.com");
    const fresh = await login({ method: "oidc", id_token: await oidcToken({ sub: "oidc|43" }) });
    expect(decodeJwt(fresh.body.access_token).payload["rc.app_user_id"]).toBe("oidc|43");
    // A discovery document naming another issuer is refused.
    clearIdentityCaches();
    const p2 = (await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: "https://idp.example.com/tenant", audiences: ["client-123"] })).body;
    const t2 = await jwt({ alg: "ES256", kid: "ec1" }, { iss: "https://idp.example.com/tenant", aud: "client-123", sub: "x", exp: now() + 60 }, keys.ec.privateKey);
    expect((await v2("POST", `${P()}/auth/providers/${p2.id}/actions/test`, { id_token: t2 })).body.valid).toBe(false);
  });

  it("refreshes with rotation; a replayed refresh token ends the whole session; revoke ends a session whatever the hint", async () => {
    await enableFirebase();
    const refreshWith = (rt: string, key = h.ids.iosKey) => h.fetch("/auth/token", { method: "POST", key, json: { grant_type: "refresh_token", refresh_token: rt } });
    const first = (await login({ method: "firebase", id_token: await firebaseToken() })).body;
    const t = await refreshWith(first.refresh_token);
    expect(t.status).toBe(200);
    const second = await t.json() as any;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(decodeJwt(second.access_token).payload["rc.app_user_id"]).toBe("uid_alice");
    // Another app of the project cannot use the session (and that is no replay).
    expect((await refreshWith(second.refresh_token, h.ids.androidKey)).status).toBe(401);
    // Both access tokens work while the session lives.
    expect((await getAs(first.access_token, "/v1/customer")).status).toBe(200);
    expect((await getAs(second.access_token, "/v1/customer")).status).toBe(200);
    // Replaying the rotated-away token (a thief, or the app after a thief) ends the session for everyone.
    const reused = await refreshWith(first.refresh_token);
    expect(reused.status).toBe(401);
    expect(await reused.json()).toMatchObject({ code: 7224, message: expect.stringMatching(/already used/) });
    expect((await refreshWith(second.refresh_token)).status).toBe(401);
    for (const a of [first.access_token, second.access_token]) {
      const res = await getAs(a, "/v1/customer");
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 7224 });
    }
    const [ended] = await h.db.select().from(schema.identitySessions).where(eq(schema.identitySessions.appUserId, "uid_alice"));
    expect(ended!.revokedAt).not.toBeNull();

    // Revoke: a refresh token ends its session and its access tokens, also when the hint says access_token.
    const next = (await login({ method: "firebase", id_token: await firebaseToken() })).body;
    const rv = await h.fetch("/v1/auth/revoke", { method: "POST", key: h.ids.iosKey, json: { token: next.refresh_token, token_type_hint: "access_token" } });
    expect(rv.status).toBe(200);
    expect(rv.headers.get("access-control-allow-origin")).toBe("*");
    expect((await getAs(next.access_token, "/v1/customer")).status).toBe(401);
    expect((await refreshWith(next.refresh_token)).status).toBe(401);
    // An access token alone can be revoked; unknown tokens are fine (RFC 7009).
    const third = (await login({ method: "firebase", id_token: await firebaseToken() })).body;
    expect((await h.fetch("/auth/revoke", { method: "POST", key: h.ids.iosKey, json: { token: third.access_token, token_type_hint: "access_token" } })).status).toBe(200);
    expect((await getAs(third.access_token, "/v1/customer")).status).toBe(401);
    expect((await refreshWith(third.refresh_token)).status).toBe(200);
    expect((await h.fetch("/auth/revoke", { method: "POST", key: h.ids.iosKey, json: { token: "rdrf_unknown" } })).status).toBe(200);
    // Expired access tokens answer 7224 too.
    const fourth = (await login({ method: "firebase", id_token: await firebaseToken() })).body;
    h.setNow(new Date(h.now().getTime() + 3601_000));
    expect(await (await getAs(fourth.access_token, "/v1/customer")).json()).toMatchObject({ code: 7224 });
  });

  it("stops refreshing once Auth, the provider or anonymous sign-in is turned off", async () => {
    const prov = await enableFirebase();
    await v2("POST", `${P()}/auth/settings`, { allow_anonymous: true });
    const refreshWith = (rt: string) => h.fetch("/auth/token", { method: "POST", key: h.ids.iosKey, json: { grant_type: "refresh_token", refresh_token: rt } });
    const fb = (await login({ method: "firebase", id_token: await firebaseToken() })).body;
    const anon = (await login({ method: "anonymous" })).body;
    await v2("POST", `${P()}/auth/providers/${prov.id}`, { enabled: false });
    const off = await refreshWith(fb.refresh_token);
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ code: 7224, message: expect.stringMatching(/provider/) });
    await v2("POST", `${P()}/auth/providers/${prov.id}`, { enabled: true });
    const back = await refreshWith(fb.refresh_token);
    expect(back.status).toBe(200);
    const fb2 = await back.json() as any;
    await v2("POST", `${P()}/auth/settings`, { allow_anonymous: false });
    expect((await refreshWith(anon.refresh_token)).status).toBe(403);
    await v2("POST", `${P()}/auth/settings`, { enabled: false });
    expect((await refreshWith(fb2.refresh_token)).status).toBe(403);
  });

  it("refuses a mapping that would make a signed-in user look anonymous", async () => {
    await v2("POST", `${P()}/auth/settings`, { enabled: true });
    await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: OIDC_ISS, audiences: ["client-123"], app_user_id_claim: "nickname" });
    const r = await login({ method: "oidc", id_token: await oidcToken({ nickname: "$RCAnonymousID:0123456789abcdef0123456789abcdef" }) });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: 7224, message: expect.stringMatching(/must not start with/) });
  });

  it("reads at most 256 KB of a key or discovery answer, and asks a provider that is down at most once a minute", async () => {
    await v2("POST", `${P()}/auth/settings`, { enabled: true });
    const big = "https://big.example.com";
    const prov = (await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: big, audiences: ["c"], jwks_url: `${big}/jwks` })).body;
    let pulled = 0;
    // A streamed answer with no content-length: reading stops after 256 KB.
    override = (url) => url === `${big}/jwks`
      ? new Response(new ReadableStream({ pull(ctl) { pulled += 1; if (pulled > 1000) ctl.close(); else ctl.enqueue(new Uint8Array(64 * 1024)); } }), { headers: { "content-type": "application/json" } })
      : null;
    const tok = await jwt({ alg: "ES256", kid: "ec1" }, { iss: big, aud: "c", sub: "s", exp: now() + 60 }, keys.ec.privateKey);
    const r = await login({ method: "oidc", id_token: tok });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/larger than 256 KB/);
    expect(pulled).toBeLessThan(10);
    // A declared size over the limit is not read at all.
    override = (url) => url === `${big}/jwks` ? new Response("{}", { headers: { "content-length": "999999999" } }) : null;
    clearIdentityCaches();
    expect((await login({ method: "oidc", id_token: tok })).body.message).toMatch(/larger than 256 KB/);
    override = null;
    // Discovery that fails is not asked again within a minute.
    await v2("DELETE", `${P()}/auth/providers/${prov.id}`);
    await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: OIDC_ISS, audiences: ["client-123"] });
    failing = true;
    expect((await login({ method: "oidc", id_token: await oidcToken() })).status).toBe(503);
    expect((await login({ method: "oidc", id_token: await oidcToken() })).status).toBe(503);
    expect(fetched[`${OIDC_ISS}/.well-known/openid-configuration`]).toBe(1);
    failing = false;
    h.setNow(new Date(h.now().getTime() + 61_000));
    expect((await login({ method: "oidc", id_token: await oidcToken() })).status).toBe(200);
  });

  it("signs in anonymously only when allowed", async () => {
    await enableFirebase();
    expect((await login({ method: "anonymous" })).status).toBe(403);
    await v2("POST", `${P()}/auth/settings`, { allow_anonymous: true });
    const r = await login({ method: "anonymous" });
    expect(r.status).toBe(200);
    expect(decodeJwt(r.body.access_token).payload["rc.app_user_id"]).toMatch(/^\$RCAnonymousID:[0-9a-f]{32}$/);
    expect(decodeJwt(r.body.id_token).payload.amr).toEqual(["anonymous"]);
    expect((await login({ method: "facebook-ish" })).status).toBe(403);
  });
});

describe("what a signed-in app reads, and what a backend reads by identity", () => {
  it("reads attributes and currency balances with the access token; a backend reads balances by provider and subject", async () => {
    const prov = await enableFirebase();
    const r = (await login({ method: "firebase", id_token: await firebaseToken() })).body;
    const set = await h.fetch("/v1/customer/attributes", { method: "POST", key: r.access_token, json: { attributes: { $displayName: { value: "Alice", updated_at_ms: h.now().getTime() }, plan_goal: { value: "sleep", updated_at_ms: h.now().getTime() } } } });
    expect(set.status).toBe(200);
    const attrs = await (await getAs(r.access_token, "/v1/customer/attributes")).json() as any;
    expect(attrs.subscriber_attributes).toMatchObject({ $displayName: { value: "Alice" }, plan_goal: { value: "sleep" } });
    // An app key alone cannot read attributes (they can hold contact details).
    expect((await h.fetch("/v1/subscribers/uid_alice/attributes", { key: h.ids.iosKey })).status).toBe(401);
    expect((await h.fetch("/v1/subscribers/uid_alice/attributes", { key: h.ids.secretKey })).status).toBe(200);

    expect((await v2("POST", `${P()}/virtual_currencies`, { code: "GEMS", name: "Gems" })).status).toBe(201);
    expect((await v2("POST", `${P()}/customers/uid_alice/virtual_currencies/transactions`, { adjustments: { GEMS: 40 } })).status).toBeLessThan(300);
    const bal = await (await getAs(r.access_token, "/v1/customer/virtual_currencies")).json() as any;
    expect(bal.virtual_currencies.GEMS.balance).toBe(40);

    const id = await v2("GET", `${P()}/auth/identities/${prov.id}/uid_alice`);
    expect(id.status).toBe(200);
    expect(id.body).toMatchObject({ object: "auth_identity", app_user_id: "uid_alice", customer_id: "uid_alice", virtual_currencies: { GEMS: { balance: 40 } }, active_entitlements: [] });
    const list = await v2("GET", `${P()}/auth/identities?app_user_id=uid_alice`);
    expect(list.body.items).toHaveLength(1);
    // Unlinking ends the identity's sessions.
    expect((await v2("DELETE", `${P()}/auth/identities/${prov.id}/uid_alice`)).status).toBe(200);
    expect((await getAs(r.access_token, "/v1/customer")).status).toBe(401);
    expect((await v2("GET", `${P()}/auth/identities/${prov.id}/uid_alice`)).status).toBe(404);
    // The audit log names the writes.
    const logs = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, h.ids.project));
    expect(logs.map((l) => l.actionType)).toEqual(expect.arrayContaining(["auth_settings_updated", "auth_provider_created", "auth_identity_deleted"]));
  });

  it("keeps providers and identities to their project", async () => {
    const prov = await enableFirebase();
    await h.db.insert(schema.projects).values({ id: "projB", name: "Other", authSettings: { enabled: true } });
    await h.db.insert(schema.apps).values({ id: "appB", projectId: "projB", name: "Other", type: "app_store", publicKey: "appl_other" });
    const r = await login({ method: "firebase", id_token: await firebaseToken() }, "appl_other");
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/No enabled Firebase provider/);
    const { createSecretKey } = await import("../src/services/auth.js");
    const keyB = (await createSecretKey(h.db, "projB", "b")).key;
    expect((await v2("GET", `/v2/projects/projB/auth/providers/${prov.id}`, undefined, keyB)).status).toBe(404);
  });

  it("validates provider settings, refusing private key URLs on Cloud", async () => {
    expect((await v2("POST", `${P()}/auth/providers`, { kind: "firebase" })).body).toMatchObject({ param: "firebase_project_id" });
    expect((await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: OIDC_ISS })).body).toMatchObject({ param: "audiences" });
    expect((await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: "https://idp.example.com", audiences: ["a"], jwks_url: "http://169.254.169.254/keys" })).body).toMatchObject({ param: "jwks_url" });
    await h.close();
    h = await harness({ fetch: fakeFetch, edition: "cloud" });
    expect((await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: "http://localhost:8080", audiences: ["a"] })).body).toMatchObject({ param: "issuer" });
    expect((await v2("POST", `${P()}/auth/providers`, { kind: "oidc", issuer: OIDC_ISS, audiences: ["a"], jwks_url: "https://10.0.0.5/jwks" })).body).toMatchObject({ param: "jwks_url" });
    // Without a signing or encryption key there is nothing to sign tokens with: 503 that names the setting.
    await v2("POST", `${P()}/auth/settings`, { enabled: true });
    await v2("POST", `${P()}/auth/providers`, { kind: "firebase", firebase_project_id: FB_PROJECT });
    const env = (globalThis as any).process.env;
    const saved = [env.REVENUEDOT_SIGNING_KEY, env.REVENUEDOT_ENCRYPTION_KEY];
    delete env.REVENUEDOT_SIGNING_KEY; delete env.REVENUEDOT_ENCRYPTION_KEY;
    try {
      const r = await login({ method: "firebase", id_token: await firebaseToken() });
      expect(r.status).toBe(503);
      expect(r.body.message).toMatch(/REVENUEDOT_SIGNING_KEY/);
    } finally { if (saved[0]) env.REVENUEDOT_SIGNING_KEY = saved[0]; if (saved[1]) env.REVENUEDOT_ENCRYPTION_KEY = saved[1]; }
  });
});
