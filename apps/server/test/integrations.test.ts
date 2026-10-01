import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jwtVerify } from "jose";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { tick } from "../src/services/tick.js";
import { getOrCreateCustomer, setAttributes } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import { clearGoogleTokens } from "../src/services/google-sa.js";
import type { VerifiedSubscription } from "../src/stores/types.js";
import { makeKeys, type Keys } from "./google-helpers.js";

/**
 * Integration delivery end to end with a fake fetch: the fan-out from the event pipeline, sealed credentials, the
 * delivery log (scrubbed of keys), the retry schedule, skips, replay, the test event and BigQuery's table creation.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const MIN = 60_000;

let h: Harness;
let keys: Keys;
beforeAll(async () => { keys = await makeKeys(); });
beforeEach(async () => { h = await harness(); clearGoogleTokens(); });
afterEach(async () => { await h.close(); });

interface Seen { method: string; url: string; headers: Headers; body: string }
function fake(answer: (r: Seen) => Response | Promise<Response> = () => new Response("ok", { status: 200 })) {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const r = { method: (init.method ?? "GET").toUpperCase(), url: String(input), headers: new Headers(init.headers), body: typeof init.body === "string" ? init.body : "" };
    seen.push(r);
    return answer(r);
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

/** An App Store production purchase through the real purchase pipeline (records INITIAL_PURCHASE and queues deliveries). */
async function purchase(user: string, over: Partial<VerifiedSubscription> = {}) {
  const now = h.now();
  const { customer } = await getOrCreateCustomer(h.db, "proj1", user, now);
  const sub: VerifiedSubscription = {
    kind: "subscription", store: "app_store", storeKey: `orig_${user}`, productIdentifier: "pro_monthly", isSandbox: false, purchaseDate: now, originalPurchaseDate: now,
    expiresDate: new Date(now.getTime() + 30 * 86400_000), periodType: "normal", storeTransactionId: `tx_${user}`, originalTransactionId: `orig_${user}`,
    price: { amount: 9.99, currency: "USD" }, countryCode: "US", ...over,
  };
  await applyPurchases(h.db, customer, [sub], { projectId: "proj1", appId: "app_ios", appUserId: user, now, fromDevice: false });
  return customer;
}

