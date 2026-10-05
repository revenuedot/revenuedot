import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { runExport, START_PAGE_ROWS, type ExportRuntime } from "../src/services/exports/run.js";
import { secretKeyFrom } from "../src/services/secrets.js";
import { dbStore } from "../src/services/archive/store.js";

/**
 * Paced reading: a tick sizes its pages from the measured time per row and stops before a page it cannot finish, keeping
 * the rows it read for the next tick. A chunk is still exactly 10,000 rows, so the file is byte-identical to one written
 * in a single tick.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const S3 = { destination: "s3", config: { bucket: "acme-exports", prefix: "rd", region: "eu-west-1", access_key_id: "AKIAEXAMPLE" }, credentials: { secret_access_key: "s3-secret-value" } };

/** A fake S3 that keeps plain PUTs and assembles multipart uploads. */
function objectStore() {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  let next = 0;
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();
    const q = url.searchParams;
    if (method === "POST" && q.has("uploads")) { const id = `up${++next}`; uploads.set(id, new Map()); return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); }
    if (method === "PUT" && q.has("partNumber")) { uploads.get(q.get("uploadId")!)!.set(Number(q.get("partNumber")), body); return new Response("", { headers: { etag: `"e${q.get("partNumber")}"` } }); }
    if (method === "POST" && q.has("uploadId")) {
      const parts = uploads.get(q.get("uploadId")!)!;
      objects.set(url.pathname, Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((n) => parts.get(n)!)));
      return new Response("<CompleteMultipartUploadResult/>");
    }
    if (method === "PUT") { objects.set(url.pathname, body); return new Response(""); }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, objects };
}

function api() {
  const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY });
  return async (method: string, path: string, json?: unknown) => {
    const res = await app.fetch(new Request(`http://localhost/v2/projects/proj1${path}`, {
      method, headers: { Authorization: `Bearer ${h.ids.secretKey}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    }));
    return (await res.json()) as any;
  };
}

async function events(n: number) {
  await h.db.execute(sql`insert into events (id, project_id, type, environment, payload, event_timestamp_ms, created_at)
    select 'ev' || lpad(g::text, 6, '0'), 'proj1', 'TEST', 'production', ('{"api_version":"1.0","event":{"n":' || g || '}}')::jsonb, g, timestamptz '2026-09-01 11:00:00.123+00' + g * interval '1 millisecond'
    from generate_series(1, ${n}) g`);
}

async function runOf(id: string) {
  const [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, id));
  return r!;
}

describe("paced reading", () => {
  it("reads a chunk over many short ticks, keeps the rows in between, and writes the same bytes as one long tick", async () => {
    await events(12_000);
    const call = api();
    const job = await call("POST", "/integrations/exports", { ...S3, tables: ["events"] });
    const base = { now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db), minPartBytes: 1 };

    // Reference: one long tick.
    const a = objectStore();
    const ref = await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    await runExport(h.db, ref.id, { ...base, fetch: a.f }, 600_000);
    expect((await runOf(ref.id)).status).toBe("succeeded");
    const refBytes = a.objects.get("/rd/2026-09-01/events_20260901T120000Z.csv.gz")!;

    // Paced: a budget of 1 ms, so every tick reads one page and stops.
    await h.db.delete(schema.exportRuns).where(eq(schema.exportRuns.id, ref.id));
    const b = objectStore();
    const run = await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    const rt: ExportRuntime = { ...base, fetch: b.f, budgetMs: 1 };
    await runExport(h.db, run.id, rt, 1);
    let r = await runOf(run.id);
    // The first page has no measured rate yet: START_PAGE_ROWS rows, kept for the next tick.
    expect([r.status, r.progress?.buffered?.rows, r.progress?.upload]).toEqual(["queued", START_PAGE_ROWS, undefined]);
    expect(r.progress?.pace?.msPerRow).toBeGreaterThan(0);
    const kept = await h.db.select().from(schema.archiveBlobs).where(sql`${schema.archiveBlobs.key} like ${"%/rows/%"}`);
    expect(kept).toHaveLength(1);
    let ticks = 1;
    while (r.status === "queued" && ticks < 500) { await runExport(h.db, run.id, rt, 1); r = await runOf(run.id); ticks++; }
    expect(r.status).toBe("succeeded");
    expect(ticks).toBeGreaterThan(6);
    const paced = b.objects.get("/rd/2026-09-01/events_20260901T120000Z.csv.gz")!;
    expect(Buffer.compare(paced, refBytes)).toBe(0);
    expect(gunzipSync(paced).toString("utf8").trim().split("\r\n")).toHaveLength(12_001);
    // Nothing kept is left behind.
    expect(await h.db.select().from(schema.archiveBlobs).where(sql`${schema.archiveBlobs.key} like ${"%/staging/%"}`)).toHaveLength(0);
  });

  it.each([
    ["plain CSV split every 10,000 rows", { compression: "none", split_files: true }],
    ["Parquet", { format: "parquet" }],
  ])("%s: files read over many short ticks are byte-identical to one long tick", async (_name, opts) => {
    await events(12_000);
    const call = api();
    const job = await call("POST", "/integrations/exports", { ...S3, tables: ["events"], ...opts });
    const base = { now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db) };
    const a = objectStore();
    const ref = await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    await runExport(h.db, ref.id, { ...base, fetch: a.f }, 600_000);
    await h.db.delete(schema.exportRuns).where(eq(schema.exportRuns.id, ref.id));
    const b = objectStore();
    const run = await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    let r = await runOf(run.id), ticks = 0;
    do { await runExport(h.db, run.id, { ...base, fetch: b.f, budgetMs: 1 }, 1); r = await runOf(run.id); ticks++; } while (r.status === "queued" && ticks < 500);
    expect([r.status, ticks > 6]).toEqual(["succeeded", true]);
    expect([...b.objects.keys()].sort()).toEqual([...a.objects.keys()].sort());
    expect(a.objects.size).toBe(2);
    for (const [k, v] of a.objects) expect(Buffer.compare(b.objects.get(k)!, v)).toBe(0);
  });

  it("does not start a page it predicts will overrun: a slow measured rate shrinks the page to the minimum, then the tick stops", async () => {
    await events(3_000);
    const call = api();
    const job = await call("POST", "/integrations/exports", { ...S3, tables: ["events"], split_files: true });
    const run = await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    // As if earlier ticks measured one second per row.
    await h.db.update(schema.exportRuns).set({ progress: { table: 0, cursor: null, part: 0, pace: { msPerRow: 1000 } } }).where(eq(schema.exportRuns.id, run.id));
    const a = objectStore();
    const started = Date.now();
    await runExport(h.db, run.id, { now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db), fetch: a.f }, 5_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    const r = await runOf(run.id);
    // One page of the minimum 200 rows (a tick always moves forward), then it stops instead of reading more.
    expect([r.status, r.progress?.buffered?.rows, a.objects.size]).toEqual(["queued", 200, 0]);
  });
});
