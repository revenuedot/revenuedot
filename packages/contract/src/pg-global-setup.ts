// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: vitest globalSetup for real-Postgres runs (REVENUEDOT_TEST_PG_URL). Creates and migrates the run's template
// database, which every test file clones (see test-db.ts), and drops every database of the run at the end.
// Without REVENUEDOT_TEST_PG_URL, tests use in-memory PGlite: this migrates one PGlite database and saves its data
// directory to a temp file that every test database loads (test-db.ts), so no test pays for running the migrations.
import { openDb, pgliteSnapshot } from "@revenuedot/db";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// Loaded with require: vitest's globalSetup resolves bare imports from the repo root, where postgres is not installed.
const postgres = createRequire(import.meta.url)("postgres") as typeof import("postgres");
import { databaseUrl } from "./test-db.js";

export async function setup() {
  const admin = process.env.REVENUEDOT_TEST_PG_URL?.trim();
  if (!admin) {
    const dir = mkdtempSync(join(tmpdir(), "rd-pglite-"));
    const { db, close } = await openDb("pglite://memory");
    try { writeFileSync(join(dir, "migrated.tar"), Buffer.from(await (await pgliteSnapshot(db)).arrayBuffer())); } finally { await close(); }
    process.env.REVENUEDOT_TEST_PGLITE_SNAPSHOT = join(dir, "migrated.tar");
    return () => rmSync(dir, { recursive: true, force: true });
  }
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const run = `rd_validate_${stamp}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.REVENUEDOT_TEST_PG_RUN = run;
  const sql = postgres(admin, { max: 1, onnotice: () => {} });
  try { await sql.unsafe(`CREATE DATABASE "${run}_tpl"`); } finally { await sql.end(); }
  const { close } = await openDb(databaseUrl(admin, `${run}_tpl`));
  await close();
  console.log(`[real Postgres] template ${run}_tpl migrated; one database per test file`);
  return async () => {
    const s = postgres(admin, { max: 1, onnotice: () => {} });
    try {
      const rows = await s<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE ${`${run}_%`}`;
      for (const r of rows) await s.unsafe(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
      console.log(`[real Postgres] dropped ${rows.length} databases of ${run}`);
    } finally { await s.end(); }
  };
}
