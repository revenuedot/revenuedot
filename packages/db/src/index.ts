import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { sql as q } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync } from "node:fs";
import * as schema from "./schema.js";
import { LOCK_KEYS } from "./locks.js";

export { schema };
export type { DeliveryAttempt } from "./schema.js";
export type { PaywallContent, ExportFile, ExportProgress, ExportUpload, ArchiveFileEntry, ArchiveTableEntry, ArchiveProgress, StorePrice, ExperimentVariant } from "./schema.js";
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

type Journal = { entries: { tag: string; when: number }[] };
const readJournal = (folder: string) => JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as Journal;
const rowsOf = (res: unknown) => (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Record<string, unknown>[];

/** The journal `when` of every migration this database has applied (empty for a new database). */
async function appliedMigrations(db: DB): Promise<Set<number>> {
  const exists = rowsOf(await db.execute(q`select to_regclass('drizzle.__drizzle_migrations') as t`))[0];
  if (!exists?.t) return new Set();
  return new Set(rowsOf(await db.execute(q`select created_at from drizzle.__drizzle_migrations`)).map((r) => Number(r.created_at)));
}

/**
 * drizzle applies only the migrations whose journal `when` is later than the last one applied, so a migration merged
 * after another with a later `when` would be skipped without a word and the server would run on a schema missing its
 * tables. This refuses to migrate instead, naming the migration and the fix.
 */
export async function assertNoSkippedMigrations(db: DB, folder = migrationsFolder) {
  const applied = await appliedMigrations(db);
  if (!applied.size) return;
  const last = Math.max(...applied);
  const skipped = readJournal(folder).entries.filter((e) => e.when <= last && !applied.has(e.when));
  if (skipped.length) {
    throw new Error(`Migration${skipped.length > 1 ? "s" : ""} ${skipped.map((e) => e.tag).join(", ")} would be skipped: ${skipped.length > 1 ? "their" : "its"} journal "when" is not later than the last migration this database applied (${new Date(last).toISOString()}). Give ${skipped.length > 1 ? "them" : "it"} a later "when" in packages/db/migrations/meta/_journal.json.`);
  }
}

/**
 * For a server started without migrating (a separate job migrates): refuses to run on a database that is missing any of
 * this build's migrations, instead of failing later on a missing table or column. A database ahead of the build (a
 * rollback) is fine.
 */
export async function assertMigrated(db: DB, folder = migrationsFolder) {
  const applied = await appliedMigrations(db);
  const missing = readJournal(folder).entries.filter((e) => !applied.has(e.when)).map((e) => e.tag);
  if (missing.length) {
    throw new Error(`The database is missing ${missing.length} migration${missing.length > 1 ? "s" : ""} (${missing.slice(-3).join(", ")}${missing.length > 3 ? ", …" : ""}) and this server was started without migrating (REVENUEDOT_MIGRATE=skip). Run the migration job first: node --import tsx src/migrate.node.ts in apps/server.`);
  }
}

export { LOCK_KEYS };

export interface OpenDbOptions {
  /**
   * Apply pending migrations before returning (default true). Replicas started after a migration Job pass false: they
   * then only check that every migration is applied.
   */
  migrate?: boolean;
  /** Connections in the pool (default DATABASE_POOL_MAX or 10; at least 2, since locks reserve one). Postgres only. */
  max?: number;
  /**
   * In-memory PGlite only: start from this data directory (a `pgliteSnapshot` of a migrated database) instead of an empty
   * one. Tests open about 1,700 databases a run; loading a snapshot is several times faster than migrating each one.
   */
  loadDataDir?: Blob;
}

/** The data directory of an in-memory PGlite database, for `openDb(..., { loadDataDir })`. */
export async function pgliteSnapshot(db: DB): Promise<Blob> {
  return (db as unknown as { $client: PGlite }).$client.dumpDataDir("none");
}

/**
 * Opens the database.
 * - `postgres://...` uses a real Postgres (self-host, cloud). Several servers can open the same database at once:
 *   migrations run under an advisory lock, so the first one migrates and the others wait, then find nothing to do.
 * - `pglite://memory` or unset uses an in-process Postgres (tests); `pglite://./.data/dev` persists to disk (local dev).
 * `sql` is the postgres.js client (Postgres only), for session locks on a reserved connection.
 */
export async function openDb(url = process.env.DATABASE_URL ?? "pglite://memory", opts: OpenDbOptions = {}): Promise<{ db: DB; close: () => Promise<void>; sql?: postgres.Sql }> {
  const migrate = opts.migrate ?? true;
  if (url.startsWith("postgres")) {
    const max = Math.max(2, opts.max ?? (Number(process.env.DATABASE_POOL_MAX) || 10));
    // Migrations re-check the drizzle schema on every start; Postgres NOTICEs about it are noise in self-host logs.
    const sql = postgres(url, { max, prepare: false, onnotice: () => {} });
    const db = drizzlePg(sql, { schema }) as unknown as DB;
    if (migrate) {
      const lock = await sql.reserve();
      try {
        await lock`select pg_advisory_lock(${LOCK_KEYS.migrate}::bigint)`;
        await assertNoSkippedMigrations(db);
        await migratePg(db as never, { migrationsFolder });
      } finally {
        await lock`select pg_advisory_unlock(${LOCK_KEYS.migrate}::bigint)`.catch(() => {});
        lock.release();
      }
    } else {
      await assertMigrated(db).catch(async (e) => { await sql.end({ timeout: 5 }); throw e; });
    }
    return { db, close: () => sql.end({ timeout: 5 }), sql };
  }
  const path = url.replace(/^pglite:\/\//, "");
  if (path !== "memory" && path !== "") mkdirSync(path, { recursive: true });
  const memory = path === "memory" || path === "";
  const client = memory ? new PGlite(opts.loadDataDir ? { loadDataDir: opts.loadDataDir } : {}) : new PGlite(path);
  const db = drizzlePglite(client, { schema }) as unknown as DB;
  if (migrate) {
    await assertNoSkippedMigrations(db);
    await migratePglite(db as never, { migrationsFolder });
  } else {
    await assertMigrated(db).catch(async (e) => { await client.close(); throw e; });
  }
  return { db, close: () => client.close() };
}
