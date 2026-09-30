import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { openDb } from "@revenuedot/db";
import { createApp } from "./app.js";
import { defaultStores } from "./stores/index.js";

import { tick } from "./services/tick.js";

const { db } = await openDb(process.env.DATABASE_URL ?? "pglite://./.data/dev");
let running = false;
const runTick = async () => {
  if (running) return;
  running = true;
  try { await tick(db, new Date()); } catch (e) { console.error("tick failed", e); } finally { running = false; }
};
setInterval(runTick, 30_000);
const app = createApp({ db, now: () => new Date(), stores: defaultStores(), kick: () => setTimeout(runTick, 250) });
// Self-host: one process serves the API and the built dashboard (single-page app with index.html fallback).
const dist = process.env.DASHBOARD_DIST ?? new URL("../../dashboard/dist", import.meta.url).pathname;
if (existsSync(`${dist}/index.html`)) {
  const html = readFileSync(`${dist}/index.html`, "utf8");
  app.use("/*", serveStatic({ root: relative(process.cwd(), dist) || ".", rewriteRequestPath: (p) => p }));
  app.get("*", (c) => (/^\/(v1|v2|auth|rcbilling)\//.test(c.req.path) ? c.notFound() : c.html(html)));
}
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`RevenueDot API on http://localhost:${port}`);
