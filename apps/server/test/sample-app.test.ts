import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { buildSampleApp, samplePlatformsFor, type SamplePlatform } from "../src/services/sample-apps/index.js";
import { EXAMPLES } from "../src/services/sample-apps/examples.generated.js";
import { crc32, unzip, zip } from "../src/services/sample-apps/zip.js";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  await h.db.update(schema.entitlements).set({ lookupKey: "premium" }).where(eq(schema.entitlements.id, "ent_pro"));
});
afterAll(async () => { await h.close(); });

const text = (files: Map<string, { data: Uint8Array }>, path: string) => new TextDecoder().decode(files.get(path)!.data);
const download = async (app: string, platform?: string) =>
  h.fetch(`/v2/projects/proj1/apps/${app}/sample_app${platform ? `?platform=${platform}` : ""}`, { key: h.ids.secretKey });

describe("zip", () => {
  it("round-trips files with their modes and checksums", () => {
    const enc = new TextEncoder();
    const files = unzip(zip([{ path: "a/gradlew", data: enc.encode("#!/bin/sh\n"), mode: 0o755 }, { path: "a/b.bin", data: new Uint8Array([0, 1, 2, 255]) }]));
    expect([...files.keys()]).toEqual(["a/gradlew", "a/b.bin"]);
    expect(files.get("a/gradlew")!.mode).toBe(0o755);
    expect([...files.get("a/b.bin")!.data]).toEqual([0, 1, 2, 255]);
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("sample app download", () => {
  it("iOS: the App Store app's key, this server and the project's entitlement are filled in; nothing secret", async () => {
    const res = await download("app_ios", "ios");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="revenuedot-ios-swiftui-scanner-ios.zip"');
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    expect(files.size).toBe(EXAMPLES.ios!.files.length);
    const config = text(files, "ios-swiftui/RevenueDotPaywall/RevenueDotConfig.swift");
    expect(config).toContain('static let serverURL = URL(string: "http://localhost")!');
    expect(config).toContain('static let apiKey = "appl_testkey123"');
    expect(config).toContain('static let entitlement = "premium"');
    expect(config).not.toContain("test_replace_me");
    expect(text(files, "ios-swiftui/RevenueDotPaywall.xcodeproj/project.pbxproj")).toContain("RevenueDotPaywall");
    for (const [, f] of files) expect(new TextDecoder().decode(f.data)).not.toMatch(/sk_[A-Za-z0-9]{8}|BEGIN PRIVATE KEY|atk_/);
  });

  it("Android: gradle.properties points the emulator at this server; gradlew stays executable", async () => {
    const res = await h.fetch("/v2/projects/proj1/apps/app_play/sample_app?platform=android", { key: h.ids.secretKey, headers: { "x-forwarded-host": "api.example.com", "x-forwarded-proto": "https" } });
    expect(res.status).toBe(200);
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    const props = text(files, "android-compose/gradle.properties");
    expect(props).toMatch(/^revenuedot\.apiKey=goog_testkey123$/m);
    expect(props).toMatch(/^revenuedot\.serverUrl=https:\/\/api\.example\.com$/m);
    expect(files.get("android-compose/gradlew")!.mode).toBe(0o755);
    expect(files.get("android-compose/gradle/wrapper/gradle-wrapper.jar")!.data.subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    expect(text(files, "android-compose/app/src/main/java/com/example/revenuedot/paywall/PaywallConfig.kt")).toContain('const val ENTITLEMENT = "premium"');
    // localhost becomes 10.0.2.2, the host computer as the Android emulator sees it.
    const local = unzip(new Uint8Array(await (await download("app_play", "android")).arrayBuffer()));
    expect(text(local, "android-compose/gradle.properties")).toMatch(/^revenuedot\.serverUrl=http:\/\/10\.0\.2\.2$/m);
  });

  it("Flutter, React Native and web get a .env with the key under this app's store", async () => {
    const env = async (app: string, platform: SamplePlatform) => {
      const files = unzip(new Uint8Array(await (await download(app, platform)).arrayBuffer()));
      const root = EXAMPLES[platform]!.dir.split("/").pop();
      return Object.fromEntries(text(files, `${root}/.env`).split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=") as [string, string]));
    };
    expect(await env("app_ios", "flutter")).toMatchObject({ REVENUEDOT_URL: "http://localhost", REVENUEDOT_API_KEY: "", REVENUEDOT_IOS_KEY: "appl_testkey123", REVENUEDOT_ANDROID_KEY: "" });
    expect(await env("app_play", "react_native")).toMatchObject({ EXPO_PUBLIC_REVENUEDOT_API_KEY: "", EXPO_PUBLIC_REVENUEDOT_ANDROID_KEY: "goog_testkey123" });
    expect(await env("app_test", "web")).toEqual({ VITE_REVENUEDOT_URL: "http://localhost", VITE_REVENUEDOT_API_KEY: "test_key123" });
    expect(await env("app_test", "flutter")).toMatchObject({ REVENUEDOT_API_KEY: "test_key123" });
  });

  it("offers only the samples that can buy with the app, and refuses others", async () => {
    const settings = await (await h.fetch("/v2/projects/proj1/apps/app_ios/store_settings", { key: h.ids.secretKey })).json();
    expect(settings.sample_apps.map((x: { platform: string }) => x.platform)).toEqual(["ios", "flutter", "react_native"]);
    expect(samplePlatformsFor("galaxy")).toEqual([]);
    const bad = await download("app_ios", "android");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ object: "error", param: "platform" });
    expect((await download("app_ios")).status).toBe(200);
    expect((await download("app_nope", "ios")).status).toBe(404);
  });

  it("every edit still matches the bundled examples exactly once", async () => {
    for (const appType of ["test_store", "app_store", "play_store", "rc_billing"]) {
      for (const platform of samplePlatformsFor(appType)) {
        await expect(buildSampleApp({ platform, appType, appName: "X", publicKey: "k_1", serverUrl: "https://api.example.com", entitlement: "e" })).resolves.toBeTruthy();
        await expect(buildSampleApp({ platform, appType, appName: "X", publicKey: "k_1", serverUrl: "https://api.example.com", entitlement: null })).resolves.toBeTruthy();
      }
    }
  });
});
