import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";
import { setAppleRootsForTesting } from "../src/stores/apple/index.js";
import { REJECTED_LIMIT, backfillRejected, ipBucket, pruneRejected } from "../src/stores/rejected.js";
import { signStripePayload } from "../src/stores/stripe/signature.js";
import { APP_ID as APPLE_APP, appleHarness, makePki, notificationBody, renewalInfo, signJws, transaction, type Pki } from "./apple-fixtures.js";
import * as amazon from "./amazon-helpers.js";
import * as google from "./google-helpers.js";
import * as stripe from "./stripe-helpers.js";
import * as stores3 from "./stores3-helpers.js";
import { harness } from "../../../packages/contract/src/harness.js";
import { notificationHealth } from "../src/routes/v2/notification-health.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";

/**
 * Anyone who knows an app id can POST to its notification URL. Requests without a valid signature (or, for stores with no
 * authentication set up, ones the store does not vouch for) are rejected requests: answered 4xx, kept apart, rate limited
 * per app and IP, and never part of the app's notification status. Only failures of authenticated notifications (and our
 * own processing errors) turn an app to "Notifications failing".
 */

let close: (() => Promise<void>) | null = null;
afterEach(async () => { await close?.(); close = null; });

type Health = { notification_status: string; last_notification_error: unknown; rejected_requests: { last_24h: number; last: { at: number; message: string } | null } };

async function rows(db: DB, appId: string) {
  return db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.appId, appId));
}

/** The app's status as the setup page and the app settings page read it. */
async function status(call: (path: string, init?: RequestInit & { key?: string | null }) => Promise<Response>, project: string, key: string, appId: string) {
  const settings = await (await call(`/v2/projects/${project}/apps/${appId}/store_settings`, { key })).json();
  const health = await (await call(`/v2/projects/${project}/setup_health`, { key })).json();
  const app = health.apps.find((a: { id: string }) => a.id === appId) as Health;
  expect(settings.notification_status).toBe(app.notification_status);
  expect(settings.rejected_requests).toEqual(app.rejected_requests);
  return app;
}

/** The app's status straight from notification-health (the Apple harness has no dashboard key). */
async function healthOf(db: DB, appId: string, now: Date) {
  const [app] = await db.select().from(schema.apps).where(eq(schema.apps.id, appId));
  return notificationHealth(db, app!, now) as Promise<Health>;
}

/** The status after only rejected requests: not failing, and the rejected ones counted apart. */
function expectRejectedOnly(h: Health, n: number) {
  expect(h.notification_status).not.toBe("failing");
  expect(h.last_notification_error).toBeNull();
  expect(h.rejected_requests.last_24h).toBe(n);
  expect(h.rejected_requests.last?.message).toMatch(/^rejected: /);
}

