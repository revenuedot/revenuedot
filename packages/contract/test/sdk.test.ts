import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../src/harness.js";
import { CustomerInfoSchema, ErrorSchema, OfferingsSchema, ProductEntitlementMappingSchema, WebhookEventSchema } from "../src/sdk-schemas.js";

const fx = (p: string) => JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));
const SDK_HEADERS = fx("ios/req-post-receipt-sk2-jws.json").headers as Record<string, string>;

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const post = (path: string, json: unknown, key?: string) => h.fetch(path, { method: "POST", json, key, headers: { ...SDK_HEADERS, Authorization: "" } });
const testPurchase = (appUserId: string, productId: string, at: Date, extra: Record<string, unknown> = {}) =>
  post("/v1/receipts", { app_user_id: appUserId, fetch_token: `test_${at.getTime()}_${crypto.randomUUID()}`, product_id: productId, price: "4.99", currency: "USD", is_restore: false, observer_mode: false, initiation_source: "purchase", payload_version: 1, ...extra }, h.ids.testKey);

describe("fixtures sanity: real RevenueCat responses pass our SDK schemas", () => {
  it("customer info fixtures", () => {
    for (const f of ["ios/resp-customer-info-real-signed.json", "ios/resp-login-real-signed.json"]) {
      const r = CustomerInfoSchema.safeParse(fx(f));
      expect(r.success, `${f}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });
  it("offerings fixtures", () => {
    for (const f of ["ios/resp-offerings-real-signed.json", "android/get_offerings_with_placements.json", "android/get_offerings_with_targeting_and_web_checkout_url.json"]) {
      const r = OfferingsSchema.safeParse(fx(f));
      expect(r.success, `${f}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
  });
  it("product entitlement mapping fixtures", () => {
    expect(ProductEntitlementMappingSchema.safeParse(fx("ios/resp-product-entitlement-mapping.json")).success).toBe(true);
    expect(ProductEntitlementMappingSchema.safeParse(fx("android/product_entitlement_mapping.json")).success).toBe(true);
  });
  it("webhook fixtures", () => {
    for (const f of readdirSync(new URL("../fixtures/webhooks", import.meta.url)).filter((f) => !f.startsWith("_"))) {
      const j = fx(`webhooks/${f}`);
      expect(j.api_version, f).toBe("1.0");
      expect(typeof j.event.type, f).toBe("string");
    }
  });
});

describe("authentication and errors", () => {
  it("rejects a missing or unknown API key with 401 and code 7225 in JSON", async () => {
    for (const key of ["", "appl_nope"]) {
      const res = await h.fetch("/v1/subscribers/abc", { key });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      const body = await res.json();
      expect(ErrorSchema.parse(body).code).toBe(7225);
    }
  });
  it("health needs no key", async () => {
    const res = await h.fetch("/v1/health", { key: "" });
    expect(res.status).toBe(200);
  });
  it("sets X-RevenueCat-Request-Time on every SDK response", async () => {
    const res = await h.fetch("/v1/subscribers/abc");
    expect(res.headers.get("x-revenuecat-request-time")).toBe(String(h.now().getTime()));
  });
});

describe("GET /v1/subscribers/{id}", () => {
  it("creates a new customer with an empty, decodable customer info", async () => {
    const res = await h.fetch("/v1/subscribers/%24RCAnonymousID%3Aabc123");
    expect(res.status).toBe(201);
    const body = CustomerInfoSchema.parse(await res.json());
    expect((await h.fetch("/v1/subscribers/%24RCAnonymousID%3Aabc123")).status).toBe(200);
    expect(body.subscriber.original_app_user_id).toBe("$RCAnonymousID:abc123");
    expect(body.subscriber.entitlements).toEqual({});
    expect(body.subscriber.subscriptions).toEqual({});
    expect(body.request_date).toBe("2026-09-01T12:00:00Z");
  });
  it("uses the same keys as a real RevenueCat response", async () => {
    const real = fx("ios/resp-customer-info-real-signed.json");
    const ours = await (await h.fetch("/v1/subscribers/login")).json();
    for (const k of Object.keys(real.subscriber)) expect(ours.subscriber, k).toHaveProperty(k);
    for (const k of Object.keys(real)) expect(ours, k).toHaveProperty(k);
  });
});

describe("POST /v1/receipts (Test Store)", () => {
  it("a subscription purchase grants the entitlement and is decodable", async () => {
    const at = new Date("2026-09-01T11:59:00Z");
    const res = await testPurchase("user_1", "pro_monthly", at);
    expect(res.status).toBe(200);
    const body = await res.json();
    CustomerInfoSchema.parse(body);
    expect(body.subscriber.entitlements.pro.product_identifier).toBe("pro_monthly");
    expect(body.subscriber.entitlements.pro.expires_date).toBe("2026-10-01T11:59:00Z");
    expect(body.subscriber.subscriptions.pro_monthly.store).toBe("test_store");
    expect(body.subscriber.subscriptions.pro_monthly.is_sandbox).toBe(true);
    expect(body.subscriber.subscriptions.pro_monthly.price).toEqual({ amount: 4.99, currency: "USD" });
    expect(body.purchased_products).toEqual({ pro_monthly: { should_consume: false } });
    // Customer info fetched afterwards agrees.
    const again = await (await h.fetch("/v1/subscribers/user_1")).json();
    expect(again.subscriber.entitlements.pro.expires_date).toBe("2026-10-01T11:59:00Z");
  });
  it("is idempotent for the same token", async () => {
    const at = new Date("2026-09-01T11:59:00Z");
    const token = `test_${at.getTime()}_same`;
    const body = { app_user_id: "user_2", fetch_token: token, product_id: "pro_monthly", price: "4.99", currency: "USD" };
    await post("/v1/receipts", body, h.ids.testKey);
    await post("/v1/receipts", body, h.ids.testKey);
    const events = await h.db.select().from(schema.events);
    expect(events.filter((e) => e.type === "INITIAL_PURCHASE")).toHaveLength(1);
  });
  it("consumables are marked should_consume and listed with store_transaction_id", async () => {
    const res = await testPurchase("user_3", "coins_100", new Date("2026-09-01T11:00:00Z"));
    const body = await res.json();
    CustomerInfoSchema.parse(body);
    expect(body.purchased_products.coins_100.should_consume).toBe(true);
    expect(body.subscriber.non_subscriptions.coins_100[0].store_transaction_id).toMatch(/^test_/);
    expect(body.subscriber.entitlements).toEqual({});
  });
  it("a non-consumable grants lifetime access (expires_date null)", async () => {
    const body = await (await testPurchase("user_4", "lifetime", new Date("2026-09-01T11:00:00Z"))).json();
    expect(body.subscriber.entitlements.pro.expires_date).toBeNull();
    expect(body.subscriber.entitlements.pro.product_identifier).toBe("lifetime");
  });
  it("a malformed Test Store token is a 4xx with a JSON error", async () => {
    const res = await post("/v1/receipts", { app_user_id: "u", fetch_token: "garbage", product_id: "pro_monthly" }, h.ids.testKey);
    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await res.json()).code).toBe(7103);
  });
  it("records an INITIAL_PURCHASE event in webhook format", async () => {
    await testPurchase("user_5", "pro_monthly", new Date("2026-09-01T11:59:00Z"));
    const [ev] = await h.db.select().from(schema.events).where(eq(schema.events.type, "INITIAL_PURCHASE"));
    const payload = WebhookEventSchema.parse(ev!.payload);
    expect(payload.event.environment).toBe("SANDBOX");
    expect(payload.event.entitlement_ids).toEqual(["pro"]);
    expect(payload.event.store).toBe("TEST_STORE");
    expect(payload.event.price).toBe(4.99);
  });
  it("attributes in the receipt body are saved", async () => {
    await testPurchase("user_6", "pro_monthly", new Date(), { attributes: { $email: { value: "a@b.co", updated_at_ms: 1 } } });
    const pub = await (await h.fetch("/v1/subscribers/user_6")).json();
    expect(pub.subscriber.subscriber_attributes).toBeUndefined();
    const body = await (await h.fetch("/v1/subscribers/user_6", { key: h.ids.secretKey })).json();
    expect(body.subscriber.subscriber_attributes.$email).toEqual({ value: "a@b.co", updated_at_ms: 1 });
  });
});

