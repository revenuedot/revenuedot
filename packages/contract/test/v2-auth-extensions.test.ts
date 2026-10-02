import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "@revenuedot/server/services/auth.js";
import { tick } from "@revenuedot/server/services/tick.js";
import { harness, type Harness } from "../src/harness.js";
import { buy, otherProject, signup, spec, v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const P = "/v2/projects/{project_id}";

describe("authentication and errors", () => {
  it("401 without credentials or with an unknown key, 403 with a public SDK key", async () => {
    const none = await call("GET", `${P}/apps`, {}, { key: "" });
    expect(none.status).toBe(401);
    expect(none.body).toMatchObject({ object: "error", type: "authentication_error", retryable: false });
    expect(none.body.doc_url).toMatch(/^https:\/\/revenuedot\.app\//);
    expect((await call("GET", `${P}/apps`, {}, { key: "sk_not_a_real_key" })).status).toBe(401);
    const pub = await call("GET", `${P}/apps`, {}, { key: h.ids.iosKey });
    expect(pub.status).toBe(403);
    expect(pub.body.type).toBe("authorization_error");
  });

  it("honours key permissions: read_write implies read, prefixes with :*, and nothing else", async () => {
    const { key } = await createSecretKey(h.db, "proj1", "limited", ["project_configuration:apps:read_write", "customer_information:*"]);
    expect((await call("GET", `${P}/apps`, {}, { key })).status).toBe(200);
    expect((await call("POST", `${P}/apps`, {}, { key, json: { name: "T", type: "test_store" } })).status).toBe(201);
    expect((await call("GET", `${P}/customers`, {}, { key })).status).toBe(200);
    const denied = await call("GET", `${P}/products`, {}, { key });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toContain("project_configuration:products:read");
    const { key: none } = await createSecretKey(h.db, "proj1", "empty", []);
    expect((await call("GET", `${P}/apps`, {}, { key: none })).status).toBe(403);
  });

  it("unknown routes and malformed JSON answer in the error format", async () => {
    const r = await call("GET", `${P}/nothing_here`, {}, { ext: true });
    expect(r.status).toBe(404);
    expect(r.body.type).toBe("resource_missing");
    const bad = await call("POST", `${P}/entitlements`, {}, { body: "[" });
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("invalid_request");
  });

  it("the dashboard session cookie from POST /auth/signup authorizes v2 for the user's projects only", async () => {
    const cookie = await signup(h);
    const projects = await call("GET", "/v2/projects", {}, { cookie });
    expect(projects.body.items).toHaveLength(1);
    const pid = projects.body.items[0].id;
    expect(pid).toMatch(/^proj/);
    const app = await call("POST", `${P}/apps`, { project_id: pid }, { cookie, json: { name: "Web test", type: "test_store" } });
    expect(app.status).toBe(201);
    expect((await call("GET", `${P}/apps`, { project_id: pid }, { cookie })).body.items).toHaveLength(1);
    // The harness project belongs to nobody: 404, same as a project that does not exist.
    expect((await call("GET", `${P}/apps`, { project_id: "proj1" }, { cookie })).status).toBe(404);
    expect((await call("GET", `${P}/apps`, { project_id: "proj_nope" }, { cookie })).status).toBe(404);
    // A viewer can read but not write.
    const [u] = await h.db.select().from(schema.memberships).where(eq(schema.memberships.projectId, pid));
    await h.db.update(schema.memberships).set({ role: "viewer" }).where(eq(schema.memberships.userId, u!.userId));
    expect((await call("GET", `${P}/apps`, { project_id: pid }, { cookie })).status).toBe(200);
    expect((await call("POST", `${P}/apps`, { project_id: pid }, { cookie, json: { name: "x", type: "test_store" } })).status).toBe(403);
    // Logged out: 401.
    await h.fetch("/auth/logout", { method: "POST", key: "", headers: { Cookie: cookie } });
    expect((await call("GET", "/v2/projects", {}, { cookie })).status).toBe(401);
  });
});

describe("cross-project isolation", () => {
  it("never returns or changes another project's data", async () => {
    const other = await otherProject(h);
    // Our key on their project: 404.
    for (const path of ["apps", "products", "entitlements", "offerings", "customers", "integrations/webhooks", "metrics/overview"]) {
      const r = await call("GET", `${P}/${path}`, { project_id: "projB" }, { ext: path === "metrics/overview" });
      expect(r.status, path).toBe(404);
    }
    for (const path of ["transactions", "events", "setup_health", "api_keys"]) {
      expect((await call("GET", `${P}/${path}`, { project_id: "projB" }, { ext: true })).status, path).toBe(404);
    }
    // Their object ids under our project: 404 for every kind.
    const probes: [string, string, Record<string, string>, unknown?][] = [
      ["GET", `${P}/apps/{app_id}`, { app_id: "appB" }], ["POST", `${P}/apps/{app_id}`, { app_id: "appB" }, { name: "pwned" }], ["DELETE", `${P}/apps/{app_id}`, { app_id: "appB" }],
      ["GET", `${P}/apps/{app_id}/public_api_keys`, { app_id: "appB" }],
      ["GET", `${P}/products/{product_id}`, { product_id: "prodB" }], ["DELETE", `${P}/products/{product_id}`, { product_id: "prodB" }], ["POST", `${P}/products/{product_id}/actions/archive`, { product_id: "prodB" }],
      ["GET", `${P}/entitlements/{entitlement_id}`, { entitlement_id: "entlB" }], ["DELETE", `${P}/entitlements/{entitlement_id}`, { entitlement_id: "entlB" }],
      ["POST", `${P}/entitlements/{entitlement_id}/actions/attach_products`, { entitlement_id: "entlB" }, { product_ids: ["p1"] }],
      ["GET", `${P}/offerings/{offering_id}`, { offering_id: "ofrngB" }], ["POST", `${P}/offerings/{offering_id}`, { offering_id: "ofrngB" }, { is_current: false }],
      ["GET", `${P}/offerings/{offering_id}/packages`, { offering_id: "ofrngB" }], ["DELETE", `${P}/offerings/{offering_id}`, { offering_id: "ofrngB" }],
      ["GET", `${P}/packages/{package_id}`, { package_id: "pkgeB" }], ["DELETE", `${P}/packages/{package_id}`, { package_id: "pkgeB" }],
      ["POST", `${P}/packages/{package_id}/actions/attach_products`, { package_id: "pkgeB" }, { products: [{ product_id: "p1", eligibility_criteria: "all" }] }],
      ["GET", `${P}/customers/{customer_id}`, { customer_id: "other_user" }], ["DELETE", `${P}/customers/{customer_id}`, { customer_id: "other_user" }],
      ["GET", `${P}/customers/{customer_id}/subscriptions`, { customer_id: "other_user" }],
      ["GET", `${P}/subscriptions/{subscription_id}`, { subscription_id: "subB" }], ["GET", `${P}/purchases/{purchase_id}`, { purchase_id: "purB" }],
      ["GET", `${P}/integrations/webhooks/{webhook_integration_id}`, { webhook_integration_id: "whB" }],
      ["DELETE", `${P}/integrations/webhooks/{webhook_integration_id}`, { webhook_integration_id: "whB" }],
    ];
    for (const [m, t, params, json] of probes) {
      const r = await call(m, t, params, { json });
      expect(r.status, `${m} ${t} ${JSON.stringify(params)}`).toBe(404);
    }
    for (const [m, path, json] of [
      ["GET", "/v2/projects/proj1/webhooks/whB/deliveries"], ["DELETE", "/v2/projects/proj1/api_keys/" + other.keyId],
      ["POST", "/v2/projects/proj1/entitlements/ent_pro/actions/attach_products", { product_ids: ["prodB"] }],
      ["POST", "/v2/projects/proj1/packages/pkg_m/actions/attach_products", { products: [{ product_id: "prodB", eligibility_criteria: "all" }] }],
    ] as [string, string, unknown?][]) {
      const r = await h.fetch(path, { method: m, key: h.ids.secretKey, json });
      expect([400, 404], `${m} ${path}`).toContain(r.status);
    }
    expect((await call("GET", `${P}/transactions`, {}, { ext: true, query: "starting_after=txnB" })).status).toBe(400);
    expect((await call("GET", `${P}/customers`, {}, { query: "search=other_user" })).body.items).toEqual([]);
    expect((await call("GET", `${P}/subscriptions`, {}, { query: "store_subscription_identifier=otB" })).body.items).toEqual([]);
    expect((await call("GET", `${P}/purchases`, {}, { query: "store_purchase_identifier=txB" })).body.items).toEqual([]);
    expect((await call("POST", `${P}/test_purchases`, {}, { ext: true, json: { app_user_id: "x", product_id: "prodB" } })).status).toBe(400);

    // Lists only ever hold our own objects.
    const lists: Record<string, string[]> = {};
    for (const path of ["apps", "products", "entitlements", "offerings", "customers", "integrations/webhooks"]) {
      lists[path] = (await call("GET", `${P}/${path}`, {}, { query: "limit=100" })).body.items.map((x: any) => x.id);
    }
    for (const path of ["transactions", "events", "api_keys"]) lists[path] = (await call("GET", `${P}/${path}`, {}, { ext: true, query: "limit=100" })).body.items.map((x: any) => x.id);
    const flat = JSON.stringify(lists);
    for (const theirs of ["appB", "prodB", "entlB", "ofrngB", "other_user", "whB", "txnB", other.keyId]) expect(flat).not.toContain(theirs);

    // Their data is untouched and their key still only sees their project.
    const [theirApp] = await h.db.select().from(schema.apps).where(eq(schema.apps.id, "appB"));
    expect(theirApp!.name).toBe("Other iOS");
    expect(await h.db.select().from(schema.customers).where(eq(schema.customers.projectId, "projB"))).toHaveLength(1);
    expect((await call("GET", "/v2/projects", {}, { key: other.key })).body.items.map((p: any) => p.id)).toEqual(["projB"]);
    expect((await call("GET", `${P}/apps/{app_id}`, { project_id: "projB", app_id: "app_ios" }, { key: other.key })).status).toBe(404);
  });
});

describe("dashboard extensions", () => {
  it("transactions feed: newest first, paginated, with the customer's app user id", async () => {
    for (let i = 0; i < 3; i++) await buy(h, `feed_${i}`, "pro_monthly", new Date(Date.UTC(2026, 7, 20 + i)));
    const p1 = await call("GET", `${P}/transactions`, {}, { ext: true, query: "limit=2" });
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((t: any) => t.customer_id)).toEqual(["feed_2", "feed_1"]);
    expect(p1.body.items[0]).toMatchObject({ object: "transaction", store: "test_store", product_identifier: "pro_monthly", kind: "purchase", environment: "sandbox", revenue_in_usd: 9.99, price: { amount: 9.99, currency: "USD" } });
    const p2 = await call("GET", `${P}/transactions`, {}, { ext: true, query: p1.body.next_page.split("?")[1] });
    expect(p2.body.items.map((t: any) => t.customer_id)).toEqual(["feed_0"]);
    expect(p2.body.next_page).toBeNull();
    expect((await call("GET", `${P}/transactions`, {}, { ext: true, query: "environment=production" })).body.items).toEqual([]);
    expect((await call("GET", `${P}/transactions`, {}, { ext: true, query: "customer=feed_1" })).body.items).toHaveLength(1);
  });

  it("events log with type and customer filters", async () => {
    await buy(h, "ev_a", "pro_monthly", new Date("2026-08-31T00:00:00Z"));
    await buy(h, "ev_b", "lifetime", new Date("2026-08-31T01:00:00Z"));
    const all = await call("GET", `${P}/events`, {}, { ext: true });
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0]).toMatchObject({ object: "event", environment: "sandbox", customer_id: expect.any(String) });
    expect(all.body.items[0].body.type).toBe(all.body.items[0].type);
    expect((await call("GET", `${P}/events`, {}, { ext: true, query: "type=initial_purchase" })).body.items.map((e: any) => e.app_user_id)).toEqual(["ev_a"]);
    expect((await call("GET", `${P}/events`, {}, { ext: true, query: "customer=ev_b" })).body.items.map((e: any) => e.type)).toEqual(["NON_RENEWING_PURCHASE"]);
    const p1 = await call("GET", `${P}/events`, {}, { ext: true, query: "limit=1" });
    const p2 = await call("GET", `${P}/events`, {}, { ext: true, query: p1.body.next_page.split("?")[1] });
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });

  it("webhook deliveries and manual retry; setup health reports failing endpoints", async () => {
    const hook = await call("POST", `${P}/integrations/webhooks`, {}, { json: { name: "Backend", url: "https://hooks.example.com/x" } });
    await buy(h, "wh_user", "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    await tick(h.db, h.now(), async () => new Response("no", { status: 503 }));
    const list = await call("GET", `${P}/webhooks/{webhook_id}/deliveries`, { webhook_id: hook.body.id }, { ext: true });
    expect(list.body.items).toHaveLength(1);
    const d = list.body.items[0];
    expect(d).toMatchObject({ object: "webhook_delivery", event_type: "INITIAL_PURCHASE", status: "pending", attempts: 1, response_status: 503, last_error: "HTTP 503" });

    const health = await call("GET", `${P}/setup_health`, {}, { ext: true });
    expect(health.body.webhooks).toMatchObject({ total: 1, attempted_24h: 1, delivered_24h: 0, delivered_percent_24h: 0 });
    expect(health.body.webhooks.failing).toEqual([expect.objectContaining({ id: hook.body.id, last_status: 503 })]);

    const retried = await call("POST", `${P}/webhooks/{webhook_id}/deliveries/{delivery_id}/retry`, { webhook_id: hook.body.id, delivery_id: d.id }, { ext: true });
    expect(retried.body).toMatchObject({ id: d.id, status: "pending", next_attempt_at: h.now().getTime() });
    await tick(h.db, h.now(), async () => new Response("ok", { status: 200 }));
    expect((await call("GET", `${P}/webhooks/{webhook_id}/deliveries`, { webhook_id: hook.body.id }, { ext: true, query: "status=delivered" })).body.items).toHaveLength(1);
    const after = await call("GET", `${P}/setup_health`, {}, { ext: true });
    expect(after.body.webhooks).toMatchObject({ delivered_24h: 1, delivered_percent_24h: 100, failing: [] });
    expect((await call("POST", `${P}/webhooks/{webhook_id}/deliveries/{delivery_id}/retry`, { webhook_id: hook.body.id, delivery_id: "nope" }, { ext: true })).status).toBe(404);
  });

  it("setup health lists each app's notification URL, last notification and credentials", async () => {
    await h.db.update(schema.apps).set({ lastNotificationAt: new Date("2026-09-01T10:00:00Z"), credentials: { subscription_private_key: "k", subscription_key_id: "i", subscription_key_issuer: "s" } }).where(eq(schema.apps.id, "app_ios"));
    const r = await call("GET", `${P}/setup_health`, {}, { ext: true, headers: { "x-forwarded-host": "api.example.com" } });
    const byId = Object.fromEntries(r.body.apps.map((a: any) => [a.id, a]));
    expect(byId.app_ios).toEqual({
      id: "app_ios", name: "Scanner iOS", type: "app_store", notification_url: "https://api.example.com/v1/notifications/apple/app_ios",
      last_notification_at: new Date("2026-09-01T10:00:00Z").getTime(), last_notification_received_at: null, last_notification_error: null,
      notification_status: "ready", credentials_configured: true,
    });
    expect(byId.app_play).toMatchObject({ notification_url: "https://api.example.com/v1/notifications/google/app_play", last_notification_at: null, credentials_configured: false });
    expect(byId.app_test).toMatchObject({ notification_url: null, credentials_configured: true });
    expect(r.body.webhooks).toMatchObject({ total: 0, delivered_percent_24h: null, failing: [] });
  });

  it("API keys: plaintext once, list without secrets, no privilege escalation, delete revokes", async () => {
    const created = await call("POST", `${P}/api_keys`, {}, { ext: true, json: { name: "CI", permissions: ["project_configuration:apps:read"] } });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sk_/);
    const key = created.body.key;
    const list = await call("GET", `${P}/api_keys`, {}, { ext: true });
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body.items.find((k: any) => k.id === created.body.id)).toMatchObject({ name: "CI", permissions: ["project_configuration:apps:read"], last_used_at: null });
    expect((await call("GET", `${P}/apps`, {}, { key })).status).toBe(200);
    expect((await call("GET", `${P}/api_keys`, {}, { ext: true })).body.items.find((k: any) => k.id === created.body.id).last_used_at).toBe(h.now().getTime());

    const { key: limited } = await createSecretKey(h.db, "proj1", "limited", ["project_configuration:api_keys:read_write"]);
    expect((await call("POST", `${P}/api_keys`, {}, { ext: true, key: limited, json: { name: "root" } })).status).toBe(403);
    expect((await call("POST", `${P}/api_keys`, {}, { ext: true, key: limited, json: { name: "x", permissions: ["customer_information:customers:read"] } })).status).toBe(403);
    expect((await call("POST", `${P}/api_keys`, {}, { ext: true, key: limited, json: { name: "x", permissions: ["project_configuration:api_keys:read"] } })).status).toBe(201);

    expect((await call("DELETE", `${P}/api_keys/{key_id}`, { key_id: created.body.id }, { ext: true })).body).toMatchObject({ object: "api_key", id: created.body.id });
    expect((await call("GET", `${P}/apps`, {}, { key })).status).toBe(401);
  });

  it("test purchases go through the Test Store and grant entitlements", async () => {
    const r = await call("POST", `${P}/test_purchases`, {}, { ext: true, json: { app_user_id: "tester", product_id: "pro_monthly", price: 4.99 } });
    expect(r.status).toBe(201);
    expect(r.body.store_transaction_id).toMatch(/^test_/);
    expect(r.body.customer.active_entitlements.items.map((e: any) => e.entitlement_id)).toEqual(["ent_pro"]);
    expect(r.body.subscription).toMatchObject({ store: "test_store", product_id: "p4", environment: "sandbox", total_revenue_in_usd: { gross: 4.99 } });
    expect(r.body.purchase).toBeNull();
    if (spec) {
      expect(spec.check("GET", `${P}/customers/{customer_id}`, 200, r.body.customer)).toBeNull();
      expect(spec.check("GET", `${P}/subscriptions/{subscription_id}`, 200, r.body.subscription)).toBeNull();
    }
    const one = await call("POST", `${P}/test_purchases`, {}, { ext: true, json: { app_user_id: "tester", product_id: "p6" } });
    expect(one.body.purchase).toMatchObject({ store: "test_store", product_id: "p6" });
    if (spec) expect(spec.check("GET", `${P}/purchases/{purchase_id}`, 200, one.body.purchase)).toBeNull();
    // The SDK sees the purchase.
    const info = await (await h.fetch("/v1/subscribers/tester")).json();
    expect(info.subscriber.entitlements.pro).toBeDefined();
    expect((await call("POST", `${P}/test_purchases`, {}, { ext: true, json: { app_user_id: "tester", product_id: "pro_annual" } })).body.param).toBe("product_id");
    // A price in a currency no exchange rate knows would be $0 of revenue: refused. A lower-case code is fine.
    expect((await call("POST", `${P}/test_purchases`, {}, { ext: true, json: { app_user_id: "tester", product_id: "pro_monthly", price: 4.99, currency: "XYZ" } })).body.param).toBe("currency");
    const eur = await call("POST", `${P}/test_purchases`, {}, { ext: true, json: { app_user_id: "tester_eur", product_id: "pro_monthly", price: 4.99, currency: "eur" } });
    expect(eur.status).toBe(201);
    expect(eur.body.subscription.total_revenue_in_usd.gross).toBeGreaterThan(4.99);
  });
});

describe("schema coverage", () => {
  it("validated auth errors against RevenueCat's spec", () => {
    if (!spec) return;
    const want = [`GET ${P}/apps 401`, `GET ${P}/apps 403`, `GET ${P}/apps 404`, `GET ${P}/products 403`, `POST ${P}/entitlements 400`];
    expect(want.filter((w) => !spec!.checked.has(w))).toEqual([]);
  });
});
