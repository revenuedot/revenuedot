import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB, type ExportFile, type ExportProgress, type ExportUpload } from "@revenuedot/db";
import { SecretsError, unseal, type SecretKey } from "../secrets.js";
import { notMoving } from "../archive/moving.js";
import { encodeCsvChunk, encodeFile, gunzip, gzip, toCsv } from "./files.js";
import { abortMultipart, putObject, StorageError, type Destination } from "./storage.js";
import { addChunk, finishUpload, newUpload, stagedBytes, stagingKey, type UploadContext } from "./upload.js";
import { dbStore } from "../archive/store.js";
import { COLUMNS, columnsFor, PAGE, readPage, type ExportTable, type Row, type Window } from "./tables.js";
import { emailFileKey, emailJobPrefix, sendExportEmail } from "./email.js";
import type { ArchiveStore } from "../archive/store.js";
import type { Mailer } from "../../mail/index.js";

/**
 * Scheduled data exports. The every-minute tick queues a run for each job whose `next_run_at` has passed, then works
 * through queued runs: each table is read in chunks of PART_ROWS rows and written, with the job's chosen columns, as one
 * CSV file per table (the default, written in pieces across ticks: services/exports/upload.ts) or as one file per chunk
 * (Parquet, and CSV with `split_files`) under `<prefix>/<YYYY-MM-DD>/<table>_<YYYYMMDDTHHMMSSZ>[_partN].<csv.gz|csv|parquet>`.
 * Incremental runs export what changed since the table's previous successful run; a table's first run is always full.
 * Email exports keep the files in RevenueDot's file store and, once every file is written, email the download links.
 *
 * Work per tick is bounded, because a Worker has little CPU time and memory: a run writes files until the tick's time
 * budget is spent, saves where it stopped (`progress`: table, page cursor, part number) after every file, and goes
 * back in the queue; the next tick carries on from there. A run is claimed with a lease on next_attempt_at, so two ticks
 * never work on it at once, and a tick that dies mid-file leaves the lease to expire; after MAX_ATTEMPTS such deaths
 * or failures the run fails instead of looping. A failed upload retries after 10 and 30 minutes (files are
 * overwritten, so a retry is safe).
 */

const { exportJobs: J, exportRuns: R } = schema;
export const PART_ROWS = 10_000;
/** Rows read per page before the read time is known, and the fewest a page asks for once it is. */
export const START_PAGE_ROWS = 2_000;
const MIN_PAGE_ROWS = 200;
const RETRY_MINUTES = [10, 30];
/** A run claimed by a tick that died (out of CPU or memory) is picked up again after this long. */
const LEASE_MS = 15 * 60_000;
/** Failed uploads plus ticks that died on this run; after that many the run fails. */
const MAX_ATTEMPTS = 3;

type Job = typeof J.$inferSelect;

export const INTERVAL_HOURS = [4, 6, 8, 12] as const;

/**
 * The first scheduled time strictly after `after`: daily at hour_utc, weekly on `weekday` (0 = Sunday) at hour_utc, or
 * every `interval_hours` hours (4, 6, 8 or 12) at hour_utc and every interval from it (hour 3 every 6 hours: 03, 09, 15, 21).
 */
export function nextRunAt(job: Pick<Job, "schedule" | "hourUtc" | "weekday"> & { intervalHours?: number | null }, after: Date): Date {
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), job.hourUtc, 0, 0));
  if (job.schedule === "interval") {
    // Only divisors of 24 keep the grid on hour_utc every day; anything else (0 would loop forever) falls back to 6.
    const step = ((INTERVAL_HOURS as readonly number[]).includes(job.intervalHours ?? 0) ? job.intervalHours! : 6) * 3_600_000;
    let t = d.getTime() - 86_400_000;
    while (t <= after.getTime()) t += step;
    return new Date(t);
  }
  if (job.schedule === "weekly") {
    const wd = job.weekday ?? 1;
    d.setUTCDate(d.getUTCDate() + ((wd - d.getUTCDay() + 7) % 7));
    while (d <= after) d.setUTCDate(d.getUTCDate() + 7);
    return d;
  }
  while (d <= after) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** Queues a run for every enabled job that is due, and moves the job's next_run_at forward. */
