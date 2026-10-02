import { zip, type ZipEntry } from "./zip.js";

/**
 * "Test your setup with the sample app" (RevenueCat's app page offers the same): a zip of the matching example from
 * https://github.com/revenuedot/examples with this app's public key, this server's URL and the project's entitlement
 * filled in. Only public values go in; the examples are bundled into the server by scripts/sample-apps/bundle.mjs.
 */
export type SamplePlatform = "ios" | "android" | "flutter" | "react_native" | "web";

export const SAMPLE_APPS: Record<SamplePlatform, { name: string; example: string }> = {
  ios: { name: "iOS (SwiftUI)", example: "mobile/ios-swiftui" },
  android: { name: "Android (Jetpack Compose)", example: "mobile/android-compose" },
  flutter: { name: "Flutter", example: "mobile/flutter" },
  react_native: { name: "React Native (Expo)", example: "mobile/react-native-expo" },
  web: { name: "Web (purchases-js)", example: "web/purchases-js-vite" },
};

/** Which samples can buy with an app of this type: its SDK and store. The Test Store works with all of them. */
export function samplePlatformsFor(type: string): SamplePlatform[] {
  switch (type) {
    case "test_store": return ["ios", "android", "flutter", "react_native", "web"];
    case "app_store": return ["ios", "flutter", "react_native"];
    case "play_store": return ["android", "flutter", "react_native"];
    case "rc_billing": return ["web"];
    default: return [];
  }
}

export interface SampleInput { platform: SamplePlatform; appType: string; appName: string; publicKey: string; serverUrl: string; entitlement: string | null; now?: Date }

const quoteSwift = (s: string) => JSON.stringify(s);
/** The Android emulator reaches the host computer as 10.0.2.2, not localhost. */
const forEmulator = (url: string) => url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, "$110.0.2.2");

function setEnv(example: string, values: Record<string, string>): string {
  const seen = new Set<string>();
  const out = example.split("\n").map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (!m || !(m[1]! in values)) return line;
    seen.add(m[1]!);
    return `${m[1]}=${values[m[1]!]}`;
  });
  for (const k of Object.keys(values)) if (!seen.has(k)) out.push(`${k}=${values[k]}`);
  return out.join("\n");
}

/** Text edits per platform: [file, exact text in the example, replacement]. Each must match once (tests check). */
function edits(i: SampleInput): Array<[string, string | RegExp, string]> {
  const e = i.entitlement;
  switch (i.platform) {
    case "ios": return [
      ["RevenueDotPaywall/RevenueDotConfig.swift", 'static let serverURL = URL(string: "http://localhost:8787")!', `static let serverURL = URL(string: ${quoteSwift(i.serverUrl)})!`],
      ["RevenueDotPaywall/RevenueDotConfig.swift", 'static let apiKey = "test_replace_me"', `static let apiKey = ${quoteSwift(i.publicKey)}`],
      ...(e ? [["RevenueDotPaywall/RevenueDotConfig.swift", 'static let entitlement = "pro"', `static let entitlement = ${quoteSwift(e)}`] as [string, string, string]] : []),
    ];
    case "android": return [
      ["gradle.properties", /^revenuedot\.serverUrl=.*$/m, `revenuedot.serverUrl=${forEmulator(i.serverUrl)}`],
      ["gradle.properties", /^revenuedot\.apiKey=.*$/m, `revenuedot.apiKey=${i.publicKey}`],
      ...(e ? [["app/src/main/java/com/example/revenuedot/paywall/PaywallConfig.kt", 'const val ENTITLEMENT = "pro"', `const val ENTITLEMENT = ${JSON.stringify(e)}`] as [string, string, string]] : []),
    ];
    case "flutter": return e ? [["lib/revenuedot.dart", "const entitlement = 'pro';", `const entitlement = ${JSON.stringify(e)};`]] : [];
    case "react_native": return e ? [["config.ts", 'entitlement: "pro",', `entitlement: ${JSON.stringify(e)},`]] : [];
    case "web": return e ? [["src/revenuedot.ts", 'export const ENTITLEMENT = "pro";', `export const ENTITLEMENT = ${JSON.stringify(e)};`]] : [];
  }
}

/** The `.env` the cross-platform samples read: the server URL and the key under the variable for this app's store. */
function envFile(i: SampleInput): Record<string, string> | null {
  const store = i.appType === "app_store" ? "IOS" : i.appType === "play_store" ? "ANDROID" : null;
  switch (i.platform) {
    case "flutter": return { REVENUEDOT_URL: i.serverUrl, REVENUEDOT_API_KEY: store ? "" : i.publicKey, ...(store ? { [`REVENUEDOT_${store}_KEY`]: i.publicKey } : {}) };
    case "react_native": return { EXPO_PUBLIC_REVENUEDOT_URL: i.serverUrl, EXPO_PUBLIC_REVENUEDOT_API_KEY: store ? "" : i.publicKey, ...(store ? { [`EXPO_PUBLIC_REVENUEDOT_${store}_KEY`]: i.publicKey } : {}) };
    case "web": return { VITE_REVENUEDOT_URL: i.serverUrl.replace(/\/+$/, ""), VITE_REVENUEDOT_API_KEY: i.publicKey };
    default: return null;
  }
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";

export async function buildSampleApp(i: SampleInput): Promise<{ filename: string; data: Uint8Array<ArrayBuffer>; commit: string }> {
  const { EXAMPLES, EXAMPLES_COMMIT } = await import("./examples.generated.js");
  const ex = EXAMPLES[i.platform];
  if (!ex) throw new Error(`no bundled example for ${i.platform}`);
  const text = new Map<string, string>(), enc = new TextEncoder();
  for (const [path, , kind, data] of ex.files) if (kind === "t") text.set(path, data);
  for (const [file, find, replace] of edits(i)) {
    const src = text.get(file);
    const hits = src === undefined ? 0 : typeof find === "string" ? src.split(find).length - 1 : (src.match(new RegExp(find.source, `${find.flags}g`)) ?? []).length;
    if (hits !== 1) throw new Error(`sample ${i.platform}: expected one "${String(find)}" in ${file}, found ${hits}`);
    text.set(file, src!.replace(find, () => replace));
  }
  const env = envFile(i);
  if (env) text.set(".env", setEnv(text.get(".env.example") ?? "", env) + "\n");
  const root = ex.dir.split("/").pop()!;
  const entries: ZipEntry[] = ex.files.map(([path, mode, kind, data]) => ({ path: `${root}/${path}`, mode, data: kind === "t" ? enc.encode(text.get(path)!) : b64(data) }));
  if (env) entries.push({ path: `${root}/.env`, mode: 0o644, data: enc.encode(text.get(".env")!) });
  return { filename: `revenuedot-${root}-${slug(i.appName)}.zip`, data: zip(entries, i.now), commit: EXAMPLES_COMMIT };
}
