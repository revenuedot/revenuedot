import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { and, eq, gt } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { createSecretKey, sha256Hex } from "../services/auth.js";
import { SESSION_COOKIE, projectsForUser, sessionUser } from "../services/sessions.js";
import { requestOrigin } from "../services/account-email.js";

/**
 * OAuth 2.1 authorization server for MCP clients (MCP authorization spec, 2025-06-18):
 *
 *   GET  /.well-known/oauth-authorization-server   metadata (RFC 8414)
 *   POST /oauth/register                           dynamic client registration (RFC 7591), public clients only
 *   GET  /oauth/authorize                          consent screen; reuses the dashboard session cookie
 *   POST /oauth/authorize                          the user's decision; redirects back with a one-time code
 *   POST /oauth/token                              authorization_code grant with PKCE (S256)
 *
 * Clients identify themselves with a registered client_id or, preferably, an https URL that serves their metadata (a client
 * ID metadata document, MCP spec 2025-11-25); ChatGPT and Claude both use the URL form.
 *
 * The access token is a secret API key (sk_...) bound to the one project the user picked, with only the scopes the
 * user approved. It never expires and shows in the project's API keys, where it is revoked like any other key.
 */

/** OAuth scopes and the API v2 permissions each one becomes. `write` includes `read`. */
export const OAUTH_SCOPES = {
  "project:read": [
    "project_configuration:projects:read", "project_configuration:apps:read", "project_configuration:products:read",
    "project_configuration:entitlements:read", "project_configuration:offerings:read", "project_configuration:packages:read",
    "project_configuration:integrations:read", "customer_information:customers:read", "customer_information:subscriptions:read",
    "customer_information:purchases:read", "charts_metrics:overview:read",
  ],
  "project:write": [
    "project_configuration:projects:read", "project_configuration:apps:read_write", "project_configuration:products:read_write",
    "project_configuration:entitlements:read_write", "project_configuration:offerings:read_write", "project_configuration:packages:read_write",
    "project_configuration:integrations:read_write", "customer_information:customers:read_write", "customer_information:subscriptions:read",
    "customer_information:purchases:read", "charts_metrics:overview:read",
  ],
  /** Extra consent for subscription and purchase actions (cancel, refund, extend, test purchases). Never granted with read only. */
  "project:support": ["customer_information:subscriptions:read_write", "customer_information:purchases:read_write"],
} as const;
type Level = "project:read" | "project:write";
const SUPPORT = "project:support";
const permissionsFor = (level: Level, support: boolean) => [...OAUTH_SCOPES[level], ...(support ? OAUTH_SCOPES[SUPPORT] : [])];
const scopeString = (level: Level, support: boolean) => (support ? `${level} ${SUPPORT}` : level);
const CODE_TTL_MS = 10 * 60_000;

const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
async function s256(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The public origin, honouring a reverse proxy's X-Forwarded-Host / -Proto (as setup_health does). */
export function publicOrigin(c: Context) {
  return requestOrigin(c.req.url, (n) => c.req.header(n));
}

/** Redirect URIs: https, http on a loopback host (desktop clients), or a custom app scheme such as cursor://. */
function redirectUriOk(u: string) {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.hash) return false;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === "https") return true;
  if (scheme === "http") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return !["javascript", "data", "file", "vbscript", "blob", "about", "ftp", "ws", "wss"].includes(scheme);
}

/** RFC 8707: an absolute URI without a fragment. */
function resourceOk(r: string) {
  try { const u = new URL(r); return !u.hash && (u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1"); } catch { return false; }
}

/** Requested scopes, narrowed to the ones we know. No scope means read and write (the user can still pick read only). */
function parseScope(raw: string | undefined): { level: Level; support: boolean } {
  const want = (raw ?? "").split(/\s+/).filter(Boolean);
  const level: Level = want.length && !want.includes("project:write") && want.includes("project:read") ? "project:read" : "project:write";
  return { level, support: level === "project:write" && want.includes(SUPPORT) };
}

const CLIENT_DOC_MAX_BYTES = 10_240;
const CLIENT_DOC_TTL_MS = 60 * 60_000;

/** A client ID metadata document URL must be public https: no credentials, no IP literal, no local or internal names. */
export function clientDocUrlOk(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || !u.pathname || u.pathname === "/") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.startsWith("[") || h === "localhost" || /\.(local|localhost|internal|lan|home|test|invalid)$/.test(h)) return false;
  return true;
}

