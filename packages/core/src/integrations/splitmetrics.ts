import { webhookPartner } from "./webhook-adapter.js";

/**
 * SplitMetrics Acquire: Apple Search Ads campaign management. SplitMetrics publishes no API for subscription events; for
 * RevenueCat apps it asks for a Client ID (https://help.splitmetrics.com/en/articles/5817211-how-to-link-revenuecat-partner-integration)
 * and documents no public URL behind it. So this is the webhook adapter (webhook-adapter.ts): RevenueCat's webhook body
 * POSTed to the URL SplitMetrics support gives you.
 * Settings: `webhook_url` (secret, since it may carry your Client ID). Secrets: `authorization` (optional).
 * Identity: the Apple Search Ads attributes in the body's `subscriber_attributes` ($mediaSource, $campaign, $adGroup,
 * $keyword, $appleAdsCampaignId and the rest), which RevenueDot stores from the SDK's AdServices token.
 * Sent: every lifecycle step except experiment enrollments, sandbox included (`environment: SANDBOX` in the body).
 */
export const SPLITMETRICS = webhookPartner({
  kind: "splitmetrics", name: "SplitMetrics Acquire", category: "attribution", environment: "both",
  text: "Send subscription revenue to SplitMetrics Acquire to see what each Apple Search Ads campaign earned.",
  urlLabel: "SplitMetrics Acquire webhook URL", urlIsSecret: true,
  urlHint: "SplitMetrics Acquire shows a Client ID for RevenueCat, not a URL. Ask SplitMetrics support for the URL that receives RevenueCat webhooks for your Client ID.",
  authHint: "Optional. Only if SplitMetrics gives you an Authorization value with the URL.",
});
