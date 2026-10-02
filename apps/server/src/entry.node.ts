// First: unset empty *_BASE_URL settings before the AI SDK is loaded (docker compose passes unset ones as "").
import "./env-defaults.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import type { Server } from "node:http";
import { hostname } from "node:os";
import { openDb } from "@revenuedot/db";
import { sql as q } from "drizzle-orm";
import { createApp } from "./app.js";
import { withDashboardRoot } from "./node-dashboard.js";
import { defaultStores } from "./stores/index.js";

import { tick } from "./services/tick.js";
import { logMailer, type Mailer } from "./mail/index.js";
import { modelFromEnv } from "./services/paywall-ai.js";
import { assistantModelFromEnv } from "./services/assistant/models.js";
import { capsFromEnv } from "./services/assistant/limits.js";
import { stripeConnectFromEnv } from "./services/stripe-connect-config.js";
import { loadExtensions } from "./extensions.js";
import { diskStore } from "./services/archive/disk-store.js";
import { billingConfigFromEnv } from "./services/billing/stripe.js";
import { dbStore, s3ConfigFromEnv, s3Store } from "./services/archive/store.js";
import { advisoryLock, clusterSettingsFromEnv, healthResponse, localLock } from "./cluster.js";
import { flushStoreForwards } from "./stores/forward.js";
import { flushGoogleForwards } from "./stores/google/notifications.js";