async function readCapped(res: Response, max: number) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new Error("too large"); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) { all.set(ch, at); at += ch.byteLength; }
  return new TextDecoder().decode(all);
}

/** Fetches and checks a client ID metadata document. Returns the client's name and redirect URIs, or why it was refused. */
export async function fetchClientDoc(url: string, doFetch: typeof fetch): Promise<{ name: string; redirectUris: string[] } | { error: string }> {
  if (!clientDocUrlOk(url)) return { error: "The client_id URL is not a public https address." };
  let doc: unknown;
  try {
    // "manual" rather than "error": Workers do not accept redirect: "error". A redirect is refused below.
    const res = await doFetch(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (res.status >= 300 && res.status < 400) return { error: "The client metadata document redirected; it must be served at its own URL." };
    if (!res.ok) return { error: `The client metadata document answered ${res.status}.` };
    if (!(res.headers.get("content-type") ?? "").includes("json")) return { error: "The client metadata document is not JSON." };
    doc = JSON.parse(await readCapped(res, CLIENT_DOC_MAX_BYTES));
  } catch (e) {
    return { error: e instanceof Error && e.message === "too large" ? "The client metadata document is larger than 10 KB." : "The client metadata document could not be read." };
  }
  if (!doc || typeof doc !== "object") return { error: "The client metadata document must be a JSON object." };
  const d = doc as Record<string, unknown>;
  if (d.client_id !== url) return { error: "client_id in the metadata document does not equal its URL." };
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2048 && redirectUriOk(u))) {
    return { error: "redirect_uris in the metadata document must be 1 to 10 allowed URLs." };
  }
  // We only run public clients (PKCE, no secret). ChatGPT's document prefers private_key_jwt but lists none as supported,
  // and we publish only none, so it uses none. A client that can only authenticate with a key or secret is refused.
  const method = d.token_endpoint_auth_method;
  const alsoNone = Array.isArray(d.token_endpoint_auth_methods_supported) && d.token_endpoint_auth_methods_supported.includes("none");
  if (method !== undefined && method !== "none" && !alsoNone) return { error: "Only public clients (token_endpoint_auth_method none) are supported." };
  if (Array.isArray(d.grant_types) && !d.grant_types.includes("authorization_code")) return { error: "grant_types must include authorization_code." };
  const name = typeof d.client_name === "string" && d.client_name.trim() ? d.client_name.trim().slice(0, 100) : new URL(url).hostname;
  return { name, redirectUris: uris as string[] };
}

