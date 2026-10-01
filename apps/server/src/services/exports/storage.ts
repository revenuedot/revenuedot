import { encodePath, sha256Hex, signV4 } from "./sigv4.js";
import { googleAccessToken, parseServiceAccount } from "../google-sa.js";
import { outboundUrlProblem } from "../outbound.js";

/**
 * Where export files go. All three speak plain HTTPS with WebCrypto signing, so they work on Node and Workers:
 * - s3: Amazon S3 (virtual-hosted URL, the bucket's region) or any S3-compatible endpoint (path-style URL).
 * - r2: Cloudflare R2, S3-compatible at https://<account id>.r2.cloudflarestorage.com, region "auto".
 * - gcs: Google Cloud Storage JSON API (simple upload) with a service-account token (scope devstorage.read_write).
 * Config: `bucket`, `prefix`; s3 `region`, `endpoint`; r2 `account_id`; s3 and r2 `access_key_id`.
 * Secrets: s3 and r2 `secret_access_key`; gcs `service_account_json`.
 */

export type Destination = "s3" | "r2" | "gcs";
export const DESTINATIONS: Destination[] = ["s3", "r2", "gcs"];
export const GCS_SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

export interface StorageTarget {
  destination: Destination;
  config: Record<string, any>;
  secrets: Record<string, string>;
  /** RevenueDot Cloud: refuse endpoints on private networks (services/outbound.ts). */
  strictUrls?: boolean;
}

export class StorageError extends Error {
  constructor(message: string, public transient: boolean, public status: number | null = null) { super(message); }
}

function s3Base(t: StorageTarget): { url: (key: string) => string; bucketUrl: string; region: string } {
  const bucket = String(t.config.bucket ?? "");
  if (!bucket) throw new StorageError("Set the bucket name.", false);
  if (t.destination === "r2") {
    const acct = String(t.config.account_id ?? "").trim();
    if (!acct && !t.config.endpoint) throw new StorageError("Set the Cloudflare account ID.", false);
    const endpoint = String(t.config.endpoint || `https://${acct}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
    return { url: (k) => `${endpoint}/${bucket}/${encodePath(k)}`, bucketUrl: `${endpoint}/${bucket}`, region: "auto" };
  }
  const region = String(t.config.region || "us-east-1");
  if (t.config.endpoint) {
    const endpoint = String(t.config.endpoint).replace(/\/+$/, "");
    return { url: (k) => `${endpoint}/${bucket}/${encodePath(k)}`, bucketUrl: `${endpoint}/${bucket}`, region };
  }
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  return { url: (k) => `https://${host}/${encodePath(k)}`, bucketUrl: `https://${host}/`, region };
}

const sendErr = async (what: string, res: Response) => {
  const text = (await res.text().catch(() => "")).slice(0, 400);
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? (() => { try { return JSON.parse(text)?.error?.message as string | undefined; } catch { return undefined; } })();
  return new StorageError(`${what} answered HTTP ${res.status}${code ? ` (${code})` : ""}.`, res.status >= 500 || res.status === 429 || res.status === 408, res.status);
};

async function call(t: StorageTarget, f: typeof fetch, url: string, init: RequestInit, what: string): Promise<Response> {
  const problem = outboundUrlProblem(url, !!t.strictUrls);
  if (problem) throw new StorageError(`The ${what} endpoint ${problem}.`, false);
  let res: Response;
  try { res = await f(url, { ...init, redirect: "manual" }); } catch (e) { throw new StorageError(`${what} did not answer: ${e instanceof Error ? e.message : String(e)}`, true); }
  // Not followed: the guard checked only this URL, and a redirect could point at a metadata or private address.
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") throw new StorageError(`${what} answered with a redirect, which is not followed. Use the bucket's own endpoint.`, false, res.status || undefined);
  return res;
}

/** Uploads one file. Returns the object's URI (s3://, r2://, gs://). */
export async function putObject(t: StorageTarget, key: string, bytes: Uint8Array, contentType: string, f: typeof fetch, now: Date): Promise<string> {
  if (t.destination === "gcs") {
    const bucket = String(t.config.bucket ?? "");
    if (!bucket) throw new StorageError("Set the bucket name.", false);
    const token = await gcsToken(t, f, now);
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    const res = await call(t, f, url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": contentType }, body: bytes as Uint8Array<ArrayBuffer> }, "Google Cloud Storage");
    if (!res.ok) throw await sendErr("Google Cloud Storage", res);
    return `gs://${bucket}/${key}`;
  }
  const b = s3Base(t);
  const keyId = String(t.config.access_key_id ?? ""), secret = t.secrets.secret_access_key;
  if (!keyId || !secret) throw new StorageError("Set the access key ID and secret access key.", false);
  const url = b.url(key);
  const signed = await signV4({
    method: "PUT", url, payloadHash: await sha256Hex(bytes), headers: { "content-type": contentType },
    accessKeyId: keyId, secretAccessKey: secret, region: b.region, service: "s3", now, contentSha256Header: true,
  });
  const res = await call(t, f, url, { method: "PUT", headers: signed.headers, body: bytes as Uint8Array<ArrayBuffer> }, t.destination === "r2" ? "R2" : "S3");
  if (!res.ok) throw await sendErr(t.destination === "r2" ? "R2" : "S3", res);
  return `${t.destination === "r2" ? "r2" : "s3"}://${t.config.bucket}/${key}`;
}

/** Checks that the bucket exists and the credentials can reach it (S3 HeadBucket, GCS buckets.get). */
export async function checkBucket(t: StorageTarget, f: typeof fetch, now: Date): Promise<void> {
  if (t.destination === "gcs") {
    const token = await gcsToken(t, f, now);
    const res = await call(t, f, `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(String(t.config.bucket ?? ""))}`, { headers: { authorization: `Bearer ${token}` } }, "Google Cloud Storage");
    if (!res.ok) throw await sendErr("Google Cloud Storage", res);
    return;
  }
  const b = s3Base(t);
  const keyId = String(t.config.access_key_id ?? ""), secret = t.secrets.secret_access_key;
  if (!keyId || !secret) throw new StorageError("Set the access key ID and secret access key.", false);
  const signed = await signV4({ method: "HEAD", url: b.bucketUrl, payloadHash: await sha256Hex(""), accessKeyId: keyId, secretAccessKey: secret, region: b.region, service: "s3", now, contentSha256Header: true });
  const res = await call(t, f, b.bucketUrl, { method: "HEAD", headers: signed.headers }, t.destination === "r2" ? "R2" : "S3");
  if (!res.ok) throw await sendErr(t.destination === "r2" ? "R2" : "S3", res);
}

async function gcsToken(t: StorageTarget, f: typeof fetch, now: Date) {
  try {
    return await googleAccessToken(parseServiceAccount(t.secrets.service_account_json), GCS_SCOPE, f, now.getTime());
  } catch (e) {
    throw new StorageError(e instanceof Error ? e.message : String(e), !!(e as { transient?: boolean }).transient);
  }
}
