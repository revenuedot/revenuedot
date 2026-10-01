import { describe, expect, it } from "vitest";
import {
  INTEGRATIONS, buildIntegration, conceptOf, responseError, retryableStatus, sendsEvent, subscriptionStatusOf, type IntegrationKind, type Plan, type WebhookEvent,
} from "../src/integrations/index.js";

/**
 * Payload builders: the exact request each integration gets for one App Store purchase, plus the event names and the
 * fields that change for trials, renewals, cancellations, refunds and expirations, and the skip rules.
 * The event is the webhook `event` object services/events.ts stores (RevenueCat's webhook shape).
 */

const at = (k: string, v: string) => ({ [k]: { value: v, updated_at_ms: 1789990000000 } });
const purchase: WebhookEvent = {
  id: "5E7B1C2A-1111-4222-8333-444455556666", type: "INITIAL_PURCHASE", event_timestamp_ms: 1790000000000, app_id: "app_ios",
  app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", aliases: ["$RCAnonymousID:abc", "user_42"],
  product_id: "pro_monthly", period_type: "NORMAL", purchased_at_ms: 1790000000000, expiration_at_ms: 1792592000000, environment: "PRODUCTION",
  entitlement_id: null, entitlement_ids: ["pro"], presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111",
  is_family_share: false, country_code: "DE", currency: "EUR", price: 10.79, price_in_purchased_currency: 9.99,
  subscriber_attributes: {
    ...at("$email", " Wren@Example.com "), ...at("$phoneNumber", "+1 (555) 010-0199"), ...at("$appsflyerId", "1700000000000-1234567"), ...at("$adjustId", "adid_9f8e"),
    ...at("$fbAnonId", "XZ1A2B3C"), ...at("$idfa", "AEBE52E7-03EE-455A-B3C4-E57283966239"), ...at("$idfv", "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11"), ...at("$ip", "203.0.113.7"),
    ...at("$attConsentStatus", "authorized"), ...at("$firebaseAppInstanceId", "f1rebase-instance"),
  },
  store: "APP_STORE", takehome_percentage: 0.7, tax_percentage: 0, commission_percentage: 0.3, offer_code: null,
};
const trial: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000002", period_type: "TRIAL", price: 0, price_in_purchased_currency: 0 };
const conversion: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000003", type: "RENEWAL", is_trial_conversion: true };
const renewal: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000004", type: "RENEWAL", is_trial_conversion: false };
const cancellation: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000005", type: "CANCELLATION", cancel_reason: "UNSUBSCRIBE", price: 0, price_in_purchased_currency: 0 };
const refund: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000006", type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT", price: -10.79, price_in_purchased_currency: -9.99 };
const expiration: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000007", type: "EXPIRATION", expiration_reason: "UNSUBSCRIBE", price: 0, price_in_purchased_currency: 0 };
const sandbox: WebhookEvent = { ...purchase, environment: "SANDBOX" };
const android: WebhookEvent = { ...purchase, store: "PLAY_STORE", subscriber_attributes: { ...at("$gpsAdId", "38400000-8cf0-11bd-b23e-10b96e40000d"), ...at("$adjustId", "adid_android"), ...at("$appsflyerId", "af_android") } };

const now = new Date("2026-09-21T14:13:21Z");
const CONFIG: Partial<Record<IntegrationKind, { settings: Record<string, any>; secrets: Record<string, string> }>> = {
  slack: { settings: {}, secrets: { webhook_url: "https://hooks.slack.com/services/T000/B000/XXXX" } },
  segment: { settings: { region: "us" }, secrets: { write_key: "wk_live_123" } },
  amplitude: { settings: { region: "eu" }, secrets: { api_key: "amp_key", sandbox_api_key: "amp_sandbox" } },
  mixpanel: { settings: {}, secrets: { project_token: "mp_token" } },
  posthog: { settings: { region: "eu" }, secrets: { api_key: "phc_live" } },
  firebase: { settings: { ios_firebase_app_id: "1:123:ios:abc", android_firebase_app_id: "1:123:android:def" }, secrets: { ios_api_secret: "ga_ios", android_api_secret: "ga_android" } },
  bigquery: { settings: { project_id: "acme-data", dataset_id: "revenue" }, secrets: {} },
  appsflyer: { settings: { ios_app_id: "id123456789", android_app_id: "com.example.scanner" }, secrets: { dev_key: "af_dev_key" } },
  adjust: { settings: { ios_app_token: "ios_app_tok", android_app_token: "and_app_tok", event_tokens: { initial_purchase: "ev_ip", trial_started: "ev_ts", trial_converted: "ev_tc", renewal: "ev_rn", cancellation: "ev_cn", expiration: "ev_ex" } }, secrets: { oauth_token: "adj_oauth" } },
  meta: { settings: { dataset_id: "1234567890" }, secrets: { access_token: "EAAB_token" } },
};

