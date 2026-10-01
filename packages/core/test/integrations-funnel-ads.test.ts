import { describe, expect, it } from "vitest";
import { buildIntegration, sha256Hex, type IntegrationKind, type WebhookEvent } from "../src/integrations/index.js";

/** Funnel events to ad networks (prd/integrations/PRD.md "Funnel events to ad networks"): the exact web requests. */

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)";
const purchase: WebhookEvent = {
  id: "F0000000-0000-4000-8000-000000000001", type: "FUNNEL_PURCHASE", event_timestamp_ms: 1790000000000, app_id: "app_web", app_user_id: "$RCAnonymousID:abc",
  aliases: ["$RCAnonymousID:abc"], environment: "PRODUCTION", store: "STRIPE", funnel_id: "fnl_1", funnel_name: "Focus quiz", funnel_slug: "focus-quiz", session_id: "s1",
  step_id: null, step_type: null, step_index: null, answer: null, utm_source: "facebook", click_ids: { fbclid: "IwAR3abc", gclid: "Cj0" },
  client_ip: "203.0.113.9", client_user_agent: UA, page_url: "https://pay.example.com/scanner/focus-quiz", product_id: "price_annual", subscriber_attributes: {}, revenue_usd: 59.99, currency: "USD",
};
const now = new Date("2026-09-21T14:13:21Z");
const sent = async (kind: IntegrationKind, settings: Record<string, any>, secrets: Record<string, string>, event = purchase) => {
  const p = await buildIntegration(kind, { event, settings, secrets, now });
  if ("skip" in p) throw new Error(p.skip);
  return { name: p.name, url: p.requests[0]!.url, headers: p.requests[0]!.headers, body: JSON.parse(p.requests[0]!.body) };
};

