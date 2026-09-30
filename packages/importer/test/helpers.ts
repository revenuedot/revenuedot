// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: test wiring for the importer: the fake RevenueCat, the real RevenueDot app (contract harness) and a DB dump.
// Docs: https://revenuedot.app/docs/migrate
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema, type DB } from "@revenuedot/db";
import { harness, type Harness } from "../../contract/src/harness.js";
import { loadSpec, SPEC_PATH } from "../../contract/src/openapi.js";
import { parseTokenCsv } from "../src/convert.js";
import type { FetchFn, HttpOptions } from "../src/http.js";
import { runImport, type ImportOptions } from "../src/run.js";
import { FakeRevenueCat } from "./fake-revenuecat.js";
import { PROJECT, TOKENS_CSV, rcModel } from "./fixtures.js";

export const spec = loadSpec();
if (!spec) console.warn(`[importer tests] RevenueCat OpenAPI spec not found at ${SPEC_PATH}; fixture schema validation is SKIPPED.`);

export const RC_KEY = "sk_rc_test_key";
export const TARGET = "http://revenuedot.test";

/** Sends the importer's requests for TARGET into the in-process RevenueDot app. */
export function bridge(h: Harness): FetchFn {
  return (url, init = {}) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const key = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    headers.delete("authorization");
    return h.fetch(u.pathname + u.search, { method: init.method, body: init.body, headers, key });
  };
}

export interface Env {
  h: Harness;
  rc: FakeRevenueCat;
  sleeps: number[];
  statePath: string;
  run: (over?: Partial<ImportOptions>) => ReturnType<typeof runImport>;
  close: () => Promise<void>;
}

export async function setup(): Promise<Env> {
  const h = await harness();
  const rc = await new FakeRevenueCat(rcModel(), RC_KEY, spec).start();
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const statePath = join(mkdtempSync(join(tmpdir(), "rd-import-")), "state.json");
  const target: HttpOptions = { fetch: bridge(h), sleep };
  return {
    h, rc, sleeps, statePath,
    run: (over = {}) => runImport({
      rcKey: RC_KEY, rcProject: PROJECT, rcBaseUrl: rc.url, to: TARGET, toKey: h.ids.secretKey, statePath,
      http: { sleep }, targetHttp: target, tokens: parseTokenCsv(TOKENS_CSV), concurrency: 3, ...over,
    }),
    close: async () => { await rc.stop(); await h.close(); },
  };
}

/** Every table an import touches, with rows in a stable order: equal dumps mean nothing changed. */
export async function dump(db: DB) {
  const t = schema;
  const tables = {
    apps: t.apps, products: t.products, entitlements: t.entitlements, entitlementProducts: t.entitlementProducts, offerings: t.offerings,
    packages: t.packages, packageProducts: t.packageProducts, customers: t.customers, aliases: t.customerAliases, attributes: t.customerAttributes,
    subscriptions: t.subscriptions, nonSubscriptions: t.nonSubscriptions, transactions: t.transactions, events: t.events, deliveries: t.webhookDeliveries,
  };
  const out: Record<string, string[]> = {};
  for (const [name, table] of Object.entries(tables)) {
    const rows = await db.select().from(table as typeof t.apps);
    out[name] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

/** A real HTTP server in front of the in-process app, for running the CLI end to end. */
export async function serveHarness(h: Harness): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "authorization" && k !== "host" && k !== "connection") headers.set(k, v);
    const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const r = await h.fetch(req.url ?? "/", { method: req.method, headers, key, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) };
}
