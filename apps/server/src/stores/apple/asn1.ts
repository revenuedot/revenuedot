/**
 * A small BER/DER reader, enough for X.509 certificates and App Store receipts (PKCS#7).
 * Works on Workers and Node (no Buffer).
 */
export interface Asn1 {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  tag: number;
  constructed: boolean;
  /** Content bytes (without the tag and length). */
  value: Uint8Array;
  /** The whole element, tag and length included. */
  raw: Uint8Array;
  children: Asn1[];
}

export class Asn1Error extends Error {}

export const TAG = { BOOLEAN: 1, INTEGER: 2, BIT_STRING: 3, OCTET_STRING: 4, OID: 6, UTF8: 12, SEQUENCE: 16, SET: 17, IA5: 22, UTC_TIME: 23, GENERALIZED_TIME: 24 } as const;

const MAX_DEPTH = 32;

function read(buf: Uint8Array, pos: number, end: number, depth: number): { node: Asn1; next: number } {
  if (depth > MAX_DEPTH) throw new Asn1Error("ASN.1 nesting too deep");
  const start = pos;
  if (pos >= end) throw new Asn1Error("Unexpected end of ASN.1 data");
  const first = buf[pos++]!;
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let b: number;
    do {
      if (pos >= end) throw new Asn1Error("Truncated ASN.1 tag");
      b = buf[pos++]!;
      tag = tag * 128 + (b & 0x7f);
    } while (b & 0x80);
  }
  if (pos >= end) throw new Asn1Error("Truncated ASN.1 length");
  const lb = buf[pos++]!;
  const children: Asn1[] = [];
  if (lb === 0x80) {
    // Indefinite length (BER): children until an end-of-contents marker.
    if (!constructed) throw new Asn1Error("Indefinite length on a primitive ASN.1 element");
    const contentStart = pos;
    for (;;) {
      if (pos + 1 >= end) throw new Asn1Error("Missing ASN.1 end-of-contents");
      if (buf[pos] === 0 && buf[pos + 1] === 0) break;
      const r = read(buf, pos, end, depth + 1);
      children.push(r.node);
      pos = r.next;
    }
    const value = buf.subarray(contentStart, pos);
    pos += 2;
    return { node: { cls, tag, constructed, value, raw: buf.subarray(start, pos), children }, next: pos };
  }
  let len = lb;
  if (lb & 0x80) {
    const n = lb & 0x7f;
    if (n > 4) throw new Asn1Error("ASN.1 length too large");
    len = 0;
    for (let i = 0; i < n; i++) {
      if (pos >= end) throw new Asn1Error("Truncated ASN.1 length");
      len = len * 256 + buf[pos++]!;
    }
  }
  if (pos + len > end) throw new Asn1Error("ASN.1 length exceeds the data");
  const value = buf.subarray(pos, pos + len);
  if (constructed) {
    let p = pos;
    while (p < pos + len) {
      const r = read(buf, p, pos + len, depth + 1);
      children.push(r.node);
      p = r.next;
    }
  }
  return { node: { cls, tag, constructed, value, raw: buf.subarray(start, pos + len), children }, next: pos + len };
}

/** Parses one element from the start of `buf`. Trailing bytes are ignored. */
export function parseAsn1(buf: Uint8Array): Asn1 {
  return read(buf, 0, buf.length, 0).node;
}

/** Child `i`, or an error when the structure is not what we expect. */
export function child(n: Asn1 | undefined, i: number): Asn1 {
  const c = n?.children[i];
  if (!c) throw new Asn1Error("Unexpected ASN.1 structure");
  return c;
}

export function oid(n: Asn1): string {
  if (n.tag !== TAG.OID) throw new Asn1Error("Expected an OID");
  const v = n.value;
  if (!v.length) throw new Asn1Error("Empty OID");
  const parts: number[] = [Math.floor(v[0]! / 40), v[0]! % 40];
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i]! & 0x7f);
    if (!(v[i]! & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join(".");
}

/** A small non-negative INTEGER as a number (receipt fields, versions). */
export function int(n: Asn1): number {
  if (n.tag !== TAG.INTEGER) throw new Asn1Error("Expected an INTEGER");
  let r = 0;
  for (const b of n.value) r = r * 256 + b;
  return r;
}

export function text(n: Asn1): string {
  return new TextDecoder().decode(octets(n));
}

/** Content of an OCTET STRING, joining the pieces of a constructed (BER) one. */
export function octets(n: Asn1): Uint8Array {
  if (!n.constructed) return n.value;
  const parts = n.children.map(octets);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function time(n: Asn1): Date {
  const s = new TextDecoder().decode(n.value);
  const m = n.tag === TAG.UTC_TIME ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(s);
  if (!m) throw new Asn1Error("Unsupported ASN.1 time");
  let year = Number(m[1]);
  if (n.tag === TAG.UTC_TIME) year += year >= 50 ? 1900 : 2000;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Asn1Error("Not base64");
  const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
