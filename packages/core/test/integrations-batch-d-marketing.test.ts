import { describe, expect, it } from "vitest";
import {
  INTEGRATIONS, buildIntegration, defaultEventName, partnerDef, responseError, sendsEvent, type IntegrationKind, type Plan, type WebhookEvent,
} from "../src/integrations/index.js";
import { discordEscape } from "../src/integrations/discord.js";

/**
 * Batch D marketing partners: Airship, Braze, CleverTap, Customer.io, Discord, Intercom, Iterable, OneSignal.
 * The exact requests for one App Store purchase, then names, status attributes, sandbox, identity, secrets and checks.
 */

const at = (k: string, v: string) => ({ [k]: { value: v, updated_at_ms: 1789990000000 } });
const purchase: WebhookEvent = {
  id: "5E7B1C2A-1111-4222-8333-444455556666", type: "INITIAL_PURCHASE", event_timestamp_ms: 1790000000000, app_id: "app_ios",
  app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", aliases: ["$RCAnonymousID:abc", "user_42"],
  product_id: "pro_monthly", period_type: "NORMAL", purchased_at_ms: 1790000000000, expiration_at_ms: 1792592000000, environment: "PRODUCTION",
  entitlement_id: null, entitlement_ids: ["pro"], presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111",
  is_family_share: false, country_code: "DE", currency: "EUR", price: 10.79, price_in_purchased_currency: 9.99,
  subscriber_attributes: { ...at("$email", " Wren@Example.com "), ...at("$idfa", "AEBE52E7-03EE-455A-B3C4-E57283966239") },
  store: "APP_STORE", takehome_percentage: 0.7, tax_percentage: 0, commission_percentage: 0.3, offer_code: null,
};
const trial: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000002", period_type: "TRIAL", price: 0, price_in_purchased_currency: 0 };
const renewal: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000004", type: "RENEWAL", is_trial_conversion: false };
const cancellation: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000005", type: "CANCELLATION", cancel_reason: "UNSUBSCRIBE", price: 0, price_in_purchased_currency: 0 };
const refund: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000006", type: "CANCELLATION", cancel_reason: "CUSTOMER_SUPPORT", price: -10.79, price_in_purchased_currency: -9.99 };
const expiration: WebhookEvent = { ...purchase, id: "5E7B1C2A-1111-4222-8333-000000000007", type: "EXPIRATION", expiration_reason: "UNSUBSCRIBE", price: 0, price_in_purchased_currency: 0 };
const sandbox: WebhookEvent = { ...purchase, environment: "SANDBOX" };
const anonymous: WebhookEvent = { ...purchase, app_user_id: "$RCAnonymousID:abc", subscriber_attributes: {} };

const KINDS = ["airship", "braze", "clevertap", "customerio", "discord", "intercom", "iterable", "onesignal"] as const;
type Kind = (typeof KINDS)[number];

const now = new Date("2026-09-21T14:13:21Z");
const DISCORD_URL = "https://discord.com/api/webhooks/123456789/tok-en_XYZ";
const CONFIG: Record<Kind, { settings: Record<string, any>; secrets: Record<string, string> }> = {
  airship: { settings: { app_key: "air_app_key", region: "us" }, secrets: { token: "air_token" } },
  braze: { settings: { rest_endpoint: "https://rest.iad-01.braze.com" }, secrets: { api_key: "braze_key" } },
  clevertap: { settings: { account_id: "W4R-ACC-123", region: "us1" }, secrets: { passcode: "ct_pass" } },
  customerio: { settings: { site_id: "site123", region: "us" }, secrets: { api_key: "cio_key" } },
  discord: { settings: {}, secrets: { webhook_url: DISCORD_URL } },
  intercom: { settings: { region: "eu" }, secrets: { access_token: "ic_token" } },
  iterable: { settings: { region: "us" }, secrets: { api_key: "it_key" } },
  onesignal: { settings: { app_id: "8f0e5b1a-1c2d-4e3f-9a8b-7c6d5e4f3a2b" }, secrets: { api_key: "os_key" } },
};

type Over = { settings?: Record<string, any>; secrets?: Record<string, string>; eventNames?: Record<string, string> };
async function plan(kind: Kind, event: WebhookEvent, over: Over = {}): Promise<Plan> {
  const c = CONFIG[kind];
  return buildIntegration(kind, {
    event, settings: { ...c.settings, ...over.settings }, secrets: { ...c.secrets, ...over.secrets }, eventNames: over.eventNames, now,
    context: { projectId: "proj1", dashboardUrl: "https://app.revenuedot.app", bundleId: "com.example.scanner" },
  });
}
async function sent(kind: Kind, event: WebhookEvent, over?: Over) {
  const p = await plan(kind, event, over);
  if ("skip" in p) throw new Error(`${kind} skipped: ${p.skip}`);
  return { name: p.name, redact: p.redact, requests: p.requests.map((r) => ({ ...r, json: JSON.parse(r.body) })) };
}
async function skipped(kind: Kind, event: WebhookEvent, over?: Over) {
  const p = await plan(kind, event, over);
  return "skip" in p ? p.skip : null;
}

