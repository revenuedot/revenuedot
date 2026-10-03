// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the database every test opens. In-memory PGlite by default; a real Postgres when REVENUEDOT_TEST_PG_URL is
// set (any database on the server; the run creates and drops its own `rd_validate_*` databases there).
//
// Real-Postgres mode: `pg-global-setup.ts` migrates one template database per run. Each test file (vitest gives every
// file its own module graph) clones it once with CREATE DATABASE … TEMPLATE, and every later open in the same file
// empties all tables with one TRUNCATE instead of creating another database. Teardown drops every database of the run.
// The URL is never printed.
//
// PGlite mode: `pg-global-setup.ts` migrates one in-memory database per run and saves its data directory to a temp file
// (REVENUEDOT_TEST_PGLITE_SNAPSHOT). Every open loads that snapshot instead of migrating from scratch.
import { openDb, pgliteSnapshot, schema, type DB } from "@revenuedot/db";
import { readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import { createRequire } from "node:module";
// Loaded with require: vitest's globalSetup resolves bare imports from the repo root, where postgres is not installed.
const postgres = createRequire(import.meta.url)("postgres") as typeof import("postgres");

export type Query = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
export interface TestDb { db: DB; close: () => Promise<void>; query: Query; real: boolean }

export const realPostgres = () => Boolean(process.env.REVENUEDOT_TEST_PG_URL?.trim());

/** The URL of database `name` on the server of `admin`. */
export function databaseUrl(admin: string, name: string): string {
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.href;
}

let snapshot: Promise<Blob> | undefined;

/** The migrated data directory: the run's snapshot file, or (vitest run without the global setup) one migration per file. */
function migratedSnapshot(): Promise<Blob> {
  return (snapshot ??= (async () => {
    const file = process.env.REVENUEDOT_TEST_PGLITE_SNAPSHOT;
    if (file) return new Blob([await readFile(file)]);
    const { db, close } = await openDb("pglite://memory");
    try { return await pgliteSnapshot(db); } finally { await close(); }
  })());
}

/** A migrated in-memory PGlite database, in either mode (tests that need a second server's database). */
export async function openPgliteDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  return openDb("pglite://memory", { loadDataDir: await migratedSnapshot(), migrate: false });
}

let shared: Promise<{ db: DB; tables: string[]; query: Query }> | undefined;

async function createFileDatabase(): Promise<{ db: DB; tables: string[]; query: Query }> {
  const admin = process.env.REVENUEDOT_TEST_PG_URL!.trim();
  const run = process.env.REVENUEDOT_TEST_PG_RUN;
  if (!run) throw new Error("REVENUEDOT_TEST_PG_URL is set but the run id is missing: run vitest with vitest.config.ts (its globalSetup creates the template)");
  const name = `${run}_${Math.random().toString(36).slice(2, 8)}`;
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    // Two files cloning the template at the same moment can collide ("being accessed by other users"); retry.
    for (let i = 0; ; i++) {
      try { await sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${run}_tpl"`); break; } catch (e) {
        if (i >= 30 || !/being accessed by other users/.test(String((e as Error).message))) throw e;
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
      }
    }
  } finally { await sql.end(); }
  const { db } = await openDb(databaseUrl(admin, name));
  const client = (db as unknown as { $client: import("postgres").Sql }).$client;
  const query: Query = async (text, params = []) => [...(await client.unsafe(text, params as never[]))] as Record<string, unknown>[];
  const tables = (await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).map((r) => String(r.tablename));
  return { db, tables, query };
}

/**
 * Empties every table. The previous test's background work (deferred emails, webhook sends) may still be writing: wait
 * up to 5 s for other sessions on this database to go idle, and retry when TRUNCATE loses a deadlock to one of them.
 */
async function reset(s: { tables: string[]; query: Query }) {
  for (let i = 0; i < 50; i++) {
    const [busy] = await s.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state NOT IN ('idle')");
    if (!Number(busy?.n)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let i = 0; ; i++) {
    try { await s.query(`TRUNCATE TABLE ${s.tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`); return; } catch (e) {
      if (i >= 5 || (e as { code?: string }).code !== "40P01") throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** An empty, migrated database. `close` is a no-op in real-Postgres mode (the file's database is dropped at teardown). */
export async function openTestDb(): Promise<TestDb> {
  if (!realPostgres()) {
    const { db, close } = await openPgliteDb();
    const client = (db as unknown as { $client: { query: (t: string, p: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> } }).$client;
    return { db, close, query: async (t, p = []) => (await client.query(t, p)).rows, real: false };
  }
  const first = !shared;
  shared ??= createFileDatabase();
  const s = await shared;
  if (!first && s.tables.length) await reset(s);
  // A new drizzle instance per open over the same connections: caches keyed by the db object (the SDK-version write
  // throttle) start empty, as they do with a fresh PGlite.
  const db = drizzle((s.db as unknown as { $client: import("postgres").Sql }).$client, { schema }) as unknown as DB;
  return { db, close: async () => {}, query: s.query, real: true };
}
