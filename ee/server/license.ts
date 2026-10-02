// RevenueDot Enterprise (ee/LICENSE). Licence keys: which enterprise features a server may run. Spec: prd/enterprise/PRD.md §2.
// Clause 5 of ee/LICENSE forbids moving, changing, disabling or circumventing this check.
import { fromBase64, toBase64 } from "../../apps/server/src/services/signing.js";

/** Every enterprise feature. A licence lists the ones it covers, or "*" for all. */
export const FEATURES = ["organizations", "custom_roles", "sso", "scim", "data_location", "audit_retention", "compliance_exports"] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * Raw Ed25519 public keys (base64) that sign RevenueDot Enterprise licences. Circo holds the private keys (1Password
 * vault RevenueDot, item "RevenueDot Enterprise licence signing key"); `pnpm tsx ee/scripts/license-keygen.ts` makes a
 * pair. Until a key is listed here, only development mode (REVENUEDOT_EE_DEV=true) turns the features on.
 */
export const LICENSE_PUBLIC_KEYS: string[] = [];

/** Days a licence keeps working after it expires, with a warning, so a late renewal never locks anyone out. */
export const GRACE_DAYS = 14;

export interface LicensePayload {
  v: 1;
  /** Licence id, for support. */
  id: string;
  licensee: string;
  /** Feature names, or ["*"]. */
  features: string[];
  /** Organizations allowed on this server (null: any number). */
  max_orgs?: number | null;
  /** Where the licence may run: "self-hosted", "cloud" or "any". */
  edition?: "self-hosted" | "cloud" | "any";
  issued_at: number;
  expires_at: number;
}

export interface LicenseState {
  mode: "licensed" | "development" | "invalid";
  features: Feature[];
  licensee: string | null;
  expiresAt: number | null;
  maxOrgs: number | null;
  message: string | null;
}

const PREFIX = "rdl1_";
const ED25519 = { name: "Ed25519" } as const;
const b64url = (u: Uint8Array) => toBase64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (s: string) => new TextEncoder().encode(s);

const invalid = (message: string): LicenseState => ({ mode: "invalid", features: [], licensee: null, expiresAt: null, maxOrgs: null, message });

async function verifyWith(publicKeyB64: string, data: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64(publicKeyB64), ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, sig as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

/**
 * Checks a licence key: `rdl1_<base64url payload JSON>.<base64url Ed25519 signature of the payload bytes>`.
 * `REVENUEDOT_EE_DEV=true` without a key is development mode: every feature, for development and testing only
 * (ee/LICENSE clause 3), never on RevenueDot Cloud.
 */
export async function checkLicense(o: { key?: string | null; dev?: boolean; edition?: "cloud" | "self-hosted"; now: number; publicKeys?: string[] }): Promise<LicenseState> {
  const key = o.key?.trim();
  if (!key) {
    if (o.dev && o.edition === "cloud") return invalid("Development mode is not available on RevenueDot Cloud. Set REVENUEDOT_LICENSE_KEY.");
    if (o.dev) return { mode: "development", features: [...FEATURES], licensee: null, expiresAt: null, maxOrgs: null, message: "Development mode: for development and testing only, not for production (ee/LICENSE)." };
    return invalid("No licence key.");
  }
  if (!key.startsWith(PREFIX) || !key.includes(".")) return invalid("The licence key is not in the expected format (rdl1_…).");
  const [payloadB64, sigB64] = key.slice(PREFIX.length).split(".");
  let payloadBytes: Uint8Array, sig: Uint8Array, payload: LicensePayload;
  try {
    payloadBytes = fromBase64(payloadB64!);
    sig = fromBase64(sigB64!);
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as LicensePayload;
  } catch {
    return invalid("The licence key could not be read.");
  }
  const keys = o.publicKeys ?? LICENSE_PUBLIC_KEYS;
  let ok = false;
  for (const k of keys) if (await verifyWith(k, payloadBytes, sig)) { ok = true; break; }
  if (!ok) return invalid("The licence key's signature is not valid.");
  if (payload.v !== 1 || !Array.isArray(payload.features) || typeof payload.expires_at !== "number") return invalid("The licence key is not a version this server understands.");
  const edition = payload.edition ?? "any";
  if (edition !== "any" && o.edition && edition !== o.edition) return invalid(`This licence is for ${edition === "cloud" ? "RevenueDot Cloud" : "self-hosted servers"} only.`);
  const features = (payload.features.includes("*") ? [...FEATURES] : FEATURES.filter((f) => payload.features.includes(f)));
  const base = { features, licensee: payload.licensee ?? null, expiresAt: payload.expires_at, maxOrgs: payload.max_orgs ?? null };
  if (o.now > payload.expires_at + GRACE_DAYS * 86400_000) return { ...invalid(`The licence expired on ${new Date(payload.expires_at).toISOString().slice(0, 10)}. Renew it to turn the enterprise features back on.`), licensee: base.licensee, expiresAt: base.expiresAt };
  const message = o.now > payload.expires_at ? `The licence expired on ${new Date(payload.expires_at).toISOString().slice(0, 10)}; the features stop ${GRACE_DAYS} days later. Renew it now.` : null;
  return { mode: "licensed", ...base, message };
}

/** Issues a licence key (ee/scripts/license-issue.ts and tests). `seedB64` is the base64 Ed25519 private key seed. */
export async function issueLicense(seedB64: string, payload: LicensePayload): Promise<string> {
  const PKCS8_ED25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const seed = fromBase64(seedB64);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_ED25519_PREFIX); pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, ED25519, false, ["sign"]);
  const bytes = utf8(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign(ED25519, key, bytes));
  return `${PREFIX}${b64url(bytes)}.${b64url(sig)}`;
}
