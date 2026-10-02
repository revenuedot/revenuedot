/**
 * A tiny PNG renderer for link-preview images (Verified Metrics, prd/project-settings §4). No canvas, fonts or headless
 * browser exist on Workers, so the image is drawn into an RGB buffer with rectangles, thick lines and a 5×7 pixel font,
 * then encoded as a PNG with the runtime's CompressionStream (zlib "deflate", which PNG's IDAT expects).
 */

type RGB = [number, number, number];
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// 5×7 glyphs, one string of 7 rows per character, "1" = ink. Upper-case letters, digits and the punctuation numbers use.
const GLYPHS: Record<string, string> = {
  A: "01110 10001 10001 11111 10001 10001 10001", B: "11110 10001 10001 11110 10001 10001 11110", C: "01110 10001 10000 10000 10000 10001 01110",
  D: "11110 10001 10001 10001 10001 10001 11110", E: "11111 10000 10000 11110 10000 10000 11111", F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01110 10001 10000 10111 10001 10001 01111", H: "10001 10001 10001 11111 10001 10001 10001", I: "01110 00100 00100 00100 00100 00100 01110",
  J: "00111 00010 00010 00010 00010 10010 01100", K: "10001 10010 10100 11000 10100 10010 10001", L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001", N: "10001 10001 11001 10101 10011 10001 10001", O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000", Q: "01110 10001 10001 10001 10101 10010 01101", R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110", T: "11111 00100 00100 00100 00100 00100 00100", U: "10001 10001 10001 10001 10001 10001 01110",
  V: "10001 10001 10001 10001 10001 01010 00100", W: "10001 10001 10001 10101 10101 10101 01010", X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100", Z: "11111 00001 00010 00100 01000 10000 11111",
  "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110", "2": "01110 10001 00001 00010 00100 01000 11111",
  "3": "11111 00010 00100 00010 00001 10001 01110", "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
  "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000", "8": "01110 10001 10001 01110 10001 10001 01110",
  "9": "01110 10001 10001 01111 00001 00010 01100",
  $: "00100 01111 10100 01110 00101 11110 00100", ".": "00000 00000 00000 00000 00000 01100 01100", ",": "00000 00000 00000 00000 01100 00100 01000",
  "%": "11001 11010 00010 00100 01000 01011 10011", "-": "00000 00000 00000 11111 00000 00000 00000", "+": "00000 00100 00100 11111 00100 00100 00000",
  "/": "00001 00010 00010 00100 01000 01000 10000", ":": "00000 01100 01100 00000 01100 01100 00000", "'": "00100 00100 01000 00000 00000 00000 00000",
  "&": "01100 10010 10100 01000 10101 10010 01101", "(": "00010 00100 01000 01000 01000 00100 00010", ")": "01000 00100 00010 00010 00010 00100 01000",
  "!": "00100 00100 00100 00100 00100 00000 00100", "?": "01110 10001 00001 00010 00100 00000 00100", "#": "01010 01010 11111 01010 11111 01010 01010",
  "_": "00000 00000 00000 00000 00000 00000 11111", " ": "00000 00000 00000 00000 00000 00000 00000",
};
const glyph = (ch: string) => GLYPHS[ch.toUpperCase()] ?? GLYPHS[ch] ?? (/[\p{L}\p{N}]/u.test(ch) ? GLYPHS["?"]! : GLYPHS[" "]!);

export class Raster {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number, bg: RGB) {
    const px = (this.px = new Uint8Array(w * h * 3));
    // One row by hand, then copies that double the filled part (a set() per pixel took hundreds of milliseconds).
    for (let i = 0; i < w * 3; i += 3) { px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; }
    for (let filled = w * 3; filled < px.length; filled *= 2) px.copyWithin(filled, 0, Math.min(filled, px.length - filled));
  }
  rect(x: number, y: number, w: number, h: number, c: RGB) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    const px = this.px, [r, g, b] = c;
    for (let yy = y0; yy < y1; yy++) for (let i = (yy * this.w + x0) * 3, end = (yy * this.w + x1) * 3; i < end; i += 3) { px[i] = r; px[i + 1] = g; px[i + 2] = b; }
  }
  /** A line `t` pixels thick (square brush). */
  line(ax: number, ay: number, bx: number, by: number, t: number, c: RGB) {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let i = 0; i <= steps; i++) this.rect(ax + ((bx - ax) * i) / steps - t / 2, ay + ((by - ay) * i) / steps - t / 2, t, t, c);
  }
  /** Width in pixels of `text` at `scale` (each glyph is 5 wide plus 1 of spacing). */
  static textWidth(text: string, scale: number) { return Math.max(0, [...text].length * 6 * scale - scale); }
  text(x: number, y: number, text: string, scale: number, c: RGB) {
    let cx = x;
    for (const ch of text) {
      const rows = glyph(ch).split(" ");
      rows.forEach((row, ry) => { for (let rx = 0; rx < 5; rx++) if (row[rx] === "1") this.rect(cx + rx * scale, y + ry * scale, scale, scale, c); });
      cx += 6 * scale;
    }
  }
  /** Cuts text so it fits `maxWidth`, ending with "..". */
  static fit(text: string, scale: number, maxWidth: number) {
    const chars = [...text];
    if (Raster.textWidth(text, scale) <= maxWidth) return text;
    while (chars.length && Raster.textWidth(`${chars.join("")}..`, scale) > maxWidth) chars.pop();
    return `${chars.join("").trimEnd()}..`;
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(parts: Uint8Array[]) {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  const t = new TextEncoder().encode(type);
  out.set(t, 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32([t, data]));
  return out;
}
async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(r: Raster): Promise<Uint8Array> {
  const raw = new Uint8Array((r.w * 3 + 1) * r.h);
  for (let y = 0; y < r.h; y++) raw.set(r.px.subarray(y * r.w * 3, (y + 1) * r.w * 3), y * (r.w * 3 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, r.w); dv.setUint32(4, r.h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, deflate, no filter method, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