export async function queueDueExports(db: DB, now: Date) {
  const due = await db.select().from(J).where(and(eq(J.enabled, true), isNotNull(J.nextRunAt), lte(J.nextRunAt, now), notMoving(J.projectId))).limit(50);
  for (const job of due) {
    // Move next_run_at first, only if no other tick did: the tick that wins queues the run.
    const [won] = await db.update(J).set({ nextRunAt: nextRunAt(job, now) }).where(and(eq(J.id, job.id), eq(J.nextRunAt, job.nextRunAt!))).returning({ id: J.id });
    if (!won) continue;
    const starts = job.tables.map((t) => job.cursor[t]);
    const windowStart = job.mode === "full" || starts.some((x) => x === undefined) ? null : new Date(Math.min(...(starts as number[])));
    // Same job row lock as the manual run route, so the two cannot both queue a run.
    await db.transaction(async (tx) => {
      await tx.select({ id: J.id }).from(J).where(eq(J.id, job.id)).for("update");
      const open = await tx.select({ id: R.id }).from(R).where(and(eq(R.jobId, job.id), inArray(R.status, ["queued", "running"]))).limit(1);
      if (open.length) return;
      await tx.insert(R).values({ id: newId("exprun_", 14), jobId: job.id, status: "queued", trigger: "schedule", mode: job.mode, windowStart, windowEnd: job.nextRunAt!, nextAttemptAt: now, createdAt: now });
    });
  }
  return due.length;
}

