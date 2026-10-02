// RevenueDot Enterprise (ee/LICENSE). OpenID Connect single sign-on against a fake identity provider (discovery, JWKS and
// token endpoint injected through deps.fetch; id_tokens signed with a jose key). Spec: prd/enterprise/PRD.md §5.
import { afterEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload, type KeyLike } from "jose";
import { eeServer, type Browser, type EeServer } from "./helpers.js";
import { addVerifiedDomain, dnsFetch, type FakeDns } from "./saml-idp.js";
import { eeOrgAuditLogs, eeSsoConnections } from "../server/schema.js";

const ISSUER = "https://login.idp.example.test";
const CLIENT_ID = "rd-client";
const CLIENT_SECRET = "s3cr3t value/with:chars";

let s: EeServer | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const sha256b64url = async (v: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))).toString("base64url");

/** A fake identity provider. `nextToken` changes what the token endpoint signs for the next exchange. */
async function fakeIdp() {
  const good = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const authorizations = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
  const tokenCalls: { auth: string | null; body: URLSearchParams }[] = [];
  const idp = {
    nextToken: { claims: {} as JWTPayload, key: null as KeyLike | null },
    tokenCalls,
    /** The IdP's side of the authorization request: remembers nonce and PKCE challenge, returns a code. */
    authorize(location: string, email: string) {
      const u = new URL(location);
      const code = `code_${Math.random().toString(36).slice(2)}`;
      authorizations.set(code, { nonce: u.searchParams.get("nonce")!, challenge: u.searchParams.get("code_challenge")!, redirectUri: u.searchParams.get("redirect_uri")! });
      idp.email = email;
      return { code, state: u.searchParams.get("state")!, params: u.searchParams, redirectUri: u.searchParams.get("redirect_uri")! };
    },
    email: "",
    async handle(url: string, init?: RequestInit): Promise<Response> {
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] });
      }
      if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
      if (url === `${ISSUER}/token` && init?.method === "POST") {
        const body = new URLSearchParams(String(init.body));
        const headers = new Headers(init.headers);
        tokenCalls.push({ auth: headers.get("authorization"), body });
        const a = authorizations.get(body.get("code") ?? "");
        if (!a) return Response.json({ error: "invalid_grant" }, { status: 400 });
        authorizations.delete(body.get("code")!);
        if (await sha256b64url(body.get("code_verifier") ?? "") !== a.challenge) return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 });
        if (body.get("redirect_uri") !== a.redirectUri) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        const claims: JWTPayload = { iss: ISSUER, aud: CLIENT_ID, sub: "user-1", iat: now, exp: now + 300, nonce: a.nonce, email: idp.email, email_verified: true, name: "Olivia Idp", groups: ["Engineering"], ...idp.nextToken.claims };
        const jwt = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(idp.nextToken.key ?? good.privateKey);
        idp.nextToken = { claims: {}, key: null };
        return Response.json({ access_token: "at", token_type: "Bearer", id_token: jwt });
      }
      throw new Error(`unexpected request to the fake IdP: ${url}`);
    },
    otherKey: other.privateKey,
  };
  return idp;
}

interface Setup { owner: Browser; orgId: string; projectId: string; connId: string; idp: Awaited<ReturnType<typeof fakeIdp>>; dns: FakeDns }

async function setup(oidc: Record<string, unknown> = {}): Promise<Setup> {
  const dns: FakeDns = new Map();
  const idp = await fakeIdp();
  s = await eeServer({ fetch: dnsFetch(dns, (u, i) => idp.handle(u, i)) });
  const owner = await s.signup("owner@acme.test");
  const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
  const conn = await owner.browser.call("POST", `/v2/organizations/${orgId}/sso/connections`, {
    kind: "oidc", name: "Acme IdP", enabled: true, oidc: { issuer: ISSUER, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, groups_claim: "groups", ...oidc },
  });
  expect(conn.status).toBe(201);
  await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
  return { owner: owner.browser, orgId, projectId: owner.projectId, connId: conn.body.id, idp, dns };
}

