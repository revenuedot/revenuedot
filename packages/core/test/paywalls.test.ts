import { describe, expect, it } from "vitest";
import {
  PAYWALL_ICONS, PAYWALL_TEMPLATES, blankPaywall, extractJson, fillLocales, forEachComponent, paywallAiMessages, paywallFromModel, paywallIconSvg,
  paywallTemplateList, repairPaywall, uiLocalizations, usedStringKeys, validatePaywall, variableWords, type Json,
} from "../src/index.js";

const ICONS = "https://api.example.com/assets/icons";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("template gallery", () => {
  it("has at least eight templates covering every filter: screens, purchase method, packages, tiers", () => {
    const list = paywallTemplateList();
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
    expect(list.some((t) => t.screens > 1)).toBe(true);
    expect(list.some((t) => t.purchase_method === "web")).toBe(true);
    expect(list.some((t) => t.tiers >= 2)).toBe(true);
    expect(new Set(list.map((t) => t.packages)).size).toBeGreaterThanOrEqual(3);
    for (const t of list) expect(t.evidence.length, t.id).toBeGreaterThan(20);
  });

  const inputs = [
    {},
    { appName: "Focus", packages: [{ id: "$rc_monthly" }, { id: "$rc_annual" }, { id: "$rc_weekly" }], colors: { accent: "#ff5500", background: "#fafafa" }, termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy", iconBaseUrl: ICONS },
    { appName: "Solo", packages: [{ id: "lifetime", label: "Forever" }], imageUrl: "https://example.com/hero.png", imageWidth: 1200, imageHeight: 600, colors: { background: "#000000" } },
    { packages: [{ id: "plus_m" }, { id: "plus_y" }, { id: "pro_m" }, { id: "pro_y" }], locale: "de_DE" },
  ];
  for (const t of PAYWALL_TEMPLATES) {
    it(`${t.id}: valid for every input, packages bound to the offering, one purchase button`, () => {
      for (const input of inputs) {
        const doc = t.build(input);
        const pkgs = input.packages?.map((p) => p.id) ?? ["$rc_annual", "$rc_monthly"];
        const v = validatePaywall(doc, { packages: pkgs });
        expect(v.errors, `${t.id} ${JSON.stringify(input)}`).toEqual([]);
        expect(v.warnings.filter((w) => !/selected by default/.test(w.message)), t.id).toEqual([]);
        const all: Json[] = [];
        forEachComponent(doc.components_config, (c) => all.push(c));
        expect(all.filter((c) => c.type === "purchase_button")).toHaveLength(1);
        const method = all.find((c) => c.type === "purchase_button")!.method.type;
        expect(method).toBe(t.purchase_method === "web" ? "web_checkout" : "in_app_checkout");
        for (const p of all.filter((c) => c.type === "package")) expect(pkgs).toContain(p.package_id);
        expect(doc.default_locale).toBe(input.locale ?? "en_US");
        for (const k of usedStringKeys(doc.components_config)) expect(doc.components_localizations[doc.default_locale]![k], k).toBeDefined();
        if (input.iconBaseUrl) for (const i of all.filter((c) => c.type === "icon")) expect(i.base_url).toBe(ICONS);
      }
    });
  }

  it("uses the components its metadata promises: a timeline, tabs, a carousel, a countdown, an image when given one", () => {
    const types = (id: string, input = {}) => { const s = new Set<string>(); forEachComponent(PAYWALL_TEMPLATES.find((t) => t.id === id)!.build(input).components_config, (c) => s.add(c.type)); return s; };
    expect(types("trial_timeline").has("timeline")).toBe(true);
    expect(types("tiers_tabs")).toEqual(expect.objectContaining({}));
    expect([...types("tiers_tabs")]).toEqual(expect.arrayContaining(["tabs", "tab_control", "tab_control_button"]));
    expect(types("onboarding_pages").has("carousel")).toBe(true);
    expect(types("countdown_offer").has("countdown")).toBe(true);
    expect(types("feature_hero", { imageUrl: "https://example.com/x.png" }).has("image")).toBe(true);
    // Yearly comes first and is selected.
    const pk: Json[] = [];
    forEachComponent(PAYWALL_TEMPLATES.find((t) => t.id === "annual_two_plan")!.build({ packages: [{ id: "$rc_monthly" }, { id: "$rc_annual" }] }).components_config, (c) => { if (c.type === "package") pk.push(c); });
    expect(pk.map((p) => [p.package_id, p.is_selected_by_default])).toEqual([["$rc_annual", true], ["$rc_monthly", false]]);
  });

  it("the blank paywall is valid", () => {
    expect(validatePaywall(blankPaywall()).errors).toEqual([]);
  });
});

describe("validation mirrors the SDK decoder", () => {
  const good = () => clone(PAYWALL_TEMPLATES.find((t) => t.id === "annual_two_plan")!.build());
  const first = (doc: Json, type: string) => { let f: Json | null = null; forEachComponent(doc.components_config, (c) => { if (!f && c.type === type) f = c; }); return f! as Json; };
  const errs = (doc: unknown) => validatePaywall(doc).errors.map((e) => `${e.path}: ${e.message}`);

  it("accepts the template", () => { expect(errs(good())).toEqual([]); });
  it("needs base, stack and background", () => {
    expect(errs({})).toEqual(expect.arrayContaining([expect.stringContaining("components_config.base")]));
    const d = good(); delete (d.components_config.base as Json).background;
    expect(errs(d)).toEqual([expect.stringContaining("background is required")]);
  });
  const cases: [string, string, (c: Json) => void, RegExp][] = [
    ["text", "font_weight", (c) => { delete c.font_weight; }, /font_weight is required/],
    ["text", "text_lid missing in locale", (c) => { c.text_lid = "nope"; }, /no string "nope"/],
    ["text", "font_size", (c) => { c.font_size = true; }, /font_size must be/],
    ["text", "color", (c) => { c.color = { light: { type: "rgb", value: 1 } }; }, /Colour type/],
    ["stack", "dimension", (c) => { delete c.dimension; }, /dimension is required/],
    ["stack", "margin", (c) => { delete c.margin; }, /margin is required/],
    ["stack", "gradient percent", (c) => { c.background = { type: "color", value: { light: { type: "linear", degrees: 90, points: [{ color: "#fff", percent: 50.5 }] } } }; }, /whole number/],
    ["icon", "formats", (c) => { delete c.formats; }, /formats is required/],
    ["icon", "base_url", (c) => { c.base_url = "not a url"; }, /base_url must be a URL/],
    ["package", "package_id", (c) => { delete c.package_id; }, /package_id is required/],
    ["package", "is_selected_by_default", (c) => { c.is_selected_by_default = "yes"; }, /true or false/],
    ["purchase_button", "action", (c) => { c.action = "buy_now"; }, /action must be/],
    ["button", "url", (c) => { c.action = { type: "navigate_to", destination: "terms" }; }, /url is required/],
  ];
  for (const [type, what, mutate, re] of cases) {
    it(`${type}: ${what}`, () => {
      const d = good();
      mutate(first(d, type));
      expect(errs(d).join("\n")).toMatch(re);
    });
  }
  it("timeline, tabs, carousel, countdown, video, web view and unknown types", () => {
    const tl = clone(PAYWALL_TEMPLATES.find((t) => t.id === "trial_timeline")!.build());
    delete first(tl, "timeline").items[0].icon;
    expect(errs(tl).join()).toMatch(/icon is required/);
    const tabs = clone(PAYWALL_TEMPLATES.find((t) => t.id === "tiers_tabs")!.build());
    first(tabs, "tabs").control.type = "segmented";
    first(tabs, "tab_control_button").tab_id = "ghost";
    expect(errs(tabs).join()).toMatch(/control.type must be buttons or toggle[\s\S]*ghost/);
    const car = clone(PAYWALL_TEMPLATES.find((t) => t.id === "onboarding_pages")!.build());
    first(car, "carousel").page_peek = 1.5;
    expect(errs(car).join()).toMatch(/page_peek must be a whole number/);
    const cd = clone(PAYWALL_TEMPLATES.find((t) => t.id === "countdown_offer")!.build());
    first(cd, "countdown").count_from = "weeks";
    first(cd, "countdown").style.date = "soon";
    expect(errs(cd).join()).toMatch(/ISO 8601[\s\S]*count_from/);
    const d = good();
    const s = (d.components_config.base.stack as Json).components;
    s.push({ id: "v1", type: "video", source: { light: { width: 10, height: 10, url: "https://example.com/v.mp4" } }, size: { width: { type: "fill" }, height: { type: "fit" } }, fit_mode: "fill", show_controls: false, auto_play: true, loop: true });
    s.push({ id: "w1", type: "web_view", protocol_version: 1, url: "http://example.com", size: { width: { type: "fill" }, height: { type: "fit" } } });
    s.push({ id: "z", type: "confetti" });
    s.push({ id: "z2", type: "confetti", fallback: { id: "z3", type: "tab_control" } });
    const e = errs(d).join("\n");
    expect(e).toMatch(/mute_audio is required/);
    expect(e).toMatch(/resolved https URL/);
    expect(e).toMatch(/Unknown component type "confetti"/);
    expect(e.match(/confetti/g)).toHaveLength(1);
  });
  it("warns for an offering without the package, two selected packages and untranslated strings", () => {
    const d = good();
    d.components_localizations.es_ES = { [Object.keys(d.components_localizations.en_US!)[0]!]: "Hola" };
    for (const p of [first(d, "package")]) p.package_id = "$rc_weekly";
    const v = validatePaywall(d, { packages: ["$rc_annual", "$rc_monthly"] });
    expect(v.valid).toBe(true);
    expect(v.warnings.map((w) => w.message).join("\n")).toMatch(/no package \$rc_weekly[\s\S]*not translated/);
  });
});

describe("repair (AI output, pasted JSON)", () => {
  const sloppy = `Sure! Here is your paywall:
\`\`\`json
{
  "name": "Calm",
  "background": "#F7F3EE",
  "components": [
    {"type": "title", "text": "Breathe easier with Calm"},
    {"type": "text", "text": "Sleep better in 7 days", "font_size": "subtitle", "color": "teal", "font_weight": 600},
    {"type": "features", "items": [{"icon": "sleep", "text": "Sleep stories"}, {"icon": "meditation", "text": "Guided meditations"}, "Offline listening"]},
    {"type": "timeline", "items": [{"icon": "lock-open", "title": "Today", "description": "Full access"}, {"title": "Day 5", "icon": "notification"}]},
    {"type": "hstack", "components": [{"type": "icon", "icon_name": "star", "color": "#f5a524"}], "padding": [4, 8], "corner_radius": "12"},
    {"type": "confetti", "amount": 99},
    {"type": "image"},
    {"type": "package", "package_id": "yearly_plan", "label": "Yearly"},
    {"type": "package", "package_id": "monthly", "label": "Monthly"},
  ],
  "footer": [{"type": "cta", "text": "Start free trial"}, {"type": "button", "action": "restore"}]
}
\`\`\``;
  it("turns a sloppy model answer into a valid paywall bound to the offering", () => {
    const r = paywallFromModel(sloppy, { prompt: "calm", packages: ["$rc_annual", "$rc_monthly"], brandColors: ["#0f766e"] }, ICONS);
    expect(r.validation.errors).toEqual([]);
    expect(r.name).toBe("Calm");
    const all: Json[] = [];
    forEachComponent(r.doc.components_config, (c) => all.push(c));
    expect(all.filter((c) => c.type === "package").map((p) => [p.package_id, p.is_selected_by_default])).toEqual([["$rc_annual", true], ["$rc_monthly", false]]);
    expect(all.filter((c) => c.type === "purchase_button")).toHaveLength(1);
    expect(all.some((c) => c.type === "timeline")).toBe(true);
    expect(all.filter((c) => c.type === "icon").map((c) => c.icon_name)).toEqual(expect.arrayContaining(["moon", "leaf", "unlock", "bell", "star"]));
    expect(Object.values(r.doc.components_localizations.en_US!)).toEqual(expect.arrayContaining(["Breathe easier with Calm", "Start free trial", "Offline listening"]));
    expect(r.fixes.join("\n")).toMatch(/unknown type "confetti"[\s\S]*images without a URL/);
    expect(r.doc.components_config.base.background).toEqual({ type: "color", value: { light: { type: "hex", value: "#f7f3eeff" } } });
    expect(new Set(all.map((c) => c.id)).size).toBe(all.filter((c) => c.id).length);
  });
  it("adds packages and a purchase button when the model left them out", () => {
    const r = repairPaywall({ components: [{ type: "text", text: "Hi" }] }, { iconBaseUrl: ICONS, packages: ["$rc_weekly", "$rc_annual"] });
    expect(validatePaywall(r.doc).errors).toEqual([]);
    const all: Json[] = [];
    forEachComponent(r.doc.components_config, (c) => all.push(c));
    expect(all.filter((c) => c.type === "package").map((p) => [p.package_id, p.is_selected_by_default])).toEqual([["$rc_weekly", false], ["$rc_annual", true]]);
    expect(r.doc.components_config.base.sticky_footer).toBeTruthy();
    expect(r.fixes).toEqual(expect.arrayContaining(["Added the offering's packages as a plan list.", "Added a purchase button."]));
  });
  it("keeps a valid paywall valid and its texts", () => {
    const doc = PAYWALL_TEMPLATES.find((t) => t.id === "tiers_tabs")!.build({ iconBaseUrl: ICONS });
    const r = repairPaywall(doc, { iconBaseUrl: ICONS });
    expect(validatePaywall(r.doc).errors).toEqual([]);
    for (const k of usedStringKeys(doc.components_config)) expect(r.doc.components_localizations.en_US![k]).toBe(doc.components_localizations.en_US![k]);
  });
  it("reads JSON out of fences, prose and cut-off answers", () => {
    expect(extractJson('```json\n{"a": [1, 2,],}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Here: {"a": {"b": "x}"}} trailing')).toEqual({ a: { b: "x}" } });
    expect(extractJson('{"components": [{"type": "text", "text": "Hel')).toEqual({ components: [{ type: "text", text: "Hel" }] });
    expect(extractJson("no json")).toBeNull();
    expect(() => paywallFromModel("sorry, I cannot", { prompt: "x" }, ICONS)).toThrow(/JSON/);
  });
  it("builds a prompt with the offering, colours and the icon list", () => {
    const m = paywallAiMessages({ prompt: "fitness app", appName: "Lift", brandColors: ["#ff0000"], packages: ["$rc_annual"], locale: "es_ES" });
    expect(m.system).toContain("dumbbell");
    expect(m.user).toMatch(/Lift[\s\S]*#ff0000[\s\S]*\$rc_annual[\s\S]*es_ES/);
  });
});

describe("localizations and icons", () => {
  it("fills missing strings of other locales from the default locale", () => {
    expect(fillLocales({ en_US: { a: "A", b: "B" }, es_ES: { a: "Á" } }, "en_US")).toEqual({ en_US: { a: "A", b: "B" }, es_ES: { a: "Á", b: "B" } });
  });
  it("has period words for the paywall's locales", () => {
    const u = uiLocalizations(["es_ES", "zh_Hant_TW", "xx_YY"]);
    expect(u.en_US!.monthly).toBe("monthly");
    expect(u.es_ES!.monthly).toBe("mensual");
    expect(u.zh_Hant_TW!.week).toBe("週");
    expect(u.xx_YY!.year).toBe("year");
    expect(variableWords("ru").num_day_few).toBe("%d дня");
    expect(Object.keys(u.de_DE ?? variableWords("de"))).toEqual(Object.keys(u.en_US!));
  });
  it("draws every icon as SVG", () => {
    expect(Object.keys(PAYWALL_ICONS).length).toBeGreaterThanOrEqual(40);
    for (const n of Object.keys(PAYWALL_ICONS)) expect(paywallIconSvg(n)).toMatch(/^<svg[\s\S]*<path d="M/);
    expect(paywallIconSvg("nope")).toBeNull();
  });
});

describe("editor operations", () => {
  const ICON = "https://api.example.com/assets/icons";
  const start = () => blankPaywall({ iconBaseUrl: ICON });
  const ids = (doc: ReturnType<typeof blankPaywall>) => doc.components_config.base.stack.components.map((c: Json) => c.type);
  it("adds every addable type, and the result stays valid once URLs are set", async () => {
    const { ADDABLE_TYPES, applyOp, newComponent } = await import("../src/index.js");
    let doc = start();
    doc.components_config.base.sticky_footer = null as never;
    delete (doc.components_config.base as Json).sticky_footer;
    for (const t of ADDABLE_TYPES) {
      const c = newComponent(t, { doc, iconBaseUrl: ICON, packages: ["$rc_annual", "$rc_monthly", "$rc_weekly"] });
      if (t === "video") c.source.light.url = "https://example.com/v.mp4";
      if (t === "web_view") c.url = "https://example.com/embed";
      const r = applyOp(doc, { kind: "insert", component: c, targetId: null, position: "after" });
      expect(r, t).not.toBeNull();
      doc = r!.doc;
    }
    expect(validatePaywall(doc).errors).toEqual([]);
    expect(doc.components_config.base.sticky_footer?.type).toBe("sticky_footer");
    const kinds = new Set<string>(); forEachComponent(doc.components_config, (c) => kinds.add(c.type));
    for (const t of ["text", "image", "icon", "stack", "button", "package", "purchase_button", "sticky_footer", "timeline", "tabs", "tab_control", "tab_control_button", "carousel", "video", "countdown", "web_view"]) expect(kinds.has(t), t).toBe(true);
  });
  it("moves, nests, un-nests, duplicates (with new ids and copied strings) and removes", async () => {
    const { applyOp, locate, newComponent, componentLabel } = await import("../src/index.js");
    let doc = start();
    const before = ids(doc);
    const first = doc.components_config.base.stack.components[1]!; // the title text
    let r = applyOp(doc, { kind: "move", id: first.id, delta: 1 })!;
    expect(ids(r.doc)).toEqual([before[0], before[2], before[1]]);
    expect(applyOp(r.doc, { kind: "move", id: first.id, delta: 5 })).toBeNull();
    doc = r.doc;
    // Into the stack above (the plan list), then out again.
    r = applyOp(doc, { kind: "into", id: first.id })!;
    expect(locate(r.doc, first.id)!.parentStack!.name).toBe("Plans");
    r = applyOp(r.doc, { kind: "out", id: first.id })!;
    expect(locate(r.doc, first.id)!.list).toBe(r.doc.components_config.base.stack.components);
    // Duplicate.
    const d = applyOp(r.doc, { kind: "duplicate", id: first.id })!;
    const copy = locate(d.doc, d.select!)!.component;
    expect(copy.id).not.toBe(first.id);
    expect(copy.text_lid).not.toBe(first.text_lid);
    expect(d.doc.components_localizations.en_US![copy.text_lid]).toBe(d.doc.components_localizations.en_US![first.text_lid]);
    expect(componentLabel(copy, d.doc.components_localizations.en_US!)).toBe("Your headline");
    // Insert inside a container, drag before another, remove.
    const txt = newComponent("text", { doc: d.doc, iconBaseUrl: ICON, packages: [] });
    const plans = d.doc.components_config.base.stack.components.find((c: Json) => c.name === "Plans")!;
    const ins = applyOp(d.doc, { kind: "insert", component: txt, targetId: plans.id, position: "inside" })!;
    expect(locate(ins.doc, txt.id)!.parentStack!.id).toBe(plans.id);
    const mv = applyOp(ins.doc, { kind: "moveTo", id: txt.id, targetId: first.id, position: "before" })!;
    expect(locate(mv.doc, txt.id)!.index).toBe(locate(mv.doc, first.id)!.index - 1);
    expect(applyOp(mv.doc, { kind: "moveTo", id: plans.id, targetId: plans.components?.[0]?.id ?? plans.id, position: "inside" })).toBeNull();
    const rm = applyOp(mv.doc, { kind: "remove", id: txt.id })!;
    expect(locate(rm.doc, txt.id)).toBeNull();
    expect(validatePaywall(rm.doc).errors).toEqual([]);
    // The root cannot move.
    expect(applyOp(rm.doc, { kind: "remove", id: rm.doc.components_config.base.stack.id })).toBeNull();
  });
  it("duplicates with new string keys (texts and URLs) and leaves the original as the only default package", async () => {
    const { applyOp, copyWithNewIds, locate } = await import("../src/index.js");
    const doc = start();
    const plans = doc.components_config.base.stack.components.find((c: Json) => c.name === "Plans")!;
    const def = plans.components.find((c: Json) => c.type === "package" && c.is_selected_by_default)!;
    const d = applyOp(doc, { kind: "duplicate", id: def.id })!;
    const copy = locate(d.doc, d.select!)!.component;
    expect(copy.is_selected_by_default).toBe(false);
    expect(locate(d.doc, def.id)!.component.is_selected_by_default).toBe(true);
    expect(validatePaywall(d.doc).warnings.filter((w) => /selected by default/.test(w.message))).toEqual([]);
    const loc = doc.components_localizations.en_US!;
    loc.u1 = "https://example.com/terms";
    const btn = { id: "b1", type: "button", action: { type: "navigate_to", destination: "terms", url: { url_lid: "u1", method: "in_app_browser" } }, stack: { id: "s1", type: "stack", components: [{ id: "t1", type: "text", text_lid: "u1" }] } };
    const c = copyWithNewIds(doc, btn);
    expect(c.id).not.toBe("b1");
    expect(c.action.url.url_lid).not.toBe("u1");
    expect(c.stack.components[0].text_lid).toBe(c.action.url.url_lid);
    expect(loc[c.action.url.url_lid]).toBe("https://example.com/terms");
    expect(btn.action.url.url_lid).toBe("u1");
  });
  it("never throws on malformed trees: lists that are not lists, null children, tabs without stacks, strings that are objects", async () => {
    const { applyOp, childGroups, componentLabel, locate } = await import("../src/index.js");
    const doc = start();
    const root = doc.components_config.base.stack;
    root.components.push(null, 5, { id: "bad", type: "stack", components: 7 }, { id: "btn", type: "button" },
      { id: "tb", type: "tabs", tabs: [null, { id: "x1" }, { id: "x2", stack: { id: "ts", type: "stack", components: [null] } }], control: null },
      { id: "img", type: "text", text_lid: "obj" }, { id: "pk", type: "package", package_id: { a: 1 } });
    doc.components_localizations.en_US!.obj = { light: "x" } as never;
    expect(childGroups({ id: "bad", type: "stack", components: 7 })).toEqual([]);
    expect(childGroups(null as never)).toEqual([]);
    expect(childGroups({ type: "tabs", tabs: [null, { id: "x1" }] })).toEqual([]);
    expect(locate(doc, "ts")!.parent!.id).toBe("tb");
    expect(locate(doc, "nope")).toBeNull();
    expect(locate(doc, undefined as never)).toBeNull();
    for (const c of root.components) expect(typeof componentLabel(c, doc.components_localizations.en_US!)).toBe("string");
    expect(componentLabel(null as never, {})).toBe("");
    expect(applyOp(doc, { kind: "insert", component: { id: "n1", type: "text", text_lid: "x" }, targetId: "bad", position: "inside" })!.select).toBe("n1");
    expect(applyOp(doc, { kind: "insert", component: { id: "n2", type: "text", text_lid: "x" }, targetId: "btn", position: "inside" })!.select).toBe("n2");
    expect(locate(applyOp(doc, { kind: "into", id: "img" })!.doc, "img")!.parentStack!.id).toBe("ts");
    expect(applyOp(doc, { kind: "into", id: "pk" })).toBeNull();
    expect(applyOp(doc, { kind: "moveTo", id: "img", targetId: "ts", position: "inside" })!.select).toBe("img");
    expect(applyOp(doc, { kind: "duplicate", id: "tb" })).not.toBeNull();
  });
  it("edits inside a sticky footer that has no type (as the SDK decodes it)", async () => {
    const { applyOp, locate } = await import("../src/index.js");
    const doc = start();
    const f = doc.components_config.base.sticky_footer!;
    delete f.type;
    const first = f.stack.components[0];
    expect(locate(doc, first.id)!.list).toBe(f.stack.components);
    const r = applyOp(doc, { kind: "insert", component: { id: "n1", type: "text", text_lid: "x" }, targetId: f.id, position: "inside" })!;
    expect(locate(r.doc, "n1")!.parentStack!.id).toBe(f.stack.id);
    expect(applyOp(r.doc, { kind: "out", id: "n1" })).toBeNull();
  });
  it("tells which documents the editor cannot open, without recursing", async () => {
    const { docShapeError, MAX_PAYWALL_DEPTH } = await import("../src/index.js");
    const ok = start();
    expect(docShapeError(ok)).toBeNull();
    const bad = (f: (d: Json) => void) => { const d = clone(ok) as Json; f(d); return docShapeError(d); };
    expect(docShapeError(null)).toMatch(/object/);
    expect(docShapeError([])).toMatch(/object/);
    expect(bad((d) => { delete d.components_config; })).toMatch(/base/);
    expect(bad((d) => { d.components_config.base = 3; })).toMatch(/base/);
    expect(bad((d) => { d.components_config.base.stack = null; })).toMatch(/stack/);
    expect(bad((d) => { d.components_config.base.stack.components = {}; })).toMatch(/components list/);
    expect(bad((d) => { d.components_config.base.sticky_footer = "x"; })).toMatch(/sticky_footer/);
    expect(bad((d) => { d.components_config.base.sticky_footer = null; })).toBeNull();
    expect(bad((d) => { d.components_localizations = null; })).toMatch(/components_localizations/);
    expect(bad((d) => { d.components_localizations.fr_FR = "x"; })).toMatch(/components_localizations/);
    expect(bad((d) => { d.default_locale = 7; })).toMatch(/default_locale/);
    // Deeper than any call stack: refused without overflowing.
    expect(bad((d) => { let s = d.components_config.base.stack; for (let i = 0; i < 100_000; i++) { const n = { id: `s${i}`, type: "stack", components: [] }; s.components.push(n); s = n; } })).toMatch(String(MAX_PAYWALL_DEPTH));
  });
});
