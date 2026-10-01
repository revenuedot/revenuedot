// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the iOS simulator contract run (SCOPE 1.0 and 1.1). Starts a RevenueDot server, seeds a Test Store catalog,
// runs the XCUITest that drives the unmodified RevenueCat iOS SDK (configure, getCustomerInfo, getOfferings, attribution
// and attributes, a Test Store purchase, logIn, syncPurchases, virtual currencies, web purchase redemption, reward
// verification, the Customer Center fetch) on a booted simulator, then checks the server's request log and what it stored.
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
import { attributeChecks, readLog, requestChecks, type Expectation } from "../sdk-calls.ts";
import { ADDABLE_TYPES, applyOp, blankPaywall, locate, newComponent } from "../../../packages/core/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const BUILD = join(HERE, "build");
const PORT = Number(process.env.HARNESS_PORT ?? 8871);
const BASE = `http://localhost:${PORT}`;
const DEVICE = process.env.IOS_DEVICE ?? "iPhone 17 Pro";
const LOGIN_ID = `ios_harness_${Date.now()}`;
const REQUEST_LOG = join(BUILD, "requests.jsonl");
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
  rmSync(REQUEST_LOG, { force: true });
  const logFile = join(BUILD, "server.log");
  const fd = openSync(logFile, "w");
  const child = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(HERE, "harness-server.ts")], {
    cwd: join(ROOT, "apps/server"), env: { ...process.env, PORT: String(PORT), DATABASE_URL: databaseUrl, REVENUEDOT_ALLOW_SIGNUP: "true", REVENUEDOT_REQUEST_LOG: REQUEST_LOG }, stdio: ["ignore", fd, fd],
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
  // simctl cannot uninstall from a shut-down device (it fails silently), so boot it first; "already booted" is fine.
  spawnSync("xcrun", ["simctl", "boot", DEVICE], { stdio: "ignore" });
  spawnSync("xcrun", ["simctl", "bootstatus", DEVICE, "-b"], { stdio: "ignore" });
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
let testStarted = 0;

/** The calls the harness makes beyond configure, with what the inventory in prd/sdk-api/PRD.md documents for each. */
const EXPECTED: Expectation[] = [
  { method: "POST", template: "/v1/subscribers/{app_user_id}/attribution", count: 1, statuses: [200], why: "addAttributionData, Apple Search Ads" },
  // enableAdServicesAttributionTokenCollection() runs, but the SDK sends no token from a simulator (it logs "AdServices
  // attribution token is not available in the simulator"). The lookup is covered by packages/contract/test/sdk-endpoints.test.ts.
  { method: "POST", template: "/v1/subscribers/{app_user_id}/adservices_attribution", count: 0, statuses: [200], why: "no AdServices token in the simulator" },
  { method: "POST", template: "/v1/subscribers/{app_user_id}/attributes", min: 1, statuses: [200], why: "attribute sync" },
  // syncPurchases in Test Store mode has no store receipt to send, so the purchase is the only receipt post.
  { method: "POST", template: "/v1/receipts", count: 1, statuses: [200], why: "the Test Store purchase" },
  { method: "GET", template: "/v1/subscribers/{app_user_id}/virtual_currencies", count: 1, statuses: [200], why: "virtualCurrencies()" },
  { method: "POST", template: "/v1/subscribers/redeem_purchase", count: 1, statuses: [400], why: "redeemWebPurchase, 7849 invalidToken" },
  { method: "GET", template: "/v1/subscribers/{app_user_id}/ads/reward_verifications/{client_transaction_id}", count: 10, statuses: [200], why: "pollRewardVerification polls 10 times: the answer stays pending because no ad network calls back in the harness (prd/ads/PRD.md)" },
  { method: "GET", template: "/v1/customercenter/{app_user_id}", count: 1, statuses: [200], why: "Customer Center configuration (default)" },
  { method: "POST", template: "/v1/config/app", min: 1, statuses: [200, 204], why: "remote config: RC Container with the published paywall as a workflow, 204 when unchanged" },
  { method: "GET", template: "/v1/subscribers/{app_user_id}/health_report_availability", min: 1, statuses: [200], why: "debug build health report switch" },
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
  const sdk = (health.sdk_versions ?? []).filter((v: { platform: string }) => /ios/i.test(v.platform));
  check("the SDK compatibility panel saw the iOS SDK", sdk.length > 0, sdk.map((v: Record<string, unknown>) => `${v.platform} ${v.platform_flavor} ${v.sdk_version} (${v.support})`));

  // Attributes and attribution, as the dashboard's customer page reads them (v2 customer attributes).
  const attrs = Object.fromEntries((await call("GET", `${P}/customers/${LOGIN_ID}/attributes?limit=100`)).items.map((a: { name: string; value: string | null }) => [a.name, a.value]));
  const want = {
    $email: "harness@revenuedot.test", $displayName: "RD Harness", harness_run: "ios", $adjustId: "adjust-harness-1",
    $idfv: /^[0-9A-F-]{36}$/, $ip: /^(\d{1,3}\.){3}\d{1,3}$|:/, $deviceVersion: /iOS/,
    // Apple Search Ads from the deprecated addAttributionData call.
    $mediaSource: "Apple Search Ads", $campaign: "Harness Spring", $adGroup: "Harness Group", $keyword: "harness",
  };
  checks.push(...attributeChecks(attrs, want, "customer attributes"));
  // The purchase came after attribution, so its webhook payload carries it.
  const purchase = (await call("GET", `${P}/customers/${LOGIN_ID}/events?limit=50`)).items.find((e: { type: string }) => e.type === "INITIAL_PURCHASE");
  const sa = Object.fromEntries(Object.entries((purchase?.body?.subscriber_attributes ?? {}) as Record<string, { value: string | null }>).map(([k, v]) => [k, v.value]));
  checks.push(...attributeChecks(sa, { $mediaSource: "Apple Search Ads", $email: "harness@revenuedot.test", $campaign: "Harness Spring" }, "INITIAL_PURCHASE webhook subscriber_attributes"));
  // Only what the device sent while the UI test ran (seeding posts receipts through the same server).
  checks.push(...requestChecks(readLog(REQUEST_LOG).filter((r) => r.at >= testStarted), EXPECTED));
  return checks;
}

/**
 * Two published paywalls for RevenueCatUI to render: the gallery template "Annual first" on the current offering (made by
 * the server from `template_id`), and on a second offering "editor" a paywall built with the dashboard editor's own
 * operations (packages/core/src/paywalls/editor.ts): a timeline, tabs, a carousel, a countdown, an icon and an image.
 */
async function publishPaywalls(cookie: string, projectId: string) {
  const P = `${BASE}/v2/projects/${projectId}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(P + path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.json() as Promise<any>;
  };
  const offerings = await req("GET", "/offerings?expand=items.package.product");
  const current = offerings.items.find((o: any) => o.is_current);
  const pw = await req("POST", "/paywalls", { offering_id: current.id, template_id: "annual_two_plan", template_options: { app_name: "Harness", terms_url: "https://revenuedot.app/legal/terms", privacy_url: "https://revenuedot.app/legal/privacy" } });
  await req("POST", `/paywalls/${pw.id}/actions/publish`);

  // The "editor" offering reuses the current offering's monthly and annual products.
  const editor = await req("POST", "/offerings", { lookup_key: "editor", display_name: "Editor" });
  for (const p of current.packages.items.filter((x: any) => ["$rc_monthly", "$rc_annual"].includes(x.lookup_key))) {
    const pk = await req("POST", `/offerings/${editor.id}/packages`, { lookup_key: p.lookup_key, display_name: p.display_name });
    await req("POST", `/packages/${pk.id}/actions/attach_products`, { products: p.products.items.map((x: any) => ({ product_id: x.product.id, eligibility_criteria: "all" })) });
  }
  const icons = (await req("GET", "/paywall_templates")).icon_base_url as string;
  let doc = blankPaywall({ iconBaseUrl: icons, packages: [{ id: "$rc_annual" }, { id: "$rc_monthly" }] });
  // The headline, as the editor's properties panel sets it.
  const title = doc.components_config.base.stack.components.find((c: any) => c.type === "text");
  doc.components_localizations.en_US![title.text_lid] = "Built in the editor";
  for (const t of ADDABLE_TYPES) {
    if (["sticky_footer", "video", "web_view", "package", "purchase_button"].includes(t)) continue;
    const c = newComponent(t, { doc, iconBaseUrl: icons, packages: ["$rc_annual", "$rc_monthly"] });
    doc = applyOp(doc, { kind: "insert", component: c, targetId: title.id, position: "after" })!.doc;
  }
  if (!locate(doc, title.id)) throw new Error("editor paywall lost its headline");
  const ed = await req("POST", "/paywalls", { offering_id: editor.id, name: "Editor", ...doc });
  await req("POST", `/paywalls/${ed.id}/actions/publish`);
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
  await publishPaywalls(cookie, projectId);
  console.log(`Server ${BASE}, project ${projectId}, Test Store key ${seeded.testKey.slice(0, 9)}…, device ${DEVICE}, login id ${LOGIN_ID}`);

  const t0 = Date.now();
  testStarted = t0;
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
