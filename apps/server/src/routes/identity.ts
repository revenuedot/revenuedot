import { Hono, type Context, type Next } from "hono";
import type { Deps } from "../context.js";
import { Codes, RCError, errorResponse } from "../errors.js";
import { isSubscriberToken, resolveKey } from "../services/auth.js";
import { AuthRefused, AuthUnavailable, identityJwks, refresh, revoke, signIn } from "../services/identity/sessions.js";
import { KeysUnavailable, TokenInvalid } from "../services/identity/verify.js";
import { OutboundRefused } from "../services/outbound.js";
import { requestOrigin } from "../services/account-email.js";

/**
 * Auth sign-in for apps (prd/auth), in the wire format of the SDKs' token login:
 *   POST /auth/login    and /v1/auth/login     { method, scope, id_token, link_to_id? }  → tokens
 *   POST /auth/token    and /v1/auth/token     { grant_type: "refresh_token", refresh_token } → tokens
 *   POST /auth/revoke   and /v1/auth/revoke    { token, token_type_hint }
 *   GET  /.well-known/jwks.json                the public key of RevenueDot's ID and access tokens
 * Every call carries the app's public SDK key as `Authorization: Bearer`. `/auth/login` is also the dashboard's sign-in,
 * which never sends an Authorization header: those requests pass through to it.
 */

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-platform, x-version, x-is-sandbox", "access-control-allow-methods": "POST, OPTIONS", "access-control-max-age": "86400" };

export function identityRoutes(deps: Deps) {
  const r = new Hono();
  r.onError((e, c) => errorResponse(c, e));

  const issuerOf = (c: Context) => {
    if (deps.apiUrl) return deps.apiUrl.replace(/\/+$/, "");
    return requestOrigin(c.req.url, (n) => c.req.header(n));
  };
  const bearer = (c: Context) => (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  /** The calling app, from its public SDK key. */
  const appOf = async (c: Context) => {
    const key = bearer(c);
    const auth = key && !isSubscriberToken(key) ? await resolveKey(deps.db, key, deps.now()) : null;
    if (!auth || auth.kind !== "public" || !auth.app) throw new RCError(401, Codes.INVALID_API_KEY, "Sign-in needs the app's public SDK key as the bearer token.");
    return auth.app;
  };
  const bodyOf = async (c: Context) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "The body must be a JSON object.");
    return b as Record<string, unknown>;
  };
  const str = (v: unknown, max = 20_000) => (typeof v === "string" && v.length <= max ? v : undefined);
  /** Turns verification and configuration failures into the SDK's error codes. */
  const guarded = async (c: Context, run: () => Promise<Response>) => {
    // Every SDK response carries the server time; the SDK's signature check includes it.
    c.header("X-RevenueCat-Request-Time", String(deps.now().getTime()));
    try { return await run(); } catch (e) {
      if (e instanceof TokenInvalid) throw new RCError(401, Codes.INVALID_AUTH_TOKEN, e.message);
      if (e instanceof AuthRefused) throw new RCError(403, Codes.INVALID_AUTH_TOKEN, e.message);
      if (e instanceof KeysUnavailable || e instanceof OutboundRefused) throw new RCError(503, Codes.INTERNAL, `${e.message} Try again in a minute.`);
      if (e instanceof AuthUnavailable) throw new RCError(503, Codes.INTERNAL, e.message);
      throw e;
    }
  };
  const json = (c: Context, body: unknown, status: 200 | 201 = 200) => c.json(body, status, { ...CORS, "cache-control": "no-store", pragma: "no-cache" });

  const login = (c: Context) => guarded(c, async () => {
    const app = await appOf(c);
    const b = await bodyOf(c);
    const method = str(b.method, 40);
    if (!method) throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "method is required: firebase, oidc or anonymous.");
    const res = await signIn(deps, {
      app, method, idToken: str(b.id_token, 16_384), linkToId: str(b.link_to_id, 200), scope: str(b.scope, 200), issuer: issuerOf(c),
      sandbox: c.req.header("x-is-sandbox") === "true",
    });
    deps.kick?.();
    return json(c, res.tokens);
  });
  const token = (c: Context) => guarded(c, async () => {
    const app = await appOf(c);
    const b = await bodyOf(c);
    if (b.grant_type !== "refresh_token") throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "grant_type must be refresh_token.");
    const rt = str(b.refresh_token, 200);
    if (!rt) throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "refresh_token is required.");
    return json(c, (await refresh(deps, { app, refreshToken: rt, issuer: issuerOf(c), scope: str(b.scope, 200) })).tokens);
  });
  const revokeH = (c: Context) => guarded(c, async () => {
    const app = await appOf(c);
    const b = await bodyOf(c);
    const t = str(b.token, 20_000);
    if (!t) throw new RCError(400, Codes.BAD_REQUEST_PARAMS, "token is required.");
    await revoke(deps, { app, token: t });
    return json(c, {});
  });

  // The dashboard posts its sign-in form here without an Authorization header; apps always send their key.
  const appOnly = (h: (c: Context) => Promise<Response>) => async (c: Context, next: Next) => (c.req.header("authorization") ? h(c) : next());
  const preflight = (c: Context, next: Next) => (/authorization/i.test(c.req.header("access-control-request-headers") ?? "") ? c.body(null, 204, CORS) : next());
  r.options("/auth/*", preflight);
  r.post("/auth/login", appOnly(login));
  r.post("/auth/token", appOnly(token));
  r.post("/auth/revoke", appOnly(revokeH));
  r.post("/v1/auth/login", login);
  r.post("/v1/auth/token", token);
  r.post("/v1/auth/revoke", revokeH);

  r.get("/.well-known/jwks.json", async (c) => c.json(await identityJwks(deps), 200, { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" }));
  return r;
}
