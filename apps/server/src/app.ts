import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Deps } from "./context.js";
import { sdkRoutes } from "./routes/sdk.js";
import { notificationRoutes } from "./routes/notifications.js";
import { authRoutes } from "./routes/auth.js";
import { v2Routes } from "./routes/v2/index.js";

export function createApp(deps: Deps) {
  const app = new Hono();
  // SDK and REST calls come from anywhere; dashboard calls are same-origin with a cookie.
  const sdkCors = cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["X-RevenueCat-Request-Time", "X-RevenueCat-ETag"] });
  app.use("/v1/*", sdkCors);
  app.use("/rcbilling/*", sdkCors);
  app.get("/", (c) => c.json({ name: "RevenueDot", docs: "https://revenuedot.app/docs" }));
  // Store notifications are mounted before the SDK routes, which require an SDK API key.
  app.route("/", notificationRoutes(deps));
  app.route("/", authRoutes(deps));
  // REST API v2 (secret key or dashboard session); mounted before the SDK routes.
  app.route("/", v2Routes(deps));
  app.route("/", sdkRoutes(deps));
  return app;
}
