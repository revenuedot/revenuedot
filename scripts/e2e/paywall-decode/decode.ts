// RevenueDot: decodes paywalls with the RevenueCat iOS SDK's own Swift models (the purchases-ios fork next to this repo).
// Used by packages/contract/test/paywall-decode.test.ts (PAYWALL_DECODE=1) and runnable on its own:
//   pnpm tsx scripts/e2e/paywall-decode/decode.ts        decodes every gallery template, the blank paywall and a repaired AI answer
// The first run builds the Swift package (a few minutes); later runs reuse .build.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The `paywall_components` object an offering carries, around a paywall document. */
export function asOfferingPaywall(doc: { components_config: unknown; components_localizations: unknown; default_locale: string }, id = "pw_test") {
  return {
    id, template_name: "components", asset_base_url: "https://api.revenuedot.app/assets/proj", revision: 1,
    zero_decimal_place_countries: { apple: ["TWN"], google: ["TW"] }, ...doc,
  };
}

/** Builds the decoder once (release). Throws with the build log when Swift is missing or the build fails. */
export function buildDecoder() {
  const b = spawnSync("swift", ["build", "-c", "release"], { cwd: HERE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (b.status !== 0) throw new Error(`swift build failed:\n${(b.stdout + b.stderr).slice(-3000)}`);
}

/** Decodes each paywall with the SDK. Returns one result per name: null when it decodes, else the SDK's error. */
export function decodeWithSdk(items: { name: string; paywall: unknown }[]): Record<string, string | null> {
  buildDecoder();
  const dir = mkdtempSync(join(tmpdir(), "rd-paywall-decode-"));
  mkdirSync(dir, { recursive: true });
  const files = items.map((it, i) => { const f = join(dir, `${i}-${it.name.replace(/[^\w.-]+/g, "_")}.json`); writeFileSync(f, JSON.stringify(it.paywall)); return f; });
  const r = spawnSync(join(HERE, ".build/release/paywall-decode"), ["--many", ...files], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out: Record<string, string | null> = {};
  const lines = r.stdout.split("\n");
  items.forEach((it, i) => {
    const line = lines.find((l) => l.endsWith(files[i]!) || l.includes(` ${files[i]!} `) || l.endsWith(` ${files[i]!}`));
    out[it.name] = !line ? `no result (${r.stderr.slice(-500)})` : line.startsWith("OK ") ? null : line.slice(line.indexOf(files[i]!) + files[i]!.length + 1);
  });
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void (async () => {
  const core = await import("../../../packages/core/src/index.js");
  const items = [
    ...core.PAYWALL_TEMPLATES.map((t) => ({ name: t.id, paywall: asOfferingPaywall(t.build({ termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy" })) })),
    { name: "blank", paywall: asOfferingPaywall(core.blankPaywall()) },
  ];
  const res = decodeWithSdk(items);
  for (const [k, v] of Object.entries(res)) console.log(v === null ? `ok   ${k}` : `FAIL ${k}: ${v}`);
  process.exitCode = Object.values(res).every((v) => v === null) ? 0 : 1;
})();
