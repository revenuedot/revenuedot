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

export { schema };
export type { PaywallContent, ExportFile, ExportProgress, ArchiveFileEntry, ArchiveTableEntry, ArchiveProgress } from "./schema.js";
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * drizzle applies only the migrations whose journal `when` is later than the last one applied, so a migration merged
 * after another with a later `when` would be skipped without a word and the server would run on a schema missing its
 * tables. This refuses to migrate instead, naming the migration and the fix.
 */
export async function assertNoSkippedMigrations(db: DB, folder = migrationsFolder) {
  const exists = await db.execute(q`select to_regclass('drizzle.__drizzle_migrations') as t`);
  const first = (Array.isArray(exists) ? exists : (exists as { rows: unknown[] }).rows)[0] as { t: unknown } | undefined;
  if (!first?.t) return;
  const res = await db.execute(q`select created_at from drizzle.__drizzle_migrations`);
  const applied = new Set((Array.isArray(res) ? res : (res as { rows: unknown[] }).rows).map((r) => Number((r as { created_at: unknown }).created_at)));
  if (!applied.size) return;
  const last = Math.max(...applied);
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as { entries: { tag: string; when: number }[] };
  const skipped = journal.entries.filter((e) => e.when <= last && !applied.has(e.when));
  if (skipped.length) {
    throw new Error(`Migration${skipped.length > 1 ? "s" : ""} ${skipped.map((e) => e.tag).join(", ")} would be skipped: ${skipped.length > 1 ? "their" : "its"} journal "when" is not later than the last migration this database applied (${new Date(last).toISOString()}). Give ${skipped.length > 1 ? "them" : "it"} a later "when" in packages/db/migrations/meta/_journal.json.`);
  }
}

/**
 * Opens the database.
 * - `postgres://...` uses a real Postgres (self-host, cloud).
 * - `pglite://memory` or unset uses an in-process Postgres (tests); `pglite://./.data/dev` persists to disk (local dev).
 */
export async function openDb(url = process.env.DATABASE_URL ?? "pglite://memory"): Promise<{ db: DB; close: () => Promise<void> }> {
  if (url.startsWith("postgres")) {
    // Migrations re-check the drizzle schema on every start; Postgres NOTICEs about it are noise in self-host logs.
    const sql = postgres(url, { max: 10, prepare: false, onnotice: () => {} });
    const db = drizzlePg(sql, { schema }) as unknown as DB;
    await assertNoSkippedMigrations(db);
    await migratePg(db as never, { migrationsFolder });
    return { db, close: () => sql.end() };
  }
  const path = url.replace(/^pglite:\/\//, "");
  if (path !== "memory" && path !== "") mkdirSync(path, { recursive: true });
  const client = path === "memory" || path === "" ? new PGlite() : new PGlite(path);
  const db = drizzlePglite(client, { schema }) as unknown as DB;
  await assertNoSkippedMigrations(db);
  await migratePglite(db as never, { migrationsFolder });
  return { db, close: () => client.close() };
}
