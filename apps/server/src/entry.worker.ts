// RevenueDot Cloud: the same Hono app as self-host, on Cloudflare Workers with Postgres through Hyperdrive.
// Config: apps/server/cloudflare.config.ts (built and deployed with the `cf` CLI). Deploy steps: docs/cloud.md. Node-only
// code (PGlite, node:fs, migrations, process.env) stays in entry.node.ts and @revenuedot/db's Node build; the Workers
// build picks the "workerd" build of the db.
import { AsyncLocalStorage } from "node:async_hooks";
import { connectPostgres, type DB } from "@revenuedot/db/worker";
import { createApp } from "./app.js";
import { API_PATH } from "./api-paths.js";
import { tick } from "./services/tick.js";
import { routeAssistantAgent } from "./assistant-agent.worker.js";
import { loadExtensions } from "./extensions.js";
import type { ServerExtension } from "./extensions.js";
import { archiveStoreFor, baseDeps, googleOAuthFor, stripeConnectFor, mailerFor, publicUrlFor, stores, type Env, type ExecutionContext, type ScheduledController } from "./worker-deps.js";
import { billingConfigFromEnv } from "./services/billing/stripe.js";
export { AssistantAgent } from "./assistant-agent.worker.js";
export type { Env } from "./worker-deps.js";

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

let app: ReturnType<typeof createApp> | undefined;
// Enterprise features (ee/, extensions.ts): loaded once per isolate, only when REVENUEDOT_LICENSE_KEY is set.
let extensions: Promise<ServerExtension[]> | undefined;
const extensionsFor = (env: Env) => (extensions ??= loadExtensions(env as unknown as Record<string, string | undefined>, { edition: "cloud" }));
const appFor = (env: Env, ext: ServerExtension[]) => (app ??= createApp({
  ...baseDeps(env),
  extensions: ext,
  db,
  // Send new webhook deliveries after the response, on the request's own connection.
  kick: () => { const s = scope.getStore(); if (s) s.pending.push(runTick(env, s.db, "kick")); },
  // Password reset emails and the like go out after the response, on the request's own connection.
  defer: (task) => { const s = scope.getStore(); if (s) s.pending.push(task()); else void task(); },
}));

async function runTick(env: Env, db: DB, why: string) {
  try {
    // Credential re-checks call Apple and Google; only the cron does them, not the ticks kicked by requests.
    // Data exports (file uploads) run on the cron only, never in a tick kicked by a request.
    const r = await tick(db, new Date(), fetch, {
      stores, mailer: mailerFor(env), publicUrl: publicUrlFor(env), checkCredentials: why === "cron", exports: why === "cron", winback: why === "cron", consumption: why === "cron",
      encryptionKey: env.REVENUEDOT_ENCRYPTION_KEY, signingKey: env.REVENUEDOT_SIGNING_KEY, strictUrls: true, googleOAuth: googleOAuthFor(env), admob: why === "cron", recovery: why === "cron", pruneDeliveryLogs: why === "cron", stripeConnect: stripeConnectFor(env),
      extensions: why === "cron" ? await extensionsFor(env) : [],
      // Full exports, server-run moves and billing run from the cron only.
      archives: why === "cron", archiveStore: archiveStoreFor(env), edition: why === "cron" ? "cloud" : undefined,
      billing: billingConfigFromEnv(env as unknown as Record<string, string | undefined>),
    });
    if (r.expired || r.voided || r.consumption || r.winback || r.recovery.sent || r.recovery.closed || r.sent || r.integrations || r.exports || r.credentialsChecked || r.admob || r.archives || r.moves || r.billing || r.attemptLogsPruned || r.alerts.opened || r.alerts.reminded || r.alerts.resolved) console.log(`tick (${why})`, JSON.stringify(r));
    return r;
  } catch (e) {
    console.error(`tick (${why}) failed`, e);
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // api.revenuedot.app is all API; on the dashboard host (app.revenuedot.app, localhost) only the API paths are, the rest is
    // the dashboard. Any other host routed here (the pay host, custom domains for hosted pages) is served by the app.
    const dashboardHost = url.hostname.startsWith("app.") || url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (dashboardHost && !API_PATH.test(url.pathname)) return env.ASSETS.fetch(req);
    // RevenueDot AI conversations: the session and ownership are checked here, then the Durable Object takes the socket.
    if (url.pathname.startsWith("/agents/")) {
      const conn = connectPostgres(env.HYPERDRIVE.connectionString);
      try { return await routeAssistantAgent(req, env, conn.db); } finally { ctx.waitUntil(conn.close()); }
    }
    const conn = connectPostgres(env.HYPERDRIVE.connectionString);
    const s: RequestScope = { db: conn.db, pending: [] };
    try {
      const ext = await extensionsFor(env);
      return await scope.run(s, () => appFor(env, ext).fetch(req, env, ctx));
    } finally {
      // Close the connection once the response and any kicked tick have finished.
      ctx.waitUntil((async () => {
        for (let i = 0; i < s.pending.length; i++) await s.pending[i];
        await conn.close();
      })());
    }
  },

  /** Cron Trigger, every minute: expirations, the daily Google voided-purchases scan, webhook and integration deliveries, data exports. */
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const conn = connectPostgres(env.HYPERDRIVE.connectionString);
    ctx.waitUntil((async () => {
      try { await runTick(env, conn.db, "cron"); } finally { await conn.close(); }
    })());
  },
};