describe("catalogue", () => {
  it("lists every marketing partner with a documented API", () => {
    for (const kind of KINDS) {
      const spec = INTEGRATIONS.find((s) => s.kind === kind);
      expect(spec, kind).toBeDefined();
      expect(spec).toMatchObject({ category: "marketing", api: "documented" });
      expect(partnerDef(kind)).toBeDefined();
    }
  });
  it("queues only the events each partner sends", () => {
    expect(sendsEvent("discord", expiration)).toBe(false);
    expect(sendsEvent("discord", refund)).toBe(true);
    expect(sendsEvent("intercom", { ...purchase, type: "UNCANCELLATION" })).toBe(false);
    expect(sendsEvent("clevertap", { ...purchase, type: "SUBSCRIPTION_PAUSED" })).toBe(false);
    expect(sendsEvent("braze", { ...purchase, type: "SUBSCRIPTION_PAUSED" })).toBe(true);
    for (const kind of KINDS) {
      expect(sendsEvent(kind, purchase)).toBe(true);
      expect(sendsEvent(kind, { ...purchase, type: "TRANSFER" })).toBe(false);
      expect(sendsEvent(kind, { ...purchase, type: "TEST" })).toBe(true);
    }
  });
  it("default event names are rc_<step>_event; Discord and OneSignal have none", () => {
    for (const kind of ["airship", "braze", "clevertap", "customerio", "intercom", "iterable"] as const) {
      expect(defaultEventName(kind, "initial_purchase")).toBe("rc_initial_purchase_event");
      expect(defaultEventName(kind, "trial_started")).toBe("rc_trial_started_event");
    }
    expect(defaultEventName("clevertap", "subscription_paused")).toBeNull();
    expect(defaultEventName("discord", "initial_purchase")).toBeNull();
    expect(defaultEventName("onesignal", "initial_purchase")).toBeNull();
  });
});

