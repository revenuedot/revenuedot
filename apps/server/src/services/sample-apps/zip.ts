/**
 * A minimal ZIP writer (stored entries, no compression) for the sample-app download: runs the same on Cloudflare
 * Workers and Node, and keeps Unix modes so `gradlew` stays executable after unzipping.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry { path: string; data: Uint8Array; mode?: number }

export function zip(entries: ZipEntry[], at = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  // MS-DOS date and time (local fields; UTC here so the archive does not depend on the server's zone).
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1);
  const date = ((Math.max(at.getUTCFullYear(), 1980) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path), crc = crc32(e.data), size = e.data.length;
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true); lv.setUint16(12, date, true); lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, (3 << 8) | 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true); cv.setUint16(14, date, true); cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint32(38, (((e.mode ?? 0o644) | 0o100000) << 16) >>> 0, true); cv.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local, e.data); centrals.push(central);
    offset += local.length + size;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}

/** Reads a stored-only archive written by `zip` (tests and the dashboard e2e check the contents with it). */
export function unzip(buf: Uint8Array): Map<string, { data: Uint8Array; mode: number }> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), dec = new TextDecoder(), out = new Map<string, { data: Uint8Array; mode: number }>();
  let e = buf.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip archive");
  let p = v.getUint32(e + 16, true);
  for (let i = 0; i < v.getUint16(e + 10, true); i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory");
    const n = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const size = v.getUint32(p + 24, true), local = v.getUint32(p + 42, true), mode = (v.getUint32(p + 38, true) >>> 16) & 0o777;
    const name = dec.decode(buf.subarray(p + 46, p + 46 + n));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    if (crc32(data) !== v.getUint32(p + 16, true)) throw new Error(`bad checksum: ${name}`);
    out.set(name, { data, mode });
    p += 46 + n + extra + comment;
  }
  return out;
}
