#!/usr/bin/env node
// Smoke test for a RevenueDot Cloud worker (`cf dev` or a deploy).
// Usage:
//   node scripts/smoke-cloud.mjs http://localhost:5173                 full run: signs up, creates data, runs the cron
//   node scripts/smoke-cloud.mjs https://api.revenuedot.app --read-only [--app https://app.revenuedot.app] [--public-key <base64>]
// The full run creates an account, a project, a Test Store app, a product, a secret key and a test purchase, so point
// it only at a development database. --read-only makes no writes: banner, signing key, bad-key 401 and the dashboard.
// --scheduled-worker <name> runs the scheduled handler through `cf dev`'s local explorer (full run on localhost only).
import { webcrypto as crypto } from "node:crypto";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--") && !isFlagValue(a)) ?? "").replace(/\/$/, "");
const readOnly = args.includes("--read-only");
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const appBase = (opt("--app") ?? base).replace(/\/$/, "");
const expectedPublicKey = opt("--public-key");
const scheduledWorker = opt("--scheduled-worker") ?? "revenuedot";
function isFlagValue(a) { const i = args.indexOf(a); return i > 0 && ["--app", "--public-key", "--scheduled-worker"].includes(args[i - 1]); }

if (!/^https?:\/\//.test(base)) {
  console.error("Usage: node scripts/smoke-cloud.mjs <base URL> [--read-only] [--app <dashboard URL>] [--public-key <base64>]");
  process.exit(2);
}
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);