export function oauthRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono();
  const open = cors({ origin: "*", allowHeaders: ["*"], allowMethods: ["GET", "POST", "OPTIONS"] });
  r.use("/.well-known/oauth-authorization-server", open);
  r.use("/oauth/register", open);
  r.use("/oauth/token", open);

  r.get("/.well-known/oauth-authorization-server", (c) => {
    const o = publicOrigin(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      scopes_supported: Object.keys(OAUTH_SCOPES),
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: "https://revenuedot.app/docs/guides/connect-ai-assistants",
    });
  });

  const regError = (c: Context, description: string, error = "invalid_client_metadata") => c.json({ error, error_description: description }, 400);

  r.post("/oauth/register", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return regError(c, "The body must be a JSON object.");
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2048)) {
      return regError(c, "redirect_uris must be a list of 1 to 10 URLs.", "invalid_redirect_uri");
    }
    const bad = (uris as string[]).find((u) => !redirectUriOk(u));
    if (bad) return regError(c, `Redirect URI not allowed: ${bad}. Use https, http on localhost, or an app scheme.`, "invalid_redirect_uri");
    const grants = Array.isArray(b.grant_types) ? b.grant_types : ["authorization_code"];
    if (!grants.includes("authorization_code")) return regError(c, "grant_types must include authorization_code.");
    const name = typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : "MCP client";
    const id = newId("oac_", 24);
    const now = deps.now();
    await db.insert(schema.oauthClients).values({ id, name, redirectUris: uris as string[], createdAt: now });
    // Public client: we ignore a requested client_secret_* method and say so in the response (RFC 7591 section 3.2.1).
    return c.json({
      client_id: id, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
    }, 201);
  });

  /** Reads and checks an authorization request (query on GET, form on POST). `fatal` errors must not redirect. */
  async function authRequest(p: Record<string, string | undefined>) {
    const clientId = p.client_id ?? "";
    let [client] = clientId ? await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, clientId)).limit(1) : [];
    // A client_id that is an https URL names a client metadata document: read it, and keep the result for an hour.
    if (clientId.startsWith("https://") && (!client || deps.now().getTime() - client.createdAt.getTime() > CLIENT_DOC_TTL_MS)) {
      const doc = await fetchClientDoc(clientId, deps.fetch ?? fetch);
      if ("error" in doc) {
        if (!client) return { fatal: `RevenueDot could not verify this app. ${doc.error}` } as const;
      } else if (client) {
        [client] = await db.update(schema.oauthClients).set({ name: doc.name, redirectUris: doc.redirectUris, createdAt: deps.now() }).where(eq(schema.oauthClients.id, clientId)).returning();
      } else {
        [client] = await db.insert(schema.oauthClients).values({ id: clientId, name: doc.name, redirectUris: doc.redirectUris, createdAt: deps.now() }).returning();
      }
    }
    if (!client) return { fatal: "This app is not registered with RevenueDot (unknown client_id). Try connecting again from the app." } as const;
    const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
    if (!client.redirectUris.includes(redirectUri)) return { fatal: "The redirect_uri does not match one the app registered." } as const;
    const req = {
      client, redirectUri, state: p.state, ...parseScope(p.scope), resource: p.resource || null,
      codeChallenge: p.code_challenge ?? "", method: p.code_challenge_method ?? "",
    };
    let error: string | null = null;
    if (p.response_type !== "code") error = "response_type must be code.";
    else if (!req.codeChallenge || req.method !== "S256") error = "PKCE is required: send code_challenge with code_challenge_method=S256.";
    else if (!/^[A-Za-z0-9_-]{43,128}$/.test(req.codeChallenge)) error = "code_challenge is not a valid S256 challenge.";
    else if (req.resource && !resourceOk(req.resource)) error = "resource must be an absolute URL without a fragment.";
    return { req, error };
  }

  const back = (redirectUri: string, params: Record<string, string | undefined>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };
  const csrfFor = (sessionId: string, clientId: string) => sha256Hex(`${sessionId}:oauth-consent:${clientId}`);

  r.get("/oauth/authorize", async (c) => {
    const a = await authRequest(c.req.query());
    if ("fatal" in a) return c.html(page("Cannot connect", `<p>${esc(a.fatal!)}</p>`), 400);
    const { req } = a;
    if (a.error) return c.redirect(back(req.redirectUri, { error: "invalid_request", error_description: a.error, state: req.state, iss: publicOrigin(c) }));
    const sid = getCookie(c, SESSION_COOKIE);
    const user = await sessionUser(db, sid, deps.now());
    // Account pages (forgot password, new project) live on the dashboard host, which is not always this host.
    const dash = (deps.publicUrl ?? publicOrigin(c)).replace(/\/+$/, "");
    if (!user) return c.html(page(`Sign in to connect ${req.client.name}`, signInForm(req.client.name, dash)));
    const projects = await projectsForUser(db, user.id);
    if (!projects.length) return c.html(page("No project yet", `<p>Create a project in the RevenueDot dashboard first, then come back to ${esc(req.client.name)} and connect again.</p><div class="row"><a class="btn" href="${esc(dash)}/projects/new" target="_blank" rel="noopener">Create a project</a></div>`));
    const q = c.req.query();
    const hidden = ["client_id", "redirect_uri", "state", "scope", "resource", "code_challenge", "code_challenge_method", "response_type"]
      .filter((k) => q[k] !== undefined).map((k) => `<input type="hidden" name="${k}" value="${esc(q[k]!)}">`).join("");
    const redirectHost = (() => { const u = new URL(req.redirectUri); return u.host || `${u.protocol}//`; })();
    const options = projects.map((p) => `<option value="${esc(p.id)}" data-role="${esc(p.role)}">${esc(p.name)}${p.role === "viewer" ? " (view only)" : ""}</option>`).join("");
    const body = `
      <p><strong>${esc(req.client.name)}</strong> wants to use RevenueDot as <strong>${esc(user.email)}</strong>. It will get an API key for one project.</p>
      <p class="muted">Not you? <a href="#" id="switch">Use another account</a></p>
      ${req.client.id.startsWith("https://") ? `<p class="muted">App address: ${esc(new URL(req.client.id).host)}</p>` : ""}
      <form method="post" action="/oauth/authorize">
        ${hidden}<input type="hidden" name="csrf" value="${await csrfFor(sid!, req.client.id)}">
        <label>Project<select name="project_id">${options}</select></label>
        <fieldset><legend>Access</legend>
          <label class="opt"><input type="radio" name="access" value="project:write"${req.level === "project:write" ? " checked" : ""}> Read and change products, entitlements, offerings, customers' granted access and webhooks</label>
          <label class="opt"><input type="radio" name="access" value="project:read"${req.level === "project:read" ? " checked" : ""}> Read only</label>
        </fieldset>
        <fieldset><legend>Money actions</legend>
          <label class="opt"><input type="checkbox" name="support" value="1" id="support"${req.support ? " checked" : ""}${req.level === "project:read" ? " disabled" : ""}> Also allow cancelling, refunding and extending subscriptions, and Test Store purchases (needs "Read and change")</label>
        </fieldset>
        <p class="muted">You will return to ${esc(redirectHost)}. Revoke access any time under API keys in the dashboard.</p>
        <div class="row"><button name="decision" value="deny" class="secondary">Cancel</button><button name="decision" value="allow">Allow access</button></div>
      </form>
      <script>
        // Signs out of this browser's session and shows the sign-in form again, for the same authorization request.
        document.getElementById("switch").addEventListener("click", async (e) => {
          e.preventDefault();
          await fetch("/auth/logout", { method: "POST" }).catch(() => {});
          location.reload();
        });
        // Money actions need "Read and change"; the checkbox follows the access choice (the server enforces it too).
        const box = document.getElementById("support");
        const sync = () => { const ro = document.querySelector('input[name=access][value="project:read"]').checked; box.disabled = ro; if (ro) box.checked = false; };
        for (const r of document.querySelectorAll("input[name=access]")) r.addEventListener("change", sync);
        sync();
      </script>`;
    return c.html(page(`Connect ${req.client.name} to RevenueDot`, body));
  });

  r.post("/oauth/authorize", async (c) => {
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
    const a = await authRequest(form);
    if ("fatal" in a) return c.html(page("Cannot connect", `<p>${esc(a.fatal!)}</p>`), 400);
    const { req } = a;
    const iss = publicOrigin(c);
    if (a.error) return c.redirect(back(req.redirectUri, { error: "invalid_request", error_description: a.error, state: req.state, iss }), 302);
    const sid = getCookie(c, SESSION_COOKIE);
    const user = await sessionUser(db, sid, deps.now());
    if (!user) return c.html(page("Signed out", "<p>Your session ended. Go back to the app and connect again.</p>"), 401);
    if (!form.csrf || form.csrf !== (await csrfFor(sid!, req.client.id))) return c.html(page("Cannot connect", "<p>This form expired. Go back to the app and connect again.</p>"), 403);
    if (form.decision !== "allow") return c.redirect(back(req.redirectUri, { error: "access_denied", error_description: "The user did not allow access.", state: req.state, iss }), 302);
    const project = (await projectsForUser(db, user.id)).find((p) => p.id === form.project_id);
    if (!project) return c.html(page("Cannot connect", "<p>You are not a member of that project.</p>"), 403);
    // Viewers can only hand out read access.
    const level: Level = project.role === "viewer" || form.access === "project:read" ? "project:read" : "project:write";
    const support = level === "project:write" && form.support === "1";
    const code = randomToken();
    await db.insert(schema.oauthCodes).values({
      hash: await sha256Hex(code), clientId: req.client.id, userId: user.id, projectId: project.id, redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge, scope: scopeString(level, support), permissions: permissionsFor(level, support), resource: req.resource,
      expiresAt: new Date(deps.now().getTime() + CODE_TTL_MS),
    });
    return c.redirect(back(req.redirectUri, { code, state: req.state, iss }), 302);
  });

  const tokenError = (c: Context, error: string, description: string, status: 400 | 401 = 400) => {
    c.header("Cache-Control", "no-store");
    return c.json({ error, error_description: description }, status);
  };

  r.post("/oauth/token", async (c) => {
    const type = c.req.header("content-type") ?? "";
    const p: Record<string, string | undefined> = type.includes("application/json")
      ? Object.fromEntries(Object.entries((await c.req.json().catch(() => ({}))) as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : undefined]))
      : Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, typeof v === "string" ? v : undefined]));
    if (p.grant_type !== "authorization_code") return tokenError(c, "unsupported_grant_type", "Only grant_type=authorization_code is supported.");
    if (!p.code || !p.code_verifier) return tokenError(c, "invalid_request", "code and code_verifier are required.");
    // Single use: the row is deleted by the exchange that reads it, whether or not the rest checks out.
    const [row] = await db.delete(schema.oauthCodes)
      .where(and(eq(schema.oauthCodes.hash, await sha256Hex(p.code)), gt(schema.oauthCodes.expiresAt, deps.now()))).returning();
    if (!row) return tokenError(c, "invalid_grant", "The authorization code is invalid, expired or already used.");
    if (p.client_id && p.client_id !== row.clientId) return tokenError(c, "invalid_grant", "The code was issued to another client.");
    if (p.redirect_uri !== undefined && p.redirect_uri !== row.redirectUri) return tokenError(c, "invalid_grant", "redirect_uri does not match the authorization request.");
    if (p.resource && row.resource && p.resource !== row.resource) return tokenError(c, "invalid_target", "resource does not match the authorization request.");
    if ((await s256(p.code_verifier)) !== row.codeChallenge) return tokenError(c, "invalid_grant", "code_verifier does not match the code_challenge.");
    const [member] = await db.select().from(schema.memberships)
      .where(and(eq(schema.memberships.userId, row.userId), eq(schema.memberships.projectId, row.projectId))).limit(1);
    if (!member) return tokenError(c, "invalid_grant", "The user is no longer a member of the project.");
    // A viewer who lost write access since consent only gets read.
    const level: Level = member.role === "viewer" ? "project:read" : row.scope.startsWith("project:read") ? "project:read" : "project:write";
    const support = level === "project:write" && row.scope.includes(SUPPORT);
    const scope = scopeString(level, support);
    const [client] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, row.clientId)).limit(1);
    const { key } = await createSecretKey(db, row.projectId, `OAuth: ${client?.name ?? "MCP client"}`.slice(0, 100), permissionsFor(level, support));
    c.header("Cache-Control", "no-store");
    return c.json({ access_token: key, token_type: "Bearer", scope, project_id: row.projectId });
  });

  return r;
}

