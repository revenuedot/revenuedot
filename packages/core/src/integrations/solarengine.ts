import { webhookPartner } from "./webhook-adapter.js";

/**
 * SolarEngine: ad attribution and analytics. SolarEngine's server receiving API is not public: RevenueCat's
 * description of its own delivery (https://www.revenuecat.com/docs/integrations/attribution/reference/solarengine) names
 * the hosts and an MD5 signature but not the path, the platform codes or the exact signing format, which is not enough
 * to build the request safely. So this is the webhook adapter (webhook-adapter.ts): RevenueCat's webhook body POSTed to
 * the URL SolarEngine support gives you.
 * Settings: `webhook_url` (secret, since it may carry your app key). Secrets: `authorization` (optional).
 * Identity: `$solarEngineDistinctId`, `$solarEngineAccountId` and `$solarEngineVisitorId` (set by the app from the
 * SolarEngine SDK), with `$idfv`, `$gpsAdId` and `$ip`, travel in the body's `subscriber_attributes`.
 * Sent: every lifecycle step except experiment enrollments. Production only by default (SolarEngine documents no
 * sandbox handling); a sandbox event that the environment filter lets through carries `environment: SANDBOX`.
 */
export const SOLARENGINE = webhookPartner({
  kind: "solarengine", name: "SolarEngine", category: "attribution", environment: "production",
  text: "Send subscription events to SolarEngine to attribute revenue to the campaigns that brought each customer.",
  urlLabel: "SolarEngine webhook URL", urlIsSecret: true,
  urlHint: "Ask SolarEngine support for the URL that receives RevenueCat webhooks for your app.",
  authHint: "Optional. Only if SolarEngine gives you an Authorization value with the URL.",
});