describe("App Store", () => {
  let pki: Pki;
  beforeAll(async () => { pki = await makePki(); setAppleRootsForTesting([pki.rootPem]); });
  afterAll(() => setAppleRootsForTesting(null));

  it("junk, forged bodies and Apple-signed payloads for another app are rejected requests; a broken transaction inside this app's notification turns it to failing", async () => {
    const h = await appleHarness();
    close = h.close;
    const forged = JSON.stringify({ signedPayload: await signJws({ notificationType: "DID_RENEW", data: { bundleId: "com.example.scanner" } }, await makePki()) });
    for (const body of ["junk", JSON.stringify({}), JSON.stringify({ signedPayload: "a.b.c" }), forged]) expect((await h.notify(body)).status).toBe(400);
    const stored = await rows(h.db, APPLE_APP);
    expect(stored).toHaveLength(4);
    expect(stored.every((r) => r.rejected && r.id.includes("_rejected_"))).toBe(true);
    // Apple signed it, but for another app: anyone holding any signed App Store payload could post it.
    const otherApp = JSON.stringify({ signedPayload: await signJws({ notificationType: "TEST", signedDate: h.now().getTime(), data: { bundleId: "com.evil.app", environment: "Production" } }, pki) });
    expect((await h.notify(otherApp)).status).toBe(400);
    let s = await healthOf(h.db, APPLE_APP, h.now());
    expectRejectedOnly(s, 5);

    // Apple's notification for this app whose transaction cannot be used: a real failure.
    const broken = await notificationBody(pki, "DID_RENEW", undefined, transaction({ bundleId: "com.evil.app" }), renewalInfo(), {});
    expect((await h.notify(broken)).status).toBe(400);
    s = await healthOf(h.db, APPLE_APP, h.now());
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(5);
  });

  it("rejected requests are rate limited per app and IP: past the limit they are answered 429 and not kept", async () => {
    const h = await appleHarness();
    close = h.close;
    const post = (ip: string) => h.request(`/v1/notifications/apple/${APPLE_APP}`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: "junk" });
    for (let i = 0; i < REJECTED_LIMIT; i++) expect((await post("203.0.113.7")).status).toBe(400);
    expect((await post("203.0.113.7")).status).toBe(429);
    // Another address has its own allowance.
    expect((await post("198.51.100.9")).status).toBe(400);
    expect(await rows(h.db, APPLE_APP)).toHaveLength(REJECTED_LIMIT + 1);
    // A real notification still goes through.
    expect((await h.notify(await notificationBody(pki, "TEST", undefined, null, null, { signedDate: h.now().getTime() }))).status).toBe(200);
    expect((await healthOf(h.db, APPLE_APP, h.now())).notification_status).toBe("ready");
  });
});

describe("Google Play", () => {
  it("without push authentication: junk, another package and unknown tokens are rejected requests", async () => {
    const keys = await google.makeKeys();
    const e = await google.env(keys);
    close = () => e.h.close();
    const app = e.h.ids.androidApp;
    expect((await e.call(`/v1/notifications/google/${app}`, { method: "POST", json: { message: { data: "bm9wZQ", messageId: "1" } } })).status).toBe(200);
    expect((await e.rtdn({ packageName: "com.other.app", subscriptionNotification: { notificationType: 2, purchaseToken: "t", subscriptionId: "pro" } })).status).toBe(200);
    expect((await e.rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: "tok_missing", subscriptionId: "pro" } })).status).toBe(200);
    expect((await rows(e.h.db, app)).every((r) => r.rejected)).toBe(true);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, app), 3);
  });

  it("with push authentication: a push without a valid token is rejected (401); an authenticated push with an unknown token turns the app to failing", async () => {
    const keys = await google.makeKeys();
    const aud = "https://api.example.com/v1/notifications/google/app_play";
    const e = await google.env(keys, { pubsub_audience: aud, pubsub_service_account: "pubsub@scanner.iam.gserviceaccount.com" });
    close = () => e.h.close();
    const app = e.h.ids.androidApp;
    const note = { subscriptionNotification: { notificationType: 2, purchaseToken: "tok_missing", subscriptionId: "pro" } };
    expect((await e.rtdn(note)).status).toBe(401);
    expect((await e.rtdn(note, { auth: `Bearer ${await google.pushToken(keys, e.g, "https://wrong")}` })).status).toBe(401);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, app), 2);
    expect((await e.rtdn(note, { auth: `Bearer ${await google.pushToken(keys, e.g, aud)}` })).status).toBe(200);
    const s = await status(e.call, e.h.ids.project, e.h.ids.secretKey, app);
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(2);
  });
});

