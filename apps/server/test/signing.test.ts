import { afterEach, describe, expect, it } from "vitest";
import { createHash, createPublicKey, randomBytes, verify as edVerify } from "node:crypto";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { generateSigningKeyPair, publicKeyFromSeed, ResponseSigner } from "../src/services/signing.js";

/**
 * Contract tests for response signing ("Trusted Entitlements" in the RevenueCat SDKs).
 * The verifier below is written from the SDK sources, independently of services/signing.ts:
 * purchases-ios Sources/Security/Signing.swift and purchases-android .../common/verification/SigningManager.kt (MIT).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Independent verifier (node:crypto, not WebCrypto), mirroring Signing.verificationResult on iOS.

type Reason = "missing_signature" | "invalid_signature_format" | "invalid_intermediate_key_signature" | "intermediate_key_expired" | "invalid_intermediate_key" | "payload_signature_mismatch" | "unknown";
type Result = { ok: true } | { ok: false; reason: Reason };

interface VerifyInput {
  signature: string | null;
  rootPublicKey: string;
  now: Date;
  /** Empty for unauthenticated paths such as /v1/health. */
  apiKey: string;
  /** base64 X-Nonce as sent, or undefined. */
  nonce?: string;
  path: string;
  postParamsHash?: string;
  headersHash?: string;
  requestTime: string;
  etag?: string;
  body?: Uint8Array;
}

const edKey = (raw: Buffer) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });

function verifySignature(v: VerifyInput): Result {
  if (!v.signature) return { ok: false, reason: "missing_signature" };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v.signature)) return { ok: false, reason: "invalid_signature_format" };
  const sig = Buffer.from(v.signature, "base64");
  if (sig.length !== 180) return { ok: false, reason: "invalid_signature_format" };
  const intermediatePublicKey = sig.subarray(0, 32);
  const expiration = sig.subarray(32, 36);
  const intermediateKeySignature = sig.subarray(36, 100);
  const salt = sig.subarray(100, 116);
  const payload = sig.subarray(116, 180);

  if (!edVerify(null, Buffer.concat([expiration, intermediatePublicKey]), edKey(Buffer.from(v.rootPublicKey, "base64")), intermediateKeySignature)) {
    return { ok: false, reason: "invalid_intermediate_key_signature" };
  }
  const days = expiration.readUInt32LE(0);
  if (days === 0) return { ok: false, reason: "unknown" };
  if (days * 86_400_000 - v.now.getTime() < 0) return { ok: false, reason: "intermediate_key_expired" };
  let intermediate;
  try { intermediate = edKey(Buffer.from(intermediatePublicKey)); } catch { return { ok: false, reason: "invalid_intermediate_key" }; }

  const message = Buffer.concat([
    salt,
    Buffer.from(v.apiKey, "utf8"),
    v.nonce ? Buffer.from(v.nonce, "base64") : Buffer.alloc(0),
    Buffer.from(v.path, "utf8"),
    Buffer.from(v.postParamsHash ?? "", "utf8"),
    Buffer.from(v.headersHash ?? "", "utf8"),
    Buffer.from(v.requestTime, "utf8"),
    Buffer.from(v.etag ?? "", "utf8"),
    Buffer.from(v.body ?? new Uint8Array()),
  ]);
  return edVerify(null, message, intermediate, payload) ? { ok: true } : { ok: false, reason: "payload_signature_mismatch" };
}

/** HTTPRequest.signingParameterHash: sha256 over values joined by a 0x00 byte, as lowercase hex. */
const paramHash = (values: string[]) => {
  const h = createHash("sha256");
  values.forEach((value, i) => { if (i > 0) h.update(Buffer.from([0])); h.update(value, "utf8"); });
  return h.digest("hex");
};
const postParamsHeader = (fields: [string, string][]) => `${fields.map(([k]) => k).join(",")}:sha256:${paramHash(fields.map(([, v]) => v))}`;
const headersHashHeader = (fields: [string, string][]) => `${fields.map(([k]) => k).join(",")}:sha256:${paramHash(fields.map(([, v]) => v))}`;

