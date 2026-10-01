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

export function createApp(input: Deps) {
  // Receipt checks that the store answers with a credentials error mark the app failing (the credentials alert).
  const deps: Deps = { ...input, stores: withCredentialHealth(input.stores, input.db, input.now) };
  const app = new Hono();
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
  app.route("/", sdkRoutes(deps));
  return app;
}
