import { compactVerify } from "jose";
import { Asn1Error, TAG, base64ToBytes, bytesEqual, child, oid, parseAsn1, time, type Asn1 } from "./asn1.js";

/**
 * Apple Root CA - G3, from https://www.apple.com/certificateauthority/
 * SHA-256 fingerprint 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
 */
const APPLE_ROOT_CA_G3 = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

/** Apple's marker extensions: the App Store signing leaf and the WWDR intermediate. */
const OID_APPLE_LEAF = "1.2.840.113635.100.6.11.1";
const OID_APPLE_INTERMEDIATE = "1.2.840.113635.100.6.2.1";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";

const CURVES: Record<string, { name: string; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
  "1.3.132.0.35": { name: "P-521", size: 66 },
};
const SIG_HASH: Record<string, string> = { "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384", "1.2.840.10045.4.3.4": "SHA-512" };

export class JwsError extends Error {}

export function pemToDer(pem: string): Uint8Array {
  return base64ToBytes(pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, ""));
}

let appleRoots: Uint8Array[] = [pemToDer(APPLE_ROOT_CA_G3)];
const chainCache = new Map<string, true>();

/** Replaces the trusted Apple roots (tests sign with their own CA). `null` restores Apple Root CA - G3. */
export function setAppleRootsForTesting(pems: string[] | null) {
  appleRoots = (pems ?? [APPLE_ROOT_CA_G3]).map(pemToDer);
  chainCache.clear();
}

interface Cert {
  raw: Uint8Array;
  tbs: Uint8Array;
  sigAlg: string;
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  spki: Uint8Array;
  curve: { name: string; size: number } | null;
  isCA: boolean;
  extensions: Set<string>;
}

function parseCert(der: Uint8Array): Cert {
  const cert = parseAsn1(der);
  const tbs = child(cert, 0);
  const i = tbs.children[0]?.cls === 2 && tbs.children[0].tag === 0 ? 1 : 0;
  const validity = child(tbs, i + 3);
  const spki = child(tbs, i + 5);
  const spkiAlg = child(spki, 0);
  const curveOid = spkiAlg.children[1]?.tag === TAG.OID ? oid(spkiAlg.children[1]) : "";
  const extensions = new Set<string>();
  let isCA = false;
  const extWrap = tbs.children.find((c) => c.cls === 2 && c.tag === 3);
  for (const ext of extWrap ? child(extWrap, 0).children : []) {
    const id = oid(child(ext, 0));
    extensions.add(id);
    if (id === OID_BASIC_CONSTRAINTS) {
      const bc = parseAsn1(ext.children[ext.children.length - 1]!.value);
      isCA = bc.children[0]?.tag === TAG.BOOLEAN && bc.children[0].value[0] !== 0;
    }
  }
  const sigBits = child(cert, 2);
  return {
    raw: cert.raw, tbs: tbs.raw, sigAlg: oid(child(child(cert, 1), 0)), signature: sigBits.value.subarray(1),
    issuer: child(tbs, i + 2).raw, subject: child(tbs, i + 4).raw,
    notBefore: time(child(validity, 0)), notAfter: time(child(validity, 1)),
    spki: spki.raw, curve: CURVES[curveOid] ?? null, isCA, extensions,
  };
}

const copy = (b: Uint8Array) => new Uint8Array(b);

async function publicKey(c: Cert): Promise<CryptoKey> {
  if (!c.curve) throw new JwsError("Unsupported certificate key");
  return crypto.subtle.importKey("spki", copy(c.spki), { name: "ECDSA", namedCurve: c.curve.name }, false, ["verify"]);
}

/** DER ECDSA signature (SEQUENCE of r, s) to the fixed-size r||s form WebCrypto expects. */
function rawSignature(der: Uint8Array, size: number): Uint8Array {
  const seq = parseAsn1(der);
  const out = new Uint8Array(size * 2);
  [child(seq, 0), child(seq, 1)].forEach((n, k) => {
    let v = n.value;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new JwsError("Bad certificate signature");
    out.set(v, k * size + size - v.length);
  });
  return out;
}

