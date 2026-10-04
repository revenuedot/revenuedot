import { describe, expect, it } from "vitest";
import { INTEGRATIONS, buildIntegration, fieldApplies, integrationSpec, type EventContext, type IntegrationKind, type WebhookEvent } from "../src/integrations/index.js";

/**
 * AppsFlyer web store purchases (Web S2S, the legacy PBA API, and the "Web store event routing" setting) and Meta's
 * App Events API, request by request. The rules follow RevenueCat's AppsFlyer and Meta Ads integrations:
 * https://www.revenuecat.com/docs/integrations/attribution/appsflyer, .../reference/appsflyer,
 * https://www.revenuecat.com/docs/integrations/attribution/meta-ads and .../reference/meta-ads.
 */

const at = (k: string, v: string) => ({ [k]: { value: v, updated_at_ms: 1789990000000 } });
const now = new Date("2026-10-03T10:00:00Z");
const base: WebhookEvent = {
  id: "EVT-WEB-1", type: "INITIAL_PURCHASE", event_timestamp_ms: 1790000000000, app_id: "app_web", app_user_id: "user_7", original_app_user_id: "$RCAnonymousID:a1",
  product_id: "pro_annual", period_type: "NORMAL", environment: "PRODUCTION", transaction_id: "in_1Pxyz", price: 59.99, price_in_purchased_currency: 59.99,
  commission_percentage: 0.03, tax_percentage: 0, store: "STRIPE", subscriber_attributes: { ...at("$ip", "198.51.100.4") },
};
const withAf: WebhookEvent = { ...base, subscriber_attributes: { ...base.subscriber_attributes, ...at("$appsflyerId", "1700000000000-999") } };
const ios: EventContext = { platform: "iOS", bundleId: "com.example.app", appVersion: "2.0", platformVersion: "18.1", locale: "en_US" };

const AF = {
  settings: { ios_app_id: "id123", android_app_id: "com.example.app", web_app_id: "web-sdk-uuid" },
  secrets: { dev_key: "af_dev_key", sandbox_dev_key: "af_sandbox_key", web_s2s_token: "af_web_token" },
};
async function plan(kind: IntegrationKind, event: WebhookEvent, cfg: { settings: Record<string, any>; secrets: Record<string, string> }, context?: EventContext, eventNames?: Record<string, string>) {
  return buildIntegration(kind, { event, settings: cfg.settings, secrets: cfg.secrets, context, eventNames, now });
}
async function one(kind: IntegrationKind, event: WebhookEvent, cfg: Parameters<typeof plan>[2], context?: EventContext, eventNames?: Record<string, string>) {
  const p = await plan(kind, event, cfg, context, eventNames);
  if ("skip" in p) throw new Error(`skipped: ${p.skip}`);
  expect(p.requests).toHaveLength(1);
  const r = p.requests[0]!;
  return { ...r, json: JSON.parse(r.body), name: p.name, redact: p.redact };
}
async function skipOf(kind: IntegrationKind, event: WebhookEvent, cfg: Parameters<typeof plan>[2], context?: EventContext) {
  const p = await plan(kind, event, cfg, context);
  return "skip" in p ? p.skip : null;
}
const af = (settings: Record<string, any> = {}, secrets: Record<string, string> = {}) => ({ settings: { ...AF.settings, ...settings }, secrets: { ...AF.secrets, ...secrets } });