describe("INITIAL_PURCHASE, exact requests", () => {
  it("Airship: custom event on the named user", async () => {
    const s = await sent("airship", purchase);
    expect(s.name).toBe("rc_initial_purchase_event");
    expect(s.requests).toHaveLength(1);
    const r = s.requests[0]!;
    expect([r.method, r.url]).toEqual(["POST", "https://go.urbanairship.com/api/custom-events"]);
    expect(r.headers).toEqual({ "content-type": "application/json", accept: "application/vnd.urbanairship+json; version=3", authorization: "Bearer air_token", "x-ua-appkey": "air_app_key" });
    expect(r.json).toEqual([{
      occurred: "2026-09-21T14:13:20",
      user: { named_user_id: "user_42" },
      body: {
        name: "rc_initial_purchase_event", value: 10.79, transaction: purchase.id,
        properties: {
          product_id: "pro_monthly", store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL", entitlement_ids: ["pro"], presented_offering_id: "default",
          transaction_id: "2000000111", original_transaction_id: "2000000111", app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", country_code: "DE",
          revenue: 10.79, currency: "USD", price_in_purchased_currency: 9.99, purchased_currency: "EUR", purchased_at: "2026-09-21T14:13:20", expiration_at: "2026-10-21T14:13:20",
        },
      },
    }]);
  });

  it("Braze: event, eCommerce order and status in one /users/track", async () => {
    const s = await sent("braze", purchase);
    expect(s.requests).toHaveLength(1);
    const r = s.requests[0]!;
    expect([r.method, r.url, r.headers]).toEqual(["POST", "https://rest.iad-01.braze.com/users/track", { "content-type": "application/json", authorization: "Bearer braze_key" }]);
    expect(r.json).toEqual({
      attributes: [{ external_id: "user_42", rc_subscription_status: "active" }],
      events: [
        {
          external_id: "user_42", name: "rc_initial_purchase_event", time: "2026-09-21T14:13:20Z",
          properties: {
            product_id: "pro_monthly", store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL", entitlement_ids: ["pro"], presented_offering_id: "default",
            transaction_id: "2000000111", original_transaction_id: "2000000111", app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", country_code: "DE",
            revenue: 10.79, currency: "USD", price_in_purchased_currency: 9.99, purchased_currency: "EUR", purchased_at: "2026-09-21T14:13:20Z", expiration_at: "2026-10-21T14:13:20Z",
          },
        },
        {
          external_id: "user_42", name: "ecommerce.order_placed", time: "2026-09-21T14:13:20Z",
          properties: {
            order_id: "2000000111", total_value: 10.79, currency: "USD", total_discounts: 0, source: "APP_STORE",
            products: [{ product_id: "pro_monthly", product_name: "pro_monthly", variant_id: "pro_monthly", quantity: 1, price: 10.79 }],
            metadata: { rc_event_name: "rc_initial_purchase_event", environment: "PRODUCTION", period_type: "NORMAL" },
          },
        },
      ],
    });
    const legacy = (await sent("braze", purchase, { settings: { revenue_format: "purchase", app_id: "braze-app" } })).requests[0]!.json;
    expect(legacy.events).toHaveLength(1);
    expect(legacy.events[0].app_id).toBe("braze-app");
    expect(legacy.purchases).toEqual([{
      external_id: "user_42", app_id: "braze-app", product_id: "pro_monthly", currency: "USD", price: 10.79, quantity: 1, time: "2026-09-21T14:13:20Z",
      properties: { rc_event_name: "rc_initial_purchase_event", store: "APP_STORE", environment: "PRODUCTION", transaction_id: "2000000111" },
    }]);
  });

  it("CleverTap: event and profile records in one upload", async () => {
    const s = await sent("clevertap", purchase);
    const r = s.requests[0]!;
    expect(s.requests).toHaveLength(1);
    expect([r.method, r.url]).toEqual(["POST", "https://us1.api.clevertap.com/1/upload"]);
    expect(r.headers).toEqual({ "content-type": "application/json; charset=utf-8", "x-clevertap-account-id": "W4R-ACC-123", "x-clevertap-passcode": "ct_pass" });
    expect(r.json).toEqual({
      d: [
        {
          identity: "user_42", ts: 1790000000, type: "event", evtName: "rc_initial_purchase_event",
          evtData: {
            product_id: "pro_monthly", store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL", entitlement_ids: "pro", presented_offering_id: "default",
            transaction_id: "2000000111", original_transaction_id: "2000000111", app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", country_code: "DE",
            revenue: 10.79, currency: "USD", price_in_purchased_currency: 9.99, purchased_currency: "EUR", purchased_at: 1790000000, expiration_at: 1792592000, event_id: purchase.id,
          },
        },
        { identity: "user_42", ts: 1790000000, type: "profile", profileData: { rc_subscription_status: "active" } },
      ],
    });
    expect((await sent("clevertap", purchase, { settings: { region: "eu" } })).requests[0]!.url).toBe("https://api.clevertap.com/1/upload");
  });

  it("Customer.io: identify, then the event with a ULID id", async () => {
    const s = await sent("customerio", purchase);
    expect(s.requests.map((r) => [r.method, r.url, r.headers])).toEqual([
      ["PUT", "https://track.customer.io/api/v1/customers/user_42", { "content-type": "application/json", authorization: "Basic c2l0ZTEyMzpjaW9fa2V5" }],
      ["POST", "https://track.customer.io/api/v1/customers/user_42/events", { "content-type": "application/json", authorization: "Basic c2l0ZTEyMzpjaW9fa2V5" }],
    ]);
    expect(s.requests[0]!.json).toEqual({ email: "Wren@Example.com", app_user_id: "user_42", rc_subscription_status: "active" });
    expect(s.requests[1]!.json).toEqual({
      name: "rc_initial_purchase_event", id: "01M3250V00CR2WDXH8WJGT4DP4", timestamp: 1790000000,
      data: {
        app_id: "app_ios", app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc", platform: "ios", rc_subscription_status: "active", entitlement_ids: ["pro"],
        product_id: "pro_monthly", currency: "USD", revenue: 10.79, price_in_purchased_currency: 9.99, purchased_currency: "EUR", purchased_at: 1790000000, expiration_at: 1792592000,
        transaction_id: "2000000111", original_transaction_id: "2000000111", period_type: "NORMAL", store: "APP_STORE", environment: "PRODUCTION", is_family_share: false,
        presented_offering_id: "default", country_code: "DE",
      },
    });
    // Same event, same id; a different event, a different id.
    expect((await sent("customerio", purchase)).requests[1]!.json.id).toBe("01M3250V00CR2WDXH8WJGT4DP4");
    expect((await sent("customerio", renewal)).requests[1]!.json.id).toMatch(/^01M3250V00[0-9A-HJKMNP-TV-Z]{16}$/);
    expect((await sent("customerio", renewal)).requests[1]!.json.id).not.toBe("01M3250V00CR2WDXH8WJGT4DP4");
    const eu = await sent("customerio", { ...purchase, subscriber_attributes: at("$customerioId", "cio person/1") }, { settings: { region: "eu" } });
    expect(eu.requests[0]!.url).toBe("https://track-eu.customer.io/api/v1/customers/cio%20person%2F1");
  });

  it("Discord: an embed with mentions turned off", async () => {
    const s = await sent("discord", purchase);
    const r = s.requests[0]!;
    expect([r.method, r.url, r.headers]).toEqual(["POST", DISCORD_URL, { "content-type": "application/json" }]);
    expect(r.json).toEqual({
      username: "RevenueDot",
      allowed_mentions: { parse: [] },
      embeds: [{
        description: "Customer [user\\_42](https://app.revenuedot.app/projects/proj1/customers/user_42) started a subscription.",
        color: 5763719,
        fields: [
          { name: "Product", value: "pro\\_monthly", inline: true }, { name: "Revenue", value: "$10.79", inline: true },
          { name: "Store", value: "APP\\_STORE", inline: true }, { name: "Country", value: "DE", inline: true },
        ],
        timestamp: "2026-09-21T14:13:20.000Z",
      }],
    });
    expect(s.name).toBe("initial_purchase");
  });

  it("Intercom: one data event with at most ten metadata keys", async () => {
    const s = await sent("intercom", purchase);
    const r = s.requests[0]!;
    expect(s.requests).toHaveLength(1);
    expect([r.method, r.url]).toEqual(["POST", "https://api.eu.intercom.io/events"]);
    expect(r.headers).toEqual({ "content-type": "application/json", accept: "application/json", authorization: "Bearer ic_token", "intercom-version": "2.11" });
    expect(r.json).toEqual({
      event_name: "rc_initial_purchase_event", created_at: 1790000000, user_id: "user_42",
      metadata: {
        product_identifier: "pro_monthly", entitlement: "pro", store: "APP_STORE", environment: "PRODUCTION", subscription_status: "active",
        expires_at: 1792592000, price: { amount: 1079, currency: "usd" }, period_type: "NORMAL", country_code: "DE",
      },
    });
    const many = await sent("intercom", { ...cancellation, new_product_id: "pro_yearly", expiration_reason: "X" });
    expect(Object.keys(many.requests[0]!.json.metadata)).toHaveLength(10);
  });

  it("Iterable: the event by email, then the status on the user", async () => {
    const s = await sent("iterable", purchase);
    expect(s.requests.map((r) => [r.method, r.url, r.headers])).toEqual([
      ["POST", "https://api.iterable.com/api/events/track", { "content-type": "application/json", "api-key": "it_key" }],
      ["POST", "https://api.iterable.com/api/users/update", { "content-type": "application/json", "api-key": "it_key" }],
    ]);
    const dataFields = {
      rc_event_name: "rc_initial_purchase_event", product_id: "pro_monthly", store: "APP_STORE", environment: "PRODUCTION", period_type: "NORMAL", entitlement_ids: ["pro"],
      presented_offering_id: "default", transaction_id: "2000000111", original_transaction_id: "2000000111", app_user_id: "user_42", original_app_user_id: "$RCAnonymousID:abc",
      country_code: "DE", revenue: 10.79, currency: "USD", price_in_purchased_currency: 9.99, purchased_currency: "EUR", purchased_at: 1790000000, expiration_at: 1792592000,
    };
    expect(s.requests[0]!.json).toEqual({ email: "Wren@Example.com", eventName: "rc_initial_purchase_event", id: purchase.id, createdAt: 1790000000, dataFields });
    expect(s.requests[1]!.json).toEqual({ email: "Wren@Example.com", dataFields: { rc_subscription_status: "active" } });
    const p = await sent("iterable", { ...purchase, subscriber_attributes: { ...at("$iterableUserId", "it_user_9"), ...at("$iterableCampaignId", "1234"), ...at("$iterableTemplateId", "567") } }, { settings: { track_purchases: true, region: "eu" } });
    expect(p.requests[0]!.url).toBe("https://api.eu.iterable.com/api/commerce/trackPurchase");
    expect(p.requests[0]!.json).toEqual({
      id: purchase.id, user: { userId: "it_user_9", preferUserId: true },
      items: [{ id: "pro_monthly", sku: "pro_monthly", name: "pro_monthly", price: 10.79, quantity: 1 }], total: 10.79, createdAt: 1790000000,
      dataFields, campaignId: 1234, templateId: 567,
    });
    expect(p.requests[1]!.json).toEqual({ userId: "it_user_9", dataFields: { rc_subscription_status: "active" }, preferUserId: true });
    expect((await sent("iterable", { ...purchase, subscriber_attributes: {} })).requests[0]!.json.userId).toBe("user_42");
  });

  it("OneSignal: user tags by external id", async () => {
    const s = await sent("onesignal", purchase);
    const r = s.requests[0]!;
    expect(s.requests).toHaveLength(1);
    expect([r.method, r.url]).toEqual(["PATCH", "https://api.onesignal.com/apps/8f0e5b1a-1c2d-4e3f-9a8b-7c6d5e4f3a2b/users/by/external_id/user_42"]);
    expect(r.headers).toEqual({ "content-type": "application/json", accept: "application/json", authorization: "Key os_key" });
    expect(r.json).toEqual({
      properties: {
        tags: {
          app_user_id: "user_42", period_type: "NORMAL", purchased_at: "1790000000", expiration_at: "1792592000", store: "APP_STORE", environment: "PRODUCTION",
          last_event_type: "INITIAL_PURCHASE", product_id: "pro_monthly", entitlement_ids: "pro", active_subscription: "true", subscription_status: "active",
        },
      },
    });
    const v5 = await sent("onesignal", { ...anonymous, subscriber_attributes: at("$onesignalUserId", "a1b2c3d4-0000-4000-8000-000000000001") });
    expect(v5.requests[0]!.url).toBe("https://api.onesignal.com/apps/8f0e5b1a-1c2d-4e3f-9a8b-7c6d5e4f3a2b/users/by/onesignal_id/a1b2c3d4-0000-4000-8000-000000000001");
    expect((await sent("onesignal", { ...purchase, type: "TEST" })).requests[0]!.json).toEqual({ properties: { tags: { app_user_id: "user_42", environment: "PRODUCTION", last_event_type: "TEST" } } });
  });
});

