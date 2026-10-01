import { DOCS, REPORTING, defaultAnalyticsName, type Concept, type PartnerDef } from "./common.js";
import { AIRSHIP_EVENTS, airshipAnswerError, buildAirship } from "./airship.js";
import { BRAZE_ENDPOINTS, BRAZE_EVENTS, brazeAnswerError, brazeEndpointOk, buildBraze } from "./braze.js";
import { CLEVERTAP_EVENTS, CLEVERTAP_REGIONS, buildCleverTap, cleverTapAnswerError } from "./clevertap.js";
import { CUSTOMERIO_EVENTS, buildCustomerio } from "./customerio.js";
import { DISCORD_EVENTS, buildDiscord, discordWebhookOk } from "./discord.js";
import { INTERCOM_EVENTS, buildIntercom, intercomAnswerError } from "./intercom.js";
import { ITERABLE_EVENTS, buildIterable, iterableAnswerError } from "./iterable.js";
import { ONESIGNAL_EVENTS, buildOneSignal, oneSignalAnswerError, oneSignalAppIdOk } from "./onesignal.js";

/** Batch D marketing partners (prd/integrations/PRD.md, "Batch D partners"). */

const named = (events: Concept[]) => (c: Concept) => (events.includes(c) ? defaultAnalyticsName(c) : null);

/** A sandbox setting and its secret only work together. */
function pair(settings: Record<string, any>, secrets: Record<string, string>, setting: string, secret: string, label: string) {
  const a = !!String(settings[setting] ?? "").trim(), b = !!secrets[secret];
  return a === b ? null : { param: `settings.${a ? secret : setting}`, message: `set both the ${label}, or neither.` };
}