async function plan(kind: IntegrationKind, event: WebhookEvent, over: { settings?: Record<string, any>; secrets?: Record<string, string>; eventNames?: Record<string, string> } = {}): Promise<Plan> {
  const c = CONFIG[kind] ?? { settings: {}, secrets: {} };
  return buildIntegration(kind, {
    event, settings: { ...c.settings, ...over.settings }, secrets: { ...c.secrets, ...over.secrets }, eventNames: over.eventNames, now,
    context: { projectId: "proj1", dashboardUrl: "https://app.revenuedot.app", bundleId: "com.example.scanner", appVersion: "3.4.1", platformVersion: "18.5", locale: "en_US", accessToken: "ya29.token" },
  });
}
async function sent(kind: IntegrationKind, event: WebhookEvent, over?: Parameters<typeof plan>[2]) {
  const p = await plan(kind, event, over);
  if ("skip" in p) throw new Error(`${kind} skipped: ${p.skip}`);
  return { name: p.name, requests: p.requests.map((r) => ({ ...r, json: r.headers["content-type"] === "application/json" ? JSON.parse(r.body) : null })), redact: p.redact };
}
async function skipped(kind: IntegrationKind, event: WebhookEvent, over?: Parameters<typeof plan>[2]) {
  const p = await plan(kind, event, over);
  return "skip" in p ? p.skip : null;
}

const lifecycle = {
  app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", aliases: ["$RCAnonymousID:abc", "user_42"], product_id: "pro_monthly", period_type: "NORMAL",
  purchased_at: "2026-09-21T14:13:20Z", expiration_at: "2026-10-21T14:13:20Z", environment: "PRODUCTION", store: "APP_STORE", entitlement_id: null, entitlement_ids: ["pro"],
  presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111", country_code: "DE", currency: "EUR", revenue: 10.79, app_id: "app_ios",
  subscriber_attributes: purchase.subscriber_attributes,
};

describe("event names", () => {
  it("tells trials, conversions and refunds apart", () => {
    expect([purchase, trial, conversion, renewal, cancellation, { ...cancellation, period_type: "TRIAL" }, refund, expiration].map(conceptOf))
      .toEqual(["initial_purchase", "trial_started", "trial_converted", "renewal", "cancellation", "trial_cancelled", "cancellation", "expiration"]);
    expect([purchase, trial, cancellation, refund, expiration, { ...purchase, type: "BILLING_ISSUE", period_type: "TRIAL" }].map(subscriptionStatusOf))
      .toEqual(["active", "trial", "cancelled", "expired", "expired", "grace_period_trial"]);
  });
  it("uses rc_<step>_event for the analytics tools, overridable per step", async () => {
    for (const kind of ["segment", "amplitude", "mixpanel", "posthog"] as const) {
      expect((await sent(kind, purchase)).name).toBe("rc_initial_purchase_event");
      expect((await sent(kind, trial)).name).toBe("rc_trial_started_event");
      expect((await sent(kind, conversion)).name).toBe("rc_trial_converted_event");
      expect((await sent(kind, renewal)).name).toBe("rc_renewal_event");
      expect((await sent(kind, cancellation)).name).toBe("rc_cancellation_event");
      expect((await sent(kind, { ...cancellation, period_type: "TRIAL" })).name).toBe("rc_trial_cancelled_event");
      expect((await sent(kind, expiration)).name).toBe("rc_expiration_event");
      expect((await sent(kind, { ...purchase, type: "NON_RENEWING_PURCHASE" })).name).toBe("rc_non_subscription_purchase_event");
      expect((await sent(kind, purchase, { eventNames: { initial_purchase: "Subscribed" } })).name).toBe("Subscribed");
    }
  });
  it("Firebase uses GA's purchase for money and rc_* for the rest; Meta uses its standard events", async () => {
    const fb = async (e: WebhookEvent) => (await sent("firebase", e)).requests[0]!.json.events[0];
    expect(await fb(purchase)).toMatchObject({ name: "purchase", params: { is_renewal: false, is_trial_conversion: false, value: 10.79, currency: "USD" } });
    expect(await fb(conversion)).toMatchObject({ name: "purchase", params: { is_renewal: false, is_trial_conversion: true } });
    expect(await fb(renewal)).toMatchObject({ name: "purchase", params: { is_renewal: true, is_trial_conversion: false } });
    expect((await fb(trial)).name).toBe("rc_trial_start");
    expect(await fb(cancellation)).toMatchObject({ name: "rc_cancellation", params: { cancel_reason: "UNSUBSCRIBE" } });
    expect(await fb(expiration)).toMatchObject({ name: "rc_expiration", params: { expiration_reason: "UNSUBSCRIBE" } });
    expect((await sent("meta", trial)).name).toBe("StartTrial");
    expect((await sent("meta", purchase)).name).toBe("Subscribe");
    expect((await sent("meta", renewal)).name).toBe("Subscribe");
    expect((await sent("meta", { ...purchase, type: "NON_RENEWING_PURCHASE" })).name).toBe("fb_mobile_purchase");
    expect(await skipped("meta", refund)).toMatch(/not sent to Meta/);
    expect(await skipped("meta", expiration)).toMatch(/not sent to Meta/);
  });
  it("queues only the events an integration sends", () => {
    expect(sendsEvent("slack", expiration)).toBe(false);
    expect(sendsEvent("slack", refund)).toBe(true);
    expect(sendsEvent("meta", cancellation)).toBe(false);
    expect(sendsEvent("bigquery", { type: "SUBSCRIPTION_EXTENDED" })).toBe(true);
    expect(sendsEvent("amplitude", { type: "TRANSFER" })).toBe(false);
    expect(sendsEvent("firebase", { type: "TRANSFER" })).toBe(true);
  });
});