describe("ownership and transfers", () => {
  it("an anonymous user's purchase follows them when they log in", async () => {
    const anon = "$RCAnonymousID:aaaa";
    await testPurchase(anon, "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    const res = await post("/v1/subscribers/identify", { app_user_id: anon, new_app_user_id: "kai" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.subscriber.entitlements.pro).toBeDefined();
    expect(body.subscriber.original_app_user_id).toBe(anon);
  });
  it("logging into an existing user returns 200", async () => {
    await h.fetch("/v1/subscribers/existing");
    const res = await post("/v1/subscribers/identify", { app_user_id: "$RCAnonymousID:bbbb", new_app_user_id: "existing" });
    expect(res.status).toBe(200);
    expect((await res.json()).subscriber.original_app_user_id).toBe("existing");
  });
  it("restoring another known user's receipt transfers it by default and records TRANSFER", async () => {
    const at = new Date("2026-09-01T11:00:00Z");
    const token = `test_${at.getTime()}_shared`;
    await post("/v1/receipts", { app_user_id: "alice", fetch_token: token, product_id: "pro_monthly" }, h.ids.testKey);
    const res = await post("/v1/receipts", { app_user_id: "bob", fetch_token: token, product_id: "pro_monthly", is_restore: true }, h.ids.testKey);
    expect((await res.json()).subscriber.entitlements.pro).toBeDefined();
    const alice = await (await h.fetch("/v1/subscribers/alice")).json();
    expect(alice.subscriber.entitlements).toEqual({});
    const transfers = await h.db.select().from(schema.events).where(eq(schema.events.type, "TRANSFER"));
    expect(transfers).toHaveLength(1);
    expect((transfers[0]!.payload as any).event.transferred_from).toEqual(["alice"]);
  });
  it("restoring another known user's one-time purchase transfers it and records TRANSFER like a subscription does", async () => {
    const at = new Date("2026-09-01T11:00:00Z");
    const subToken = `test_${at.getTime()}_sub_xfer`;
    const oneToken = `test_${at.getTime()}_life_xfer`;
    await post("/v1/receipts", { app_user_id: "erin", fetch_token: subToken, product_id: "pro_monthly" }, h.ids.testKey);
    await post("/v1/receipts", { app_user_id: "erin", fetch_token: oneToken, product_id: "lifetime" }, h.ids.testKey);
    const transfers = async () => (await h.db.select().from(schema.events).where(eq(schema.events.type, "TRANSFER"))).map((r) => (r.payload as any).event);
    await post("/v1/receipts", { app_user_id: "frank", fetch_token: subToken, product_id: "pro_monthly", is_restore: true }, h.ids.testKey);
    const [sub] = await transfers();
    const res = await post("/v1/receipts", { app_user_id: "frank", fetch_token: oneToken, product_id: "lifetime", is_restore: true }, h.ids.testKey);
    expect((await res.json()).subscriber.non_subscriptions.lifetime).toHaveLength(1);
    const erin = await (await h.fetch("/v1/subscribers/erin")).json();
    expect(erin.subscriber.non_subscriptions).toEqual({});
    const all = await transfers();
    expect(all).toHaveLength(2);
    const one = all.find((e) => e.id !== sub.id);
    expect(one).toMatchObject({ type: "TRANSFER", transferred_from: ["erin"], transferred_to: ["frank"], store: "TEST_STORE", environment: "SANDBOX" });
    expect(Object.keys(one).sort()).toEqual(Object.keys(sub).sort());
    // The restore itself is not a new purchase.
    const purchases = await h.db.select().from(schema.events).where(eq(schema.events.type, "NON_RENEWING_PURCHASE"));
    expect(purchases).toHaveLength(1);
  });
  it("with 'keep' the second user gets 7102 receipt already in use", async () => {
    await h.db.update(schema.projects).set({ transferBehavior: "keep" });
    const token = `test_${Date.now()}_keep`;
    await post("/v1/receipts", { app_user_id: "carol", fetch_token: token, product_id: "pro_monthly" }, h.ids.testKey);
    const res = await post("/v1/receipts", { app_user_id: "dave", fetch_token: token, product_id: "pro_monthly" }, h.ids.testKey);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(7102);
  });
});

describe("attributes", () => {
  it("saves attributes, newest timestamp wins, empty string deletes", async () => {
    await post("/v1/subscribers/u1/attributes", { attributes: { $displayName: { value: "Kai", updated_at_ms: 10 } } });
    await post("/v1/subscribers/u1/attributes", { attributes: { $displayName: { value: "Old", updated_at_ms: 5 } } });
    let b = await (await h.fetch("/v1/subscribers/u1", { key: h.ids.secretKey })).json();
    expect(b.subscriber.subscriber_attributes.$displayName.value).toBe("Kai");
    await post("/v1/subscribers/u1/attributes", { attributes: { $displayName: { value: "", updated_at_ms: 20 } } });
    b = await (await h.fetch("/v1/subscribers/u1", { key: h.ids.secretKey })).json();
    expect(b.subscriber.subscriber_attributes.$displayName.value).toBeNull();
  });
  it("an invalid $email returns 7263 with attribute_errors", async () => {
    const res = await post("/v1/subscribers/u2/attributes", { attributes: { $email: { value: "nope", updated_at_ms: 1 } } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(7263);
    expect(body.attribute_errors).toEqual([{ key_name: "$email", message: expect.any(String) }]);
  });
});

describe("offerings and mapping", () => {
  it("returns offerings for the calling app only, decodable by the SDKs", async () => {
    const ios = OfferingsSchema.parse(await (await h.fetch("/v1/subscribers/x/offerings")).json());
    expect(ios.current_offering_id).toBe("default");
    expect(ios.offerings[0]!.packages).toEqual([
      { identifier: "$rc_monthly", platform_product_identifier: "pro_monthly" },
      { identifier: "$rc_annual", platform_product_identifier: "pro_annual" },
    ]);
    const android = OfferingsSchema.parse(await (await h.fetch("/v1/subscribers/x/offerings", { key: h.ids.androidKey })).json());
    expect(android.offerings[0]!.packages).toEqual([{ identifier: "$rc_monthly", platform_product_identifier: "pro", platform_product_plan_identifier: "monthly" }]);
  });
  it("archived products are left out of packages, and a package with no active product for the app is dropped", async () => {
    const res = await h.fetch("/v2/projects/proj1/products/p2/actions/archive", { method: "POST", key: h.ids.secretKey, json: {} });
    expect(res.status).toBe(200);
    const ios = OfferingsSchema.parse(await (await h.fetch("/v1/subscribers/x/offerings")).json());
    expect(ios.offerings[0]!.packages).toEqual([{ identifier: "$rc_monthly", platform_product_identifier: "pro_monthly" }]);
    // Customers who bought the archived product keep its entitlement.
    const m = ProductEntitlementMappingSchema.parse(await (await h.fetch("/v1/product_entitlement_mapping")).json()).product_entitlement_mapping;
    expect(m["pro_annual"]!.entitlements).toEqual(["pro"]);
    await h.fetch("/v2/projects/proj1/products/p2/actions/unarchive", { method: "POST", key: h.ids.secretKey, json: {} });
    expect(OfferingsSchema.parse(await (await h.fetch("/v1/subscribers/x/offerings")).json()).offerings[0]!.packages).toHaveLength(2);
  });
  it("product entitlement mapping includes both the bare Play id and id:plan", async () => {
    const m = ProductEntitlementMappingSchema.parse(await (await h.fetch("/v1/product_entitlement_mapping")).json()).product_entitlement_mapping;
    expect(m["pro_monthly"]!.entitlements).toEqual(["pro"]);
    expect(m["pro"]).toEqual({ product_identifier: "pro", base_plan_id: "monthly", entitlements: ["pro"] });
    expect(m["pro:monthly"]).toBeDefined();
  });
});

describe("endpoints the SDK calls on its own", () => {
  it("remote config answers 204 so getOfferings is not blocked", async () => {
    const res = await h.fetch("/v1/config/app", { method: "POST", json: {} });
    expect(res.status).toBe(204);
  });
  it("events and diagnostics are accepted", async () => {
    expect((await h.fetch("/v1/events", { method: "POST", json: { events: [] } })).status).toBe(200);
    expect((await h.fetch("/v1/diagnostics", { method: "POST", json: { entries: [] } })).status).toBe(200);
  });
  it("Test Store products have the keys of a real response and a numeric cycle_count", async () => {
    const res = await h.fetch("/rcbilling/v1/subscribers/u1/products?id=pro_monthly&id=coins_100", { key: h.ids.testKey, headers: SDK_HEADERS });
    expect(res.status).toBe(200);
    const body = await res.json() as { product_details: Array<Record<string, any>> };
    const real = fx("ios/resp-web-billing-products.json").product_details[0];
    const sub = body.product_details.find((p) => p.identifier === "pro_monthly")!;
    expect(Object.keys(sub).sort()).toEqual(Object.keys(real).sort());
    const base = sub.purchase_options[sub.default_purchase_option_id].base;
    expect(Number.isInteger(base.cycle_count)).toBe(true);
    expect(base.price.currency).toBe("USD");
    const coins = body.product_details.find((p) => p.identifier === "coins_100")!;
    expect(coins.product_type).toBe("consumable");
    expect(coins.purchase_options.base.base_price.amount_micros).toBe(0);
  });
  it("offerings fallback path without a user id works", async () => {
    expect(OfferingsSchema.safeParse(await (await h.fetch("/v1/offerings")).json()).success).toBe(true);
  });
});