// Several replicas can share one database (prd/ha-self-host/PRD.md): migrations run under a lock (or in a separate Job
// with REVENUEDOT_MIGRATE=skip here), and the background job runs on one replica at a time.
const cluster = clusterSettingsFromEnv(process.env);
const replica = process.env.REVENUEDOT_REPLICA_ID?.trim() || `${hostname()}:${process.pid}`;
const { db, sql: pg, close: closeDb } = await openDb(process.env.DATABASE_URL ?? "pglite://./.data/dev", { migrate: cluster.migrate });
// Enterprise features (ee/, extensions.ts): only with REVENUEDOT_LICENSE_KEY (or REVENUEDOT_EE_DEV=true for development).
// A Node server run as Cloud (REVENUEDOT_EDITION=cloud) is Cloud here too, so development mode stays off there.
const extensions = await loadExtensions(process.env, { edition: process.env.REVENUEDOT_EDITION === "cloud" ? "cloud" : "self-hosted" });
const stores = defaultStores();
// Email: SMTP when REVENUEDOT_SMTP_URL is set, else every email (links included) is printed to this log.
const publicUrl = process.env.REVENUEDOT_PUBLIC_URL?.trim() || undefined;
// "Connect with Stripe" (prd/web-billing/PRD.md §8): REVENUEDOT_STRIPE_CONNECT_*; unavailable without them.
const stripeConnect = stripeConnectFromEnv(process.env);
const googleOAuth = { clientId: process.env.REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID?.trim() || undefined, clientSecret: process.env.REVENUEDOT_GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined };
let mailer: Mailer = logMailer();
if (process.env.REVENUEDOT_SMTP_URL?.trim()) {
  const { smtpMailer } = await import("./mail/smtp.js");
  mailer = smtpMailer(process.env.REVENUEDOT_SMTP_URL.trim(), process.env.REVENUEDOT_MAIL_FROM?.trim() || "RevenueDot <no-reply@localhost>", { replyTo: process.env.REVENUEDOT_MAIL_REPLY_TO?.trim() || undefined });
}
// Full-export archives (prd/moves-export/PRD.md): an S3-compatible bucket when REVENUEDOT_ARCHIVE_S3_BUCKET is set, else a
// folder (REVENUEDOT_ARCHIVE_DIR, default .data/archives; the Docker image keeps it on a volume). "db" keeps them in Postgres.
const s3 = s3ConfigFromEnv(process.env);
const archiveStore = s3 ? s3Store(s3) : process.env.REVENUEDOT_ARCHIVE_DIR === "db" ? dbStore(db) : diskStore(process.env.REVENUEDOT_ARCHIVE_DIR?.trim() || ".data/archives");
// RevenueDot Cloud runs on Workers (entry.worker.ts). REVENUEDOT_EDITION=cloud runs this Node entry as Cloud, for the
// billing journeys and local tests of Cloud-only behaviour; billing then reads REVENUEDOT_BILLING_* (prd/cloud-billing).
const edition = process.env.REVENUEDOT_EDITION === "cloud" ? "cloud" as const : undefined;
const billing = edition ? billingConfigFromEnv(process.env) : undefined;
// The background job: every REVENUEDOT_TICK_INTERVAL_MS on every replica, and shortly after a request queues work. Only
// the replica holding the cluster lock runs it; the others skip that turn. A request-kicked run that finds the lock held
// tries again every second for up to 10 seconds, so a queued webhook still leaves within seconds.
const lock = pg ? advisoryLock(pg) : localLock();
const tickLog = process.env.REVENUEDOT_TICK_LOG === "1";
let current: Promise<unknown> | null = null;
let draining = false;
// Aborted on SIGTERM: a running job stops after the webhooks in flight and skips its long steps.
const stopping = new AbortController();
const runTick = async (): Promise<boolean> => {
  if (draining || !cluster.backgroundJobs) return true;
  if (current) return false;
  const run = (async () => {
    try {
      const r = await lock.tryRun(async () => {
        const started = Date.now();
        const out = await tick(db, new Date(), fetch, { stores, mailer, publicUrl, checkCredentials: true, googleOAuth, archiveStore, edition, billing, extensions, stripeConnect, signal: stopping.signal });
        // REVENUEDOT_TICK_LOG=1: one line per run, with the time the lock was held (the cluster test checks no two overlap).
        if (tickLog) console.log(`tick ${JSON.stringify({ replica, started, ended: Date.now(), sent: out.sent, expired: out.expired, alerts: out.alerts })}`);
        return out;
      });
      return r.ran;
    } catch (e) { console.error("tick failed", e); return true; }
  })();
  current = run;
  try { return await run; } finally { current = null; }
};
let kickTimer: ReturnType<typeof setTimeout> | null = null;
const kick = (tries = 10) => {
  if (kickTimer || draining) return;
  kickTimer = setTimeout(async () => {
    kickTimer = null;
    if (!(await runTick()) && tries > 1) kick(tries - 1);
  }, tries === 10 ? 250 : 1000);
};
const interval = setInterval(() => { void runTick(); }, cluster.tickIntervalMs);
// Self-hosted servers let only their first account (the owner) sign up, unless REVENUEDOT_ALLOW_SIGNUP=true.
const signup = process.env.REVENUEDOT_ALLOW_SIGNUP === "true" ? "open" : "owner_only";
const app = createApp({ db, now: () => new Date(), stores, kick: () => kick(), signup, mailer, publicUrl, archiveStore, edition, billing, encryptionKey: process.env.REVENUEDOT_ENCRYPTION_KEY?.trim() || undefined,
  // "Generate with AI" on paywalls: OPENAI_API_KEY or ANTHROPIC_API_KEY (REVENUEDOT_AI_MODEL to pick the model); off without either.
  ai: modelFromEnv(process.env), apiUrl: process.env.REVENUEDOT_API_URL?.trim() || undefined, googleOAuth,
  // Hosted web pages (purchase links, funnels): REVENUEDOT_PAY_URL, else <this server>/pay; custom domains CNAME to the pay host.
  payUrl: process.env.REVENUEDOT_PAY_URL?.trim() || undefined, customDomainTarget: process.env.REVENUEDOT_CUSTOM_DOMAIN_TARGET?.trim() || undefined,
  // RevenueDot AI (prd/ai-assistant/PRD.md): ANTHROPIC_API_KEY (Claude Opus 5.5) or OPENAI_API_KEY (GPT-6 Astra), REVENUEDOT_ASSISTANT_MODEL to
  // pick another; hidden without either. Conversations and their streams live in Postgres; caps from REVENUEDOT_ASSISTANT_CAPS.
  assistant: assistantModelFromEnv(process.env), assistantRuntime: "sse", assistantCaps: capsFromEnv(process.env.REVENUEDOT_ASSISTANT_CAPS), extensions, stripeConnect });
