import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { env, makeKeys, pushToken, sub, type Env, type Keys } from "./google-helpers.js";
import { contextFor } from "../src/services/targeting.js";

const T0 = new Date("2026-09-01T12:00:00Z");
const MONTH_END = new Date("2026-10-01T12:00:00Z");

let keys: Keys;
let e: Env;
beforeAll(async () => { keys = await makeKeys(); });
afterEach(async () => { await e?.h.close(); });

const health = async () => (await (await e.call("/v2/projects/proj1/setup_health", { key: e.h.ids.secretKey })).json());
const playApp = async () => (await health()).apps.find((a: any) => a.id === "app_play");
const settings = async () => (await e.call("/v2/projects/proj1/apps/app_play/store_settings", { key: e.h.ids.secretKey })).json();
// With Pub/Sub push authentication on, so a message with an invalid token is Google's and counts as a failure.
const AUD = "https://api.example.com/v1/notifications/google/app_play";
const note = async (notificationType: number, purchaseToken: string) =>
  e.rtdn({ subscriptionNotification: { version: "1.0", notificationType, purchaseToken, subscriptionId: "pro" } }, { auth: `Bearer ${await pushToken(keys, e.g, AUD)}` });

describe("setup health marks an app Ready only after a notification was processed", () => {
  it("waiting, then failing on an invalid token (not Ready), received for an untracked purchase, Ready after a processed one, failing again on an outage", async () => {
    e = await env(keys, { pubsub_audience: AUD });
    expect(await playApp()).toMatchObject({ notification_status: "waiting", last_notification_at: null, last_notification_error: null });

    await note(2, "tok_missing");
    let app = await playApp();
    expect(app).toMatchObject({ notification_status: "failing", last_notification_at: null, last_notification_received_at: T0.getTime() });
    expect(app.last_notification_error).toMatchObject({ type: "SUBSCRIPTION_RENEWED", message: expect.stringMatching(/invalid purchase token/) });
    expect((await settings())).toMatchObject({ last_notification_at: null, notification_status: "failing", last_notification_error: expect.stringMatching(/invalid purchase token/) });

    e.h.setNow(new Date(T0.getTime() + 60_000));
    e.g.subs.set("tok_new", sub({ start: T0, expiry: MONTH_END, order: "GPA.N" }));
    await note(4, "tok_new");
    expect(await playApp()).toMatchObject({ notification_status: "received", last_notification_at: null });

    e.h.setNow(new Date(T0.getTime() + 120_000));
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1" }));
    await e.receipt({ app_user_id: "u", fetch_token: "tok_pro_1", product_ids: ["pro"], platform_product_ids: [{ product_id: "pro", base_plan_id: "monthly" }] });
    await note(2, "tok_pro_1");
    app = await playApp();
    expect(app).toMatchObject({ notification_status: "ready", last_notification_at: T0.getTime() + 120_000 });
    // The earlier failure stays visible, but it no longer makes the app failing.
    expect(app.last_notification_error.type).toBe("SUBSCRIPTION_RENEWED");
    expect((await settings())).toMatchObject({ notification_status: "ready", last_notification_error: null, last_notification_at: T0.getTime() + 120_000 });

    e.h.setNow(new Date(T0.getTime() + 180_000));
    e.g.override = () => new Response("down", { status: 500 });
    expect((await note(2, "tok_pro_1")).status).toBe(500);
    e.g.override = null;
    app = await playApp();
    expect(app).toMatchObject({ notification_status: "failing", last_notification_at: T0.getTime() + 120_000 });
    const [row] = await e.h.db.select().from(schema.apps).where(eq(schema.apps.id, "app_play"));
    expect(row!.lastNotificationAt!.getTime()).toBe(T0.getTime() + 120_000);
  });
});

describe("Google Play credentials count as configured under every field the Play adapter reads", () => {
  it("service_account (object or JSON text) and play_service_account_credentials_json are configured everywhere: setup health, the app, store settings", async () => {
    e = await env(keys);
    const app = async () => (await (await e.call("/v2/projects/proj1/apps/app_play", { key: e.h.ids.secretKey })).json()).play_store;
    const set = (credentials: Record<string, unknown>) => e.h.db.update(schema.apps).set({ credentials }).where(eq(schema.apps.id, "app_play"));
    // google-helpers saves the service account as an object under `service_account`, which the adapter verifies purchases with.
    e.g.subs.set("tok_pro_1", sub({ start: T0, expiry: MONTH_END, order: "GPA.1" }));
    expect((await e.receipt({ app_user_id: "u", fetch_token: "tok_pro_1", product_ids: ["pro"], platform_product_ids: [{ product_id: "pro", base_plan_id: "monthly" }] })).status).toBe(200);
    for (const credentials of [{ service_account: keys.sa }, { service_account: JSON.stringify(keys.sa) }, { play_service_account_credentials_json: JSON.stringify(keys.sa) }]) {
      await set(credentials);
      expect((await playApp()).credentials_configured).toBe(true);
      expect((await app()).play_service_account_credentials_configured).toBe(true);
      expect((await settings()).credentials.play_service_account).toEqual({ configured: true, client_email: keys.sa.client_email });
    }
    await set({});
    expect((await playApp()).credentials_configured).toBe(false);
    expect((await app()).play_service_account_credentials_configured).toBe(false);
    expect((await settings()).credentials.play_service_account).toEqual({ configured: false, client_email: null });
  });
});

