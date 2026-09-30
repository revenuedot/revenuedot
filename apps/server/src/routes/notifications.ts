import { Hono } from "hono";
import type { Deps } from "../context.js";
import { appleNotificationRoutes } from "../stores/apple/notifications.js";
import { googleNotificationRoutes } from "../stores/google/notifications.js";

/**
 * Store server notifications. URLs (shown in the dashboard's app settings):
 *   App Store:   POST /v1/notifications/apple/{appId}
 *   Google Play: POST /v1/notifications/google/{appId}   (Pub/Sub push subscription)
 */
export function notificationRoutes(deps: Deps) {
  const r = new Hono();
  r.route("/v1/notifications/apple", appleNotificationRoutes(deps));
  r.route("/v1/notifications/google", googleNotificationRoutes(deps));
  return r;
}
