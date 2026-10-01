import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { openDb } from "@revenuedot/db";
import { createApp } from "./app.js";
import { defaultStores } from "./stores/index.js";

import { tick } from "./services/tick.js";
import { logMailer, type Mailer } from "./mail/index.js";

const { db } = await openDb(process.env.DATABASE_URL ?? "pglite://./.data/dev");
const stores = defaultStores();
// Email: SMTP when REVENUEDOT_SMTP_URL is set, else every email (links included) is printed to this log.
const publicUrl = process.env.REVENUEDOT_PUBLIC_URL?.trim() || undefined;
let mailer: Mailer = logMailer();
if (process.env.REVENUEDOT_SMTP_URL?.trim()) {
  const { smtpMailer } = await import("./mail/smtp.js");
  mailer = smtpMailer(process.env.REVENUEDOT_SMTP_URL.trim(), process.env.REVENUEDOT_MAIL_FROM?.trim() || "RevenueDot <no-reply@localhost>", { replyTo: process.env.REVENUEDOT_MAIL_REPLY_TO?.trim() || undefined });
}
let running = false;
const runTick = async () => {
  if (running) return;
  running = true;
  try { await tick(db, new Date(), fetch, { stores, mailer, publicUrl, checkCredentials: true }); } catch (e) { console.error("tick failed", e); } finally { running = false; }
};
setInterval(runTick, 30_000);
// Self-hosted servers let only their first account (the owner) sign up, unless REVENUEDOT_ALLOW_SIGNUP=true.
const signup = process.env.REVENUEDOT_ALLOW_SIGNUP === "true" ? "open" : "owner_only";
const app = createApp({ db, now: () => new Date(), stores, kick: () => setTimeout(runTick, 250), signup, mailer, publicUrl, encryptionKey: process.env.REVENUEDOT_ENCRYPTION_KEY?.trim() || undefined });
// Self-host: one process serves the API and the built dashboard (single-page app with index.html fallback).
const dist = process.env.DASHBOARD_DIST ?? new URL("../../dashboard/dist", import.meta.url).pathname;
if (existsSync(`${dist}/index.html`)) {
  const html = readFileSync(`${dist}/index.html`, "utf8");
  app.use("/*", serveStatic({ root: relative(process.cwd(), dist) || ".", rewriteRequestPath: (p) => p }));
  app.get("*", (c) => (/^\/(v1|v2|auth|rcbilling)\//.test(c.req.path) ? c.notFound() : c.html(html)));
}
const port = Number(process.env.PORT ?? 8787);
// REVENUEDOT_REQUEST_LOG=<file>: one JSON line per request (method, path, status, whether a route answered). The device
// harnesses read it to check that each SDK call happened once, with the documented status. No bodies or headers.
const requestLog = process.env.REVENUEDOT_REQUEST_LOG;
const handler: typeof app.fetch = !requestLog ? app.fetch : async (req, ...rest) => {
  const t0 = Date.now();
  const res = await app.fetch(req, ...rest);
  const url = new URL(req.url);
  // Hono's own 404 for an unknown path is plain text; every deliberate SDK error is JSON with a code.
  const routed = !(res.status === 404 && !(res.headers.get("content-type") ?? "").includes("json"));
  appendFileSync(requestLog, `${JSON.stringify({ at: t0, method: req.method, path: url.pathname, query: url.search, status: res.status, routed, ms: Date.now() - t0 })}\n`);
  return res;
};
serve({ fetch: handler, port });
console.log(`RevenueDot API on http://localhost:${port}`);
console.log(mailer.driver === "smtp" ? "Email: SMTP (REVENUEDOT_SMTP_URL)." : "Email: not configured; emails are printed to this log. Set REVENUEDOT_SMTP_URL to send them.");
