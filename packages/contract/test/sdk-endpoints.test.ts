// The SDK routes added for the endpoint inventory (prd/sdk-api/PRD.md, rows 10-12 and 15-40): what each stores, and
// that each answer has the keys of the upstream fixture the SDKs are tested with.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { ErrorSchema } from "../src/sdk-schemas.js";
import { adServicesToAttributes, ADSERVICES_URL, attributionDataToAttributes } from "../../../apps/server/src/services/attribution.js";
import { offerPayload, p1363ToDer } from "../../../apps/server/src/services/promo-offers.js";

const fx = (p: string) => JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));
const SDK_HEADERS = fx("ios/req-post-receipt-sk2-jws.json").headers as Record<string, string>;
const reqBody = (p: string) => fx(p).request.body;

let h: Harness;
let pending: Promise<unknown>[] = [];
/** Apple's AdServices API, stubbed: tokens starting "ok" are attributed, "organic" are not, "later" is 404 first. */
let appleCalls: string[] = [];
const appleFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url) !== ADSERVICES_URL) throw new Error(`unexpected fetch ${url}`);
  const token = String(init?.body);
  appleCalls.push(token);
  if (token === "later" && appleCalls.filter((t) => t === "later").length === 1) return new Response("", { status: 404 });
  if (token === "bad") return new Response("", { status: 400 });
  const attributed = token !== "organic";
  return Response.json(attributed
    ? { attribution: true, orgId: 40669820, campaignId: 542370539, conversionType: "Download", claimType: "Click", adGroupId: 542317095, countryOrRegion: "US", keywordId: 87675432, adId: 542317136 }
    : { attribution: false });
}) as typeof fetch;

beforeEach(async () => {
  pending = []; appleCalls = [];
  h = await harness({ fetch: appleFetch, defer: (task) => { pending.push(task()); } });
});
// Work the server runs after a response finishes before the database closes.
afterEach(async () => { while (pending.length) await pending.shift(); await h.close(); });

const post = (path: string, json: unknown, key?: string, headers: Record<string, string> = {}) =>
  h.fetch(path, { method: "POST", json, key, headers: { ...SDK_HEADERS, Authorization: "", ...headers } });
const get = (path: string, key?: string) => h.fetch(path, { key, headers: { ...SDK_HEADERS, Authorization: "" } });
const attrs = async (id: string) => (await (await h.fetch(`/v1/subscribers/${encodeURIComponent(id)}`, { key: h.ids.secretKey })).json()).subscriber.subscriber_attributes as Record<string, { value: string | null }>;
const values = (a: Record<string, { value: string | null }>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.value]));
const settle = async () => { while (pending.length) await pending.shift(); };