describe("event names", () => {
  const nameOf = async (kind: Kind, e: WebhookEvent, over?: Over) => (await sent(kind, e, over)).name;
  it("trial start and renewal use RevenueCat's names, and overrides win", async () => {
    for (const kind of ["airship", "braze", "clevertap", "customerio", "intercom", "iterable"] as const) {
      expect(await nameOf(kind, trial)).toBe("rc_trial_started_event");
      expect(await nameOf(kind, renewal)).toBe("rc_renewal_event");
      expect(await nameOf(kind, cancellation)).toBe("rc_cancellation_event");
      expect(await nameOf(kind, { ...cancellation, period_type: "TRIAL" })).toBe("rc_trial_cancelled_event");
      expect(await nameOf(kind, expiration)).toBe("rc_expiration_event");
    }
    expect(await nameOf("braze", purchase, { eventNames: { initial_purchase: "Subscribed" } })).toBe("Subscribed");
    expect((await sent("braze", trial)).requests[0]!.json.events[0].name).toBe("rc_trial_started_event");
    expect((await sent("iterable", renewal)).requests[0]!.json.eventName).toBe("rc_renewal_event");
    expect((await sent("clevertap", trial)).requests[0]!.json.d[0].evtName).toBe("rc_trial_started_event");
    expect((await sent("customerio", renewal)).requests[1]!.json.name).toBe("rc_renewal_event");
    expect((await sent("intercom", trial)).requests[0]!.json.event_name).toBe("rc_trial_started_event");
    // Airship rejects uppercase event names.
    const air = await sent("airship", purchase, { eventNames: { initial_purchase: "Subscribed" } });
    expect([air.name, air.requests[0]!.json[0].body.name]).toEqual(["subscribed", "subscribed"]);
    expect((await sent("airship", renewal)).requests[0]!.json[0].body).toMatchObject({ name: "rc_renewal_event", value: 10.79 });
    expect((await sent("airship", trial)).requests[0]!.json[0].body).not.toHaveProperty("value");
    expect((await sent("onesignal", trial)).requests[0]!.json.properties.tags).toMatchObject({ last_event_type: "TRIAL_STARTED", period_type: "TRIAL", subscription_status: "trial" });
    expect((await sent("onesignal", renewal)).requests[0]!.json.properties.tags).toMatchObject({ last_event_type: "RENEWAL", active_subscription: "true" });
  });
  it("Discord posts trials, renewals, refunds and cancellations, not expirations", async () => {
    const d = async (e: WebhookEvent) => (await sent("discord", e)).requests[0]!.json.embeds[0];
    expect((await d(trial)).description).toMatch(/started a free trial\.$/);
    expect(await d(trial)).toMatchObject({ color: 5763719 });
    expect((await d(trial)).fields.map((f: any) => f.name)).toEqual(["Product", "Store", "Country"]);
    expect((await d(renewal)).description).toMatch(/renewed their subscription\.$/);
    const r = await d(refund);
    expect(r.description).toMatch(/was refunded\.$/);
    expect(r).toMatchObject({ color: 15548997 });
    expect(r.fields).toContainEqual({ name: "Revenue", value: "-$10.79", inline: true });
    expect((await sent("discord", refund)).name).toBe("refund");
    expect(await d(cancellation)).toMatchObject({ color: 15548997, description: expect.stringMatching(/cancelled their subscription\.$/) });
    expect(await skipped("discord", expiration)).toMatch(/not posted to Discord/);
  });
});