async function signedBy(c: Cert, issuer: Cert): Promise<boolean> {
  const hash = SIG_HASH[c.sigAlg];
  if (!hash || !issuer.curve || !bytesEqual(c.issuer, issuer.subject)) return false;
  return crypto.subtle.verify({ name: "ECDSA", hash }, await publicKey(issuer), copy(rawSignature(c.signature, issuer.curve.size)), copy(c.tbs));
}

async function verifyChain(certs: Cert[], roots: Cert[]) {
  for (let k = 0; k < certs.length - 1; k++) {
    if (!certs[k + 1]!.isCA || !(await signedBy(certs[k]!, certs[k + 1]!))) throw new JwsError("The certificate chain is broken");
  }
  const top = certs[certs.length - 1]!;
  for (const r of roots) {
    if (bytesEqual(r.raw, top.raw) || (await signedBy(top, r))) return;
  }
  throw new JwsError("The certificate chain does not lead to a trusted root");
}

const decodePart = (s: string) => JSON.parse(new TextDecoder().decode(base64ToBytes(s)));

/**
 * Verifies an App Store JWS (signed transaction, renewal info or notification) and returns its payload.
 * Follows Apple's SignedDataVerifier: a 3-certificate x5c chain up to a trusted Apple root, Apple's marker OIDs on the leaf
 * and intermediate, certificates valid at `signedDate`, and an ES256 signature by the leaf.
 * Xcode StoreKit testing payloads are signed by a local certificate instead; they verify only against `xcodeRoots`.
 */
export async function verifyAppleJws<T = Record<string, any>>(jws: string, opts: { xcodeRoots?: Uint8Array[]; now?: Date } = {}): Promise<T> {
  try {
    const parts = jws.split(".");
    if (parts.length !== 3) throw new JwsError("Not a JWS");
    const header = decodePart(parts[0]!);
    const unverified = decodePart(parts[1]!);
    if (header?.alg !== "ES256") throw new JwsError("Unsupported JWS algorithm");
    const x5c: unknown = header.x5c;
    if (!Array.isArray(x5c) || !x5c.length || !x5c.every((c) => typeof c === "string")) throw new JwsError("The JWS has no certificate chain");
    const env = unverified?.environment ?? unverified?.data?.environment;
    const xcode = env === "Xcode" || env === "LocalTesting";
    const certs = (x5c as string[]).map((c) => parseCert(base64ToBytes(c)));
    if (!xcode) {
      if (certs.length !== 3) throw new JwsError("Apple JWS chains have exactly 3 certificates");
      if (!certs[0]!.extensions.has(OID_APPLE_LEAF) || !certs[1]!.extensions.has(OID_APPLE_INTERMEDIATE)) throw new JwsError("The certificates are not App Store certificates");
    }
    const roots = xcode ? opts.xcodeRoots ?? [] : appleRoots;
    if (!roots.length) throw new JwsError("Xcode StoreKit testing transactions need the app's StoreKit test certificate");
    const at = typeof unverified?.signedDate === "number" ? new Date(unverified.signedDate) : opts.now ?? new Date();
    for (const c of certs) if (at < c.notBefore || at > c.notAfter) throw new JwsError("A certificate in the chain is expired or not yet valid");
    // Apple reuses one chain for many payloads, so its signatures are checked once. Xcode roots differ per app: never cached.
    const cacheKey = (x5c as string[]).join(".");
    if (xcode || !chainCache.has(cacheKey)) {
      await verifyChain(certs, roots.map(parseCert));
      if (!xcode) {
        if (chainCache.size > 200) chainCache.clear();
        chainCache.set(cacheKey, true);
      }
    }
    const { payload } = await compactVerify(jws, await publicKey(certs[0]!), { algorithms: ["ES256"] });
    return JSON.parse(new TextDecoder().decode(payload)) as T;
  } catch (e) {
    if (e instanceof JwsError) throw e;
    if (e instanceof Asn1Error || e instanceof SyntaxError) throw new JwsError("Malformed JWS");
    throw new JwsError(e instanceof Error && e.message ? `Invalid JWS: ${e.message}` : "Invalid JWS");
  }
}

/** True when the string has the shape of a compact JWS (three base64url parts). */
export const looksLikeJws = (s: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s);
