import { conceptOf, defaultAnalyticsName, type BuildInput, type Concept, type IntegrationKind, type Plan, type WebhookEvent } from "./common.js";
import { buildSlack, SLACK_EVENTS } from "./slack.js";
import { buildSegment, SEGMENT_EVENTS } from "./segment.js";
import { buildAmplitude, AMPLITUDE_EVENTS } from "./amplitude.js";
import { buildMixpanel, MIXPANEL_EVENTS } from "./mixpanel.js";
import { buildPostHog, POSTHOG_EVENTS } from "./posthog.js";
import { buildFirebase, FIREBASE_NAMES } from "./firebase.js";
import { buildBigQuery } from "./bigquery.js";
import { buildAppsFlyer, APPSFLYER_EVENTS } from "./appsflyer.js";
import { buildAdjust, ADJUST_STEPS } from "./adjust.js";
import { buildMeta, META_NAMES } from "./meta.js";

export * from "./common.js";
export { buildSlack, buildSegment, buildAmplitude, buildMixpanel, buildPostHog, buildFirebase, buildBigQuery, buildAppsFlyer, buildAdjust, buildMeta };
export { BIGQUERY_SCHEMA, BIGQUERY_SCOPE, bigQueryCreateTable, bigQueryRow, bigQueryTablePath } from "./bigquery.js";
export { appsflyerTime } from "./appsflyer.js";

/**
 * The integration catalogue: what each integration needs. The API validates writes against it and the dashboard draws
 * its forms from it. `secret` fields are sealed at rest and never returned; `select` fields list their options.
 */
export interface IntegrationField {
  key: string;
  label: string;
  type: "text" | "secret" | "select" | "boolean" | "textarea" | "tokens";
  required?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
  placeholder?: string;
  /** Only shown when another select field has this value (`region: custom`). */
  when?: { key: string; value: string };
}

export interface IntegrationSpec {
  kind: IntegrationKind;
  name: string;
  category: "core" | "analytics" | "attribution" | "marketing";
  text: string;
  /** Environment default for a new integration ("production", "sandbox" or "both"). */
  environment: "production" | "both";
  /** Whether the dashboard offers event name overrides. */
  eventNames: boolean;
  fields: IntegrationField[];
  docs: string;
}

const REPORTING: IntegrationField = {
  key: "reporting", label: "Sales reporting", type: "select", options: [{ value: "gross", label: "Gross revenue" }, { value: "proceeds", label: "After store commission and taxes" }],
  hint: "Revenue is sent in US dollars.",
};
const DOCS = "https://revenuedot.app/docs/guides/integrations";