describe("INITIAL_PURCHASE, exact requests", () => {
  it("Slack", async () => {
    const s = await sent("slack", purchase);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.url).toBe("https://hooks.slack.com/services/T000/B000/XXXX");
    expect(s.requests[0]!.json).toEqual({
      text: "Customer user_42 started a subscription: pro_monthly ($10.79).",
      username: "RevenueDot",
      attachments: [{
        fallback: "Customer user_42 started a subscription: pro_monthly ($10.79).", color: "#5F822B", ts: 1790000000,
        fields: [
          { value: "Customer <https://app.revenuedot.app/projects/proj1/customers/user_42|user_42> started a subscription." },
          { title: "Product", value: "pro_monthly", short: true }, { title: "Revenue", value: "$10.79", short: true },
          { title: "Store", value: "APP_STORE", short: true }, { title: "Country", value: "DE", short: true },
        ],
      }],
    });
  });

  it("Segment: track and identify with Basic auth and messageId", async () => {
    const s = await sent("segment", purchase);
    expect(s.requests.map((r) => [r.method, r.url, r.headers.authorization])).toEqual([
      ["POST", "https://api.segment.io/v1/track", "Basic d2tfbGl2ZV8xMjM6"], ["POST", "https://api.segment.io/v1/identify", "Basic d2tfbGl2ZV8xMjM6"],
    ]);
    const context = { environment: "production", library: { name: "RevenueDot Segment events", version: "1.0" } };
    expect(s.requests[0]!.json).toEqual({
      userId: "user_42", event: "rc_initial_purchase_event", context, timestamp: "2026-09-21T14:13:20.000Z", messageId: purchase.id,
      properties: {
        revenue: 10.79, currency: "USD", price_in_purchased_currency: 9.99, purchased_currency: "EUR", store: "APP_STORE", product_id: "pro_monthly",
        entitlement: "pro", entitlements: ["pro"], purchased_at: 1790000000, expires_at: 1792592000, period_type: "NORMAL", environment: "PRODUCTION",
        presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111", app_user_id: "user_42",
        original_app_user_id: "$RCAnonymousID:abc", aliases: ["$RCAnonymousID:abc", "user_42"], app_id: "app_ios", country_code: "DE",
        subscriber_attributes: purchase.subscriber_attributes,
      },
    });
    expect(s.requests[1]!.json).toEqual({
      userId: "user_42", traits: { last_seen_app_user_id: "user_42", aliases: ["$RCAnonymousID:abc", "user_42"], rc_subscription_status: "active" },
      context, timestamp: "2026-09-21T14:13:20.000Z", messageId: `${purchase.id}-identify`,
    });
  });

  it("Amplitude: HTTP V2 with insert_id and revenue", async () => {
    const s = await sent("amplitude", purchase);
    expect(s.requests[0]!.url).toBe("https://api.eu.amplitude.com/2/httpapi");
    expect(s.requests[0]!.json).toEqual({
      api_key: "amp_key", options: { min_id_length: 1 },
      events: [{
        user_id: "user_42", event_type: "rc_initial_purchase_event", time: 1790000000000, insert_id: purchase.id, partner_id: "revenuedot", platform: "iOS",
        event_properties: lifecycle, revenue: 10.79, price: 10.79, quantity: 1, productId: "pro_monthly", revenueType: "purchase", country: "DE",
        user_properties: { $set: { rc_subscription_status: "active" } },
      }],
    });
  });

  it("Mixpanel: /track plus a profile update with $transactions", async () => {
    const s = await sent("mixpanel", purchase);
    expect(s.requests.map((r) => r.url)).toEqual(["https://api.mixpanel.com/track?verbose=1", "https://api.mixpanel.com/engage?verbose=1"]);
    expect(s.requests[0]!.json).toEqual([{
      event: "rc_initial_purchase_event",
      properties: {
        token: "mp_token", distinct_id: "user_42", time: 1790000000, $insert_id: "5E7B1C2A-1111-4222-8333-444455556666", revenue: 10.79, currency: "USD",
        product_id: "pro_monthly", store: "APP_STORE", offer_code: null, period_type: "NORMAL", environment: "PRODUCTION", entitlement_ids: ["pro"],
        presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111", app_user_id: "user_42",
        original_app_user_id: "$RCAnonymousID:abc", app_id: "app_ios", $country_code: "DE", price_in_purchased_currency: 9.99, purchased_currency: "EUR",
      },
    }]);
    expect(s.requests[1]!.json).toEqual([
      { $token: "mp_token", $distinct_id: "user_42", $ignore_time: true, $set: { rc_subscription_status: "active" } },
      { $token: "mp_token", $distinct_id: "user_42", $ignore_time: true, $append: { $transactions: { $time: "2026-09-21T14:13:20", $amount: 10.79, product_id: "pro_monthly", store: "APP_STORE" } } },
    ]);
    const imp = await sent("mixpanel", purchase, { settings: { region: "eu" }, secrets: { api_secret: "mp_secret" } });
    expect(imp.requests[0]!.url).toBe("https://api-eu.mixpanel.com/import?strict=1");
    expect(imp.requests[0]!.headers.authorization).toBe("Basic bXBfc2VjcmV0Og==");
    expect(imp.requests[0]!.json[0].properties.time).toBe(1790000000000);
  });

  it("PostHog: capture with uuid and $set", async () => {
    const s = await sent("posthog", purchase);
    expect(s.requests[0]!.url).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(s.requests[0]!.json).toEqual({
      api_key: "phc_live", event: "rc_initial_purchase_event", distinct_id: "user_42", timestamp: "2026-09-21T14:13:20.000Z", uuid: "5e7b1c2a-1111-4222-8333-444455556666",
      properties: { ...lifecycle, insert_id: purchase.id, platform: "iOS", rc_subscription_status: "active", $set: { rc_subscription_status: "active" } },
    });
    expect((await sent("posthog", purchase, { settings: { region: "custom", host: "https://ph.example.com/" } })).requests[0]!.url).toBe("https://ph.example.com/i/v0/e/");
  });

  it("Firebase: Measurement Protocol for the iOS stream", async () => {
    const s = await sent("firebase", purchase);
    expect(s.requests[0]!.url).toBe("https://www.google-analytics.com/mp/collect?firebase_app_id=1%3A123%3Aios%3Aabc&api_secret=ga_ios");
    expect(s.requests[0]!.json).toEqual({
      app_instance_id: "f1rebase-instance", user_id: "user_42", timestamp_micros: 1790000000000000,
      events: [{ name: "purchase", params: {
        event_id: purchase.id, product_id: "pro_monthly", period_type: "NORMAL", purchased_at: 1790000000000000, expiration_at: 1792592000000000, environment: "PRODUCTION",
        presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111", affiliation: "APP_STORE",
        original_app_user_id: "$RCAnonymousID:abc", app_id: "app_ios", currency: "USD", value: 10.79, coupon: "", is_trial_conversion: false, is_renewal: false,
        items: [{ item_id: "pro_monthly", affiliation: "APP_STORE" }],
      } }],
    });
    expect((await sent("firebase", purchase, { settings: { currency: "local", reporting: "proceeds" } })).requests[0]!.json.events[0].params).toMatchObject({ currency: "EUR", value: 6.993 });
  });

  it("BigQuery: one insertAll row keyed by the event id", async () => {
    const s = await sent("bigquery", purchase);
    expect(s.requests[0]!.url).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/acme-data/datasets/revenue/tables/revenuedot_events/insertAll");
    expect(s.requests[0]!.headers.authorization).toBe("Bearer ya29.token");
    expect(s.requests[0]!.json).toEqual({
      kind: "bigquery#tableDataInsertAllRequest", skipInvalidRows: false, ignoreUnknownValues: true,
      rows: [{ insertId: purchase.id, json: {
        id: purchase.id, type: "INITIAL_PURCHASE", event_timestamp: "2026-09-21T14:13:20.000Z", app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc",
        aliases: ["$RCAnonymousID:abc", "user_42"], app_id: "app_ios", environment: "PRODUCTION", store: "APP_STORE", product_id: "pro_monthly", new_product_id: null,
        period_type: "NORMAL", purchased_at: "2026-09-21T14:13:20.000Z", expiration_at: "2026-10-21T14:13:20.000Z", entitlement_ids: ["pro"], presented_offering_id: "default",
        transaction_id: "2000000111", original_transaction_id: "2000000111", country_code: "DE", currency: "EUR", price_in_purchased_currency: 9.99, price_usd: 10.79,
        revenue_usd: 10.79, is_trial_conversion: null, cancel_reason: null, expiration_reason: null, payload: JSON.stringify(purchase),
      } }],
    });
  });

  it("AppsFlyer: S2S in-app event with eventValue as a JSON string", async () => {
    const s = await sent("appsflyer", purchase);
    expect(s.requests[0]!.url).toBe("https://api2.appsflyer.com/inappevent/id123456789");
    expect(s.requests[0]!.headers.authentication).toBe("af_dev_key");
    expect(s.requests[0]!.json).toEqual({
      appsflyer_id: "1700000000000-1234567", customer_user_id: "user_42", eventName: "rc_initial_purchase_event",
      eventValue: '{"af_revenue":"10.79","af_price":10.79,"renewal":"false","af_content_id":"pro_monthly","af_currency":"USD"}',
      eventCurrency: "USD", eventTime: "2026-09-21 14:13:20.000", af_events_api: "true", idfa: "AEBE52E7-03EE-455A-B3C4-E57283966239",
      idfv: "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11", ip: "203.0.113.7", bundleIdentifier: "com.example.scanner",
    });
    expect((await sent("appsflyer", purchase, { settings: { s2s_token: true } })).requests[0]!.url).toBe("https://api3.appsflyer.com/inappevent/id123456789");
  });

  it("Adjust: form-encoded S2S event with the step's token", async () => {
    const s = await sent("adjust", purchase);
    const r = s.requests[0]!;
    expect([r.method, r.url, r.headers["content-type"], r.headers.authorization]).toEqual(["POST", "https://s2s.adjust.com/event", "application/x-www-form-urlencoded", "Bearer adj_oauth"]);
    expect(Object.fromEntries(new URLSearchParams(r.body))).toEqual({
      s2s: "1", app_token: "ios_app_tok", event_token: "ev_ip", adid: "adid_9f8e", created_at_unix: "1790000000", environment: "production",
      idfa: "AEBE52E7-03EE-455A-B3C4-E57283966239", idfv: "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11", ip_address: "203.0.113.7", revenue: "10.79", currency: "USD",
      callback_params: '{"app_user_id":"user_42","app_id":"app_ios","product_id":"pro_monthly"}',
    });
    expect(s.name).toBe("ev_ip");
  });

  it("Meta: Conversions API app event with hashed user data and extinfo", async () => {
    const s = await sent("meta", purchase);
    expect(s.requests[0]!.url).toBe("https://graph.facebook.com/v21.0/1234567890/events");
    expect(s.requests[0]!.json).toEqual({
      access_token: "EAAB_token", partner_agent: "revenuedot",
      data: [{
        event_name: "Subscribe", event_time: 1790000000, event_id: purchase.id, action_source: "app",
        user_data: {
          external_id: ["573baabb5ca42a23f3a118d027eadd8dc9bed70e40708a1b1ed9410b00feed0e"], madid: "AEBE52E7-03EE-455A-B3C4-E57283966239", anon_id: "XZ1A2B3C",
          em: ["4be15ac83ae8c671231bdfc73fb0ee64f45e57cbbb1af848ea24cf6d0c24b65b"], ph: ["90be998a6e4b5bec4f18e14bc56a618ba6dd57100b89276067e3a77ff7140b4a"], client_ip_address: "203.0.113.7",
        },
        custom_data: { currency: "USD", value: 10.79, order_id: "2000000111", content_type: "product", content_ids: ["pro_monthly"], contents: [{ id: "pro_monthly", quantity: 1 }] },
        app_data: {
          advertiser_tracking_enabled: 1, application_tracking_enabled: 1, vendor_id: "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11",
          extinfo: ["i2", "com.example.scanner", "", "3.4.1", "18.5", "", "en_US", "", "", 0, 0, "", 0, 0, 0, ""],
        },
      }],
    });
  });
});

