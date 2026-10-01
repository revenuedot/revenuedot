import { describe, expect, it } from "vitest";
import { PAYWALL_TEMPLATES, fillLocales, iconName, paywallIconSvg, validatePaywall, type Json } from "../src/index.js";

// Each case was found by mutating real paywalls and decoding them with the iOS SDK (scripts/e2e/paywall-decode): the SDK
// fails to decode the whole paywall, so publishing must refuse it.
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const base = () => clone(PAYWALL_TEMPLATES[0]!.build({ termsUrl: "https://example.com/t", privacyUrl: "https://example.com/p" })) as unknown as Json;
const first = (root: unknown, type: string): Json => {
  let hit: Json | null = null;
  const walk = (x: unknown) => { if (hit || !x || typeof x !== "object") return; if ((x as Json).type === type && (x as Json).id !== undefined) { hit = x as Json; return; } Object.values(x as Json).forEach(walk); };
  walk(root);
  if (!hit) throw new Error(`no ${type}`);
  return hit;
};
const errorsOf = (d: Json) => validatePaywall(d).errors.map((e) => e.path);

describe("publish validation refuses what the iOS SDK cannot decode", () => {
  it("checks every locale's values, not only the default locale", () => {
    const d = base();
    d.components_localizations.fr_FR = { a: 1 };
    expect(errorsOf(d)).toContain("components_localizations.fr_FR.a");
    d.components_localizations.fr_FR = "Bonjour";
    expect(errorsOf(d)).toContain("components_localizations.fr_FR");
    d.components_localizations.fr_FR = { a: { foo: 1 } };
    expect(errorsOf(d).some((p) => p.startsWith("components_localizations.fr_FR.a"))).toBe(true);
    const img = { width: 10, height: 10, original: "https://e.com/a.png", heic: "https://e.com/a.heic", heic_low_res: "https://e.com/a.heic" };
    d.components_localizations.fr_FR = { a: { light: img } };
    expect(errorsOf(d)).toEqual([]);
  });

  it("checks exit offers and the default locale's type", () => {
    const d = base();
    d.exit_offers = { dismiss: { offering: "x" } };
    expect(errorsOf(d)).toContain("exit_offers.dismiss.offering_id");
    d.exit_offers = "x";
    expect(errorsOf(d)).toContain("exit_offers");
    d.exit_offers = { dismiss: { offering_id: "ofrng1" } };
    expect(errorsOf(d)).toEqual([]);
    d.default_locale = 5;
    expect(errorsOf(d)).toContain("default_locale");
  });

  it("checks optional fields the SDK decodes strictly", () => {
    const cases: [string, (d: Json) => void, string][] = [
      ["button transition", (d) => { first(d.components_config, "button").transition = "fade"; }, ".transition"],
      ["button state updates", (d) => { first(d.components_config, "button").state_updates = {}; }, ".state_updates"],
      ["button destination", (d) => { first(d.components_config, "button").action = { type: "navigate_to", destination: 3 }; }, ".action.destination"],
      ["package promo code", (d) => { first(d.components_config, "package").apple_promo_offer_product_code = 1; }, ".apple_promo_offer_product_code"],
      ["package haptics", (d) => { first(d.components_config, "package").haptic_feedback_enabled = "yes"; }, ".haptic_feedback_enabled"],
      ["purchase method open_method", (d) => { first(d.components_config, "purchase_button").method = { type: "web_checkout", open_method: 1 }; }, ".method.open_method"],
      ["purchase method auto_dismiss", (d) => { first(d.components_config, "purchase_button").method = { type: "web_checkout", auto_dismiss: "no" }; }, ".method.auto_dismiss"],
      ["image mask", (d) => { first(d.components_config, "stack").components.push({ type: "image", id: "im1", source: { light: { width: 1, height: 1, original: "https://e.com/a.png", heic: "https://e.com/a.png", heic_low_res: "https://e.com/a.png" } }, size: { width: { type: "fill" }, height: { type: "fit" } }, fit_mode: "fit", mask_shape: "circle" }); }, ".mask_shape"],
      ["web view protocol", (d) => { first(d.components_config, "stack").components.push({ type: "web_view", id: "wv1", protocol_version: 2, url: "https://e.com", size: { width: { type: "fill" }, height: { type: "fit" } } }); }, ".protocol_version"],
    ];
    for (const [name, mutate, suffix] of cases) {
      const d = base();
      mutate(d);
      expect(errorsOf(d).some((p) => p.endsWith(suffix)), name).toBe(true);
    }
  });

  it("accepts a web view with another protocol version when it has a fallback", () => {
    const d = base();
    const text = clone(first(d.components_config, "text"));
    first(d.components_config, "stack").components.push({ type: "web_view", id: "wv1", protocol_version: 2, url: "https://e.com", size: { width: { type: "fill" }, height: { type: "fit" } }, fallback: { ...text, id: "fb1" } });
    expect(errorsOf(d)).toEqual([]);
  });
});

describe("icon names", () => {
  it("resolve only to built-in icons, never to Object.prototype members", () => {
    for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(iconName(n), n).not.toBe(n.toLowerCase());
      expect(typeof iconName(n)).toBe("string");
      expect(paywallIconSvg(n.toLowerCase())).toBeNull();
    }
    expect(iconName("Check.png")).toBe("check");
  });
});

describe("translations", () => {
  it("fall back to the default locale when missing or cleared", () => {
    const filled = fillLocales({ en_US: { a: "Hello", b: "Bye", c: "" }, de_DE: { a: "", b: "Tschüss", c: "" } }, "en_US");
    expect(filled.de_DE).toEqual({ a: "Hello", b: "Tschüss", c: "" });
    const d = base();
    const key = Object.keys(d.components_localizations.en_US)[0]!;
    d.components_localizations.de_DE = { [key]: "" };
    expect(validatePaywall(d).warnings.some((w) => w.path === "components_localizations.de_DE")).toBe(true);
  });
});
