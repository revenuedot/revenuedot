import type { ExportUpload } from "@revenuedot/db";
import type { ArchiveStore } from "../archive/store.js";
import { completeMultipart, createMultipart, headObjectSize, MIN_PART_BYTES, putBlock, putBlockList, putObject, StorageError, uploadPart, type StorageTarget } from "./storage.js";

/**
 * Single-file CSV exports, as RevenueCat writes them. Rows are encoded in chunks of 10,000; a gzip chunk is a gzip
 * member, and concatenated members are one valid gzip file (plain CSV chunks concatenate too; only the first has the
 * header). A file that fits in one chunk is uploaded with one plain PUT. A bigger one is sent in pieces of at least
 * `minPart` bytes: S3, R2 and GCS multipart upload parts, Azure blocks, or pieces RevenueDot keeps for an email export
 * (the download link serves them in order as one file). Bytes not yet enough for a piece wait in RevenueDot's file
 * store under the chunk's number, so a tick that dies never loses or repeats them: progress and the staged bytes
 * always describe the same chunk. R2 wants every part but the last to be the same size, so R2 parts are exactly
 * `minPart` bytes. Once the last piece is sent, progress records it (`sent`) before the upload is completed, so a tick
 * that dies after completing does not send parts to an upload that is already finished.
 */

export interface UploadContext {
  target: StorageTarget;
  store: ArchiveStore;
  /** Where staged bytes wait: `<prefix><chunk number>`. */
  stagingPrefix: string;
  /** Email exports: the key the whole file is kept under. */
  emailKey?: string;
  fetch: typeof fetch;
  now: Date;
  minPart?: number;
}

export const newUpload = (key: string, contentType: string, destination: string): ExportUpload => ({ key, contentType, destination, chunks: 0, rows: 0, bytes: 0, staged: 0, pieces: 0 });
export const stagingKey = (prefix: string, chunk: number) => `${prefix}${String(chunk).padStart(7, "0")}.bin`;
export const emailPieceKey = (fileKey: string, n: number) => `${fileKey}.piece${String(n).padStart(5, "0")}`;

const concat = (a: Uint8Array, b: Uint8Array) => {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
};

/** Reads the bytes staged for the upload's current chunk (none when nothing is staged). */
export async function stagedBytes(ctx: UploadContext, up: ExportUpload): Promise<Uint8Array> {
  if (!up.staged) return new Uint8Array();
  const b = await ctx.store.get(stagingKey(ctx.stagingPrefix, up.chunks));
  if (!b || b.length !== up.staged) throw new StorageError("Part of the file being written went missing from RevenueDot's file store. Run the export again.", false);
  return b;
}

async function sendPiece(ctx: UploadContext, up: ExportUpload, bytes: Uint8Array): Promise<void> {
  const n = up.pieces + 1;
  const d = ctx.target.destination;
  if (d === "email") await ctx.store.put(emailPieceKey(ctx.emailKey!, n), bytes);
  else if (d === "azure") await putBlock(ctx.target, up.key, n, bytes, ctx.fetch, ctx.now);
  else {
    up.uploadId ??= await createMultipart(ctx.target, up.key, up.contentType, ctx.fetch, ctx.now);
    const etag = await uploadPart(ctx.target, up.key, up.uploadId, n, bytes, ctx.fetch, ctx.now);
    up.etags = [...(up.etags ?? []).slice(0, n - 1), etag];
  }
  up.pieces = n;
}

/**
 * Adds one encoded chunk (`chunk`, `rows` rows) to the file. `pending` is what was staged before it. With `done` every
 * byte is sent; a multipart upload or block list is then marked `sent` and still needs `finishUpload` (after the caller
 * saves progress). Returns the bytes still waiting for a piece; the caller stages them under the new chunk number before
 * saving progress. Updates `up` in place.
 */
export async function addChunk(ctx: UploadContext, up: ExportUpload, pending: Uint8Array, chunk: Uint8Array, rows: number, done: boolean): Promise<Uint8Array> {
  let waiting = concat(pending, chunk);
  if (chunk.length) up.chunks++;
  up.rows += rows;
  up.bytes += chunk.length;
  const min = ctx.minPart ?? MIN_PART_BYTES;
  const d = ctx.target.destination;
  if (done && up.pieces === 0) {
    // The whole file is here: one plain upload.
    if (d === "email") await ctx.store.put(ctx.emailKey!, waiting);
    else await putObject(ctx.target, up.key, waiting, up.contentType, ctx.fetch, ctx.now);
    return new Uint8Array();
  }
  while (waiting.length >= min) {
    const size = d === "r2" ? min : waiting.length;
    await sendPiece(ctx, up, waiting.subarray(0, size));
    waiting = waiting.subarray(size);
  }
  if (done && waiting.length) {
    await sendPiece(ctx, up, waiting);
    waiting = new Uint8Array();
  }
  if (done && d !== "email") up.sent = true;
  // A copy, so the staged bytes do not keep the whole concatenated buffer alive.
  return waiting.slice();
}

/** Completes a file whose pieces are all sent (`up.sent`). Safe to call again after a tick died once it was complete. */
export async function finishUpload(ctx: UploadContext, up: ExportUpload): Promise<void> {
  if (ctx.target.destination === "azure") return putBlockList(ctx.target, up.key, up.pieces, up.contentType, ctx.fetch, ctx.now);
  try {
    await completeMultipart(ctx.target, up.key, up.uploadId!, up.etags!.map((etag, i) => ({ n: i + 1, etag })), ctx.fetch, ctx.now);
  } catch (e) {
    // NoSuchUpload: an earlier attempt completed it (and died before saving that). The object is there with every byte.
    if (e instanceof StorageError && e.status === 404 && await headObjectSize(ctx.target, up.key, ctx.fetch, ctx.now) === up.bytes) return;
    throw e;
  }
}
