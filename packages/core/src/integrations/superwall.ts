import { webhookPartner } from "./webhook-adapter.js";

/**
 * Superwall: revenue tracking for paywalls. Superwall publishes no API for subscription events; for RevenueCat apps it
 * asks for an integration token (Superwall dashboard, Settings → Revenue Tracking → RevenueCat;
 * https://superwall.com/docs/overview-settings-revenue-tracking) and documents no public URL behind it. So this is the
 * webhook adapter (webhook-adapter.ts): RevenueCat's webhook body POSTed to the URL Superwall support gives you.
 * Settings: `webhook_url` (secret, since Superwall's own ingest URLs carry a private key in the query).
 * Secrets: `authorization` (optional; the integration token, as the Authorization header value Superwall asks for).
 * Identity: the body's `app_user_id`, `original_app_user_id` and `aliases`, which the Superwall SDK sets from the same id.
 * Sent: every lifecycle step except experiment enrollments, sandbox included (`environment: SANDBOX` in the body).
 */
export const SUPERWALL = webhookPartner({
  kind: "superwall", name: "Superwall", category: "analytics", environment: "both",
  text: "Send subscription events and revenue to Superwall so paywall reports show what each paywall earned.",
  urlLabel: "Superwall webhook URL", urlIsSecret: true, urlPlaceholder: "https://superwall.com/api/integrations/…",
  urlHint: "Superwall shows a RevenueCat integration token, not a URL, under Settings → Revenue Tracking → RevenueCat. Ask Superwall support for the URL that receives RevenueCat webhooks.",
  authHint: "Optional. The integration token from Superwall's Settings → Revenue Tracking → RevenueCat, in the form Superwall asks for.",
});