export const INTEGRATIONS: IntegrationSpec[] = [
  { kind: "slack", name: "Slack", category: "marketing", text: "Post new purchases, trials, cancellations, refunds and billing issues to a channel.", environment: "production", eventNames: false, docs: `${DOCS}#slack`,
    fields: [
      { key: "webhook_url", label: "Incoming webhook URL", type: "secret", required: true, placeholder: "https://hooks.slack.com/services/…", hint: "Create one in your Slack app under Incoming Webhooks and pick the channel." },
      REPORTING,
    ] },
  { kind: "segment", name: "Segment", category: "analytics", text: "A track and identify call for every event, for every destination in your workspace.", environment: "production", eventNames: true, docs: `${DOCS}#segment`,
    fields: [
      { key: "write_key", label: "Write key", type: "secret", required: true, hint: "From an HTTP API source in Segment." },
      { key: "region", label: "Region", type: "select", options: [{ value: "us", label: "US (api.segment.io)" }, { value: "eu", label: "EU (events.eu1.segmentapis.com)" }] },
      { key: "anonymous_id", label: "Send anonymous app user ids as anonymousId", type: "boolean" },
      REPORTING,
    ] },
  { kind: "amplitude", name: "Amplitude", category: "analytics", text: "Subscription events and revenue next to your product analytics.", environment: "both", eventNames: true, docs: `${DOCS}#amplitude`,
    fields: [
      { key: "api_key", label: "API key", type: "secret", required: true },
      { key: "sandbox_api_key", label: "Sandbox API key", type: "secret", hint: "A second Amplitude project for sandbox events. Without it sandbox events are not sent." },
      { key: "region", label: "Region", type: "select", options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }] }, REPORTING,
    ] },
  { kind: "mixpanel", name: "Mixpanel", category: "analytics", text: "Events, revenue and subscription status on Mixpanel profiles.", environment: "both", eventNames: true, docs: `${DOCS}#mixpanel`,
    fields: [
      { key: "project_token", label: "Project token", type: "secret", required: true },
      { key: "sandbox_project_token", label: "Sandbox project token", type: "secret", hint: "Without it sandbox events are not sent." },
      { key: "api_secret", label: "Project API secret", type: "secret", hint: "Optional. With it events go through /import, which accepts events of any age (replays of old events)." },
      { key: "region", label: "Data residency", type: "select", options: [{ value: "us", label: "US" }, { value: "eu", label: "EU" }, { value: "in", label: "India" }] }, REPORTING,
    ] },
  { kind: "posthog", name: "PostHog", category: "analytics", text: "Revenue events for funnels, retention and session replays.", environment: "both", eventNames: true, docs: `${DOCS}#posthog`,
    fields: [
      { key: "api_key", label: "Project API key", type: "secret", required: true, placeholder: "phc_…" },
      { key: "sandbox_api_key", label: "Sandbox project API key", type: "secret", hint: "Without it sandbox events are not sent." },
      { key: "region", label: "Region", type: "select", options: [{ value: "us", label: "US Cloud" }, { value: "eu", label: "EU Cloud" }, { value: "custom", label: "Self-hosted" }] },
      { key: "host", label: "PostHog URL", type: "text", placeholder: "https://posthog.example.com", when: { key: "region", value: "custom" } }, REPORTING,
    ] },
  { kind: "firebase", name: "Firebase", category: "analytics", text: "Purchase events in Google Analytics for Firebase.", environment: "production", eventNames: false, docs: `${DOCS}#firebase`,
    fields: [
      { key: "ios_firebase_app_id", label: "iOS Firebase app ID", type: "text", placeholder: "1:1234567890:ios:abc123" },
      { key: "ios_api_secret", label: "iOS Measurement Protocol API secret", type: "secret" },
      { key: "android_firebase_app_id", label: "Android Firebase app ID", type: "text", placeholder: "1:1234567890:android:abc123" },
      { key: "android_api_secret", label: "Android Measurement Protocol API secret", type: "secret" },
      { key: "currency", label: "Currency", type: "select", options: [{ value: "usd", label: "US dollars" }, { value: "local", label: "The currency the customer paid in" }] }, REPORTING,
    ] },
  { kind: "bigquery", name: "BigQuery", category: "core", text: "Every event as a row in a BigQuery table, streamed as it happens.", environment: "both", eventNames: false, docs: `${DOCS}#bigquery`,
    fields: [
      { key: "service_account_json", label: "Service account key (JSON)", type: "secret", required: true, hint: "Needs the BigQuery Data Editor role on the dataset." },
      { key: "project_id", label: "Project ID", type: "text", hint: "Defaults to the service account's project." },
      { key: "dataset_id", label: "Dataset", type: "text", required: true },
      { key: "table_id", label: "Table", type: "text", placeholder: "revenuedot_events", hint: "Created with RevenueDot's schema if it does not exist." }, REPORTING,
    ] },
  { kind: "appsflyer", name: "AppsFlyer", category: "attribution", text: "Report purchases, trials and renewals to AppsFlyer with the customer's AppsFlyer id.", environment: "both", eventNames: true, docs: `${DOCS}#appsflyer`,
    fields: [
      { key: "dev_key", label: "Developer key", type: "secret", required: true },
      { key: "sandbox_dev_key", label: "Sandbox developer key", type: "secret", hint: "Without it sandbox events are not sent." },
      { key: "s2s_token", label: "The key is an S2S token", type: "boolean" },
      { key: "ios_app_id", label: "iOS app ID", type: "text", placeholder: "id123456789" },
      { key: "android_app_id", label: "Android app ID", type: "text", placeholder: "com.example.app" }, REPORTING,
    ] },
  { kind: "adjust", name: "Adjust", category: "attribution", text: "Report purchases and renewals to Adjust with event tokens you choose.", environment: "both", eventNames: false, docs: `${DOCS}#adjust`,
    fields: [
      { key: "ios_app_token", label: "iOS app token", type: "text" },
      { key: "android_app_token", label: "Android app token", type: "text" },
      { key: "event_tokens", label: "Event tokens", type: "tokens", hint: "The Adjust event token for each step. Steps without a token are not sent." },
      { key: "oauth_token", label: "S2S auth token", type: "secret", hint: "Only when S2S security is on in Adjust." }, REPORTING,
    ] },
  { kind: "meta", name: "Meta", category: "attribution", text: "Send purchase conversions to Meta through the Conversions API.", environment: "production", eventNames: true, docs: `${DOCS}#meta`,
    fields: [
      { key: "dataset_id", label: "Dataset ID", type: "text", required: true },
      { key: "access_token", label: "Conversions API access token", type: "secret", required: true },
      { key: "sandbox_dataset_id", label: "Sandbox dataset ID", type: "text" },
      { key: "sandbox_access_token", label: "Sandbox access token", type: "secret" },
      { key: "send_without_att", label: "Send iOS events without ATT consent", type: "boolean" },
      { key: "test_event_code", label: "Test event code", type: "text", hint: "Optional. Events show in Events Manager's Test Events tab." }, REPORTING,
    ] },
];

