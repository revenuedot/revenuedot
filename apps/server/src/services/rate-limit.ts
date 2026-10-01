import { sql } from "drizzle-orm";
import { schema, type DB } from "@revenuedot/db";

/**
 * Fixed-window rate limit kept in Postgres (`rate_limits`), so it holds across Workers isolates and Node restarts.
 * Counts this hit and returns whether it is within `limit` for the window.
 */
export async function hit(db: DB, key: string, limit: number, windowMs: number, now: Date): Promise<boolean> {
  const t = schema.rateLimits;
  const nowTs = sql`${now.toISOString()}::timestamptz`;
  const expired = sql`${t.windowStart} <= ${new Date(now.getTime() - windowMs).toISOString()}::timestamptz`;
  const [row] = await db.insert(t).values({ key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: t.key,
      set: {
        count: sql`case when ${expired} then 1 else ${t.count} + 1 end`,
        windowStart: sql`case when ${expired} then ${nowTs} else ${t.windowStart} end`,
      },
    })
    .returning({ count: t.count });
  return (row?.count ?? 1) <= limit;
}

/**
 * The caller's IP as the edge reports it (Cloudflare, a reverse proxy), else the connection's own address (the Node server
 * with no proxy in front: `env` is @hono/node-server's `{ incoming }`), else "unknown". Without the socket fallback every
 * caller of a self-hosted server shared one "unknown" bucket, so per-IP limits throttled all callers together.
 */
export function clientIp(header: (name: string) => string | undefined, env?: unknown): string {
  const edge = header("cf-connecting-ip") ?? header("x-forwarded-for")?.split(",")[0]?.trim() ?? header("x-real-ip");
  if (edge) return edge;
  const socket = (env as { incoming?: { socket?: { remoteAddress?: string } } } | null | undefined)?.incoming?.socket;
  return socket?.remoteAddress?.replace(/^::ffff:/, "") || "unknown";
}
