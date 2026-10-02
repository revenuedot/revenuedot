import { assetRoutes } from "./routes/assets.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Deps } from "./context.js";
import { sdkRoutes } from "./routes/sdk.js";
import { notificationRoutes } from "./routes/notifications.js";
import { lifecyclePublicRoutes } from "./routes/lifecycle-public.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { oauthRoutes } from "./routes/oauth.js";
import { v2Routes } from "./routes/v2/index.js";
import { adsPublicRoutes } from "./routes/ads-public.js";
import { supportAppRoutes } from "./routes/support-apps.js";
import { withCredentialHealth } from "./services/credential-health.js";
import { resolveSigner, responseSigning, signingKeyHandler, SIGNING_KEY_PATH } from "./services/signing.js";
import { PAY_CTX, payRoutes } from "./routes/pay.js";
import { projectForHost } from "./services/web/domains.js";
import { identityRoutes } from "./routes/identity.js";
import { verifiedRoutes } from "./routes/verified.js";
import { shareRoutes } from "./routes/share.js";
import { insightsPublicRoutes } from "./routes/insights-public.js";
import { importRoutes } from "./routes/imports.js";
import { billingRoutes } from "./routes/billing.js";
import { moveGate } from "./services/archive/gate.js";

export function createApp(input: Deps): Hono & { deps: Deps } {
  // Receipt checks that the store answers with a credentials error mark the app failing (the credentials alert).
  const deps: Deps = { ...input, stores: withCredentialHealth(input.stores, input.db, input.now) };
  const app = new Hono();
  // RevenueDot AI's tools call the API in-process through the app itself (services/assistant/client.ts).
  deps.dispatch = (req) => Promise.resolve(app.fetch(req));
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
    if (payHost && host === payHost) rewritten = path;
    else if (!known.has(host) && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && /^[a-z0-9.-]+(:\d+)?$/.test(host)) {
      // A verified custom domain serves the project's hosted pages and nothing else: never the API, sign-in or OAuth, whose
      // cookies and pages must not live on a domain a customer controls.
      projectSlug = await projectForHost(deps.db, host.replace(/:\d+$/, ""), deps.now().getTime());
      if (projectSlug) rewritten = /^\/(api|r)\//.test(path) ? path : `/${projectSlug}${path}`;
    }
    if (rewritten === null) return next();
    // The pay routes run on their own (no /pay prefix) with the request's link bases in PAY_CTX.
    const target = new URL(c.req.url);
    target.pathname = rewritten;
    const req = new Request(target, c.req.raw);
    // Behind a TLS proxy the request URL is http; the page's links must use the scheme the visitor used.
    const proto = (c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")).split(",")[0]!.trim();
    const origin = `${proto === "https" || proto === "http" ? proto : "https"}://${host}`;
    PAY_CTX.set(req, projectSlug ? { base: origin, projectBase: origin, projectSlug } : { base: deps.payUrl!.replace(/\/+$/, "") });
    return pay.fetch(req);
  });
  // SDK and REST calls come from anywhere; dashboard calls are same-origin with a cookie.
  const sdkCors = cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["X-RevenueCat-Request-Time", "X-RevenueCat-ETag", "X-Signature"] });
  app.use("/v1/*", sdkCors);
  app.use("/rcbilling/*", sdkCors);
  // A project that is moving to another server (prd/moves-export/PRD.md §3): forwarded requests go there with their
  // answer (signature included) coming back, and writes wait while it is paused. Before signing, so a forwarded answer
  // keeps the new server's signature.
  app.use("*", moveGate(deps));
  // Trusted Entitlements: sign SDK responses when REVENUEDOT_SIGNING_KEY (or deps.signingKey) is set.
  const signer = resolveSigner(deps.signingKey, deps.now);
  app.use("/v1/*", responseSigning(signer, deps.now));
  app.use("/rcbilling/*", responseSigning(signer, deps.now));
  app.get(SIGNING_KEY_PATH, signingKeyHandler(signer));
  app.get("/", (c) => c.json({ name: "RevenueDot", docs: "https://revenuedot.app/docs" }));
  // Enterprise extensions (extensions.ts): their middleware and routes come before every core route. None in the open-source build.
  for (const x of deps.extensions ?? []) x.mount?.(app, deps);
  // Store notifications are mounted before the SDK routes, which require an SDK API key.
  app.route("/", notificationRoutes(deps));
  // Apple's Retention Messaging call and the win-back email links (no API key).
  app.route("/", lifecyclePublicRoutes(deps));
  // AdMob's reward callback and OAuth redirect, and the Intercom inbox app (each authenticated by its caller, no API key).
  app.route("/", adsPublicRoutes(deps));
  app.route("/", supportAppRoutes(deps));
  // App sign-in (Auth, prd/auth) answers POST /auth/login when it carries an app key; the dashboard's sign-in gets the rest.
  app.route("/", identityRoutes(deps));
  // The weekly insights digest's one-click opt-out (no sign-in), before the dashboard's account routes.
  app.route("/", insightsPublicRoutes(deps));
  app.route("/", authRoutes(deps));
  // Account settings (prd/account-settings/PRD.md): email change, password, sessions, two-factor, OAuth tokens, deletion,
  // notification preferences and the display currency's rate.
  app.route("/", accountRoutes(deps));
  // Public Verified Metrics pages (prd/project-settings §4).
  app.route("/", verifiedRoutes(deps));
  // Public share cards (the first-sale card, prd/ai-assistant/PRD.md).
  app.route("/", shareRoutes(deps));
  // OAuth 2.1 for MCP clients: the access token is a project-scoped secret key.
  app.route("/", oauthRoutes(deps));
  // REST API v2 (secret key or dashboard session); mounted before the SDK routes.
  app.route("/", assetRoutes(deps));
  // Imports into this server (an account-level rdi_ token) and archive downloads: before v2, whose auth is per project.
  app.route("/", importRoutes(deps));
  // RevenueDot Cloud billing (session auth; 404 on self-host).
  app.route("/", billingRoutes(deps));
  app.route("/", v2Routes(deps));
  app.route("/pay", pay);
  app.route("/", sdkRoutes(deps));
  // The deps routes see (with `dispatch`): scheduled jobs that call the API in-process (AI growth insights) use them.
  return Object.assign(app, { deps });
}
