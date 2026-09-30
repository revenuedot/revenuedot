import { serve } from "@hono/node-server";
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
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`RevenueDot API on http://localhost:${port}`);
