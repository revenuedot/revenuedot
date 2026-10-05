import { parquetWriteBuffer } from "hyparquet-writer";
import type { ColumnType, Row, Value } from "./tables.js";

/**
 * Export file writers that run on Node and Cloudflare Workers: CSV (RFC 4180, optionally gzip through
 * CompressionStream) and Parquet (hyparquet-writer, pure JavaScript, Snappy compression).
 * CSV times are UTC "YYYY-MM-DD HH:MM:SS" (the format of RevenueCat's exports); Parquet times are TIMESTAMP_MILLIS.
 */

const pad = (n: number) => String(n).padStart(2, "0");
export const csvTime = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function csvCell(v: Value): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? csvTime(v) : typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: [string, ColumnType][], rows: Row[], header = true): string {
  const lines = header ? [columns.map(([n]) => csvCell(n)).join(",")] : [];
  for (const r of rows) lines.push(columns.map(([n]) => csvCell(r[n] ?? null)).join(","));
  return lines.length ? `${lines.join("\r\n")}\r\n` : "";
}

/** Minimal RFC 4180 reader (tests and the dashboard preview): quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

const PARQUET_TYPE: Record<ColumnType, "STRING" | "BOOLEAN" | "INT64" | "DOUBLE" | "TIMESTAMP" | "JSON"> = {
  string: "STRING", bool: "BOOLEAN", int: "INT64", float: "DOUBLE", timestamp: "TIMESTAMP", json: "JSON",
};

export function toParquet(columns: [string, ColumnType][], rows: Row[]): Uint8Array {
  const columnData = columns.map(([name, type]) => ({
    name, type: PARQUET_TYPE[type], nullable: true,
    data: rows.map((r) => {
      const v = r[name] ?? null;
      if (v === null) return null;
      if (type === "int") return BigInt(Math.trunc(Number(v)));
      if (type === "float") return Number(v);
      if (type === "bool") return Boolean(v);
      if (type === "timestamp") return v instanceof Date ? v : new Date(v as string);
      return String(v);
    }),
  }));
  return new Uint8Array(parquetWriteBuffer({ columnData: columnData as never, kvMetadata: [{ key: "writer", value: "RevenueDot data export" }] }));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (b: Uint8Array) => pipe(b, new CompressionStream("gzip"));
export const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream("gzip"));

export interface ExportFileBytes { bytes: Uint8Array; contentType: string; extension: string }

/**
 * A CSV chunk from rows carried over from earlier ticks (`before`, CSV text without a header) and rows read now. The bytes
 * are the same as encoding every row at once: CSV is one line per row, so the text simply concatenates.
 */
export async function encodeCsvChunk(compression: "gzip" | "none", columns: [string, ColumnType][], before: string, rows: Row[], header: boolean): Promise<ExportFileBytes> {
  const text = (header ? toCsv(columns, []) : "") + before + toCsv(columns, rows, false);
  const csv = new TextEncoder().encode(text);
  if (compression === "gzip") return { bytes: await gzip(csv), contentType: "application/gzip", extension: "csv.gz" };
  return { bytes: csv, contentType: "text/csv", extension: "csv" };
}

/** `header: false` leaves out the header row: a later chunk of a single-file CSV (services/exports/upload.ts). */
export async function encodeFile(format: "csv" | "parquet", compression: "gzip" | "none", columns: [string, ColumnType][], rows: Row[], header = true): Promise<ExportFileBytes> {
  if (format === "parquet") return { bytes: toParquet(columns, rows), contentType: "application/vnd.apache.parquet", extension: "parquet" };
  const csv = new TextEncoder().encode(toCsv(columns, rows, header));
  if (compression === "gzip") return { bytes: await gzip(csv), contentType: "application/gzip", extension: "csv.gz" };
  return { bytes: csv, contentType: "text/csv", extension: "csv" };
}
