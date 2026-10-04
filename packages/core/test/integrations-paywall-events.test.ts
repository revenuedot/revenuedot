import { describe, expect, it } from "vitest";
import { buildIntegration, conceptOf, defaultEventName, INTEGRATION_EVENTS, sendsEvent, subscriptionStatusOf, type IntegrationKind, type WebhookEvent } from "../src/integrations/index.js";

/**
 * Paywall events (opt-in PAYWALL_* types, prd/integrations/PRD.md "Paywall events"): Segment, Amplitude, Mixpanel and
 * PostHog get them under RevenueCat's default names (paywall_impression …) with the paywall's fields and no revenue.
 */

const impression: WebhookEvent = {
  id: "9A1B2C3D-0000-5000-8000-000000000001", type: "PAYWALL_IMPRESSION", event_timestamp_ms: 1790000000000, app_id: "app_ios",
  app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", aliases: ["$RCAnonymousID:abc", "user_42"], environment: "PRODUCTION", store: "APP_STORE",
  paywall_id: "pw_1", paywall_name: "Spring sale", paywall_revision: 3, offering_id: "default", session_id: "S-1", display_mode: "full_screen", dark_mode: false, locale: "en_US",
  sdk_version: "5.62.0", subscriber_attributes: { $email: { value: "a@example.com", updated_at_ms: 1 } },
};
const interacted: WebhookEvent = {
  ...impression, id: "9A1B2C3D-0000-5000-8000-000000000002", type: "PAYWALL_COMPONENT_INTERACTED",
  component_type: "package", component_value: "selected", component_name: "annual_pkg", origin_package_id: "monthly", destination_package_id: "annual",
  origin_product_id: "prod_monthly", destination_product_id: "prod_annual",
};
const purchaseError: WebhookEvent = { ...impression, id: "9A1B2C3D-0000-5000-8000-000000000003", type: "PAYWALL_PURCHASE_ERROR", package_id: "annual", product_id: "prod_annual", error_code: 2, error_message: "Payment declined" };
const sandbox: WebhookEvent = { ...impression, environment: "SANDBOX" };

const now = new Date("2026-10-03T10:00:00Z");
const CONFIG: Record<string, { settings: Record<string, any>; secrets: Record<string, string> }> = {
  segment: { settings: {}, secrets: { write_key: "wk_123" } },
  amplitude: { settings: {}, secrets: { api_key: "amp_key" } },
  mixpanel: { settings: {}, secrets: { project_token: "mp_token" } },
  posthog: { settings: {}, secrets: { api_key: "phc_key" } },
};
const ANALYTICS = ["segment", "amplitude", "mixpanel", "posthog"] as const;

async function sent(kind: IntegrationKind, event: WebhookEvent, eventNames?: Record<string, string>) {
  const p = await buildIntegration(kind, { event, ...CONFIG[kind]!, eventNames, now });
  if ("skip" in p) throw new Error(`${kind} skipped: ${p.skip}`);
  return { name: p.name, requests: p.requests.map((r) => ({ url: r.url, json: JSON.parse(r.body) })) };
}

const PAYWALL_FIELDS = { paywall_id: "pw_1", paywall_name: "Spring sale", offering_id: "default", session_id: "S-1", display_mode: "full_screen", dark_mode: false, locale: "en_US", environment: "PRODUCTION" };

describe("paywall events to analytics tools", () => {
  it("map to the paywall concepts, carry no subscription status, and default to RevenueCat's names", () => {
    expect(conceptOf(impression)).toBe("paywall_impression");
    expect(conceptOf({ type: "PAYWALL_PURCHASE_INITIATED" })).toBe("paywall_purchase_initiated");
    expect(subscriptionStatusOf(impression)).toBeNull();
    for (const k of ANALYTICS) {
      expect(sendsEvent(k, impression)).toBe(true);
      expect(defaultEventName(k, "paywall_component_interacted")).toBe("paywall_component_interacted");
    }
    // Only the four analytics tools RevenueCat sends them to, plus BigQuery (every event); never the webhook-adapter partners or Slack.
    const senders = (Object.keys(INTEGRATION_EVENTS) as IntegrationKind[]).filter((k) => sendsEvent(k, impression)).sort();
    expect(senders).toEqual(["amplitude", "bigquery", "mixpanel", "posthog", "segment"]);
  });

  it("Amplitude: event_properties hold the paywall fields; no revenue, no user properties", async () => {
    const { name, requests } = await sent("amplitude", interacted);
    expect(name).toBe("paywall_component_interacted");
    const ev = requests[0]!.json.events[0];
    expect(ev).toMatchObject({ event_type: "paywall_component_interacted", user_id: "user_42", insert_id: interacted.id, time: 1790000000000, platform: "iOS" });
    expect(ev.event_properties).toMatchObject({ ...PAYWALL_FIELDS, paywall_revision: 3, sdk_version: "5.62.0", component_type: "package", component_value: "selected", component_name: "annual_pkg",
      origin_package_id: "monthly", destination_package_id: "annual", origin_product_id: "prod_monthly", destination_product_id: "prod_annual", subscriber_attributes: impression.subscriber_attributes });
    expect(ev).not.toHaveProperty("revenue");
    expect(ev).not.toHaveProperty("user_properties");
    expect(ev.event_properties).not.toHaveProperty("revenue");
    expect(ev.event_properties).not.toHaveProperty("transaction_id");
  });

  it("Mixpanel: one track call with the paywall fields, no profile update", async () => {
    const { requests } = await sent("mixpanel", impression);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.mixpanel.com/track?verbose=1");
    const [ev] = requests[0]!.json;
    expect(ev.event).toBe("paywall_impression");
    expect(ev.properties).toMatchObject({ ...PAYWALL_FIELDS, token: "mp_token", distinct_id: "user_42", time: 1790000000, $insert_id: impression.id });
    expect(ev.properties).not.toHaveProperty("revenue");
  });

  it("PostHog: the capture body has the paywall fields and no $set", async () => {
    const { requests } = await sent("posthog", purchaseError);
    const b = requests[0]!.json;
    expect(b).toMatchObject({ event: "paywall_purchase_error", distinct_id: "user_42", uuid: purchaseError.id.toLowerCase() });
    expect(b.properties).toMatchObject({ ...PAYWALL_FIELDS, package_id: "annual", product_id: "prod_annual", error_code: 2, error_message: "Payment declined" });
    expect(b.properties).not.toHaveProperty("$set");
    expect(b.properties).not.toHaveProperty("revenue");
  });

  it("Segment: track with the paywall fields, identify without a subscription status", async () => {
    const { requests } = await sent("segment", impression);
    expect(requests.map((r) => r.url)).toEqual(["https://api.segment.io/v1/track", "https://api.segment.io/v1/identify"]);
    expect(requests[0]!.json).toMatchObject({ userId: "user_42", event: "paywall_impression", messageId: impression.id, properties: { ...PAYWALL_FIELDS, app_id: "app_ios" } });
    expect(requests[0]!.json.properties).not.toHaveProperty("revenue");
    expect(requests[1]!.json.traits).toEqual({ last_seen_app_user_id: "user_42", aliases: impression.aliases });
  });

  it("names are overridable, and sandbox events need the sandbox key like any other event", async () => {
    for (const k of ANALYTICS) expect((await sent(k, impression, { paywall_impression: "Paywall Viewed" })).name).toBe("Paywall Viewed");
    const p = await buildIntegration("amplitude", { event: sandbox, ...CONFIG.amplitude!, now });
    expect(p).toEqual({ skip: "Sandbox events need a sandbox API key." });
  });
});
