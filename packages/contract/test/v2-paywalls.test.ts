import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harness, type Harness } from "../src/harness.js";
import { createHash } from "node:crypto";
import { md5Hex } from "@revenuedot/server/services/paywalls.js";
import { v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const PW = "/v2/projects/{project_id}/paywalls";
const ONE = `${PW}/{paywall_id}`;
const sdkOfferings = async () => (await (await h.fetch("/v1/subscribers/anyone/offerings", { key: h.ids.testKey })).json()) as any;

const hero = {
  base: {
    background: { type: "color", value: { light: { type: "hex", value: "#112233ff" } } },
    stack: { id: "root", type: "stack", components: [{ id: "t1", type: "text", text_lid: "headline", color: { light: { type: "hex", value: "#ffffffff" } }, font_weight: "bold", font_size: 28, horizontal_alignment: "center", size: { width: { type: "fill" }, height: { type: "fit" } }, padding: {}, margin: {} }], dimension: { type: "vertical", alignment: "center", distribution: "center" }, size: { width: { type: "fill" }, height: { type: "fill" } }, spacing: 16, margin: {}, padding: {} },
  },
};

/** A 1x1 PNG. */
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A minimal OpenType file with `name` and `OS/2` tables, enough for the server to read the font's identity. */
function tinyFont(family: string, postscript: string, weight: number, italic = false): string {
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const utf16 = (s: string) => [...s].flatMap((ch) => u16(ch.charCodeAt(0)));
  const names: [number, string][] = [[1, family], [2, italic ? "Italic" : "Regular"], [6, postscript]];
  const strings = names.map(([, v]) => utf16(v));
  let off = 0;
  const records = names.flatMap(([id], i) => { const r = [...u16(3), ...u16(1), ...u16(0x409), ...u16(id), ...u16(strings[i]!.length), ...u16(off)]; off += strings[i]!.length; return r; });
  const nameTable = [...u16(0), ...u16(names.length), ...u16(6 + names.length * 12), ...records, ...strings.flat()];
  const os2 = new Array(78).fill(0);
  os2[4] = (weight >> 8) & 255; os2[5] = weight & 255; os2[62] = 0; os2[63] = italic ? 1 : 0;
  const tables: [string, number[]][] = [["OS/2", os2], ["name", nameTable]];
  const dirLen = 12 + tables.length * 16;
  let pos = dirLen;
  const dir = tables.flatMap(([tag, data]) => { const e = [...[...tag].map((x) => x.charCodeAt(0)), ...u32(0), ...u32(pos), ...u32(data.length)]; pos += data.length; return e; });
  const bytes = [...[0x4f, 0x54, 0x54, 0x4f], ...u16(tables.length), ...u16(0), ...u16(0), ...u16(0), ...dir, ...tables.flatMap(([, d]) => d)];
  return Buffer.from(bytes).toString("base64");
}

async function offering(key: string) {
  const r = await call("POST", "/v2/projects/{project_id}/offerings", {}, { json: { lookup_key: key, display_name: key } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe("paywalls", () => {
  it("creates an empty paywall for an offering, refuses a second one, and shows it through expand", async () => {
    const o = await offering("promo");
    const made = await call("POST", PW, {}, { json: { offering_id: o } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ object: "paywall", offering_id: o, published_at: null, revision: 1, automatically_scale_font_size: true });
    expect((await call("POST", PW, {}, { json: { offering_id: o } })).status).toBe(409);
    expect((await call("POST", PW, {}, { json: { offering_id: "ofrng_nope" } })).status).toBe(404);
    expect((await call("POST", PW, {}, { json: {} })).status).toBe(400);

    const got = await call("GET", ONE, { paywall_id: made.body.id }, { query: "expand=components&expand=offering" });
    expect(got.body.components.published).toBeNull();
    expect(got.body.components.draft.components_config.base.stack.type).toBe("stack");
    expect(got.body.offering).toMatchObject({ object: "offering", id: o, paywall_id: made.body.id });
    const list = await call("GET", PW, {}, { query: "expand=items.offering" });
    expect(list.body.items.map((x: any) => x.id)).toEqual([made.body.id]);
    expect((await call("GET", ONE, { paywall_id: "pw_nope" })).status).toBe(404);
    expect((await call("GET", "/v2/projects/{project_id}/offerings/{offering_id}", { offering_id: o })).body.paywall_id).toBe(made.body.id);
  });

  it("creates a paywall from components and localizations, updates its draft with revision checks, and keeps the draft out of the SDK until publish", async () => {
    const o = await offering("promo");
    const made = await call("POST", PW, {}, { json: { offering_id: o, name: "Hero", components_config: hero, components_localizations: { en_US: { headline: "Go Pro" } }, default_locale: "en_US" } });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect(made.body.name).toBe("Hero");
    expect((await sdkOfferings()).offerings.find((x: any) => x.identifier === "promo")).toMatchObject({ has_paywall_components: false });

    const patch = await call("PATCH", ONE, { paywall_id: id }, { json: { revision: 1, components_localizations: { en_US: { headline: "Go Pro today" }, de_DE: { headline: "Jetzt Pro" } }, name: "Hero v2" } });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ revision: 2, name: "Hero v2" });
    const stale = await call("PATCH", ONE, { paywall_id: id }, { json: { revision: 1, name: "stale" } });
    expect(stale.status).toBe(409);
    expect(stale.body.param).toBe("revision");
    expect((await call("PATCH", ONE, { paywall_id: id }, { json: { name: "no revision" } })).status).toBe(400);
    const draft = (await call("GET", ONE, { paywall_id: id }, { query: "expand=components" })).body.components.draft;
    expect(draft.components_localizations.de_DE.headline).toBe("Jetzt Pro");
    expect(draft.components_config.base.background.value.light.value).toBe("#112233ff");
  });

  it("publishes the draft to the SDK with assets, ui_config and placements, and unpublish takes it back", async () => {
    const o = await offering("promo");
    const id = (await call("POST", PW, {}, { json: { offering_id: o, components_config: hero, components_localizations: { en_US: { headline: "Go Pro" } } } })).body.id;
    const pub = await call("POST", `${ONE}/actions/publish`, { paywall_id: id });
    expect(pub.status).toBe(200);
    expect(pub.body.published_at).toBeGreaterThan(0);
    expect((await call("POST", `${ONE}/actions/publish`, { paywall_id: id })).status).toBe(422);
    const state = (await call("GET", ONE, { paywall_id: id }, { query: "expand=components" })).body.components;
    expect(state.draft).toBeNull();
    expect(state.published.components_localizations.en_US.headline).toBe("Go Pro");

    const sdk = await sdkOfferings();
    const off = sdk.offerings.find((x: any) => x.identifier === "promo");
    expect(off.has_paywall_components).toBe(true);
    expect(off.paywall_components).toMatchObject({ id, template_name: "components", default_locale: "en_US", revision: 1, components_localizations: { en_US: { headline: "Go Pro" } } });
    expect(off.paywall_components.asset_base_url).toMatch(/\/assets\/proj1$/);
    expect(off.paywall_components.components_config.base.stack.id).toBe("root");
    expect(sdk.ui_config.localizations.en_US.month).toBe("month");
    expect(sdk.placements).toMatchObject({ fallback_offering_id: expect.any(String), offering_ids_by_placement: {} });

    // A new draft does not change what the SDK gets until it is published.
    await call("PATCH", ONE, { paywall_id: id }, { json: { revision: 1, components_localizations: { en_US: { headline: "Changed" } } } });
    expect((await sdkOfferings()).offerings.find((x: any) => x.identifier === "promo").paywall_components.components_localizations.en_US.headline).toBe("Go Pro");
    await call("POST", `${ONE}/actions/publish`, { paywall_id: id });
    expect((await sdkOfferings()).offerings.find((x: any) => x.identifier === "promo").paywall_components.components_localizations.en_US.headline).toBe("Changed");

    const un = await call("POST", `${ONE}/actions/unpublish`, { paywall_id: id });
    expect(un.body.published_at).toBeNull();
    expect((await sdkOfferings()).offerings.find((x: any) => x.identifier === "promo").has_paywall_components).toBe(false);
    expect((await call("POST", `${ONE}/actions/unpublish`, { paywall_id: id })).status).toBe(422);
    // The content survived as the draft.
    expect((await call("GET", ONE, { paywall_id: id }, { query: "expand=components" })).body.components.draft.components_localizations.en_US.headline).toBe("Changed");
  });

  it("will not publish a paywall without an offering; attach and detach move it between offerings", async () => {
    const a = await offering("a");
    const b = await offering("b");
    const id = (await call("POST", PW, {}, { json: { components_config: hero, components_localizations: { en_US: {} } } })).body.id;
    expect((await call("POST", `${ONE}/actions/publish`, { paywall_id: id })).status).toBe(422);
    expect((await call("POST", `${ONE}/actions/attach_offering`, { paywall_id: id }, { json: { offering_id: a } })).body.offering_id).toBe(a);
    const other = (await call("POST", PW, {}, { json: { offering_id: b } })).body.id;
    expect((await call("POST", `${ONE}/actions/attach_offering`, { paywall_id: id }, { json: { offering_id: b } })).status).toBe(409);
    expect((await call("POST", `${ONE}/actions/detach_offering`, { paywall_id: other })).body.offering_id).toBeNull();
    expect((await call("POST", `${ONE}/actions/attach_offering`, { paywall_id: id }, { json: { offering_id: b } })).body.offering_id).toBe(b);
    expect((await call("PATCH", ONE, { paywall_id: id }, { json: { revision: 1, offering_id: null } })).body.offering_id).toBeNull();
  });

  it("duplicates the draft or the published version, optionally into a new offering; snapshots and reads versions; deletes", async () => {
    const o = await offering("promo");
    const id = (await call("POST", PW, {}, { json: { offering_id: o, name: "Hero", components_config: hero, components_localizations: { en_US: { headline: "Pub" } } } })).body.id;
    expect((await call("POST", `${ONE}/actions/duplicate`, { paywall_id: id }, { json: { source_version: "published" } })).status).toBe(409);
    await call("POST", `${ONE}/actions/publish`, { paywall_id: id });
    await call("PATCH", ONE, { paywall_id: id }, { json: { revision: 1, components_localizations: { en_US: { headline: "Draft" } } } });

    const fromPublished = await call("POST", `${ONE}/actions/duplicate`, { paywall_id: id }, { json: { source_version: "published", name: "Copy of pub", offering: { lookup_key: "copy", display_name: "Copy" } } });
    expect(fromPublished.status).toBe(201);
    expect(fromPublished.body).toMatchObject({ name: "Copy of pub", published_at: null });
    const copy = (await call("GET", ONE, { paywall_id: fromPublished.body.id }, { query: "expand=components" })).body;
    expect(copy.components.draft.components_localizations.en_US.headline).toBe("Pub");
    expect(copy.offering_id).not.toBeNull();
    const fromDraft = await call("POST", `${ONE}/actions/duplicate`, { paywall_id: id }, {});
    expect(fromDraft.body.name).toBe("Hero Copy");
    expect((await call("POST", `${ONE}/actions/duplicate`, { paywall_id: id }, { json: { offering: { lookup_key: "copy", display_name: "Again" } } })).status).toBe(409);

    const v = await call("POST", `${ONE}/versions`, { paywall_id: id }, { json: { name: "Before launch" } });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ object: "paywall_version", name: "Before launch", revision: 2 });
    const got = await call("GET", `${ONE}/versions/{version_id}`, { paywall_id: id, version_id: v.body.id });
    expect(got.body.components_localizations.en_US.headline).toBe("Draft");
    expect((await call("GET", `${ONE}/versions/{version_id}`, { paywall_id: id, version_id: "pwv_nope" })).status).toBe(404);
    expect((await call("POST", `${ONE}/versions`, { paywall_id: id }, { json: {} })).status).toBe(400);

    const del = await call("DELETE", ONE, { paywall_id: id });
    expect(del.body).toMatchObject({ object: "paywall", id });
    expect((await call("GET", ONE, { paywall_id: id })).status).toBe(404);
    expect((await call("GET", `${ONE}/versions/{version_id}`, { paywall_id: id, version_id: v.body.id })).status).toBe(404);
  });

  it("keeps projects apart", async () => {
    const o = await offering("promo");
    const id = (await call("POST", PW, {}, { json: { offering_id: o } })).body.id;
    const { otherProject } = await import("./v2-helpers.js");
    const other = await otherProject(h);
    expect((await call("GET", ONE, { paywall_id: id }, { key: other.key })).status).toBe(404);
    expect((await call("GET", ONE, { project_id: "projB", paywall_id: id }, { key: other.key })).status).toBe(404);
  });
});

