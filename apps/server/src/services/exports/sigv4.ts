/**
 * AWS Signature Version 4 with WebCrypto (runs on Node and Cloudflare Workers). Used for S3 and S3-compatible storage
 * such as Cloudflare R2 ("auto" region) and MinIO. Reference: AWS's "Signature Version 4 signing process" and its
 * published test suite (apps/server/test/sigv4.test.ts checks the vectors).
 */

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", (typeof key === "string" ? enc.encode(key) : key) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** RFC 3986 percent-encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** S3 object keys are encoded once per path segment, keeping the slashes. */
export const encodePath = (path: string) => path.split("/").map((seg) => rfc3986(decodeURIComponentSafe(seg))).join("/");
function decodeURIComponentSafe(s: string) { try { return decodeURIComponent(s); } catch { return s; } }

export interface SigV4Request {
  method: string;
  url: string;
  /** Headers to sign besides host and x-amz-date (lower or mixed case). */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". Computed from `body` when absent. */
  payloadHash?: string;
  body?: string | Uint8Array | null;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  now: Date;
  /** S3 sends x-amz-content-sha256; the generic test suite does not. */
  contentSha256Header?: boolean;
}

export interface SignedRequest { headers: Record<string, string>; canonicalRequest: string; stringToSign: string; signature: string }

export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export async function signV4(r: SigV4Request): Promise<SignedRequest> {
  const url = new URL(r.url);
  const date = amzDate(r.now);
  const day = date.slice(0, 8);
  const payloadHash = r.payloadHash ?? await sha256Hex(r.body ?? "");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v;
  if (!headers.host) headers.host = url.host;
  headers["x-amz-date"] = date;
  if (r.contentSha256Header) headers["x-amz-content-sha256"] = payloadHash;
  if (r.sessionToken) headers["x-amz-security-token"] = r.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...url.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [r.method.toUpperCase(), encodePath(url.pathname || "/"), query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(`AWS4${r.secretAccessKey}`, day);
  const kRegion = await hmac(kDate, r.region);
  const kService = await hmac(kRegion, r.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));
  const out: Record<string, string> = { ...headers };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, canonicalRequest, stringToSign, signature };
}
