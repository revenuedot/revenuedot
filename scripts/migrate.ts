// Applies the database migrations (packages/db/migrations) to a Postgres and exits.
// Usage: DATABASE_URL=postgres://... pnpm migrate   (or: pnpm tsx scripts/migrate.ts postgres://...)
// The self-host server migrates on start; the cloud (Workers) build cannot read migration files, so deploys run this first.
import { openDb } from "../packages/db/src/index.js";

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("Set DATABASE_URL (or pass it as the first argument) to a postgres:// URL.");
  process.exit(1);
}
const host = new URL(url).host;
const { close } = await openDb(url);
await close();
console.log(`Migrations applied to ${host}.`);