export const MARKETING_PARTNERS: PartnerDef[] = [
  {
    spec: {
      kind: "airship", name: "Airship", category: "marketing", api: "documented", environment: "both", eventNames: true, docs: `${DOCS}#airship`,
      text: "Subscription events as Airship custom events, on the device's channel or the named user.",
      fields: [
        { key: "app_key", label: "App key", type: "text", required: true },
        { key: "token", label: "Bearer token", type: "secret", required: true, hint: "A token with the Events role (and Attributes if you set the status attribute), from Settings, Tokens." },
        { key: "region", label: "Cloud site", type: "select", options: [{ value: "us", label: "US (go.urbanairship.com)" }, { value: "eu", label: "EU (go.airship.eu)" }] },
        { key: "sandbox_app_key", label: "Sandbox app key", type: "text", hint: "A second Airship project for sandbox events. Without it and its token sandbox events are not sent." },
        { key: "sandbox_token", label: "Sandbox bearer token", type: "secret" },
        { key: "set_attributes", label: "Set the rc_subscription_status attribute", type: "boolean", hint: "Create a text attribute named rc_subscription_status in Airship first." },
        REPORTING,
      ],
    },
    events: AIRSHIP_EVENTS, build: buildAirship, defaultName: named(AIRSHIP_EVENTS), answerError: airshipAnswerError,
    validate: (s, x) => pair(s, x, "sandbox_app_key", "sandbox_token", "sandbox app key and sandbox token"),
  },
  {
    spec: {
      kind: "braze", name: "Braze", category: "marketing", api: "documented", environment: "both", eventNames: true, docs: `${DOCS}#braze`,
      text: "Custom events, purchases and rc_subscription_status on Braze user profiles.",
      fields: [
        { key: "rest_endpoint", label: "REST endpoint", type: "select", required: true, options: BRAZE_ENDPOINTS, hint: "Your instance's REST endpoint, under Settings, APIs and Identifiers." },
        { key: "api_key", label: "REST API key", type: "secret", required: true, hint: "Needs the users.track permission." },
        { key: "sandbox_api_key", label: "Sandbox REST API key", type: "secret", hint: "A second Braze workspace for sandbox events. Without it sandbox events are not sent." },
        { key: "app_id", label: "App identifier", type: "text", hint: "Optional. Ties events to one Braze app." },
        { key: "revenue_format", label: "Revenue", type: "select", options: [{ value: "ecommerce", label: "eCommerce order placed events" }, { value: "purchase", label: "Legacy purchase objects" }] },
        REPORTING,
      ],
    },
    events: BRAZE_EVENTS, build: buildBraze, defaultName: named(BRAZE_EVENTS), answerError: brazeAnswerError,
    validate: (s) => (s.rest_endpoint && !brazeEndpointOk(s.rest_endpoint) ? { param: "settings.rest_endpoint", message: "must be a Braze REST endpoint, such as https://rest.iad-01.braze.com or https://rest.fra-01.braze.eu." } : null),
  },
  {
    spec: {
      kind: "clevertap", name: "CleverTap", category: "marketing", api: "documented", environment: "both", eventNames: true, docs: `${DOCS}#clevertap`,
      text: "Subscription events and rc_subscription_status on CleverTap profiles.",
      fields: [
        { key: "account_id", label: "Account ID", type: "text", required: true },
        { key: "passcode", label: "Passcode", type: "secret", required: true },
        { key: "region", label: "Region", type: "select", options: CLEVERTAP_REGIONS.map(({ value, label }) => ({ value, label })) },
        { key: "sandbox_account_id", label: "Sandbox account ID", type: "text", hint: "A second CleverTap account for sandbox events. Without it and its passcode sandbox events are not sent." },
        { key: "sandbox_passcode", label: "Sandbox passcode", type: "secret" },
        REPORTING,
      ],
    },
    events: CLEVERTAP_EVENTS, build: buildCleverTap, defaultName: named(CLEVERTAP_EVENTS), answerError: cleverTapAnswerError,
    validate: (s, x) => pair(s, x, "sandbox_account_id", "sandbox_passcode", "sandbox account ID and sandbox passcode"),
  },
  {
    spec: {
      kind: "customerio", name: "Customer.io", category: "marketing", api: "documented", environment: "both", eventNames: true, docs: `${DOCS}#customerio`,
      text: "Subscription events and rc_subscription_status on Customer.io people, for campaigns and segments.",
      fields: [
        { key: "site_id", label: "Site ID", type: "text", required: true, hint: "Track API credentials, under Workspace Settings, API Credentials." },
        { key: "api_key", label: "Track API key", type: "secret", required: true },
        { key: "region", label: "Region", type: "select", options: [{ value: "us", label: "US (track.customer.io)" }, { value: "eu", label: "EU (track-eu.customer.io)" }] },
        { key: "sandbox_site_id", label: "Sandbox site ID", type: "text", hint: "A second workspace for sandbox events. Without it and its API key sandbox events are not sent." },
        { key: "sandbox_api_key", label: "Sandbox Track API key", type: "secret" },
        REPORTING,
      ],
    },
    events: CUSTOMERIO_EVENTS, build: buildCustomerio, defaultName: named(CUSTOMERIO_EVENTS),
    validate: (s, x) => pair(s, x, "sandbox_site_id", "sandbox_api_key", "sandbox site ID and sandbox API key"),
  },
  {
    spec: {
      kind: "discord", name: "Discord", category: "marketing", api: "documented", environment: "production", eventNames: false, docs: `${DOCS}#discord`,
      text: "Post new purchases, trials, cancellations, refunds and billing issues to a channel.",
      fields: [
        { key: "webhook_url", label: "Webhook URL", type: "secret", required: true, url: true, placeholder: "https://discord.com/api/webhooks/…", hint: "In the channel's settings, Integrations, Webhooks, New Webhook, Copy Webhook URL." },
        REPORTING,
      ],
    },
    events: DISCORD_EVENTS, build: buildDiscord,
    validate: (_s, x) => (x.webhook_url && !discordWebhookOk(x.webhook_url) ? { param: "settings.webhook_url", message: "must be a Discord webhook URL, such as https://discord.com/api/webhooks/<id>/<token>." } : null),
  },
  {
    spec: {
      kind: "intercom", name: "Intercom", category: "marketing", api: "documented", environment: "production", eventNames: true, docs: `${DOCS}#intercom`,
      text: "Subscription events on Intercom contacts, for series, segments and messages.",
      fields: [
        { key: "access_token", label: "Access token", type: "secret", required: true, hint: "From your Intercom app in the Developer Hub, Authentication." },
        { key: "region", label: "Data hosting region", type: "select", options: [{ value: "us", label: "US (api.intercom.io)" }, { value: "eu", label: "EU (api.eu.intercom.io)" }, { value: "au", label: "Australia (api.au.intercom.io)" }] },
        REPORTING,
      ],
    },
    events: INTERCOM_EVENTS, build: buildIntercom, defaultName: named(INTERCOM_EVENTS), answerError: intercomAnswerError,
  },
  {
    spec: {
      kind: "iterable", name: "Iterable", category: "marketing", api: "documented", environment: "both", eventNames: true, docs: `${DOCS}#iterable`,
      text: "Subscription events, purchases and rc_subscription_status on Iterable users.",
      fields: [
        { key: "api_key", label: "Server-side API key", type: "secret", required: true },
        { key: "sandbox_api_key", label: "Sandbox server-side API key", type: "secret", hint: "A second Iterable project for sandbox events. Without it sandbox events are not sent." },
        { key: "region", label: "Data center", type: "select", options: [{ value: "us", label: "US (api.iterable.com)" }, { value: "eu", label: "EU (api.eu.iterable.com)" }] },
        { key: "track_purchases", label: "Send paid events as Iterable purchases", type: "boolean", hint: "Purchases, conversions, renewals and one-time purchases go to Track Purchase, for Iterable's revenue reports." },
        REPORTING,
      ],
    },
    events: ITERABLE_EVENTS, build: buildIterable, defaultName: named(ITERABLE_EVENTS), answerError: iterableAnswerError,
  },
  {
    spec: {
      kind: "onesignal", name: "OneSignal", category: "marketing", api: "documented", environment: "production", eventNames: false, docs: `${DOCS}#onesignal`,
      text: "Subscription status, product and expiry as OneSignal user tags, for segments and messages.",
      fields: [
        { key: "app_id", label: "App ID", type: "text", required: true, placeholder: "00000000-0000-0000-0000-000000000000" },
        { key: "api_key", label: "App API key", type: "secret", required: true, hint: "Under Settings, Keys & IDs." },
      ],
    },
    events: ONESIGNAL_EVENTS, build: buildOneSignal, answerError: oneSignalAnswerError,
    validate: (s) => (s.app_id && !oneSignalAppIdOk(s.app_id) ? { param: "settings.app_id", message: "must be your OneSignal App ID (a UUID)." } : null),
  },
];
