import { describe, expect, it } from "vitest";
import {
  CC_BUILTIN, CC_LANGUAGES, CC_PATH_TYPES, CC_STRINGS, ccLanguageOf, ccOfferRefs, ccStringFor, defaultCustomerCenter, mergeConfig, newCcPath, pickCcLocale,
  resolveCcOfferRefs, sdkCustomerCenter, validateCustomerCenter,
} from "../src/customer-center/index.js";

const dflt = () => defaultCustomerCenter("help@scanner.app") as unknown as Record<string, any>;

describe("languages", () => {
  it("has the 33 languages, each with every built-in string and phrase", () => {
    expect(CC_LANGUAGES).toHaveLength(33);
    const langs = CC_LANGUAGES.map((l) => l.code).filter((c) => c !== "en");
    expect(Object.keys(CC_BUILTIN).sort()).toEqual([...langs].sort());
    const keys = Object.keys(CC_BUILTIN.de!.strings);
    const phrases = Object.keys(CC_BUILTIN.de!.phrases);
    for (const l of langs) {
      expect(Object.keys(CC_BUILTIN[l]!.strings), l).toEqual(keys);
      expect(Object.keys(CC_BUILTIN[l]!.phrases), l).toEqual(phrases);
      for (const v of [...Object.values(CC_BUILTIN[l]!.strings), ...Object.values(CC_BUILTIN[l]!.phrases)]) expect(v.trim(), l).not.toBe("");
    }
    for (const k of keys) expect(CC_STRINGS[k], k).toBeTypeOf("string");
  });

  it("maps device locales to a language", () => {
    expect(ccLanguageOf("de_DE")).toBe("de");
    expect(ccLanguageOf("pt-BR")).toBe("pt");
    expect(ccLanguageOf("zh_Hant_TW")).toBe("zh_Hant");
    expect(ccLanguageOf("zh-HK")).toBe("zh_Hant");
    expect(ccLanguageOf("zh_CN")).toBe("zh_Hans");
    expect(ccLanguageOf("nb_NO")).toBe("no");
    expect(ccLanguageOf("iw_IL")).toBe("he");
    expect(ccLanguageOf("az_AZ")).toBeNull();
    expect(pickCcLocale("az_AZ,fr-CA,en_US")).toEqual({ language: "fr", locale: "fr_CA" });
    expect(pickCcLocale(null)).toEqual({ language: "en", locale: "en_US" });
    expect(pickCcLocale("az_AZ", "en_GB")).toEqual({ language: "en", locale: "en_GB" });
  });
});

describe("validation", () => {
  it("accepts the default and every new path type", () => {
    expect(validateCustomerCenter(dflt())).toEqual([]);
    const cfg = dflt();
    const paths = CC_PATH_TYPES.map((t) => newCcPath(t, []));
    paths.find((p) => p.type === "CUSTOM_URL")!.url = "myapp://support";
    paths.find((p) => p.type === "CUSTOM_ACTION")!.action_identifier = "open_chat";
    cfg.screens.MANAGEMENT.paths = paths;
    expect(validateCustomerCenter(cfg)).toEqual([]);
    expect(paths.find((p) => p.type === "CANCEL")!.feedback_survey!.options.map((o) => o.title)).toEqual(["Too expensive", "Don't use the app", "Bought by mistake"]);
  });

  it("names each problem by its field", () => {
    const cfg = mergeConfig(dflt(), {
      screens: { MANAGEMENT: { title: "", paths: [{ id: "x", type: "CUSTOM_URL", title: "Site", url: "not a url" }, { id: "y", type: "REFUND_REQUEST", title: "Refund", promotional_offer: { title: "Stay", product_mapping: { pro: "" } } }] } },
      appearance: { dark: { text_color: "#12345" } },
    });
    expect(validateCustomerCenter(cfg)).toEqual([
      "appearance.dark.text_color: must be a hex colour such as #1A1A1A.",
      "screens.MANAGEMENT.title: cannot be empty.",
      "screens.MANAGEMENT.paths[0].url: needs a full URL, such as https://example.com/help or myapp://support.",
      "screens.MANAGEMENT.paths[1].promotional_offer.product_mapping.pro: needs the store offer id.",
    ]);
    expect(validateCustomerCenter(null)).toEqual(["customer_center: must be an object."]);
  });
});