/**
 * What a signed-out person sees at /oauth/authorize: sign in, or create an account where sign-up is open (checked with
 * /auth/config, so self-hosted servers that closed sign-up show only the sign-in form). Either one reloads this same URL,
 * which now has a session, so they land on the consent screen for the app that sent them.
 */
function signInForm(clientName: string, dash: string) {
  return `
    <p>Sign in or create a RevenueDot account to connect ${esc(clientName)}.</p>
    <div class="tabs" role="tablist" aria-label="Account">
      <button type="button" id="tab-signin" class="tab on" role="tab" aria-selected="true" aria-controls="signin">Sign in</button>
      <button type="button" id="tab-signup" class="tab" role="tab" aria-selected="false" aria-controls="signup" hidden>Create account</button>
    </div>
    <form id="signin" role="tabpanel" aria-labelledby="tab-signin">
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="muted"><a id="forgot" href="${esc(dash)}/forgot-password" target="_blank" rel="noopener">Forgot your password?</a> It opens in a new tab; come back to this tab when you are done.</p>
      <p id="err-signin" class="err" role="alert" hidden></p>
      <div class="row"><button type="submit">Sign in</button></div>
    </form>
    <form id="signup" role="tabpanel" aria-labelledby="tab-signup" hidden>
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <p class="muted">At least 8 characters. We create a project called "My project" (rename it any time) and email you a link to confirm the address. By creating an account you agree to the <a href="https://revenuedot.app/legal/terms" target="_blank" rel="noopener">Terms</a> and <a href="https://revenuedot.app/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>
      <p id="err-signup" class="err" role="alert" hidden></p>
      <div class="row"><button type="submit">Create account</button></div>
    </form>
    <script>
      const show = (which) => {
        for (const id of ["signin", "signup"]) {
          document.getElementById(id).hidden = id !== which;
          const tab = document.getElementById("tab-" + id);
          tab.classList.toggle("on", id === which);
          tab.setAttribute("aria-selected", String(id === which));
        }
      };
      document.getElementById("tab-signin").onclick = () => show("signin");
      document.getElementById("tab-signup").onclick = () => show("signup");
      fetch("/auth/config").then((r) => r.json()).then((c) => { if (c.signup === "open") document.getElementById("tab-signup").hidden = false; }).catch(() => {});
      // The reset page gets the typed email, and this tab picks the new session up when the person comes back to it.
      const forgot = document.getElementById("forgot");
      forgot.addEventListener("click", () => {
        const email = document.querySelector("#signin input[name=email]").value.trim();
        forgot.href = ${JSON.stringify(`${dash}/forgot-password`).replace(/</g, "\\u003c")} + (email ? "?email=" + encodeURIComponent(email) : "");
      });
      window.addEventListener("focus", () => { fetch("/auth/me").then((r) => { if (r.ok) location.reload(); }).catch(() => {}); });
      const submit = (id, path, body) => document.getElementById(id).addEventListener("submit", async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const btn = e.target.querySelector("button[type=submit]");
        const err = document.getElementById("err-" + id);
        btn.disabled = true;
        err.hidden = true;
        try {
          const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body(f)) });
          if (res.ok) return location.reload();
          err.textContent = (await res.json().catch(() => ({}))).message || "That did not work. Try again.";
        } catch {
          err.textContent = "Could not reach RevenueDot. Check your connection and try again.";
        }
        btn.disabled = false;
        err.hidden = false;
      });
      submit("signin", "/auth/login", (f) => ({ email: f.get("email"), password: f.get("password") }));
      submit("signup", "/auth/signup", (f) => ({ email: f.get("email"), password: f.get("password"), project_name: "My project" }));
    </script>`;
}