export const INTEGRATION_KINDS = INTEGRATIONS.map((s) => s.kind);

/** The lifecycle steps each integration sends (BigQuery takes every event). Events outside the list are not queued. */
export const INTEGRATION_EVENTS: Record<IntegrationKind, Concept[] | "all"> = {
  slack: SLACK_EVENTS, segment: SEGMENT_EVENTS, amplitude: AMPLITUDE_EVENTS, mixpanel: MIXPANEL_EVENTS, posthog: POSTHOG_EVENTS,
  firebase: Object.keys(FIREBASE_NAMES) as Concept[], bigquery: "all", appsflyer: APPSFLYER_EVENTS, adjust: ADJUST_STEPS, meta: Object.keys(META_NAMES) as Concept[],
};

/** Whether an integration of this kind sends this event at all (before its own checks for keys and device ids). */
export function sendsEvent(kind: IntegrationKind, event: WebhookEvent): boolean {
  const list = INTEGRATION_EVENTS[kind] as Concept[] | "all" | undefined;
  if (!list) return false;
  if (list === "all") return true;
  const c = conceptOf(event);
  return !!c && list.includes(c);
}
export const integrationSpec = (k: string) => INTEGRATIONS.find((s) => s.kind === k);
export { ADJUST_STEPS };

const BUILDERS: Record<IntegrationKind, (i: BuildInput) => Promise<Plan>> = {
  slack: buildSlack, segment: buildSegment, amplitude: buildAmplitude, mixpanel: buildMixpanel, posthog: buildPostHog,
  firebase: buildFirebase, bigquery: buildBigQuery, appsflyer: buildAppsFlyer, adjust: buildAdjust, meta: buildMeta,
};

export function buildIntegration(kind: IntegrationKind, input: BuildInput): Promise<Plan> {
  const b = BUILDERS[kind];
  if (!b) return Promise.resolve({ skip: `Unknown integration ${kind}.` });
  return b(input);
}

/**
 * Whether a partner's answer means "accepted". HTTP 2xx is necessary; some APIs also answer 200 with an error inside:
 * Mixpanel's verbose `{ status: 0 }`, BigQuery's `insertErrors`, Adjust's `{ error }`, Slack's non-"ok" body.
 * Returns an error message, or null when the request was accepted.
 */
export function responseError(kind: IntegrationKind, status: number, body: string): string | null {
  if (status < 200 || status >= 300) return `HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ""}`;
  let j: any = null;
  try { j = body ? JSON.parse(body) : null; } catch { j = null; }
  if (kind === "mixpanel" && j && typeof j === "object" && "status" in j && j.status !== 1 && j.status !== "OK") return `Mixpanel rejected the event: ${j.error ?? JSON.stringify(j)}`;
  if (kind === "bigquery" && j?.insertErrors?.length) return `BigQuery rejected the row: ${JSON.stringify(j.insertErrors[0]?.errors ?? j.insertErrors[0]).slice(0, 300)}`;
  if (kind === "adjust" && j?.error) return `Adjust rejected the event: ${j.error}`;
  if (kind === "slack" && body && body.trim() !== "ok") return `Slack answered: ${body.slice(0, 200)}`;
  return null;
}

/** HTTP statuses worth retrying: timeouts, rate limits and server errors. Any other 4xx fails at once (fix the settings, then replay). */
export const retryableStatus = (status: number | null) => status === null || status === 408 || status === 425 || status === 429 || status >= 500;

/** Plain names for the lifecycle steps (dashboard labels). */
export const STEP_LABELS: Record<Concept, string> = {
  initial_purchase: "Initial purchase", trial_started: "Trial started", trial_converted: "Trial converted", trial_cancelled: "Trial cancelled",
  renewal: "Renewal", cancellation: "Cancellation or refund", uncancellation: "Uncancellation", non_subscription_purchase: "One-time purchase",
  subscription_paused: "Subscription paused", expiration: "Expiration", billing_issue: "Billing issue", product_change: "Product change",
  transfer: "Transfer", purchase_redeemed: "Web purchase redeemed", experiment_enrollment: "Experiment enrollment", refund_reversed: "Refund reversed", test: "Test event",
};

/** The name an integration sends for a step when no override is set (null: the integration has no event names). */
export function defaultEventName(kind: IntegrationKind, c: Concept): string | null {
  if (kind === "meta") return META_NAMES[c] ?? null;
  if (kind === "firebase") return FIREBASE_NAMES[c] ?? null;
  if (kind === "slack" || kind === "bigquery" || kind === "adjust") return null;
  return defaultAnalyticsName(c);
}
