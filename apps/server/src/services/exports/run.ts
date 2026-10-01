import { and, asc, eq, inArray, isNotNull, lt, lte, or } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB, type ExportFile } from "@revenuedot/db";
import { SecretsError, unseal, type SecretKey } from "../secrets.js";
import { encodeFile } from "./files.js";
import { putObject, StorageError, type Destination } from "./storage.js";
import { COLUMNS, readPage, type Cursor, type ExportTable, type Row, type Window } from "./tables.js";

/**
 * Scheduled data exports. The every-minute tick queues a run for each job whose `next_run_at` has passed, then works
 * through queued runs one at a time: each table is read in pages and written as one or more files (PART_ROWS rows each)
 * under `<prefix>/<YYYY-MM-DD>/<table>_<YYYYMMDDTHHMMSSZ>[_partN].<csv.gz|csv|parquet>`.
 * Incremental runs export what changed since the table's previous successful run; a table's first run is always full.
 * A failed upload retries the whole run after 10 and 30 minutes (files are overwritten, so a retry is safe).
 */

const { exportJobs: J, exportRuns: R } = schema;
export const PART_ROWS = 25_000;
const RETRY_MINUTES = [10, 30];
const STALE_MS = 30 * 60_000;

type Job = typeof J.$inferSelect;

/** The first scheduled time strictly after `after`: daily at hour_utc, or weekly on `weekday` (0 = Sunday) at hour_utc. */
export function nextRunAt(job: Pick<Job, "schedule" | "hourUtc" | "weekday">, after: Date): Date {
  const d = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), job.hourUtc, 0, 0));
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
  const due = await db.select().from(J).where(and(eq(J.enabled, true), isNotNull(J.nextRunAt), lte(J.nextRunAt, now))).limit(50);
  for (const job of due) {
    const open = await db.select({ id: R.id }).from(R).where(and(eq(R.jobId, job.id), inArray(R.status, ["queued", "running"]))).limit(1);
    if (!open.length) await db.insert(R).values({ id: newId("exprun_", 14), jobId: job.id, status: "queued", trigger: "schedule", mode: job.mode, windowEnd: job.nextRunAt!, nextAttemptAt: now, createdAt: now });
    await db.update(J).set({ nextRunAt: nextRunAt(job, now) }).where(eq(J.id, job.id));
  }
  return due.length;
}

export interface ExportRuntime { fetch: typeof fetch; now: Date; secretKey: SecretKey | null }

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function objectKey(prefix: string | undefined, table: string, windowEnd: Date, part: number, extension: string) {
  const base = (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return `${base ? `${base}/` : ""}${day(windowEnd)}/${table}_${stamp(windowEnd)}${part > 1 ? `_part${part}` : ""}.${extension}`;
}

/** Works through due runs (one per call unless `limit` says otherwise). Returns how many ran. */
export async function processExportRuns(db: DB, rt: ExportRuntime, limit = 1) {
  const due = await db.select({ id: R.id }).from(R).where(or(
    and(eq(R.status, "queued"), lte(R.nextAttemptAt, rt.now)),
    and(eq(R.status, "running"), lt(R.startedAt, new Date(rt.now.getTime() - STALE_MS))),
  )).orderBy(asc(R.nextAttemptAt)).limit(limit);
  for (const r of due) await runExport(db, r.id, rt);
  return due.length;
}

export async function runExport(db: DB, runId: string, rt: ExportRuntime) {
  const [row] = await db.select({ r: R, j: J }).from(R).innerJoin(J, eq(J.id, R.jobId)).where(eq(R.id, runId));
  if (!row) return;
  const { r: run, j: job } = row;
  const attempts = run.attempts + 1;
  await db.update(R).set({ status: "running", attempts, startedAt: rt.now, error: null }).where(eq(R.id, runId));
  const files: ExportFile[] = [];
  try {
    const secrets = await unseal(job.secrets, rt.secretKey);
    const target = { destination: job.destination as Destination, config: job.destinationConfig, secrets };
    for (const table of job.tables as ExportTable[]) {
      const since = run.mode === "full" || job.cursor[table] === undefined ? null : new Date(job.cursor[table]!);
      const w: Window = { since, until: run.windowEnd, environment: job.environment as Window["environment"] };
      let cursor: Cursor | null = null, part = 0, buffer: Row[] = [];
      const flush = async (final: boolean) => {
        if (!buffer.length && (part > 0 || !final)) return;
        part++;
        const f = await encodeFile(job.format as "csv" | "parquet", job.compression as "gzip" | "none", COLUMNS[table], buffer);
        const key = objectKey(job.destinationConfig.prefix as string | undefined, table, run.windowEnd, part, f.extension);
        await putObject(target, key, f.bytes, f.contentType, rt.fetch, rt.now);
        files.push({ table, key, rows: buffer.length, bytes: f.bytes.length });
        buffer = [];
      };
      do {
        const page = await readPage(db, job.projectId, table, w, cursor);
        buffer.push(...page.rows);
        cursor = page.next;
        if (buffer.length >= PART_ROWS) await flush(false);
      } while (cursor);
      await flush(true);
    }
    const cursorOut = { ...job.cursor };
    for (const t of job.tables) cursorOut[t] = run.windowEnd.getTime();
    await db.update(R).set({ status: "succeeded", files, rows: files.reduce((n, f) => n + f.rows, 0), bytes: files.reduce((n, f) => n + f.bytes, 0), finishedAt: rt.now, error: null }).where(eq(R.id, runId));
    await db.update(J).set({ cursor: cursorOut, lastRunAt: rt.now, consecutiveFailures: 0, lastError: null }).where(eq(J.id, job.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const transient = e instanceof StorageError ? e.transient : !(e instanceof SecretsError);
    const retryIn = transient ? RETRY_MINUTES[attempts - 1] : undefined;
    await db.update(R).set({
      status: retryIn === undefined ? "failed" : "queued", nextAttemptAt: retryIn === undefined ? rt.now : new Date(rt.now.getTime() + retryIn * 60_000),
      error: message.slice(0, 1000), files, finishedAt: retryIn === undefined ? rt.now : null,
    }).where(eq(R.id, runId));
    await db.update(J).set({ consecutiveFailures: job.consecutiveFailures + 1, lastError: message.slice(0, 500) }).where(eq(J.id, job.id));
  }
}
