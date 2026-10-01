import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb, schema, type DB } from "@revenuedot/db";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { OAUTH_SCOPES, clientDocUrlOk } from "../src/routes/oauth.js";

/** OAuth 2.1 for MCP clients: metadata, dynamic client registration, consent with the dashboard session, PKCE code exchange. */

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const REDIRECT = "http://localhost:33418/callback";
const b64url = (u: Uint8Array) => Buffer.from(u).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function setup(fetchImpl?: typeof fetch) {
  const opened = await openDb("pglite://memory");
  close = opened.close;
  const db: DB = opened.db;
  let clock = new Date("2026-09-30T12:00:00Z");
  const app = createApp({ db, now: () => clock, stores: defaultStores(), signingKey: "", fetch: fetchImpl });
  const call = async (method: string, path: string, init: { json?: unknown; form?: Record<string, string>; cookie?: string; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    let body: string | undefined;
    if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
    if (init.form) { headers.set("content-type", "application/x-www-form-urlencoded"); body = new URLSearchParams(init.form).toString(); }
    if (init.cookie) headers.set("cookie", init.cookie);
    return app.fetch(new Request(`http://localhost${path}`, { method, headers, body, redirect: "manual" }));
  };
  const signup = async (email: string, projectName = "Scanner") => {
    const res = await call("POST", "/auth/signup", { json: { email, password: "correct horse battery", project_name: projectName } });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const me = await (await call("GET", "/auth/me", { cookie })).json() as { projects: { id: string }[] };
    return { cookie, projectId: me.projects[0]!.id };
  };
  const register = async (meta: Record<string, unknown> = { client_name: "Claude", redirect_uris: [REDIRECT] }) => call("POST", "/oauth/register", { json: meta });
  return { db, call, signup, register, setNow: (d: Date) => { clock = d; } };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** Runs the consent screen as the browser would: GET the page, read the hidden fields, POST the decision. */
async function consent(env: Env, cookie: string, query: Record<string, string>, choice: { project_id?: string; access?: string; decision?: string } = {}) {
  const page = await env.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`, { cookie });
  expect(page.status).toBe(200);
  const html = await page.text();
  const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"')]));
  const project = choice.project_id ?? /<option value="([^"]+)"/.exec(html)![1]!;
  return env.call("POST", "/oauth/authorize", { cookie, form: { ...fields, project_id: project, access: choice.access ?? "project:write", decision: choice.decision ?? "allow" } });
}

describe("OAuth for MCP clients", () => {
  it("publishes authorization server metadata with PKCE S256, registration and the public origin behind a proxy", async () => {
    const env = await setup();
    const res = await env.call("GET", "/.well-known/oauth-authorization-server", { headers: { "x-forwarded-host": "api.example.com", "x-forwarded-proto": "https" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({
      issuer: "https://api.example.com", authorization_endpoint: "https://api.example.com/oauth/authorize", token_endpoint: "https://api.example.com/oauth/token",
      registration_endpoint: "https://api.example.com/oauth/register", code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["project:read", "project:write", "project:support"],
      client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    });
  });

  it("registers public clients and rejects unsafe redirect URIs", async () => {
    const env = await setup();
    const ok = await env.register({ client_name: "Cursor", redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback", "https://claude.ai/api/mcp/auth_callback", REDIRECT], token_endpoint_auth_method: "client_secret_post" });
    expect(ok.status).toBe(201);
    const body = await ok.json() as Record<string, unknown>;
    expect(body).toMatchObject({ client_name: "Cursor", token_endpoint_auth_method: "none", grant_types: ["authorization_code"] });
    expect(String(body.client_id)).toMatch(/^oac_/);
    for (const bad of [["javascript:alert(1)"], ["http://evil.example.com/cb"], ["https://x.example.com/cb#frag"], []]) {
      const r = await env.register({ redirect_uris: bad });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe("invalid_redirect_uri");
    }
    expect((await env.call("POST", "/oauth/register", { json: "nope" })).status).toBe(400);
  });

  it("runs the whole flow: sign-in page, consent, code, PKCE exchange; the token is a project-scoped key that works on API v2", async () => {
    const env = await setup();
    const { client_id } = await (await env.register()).json() as { client_id: string };
    const { verifier, challenge } = await pkce();
    const query = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: "https://mcp.example.com/mcp" };

    // Without a session the page asks the user to sign in with their dashboard account.
    const anon = await env.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`);
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain("Sign in to connect Claude");
    // A signed-out person can also create an account on the same page; both reload this URL, which then shows the consent screen.
    expect(anonHtml).toContain('id="signup"');
    expect(anonHtml).toContain('"/auth/signup"');
    expect(anonHtml).toContain("location.reload()");
    expect(anonHtml).toContain("/legal/terms");
    expect(anonHtml).toContain('aria-selected="true"');
    expect(anonHtml).toContain("/forgot-password");
    expect(anonHtml).toContain('aria-label="RevenueDot"');

    const alice = await env.signup("alice@example.com");
    const other = await env.signup("bob@example.com", "Bob's app");
    const page = await (await env.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`, { cookie: alice.cookie })).text();
    expect(page).toContain("Connect Claude to RevenueDot");
    expect(page).toContain(`value="${alice.projectId}"`);
    expect(page).not.toContain(other.projectId);

    const res = await consent(env, alice.cookie, query);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("xyz");
    expect(loc.searchParams.get("iss")).toBe("http://localhost");
    const code = loc.searchParams.get("code")!;

    // A wrong verifier burns the code.
    const wrong = await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: (await pkce()).verifier, client_id, redirect_uri: REDIRECT } });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    const again = await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT } });
    expect(again.status).toBe(400);

    // A fresh code with the right verifier gives a key.
    const code2 = new URL((await consent(env, alice.cookie, query)).headers.get("location")!).searchParams.get("code")!;
    const tok = await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code: code2, code_verifier: verifier, client_id, redirect_uri: REDIRECT } });
    expect(tok.status).toBe(200);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    const t = await tok.json() as { access_token: string; token_type: string; scope: string; project_id: string };
    expect(t).toMatchObject({ token_type: "Bearer", scope: "project:write", project_id: alice.projectId });
    expect(t.access_token).toMatch(/^sk_/);

    const auth = { authorization: `Bearer ${t.access_token}` };
    const projects = await (await env.call("GET", "/v2/projects", { headers: auth })).json() as { items: { id: string }[] };
    expect(projects.items.map((p) => p.id)).toEqual([alice.projectId]);
    expect((await env.call("POST", `/v2/projects/${alice.projectId}/entitlements`, { headers: auth, json: { lookup_key: "pro", display_name: "Pro" } })).status).toBe(201);
    expect((await env.call("GET", `/v2/projects/${other.projectId}/entitlements`, { headers: auth })).status).toBe(404);
    // The token cannot mint more keys, and it shows up in the project's key list where it can be revoked.
    expect((await env.call("GET", `/v2/projects/${alice.projectId}/api_keys`, { headers: auth })).status).toBe(403);
    const keys = await (await env.call("GET", `/v2/projects/${alice.projectId}/api_keys`, { cookie: alice.cookie })).json() as { items: { id: string; name: string; permissions: string[] }[] };
    const k = keys.items.find((x) => x.name === "OAuth: Claude")!;
    expect(k.permissions).toEqual(OAUTH_SCOPES["project:write"]);
    expect((await env.call("DELETE", `/v2/projects/${alice.projectId}/api_keys/${k.id}`, { cookie: alice.cookie })).status).toBe(200);
    expect((await env.call("GET", "/v2/projects", { headers: auth })).status).toBe(401);
  });

  it("sign-up from the consent page leads straight back to the consent screen with the same request", async () => {
    const env = await setup();
    const { client_id } = await (await env.register()).json() as { client_id: string };
    const { challenge } = await pkce();
    const query = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "keep-me" };
    const url = `/oauth/authorize?${new URLSearchParams(query)}`;
    expect(await (await env.call("GET", url)).text()).toContain('id="signup"');
    // What the page's script does: POST /auth/signup with the form values, then reload the same URL with the new session.
    const created = await env.call("POST", "/auth/signup", { json: { email: "newperson@example.com", password: "a long enough password", project_name: "My project" } });
    expect(created.status).toBe(201);
    const cookie = created.headers.get("set-cookie")!.split(";")[0]!;
    const page = await env.call("GET", url, { cookie });
    const html = await page.text();
    expect(html).toContain("Connect Claude to RevenueDot");
    expect(html).toContain('value="keep-me"');
    expect(html).toContain("newperson@example.com");
    // And a wrong password on sign-in answers a message the page shows.
    const bad = await env.call("POST", "/auth/login", { json: { email: "newperson@example.com", password: "wrong password" } });
    expect(bad.status).toBe(401);
  });

  it("read-only consent gives a key that cannot write; deny redirects with access_denied", async () => {
    const env = await setup();
    const { client_id } = await (await env.register()).json() as { client_id: string };
    const alice = await env.signup("alice@example.com");
    const { verifier, challenge } = await pkce();
    const query = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s1", scope: "project:read" };
    const html = await (await env.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`, { cookie: alice.cookie })).text();
    expect(html).toMatch(/value="project:read" checked/);
    // Money actions need read and change, so the box starts disabled when read only is asked for.
    expect(html).toMatch(/name="support" value="1" id="support" disabled/);

    const code = new URL((await consent(env, alice.cookie, query, { access: "project:read" })).headers.get("location")!).searchParams.get("code")!;
    const t = await (await env.call("POST", "/oauth/token", { json: { grant_type: "authorization_code", code, code_verifier: verifier } })).json() as { access_token: string; scope: string };
    expect(t.scope).toBe("project:read");
    const auth = { authorization: `Bearer ${t.access_token}` };
    expect((await env.call("GET", `/v2/projects/${alice.projectId}/entitlements`, { headers: auth })).status).toBe(200);
    const w = await env.call("POST", `/v2/projects/${alice.projectId}/entitlements`, { headers: auth, json: { lookup_key: "pro", display_name: "Pro" } });
    expect(w.status).toBe(403);
    expect(await w.json()).toMatchObject({ type: "authorization_error" });

    const denied = await consent(env, alice.cookie, query, { decision: "deny" });
    const loc = new URL(denied.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s1");
  });

  it("guards the consent step: unknown client, unregistered redirect, missing PKCE, forged form, other people's projects, expired codes", async () => {
    const env = await setup();
    const { client_id } = await (await env.register()).json() as { client_id: string };
    const alice = await env.signup("alice@example.com");
    const bob = await env.signup("bob@example.com", "Bob's app");
    const { verifier, challenge } = await pkce();
    const base = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" };

    expect((await env.call("GET", `/oauth/authorize?${new URLSearchParams({ ...base, client_id: "oac_nope" })}`, { cookie: alice.cookie })).status).toBe(400);
    const evil = await env.call("GET", `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "https://evil.example.com/cb" })}`, { cookie: alice.cookie });
    expect(evil.status).toBe(400);
    expect(evil.headers.get("location")).toBeNull();
    const noPkce = await env.call("GET", `/oauth/authorize?${new URLSearchParams({ ...base, code_challenge: "" })}`, { cookie: alice.cookie });
    expect(noPkce.status).toBe(302);
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const plain = await env.call("GET", `/oauth/authorize?${new URLSearchParams({ ...base, code_challenge_method: "plain" })}`, { cookie: alice.cookie });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    // A cross-site form post has no valid csrf value.
    const forged = await env.call("POST", "/oauth/authorize", { cookie: alice.cookie, form: { ...base, project_id: alice.projectId, access: "project:write", decision: "allow", csrf: "x" } });
    expect(forged.status).toBe(403);
    // Picking a project the user is not a member of.
    expect((await consent(env, alice.cookie, base, { project_id: bob.projectId })).status).toBe(403);
    // Signed out at decision time.
    expect((await env.call("POST", "/oauth/authorize", { form: { ...base, project_id: alice.projectId, decision: "allow", csrf: "x" } })).status).toBe(401);

    // Codes expire after ten minutes.
    const code = new URL((await consent(env, alice.cookie, base)).headers.get("location")!).searchParams.get("code")!;
    env.setNow(new Date("2026-09-30T12:11:00Z"));
    const late = await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier } });
    expect(await late.json()).toMatchObject({ error: "invalid_grant" });
    env.setNow(new Date("2026-09-30T12:00:00Z"));

    // Code issued to one client and redeemed by another, or with another redirect_uri.
    const other = await (await env.register({ client_name: "Other", redirect_uris: [REDIRECT] })).json() as { client_id: string };
    const c2 = new URL((await consent(env, alice.cookie, base)).headers.get("location")!).searchParams.get("code")!;
    expect(await (await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code: c2, code_verifier: verifier, client_id: other.client_id } })).json()).toMatchObject({ error: "invalid_grant" });
    const c3 = new URL((await consent(env, alice.cookie, base)).headers.get("location")!).searchParams.get("code")!;
    expect(await (await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code: c3, code_verifier: verifier, redirect_uri: "http://localhost:1/x" } })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await env.call("POST", "/oauth/token", { form: { grant_type: "client_credentials" } })).json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("a viewer can only grant read access, even when the form asks for write", async () => {
    const env = await setup();
    const { client_id } = await (await env.register()).json() as { client_id: string };
    const alice = await env.signup("alice@example.com");
    const viewer = await env.signup("vic@example.com", "Vic's own");
    const [vic] = await env.db.select().from(schema.users).where(eq(schema.users.email, "vic@example.com"));
    await env.db.insert(schema.memberships).values({ userId: vic!.id, projectId: alice.projectId, role: "viewer" });
    const { verifier, challenge } = await pkce();
    const base = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" };
    const res = await consent(env, viewer.cookie, base, { project_id: alice.projectId, access: "project:write" });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const t = await (await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier } })).json() as { scope: string; project_id: string };
    expect(t).toMatchObject({ scope: "project:read", project_id: alice.projectId });
  });

  it("grants the money-actions scope only when the user ticks it, never with read only, and shows it as its own key permission set", async () => {
    const env = await setup();
    const { client_id } = await (await env.register()).json() as { client_id: string };
    const alice = await env.signup("alice@example.com");
    const { verifier, challenge } = await pkce();
    const query = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "project:write project:support" };
    const html = await (await env.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`, { cookie: alice.cookie })).text();
    expect(html).toContain("Money actions");
    expect(html).toMatch(/name="support" value="1" id="support" checked/);
    const tokenFor = async (choice: Record<string, string>, form: Record<string, string> = {}) => {
      const page = await (await env.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`, { cookie: alice.cookie })).text();
      const fields = Object.fromEntries([...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1]!, m[2]!]));
      const res = await env.call("POST", "/oauth/authorize", { cookie: alice.cookie, form: { ...fields, project_id: alice.projectId, decision: "allow", ...choice, ...form } });
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      return (await (await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier } })).json()) as { access_token: string; scope: string };
    };
    const withSupport = await tokenFor({ access: "project:write", support: "1" });
    expect(withSupport.scope).toBe("project:write project:support");
    const without = await tokenFor({ access: "project:write" });
    expect(without.scope).toBe("project:write");
    const readOnly = await tokenFor({ access: "project:read", support: "1" });
    expect(readOnly.scope).toBe("project:read");
    const keys = await (await env.call("GET", `/v2/projects/${alice.projectId}/api_keys`, { cookie: alice.cookie })).json() as { items: { name: string; permissions: string[] }[] };
    const perms = keys.items.filter((k) => k.name === "OAuth: Claude").map((k) => k.permissions.length).sort((a, b) => a - b);
    expect(perms).toEqual([OAUTH_SCOPES["project:read"].length, OAUTH_SCOPES["project:write"].length, OAUTH_SCOPES["project:write"].length + OAUTH_SCOPES["project:support"].length]);
  });

  it("rejects a resource that is not an absolute URL without a fragment, and a token request for another resource", async () => {
    const env = await setup();
    const { client_id } = await (await env.register()).json() as { client_id: string };
    const alice = await env.signup("alice@example.com");
    const { verifier, challenge } = await pkce();
    const base = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    const bad = await env.call("GET", `/oauth/authorize?${new URLSearchParams({ ...base, resource: "mcp.example.com#x" })}`, { cookie: alice.cookie });
    expect(new URL(bad.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const code = new URL((await consent(env, alice.cookie, { ...base, resource: "https://mcp.example.com/mcp" })).headers.get("location")!).searchParams.get("code")!;
    const tok = await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier, resource: "https://other.example.com/mcp" } });
    expect(await tok.json()).toMatchObject({ error: "invalid_target" });
  });

  describe("client ID metadata documents", () => {
    const CLIENT = "https://chatgpt.example.com/oauth/client.json";
    const doc = (over: Record<string, unknown> = {}) => ({ client_id: CLIENT, client_name: "ChatGPT", redirect_uris: ["https://chatgpt.example.com/connector/oauth/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], ...over });
    const fetcher = (body: unknown, init: { status?: number; type?: string } = {}) => {
      const calls: string[] = [];
      const f = (async (url: string) => { calls.push(String(url)); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": init.type ?? "application/json" } }); }) as unknown as typeof fetch;
      return { f, calls };
    };
    const authorize = async (env: Env, cookie: string, redirect = "https://chatgpt.example.com/connector/oauth/cb") => {
      const { challenge } = await pkce();
      return env.call("GET", `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`, { cookie });
    };

    it("accepts a URL client_id, shows its host, runs the whole flow, and reads the document once an hour", async () => {
      const { f, calls } = fetcher(doc());
      const env = await setup(f);
      const alice = await env.signup("alice@example.com");
      const { verifier, challenge } = await pkce();
      const query = { response_type: "code", client_id: CLIENT, redirect_uri: "https://chatgpt.example.com/connector/oauth/cb", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
      const page = await (await env.call("GET", `/oauth/authorize?${new URLSearchParams(query)}`, { cookie: alice.cookie })).text();
      expect(page).toContain("Connect ChatGPT to RevenueDot");
      expect(page).toContain("chatgpt.example.com");
      const res = await consent(env, alice.cookie, query);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.origin + loc.pathname).toBe("https://chatgpt.example.com/connector/oauth/cb");
      const tok = await env.call("POST", "/oauth/token", { form: { grant_type: "authorization_code", code: loc.searchParams.get("code")!, code_verifier: verifier, client_id: CLIENT } });
      expect(tok.status).toBe(200);
      expect(calls).toHaveLength(1);
      env.setNow(new Date("2026-09-30T13:30:00Z"));
      await authorize(env, alice.cookie);
      expect(calls).toHaveLength(2);
    });

    it("accepts ChatGPT's real document: private_key_jwt preferred, none supported, refresh_token listed", async () => {
      const real = { client_id: CLIENT, client_uri: "https://chatgpt.example.com/", redirect_uris: ["https://chatgpt.example.com/connector/oauth/cb"], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_name: "ChatGPT", jwks_uri: "https://chatgpt.example.com/oauth/jwks.json" };
      const env = await setup(fetcher(real).f);
      const alice = await env.signup("alice@example.com");
      expect((await authorize(env, alice.cookie)).status).toBe(200);
    });

    it("keeps working from the saved copy when the document is unreachable later", async () => {
      let ok = true;
      const f = (async () => (ok ? new Response(JSON.stringify(doc()), { headers: { "content-type": "application/json" } }) : new Response("no", { status: 500 }))) as unknown as typeof fetch;
      const env = await setup(f);
      const alice = await env.signup("alice@example.com");
      expect((await authorize(env, alice.cookie)).status).toBe(200);
      ok = false;
      env.setNow(new Date("2026-09-30T14:00:00Z"));
      expect((await authorize(env, alice.cookie)).status).toBe(200);
    });

    it.each([
      ["a different client_id inside", doc({ client_id: "https://evil.example.com/c.json" }), {}],
      ["a redirect the document does not list", doc(), { redirect: "https://evil.example.com/cb" }],
      ["a plain http redirect", doc({ redirect_uris: ["http://chatgpt.example.com/cb"] }), {}],
      ["a client that wants a secret", doc({ token_endpoint_auth_method: "client_secret_basic" }), {}],
      ["a client that can only use a key", doc({ token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["private_key_jwt"] }), {}],
      ["a redirect", doc(), { status: 302 }],
      ["no redirect_uris", doc({ redirect_uris: [] }), {}],
      ["HTML instead of JSON", "<html></html>", { type: "text/html" }],
      ["a document over 10 KB", doc({ client_name: "x".repeat(11_000) }), {}],
      ["a 404", doc(), { status: 404 }],
    ])("refuses %s", async (_name, body, extra: { redirect?: string; type?: string; status?: number }) => {
      const { f } = fetcher(body, extra);
      const env = await setup(f);
      const alice = await env.signup("alice@example.com");
      const res = await authorize(env, alice.cookie, extra.redirect);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    });

    it("never fetches addresses that are not public https", async () => {
      for (const bad of ["http://chatgpt.example.com/c.json", "https://127.0.0.1/c.json", "https://localhost/c.json", "https://[::1]/c.json", "https://169.254.169.254/latest", "https://db.internal/c.json", "https://user:pw@chatgpt.example.com/c.json", "https://chatgpt.example.com/", "https://nodots/c.json"]) {
        expect(clientDocUrlOk(bad), bad).toBe(false);
      }
      expect(clientDocUrlOk(CLIENT)).toBe(true);
      let called = 0;
      const env = await setup((async () => { called++; return new Response("{}"); }) as unknown as typeof fetch);
      const alice = await env.signup("alice@example.com");
      const res = await env.call("GET", `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "https://169.254.169.254/latest/meta", redirect_uri: "https://x.example.com/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`, { cookie: alice.cookie });
      expect(res.status).toBe(400);
      expect(called).toBe(0);
    });
  });
});