// ---------------------------------------------------------------------------------------------------------------------
// 1. The verifier accepts RevenueCat's real production signatures.
// Vectors from purchases-ios Tests/UnitTests/Security/SigningTests.swift ("testVerifyKnownSignature*"), MIT License,
// Copyright RevenueCat Inc. The test's Signing instance uses apiKey "appl_fFVBVAoYujMZJnepIziGKVjnZBz" and a clock at
// mockDate = 1688769125 s; /v1/health is unauthenticated there, so its API key part is empty.

const RC_ROOT = "UC1upXWg5QVmyOSwozp755xLqquBKjjU+di6U8QhMlM=";
const RC_KEY = "appl_fFVBVAoYujMZJnepIziGKVjnZBz";
const RC_NOW = new Date(1688769125 * 1000);
const RC_NONCE = "MTIzNDU2Nzg5MGFi";
const utf8 = (s: string) => new TextEncoder().encode(s);

const rcVectors: { name: string; input: Omit<VerifyInput, "rootPublicKey" | "now"> }[] = [
  {
    name: "customer info with nonce and ETag",
    input: {
      signature: "XX8Mh8DTcqPC5A48nncRU3hDkL/v3baxxqLIWnWJzg1tTAAA7ok0iXupT2bjju/BSHVmgxc0XiwTZXBmsGuWEXa9lsyoFi9HMF4aAIOs4Y+lYE2i4USJCP7ev07QZk7D2b6ZBU2RTz0mVMohVliMOU7TKpW6/g3g1TUCJaTVYGBI0TZU1LSvtbrnTV9WZLOFva5A0w/PaaEi5Kd7F3Pc3Ytd/JWU2W+GzCbr7fcEYaHCMz0A",
      apiKey: RC_KEY, nonce: RC_NONCE, path: "/v1/subscribers/login", requestTime: "1688165932214", etag: "bc03094946db5488",
      body: utf8('{"request_date":"2023-06-30T22:58:52Z","request_date_ms":1688165932212,"subscriber":{"entitlements":{},"first_seen":"2023-06-30T22:04:54Z","last_seen":"2023-06-30T22:04:54Z","management_url":null,"non_subscriptions":{},"original_app_user_id":"login","original_application_version":null,"original_purchase_date":null,"other_purchases":{},"subscriptions":{}}}\n'),
    },
  },
  {
    name: "offerings without nonce or ETag",
    input: {
      signature: "XX8Mh8DTcqPC5A48nncRU3hDkL/v3baxxqLIWnWJzg1tTAAA7ok0iXupT2bjju/BSHVmgxc0XiwTZXBmsGuWEXa9lsyoFi9HMF4aAIOs4Y+lYE2i4USJCP7ev07QZk7D2b6ZBbkS7vAEXt1c/Afax+p77HE+FOdasE/exztEfLohmttwAC86LxciXvuRB6GRlwdlqOG4hRBBkHju1/bwy+mOxXC7Hh6X6YGbypREKGdlX3kB",
      apiKey: RC_KEY, path: "/v1/subscribers/test/offerings", requestTime: "1688165984163",
      body: utf8('{"current_offering_id":"default","offerings":[{"description":"Default","identifier":"default","metadata":null,"packages":[{"identifier":"$rc_monthly","platform_product_identifier":"ns_599_1m_1w0"},{"identifier":"$rc_annual","platform_product_identifier":"ns_3999_1y_1w0"}]}]}\n'),
    },
  },
  {
    name: "health without an API key",
    input: {
      signature: "XX8Mh8DTcqPC5A48nncRU3hDkL/v3baxxqLIWnWJzg1tTAAA7ok0iXupT2bjju/BSHVmgxc0XiwTZXBmsGuWEXa9lsyoFi9HMF4aAIOs4Y+lYE2i4USJCP7ev07QZk7D2b6ZBWLvZSDGa3uPdgoLSNasWaBgg8uJkzajyVv3psjMJqSQZ753hXgTvALa18ugG2LULJmYWc+FWHn4y93OrHjzSHB2jXGCF+EKvxGcUYPXM8gM",
      apiKey: "", nonce: RC_NONCE, path: "/v1/health", requestTime: "1688701887822", body: utf8('""\n'),
    },
  },
  {
    name: "304 Not Modified (empty body, ETag only)",
    input: {
      signature: "XX8Mh8DTcqPC5A48nncRU3hDkL/v3baxxqLIWnWJzg1tTAAA7ok0iXupT2bjju/BSHVmgxc0XiwTZXBmsGuWEXa9lsyoFi9HMF4aAIOs4Y+lYE2i4USJCP7ev07QZk7D2b6ZBXDYl4jSnJUxrC4e1pg/WVvPvwyGJjUSnnt5m1xi2QiNU5RjnLy3ursE/t9gO/a61He1kYPgC3XznHPPypn4Zn4CcCyOnPmKtwQB0eCHlOUI",
      apiKey: RC_KEY, nonce: RC_NONCE, path: "/v1/subscribers/login", requestTime: "1688165833071", etag: "bc03094946db5488",
    },
  },
  {
    // iOS escapes app user IDs with .urlHostAllowed: "$" stays, ":" becomes %3A. The signed path is the raw one.
    name: "anonymous user ($RCAnonymousID%3A... path)",
    input: {
      signature: "XX8Mh8DTcqPC5A48nncRU3hDkL/v3baxxqLIWnWJzg1tTAAA7ok0iXupT2bjju/BSHVmgxc0XiwTZXBmsGuWEXa9lsyoFi9HMF4aAIOs4Y+lYE2i4USJCP7ev07QZk7D2b6ZBSrxh7Tsw8z/B0jfCUIVOlzAJqMSoDWL3zy1etinl/pU/xzwZ9HdZWwyAgn38I9rv/JM0FSCcYMC2C8KE06wFyQTz+7c9btj/v2ueXRgAJYB",
      apiKey: RC_KEY, nonce: RC_NONCE, path: "/v1/subscribers/$RCAnonymousID%3A1af512a3b9c848899fe427f39dd69f2b", requestTime: "1688671515638", etag: "a896a69e4b31304d",
      body: utf8('{"request_date":"2023-07-06T19:25:15Z","request_date_ms":1688671515638,"subscriber":{"entitlements":{},"first_seen":"2023-06-30T23:06:23Z","last_seen":"2023-06-30T23:06:23Z","management_url":null,"non_subscriptions":{},"original_app_user_id":"$RCAnonymousID:1af512a3b9c848899fe427f39dd69f2b","original_application_version":null,"original_purchase_date":null,"other_purchases":{},"subscriptions":{}}}\n'),
    },
  },
  {
    name: "POST identify with X-Post-Params-Hash",
    input: {
      signature: "XX8Mh8DTcqPC5A48nncRU3hDkL/v3baxxqLIWnWJzg1tTAAA7ok0iXupT2bjju/BSHVmgxc0XiwTZXBmsGuWEXa9lsyoFi9HMF4aAIOs4Y+lYE2i4USJCP7ev07QZk7D2b6ZBYArl3A6DzmFY4Yh9CLUnG6RHMuVDFHmhOd4I6L10UiJUyO/vH9prON6j9E0bOyPdq5Cv+5/cQg2f2dA4NKPCFcZ9Ursc6O9c/HQ+qoVfX8H",
      apiKey: RC_KEY, nonce: RC_NONCE, path: "/v1/subscribers/identify", requestTime: "1688759279805",
      postParamsHash: postParamsHeader([["app_user_id", "$RCAnonymousID:6b2787de2fb848a8b403a45f695ee74f"], ["new_app_user_id", "F72BF276-CD70-4C27-BCD2-FC1EFD988FA3"]]),
      body: utf8('{"request_date":"2023-07-07T19:47:59Z","request_date_ms":1688759279804,"subscriber":{"entitlements":{},"first_seen":"2023-07-06T19:51:18Z","last_seen":"2023-07-06T19:51:18Z","management_url":null,"non_subscriptions":{},"original_app_user_id":"F72BF276-CD70-4C27-BCD2-FC1EFD988FA3","original_application_version":null,"original_purchase_date":null,"other_purchases":{},"subscriptions":{}}}\n'),
    },
  },
  {
    name: "GET with X-Headers-Hash (X-Is-Sandbox)",
    input: {
      signature: "x2qnlHOl5WuzGi4TbSUVHxzlKELRCfrRYG9XAiso7ucZTQAAYEZqbguA3X0YfCJqCKh2hnTLSdEr4R+t23xBlTxceWZu2TJjK3461UJKpUnrwXDv+tYo2K54IoS3/tsEr3VmB5ppKAq0P2CR7SwbsDPpxUlHBcl5/4XJvb/DHOnTKjIVd4WJ+57LLWvIV9sDHnj9XxiBez+p5cEjez1RtUis0XdCfAFXU8XfAq6ggiEJKX4F",
      apiKey: RC_KEY, nonce: RC_NONCE, path: "/v1/subscribers/$RCAnonymousID%3A6ca4535c42714f88abc99c563703f113", requestTime: "1702063024732", etag: "5f74102dd8cbfc5e",
      headersHash: headersHashHeader([["X-Is-Sandbox", "true"]]),
      body: utf8('{"request_date":"2023-12-08T19:17:04Z","request_date_ms":1702063024731,"subscriber":{"entitlements":{},"first_seen":"2023-12-08T19:13:02Z","last_seen":"2023-12-08T19:13:02Z","management_url":null,"non_subscriptions":{},"original_app_user_id":"$RCAnonymousID:6ca4535c42714f88abc99c563703f113","original_application_version":null,"original_purchase_date":null,"other_purchases":{},"subscriptions":{}}}\n'),
    },
  },
  {
    name: "POST with both X-Post-Params-Hash and X-Headers-Hash",
    input: {
      signature: "x2qnlHOl5WuzGi4TbSUVHxzlKELRCfrRYG9XAiso7ucZTQAAYEZqbguA3X0YfCJqCKh2hnTLSdEr4R+t23xBlTxceWZu2TJjK3461UJKpUnrwXDv+tYo2K54IoS3/tsEr3VmB+i9GyA6+bZcCIQxv54gcEO0K/tx7ai2lgy2faTaWCfgm5K4KTVDA952V45fI6g5oalGXyiUVh4xUgNMECnyI5REy0xZK62ekFRsksayX30O",
      apiKey: RC_KEY, nonce: RC_NONCE, path: "/v1/subscribers/identify", requestTime: "1702063090637",
      postParamsHash: postParamsHeader([["app_user_id", "$RCAnonymousID:6b2787de2fb848a8b403a45f695ee74f"], ["new_app_user_id", "F72BF276-CD70-4C27-BCD2-FC1EFD988FA3"]]),
      headersHash: headersHashHeader([["X-Is-Sandbox", "true"]]),
      body: utf8('{"request_date":"2023-12-08T19:18:10Z","request_date_ms":1702063090636,"subscriber":{"entitlements":{},"first_seen":"2023-07-07T17:34:01Z","last_seen":"2023-07-07T17:34:01Z","management_url":null,"non_subscriptions":{},"original_app_user_id":"F72BF276-CD70-4C27-BCD2-FC1EFD988FA3","original_application_version":null,"original_purchase_date":null,"other_purchases":{},"subscriptions":{}}}\n'),
    },
  },
];