let failures = 0;
const ok = (name, detail = "") => console.log(`PASS ${name}${detail ? ` - ${detail}` : ""}`);
const fail = (name, detail) => { failures++; console.log(`FAIL ${name} - ${detail}`); };
async function check(name, fn) {
  try { const d = await fn(); ok(name, d ?? ""); } catch (e) { fail(name, e instanceof Error ? e.message : String(e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let cookie = "";
async function req(method, path, { json, bearer, headers = {}, url } = {}) {
  const h = { ...headers };
  if (json !== undefined) h["content-type"] = "application/json";
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (cookie && !bearer) h.cookie = cookie;
  const res = await fetch(`${url ?? base}${path}`, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json), redirect: "manual" });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* HTML or empty */ }
  return { status: res.status, headers: res.headers, body, raw: text };
}

const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

/** Verifies an X-Signature header the way the RevenueCat SDKs do (root key → intermediate key → payload). */
async function verifySignature(rootPublicKeyB64, sig, { apiKey, nonce, path, requestTime, etag = "", body }) {
  const s = b64(sig);
  assert(s.length === 180, `X-Signature is ${s.length} bytes, expected 180`);
  const imPub = s.slice(0, 32), expiration = s.slice(32, 36), rootSig = s.slice(36, 100), salt = s.slice(100, 116), payloadSig = s.slice(116, 180);
  const root = await crypto.subtle.importKey("raw", b64(rootPublicKeyB64), { name: "Ed25519" }, false, ["verify"]);
  assert(await crypto.subtle.verify({ name: "Ed25519" }, root, rootSig, concat([expiration, imPub])), "root signature over the intermediate key does not verify");
  const days = new DataView(expiration.buffer, expiration.byteOffset, 4).getUint32(0, true);
  assert(days * 86_400_000 > Date.now(), "intermediate key has expired");
  const im = await crypto.subtle.importKey("raw", imPub, { name: "Ed25519" }, false, ["verify"]);
  const msg = concat([salt, utf8(apiKey), nonce, utf8(path), utf8(""), utf8(""), utf8(requestTime), utf8(etag), utf8(body)]);
  assert(await crypto.subtle.verify({ name: "Ed25519" }, im, payloadSig, msg), "payload signature does not verify");
}

let publicKey = expectedPublicKey;

// "/" is the JSON banner on the API host (api.*); on every other host (app.*, localhost) it is the dashboard.
await check("GET / on the API host returns the JSON banner", async () => {
  const r = await req("GET", "/");
  if (new URL(base).hostname.startsWith("api.")) {
    assert(r.status === 200 && r.body?.name === "RevenueDot", `status ${r.status}, body ${r.raw.slice(0, 120)}`);
    return JSON.stringify(r.body);
  }
  assert(r.status === 200 && /<script type="module"/i.test(r.raw), `expected the dashboard at / on ${base}, got ${r.status}`);
  return "not an api.* host: / is the dashboard";
});

await check("GET /.well-known/revenuedot-signing-key returns the public key", async () => {
  const r = await req("GET", "/.well-known/revenuedot-signing-key");
  assert(r.status === 200 && r.body?.algorithm === "Ed25519" && r.body?.public_key, `status ${r.status}, body ${r.raw.slice(0, 200)}`);
  if (expectedPublicKey) assert(r.body.public_key === expectedPublicKey, `public key ${r.body.public_key} does not match ${expectedPublicKey}`);
  publicKey = r.body.public_key;
  return r.body.public_key;
});

await check("SDK call with a bad key is a 401 JSON with code 7225", async () => {
  const r = await req("GET", "/v1/subscribers/smoke_nobody", { bearer: "appl_not_a_real_key" });
  assert(r.status === 401, `status ${r.status}`);
  assert(r.body?.code === 7225, `body ${r.raw.slice(0, 200)}`);
  return JSON.stringify(r.body);
});

await check("Test Store products (rcbilling) with a bad key is a 401 JSON with code 7225", async () => {
  const r = await req("GET", "/rcbilling/v1/subscribers/smoke_nobody/products", { bearer: "test_not_a_real_key" });
  assert(r.status === 401 && r.body?.code === 7225, `status ${r.status}, body ${r.raw.slice(0, 200)}`);
  return "401";
});

await check("dashboard /login renders the single-page app", async () => {
  const r = await req("GET", "/login", { url: appBase });
  assert(r.status === 200 && /<div id="root"|<script type="module"/i.test(r.raw), `status ${r.status}, body ${r.raw.slice(0, 120)}`);
  return "index.html";
});

await check("dashboard deep link falls back to index.html", async () => {
  const r = await req("GET", "/projects/smoke/customers/deep/link", { url: appBase });
  assert(r.status === 200 && /<script type="module"/i.test(r.raw), `status ${r.status}`);
  return "SPA fallback";
});

await check("dashboard static asset is served", async () => {
  const r = await req("GET", "/favicon.svg", { url: appBase });
  assert(r.status === 200 && /svg/.test(r.headers.get("content-type") ?? ""), `status ${r.status}, type ${r.headers.get("content-type")}`);
  return r.headers.get("content-type");
});

if (!readOnly) {
  const email = `smoke+${Date.now()}@example.com`;
  let projectId, appId, sdkKey, secretKey;
  const userId = `smoke_user_${Date.now()}`;

  await check("POST /auth/signup", async () => {
    const r = await req("POST", "/auth/signup", { json: { email, password: "smoke-test-password-1", project_name: "Smoke" } });
    assert(r.status === 201, `status ${r.status}, body ${r.raw.slice(0, 200)}`);
    const me = await req("GET", "/auth/me");
    assert(me.status === 200, `/auth/me status ${me.status}`);
    assert(me.body.account?.edition === "cloud", `edition ${JSON.stringify(me.body.account)}`);
    projectId = me.body.projects?.[0]?.id;
    assert(projectId, "no project after signup");
    return `${email}, project ${projectId}`;
  });

  await check("create a Test Store app, a product and a secret key", async () => {
    const a = await req("POST", `/v2/projects/${projectId}/apps`, { json: { name: "Smoke Test Store", type: "test_store" } });
    assert(a.status === 201, `app: status ${a.status}, ${a.raw.slice(0, 200)}`);
    appId = a.body.id;
    const k = await req("GET", `/v2/projects/${projectId}/apps/${appId}/public_api_keys`);
    sdkKey = k.body.items?.[0]?.key;
    assert(sdkKey, `no public key: ${k.raw.slice(0, 200)}`);
    const p = await req("POST", `/v2/projects/${projectId}/products`, { json: { store_identifier: "smoke_monthly", app_id: appId, type: "subscription", subscription: { duration: "P1M" } } });
    assert(p.status === 201, `product: status ${p.status}, ${p.raw.slice(0, 200)}`);
    const s = await req("POST", `/v2/projects/${projectId}/api_keys`, { json: { name: "smoke" } });
    assert(s.status === 201 && s.body.key, `secret key: status ${s.status}, ${s.raw.slice(0, 200)}`);
    secretKey = s.body.key;
    return `app ${appId}`;
  });

  await check("POST /v2/projects/{id}/test_purchases with the secret key", async () => {
    const r = await req("POST", `/v2/projects/${projectId}/test_purchases`, { bearer: secretKey, json: { app_user_id: userId, product_id: "smoke_monthly", price: 9.99 } });
    assert(r.status === 201, `status ${r.status}, ${r.raw.slice(0, 300)}`);
    assert(r.body.event_types?.[0] === "INITIAL_PURCHASE", `events ${JSON.stringify(r.body.event_types)}`);
    assert(r.body.subscription?.status === "active", `subscription ${JSON.stringify(r.body.subscription)}`);
    return r.body.store_transaction_id;
  });

  await check("GET /v1/subscribers/{id} shows the purchase, with a valid signature", async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const path = `/v1/subscribers/${userId}`;
    const r = await req("GET", path, { bearer: sdkKey, headers: { "x-nonce": Buffer.from(nonce).toString("base64") } });
    assert(r.status === 200, `status ${r.status}, ${r.raw.slice(0, 200)}`);
    assert(r.body.subscriber?.subscriptions?.smoke_monthly, `no smoke_monthly subscription: ${r.raw.slice(0, 300)}`);
    const sig = r.headers.get("x-signature");
    assert(sig, "no X-Signature header");
    assert(publicKey, "no public key to verify against");
    await verifySignature(publicKey, sig, { apiKey: sdkKey, nonce, path, requestTime: r.headers.get("x-revenuecat-request-time") ?? "", etag: r.headers.get("x-revenuecat-etag") ?? "", body: r.raw });
    return "subscription active, X-Signature verifies";
  });

  await check("GET /rcbilling/v1/subscribers/{id}/products keeps RevenueCat's web billing shape", async () => {
    const r = await req("GET", `/rcbilling/v1/subscribers/${userId}/products?id=smoke_monthly`, { bearer: sdkKey });
    assert(r.status === 200, `status ${r.status}, ${r.raw.slice(0, 200)}`);
    const p = r.body.product_details?.[0];
    assert(p, `no product_details: ${r.raw.slice(0, 200)}`);
    const keys = ["current_price", "default_purchase_option_id", "default_subscription_option_id", "description", "identifier", "normal_period_duration", "product_type", "purchase_options", "subscription_options", "title"];
    assert(JSON.stringify(Object.keys(p).sort()) === JSON.stringify(keys), `keys ${Object.keys(p).sort()}`);
    const price = p.current_price;
    assert(typeof price.amount === "number" && Number.isInteger(price.amount_micros) && typeof price.currency === "string", `price ${JSON.stringify(price)}`);
    const base = p.purchase_options?.base?.base;
    assert(base && Number.isInteger(base.cycle_count) && base.period_duration === "P1M", `base option ${JSON.stringify(p.purchase_options)}`);
    return `${p.identifier} ${p.product_type} ${price.currency} ${price.amount}`;
  });

  if (isLocal) {
    await check("scheduled handler runs", async () => {
      const u = new URL("/cdn-cgi/local/explorer/api/local/scheduled", base);
      u.searchParams.set("worker", scheduledWorker);
      const res = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cron: "* * * * *" }) });
      const text = await res.text();
      assert(res.ok, `status ${res.status}, ${text.slice(0, 300)}`);
      return text.slice(0, 200);
    });
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