describe("RENEWAL, CANCELLATION, refunds and EXPIRATION", () => {
  it("revenue follows the money: renewals carry it, cancellations 0, refunds negative where the partner allows", async () => {
    const amp = async (e: WebhookEvent) => (await sent("amplitude", e)).requests[0]!.json.events[0];
    expect(await amp(renewal)).toMatchObject({ revenue: 10.79, revenueType: "renewal", event_properties: { revenue: 10.79 } });
    expect(await amp(cancellation)).not.toHaveProperty("revenue");
    expect((await amp(cancellation)).event_properties).toMatchObject({ cancel_reason: "UNSUBSCRIBE", revenue: 0 });
    expect(await amp(refund)).toMatchObject({ revenue: -10.79, revenueType: "refund", user_properties: { $set: { rc_subscription_status: "expired" } } });
    expect((await amp(expiration)).event_properties).toMatchObject({ expiration_reason: "UNSUBSCRIBE", revenue: 0 });
    const af = JSON.parse((await sent("appsflyer", refund)).requests[0]!.json.eventValue);
    expect(af).toEqual({ af_revenue: "-10.79", af_price: 10.79, renewal: "false", af_content_id: "pro_monthly", af_currency: "USD" });
    expect(JSON.parse((await sent("appsflyer", renewal)).requests[0]!.json.eventValue).renewal).toBe("true");
    const adj = new URLSearchParams((await sent("adjust", trial)).requests[0]!.body);
    expect([adj.get("event_token"), adj.get("revenue"), adj.get("currency")]).toEqual(["ev_ts", null, null]);
    expect(await skipped("adjust", refund)).toBeNull();
    expect(new URLSearchParams((await sent("adjust", refund)).requests[0]!.body).get("revenue")).toBeNull();
    expect(new URLSearchParams((await sent("adjust", renewal)).requests[0]!.body).get("revenue")).toBe("10.79");
  });
  it("proceeds reporting takes the store commission off", async () => {
    expect((await sent("amplitude", purchase, { settings: { reporting: "proceeds" } })).requests[0]!.json.events[0].revenue).toBe(7.553);
  });
  it("Slack words cancellations, refunds and expirations", async () => {
    expect((await sent("slack", cancellation)).requests[0]!.json.text).toBe("Customer user_42 cancelled their subscription: pro_monthly.");
    const r = await sent("slack", refund);
    expect(r.name).toBe("refund");
    expect(r.requests[0]!.json.text).toBe("Customer user_42 was refunded: pro_monthly (-$10.79).");
    expect(r.requests[0]!.json.attachments[0].color).toBe("#C2410C");
    expect(await skipped("slack", expiration)).toMatch(/not posted to Slack/);
    expect((await sent("slack", sandbox)).requests[0]!.json.attachments[0].fields).toContainEqual({ title: "Environment", value: "Sandbox", short: true });
  });
  it("Segment, Mixpanel and PostHog carry the step's extra fields", async () => {
    expect((await sent("segment", expiration)).requests[0]!.json.properties).toMatchObject({ expiration_reason: "UNSUBSCRIBE", revenue: 0 });
    expect((await sent("segment", conversion)).requests[0]!.json.properties.is_trial_conversion).toBe(true);
    const mp = await sent("mixpanel", cancellation);
    expect(mp.requests[0]!.json[0].properties).toMatchObject({ cancel_reason: "UNSUBSCRIBE", revenue: 0 });
    expect(mp.requests[1]!.json).toEqual([{ $token: "mp_token", $distinct_id: "user_42", $ignore_time: true, $set: { rc_subscription_status: "cancelled" } }]);
    expect((await sent("posthog", renewal)).requests[0]!.json.properties).toMatchObject({ is_trial_conversion: false, revenue: 10.79, rc_subscription_status: "active" });
  });
});

