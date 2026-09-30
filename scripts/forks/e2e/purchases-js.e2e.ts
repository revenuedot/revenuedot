/**
 * End-to-end check of the forked web SDK (purchases-js on revenuedot/main-patches) against the real RevenueDot server.
 *
 *   # build the fork once (or point PURCHASES_JS_DIR at the check worktree, which is built by check.ts)
 *   (cd ../purchases-js && git checkout revenuedot/main-patches && pnpm install && pnpm vite build)
 *   pnpm tsx scripts/forks/e2e/purchases-js.e2e.ts
 *
 * It starts `@revenuedot/server` as its own process on a free port with an in-memory database (PGlite) and a
 * response-signing key, creates a project, a Test Store app, a product, an entitlement and an offering through the
 * REST API, then drives the built SDK bundle in jsdom:
 *   configure (proxyURL → local server) → getCustomerInfo → getOfferings → purchase (Test Store modal, "valid purchase")
 *   → entitlement active → getCustomerInfo again, and checks the server state and a signed response.
 * Env: PURCHASES_JS_DIR (default ../purchases-js), REVENUEDOT_SIGNING_KEY (default: a fresh key).
 */
import { spawn } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify as edVerify, randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { client, session } from "../../../apps/dashboard/e2e/seed.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAGSHIP = resolve(HERE, "../../..");
const JS_DIR = resolve(process.env.PURCHASES_JS_DIR ?? join(FLAGSHIP, "..", "purchases-js"));
const BUNDLE = join(JS_DIR, "dist", "Purchases.es.js");
const BAKED_KEY = JSON.parse(readFileSync(join(HERE, "..", "config.json"), "utf8")).vars.signingPublicKey as string;

