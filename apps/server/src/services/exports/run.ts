import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { newId } from "@revenuedot/core";
import { schema, type DB, type ExportFile, type ExportProgress } from "@revenuedot/db";
import { SecretsError, unseal, type SecretKey } from "../secrets.js";
import { encodeFile } from "./files.js";
import { putObject, StorageError, type Destination } from "./storage.js";
import { COLUMNS, readPage, type ExportTable, type Row, type Window } from "./tables.js";

/**
 * Scheduled data exports. The every-minute tick queues a run for each job whose `next_run_at` has passed, then works
 * through queued runs: each table is read in pages and written as one or more files (PART_ROWS rows each) under
 * `<prefix>/<YYYY-MM-DD>/<table>_<YYYYMMDDTHHMMSSZ>[_partN].<csv.gz|csv|parquet>`.
 * Incremental runs export what changed since the table's previous successful run; a table's first run is always full.
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
const RETRY_MINUTES = [10, 30];
/** A run claimed by a tick that died (out of CPU or memory) is picked up again after this long. */
const LEASE_MS = 15 * 60_000;
/** Failed uploads plus ticks that died on this run; after that many the run fails. */
const MAX_ATTEMPTS = 3;

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
  const due = await db.select({ id: R.id, status: R.status }).from(R)
    .where(and(inArray(R.status, ["queued", "running"]), lte(R.nextAttemptAt, rt.now))).orderBy(asc(R.nextAttemptAt)).limit(limit);
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
  const fail = async (message: string, transient: boolean) => {
    const attempts = run.attempts + 1;
    const retryIn = transient && attempts < MAX_ATTEMPTS ? RETRY_MINUTES[attempts - 1] : undefined;
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
    const target = { destination: job.destination as Destination, config: job.destinationConfig, secrets, strictUrls: rt.strictUrls };
    const tables = job.tables as ExportTable[];
    let progress: ExportProgress = run.progress ?? { table: 0, cursor: null, part: 0 };
    let wrote = false;
    while (progress.table < tables.length) {
      // Every call writes at least one file, so a run always moves forward however small the budget.
      if (wrote && Date.now() - started >= budgetMs) {
        // Out of time for this tick: carry on from here in the next one, behind runs that are already waiting.
        await db.update(R).set({ status: "queued", nextAttemptAt: rt.now, progress, files }).where(eq(R.id, runId));
        return true;
      }
      const table = tables[progress.table]!;
      const since = run.mode === "full" || job.cursor[table] === undefined ? null : new Date(job.cursor[table]!);
      const w: Window = { since, until: run.windowEnd, environment: job.environment as Window["environment"] };
      // Read up to one file's worth of rows, then write it.
      const buffer: Row[] = [];
      let cursor = progress.cursor;
      do {
        const page = await readPage(db, job.projectId, table, w, cursor);
        buffer.push(...page.rows);
        cursor = page.next;
      } while (cursor && buffer.length < PART_ROWS);
      // An empty table still gets one (header-only) file; a table that ends on a file boundary does not get another.
      if (buffer.length || progress.part === 0) {
        const part = progress.part + 1;
        const f = await encodeFile(job.format as "csv" | "parquet", job.compression as "gzip" | "none", COLUMNS[table], buffer);
        const key = objectKey(job.destinationConfig.prefix as string | undefined, table, run.windowEnd, part, f.extension);
        await putObject(target, key, f.bytes, f.contentType, rt.fetch, rt.now);
        const at = files.findIndex((x) => x.key === key);
        const entry = { table, key, rows: buffer.length, bytes: f.bytes.length };
        if (at >= 0) files[at] = entry; else files.push(entry);
        progress = cursor ? { table: progress.table, cursor, part } : { table: progress.table + 1, cursor: null, part: 0 };
      } else {
        progress = { table: progress.table + 1, cursor: null, part: 0 };
      }
      await db.update(R).set({ progress, files }).where(eq(R.id, runId));
      wrote = true;
    }
    const cursorOut = { ...job.cursor };
    for (const t of job.tables) cursorOut[t] = run.windowEnd.getTime();
    await db.update(R).set({ status: "succeeded", files, progress: null, rows: files.reduce((n, f) => n + f.rows, 0), bytes: files.reduce((n, f) => n + f.bytes, 0), finishedAt: rt.now, nextAttemptAt: rt.now, error: null }).where(eq(R.id, runId));
    await db.update(J).set({ cursor: cursorOut, lastRunAt: rt.now, consecutiveFailures: 0, lastError: null }).where(eq(J.id, job.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Storage errors say whether they are worth retrying; anything else (a key problem, a database error) retries too.
    await fail(message, e instanceof StorageError ? e.transient : true);
    if (!(e instanceof StorageError) && !(e instanceof SecretsError)) console.error(`data export run ${runId} failed`, e);
  }
  return true;
}