/** Runs the browser through start → IdP → callback and returns the callback response. */
async function signIn(x: Setup, b: Browser, email: string, next = "/") {
  const start = await b.call("GET", `/sso/start?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
  expect(start.status).toBe(303);
  const loc = start.headers.get("location")!;
  expect(loc.startsWith(`${ISSUER}/authorize?`)).toBe(true);
  const a = x.idp.authorize(loc, email);
  const cb = new URL(a.redirectUri);
  return { res: await b.call("GET", `${cb.pathname}?code=${a.code}&state=${a.state}`), auth: a };
}

async function lastFailure(orgId: string): Promise<string> {
  const [row] = await s!.db.select().from(eeOrgAuditLogs).where(and(eq(eeOrgAuditLogs.orgId, orgId), eq(eeOrgAuditLogs.action, "sso_sign_in_failed"))).orderBy(desc(eeOrgAuditLogs.occurredAt)).limit(1);
  return String(row?.data.reason ?? "");
}

function expectRefused(r: { status: number; headers: Headers; cookie: string | null }) {
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toMatch(/^\/login\?sso_error=/);
  expect(r.cookie ?? "").not.toMatch(/rd_session=[^;]/);
}

describe("OpenID Connect sign-in", () => {
  it("signs in with code + PKCE + nonce, client_secret_basic, and stores the groups", async () => {
    const x = await setup();
    const b = s!.browser();
    const { res, auth } = await signIn(x, b, "olivia@acme.test", "/projects");
    expect(auth.params.get("code_challenge_method")).toBe("S256");
    expect(auth.params.get("response_type")).toBe("code");
    expect(auth.params.get("scope")).toBe("openid email profile");
    expect(auth.params.get("login_hint")).toBe("olivia@acme.test");
    expect(auth.redirectUri).toBe(`https://dash.example.com/sso/oidc/${x.connId}/callback`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/projects");
    expect(res.cookie).toMatch(/rd_session=[^;]+/);
    const me = await b.call("GET", "/auth/me");
    expect(me.body.user).toMatchObject({ email: "olivia@acme.test", name: "Olivia Idp", email_verified: true });
    const call = x.idp.tokenCalls.at(-1)!;
    expect(call.auth).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${encodeURIComponent(CLIENT_SECRET).replace(/%20/g, "+")}`).toString("base64")}`);
    expect(call.body.get("client_secret")).toBeNull();
    const members = await x.owner.call("GET", `/v2/organizations/${x.orgId}/members`);
    expect(JSON.stringify(members.body)).toContain("Engineering");
  });

  it("never returns the client secret, and stores it sealed", async () => {
    const x = await setup();
    const r = await x.owner.call("GET", `/v2/organizations/${x.orgId}/sso/connections/${x.connId}`);
    expect(r.status).toBe(200);
    expect(r.body.oidc).toMatchObject({ issuer: ISSUER, client_id: CLIENT_ID, has_client_secret: true });
    expect(r.text).not.toContain(CLIENT_SECRET);
    const [row] = await s!.db.select().from(eeSsoConnections).where(eq(eeSsoConnections.id, x.connId));
    expect(row!.secret).toMatch(/^v1:/);
    expect(row!.secret).not.toContain(CLIENT_SECRET);
  });

  it("refuses a wrong nonce", async () => {
    const x = await setup();
    x.idp.nextToken.claims = { nonce: "not-the-nonce" };
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toContain("nonce");
  });

  it("refuses a wrong audience", async () => {
    const x = await setup();
    x.idp.nextToken.claims = { aud: "someone-else" };
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toMatch(/aud/);
  });

  it("refuses several audiences without azp for this client", async () => {
    const x = await setup();
    x.idp.nextToken.claims = { aud: [CLIENT_ID, "other"], azp: "other" };
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toContain("azp");
  });

  it("refuses a wrong issuer", async () => {
    const x = await setup();
    x.idp.nextToken.claims = { iss: "https://evil.example" };
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toMatch(/iss/);
  });

  it("refuses an expired id_token", async () => {
    const x = await setup();
    const now = Math.floor(Date.now() / 1000);
    x.idp.nextToken.claims = { iat: now - 3600, exp: now - 600 };
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toMatch(/exp/);
  });

  it("refuses an id_token signed with another key", async () => {
    const x = await setup();
    x.idp.nextToken.key = x.idp.otherKey;
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toMatch(/signature/i);
  });

  it("refuses email_verified false", async () => {
    const x = await setup();
    x.idp.nextToken.claims = { email_verified: false };
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toContain("not verified");
  });

  it("refuses an email on a domain the organization did not verify", async () => {
    const x = await setup();
    x.idp.nextToken.claims = { email: "olivia@elsewhere.test" };
    expectRefused((await signIn(x, s!.browser(), "olivia@acme.test")).res);
    expect(await lastFailure(x.orgId)).toContain("not verified by this organization");
  });

  it("refuses a state used twice", async () => {
    const x = await setup();
    const b = s!.browser();
    const { res, auth } = await signIn(x, b, "olivia@acme.test");
    expect(res.headers.get("location")).toBe("/");
    // The same state again (with a fresh code the IdP would accept) is refused.
    const again = x.idp.authorize(`${ISSUER}/authorize?state=${auth.state}&nonce=${auth.params.get("nonce")}&code_challenge=${auth.params.get("code_challenge")}&redirect_uri=${encodeURIComponent(auth.redirectUri)}`, "olivia@acme.test");
    expectRefused(await b.call("GET", `/sso/oidc/${x.connId}/callback?code=${again.code}&state=${auth.state}`));
    expect(await lastFailure(x.orgId)).toContain("state");
  });

  it("refuses a callback in a browser that did not start the sign-in (login CSRF)", async () => {
    const x = await setup();
    const attacker = s!.browser();
    const start = await attacker.call("GET", "/sso/start?email=olivia%40acme.test");
    const auth = new URL(start.headers.get("location")!);
    const code = x.idp.authorize(auth.toString(), "olivia@acme.test").code;
    const victim = s!.browser();
    expectRefused(await victim.call("GET", `/sso/oidc/${x.connId}/callback?code=${code}&state=${auth.searchParams.get("state")}`));
    expect(await lastFailure(x.orgId)).toContain("another browser");
  });

  it("uses client_secret_post when the provider does not list client_secret_basic", async () => {
    const x = await setup();
    const orig = x.idp.handle.bind(x.idp);
    x.idp.handle = async (url, init) => {
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, token_endpoint_auth_methods_supported: ["client_secret_post"] });
      }
      return orig(url, init);
    };
    // A new server, so the discovery cache (per fetch function) starts empty.
    await s!.close();
    const dns: FakeDns = new Map();
    s = await eeServer({ fetch: dnsFetch(dns, (u, i) => x.idp.handle(u, i)) });
    const owner = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    const conn = await owner.browser.call("POST", `/v2/organizations/${orgId}/sso/connections`, { kind: "oidc", name: "IdP", enabled: true, oidc: { issuer: ISSUER, client_id: CLIENT_ID, client_secret: CLIENT_SECRET } });
    await addVerifiedDomain(owner.browser, orgId, "acme.test", dns);
    const y = { ...x, owner: owner.browser, orgId, connId: conn.body.id };
    const { res } = await signIn(y, s.browser(), "olivia@acme.test");
    expect(res.headers.get("location")).toBe("/");
    const call = x.idp.tokenCalls.at(-1)!;
    expect(call.auth).toBeNull();
    expect(call.body.get("client_id")).toBe(CLIENT_ID);
    expect(call.body.get("client_secret")).toBe(CLIENT_SECRET);
  });

  it("refuses an issuer the outbound guard flags on Cloud", async () => {
    const dns: FakeDns = new Map();
    s = await eeServer({ fetch: dnsFetch(dns), deps: { edition: "cloud" } });
    const owner = await s.signup("owner@acme.test");
    const orgId = await s.createOrg(owner.browser, "Acme", [owner.projectId]);
    for (const issuer of ["http://login.example.com", "https://10.0.0.5", "https://169.254.169.254/latest"]) {
      const r = await owner.browser.call("POST", `/v2/organizations/${orgId}/sso/connections`, { kind: "oidc", name: "IdP", oidc: { issuer, client_id: "c" } });
      expect(r.status, issuer).toBe(400);
      expect(r.body.param).toBe("oidc.issuer");
    }
  });
});
