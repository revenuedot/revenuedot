import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../src/harness.js";
import { CustomerCenterAndroidSchema, CustomerCenterIosSchema } from "../src/sdk-schemas.js";
import { v2 } from "./v2-helpers.js";

/**
 * Customer Center (prd/customer-center/PRD.md): `GET /v1/customercenter/{id}` decodes with the fields each SDK requires
 * (purchases-ios `CustomerCenterConfigResponse`, purchases-android `CustomerCenterConfigData`), for the default and for a
 * full configuration saved through the editor's API, in English and in another language.
 */

const fx = (p: string) => JSON.parse(readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8"));
const CONFIG = "/v2/projects/{project_id}/customer_center_config";

/** Everything the editor can set: every path type, a survey with offers, a refund offer, colours, translations, custom strings. */
export const FULL_CONFIG = {
  support: { email: "help@scanner.app", should_warn_customer_to_update: true, display_purchase_history_link: false, display_user_details_section: true },
  appearance: {
    light: { accent_color: "#F4A900", text_color: "#111111", background_color: "#FFFFFF", button_text_color: "#FFFFFF", button_background_color: "#111111" },
    dark: { accent_color: "#F4A900", text_color: "#FAFAFA", background_color: "#000000", button_text_color: "#000000", button_background_color: "#FAFAFA" },
  },
  screens: {
    MANAGEMENT: {
      type: "MANAGEMENT", title: "How can we help?", title_localizations: { de: "Wie können wir dir helfen?" },
      paths: [
        { id: "p_missing", type: "MISSING_PURCHASE", title: "Missing purchase" },
        { id: "p_plans", type: "CHANGE_PLANS", title: "Change plans" },
        {
          id: "p_manage", type: "CANCEL", title: "Cancel subscription", title_localizations: { de: "Abo beenden" },
          promotional_offer: { title: "Stay for less", subtitle: "50% off for 3 months", product_mapping: { pro_monthly: "stay_50" } },
          feedback_survey: {
            title: "Why are you cancelling?",
            options: [
              { id: "o_price", title: "Too expensive", promotional_offer: { title: "Half price", subtitle: "Keep Pro for less", product_mapping: { pro_monthly: "half", "pro:monthly": "half-play" }, ios_offer_id: "half", android_offer_id: "half-play" } },
              { id: "o_use", title: "Don't use the app" },
              { id: "o_mistake", title: "Bought by mistake", title_localizations: { de: "Aus Versehen gekauft" } },
            ],
          },
        },
        { id: "p_refund", type: "REFUND_REQUEST", title: "Request a refund", promotional_offer: { title: "A free month instead?", product_mapping: { pro_annual: "free_month" } } },
        { id: "p_help", type: "CUSTOM_URL", title: "Help center", url: "https://scanner.app/help", open_method: "IN_APP" },
        { id: "p_chat", type: "CUSTOM_ACTION", title: "Chat with us", action_identifier: "open_chat" },
      ],
    },
    NO_ACTIVE: { type: "NO_ACTIVE", title: "No subscriptions found", subtitle: "Check your past purchases", paths: [{ id: "p_restore", type: "MISSING_PURCHASE", title: "Restore purchases" }] },
  },
  localization: { locale: "en_US", localized_strings: {}, custom_strings: { en: { contact_support: "Write to us" }, de: { contact_support: "Schreib uns" } } },
};

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const sdk = async (locales?: string, key = h.ids.iosKey) => {
  const res = await h.fetch("/v1/customercenter/cc_user", { key, headers: locales ? { "X-Preferred-Locales": locales } : {} });
  expect(res.status).toBe(200);
  return await res.json() as any;
};
const decodes = (body: unknown) => {
  const ios = CustomerCenterIosSchema.safeParse(body);
  expect(ios.success, ios.success ? "" : JSON.stringify(ios.error.issues.slice(0, 5))).toBe(true);
  const android = CustomerCenterAndroidSchema.safeParse(body);
  expect(android.success, android.success ? "" : JSON.stringify(android.error.issues.slice(0, 5))).toBe(true);
};

describe("Customer Center: what the SDKs decode", () => {
  it("the upstream fixtures pass the iOS and Android schemas (the schemas are not too strict)", () => {
    expect(CustomerCenterIosSchema.safeParse(fx("ios/resp-customer-center-config.json")).success).toBe(true);
    expect(CustomerCenterAndroidSchema.safeParse(fx("android/customer_center_config.json")).success).toBe(true);
    // The schemas do catch what breaks a decoder: a missing title, an unknown open method on Android.
    expect(CustomerCenterIosSchema.safeParse({ customer_center: { ...fx("ios/resp-customer-center-config.json").customer_center, change_plans: undefined } }).success).toBe(false);
    const bad = fx("android/customer_center_config.json");
    bad.customer_center.screens.MANAGEMENT.paths[4].open_method = "POPUP";
    expect(CustomerCenterAndroidSchema.safeParse(bad).success).toBe(false);
  });

  it("the default configuration decodes on both SDKs and keeps today's paths", async () => {
    const body = await sdk();
    decodes(body);
    expect(body.customer_center.screens.MANAGEMENT.paths.map((p: any) => p.id)).toEqual(["path_cancel", "path_refund", "path_missing"]);
    expect(body.customer_center.localization).toMatchObject({ locale: "en_US", localized_strings: { contact_support: "Contact support" } });
    // A German phone gets the built-in German strings and screen texts.
    const de = await sdk("de_DE,en_US", h.ids.androidKey);
    decodes(de);
    expect(de.customer_center.localization.locale).toBe("de_DE");
    expect(de.customer_center.localization.localized_strings.restore_purchases).toBe("Käufe wiederherstellen");
    expect(de.customer_center.screens.MANAGEMENT.paths[0].title).not.toBe("Cancel subscription");
  });

  it("a full configuration saved through the API decodes on both SDKs, in order, in English and German, without editor-only fields", async () => {
    const saved = await call("POST", CONFIG, {}, { ext: true, json: { customer_center: FULL_CONFIG } });
    expect(saved.status).toBe(200);
    expect(saved.body.config.screens.MANAGEMENT.paths).toHaveLength(6);

    const en = await sdk("en_GB");
    decodes(en);
    const cc = en.customer_center;
    expect(JSON.stringify(cc)).not.toMatch(/_localizations|custom_strings/);
    expect(cc.screens.MANAGEMENT.title).toBe("How can we help?");
    expect(cc.screens.MANAGEMENT.paths.map((p: any) => p.type)).toEqual(["MISSING_PURCHASE", "CHANGE_PLANS", "CANCEL", "REFUND_REQUEST", "CUSTOM_URL", "CUSTOM_ACTION"]);
    const path = (id: string) => cc.screens.MANAGEMENT.paths.find((p: any) => p.id === id);
    expect(path("p_help")).toEqual({ id: "p_help", title: "Help center", type: "CUSTOM_URL", url: "https://scanner.app/help", open_method: "IN_APP" });
    expect(path("p_chat")).toEqual({ id: "p_chat", title: "Chat with us", type: "CUSTOM_ACTION", action_identifier: "open_chat" });
    expect(path("p_manage").promotional_offer).toEqual({ ios_offer_id: "stay_50", android_offer_id: "stay_50", eligible: true, title: "Stay for less", subtitle: "50% off for 3 months", product_mapping: { pro_monthly: "stay_50" } });
    expect(path("p_manage").feedback_survey.options.map((o: any) => o.id)).toEqual(["o_price", "o_use", "o_mistake"]);
    expect(path("p_manage").feedback_survey.options[0].promotional_offer).toMatchObject({ ios_offer_id: "half", android_offer_id: "half-play", product_mapping: { pro_monthly: "half", "pro:monthly": "half-play" } });
    expect(path("p_refund").promotional_offer).toMatchObject({ ios_offer_id: "free_month", subtitle: "", product_mapping: { pro_annual: "free_month" } });
    expect(cc.appearance.dark).toEqual(FULL_CONFIG.appearance.dark);
    expect(cc.support).toMatchObject({ email: "help@scanner.app", should_warn_customer_to_update: true, display_purchase_history_link: false });
    expect(cc.localization).toMatchObject({ locale: "en_GB", localized_strings: { contact_support: "Write to us" } });

    const de = (await sdk("de_AT", h.ids.androidKey)).customer_center;
    decodes({ customer_center: de });
    expect(de.screens.MANAGEMENT.title).toBe("Wie können wir dir helfen?");
    expect(de.screens.MANAGEMENT.paths.find((p: any) => p.id === "p_manage").title).toBe("Abo beenden");
    expect(de.screens.MANAGEMENT.paths.find((p: any) => p.id === "p_help").title).toBe("Help center");
    expect(de.screens.MANAGEMENT.paths.find((p: any) => p.id === "p_manage").feedback_survey.options[2].title).toBe("Aus Versehen gekauft");
    expect(de.localization.localized_strings.contact_support).toBe("Schreib uns");
    expect(de.localization.localized_strings.restore_purchases).toBe("Käufe wiederherstellen");

    // An unsupported language falls back to English with the configured locale.
    expect((await sdk("az_AZ")).customer_center.localization.locale).toBe("en_US");
    // API v2 shows a customer's configuration in a given language too.
    await h.fetch("/v1/subscribers/cc_user", { key: h.ids.iosKey });
    const v2de = await call("GET", "/v2/projects/{project_id}/customers/{customer_id}/customer_center", { customer_id: "cc_user" }, { query: "locale=de_DE" });
    expect(v2de.body.customer_center.screens.MANAGEMENT.title).toBe("Wie können wir dir helfen?");
  });

  it("rejects what the SDKs could not act on, and stores nothing", async () => {
    const bad = async (patch: unknown, message: RegExp) => {
      const res = await call("POST", CONFIG, {}, { ext: true, json: { customer_center: patch } });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.message).toMatch(message);
    };
    const mgmt = (paths: unknown[]) => ({ screens: { MANAGEMENT: { type: "MANAGEMENT", title: "Help", paths } } });
    await bad(mgmt([{ id: "a", type: "CUSTOM_URL", title: "Site" }]), /paths\[0\]\.url: needs a full URL/);
    await bad(mgmt([{ id: "a", type: "CUSTOM_ACTION", title: "Chat", action_identifier: "has spaces" }]), /action_identifier/);
    await bad(mgmt([{ id: "a", type: "CANCEL", title: "x" }, { id: "b", type: "CANCEL", title: "y" }]), /Manage can appear only once/);
    await bad(mgmt([{ id: "a", type: "CUSTOM_URL", title: "x", url: "https://a.b" }, { id: "a", type: "CUSTOM_URL", title: "y", url: "https://a.b" }]), /used twice/);
    await bad(mgmt([{ id: "a", type: "TELEPORT", title: "x" }]), /type: must be one of/);
    await bad(mgmt([{ id: "a", type: "MISSING_PURCHASE", title: "" }]), /title: cannot be empty/);
    await bad(mgmt([{ id: "a", type: "MISSING_PURCHASE", title: "x", feedback_survey: { title: "Why?", options: [{ id: "o", title: "x" }] } }]), /only shown on the Manage/);
    await bad(mgmt([{ id: "a", type: "CANCEL", title: "x", promotional_offer: { title: "Stay", product_mapping: {} } }]), /needs at least one product/);
    await bad(mgmt([{ id: "a", type: "CANCEL", title: "x", feedback_survey: { title: "Why?", options: [] } }]), /at least one option/);
    await bad({ appearance: { light: { accent_color: "gold" } } }, /appearance\.light\.accent_color: must be a hex colour/);
    await bad({ support: { email: "nope" } }, /support\.email/);
    await bad({ localization: { custom_strings: { klingon: { done: "x" } } } }, /not a supported language/);
    await bad({ screens: { MANAGEMENT: { title: "x", title_localizations: { xx: "y" } } } }, /title_localizations\.xx/);
    await bad({ screens: { SETTINGS: { title: "x", paths: [] } } }, /only MANAGEMENT and NO_ACTIVE/);
    expect((await call("GET", CONFIG, {}, { ext: true })).body.overrides).toBeNull();
    // A partial override (what the Support page and older clients send) still merges over the default.
    expect((await call("POST", CONFIG, {}, { ext: true, json: { customer_center: { support: { email: "a@b.co" } } } })).status).toBe(200);
    decodes(await sdk());
  });
});