describe("media assets and fonts", () => {
  it("uploads an image, reads its size, lists it, and serves it publicly and immutably", async () => {
    const up = await call("POST", "/v2/projects/{project_id}/media_assets", {}, { json: { filename: "hero.png", content_type: "image/png", file_data_base64: PNG_1x1 } });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ object: "media_asset", original_name: "hero.png", original_width: 1, original_height: 1, asset_type: "image" });
    expect(up.body.object_name).toMatch(/\.png$/);
    expect(up.body.asset_base_url).toMatch(/\/assets\/proj1$/);
    const list = await call("GET", "/v2/projects/{project_id}/media_assets");
    expect(list.body.items.map((x: any) => x.id)).toEqual([up.body.id]);

    const res = await h.fetch(`/assets/proj1/${up.body.object_name}`, { key: "" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(PNG_1x1);
    expect((await h.fetch(`/assets/proj1/nope.png`, { key: "" })).status).toBe(404);
    expect((await h.fetch(`/assets/proj2/${up.body.object_name}`, { key: "" })).status).toBe(404);
    expect((await call("POST", "/v2/projects/{project_id}/media_assets", {}, { json: { filename: "x.gif", content_type: "image/gif", file_data_base64: PNG_1x1 } })).status).toBe(400);
    // Served publicly as an image, so the bytes must be one: no HTML or SVG under an image type, no PNG labelled JPEG.
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
    for (const [content_type, data] of [["image/png", html], ["image/webp", svg], ["image/jpeg", PNG_1x1], ["image/heic", html]] as const) {
      const bad = await call("POST", "/v2/projects/{project_id}/media_assets", {}, { json: { filename: "x", content_type, file_data_base64: data } });
      expect(bad.status, content_type).toBe(400);
      expect(bad.body.param).toBe("file_data_base64");
    }
  });

  it("uploads a font, reads its identity, lists it, and adds it to the SDK's ui_config", async () => {
    const up = await call("POST", "/v2/projects/{project_id}/fonts", {}, { json: { filename: "Brand-Bold.otf", content_type: "font/otf", file_data_base64: tinyFont("Brand Sans", "BrandSans-Bold", 700) } });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ object: "font", name: "BrandSans-Bold", family_name: "Brand Sans", style: "normal", weight: 700 });
    expect(up.body.font_key).toBe(`font_${up.body.id}`);
    expect((await call("GET", "/v2/projects/{project_id}/fonts")).body.items).toHaveLength(1);
    const ui = (await sdkOfferings()).ui_config.app.fonts[up.body.font_key];
    expect(ui.ios).toMatchObject({ type: "name", value: "BrandSans-Bold", family: "Brand Sans" });
    expect(ui.ios.url).toMatch(/\/assets\/proj1\/.+\.otf$/);
    expect(ui.ios.hash).toMatch(/^[0-9a-f]{32}$/);
    const italic = await call("POST", "/v2/projects/{project_id}/fonts", {}, { json: { filename: "Brand-It.ttf", content_type: "font/ttf", file_data_base64: tinyFont("Brand Sans", "BrandSans-Italic", 400, true) } });
    expect(italic.body.style).toBe("italic");
    expect((await call("POST", "/v2/projects/{project_id}/fonts", {}, { json: { filename: "bad.otf", content_type: "font/otf", file_data_base64: PNG_1x1 } })).status).toBe(400);
    expect((await call("POST", "/v2/projects/{project_id}/fonts", {}, { json: { filename: "x.woff", content_type: "font/otf", file_data_base64: tinyFont("A", "A", 400) } })).status).toBe(400);
  });
});

