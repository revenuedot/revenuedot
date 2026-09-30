// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the Android emulator contract run (SCOPE 1.0 and 1.1). Starts a RevenueDot server, seeds a Test Store
// catalog, boots an emulator headless, runs the UIAutomator test that drives the unmodified RevenueCat Android SDK
// (configure, getCustomerInfo, getOfferings, attributes, a Test Store purchase, logIn, syncPurchases, virtual currencies,
// web purchase redemption, reward verification), then checks the server's request log and what it stored.
//
//   pnpm tsx scripts/e2e/android/run.ts                  (AVD rd_harness, a fresh database)
//   ANDROID_AVD=my_avd SHOTS=/tmp/shots pnpm tsx scripts/e2e/android/run.ts
//
// Database: DATABASE_URL if set; else a fresh `rd_android_harness` database on the shared dev Postgres
// (REVENUEDOT_DEV_DATABASE_URL from ~/.config/revenuedot/dev.env), dropped afterwards; else an on-disk PGlite under build/.
// Needs JDK 17 and the Android SDK (platform-tools, emulator, android-35, an arm64-v8a system image, an AVD). JAVA_HOME
// and ANDROID_HOME default to the Homebrew openjdk@17 and android-commandlinetools paths. Docs: https://revenuedot.app/docs/sdks/android
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { client, seedProject, session } from "../../../apps/dashboard/e2e/seed.ts";
import { attributeChecks, readLog, requestChecks, type Expectation } from "../sdk-calls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const BUILD = join(HERE, "build");
const PORT = Number(process.env.HARNESS_PORT ?? 8872);
const BASE = `http://localhost:${PORT}`;
// The emulator reaches the Mac's loopback at 10.0.2.2.
const DEVICE_BASE = `http://10.0.2.2:${PORT}`;
const AVD = process.env.ANDROID_AVD ?? "rd_harness";
const LOGIN_ID = `android_harness_${Date.now()}`;
const APP_ID = "app.revenuedot.harness";
const DB_NAME = "rd_android_harness";
const REQUEST_LOG = join(BUILD, "requests.jsonl");
const JAVA_HOME = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home";
const ANDROID_HOME = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? "/opt/homebrew/share/android-commandlinetools";
const ENV = { ...process.env, JAVA_HOME, ANDROID_HOME, PATH: `${JAVA_HOME}/bin:${process.env.PATH}` };
const ADB = join(ANDROID_HOME, "platform-tools/adb");
const postgres = createRequire(join(ROOT, "packages/db/package.json"))("postgres") as typeof import("postgres").default;

function devEnvUrl(): string | null {
  if (process.env.REVENUEDOT_DEV_DATABASE_URL) return process.env.REVENUEDOT_DEV_DATABASE_URL;
  const file = join(process.env.HOME ?? "", ".config/revenuedot/dev.env");
  if (!existsSync(file)) return null;
  const m = /REVENUEDOT_DEV_DATABASE_URL=["']?([^"'\n]+)/.exec(readFileSync(file, "utf8"));
  return m?.[1] ?? null;
}

async function adminSql(fn: (sql: ReturnType<typeof postgres>) => Promise<unknown>) {
  const sql = postgres(devEnvUrl()!, { max: 1, onnotice: () => {} });
  try { await fn(sql); } finally { await sql.end(); }
}

/** A clean database for this run. The URL is never printed. */
async function database(): Promise<{ url: string; owned: boolean }> {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, owned: false };
  const admin = devEnvUrl();
  if (!admin) {
    const dir = join(BUILD, "pglite");
    rmSync(dir, { recursive: true, force: true });
    return { url: `pglite://${dir}`, owned: false };
  }
  await adminSql(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await sql.unsafe(`CREATE DATABASE ${DB_NAME}`);
  });
  const u = new URL(admin);
  u.pathname = `/${DB_NAME}`;
  return { url: u.href, owned: true };
}