describe("funnel events to ad networks", () => {
  it("Meta: a website Purchase with fbc, the browser and external_id", async () => {
    const r = await sent("meta", { dataset_id: "111" }, { access_token: "EAAB" });
    expect(r).toEqual({
      name: "Purchase", url: "https://graph.facebook.com/v21.0/111/events", headers: { "content-type": "application/json" },
      body: {
        access_token: "EAAB", partner_agent: "revenuedot",
        data: [{
          event_name: "Purchase", event_time: 1790000000, event_id: purchase.id, action_source: "website", event_source_url: "https://pay.example.com/scanner/focus-quiz",
          user_data: { external_id: [await sha256Hex("$RCAnonymousID:abc")], client_user_agent: UA, client_ip_address: "203.0.113.9", fbc: "fb.1.1790000000000.IwAR3abc" },
          custom_data: { content_name: "Focus quiz", content_category: "funnel", funnel_id: "fnl_1", currency: "USD", value: 59.99, content_type: "product", content_ids: ["price_annual"] },
        }],
      },
    });
    const noBrowser = await buildIntegration("meta", { event: { ...purchase, client_user_agent: null }, settings: { dataset_id: "111" }, secrets: { access_token: "EAAB" }, now });
    expect("skip" in noBrowser && noBrowser.skip).toMatch(/user agent and page URL/);
  });

  it("Google Tag Manager: GA4 purchase with the landing page, utm and gclid", async () => {
    const r = await sent("google_tag_manager", { server_container_url: "https://sgtm.example.com", measurement_id: "G-ABC" }, {});
    expect(r.url).toBe("https://sgtm.example.com/mp/collect?measurement_id=G-ABC");
    expect(r.body).toEqual({
      client_id: "$RCAnonymousID:abc", user_id: "$RCAnonymousID:abc", timestamp_micros: 1790000000000000,
      events: [{ name: "purchase", params: {
        event_id: purchase.id, event_type: "FUNNEL_PURCHASE", product_id: "price_annual", environment: "PRODUCTION", store: "STRIPE", app_id: "app_web",
        page_location: "https://pay.example.com/scanner/focus-quiz?utm_source=facebook&gclid=Cj0", funnel_id: "fnl_1", funnel_name: "Focus quiz",
        currency: "USD", value: 59.99, transaction_id: purchase.id, items: [{ item_id: "price_annual", item_name: "price_annual", affiliation: "STRIPE", price: 59.99, quantity: 1 }],
      } }],
    });
  });

  it("Branch: a web PURCHASE with developer_identity and the browser", async () => {
    const r = await sent("branch", {}, { branch_key: "key_live_x" });
    expect(r).toEqual({
      name: "PURCHASE", url: "https://api2.branch.io/v2/event/standard", headers: { "content-type": "application/json", accept: "application/json" },
      body: {
        name: "PURCHASE", branch_key: "key_live_x",
        user_data: { developer_identity: "$RCAnonymousID:abc", user_agent: UA, ip: "203.0.113.9", http_origin: "https://pay.example.com/scanner/focus-quiz" },
        custom_data: { event_id: purchase.id, event_type: "FUNNEL_PURCHASE", funnel_id: "fnl_1", funnel_name: "Focus quiz", product_id: "price_annual", utm_source: "facebook", fbclid: "IwAR3abc", gclid: "Cj0" },
        event_data: { transaction_id: purchase.id, currency: "USD", revenue: 59.99, description: "price_annual" },
      },
    });
  });

  it("AppsFlyer: the Web S2S API with the customer user id", async () => {
    const r = await sent("appsflyer", { web_app_id: "web-1" }, { dev_key: "d", web_s2s_token: "tok" });
    expect(r).toEqual({
      name: "rd_funnel_purchase", url: "https://events.appsflyer.com/v2.0/s2s/inapps/app/web/web-1", headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: {
        event_name: "rd_funnel_purchase", user_id: { customer_user_id: "$RCAnonymousID:abc" }, event_revenue: 59.99, event_revenue_currency: "USD",
        event_value: { event_id: purchase.id, funnel_id: "fnl_1", funnel_name: "Focus quiz", step_id: null, step_type: null, product_id: "price_annual", utm_source: "facebook", fbclid: "IwAR3abc", gclid: "Cj0" },
      },
    });
    expect(await buildIntegration("appsflyer", { event: purchase, settings: {}, secrets: { dev_key: "d" }, now })).toEqual({ skip: "Funnel events need the AppsFlyer web app ID and Web S2S token." });
  });
});

describe("visitor data and secrets in funnel deliveries", () => {
  it("webhook adapter partners never get the visitor's IP address or user agent", async () => {
    for (const kind of ["appstack", "superwall", "splitmetrics", "solarengine"] as IntegrationKind[]) {
      const urlIsSecret = kind !== "appstack";
      const url = "https://partner.example.com/rc";
      const p = await buildIntegration(kind, { event: purchase, settings: urlIsSecret ? {} : { webhook_url: url }, secrets: urlIsSecret ? { webhook_url: url } : { authorization: "a" }, now });
      if ("skip" in p) throw new Error(p.skip);
      const body = JSON.parse(p.requests[0]!.body);
      expect(body.event, kind).not.toHaveProperty("client_ip");
      expect(body.event, kind).not.toHaveProperty("client_user_agent");
      expect(body.event, kind).toMatchObject({ type: "FUNNEL_PURCHASE", page_url: purchase.page_url, click_ids: purchase.click_ids });
    }
    expect(purchase.client_ip).toBe("203.0.113.9");
  });

  it("scrubs a query-string secret in the form URLSearchParams writes it", async () => {
    const secret = "gtm secret~!'()*";
    const p = await buildIntegration("google_tag_manager", { event: purchase, settings: { server_container_url: "https://sgtm.example.com", measurement_id: "G-ABC" }, secrets: { api_secret: secret }, now });
    if ("skip" in p) throw new Error(p.skip);
    let url = p.requests[0]!.url;
    for (const v of p.redact) url = url.split(v).join("[redacted]");
    expect(url).toBe("https://sgtm.example.com/mp/collect?measurement_id=G-ABC&api_secret=[redacted]");
  });
});
