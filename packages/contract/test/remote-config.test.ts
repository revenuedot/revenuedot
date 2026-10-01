import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildPaywall } from "@revenuedot/core";
import { parseContainer } from "@revenuedot/server/services/remote-config.js";
import { harness, type Harness } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";

let h: Harness;
let call: ReturnType<typeof v2>;
beforeEach(async () => { h = await harness(); call = v2(h); });
afterEach(async () => { await h.close(); });

const ref = (b: Uint8Array) => createHash("sha256").update(b).digest().subarray(0, 24).toString("base64url");
async function fetchConfig(body: Record<string, unknown> = { fetch_context: "app_start", app_user_id: "u1" }) {
  const res = await h.fetch("/v1/config/app", { method: "POST", key: h.ids.testKey, json: body, headers: { accept: "application/x-rc-format" } });
  return res;
}
async function publishedPaywall(offeringKey = "default") {
  const offs = await call("GET", "/v2/projects/{project_id}/offerings", {}, { query: "expand=items.package" });
  const o = offs.body.items.find((x: any) => x.lookup_key === offeringKey);
  const content = buildPaywall({ template: "classic", headline: "Unlock", packages: o.packages.items.map((p: any) => ({ id: p.lookup_key, label: p.display_name })) });
  const pw = await call("POST", "/v2/projects/{project_id}/paywalls", {}, { json: { offering_id: o.id, ...content } });
  await call("POST", "/v2/projects/{project_id}/paywalls/{paywall_id}/actions/publish", { paywall_id: pw.body.id });
  return pw.body.id as string;
}

describe("remote configuration (RC Container)", () => {
  it("answers a valid container: header, element 0 config JSON, inline blobs whose checksums are their refs", async () => {
    const pw = await publishedPaywall();
    const res = await fetchConfig();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-rc-format");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x52, 0x43, 1, 0, 0, 0, 0, 0]);
    const els = parseContainer(bytes);
    for (const e of els) expect(Buffer.from(e.checksum).toString("base64url")).toBe(ref(e.payload));
    const config = JSON.parse(new TextDecoder().decode(els[0]!.payload));
    expect(config).toMatchObject({ domain: "app", active_topics: ["sources", "ui_config", "workflows"] });
    expect(config.manifest).toMatch(/^v1\./);
    expect(Object.keys(config.topics.ui_config).sort()).toEqual(["app", "custom_variables", "localizations", "variable_config"]);
    expect(config.topics.sources.blob.sources[0].url_format).toMatch(/\/blobs\/\{blob_ref\}$/);
    const wf = config.topics.workflows[`wf_${pw}`];
    expect(wf).toMatchObject({ prefetch: true, offering_identifier: "default" });
    expect(wf.blob_ref).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const inline = new Map(els.slice(1).map((e) => [ref(e.payload), JSON.parse(new TextDecoder().decode(e.payload))]));
    const workflow = inline.get(wf.blob_ref);
    expect(workflow).toMatchObject({ id: `wf_${pw}`, initial_step_id: "step_1", steps: { step_1: { type: "screen", screen_id: "screen_1", param_values: { offering: { identifier: "default" } } } } });
    expect(workflow.screens.screen_1).toMatchObject({ template_name: "components", offering_identifier: "default", default_locale: "en_US" });
    expect(Object.values(workflow.screens.screen_1.components_localizations.en_US)).toContain("Unlock");
    expect(inline.get(config.topics.ui_config.localizations.blob_ref).en_US.month).toBe("month");
    expect(inline.get(config.topics.ui_config.app.blob_ref)).toEqual({ colors: {}, fonts: {} });

    // Every blob is also downloadable without credentials, byte for byte.
    const dl = await h.fetch(`/blobs/${wf.blob_ref}`, { key: "" });
    expect(dl.status).toBe(200);
    expect(ref(new Uint8Array(await dl.arrayBuffer()))).toBe(wf.blob_ref);
    expect((await h.fetch(`/blobs/${"x".repeat(32)}`, { key: "" })).status).toBe(404);
  });

  it("answers 204 while the manifest is current, skips blobs the SDK already holds, and changes when a paywall is published", async () => {
    const first = parseContainer(new Uint8Array(await (await fetchConfig()).arrayBuffer()));
    const config = JSON.parse(new TextDecoder().decode(first[0]!.payload));
    expect(config.topics.workflows).toEqual({});
    expect((await fetchConfig({ fetch_context: "foreground", app_user_id: "u1", manifest: config.manifest })).status).toBe(204);
    const held = Object.values(config.topics.ui_config).map((x: any) => x.blob_ref);
    await publishedPaywall();
    const again = await fetchConfig({ fetch_context: "foreground", app_user_id: "u1", manifest: config.manifest, prefetched_blobs: held });
    expect(again.status).toBe(200);
    const els = parseContainer(new Uint8Array(await again.arrayBuffer()));
    expect(els).toHaveLength(2); // the config and the new workflow; ui_config blobs were already held
  });

  it("leaves out unpublished paywalls and paywalls without an offering, and needs an SDK key", async () => {
    const pw = await publishedPaywall();
    await call("POST", "/v2/projects/{project_id}/paywalls/{paywall_id}/actions/unpublish", { paywall_id: pw });
    const els = parseContainer(new Uint8Array(await (await fetchConfig()).arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(els[0]!.payload)).topics.workflows).toEqual({});
    expect((await h.fetch("/v1/config/app", { method: "POST", key: "", json: {} })).status).toBe(401);
  });
});
