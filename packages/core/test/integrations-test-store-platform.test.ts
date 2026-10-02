import { describe, expect, it } from "vitest";
import { buildIntegration, platformOf, type IntegrationKind, type Plan, type WebhookEvent } from "../src/integrations/index.js";

/**
 * Regression (found by the integrations journey, scripts/e2e/journeys/integrations.ts): a Test Store purchase made in
 * the iOS app was skipped by every platform-bound integration ("TEST_STORE purchases are not sent to AppsFlyer's mobile
 * API"), so a developer could not test AppsFlyer, Adjust, Firebase, Branch or Kochava with the Test Store, even with
 * their sandbox keys saved. A Test Store event now takes the platform the customer's SDK last reported.
 */

const at = (k: string, v: string) => ({ [k]: { value: v, updated_at_ms: 1789990000000 } });
const testStore: WebhookEvent = {
  id: "5E7B1C2A-1111-4222-8333-444455550001", type: "INITIAL_PURCHASE", event_timestamp_ms: 1790000000000, app_id: "app_test",
  app_user_id: "user_42", original_app_user_id: "user_42", aliases: ["user_42"], product_id: "pro_monthly", period_type: "NORMAL",
  purchased_at_ms: 1790000000000, expiration_at_ms: 1792592000000, environment: "SANDBOX", entitlement_ids: ["pro"], transaction_id: "test_1",
  original_transaction_id: "test_1", country_code: "US", currency: "USD", price: 9.99, price_in_purchased_currency: 9.99, store: "TEST_STORE",
  takehome_percentage: 1, tax_percentage: 0, commission_percentage: 0,
  subscriber_attributes: {
    ...at("$appsflyerId", "1700000000000-1234567"), ...at("$adjustId", "adid_9f8e"), ...at("$idfa", "AEBE52E7-03EE-455A-B3C4-E57283966239"),
    ...at("$idfv", "7B4E1C2A-19F2-4E0B-9C0F-2D4A7B1E9A11"), ...at("$gpsAdId", "38400000-8cf0-11bd-b23e-10b96e40000d"), ...at("$attConsentStatus", "authorized"),
    ...at("$firebaseAppInstanceId", "0123456789abcdef0123456789abcdef"), ...at("$kochavaDeviceId", "KA123"),
  },
};

const CONFIG: Partial<Record<IntegrationKind, { settings: Record<string, any>; secrets: Record<string, string> }>> = {
  appsflyer: { settings: { ios_app_id: "id123456789", android_app_id: "com.example.app" }, secrets: { dev_key: "af_live", sandbox_dev_key: "af_sandbox" } },
  adjust: { settings: { ios_app_token: "ios_tok", android_app_token: "and_tok", event_tokens: { initial_purchase: "ev_ip" } }, secrets: {} },
  firebase: { settings: { ios_firebase_app_id: "1:123:ios:abc", android_firebase_app_id: "1:123:android:def" }, secrets: { ios_api_secret: "ga_ios", android_api_secret: "ga_android" } },
  branch: { settings: {}, secrets: { branch_key: "key_live_x", sandbox_branch_key: "key_test_x" } },
  kochava: { settings: { ios_app_guid: "ko-ios", sandbox_ios_app_guid: "ko-ios-test", sandbox_android_app_guid: "ko-and-test" }, secrets: {} },
};

const build = (kind: IntegrationKind, platform: string | null): Promise<Plan> =>
  buildIntegration(kind, { event: testStore, ...CONFIG[kind]!, now: new Date(1790000001000), context: { projectId: "p", platform } });

describe("Test Store events take the SDK's platform", () => {
  it("maps TEST_STORE by the reported SDK platform and leaves the real stores alone", () => {
    expect(platformOf("TEST_STORE", "iOS")).toBe("ios");
    expect(platformOf("TEST_STORE", "macOS")).toBe("ios");
    expect(platformOf("TEST_STORE", "Android")).toBe("android");
    expect(platformOf("TEST_STORE", "web")).toBe("other");
    expect(platformOf("TEST_STORE", null)).toBe("other");
    expect(platformOf("TEST_STORE")).toBe("other");
    expect(platformOf("APP_STORE", "Android")).toBe("ios");
    expect(platformOf("PLAY_STORE", "iOS")).toBe("android");
  });

  it("sends a Test Store purchase from the iOS SDK to the iOS app with the sandbox keys", async () => {
    const af = await build("appsflyer", "iOS");
    expect("skip" in af).toBe(false);
    if ("skip" in af) return;
    expect(af.requests[0]!.url).toBe("https://api2.appsflyer.com/inappevent/id123456789");
    expect(af.requests[0]!.headers.authentication).toBe("af_sandbox");
    expect(JSON.parse(af.requests[0]!.body)).toMatchObject({ appsflyer_id: "1700000000000-1234567", idfa: "AEBE52E7-03EE-455A-B3C4-E57283966239" });

    const adj = await build("adjust", "iOS");
    expect("skip" in adj ? adj.skip : new URLSearchParams(adj.requests[0]!.body).get("app_token")).toBe("ios_tok");
    if (!("skip" in adj)) expect(new URLSearchParams(adj.requests[0]!.body).get("environment")).toBe("sandbox");

    const fb = await build("firebase", "iOS");
    expect("skip" in fb ? fb.skip : fb.requests[0]!.url).toBe("https://www.google-analytics.com/mp/collect?firebase_app_id=1%3A123%3Aios%3Aabc&api_secret=ga_ios");

    const br = await build("branch", "iOS");
    expect("skip" in br ? br.skip : JSON.parse(br.requests[0]!.body).branch_key).toBe("key_test_x");

    const ko = await build("kochava", "iOS");
    expect("skip" in ko ? ko.skip : JSON.parse(ko.requests[0]!.body).kochava_app_id).toBe("ko-ios-test");
  });

  it("sends a Test Store purchase from the Android SDK to the Android app", async () => {
    const af = await build("appsflyer", "Android");
    expect("skip" in af ? af.skip : af.requests[0]!.url).toBe("https://api2.appsflyer.com/inappevent/com.example.app");
    const fb = await build("firebase", "Android");
    expect("skip" in fb ? fb.skip : fb.requests[0]!.url).toContain("firebase_app_id=1%3A123%3Aandroid%3Adef");
    const ko = await build("kochava", "Android");
    expect("skip" in ko ? ko.skip : JSON.parse(ko.requests[0]!.body).data.device_ids).toEqual({ adid: "38400000-8cf0-11bd-b23e-10b96e40000d" });
  });

  it("still skips a Test Store purchase when no SDK platform is known", async () => {
    const af = await build("appsflyer", null);
    expect(af).toEqual({ skip: "TEST_STORE purchases are not sent to AppsFlyer's mobile API." });
    const fb = await build("firebase", null);
    expect(fb).toEqual({ skip: "TEST_STORE purchases have no Firebase app stream." });
  });
});