// Self-host: one process serves the API and the built dashboard (single-page app with index.html fallback).
const dist = process.env.DASHBOARD_DIST ?? new URL("../../dashboard/dist", import.meta.url).pathname;
const html = existsSync(`${dist}/index.html`) ? readFileSync(`${dist}/index.html`, "utf8") : null;
if (html) {
  app.use("/*", serveStatic({ root: relative(process.cwd(), dist) || ".", rewriteRequestPath: (p) => p }));
  app.get("*", (c) => (/^\/(v1|v2|auth|rcbilling|share|sso|scim)\//.test(c.req.path) ? c.notFound() : c.html(html)));
}
// A browser opening the server's address gets the dashboard; API clients still get the JSON at /.
const appFetch: typeof app.fetch = html ? withDashboardRoot(app.fetch, html) : app.fetch;
const port = Number(process.env.PORT ?? 8787);
// REVENUEDOT_REQUEST_LOG=<file>: one JSON line per request (method, path, status, whether a route answered). The device
// harnesses read it to check that each SDK call happened once, with the documented status. No bodies or headers.
const requestLog = process.env.REVENUEDOT_REQUEST_LOG;
const health = { draining: () => draining, ping: () => db.execute(q`select 1`) };
const handler: typeof app.fetch = async (req, ...rest) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  let res = (await healthResponse(url.pathname, health)) ?? await appFetch(req, ...rest);
  // Draining: tell keep-alive clients to reconnect (to another replica) after this answer.
  if (draining) { res = new Response(res.body, res); res.headers.set("connection", "close"); }
  if (requestLog) {
    // Hono's own 404 for an unknown path is plain text; every deliberate SDK error is JSON with a code.
    const routed = !(res.status === 404 && !(res.headers.get("content-type") ?? "").includes("json"));
    appendFileSync(requestLog, `${JSON.stringify({ at: t0, method: req.method, path: url.pathname, query: url.search, status: res.status, routed, ms: Date.now() - t0 })}\n`);
  }
  return res;
};
const server = serve({ fetch: handler, port }) as Server;
console.log(`RevenueDot API on http://localhost:${port} (replica ${replica}${cluster.backgroundJobs ? "" : ", background jobs off"})`);
console.log(mailer.driver === "smtp" ? "Email: SMTP (REVENUEDOT_SMTP_URL)." : "Email: not configured; emails are printed to this log. Set REVENUEDOT_SMTP_URL to send them.");

// Graceful shutdown (SIGTERM from Kubernetes, ECS or docker stop): /readyz turns 503 so the load balancer stops sending
// requests, then the listener closes and in-flight requests, the running job and store forwards finish before the pool
// closes. REVENUEDOT_SHUTDOWN_DELAY_MS and REVENUEDOT_SHUTDOWN_TIMEOUT_MS fit it inside the platform's grace period.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shutdown = async (signal: string) => {
  if (draining) return;
  draining = true;
  stopping.abort();
  console.log(`${signal}: draining (replica ${replica})`);
  clearInterval(interval);
  if (kickTimer) clearTimeout(kickTimer);
  await sleep(cluster.shutdownDelayMs);
  const closed = new Promise<void>((r) => server.close(() => r()));
  server.closeIdleConnections?.();
  const t0 = Date.now();
  const waited: Record<string, number> = {};
  const timed = (name: string, p: Promise<unknown> | null) => Promise.resolve(p).then(() => { waited[name] = Date.now() - t0; });
  const done = await Promise.race([
    Promise.all([timed("requests", closed), timed("job", current), timed("forwards", Promise.all([flushStoreForwards(), flushGoogleForwards()]))]).then(() => true),
    sleep(cluster.shutdownTimeoutMs).then(() => false),
  ]);
  if (!done) console.error(`Shutdown timed out after ${cluster.shutdownTimeoutMs} ms; closing open connections.`);
  else console.log(`Drained (ms): ${JSON.stringify(waited)}`);
  server.closeAllConnections?.();
  await closeDb().catch(() => {});
  console.log("Stopped.");
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
