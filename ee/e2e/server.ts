// RevenueDot Enterprise (ee/LICENSE). The browser-test server for the enterprise features: the real API on a real
// Postgres (DATABASE_URL, a Railway development database) with the enterprise extension in development mode, the
// built dashboard, and a local test identity provider on IDP_PORT. Nothing leaves this machine: DNS-over-HTTPS lookups
// answer from records set with POST /__dns, and every email is kept in memory (GET /__mail?to=).
//   DATABASE_URL=postgres://… PORT=5460 IDP_PORT=5461 pnpm tsx ee/e2e/server.ts   (after building the dashboard)
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { openDb } from "@revenuedot/db";
import { createApp } from "../../apps/server/src/app.js";
import { defaultStores } from "../../apps/server/src/stores/index.js";
import { memoryMailer } from "../../apps/server/src/mail/index.js";
import { tick } from "../../apps/server/src/services/tick.js";
import { loadExtensions } from "../../apps/server/src/extensions.js";
import { generateSigningKeyPair } from "../../apps/server/src/services/signing.js";
import { testIdp } from "./test-idp.js";
import { eeJobRuns } from "../server/schema.js";

const PORT = Number(process.env.PORT ?? 5460);
const IDP_PORT = Number(process.env.IDP_PORT ?? 5461);
const url = process.env.DATABASE_URL;
if (!url?.startsWith("postgres")) { console.error("Set DATABASE_URL to a Postgres database of its own (see ee/e2e/README.md)."); process.exit(1); }
const DIST = new URL("../../apps/dashboard/dist", import.meta.url).pathname;
if (!existsSync(join(DIST, "index.html"))) { console.error("Build the dashboard first: pnpm --filter @revenuedot/dashboard build"); process.exit(1); }

const { db, close } = await openDb(url);
const origin = `http://localhost:${PORT}`;
const extensions = await loadExtensions({ ...process.env, REVENUEDOT_EE_DEV: "true", REVENUEDOT_REGIONS: process.env.REVENUEDOT_REGIONS ?? "" });
const dns: Record<string, string[]> = {};
const localFetch: typeof fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return fetch(input, init);
  if (u.href.startsWith("https://cloudflare-dns.com/dns-query")) {
    const name = u.searchParams.get("name")!;
    return Response.json({ Status: 0, Answer: (dns[name] ?? []).map((d) => ({ name, type: 16, TTL: 60, data: `"${d}"` })) }, { headers: { "content-type": "application/dns-json" } });
  }
  return Response.json({ error: `The enterprise e2e server does not call ${u.host}.` }, { status: 503 });
};
const mail = memoryMailer();
const { privateKey: signingKey } = await generateSigningKeyPair();
const deps = { db, now: () => new Date(), fetch: localFetch, stores: defaultStores(), mailer: mail, publicUrl: origin, signingKey, encryptionKey: "ZTJlLWlkZW50aXR5LWtleS1mb3ItdGVzdHMtb25seSE=", extensions, kick: () => { setTimeout(runTick, 100); } };
const api = createApp(deps);
let ticking = false;
async function runTick() {
  if (ticking) return;
  ticking = true;
  try { await tick(db, new Date(), localFetch, { mailer: mail, encryptionKey: deps.encryptionKey, signingKey, extensions }); } catch (e) { console.error("tick failed", e); } finally { ticking = false; }
}
const timer = setInterval(runTick, 5_000);

const web = new Hono();
web.get("/__ready", (c) => c.text("ready"));
web.get("/__mail", (c) => { const to = c.req.query("to"); return c.json(mail.sent.filter((m) => !to || m.to === to)); });
web.post("/__dns", async (c) => { const b = await c.req.json() as { name: string; TXT: string[] }; dns[b.name] = b.TXT; return c.json({ ok: true }); });
// Runs the tick now, with the hourly enterprise jobs (audit retention) due again.
web.post("/__tick", async (c) => { await db.delete(eeJobRuns); while (ticking) await new Promise((r) => setTimeout(r, 50)); await runTick(); return c.json({ ok: true }); });
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json" };
web.all("/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (/^\/(v1|v2|auth|oauth|rcbilling|pay|share|verified|sso|scim|\.well-known)(\/|$)/.test(path)) return api.fetch(c.req.raw);
  const file = join(DIST, path);
  if (path !== "/" && file.startsWith(DIST) && existsSync(file) && extname(file)) return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
  return c.html(readFileSync(join(DIST, "index.html"), "utf8"));
});
const server = serve({ fetch: web.fetch, port: PORT });
const idp = await testIdp({ origin: `http://localhost:${IDP_PORT}` });
const idpServer = serve({ fetch: idp.app.fetch, port: IDP_PORT });
console.log(`Enterprise e2e server on ${origin}; test identity provider on http://localhost:${IDP_PORT} (SAML metadata ${idp.samlEntity}, OIDC issuer ${idp.issuer}).`);

const stop = async () => { clearInterval(timer); server.close(); idpServer.close(); await close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
