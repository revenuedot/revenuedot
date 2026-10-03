/**
 * The paywall builder's server side (prd/paywalls/PRD.md): gallery templates, validation on publish, the AI generator with
 * a fake model, versions, localization serving, the asset CDN and built-in icons, and saved charts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PAYWALL_TEMPLATES, forEachComponent, type Json } from "@revenuedot/core";
import { parseContainer } from "@revenuedot/server/services/remote-config.js";
import { fakeDesignerAnswer, fakeModel } from "@revenuedot/server/services/paywall-ai.js";
import { harness, type Harness, type HarnessOptions } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
const boot = async (o: HarnessOptions = {}) => { h = await harness(o); call = v2(h); };
afterEach(async () => { await h?.close(); });

const PW = "/v2/projects/{project_id}/paywalls";
const ONE = `${PW}/{paywall_id}`;
const sdkOfferings = async () => (await (await h.fetch("/v1/subscribers/anyone/offerings", { key: h.ids.testKey })).json()) as any;
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function offeringWithPackages(key: string, packages: string[]) {
  const o = await call("POST", "/v2/projects/{project_id}/offerings", {}, { json: { lookup_key: key, display_name: key } });
  for (const lk of packages) await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/packages", { offering_id: o.body.id }, { json: { lookup_key: lk, display_name: lk.replace("$rc_", "") } });
  return o.body.id as string;
}
const components = (doc: Json) => { const all: Json[] = []; forEachComponent(doc, (c) => all.push(c)); return all; };

describe("gallery templates", () => {
  it("lists the templates with their filter fields and the icon URL", async () => {
    await boot({ apiUrl: "https://api.example.test" });
    const r = await call("GET", "/v2/projects/{project_id}/paywall_templates", {}, { ext: true });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThanOrEqual(8);
    expect(r.body.items[0]).toMatchObject({ object: "paywall_template", id: expect.any(String), screens: expect.any(Number), purchase_method: expect.stringMatching(/in_app|web/), packages: expect.any(Number), tiers: expect.any(Number) });
    expect(r.body.icon_base_url).toBe("https://api.example.test/assets/icons");
  });

  it("creates a paywall from a template with the offering's packages, publishes it, and the SDK gets it both ways", async () => {
    await boot({ apiUrl: "https://api.example.test" });
    const o = await offeringWithPackages("spring", ["$rc_monthly", "$rc_annual"]);
    const made = await call("POST", PW, {}, { ext: true, json: { offering_id: o, template_id: "trial_timeline", template_options: { app_name: "Scanner", accent_color: "#ff5500", terms_url: "https://example.com/terms", privacy_url: "https://example.com/privacy" } } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "Trial timeline", offering_id: o });
    const draft = (await call("GET", ONE, { paywall_id: made.body.id }, { query: "expand=components" })).body.components.draft;
    const all = components(draft.components_config);
    expect(all.filter((c) => c.type === "package").map((p) => [p.package_id, p.is_selected_by_default])).toEqual([["$rc_annual", true], ["$rc_monthly", false]]);
    expect(all.find((c) => c.type === "icon")!.base_url).toBe("https://api.example.test/assets/icons");
    expect(Object.values(draft.components_localizations.en_US)).toEqual(expect.arrayContaining(["Get full access to Scanner and everything in it.", "https://example.com/terms"]));

    expect((await call("POST", `${ONE}/actions/publish`, { paywall_id: made.body.id })).status).toBe(200);
    const off = (await sdkOfferings()).offerings.find((x: any) => x.identifier === "spring");
    expect(off.has_paywall_components).toBe(true);
    expect(components(off.paywall_components.components_config).some((c) => c.type === "timeline")).toBe(true);
    const res = await h.fetch("/v1/config/app", { method: "POST", key: h.ids.testKey, json: { fetch_context: "app_start", app_user_id: "u1" } });
    const els = parseContainer(new Uint8Array(await res.arrayBuffer()));
    const cfg = JSON.parse(new TextDecoder().decode(els[0]!.payload));
    expect(Object.values(cfg.topics.workflows).map((w: any) => w.offering_identifier)).toContain("spring");

    expect((await call("POST", PW, {}, { ext: true, json: { offering_id: o, template_id: "minimal" } })).status).toBe(409);
    expect((await call("POST", PW, {}, { ext: true, json: { template_id: "nope" } })).status).toBe(400);
    expect((await call("POST", PW, {}, { ext: true, json: { template_id: "minimal", template_options: { accent_color: "orange" } } })).status).toBe(400);
  });

  it("every template publishes on an offering that has its packages", async () => {
    await boot();
    for (const t of PAYWALL_TEMPLATES) {
      const o = await offeringWithPackages(`o_${t.id}`, ["$rc_annual", "$rc_monthly", "$rc_weekly", "$rc_lifetime"]);
      const made = await call("POST", PW, {}, { ext: true, json: { offering_id: o, template_id: t.id } });
      const pub = await call("POST", `${ONE}/actions/publish`, { paywall_id: made.body.id });
      expect(pub.status, `${t.id}: ${JSON.stringify(pub.body)}`).toBe(200);
    }
  });
});

describe("validation", () => {
  it("validates without saving, repairs on request, and publish refuses what the SDK cannot decode", async () => {
    await boot();
    const o = await offeringWithPackages("val", ["$rc_annual"]);
    const good = PAYWALL_TEMPLATES[0]!.build({ packages: [{ id: "$rc_annual" }] });
    const ok = await call("POST", `${PW}/validate`, {}, { ext: true, json: { ...good, offering_id: o } });
    expect(ok.body).toMatchObject({ object: "paywall_validation", valid: true, errors: [] });

    const bad = JSON.parse(JSON.stringify(good));
    delete components(bad.components_config).find((c) => c.type === "text")!.font_weight;
    const v = await call("POST", `${PW}/validate`, {}, { ext: true, json: bad });
    expect(v.body.valid).toBe(false);
    expect(v.body.errors[0]).toMatchObject({ path: expect.stringContaining("font_weight"), message: "font_weight is required." });

    const fixed = await call("POST", `${PW}/validate`, {}, { ext: true, json: { components_config: { base: { stack: { components: [{ type: "text", text: "Hello" }] } } }, components_localizations: {}, repair: true, offering_id: o } });
    expect(fixed.body.valid).toBe(true);
    expect(fixed.body.fixes).toEqual(expect.arrayContaining(["Added a purchase button."]));
    expect(components(fixed.body.components_config).find((c) => c.type === "package")!.package_id).toBe("$rc_annual");

    const id = (await call("POST", PW, {}, { json: { offering_id: o, components_config: bad.components_config, components_localizations: bad.components_localizations } })).body.id;
    const pub = await call("POST", `${ONE}/actions/publish`, { paywall_id: id });
    expect(pub.status).toBe(422);
    expect(pub.body.message).toMatch(/would not render in the SDK.*font_weight is required/);
    expect(pub.body.param).toMatch(/font_weight$/);
    expect((await sdkOfferings()).offerings.find((x: any) => x.identifier === "val").has_paywall_components).toBe(false);
  });
});

describe("versions", () => {
  it("lists saved versions and restores one into the draft", async () => {
    await boot();
    const o = await offeringWithPackages("ver", ["$rc_annual"]);
    const id = (await call("POST", PW, {}, { ext: true, json: { offering_id: o, template_id: "minimal" } })).body.id;
    const v1 = await call("POST", `${ONE}/versions`, { paywall_id: id }, { json: { name: "First" } });
    expect(v1.status).toBe(201);
    const cur = (await call("GET", ONE, { paywall_id: id }, { query: "expand=components" })).body;
    const loc = { ...cur.components.draft.components_localizations };
    const k = Object.keys(loc.en_US)[0]!;
    await call("PATCH", ONE, { paywall_id: id }, { json: { revision: cur.revision, components_localizations: { en_US: { ...loc.en_US, [k]: "Changed" } } } });
    const list = await call("GET", `${ONE}/versions`, { paywall_id: id }, { ext: true });
    expect(list.body.items.map((x: any) => x.name)).toEqual(["First"]);
    const back = await call("POST", `${ONE}/versions/{version_id}/actions/restore`, { paywall_id: id, version_id: v1.body.id }, { ext: true });
    expect(back.status).toBe(200);
    expect(back.body.revision).toBe(cur.revision + 2);
    expect(back.body.components.draft.components_localizations.en_US[k]).toBe(loc.en_US[k]);
    expect((await call("POST", `${ONE}/versions/{version_id}/actions/restore`, { paywall_id: id, version_id: "pwv_nope" }, { ext: true })).status).toBe(404);
  });
});

describe("AI generator", () => {
  it("is off without a model: status says so and generate answers 503", async () => {
    await boot();
    expect((await call("GET", `${PW}/ai`, {}, { ext: true })).body).toMatchObject({ object: "paywall_ai", available: false, provider: null });
    expect((await call("POST", `${PW}/generate`, {}, { ext: true, json: { prompt: "a calm paywall" } })).status).toBe(503);
  });

  it("designs a valid paywall from the brief and the offering's products, names the model, and rate-limits", async () => {
    const model = fakeModel((_s, user, name) => fakeDesignerAnswer(name, user));
    await boot({ ai: model });
    expect((await call("GET", `${PW}/ai`, {}, { ext: true })).body).toMatchObject({ available: true, provider: "Fake", model: "fake-paywall-model" });
    const o = await offeringWithPackages("ai", ["$rc_weekly", "$rc_annual"]);
    const r = await call("POST", `${PW}/generate`, {}, { ext: true, json: { prompt: "A calm sleep app", app_name: "Calm", brand_colors: ["#0f766e"], offering_id: o } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: "paywall_generation", name: "AI paywall", default_locale: "en_US", provider: "Fake", model: "fake-paywall-model", preview_trials: {} });
    // Two structured calls: the brief (description, form, offering), then the design.
    expect(model.calls.map((c) => c.name)).toEqual(["paywall_brief", "paywall_design"]);
    expect(model.calls[0]!.user).toMatch(/A calm sleep app[\s\S]*Calm[\s\S]*#0f766e[\s\S]*\$rc_weekly[\s\S]*\$rc_annual/);
    expect(r.body.steps.map((s: { id: string; status: string }) => `${s.id}:${s.status}`)).toEqual(["brief:done", "packages:done", "draft:done", "check:done", "fix:skipped", "translate:skipped"]);
    const all = components(r.body.components_config);
    expect(all.filter((c) => c.type === "package").map((p) => [p.package_id, p.is_selected_by_default])).toEqual([["$rc_weekly", true], ["$rc_annual", false]]);
    expect(Object.values(r.body.components_localizations.en_US)).toContain("AI: A calm sleep app");
    // Nothing was saved: the answer is a draft for the editor. It saves and publishes as is.
    expect((await call("GET", PW)).body.items).toHaveLength(0);
    const id = (await call("POST", PW, {}, { json: { offering_id: o, name: r.body.name, components_config: r.body.components_config, components_localizations: r.body.components_localizations } })).body.id;
    expect((await call("POST", `${ONE}/actions/publish`, { paywall_id: id })).status).toBe(200);
    // One generation per 5 seconds per project.
    expect((await call("POST", `${PW}/generate`, {}, { ext: true, json: { prompt: "again please" } })).status).toBe(429);
    h.setNow(new Date(h.now().getTime() + 6000));
    const again = await call("POST", `${PW}/generate`, {}, { ext: true, json: { prompt: "again please" } });
    expect(again.status).toBe(200);
    // Without an offering the designer uses standard packages with sample prices and says so.
    expect(again.body.notes.join(" ")).toMatch(/sample prices/);
    expect((await call("POST", `${PW}/generate`, {}, { ext: true, json: { prompt: "x" } })).status).toBe(400);
  });

  it("answers 502 (retryable) when the model fails", async () => {
    await boot({ ai: { ...fakeModel("{}"), json: async () => { throw new Error("down"); } } });
    const r = await call("POST", `${PW}/generate`, {}, { ext: true, json: { prompt: "a paywall" } });
    expect(r.status).toBe(502);
    expect(r.body.retryable).toBe(true);
  });
});

describe("localizations", () => {
  it("serves every locale complete (missing strings from the default locale) with period words in each language", async () => {
    await boot();
    const o = await offeringWithPackages("loc", ["$rc_annual"]);
    const doc = PAYWALL_TEMPLATES.find((t) => t.id === "minimal")!.build({ packages: [{ id: "$rc_annual" }] });
    const keys = Object.keys(doc.components_localizations.en_US!);
    const es = { [keys[0]!]: "Hola" };
    const id = (await call("POST", PW, {}, { json: { offering_id: o, ...doc, components_localizations: { ...doc.components_localizations, es_ES: es } } })).body.id;
    expect((await call("POST", `${ONE}/actions/publish`, { paywall_id: id })).status).toBe(200);
    const sdk = await sdkOfferings();
    const pc = sdk.offerings.find((x: any) => x.identifier === "loc").paywall_components;
    expect(Object.keys(pc.components_localizations.es_ES).sort()).toEqual([...keys].sort());
    expect(pc.components_localizations.es_ES[keys[0]!]).toBe("Hola");
    expect(pc.components_localizations.es_ES[keys[1]!]).toBe(doc.components_localizations.en_US![keys[1]!]);
    expect(sdk.ui_config.localizations.es_ES.monthly).toBe("mensual");
    expect(sdk.ui_config.localizations.en_US.monthly).toBe("monthly");
    // The stored draft keeps only what was translated.
    expect((await call("GET", ONE, { paywall_id: id }, { query: "expand=components" })).body.components.published.components_localizations.es_ES).toEqual(es);
  });
});

describe("asset CDN", () => {
  it("serves uploads with an ETag, 304 on If-None-Match, HEAD and the image size, from the API origin", async () => {
    await boot({ apiUrl: "https://api.example.test" });
    const up = await call("POST", "/v2/projects/{project_id}/media_assets", {}, { json: { filename: "hero.png", content_type: "image/png", file_data_base64: PNG_1x1 } });
    expect(up.body.asset_base_url).toBe("https://api.example.test/assets/proj1");
    const path = `/assets/proj1/${up.body.object_name}`;
    const res = await h.fetch(path, { key: "" });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);
    expect(res.headers.get("content-length")).toBe(String(Buffer.from(PNG_1x1, "base64").length));
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-image-width")).toBe("1");
    const again = await h.fetch(path, { key: "", headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const head = await h.fetch(path, { key: "", method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
  });

  it("serves the built-in icons as PNG and SVG, and every image of a published paywall resolves", async () => {
    await boot();
    const png = await h.fetch("/assets/icons/check.png", { key: "" });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
    expect(new DataView(bytes.buffer).getUint32(16)).toBe(96);
    expect((await h.fetch("/assets/icons/check.heic", { key: "" })).headers.get("content-type")).toBe("image/png");
    expect(await (await h.fetch("/assets/icons/star.svg", { key: "" })).text()).toMatch(/^<svg/);
    expect((await h.fetch("/assets/icons/nope.png", { key: "" })).status).toBe(404);
    for (const f of ["constructor.png", "__proto__.svg", "tostring.png"]) expect((await h.fetch(`/assets/icons/${f}`, { key: "" })).status, f).toBe(404);

    const up = await call("POST", "/v2/projects/{project_id}/media_assets", {}, { json: { filename: "hero.png", content_type: "image/png", file_data_base64: PNG_1x1 } });
    const url = `${up.body.asset_base_url}/${up.body.object_name}`;
    const o = await offeringWithPackages("img", ["$rc_annual", "$rc_monthly"]);
    const id = (await call("POST", PW, {}, { ext: true, json: { offering_id: o, template_id: "feature_hero", template_options: { image_url: url, image_width: 1, image_height: 1 } } })).body.id;
    await call("POST", `${ONE}/actions/publish`, { paywall_id: id });
    const pc = (await sdkOfferings()).offerings.find((x: any) => x.identifier === "img").paywall_components;
    const urls = new Set<string>();
    forEachComponent(pc.components_config, (c) => {
      if (c.type === "image") for (const k of ["original", "heic", "heic_low_res"]) urls.add(c.source.light[k]);
      if (c.type === "icon") urls.add(`${c.base_url}/${c.formats.heic}`);
    });
    expect(urls.size).toBeGreaterThan(2);
    for (const u of urls) {
      const r = await h.fetch(new URL(u).pathname, { key: "" });
      expect(r.status, u).toBe(200);
      expect(r.headers.get("content-type"), u).toMatch(/^image\//);
    }
  });
});

describe("saved charts", () => {
  it("saves, lists, renames and deletes chart views, and checks the chart name", async () => {
    await boot();
    const P = "/v2/projects/{project_id}/saved_charts";
    const made = await call("POST", P, {}, { ext: true, json: { name: "MRR by country", chart_name: "mrr", view: { range: "90d", res: "week", segment: "country", compare: true } } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ object: "saved_chart", name: "MRR by country", chart_name: "mrr", view: { range: "90d", segment: "country", compare: true } });
    expect((await call("POST", P, {}, { ext: true, json: { name: "x", chart_name: "not_a_chart" } })).status).toBe(400);
    expect((await call("POST", P, {}, { ext: true, json: { name: "", chart_name: "mrr" } })).status).toBe(400);
    expect((await call("POST", P, {}, { ext: true, json: { name: "x", chart_name: "mrr", view: { colour: "red" } } })).status).toBe(400);
    expect((await call("GET", P, {}, { ext: true })).body.items.map((x: any) => x.name)).toEqual(["MRR by country"]);
    const ren = await call("PATCH", `${P}/{saved_chart_id}`, { saved_chart_id: made.body.id }, { ext: true, json: { name: "MRR, countries" } });
    expect(ren.body).toMatchObject({ name: "MRR, countries", view: { range: "90d" } });
    expect((await call("DELETE", `${P}/{saved_chart_id}`, { saved_chart_id: made.body.id }, { ext: true })).status).toBe(200);
    expect((await call("GET", `${P}/{saved_chart_id}`, { saved_chart_id: made.body.id }, { ext: true })).status).toBe(404);
  });
});
