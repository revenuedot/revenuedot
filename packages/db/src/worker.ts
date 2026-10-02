import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import type { DB } from "./index.js";

/**
 * The Workers build of @revenuedot/db (picked by the "workerd" export condition): the schema and a Postgres
 * connection, without PGlite, migrations or node:fs. Migrations run from Node before a deploy (`scripts/migrate.ts`).
 */
export { schema };
export { LOCK_KEYS } from "./locks.js";
export type { DB };

/** One short-lived connection pool per request, as Cloudflare recommends with Hyperdrive (Hyperdrive does the pooling). */
export function connectPostgres(url: string): { db: DB; close: () => Promise<void> } {
  const sql = postgres(url, { max: 5, fetch_types: false, prepare: false });
  return { db: drizzle(sql, { schema }) as unknown as DB, close: () => sql.end() };
}