describe("md5", () => {
  it("matches the reference implementation for several sizes, including block boundaries", async () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
      expect(await md5Hex(b), `${n} bytes`).toBe(createHash("md5").update(b).digest("hex"));
    }
  });
});

describe("template form storage and the template builder", () => {
  it("stores the dashboard's template form next to the paywall", async () => {
    const o = await offering("promo");
    const id = (await call("POST", PW, {}, { json: { offering_id: o } })).body.id;
    expect((await call("GET", `${ONE}/template`, { paywall_id: id }, { ext: true })).body.template).toBeNull();
    const put = await call("PUT", `${ONE}/template`, { paywall_id: id }, { ext: true, json: { template: { template: "classic", headline: "Go Pro" } } });
    expect(put.body).toMatchObject({ object: "paywall_template", paywall_id: id, template: { headline: "Go Pro" } });
    expect((await call("GET", `${ONE}/template`, { paywall_id: id }, { ext: true })).body.template.headline).toBe("Go Pro");
    expect((await call("PUT", `${ONE}/template`, { paywall_id: id }, { ext: true, json: { template: "x" } })).status).toBe(400);
  });

  it("builds components every SDK part can find: texts by localization id, packages by identifier, a sticky purchase button", async () => {
    const { buildPaywall } = await import("@revenuedot/core");
    for (const template of ["classic", "hero", "minimal"] as const) {
      const out = buildPaywall({ template, headline: "Unlock", subheadline: "Sub", features: ["A", "B"], cta: "Buy", imageUrl: "https://example.com/x.png", packages: [{ id: "$rc_monthly", label: "Monthly" }, { id: "$rc_annual", label: "Yearly" }], selectedPackage: "$rc_annual" });
      const all: any[] = [];
      const walk = (x: any) => { if (x && typeof x === "object") { if (typeof x.type === "string" && x.id) all.push(x); Object.values(x).forEach(walk); } };
      walk(out.components_config);
      const ids = all.map((x) => x.id);
      expect(new Set(ids).size, template).toBe(ids.length);
      for (const t of all.filter((x) => x.type === "text")) expect(out.components_localizations.en_US[t.text_lid], `${template} ${t.text_lid}`).toBeDefined();
      const pk = all.filter((x) => x.type === "package");
      expect(pk.map((p) => [p.package_id, p.is_selected_by_default])).toEqual([["$rc_monthly", false], ["$rc_annual", true]]);
      expect(all.filter((x) => x.type === "purchase_button")).toHaveLength(1);
      expect((out.components_config.base as any).sticky_footer.type).toBe("footer");
      expect(all.some((x) => x.type === "image")).toBe(template === "hero");
      expect(Object.values(out.components_localizations.en_US)).toEqual(expect.arrayContaining(["Unlock", "Buy", "{{ product.price_per_period }}"]));
    }
  });
});