describe("POST /v1/offers (promotional offer signing)", () => {
  const withKey = async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await h.db.update(schema.apps).set({ credentials: { key_id: "C815358F", issuer_id: "issuer-1", private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString() } })
      .where(eq(schema.apps.id, h.ids.app));
    return publicKey;
  };

  it("signs the offer with the In-App Purchase key the way Apple verifies it, in the fixture's shape", async () => {
    const publicKey = await withKey();
    const res = await post("/v1/offers", reqBody("ios/req-post-offer-for-signing.json"));
    expect(res.status).toBe(200);
    const body = await res.json() as { offers: Array<Record<string, any>> };
    const real = fx("ios/resp-offer-signing.json").offers[0];
    const offer = body.offers[0]!;
    expect(Object.keys(offer).sort()).toEqual(Object.keys(real).filter((k) => k !== "signature_error").sort());
    expect(Object.keys(offer.signature_data).sort()).toEqual(Object.keys(real.signature_data).sort());
    expect(offer).toMatchObject({ key_id: "C815358F", offer_id: "offerid", product_id: "a_great_product" });
    expect(offer.signature_data.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(offer.signature_data.timestamp).toBe(h.now().getTime());
    // The fixture's user id "user" is not a UUID, so StoreKit 2 sends no app account token: the signed field is empty.
    const payload = offerPayload("com.example.scanner", "C815358F", "a_great_product", "offerid", "", offer.signature_data.nonce, offer.signature_data.timestamp);
    const der = Buffer.from(offer.signature_data.signature, "base64");
    expect(der[0]).toBe(0x30);
    expect(verify("sha256", Buffer.from(payload), { key: publicKey, dsaEncoding: "der" }, der)).toBe(true);
  });

  it("signs a UUID app user id as the StoreKit 2 app account token, and the plain id for StoreKit 1", async () => {
    const publicKey = await withKey();
    const uuid = "7F2B7C5E-5D0B-4C9E-9C1B-2E4F7A1B3C5D";
    const offerFor = async (headers: Record<string, string>) => (await (await post("/v1/offers", { ...reqBody("ios/req-post-offer-for-signing.json"), app_user_id: uuid }, undefined, headers)).json()).offers[0];
    const sk2 = await offerFor({});
    const ok = (o: any, token: string) => verify("sha256", Buffer.from(offerPayload("com.example.scanner", "C815358F", "a_great_product", "offerid", token, o.signature_data.nonce, o.signature_data.timestamp)),
      { key: publicKey, dsaEncoding: "der" }, Buffer.from(o.signature_data.signature, "base64"));
    expect(ok(sk2, uuid.toLowerCase())).toBe(true);
    const sk1 = await offerFor({ "X-StoreKit-Version": "1", "X-StoreKit2-Enabled": "false" });
    expect(ok(sk1, uuid)).toBe(true);
  });

  it("answers 7234 (invalidAppleSubscriptionKeyError) when the app has no In-App Purchase key, and for a Test Store key", async () => {
    for (const key of [undefined, h.ids.testKey]) {
      const res = await post("/v1/offers", reqBody("ios/req-post-offer-for-signing.json"), key);
      expect(res.status).toBe(400);
      expect(ErrorSchema.parse(await res.json()).code).toBe(7234);
    }
  });

  it("DER encoding keeps a positive INTEGER when the high bit is set", () => {
    const sig = new Uint8Array(64).fill(0x80);
    const der = p1363ToDer(sig);
    expect([der[0], der[2], der[3], der[4]]).toEqual([0x30, 0x02, 33, 0x00]);
  });
});

