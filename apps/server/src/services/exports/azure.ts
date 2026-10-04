import { fromBase64, toBase64 } from "../signing.js";

/**
 * Azure Blob Storage with WebCrypto (runs on Node and Cloudflare Workers): the storage account connection string and
 * Shared Key request signing, or a shared access signature (SAS) appended to the URL when the connection string carries
 * one. References: Microsoft's "Configure Azure Storage connection strings" and "Authorize with Shared Key" pages;
 * apps/server/test/azure.test.ts checks the signatures against values made by Microsoft's own JavaScript SDK.
 */

export const AZURE_VERSION = "2021-08-06";

/** Azurite (the local emulator)'s well-known account, which `UseDevelopmentStorage=true` stands for. */
const DEV_ACCOUNT = "devstoreaccount1";
const DEV_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

export interface AzureAccount {
  /** The blob service endpoint, without a trailing slash: https://<account>.blob.core.windows.net or a custom one. */
  blobEndpoint: string;
  accountName: string | null;
  accountKey: string | null;
  /** A shared access signature without the leading "?" (sv=…&sig=…). */
  sas: string | null;
}

export class AzureConfigError extends Error {}

/** Reads a storage account connection string (Microsoft's `Key=Value;…` format). */
export function parseConnectionString(raw: string): AzureAccount {
  const parts = new Map<string, string>();
  for (const seg of raw.trim().split(";")) {
    const i = seg.indexOf("=");
    if (i <= 0) continue;
    parts.set(seg.slice(0, i).trim().toLowerCase(), seg.slice(i + 1).trim());
  }
  if (parts.get("usedevelopmentstorage")?.toLowerCase() === "true") {
    const proxy = parts.get("developmentstorageproxyuri")?.replace(/\/+$/, "") ?? "http://127.0.0.1:10000";
    return { blobEndpoint: `${proxy}/${DEV_ACCOUNT}`, accountName: DEV_ACCOUNT, accountKey: DEV_KEY, sas: null };
  }
  const accountName = parts.get("accountname") || null;
  const accountKey = parts.get("accountkey") || null;
  const sas = parts.get("sharedaccesssignature")?.replace(/^\?/, "") || null;
  let blobEndpoint = parts.get("blobendpoint")?.replace(/\/+$/, "") || null;
  if (!blobEndpoint) {
    if (!accountName) throw new AzureConfigError("The connection string has no AccountName or BlobEndpoint.");
    const protocol = (parts.get("defaultendpointsprotocol") || "https").toLowerCase();
    const suffix = parts.get("endpointsuffix") || "core.windows.net";
    blobEndpoint = `${protocol}://${accountName}.blob.${suffix}`;
  }
  if (!/^https?:\/\//i.test(blobEndpoint)) throw new AzureConfigError("The connection string's BlobEndpoint is not an http(s) URL.");
  if (accountKey) {
    if (!accountName) throw new AzureConfigError("The connection string has an AccountKey but no AccountName.");
    try { if (fromBase64(accountKey).length < 16) throw new Error(); } catch { throw new AzureConfigError("The connection string's AccountKey is not a base64 storage account key."); }
  } else if (!sas) {
    throw new AzureConfigError("The connection string needs an AccountKey or a SharedAccessSignature.");
  }
  return { blobEndpoint, accountName, accountKey, sas };
}

/** The URL of a blob (each path segment encoded once) or, without a key, of the container. SAS is appended when present. */
export function azureUrl(a: AzureAccount, container: string, blob?: string, query: Record<string, string> = {}): string {
  const path = blob === undefined ? encodeURIComponent(container) : `${encodeURIComponent(container)}/${blob.split("/").map(encodeURIComponent).join("/")}`;
  const q = new URLSearchParams(query).toString();
  const qs = [q, a.accountKey ? "" : a.sas ?? ""].filter(Boolean).join("&");
  return `${a.blobEndpoint}/${path}${qs ? `?${qs}` : ""}`;
}

/**
 * The Shared Key Authorization header for a request (service version 2015-02-21 and later: an empty Content-Length when
 * the body is empty). `headers` are every header sent, x-ms-date and x-ms-version included.
 */
export async function sharedKeyAuthorization(r: { method: string; url: string; headers: Record<string, string>; accountName: string; accountKey: string }): Promise<{ authorization: string; stringToSign: string }> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) h[k.toLowerCase()] = v;
  const len = h["content-length"];
  const canonicalHeaders = Object.keys(h).filter((k) => k.startsWith("x-ms-")).sort()
    .map((k) => `${k}:${h[k]!.replace(/\s+/g, " ").trim()}\n`).join("");
  const url = new URL(r.url);
  const params = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) {
    const key = k.toLowerCase();
    (params.get(key) ?? params.set(key, []).get(key)!).push(v);
  }
  const canonicalResource = `/${r.accountName}${url.pathname || "/"}` +
    [...params.keys()].sort().map((k) => `\n${k}:${params.get(k)!.sort().join(",")}`).join("");
  const stringToSign = [
    r.method.toUpperCase(), h["content-encoding"] ?? "", h["content-language"] ?? "", len && len !== "0" ? len : "", h["content-md5"] ?? "",
    h["content-type"] ?? "", h.date ?? "", h["if-modified-since"] ?? "", h["if-match"] ?? "", h["if-none-match"] ?? "", h["if-unmodified-since"] ?? "", h.range ?? "",
  ].join("\n") + "\n" + canonicalHeaders + canonicalResource;
  const key = await crypto.subtle.importKey("raw", fromBase64(r.accountKey) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stringToSign)));
  return { authorization: `SharedKey ${r.accountName}:${toBase64(sig)}`, stringToSign };
}

/** Headers for a request to the blob service: x-ms-date and x-ms-version, plus Shared Key when the account key is known. */
export async function azureHeaders(a: AzureAccount, method: string, url: string, headers: Record<string, string>, now: Date): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...headers, "x-ms-date": now.toUTCString(), "x-ms-version": AZURE_VERSION };
  if (a.accountKey && a.accountName) out.authorization = (await sharedKeyAuthorization({ method, url, headers: out, accountName: a.accountName, accountKey: a.accountKey })).authorization;
  return out;
}