describe("Google Play audience only", () => {
  it("a token for the audience from any service account is required but proves nothing: an unknown token is a rejected request", async () => {
    const keys = await google.makeKeys();
    const aud = "https://api.example.com/v1/notifications/google/app_play";
    const e = await google.env(keys, { pubsub_audience: aud });
    close = () => e.h.close();
    const note = { subscriptionNotification: { notificationType: 2, purchaseToken: "tok_missing", subscriptionId: "pro" } };
    expect((await e.rtdn(note)).status).toBe(401);
    expect((await e.rtdn(note, { auth: `Bearer ${await google.pushToken(keys, e.g, aud, "attacker@evil.iam.gserviceaccount.com")}` })).status).toBe(200);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.h.ids.androidApp), 2);
  });

  it("without push authentication, a junk message with a real message's id does not make the real one a duplicate", async () => {
    const keys = await google.makeKeys();
    const e = await google.env(keys);
    close = () => e.h.close();
    expect((await e.rtdn({ subscriptionNotification: { notificationType: 20, purchaseToken: "x", subscriptionId: "pro" } }, { messageId: "m-real" })).status).toBe(200);
    const res = await e.rtdn({ testNotification: { version: "1.0" } }, { messageId: "m-real" });
    expect(await res.json()).toEqual({ status: "processed" });
    expect((await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.h.ids.androidApp)).notification_status).toBe("ready");
  });
});

describe("Amazon Appstore", () => {
  // One key pair for the file: the server caches the SNS certificate by its URL.
  let keys: amazon.SnsKeys;
  beforeAll(async () => { keys = await amazon.makeSnsKeys(); });
  it("unsigned and foreign-topic messages are rejected requests; a signed one from the app's topic for another package turns the app to failing", async () => {
    const e = await amazon.env(keys, { sns_topic_arn: amazon.TOPIC });
    close = () => e.h.close();
    const msg = { appPackageName: amazon.PKG, notificationType: "SUBSCRIPTION_RENEWED", receiptId: "r1" };
    expect((await e.call(`/v1/notifications/amazon/${e.appId}`, { method: "POST", body: "junk" })).status).toBe(400);
    const signed = await amazon.snsMessage(keys, { message: msg });
    expect((await e.sns({ ...signed, Signature: "AAAA" })).status).toBe(400);
    expect((await e.sns(await amazon.snsMessage(keys, { message: msg, topic: "arn:aws:sns:us-east-1:999999999999:someone-else" }))).status).toBe(400);
    const stored = await rows(e.h.db, e.appId);
    expect(stored.filter((r) => r.rejected)).toHaveLength(2);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId), 2);

    expect((await e.sns(await amazon.snsMessage(keys, { message: { ...msg, appPackageName: "com.other.app" } }))).status).toBe(200);
    const s = await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId);
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(2);
  });

  it("with no topic saved, the topic pinned from the first message proves nothing: a message for another package is a rejected request", async () => {
    const e = await amazon.env(keys);
    close = () => e.h.close();
    const other = { appPackageName: "com.other.app", notificationType: "SUBSCRIPTION_RENEWED", receiptId: "r1" };
    // The second message from the pinned topic proves no more than the first.
    for (let i = 0; i < 2; i++) expect((await e.sns(await amazon.snsMessage(keys, { message: other }))).status).toBe(200);
    const confirm = await amazon.snsMessage(keys, { type: "SubscriptionConfirmation", message: "subscribe" });
    expect((await e.sns({ ...confirm, SubscribeURL: "https://evil.example.com/confirm" })).status).toBe(400);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId), 3);
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, e.appId));
    expect(row!.credentials).toMatchObject({ sns_topic_arn_auto: amazon.TOPIC });
    expect(row!.credentials?.sns_topic_arn).toBeUndefined();
  });
});