describe("integration API", () => {
  it("seals secrets, returns only hints, validates settings", async () => {
    const call = api();
    const cat = await call("GET", "/integrations/catalog");
    expect(cat.body.items.map((x: any) => x.type)).toEqual(["slack", "segment", "amplitude", "mixpanel", "posthog", "firebase", "bigquery", "appsflyer", "adjust", "meta"]);
    const res = await call("POST", "/integrations/partners", { type: "amplitude", settings: { api_key: "amp_live_secret_1234", region: "eu" }, event_names: { initial_purchase: "Subscribed" } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "integration", type: "amplitude", name: "Amplitude", enabled: true, environment: null, settings: { region: "eu" },
      secrets: { api_key: { configured: true, hint: "••••1234" }, sandbox_api_key: { configured: false, hint: null } }, event_names: { initial_purchase: "Subscribed" },
    });
    expect(JSON.stringify(res.body)).not.toContain("amp_live_secret");
    const [row] = await h.db.select().from(schema.integrations).where(eq(schema.integrations.id, res.body.id));
    expect(row!.secrets).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(row!.secrets).not.toContain("amp_live_secret");
    // A missing secret keeps the saved one; null removes it.
    const upd = await call("POST", `/integrations/partners/${res.body.id}`, { settings: { region: "us", sandbox_api_key: "amp_sbx_9999" } });
    expect(upd.body.secrets).toEqual({ api_key: { configured: true, hint: "••••1234" }, sandbox_api_key: { configured: true, hint: "••••9999" } });
    expect((await call("POST", `/integrations/partners/${res.body.id}`, { settings: { api_key: null } })).body).toMatchObject({ object: "error", param: "settings.api_key" });
    expect((await call("POST", "/integrations/partners", { type: "slack", settings: {} })).body).toMatchObject({ object: "error", param: "settings.webhook_url" });
    expect((await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/x", color: "red" } })).body.message).toMatch(/Slack has no setting color/);
    expect((await call("POST", "/integrations/partners", { type: "amplitude", settings: { api_key: "k", region: "mars" } })).body.param).toBe("settings.region");
    expect((await call("POST", "/integrations/partners", { type: "adjust", settings: { ios_app_token: "t", event_tokens: { lunch: "x" } } })).body.param).toBe("settings.event_tokens.lunch");
    expect((await call("POST", "/integrations/partners", { type: "bigquery", settings: { service_account_json: "{}", dataset_id: "d" } })).body.param).toBe("settings.service_account_json");
    const list = await call("GET", "/integrations/partners?type=amplitude");
    expect(list.body.items).toHaveLength(1);
    const audit = await h.db.select().from(schema.auditLogs);
    expect(audit.map((a) => a.actionType)).toContain("integration_created");
  });
});

describe("delivery", () => {
  it("fans every event out to each matching integration and logs a scrubbed request", async () => {
    const call = api();
    const slack = (await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/services/T1/B1/secretpath" } })).body;
    const amp = (await call("POST", "/integrations/partners", { type: "amplitude", settings: { api_key: "amp_live_secret_1234" } })).body;
    await call("POST", "/integrations/partners", { type: "posthog", environment: "sandbox", settings: { api_key: "phc_sbx" } });
    await purchase("u1");
    const { f, seen } = fake((r) => new Response(r.url.includes("slack") ? "ok" : '{"code":200}', { status: 200 }));
    const r = await run(f);
    expect(r.integrations).toBe(2);
    expect(seen.map((s) => s.url).sort()).toEqual(["https://api2.amplitude.com/2/httpapi", "https://hooks.slack.com/services/T1/B1/secretpath"]);
    const ampBody = JSON.parse(seen.find((s) => s.url.includes("amplitude"))!.body);
    expect(ampBody.events[0]).toMatchObject({ event_type: "rc_initial_purchase_event", user_id: "u1", revenue: 9.99 });
    const log = (await call("GET", `/integrations/partners/${amp.id}/deliveries`)).body.items;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ object: "integration_delivery", event_type: "INITIAL_PURCHASE", status: "delivered", attempts: 1, sent_as: "rc_initial_purchase_event", response_status: 200, request: "POST https://api2.amplitude.com/2/httpapi" });
    expect(log[0].request_body).toContain('"api_key":"[redacted]"');
    expect(log[0].request_body).not.toContain("amp_live_secret");
    const slackLog = (await call("GET", `/integrations/partners/${slack.id}/deliveries`)).body.items;
    expect(slackLog[0].request).toBe("POST [redacted]");
    expect((await call("GET", `/integrations/partners/${amp.id}`)).body.status).toMatchObject({ last_error: null, consecutive_failures: 0, last_delivered_at: h.now().getTime() });
  });

  it("retries timeouts and 5xx on the webhook schedule, fails a 4xx at once, and replays", async () => {
    const call = api();
    const amp = (await call("POST", "/integrations/partners", { type: "amplitude", settings: { api_key: "k_live_0001" } })).body;
    await purchase("u2");
    let status = 503;
    const { f, seen } = fake(() => new Response('{"error":"busy"}', { status }));
    const start = h.now().getTime();
    await run(f);
    const D = schema.integrationDeliveries;
    let [d] = await h.db.select().from(D);
    expect([d!.status, d!.attempts, d!.nextAttemptAt.getTime() - start]).toEqual(["pending", 1, 5 * MIN]);
    for (const [i, wait] of [10, 20, 40, 80].entries()) {
      h.setNow(new Date(d!.nextAttemptAt.getTime()));
      await run(f);
      [d] = await h.db.select().from(D);
      expect(d!.attempts).toBe(i + 2);
      if (i < 3) expect(d!.nextAttemptAt.getTime() - h.now().getTime()).toBe(wait * MIN);
    }
    h.setNow(new Date(d!.nextAttemptAt.getTime()));
    await run(f);
    [d] = await h.db.select().from(D);
    expect([d!.status, d!.attempts, d!.responseStatus, d!.lastError]).toEqual(["failed", 6, 503, 'HTTP 503: {"error":"busy"}']);
    expect(seen).toHaveLength(6);
    expect((await call("GET", `/integrations/partners/${amp.id}`)).body.status.consecutive_failures).toBe(6);

    // A 400 is not retried.
    await purchase("u3");
    status = 400;
    await run(f);
    const second = (await h.db.select().from(D)).find((x) => x.id !== d!.id)!;
    expect([second.status, second.attempts]).toEqual(["failed", 1]);

    // Replay every failed delivery once the partner is back.
    status = 200;
    const rep = await call("POST", `/integrations/partners/${amp.id}/actions/replay`, {});
    expect(rep.body).toEqual({ object: "integration_replay", integration_id: amp.id, statuses: ["failed"], queued: 2 });
    await run(f);
    expect((await h.db.select().from(D)).map((x) => x.status)).toEqual(["delivered", "delivered"]);
    expect((await call("GET", `/integrations/partners/${amp.id}/deliveries?status=failed`)).body.items).toEqual([]);
  });

  it("skips what it cannot send, and a retry after the app sends the id goes through", async () => {
    const call = api();
    const af = (await call("POST", "/integrations/partners", { type: "appsflyer", settings: { dev_key: "af_key_123", ios_app_id: "id123" } })).body;
    const customer = await purchase("u4");
    const { f, seen } = fake(() => new Response("ok", { status: 200 }));
    await run(f);
    let [d] = (await call("GET", `/integrations/partners/${af.id}/deliveries`)).body.items;
    expect([d.status, d.attempts, d.last_error]).toEqual(["skipped", 0, "The customer has no $appsflyerId attribute, so AppsFlyer cannot attribute the event."]);
    expect(seen).toHaveLength(0);
    await setAttributes(h.db, customer.id, { $appsflyerId: { value: "af-123", updated_at_ms: h.now().getTime() + 1 } }, h.now());
    const retried = await call("POST", `/integrations/partners/${af.id}/deliveries/${d.id}/retry`);
    expect(retried.body.status).toBe("pending");
    await run(f);
    [d] = (await call("GET", `/integrations/partners/${af.id}/deliveries`)).body.items;
    expect(d.status).toBe("delivered");
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ appsflyer_id: "af-123", eventName: "rc_initial_purchase_event", customer_user_id: "u4" });
    expect(seen[0]!.headers.get("authentication")).toBe("af_key_123");
  });

  it("filters by environment, app and event type, and pauses while disabled", async () => {
    const call = api();
    const prodOnly = (await call("POST", "/integrations/partners", { type: "slack", environment: "production", app_id: "app_play", settings: { webhook_url: "https://hooks.slack.com/a" } })).body;
    const typed = (await call("POST", "/integrations/partners", { type: "slack", event_types: ["cancellation"], settings: { webhook_url: "https://hooks.slack.com/b" } })).body;
    const paused = (await call("POST", "/integrations/partners", { type: "slack", enabled: false, settings: { webhook_url: "https://hooks.slack.com/c" } })).body;
    const later = (await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/d" } })).body;
    await purchase("u5");
    const count = async (id: string) => (await call("GET", `/integrations/partners/${id}/deliveries`)).body.items.length;
    expect([await count(prodOnly.id), await count(typed.id), await count(paused.id), await count(later.id)]).toEqual([0, 0, 0, 1]);
    await call("POST", `/integrations/partners/${later.id}`, { enabled: false });
    const { f, seen } = fake();
    await run(f);
    expect(seen).toHaveLength(0);
    await call("POST", `/integrations/partners/${later.id}`, { enabled: true });
    await run(f);
    expect(seen.map((s) => s.url)).toEqual(["https://hooks.slack.com/d"]);
  });

  it("sends a test event to one integration with a customer's attributes", async () => {
    const call = api();
    const slack = (await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/t" } })).body;
    const meta = (await call("POST", "/integrations/partners", { type: "meta", settings: { dataset_id: "999", access_token: "EAA_tok", test_event_code: "TEST42" } })).body;
    const t = await call("POST", `/integrations/partners/${slack.id}/test`, {});
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ object: "integration_delivery", event_type: "TEST", status: "pending" });
    const customer = await purchase("u6");
    await setAttributes(h.db, customer.id, { $fbAnonId: { value: "fb-anon" }, $attConsentStatus: { value: "authorized" } }, h.now());
    await h.db.delete(schema.integrationDeliveries).where(eq(schema.integrationDeliveries.integrationId, meta.id));
    expect((await call("POST", `/integrations/partners/${meta.id}/test`, { app_user_id: "nobody" })).body.param).toBe("app_user_id");
    await call("POST", `/integrations/partners/${meta.id}/test`, { app_user_id: "u6" });
    const { f, seen } = fake((r) => new Response(r.url.includes("facebook") ? '{"events_received":1}' : "ok", { status: 200 }));
    await run(f);
    const slackTexts = seen.filter((s) => s.url === "https://hooks.slack.com/t").map((s) => JSON.parse(s.body).text as string);
    expect(slackTexts.some((t) => /^Customer \$RCAnonymousID:[0-9a-f]{32} is a test customer: Slack is connected to RevenueDot: test_product\.$/.test(t))).toBe(true);
    const metaBody = JSON.parse(seen.find((s) => s.url.includes("graph.facebook.com/v21.0/999/events"))!.body);
    expect(metaBody).toMatchObject({ test_event_code: "TEST42", data: [{ event_name: "Subscribe", user_data: { anon_id: "fb-anon" } }] });
    // Without a test event code a Meta test would count as a real conversion, so it is skipped.
    await call("POST", `/integrations/partners/${meta.id}`, { settings: { test_event_code: null } });
    await h.db.delete(schema.integrationDeliveries).where(eq(schema.integrationDeliveries.integrationId, meta.id));
    await call("POST", `/integrations/partners/${meta.id}/test`, { app_user_id: "u6" });
    const before = seen.length;
    await run(f);
    expect(seen.length).toBe(before);
    const [skipped] = (await call("GET", `/integrations/partners/${meta.id}/deliveries`)).body.items;
    expect(skipped).toMatchObject({ status: "skipped", event_type: "TEST" });
    expect((await call("POST", `/integrations/partners/${slack.id}`, { enabled: false })).status).toBe(200);
    expect((await call("POST", `/integrations/partners/${slack.id}/test`, {})).status).toBe(422);
  });

  it("BigQuery signs in with the service account and creates the table on first insert", async () => {
    const call = api();
    const bq = (await call("POST", "/integrations/partners", { type: "bigquery", settings: { service_account_json: JSON.stringify(keys.sa), dataset_id: "revenue" } })).body;
    expect(bq.secrets.service_account_json.hint).toBe("rd@scanner.iam.gserviceaccount.com");
    await purchase("u7");
    let created = false;
    const { f, seen } = fake(async (r) => {
      if (r.url === "https://oauth2.googleapis.com/token") {
        const { payload } = await jwtVerify(new URLSearchParams(r.body).get("assertion")!, keys.publicKey, { issuer: keys.sa.client_email, audience: "https://oauth2.googleapis.com/token", currentDate: h.now() });
        expect(payload.scope).toBe("https://www.googleapis.com/auth/bigquery");
        return Response.json({ access_token: "ya29.bq", expires_in: 3600 });
      }
      if (r.url.endsWith("/tables")) { created = true; return Response.json({ id: "scanner:revenue.revenuedot_events" }); }
      if (!created) return Response.json({ error: { code: 404, message: "Not found: Table scanner:revenue.revenuedot_events" } }, { status: 404 });
      return Response.json({ kind: "bigquery#tableDataInsertAllResponse" });
    });
    await run(f);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST https://oauth2.googleapis.com/token",
      "POST https://bigquery.googleapis.com/bigquery/v2/projects/scanner/datasets/revenue/tables/revenuedot_events/insertAll",
      "POST https://bigquery.googleapis.com/bigquery/v2/projects/scanner/datasets/revenue/tables",
      "POST https://bigquery.googleapis.com/bigquery/v2/projects/scanner/datasets/revenue/tables/revenuedot_events/insertAll",
    ]);
    expect(JSON.parse(seen[2]!.body).schema.fields.map((x: any) => x.name)).toContain("revenue_usd");
    expect(seen[3]!.headers.get("authorization")).toBe("Bearer ya29.bq");
    const [d] = (await call("GET", `/integrations/partners/${bq.id}/deliveries`)).body.items;
    expect(d).toMatchObject({ status: "delivered", sent_as: "INITIAL_PURCHASE" });
    expect(d.request_body).not.toContain("ya29.bq");
  });

  it("a delivery whose secrets cannot be decrypted waits on the retry schedule with a clear message", async () => {
    const call = api();
    await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/z" } });
    await purchase("u8");
    const { f } = fake();
    await tick(h.db, h.now(), f, { encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) });
    const [d] = await h.db.select().from(schema.integrationDeliveries);
    expect([d!.status, d!.attempts, d!.lastError]).toEqual(["pending", 1, "The credentials were encrypted with a different key (REVENUEDOT_ENCRYPTION_KEY or REVENUEDOT_SIGNING_KEY changed). Enter them again."]);
    expect(d!.nextAttemptAt.getTime()).toBe(h.now().getTime() + 5 * MIN);
  });
});