describe("the SDK shape", () => {
  it("fills promotional offers, drops paths the SDK cannot act on, keeps only valid colours", () => {
    const cfg = mergeConfig(dflt(), {
      appearance: { light: { accent_color: "#ABCDEF", text_color: "red" } },
      screens: {
        MANAGEMENT: {
          title: "Help", subtitle: "",
          paths: [
            { id: "a", type: "CUSTOM_URL", title: "No URL" },
            { id: "b", type: "CANCEL", title: "Cancel", promotional_offer: { title: "Stay", product_mapping: { pro: "off" } }, url: "https://ignored.example" },
            { id: "c", type: "TELEPORT", title: "?" },
          ],
        },
      },
    });
    const out = sdkCustomerCenter(cfg) as any;
    expect(out.appearance).toEqual({ light: { accent_color: "#ABCDEF" }, dark: {} });
    expect(out.screens.MANAGEMENT).toEqual({
      type: "MANAGEMENT", title: "Help",
      paths: [{ id: "b", title: "Cancel", type: "CANCEL", promotional_offer: { ios_offer_id: "off", android_offer_id: "off", eligible: true, title: "Stay", subtitle: "", product_mapping: { pro: "off" } } }],
    });
    expect(Object.keys(out)).toEqual(["appearance", "screens", "localization", "support", "change_plans"]);
  });

  it("translates default texts, keeps custom texts, and lets translations and custom strings win", () => {
    const cfg = mergeConfig(dflt(), {
      screens: { NO_ACTIVE: { title: "Nothing here", title_localizations: { fr: "Rien ici" } } },
      localization: { localized_strings: { done: "OK" }, custom_strings: { fr: { done: "Terminé !" }, en: { dismiss: "Close" } } },
    });
    const fr = sdkCustomerCenter(cfg, { preferredLocales: "fr_FR" }) as any;
    expect(fr.screens.NO_ACTIVE.title).toBe("Rien ici");
    expect(fr.screens.MANAGEMENT.title).toBe(CC_BUILTIN.fr!.phrases["Manage subscription"]);
    expect(fr.localization.localized_strings.done).toBe("Terminé !");
    expect(fr.localization.localized_strings.dismiss).toBe(CC_BUILTIN.fr!.strings.dismiss);
    const en = sdkCustomerCenter(cfg) as any;
    expect(en.localization.localized_strings).toMatchObject({ done: "OK", dismiss: "Close", contact_support: "Contact support" });
    expect(ccStringFor(cfg, "fr", "done")).toEqual({ value: "Terminé !", source: "custom" });
    expect(ccStringFor(cfg, "de", "done").source).toBe("built-in");
    expect(ccStringFor(cfg, "en", "refund_status")).toEqual({ value: "Refund status", source: "default" });
  });

  it("falls back to the default screen when a stored screen is broken", () => {
    const out = sdkCustomerCenter({ screens: { MANAGEMENT: "oops" }, support: { email: 3 } }) as any;
    expect(out.screens.MANAGEMENT.paths.map((p: any) => p.id)).toEqual(["path_cancel", "path_refund", "path_missing"]);
    expect(out.screens.NO_ACTIVE.title).toBe("No active subscriptions");
    expect(out.support.email).toBe("");
    expect(out.change_plans).toEqual([]);
  });
});

describe("promotional offer references, tickets and offerings", () => {
  const withRefs = () => mergeConfig(dflt(), {
    screens: {
      MANAGEMENT: {
        title: "Help",
        paths: [
          { id: "c", type: "CANCEL", title: "Cancel", promotional_offer: { retention_offer_id: "ro_1" }, feedback_survey: { title: "Why?", options: [{ id: "o1", title: "Price", promotional_offer: { retention_offer_id: "ro_2" } }, { id: "o2", title: "Other" }] } },
          { id: "r", type: "REFUND_REQUEST", title: "Refund", promotional_offer: null },
        ],
      },
    },
  });

  it("finds, validates and resolves references; a missing offer becomes no offer", () => {
    const cfg = withRefs();
    expect(validateCustomerCenter(cfg)).toEqual([]);
    expect(ccOfferRefs(cfg)).toEqual([
      { id: "ro_1", at: "screens.MANAGEMENT.paths[0].promotional_offer" },
      { id: "ro_2", at: "screens.MANAGEMENT.paths[0].feedback_survey.options[0].promotional_offer" },
    ]);
    const resolved = resolveCcOfferRefs(cfg, (id) => (id === "ro_1" ? { title: "Stay", product_mapping: { pro: "stay" } } : null)) as any;
    const out = sdkCustomerCenter(resolved) as any;
    const cancel = out.screens.MANAGEMENT.paths[0];
    expect(cancel.promotional_offer).toMatchObject({ title: "Stay", ios_offer_id: "stay", product_mapping: { pro: "stay" } });
    expect(cancel.feedback_survey.options[0]).toEqual({ id: "o1", title: "Price" });
    expect(out.screens.MANAGEMENT.paths[1]).toEqual({ id: "r", title: "Refund", type: "REFUND_REQUEST" });
    expect(JSON.stringify(out)).not.toContain("retention_offer_id");
  });

  it("rejects a reference mixed with an offer of its own, bad ticket settings and offerings", () => {
    const cfg = mergeConfig(dflt(), {
      screens: { NO_ACTIVE: { title: "None", offering: { type: "SPECIFIC" }, paths: [] }, MANAGEMENT: { title: "Help", paths: [{ id: "c", type: "CANCEL", title: "x", promotional_offer: { retention_offer_id: "ro_1", title: "Also" } }] } },
      support: { support_tickets: { allow_creation: "yes", customer_type: "everyone" } },
    });
    expect(validateCustomerCenter(cfg)).toEqual([
      "support.support_tickets.allow_creation: must be true or false.",
      "support.support_tickets.customer_type: must be one of active, not_active, all, none.",
      "screens.MANAGEMENT.paths[0].promotional_offer: is either a reference to a Retention offer (retention_offer_id) or an offer of its own, not both.",
      "screens.NO_ACTIVE.offering.offering_id: is required for a specific offering.",
    ]);
  });

  it("sends only the support and offering fields the SDKs decode", () => {
    const out = sdkCustomerCenter(mergeConfig(dflt(), {
      support: { email: "a@b.co", internal_note: "x", display_purchase_history_link: "yes", support_tickets: { allow_creation: true, customer_type: "bogus", customer_details: { idfv: true, email: "x" } } },
      screens: { NO_ACTIVE: { title: "None", paths: [], offering: { type: "CURRENT", button_text: "See plans", extra: 1 } } },
    })) as any;
    expect(out.support).toEqual({ email: "a@b.co", should_warn_customer_to_update: false, display_user_details_section: true, display_virtual_currencies: false, support_tickets: { allow_creation: true, customer_type: "not_active", customer_details: { idfv: true } } });
    expect(out.screens.NO_ACTIVE.offering).toEqual({ type: "CURRENT", button_text: "See plans" });
  });
});
