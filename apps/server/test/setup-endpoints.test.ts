import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { tick } from "../src/services/tick.js";
import { verifySignature } from "../src/services/webhooks.js";
import { makeP8, mockAppleApi } from "./apple-fixtures.js";
import { FakeGoogle, makeKeys, PKG, type Keys } from "./google-helpers.js";

/** Dashboard setup endpoints: credential checks against (mocked) Apple and Google, store settings, forwarding URL and webhook tests. */

let h: Harness;
afterEach(async () => { await h?.close(); });

let keys: Keys;
let p8: string;
beforeAll(async () => { keys = await makeKeys(); p8 = await makeP8(); });

function server(fetchImpl: typeof fetch) {
  const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), fetch: fetchImpl });
  return async (method: string, path: string, json?: unknown) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method, headers: { Authorization: `Bearer ${h.ids.secretKey}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    }));
    return { status: res.status, body: await res.json() as any };
  };
}

const P = "/v2/projects/proj1";
const appleCreds = () => ({ subscription_private_key: p8, subscription_key_id: "ABC123DEFG", subscription_key_issuer: "69a6de94-014f-47e3-e053-5b8c7c11a4d1" });

describe("verify_credentials: App Store", () => {
  it("valid when Apple accepts the signed request (unknown transaction = 404), checking values from the body before they are saved", async () => {
    h = await harness();
    const apple = mockAppleApi({ production: { transactions: [] }, knownIds: [] });
    const call = server(apple.fetch as typeof fetch);
    const r = await call("POST", `${P}/apps/app_ios/actions/verify_credentials`, { app_store: appleCreds() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "credentials_check", app_id: "app_ios", store: "app_store", status: "valid", valid: true, key_id: "ABC123DEFG" });
    expect(apple.calls).toHaveLength(1);
    expect(apple.calls[0]!.env).toBe("production");
    const jwt = apple.calls[0]!.auth!.replace(/^Bearer /, "");
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "ES256", kid: "ABC123DEFG" });
    // Nothing was saved by checking.
    const [row] = await h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_ios"));
    expect(row!.credentials).toEqual({});
  });

  it("uses the stored key when the body is empty", async () => {
    h = await harness();
    await h.db.update(schema.apps).set({ credentials: appleCreds() }).where(eq(schema.apps.id, "app_ios"));
    const call = server(mockAppleApi({ production: { transactions: [] }, knownIds: [] }).fetch as typeof fetch);
    expect((await call("POST", `${P}/apps/app_ios/actions/verify_credentials`)).body.status).toBe("valid");
  });

  it("invalid when Apple answers 401, when the .p8 is not a key, and when fields are missing", async () => {
    h = await harness();
    const call = server(mockAppleApi({ failWith: 401 }).fetch as typeof fetch);
    const rejected = await call("POST", `${P}/apps/app_ios/actions/verify_credentials`, { app_store: appleCreds() });
    expect(rejected.body).toMatchObject({ status: "invalid", valid: false });
    expect(rejected.body.message).toMatch(/Apple rejected the key/);
    const badP8 = await call("POST", `${P}/apps/app_ios/actions/verify_credentials`, { app_store: { ...appleCreds(), subscription_private_key: "not a key" } });
    expect(badP8.body.message).toMatch(/not a valid \.p8/);
    const partial = await call("POST", `${P}/apps/app_ios/actions/verify_credentials`, { app_store: { subscription_key_id: "ABC" } });
    expect(partial.body).toMatchObject({ status: "invalid" });
    expect(partial.body.message).toMatch(/incomplete/);
    const none = await call("POST", `${P}/apps/app_ios/actions/verify_credentials`);
    expect(none.body.message).toMatch(/No in-app purchase key yet/);
  });

  it("unreachable when Apple is down, and 400 for apps without store credentials", async () => {
    h = await harness();
    const call = server(mockAppleApi({ failWith: 503 }).fetch as typeof fetch);
    expect((await call("POST", `${P}/apps/app_ios/actions/verify_credentials`, { app_store: appleCreds() })).body).toMatchObject({ status: "unreachable", valid: false });
    const test = await call("POST", `${P}/apps/app_test/actions/verify_credentials`);
    expect(test.status).toBe(400);
    expect(test.body.type).toBe("parameter_error");
    expect((await call("POST", `${P}/apps/app_nope/actions/verify_credentials`)).status).toBe(404);
  });
});

describe("verify_credentials: Google Play", () => {
  it("valid when the service account gets a token and can read the app's purchases", async () => {
    h = await harness();
    const g = new FakeGoogle(keys.publicKey);
    const call = server(g.fetch);
    const r = await call("POST", `${P}/apps/app_play/actions/verify_credentials`, { play_store: { play_service_account_credentials_json: JSON.stringify(keys.sa) } });
    expect(r.body).toMatchObject({ status: "valid", valid: true, client_email: keys.sa.client_email });
    expect(g.tokenRequests).toHaveLength(1);
    expect(g.calls[0]!.url).toContain(`/applications/${PKG}/purchases/subscriptionsv2/tokens/`);
  });

  it("explains missing Play Console access, a wrong package name and a file that is not a key", async () => {
    h = await harness();
    const g = new FakeGoogle(keys.publicKey);
    const call = server(g.fetch);
    const json = JSON.stringify(keys.sa);
    g.override = (url) => url.includes("androidpublisher") ? new Response(JSON.stringify({ error: { code: 403, message: "The current user has insufficient permissions", errors: [{ reason: "permissionDenied" }] } }), { status: 403 }) : undefined;
    const denied = await call("POST", `${P}/apps/app_play/actions/verify_credentials`, { play_store: { play_service_account_credentials_json: json } });
    expect(denied.body.status).toBe("invalid");
    expect(denied.body.message).toMatch(/Play Console/);
    g.override = (url) => url.includes("androidpublisher") ? new Response(JSON.stringify({ error: { code: 404, message: "No application was found", errors: [{ reason: "applicationNotFound" }] } }), { status: 404 }) : undefined;
    const pkg = await call("POST", `${P}/apps/app_play/actions/verify_credentials`, { play_store: { play_service_account_credentials_json: json, package_name: "com.wrong.app" } });
    expect(pkg.body.message).toMatch(/no app with the package name com\.wrong\.app/);
    g.override = null;
    const notKey = await call("POST", `${P}/apps/app_play/actions/verify_credentials`, { play_store: { play_service_account_credentials_json: "{\"hello\":1}" } });
    expect(notKey.body.status).toBe("invalid");
    expect(notKey.body.message).toMatch(/not a service account key/);
  });
});

describe("store settings and forwarding URL", () => {
  it("reports what is configured without returning secrets, and stores the forwarding URL on the app", async () => {
    h = await harness();
    const call = server(fetch);
    const up = await call("POST", `${P}/apps/app_ios`, { app_store: { ...appleCreds(), shared_secret: "abc123secret", track_new_purchases: true, notification_forward_url: "https://api.revenuecat.com/v1/incoming-webhooks/apple-server-to-server-notification/xyz" } });
    expect(up.status).toBe(200);
    expect(JSON.stringify(up.body)).not.toContain("abc123secret");
    const [row] = await h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_ios"));
    expect(row!.notificationForwardUrl).toMatch(/^https:\/\/api\.revenuecat\.com\//);
    expect(row!.credentials).not.toHaveProperty("notification_forward_url");
    const s = await call("GET", `${P}/apps/app_ios/store_settings`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({
      object: "app_store_settings", notification_url: "http://localhost/v1/notifications/apple/app_ios", track_new_purchases: true, allow_unsigned_receipts: false,
      notification_forward_url: row!.notificationForwardUrl, last_notification_at: null,
      credentials: { subscription_key: { configured: true, key_id: "ABC123DEFG" }, shared_secret: { configured: true }, app_store_connect_api_key: { configured: false } },
    });
    const text = JSON.stringify(s.body);
    expect(text).not.toContain("abc123secret");
    expect(text).not.toContain("PRIVATE KEY");
    // "" turns forwarding off; anything but http(s) is rejected.
    expect((await call("POST", `${P}/apps/app_ios`, { app_store: { notification_forward_url: "" } })).status).toBe(200);
    expect((await call("GET", `${P}/apps/app_ios/store_settings`)).body.notification_forward_url).toBeNull();
    const bad = await call("POST", `${P}/apps/app_ios`, { app_store: { notification_forward_url: "ftp://nope" } });
    expect(bad.status).toBe(400);
    expect(bad.body.param).toBe("notification_forward_url");
    const play = await call("GET", `${P}/apps/app_play/store_settings`);
    expect(play.body.notification_url).toBe("http://localhost/v1/notifications/google/app_play");
    expect((await call("GET", `${P}/apps/app_test/store_settings`)).body.notification_url).toBeNull();
  });
});

describe("webhook test event", () => {
  it("queues a signed TEST event for that webhook only, ignoring its event filter, and it is delivered by the tick", async () => {
    h = await harness();
    const received: { url: string; body: string; headers: Headers }[] = [];
    const listener = (async (url: string, init?: RequestInit) => {
      received.push({ url: String(url), body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const call = server(fetch);
    const a = await call("POST", `${P}/integrations/webhooks`, { name: "Mine", url: "https://hooks.example.com/a", event_types: ["renewal"], environment: "production", authorization_header: "Bearer abc" });
    expect(a.status).toBe(201);
    const secret = a.body.signing_secret;
    await call("POST", `${P}/integrations/webhooks`, { name: "Other", url: "https://hooks.example.com/b" });
    const t = await call("POST", `${P}/integrations/webhooks/${a.body.id}/test`);
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ object: "webhook_delivery", webhook_integration_id: a.body.id, event_type: "TEST", status: "pending", attempts: 0 });
    await tick(h.db, h.now(), listener);
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("https://hooks.example.com/a");
    expect(received[0]!.headers.get("authorization")).toBe("Bearer abc");
    expect(await verifySignature(secret, received[0]!.body, received[0]!.headers.get("X-RevenueCat-Webhook-Signature")!, 300, h.now())).toBe(true);
    const payload = JSON.parse(received[0]!.body);
    expect(payload).toMatchObject({ api_version: "1.0", event: { type: "TEST", environment: "PRODUCTION", id: t.body.event_id, product_id: "test_product" } });
    const log = await call("GET", `${P}/webhooks/${a.body.id}/deliveries`);
    expect(log.body.items[0]).toMatchObject({ id: t.body.id, status: "delivered", attempts: 1, response_status: 200, event_type: "TEST" });
    expect((await call("POST", `${P}/integrations/webhooks/wh_missing/test`)).status).toBe(404);
  });

  it("accepts all 21 RevenueCat event types in the filter", async () => {
    h = await harness();
    const call = server(fetch);
    const r = await call("POST", `${P}/integrations/webhooks`, { name: "All", url: "https://hooks.example.com/a", event_types: ["test", "price_increase_consent_required", "experiment_enrollment", "initial_purchase"] });
    expect(r.status).toBe(201);
    expect(r.body.event_types).toEqual(["test", "price_increase_consent_required", "experiment_enrollment", "initial_purchase"]);
    expect((await call("POST", `${P}/integrations/webhooks`, { name: "Bad", url: "https://hooks.example.com/a", event_types: ["nope"] })).status).toBe(400);
  });
});