describe("delivery under load and misconfiguration", () => {
  it("does not follow redirects, refuses a retry while the delivery is leased, and gives up on a delivery that keeps dying", async () => {
    const call = api();
    const slack = (await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/redirect" } })).body;
    await purchase("r1");
    const { f, seen } = fake(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    await run(f);
    expect(seen.map((r) => r.url)).toEqual(["https://hooks.slack.com/redirect"]);
    const D = schema.integrationDeliveries;
    let [d] = await h.db.select().from(D);
    expect(d!.lastError).toMatch(/redirect, which is not followed/);
    expect(d!.responseBody ?? "").toBe("");

    // A tick holds the lease: Retry answers 409 instead of queueing a second send.
    await h.db.update(D).set({ status: "pending", nextAttemptAt: new Date(h.now().getTime() + 10 * MIN) }).where(eq(D.id, d!.id));
    const locked = await call("POST", `/integrations/partners/${slack.id}/deliveries/${d!.id}/retry`);
    expect([locked.status, locked.body.type]).toEqual([409, "resource_locked_error"]);

    // Claimed once more than the retry schedule allows (each earlier claim died with the tick): failed without sending.
    await h.db.update(D).set({ status: "pending", nextAttemptAt: h.now(), attempts: 6 }).where(eq(D.id, d!.id));
    const before = seen.length;
    await run(f);
    [d] = await h.db.select().from(D);
    expect([d!.status, seen.length - before]).toEqual(["failed", 0]);
    expect(d!.lastError).toMatch(/Gave up/);
  });

  it("two overlapping ticks send each delivery once", async () => {
    const call = api();
    await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/once" } });
    for (const u of ["o1", "o2", "o3"]) await purchase(u);
    const { f, seen } = fake(async () => { await new Promise((r) => setTimeout(r, 20)); return new Response("ok"); });
    await Promise.all([run(f), run(f)]);
    expect(seen).toHaveLength(3);
    const rows = await h.db.select().from(schema.integrationDeliveries);
    expect(rows.map((d) => [d.status, d.attempts])).toEqual([["delivered", 1], ["delivered", 1], ["delivered", 1]]);
  });

  it("a big backlog in one integration does not starve another project's integration", async () => {
    const call = api();
    const busy = (await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/busy" } })).body;
    for (let i = 0; i < 30; i++) await purchase(`b${i}`);
    const quiet = (await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/quiet" } })).body;
    await purchase("q1");
    expect((await h.db.select().from(schema.integrationDeliveries).where(eq(schema.integrationDeliveries.integrationId, busy.id))).length).toBe(31);
    const { f, seen } = fake();
    await run(f);
    // At most 10 per integration per tick, so the quiet one goes out in the first tick.
    expect(seen.filter((s) => s.url.endsWith("/busy"))).toHaveLength(10);
    expect(seen.filter((s) => s.url.endsWith("/quiet"))).toHaveLength(1);
    expect(quiet.id).toBeTruthy();
  });

  it("refuses private-network URLs on Cloud and metadata addresses everywhere, without sending", async () => {
    const call = api();
    await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "http://127.0.0.1:9/slack" } });
    const meta = await call("POST", "/integrations/partners", { type: "posthog", settings: { api_key: "phc_x", region: "custom", host: "http://169.254.169.254" } });
    expect(meta.status).toBe(400);
    expect(meta.body.param).toBe("settings.host");
    const cloud = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY, edition: "cloud" });
    const res = await cloud.fetch(new Request("http://localhost/v2/projects/proj1/integrations/partners", {
      method: "POST", headers: { Authorization: `Bearer ${h.ids.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "slack", settings: { webhook_url: "https://10.0.0.8/hook" } }),
    }));
    expect(res.status).toBe(400);
    await purchase("p1");
    const { f, seen } = fake();
    await tick(h.db, h.now(), f, { encryptionKey: KEY, strictUrls: true });
    expect(seen).toHaveLength(0);
    const [d] = await h.db.select().from(schema.integrationDeliveries);
    expect([d!.status, d!.lastError]).toEqual(["failed", "The slack URL must be an https URL. Fix the integration's settings, then replay."]);
  });

  it("a malformed REVENUEDOT_ENCRYPTION_KEY leaves deliveries queued and the rest of the tick running", async () => {
    const call = api();
    await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/k" } });
    await purchase("k1");
    const { f, seen } = fake();
    const r = await tick(h.db, h.now(), f, { encryptionKey: "bm90LTMyLWJ5dGVz" });
    expect(r).toMatchObject({ integrations: 0, exports: 0 });
    expect(r.alerts).toBeDefined();
    expect(seen).toHaveLength(0);
    const [d] = await h.db.select().from(schema.integrationDeliveries);
    expect([d!.status, d!.attempts]).toEqual(["pending", 0]);
    await run(f);
    expect(seen).toHaveLength(1);
  });

  it("escapes Slack control characters in customer and product ids", async () => {
    const call = api();
    await call("POST", "/integrations/partners", { type: "slack", settings: { webhook_url: "https://hooks.slack.com/esc" } });
    await purchase("<!channel> <https://evil.example|Reset>");
    const { f, seen } = fake();
    await run(f);
    const text = JSON.parse(seen[0]!.body).text as string;
    expect(text).toContain("&lt;!channel&gt; &lt;https://evil.example|Reset&gt;");
    expect(text).not.toContain("<!channel>");
  });
});