describe("AppsFlyer web store purchases", () => {
  it("Web S2S: a Stripe purchase from a customer without an AppsFlyer id", async () => {
    const r = await one("appsflyer", base, af(), ios);
    expect(r.url).toBe("https://events.appsflyer.com/v2.0/s2s/inapps/app/web/web-sdk-uuid");
    expect(r.headers).toEqual({ "content-type": "application/json", authorization: "Bearer af_web_token" });
    expect(r.json).toEqual({
      user_id: { customer_user_id: "user_7" }, event_name: "rc_initial_purchase_event", event_revenue: 59.99, event_revenue_currency: "USD",
      event_value: { af_content_id: "pro_annual", renewal: "false", store: "STRIPE", af_order_id: "in_1Pxyz" },
      customer_dedup_id: "EVT-WEB-1", timestamp: 1790000000000, ip: "198.51.100.4",
    });
    expect(r.redact).toEqual(["af_web_token"]);
  });

  it("Web S2S follows the sales reporting mode, renewals and event name overrides", async () => {
    const r = await one("appsflyer", { ...base, type: "RENEWAL" }, af({ reporting: "proceeds" }), ios, { renewal: "web_renewal" });
    expect(r.json).toMatchObject({ event_name: "web_renewal", event_revenue: 58.1903, event_value: { renewal: "true" } });
    expect(r.name).toBe("web_renewal");
  });

  it("mobile S2S routing (the default): a customer with an AppsFlyer id goes to the app they last used", async () => {
    const r = await one("appsflyer", withAf, af(), ios);
    expect(r.url).toBe("https://api2.appsflyer.com/inappevent/id123");
    expect(r.headers.authentication).toBe("af_dev_key");
    expect(r.json).toMatchObject({ appsflyer_id: "1700000000000-999", customer_user_id: "user_7", eventName: "rc_initial_purchase_event", ip: "198.51.100.4" });
    expect(JSON.parse(r.json.eventValue)).toEqual({ af_revenue: "59.99", af_price: 59.99, renewal: "false", af_content_id: "pro_annual", af_currency: "USD", af_order_id: "in_1Pxyz" });
    expect((await one("appsflyer", withAf, af(), { platform: "android" })).url).toBe("https://api2.appsflyer.com/inappevent/com.example.app");
    // The context's bundle is the web app's, so it is not sent as the mobile app's bundleIdentifier.
    expect(r.json).not.toHaveProperty("bundleIdentifier");
    expect((await one("appsflyer", { ...withAf, store: "APP_STORE" }, af(), ios)).json.bundleIdentifier).toBe("com.example.app");
  });

  it("mobile S2S routing sends to the web API when the customer's last app has no app id or is unknown", async () => {
    expect((await one("appsflyer", withAf, af(), { platform: null })).url).toContain("events.appsflyer.com");
    expect((await one("appsflyer", withAf, af({ android_app_id: null }), { platform: "android" })).url).toContain("events.appsflyer.com");
  });

  it("web S2S routing sends every web purchase to the web API, even with an AppsFlyer id", async () => {
    const r = await one("appsflyer", withAf, af({ web_routing: "web_s2s" }), ios);
    expect(r.url).toBe("https://events.appsflyer.com/v2.0/s2s/inapps/app/web/web-sdk-uuid");
  });

  it("App Store and Play purchases are unaffected by web routing", async () => {
    const appStore = { ...withAf, store: "APP_STORE" };
    expect((await one("appsflyer", appStore, af({ web_routing: "web_s2s" }), ios)).url).toBe("https://api2.appsflyer.com/inappevent/id123");
    expect((await one("appsflyer", { ...withAf, store: "PLAY_STORE" }, af({ web_routing: "web_s2s" }), ios)).url).toBe("https://api2.appsflyer.com/inappevent/com.example.app");
  });

  it("PBA: Stripe purchases with the dev key in the body", async () => {
    const cfg = af({ web_app_id: null, web_pba_bundle_id: "0f6c-bundle" }, { web_s2s_token: "", web_pba_dev_key: "pba_dev_key" });
    const r = await one("appsflyer", base, cfg, ios);
    expect(r.url).toBe("https://webs2s.appsflyer.com/v1/0f6c-bundle/event");
    expect(r.headers).toEqual({ "content-type": "application/json" });
    expect(r.json).toEqual({
      customerUserId: "user_7", webDevKey: "pba_dev_key", eventType: "EVENT", eventName: "rc_initial_purchase_event", eventRevenue: 59.99, eventRevenueCurrency: "USD",
      eventValue: { af_revenue: "59.99", af_price: 59.99, renewal: "false", af_content_id: "pro_annual", af_currency: "USD", af_order_id: "in_1Pxyz" },
      timestamp: 1790000000000, ip: "198.51.100.4",
    });
    expect(r.redact).toEqual(["pba_dev_key"]);
  });

  it("Web S2S wins over PBA when both are set", async () => {
    const r = await one("appsflyer", base, af({ web_pba_bundle_id: "0f6c-bundle" }, { web_pba_dev_key: "pba_dev_key" }), ios);
    expect(r.url).toContain("events.appsflyer.com");
  });

  it("PBA takes Stripe only: Paddle and Web Billing fall back to mobile S2S, or are skipped", async () => {
    const cfg = af({ web_app_id: null, web_pba_bundle_id: "0f6c-bundle" }, { web_s2s_token: "", web_pba_dev_key: "pba_dev_key" });
    expect((await one("appsflyer", { ...withAf, store: "PADDLE" }, cfg, ios)).url).toBe("https://api2.appsflyer.com/inappevent/id123");
    expect(await skipOf("appsflyer", { ...base, store: "RC_BILLING" }, cfg, ios)).toBe("RC_BILLING purchases need AppsFlyer's Web S2S API (Web SDK ID and Web S2S token), or a customer with an $appsflyerId who last used the iOS or Android app.");
  });

  it("no web API configured: falls back to mobile S2S, else skips with the reason", async () => {
    const cfg = af({ web_app_id: null }, { web_s2s_token: "" });
    expect((await one("appsflyer", withAf, { ...cfg, settings: { ...cfg.settings, web_routing: "web_s2s" } }, ios)).url).toBe("https://api2.appsflyer.com/inappevent/id123");
    expect(await skipOf("appsflyer", base, cfg, ios)).toBe("STRIPE purchases need AppsFlyer's Web S2S API (Web SDK ID and Web S2S token, or the PBA bundle ID and web dev key), or a customer with an $appsflyerId who last used the iOS or Android app.");
    // A Web SDK ID without its token is not a web route.
    expect(await skipOf("appsflyer", base, af({}, { web_s2s_token: "" }), ios)).toMatch(/^STRIPE purchases need/);
  });

  it("sandbox web purchases never use the web APIs: mobile S2S with the sandbox key, or skipped", async () => {
    const sandbox = { ...withAf, environment: "SANDBOX" };
    const r = await one("appsflyer", sandbox, af({ web_routing: "web_s2s" }), ios);
    expect([r.url, r.headers.authentication]).toEqual(["https://api2.appsflyer.com/inappevent/id123", "af_sandbox_key"]);
    expect(await skipOf("appsflyer", { ...base, environment: "SANDBOX" }, af(), ios)).toMatch(/^Sandbox web purchases are sent only through AppsFlyer's mobile API/);
    expect(await skipOf("appsflyer", sandbox, af({}, { sandbox_dev_key: "" }), ios)).toBe("Sandbox events need a sandbox developer key.");
  });

  it("funnel events keep using the Web S2S API exactly as before", async () => {
    const funnel = { ...base, type: "FUNNEL_VIEWED", funnel_id: "f1", funnel_name: "Quiz" };
    const r = await one("appsflyer", funnel, af({ web_routing: "mobile_s2s" }), ios);
    expect(r.url).toBe("https://events.appsflyer.com/v2.0/s2s/inapps/app/web/web-sdk-uuid");
    expect(r.json).toMatchObject({ event_name: "rd_funnel_viewed", user_id: { customer_user_id: "user_7" } });
    expect(r.json).not.toHaveProperty("customer_dedup_id");
  });
});

const META_AE = { settings: { api: "app_events", app_id: "111222", sandbox_app_id: "333444" }, secrets: { client_token: "ct_live", sandbox_client_token: "ct_sbx" } };
const iosPurchase: WebhookEvent = {
  ...base, store: "APP_STORE", transaction_id: "2000000999", price: 9.99,
  subscriber_attributes: {
    ...at("$fbAnonId", "XZanon"), ...at("$idfa", "AEBE52E7-03EE-455A-B3C4-E57283966239"), ...at("$attConsentStatus", "authorized"), ...at("$ip", "203.0.113.9"),
    ...at("$email", " Wren@Example.com "), ...at("$phoneNumber", "+1 (555) 010-0199"),
  },
};

describe("Meta App Events API", () => {
  it("sends CUSTOM_APP_EVENTS to the app's activities endpoint with the client token", async () => {
    const r = await one("meta", iosPurchase, META_AE, { ...ios, bundleId: "com.example.app" });
    expect(r.url).toBe("https://graph.facebook.com/v21.0/111222/activities");
    expect(r.headers).toEqual({ "content-type": "application/json", "x-forwarded-for": "203.0.113.9" });
    expect(r.json).toEqual({
      event: "CUSTOM_APP_EVENTS", advertiser_tracking_enabled: "1", application_tracking_enabled: "1", app_user_id: "user_7", client_token: "ct_live",
      advertiser_id: "AEBE52E7-03EE-455A-B3C4-E57283966239",
      custom_events: [{ _eventName: "Subscribe", fb_content: [{ id: "pro_annual", quantity: 1 }], _valueToSum: 9.99, fb_content_type: "product", fb_currency: "USD", fb_order_id: "2000000999", _logTime: 1790000000 }],
      ud: { em: "4be15ac83ae8c671231bdfc73fb0ee64f45e57cbbb1af848ea24cf6d0c24b65b", ph: "90be998a6e4b5bec4f18e14bc56a618ba6dd57100b89276067e3a77ff7140b4a" },
      extinfo: ["i2", "com.example.app", "", "2.0", "18.1", "", "en_US", "", "", 0, 0, "", 0, 0, 0, ""],
    });
    expect(r.redact).toEqual(["ct_live"]);
  });

  it("sends anon_id when there is no valid advertising id, and the same event names as the Conversions API", async () => {
    const attrs = { ...iosPurchase.subscriber_attributes, ...at("$idfa", "00000000-0000-0000-0000-000000000000") };
    const r = await one("meta", { ...iosPurchase, period_type: "TRIAL", price: 0, subscriber_attributes: attrs }, META_AE, ios);
    expect(r.json.anon_id).toBe("XZanon");
    expect(r.json).not.toHaveProperty("advertiser_id");
    expect(r.json.custom_events[0]).toMatchObject({ _eventName: "StartTrial", _valueToSum: 0 });
    expect((await one("meta", { ...iosPurchase, type: "NON_RENEWING_PURCHASE" }, META_AE, ios)).name).toBe("fb_mobile_purchase");
    expect((await one("meta", iosPurchase, META_AE, ios, { initial_purchase: "Purchase" })).json.custom_events[0]._eventName).toBe("Purchase");
  });

  it("App Store needs ATT consent with no override; Play needs $fbAnonId or a Google advertising id", async () => {
    const noAtt = { ...iosPurchase, subscriber_attributes: { ...iosPurchase.subscriber_attributes, ...at("$attConsentStatus", "denied") } };
    expect(await skipOf("meta", noAtt, { ...META_AE, settings: { ...META_AE.settings, send_without_att: true } }, ios)).toBe("App Store customers need $attConsentStatus = authorized for Meta's App Events API.");
    const play: WebhookEvent = { ...iosPurchase, store: "PLAY_STORE", subscriber_attributes: { ...at("$gpsAdId", "38400000-8cf0-11bd-b23e-10b96e40000d") } };
    const r = await one("meta", play, META_AE, { platform: "android", bundleId: "com.example.app" });
    expect(r.json.advertiser_id).toBe("38400000-8cf0-11bd-b23e-10b96e40000d");
    expect(r.json.extinfo[0]).toBe("a2");
    expect(r.headers).not.toHaveProperty("x-forwarded-for");
    expect(await skipOf("meta", { ...play, subscriber_attributes: { ...at("$gpsAdId", "00000000-0000-0000-0000-000000000000") } }, META_AE)).toBe("The customer has no $fbAnonId or advertising id, so Meta cannot match the event.");
  });

  it("sandbox events go to the sandbox app; without one they are skipped", async () => {
    const r = await one("meta", { ...iosPurchase, environment: "SANDBOX" }, META_AE, ios);
    expect([r.url, r.json.client_token, r.redact]).toEqual(["https://graph.facebook.com/v21.0/333444/activities", "ct_sbx", ["ct_sbx"]]);
    expect(await skipOf("meta", { ...iosPurchase, environment: "SANDBOX" }, { ...META_AE, settings: { api: "app_events", app_id: "111222" } }, ios)).toBe("Sandbox events need a sandbox app ID and client token.");
    expect(await skipOf("meta", iosPurchase, { settings: { api: "app_events" }, secrets: {} }, ios)).toBe("No Meta app ID and client token are saved.");
  });

  it("test events go only to the sandbox app (the API has no test mode)", async () => {
    const test = { ...iosPurchase, type: "TEST" };
    expect(await skipOf("meta", test, META_AE, ios)).toMatch(/^Meta's App Events API has no test mode/);
    expect((await one("meta", { ...test, environment: "SANDBOX" }, META_AE, ios)).url).toBe("https://graph.facebook.com/v21.0/333444/activities");
  });

  it("web funnel events are skipped, even with a dataset saved before the switch to the App Events API", async () => {
    const funnel = { ...base, type: "FUNNEL_VIEWED" };
    expect(await skipOf("meta", funnel, META_AE)).toMatch(/^Web funnel events are website events, which Meta takes only through the Conversions API/);
    const stale = { settings: { ...META_AE.settings, dataset_id: "999" }, secrets: { ...META_AE.secrets, access_token: "EAA_old" } };
    expect(await skipOf("meta", funnel, stale)).toMatch(/^Web funnel events are website events/);
  });

  it("web store purchases are not sent to the App Events API, which takes app events only", async () => {
    expect(await skipOf("meta", { ...iosPurchase, store: "STRIPE" }, META_AE, ios)).toBe("STRIPE purchases are web purchases, which Meta's App Events API does not take: it reports app events only.");
  });

  it("the Conversions API also sends X-Forwarded-For with $ip", async () => {
    const r = await one("meta", iosPurchase, { settings: { dataset_id: "999" }, secrets: { access_token: "EAA_tok" } }, ios);
    expect(r.url).toBe("https://graph.facebook.com/v21.0/999/events");
    expect(r.headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(r.json.data[0].user_data.client_ip_address).toBe("203.0.113.9");
  });
});

describe("catalogue: fields that depend on a select", () => {
  const meta = integrationSpec("meta")!;
  const field = (k: string) => meta.fields.find((f) => f.key === k)!;
  it("an unset select counts as its first option", () => {
    expect(fieldApplies(meta, field("dataset_id"), {})).toBe(true);
    expect(fieldApplies(meta, field("app_id"), {})).toBe(false);
    expect(fieldApplies(meta, field("dataset_id"), { api: "app_events" })).toBe(false);
    expect(fieldApplies(meta, field("client_token"), { api: "app_events" })).toBe(true);
    expect(fieldApplies(meta, field("reporting"), { api: "app_events" })).toBe(true);
  });
  it("every `when` points at a select field of the same integration with that option", () => {
    for (const s of INTEGRATIONS) for (const f of s.fields) {
      if (!f.when) continue;
      const dep = s.fields.find((x) => x.key === f.when!.key);
      expect(dep?.type, `${s.kind}.${f.key}`).toBe("select");
      expect(dep!.options!.map((o) => o.value), `${s.kind}.${f.key}`).toContain(f.when.value);
    }
  });
  it("AppsFlyer has the web routing setting with Mobile S2S first (the default)", () => {
    const routing = integrationSpec("appsflyer")!.fields.find((f) => f.key === "web_routing")!;
    expect(routing.options!.map((o) => o.value)).toEqual(["mobile_s2s", "web_s2s"]);
    expect(integrationSpec("appsflyer")!.fields.find((f) => f.key === "web_pba_dev_key")!.type).toBe("secret");
  });
});
