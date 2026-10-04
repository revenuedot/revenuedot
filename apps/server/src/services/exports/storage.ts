import { encodePath, sha256Hex, signV4 } from "./sigv4.js";
import { AzureConfigError, azureHeaders, azureUrl, parseConnectionString, type AzureAccount } from "./azure.js";
import { googleAccessToken, parseServiceAccount } from "../google-sa.js";
import { outboundUrlProblem } from "../outbound.js";

/**
 * Where export files go. The buckets speak plain HTTPS with WebCrypto signing, so they work on Node and Workers:
 * - s3: Amazon S3 (virtual-hosted URL, the bucket's region) or any S3-compatible endpoint (path-style URL).
 * - r2: Cloudflare R2, S3-compatible at https://<account id>.r2.cloudflarestorage.com, region "auto".
 * - gcs: Google Cloud Storage. With a service account (`credential_type` "service_account", the default): the JSON API
 *   (simple upload) with a token for scope devstorage.read_write. With an HMAC key (`credential_type` "hmac"): the XML
 *   API at storage.googleapis.com, which accepts AWS Signature Version 4 requests (region "auto").
 * - azure: Azure Blob Storage (Put Blob as a block blob) with a storage account connection string: Shared Key signing
 *   with the account key, or the connection string's shared access signature (services/exports/azure.ts).
 * - email: no bucket. Files are kept by RevenueDot for 7 days and recipients get download links (services/exports/email.ts).
 * Config: `bucket` (the container for azure), `prefix`; s3 `region`, `endpoint`; r2 `account_id`; s3, r2 and gcs hmac
 * `access_key_id`; gcs `credential_type`; email `recipients`, `subject_prefix`.
 * Secrets: s3, r2 and gcs hmac `secret_access_key`; gcs `service_account_json`; azure `connection_string`.
 */

export type Destination = "s3" | "r2" | "gcs" | "azure" | "email";
export const DESTINATIONS: Destination[] = ["s3", "r2", "gcs", "azure", "email"];
export const GCS_XML_ENDPOINT = "https://storage.googleapis.com";

/** The secret a destination needs (null for email). */
export function secretField(destination: Destination, config: Record<string, unknown>): string | null {
  if (destination === "email") return null;
  if (destination === "azure") return "connection_string";
  if (destination === "gcs") return config.credential_type === "hmac" ? "secret_access_key" : "service_account_json";
  return "secret_access_key";
}
const gcsHmac = (t: StorageTarget) => t.destination === "gcs" && t.config.credential_type === "hmac";
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
  if (gcsHmac(t)) return { url: (k) => `${GCS_XML_ENDPOINT}/${bucket}/${encodePath(k)}`, bucketUrl: `${GCS_XML_ENDPOINT}/${bucket}`, region: "auto" };
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
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? res.headers.get("x-ms-error-code") ?? (() => { try { return JSON.parse(text)?.error?.message as string | undefined; } catch { return undefined; } })();
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

const s3Name = (t: StorageTarget) => (t.destination === "r2" ? "R2" : t.destination === "gcs" ? "Google Cloud Storage" : "S3");

function azureAccount(t: StorageTarget): AzureAccount {
  if (!t.secrets.connection_string) throw new StorageError("Set the storage account connection string.", false);
  try { return parseConnectionString(t.secrets.connection_string); } catch (e) { throw new StorageError(e instanceof AzureConfigError ? e.message : "The connection string could not be read.", false); }
}
const azureContainer = (t: StorageTarget) => {
  const c = String(t.config.bucket ?? "");
  if (!c) throw new StorageError("Set the container name.", false);
  return c;
};

/** Uploads one file. Returns the object's URI (s3://, r2://, gs://, azure://). */
export async function putObject(t: StorageTarget, key: string, bytes: Uint8Array, contentType: string, f: typeof fetch, now: Date): Promise<string> {
  if (t.destination === "email") throw new StorageError("Email exports are kept by RevenueDot, not uploaded.", false);
  if (t.destination === "azure") {
    const a = azureAccount(t), container = azureContainer(t);
    const url = azureUrl(a, container, key);
    const headers = await azureHeaders(a, "PUT", url, { "content-length": String(bytes.length), "content-type": contentType, "x-ms-blob-content-type": contentType, "x-ms-blob-type": "BlockBlob" }, now);
    const res = await call(t, f, url, { method: "PUT", headers, body: bytes as Uint8Array<ArrayBuffer> }, "Azure Blob Storage");
    if (!res.ok) throw await sendErr("Azure Blob Storage", res);
    return `azure://${container}/${key}`;
  }
  if (t.destination === "gcs" && !gcsHmac(t)) {
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
  const res = await call(t, f, url, { method: "PUT", headers: signed.headers, body: bytes as Uint8Array<ArrayBuffer> }, s3Name(t));
  if (!res.ok) throw await sendErr(s3Name(t), res);
  return `${t.destination === "gcs" ? "gs" : t.destination}://${t.config.bucket}/${key}`;
}

/** Checks that the bucket exists and the credentials can reach it (S3 HeadBucket, GCS buckets.get, Azure Get Container Properties). */
export async function checkBucket(t: StorageTarget, f: typeof fetch, now: Date): Promise<void> {
  if (t.destination === "email") return;
  if (t.destination === "azure") {
    const a = azureAccount(t);
    const url = azureUrl(a, azureContainer(t), undefined, { restype: "container" });
    const res = await call(t, f, url, { method: "GET", headers: await azureHeaders(a, "GET", url, {}, now) }, "Azure Blob Storage");
    if (!res.ok) throw await sendErr("Azure Blob Storage", res);
    return;
  }
  if (t.destination === "gcs" && !gcsHmac(t)) {
    const token = await gcsToken(t, f, now);
    const res = await call(t, f, `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(String(t.config.bucket ?? ""))}`, { headers: { authorization: `Bearer ${token}` } }, "Google Cloud Storage");
    if (!res.ok) throw await sendErr("Google Cloud Storage", res);
    return;
  }
  const b = s3Base(t);
  const keyId = String(t.config.access_key_id ?? ""), secret = t.secrets.secret_access_key;
  if (!keyId || !secret) throw new StorageError("Set the access key ID and secret access key.", false);
  const signed = await signV4({ method: "HEAD", url: b.bucketUrl, payloadHash: await sha256Hex(""), accessKeyId: keyId, secretAccessKey: secret, region: b.region, service: "s3", now, contentSha256Header: true });
  const res = await call(t, f, b.bucketUrl, { method: "HEAD", headers: signed.headers }, s3Name(t));
  if (!res.ok) throw await sendErr(s3Name(t), res);
}

async function gcsToken(t: StorageTarget, f: typeof fetch, now: Date) {
  try {
    return await googleAccessToken(parseServiceAccount(t.secrets.service_account_json), GCS_SCOPE, f, now.getTime());
  } catch (e) {
    throw new StorageError(e instanceof Error ? e.message : String(e), !!(e as { transient?: boolean }).transient);
  }
}