/** The RevenueDot mark, the same as the dashboard's. */
const MARK = `<svg class="mark" width="32" height="32" viewBox="0 0 32 32" role="img" aria-label="RevenueDot"><rect width="32" height="32" fill="#0A0A0A"/><g transform="translate(4.4 4) scale(.75)"><path d="M8.5 25.5V6.5h7.2a5.5 5.5 0 010 11H8.5M14.6 17.5l2.2 2.6" fill="none" stroke="#FAFAFA" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="22" cy="23.6" r="3.2" fill="#F7B500"/></g></svg>`;

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="referrer" content="no-referrer">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#f7f7f8;--card:#fff;--fg:#111;--muted:#666;--line:#e3e3e6;--accent:#111;--accent-fg:#fff;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e10;--card:#18181b;--fg:#f2f2f3;--muted:#a0a0a8;--line:#2c2c31;--accent:#f2f2f3;--accent-fg:#111;--err:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Manrope,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:440px;width:100%}
h1{font-size:19px;margin:0 0 12px}.mark{display:block;margin:0 0 16px}a.btn{display:inline-block;text-decoration:none;padding:9px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg)}label{display:block;margin:14px 0 4px;font-weight:500}label.opt{font-weight:400;display:flex;gap:8px;align-items:flex-start;margin:8px 0}
input:disabled+*,label:has(input:disabled){opacity:.55}input[type=email],input[type=password],select{display:block;width:100%;margin-top:6px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
fieldset{border:0;padding:0;margin:14px 0 0}legend{font-weight:500;padding:0}.muted{color:var(--muted);font-size:13px}.err{color:var(--err)}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}
.tabs{display:flex;gap:6px;margin:12px 0 0}.tab{background:transparent;color:var(--muted);border:1px solid var(--line);padding:6px 12px}.tab.on{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}[hidden]{display:none!important}a{color:inherit}
</style></head><body><main>${MARK}<h1>${esc(title)}</h1>${body}</main></body></html>`;
}
