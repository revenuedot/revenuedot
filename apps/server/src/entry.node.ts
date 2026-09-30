import { serve } from "@hono/node-server";
import { openDb } from "@revenuedot/db";
import { createApp } from "./app.js";
import { defaultStores } from "./stores/index.js";

const { db } = await openDb(process.env.DATABASE_URL ?? "pglite://./.data/dev");
const app = createApp({ db, now: () => new Date(), stores: defaultStores() });
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`RevenueDot API on http://localhost:${port}`);
