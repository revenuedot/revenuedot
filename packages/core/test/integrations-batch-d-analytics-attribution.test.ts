import { describe, expect, it } from "vitest";
import {
  CONCEPTS, INTEGRATIONS, buildIntegration, defaultEventName, partnerDef, responseError, sendsEvent, type IntegrationKind, type Plan, type WebhookEvent,
} from "../src/integrations/index.js";
import { ANALYTICS_PARTNERS } from "../src/integrations/partners-analytics.js";
import { ATTRIBUTION_PARTNERS } from "../src/integrations/partners-attribution.js";
import { WEBHOOK_ADAPTER_EVENTS } from "../src/integrations/webhook-adapter.js";

/**
 * Batch D analytics and attribution partners: the exact request for one App Store INITIAL_PURCHASE per partner, then
 * names, refunds, sandbox, Android routing, identity skips, redaction, partner answers, save checks and catalogue entries.
 * The event is the stored webhook `event` (RevenueCat's webhook shape).
 */

const at = (k: string, v: string) => ({ [k]: { value: v, updated_at_ms: 1789990000000 } });
const ID = "5E7B1C2A-1111-4222-8333-444455556666";
const IDFA = "AEBE52E7-03EE-455A-B3C4-E57283966239", IDFV = "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11", GAID = "38400000-8cf0-11bd-b23e-10b96e40000d";
const purchase: WebhookEvent = {
  id: ID, type: "INITIAL_PURCHASE", event_timestamp_ms: 1790000000000, app_id: "app_ios",
  app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", aliases: ["$RCAnonymousID:abc", "user_42"],
  product_id: "pro_monthly", period_type: "NORMAL", purchased_at_ms: 1790000000000, expiration_at_ms: 1792592000000, environment: "PRODUCTION",
  entitlement_id: null, entitlement_ids: ["pro"], presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111",
  is_family_share: false, country_code: "DE", currency: "EUR", price: 10.79, price_in_purchased_currency: 9.99,
  subscriber_attributes: {
    ...at("$email", " Wren@Example.com "), ...at("$idfa", IDFA), ...at("$idfv", IDFV), ...at("$ip", "203.0.113.7"), ...at("$attConsentStatus", "authorized"),
    ...at("$deviceVersion", "iPhone15,2 iOS 18.5"), ...at("$mparticleId", "8714512986533049"), ...at("$telemetryDeckUserId", "a1b2hash"),
    ...at("$telemetryDeckAppId", "TD-APP-1"), ...at("$kochavaDeviceId", "KO-DEVICE-1"), ...at("$airbridgeDeviceId", "ab-device-1"),
    ...at("$tenjinId", "29eeb1610fe74997b6d53f02e9711f8c"), ...at("$singularDeviceId", "sdid-1"), ...at("$appstackId", "as-1"),
    ...at("$mediaSource", "Apple Search Ads"), ...at("$appleAdsCampaignId", "542370539"), ...at("$appleAdsAdGroupId", "542317095"),
    ...at("$appleAdsKeywordId", "87675432"), ...at("$appleAdsAdId", "-1"), ...at("$claimType", "Click"), ...at("$appleAdsCountryOrRegion", "US"),
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
const android: WebhookEvent = {
  ...purchase, store: "PLAY_STORE",
  subscriber_attributes: {
    ...at("$gpsAdId", GAID), ...at("$androidId", "a1b2c3d4e5f6"), ...at("$kochavaDeviceId", "KO-ANDROID"), ...at("$airbridgeDeviceId", "ab-android"),
    ...at("$tenjinId", "tenjin-android"), ...at("$singularDeviceId", "sdid-android"), ...at("$mparticleId", "42"),
  },
};
const withAttrs = (e: WebhookEvent, drop: string[]) => ({ ...e, subscriber_attributes: Object.fromEntries(Object.entries(e.subscriber_attributes).filter(([k]) => !drop.includes(k))) });

const now = new Date("2026-09-21T14:13:21Z");
const CONFIG: Partial<Record<IntegrationKind, { settings: Record<string, any>; secrets: Record<string, string> }>> = {
  mparticle: { settings: { pod: "eu1" }, secrets: { api_key: "us1-mpkey", api_secret: "mp_secret_value" } },
  statsig: { settings: {}, secrets: { server_secret: "secret-statsig123" } },
  superwall: { settings: {}, secrets: { webhook_url: "https://superwall.example/api/integrations/revenuecat?pk=sk_live_9", authorization: "Bearer sw_token" } },
  telemetrydeck: { settings: {}, secrets: {} },
  appstack: { settings: { webhook_url: "https://api.event.appstack.tech/revenuecat/webhook/app_1" }, secrets: { authorization: "appstack-token" } },
  asapty: { settings: { asapty_id: "asapty_123" }, secrets: {} },
  branch: { settings: {}, secrets: { branch_key: "key_live_abc", sandbox_branch_key: "key_test_abc" } },
  google_tag_manager: { settings: { server_container_url: "https://sgtm.example.com/", measurement_id: "G-ABC123" }, secrets: { api_secret: "gtm_secret+/=" } },
  kochava: { settings: { ios_app_guid: "koapp-ios", android_app_guid: "koapp-android" }, secrets: {} },
  airbridge: { settings: { app_name: "testapp" }, secrets: { api_token: "ab_token" } },
  splitmetrics: { settings: {}, secrets: { webhook_url: "https://acquire.example/rc/client_77" } },
  singular: { settings: {}, secrets: { sdk_key: "sing_key", sandbox_sdk_key: "sing_sandbox" } },
  solarengine: { settings: {}, secrets: { webhook_url: "https://se.example/rc?appkey=se_key_1", authorization: "se-auth" } },
  tenjin: { settings: {}, secrets: { ios_sdk_key: "tj_ios_key", android_sdk_key: "tj_android_key" } },
};
const KINDS = Object.keys(CONFIG) as IntegrationKind[];

type Over = { settings?: Record<string, any>; secrets?: Record<string, string>; eventNames?: Record<string, string>; context?: Record<string, unknown> };
async function plan(kind: IntegrationKind, event: WebhookEvent, over: Over = {}): Promise<Plan> {
  const c = CONFIG[kind]!;
  return buildIntegration(kind, {
    event, settings: { ...c.settings, ...over.settings }, secrets: { ...c.secrets, ...over.secrets }, eventNames: over.eventNames, now,
    context: { projectId: "proj1", bundleId: "com.example.scanner", appVersion: "3.4.1", platformVersion: "18.5", locale: "en_US", ...over.context },
  });
}
const parse = (r: { method: string; url: string; headers: Record<string, string>; body: string }) => {
  const ct = r.headers["content-type"] ?? "";
  if (ct.startsWith("application/json")) return JSON.parse(r.body);
  if (ct === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(r.body));
  return Object.fromEntries(new URL(r.url).searchParams);
};
async function sent(kind: IntegrationKind, event: WebhookEvent, over?: Over) {
  const p = await plan(kind, event, over);
  if ("skip" in p) throw new Error(`${kind} skipped: ${p.skip}`);
  return { name: p.name, requests: p.requests.map((r) => ({ ...r, data: parse(r) })), redact: p.redact, req: p.requests[0]!, data: parse(p.requests[0]!) };
}
async function skipped(kind: IntegrationKind, event: WebhookEvent, over?: Over) {
  const p = await plan(kind, event, over);
  return "skip" in p ? p.skip : null;
}

describe("Batch D catalogue", () => {
  it("registers every partner in INTEGRATIONS with a well-formed spec", () => {
    const partners = [...ANALYTICS_PARTNERS, ...ATTRIBUTION_PARTNERS];
    expect(ANALYTICS_PARTNERS.map((p) => p.spec.kind)).toEqual(["mparticle", "statsig", "superwall", "telemetrydeck"]);
    expect(ATTRIBUTION_PARTNERS.map((p) => p.spec.kind).sort()).toEqual(["airbridge", "appstack", "asapty", "branch", "google_tag_manager", "kochava", "singular", "solarengine", "splitmetrics", "tenjin"]);
    for (const p of partners) {
      const s = p.spec;
      expect(INTEGRATIONS.filter((x) => x.kind === s.kind)).toHaveLength(1);
      expect(partnerDef(s.kind)).toBe(p);
      expect(s.category).toBe(ANALYTICS_PARTNERS.includes(p) ? "analytics" : "attribution");
      expect(s.docs).toBe(`https://revenuedot.app/docs/guides/integrations#${s.kind}`);
      expect(["documented", "webhook"]).toContain(s.api);
      expect(s.text).toMatch(/^[A-Z].+\.$/);
      expect(new Set(s.fields.map((f) => f.key)).size).toBe(s.fields.length);
      for (const f of s.fields) {
        expect(f.label).toBeTruthy();
        if (f.type === "select") expect(f.options!.length).toBeGreaterThan(1);
        else expect(f.options).toBeUndefined();
      }
      if (s.eventNames) expect(p.defaultName).toBeTypeOf("function");
      if (p.events !== "all") for (const c of p.events) expect(CONCEPTS).toContain(c);
      // Revenue-sending partners offer the sales reporting choice; the webhook adapter forwards the event as stored.
      expect(s.fields.some((f) => f.key === "reporting")).toBe(s.api === "documented");
      if (s.api === "webhook") {
        expect(s.fields.find((f) => f.key === "webhook_url")).toMatchObject({ required: true, url: true });
        expect(p.events).toEqual(WEBHOOK_ADAPTER_EVENTS);
      }
    }
    expect(INTEGRATIONS.find((s) => s.kind === "google_tag_manager")!.fields.find((f) => f.key === "server_container_url")).toMatchObject({ url: true, required: true });
    expect(WEBHOOK_ADAPTER_EVENTS).toEqual(CONCEPTS.filter((c) => c !== "experiment_enrollment"));
  });

  it("queues only the steps each partner sends", () => {
    expect(sendsEvent("superwall", { type: "EXPERIMENT_ENROLLMENT" })).toBe(false);
    expect(sendsEvent("appstack", { type: "TRANSFER" })).toBe(true);
    expect(sendsEvent("appstack", { type: "SUBSCRIPTION_EXTENDED" })).toBe(false);
    expect(sendsEvent("asapty", { type: "TEST" })).toBe(false);
    expect(sendsEvent("asapty", renewal)).toBe(true);
    expect(sendsEvent("airbridge", { type: "TRANSFER" })).toBe(false);
    expect(sendsEvent("statsig", { type: "TRANSFER" })).toBe(true);
    expect(sendsEvent("tenjin", { type: "UNCANCELLATION" })).toBe(false);
    expect(sendsEvent("branch", { type: "BILLING_ISSUE" })).toBe(false);
    expect(sendsEvent("kochava", { type: "BILLING_ISSUE" })).toBe(true);
    expect(sendsEvent("google_tag_manager", { type: "PURCHASE_REDEEMED" })).toBe(true);
  });

  it("names each step for the dashboard", () => {
    expect(defaultEventName("mparticle", "non_subscription_purchase")).toBe("non_renewing_purchase");
    expect(defaultEventName("statsig", "renewal")).toBe("rc_renewal_event");
    expect(defaultEventName("asapty", "non_subscription_purchase")).toBe("non_renewing_purchase_event");
    expect(defaultEventName("branch", "trial_started")).toBe("START_TRIAL");
    expect(defaultEventName("airbridge", "cancellation")).toBe("airbridge.unsubscribe");
    expect(defaultEventName("tenjin", "renewal")).toBeNull();
    expect(defaultEventName("tenjin", "expiration")).toBe("rc_expiration_event");
    expect(defaultEventName("superwall", "renewal")).toBeNull();
    expect(defaultEventName("google_tag_manager", "renewal")).toBe("purchase");
  });
});

describe("INITIAL_PURCHASE, exact requests", () => {
  it("mParticle: one batch to the pod's Events API, money as a commerce event", async () => {
    const s = await sent("mparticle", purchase);
    expect(s.name).toBe("initial_purchase");
    expect(s.requests).toHaveLength(1);
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://s2s.eu1.mparticle.com/v2/events", { "content-type": "application/json", authorization: `Basic ${btoa("us1-mpkey:mp_secret_value")}` }]);
    expect(s.data).toEqual({
      events: [{
        event_type: "commerce_event",
        data: {
          timestamp_unixtime_ms: 1790000000000, source_message_id: ID,
          custom_attributes: {
            revenuecat_event: "initial_purchase", revenuecat_event_type: "INITIAL_PURCHASE", revenuecat_product_id: "pro_monthly", app_user_id: "user_42",
            original_app_user_id: "$RCAnonymousID:abc", aliases: "$RCAnonymousID:abc,user_42", store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL",
            entitlement_ids: "pro", presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111", country_code: "DE",
            purchased_currency: "EUR", price_in_purchased_currency: "9.99",
          },
          currency_code: "USD",
          product_action: {
            action: "purchase", transaction_id: "2000000111", total_amount: 10.79,
            products: [{ id: "pro_monthly", name: "pro_monthly", price: 10.79, quantity: 1, total_product_amount: 10.79 }],
          },
        },
      }],
      environment: "production", schema_version: 2, source_request_id: ID, mpid: 8714512986533049,
      user_identities: { customer_id: "user_42", email: "Wren@Example.com" }, user_attributes: { rc_subscription_status: "active" },
      device_info: { ios_advertising_id: IDFA, ios_idfv: IDFV, att_authorization_status: "authorized" }, ip: "203.0.113.7",
    });
  });

  it("Statsig: one event to log_event with the server secret header", async () => {
    const s = await sent("statsig", purchase);
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://events.statsigapi.net/v1/log_event", { "content-type": "application/json", "statsig-api-key": "secret-statsig123" }]);
    expect(s.data).toEqual({
      events: [{
        eventName: "rc_initial_purchase_event", time: 1790000000000, value: 10.79,
        user: { userID: "user_42", email: "Wren@Example.com", ip: "203.0.113.7", country: "DE", statsigEnvironment: { tier: "production" } },
        metadata: {
          event_id: ID, event_type: "INITIAL_PURCHASE", product_id: "pro_monthly", store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL",
          entitlement_ids: "pro", presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111",
          original_app_user_id: "$RCAnonymousID:abc", app_id: "app_ios", currency: "USD", purchased_currency: "EUR", price_in_purchased_currency: "9.99",
        },
      }],
    });
  });

  it("Superwall: RevenueCat's webhook body to the saved URL with the Authorization value", async () => {
    const s = await sent("superwall", purchase);
    expect(s.name).toBe("INITIAL_PURCHASE");
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://superwall.example/api/integrations/revenuecat?pk=sk_live_9", { "content-type": "application/json", authorization: "Bearer sw_token" }]);
    expect(s.data).toEqual({ api_version: "1.0", event: purchase });
  });

  it("TelemetryDeck: one signal with the hashed user and RevenueCat payload keys", async () => {
    const s = await sent("telemetrydeck", purchase);
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://nom.telemetrydeck.com/v2/", { "content-type": "application/json; charset=utf-8" }]);
    expect(s.data).toEqual([{
      appID: "TD-APP-1", clientUser: "a1b2hash", type: "rc_initial_purchase_event", isTestMode: false, floatValue: 10.79,
      payload: {
        "RevenueCat.event.id": ID, "RevenueCat.event.type": "INITIAL_PURCHASE", "RevenueCat.event.app_user_id": "user_42",
        "RevenueCat.event.original_app_user_id": "$RCAnonymousID:abc", "RevenueCat.event.product_id": "pro_monthly", "RevenueCat.event.store": "APP_STORE",
        "RevenueCat.event.environment": "PRODUCTION", "RevenueCat.event.period_type": "NORMAL", "RevenueCat.event.entitlement_ids": "pro",
        "RevenueCat.event.presented_offering_id": "default", "RevenueCat.event.transaction_id": "2000000111", "RevenueCat.event.original_transaction_id": "2000000111",
        "RevenueCat.event.country_code": "DE", "RevenueCat.event.currency": "EUR", "RevenueCat.event.price": 10.79, "RevenueCat.event.price_in_purchased_currency": 9.99,
        "RevenueCat.event.commission_percentage": 0.3, "RevenueCat.event.tax_percentage": 0, "RevenueCat.event.takehome_percentage": 0.7,
      },
    }]);
  });

  it("Appstack: RevenueCat's webhook body to the Appstack URL with its Authorization header", async () => {
    const s = await sent("appstack", purchase);
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://api.event.appstack.tech/revenuecat/webhook/app_1", { "content-type": "application/json", authorization: "appstack-token" }]);
    expect(s.data).toEqual({ api_version: "1.0", event: purchase });
    expect(s.data.event.subscriber_attributes.$appstackId.value).toBe("as-1");
  });

  it("Asapty: a GET with the Apple Search Ads ids and a json parameter", async () => {
    const s = await sent("asapty", purchase);
    expect(s.name).toBe("initial_purchase_event");
    expect([s.req.method, s.req.url.split("?")[0], s.req.headers, s.req.body]).toEqual(["GET", "https://asapty.com/_api/mmpEvents/", {}, ""]);
    const { json: payload, ...q } = s.data;
    expect(q).toEqual({
      source: "revenuedot", asaptyid: "asapty_123", event_name: "initial_purchase_event", conversiondate: "1790000000000",
      campaignid: "542370539", adgroupid: "542317095", keywordid: "87675432", claim_type: "Click",
    });
    expect(JSON.parse(payload)).toEqual({
      revenue: "10.79", af_currency: "USD", transaction_id: "2000000111", original_transaction_id: "2000000111", purchase_date: 1790000000000,
      environment: "PRODUCTION", vendor_product_id: "pro_monthly", store_country: "DE", profile_country: "US",
    });
  });

  it("Branch: a SUBSCRIBE standard event with revenue and the product", async () => {
    const s = await sent("branch", purchase);
    expect(s.name).toBe("SUBSCRIBE");
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://api2.branch.io/v2/event/standard", { "content-type": "application/json", accept: "application/json" }]);
    expect(s.data).toEqual({
      name: "SUBSCRIBE", branch_key: "key_live_abc",
      user_data: {
        os: "iOS", idfa: IDFA, idfv: IDFV, limit_ad_tracking: false, developer_identity: "user_42", environment: "FULL_APP", ip: "203.0.113.7",
        os_version: "18.5", app_version: "3.4.1", country: "DE",
      },
      custom_data: {
        event_id: ID, event_type: "INITIAL_PURCHASE", app_user_id: "user_42", product_id: "pro_monthly", store: "APP_STORE", environment: "PRODUCTION",
        period_type: "NORMAL", transaction_id: "2000000111", original_transaction_id: "2000000111",
      },
      event_data: { transaction_id: "2000000111", currency: "USD", revenue: 10.79, description: "pro_monthly" },
      content_items: [{ $content_schema: "COMMERCE_PRODUCT", $canonical_identifier: "pro_monthly", $sku: "pro_monthly", $product_name: "pro_monthly", $price: 10.79, $quantity: 1, $currency: "USD" }],
    });
  });

  it("Google Tag Manager: a GA4 purchase to the server container's /mp/collect", async () => {
    const s = await sent("google_tag_manager", purchase);
    expect(s.name).toBe("purchase");
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://sgtm.example.com/mp/collect?measurement_id=G-ABC123&api_secret=gtm_secret%2B%2F%3D", { "content-type": "application/json" }]);
    expect(s.data).toEqual({
      client_id: "user_42", user_id: "user_42", timestamp_micros: 1790000000000000,
      events: [{
        name: "purchase",
        params: {
          event_id: ID, event_type: "INITIAL_PURCHASE", product_id: "pro_monthly", period_type: "NORMAL", environment: "PRODUCTION", store: "APP_STORE",
          transaction_id: "2000000111", original_transaction_id: "2000000111", original_app_user_id: "$RCAnonymousID:abc", app_id: "app_ios",
          currency: "USD", value: 10.79, is_renewal: false, is_trial_conversion: false,
          items: [{ item_id: "pro_monthly", item_name: "pro_monthly", affiliation: "APP_STORE", price: 10.79, quantity: 1 }],
        },
      }],
    });
  });

  it("Kochava: a post-install event with the app GUID, device ids and the sum", async () => {
    const s = await sent("kochava", purchase);
    expect(s.name).toBe("Subscribe");
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://control.kochava.com/track/json", { "content-type": "application/json" }]);
    expect(s.data).toEqual({
      action: "event", kochava_app_id: "koapp-ios", kochava_device_id: "KO-DEVICE-1",
      data: {
        event_name: "Subscribe", device_ids: { idfa: IDFA, idfv: IDFV }, origination_ip: "203.0.113.7", device_ua: "", device_ver: "iPhone15,2 iOS 18.5",
        app_version: "3.4.1", usertime: 1790000000, currency: "USD",
        event_data: {
          name: "pro_monthly", product_id: "pro_monthly", event_id: ID, event_type: "INITIAL_PURCHASE", app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc",
          store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL", transaction_id: "2000000111", original_transaction_id: "2000000111", sum: 10.79,
        },
      },
    });
  });

  it("Airbridge: an airbridge.subscribe event with the Bearer token and client IP", async () => {
    const s = await sent("airbridge", purchase);
    expect(s.name).toBe("airbridge.subscribe");
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://api.airbridge.io/events/v2/apps/testapp/mobile-app/9360", { "content-type": "application/json", authorization: "Bearer ab_token", "x-forwarded-for": "203.0.113.7" }]);
    expect(s.data).toEqual({
      eventUUID: ID.toLowerCase(), eventTimestamp: 1790000000000,
      user: { externalUserID: "user_42", externalUserEmail: "Wren@Example.com" },
      device: { osName: "iOS", osVersion: "18.5", deviceUUID: "ab-device-1", ifa: IDFA, ifv: IDFV, appTrackingTransparency: 3 },
      app: { packageName: "com.example.scanner", version: "3.4.1" },
      eventData: {
        goal: {
          category: "airbridge.subscribe", value: 10.79,
          semanticAttributes: { currency: "USD", transactionID: "2000000111", isRenewal: false, totalValue: 10.79, products: [{ productID: "pro_monthly", name: "pro_monthly", price: 10.79, currency: "USD", quantity: 1 }] },
          customAttributes: { event_id: ID, event_type: "INITIAL_PURCHASE", product_id: "pro_monthly", store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL", original_transaction_id: "2000000111" },
        },
      },
    });
  });

  it("SplitMetrics Acquire: RevenueCat's webhook body to the saved URL, no Authorization when none is saved", async () => {
    const s = await sent("splitmetrics", purchase);
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://acquire.example/rc/client_77", { "content-type": "application/json" }]);
    expect(s.data).toEqual({ api_version: "1.0", event: purchase });
  });

  it("Singular: a V2 form POST matched on the Singular device id", async () => {
    const s = await sent("singular", purchase);
    expect(s.name).toBe("rc_initial_purchase_event");
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://s2s.singular.net/api/v2/evt", { "content-type": "application/x-www-form-urlencoded" }]);
    const { e: args, ...form } = s.data;
    expect(form).toEqual({
      a: "sing_key", n: "rc_initial_purchase_event", sdid: "sdid-1", p: "iOS", i: "com.example.scanner", amt: "10.79", cur: "USD", umilisec: "1790000000000",
      purchase_product_id: "pro_monthly", purchase_transaction_id: "2000000111", ip: "203.0.113.7", custom_user_id: "user_42", att_authorization_status: "3",
    });
    expect(JSON.parse(args)).toEqual({ rc_app_user_id: "user_42", rc_event_id: ID, pn: "", pq: 1, pp: 10.79, pk: "pro_monthly" });
  });

  it("SolarEngine: RevenueCat's webhook body to the saved URL", async () => {
    const s = await sent("solarengine", purchase);
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://se.example/rc?appkey=se_key_1", { "content-type": "application/json", authorization: "se-auth" }]);
    expect(s.data).toEqual({ api_version: "1.0", event: purchase });
  });

  it("Tenjin: a purchase with Basic auth and the analytics installation id", async () => {
    const s = await sent("tenjin", purchase);
    expect(s.name).toBe("purchase");
    expect([s.req.method, s.req.url, s.req.headers]).toEqual(["POST", "https://track.tenjin.com/v0/purchase", { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa("tj_ios_key:")}` }]);
    expect(s.data).toEqual({
      bundle_id: "com.example.scanner", platform: "ios", os_version: "18.5", sdk_version: "server", analytics_installation_id: "29eeb1610fe74997b6d53f02e9711f8c",
      advertising_id: IDFA, developer_device_id: IDFV, tracking_status: "3", limit_ad_tracking: "0", app_version: "3.4.1", ip_address: "203.0.113.7",
      country: "DE", customer_user_id: "user_42", product_id: "pro_monthly", price: "10.79", quantity: "1", currency: "USD",
    });
  });
});

describe("event names for trial starts and renewals", () => {
  const cases: [IntegrationKind, string, string][] = [
    ["mparticle", "trial_started", "renewal"], ["statsig", "rc_trial_started_event", "rc_renewal_event"], ["telemetrydeck", "rc_trial_started_event", "rc_renewal_event"],
    ["superwall", "INITIAL_PURCHASE", "RENEWAL"], ["appstack", "INITIAL_PURCHASE", "RENEWAL"], ["asapty", "trial_started_event", "renewal_event"],
    ["branch", "START_TRIAL", "SUBSCRIBE"], ["google_tag_manager", "rc_trial_started_event", "purchase"], ["kochava", "Start Trial", "Subscribe"],
    ["airbridge", "airbridge.startTrial", "airbridge.subscribe"], ["splitmetrics", "INITIAL_PURCHASE", "RENEWAL"], ["singular", "rc_trial_started_event", "rc_renewal_event"],
    ["solarengine", "INITIAL_PURCHASE", "RENEWAL"], ["tenjin", "rc_trial_started_event", "purchase"],
  ];
  for (const [kind, t, r] of cases) {
    it(kind, async () => {
      expect((await sent(kind, trial)).name).toBe(t);
      expect((await sent(kind, renewal)).name).toBe(r);
    });
  }

  it("overrides apply, and an override outside Branch's standard names goes to /custom", async () => {
    expect((await sent("statsig", trial, { eventNames: { trial_started: "Trial" } })).data.events[0].eventName).toBe("Trial");
    expect((await sent("mparticle", cancellation, { eventNames: { cancellation: "Cancelled" } })).data.events[0].data.event_name).toBe("Cancelled");
    expect((await sent("asapty", renewal, { eventNames: { renewal: "rebill" } })).data.event_name).toBe("rebill");
    const b = await sent("branch", purchase, { eventNames: { initial_purchase: "Paid" } });
    expect(b.req.url).toBe("https://api2.branch.io/v2/event/custom");
    expect(b.data.content_items).toBeUndefined();
    expect(b.data.event_data.revenue).toBe(10.79);
    expect((await sent("tenjin", purchase, { eventNames: { initial_purchase: "ignored" } })).name).toBe("purchase");
    expect((await sent("tenjin", trial, { eventNames: { trial_started: "trial" } })).data.event).toBe("trial");
  });

  it("each partner's details for trials and renewals", async () => {
    const mp = (await sent("mparticle", trial)).data.events[0];
    expect(mp).toMatchObject({ event_type: "custom_event", data: { event_name: "trial_started", custom_event_type: "transaction" } });
    expect((await sent("statsig", trial)).data.events[0].value).toBeUndefined();
    expect((await sent("telemetrydeck", trial)).data[0].floatValue).toBeUndefined();
    expect((await sent("branch", trial)).data.event_data).toBeUndefined();
    expect((await sent("airbridge", renewal)).data.eventData.goal.semanticAttributes.isRenewal).toBe(true);
    expect((await sent("google_tag_manager", conversion)).data.events[0].params).toMatchObject({ is_renewal: false, is_trial_conversion: true, value: 10.79 });
    expect((await sent("tenjin", trial)).req.url).toBe("https://track.tenjin.com/v0/event");
    expect((await sent("tenjin", conversion)).req.url).toBe("https://track.tenjin.com/v0/purchase");
    expect(JSON.parse((await sent("asapty", trial)).data.json).revenue).toBe("0.00");
    expect((await sent("kochava", trial)).data.data.event_data.sum).toBeUndefined();
    expect((await sent("singular", trial)).data.amt).toBeUndefined();
  });
});

describe("refunds", () => {
  it("negative revenue where the partner accepts it", async () => {
    expect((await sent("statsig", refund)).data.events[0].value).toBe(-10.79);
    expect((await sent("telemetrydeck", refund)).data[0].floatValue).toBe(-10.79);
    expect((await sent("kochava", refund)).data.data.event_data.sum).toBe(-10.79);
    const sing = await sent("singular", refund);
    expect([sing.data.amt, sing.data.cur, JSON.parse(sing.data.e).pp]).toEqual(["-10.79", "USD", -10.79]);
  });
  it("mParticle: a refund product action with the amount refunded", async () => {
    const mp = (await sent("mparticle", refund)).data.events[0];
    expect(mp.event_type).toBe("commerce_event");
    expect(mp.data.product_action).toMatchObject({ action: "refund", total_amount: 10.79 });
    expect(mp.data.custom_attributes).toMatchObject({ revenuecat_event: "cancellation", cancel_reason: "CUSTOMER_SUPPORT" });
  });
  it("no money where the partner takes no negative values", async () => {
    const b = await sent("branch", refund);
    expect([b.name, b.req.url, b.data.event_data, b.data.custom_data.cancel_reason]).toEqual(["rc_cancellation_event", "https://api2.branch.io/v2/event/custom", undefined, "CUSTOMER_SUPPORT"]);
    const ab = (await sent("airbridge", refund)).data.eventData.goal;
    expect([ab.category, ab.value, ab.semanticAttributes.totalValue]).toEqual(["airbridge.unsubscribe", undefined, undefined]);
    const t = await sent("tenjin", refund);
    expect([t.req.url, t.data.event, t.data.price]).toEqual(["https://track.tenjin.com/v0/event", "rc_cancellation_event", undefined]);
    expect(JSON.parse((await sent("asapty", refund)).data.json).revenue).toBe("0.00");
    const g = (await sent("google_tag_manager", refund)).data.events[0];
    expect([g.name, g.params.value, g.params.cancel_reason]).toEqual(["rc_cancellation_event", undefined, "CUSTOMER_SUPPORT"]);
  });
  it("the webhook adapter forwards the refund as stored", async () => {
    expect((await sent("appstack", refund)).data.event.price).toBe(-10.79);
  });
  it("expirations carry their reason", async () => {
    expect((await sent("statsig", expiration)).data.events[0].metadata.expiration_reason).toBe("UNSUBSCRIBE");
    expect((await sent("kochava", expiration)).data.data.event_data.expiration_reason).toBe("UNSUBSCRIBE");
  });
});

describe("sandbox", () => {
  it("sends with the partner's test flag", async () => {
    expect((await sent("mparticle", sandbox)).data.environment).toBe("development");
    expect((await sent("statsig", sandbox)).data.events[0].user.statsigEnvironment).toEqual({ tier: "development" });
    expect((await sent("telemetrydeck", sandbox)).data[0].isTestMode).toBe(true);
    expect((await sent("superwall", sandbox)).data.event.environment).toBe("SANDBOX");
  });
  it("uses the sandbox key or project, else skips", async () => {
    expect((await sent("branch", sandbox)).data.branch_key).toBe("key_test_abc");
    expect(await skipped("branch", sandbox, { secrets: { sandbox_branch_key: "" } })).toBe("Sandbox events need a sandbox Branch key (key_test_…).");
    expect((await sent("singular", sandbox)).data.a).toBe("sing_sandbox");
    expect(await skipped("singular", sandbox, { secrets: { sandbox_sdk_key: "" } })).toBe("Sandbox events need a sandbox Singular SDK key.");
    expect(await skipped("kochava", sandbox)).toBe("Sandbox events need a Kochava test app GUID for iOS.");
    expect((await sent("kochava", sandbox, { settings: { sandbox_ios_app_guid: "koapp-ios-test" } })).data.kochava_app_id).toBe("koapp-ios-test");
    expect(await skipped("airbridge", sandbox)).toBe("Sandbox events need a sandbox Airbridge app name.");
    const ab = await sent("airbridge", sandbox, { settings: { sandbox_app_name: "testapp-dev" } });
    expect([ab.req.url, ab.req.headers.authorization]).toEqual(["https://api.airbridge.io/events/v2/apps/testapp-dev/mobile-app/9360", "Bearer ab_token"]);
    expect((await sent("airbridge", sandbox, { settings: { sandbox_app_name: "testapp-dev" }, secrets: { sandbox_api_token: "ab_dev" } })).req.headers.authorization).toBe("Bearer ab_dev");
    expect(await skipped("google_tag_manager", sandbox)).toBe("Sandbox events need a sandbox measurement ID.");
    const g = await sent("google_tag_manager", sandbox, { settings: { sandbox_measurement_id: "G-DEV1" } });
    expect(g.req.url).toBe("https://sgtm.example.com/mp/collect?measurement_id=G-DEV1");
    expect(g.redact).toEqual([]);
  });
  it("skips where the partner takes production only", async () => {
    expect(await skipped("asapty", sandbox)).toBe("Asapty takes production events only, so sandbox events are not sent.");
    expect(await skipped("tenjin", sandbox)).toBe("Tenjin keeps no sandbox data apart, so sandbox events are not sent.");
  });
});

describe("Android routing", () => {
  it("uses the Android ids, keys and app ids", async () => {
    expect((await sent("mparticle", android)).data).toMatchObject({ mpid: 42, device_info: { android_advertising_id: GAID } });
    const b = (await sent("branch", android)).data.user_data;
    expect([b.os, b.aaid, b.android_id, b.idfa, b.limit_ad_tracking]).toEqual(["Android", GAID, "a1b2c3d4e5f6", undefined, undefined]);
    const k = (await sent("kochava", android)).data;
    expect([k.kochava_app_id, k.kochava_device_id, k.data.device_ids]).toEqual(["koapp-android", "KO-ANDROID", { adid: GAID, android_id: "a1b2c3d4e5f6" }]);
    const ab = (await sent("airbridge", android)).data.device;
    expect(ab).toEqual({ osName: "Android", osVersion: "18.5", deviceUUID: "ab-android", gaid: GAID });
    const s = (await sent("singular", android)).data;
    expect([s.p, s.sdid, s.att_authorization_status]).toEqual(["Android", "sdid-android", undefined]);
    expect((await sent("singular", { ...android, store: "AMAZON" })).data.p).toBe("Android");
    const t = await sent("tenjin", android);
    expect([t.req.headers.authorization, t.data.platform, t.data.advertising_id, t.data.developer_device_id, t.data.analytics_installation_id])
      .toEqual([`Basic ${btoa("tj_android_key:")}`, "android", GAID, undefined, "tenjin-android"]);
    expect((await sent("tenjin", { ...android, store: "AMAZON" })).data.platform).toBe("amazon");
  });
  it("skips stores the partner has no app for", async () => {
    const web = { ...purchase, store: "STRIPE" };
    expect(await skipped("branch", web)).toBe("STRIPE purchases are not sent to Branch's app events.");
    expect(await skipped("kochava", web)).toBe("STRIPE purchases are not sent to Kochava.");
    expect(await skipped("airbridge", web)).toBe("STRIPE purchases are not sent to Airbridge's app events.");
    expect(await skipped("singular", web)).toBe("STRIPE purchases are not sent to Singular's app events.");
    expect(await skipped("tenjin", web)).toBe("STRIPE purchases are not sent to Tenjin.");
    expect(await skipped("kochava", android, { settings: { android_app_guid: "" } })).toBe("No Kochava app GUID is saved for Android.");
    expect(await skipped("tenjin", android, { secrets: { android_sdk_key: "" } })).toBe("No Tenjin SDK key is saved for Android.");
  });
});

describe("identity", () => {
  it("skips attribution events without the partner's id, naming the attribute", async () => {
    expect(await skipped("kochava", withAttrs(purchase, ["$kochavaDeviceId"]))).toBe("The customer has no $kochavaDeviceId attribute, so Kochava cannot match the event.");
    expect(await skipped("kochava", withAttrs(purchase, ["$idfa", "$idfv"]))).toBe("The customer has no $idfa or $idfv attribute, which Kochava needs with the device id.");
    expect(await skipped("singular", withAttrs(purchase, ["$singularDeviceId"]))).toBe("The customer has no $singularDeviceId attribute, so Singular cannot match the event.");
    expect(await skipped("tenjin", withAttrs(purchase, ["$tenjinId"]))).toBe("The customer has no $tenjinId attribute (the Tenjin SDK's analytics installation id), so Tenjin cannot attribute the event.");
    expect(await skipped("asapty", withAttrs(purchase, ["$appleAdsCampaignId"]))).toBe("The customer has no Apple Search Ads attribution ($appleAdsCampaignId), so Asapty cannot attribute the event.");
    expect(await skipped("branch", withAttrs(purchase, ["$idfa", "$idfv"]))).toBe("The customer has no $idfa or $idfv attribute, so Branch cannot match the event.");
    expect(await skipped("branch", withAttrs(android, ["$gpsAdId", "$androidId"]))).toBe("The customer has no $gpsAdId or $androidId attribute, so Branch cannot match the event.");
    expect(await skipped("telemetrydeck", withAttrs(purchase, ["$telemetryDeckUserId"]))).toMatch(/^The customer has no \$telemetryDeckUserId attribute/);
  });
  it("uses the partner's fallbacks", async () => {
    // Singular V1 matches on advertising ids instead of the device id.
    const v1 = await sent("singular", withAttrs(purchase, ["$singularDeviceId"]), { settings: { api_version: "v1" } });
    expect([v1.req.method, v1.req.url.split("?")[0], v1.req.body, v1.data.idfa, v1.data.idfv, v1.data.sdid, v1.data.a]).toEqual(["GET", "https://s2s.singular.net/api/v1/evt", "", IDFA, IDFV, undefined, "sing_key"]);
    expect(await skipped("singular", withAttrs(purchase, ["$idfv"]), { settings: { api_version: "v1" } })).toBe("Singular's V1 endpoint needs both $idfa and $idfv on iOS; the customer is missing one.");
    expect((await sent("singular", android, { settings: { api_version: "v1" } })).data).toMatchObject({ aifa: GAID, andi: "a1b2c3d4e5f6" });
    // Anonymous ids are not sent as Singular's or Tenjin's custom user id; the IP falls back to the country.
    const anon = { ...withAttrs(purchase, ["$ip"]), app_user_id: "$RCAnonymousID:abc" };
    expect([(await sent("singular", anon)).data.custom_user_id, (await sent("singular", anon)).data.country]).toEqual([undefined, "DE"]);
    expect((await sent("tenjin", anon)).data.customer_user_id).toBeUndefined();
    // Tenjin sends zeros for an unknown advertising id.
    expect((await sent("tenjin", withAttrs(purchase, ["$idfa"]))).data.advertising_id).toBe("00000000-0000-0000-0000-000000000000");
    // Branch prefers $branchId; Airbridge matches on the user id when the device id cannot be sent.
    expect((await sent("branch", { ...purchase, subscriber_attributes: { ...purchase.subscriber_attributes, ...at("$branchId", "branch-user") } })).data.user_data.developer_identity).toBe("branch-user");
    const ab = (await sent("airbridge", withAttrs(purchase, ["$airbridgeDeviceId"]))).data;
    expect([ab.user.externalUserID, ab.device.deviceUUID]).toEqual(["user_42", undefined]);
    expect((await sent("airbridge", purchase, { context: { platformVersion: null } })).data.device).toEqual({ osName: "iOS", ifa: IDFA, ifv: IDFV, appTrackingTransparency: 3 });
    // mParticle: no $mparticleId, still sent with customer_id; a 64-bit mpid is written as digits.
    expect((await sent("mparticle", withAttrs(purchase, ["$mparticleId"]))).data.mpid).toBeUndefined();
    const big = await sent("mparticle", { ...purchase, subscriber_attributes: { ...purchase.subscriber_attributes, ...at("$mparticleId", "-8714512986533049123") } });
    expect(big.req.body).toContain(`"mpid":-8714512986533049123,`);
    expect((await sent("mparticle", { ...purchase, subscriber_attributes: { ...purchase.subscriber_attributes, ...at("$mparticleId", "not-a-number") } })).data.mpid).toBeUndefined();
    // TelemetryDeck: the saved app ID when the attribute is missing; a namespace changes the URL.
    const td = await sent("telemetrydeck", withAttrs(purchase, ["$telemetryDeckAppId"]), { settings: { app_id: "SAVED-APP", namespace: "acme" } });
    expect([td.req.url, td.data[0].appID]).toEqual(["https://nom.telemetrydeck.com/v2/namespace/acme/", "SAVED-APP"]);
    expect(await skipped("telemetrydeck", withAttrs(purchase, ["$telemetryDeckAppId"]))).toBe("No TelemetryDeck app ID: set the $telemetryDeckAppId attribute in the app or save an app ID.");
    // Asapty leaves out Apple's -1 placeholder ids.
    expect((await sent("asapty", purchase)).data.ad_id).toBeUndefined();
    expect((await sent("asapty", { ...purchase, subscriber_attributes: { ...purchase.subscriber_attributes, ...at("$appleAdsAdId", "542317136") } })).data.ad_id).toBe("542317136");
  });
  it("needs the app's bundle id where the partner asks for it", async () => {
    for (const kind of ["airbridge", "singular", "tenjin"] as const) {
      expect(await skipped(kind, purchase, { context: { bundleId: null } })).toMatch(/^The app has no bundle ID or package name saved/);
    }
  });
  it("Airbridge skips events older than 24 hours", async () => {
    expect(await skipped("airbridge", { ...purchase, event_timestamp_ms: now.getTime() - 25 * 3600_000 })).toBe("Airbridge drops events more than 24 hours old, so this event is not sent.");
  });
});

describe("missing settings and unsent steps", () => {
  it("skips with a reason", async () => {
    expect(await skipped("mparticle", purchase, { secrets: { api_secret: "" } })).toBe("No mParticle server-to-server key and secret are saved.");
    expect(await skipped("statsig", purchase, { secrets: { server_secret: "" } })).toBe("No Statsig server secret key is saved.");
    expect(await skipped("superwall", purchase, { secrets: { webhook_url: "" } })).toBe("No Superwall webhook URL is saved.");
    expect(await skipped("appstack", purchase, { settings: { webhook_url: "" } })).toBe("No Appstack webhook URL is saved.");
    expect(await skipped("asapty", purchase, { settings: { asapty_id: "" } })).toBe("No Asapty ID is saved.");
    expect(await skipped("google_tag_manager", purchase, { settings: { server_container_url: "" } })).toBe("No server container URL is saved.");
    expect(await skipped("airbridge", purchase, { secrets: { api_token: "" } })).toBe("No Airbridge app name and API token are saved.");
    expect(await skipped("superwall", { ...purchase, type: "EXPERIMENT_ENROLLMENT" })).toBe("EXPERIMENT_ENROLLMENT events are not sent to Superwall.");
    expect(await skipped("asapty", { ...purchase, type: "TEST" })).toBe("TEST events are not sent to Asapty.");
    expect(await skipped("airbridge", { ...purchase, type: "TRANSFER" })).toBe("TRANSFER events are not sent to Airbridge.");
  });
});

describe("redaction", () => {
  it("lists every secret value and derived credential", async () => {
    const want: Partial<Record<IntegrationKind, string[]>> = {
      mparticle: ["us1-mpkey", "mp_secret_value", btoa("us1-mpkey:mp_secret_value")],
      statsig: ["secret-statsig123"],
      superwall: ["https://superwall.example/api/integrations/revenuecat?pk=sk_live_9", "Bearer sw_token"],
      telemetrydeck: [],
      appstack: ["appstack-token"],
      asapty: [],
      branch: ["key_live_abc"],
      google_tag_manager: ["gtm_secret+/=", "gtm_secret%2B%2F%3D"],
      kochava: [],
      airbridge: ["ab_token"],
      splitmetrics: ["https://acquire.example/rc/client_77"],
      singular: ["sing_key"],
      solarengine: ["https://se.example/rc?appkey=se_key_1", "se-auth"],
      tenjin: ["tj_ios_key", btoa("tj_ios_key:")],
    };
    for (const kind of KINDS) {
      const s = await sent(kind, purchase);
      expect(s.redact, kind).toEqual(want[kind]);
      for (const v of Object.values(CONFIG[kind]!.secrets).filter((x) => x && !(kind === "branch" && x.startsWith("key_test")) && !(kind === "singular" && x === "sing_sandbox") && !(kind === "tenjin" && x === "tj_android_key"))) {
        expect(s.redact, `${kind} redacts ${v}`).toContain(v);
      }
      // Nothing secret reaches the URL or body unscrubbed.
      let scrubbed = s.requests.map((r) => `${r.url} ${JSON.stringify(r.headers)} ${r.body}`).join("\n");
      for (const v of s.redact) scrubbed = scrubbed.split(v).join("[redacted]");
      for (const v of Object.values(CONFIG[kind]!.secrets)) if (v) expect(scrubbed, kind).not.toContain(v);
    }
    expect((await sent("branch", sandbox)).redact).toEqual(["key_test_abc"]);
    expect((await sent("tenjin", android)).redact).toEqual(["tj_android_key", btoa("tj_android_key:")]);
    expect((await sent("appstack", purchase, { secrets: { authorization: "" } })).redact).toEqual([]);
  });
});

describe("partner answers", () => {
  it("reads errors inside 2xx bodies", () => {
    expect(responseError("statsig", 202, '{"success":true}')).toBeNull();
    expect(responseError("statsig", 200, '{"success":false}')).toBe('Statsig rejected the event: {"success":false}');
    expect(responseError("kochava", 200, '{"success":"1"}')).toBeNull();
    expect(responseError("kochava", 200, '{"success":"0","error":"invalid app"}')).toBe('Kochava rejected the event: {"success":"0","error":"invalid app"}');
    expect(responseError("singular", 200, '{"status":"ok"}')).toBeNull();
    expect(responseError("singular", 200, '{"status":"error","reason":"Invalid API key"}')).toBe("Singular rejected the event: Invalid API key");
    expect(responseError("asapty", 200, '{"result":{"status":"OK"}}')).toBeNull();
    expect(responseError("asapty", 200, '{"result":{"status":"ERROR","message":"unknown asaptyid"}}')).toMatch(/^Asapty did not accept the event: /);
    expect(responseError("asapty", 200, "")).toBe("Asapty did not accept the event: empty answer");
    expect(responseError("tenjin", 200, '{"code":200}')).toBeNull();
    expect(responseError("tenjin", 200, '{"code":400,"message":"bad bundle"}')).toBe('Tenjin rejected the event: {"code":400,"message":"bad bundle"}');
    expect(responseError("airbridge", 200, '{"at":"2020-02-06 16:06:49","data":"Event(9360) is successfully proccessed."}')).toBeNull();
    expect(responseError("airbridge", 200, '{"at":"2020-02-06 16:06:49","error":"invalid_request","ingested":0}')).toBe("Airbridge rejected the event: invalid_request");
    expect(responseError("branch", 200, '{"ascending_only":false,"locked":false}')).toBeNull();
    expect(responseError("branch", 200, '{"error":{"code":400,"message":"Invalid branch key"}}')).toBe("Branch rejected the event: Invalid branch key");
    for (const kind of ["mparticle", "telemetrydeck", "superwall", "appstack", "splitmetrics", "solarengine", "google_tag_manager"] as const) {
      expect(responseError(kind, 202, "")).toBeNull();
      expect(responseError(kind, 200, "ok")).toBeNull();
    }
    expect(responseError("mparticle", 401, "")).toBe("HTTP 401");
  });
});

describe("save checks", () => {
  const check = (kind: IntegrationKind, settings: Record<string, any>, secrets: Record<string, string> = {}) => partnerDef(kind)!.validate!(settings, secrets);
  it("rejects settings the partner cannot use", () => {
    expect(check("statsig", {}, { server_secret: "client-abc" })).toEqual({ param: "settings.server_secret", message: "use the Server Secret Key, which starts with secret-. Client keys cannot log server events." });
    expect(check("statsig", {}, { server_secret: "secret-abc" })).toBeNull();
    expect(check("branch", {}, { branch_key: "key_test_abc" })).toEqual({ param: "settings.branch_key", message: "use the live Branch key (key_live_…); the test key goes in Sandbox Branch key." });
    expect(check("branch", {}, { branch_key: "key_live_abc", sandbox_branch_key: "key_live_x" })).toEqual({ param: "settings.sandbox_branch_key", message: "use the test Branch key (key_test_…)." });
    expect(check("branch", {}, { branch_key: "key_live_abc", sandbox_branch_key: "key_test_x" })).toBeNull();
    expect(check("kochava", {})).toEqual({ param: "settings", message: "set the Kochava app GUID for iOS, Android or both." });
    expect(check("kochava", { android_app_guid: "ko" })).toBeNull();
    expect(check("tenjin", {}, {})).toEqual({ param: "settings", message: "set the Tenjin SDK key for iOS, Android or both." });
    expect(check("tenjin", {}, { ios_sdk_key: "k" })).toBeNull();
    expect(check("google_tag_manager", { server_container_url: "https://sgtm.example.com?x=1", measurement_id: "G-1" })).toEqual({ param: "settings.server_container_url", message: "must be the container address only, without ? or #." });
    expect(check("google_tag_manager", { server_container_url: "https://sgtm.example.com", measurement_id: "UA-123-1" })).toEqual({ param: "settings.measurement_id", message: "must be a GA4 measurement ID, such as G-ABC123XYZ." });
    expect(check("google_tag_manager", { server_container_url: "https://sgtm.example.com", measurement_id: "G-ABC", sandbox_measurement_id: "g-x" })).toEqual({ param: "settings.sandbox_measurement_id", message: "must be a GA4 measurement ID, such as G-ABC123XYZ." });
    expect(check("google_tag_manager", { server_container_url: "https://sgtm.example.com", measurement_id: "G-ABC" })).toBeNull();
    expect(check("airbridge", { app_name: "https://testapp.airbridge.io" })).toEqual({ param: "settings.app_name", message: "must be the Airbridge app name (letters, digits and dashes), not a URL." });
    expect(check("airbridge", { app_name: "testapp" })).toBeNull();
    expect(check("telemetrydeck", { namespace: "acme/../x" })).toEqual({ param: "settings.namespace", message: "use letters, digits, dots, dashes and underscores only." });
    expect(check("telemetrydeck", { namespace: "acme" })).toBeNull();
    for (const kind of ["superwall", "appstack", "splitmetrics", "solarengine"] as const) {
      expect(check(kind, {}, { authorization: "Bearer a\r\nX-Evil: 1" })).toEqual({ param: "settings.authorization", message: "must be one line, without line breaks." });
      expect(check(kind, {}, { authorization: "Bearer a" })).toBeNull();
    }
    for (const kind of ["mparticle", "asapty", "singular"] as const) expect(partnerDef(kind)!.validate).toBeUndefined();
  });
});