describe("revenue, refunds, cancellations and expirations", () => {
  it("Braze sends purchases only for positive money events", async () => {
    const b = async (e: WebhookEvent, over?: Over) => (await sent("braze", e, over)).requests[0]!.json;
    expect((await b(renewal)).events.map((x: any) => x.name)).toEqual(["rc_renewal_event", "ecommerce.order_placed"]);
    expect((await b(trial)).events).toHaveLength(1);
    const rf = await b(refund, { settings: { revenue_format: "purchase" } });
    expect(rf.purchases).toBeUndefined();
    expect(rf.events).toHaveLength(1);
    expect(rf.events[0].properties).toMatchObject({ revenue: -10.79, cancel_reason: "CUSTOMER_SUPPORT" });
    expect(rf.attributes).toEqual([{ external_id: "user_42", rc_subscription_status: "expired" }]);
    expect((await b(cancellation)).attributes).toEqual([{ external_id: "user_42", rc_subscription_status: "cancelled" }]);
    expect((await b(expiration)).attributes).toEqual([{ external_id: "user_42", rc_subscription_status: "expired" }]);
    expect((await b(expiration)).events[0].properties).toMatchObject({ expiration_reason: "UNSUBSCRIBE", revenue: 0 });
    expect((await b(purchase, { settings: { reporting: "proceeds" } })).events[0].properties.revenue).toBe(7.553);
    expect((await b({ ...purchase, type: "TEST" })).attributes).toBeUndefined();
  });
  it("every partner sets rc_subscription_status (OneSignal: subscription_status) for cancellations and expirations", async () => {
    for (const [e, status] of [[cancellation, "cancelled"], [expiration, "expired"], [refund, "expired"]] as const) {
      expect((await sent("clevertap", e)).requests[0]!.json.d[1]).toMatchObject({ type: "profile", profileData: { rc_subscription_status: status } });
      expect((await sent("customerio", e)).requests[0]!.json).toMatchObject({ rc_subscription_status: status });
      expect((await sent("iterable", e)).requests[1]!.json.dataFields).toEqual({ rc_subscription_status: status });
      expect((await sent("intercom", e)).requests[0]!.json.metadata.subscription_status).toBe(status);
      expect((await sent("onesignal", e)).requests[0]!.json.properties.tags.subscription_status).toBe(status);
      const air = await sent("airship", e, { settings: { set_attributes: true } });
      expect(air.requests[1]!.url).toBe("https://go.urbanairship.com/api/named_users/user_42/attributes");
      expect(air.requests[1]!.json).toEqual({ attributes: [{ action: "set", key: "rc_subscription_status", value: status, timestamp: "2026-09-21 14:13:20" }] });
    }
    expect((await sent("onesignal", expiration)).requests[0]!.json.properties.tags.active_subscription).toBe("false");
    expect((await sent("onesignal", cancellation)).requests[0]!.json.properties.tags.active_subscription).toBe("true");
    expect((await sent("airship", expiration)).requests).toHaveLength(1);
    expect((await sent("intercom", expiration)).requests[0]!.json.metadata).toMatchObject({ expiration_reason: "UNSUBSCRIBE" });
    expect((await sent("intercom", cancellation)).requests[0]!.json.metadata).toMatchObject({ cancellation_reason: "UNSUBSCRIBE" });
  });
  it("refunds carry negative revenue in event data, never as purchases", async () => {
    expect((await sent("iterable", refund, { settings: { track_purchases: true } })).requests[0]!.url).toBe("https://api.iterable.com/api/events/track");
    expect((await sent("iterable", refund)).requests[0]!.json.dataFields).toMatchObject({ revenue: -10.79, cancel_reason: "CUSTOMER_SUPPORT" });
    expect((await sent("customerio", refund)).requests[1]!.json.data.revenue).toBe(-10.79);
    expect((await sent("clevertap", refund)).requests[0]!.json.d[0].evtData.revenue).toBe(-10.79);
    expect((await sent("intercom", refund)).requests[0]!.json.metadata).not.toHaveProperty("price");
    expect((await sent("airship", refund)).requests[0]!.json[0].body).not.toHaveProperty("value");
  });
});

