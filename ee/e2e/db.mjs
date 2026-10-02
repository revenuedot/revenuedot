// RevenueDot Enterprise (ee/LICENSE). Creates or drops the browser tests' own database on the Railway development
// Postgres (REVENUEDOT_DEV_DATABASE_URL from ~/.config/revenuedot/dev.env). Never prints the URL.
//   node ee/e2e/db.mjs recreate|drop <name>
import postgres from "postgres";

const [action, name] = process.argv.slice(2);
if (!/^rd_[a-z0-9_]+$/.test(name ?? "")) { console.error("The database name must look like rd_<task>."); process.exit(1); }
const sql = postgres(process.env.REVENUEDOT_DEV_DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  if (action === "recreate" || action === "drop") await sql.unsafe(`drop database if exists "${name}" with (force)`);
  if (action === "recreate") await sql.unsafe(`create database "${name}"`);
  console.log(`${action} ${name}: done`);
} finally {
  await sql.end();
}
