import { assetRoutes } from "./routes/assets.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Deps } from "./context.js";
import { sdkRoutes } from "./routes/sdk.js";
import { notificationRoutes } from "./routes/notifications.js";
import { authRoutes } from "./routes/auth.js";
import { oauthRoutes } from "./routes/oauth.js";
import { v2Routes } from "./routes/v2/index.js";
import { withCredentialHealth } from "./services/credential-health.js";
import { resolveSigner, responseSigning, signingKeyHandler, SIGNING_KEY_PATH } from "./services/signing.js";
import { PAY_CTX, payRoutes } from "./routes/pay.js";
import { projectForHost } from "./services/web/domains.js";
import { API_PATH } from "./api-paths.js";

export function createApp(input: Deps) {
  // Receipt checks that the store answers with a credentials error mark the app failing (the credentials alert).
  const deps: Deps = { ...input, stores: withCredentialHealth(input.stores, input.db, input.now) };
  const app = new Hono();
  const pay = payRoutes(deps);
  // Hosted web pages on the pay host (REVENUEDOT_PAY_URL without a path) and on verified custom domains are served by the
  // pay routes at the root of that host (prd/web-billing/PRD.md §7). Everything else on those hosts is not found.
  const payUrl = deps.payUrl ? new URL(deps.payUrl) : null;
  const payHost = payUrl && (payUrl.pathname === "/" || payUrl.pathname === "") ? payUrl.host.toLowerCase() : null;
  const known = new Set([deps.publicUrl, deps.apiUrl].filter(Boolean).map((u) => { try { return new URL(u!).host.toLowerCase(); } catch { return ""; } }));
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const host = (c.req.header("x-forwarded-host") ?? url.host).toLowerCase();
    const path = url.pathname;
    let rewritten: string | null = null;
    let projectSlug: string | null = null;
    if (payHost && host === payHost) rewritten = `/pay${path === "/" ? "" : path}`;
    else if (!known.has(host) && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && !API_PATH.test(path) && !path.startsWith("/pay/") && !path.startsWith("/assets/") && /^[a-z0-9.-]+(:\d+)?$/.test(host)) {
      projectSlug = await projectForHost(deps.db, host.replace(/:\d+$/, ""), deps.now().getTime());
      if (projectSlug) rewritten = /^\/(api|r)\//.test(path) ? `/pay${path}` : `/pay/${projectSlug}${path === "/" ? "/" : path}`;
    }
    if (rewritten === null) return next();
    const target = new URL(c.req.url);
    target.pathname = rewritten;
    const req = new Request(target, c.req.raw);
    const origin = `${url.protocol}//${host}`;
    PAY_CTX.set(req, projectSlug ? { base: origin, projectBase: origin, projectSlug } : { base: deps.payUrl!.replace(/\/+$/, "") });
    return pay.fetch(req);
  });
  // SDK and REST calls come from anywhere; dashboard calls are same-origin with a cookie.
  const sdkCors = cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["X-RevenueCat-Request-Time", "X-RevenueCat-ETag", "X-Signature"] });
  app.use("/v1/*", sdkCors);
  app.use("/rcbilling/*", sdkCors);
  // Trusted Entitlements: sign SDK responses when REVENUEDOT_SIGNING_KEY (or deps.signingKey) is set.
  const signer = resolveSigner(deps.signingKey, deps.now);
  app.use("/v1/*", responseSigning(signer, deps.now));
  app.use("/rcbilling/*", responseSigning(signer, deps.now));
  app.get(SIGNING_KEY_PATH, signingKeyHandler(signer));
  app.get("/", (c) => c.json({ name: "RevenueDot", docs: "https://revenuedot.app/docs" }));
  // Store notifications are mounted before the SDK routes, which require an SDK API key.
  app.route("/", notificationRoutes(deps));
  app.route("/", authRoutes(deps));
  // OAuth 2.1 for MCP clients: the access token is a project-scoped secret key.
  app.route("/", oauthRoutes(deps));
  // REST API v2 (secret key or dashboard session); mounted before the SDK routes.
  app.route("/", assetRoutes(deps));
  app.route("/", v2Routes(deps));
  app.route("/pay", pay);
  app.route("/", sdkRoutes(deps));
  return app;
}