describe("sandbox", () => {
  it("partners with separate projects need sandbox credentials", async () => {
    expect(await skipped("braze", sandbox)).toBe("Sandbox events need a sandbox REST API key.");
    expect(await skipped("iterable", sandbox)).toBe("Sandbox events need a sandbox API key (a separate Iterable project).");
    expect(await skipped("customerio", sandbox)).toBe("Sandbox events need a sandbox site ID and API key (a second Customer.io workspace).");
    expect(await skipped("clevertap", sandbox)).toBe("Sandbox events need a sandbox account ID and passcode (a second CleverTap account).");
    expect(await skipped("airship", sandbox)).toBe("Sandbox events need a sandbox app key and token (a second Airship project).");
    expect(await skipped("customerio", sandbox, { secrets: { sandbox_api_key: "cio_sb" } })).toMatch(/sandbox site ID/);
  });
  it("sends sandbox events with the sandbox credentials", async () => {
    const b = await sent("braze", sandbox, { secrets: { sandbox_api_key: "braze_sb" } });
    expect(b.requests[0]!.headers.authorization).toBe("Bearer braze_sb");
    expect(b.redact).toEqual(["braze_sb"]);
    expect((await sent("iterable", sandbox, { secrets: { sandbox_api_key: "it_sb" } })).requests[0]!.headers["api-key"]).toBe("it_sb");
    const c = await sent("customerio", sandbox, { settings: { sandbox_site_id: "sb_site" }, secrets: { sandbox_api_key: "cio_sb" } });
    expect(c.requests[0]!.headers.authorization).toBe(`Basic ${btoa("sb_site:cio_sb")}`);
    expect(c.redact).toEqual(["cio_sb", btoa("sb_site:cio_sb")]);
    const ct = await sent("clevertap", sandbox, { settings: { sandbox_account_id: "SB-ACC" }, secrets: { sandbox_passcode: "ct_sb" } });
    expect([ct.requests[0]!.headers["x-clevertap-account-id"], ct.requests[0]!.headers["x-clevertap-passcode"]]).toEqual(["SB-ACC", "ct_sb"]);
    const a = await sent("airship", sandbox, { settings: { sandbox_app_key: "sb_app" }, secrets: { sandbox_token: "air_sb" } });
    expect([a.requests[0]!.headers["x-ua-appkey"], a.requests[0]!.headers.authorization]).toEqual(["sb_app", "Bearer air_sb"]);
  });
  it("Discord labels sandbox events; Intercom and OneSignal send them to the same workspace or app", async () => {
    expect((await sent("discord", sandbox)).requests[0]!.json.embeds[0].fields).toContainEqual({ name: "Environment", value: "Sandbox", inline: true });
    expect((await sent("intercom", sandbox)).requests[0]!.json.metadata.environment).toBe("SANDBOX");
    expect((await sent("onesignal", sandbox)).requests[0]!.json.properties.tags.environment).toBe("SANDBOX");
  });
});

