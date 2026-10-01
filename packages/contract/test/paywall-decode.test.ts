/**
 * Decodes what the server serves with the RevenueCat iOS SDK's own Swift models (scripts/e2e/paywall-decode, built from the
 * purchases-ios fork next to this repo): every gallery template as published through the API, a paywall built with the
 * editor's operations (every component type), a repaired AI answer, and the remote-config workflow. Needs Swift, so it
 * runs only with PAYWALL_DECODE=1:
 *   PAYWALL_DECODE=1 pnpm vitest run packages/contract/test/paywall-decode.test.ts
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDABLE_TYPES, PAYWALL_TEMPLATES, applyOp, blankPaywall, newComponent, paywallFromModel } from "@revenuedot/core";
import { parseContainer } from "@revenuedot/server/services/remote-config.js";
import { decodeWithSdk, buildDecoder } from "../../../scripts/e2e/paywall-decode/decode.js";
import { harness } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";

const ICONS = "https://api.revenuedot.app/assets/icons";

describe.skipIf(!process.env.PAYWALL_DECODE)("paywalls decode in the iOS SDK", () => {
  it("templates as served, an editor-built paywall, an AI paywall and the workflow", async () => {
    const h = await harness();
    const call = v2(h);
    try {
      const pkgs = ["$rc_annual", "$rc_monthly", "$rc_weekly", "$rc_lifetime"];
      const served: { name: string; paywall: unknown }[] = [];
      for (const t of PAYWALL_TEMPLATES) {
        const o = (await call("POST", "/v2/projects/{project_id}/offerings", {}, { json: { lookup_key: `o_${t.id}`, display_name: t.name } })).body.id;
        for (const lk of pkgs) await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/packages", { offering_id: o }, { json: { lookup_key: lk, display_name: lk } });
        const pw = await call("POST", "/v2/projects/{project_id}/paywalls", {}, { ext: true, json: { offering_id: o, template_id: t.id, template_options: { terms_url: "https://example.com/terms", privacy_url: "https://example.com/privacy" } } });
        expect((await call("POST", "/v2/projects/{project_id}/paywalls/{paywall_id}/actions/publish", { paywall_id: pw.body.id })).status, t.id).toBe(200);
      }
      // The editor: a blank paywall plus one of every addable component, inserted, moved and duplicated.
      let doc = blankPaywall({ iconBaseUrl: ICONS });
      for (const t of ADDABLE_TYPES) {
        if (t === "sticky_footer") continue;
        const c = newComponent(t, { doc, iconBaseUrl: ICONS, packages: pkgs });
        if (t === "video") c.source.light.url = "https://example.com/v.mp4";
        if (t === "web_view") c.url = "https://example.com/embed";
        doc = applyOp(doc, { kind: "insert", component: c, targetId: null, position: "after" })!.doc;
      }
      const second = doc.components_config.base.stack.components[2]!.id;
      doc = applyOp(doc, { kind: "duplicate", id: second })!.doc;
      doc = applyOp(doc, { kind: "move", id: second, delta: 3 })!.doc;
      doc.components_localizations.es_ES = { [Object.keys(doc.components_localizations.en_US!)[0]!]: "Hola" };
      const o = (await call("POST", "/v2/projects/{project_id}/offerings", {}, { json: { lookup_key: "editor", display_name: "Editor" } })).body.id;
      for (const lk of pkgs) await call("POST", "/v2/projects/{project_id}/offerings/{offering_id}/packages", { offering_id: o }, { json: { lookup_key: lk, display_name: lk } });
      const ed = await call("POST", "/v2/projects/{project_id}/paywalls", {}, { json: { offering_id: o, ...doc } });
      expect((await call("POST", "/v2/projects/{project_id}/paywalls/{paywall_id}/actions/publish", { paywall_id: ed.body.id })).status).toBe(200);

      const sdk = (await (await h.fetch("/v1/subscribers/anyone/offerings", { key: h.ids.testKey })).json()) as any;
      for (const off of sdk.offerings) if (off.has_paywall_components) served.push({ name: off.identifier, paywall: off.paywall_components });
      expect(served.length).toBe(PAYWALL_TEMPLATES.length + 1);

      const ai = paywallFromModel(JSON.stringify({ components: [{ type: "title", text: "Hi" }, { type: "timeline", items: ["Today", "Day 5"] }, { type: "carousel", pages: [{ components: ["A"] }] }, { type: "countdown" }, { type: "tabs", tabs: [{ name: "A", components: [{ type: "packages" }] }] }] }), { prompt: "x", packages: pkgs }, ICONS);
      served.push({ name: "ai", paywall: { id: "pw_ai", template_name: "components", asset_base_url: "https://api.revenuedot.app/assets/p", revision: 1, ...ai.doc } });

      const res = decodeWithSdk(served);
      expect(Object.entries(res).filter(([, v]) => v !== null)).toEqual([]);

      // The remote-config workflow of the editor paywall (iOS 5.83+ read paywalls only from here).
      const cfgRes = await h.fetch("/v1/config/app", { method: "POST", key: h.ids.testKey, json: { fetch_context: "app_start", app_user_id: "u1" } });
      const els = parseContainer(new Uint8Array(await cfgRes.arrayBuffer()));
      const cfg = JSON.parse(new TextDecoder().decode(els[0]!.payload));
      const ref = (Object.values(cfg.topics.workflows) as any[]).find((w) => w.offering_identifier === "editor").blob_ref;
      const blob = els.slice(1).find((e) => Buffer.from(e.checksum).toString("base64url") === ref)!;
      const dir = mkdtempSync(join(tmpdir(), "rd-wf-"));
      writeFileSync(join(dir, "wf.json"), blob.payload);
      buildDecoder();
      const out = spawnSync(join(__dirname, "../../../scripts/e2e/paywall-decode/.build/release/paywall-decode"), [join(dir, "wf.json"), "workflow"], { encoding: "utf8" });
      expect(out.stdout).toMatch(/^WORKFLOW OK/);
    } finally { await h.close(); }
  }, 600_000);
});