describe("Stripe", () => {
  it("unsigned, wrongly signed and secret-less events are rejected requests; a signed body that is not an event turns the app to failing", async () => {
    const e = await stripe.env();
    close = () => e.h.close();
    expect((await e.webhook("customer.subscription.updated", { id: "sub_1" }, { signature: null })).status).toBe(400);
    expect((await e.webhook("customer.subscription.updated", { id: "sub_1" }, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await e.call(`/v1/notifications/stripe/${e.appId}`, { method: "POST", body: "junk" })).status).toBe(400);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId), 3);

    const raw = JSON.stringify({ hello: "world" });
    const sig = await signStripePayload(stripe.WHSEC, raw, Math.floor(e.h.now().getTime() / 1000));
    expect((await e.call(`/v1/notifications/stripe/${e.appId}`, { method: "POST", headers: { "stripe-signature": sig }, body: raw })).status).toBe(400);
    const s = await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId);
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(3);
  });

  it("the platform's Connect endpoint refuses unsigned events without touching any app", async () => {
    const h = await harness();
    close = () => h.close();
    const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), stripeConnect: { clientId: "ca_test", secretKey: "sk_test_x", webhookSecrets: [stripe.WHSEC] } as never });
    const res = await app.fetch(new Request("http://localhost/v1/notifications/stripe-connect", { method: "POST", body: JSON.stringify({ id: "evt_1", type: "invoice.paid", account: "acct_1" }) }));
    expect(res.status).toBe(400);
    expect(await h.db.select().from(schema.storeNotifications)).toHaveLength(0);
  });
});

describe("Paddle", () => {
  it("unsigned and wrongly signed events are rejected requests; a signed body that is not an event turns the app to failing", async () => {
    const e = await stores3.env("paddle");
    close = () => e.h.close();
    expect((await e.notify("junk")).status).toBe(400);
    expect((await e.notify(JSON.stringify({ event_id: "evt_1", event_type: "subscription.updated" }), { "paddle-signature": "ts=1;h1=00" })).status).toBe(400);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId), 2);

    const signed = await e.paddle.sign({ hello: "world" });
    expect((await e.notify(signed.body, { "paddle-signature": signed.signature })).status).toBe(400);
    const s = await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId);
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(2);
  });
});

describe("Roku", () => {
  it("unsigned and forged pushes are rejected requests; a signed push for a transaction Roku does not know turns the app to failing", async () => {
    const e = await stores3.env("roku");
    close = () => e.h.close();
    const b = e.roku.buy("scanner_monthly", { price: 4.99 });
    const m = e.roku.cancel(b.transaction.transactionId as string)[0]!;
    expect((await e.notify("not a jwt")).status).toBe(400);
    expect((await e.notify((await e.roku.sign(m, { forged: true })).body)).status).toBe(400);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId), 2);

    expect((await e.notify((await e.roku.sign({ ...m, transactionId: "f".repeat(32) })).body)).status).toBe(200);
    const s = await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId);
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(2);
  });
});

describe("Galaxy Store", () => {
  it("with the IAP public key: unsigned and wrongly signed notifications are rejected; a signed one for another package turns the app to failing", async () => {
    const e = await stores3.env("galaxy");
    close = () => e.h.close();
    const n = e.galaxy.test()[0]!;
    const otherKey = (await new (await import("../../../packages/contract/src/fake-galaxy.js")).FakeGalaxy().keys()).iapPrivateKey;
    expect((await e.notify("junk")).status).toBe(400);
    expect((await e.notify((await e.galaxy.sign(n, { key: otherKey })).body)).status).toBe(400);
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId), 2);

    expect((await e.notify((await e.galaxy.sign(n, { audience: ["com.other.app"] })).body)).status).toBe(400);
    const s = await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId);
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(2);
  });

  it("a saved IAP public key that cannot be read is a real failure", async () => {
    const e = await stores3.env("galaxy");
    close = () => e.h.close();
    await e.setCredentials({ galaxy_service_account_id: "acct", galaxy_service_account_private_key: (await e.galaxy.keys()).serviceAccountPrivateKey, galaxy_iap_public_key: "not a key" });
    expect((await e.notify((await e.galaxy.sign(e.galaxy.test()[0]!)).body)).status).toBe(400);
    const s = await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId);
    expect(s.notification_status).toBe("failing");
    expect(s.rejected_requests.last_24h).toBe(0);
  });

  it("without the key: a notification for a purchase Samsung does not know is a rejected request, and its id stays free", async () => {
    const keys = await new (await import("../../../packages/contract/src/fake-galaxy.js")).FakeGalaxy().keys();
    const e = await stores3.env("galaxy");
    close = () => e.h.close();
    await e.setCredentials({ galaxy_service_account_id: "acct", galaxy_service_account_private_key: (await e.galaxy.keys()).serviceAccountPrivateKey });
    const n = e.galaxy.n("ARS_UNSUBSCRIBED", { firstPurchaseId: "0123456789abcdef0123456789abcdef", firstOrderId: "S20260901KR00000001" });
    expect((await e.notify((await e.galaxy.sign(n, { key: keys.iapPrivateKey })).body)).status).toBe(200);
    const stored = await rows(e.h.db, e.appId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ rejected: true });
    expect(stored[0]!.id).toContain("_rejected_");
    expectRejectedOnly(await status(e.call, e.h.ids.project, e.h.ids.secretKey, e.appId), 1);
  });
});