let failures = 0;
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "  PASS" : "  FAIL"} ${what}`); if (!cond) failures++; };

const freePort = () => new Promise<number>((res) => { const s = createServer(); s.listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

function seedFromEnvOrFresh(): { seed: string; publicKey: string; source: string } {
  const env = process.env.REVENUEDOT_SIGNING_KEY;
  const toPub = (seed: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" }).export({ format: "der", type: "spki" }).subarray(12).toString("base64");
  if (env) return { seed: env, publicKey: toPub(Buffer.from(env, "base64")), source: "REVENUEDOT_SIGNING_KEY" };
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(16);
  return { seed: seed.toString("base64"), publicKey: toPub(seed), source: "fresh key" };
}

/** Independent check of an X-Signature header (same layout the iOS and Android SDKs verify). */
function verifySignature(sigB64: string, rootPubB64: string, parts: { apiKey: string; nonce: Buffer; path: string; requestTime: string; body: Buffer }): string {
  const sig = Buffer.from(sigB64, "base64");
  if (sig.length !== 180) return `bad length ${sig.length}`;
  const key = (raw: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const inter = sig.subarray(0, 32), exp = sig.subarray(32, 36), rootSig = sig.subarray(36, 100), salt = sig.subarray(100, 116), payloadSig = sig.subarray(116, 180);
  if (!edVerify(null, Buffer.concat([exp, inter]), key(Buffer.from(rootPubB64, "base64")), rootSig)) return "intermediate key not signed by the root key";
  if (exp.readUInt32LE(0) * 86400_000 < Date.now()) return "intermediate key expired";
  const msg = Buffer.concat([salt, Buffer.from(parts.apiKey), parts.nonce, Buffer.from(parts.path), Buffer.from(parts.requestTime), parts.body]);
  return edVerify(null, msg, key(inter), payloadSig) ? "verified" : "payload signature mismatch";
}

async function main() {
  if (!existsSync(BUNDLE)) { console.error(`No build at ${BUNDLE}. Build the fork first: cd ${JS_DIR} && pnpm install && pnpm vite build`); process.exit(2); }
  const bundle = readFileSync(BUNDLE, "utf8");
  console.log(`purchases-js bundle: ${BUNDLE}`);
  ok(bundle.includes("https://api.revenuedot.app") && !bundle.includes("api.revenuecat.com") && !bundle.includes("e.revenue.cat"), "bundle defaults to https://api.revenuedot.app and contains no RevenueCat API or events host");
  ok(bundle.includes("Secure checkout by RevenueDot") || !bundle.includes("Secure checkout by RevenueCat"), "checkout title no longer says RevenueCat");

  // 1. The real server, as its own process.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const signing = seedFromEnvOrFresh();
  const server = spawn("pnpm", ["--filter", "@revenuedot/server", "start"], { cwd: FLAGSHIP, env: { ...process.env, PORT: String(port), DATABASE_URL: "pglite://memory", REVENUEDOT_SIGNING_KEY: signing.seed, DASHBOARD_DIST: "/nonexistent" }, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d; }); server.stderr.on("data", (d) => { serverLog += d; });
  const stop = () => { try { server.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", stop);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/v1/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  ok((await fetch(`${base}/v1/health`).catch(() => null))?.ok, `server up on ${base} (pnpm --filter @revenuedot/server start, in-memory PGlite)`);

  // 2. Project, Test Store app, product, entitlement, offering through the API.
  const cookie = await session(base, `forks-e2e-${Date.now()}@revenuedot.test`, "e2e-password-1", "Fork E2E");
  const me = await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json() as { projects: { id: string }[] };
  const call = client(base, cookie);
  const P = `/v2/projects/${me.projects[0]!.id}`;
  const app = await call("POST", `${P}/apps`, { name: "Web (Test Store)", type: "test_store" });
  const testKey = (await call<{ items: { key: string }[] }>("GET", `${P}/apps/${app.id}/public_api_keys`)).items[0]!.key;
  const product = await call("POST", `${P}/products`, { store_identifier: "pro_monthly", app_id: app.id, type: "subscription", display_name: "Pro monthly", subscription: { duration: "P1M" } });
  const ent = await call("POST", `${P}/entitlements`, { lookup_key: "pro", display_name: "Pro access" });
  await call("POST", `${P}/entitlements/${ent.id}/actions/attach_products`, { product_ids: [product.id] });
  const off = await call("POST", `${P}/offerings`, { lookup_key: "default", display_name: "Standard" });
  await call("POST", `${P}/offerings/${off.id}`, { is_current: true });
  const pkg = await call("POST", `${P}/offerings/${off.id}/packages`, { lookup_key: "$rc_monthly", display_name: "Monthly", position: 0 });
  await call("POST", `${P}/packages/${pkg.id}/actions/attach_products`, { products: [{ product_id: product.id, eligibility_criteria: "all" }] });
  ok(testKey.startsWith("test_"), `Test Store app key issued with the test_ prefix purchases-js requires (${testKey.slice(0, 9)}…)`);

  // 3. The forked SDK in jsdom.
  const req = createRequire(join(JS_DIR, "package.json"));
  const { JSDOM } = req("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://shop.example.com/", pretendToBeVisual: true });
  const g = globalThis as any;
  // Expose the jsdom window as the global scope (DOM classes such as HTMLMediaElement are used by the Svelte UI).
  for (const k of Object.getOwnPropertyNames(dom.window)) {
    if (k in g && !["window", "document", "navigator", "location", "localStorage", "sessionStorage"].includes(k)) continue;
    try { const v = dom.window[k]; Object.defineProperty(g, k, { value: typeof v === "function" && !/^[A-Z]/.test(k) ? v.bind(dom.window) : v, configurable: true, writable: true }); } catch { /* read-only in jsdom */ }
  }
  if (!g.matchMedia) g.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  dom.window.matchMedia = g.matchMedia;

  // A recording pass-through in front of the server, so we can see every call the SDK makes (and where events go).
  const seen: string[] = [];
  const proxy = createHttpServer(async (rq, rs) => {
    const chunks: Buffer[] = []; for await (const c of rq) chunks.push(c as Buffer);
    seen.push(`${rq.method} ${rq.url}`);
    const headers = Object.fromEntries(Object.entries(rq.headers).filter(([k]) => k !== "host" && k !== "content-length")) as Record<string, string>;
    const up = await fetch(base + rq.url, { method: rq.method, headers, body: ["GET", "HEAD", "OPTIONS"].includes(rq.method!) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await up.arrayBuffer());
    rs.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !["content-encoding", "content-length", "transfer-encoding"].includes(k))));
    rs.end(out);
  });
  const proxyPort = await freePort();
  await new Promise<void>((r) => proxy.listen(proxyPort, "127.0.0.1", () => r()));
  const proxyURL = `http://127.0.0.1:${proxyPort}`;

  const { Purchases } = await import(pathToFileURL(BUNDLE).href);
  const userId = "fork_e2e_user_1";
  const purchases = Purchases.configure({ apiKey: testKey, appUserId: userId, httpConfig: { proxyURL } });

  const info0 = await purchases.getCustomerInfo();
  ok(info0 && Object.keys(info0.entitlements.active).length === 0, "getCustomerInfo via the proxy URL: new customer, no active entitlements");

  const offerings = await purchases.getOfferings();
  const current = offerings.current;
  ok(current?.identifier === "default" && current.availablePackages.length === 1 && current.availablePackages[0].rcBillingProduct?.identifier === "pro_monthly", `getOfferings: current offering "default" with package ${current?.availablePackages?.[0]?.identifier} → ${current?.availablePackages?.[0]?.rcBillingProduct?.identifier}`);

  const purchase = purchases.purchase({ rcPackage: current.availablePackages[0] });
  let button: any = null;
  for (let i = 0; i < 100 && !button; i++) { await new Promise((r) => setTimeout(r, 50)); button = document.querySelector(".rc-simulated-store-modal-button-primary"); }
  ok(!!button, "purchase(): the Test Store modal opened in the page");
  button?.click();
  const result = await purchase;
  ok(result.customerInfo.entitlements.active.pro?.isActive === true, `purchase(): entitlement "pro" active in the returned customer info (product ${result.customerInfo.entitlements.active.pro?.productIdentifier})`);

  const info1 = await purchases.getCustomerInfo();
  ok(info1.entitlements.active.pro?.isActive === true && info1.activeSubscriptions.has("pro_monthly"), "getCustomerInfo after purchase: \"pro\" active, pro_monthly in active subscriptions");

  // 4. Server-side state through the REST API.
  const customer = await call("GET", `${P}/customers/${encodeURIComponent(userId)}`);
  const active = await call<{ items: any[] }>("GET", `${P}/customers/${encodeURIComponent(userId)}/active_entitlements`).catch(() => ({ items: [] }));
  ok(customer.id === userId && (active.items.length === 1 || active.items.some?.((e: any) => e.entitlement_id === ent.id)), `server: customer ${customer.id} exists with ${active.items.length} active entitlement(s)`);

  // 5. Trusted Entitlements: the running server signs SDK responses; the key it publishes verifies them.
  const wk = await (await fetch(`${base}/.well-known/revenuedot-signing-key`)).json() as { public_key: string };
  ok(wk.public_key === signing.publicKey, `/.well-known/revenuedot-signing-key serves the signing public key (${signing.source})`);
  if (signing.source === "REVENUEDOT_SIGNING_KEY") ok(wk.public_key === BAKED_KEY, "that key is the one baked into the forks (config.json signingPublicKey)");
  const nonce = randomBytes(12);
  const path = `/v1/subscribers/${encodeURIComponent(userId)}`;
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${testKey}`, "x-nonce": nonce.toString("base64"), "x-platform": "web" } });
  const body = Buffer.from(await res.arrayBuffer());
  const verdict = verifySignature(res.headers.get("x-signature") ?? "", wk.public_key, { apiKey: testKey, nonce, path, requestTime: res.headers.get("x-revenuecat-request-time") ?? "", body });
  ok(verdict === "verified", `GET ${path} with X-Nonce: X-Signature ${verdict}`);

  // 6. Everything went through the proxy URL, including analytics events (fork patch; upstream sends them to e.revenue.cat).
  try { await purchases.close?.(); } catch { /* close flushes events in recent versions */ }
  for (let i = 0; i < 60 && !seen.some((s) => s.startsWith("POST /v1/events")); i++) await new Promise((r) => setTimeout(r, 250));
  console.log(`  SDK calls seen at the proxy URL: ${[...new Set(seen.map((s) => s.replace(/subscribers\/[^/?]+/, "subscribers/{id}").replace(/\?.*$/, "")))].join(", ")}`);
  ok(seen.some((s) => s.startsWith("POST /v1/receipts")), "the purchase posted the Test Store receipt to POST /v1/receipts on the proxy URL");
  ok(seen.some((s) => s.startsWith("POST /v1/events")), "analytics events went to POST /v1/events on the proxy URL, not to RevenueCat");
  proxy.close();
  stop();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  if (failures) console.log(serverLog.split("\n").slice(-30).join("\n"));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
