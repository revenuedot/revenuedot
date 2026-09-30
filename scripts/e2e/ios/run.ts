// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the iOS simulator contract run (SCOPE 1.0). Starts a RevenueDot server, seeds a Test Store catalog, runs the
// XCUITest that drives the unmodified RevenueCat iOS SDK (configure, getCustomerInfo, getOfferings, a Test Store
// purchase, logIn) on a booted simulator, then checks what the server recorded.
//
//   pnpm tsx scripts/e2e/ios/run.ts                     (iPhone 17 Pro, a fresh database)
//   IOS_DEVICE="iPhone 16" SHOTS=/tmp/shots pnpm tsx scripts/e2e/ios/run.ts
//
// Database: DATABASE_URL if set; else a fresh `rd_ios_harness` database on the shared dev Postgres
// (REVENUEDOT_DEV_DATABASE_URL from ~/.config/revenuedot/dev.env); else an on-disk PGlite under build/.
// Needs Xcode and XcodeGen (brew install xcodegen). Docs: https://revenuedot.app/docs/sdks/ios
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { client, seedProject, session } from "../../../apps/dashboard/e2e/seed.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const BUILD = join(HERE, "build");
const PORT = Number(process.env.HARNESS_PORT ?? 8871);
const BASE = `http://localhost:${PORT}`;
const DEVICE = process.env.IOS_DEVICE ?? "iPhone 17 Pro";
const LOGIN_ID = `ios_harness_${Date.now()}`;
// The Postgres client lives in packages/db (pnpm keeps dependencies per package).
const postgres = createRequire(join(ROOT, "packages/db/package.json"))("postgres") as typeof import("postgres").default;

