import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import * as schema from "./schema.js";

export { schema };
export type { PaywallContent, ExportFile, ExportProgress, ArchiveFileEntry, ArchiveTableEntry, ArchiveProgress } from "./schema.js";
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

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
    await migratePg(db as never, { migrationsFolder });
    return { db, close: () => sql.end() };
  }
  const path = url.replace(/^pglite:\/\//, "");
  if (path !== "memory" && path !== "") mkdirSync(path, { recursive: true });
  const client = path === "memory" || path === "" ? new PGlite() : new PGlite(path);
  const db = drizzlePglite(client, { schema }) as unknown as DB;
  await migratePglite(db as never, { migrationsFolder });
  return { db, close: () => client.close() };
}