describe("identity", () => {
  it("uses each partner's reserved attribute when set", async () => {
    const withAttrs = (o: Record<string, string>) => ({ ...purchase, subscriber_attributes: Object.assign({}, ...Object.entries(o).map(([k, v]) => at(k, v))) });
    const braze = (await sent("braze", withAttrs({ $brazeAliasName: "wren", $brazeAliasLabel: "crm" }))).requests[0]!.json;
    expect(braze.events[0]).toMatchObject({ user_alias: { alias_name: "wren", alias_label: "crm" } });
    expect(braze.events[0]).not.toHaveProperty("external_id");
    expect(braze.attributes[0]).toEqual({ user_alias: { alias_name: "wren", alias_label: "crm" }, rc_subscription_status: "active" });
    expect((await sent("braze", withAttrs({ $brazeAliasName: "wren" }))).requests[0]!.json.events[0].external_id).toBe("user_42");
    const ct = (await sent("clevertap", withAttrs({ $clevertapId: "ct-guid-1" }))).requests[0]!.json.d;
    expect([ct[0].objectId, ct[0].identity, ct[1].objectId]).toEqual(["ct-guid-1", undefined, "ct-guid-1"]);
    const air = await sent("airship", withAttrs({ $airshipChannelId: "chan-ios-1" }), { settings: { set_attributes: true } });
    expect(air.requests[0]!.json[0].user).toEqual({ ios_channel: "chan-ios-1" });
    expect(air.requests[1]!.url).toBe("https://go.urbanairship.com/api/channels/attributes");
    expect(air.requests[1]!.json.audience).toEqual({ ios_channel: "chan-ios-1" });
    const android = await sent("airship", { ...withAttrs({ $airshipChannelId: "chan-and-1" }), store: "PLAY_STORE" });
    expect(android.requests[0]!.json[0].user).toEqual({ android_channel: "chan-and-1" });
    const intercom = await sent("intercom", { ...anonymous, subscriber_attributes: at("$email", "wren@example.com") });
    expect(intercom.requests[0]!.json).toMatchObject({ email: "wren@example.com" });
    expect(intercom.requests[0]!.json).not.toHaveProperty("user_id");
  });
  it("skips anonymous customers the partner cannot find", async () => {
    expect(await skipped("airship", anonymous)).toMatch(/\$airshipChannelId/);
    expect(await skipped("intercom", anonymous)).toMatch(/\$email/);
    expect(await skipped("onesignal", anonymous)).toMatch(/\$onesignalUserId/);
    expect(await skipped("airship", { ...anonymous, subscriber_attributes: at("$airshipChannelId", "c1") })).toBeNull();
    // Partners that create profiles on first sight take anonymous ids as RevenueCat does.
    expect((await sent("braze", anonymous)).requests[0]!.json.events[0].external_id).toBe("$RCAnonymousID:abc");
    expect((await sent("clevertap", anonymous)).requests[0]!.json.d[0].identity).toBe("$RCAnonymousID:abc");
    expect((await sent("customerio", anonymous)).requests[0]!.url).toBe("https://track.customer.io/api/v1/customers/%24RCAnonymousID%3Aabc");
    expect((await sent("iterable", anonymous)).requests[0]!.json.userId).toBe("$RCAnonymousID:abc");
  });
  it("skips without credentials", async () => {
    expect(await skipped("braze", purchase, { secrets: { api_key: "" } })).toBe("No Braze REST API key is saved.");
    expect(await skipped("braze", purchase, { settings: { rest_endpoint: "https://evil.example.com" } })).toMatch(/REST endpoint/);
    expect(await skipped("discord", purchase, { secrets: { webhook_url: "" } })).toBe("No Discord webhook URL is saved.");
    expect(await skipped("discord", purchase, { secrets: { webhook_url: "https://example.com/api/webhooks/1/x" } })).toMatch(/not a discord.com webhook/);
    expect(await skipped("onesignal", purchase, { settings: { app_id: "" } })).toBe("No OneSignal app ID and API key are saved.");
    expect(await skipped("intercom", purchase, { secrets: { access_token: "" } })).toBe("No Intercom access token is saved.");
    expect(await skipped("clevertap", { ...purchase, type: "SUBSCRIPTION_PAUSED" })).toMatch(/not sent to CleverTap/);
  });
});

describe("secrets", () => {
  it("redact covers every secret and derived credential", async () => {
    for (const kind of KINDS) {
      const s = await sent(kind, purchase);
      for (const v of Object.values(CONFIG[kind].secrets)) expect(s.redact, kind).toContain(v);
      const logged = s.requests.map((r) => `${r.url} ${JSON.stringify(r.headers)} ${r.body}`).join("\n");
      const scrubbed = s.redact.reduce((t, v) => t.split(v).join("[redacted]"), logged);
      for (const v of Object.values(CONFIG[kind].secrets)) expect(scrubbed, kind).not.toContain(v);
    }
    expect((await sent("customerio", purchase)).redact).toEqual(["cio_key", "c2l0ZTEyMzpjaW9fa2V5"]);
    expect((await sent("discord", purchase)).redact).toEqual([DISCORD_URL, "tok-en_XYZ"]);
  });
});

