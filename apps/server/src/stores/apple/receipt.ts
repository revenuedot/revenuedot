import { Asn1Error, TAG, child, int, octets, oid, parseAsn1, text, type Asn1 } from "./asn1.js";

/** One in-app purchase record of a StoreKit 1 app receipt. */
export interface ReceiptInApp {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  quantity: number;
  purchaseDate: Date;
  originalPurchaseDate: Date | null;
  expiresDate: Date | null;
  cancellationDate: Date | null;
  isTrialPeriod: boolean;
  isInIntroOfferPeriod: boolean;
}

export interface AppReceipt {
  /** "Production", "ProductionSandbox" or "Xcode" (attribute 0; absent in very old receipts). */
  environment: string | null;
  bundleId: string;
  applicationVersion: string | null;
  originalApplicationVersion: string | null;
  inApp: ReceiptInApp[];
}

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";

/** Receipt attribute SEQUENCE { type INTEGER, version INTEGER, value OCTET STRING } as [type, value]. */
function attributes(set: Asn1): [number, Uint8Array][] {
  if (set.tag !== TAG.SET) throw new Asn1Error("Receipt payload is not a SET");
  return set.children.filter((a) => a.tag === TAG.SEQUENCE && a.children.length >= 3).map((a) => [int(child(a, 0)), octets(child(a, 2))]);
}

/** Attribute values are themselves DER (UTF8String, IA5String or INTEGER). */
const str = (v: Uint8Array) => text(parseAsn1(v));
const num = (v: Uint8Array) => int(parseAsn1(v));
const date = (v: Uint8Array) => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s.replace(/ Etc\/GMT$/, "Z"));
  return Number.isNaN(d.getTime()) ? null : d;
};

function inApp(value: Uint8Array): ReceiptInApp {
  const r: Partial<ReceiptInApp> = { quantity: 1, isTrialPeriod: false, isInIntroOfferPeriod: false, expiresDate: null, cancellationDate: null, originalPurchaseDate: null };
  for (const [type, v] of attributes(parseAsn1(value))) {
    switch (type) {
      case 1701: r.quantity = num(v); break;
      case 1702: r.productId = str(v); break;
      case 1703: r.transactionId = str(v); break;
      case 1704: r.purchaseDate = date(v) ?? undefined; break;
      case 1705: r.originalTransactionId = str(v); break;
      case 1706: r.originalPurchaseDate = date(v); break;
      case 1708: r.expiresDate = date(v); break;
      case 1712: r.cancellationDate = date(v); break;
      case 1713: r.isTrialPeriod = num(v) === 1; break;
      case 1719: r.isInIntroOfferPeriod = num(v) === 1; break;
    }
  }
  if (!r.productId || !r.transactionId || !r.purchaseDate) throw new Asn1Error("In-app record is missing required fields");
  r.originalTransactionId ||= r.transactionId;
  return r as ReceiptInApp;
}

/**
 * Parses a base64-decoded StoreKit 1 app receipt: a PKCS#7 SignedData whose content is a SET of receipt attributes.
 * The PKCS#7 signature is not checked here; see index.ts for when a parsed receipt is trusted.
 */
export function parseAppReceipt(der: Uint8Array): AppReceipt {
  const ci = parseAsn1(der);
  if (ci.tag !== TAG.SEQUENCE || oid(child(ci, 0)) !== OID_SIGNED_DATA) throw new Asn1Error("Not a PKCS#7 signed receipt");
  const signedData = child(child(ci, 1), 0);
  const encap = signedData.children.find((c, i) => i > 0 && c.tag === TAG.SEQUENCE && c.children[0]?.tag === TAG.OID);
  const content = encap?.children[1];
  if (!content) throw new Asn1Error("The receipt has no content");
  const payload = parseAsn1(octets(child(content, 0)));
  const r: AppReceipt = { environment: null, bundleId: "", applicationVersion: null, originalApplicationVersion: null, inApp: [] };
  for (const [type, v] of attributes(payload)) {
    switch (type) {
      case 0: r.environment = str(v); break;
      case 2: r.bundleId = str(v); break;
      case 3: r.applicationVersion = str(v); break;
      case 17: r.inApp.push(inApp(v)); break;
      case 19: r.originalApplicationVersion = str(v); break;
    }
  }
  if (!r.bundleId) throw new Asn1Error("The receipt has no bundle id");
  return r;
}
