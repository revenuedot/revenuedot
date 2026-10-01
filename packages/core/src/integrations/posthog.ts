import { attr, conceptOf, defaultAnalyticsName, isSandbox, json, lifecycleProperties, nameFor, skip, subscriptionStatusOf, type BuildInput, type Concept, type Plan } from "./common.js";

/**
 * PostHog: one event per RevenueDot event through the capture endpoint (https://posthog.com/docs/api/capture).
 * Secrets: `api_key` (the project's public key), `sandbox_api_key` (sandbox events are sent only with it).
 * Settings: `region` (us | eu | custom) and `host` for a self-hosted PostHog, `reporting`.
 * Identity: `$posthogUserId` when set, else the app user id. `uuid` is the event id, so PostHog deduplicates retries.
 */

export const POSTHOG_HOSTS = { us: "https://us.i.posthog.com", eu: "https://eu.i.posthog.com" } as const;

export const POSTHOG_EVENTS: Concept[] = [
  "initial_purchase", "trial_started", "trial_converted", "trial_cancelled", "renewal", "cancellation", "uncancellation",
  "non_subscription_purchase", "subscription_paused", "expiration", "billing_issue", "product_change", "test",
];

const PLATFORMS: Record<string, string> = { APP_STORE: "iOS", MAC_APP_STORE: "macOS", PLAY_STORE: "Android", AMAZON: "Amazon", STRIPE: "Web", RC_BILLING: "Web", PADDLE: "Web" };

/** A UUID for PostHog's `uuid` from the event id (already a UUID for every event RevenueDot records). */
const uuidOf = (id: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : undefined);

export function posthogHost(settings: Record<string, any>): string {
  if (settings.region === "custom" && typeof settings.host === "string" && settings.host.trim()) return settings.host.trim().replace(/\/+$/, "");
  return POSTHOG_HOSTS[(settings.region as keyof typeof POSTHOG_HOSTS) ?? "us"] ?? POSTHOG_HOSTS.us;
}

export async function buildPostHog(i: BuildInput): Promise<Plan> {
  const e = i.event;
  const key = isSandbox(e) ? i.secrets.sandbox_api_key : i.secrets.api_key;
  if (!key) return skip(isSandbox(e) ? "Sandbox events need a sandbox project API key." : "No PostHog project API key is saved.");
  const c = conceptOf(e);
  if (!c || !POSTHOG_EVENTS.includes(c)) return skip(`${e.type} events are not sent to PostHog.`);
  const name = nameFor(c, defaultAnalyticsName, i.eventNames)!;
  const status = subscriptionStatusOf(e);
  const properties: Record<string, unknown> = {
    ...lifecycleProperties(e, i.settings.reporting), insert_id: String(e.id), platform: PLATFORMS[e.store as string] ?? null,
  };
  if (status) { properties.rc_subscription_status = status; properties.$set = { rc_subscription_status: status }; }
  const body: Record<string, unknown> = {
    api_key: key, event: name, distinct_id: attr(e, "$posthogUserId") ?? String(e.app_user_id ?? e.original_app_user_id),
    timestamp: new Date(e.event_timestamp_ms ?? i.now.getTime()).toISOString(), properties,
  };
  const uuid = uuidOf(String(e.id));
  if (uuid) body.uuid = uuid;
  return { name, requests: [{ method: "POST", url: `${posthogHost(i.settings)}/i/v0/e/`, headers: { "content-type": "application/json" }, body: json(body) }], redact: [key] };
}
