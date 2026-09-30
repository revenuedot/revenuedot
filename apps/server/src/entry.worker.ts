// RevenueDot Cloud: the same Hono app as self-host, on Cloudflare Workers with Postgres through Hyperdrive.
// Config: apps/server/cloudflare.config.ts (built and deployed with the `cf` CLI). Deploy steps: docs/cloud.md. Node-only
// code (PGlite, node:fs, migrations, process.env) stays in entry.node.ts and @revenuedot/db's Node build; the Workers
// build picks the "workerd" build of the db.
import { AsyncLocalStorage } from "node:async_hooks";
import { connectPostgres, type DB } from "@revenuedot/db/worker";
import { createApp } from "./app.js";
import { defaultStores } from "./stores/index.js";
import { tick } from "./services/tick.js";

// Minimal Workers types, so the shared tsconfig (DOM lib) needs no @cloudflare/workers-types.
interface Hyperdrive { connectionString: string }
interface Fetcher { fetch(req: Request): Promise<Response> }
interface ExecutionContext { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void; props: unknown }
interface ScheduledController { scheduledTime: number; cron: string }

export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** The built dashboard (apps/dashboard/dist), served with single-page-app fallback. */
  ASSETS: Fetcher;
  /** Secret. Base64 Ed25519 seed for response signing (Trusted Entitlements). Unset turns signing off. */
  REVENUEDOT_SIGNING_KEY?: string;
}

/** Paths the API owns. Everything else on app.revenuedot.app is the dashboard. */
const API_PATH = /^\/(v1|v2|auth|rcbilling|\.well-known)(\/|$)/;

interface RequestScope { db: DB; pending: Promise<unknown>[] }
const scope = new AsyncLocalStorage<RequestScope>();

/**
 * The app is built once per isolate (so the response signer keeps its intermediate key), but each request gets its
 * own Postgres connection. Route handlers capture `deps.db` when the app is built, so `db` forwards every call to the
 * connection of the request that is running.
 */
const db = new Proxy({} as DB, {
  get(_t, prop) {
    const real = scope.getStore()?.db;
    if (!real) throw new Error("RevenueDot: database used outside a request.");
    const v = (real as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

const stores = defaultStores();
let app: ReturnType<typeof createApp> | undefined;
const appFor = (env: Env) => (app ??= createApp({
  db,
  now: () => new Date(),
  stores,
  edition: "cloud",
  signingKey: env.REVENUEDOT_SIGNING_KEY ?? "",
  // Send new webhook deliveries after the response, on the request's own connection.
  kick: () => { const s = scope.getStore(); if (s) s.pending.push(runTick(s.db, "kick")); },
  // Work that finishes after the response (AdServices attribution) keeps the request's connection open until it is done.
  background: (task) => { scope.getStore()?.pending.push(task); },
}));

async function runTick(db: DB, why: string) {
  try {
    const r = await tick(db, new Date(), fetch, { stores });
    if (r.expired || r.voided || r.sent) console.log(`tick (${why})`, JSON.stringify(r));
    return r;
  } catch (e) {
    console.error(`tick (${why}) failed`, e);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // api.revenuedot.app is all API; elsewhere (app.revenuedot.app, localhost) only the API paths are, the rest is the dashboard.
    if (!url.hostname.startsWith("api.") && !API_PATH.test(url.pathname)) return env.ASSETS.fetch(req);
    const conn = connectPostgres(env.HYPERDRIVE.connectionString);
    const s: RequestScope = { db: conn.db, pending: [] };
    try {
      return await scope.run(s, () => appFor(env).fetch(req, env, ctx));
    } finally {
      // Close the connection once the response and any kicked tick have finished.
      ctx.waitUntil((async () => {
        for (let i = 0; i < s.pending.length; i++) await s.pending[i];
        await conn.close();
      })());
    }
  },

  /** Cron Trigger, every minute: expirations, the daily Google voided-purchases scan, webhook deliveries. */
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const conn = connectPostgres(env.HYPERDRIVE.connectionString);
    ctx.waitUntil((async () => {
      try { await runTick(conn.db, "cron"); } finally { await conn.close(); }
    })());
  },
};