async function startServer(databaseUrl: string): Promise<ChildProcess> {
  // The server logs to a file: Gradle and the emulator run for minutes, and a full pipe would stall the server.
  mkdirSync(BUILD, { recursive: true });
  rmSync(REQUEST_LOG, { force: true });
  const logFile = join(BUILD, "server.log");
  const fd = openSync(logFile, "w");
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(HERE, "harness-server.ts")], {
    cwd: join(ROOT, "apps/server"), env: { ...process.env, PORT: String(PORT), DATABASE_URL: databaseUrl, REVENUEDOT_ALLOW_SIGNUP: "true", REVENUEDOT_REQUEST_LOG: REQUEST_LOG }, stdio: ["ignore", fd, fd],
    detached: true,
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/v1/health`)).ok) return child; } catch { /* not up yet */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(child);
  throw new Error(`The server did not start on ${BASE}:\n${readFileSync(logFile, "utf8").replace(/postgres(ql)?:\/\/\S+/g, "postgres://…").slice(-2000)}`);
}

function stop(child: ChildProcess) {
  try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); }
}

/** Runs a command without blocking the event loop (the server shares this process's sockets). */
function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd ?? HERE, env: ENV });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const adb = (...args: string[]) => run(ADB, args);

/** Boots the AVD headless unless an emulator is already attached. Returns the emulator process when this run started it. */
async function bootEmulator(): Promise<ChildProcess | undefined> {
  const attached = (await adb("devices")).out.split("\n").some((l) => /^emulator-\d+\s+device/.test(l));
  let emu: ChildProcess | undefined;
  if (!attached) {
    const fd = openSync(join(BUILD, "emulator.log"), "w");
    emu = spawn(join(ANDROID_HOME, "emulator/emulator"), ["-avd", AVD, "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-gpu", "swiftshader_indirect"], {
      env: ENV, stdio: ["ignore", fd, fd], detached: true,
    });
    // Does not hold this process open (KEEP_EMULATOR leaves it running).
    emu.unref();
  }
  await adb("wait-for-device");
  for (let i = 0; i < 180; i++) {
    if ((await adb("shell", "getprop", "sys.boot_completed")).out.trim() === "1") break;
    if (emu && emu.exitCode !== null) throw new Error(`The emulator exited:\n${readFileSync(join(BUILD, "emulator.log"), "utf8").slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Animations off, so UIAutomator does not race dialog transitions.
  for (const k of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) await adb("shell", "settings", "put", "global", k, "0");
  await adb("shell", "input", "keyevent", "82"); // unlock
  return emu;
}

async function shutdownEmulator(emu: ChildProcess | undefined) {
  if (!emu) return;
  await adb("emu", "kill");
  for (let i = 0; i < 30 && emu.exitCode === null; i++) await new Promise((r) => setTimeout(r, 1000));
  if (emu.exitCode === null) stop(emu);
}

async function instrumentedTest(testKey: string, shots: string | undefined) {
  const build = await run(join(HERE, "gradlew"), [":app:assembleDebug", ":app:assembleDebugAndroidTest", "-q"]);
  if (build.code !== 0) return { ok: false, summary: build.out.slice(-3000) };
  // A fresh install: the SDK keeps its app user id and caches in the app's data between runs.
  await adb("uninstall", APP_ID);
  await adb("uninstall", `${APP_ID}.test`);
  for (const apk of ["app/build/outputs/apk/debug/app-debug.apk", "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"]) {
    const r = await adb("install", "-r", "-t", join(HERE, apk));
    if (r.code !== 0) return { ok: false, summary: r.out };
  }
  const t = await adb("shell", "am", "instrument", "-w", "-r",
    "-e", "RD_SERVER_URL", DEVICE_BASE, "-e", "RD_API_KEY", testKey, "-e", "RD_LOGIN_ID", LOGIN_ID,
    `${APP_ID}.test/androidx.test.runner.AndroidJUnitRunner`);
  const ok = t.code === 0 && /OK \(1 test\)/.test(t.out);
  if (shots) await adb("pull", `/sdcard/Android/data/${APP_ID}/files/.`, shots);
  if (!ok) {
    const log = (await adb("logcat", "-d", "-s", "Purchases:*", "AndroidRuntime:E", "TestRunner:*")).out;
    return { ok, summary: `${t.out.slice(-3000)}\n--- logcat ---\n${log.slice(-4000)}` };
  }
  return { ok, summary: t.out.split("\n").filter((l) => /OK \(|FAILURES|Time:/.test(l)).join("\n") };
}

type Check = { name: string; ok: boolean; detail?: unknown };
let testStarted = 0;

/** The calls the harness makes beyond configure, with what the inventory in prd/sdk-api/PRD.md documents for each. */
const EXPECTED: Expectation[] = [
  { method: "POST", template: "/v1/subscribers/{app_user_id}/attributes", min: 1, statuses: [200], why: "attribute sync" },
  { method: "POST", template: "/v1/receipts", count: 1, statuses: [200], why: "the Test Store purchase; syncPurchases has no store purchase to send" },
  { method: "GET", template: "/v1/subscribers/{app_user_id}/virtual_currencies", count: 1, statuses: [200], why: "getVirtualCurrencies" },
  { method: "POST", template: "/v1/subscribers/redeem_purchase", count: 1, statuses: [400], why: "redeemWebPurchase, 7849 InvalidToken" },
  { method: "GET", template: "/v1/subscribers/{app_user_id}/ads/reward_verifications/{client_transaction_id}", count: 1, statuses: [200], why: "pollRewardVerification stops at failed" },
  { method: "POST", template: "/v1/config/app", min: 1, statuses: [204], why: "remote config" },
];

async function serverState(cookie: string, projectId: string): Promise<Check[]> {
  const call = client(BASE, cookie);
  const P = `/v2/projects/${projectId}`;
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail });
  const cu = await call("GET", `${P}/customers/${LOGIN_ID}`);
  const ents = (cu.active_entitlements?.items ?? []).map((e: { entitlement_id: string }) => e.entitlement_id);
  const entList = await call("GET", `${P}/entitlements?limit=100`);
  const pro = entList.items.find((e: { lookup_key: string }) => e.lookup_key === "pro");
  check("the logged-in customer has the pro entitlement", ents.includes(pro.id), ents);
  const aliases = (await call("GET", `${P}/customers/${LOGIN_ID}/aliases`)).items.map((a: { id: string }) => a.id);
  check("logIn aliased the anonymous id that bought", aliases.some((a: string) => a.startsWith("$RCAnonymousID:")) && aliases.includes(LOGIN_ID), aliases);
  const subs = (await call("GET", `${P}/customers/${LOGIN_ID}/subscriptions`)).items;
  check("one Test Store subscription, sandbox, auto-renewing", subs.length === 1 && subs[0].store === "test_store" && subs[0].environment === "sandbox" && subs[0].gives_access === true,
    subs.map((s: Record<string, unknown>) => ({ store: s.store, environment: s.environment, status: s.status, product_id: s.product_id })));
  const events = (await call("GET", `${P}/customers/${LOGIN_ID}/events?limit=50`)).items.map((e: { type: string }) => e.type);
  // The seed gives every product a Test Store price, so the SDK's dialog and the recorded purchase are not $0.00.
  const gross = subs[0]?.total_revenue_in_usd?.gross ?? 0;
  check("the purchase recorded a nonzero price (the catalog's Test Store price)", gross > 0, { product_id: subs[0]?.product_id, gross });
  check("INITIAL_PURCHASE recorded (webhook source)", events.includes("INITIAL_PURCHASE"), events);
  const health = await call("GET", `${P}/setup_health`);
  const sdk = (health.sdk_versions ?? []).filter((v: { platform: string }) => /android/i.test(v.platform));
  check("the SDK compatibility panel saw the Android SDK", sdk.length > 0, sdk.map((v: Record<string, unknown>) => `${v.platform} ${v.platform_flavor} ${v.sdk_version} (${v.support})`));

  // Attributes, as the dashboard's customer page reads them (v2 customer attributes).
  const attrs = Object.fromEntries((await call("GET", `${P}/customers/${LOGIN_ID}/attributes?limit=100`)).items.map((a: { name: string; value: string | null }) => [a.name, a.value]));
  checks.push(...attributeChecks(attrs, {
    $email: "harness@revenuedot.test", $displayName: "RD Harness", harness_run: "android", $adjustId: "adjust-harness-1",
    $mediaSource: "Harness Network", $campaign: "Harness Android", $ip: /^(\d{1,3}\.){3}\d{1,3}$|:/, $deviceVersion: /android/i,
  }, "customer attributes"));
  // The purchase came after the attributes, so its webhook payload carries them.
  const purchase = (await call("GET", `${P}/customers/${LOGIN_ID}/events?limit=50`)).items.find((e: { type: string }) => e.type === "INITIAL_PURCHASE");
  const sa = Object.fromEntries(Object.entries((purchase?.body?.subscriber_attributes ?? {}) as Record<string, { value: string | null }>).map(([k, v]) => [k, v.value]));
  checks.push(...attributeChecks(sa, { $email: "harness@revenuedot.test", $mediaSource: "Harness Network" }, "INITIAL_PURCHASE webhook subscriber_attributes"));
  // Only what the device sent while the test ran (seeding posts receipts through the same server).
  checks.push(...requestChecks(readLog(REQUEST_LOG).filter((r) => r.at >= testStarted), EXPECTED));
  return checks;
}

