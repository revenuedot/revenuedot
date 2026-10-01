import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createSecretKey } from "../src/services/auth.js";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { APP_ID, T0, appleHarness, makeP8, makePki, signJws, type AppleHarness, type Pki } from "./apple-fixtures.js";

/** Retention (prd/lifecycle/PRD.md): Customer Center offers in the SDK config, and Apple's Retention Messaging API. */

describe("Customer Center retention offers", () => {
  let h: Harness;
  afterEach(async () => { await h.close(); });

  it("puts the cancel and refund offers on the CANCEL and REFUND_REQUEST paths the SDKs decode", async () => {
    h = await harness();
    const post = (json: unknown) => h.fetch("/v2/projects/proj1/retention_offers", { method: "POST", key: h.ids.secretKey, json });
    const before = await (await h.fetch("/v1/customercenter/anyone")).json() as any;
    expect(before.customer_center.screens.MANAGEMENT.paths.find((p: any) => p.type === "CANCEL").promotional_offer).toBeUndefined();

    const cancel = await post({ trigger: "cancel", name: "Cancellation discount", title: "Stay for 50% off", subtitle: "Three months at half price", store: "app_store", product_mapping: { pro_monthly: "stay_50", pro_annual: "stay_annual" } });
    expect(cancel.status).toBe(201);
    expect(await post({ trigger: "cancel", name: "Android", title: "Stay", store: "play_store", product_mapping: { "pro:monthly": "stay-offer" } })).toHaveProperty("status", 201);
    expect(await post({ trigger: "refund", name: "Refund discount", title: "Before you go", subtitle: "A free month instead", store: "app_store", product_mapping: { pro_monthly: "free_month" } })).toHaveProperty("status", 201);
    expect((await post({ trigger: "cancel", name: "No products", title: "x", store: "app_store", product_mapping: {} })).status).toBe(400);

    const cc = (await (await h.fetch("/v1/customercenter/anyone")).json() as any).customer_center;
    const path = (type: string) => cc.screens.MANAGEMENT.paths.find((p: any) => p.type === type);
    expect(path("CANCEL").promotional_offer).toEqual({
      ios_offer_id: "stay_annual", android_offer_id: "stay-offer", eligible: true, title: "Stay for 50% off", subtitle: "Three months at half price",
      product_mapping: { pro_monthly: "stay_50", pro_annual: "stay_annual", "pro:monthly": "stay-offer" },
    });
    expect(path("REFUND_REQUEST").promotional_offer).toMatchObject({ ios_offer_id: "free_month", android_offer_id: "", title: "Before you go", product_mapping: { pro_monthly: "free_month" } });
    expect(path("MISSING_PURCHASE").promotional_offer).toBeUndefined();

    // Turning an offer off removes it from the SDK config.
    const id = (cancel.status === 201 ? await cancel.json() as any : null).id;
    await h.fetch(`/v2/projects/proj1/retention_offers/${id}`, { method: "POST", key: h.ids.secretKey, json: { active: false } });
    const after = (await (await h.fetch("/v1/customercenter/anyone")).json() as any).customer_center;
    expect(after.screens.MANAGEMENT.paths.find((p: any) => p.type === "CANCEL").promotional_offer.ios_offer_id).toBe("");
    const list = await (await h.fetch("/v2/projects/proj1/retention_offers", { key: h.ids.secretKey })).json() as any;
    expect(list.items.map((o: any) => [o.trigger, o.active])).toEqual([["cancel", false], ["cancel", true], ["refund", true]]);
  });
});

