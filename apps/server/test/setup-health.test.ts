import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { env, makeKeys, sub, type Env, type Keys } from "./google-helpers.js";

const T0 = new Date("2026-09-01T12:00:00Z");
const MONTH_END = new Date("2026-10-01T12:00:00Z");

let keys: Keys;
let e: Env;
beforeAll(async () => { keys = await makeKeys(); });
afterEach(async () => { await e?.h.close(); });

const health = async () => (await (await e.call("/v2/projects/proj1/setup_health", { key: e.h.ids.secretKey })).json());
const playApp = async () => (await health()).apps.find((a: any) => a.id === "app_play");
const settings = async () => (await e.call("/v2/projects/proj1/apps/app_play/store_settings", { key: e.h.ids.secretKey })).json();
const note = (notificationType: number, purchaseToken: string) => e.rtdn({ subscriptionNotification: { version: "1.0", notificationType, purchaseToken, subscriptionId: "pro" } });

describe("setup health marks an app Ready only after a notification was processed", () => {
  it("waiting, then failing on an invalid token (not Ready), received for an untracked purchase, Ready after a processed one, failing again on an outage", async () => {
    e = await env(keys);
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

describe("SDK versions", () => {
  const sdk = (path: string, headers: Record<string, string>, key = e.h.ids.iosKey) => e.call(path, { key, headers });
  const ios = { "X-Platform": "iOS", "X-Platform-Version": "Version 18.4 (Build 22E240)", "X-Version": "5.91.0", "X-Platform-Flavor": "native", "X-Client-Version": "2.3.0", "X-Client-Build-Version": "412", "X-Client-Bundle-ID": "com.example.scanner" };

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