describe("identity and skip rules", () => {
  it("reserved attributes pick the partner's user id", async () => {
    const e = { ...purchase, subscriber_attributes: { ...purchase.subscriber_attributes, ...at("$amplitudeDeviceId", "dev-1"), ...at("$mixpanelDistinctId", "mp-1"), ...at("$posthogUserId", "ph-1") } };
    expect((await sent("amplitude", e)).requests[0]!.json.events[0]).toMatchObject({ device_id: "dev-1" });
    expect((await sent("amplitude", e)).requests[0]!.json.events[0]).not.toHaveProperty("user_id");
    expect((await sent("mixpanel", e)).requests[0]!.json[0].properties.distinct_id).toBe("mp-1");
    expect((await sent("posthog", e)).requests[0]!.json.distinct_id).toBe("ph-1");
    const anon = { ...purchase, app_user_id: "$RCAnonymousID:abc" };
    expect((await sent("segment", anon, { settings: { anonymous_id: true } })).requests[0]!.json).toMatchObject({ anonymousId: "$RCAnonymousID:abc" });
  });
  it("sandbox events need a sandbox key where the partner keeps sandbox apart", async () => {
    expect(await skipped("mixpanel", sandbox)).toBe("Sandbox events need a sandbox project token.");
    expect(await skipped("posthog", sandbox)).toBe("Sandbox events need a sandbox project API key.");
    expect(await skipped("appsflyer", sandbox)).toBe("Sandbox events need a sandbox developer key.");
    expect(await skipped("meta", sandbox)).toBe("Sandbox events need a sandbox dataset ID and access token.");
    expect((await sent("amplitude", sandbox)).requests[0]!.json.api_key).toBe("amp_sandbox");
    expect(new URLSearchParams((await sent("adjust", sandbox)).requests[0]!.body).get("environment")).toBe("sandbox");
  });
  it("attribution partners need their device ids", async () => {
    const bare = { ...purchase, subscriber_attributes: {} };
    expect(await skipped("appsflyer", bare)).toMatch(/\$appsflyerId/);
    expect(await skipped("adjust", bare)).toMatch(/\$adjustId/);
    expect(await skipped("meta", bare)).toMatch(/\$fbAnonId/);
    expect(await skipped("firebase", bare)).toMatch(/\$firebaseAppInstanceId/);
    expect(await skipped("adjust", { ...purchase, type: "BILLING_ISSUE" })).toMatch(/not sent to Adjust/);
    expect(await skipped("adjust", purchase, { settings: { event_tokens: {} } })).toBe("No Adjust event token is set for initial_purchase.");
    const noAtt = { ...purchase, subscriber_attributes: { ...purchase.subscriber_attributes, ...at("$attConsentStatus", "denied") } };
    expect(await skipped("meta", noAtt)).toMatch(/ATT/);
    expect((await sent("meta", noAtt, { settings: { send_without_att: true } })).requests[0]!.json.data[0].app_data.advertiser_tracking_enabled).toBe(0);
  });
  it("Android purchases go to the Android app ids and streams", async () => {
    expect((await sent("appsflyer", android)).requests[0]!.url).toBe("https://api2.appsflyer.com/inappevent/com.example.scanner");
    expect((await sent("appsflyer", android)).requests[0]!.json.advertising_id).toBe("38400000-8cf0-11bd-b23e-10b96e40000d");
    expect(new URLSearchParams((await sent("adjust", android)).requests[0]!.body).get("app_token")).toBe("and_app_tok");
    expect(new URLSearchParams((await sent("adjust", android)).requests[0]!.body).get("gps_adid")).toBe("38400000-8cf0-11bd-b23e-10b96e40000d");
    const meta = (await sent("meta", { ...android, subscriber_attributes: { ...android.subscriber_attributes } })).requests[0]!.json.data[0];
    expect(meta.user_data.madid).toBe("38400000-8cf0-11bd-b23e-10b96e40000d");
    expect(meta.app_data.extinfo[0]).toBe("a2");
  });
  it("lists the secret values to scrub from the delivery log", async () => {
    expect((await sent("amplitude", purchase)).redact).toContain("amp_key");
    expect((await sent("meta", purchase)).redact).toContain("EAAB_token");
    expect((await sent("firebase", purchase)).redact).toContain("ga_ios");
  });
});

