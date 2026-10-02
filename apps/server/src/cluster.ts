// Running several Node replicas against one Postgres (prd/ha-self-host/PRD.md): the background job runs on one replica at
// a time, readiness for load balancers, and settings read from the environment.
import { LOCK_KEYS, type openDb } from "@revenuedot/db";

/** The postgres.js client `openDb` returns for a real Postgres. */
type Sql = NonNullable<Awaited<ReturnType<typeof openDb>>["sql"]>;

export type RunResult<T> = { ran: true; value: T } | { ran: false };

/** Runs work while holding a cluster-wide lock, or skips it when another replica holds it. */
export interface ClusterLock {
  tryRun<T>(fn: () => Promise<T>): Promise<RunResult<T>>;
}

/**
 * A Postgres session advisory lock on a reserved connection. It is released when the work ends or, if the replica dies,
 * when Postgres closes its connection, so another replica takes over on its next try.
 */
export function advisoryLock(sql: Sql, key: number = LOCK_KEYS.tick): ClusterLock {
  return {
    async tryRun(fn) {
      const conn = await sql.reserve();
      try {
        const [row] = await conn<{ ok: boolean }[]>`select pg_try_advisory_lock(${key}::bigint) as ok`;
        if (!row?.ok) return { ran: false };
        try {
          return { ran: true, value: await fn() };
        } finally {
          await conn`select pg_advisory_unlock(${key}::bigint)`.catch(() => {});
        }
      } finally {
        conn.release();
      }
    },
  };
}

/** One process only (PGlite, tests): no other replica can exist, so only this process's own runs are kept apart. */
export function localLock(): ClusterLock {
  let held = false;
  return {
    async tryRun(fn) {
      if (held) return { ran: false };
      held = true;
      try { return { ran: true, value: await fn() }; } finally { held = false; }
    },
  };
}

export interface ClusterSettings {
  migrate: boolean;
  backgroundJobs: boolean;
  tickIntervalMs: number;
  shutdownDelayMs: number;
  shutdownTimeoutMs: number;
}

const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

export function clusterSettingsFromEnv(env: Record<string, string | undefined>): ClusterSettings {
  const migrate = (env.REVENUEDOT_MIGRATE ?? "auto").trim().toLowerCase();
  if (!["auto", "skip"].includes(migrate)) throw new Error(`REVENUEDOT_MIGRATE must be "auto" or "skip", not "${env.REVENUEDOT_MIGRATE}".`);
  const jobs = (env.REVENUEDOT_BACKGROUND_JOBS ?? "on").trim().toLowerCase();
  if (!["on", "off", "true", "false"].includes(jobs)) throw new Error(`REVENUEDOT_BACKGROUND_JOBS must be "on" or "off", not "${env.REVENUEDOT_BACKGROUND_JOBS}".`);
  return {
    migrate: migrate === "auto",
    backgroundJobs: jobs === "on" || jobs === "true",
    tickIntervalMs: Math.max(1000, num(env.REVENUEDOT_TICK_INTERVAL_MS, 30_000)),
    shutdownDelayMs: num(env.REVENUEDOT_SHUTDOWN_DELAY_MS, 5_000),
    shutdownTimeoutMs: num(env.REVENUEDOT_SHUTDOWN_TIMEOUT_MS, 20_000),
  };
}

/**
 * `/healthz` (liveness: the process answers; never touches the database, so a database blip restarts no pod) and
 * `/readyz` (readiness: the database answers within 2 seconds and the replica is not draining). Null for other paths.
 */
export async function healthResponse(path: string, state: { draining: () => boolean; ping: () => Promise<unknown> }): Promise<Response | null> {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (path === "/healthz") return new Response(JSON.stringify({ status: "ok" }), { headers });
  if (path !== "/readyz") return null;
  if (state.draining()) return new Response(JSON.stringify({ status: "draining" }), { status: 503, headers });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([state.ping(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), 2_000); })]);
    return new Response(JSON.stringify({ status: "ok" }), { headers });
  } catch {
    return new Response(JSON.stringify({ status: "database_unavailable" }), { status: 503, headers });
  } finally {
    clearTimeout(timer);
  }
}