let server: ChildProcess | undefined;
let emu: ChildProcess | undefined;
let owned = false;
const started = Date.now();
try {
  const shots = process.env.SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  mkdirSync(BUILD, { recursive: true });
  const db = await database();
  owned = db.owned;
  // The emulator boots while the server starts.
  const booting = bootEmulator();
  server = await startServer(db.url);
  const cookie = await session(BASE, "android-harness@revenuedot.test", "android-harness-password", "Android harness");
  const me = await (await fetch(`${BASE}/auth/me`, { headers: { cookie } })).json() as { projects: { id: string }[] };
  const projectId = me.projects[0]!.id;
  const seeded = await seedProject(BASE, cookie, projectId, { customers: 2 });
  emu = await booting;
  console.log(`Server ${BASE} (device sees ${DEVICE_BASE}), project ${projectId}, Test Store key ${seeded.testKey.slice(0, 9)}…, AVD ${AVD}, login id ${LOGIN_ID}`);

  const t0 = Date.now();
  testStarted = t0;
  const x = await instrumentedTest(seeded.testKey, shots);
  console.log(x.summary);
  console.log(`instrumented test: ${x.ok ? "passed" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)}s`);
  const checks = x.ok ? await serverState(cookie, projectId) : [];
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${JSON.stringify(c.detail)}`);
  const pass = x.ok && checks.every((c) => c.ok);
  console.log(`${pass ? "Android emulator run: PASS" : "Android emulator run: FAIL"} (${Math.round((Date.now() - started) / 1000)}s total)`);
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  if (server) stop(server);
  if (!process.env.KEEP_EMULATOR) await shutdownEmulator(emu);
  if (owned) await adminSql((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)).catch(() => undefined);
}