describe("attribution", () => {
  it("POST .../attribution stores the advertising ids and Apple Search Ads campaign as reserved attributes", async () => {
    const res = await post("/v1/subscribers/att_user/attribution", {
      network: 0,
      data: { rc_idfa: "IDFA-1", rc_idfv: "IDFV-1", "Version3.1": { "iad-attribution": "true", "iad-campaign-name": "Spring", "iad-adgroup-name": "Group A", "iad-keyword": "scanner", "iad-campaign-id": "123" } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(values(await attrs("att_user"))).toMatchObject({ $idfa: "IDFA-1", $idfv: "IDFV-1", $mediaSource: "Apple Search Ads", $campaign: "Spring", $adGroup: "Group A", $keyword: "scanner", $appleAdsCampaignId: "123" });
  });

  it("the fixture's request (another network, no ids) is accepted and stores nothing", async () => {
    const res = await post("/v1/subscribers/user/attribution", reqBody("ios/req-post-attribution-data.json"));
    expect(res.status).toBe(200);
    expect(await attrs("user")).toEqual({});
    expect(attributionDataToAttributes({ network: 0, data: { "iad-attribution": "false", "iad-campaign-name": "x" } }, 1)).toEqual({});
  });

  it("the AdServices token is resolved with Apple after the response, stored once, and shows in the customer, the v2 API and webhooks", async () => {
    const res = await post("/v1/subscribers/asa_user/adservices_attribution", { aad_attribution_token: "ok-token" });
    expect(res.status).toBe(200);
    await settle();
    expect(appleCalls).toEqual(["ok-token"]);
    const want = {
      $mediaSource: "Apple Search Ads", $campaign: "542370539", $adGroup: "542317095", $keyword: "87675432", $ad: "542317136", $appleAdsCampaignId: "542370539",
      $appleAdsAdGroupId: "542317095", $appleAdsKeywordId: "87675432", $appleAdsAdId: "542317136", $appleAdsOrgId: "40669820", $appleAdsCountryOrRegion: "US",
      $claimType: "Click", $conversionType: "Download",
    };
    expect(values(await attrs("asa_user"))).toEqual(want);
    // The dashboard's customer page reads the v2 customer with expand=attributes.
    const v2 = await (await h.fetch("/v2/projects/proj1/customers/asa_user?expand=attributes", { key: h.ids.secretKey })).json() as { attributes: { items: Array<{ name: string; value: string }> } };
    expect(Object.fromEntries(v2.attributes.items.map((a) => [a.name, a.value]))).toMatchObject(want);
    // Attribution is write-once: a later campaign does not replace the first.
    await h.db.update(schema.customerAttributes).set({ value: "Earlier campaign" }).where(eq(schema.customerAttributes.key, "$campaign"));
    await post("/v1/subscribers/asa_user/adservices_attribution", { aad_attribution_token: "ok-again" });
    await settle();
    expect((await attrs("asa_user")).$campaign!.value).toBe("Earlier campaign");
    // A purchase's webhook payload carries them in subscriber_attributes.
    await post("/v1/receipts", { app_user_id: "asa_user", fetch_token: `test_${h.now().getTime()}_asa`, product_id: "pro_monthly", is_restore: false }, h.ids.testKey);
    const [ev] = await h.db.select().from(schema.events).where(eq(schema.events.type, "INITIAL_PURCHASE"));
    const sa = (ev!.payload as any).event.subscriber_attributes as Record<string, { value: string }>;
    expect(sa.$mediaSource!.value).toBe("Apple Search Ads");
    expect(sa.$appleAdsKeywordId!.value).toBe("87675432");
  });

  it("a receipt's aad_attribution_token is resolved too; 404 is retried, organic and refused tokens store nothing", async () => {
    const b = reqBody("ios/req-post-receipt-adservices-token.json");
    await post("/v1/receipts", { ...b, fetch_token: `test_${h.now().getTime()}_x`, product_id: "pro_monthly", aad_attribution_token: "organic" }, h.ids.testKey);
    await settle();
    const stored = await attrs("abc123");
    expect(stored.$attConsentStatus!.value).toBe("authorized");
    expect(stored.$mediaSource).toBeUndefined();
    expect(adServicesToAttributes({ attribution: false }, 1)).toEqual({});
    // Apple's 404 (record not ready) is retried; the SDK has long since had its answer.
    const svc = await import("../../../apps/server/src/services/attribution.js");
    const [cust] = await h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, "abc123"));
    await svc.resolveAdServicesToken({ db: h.db, now: h.now, stores: {}, fetch: appleFetch }, cust!.id, "later", 1);
    expect(appleCalls.filter((t) => t === "later")).toHaveLength(2);
    expect((await attrs("abc123")).$mediaSource!.value).toBe("Apple Search Ads");
    await svc.resolveAdServicesToken({ db: h.db, now: h.now, stores: {}, fetch: appleFetch }, cust!.id, "bad", 1);
    expect(appleCalls.filter((t) => t === "bad")).toHaveLength(1);
  });

  it("the fixture's adservices request answers {} and a missing token is 400 7226", async () => {
    expect(await (await post("/v1/subscribers/asdf/adservices_attribution", reqBody("ios/req-post-adservices-attribution.json"))).json()).toEqual({});
    const bad = await post("/v1/subscribers/asdf/adservices_attribution", {});
    expect(bad.status).toBe(400);
    expect(ErrorSchema.parse(await bad.json()).code).toBe(7226);
  });

  it("collectDeviceIdentifiers: $ip and $deviceVersion sent as \"true\" become the request's IP and device", async () => {
    await post("/v1/subscribers/dev_user/attributes", { attributes: { $ip: { value: "true", updated_at_ms: 1 }, $deviceVersion: { value: "true", updated_at_ms: 1 }, $idfv: { value: "IDFV-2", updated_at_ms: 1 } } },
      undefined, { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" });
    expect(values(await attrs("dev_user"))).toEqual({ $ip: "203.0.113.7", $deviceVersion: "arm64, iOS Version 17.0.0 (Build 21A342)", $idfv: "IDFV-2" });
  });
});

describe("stubs the SDK handles as a normal result", () => {
  it("redeem_purchase: 7849, the SDK's invalidToken result, in the error fixture's shape", async () => {
    const res = await post("/v1/subscribers/redeem_purchase", reqBody("ios/req-post-redeem-web-purchase.json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(fx("android/error_7849_invalid_web_redemption_token.json")).sort());
    expect(body.code).toBe(7849);
    // redeem_purchase is a path, not an app user id: no customer is created for it.
    expect(await h.db.select().from(schema.customers)).toEqual([]);
  });

  it("external_purchase_tokens: an id and the fixture's other keys", async () => {
    const res = await post("/v1/external_purchase_tokens", reqBody("ios/req-post-external-purchase-token.json"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const real = fx("ios/resp-external-purchase-token.json");
    for (const k of Object.keys(body)) expect(real, k).toHaveProperty(k);
    expect(body.id).toMatch(/^ept[0-9a-f]{32}$/);
    expect(body).toMatchObject({ purchase_type: "LINK_OUT", token_source: "APPLE_SDK", is_sandbox: true });
  });

  it("reward verification: failed, with the keys of the failed fixtures", async () => {
    const res = await get("/v1/subscribers/user/ads/reward_verifications/AABBCCDD-1111-2222-3333-444455556666");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(Object.keys(fx("ios/resp-reward-verification-failed.json")).sort());
    expect(body.status).toBe("failed");
    expect(typeof body.failure_reason).toBe("string");
  });

  it("Amazon receipt details: 7662 for a key that is not an Amazon app's", async () => {
    const res = await h.fetch("/v1/receipts/amazon/amzn1.account.x/hQ8uPyAd/wptg=:3:24", { key: h.ids.androidKey });
    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await res.json()).code).toBe(7662);
  });

  it("web offering products: an empty offerings map", async () => {
    expect(await (await get("/rcbilling/v1/subscribers/user/offering_products")).json()).toEqual({ offerings: {} });
  });

  it("hosted checkout and Web Billing checkout: 7000 to start, 7877 for a session", async () => {
    const hosted = await post("/rcbilling/v1/hosted-checkout", reqBody("ios/req-post-hosted-checkout.json"));
    expect([hosted.status, (await hosted.json()).code]).toEqual([400, 7000]);
    for (const [m, p, code] of [["POST", "/rcbilling/v1/checkout/prepare", 7000], ["POST", "/rcbilling/v1/checkout/start", 7000], ["GET", "/rcbilling/v1/checkout/op_1", 7877],
      ["PATCH", "/rcbilling/v1/checkout/op_1", 7877], ["POST", "/rcbilling/v1/checkout/op_1/complete", 7877], ["POST", "/rcbilling/v1/purchase", 7000]] as const) {
      const res = await h.fetch(p, { method: m, json: m === "GET" ? undefined : {} });
      expect([p, res.status, ErrorSchema.parse(await res.json()).code]).toEqual([p, 400, code]);
    }
  });

  it("branding: every key of purchases-js's BrandingInfoResponse that is not optional, with the app's name", async () => {
    const body = await (await get("/rcbilling/v1/branding")).json();
    for (const k of ["app_icon", "app_icon_webp", "app_wordmark", "app_wordmark_webp", "appearance", "id", "app_name", "gateway_tax_collection_enabled", "brand_font_config"]) expect(body, k).toHaveProperty(k);
    expect(body).toMatchObject({ id: h.ids.app, app_name: "Scanner iOS", gateway_tax_collection_enabled: false });
  });

  it("paywall workflows: none, and an unknown workflow is a JSON 404", async () => {
    expect(await (await get("/v1/subscribers/user/workflows?type=paywall")).json()).toEqual({ workflows: [], ui_config: {} });
    const one = await get("/v1/subscribers/user/workflows/wf_1");
    expect([one.status, (await one.json()).code]).toEqual([404, 7259]);
  });

  it("the health calls need no key and carry X-RevenueCat-Request-Time", async () => {
    for (const p of ["/v1/health", "/v1/health/connectivity", "/v1/subscribers/u/health_report_availability"]) {
      const res = await h.fetch(p, { key: "" });
      expect(res.status, p).toBe(200);
      expect(res.headers.get("x-revenuecat-request-time"), p).toBe(String(h.now().getTime()));
    }
  });
});