describe("SDK versions", () => {
  const sdk = (path: string, headers: Record<string, string>, key = e.h.ids.iosKey) => e.call(path, { key, headers });
  const ios = { "X-Platform": "iOS", "X-Platform-Version": "Version 18.4 (Build 22E240)", "X-Version": "5.91.0", "X-Platform-Flavor": "native", "X-Client-Version": "2.3.0", "X-Client-Build-Version": "412", "X-Client-Bundle-ID": "com.example.scanner" };

  it("stores the App Store storefront (alpha-3) as a two-letter country, like imported customers, so country targeting matches", async () => {
    e = await env(keys);
    await sdk("/v1/subscribers/user_store", { ...ios, "X-Storefront": "USA" });
    await sdk("/v1/subscribers/user_play", { "X-Platform": "android", "X-Version": "9.2.0", "X-Storefront": "DE" }, e.h.ids.androidKey);
    const country = async (id: string) => (await e.h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, id)))[0]!.lastSeenCountry;
    expect(await country("user_store")).toBe("US");
    expect(await country("user_play")).toBe("DE");
    const v2 = await (await e.call("/v2/projects/proj1/customers/user_store", { key: e.h.ids.secretKey })).json();
    expect(v2.last_seen_country).toBe("US");
    expect((await contextFor(e.h.db, null, { "x-storefront": "GBR" }, T0)).country).toBe("GB");
  });

  it("records each SDK build per app from the SDK headers, throttled, and lists them in setup_health with a support level", async () => {
    e = await env(keys);
    await sdk("/v1/subscribers/user_1", ios);
    await sdk("/v1/subscribers/user_1/offerings", ios);
    await sdk("/v1/subscribers/user_2", { "X-Platform": "android", "X-Platform-Version": "34", "X-Version": "9.2.0", "X-Platform-Flavor": "react-native", "X-Platform-Flavor-Version": "8.1.0", "X-Client-Version": "2.3.0", "X-Client-Bundle-ID": "com.example.scanner" }, e.h.ids.androidKey);
    await sdk("/v1/subscribers/user_3", { "X-Platform": "iOS", "X-Version": "4.43.0" });
    // A secret key is a server, not an SDK.
    await sdk("/v1/subscribers/user_4", { "X-Platform": "iOS", "X-Version": "1.0.0" }, e.h.ids.secretKey);

    const list = (await health()).sdk_versions;
    expect(list).toHaveLength(3);
    const byVersion = Object.fromEntries(list.map((v: any) => [v.sdk_version, v]));
    expect(byVersion["5.91.0"]).toEqual({
      app_id: "app_ios", platform: "iOS", platform_flavor: "native", platform_flavor_version: null, sdk_version: "5.91.0", support: "verified", customers_30d: 1,
      caveats: [expect.stringMatching(/^Trusted Entitlements/)],
      platform_version: "Version 18.4 (Build 22E240)", app_version: "2.3.0", app_build: "412", bundle_id: "com.example.scanner", last_app_user_id: "user_1",
      first_seen_at: T0.getTime(), last_seen_at: T0.getTime(),
    });
    expect(byVersion["9.2.0"]).toMatchObject({ app_id: "app_play", platform: "android", platform_flavor: "react-native", platform_flavor_version: "8.1.0", support: "verified", customers_30d: 1 });
    expect(byVersion["9.2.0"].caveats).toEqual([expect.stringMatching(/^Trusted Entitlements/), expect.stringMatching(/Paywall and ad events/)]);
    expect(byVersion["4.43.0"]).toMatchObject({ support: "untested" });

    // The customer keeps the last SDK it was seen with.
    const [c] = await e.h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, "user_1"));
    expect(c).toMatchObject({ lastSeenSdkVersion: "5.91.0", lastSeenSdkFlavor: "native", lastSeenPlatformVersion: "Version 18.4 (Build 22E240)", lastSeenAppBuild: "412", lastSeenAppVersion: "2.3.0" });

    // Within a minute the row is not written again; after a minute last_seen_at moves.
    e.h.setNow(new Date(T0.getTime() + 30_000));
    await sdk("/v1/subscribers/user_1", ios);
    expect((await health()).sdk_versions.find((v: any) => v.sdk_version === "5.91.0").last_seen_at).toBe(T0.getTime());
    e.h.setNow(new Date(T0.getTime() + 90_000));
    await sdk("/v1/subscribers/user_1", ios);
    expect((await health()).sdk_versions.find((v: any) => v.sdk_version === "5.91.0")).toMatchObject({ last_seen_at: T0.getTime() + 90_000, first_seen_at: T0.getTime() });
  });
});