describe("Apple Retention Messaging", () => {
  let pki: Pki;
  let h: AppleHarness | undefined;
  beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
  afterAll(() => setAppleRootsForTesting(null));
  afterEach(async () => { await h?.close(); h = undefined; });

  const TEXT = "11111111-2222-4333-8444-555555555555", SWITCH = "21111111-2222-4333-8444-555555555555", PROMO = "31111111-2222-4333-8444-555555555555";
  const messages = [
    { id: TEXT, kind: "text", header: "Your scans stay unlimited", body: "Keep unlimited scans, OCR and cloud backup." },
    { id: SWITCH, kind: "switch_plan", header: "Pay less per month", body: "Switch to annual and save 40%.", alternate_product_id: "pro_annual" },
    { id: PROMO, kind: "promotional_offer", header: "Half price for 3 months", body: "Stay and pay 50% less.", promotional_offer_id: "stay_50" },
  ];

  function fakeApple() {
    const calls: { method: string; url: string; body: any }[] = [];
    let uploadStatus = 200;
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("/messaging/message/")) return new Response(uploadStatus === 200 ? null : JSON.stringify({ errorCode: 4090001, errorMessage: "Message already exists." }), { status: uploadStatus });
      if (url.includes("/messaging/")) return new Response(null, { status: 200 });
      return new Response("{}", { status: 404 });
    };
    return { fetch, calls, setUploadStatus: (s: number) => { uploadStatus = s; } };
  }

  async function setup() {
    const apple = fakeApple();
    h = await appleHarness({ fetch: apple.fetch, credentials: { key_id: "KEY123", issuer_id: "issuer", private_key: await makeP8(), app_apple_id: "1234567890" } });
    const { key } = await createSecretKey(h.db, "proj1", "retention");
    const call = (path: string, json?: unknown) => h!.request(`/v2/projects/proj1/apps/${APP_ID}/retention_messaging${path}`, {
      method: json === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json),
    });
    return { apple, call };
  }
  const realtime = async (over: Record<string, unknown> = {}) => {
    const payload = { originalTransactionId: "2000000001", appAppleId: 1234567890, productId: "pro_monthly", userLocale: "en-US", requestIdentifier: crypto.randomUUID(), environment: "Sandbox", signedDate: T0, ...over };
    return h!.request(`/v1/retention/apple/${APP_ID}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload: await signJws(payload, pki) }) });
  };

  it("validates messages against Apple's limits and rules", async () => {
    const { call } = await setup();
    expect((await call("", { messages: [{ ...messages[0], header: "x".repeat(67) }] })).status).toBe(400);
    expect((await call("", { messages: [{ ...messages[0], id: "not-a-uuid" }] })).status).toBe(400);
    expect((await call("", { messages: [{ ...messages[1], alternate_product_id: null }] })).status).toBe(400);
    expect((await call("", { messages, defaults: [{ product_id: "pro_monthly", locale: "en-US", message_id: PROMO }] })).status).toBe(400);
    expect((await call("", { messages, rules: [{ product_id: null, message_id: "41111111-2222-4333-8444-555555555555" }] })).status).toBe(400);
    const ok = await call("", { enabled: true, messages, defaults: [{ product_id: "pro_monthly", locale: "en-US", message_id: TEXT }], rules: [{ product_id: null, message_id: TEXT }] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ object: "retention_messaging", enabled: true, realtime_url: `http://localhost/v1/retention/apple/${APP_ID}`, app_apple_id: "1234567890", has_in_app_purchase_key: true });
  });

  it("answers Apple's real-time call with a message, a switch plan or a signed promotional offer, and {} when off", async () => {
    const { call } = await setup();
    expect((await realtime()).status).toBe(200);
    expect(await (await realtime()).json()).toEqual({});
    await call("", { enabled: true, messages, rules: [{ product_id: "pro_annual", message_id: SWITCH }, { product_id: "pro_monthly", message_id: PROMO }, { product_id: null, message_id: TEXT }] });

    expect(await (await realtime({ productId: "pro_weekly" })).json()).toEqual({ message: { messageIdentifier: TEXT } });
    expect(await (await realtime({ productId: "pro_annual" })).json()).toEqual({ alternateProduct: { messageIdentifier: SWITCH, productId: "pro_annual" } });
    const promo = await (await realtime({ productId: "pro_monthly" })).json() as any;
    expect(promo.promotionalOffer).toMatchObject({ messageIdentifier: PROMO, promotionalOfferSignatureV1: { productId: "pro_monthly", offerIdentifier: "stay_50", keyId: "KEY123", timestamp: T0 } });
    expect(promo.promotionalOffer.promotionalOfferSignatureV1.encodedSignature).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(promo.promotionalOffer.promotionalOfferSignatureV1.nonce).toMatch(/^[0-9a-f-]{36}$/);

    // Requests for another app, or not signed by Apple, get no answer.
    expect((await realtime({ appAppleId: 999 })).status).toBe(400);
    const forged = await h!.request(`/v1/retention/apple/${APP_ID}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload: "a.b.c" }) });
    expect(forged.status).toBe(400);

    const [app] = await h!.db.select().from(schema.apps).where(eq(schema.apps.id, APP_ID));
    expect((app!.retentionMessaging as any).stats).toMatchObject({ requests: 5, answered: 3, last_environment: "Sandbox", last_request_at: T0 });
  });

  it("refuses replayed, Xcode-signed or unbound production requests, and answers {} when the offer cannot be signed", async () => {
    const { call } = await setup();
    await call("", { enabled: true, messages, rules: [{ product_id: "pro_monthly", message_id: PROMO }, { product_id: null, message_id: TEXT }] });
    // A request signed more than 5 minutes ago is a replay.
    expect((await realtime({ signedDate: T0 - 6 * 60_000 })).status).toBe(400);
    expect((await realtime({ signedDate: T0 + 5 * 60_000 })).status).toBe(400);
    expect((await realtime({ signedDate: T0 - 60_000, productId: "pro_weekly" })).status).toBe(200);
    // Apple's sandbox may leave appAppleId out; production must carry the app's Apple ID.
    expect((await realtime({ appAppleId: undefined, productId: "pro_weekly" })).status).toBe(200);
    expect((await realtime({ environment: "Production", productId: "pro_weekly" })).status).toBe(200);
    expect((await realtime({ environment: "Production", appAppleId: undefined })).status).toBe(400);
    // Only the App Store calls this endpoint.
    expect((await realtime({ environment: "Xcode" })).status).toBe(400);
    // Duplicate defaults for one product and locale are refused.
    expect((await call("", { defaults: [{ product_id: "pro_monthly", locale: "en-US", message_id: TEXT }, { product_id: "pro_monthly", locale: "en_US", message_id: TEXT }] })).status).toBe(400);
    // A broken In-App Purchase key: Apple gets {} and shows its default message.
    await h!.db.update(schema.apps).set({ credentials: { key_id: "KEY123", issuer_id: "issuer", private_key: "not a key", app_apple_id: "1234567890" } }).where(eq(schema.apps.id, APP_ID));
    const broken = await realtime({ productId: "pro_monthly" });
    expect(broken.status).toBe(200);
    expect(await broken.json()).toEqual({});
  });

  it("answers no production request for an app without its Apple ID", async () => {
    h = await appleHarness({ credentials: { key_id: "KEY123", issuer_id: "issuer", private_key: await makeP8() } });
    expect((await realtime({ environment: "Production" })).status).toBe(400);
    expect((await realtime({ environment: "Sandbox" })).status).toBe(200);
  });

  it("Sync to Apple uploads messages once, sets the defaults and registers the real-time URL", async () => {
    const { apple, call } = await setup();
    await call("", { enabled: true, messages: [messages[0], messages[2]], defaults: [{ product_id: "pro_monthly", locale: "en-US", message_id: TEXT }], rules: [{ product_id: null, message_id: TEXT }] });
    const res = await call("/actions/sync", { environment: "sandbox" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sync).toEqual({ environment: "sandbox", errors: [] });
    expect(apple.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT https://api.storekit-sandbox.apple.com/inApps/v1/messaging/message/${TEXT}`,
      `PUT https://api.storekit-sandbox.apple.com/inApps/v1/messaging/message/${PROMO}`,
      "PUT https://api.storekit-sandbox.apple.com/inApps/v1/messaging/default/pro_monthly/en-US",
      "PUT https://api.storekit-sandbox.apple.com/inApps/v1/messaging/realtime/url",
    ]);
    expect(apple.calls[0]!.body).toEqual({ header: messages[0]!.header, body: messages[0]!.body });
    expect(apple.calls[2]!.body).toEqual({ messageIdentifier: TEXT });
    expect(apple.calls[3]!.body).toEqual({ realtimeURL: `http://localhost/v1/retention/apple/${APP_ID}` });
    expect(body.messages.map((m: any) => m.uploaded)).toEqual([["sandbox"], ["sandbox"]]);
    expect(body.realtime_url_configured.sandbox).toBe(T0);

    // Uploaded messages are not uploaded again, and cannot be edited (Apple keeps them as they were).
    apple.calls.length = 0;
    await call("/actions/sync", { environment: "sandbox" });
    expect(apple.calls.filter((c) => c.url.includes("/messaging/message/"))).toHaveLength(0);
    expect((await call("", { messages: [{ ...messages[0], body: "Changed text." }, messages[2]] })).status).toBe(400);

    // Production: Apple answers 409 for a message it already has, which counts as uploaded.
    apple.setUploadStatus(409);
    const prod = await (await call("/actions/sync", { environment: "production" })).json() as any;
    expect(prod.sync.errors).toEqual([]);
    expect(prod.messages[0].uploaded).toEqual(["sandbox", "production"]);
    expect(apple.calls.some((c) => c.url.startsWith("https://api.storekit.apple.com/inApps/v1/messaging/realtime/url"))).toBe(true);
  });
});