function devEnvUrl(): string | null {
  if (process.env.REVENUEDOT_DEV_DATABASE_URL) return process.env.REVENUEDOT_DEV_DATABASE_URL;
  const file = join(process.env.HOME ?? "", ".config/revenuedot/dev.env");
  if (!existsSync(file)) return null;
  const m = /REVENUEDOT_DEV_DATABASE_URL=["']?([^"'\n]+)/.exec(readFileSync(file, "utf8"));
  return m?.[1] ?? null;
}

/** A clean database for this run. The URL is never printed. */
async function database(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const admin = devEnvUrl();
  if (!admin) {
    const dir = join(BUILD, "pglite");
    rmSync(dir, { recursive: true, force: true });
    return `pglite://${dir}`;
  }
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  await sql.unsafe("DROP DATABASE IF EXISTS rd_ios_harness WITH (FORCE)");
  await sql.unsafe("CREATE DATABASE rd_ios_harness");
  await sql.end();
  const u = new URL(admin);
  u.pathname = "/rd_ios_harness";
  return u.href;
}

async function startServer(databaseUrl: string): Promise<ChildProcess> {
  // The server logs to a file: xcodebuild blocks this process for minutes, and a full pipe would stall the server.
  mkdirSync(BUILD, { recursive: true });
  const logFile = join(BUILD, "server.log");
  const fd = openSync(logFile, "w");
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(HERE, "harness-server.ts")], {
    cwd: join(ROOT, "apps/server"), env: { ...process.env, PORT: String(PORT), DATABASE_URL: databaseUrl, REVENUEDOT_ALLOW_SIGNUP: "true" }, stdio: ["ignore", fd, fd],
    // Its own process group, so stopping it also stops tsx's node child.
    detached: true,
  });
  const log = () => readFileSync(logFile, "utf8");
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/v1/health`)).ok) return child; } catch { /* not up yet */ }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop(child);
  throw new Error(`The server did not start on ${BASE}:\n${log().replace(/postgres(ql)?:\/\/\S+/g, "postgres://…").slice(-2000)}`);
}

function xcodebuild(testKey: string, shots: string | undefined) {
  if (!existsSync(join(HERE, "RDHarness.xcodeproj"))) {
    const g = spawnSync("xcodegen", ["generate"], { cwd: HERE, stdio: "inherit" });
    if (g.status !== 0) throw new Error("xcodegen generate failed (brew install xcodegen)");
  }
  mkdirSync(BUILD, { recursive: true });
  // A fresh install: the SDK keeps its app user id and caches in the app's container between runs.
  spawnSync("xcrun", ["simctl", "uninstall", DEVICE, "app.revenuedot.harness"], { stdio: "ignore" });
  const result = join(BUILD, `result-${Date.now()}.xcresult`);
  const args = [
    "test", "-project", "RDHarness.xcodeproj", "-scheme", "RDHarness", "-destination", `platform=iOS Simulator,name=${DEVICE}`,
    "-derivedDataPath", join(BUILD, "DerivedData"), "-clonedSourcePackagesDirPath", join(BUILD, "SourcePackages"), "-resultBundlePath", result,
  ];
  const env = {
    ...process.env, TEST_RUNNER_RD_SERVER_URL: BASE, TEST_RUNNER_RD_API_KEY: testKey, TEST_RUNNER_RD_LOGIN_ID: LOGIN_ID,
    ...(shots ? { TEST_RUNNER_RD_SHOT_DIR: shots } : {}),
  };
  // Asynchronous, so this process keeps serving its sockets (a blocked event loop leaves stale keep-alive connections).
  return new Promise<{ ok: boolean; summary: string; result: string }>((resolve) => {
    const x = spawn("xcodebuild", args, { cwd: HERE, env });
    let out = "";
    x.stdout.on("data", (d) => { out += d; });
    x.stderr.on("data", (d) => { out += d; });
    x.on("close", (code) => {
      const summary = out.split("\n").filter((l) => /Test Case|error:|failed|\*\* TEST|XCTAssert/.test(l)).slice(-40).join("\n");
      resolve({ ok: code === 0, summary, result });
    });
  });
}

function stop(child: ChildProcess) {
  try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); }
}

type Check = { name: string; ok: boolean; detail?: unknown };

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
  const sdk = (health.sdk_versions ?? []).filter((v: { platform: string }) => /ios/i.test(v.platform));
  check("the SDK compatibility panel saw the iOS SDK", sdk.length > 0, sdk.map((v: Record<string, unknown>) => `${v.platform} ${v.platform_flavor} ${v.sdk_version} (${v.support})`));
  return checks;
}

let server: ChildProcess | undefined;
try {
  const shots = process.env.SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  // Reuse the Swift package checkout of the examples app when there is one, instead of downloading it again.
  const cache = join(ROOT, "../examples/mobile/ios-swiftui/build/DerivedData/SourcePackages");
  if (!existsSync(join(BUILD, "SourcePackages")) && existsSync(cache)) {
    mkdirSync(BUILD, { recursive: true });
    spawnSync("cp", ["-R", cache, join(BUILD, "SourcePackages")]);
  }
  server = await startServer(await database());
  const cookie = await session(BASE, "ios-harness@revenuedot.test", "ios-harness-password", "iOS harness");
  const me = await (await fetch(`${BASE}/auth/me`, { headers: { cookie } })).json() as { projects: { id: string }[] };
  const projectId = me.projects[0]!.id;
  const seeded = await seedProject(BASE, cookie, projectId, { customers: 2 });
  console.log(`Server ${BASE}, project ${projectId}, Test Store key ${seeded.testKey.slice(0, 9)}…, device ${DEVICE}, login id ${LOGIN_ID}`);

  const t0 = Date.now();
  const x = await xcodebuild(seeded.testKey, shots);
  console.log(x.summary);
  console.log(`xcodebuild test: ${x.ok ? "passed" : "FAILED"} in ${Math.round((Date.now() - t0) / 1000)}s (result bundle ${x.result})`);
  const checks = x.ok ? await serverState(cookie, projectId) : [];
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${JSON.stringify(c.detail)}`);
  const pass = x.ok && checks.every((c) => c.ok);
  console.log(pass ? "iOS simulator run: PASS" : "iOS simulator run: FAIL");
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  if (server) stop(server);
}
