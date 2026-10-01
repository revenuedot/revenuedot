// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: vitest globalSetup for real-Postgres runs (REVENUEDOT_TEST_PG_URL). Creates and migrates the run's template
// database, which every test file clones (see test-db.ts), and drops every database of the run at the end.
// Without REVENUEDOT_TEST_PG_URL it does nothing and tests use in-memory PGlite.
import { openDb } from "@revenuedot/db";
import { createRequire } from "node:module";
// Loaded with require: vitest's globalSetup resolves bare imports from the repo root, where postgres is not installed.
const postgres = createRequire(import.meta.url)("postgres") as typeof import("postgres");
import { databaseUrl } from "./test-db.js";

export async function setup() {
  const admin = process.env.REVENUEDOT_TEST_PG_URL?.trim();
  if (!admin) return;
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