describe("verifier against RevenueCat production signatures", () => {
  it("computes the SDK's hash headers exactly as in the published curl commands", () => {
    expect(postParamsHeader([["app_user_id", "$RCAnonymousID:6b2787de2fb848a8b403a45f695ee74f"], ["new_app_user_id", "F72BF276-CD70-4C27-BCD2-FC1EFD988FA3"]]))
      .toBe("app_user_id,new_app_user_id:sha256:6fa58b9e3bdb1ca187ac082d128c19f04da8711fe6b17873a48bc7ca37bbf95a");
    expect(headersHashHeader([["X-Is-Sandbox", "true"]])).toBe("X-Is-Sandbox:sha256:b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b");
  });

  for (const v of rcVectors) {
    it(`verifies: ${v.name}`, () => {
      expect(verifySignature({ ...v.input, rootPublicKey: RC_ROOT, now: RC_NOW })).toEqual({ ok: true });
    });
  }

  it("rejects the same vectors when any signed part changes", () => {
    const base = { ...rcVectors[0]!.input, rootPublicKey: RC_ROOT, now: RC_NOW };
    const mismatch = { ok: false, reason: "payload_signature_mismatch" };
    expect(verifySignature({ ...base, path: "/v1/subscribers/login2" })).toEqual(mismatch);
    expect(verifySignature({ ...base, nonce: "MTIzNDU2Nzg5MGFj" })).toEqual(mismatch);
    expect(verifySignature({ ...base, requestTime: "1688165932215" })).toEqual(mismatch);
    expect(verifySignature({ ...base, etag: "" })).toEqual(mismatch);
    expect(verifySignature({ ...base, apiKey: "appl_other" })).toEqual(mismatch);
    expect(verifySignature({ ...base, body: utf8("{}") })).toEqual(mismatch);
    // Android encodes "$" as %24; RevenueCat signed the path it received, so the other spelling does not verify.
    expect(verifySignature({ ...rcVectors[4]!.input, path: "/v1/subscribers/%24RCAnonymousID%3A1af512a3b9c848899fe427f39dd69f2b", rootPublicKey: RC_ROOT, now: RC_NOW })).toEqual(mismatch);
    expect(verifySignature({ ...base, rootPublicKey: toB64(randomBytes(32)) }).ok).toBe(false);
    expect(verifySignature({ ...base, signature: base.signature!.slice(4) })).toEqual({ ok: false, reason: "invalid_signature_format" });
  });

  it("reports their intermediate keys as expired today", () => {
    for (const v of rcVectors) expect(verifySignature({ ...v.input, rootPublicKey: RC_ROOT, now: new Date("2026-09-30T00:00:00Z") })).toEqual({ ok: false, reason: "intermediate_key_expired" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Round trip through the real server.

const toB64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

interface Sent { path: string; method?: string; key?: string | null; nonce?: string; headers?: Record<string, string>; json?: unknown }

function serverWith(signingKey: string, now?: () => Date) {
  const app = createApp({ db: h!.db, now: now ?? h!.now, stores: defaultStores(), signingKey });
  return async (s: Sent) => {
    const headers = new Headers(s.headers);
    if (s.key !== null) headers.set("Authorization", `Bearer ${s.key ?? h!.ids.iosKey}`);
    if (s.nonce) headers.set("X-Nonce", s.nonce);
    if (s.json !== undefined) headers.set("content-type", "application/json");
    const res = await app.fetch(new Request(`http://localhost${s.path}`, { method: s.method ?? "GET", headers, body: s.json !== undefined ? JSON.stringify(s.json) : undefined }));
    const body = new Uint8Array(await res.arrayBuffer());
    return { res, body, sent: s, headers };
  };
}

/** What the SDK checks: the response headers plus what it sent. */
function check(r: Awaited<ReturnType<ReturnType<typeof serverWith>>>, rootPublicKey: string, overrides: Partial<VerifyInput> = {}, now = new Date()) {
  return verifySignature({
    signature: r.res.headers.get("X-Signature"),
    rootPublicKey,
    now,
    apiKey: r.sent.key === null ? "" : (r.sent.key ?? h!.ids.iosKey),
    nonce: r.sent.nonce,
    path: r.sent.path,
    postParamsHash: r.headers.get("X-Post-Params-Hash") ?? undefined,
    headersHash: r.headers.get("X-Headers-Hash") ?? undefined,
    requestTime: r.res.headers.get("X-RevenueCat-Request-Time") ?? "",
    etag: r.res.headers.get("X-RevenueCat-ETag") ?? undefined,
    body: r.body,
    ...overrides,
  });
}

const nonce = () => toB64(randomBytes(12));

describe("signed responses from the server", () => {
  it("publishes the root public key and signs SDK responses the SDK verifier accepts", async () => {
    h = await harness();
    const keys = await generateSigningKeyPair();
    expect(Buffer.from(keys.privateKey, "base64")).toHaveLength(32);
    expect(await publicKeyFromSeed(keys.privateKey)).toBe(keys.publicKey);
    const call = serverWith(keys.privateKey);

    const wk = await call({ path: "/.well-known/revenuedot-signing-key", key: null });
    expect(wk.res.status).toBe(200);
    const published = JSON.parse(new TextDecoder().decode(wk.body));
    expect(published).toEqual({ algorithm: "Ed25519", public_key: keys.publicKey, encoding: "base64", header: "X-Signature", docs: "https://revenuedot.app/docs" });
    const root = published.public_key as string;
    const now = h.now();

    // Customer info for an anonymous ID, spelled the iOS way ($ kept, ":" as %3A) and the Android way (%24 and %3A).
    const ios = await call({ path: "/v1/subscribers/$RCAnonymousID%3Aabc123", nonce: nonce() });
    expect(ios.res.status).toBeLessThan(300);
    expect(ios.res.headers.get("X-Signature")).toBeTruthy();
    expect(Buffer.from(ios.res.headers.get("X-Signature")!, "base64")).toHaveLength(180);
    expect(check(ios, root, {}, now)).toEqual({ ok: true });
    expect(JSON.parse(new TextDecoder().decode(ios.body)).subscriber.original_app_user_id).toBe("$RCAnonymousID:abc123");
    const android = await call({ path: "/v1/subscribers/%24RCAnonymousID%3Aabc123", nonce: nonce() });
    expect(check(android, root, {}, now)).toEqual({ ok: true });

    // Offerings are signed without a nonce (static signature).
    const offerings = await call({ path: "/v1/subscribers/$RCAnonymousID%3Aabc123/offerings" });
    expect(offerings.res.status).toBe(200);
    expect(check(offerings, root, {}, now)).toEqual({ ok: true });

    // logIn: X-Post-Params-Hash and X-Headers-Hash, computed the way the SDK does.
    const oldId = "$RCAnonymousID:abc123", newId = "user_42";
    const login = await call({
      path: "/v1/subscribers/identify", method: "POST", nonce: nonce(), json: { app_user_id: oldId, new_app_user_id: newId },
      headers: { "X-Is-Sandbox": "true", "X-Post-Params-Hash": postParamsHeader([["app_user_id", oldId], ["new_app_user_id", newId]]), "X-Headers-Hash": headersHashHeader([["X-Is-Sandbox", "true"]]) },
    });
    expect(login.res.status).toBeLessThan(300);
    expect(check(login, root, {}, now)).toEqual({ ok: true });
    // Without the headers in the message the signature does not verify, so they really are covered.
    expect(check(login, root, { postParamsHash: "" }, now)).toEqual({ ok: false, reason: "payload_signature_mismatch" });
    expect(check(login, root, { headersHash: "" }, now)).toEqual({ ok: false, reason: "payload_signature_mismatch" });

    // Health is unauthenticated: no API key in the message, and the server adds the request time itself.
    const health = await call({ path: "/v1/health", key: null, nonce: nonce() });
    expect(health.res.status).toBe(200);
    expect(health.res.headers.get("X-RevenueCat-Request-Time")).toBe(String(now.getTime()));
    expect(check(health, root, {}, now)).toEqual({ ok: true });

    // Errors are never signed.
    const denied = await call({ path: "/v1/subscribers/someone", key: "appl_wrong", nonce: nonce() });
    expect(denied.res.status).toBe(401);
    expect(denied.res.headers.get("X-Signature")).toBeNull();

    // Browsers may read the signature header.
    expect(ios.res.headers.get("Access-Control-Expose-Headers")).toContain("X-Signature");
  });

  it("fails verification for a tampered body, another nonce, another path, another key and a wrong root key", async () => {
    h = await harness();
    const keys = await generateSigningKeyPair();
    const call = serverWith(keys.privateKey);
    const now = h.now();
    const r = await call({ path: "/v1/subscribers/$RCAnonymousID%3Axyz", nonce: nonce() });
    expect(check(r, keys.publicKey, {}, now)).toEqual({ ok: true });
    const mismatch = { ok: false, reason: "payload_signature_mismatch" };
    const tampered = new Uint8Array(r.body); tampered[10] = tampered[10]! ^ 1;
    expect(check(r, keys.publicKey, { body: tampered }, now)).toEqual(mismatch);
    expect(check(r, keys.publicKey, { nonce: nonce() }, now)).toEqual(mismatch);
    expect(check(r, keys.publicKey, { path: "/v1/subscribers/$RCAnonymousID%3Axyy" }, now)).toEqual(mismatch);
    expect(check(r, keys.publicKey, { apiKey: "appl_other" }, now)).toEqual(mismatch);
    expect(check(r, keys.publicKey, { requestTime: "1" }, now)).toEqual(mismatch);
    expect(check(r, (await generateSigningKeyPair()).publicKey, {}, now)).toEqual({ ok: false, reason: "invalid_intermediate_key_signature" });
  });

  it("an intermediate key minted with a clock in the past is expired for the device", async () => {
    h = await harness();
    const keys = await generateSigningKeyPair();
    const call = serverWith(keys.privateKey, () => new Date("2020-01-01T00:00:00Z"));
    const r = await call({ path: "/v1/health", key: null, nonce: nonce() });
    expect(check(r, keys.publicKey, {}, new Date("2020-01-15T00:00:00Z"))).toEqual({ ok: true });
    expect(check(r, keys.publicKey, {}, new Date("2026-09-30T00:00:00Z"))).toEqual({ ok: false, reason: "intermediate_key_expired" });
  });

  it("does not sign when no key is configured, and the key endpoint answers 404", async () => {
    h = await harness();
    const call = serverWith("");
    const r = await call({ path: "/v1/subscribers/$RCAnonymousID%3Aabc", nonce: nonce() });
    expect(r.res.status).toBeLessThan(300);
    expect(r.res.headers.get("X-Signature")).toBeNull();
    const wk = await call({ path: "/.well-known/revenuedot-signing-key", key: null });
    expect(wk.res.status).toBe(404);
    expect(JSON.parse(new TextDecoder().decode(wk.body)).message).toMatch(/REVENUEDOT_SIGNING_KEY/);
  });

  it("reads REVENUEDOT_SIGNING_KEY from the environment and rejects an invalid key at startup", async () => {
    h = await harness();
    const keys = await generateSigningKeyPair();
    const saved = process.env.REVENUEDOT_SIGNING_KEY;
    try {
      process.env.REVENUEDOT_SIGNING_KEY = keys.privateKey;
      const app = createApp({ db: h.db, now: h.now, stores: defaultStores() });
      const res = await app.fetch(new Request("http://localhost/v1/health"));
      expect(res.headers.get("X-Signature")).toBeTruthy();
      process.env.REVENUEDOT_SIGNING_KEY = "not-a-key";
      expect(() => createApp({ db: h!.db, now: h!.now, stores: defaultStores() })).toThrow(/REVENUEDOT_SIGNING_KEY must be the base64 of a 32-byte/);
    } finally {
      if (saved === undefined) delete process.env.REVENUEDOT_SIGNING_KEY; else process.env.REVENUEDOT_SIGNING_KEY = saved;
    }
    expect(() => createApp({ db: h!.db, now: h!.now, stores: defaultStores(), signingKey: toB64(randomBytes(16)) })).toThrow(/32-byte/);
  });
});

describe("intermediate key rotation", () => {
  it("expires 30 days out and is re-minted when fewer than 7 days remain", async () => {
    const keys = await generateSigningKeyPair();
    let clock = new Date("2026-09-30T12:00:00Z");
    const signer = new ResponseSigner(keys.privateKey, { now: () => clock });
    const parts = { apiKey: "", nonce: new Uint8Array(), path: "/v1/health", postParamsHash: "", headersHash: "", requestTime: "1", etag: "", body: new Uint8Array() };
    const intermediate = async () => {
      const sig = Buffer.from(await signer.signMessage(parts), "base64");
      return { key: sig.subarray(0, 32).toString("hex"), days: sig.readUInt32LE(32) };
    };
    const first = await intermediate();
    expect(first.days).toBe(Math.floor(clock.getTime() / 86_400_000) + 30);
    clock = new Date(clock.getTime() + 22 * 86_400_000);
    expect(await intermediate()).toEqual(first);
    clock = new Date(clock.getTime() + 2 * 86_400_000);
    const second = await intermediate();
    expect(second.key).not.toBe(first.key);
    expect(second.days).toBe(Math.floor(clock.getTime() / 86_400_000) + 30);
    // Concurrent requests share one mint.
    clock = new Date(clock.getTime() + 40 * 86_400_000);
    const many = await Promise.all([intermediate(), intermediate(), intermediate()]);
    expect(new Set(many.map((m) => m.key)).size).toBe(1);
    const sigs = await Promise.all([signer.signMessage(parts), signer.signMessage(parts)]);
    expect(sigs[0]).not.toBe(sigs[1]); // fresh salt per response
  });
});
