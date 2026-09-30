import type { AppleCredentials } from "../stores/apple/api.js";

/**
 * Promotional offer signatures for `POST /v1/offers` (iOS `Purchases.promotionalOffer(forProductDiscount:product:)`).
 * Apple's format (https://developer.apple.com/documentation/storekit/generating-a-signature-for-promotional-offers):
 * ECDSA P-256 with SHA-256 over bundle id, key id, product id, offer id, app account token, nonce and timestamp joined
 * by U+2063, DER-encoded and base64. The key is the app's In-App Purchase key, the same one the App Store Server API uses.
 */
export interface OfferSignature { keyId: string; nonce: string; signature: string; timestamp: number }

const SEP = "\u2063";

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** WebCrypto returns r||s (IEEE P1363); Apple expects an ASN.1 DER SEQUENCE of two INTEGERs. */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = Uint8Array.from([0, ...v]);
    return Uint8Array.from([0x02, v.length, ...v]);
  };
  const half = sig.length / 2;
  const r = int(sig.slice(0, half)), s = int(sig.slice(half));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** The payload Apple verifies. `appAccountToken` is a lowercase UUID or "" (see appAccountTokenFor). */
export function offerPayload(bundleId: string, keyId: string, productId: string, offerId: string, appAccountToken: string, nonce: string, timestamp: number) {
  return [bundleId, keyId, productId, offerId, appAccountToken, nonce.toLowerCase(), String(timestamp)].join(SEP);
}

/**
 * What the SDK puts on the payment, which the signature must match: StoreKit 2 adds `appAccountToken` only when the app
 * user id is a UUID; StoreKit 1 sets `applicationUsername` to the app user id (`PurchasesOrchestrator`).
 */
export function appAccountTokenFor(appUserId: string, storeKit2: boolean): string {
  if (!storeKit2) return appUserId;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appUserId) ? appUserId.toLowerCase() : "";
}

export async function signOffer(creds: AppleCredentials, productId: string, offerId: string, appAccountToken: string, now: Date): Promise<OfferSignature> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(creds.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const nonce = crypto.randomUUID().toLowerCase();
  const timestamp = now.getTime();
  const data = new TextEncoder().encode(offerPayload(creds.bundleId, creds.keyId, productId, offerId, appAccountToken, nonce, timestamp));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
  return { keyId: creds.keyId, nonce, signature: b64(p1363ToDer(raw)), timestamp };
}