describe("partner answers", () => {
  it("2xx with an error inside counts as a failure", () => {
    expect(responseError("mixpanel", 200, '{"status":0,"error":"token invalid"}')).toMatch(/token invalid/);
    expect(responseError("mixpanel", 200, '{"status":1,"error":null}')).toBeNull();
    expect(responseError("bigquery", 200, '{"insertErrors":[{"index":0,"errors":[{"reason":"invalid"}]}]}')).toMatch(/invalid/);
    expect(responseError("slack", 200, "ok")).toBeNull();
    expect(responseError("slack", 200, "no_service")).toMatch(/no_service/);
    expect(responseError("firebase", 204, "")).toBeNull();
    expect(responseError("amplitude", 400, '{"error":"missing api_key"}')).toMatch(/HTTP 400/);
  });
  it("only timeouts, rate limits and server errors retry", () => {
    expect([null, 408, 429, 500, 503].map(retryableStatus)).toEqual([true, true, true, true, true]);
    expect([400, 401, 403, 404].map(retryableStatus)).toEqual([false, false, false, false]);
  });
  it("every catalogue entry has a builder and documented fields", async () => {
    for (const s of INTEGRATIONS) {
      // Connections (AdMob, the help desk apps) send no events and have their own guides; Zendesk has no settings at all.
      if (s.connection) { expect(s.docs).toMatch(/^https:\/\/revenuedot\.app\/docs\/guides\/(ads|support-integrations)#/); continue; }
      expect(s.fields.length).toBeGreaterThan(0);
      expect(s.docs).toMatch(/^https:\/\/revenuedot\.app\/docs\/guides\/integrations#/);
      const p = await plan(s.kind, purchase);
      expect("skip" in p ? p.skip : p.requests.length).toBeTruthy();
    }
  });
});

describe("review fixes", () => {
  const reversed: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000099", type: "REFUND_REVERSED" };

  it("REFUND_REVERSED reaches the analytics and attribution tools with positive revenue", async () => {
    expect(conceptOf(reversed)).toBe("refund_reversed");
    for (const k of ["slack", "segment", "amplitude", "mixpanel", "posthog", "appsflyer", "bigquery"] as IntegrationKind[]) expect(sendsEvent(k, reversed), k).toBe(true);
    for (const k of ["adjust", "meta", "firebase"] as IntegrationKind[]) expect(sendsEvent(k, reversed), k).toBe(false);
    const amp = await sent("amplitude", reversed);
    expect(amp.name).toBe("rc_refund_reversed_event");
    expect(amp.requests[0]!.json.events[0]).toMatchObject({ revenue: 10.79, revenueType: "purchase" });
    expect((await sent("slack", reversed)).requests[0]!.json.text).toBe("Customer user_42 had a refund reversed: pro_monthly ($10.79).");
  });

  it("Meta sends a test event only to Events Manager's test tab", async () => {
    const test: WebhookEvent = { ...purchase, type: "TEST" };
    expect(await skipped("meta", test)).toMatch(/test event code/);
    const p = await sent("meta", test, { settings: { test_event_code: "TEST1" } });
    expect(p.requests[0]!.json).toMatchObject({ test_event_code: "TEST1", data: [{ event_name: "Subscribe" }] });
  });

  it("Firebase defaults to production events, and unknown kinds queue nothing", () => {
    expect(INTEGRATIONS.find((s) => s.kind === "firebase")!.environment).toBe("production");
    expect(sendsEvent("nope" as IntegrationKind, purchase)).toBe(false);
  });

  it("Slack keeps customer-controlled ids as text", async () => {
    const p = await sent("slack", { ...purchase, app_user_id: "<!channel>", product_id: "<https://x.example|win>" });
    expect(p.requests[0]!.json.text).toBe("Customer &lt;!channel&gt; started a subscription: &lt;https://x.example|win&gt; ($10.79).");
  });
});
