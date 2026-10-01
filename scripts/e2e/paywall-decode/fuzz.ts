// RevenueDot: differential check of the publish validator against the iOS SDK decoder. Mutates every gallery template and an
// editor-built paywall (every key: deleted, null, each wrong type; every optional SDK field added with each type) and prints
// each mutant the validator accepts but the SDK cannot decode (a published paywall that would break apps). Needs Swift:
//   pnpm tsx scripts/e2e/paywall-decode/fuzz.ts      (SHOW_REJECT=1 also lists what the validator refuses but the SDK decodes)
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as core from "../../../packages/core/src/index.js";
import { asOfferingPaywall, buildDecoder } from "./decode.js";

const ICONS = "https://api.revenuedot.app/assets/icons";
const pkgs = ["$rc_annual", "$rc_monthly", "$rc_weekly", "$rc_lifetime"];
const docs: [string, any][] = core.PAYWALL_TEMPLATES.map((t) => [t.id, t.build({ termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy", packages: pkgs.map((id) => ({ id, label: id })) })]);
let ed: any = core.blankPaywall({ iconBaseUrl: ICONS });
for (const t of core.ADDABLE_TYPES) {
  if (t === "sticky_footer") continue;
  const c = core.newComponent(t, { doc: ed, iconBaseUrl: ICONS, packages: pkgs });
  if (t === "video") c.source.light.url = "https://example.com/v.mp4";
  if (t === "web_view") c.url = "https://example.com/embed";
  ed = core.applyOp(ed, { kind: "insert", component: c, targetId: null, position: "after" })!.doc;
}
ed.components_localizations.es_ES = { [Object.keys(ed.components_localizations.en_US)[0]]: "Hola" };
docs.push(["editor", ed]);

const VALUES: [string, unknown][] = [["null", null], ["str", "x"], ["num", 1.5], ["int", 7], ["obj", {}], ["arr", []], ["bool", true], ["neg", -3]];
type Mut = { name: string; doc: any };
const muts: Mut[] = [];
const seen = new Set<string>();
const clone = (x: any) => JSON.parse(JSON.stringify(x));
function walk(docName: string, doc: any, node: any, path: (string | number)[], sig: string) {
  if (node === null || typeof node !== "object") return;
  const entries: [string | number, any][] = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  for (const [k, v] of entries) {
    const ksig = typeof k === "number" ? "[]" : k;
    // Component-type-aware signature, so one mutant per (type, key path).
    const typed = v && typeof v === "object" && typeof v.type === "string" ? `${sig}.${ksig}<${v.type}>` : `${sig}.${ksig}`;
    const short = typed.replace(/^.*<([^>]+)>/, "<$1>");
    const isLoc = path[0] === "components_localizations";
    const key = isLoc ? `${path.length}:${typeof k}:${typeof v}:${Array.isArray(v)}` + (path.length > 1 ? "" : String(k === "en_US")) : short;
    if (!seen.has(key)) {
      seen.add(key);
      const variants: [string, (o: any) => void][] = [];
      if (!Array.isArray(node)) variants.push(["del", (o) => { delete o[k]; }]);
      for (const [vn, val] of VALUES) variants.push([vn, (o) => { o[k] = clone(val); }]);
      if (typeof v === "string") variants.push(["badstr", (o) => { o[k] = "zz_unknown"; }], ["empty", (o) => { o[k] = ""; }]);
      for (const [vn, f] of variants) {
        const d = clone(doc);
        let o = d; for (const p of path) o = o[p];
        f(o);
        muts.push({ name: `${docName}:${[...path, k].join(".")}=${vn}`, doc: d });
      }
    }
    walk(docName, doc, v, [...path, k], typed);
  }
}
for (const [n, d] of docs) walk(n, d, d, [], "");
// Optional SDK fields the documents do not set: add each with every kind of value.
const OPTIONAL: Record<string, string[]> = {
  button: ["name", "transition", "overrides", "state_updates"], carousel: ["name", "visible", "size", "padding", "margin", "background", "shape", "border", "shadow", "auto_advance", "page_control", "overrides", "state_updates"],
  countdown: ["name", "end_stack", "fallback", "overrides"], icon: ["visible", "padding", "margin", "icon_background", "overrides"],
  image: ["visible", "override_source_lid", "mask_shape", "color_overlay", "padding", "margin", "border", "shadow", "overrides"],
  package: ["visible", "apple_promo_offer_product_code", "name", "haptic_feedback_enabled", "overrides"], purchase_button: ["name", "action", "method"],
  stack: ["name", "visible", "spacing", "background_color", "background", "shape", "border", "shadow", "badge", "overflow", "overrides"],
  tab_control_button: ["name", "haptic_feedback_enabled"], tab_control_toggle: ["name", "haptic_feedback_enabled"],
  tabs: ["name", "visible", "background", "shape", "border", "shadow", "default_tab_id", "overrides", "state_updates"],
  text: ["visible", "name", "font_name", "background_color", "font_weight_int", "overrides"],
  timeline: ["visible", "icon_alignment", "item_spacing", "text_spacing", "column_gutter", "overrides"],
  video: ["fallback_source", "visible", "mask_shape", "color_overlay", "padding", "margin", "border", "shadow", "overrides"], web_view: ["name", "visible", "overrides"],
};
const OVR: [string, unknown][] = [
  ["ovr_cond_selected", [{ conditions: [{ type: "selected" }], properties: { visible: false } }]],
  ["ovr_cond_unknown", [{ conditions: [{ type: "zz" }], properties: { visible: false } }]],
  ["ovr_cond_intro", [{ conditions: [{ type: "intro_offer", operator: "=", value: "x" }], properties: { visible: false } }]],
  ["ovr_cond_variable", [{ conditions: [{ type: "variable", operator: "=", variable: "a" }], properties: { visible: false } }]],
  ["ovr_cond_pkg", [{ conditions: [{ type: "selected_package", operator: "in", packages: "x" }], properties: { visible: false } }]],
  ["ovr_cond_notobj", [{ conditions: ["selected"], properties: { visible: false } }]],
  ["ovr_props_badsize", [{ conditions: [{ type: "selected" }], properties: { size: 1 } }]],
  ["ovr_props_unknown", [{ conditions: [{ type: "selected" }], properties: { zz: 1 } }]],
];
const seenT = new Set<string>();
for (const [n, d] of docs) {
  const visit = (x: any, path: (string | number)[]) => {
    if (!x || typeof x !== "object") return;
    if (typeof x.type === "string" && OPTIONAL[x.type] && !seenT.has(x.type) && path[0] === "components_config") {
      seenT.add(x.type);
      for (const k of OPTIONAL[x.type]!) {
        if (k in x) continue;
        const vals: [string, unknown][] = k === "overrides" ? [...VALUES, ...OVR] : VALUES;
        for (const [vn, val] of vals) {
          const dd = clone(d); let o = dd; for (const p of path) o = o[p];
          o[k] = clone(val);
          muts.push({ name: `opt:${n}:${x.type}.${k}=${vn}`, doc: dd });
        }
      }
    }
    for (const [k, v] of Array.isArray(x) ? x.entries() : Object.entries(x)) visit(v, [...path, k]);
  };
  visit(d, []);
}
// Extra top-level cases.
const base = docs[0]![1];
const extra: [string, (d: any) => void][] = [
  ["exit_offers_bad", (d) => { d.exit_offers = { dismiss: { offering: 1 } }; }],
  ["exit_offers_str", (d) => { d.exit_offers = "x"; }],
  ["exit_offers_ok", (d) => { d.exit_offers = { dismiss: { offering_id: "o" } }; }],
  ["state_decl_bad", (d) => { d.state_declarations = { a: 1 }; }],
  ["loc_extra_locale_num", (d) => { d.components_localizations.fr_FR = { a: 1 }; }],
  ["loc_extra_locale_str", (d) => { d.components_localizations.fr_FR = "x"; }],
  ["loc_extra_locale_imgbad", (d) => { d.components_localizations.fr_FR = { a: { foo: 1 } }; }],
  ["loc_default_imgbad", (d) => { const t = d.components_localizations[d.default_locale]; t.zz = { foo: 1 }; }],
  ["default_locale_missing", (d) => { d.default_locale = "xx_XX"; }],
];
for (const [n, f] of extra) { const d = clone(base); f(d); muts.push({ name: `extra:${n}`, doc: d }); }

console.error(`${muts.length} mutants`);
const dir = join(process.env.TMPDIR ?? "/tmp", "rd-fuzz");
mkdirSync(dir, { recursive: true });
buildDecoder();
const files: string[] = [];
const results: { name: string; valid: boolean; errs: string; sdk: string | null }[] = [];
muts.forEach((m, i) => {
  const v = core.validatePaywall(m.doc, { packages: pkgs });
  // As the server serves it (services/paywalls.ts): default locale en_US, every locale completed.
  const served = { ...m.doc, default_locale: m.doc.default_locale ?? "en_US", components_localizations: core.fillLocales(isObj(m.doc.components_localizations) ? m.doc.components_localizations : {}, m.doc.default_locale ?? "en_US") };
  const f = join(dir, `${i}.json`);
  writeFileSync(f, JSON.stringify(asOfferingPaywall(served as any)));
  files.push(f);
  results.push({ name: m.name, valid: v.valid, errs: v.errors.map((e) => `${e.path}: ${e.message}`).slice(0, 2).join(" | "), sdk: null });
});
function isObj(x: unknown): x is Record<string, any> { return !!x && typeof x === "object" && !Array.isArray(x); }
const bin = join(import.meta.dirname, ".build/release/paywall-decode");
for (let s = 0; s < files.length; s += 500) {
  const chunk = files.slice(s, s + 500);
  const r = spawnSync(bin, ["--many", ...chunk], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  for (const line of r.stdout.split("\n")) {
    const m = /^(OK|ERROR) (\S+)(?: (.*))?$/.exec(line);
    if (!m) continue;
    const idx = files.indexOf(m[2]!);
    results[idx]!.sdk = m[1] === "OK" ? "OK" : (m[3] ?? "error");
  }
}
const falseAccept = results.filter((r) => r.valid && r.sdk !== "OK");
const falseReject = results.filter((r) => !r.valid && r.sdk === "OK");
console.log(`mutants ${results.length}; validator accepts but SDK fails: ${falseAccept.length}; validator refuses but SDK decodes: ${falseReject.length}`);
console.log("=== FALSE ACCEPT (would break apps) ===");
for (const r of falseAccept) console.log(`${r.name}\n    SDK: ${r.sdk}`);
if (process.env.SHOW_REJECT) { console.log("=== FALSE REJECT ==="); for (const r of falseReject) console.log(`${r.name}\n    validator: ${r.errs}`); }
process.exitCode = falseAccept.length ? 1 : 0;
