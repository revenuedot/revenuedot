import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { tick } from "@revenuedot/server/services/tick.js";
import { verifySignature, RETRY_MINUTES } from "@revenuedot/server/services/webhooks.js";
import { harness, type Harness } from "../src/harness.js";
import { CustomerInfoSchema, WebhookEventSchema } from "../src/sdk-schemas.js";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const sk = () => h.ids.secretKey;
const post = (path: string, json: unknown, key = sk()) => h.fetch(path, { method: "POST", json, key });
const buy = (user: string, product: string, at: Date) =>
  post("/v1/receipts", { app_user_id: user, fetch_token: `test_${at.getTime()}_${crypto.randomUUID()}`, product_id: product, price: 9.99, currency: "USD" }, h.ids.testKey);

describe("REST API v1 with a secret key", () => {
  it("public keys cannot use secret endpoints (403)", async () => {
    const res = await post("/v1/subscribers/u/entitlements/pro/promotional", { duration: "monthly" }, h.ids.iosKey);
    expect(res.status).toBe(403);
  });
  it("secret key GET returns subscriber_attributes, public key does not", async () => {
    await h.fetch("/v1/subscribers/u/attributes", { method: "POST", json: { attributes: { $email: { value: "k@x.io", updated_at_ms: 5 } } } });
    const s = await (await h.fetch("/v1/subscribers/u", { key: sk() })).json();
    expect(s.subscriber.subscriber_attributes.$email.value).toBe("k@x.io");
  });
  it("grants promotional access by duration and end_time_ms, ignores 2h duplicates, and revokes", async () => {
    let res = await post("/v1/subscribers/promo_user/entitlements/pro/promotional", { duration: "monthly" });
    expect(res.status).toBe(200);
    let b = CustomerInfoSchema.parse(await res.json());
    expect(b.subscriber.entitlements.pro!.product_identifier).toBe("rc_promo_pro_monthly");
    expect(b.subscriber.entitlements.pro!.expires_date).toBe("2026-10-01T12:00:00Z");
    expect(b.subscriber.subscriptions.rc_promo_pro_monthly!.store).toBe("promotional");
    expect(b.subscriber.subscriptions.rc_promo_pro_monthly!.period_type).toBe("promotional");
    await post("/v1/subscribers/promo_user/entitlements/pro/promotional", { end_time_ms: new Date("2026-10-01T13:00:00Z").getTime() });
    const promos = await h.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.store, "promotional"));
    expect(promos).toHaveLength(1);
    res = await post("/v1/subscribers/promo_user/entitlements/pro/revoke_promotionals", {});
    b = await res.json();
    expect(new Date(b.subscriber.entitlements.pro!.expires_date!).getTime()).toBeLessThanOrEqual(h.now().getTime());
  });
  it("lifetime promotional grant has expires_date null", async () => {
    const b = await (await post("/v1/subscribers/life/entitlements/pro/promotional", { duration: "lifetime" })).json();
    expect(b.subscriber.entitlements.pro.expires_date).toBeNull();
  });
  it("unknown entitlement is 404", async () => {
    expect((await post("/v1/subscribers/x/entitlements/nope/promotional", { duration: "weekly" })).status).toBe(404);
  });
  it("offering override changes current_offering_id for that customer only", async () => {
    await h.db.insert(schema.offerings).values({ id: "ofr_sale", projectId: h.ids.project, lookupKey: "sale", displayName: "Sale" });
    await post("/v1/subscribers/o1/offerings/ofr_sale/override", {});
    expect((await (await h.fetch("/v1/subscribers/o1/offerings")).json()).current_offering_id).toBe("sale");
    expect((await (await h.fetch("/v1/subscribers/o2/offerings")).json()).current_offering_id).toBe("default");
    await h.fetch("/v1/subscribers/o1/offerings/override", { method: "DELETE", key: sk() });
    expect((await (await h.fetch("/v1/subscribers/o1/offerings")).json()).current_offering_id).toBe("default");
  });
  it("deletes a subscriber", async () => {
    await h.fetch("/v1/subscribers/gone");
    const res = await h.fetch("/v1/subscribers/gone", { method: "DELETE", key: sk() });
    expect(await res.json()).toEqual({ app_user_id: "gone" });
    expect((await h.fetch("/v1/subscribers/gone")).status).toBe(201);
  });
  it("offerings with a secret key use X-Platform to pick the app", async () => {
    const b = await (await h.fetch("/v1/subscribers/x/offerings", { key: sk(), headers: { "X-Platform": "android" } })).json();
    expect(b.offerings[0].packages[0].platform_product_identifier).toBe("pro");
  });
});

