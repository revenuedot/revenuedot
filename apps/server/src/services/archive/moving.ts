import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Background work skips projects that are moving (prd/moves-export/PRD.md §3): an `incoming` copy must stay exactly the
 * source's, and a `paused` or `forwarded` source hands its queue (webhook deliveries, retries, exports) to the target,
 * which sends each one once. The sub-select is on a tiny set and costs nothing when no project is moving.
 */
export const notMoving = (projectId: AnyColumn | SQL): SQL => sql`${projectId} NOT IN (SELECT "id" FROM "projects" WHERE "move_state" IS NOT NULL)`;
