import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { tick } from "../src/services/tick.js";
import { getOrCreateCustomer, setAttributes } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import type { VerifiedSubscription } from "../src/stores/types.js";

/**
 * AppsFlyer web store purchases and Meta's App Events API through the real sender (PGlite, sealed secrets, a fake
 * partner fetch): the request each partner gets, and a delivery log with every credential scrubbed. Also the settings
 * rule that a required field is required only while the select it depends on shows it.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

interface Seen { method: string; url: string; headers: Headers; body: string }
function fake() {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    seen.push({ method: (init.method ?? "GET").toUpperCase(), url: String(input), headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" });
    return new Response('{"status":"ok"}', { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}
function api() {
  const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY });
  return async (method: string, path: string, json?: unknown) => {
    const res = await app.fetch(new Request(`http://localhost/v2/projects/proj1${path}`, {
      method, headers: { Authorization: `Bearer ${h.ids.secretKey}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    }));
    return { status: res.status, body: await res.json() as any };
  };
}
const run = (f: typeof fetch) => tick(h.db, h.now(), f, { encryptionKey: KEY, publicUrl: "https://app.example.com" });

async function buy(user: string, store: VerifiedSubscription["store"], attributes: Record<string, string>) {
  const now = h.now();
  const { customer } = await getOrCreateCustomer(h.db, "proj1", user, now);
  await setAttributes(h.db, customer.id, Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, { value: v }])), now);
  const sub: VerifiedSubscription = {
    kind: "subscription", store, storeKey: `orig_${user}`, productIdentifier: "pro_monthly", isSandbox: false, purchaseDate: now, originalPurchaseDate: now,
    expiresDate: new Date(now.getTime() + 30 * 86400_000), periodType: "normal", storeTransactionId: `tx_${user}`, originalTransactionId: `orig_${user}`,
    price: { amount: 9.99, currency: "USD" }, countryCode: "US",
  };
  await applyPurchases(h.db, customer, [sub], { projectId: "proj1", appId: "app_ios", appUserId: user, now, fromDevice: false });
}

describe("AppsFlyer web store purchases through the sender", () => {
  it("a Stripe purchase goes to the Web S2S API; a PBA purchase keeps its dev key out of the log", async () => {
    const call = api();
    const res = await call("POST", "/integrations/partners", {
      type: "appsflyer", settings: { dev_key: "af_dev_key_1234", web_app_id: "web-sdk-id", web_s2s_token: "af_web_token_5678", web_routing: "web_s2s" },
    });
    expect(res.status).toBe(201);
    expect(res.body.settings).toMatchObject({ web_app_id: "web-sdk-id", web_routing: "web_s2s" });
    expect(res.body.secrets.web_s2s_token).toEqual({ configured: true, hint: "••••5678" });
    await buy("web_1", "stripe", { $appsflyerId: "af-1", $ip: "198.51.100.4" });
    const { f, seen } = fake();
    await run(f);
    const web = seen.find((s) => s.url.startsWith("https://events.appsflyer.com/"))!;
    expect(web.url).toBe("https://events.appsflyer.com/v2.0/s2s/inapps/app/web/web-sdk-id");
    expect(web.headers.get("authorization")).toBe("Bearer af_web_token_5678");
    expect(JSON.parse(web.body)).toMatchObject({ user_id: { customer_user_id: "web_1" }, event_name: "rc_initial_purchase_event", event_revenue: 9.99, event_value: { store: "STRIPE", af_order_id: "tx_web_1" }, ip: "198.51.100.4" });
    const [d] = (await call("GET", `/integrations/partners/${res.body.id}/deliveries`)).body.items;
    expect(d).toMatchObject({ status: "delivered", request: "POST https://events.appsflyer.com/v2.0/s2s/inapps/app/web/web-sdk-id" });
    expect(JSON.stringify(d)).not.toContain("af_web_token");

    // The legacy PBA API: the dev key travels in the body, and the log shows it redacted.
    await call("POST", `/integrations/partners/${res.body.id}`, { settings: { web_app_id: null, web_s2s_token: null, web_pba_bundle_id: "pba-bundle", web_pba_dev_key: "pba_dev_key_9012" } });
    await buy("web_2", "stripe", { $ip: "198.51.100.5" });
    await run(f);
    const pba = seen.find((s) => s.url.startsWith("https://webs2s.appsflyer.com/"))!;
    expect(pba.url).toBe("https://webs2s.appsflyer.com/v1/pba-bundle/event");
    expect(JSON.parse(pba.body)).toMatchObject({ customerUserId: "web_2", webDevKey: "pba_dev_key_9012", eventType: "EVENT", eventRevenue: 9.99 });
    const items = (await call("GET", `/integrations/partners/${res.body.id}/deliveries`)).body.items;
    const row = items.find((x: any) => x.request?.includes("webs2s"));
    expect(row.request_body).toContain('"webDevKey":"[redacted]"');
    const detail = (await call("GET", `/integrations/partners/${res.body.id}/deliveries/${row.id}`)).body;
    expect(JSON.stringify(detail)).not.toContain("pba_dev_key_9012");
    expect(detail.curl).toContain("https://webs2s.appsflyer.com/v1/pba-bundle/event");
  });

  it("each web API needs its ID and its credential together", async () => {
    const call = api();
    const make = (settings: Record<string, unknown>) => call("POST", "/integrations/partners", { type: "appsflyer", settings: { dev_key: "af_dev_key_1234", ios_app_id: "id1", ...settings } });
    expect((await make({ web_pba_bundle_id: "pba-bundle" })).body.param).toBe("settings.web_pba_dev_key");
    expect((await make({ web_pba_dev_key: "pba_dev_key_9012" })).body.param).toBe("settings.web_pba_bundle_id");
    expect((await make({ web_app_id: "web-sdk-id" })).body.param).toBe("settings.web_s2s_token");
    expect((await make({ web_s2s_token: "af_web_token_5678" })).body.param).toBe("settings.web_app_id");
    expect((await make({ web_pba_bundle_id: "pba-bundle", web_pba_dev_key: "pba_dev_key_9012" })).status).toBe(201);
  });
});

describe("Meta App Events API through the sender", () => {
  it("validates per integration type, sends to /activities with X-Forwarded-For, and scrubs the client token", async () => {
    const call = api();
    // Conversions API (the default) still needs its dataset and token.
    const bad = await call("POST", "/integrations/partners", { type: "meta", settings: { access_token: "EAA_x" } });
    expect([bad.status, bad.body.param]).toEqual([400, "settings.dataset_id"]);
    // App Events needs the app id and client token, and no dataset.
    const noApp = await call("POST", "/integrations/partners", { type: "meta", settings: { api: "app_events", client_token: "ct_live_secret" } });
    expect([noApp.status, noApp.body.param]).toEqual([400, "settings.app_id"]);
    const res = await call("POST", "/integrations/partners", { type: "meta", settings: { api: "app_events", app_id: "555666", client_token: "ct_live_secret" } });
    expect(res.status).toBe(201);
    // Switching back to the Conversions API without a dataset is refused.
    expect((await call("POST", `/integrations/partners/${res.body.id}`, { settings: { api: "conversions" } })).body.param).toBe("settings.dataset_id");
    // The sandbox app ID and its client token go together.
    expect((await call("POST", `/integrations/partners/${res.body.id}`, { settings: { sandbox_app_id: "777888" } })).body.param).toBe("settings.sandbox_client_token");
    expect((await call("POST", `/integrations/partners/${res.body.id}`, { settings: { sandbox_client_token: "ct_sbx_secret" } })).body.param).toBe("settings.sandbox_app_id");

    await buy("meta_1", "app_store", { $fbAnonId: "fb-anon-1", $attConsentStatus: "authorized", $ip: "203.0.113.20" });
    const { f, seen } = fake();
    await run(f);
    const r = seen.find((s) => s.url.includes("graph.facebook.com"))!;
    expect(r.url).toBe("https://graph.facebook.com/v21.0/555666/activities");
    expect(r.headers.get("x-forwarded-for")).toBe("203.0.113.20");
    expect(JSON.parse(r.body)).toMatchObject({ event: "CUSTOM_APP_EVENTS", app_user_id: "meta_1", client_token: "ct_live_secret", anon_id: "fb-anon-1", custom_events: [{ _eventName: "Subscribe", _valueToSum: 9.99 }] });
    const [d] = (await call("GET", `/integrations/partners/${res.body.id}/deliveries`)).body.items;
    expect(d).toMatchObject({ status: "delivered", sent_as: "Subscribe", request: "POST https://graph.facebook.com/v21.0/555666/activities" });
    expect(d.request_body).toContain('"client_token":"[redacted]"');
    const detail = (await call("GET", `/integrations/partners/${res.body.id}/deliveries/${d.id}`)).body;
    expect(JSON.stringify(detail)).not.toContain("ct_live_secret");
    expect(detail.curl).toContain("https://graph.facebook.com/v21.0/555666/activities");
  });
});