describe("webhooks", () => {
  async function addHook(opts: Partial<typeof schema.webhooks.$inferInsert> = {}) {
    await h.db.insert(schema.webhooks).values({ id: "wh1", projectId: h.ids.project, name: "Backend", url: "https://hooks.example.com/rc", authorizationHeader: "Bearer abc", signingSecret: "whsec_test", ...opts });
  }
  it("delivers the event with Authorization and a valid HMAC signature; only 200 counts", async () => {
    await addHook();
    await buy("wh_user", "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const fake: typeof fetch = async (url, init) => { calls.push({ url: String(url), headers: new Headers(init!.headers), body: String(init!.body) }); return new Response("ok", { status: 200 }); };
    const r = await tick(h.db, h.now(), fake);
    expect(r.sent).toBe(1);
    expect(calls[0]!.url).toBe("https://hooks.example.com/rc");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer abc");
    expect(await verifySignature("whsec_test", calls[0]!.body, calls[0]!.headers.get("x-revenuecat-webhook-signature")!, 300, h.now())).toBe(true);
    const payload = WebhookEventSchema.parse(JSON.parse(calls[0]!.body));
    expect(payload.event.type).toBe("INITIAL_PURCHASE");
    const [d] = await h.db.select().from(schema.webhookDeliveries);
    expect(d!.status).toBe("delivered");
  });
  it("retries at 5, 10, 20, 40, 80 minutes, then fails", async () => {
    await addHook();
    await buy("wh_user2", "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    const fail: typeof fetch = async () => new Response("no", { status: 500 });
    let t = h.now();
    await tick(h.db, t, fail);
    for (const m of RETRY_MINUTES) {
      const [d] = await h.db.select().from(schema.webhookDeliveries);
      expect(d!.status).toBe("pending");
      expect(d!.nextAttemptAt.getTime() - t.getTime()).toBe(m * 60_000);
      t = d!.nextAttemptAt;
      await tick(h.db, t, fail);
    }
    const [d] = await h.db.select().from(schema.webhookDeliveries);
    expect(d!.status).toBe("failed");
    expect(d!.attempts).toBe(6);
  });
  it("filters by environment and event type", async () => {
    await addHook({ environment: "production" });
    await buy("wh_user3", "pro_monthly", new Date()); // Test Store is sandbox
    expect(await h.db.select().from(schema.webhookDeliveries)).toHaveLength(0);
    await h.db.update(schema.webhooks).set({ environment: "both", eventTypes: ["RENEWAL"] });
    await buy("wh_user4", "pro_monthly", new Date());
    expect(await h.db.select().from(schema.webhookDeliveries)).toHaveLength(0);
  });
});

describe("expirations", () => {
  it("records EXPIRATION once when access ends, and not again", async () => {
    await buy("exp_user", "pro_monthly", new Date("2026-08-01T00:00:00Z"));
    const later = new Date("2026-09-02T00:00:00Z");
    expect((await tick(h.db, later, async () => new Response(null, { status: 200 }))).expired).toBe(1);
    expect((await tick(h.db, later, async () => new Response(null, { status: 200 }))).expired).toBe(0);
    const ev = await h.db.select().from(schema.events).where(eq(schema.events.type, "EXPIRATION"));
    expect(ev).toHaveLength(1);
  });
});