describe("Test Store", () => {
  it("has no notification URL: posts to any store's URL with a Test Store app id are refused and change nothing", async () => {
    const h = await harness();
    close = () => h.close();
    const app = createApp({ db: h.db, now: h.now, stores: defaultStores() });
    const testApp = (await h.db.select().from(schema.apps).where(eq(schema.apps.type, "test_store")))[0]!;
    for (const store of ["apple", "google", "amazon", "stripe", "paddle", "roku", "galaxy", "test_store"]) {
      const res = await app.fetch(new Request(`http://localhost/v1/notifications/${store}/${testApp.id}`, { method: "POST", body: "junk" }));
      // 404 from the store routes; /v1/notifications/test_store/… is no route at all and falls to the SDK API's key check.
      expect(res.status).toBe(store === "test_store" ? 401 : 404);
    }
    expect(await h.db.select().from(schema.storeNotifications)).toHaveLength(0);
  });
});

describe("rejected request bookkeeping", () => {
  it("IPv6 addresses share a bucket per /64; IPv4 addresses do not", () => {
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe(ipBucket("2001:0db8:0001:0002:ffff:1:2:3"));
    expect(ipBucket("2001:db8:1:2::9")).not.toBe(ipBucket("2001:db8:1:3::9"));
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
  });

  it("the backfill marks old unauthenticated rows of a project rejected, keeps real failures, and old rejected rows are pruned after a week", async () => {
    const h = await harness();
    close = () => h.close();
    const now = new Date("2026-10-03T12:00:00Z");
    const ios = (await h.db.select().from(schema.apps).where(eq(schema.apps.type, "app_store")))[0]!;
    const play = (await h.db.select().from(schema.apps).where(eq(schema.apps.type, "play_store")))[0]!;
    const row = (id: string, appId: string, store: string, error: string, receivedAt = now) => ({ id, projectId: h.ids.project, appId, store, body: "{}", error, receivedAt });
    await h.db.insert(schema.storeNotifications).values([
      row("a1", ios.id, "app_store", "The signed payload is not valid: Malformed JWS."),
      row("a2", ios.id, "app_store", "The body is not JSON."),
      row("a3", ios.id, "app_store", "The notification could not be processed."),
      row("g1", play.id, "play_store", "invalid purchase token: gone"),
      row("s1", ios.id, "stripe", "rejected: The Stripe-Signature header is missing."),
    ]);
    await backfillRejected(h.db, h.ids.project);
    const byId = Object.fromEntries((await h.db.select().from(schema.storeNotifications)).map((r) => [r.id, r.rejected]));
    expect(byId).toEqual({ a1: true, a2: true, a3: false, g1: true, s1: true });

    await h.db.insert(schema.storeNotifications).values({ ...row("old", ios.id, "app_store", "rejected: x", new Date(now.getTime() - 8 * 86_400_000)), rejected: true });
    await pruneRejected(h.db, now);
    expect((await h.db.select().from(schema.storeNotifications)).map((r) => r.id).sort()).toEqual(["a1", "a2", "a3", "g1", "s1"]);
  });
});
