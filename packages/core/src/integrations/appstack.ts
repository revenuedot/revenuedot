import { webhookPartner } from "./webhook-adapter.js";

/**
 * Appstack: ad attribution. Appstack takes RevenueCat events as a webhook, not through an API of its own
 * (https://www.revenuecat.com/docs/integrations/attribution/appstack): in Appstack open Integrations → RevenueCat and copy
 * the Webhook URL and the Authorization Header. This is the webhook adapter (webhook-adapter.ts): RevenueCat's webhook
 * body POSTed to that URL with that header.
 * Settings: `webhook_url` (text; it holds the Appstack app, the token is in the header). Secrets: `authorization`.
 * Identity: the `$appstackId` attribute (the Appstack SDK's user id) travels in the body's `subscriber_attributes`;
 * Appstack matches on it, so it is not checked here.
 * Sent: every lifecycle step except experiment enrollments. Sandbox events are sent with `environment: SANDBOX`,
 * which Appstack keeps apart from production.
 */
export const APPSTACK = webhookPartner({
  kind: "appstack", name: "Appstack", category: "attribution", environment: "both",
  text: "Send subscription events to Appstack to attribute revenue to the campaigns that brought each customer.",
  urlLabel: "Appstack webhook URL", urlIsSecret: false, urlPlaceholder: "https://api.event.appstack.tech/…",
  urlHint: "In Appstack open Integrations → RevenueCat and copy the Webhook URL.",
  authHint: "In Appstack open Integrations → RevenueCat and copy the Authorization Header.", authRequired: true,
});
