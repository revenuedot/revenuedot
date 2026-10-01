// First: unset empty *_BASE_URL settings before the AI SDK is loaded (docker compose passes unset ones as "").
import "./env-defaults.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { openDb } from "@revenuedot/db";
import { createApp } from "./app.js";
import { withDashboardRoot } from "./node-dashboard.js";
import { defaultStores } from "./stores/index.js";

import { tick } from "./services/tick.js";
import { logMailer, type Mailer } from "./mail/index.js";
import { modelFromEnv } from "./services/paywall-ai.js";
import { assistantModelFromEnv } from "./services/assistant/models.js";
import { capsFromEnv } from "./services/assistant/limits.js";

const { db } = await openDb(process.env.DATABASE_URL ?? "pglite://./.data/dev");
const stores = defaultStores();
// Email: SMTP when REVENUEDOT_SMTP_URL is set, else every email (links included) is printed to this log.
const publicUrl = process.env.REVENUEDOT_PUBLIC_URL?.trim() || undefined;
const googleOAuth = { clientId: process.env.REVENUEDOT_GOOGLE_OAUTH_CLIENT_ID?.trim() || undefined, clientSecret: process.env.REVENUEDOT_GOOGLE_OAUTH_CLIENT_SECRET?.trim() || undefined };
let mailer: Mailer = logMailer();
if (process.env.REVENUEDOT_SMTP_URL?.trim()) {
  const { smtpMailer } = await import("./mail/smtp.js");
  mailer = smtpMailer(process.env.REVENUEDOT_SMTP_URL.trim(), process.env.REVENUEDOT_MAIL_FROM?.trim() || "RevenueDot <no-reply@localhost>", { replyTo: process.env.REVENUEDOT_MAIL_REPLY_TO?.trim() || undefined });
}
let running = false;
const runTick = async () => {
  if (running) return;
  running = true;
  try { await tick(db, new Date(), fetch, { stores, mailer, publicUrl, checkCredentials: true, googleOAuth }); } catch (e) { console.error("tick failed", e); } finally { running = false; }
};
setInterval(runTick, 30_000);
// Self-hosted servers let only their first account (the owner) sign up, unless REVENUEDOT_ALLOW_SIGNUP=true.
const signup = process.env.REVENUEDOT_ALLOW_SIGNUP === "true" ? "open" : "owner_only";
const app = createApp({ db, now: () => new Date(), stores, kick: () => setTimeout(runTick, 250), signup, mailer, publicUrl, encryptionKey: process.env.REVENUEDOT_ENCRYPTION_KEY?.trim() || undefined,
  // "Generate with AI" on paywalls: OPENAI_API_KEY or ANTHROPIC_API_KEY (REVENUEDOT_AI_MODEL to pick the model); off without either.
  ai: modelFromEnv(process.env), apiUrl: process.env.REVENUEDOT_API_URL?.trim() || undefined, googleOAuth,
  // Hosted web pages (purchase links, funnels): REVENUEDOT_PAY_URL, else <this server>/pay; custom domains CNAME to the pay host.
  payUrl: process.env.REVENUEDOT_PAY_URL?.trim() || undefined, customDomainTarget: process.env.REVENUEDOT_CUSTOM_DOMAIN_TARGET?.trim() || undefined,
  // RevenueDot AI (prd/ai-assistant/PRD.md): ANTHROPIC_API_KEY (Claude Opus 5.5) or OPENAI_API_KEY (GPT-6 Astra), REVENUEDOT_ASSISTANT_MODEL to
  // pick another; hidden without either. Conversations and their streams live in Postgres; caps from REVENUEDOT_ASSISTANT_CAPS.
  assistant: assistantModelFromEnv(process.env), assistantRuntime: "sse", assistantCaps: capsFromEnv(process.env.REVENUEDOT_ASSISTANT_CAPS) });
// Self-host: one process serves the API and the built dashboard (single-page app with index.html fallback).
const dist = process.env.DASHBOARD_DIST ?? new URL("../../dashboard/dist", import.meta.url).pathname;
const html = existsSync(`${dist}/index.html`) ? readFileSync(`${dist}/index.html`, "utf8") : null;
if (html) {
  app.use("/*", serveStatic({ root: relative(process.cwd(), dist) || ".", rewriteRequestPath: (p) => p }));
  app.get("*", (c) => (/^\/(v1|v2|auth|rcbilling|share)\//.test(c.req.path) ? c.notFound() : c.html(html)));
}
// A browser opening the server's address gets the dashboard; API clients still get the JSON at /.
const appFetch: typeof app.fetch = html ? withDashboardRoot(app.fetch, html) : app.fetch;
const port = Number(process.env.PORT ?? 8787);
// REVENUEDOT_REQUEST_LOG=<file>: one JSON line per request (method, path, status, whether a route answered). The device
// harnesses read it to check that each SDK call happened once, with the documented status. No bodies or headers.
const requestLog = process.env.REVENUEDOT_REQUEST_LOG;
const handler: typeof app.fetch = !requestLog ? appFetch : async (req, ...rest) => {
  const t0 = Date.now();
  const res = await appFetch(req, ...rest);
  const url = new URL(req.url);
  // Hono's own 404 for an unknown path is plain text; every deliberate SDK error is JSON with a code.
  const routed = !(res.status === 404 && !(res.headers.get("content-type") ?? "").includes("json"));
  appendFileSync(requestLog, `${JSON.stringify({ at: t0, method: req.method, path: url.pathname, query: url.search, status: res.status, routed, ms: Date.now() - t0 })}\n`);
  return res;
};
serve({ fetch: handler, port });
console.log(`RevenueDot API on http://localhost:${port}`);
console.log(mailer.driver === "smtp" ? "Email: SMTP (REVENUEDOT_SMTP_URL)." : "Email: not configured; emails are printed to this log. Set REVENUEDOT_SMTP_URL to send them.");
