// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: starts the node-express webhook example (revenuedot/examples, backend/node-express-webhook) as a developer
// would, with the webhook's signing secret, and keeps its log: it prints "grant <entitlements> to <user>" only after the
// HMAC signature checked out, and answers 401 otherwise.
import { spawn } from "node:child_process";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { until } from "./check.ts";
import { PORTS, ROOT } from "./stack.ts";

export const BACKEND_DIR = join(ROOT, "..", "examples/backend/node-express-webhook");
export const backendUrl = () => `http://localhost:${PORTS.backend}/webhooks/revenuedot`;

export async function startExampleBackend(secret: string) {
  if (!existsSync(join(BACKEND_DIR, "node_modules/express"))) throw new Error(`run npm install in ${BACKEND_DIR}`);
  const state = { log: "" };
  const child = spawn(process.execPath, ["src/server.js"], { cwd: BACKEND_DIR, env: { ...process.env, PORT: String(PORTS.backend), REVENUEDOT_WEBHOOK_SECRET: secret } });
  child.stdout.on("data", (d) => { state.log += d; });
  child.stderr.on("data", (d) => { state.log += d; });
  await until(async () => state.log.includes("Listening"), { timeoutMs: 15_000 });
  return { get log() { return state.log; }, stop: () => child.kill("SIGTERM") };
}

/**
 * Checks an X-Signature header the way the iOS and Android SDKs' Trusted Entitlements do: an intermediate key signed by
 * the root key, then salt + api key + nonce + path + request time + ETag-or-body signed by the intermediate key.
 */
export function verifySignature(sigB64: string, rootPubB64: string, parts: { apiKey: string; nonce: Buffer; path: string; requestTime: string; body: Buffer }): string {
  const sig = Buffer.from(sigB64, "base64");
  if (sig.length !== 180) return `bad length ${sig.length}`;
  const key = (raw: Buffer) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const inter = sig.subarray(0, 32), exp = sig.subarray(32, 36), rootSig = sig.subarray(36, 100), salt = sig.subarray(100, 116), payloadSig = sig.subarray(116, 180);
  if (!edVerify(null, Buffer.concat([exp, inter]), key(Buffer.from(rootPubB64, "base64")), rootSig)) return "intermediate key not signed by the root key";
  if (exp.readUInt32LE(0) * 86400_000 < Date.now()) return "intermediate key expired";
  const msg = Buffer.concat([salt, Buffer.from(parts.apiKey), parts.nonce, Buffer.from(parts.path), Buffer.from(parts.requestTime), parts.body]);
  return edVerify(null, msg, key(inter), payloadSig) ? "verified" : "payload signature mismatch";
}

/** The raw Ed25519 public key (base64) for a base64 32-byte seed. */
export function publicKeyOfSeed(seedB64: string): string {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedB64, "base64")]), format: "der", type: "pkcs8" })
    .export({ format: "der", type: "spki" }).subarray(12).toString("base64");
}
