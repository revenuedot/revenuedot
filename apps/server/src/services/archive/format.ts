import { fromBase64, toBase64 } from "../signing.js";

/**
 * Archive bytes (prd/moves-export/PRD.md §1): gzip JSON Lines, checksums, passphrase encryption and a tar writer.
 * WebCrypto and Compression Streams only, so the same code runs on Node and Cloudflare Workers.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (b: Uint8Array) => pipe(b, new CompressionStream("gzip"));
export const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream("gzip"));

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256(b: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", (typeof b === "string" ? enc.encode(b) : b) as Uint8Array<ArrayBuffer>));
}
export const sha256Hex = async (b: Uint8Array | string) => hex(await sha256(b));

const MOD = 1n << 256n;
export const ZERO_SUM = "0".repeat(64);

/**
 * A table's checksum: the sum, modulo 2^256, of the SHA-256 of every row line. The order of rows and the way they are
 * split into files do not change it, so an export spread over many ticks and a target that re-reads its own rows in
 * other pages arrive at the same value.
 */
export async function addRows(sum: string, lines: string[]): Promise<string> {
  let s = BigInt(`0x${sum}`);
  for (const l of lines) s = (s + BigInt(`0x${hex(await sha256(l))}`)) % MOD;
  return s.toString(16).padStart(64, "0");
}

/** Two table checksums added (rows split between two sets, such as rows loaded and rows left out). */
export const addSums = (a: string, b: string) => ((BigInt(`0x${a}`) + BigInt(`0x${b}`)) % MOD).toString(16).padStart(64, "0");

export const linesToBytes = (lines: string[]) => enc.encode(lines.length ? `${lines.join("\n")}\n` : "");
export const bytesToLines = (b: Uint8Array) => dec.decode(b).split("\n").filter((l) => l.length > 0);

/* ---- Passphrase encryption of the secrets files ---- */

export const KDF_ITERATIONS = 100_000; // The most PBKDF2 rounds Cloudflare Workers allow.

export interface Kdf { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string }

export async function passphraseKey(passphrase: string, kdf: Kdf): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64(kdf.salt), iterations: kdf.iterations }, base, 256));
}

export const newKdf = (): Kdf => ({ name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) });

const aes = (raw: Uint8Array) => crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

/** A secrets file: { iv, data } JSON, AES-256-GCM with the passphrase-derived key. */
export async function encryptJson(raw: Uint8Array, value: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(raw), enc.encode(JSON.stringify(value))));
  return enc.encode(JSON.stringify({ alg: "A256GCM", iv: toBase64(iv), data: toBase64(ct) }));
}

export class PassphraseError extends Error {}

export async function decryptJson<T>(raw: Uint8Array, file: Uint8Array): Promise<T> {
  let box: { iv: string; data: string };
  try { box = JSON.parse(dec.decode(file)); } catch { throw new PassphraseError("The secrets file is damaged."); }
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(box.iv) }, await aes(raw), fromBase64(box.data));
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    throw new PassphraseError("The export passphrase is wrong: the secrets could not be decrypted.");
  }
}

/** A random passphrase (for moves, where the CLI or server holds it in memory and never shows it). */
export const randomPassphrase = () => toBase64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "x");

/* ---- tar ---- */

function header(name: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, off: number, len: number) => { const b = enc.encode(s); h.set(b.subarray(0, len), off); };
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  if (enc.encode(name).length > 100) {
    // ustar prefix field for long names.
    const cut = name.lastIndexOf("/", 155);
    put(name.slice(cut + 1), 0, 100);
    put(name.slice(0, cut), 345, 155);
  } else put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\u000000", 257, 8);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

/** Streams a tar of the given files, reading each one only when its turn comes. */
export function tarStream(files: { name: string; size: number; read: () => Promise<Uint8Array> }[], mtime: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (i >= files.length) { ctl.enqueue(new Uint8Array(1024)); ctl.close(); return; }
      const f = files[i++]!;
      const data = await f.read();
      ctl.enqueue(header(f.name, data.length, mtime));
      ctl.enqueue(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) ctl.enqueue(new Uint8Array(pad));
    },
  });
}

/** Reads a tar into name → bytes (the CLI's `--from-archive`, tests). */
export function untar(b: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let off = 0;
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const str = (o: number, l: number) => dec.decode(h.subarray(o, o + l)).replace(/\0.*$/s, "");
    const prefix = str(345, 155);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const size = parseInt(str(124, 12).trim() || "0", 8);
    out.set(name, b.slice(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
