import { base64ToBytes } from "../apple/asn1.js";
import { parseCert, pemToDer } from "../apple/jws.js";
import { guardedFetch, OutboundRefused } from "../../services/outbound.js";

/**
 * Amazon SNS message signatures (how Amazon delivers Appstore Real-time Notifications).
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 * The signing certificate must come from an SNS host over HTTPS; the canonical string of the message is signed with
 * RSA PKCS#1 v1.5 and SHA-1 (SignatureVersion 1) or SHA-256 (SignatureVersion 2). Runs on WebCrypto (Node and Workers).
 */

export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation" | string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string | null;
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

export class SnsError extends Error {
  constructor(message: string, public transient = false) { super(message); }
}

/**
 * SNS hosts: sns.<region>.amazonaws.com, and sns.<region>.amazonaws.com.cn in China. The label must be an AWS region
 * (us-east-1, eu-central-1, us-gov-west-1, cn-north-1 ...): a looser pattern also matches other AWS hosts where anyone
 * can serve files, such as an S3 bucket named "sns" (sns.s3.amazonaws.com), and so a certificate of the sender's choice.
 */
const SNS_HOST = /^sns\.[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}\.amazonaws\.com(\.cn)?$/;
export const isSnsHost = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && SNS_HOST.test(url.hostname) && !url.port && !url.username && !url.password;
  } catch { return false; }
};

/** The canonical string AWS signs: selected keys in byte order, each "Key\nValue\n". */
export function stringToSign(m: SnsMessage): string {
  const keys = m.Type === "Notification"
    ? ["Message", "MessageId", ...(m.Subject !== undefined && m.Subject !== null ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k] ?? ""}\n`).join("");
}

/** Parses an SNS body; null when it is not one. */
export function parseSns(raw: string): SnsMessage | null {
  try {
    const j = JSON.parse(raw) as Partial<SnsMessage>;
    if (!j || typeof j !== "object" || typeof j.Type !== "string" || typeof j.MessageId !== "string" || typeof j.Signature !== "string" || typeof j.SigningCertURL !== "string") return null;
    return j as SnsMessage;
  } catch { return null; }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const certCache = new Map<string, { at: number; spki: Uint8Array; notBefore: Date; notAfter: Date }>();

async function certificate(url: string, fetchFn: FetchFn) {
  const hit = certCache.get(url);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit;
  let res: Response;
  try { res = await guardedFetch(fetchFn, url, { signal: AbortSignal.timeout(10_000) }); } catch (e) {
    if (e instanceof OutboundRefused) throw new SnsError(`The SNS signing certificate could not be fetched: ${e.message}`);
    throw new SnsError(`The SNS signing certificate could not be fetched: ${e instanceof Error ? e.message : e}`, true);
  }
  if (!res.ok) throw new SnsError(`The SNS signing certificate answered ${res.status}`, res.status >= 500);
  const pem = await res.text();
  let cert;
  try { cert = parseCert(pemToDer(pem)); } catch { throw new SnsError("The SNS signing certificate is not a PEM certificate"); }
  const entry = { at: Date.now(), spki: cert.spki, notBefore: cert.notBefore, notAfter: cert.notAfter };
  certCache.set(url, entry);
  return entry;
}

/** Throws SnsError unless the message is signed by the certificate at its SNS SigningCertURL. */
export async function verifySns(m: SnsMessage, fetchFn: FetchFn, now: Date): Promise<void> {
  if (m.SignatureVersion !== "1" && m.SignatureVersion !== "2") throw new SnsError(`Unsupported SNS SignatureVersion ${m.SignatureVersion}`);
  if (!isSnsHost(m.SigningCertURL) || !/\.pem$/.test(new URL(m.SigningCertURL).pathname)) throw new SnsError("SigningCertURL is not an Amazon SNS certificate URL");
  const cert = await certificate(m.SigningCertURL, fetchFn);
  if (now < cert.notBefore || now > cert.notAfter) throw new SnsError("The SNS signing certificate is not valid now");
  const hash = m.SignatureVersion === "1" ? "SHA-1" : "SHA-256";
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", new Uint8Array(cert.spki), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
  } catch { throw new SnsError("The SNS signing certificate does not hold an RSA key"); }
  let sig: Uint8Array;
  try { sig = base64ToBytes(m.Signature); } catch { throw new SnsError("The SNS signature is not base64"); }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, new Uint8Array(sig), new TextEncoder().encode(stringToSign(m)));
  if (!ok) throw new SnsError("The SNS signature does not match the message");
}

/** For tests: forget fetched certificates. */
export function clearSnsCertCache() { certCache.clear(); }