describe("answers and save checks", () => {
  it("reads errors inside 2xx answers", () => {
    expect(responseError("braze", 201, '{"message":"success","errors":[{"type":"\'external_id\' is required","input_array":"events","index":0}]}')).toMatch(/Braze rejected part of the request: 'external_id' is required \(events\)/);
    expect(responseError("braze", 201, '{"message":"success","attributes_processed":1,"events_processed":1}')).toBeNull();
    expect(responseError("braze", 400, '{"message":"Invalid API key"}')).toMatch(/HTTP 400/);
    expect(responseError("clevertap", 200, '{"status":"partial","processed":1,"unprocessed":[{"status":"fail","code":509,"error":"Invalid identity"}]}')).toBe("CleverTap answered partial: Invalid identity (code 509)");
    expect(responseError("clevertap", 200, '{"status":"success","processed":2,"unprocessed":[]}')).toBeNull();
    expect(responseError("iterable", 200, '{"msg":"","code":"Success","params":null}')).toBeNull();
    expect(responseError("iterable", 200, '{"msg":"Invalid email","code":"InvalidEmailAddressError","params":null}')).toBe("Iterable answered InvalidEmailAddressError: Invalid email");
    expect(responseError("airship", 200, '{"ok":true,"operation_id":"abc"}')).toBeNull();
    expect(responseError("airship", 200, '{"ok":false,"error":"Could not parse request body"}')).toMatch(/Could not parse/);
    expect(responseError("intercom", 202, "")).toBeNull();
    expect(responseError("intercom", 200, '{"type":"error.list","errors":[{"code":"not_found","message":"User Not Found"}]}')).toBe("Intercom answered: User Not Found");
    expect(responseError("onesignal", 202, '{"properties":{"tags":{"a":"1"}}}')).toBeNull();
    expect(responseError("onesignal", 200, '{"errors":[{"title":"tags limit"}]}')).toBe("OneSignal answered: tags limit");
    expect(responseError("discord", 204, "")).toBeNull();
    expect(responseError("customerio", 200, "{}")).toBeNull();
  });
  it("validates Discord URLs, Braze endpoints, OneSignal app ids and sandbox pairs", () => {
    const v = (kind: Kind, settings: Record<string, any>, secrets: Record<string, string> = {}) => partnerDef(kind)!.validate?.(settings, secrets) ?? null;
    expect(v("discord", {}, { webhook_url: DISCORD_URL })).toBeNull();
    expect(v("discord", {}, { webhook_url: "https://discordapp.com/api/webhooks/1/abc" })).toBeNull();
    expect(v("discord", {}, { webhook_url: "https://canary.discord.com/api/v10/webhooks/1/abc" })).toBeNull();
    for (const bad of ["https://discord.com.evil.io/api/webhooks/1/abc", "http://discord.com/api/webhooks/1/abc", "https://discord.com/api/channels/1/messages", "https://user:pw@discord.com/api/webhooks/1/abc", "https://hooks.slack.com/services/T/B/X"]) {
      expect(v("discord", {}, { webhook_url: bad })?.param, bad).toBe("settings.webhook_url");
    }
    expect(v("braze", { rest_endpoint: "https://rest.fra-02.braze.eu" })).toBeNull();
    expect(v("braze", { rest_endpoint: "https://rest.iad-01.braze.com.evil.io" })?.param).toBe("settings.rest_endpoint");
    expect(v("braze", { rest_endpoint: "https://rest.iad-01.braze.com/users/track" })?.param).toBe("settings.rest_endpoint");
    expect(v("onesignal", { app_id: CONFIG.onesignal.settings.app_id })).toBeNull();
    expect(v("onesignal", { app_id: "../../other" })?.param).toBe("settings.app_id");
    expect(v("customerio", { sandbox_site_id: "sb" })?.param).toBe("settings.sandbox_api_key");
    expect(v("clevertap", {}, { sandbox_passcode: "x" })?.param).toBe("settings.sandbox_account_id");
    expect(v("airship", { sandbox_app_key: "a" }, { sandbox_token: "t" })).toBeNull();
    expect(INTEGRATIONS.find((s) => s.kind === "discord")!.fields.find((f) => f.key === "webhook_url")).toMatchObject({ type: "secret", url: true, required: true });
  });
  it("escapes Discord markdown and mentions", async () => {
    expect(discordEscape("@everyone <@123> **bold** [x](y)")).toBe("@\u200beveryone \\<@\u200b123\\> \\*\\*bold\\*\\* \\[x\\]\\(y\\)");
    const s = await sent("discord", { ...purchase, app_user_id: "@everyone", product_id: "<@&42>\nhi" }, {});
    const embed = s.requests[0]!.json.embeds[0];
    expect(embed.description).toBe("Customer [@\u200beveryone](https://app.revenuedot.app/projects/proj1/customers/%40everyone) started a subscription.");
    expect(embed.fields[0]).toEqual({ name: "Product", value: "\\<@\u200b&42\\> hi", inline: true });
    expect(s.requests[0]!.json.allowed_mentions).toEqual({ parse: [] });
    const paren = await sent("discord", { ...purchase, app_user_id: "a)b" });
    expect(paren.requests[0]!.json.embeds[0].description).toContain("(https://app.revenuedot.app/projects/proj1/customers/a%29b)");
  });
});
