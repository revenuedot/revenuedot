import { Hono } from "hono";
import type { Deps } from "../context.js";
import { appleNotificationRoutes } from "../stores/apple/notifications.js";
import { googleNotificationRoutes } from "../stores/google/notifications.js";
import { amazonNotificationRoutes } from "../stores/amazon/notifications.js";
import { stripeNotificationRoutes } from "../stores/stripe/notifications.js";
import { stripeConnectNotificationRoutes } from "../stores/stripe/connect-notifications.js";
import { paddleNotificationRoutes } from "../stores/paddle/notifications.js";
import { rokuNotificationRoutes } from "../stores/roku/notifications.js";
import { galaxyNotificationRoutes } from "../stores/galaxy/notifications.js";

/**
 * Store server notifications. URLs (shown in the dashboard's app settings):
 *   App Store:   POST /v1/notifications/apple/{appId}
 *   Google Play: POST /v1/notifications/google/{appId}   (Pub/Sub push subscription)
 *   Amazon:      POST /v1/notifications/amazon/{appId}   (Real-time Notifications through Amazon SNS)
 *   Stripe:      POST /v1/notifications/stripe/{appId}   (webhook endpoint in the developer's Stripe account)
 *   Stripe Connect: POST /v1/notifications/stripe-connect (the platform's endpoint for every connected account)
 *   Paddle:      POST /v1/notifications/paddle/{appId}   (notification destination in the developer's Paddle account)
 *   Roku:        POST /v1/notifications/roku/{appId}     (Roku Pay push notification URL, signed JWTs)
 *   Galaxy:      POST /v1/notifications/galaxy/{appId}   (Samsung Instant Server Notification URL, JWTs)
 */
export function notificationRoutes(deps: Deps) {
  const r = new Hono();
  r.route("/v1/notifications/apple", appleNotificationRoutes(deps));
  r.route("/v1/notifications/google", googleNotificationRoutes(deps));
  r.route("/v1/notifications/amazon", amazonNotificationRoutes(deps));
  r.route("/", stripeConnectNotificationRoutes(deps));
  r.route("/v1/notifications/stripe", stripeNotificationRoutes(deps));
  r.route("/v1/notifications/paddle", paddleNotificationRoutes(deps));
  r.route("/v1/notifications/roku", rokuNotificationRoutes(deps));
  r.route("/v1/notifications/galaxy", galaxyNotificationRoutes(deps));
  return r;
}
