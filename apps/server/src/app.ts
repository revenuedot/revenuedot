import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Deps } from "./context.js";
import { sdkRoutes } from "./routes/sdk.js";
import { notificationRoutes } from "./routes/notifications.js";

export function createApp(deps: Deps) {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["*"], exposeHeaders: ["X-RevenueCat-Request-Time", "X-RevenueCat-ETag"] }));
  app.get("/", (c) => c.json({ name: "RevenueDot", docs: "https://revenuedot.app/docs" }));
  // Store notifications are mounted before the SDK routes, which require an SDK API key.
  app.route("/", notificationRoutes(deps));
  app.route("/", sdkRoutes(deps));
  return app;
}