export interface ExportRuntime {
  fetch: typeof fetch;
  now: Date;
  secretKey: SecretKey | null;
  /** RevenueDot Cloud: refuse bucket endpoints on private networks (services/outbound.ts). */
  strictUrls?: boolean;
  /** No new file starts after this many milliseconds (default 20 s). */
  budgetMs?: number;
  /** Rows per page, fixed (tests); by default pages are sized from the measured time per row. */
  pageRows?: number;
  /** Single-file CSV: the smallest piece sent before the last (default 5 MiB, S3's and GCS's minimum part size). */
  minPartBytes?: number;
  /** Email exports: where RevenueDot keeps the files, who sends the links, the origin the links use and what signs them. */
  store?: ArchiveStore;
  mailer?: Mailer;
  publicUrl?: string;
  linkMaterial?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function objectKey(prefix: string | undefined, table: string, windowEnd: Date, part: number, extension: string) {
  const base = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return `${base ? `${base}/` : ""}${day(windowEnd)}/${table}_${stamp(windowEnd)}${part > 1 ? `_part${part}` : ""}.${extension}`;
}

/** Works on due runs until the time budget is spent (at most `limit` runs). Returns how many it worked on. */
export async function processExportRuns(db: DB, rt: ExportRuntime, limit = 5) {
  const started = Date.now();
  const budget = rt.budgetMs ?? 20_000;
  const due = await db.select({ id: R.id, status: R.status }).from(R).innerJoin(J, eq(J.id, R.jobId))
    .where(and(inArray(R.status, ["queued", "running"]), lte(R.nextAttemptAt, rt.now), notMoving(J.projectId))).orderBy(asc(R.nextAttemptAt)).limit(limit);
  let worked = 0;
  for (const r of due) {
    const left = budget - (Date.now() - started);
    if (left <= 0) break;
    try {
      if (await runExport(db, r.id, rt, left)) worked++;
    } catch (e) {
      console.error(`data export run ${r.id} failed`, e);
    }
  }
  return worked;
}

/**
 * Works on one run for up to `budgetMs`: claims it, writes files from where it stopped, and then either finishes it
 * or queues it again to carry on in the next tick. Returns false when another tick holds the run.
 */
export async function runExport(db: DB, runId: string, rt: ExportRuntime, budgetMs = rt.budgetMs ?? 20_000): Promise<boolean> {
  const started = Date.now();
  const [row] = await db.select({ r: R, j: J }).from(R).innerJoin(J, eq(J.id, R.jobId)).where(eq(R.id, runId));
  if (!row) return false;
  const { j: job } = row;
  // A run found "running" with its lease expired was left by a tick that died: that counts as a failed attempt.
  const died = row.r.status === "running";
  const [run] = await db.update(R).set({
    status: "running", nextAttemptAt: new Date(rt.now.getTime() + LEASE_MS), startedAt: row.r.startedAt ?? rt.now, error: null,
    ...(died ? { attempts: sql`${R.attempts} + 1` } : {}),
  }).where(and(eq(R.id, runId), eq(R.status, row.r.status), lte(R.nextAttemptAt, rt.now))).returning();
  if (!run) return false;
  const files: ExportFile[] = [...run.files];
  const store = rt.store ?? dbStore(db);
  // Beside the run's email files (`<job>/<run id>/<key>`), never under them: a job prefix such as "staging/0" cannot reach it.
  const runStaging = `${emailJobPrefix(job.projectId, job.id)}staging/${run.id}/`;
  let target: Parameters<typeof abortMultipart>[0] | null = null;
  // The upload being written, with an upload ID created in this tick too.
  let live: ExportUpload | undefined = run.progress?.upload;
  const fail = async (message: string, transient: boolean) => {
    const attempts = run.attempts + 1;
    const retryIn = transient && attempts < MAX_ATTEMPTS ? RETRY_MINUTES[attempts - 1] : undefined;
    if (retryIn === undefined) {
      // The run is over: drop a half-written upload and the bytes staged for it.
      if (live?.uploadId && target && target.destination === live.destination) await abortMultipart(target, live.key, live.uploadId, rt.fetch, rt.now);
      await store.deletePrefix(runStaging).catch(() => undefined);
    }
    await db.update(R).set({
      status: retryIn === undefined ? "failed" : "queued", attempts, nextAttemptAt: retryIn === undefined ? rt.now : new Date(rt.now.getTime() + retryIn * 60_000),
      error: message.slice(0, 1000), files, finishedAt: retryIn === undefined ? rt.now : null,
    }).where(eq(R.id, runId));
    await db.update(J).set({ consecutiveFailures: sql`${J.consecutiveFailures} + 1`, lastError: message.slice(0, 500) }).where(eq(J.id, job.id));
  };
  if (died && run.attempts >= MAX_ATTEMPTS) {
    await fail("The export stopped before it finished several times (the server ran out of time or memory). Export fewer tables, or contact support.", false);
    return true;
  }
  try {
    const secrets = await unseal(job.secrets, rt.secretKey);
    target = { destination: job.destination as Destination, config: job.destinationConfig, secrets, strictUrls: rt.strictUrls };
    const tables = job.tables as ExportTable[];
    let progress: ExportProgress = run.progress ?? { table: 0, cursor: null, part: 0 };
    // Whether this tick has moved the run forward: a tick always reads or writes something, however small its budget.
    let moved = false;
    const pace: NonNullable<ExportProgress["pace"]> = { ...(run.progress?.pace ?? {}) };
    // Bytes staged for the current single-file chunk, kept in memory between chunks of this tick.
    let held: { table: number; chunk: number; bytes: Uint8Array } | null = null;
    while (progress.table < tables.length) {
      // Every call reads or writes something first, so a run always moves forward however small the budget.
      if (moved && Date.now() - started >= budgetMs) {
        // Out of time for this tick: carry on from here in the next one, behind runs that are already waiting.
        await db.update(R).set({ status: "queued", nextAttemptAt: rt.now, progress: { ...progress, pace }, files }).where(eq(R.id, runId));
        return true;
      }
      const table = tables[progress.table]!;
      const since = run.mode === "full" || job.cursor[table] === undefined ? null : new Date(job.cursor[table]!);
      const w: Window = { since, until: run.windowEnd, environment: job.environment as Window["environment"] };
      // Read up to one file's worth of rows, then write it.
      let cursor = progress.cursor;
      const columns = columnsFor(table, job.columns[table]);
      const csv = job.format === "csv";
      // Rows a tick read for this chunk before it ran out of time: CSV text (without the header) for CSV, rows for Parquet.
      const carried = progress.buffered ? await loadCarried(store, rowsKey(runStaging, progress.table, progress.buffered.seq), table, csv) : { text: "", rows: [] as Row[] };
      if (progress.buffered && csv && progress.buffered.columns !== columns.map(([n]) => n).join(",")) {
        throw new StorageError("The export's columns changed while it was running. Run the export again.", false);
      }
      const carriedRows = csv ? progress.buffered?.rows ?? 0 : 0;
      const buffer: Row[] = carried.rows;
      const chunkRows = () => carriedRows + buffer.length;
      // A single file whose pieces are all sent only needs completing.
      if (!progress.upload?.sent) {
        // A new chunk always reads once (an empty table still gets its header-only file).
        let first = !progress.buffered;
        while ((first || cursor) && chunkRows() < PART_ROWS) {
          // Pages are sized from the measured time per row so a tick stays within its budget: a chunk is still exactly
          // PART_ROWS rows (the file's bytes do not depend on how it was read), but it may be read over several ticks.
          const left = budgetMs - (Date.now() - started);
          const rate = pace.msPerRow;
          // After the page: writing the chunk it completes, or, when it does not, keeping the rows for the next tick or
          // writing the last chunk if the page turns out to end the table.
          const tail = Math.max(pace.chunkMs ?? 0, pace.stashMs ?? 0);
          // Never more than PAGE rows: a page also loads every transaction and subscription of its customers.
          const sized = rate ? Math.min(PAGE, Math.max(MIN_PAGE_ROWS, Math.floor(((left - (moved ? tail : 0)) * 0.6) / rate))) : START_PAGE_ROWS;
          const n = Math.min(PART_ROWS - chunkRows(), rt.pageRows ?? sized);
          const predicted = (rate ?? 0) * n + (chunkRows() + n >= PART_ROWS ? pace.chunkMs ?? 0 : tail);
          if (moved && Date.now() - started + predicted > budgetMs) {
            // Not enough time left for this page: keep what was read and carry on in the next tick.
            const seq = (progress.buffered?.seq ?? 0) + 1;
            const old = progress.buffered;
            const stashStarted = Date.now();
            const total = chunkRows();
            if (total) {
              await store.put(rowsKey(runStaging, progress.table, seq), await gzip(new TextEncoder().encode(csv ? carried.text + toCsv(columns, buffer, false) : JSON.stringify(buffer))));
            }
            pace.stashMs = Math.max(Date.now() - stashStarted, (pace.stashMs ?? 0) * 0.8);
            progress = { ...progress, cursor, ...(total ? { buffered: { seq, rows: total, ...(csv ? { columns: columns.map(([n]) => n).join(",") } : {}) } } : { buffered: undefined }) };
            await db.update(R).set({ status: "queued", nextAttemptAt: rt.now, progress: { ...progress, pace }, files }).where(eq(R.id, runId));
            if (old) await store.deletePrefix(rowsKey(runStaging, progress.table, old.seq));
            return true;
          }
          const t0 = Date.now();
          const page = await readPage(db, job.projectId, table, w, cursor, n);
          // An empty page (the end of a table) says nothing about the time per row.
          if (page.rows.length) {
            const per = (Date.now() - t0) / page.rows.length;
            pace.msPerRow = rate ? rate * 0.5 + per * 0.5 : per;
          }
          buffer.push(...page.rows);
          cursor = page.next;
          first = false;
          moved = true;
        }
      }
      // Writing a chunk (encoding and uploading) is timed too, so a tick does not start reading one it cannot finish.
      const chunkStarted = Date.now();
      const wroteChunk = () => {
        const ms = Date.now() - chunkStarted;
        // A slowly fading maximum: writing gets slower as the staged bytes grow, and underestimating it overruns the tick.
        pace.chunkMs = Math.max(ms, (pace.chunkMs ?? 0) * 0.8);
        moved = true;
      };
      // One CSV file per table unless split (a run that started split stays split).
      const single = !!progress.upload || (progress.part === 0 && job.format === "csv" && !job.splitFiles);
      if (single) {
        const up: ExportUpload = progress.upload
          ? { ...progress.upload }
          : newUpload(objectKey(job.destinationConfig.prefix as string | undefined, table, run.windowEnd, 1, job.compression === "gzip" ? "csv.gz" : "csv"), job.compression === "gzip" ? "application/gzip" : "text/csv", job.destination);
        live = up;
        // Pieces already went to the destination the run started with; a changed destination cannot carry on the file.
        if (up.destination && up.destination !== job.destination) throw new StorageError("The export's destination changed while it was running. Run the export again.", false);
        // The compression and key the file started with, even if the job changed since.
        const gz = up.contentType === "application/gzip";
        const stagingPrefix = `${runStaging}${progress.table}/`;
        const ctx: UploadContext = {
          target, store, stagingPrefix, emailKey: job.destination === "email" ? emailFileKey(job.projectId, job.id, run.id, up.key) : undefined,
          fetch: rt.fetch, now: rt.now, minPart: rt.minPartBytes,
        };
        if (!up.sent) {
          const before = { chunks: up.chunks, staged: up.staged };
          const pending = held && held.table === progress.table && held.chunk === up.chunks ? held.bytes : await stagedBytes(ctx, up);
          const done = !cursor;
          const chunk = chunkRows() || up.chunks === 0 ? (await encodeCsvChunk(gz ? "gzip" : "none", columns, carried.text, buffer, up.chunks === 0)).bytes : new Uint8Array();
          const waiting = await addChunk(ctx, up, pending, chunk, chunkRows(), done);
          if (waiting.length) await store.put(stagingKey(stagingPrefix, up.chunks), waiting);
          up.staged = waiting.length;
          held = { table: progress.table, chunk: up.chunks, bytes: waiting };
          if (!done || up.sent) {
            // Saved before completing, so a retry completes the upload instead of sending parts to a finished one.
            progress = { table: progress.table, cursor: done ? null : cursor, part: 1, upload: up };
            await db.update(R).set({ progress: { ...progress, pace }, files }).where(eq(R.id, runId));
            // The previous chunk's staged bytes are no longer needed once progress points past them.
            if (before.staged && before.chunks !== up.chunks) await store.deletePrefix(stagingKey(stagingPrefix, before.chunks));
          }
          if (!done) { wroteChunk(); continue; }
        }
        if (up.sent) await finishUpload(ctx, up);
        const entry: ExportFile = { table, key: up.key, rows: up.rows, bytes: up.bytes, ...(job.destination === "email" && up.pieces ? { chunks: up.pieces } : {}) };
        const at = files.findIndex((x) => x.key === up.key);
        if (at >= 0) files[at] = entry; else files.push(entry);
        progress = { table: progress.table + 1, cursor: null, part: 0 };
        live = undefined;
        await db.update(R).set({ progress: { ...progress, pace }, files }).where(eq(R.id, runId));
        await store.deletePrefix(stagingPrefix);
        wroteChunk();
        continue;
      }
      // An empty table still gets one (header-only) file; a table that ends on a file boundary does not get another.
      if (chunkRows() || progress.part === 0) {
        const part = progress.part + 1;
        const f = csv ? await encodeCsvChunk(job.compression as "gzip" | "none", columns, carried.text, buffer, true) : await encodeFile("parquet", "none", columns, buffer);
        const key = objectKey(job.destinationConfig.prefix as string | undefined, table, run.windowEnd, part, f.extension);
        if (job.destination === "email") {
          if (!rt.store) throw new Error("No file store is configured for email exports.");
          await rt.store.put(emailFileKey(job.projectId, job.id, run.id, key), f.bytes);
        } else {
          await putObject(target, key, f.bytes, f.contentType, rt.fetch, rt.now);
        }
        const at = files.findIndex((x) => x.key === key);
        const entry = { table, key, rows: chunkRows(), bytes: f.bytes.length };
        if (at >= 0) files[at] = entry; else files.push(entry);
        progress = cursor ? { table: progress.table, cursor, part } : { table: progress.table + 1, cursor: null, part: 0 };
      } else {
        progress = { table: progress.table + 1, cursor: null, part: 0 };
      }
      await db.update(R).set({ progress: { ...progress, pace }, files }).where(eq(R.id, runId));
      wroteChunk();
    }
    let notifiedAt: Date | null = run.notifiedAt;
    if (job.destination === "email" && !notifiedAt) {
      const n = await sendExportEmail({ db, mailer: rt.mailer, publicUrl: rt.publicUrl ?? "http://localhost:8787", linkMaterial: rt.linkMaterial, now: rt.now }, job, { id: run.id, files });
      if (n.recipients === 0) throw new StorageError("None of the export's recipients is a member of the project any more. Add a recipient who is.", false);
      if (n.sent === 0) throw new StorageError("The email with the download links could not be sent.", true);
      notifiedAt = rt.now;
      // Saved at once, so a failure below (and the retry it causes) does not email the links a second time.
      await db.update(R).set({ notifiedAt }).where(eq(R.id, runId));
    }
    const cursorOut = { ...job.cursor };
    for (const t of job.tables) cursorOut[t] = run.windowEnd.getTime();
    await store.deletePrefix(`${runStaging}rows/`);
    await db.update(R).set({ status: "succeeded", files, progress: null, notifiedAt, rows: files.reduce((n, f) => n + f.rows, 0), bytes: files.reduce((n, f) => n + f.bytes, 0), finishedAt: rt.now, nextAttemptAt: rt.now, error: null }).where(eq(R.id, runId));
    await db.update(J).set({ cursor: cursorOut, lastRunAt: rt.now, consecutiveFailures: 0, lastError: null }).where(eq(J.id, job.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Storage errors say whether they are worth retrying; anything else (a key problem, a database error) retries too.
    await fail(message, e instanceof StorageError ? e.transient : true);
    if (!(e instanceof StorageError) && !(e instanceof SecretsError)) console.error(`data export run ${runId} failed`, e);
  }
  return true;
}

/** Where a tick keeps the rows it read for an unfinished chunk. */
const rowsKey = (runStaging: string, table: number, seq: number) => `${runStaging}rows/${table}/${String(seq).padStart(7, "0")}`;

/** Reads what a tick kept for an unfinished chunk (gzip): CSV text, or JSON rows with their timestamps as dates again (Parquet). */
async function loadCarried(store: ArchiveStore, key: string, table: ExportTable, csv: boolean): Promise<{ text: string; rows: Row[] }> {
  const bytes = await store.get(key);
  if (!bytes) throw new StorageError("Rows read in an earlier tick went missing from RevenueDot's file store. Run the export again.", false);
  const text = new TextDecoder().decode(await gunzip(bytes));
  if (csv) return { text, rows: [] };
  const times = COLUMNS[table].filter(([, t]) => t === "timestamp").map(([n]) => n);
  return {
    text: "",
    rows: (JSON.parse(text) as Row[]).map((r) => {
      for (const n of times) if (typeof r[n] === "string") r[n] = new Date(r[n] as string);
      return r;
    }),
  };
}
