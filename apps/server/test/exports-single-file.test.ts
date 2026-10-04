import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { eq, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { getOrCreateCustomer } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import { adjust } from "../src/services/virtual-currencies.js";
import { parseCsv } from "../src/services/exports/files.js";
import { runExport, type ExportRuntime } from "../src/services/exports/run.js";
import { secretKeyFrom } from "../src/services/secrets.js";
import { dbStore } from "../src/services/archive/store.js";
import { memoryMailer } from "../src/mail/index.js";
import { COLUMNS } from "../src/services/exports/tables.js";
import type { VerifiedSubscription } from "../src/stores/types.js";

/**
 * Single-file CSV exports (one file per table, written in pieces across ticks: S3 multipart, Azure blocks, kept pieces
 * for email) and the in-app currency feed, against a fake object store that assembles uploads the way S3 and Azure do.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const AZ_KEY = btoa(String.fromCharCode(...new Uint8Array(64).map((_, i) => (i * 5) % 256)));
const DAY = 86400_000;
let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const S3 = { destination: "s3", config: { bucket: "acme-exports", prefix: "rd", region: "eu-west-1", access_key_id: "AKIAEXAMPLE" }, credentials: { secret_access_key: "s3-secret-value" } };
const AZURE = { destination: "azure", config: { bucket: "rd-exports", prefix: "rd" }, credentials: { connection_string: `DefaultEndpointsProtocol=https;AccountName=acmedata;AccountKey=${AZ_KEY};EndpointSuffix=core.windows.net` } };

/**
 * A fake S3 and Azure: plain PUTs, multipart uploads (parts below `minPart`, except the last, are refused; with `uniform`,
 * as R2, parts but the last must all be one size) and block lists. `loseComplete` completes the first upload and then
 * answers 500, as when the response is lost.
 */
function objectStore(minPart: number, o: { uniform?: boolean; loseComplete?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const blocks = new Map<string, Map<string, Uint8Array>>();
  const log: string[] = [];
  let next = 0;
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();
    const path = url.pathname;
    const q = url.searchParams;
    log.push(`${method} ${path}${url.search}`.replace(/&sig=[^&]*/, ""));
    if (method === "POST" && q.has("uploads")) {
      const id = `up${++next}`;
      uploads.set(id, new Map());
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === "PUT" && q.has("partNumber")) {
      uploads.get(q.get("uploadId")!)!.set(Number(q.get("partNumber")), body);
      return new Response("", { headers: { etag: `"etag-${q.get("partNumber")}"` } });
    }
    if (method === "PUT" && q.has("partNumber") && !uploads.has(q.get("uploadId")!)) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
    if (method === "POST" && q.has("uploadId")) {
      const parts = uploads.get(q.get("uploadId")!);
      if (!parts) return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
      const xml = new TextDecoder().decode(body);
      const nums = [...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>&quot;etag-(\d+)&quot;<\/ETag>/g)].map((m) => Number(m[1]));
      if (nums.some((n, i) => i < nums.length - 1 && parts.get(n)!.length < minPart)) return new Response("<Error><Code>EntityTooSmall</Code></Error>", { status: 400 });
      if (o.uniform && new Set(nums.slice(0, -1).map((n) => parts.get(n)!.length)).size > 1) return new Response("<Error><Code>InvalidPart</Code></Error>", { status: 400 });
      objects.set(path, Buffer.concat(nums.map((n) => parts.get(n)!)));
      uploads.delete(q.get("uploadId")!);
      if (o.loseComplete) { o.loseComplete = false; return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 }); }
      return new Response("<CompleteMultipartUploadResult/>");
    }
    if (method === "HEAD") return objects.has(path) ? new Response(null, { headers: { "content-length": String(objects.get(path)!.length) } }) : new Response(null, { status: 404 });
    if (method === "PUT" && q.get("comp") === "block") {
      (blocks.get(path) ?? blocks.set(path, new Map()).get(path)!).set(q.get("blockid")!, body);
      return new Response("", { status: 201 });
    }
    if (method === "PUT" && q.get("comp") === "blocklist") {
      const ids = [...new TextDecoder().decode(body).matchAll(/<Latest>([^<]+)<\/Latest>/g)].map((m) => m[1]!);
      objects.set(path, Buffer.concat(ids.map((id) => blocks.get(path)!.get(id)!)));
      return new Response("", { status: 201 });
    }
    if (method === "PUT") { objects.set(path, body); return new Response("", { status: 201 }); }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, objects, log };
}

function api() {
  const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY });
  return async (method: string, path: string, json?: unknown) => {
    const res = await app.fetch(new Request(`http://localhost${path.startsWith("/v2/") ? "" : "/v2/projects/proj1"}${path}`, {
      method, headers: { Authorization: `Bearer ${h.ids.secretKey}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    }));
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() as any : new Uint8Array(await res.arrayBuffer()) };
  };
}

/** 25,000 events: three chunks of at most 10,000 rows. */
async function manyEvents(n = 25_000) {
  await h.db.execute(sql`insert into events (id, project_id, type, environment, payload, event_timestamp_ms, created_at)
    select 'ev' || lpad(g::text, 6, '0'), 'proj1', 'TEST', 'production', ('{"api_version":"1.0","event":{"n":' || g || '}}')::jsonb, 0, timestamptz '2026-09-01 11:00:00+00' + g * interval '1 millisecond'
    from generate_series(1, ${n}) g`);
}

/** Runs the export one chunk per tick until it is done. Returns how many ticks it took. */
async function runToEnd(runId: string, rt: ExportRuntime) {
  for (let i = 1; i <= 20; i++) {
    await runExport(h.db, runId, rt, 0);
    const [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, runId));
    if (r!.status !== "queued") return { ticks: i, run: r! };
  }
  throw new Error("the run did not finish");
}

const csvRows = (gz: Uint8Array) => parseCsv(gunzipSync(gz).toString("utf8"));

describe("single-file CSV", () => {
  it("writes one gzip file per table to S3 as a multipart upload, buffering chunks below the part size across ticks", async () => {
    await manyEvents();
    const call = api();
    const store = dbStore(h.db);
    // First with every chunk its own part, to learn the chunks' sizes.
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["events"] })).body;
    expect(job.split_files).toBe(false);
    let run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const a = objectStore(1);
    const rt = { fetch: a.f, now: h.now(), secretKey: await secretKeyFrom(KEY, null), store, minPartBytes: 1 };
    const one = await runToEnd(run.id, rt);
    expect([one.ticks, one.run.status, one.run.files.length, one.run.rows]).toEqual([3, "succeeded", 1, 25_000]);
    const key = "/rd/2026-09-01/events_20260901T120000Z.csv.gz";
    expect(one.run.files[0]!.key).toBe("rd/2026-09-01/events_20260901T120000Z.csv.gz");
    const file = a.objects.get(key)!;
    expect(file.length).toBe(one.run.files[0]!.bytes);
    const rows = csvRows(file);
    expect(rows[0]).toEqual(COLUMNS.events.map(([n]) => n));
    expect(rows.slice(1).map((r) => r[0])).toEqual(Array.from({ length: 25_000 }, (_, i) => `ev${String(i + 1).padStart(6, "0")}`));
    expect(a.log.filter((l) => l.includes("partNumber")).length).toBe(3);

    // Now with a part size just above the first chunk: chunk 1 waits in the file store, chunks 1 and 2 make part 1, chunk 3 is the last part.
    const firstChunk = await (async () => { const b = objectStore(1); const r2 = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body; await runExport(h.db, r2.id, { ...rt, fetch: b.f }, 0); const [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, r2.id)); await h.db.delete(schema.exportRuns).where(eq(schema.exportRuns.id, r2.id)); return r!.progress!.upload!.bytes; })();
    const b = objectStore(firstChunk + 1);
    run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const rt2 = { ...rt, fetch: b.f, minPartBytes: firstChunk + 1 };
    await runExport(h.db, run.id, rt2, 0);
    let [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    expect([r!.status, r!.progress!.upload!.chunks, r!.progress!.upload!.staged, r!.progress!.upload!.pieces]).toEqual(["queued", 1, firstChunk, 0]);
    expect(b.log.some((l) => l.includes("uploads"))).toBe(false);
    const done = await runToEnd(run.id, rt2);
    expect(done.run.status).toBe("succeeded");
    expect(b.log.filter((l) => l.includes("partNumber"))).toEqual([expect.stringContaining("partNumber=1"), expect.stringContaining("partNumber=2")]);
    expect(Buffer.compare(b.objects.get(key)!, file)).toBe(0);
    // Nothing is left staged.
    [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    const left = await h.db.select().from(schema.archiveBlobs).where(sql`${schema.archiveBlobs.key} like ${"data-exports/%/staging/%"}`);
    expect(left).toHaveLength(0);
  });

  it("R2 gets parts of one size, and a lost CompleteMultipartUpload answer is finished on the retry", async () => {
    await manyEvents();
    const call = api();
    const R2 = { destination: "r2", config: { bucket: "acme-r2", prefix: "rd", account_id: "0123456789abcdef0123456789abcdef", access_key_id: "r2key" }, credentials: { secret_access_key: "r2-secret-value" } };
    const job = (await call("POST", "/integrations/exports", { ...R2, tables: ["events"] })).body;
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const a = objectStore(1000, { uniform: true, loseComplete: true });
    const rt = { fetch: a.f, now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db), minPartBytes: 1000 };
    for (let i = 0; i < 3; i++) await runExport(h.db, run.id, rt, 0);
    let [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    // Every part went up and the object exists, but the answer was lost: the run waits for its retry with `sent` saved.
    expect([r!.status, r!.progress!.upload!.sent]).toEqual(["queued", true]);
    await h.db.update(schema.exportRuns).set({ nextAttemptAt: h.now() }).where(eq(schema.exportRuns.id, run.id));
    await runExport(h.db, run.id, rt, 0);
    [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    expect(r!.status).toBe("succeeded");
    const file = a.objects.get("/acme-r2/rd/2026-09-01/events_20260901T120000Z.csv.gz")!;
    expect(file.length).toBe(r!.files[0]!.bytes);
    expect(csvRows(file).length).toBe(25_001);
    // No part was sent again after the upload was complete.
    expect(a.log.filter((l) => l.startsWith("POST") && l.includes("uploadId")).length).toBe(2);
  });

  it("a small table is one plain PUT; split_files keeps one file per 10,000 rows", async () => {
    await manyEvents(12_000);
    const call = api();
    const rt = { now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db) };
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["customers", "events"], split_files: true })).body;
    let run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const a = objectStore(1);
    await runToEnd(run.id, { ...rt, fetch: a.f });
    expect([...a.objects.keys()].sort()).toEqual(["/rd/2026-09-01/customers_20260901T120000Z.csv.gz", "/rd/2026-09-01/events_20260901T120000Z.csv.gz", "/rd/2026-09-01/events_20260901T120000Z_part2.csv.gz"]);
    await call("POST", `/integrations/exports/${job.id}`, { split_files: false });
    run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const b = objectStore(5 * 1024 * 1024);
    const done = await runToEnd(run.id, { ...rt, fetch: b.f });
    expect(done.run.files.map((x) => [x.key.split("/").pop(), x.rows])).toEqual([["customers_20260901T120000Z.csv.gz", 0], ["events_20260901T120000Z.csv.gz", 12_000]]);
    // Both files were below 5 MiB: the first chunk waited, and the file went up whole at the end (no multipart).
    expect(b.log.filter((l) => l.startsWith("PUT")).length).toBe(2);
    expect(b.log.some((l) => l.includes("uploads"))).toBe(false);
    expect(csvRows(b.objects.get("/rd/2026-09-01/events_20260901T120000Z.csv.gz")!).length).toBe(12_001);
  });

  it("writes one file to Azure as blocks and a block list", async () => {
    await manyEvents();
    const call = api();
    const job = (await call("POST", "/integrations/exports", { ...AZURE, tables: ["events"], compression: "none" })).body;
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const a = objectStore(1);
    const done = await runToEnd(run.id, { fetch: a.f, now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db), minPartBytes: 1 });
    expect(done.run.status).toBe("succeeded");
    expect(a.log.filter((l) => l.includes("comp=block&")).length).toBe(3);
    expect(a.log.filter((l) => l.includes("comp=blocklist")).length).toBe(1);
    const rows = parseCsv(new TextDecoder().decode(a.objects.get("/rd-exports/rd/2026-09-01/events_20260901T120000Z.csv")!));
    expect(rows.length).toBe(25_001);
    expect(rows.filter((r) => r[0] === "event_id")).toHaveLength(1);
  });

  it("an email export keeps a big file in pieces and its one link downloads the whole file", async () => {
    await manyEvents();
    await h.db.insert(schema.users).values({ id: "u1", email: "owner@acme.test" }).onConflictDoNothing();
    await h.db.insert(schema.memberships).values({ userId: "u1", projectId: "proj1", role: "admin" }).onConflictDoNothing();
    const call = api();
    const job = (await call("POST", "/integrations/exports", { destination: "email", config: { recipients: ["owner@acme.test"] }, tables: ["events"] })).body;
    expect(job.object).toBe("data_export");
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const mailer = memoryMailer();
    const done = await runToEnd(run.id, { fetch: fetch, now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db), minPartBytes: 1, mailer, publicUrl: "http://localhost", linkMaterial: KEY });
    expect([done.run.status, done.run.files.length, done.run.files[0]!.chunks]).toEqual(["succeeded", 1, 3]);
    const link = /http:\/\/localhost(\/v2\/data-exports\/download\/\S+)/.exec(mailer.sent[0]!.text!)![1]!;
    const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY });
    const res = await app.fetch(new Request(`http://localhost${link}`));
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(done.run.files[0]!.bytes);
    expect(csvRows(bytes).length).toBe(25_001);
  });
});

describe("in-app currency feed", () => {
  async function purchase(user: string, over: Partial<VerifiedSubscription> = {}) {
    const now = h.now();
    const { customer } = await getOrCreateCustomer(h.db, "proj1", user, now);
    const s: VerifiedSubscription = {
      kind: "subscription", store: "app_store", storeKey: `orig_${user}`, productIdentifier: "gems_pack", isSandbox: false, purchaseDate: now, originalPurchaseDate: now,
      expiresDate: new Date(now.getTime() + 30 * DAY), periodType: "normal", storeTransactionId: `tx_${user}`, originalTransactionId: `orig_${user}`,
      price: { amount: 4.99, currency: "USD" }, countryCode: "US", ...over,
    };
    await applyPurchases(h.db, customer, [s], { projectId: "proj1", appId: "app_ios", appUserId: user, now, fromDevice: false });
    return customer;
  }

  it("exports the ledger with RevenueCat's columns, running balances, and refunds on the next incremental run", async () => {
    const c = await purchase("gamer");
    const at = (ms: number) => new Date(h.now().getTime() + ms);
    await adjust(h.db, "proj1", c.id, "GEMS", 100, { source: "purchase", sourceKey: "tx_gamer", now: at(1) });
    await adjust(h.db, "proj1", c.id, "GEMS", -30, { source: "sdk", sourceKey: "sdk:spend-1", reference: "sword", now: at(2) });
    const grant = await adjust(h.db, "proj1", c.id, "GEMS", 5, { source: "api", now: at(3) });
    await adjust(h.db, "proj1", c.id, "GEMS", -100, { source: "api", sourceKey: "fix-1", now: at(4) });
    await adjust(h.db, "proj1", c.id, "COINS", 7, { source: "ad_reward", sourceKey: "rw_1", now: at(5) });
    h.setNow(at(1000));
    const call = api();
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["virtual_currency"] })).body;
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const a = objectStore(1);
    const rt = { now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db) };
    const [r0] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.jobId, job.id));
    await runToEnd(r0!.id, { ...rt, fetch: a.f });
    const rows = csvRows(a.objects.get("/rd/2026-09-01/virtual_currency_20260901T120001Z.csv.gz")!);
    expect(rows[0]).toEqual(COLUMNS.virtual_currency.map(([n]) => n));
    const data = rows.slice(1).map((r) => Object.fromEntries(rows[0]!.map((k, i) => [k, r[i]!])));
    expect(data.map((d) => [d.transaction_type, d.currency_code, d.adjustment_amount, d.updated_balance, d.idempotency_key])).toEqual([
      ["PURCHASE", "GEMS", "100", "100", "tx_gamer"], ["DEDUCTION", "GEMS", "-30", "70", "sdk:spend-1"], ["GRANT", "GEMS", "5", "75", grant],
      ["DEDUCTION", "GEMS", "-100", "0", "fix-1"], ["GRANT", "COINS", "7", "7", "rw_1"],
    ]);
    expect(data[0]).toMatchObject({
      rc_original_app_user_id: "gamer", store: "app_store", is_sandbox: "false", store_transaction_id: "tx_gamer", product_identifier: "gems_pack",
      price_in_usd: "4.99", purchase_price_in_usd: "4.99", purchased_currency: "USD", price_in_purchased_currency: "4.99", event_timestamp: "2026-09-01 12:00:00",
    });
    expect(data[1]).toMatchObject({ store: "", is_sandbox: "", price_in_usd: "", product_identifier: "" });
    expect(data[0]).toMatchObject({ refund_amount_usd: "", refund_type: "" });

    // Next day: the purchase is refunded and one more spend happens. Only those two rows come again.
    h.setNow(new Date(h.now().getTime() + DAY));
    const bought = new Date(h.now().getTime() - DAY);
    await purchase("gamer", { purchaseDate: bought, originalPurchaseDate: bought, expiresDate: new Date(bought.getTime() + 30 * DAY), refundedAt: h.now() });
    await adjust(h.db, "proj1", c.id, "GEMS", -1, { source: "sdk", sourceKey: "sdk:spend-2", now: h.now() });
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const runs = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.jobId, job.id));
    const second = runs.find((x) => x.status === "queued")!;
    const b = objectStore(1);
    await runToEnd(second.id, { ...rt, now: h.now(), fetch: b.f });
    const next = csvRows([...b.objects.values()][0]!);
    const d2 = next.slice(1).map((r) => Object.fromEntries(next[0]!.map((k, i) => [k, r[i]!])));
    expect(d2.map((d) => [d.transaction_type, d.idempotency_key, d.price_in_usd, d.purchase_price_in_usd, d.updated_balance, d.refund_amount_usd, d.refund_amount_in_purchased_currency, d.refund_type])).toEqual([
      ["PURCHASE", "tx_gamer", "0", "4.99", "100", "4.99", "4.99", "FULL"], ["DEDUCTION", "sdk:spend-2", "", "", "0", "", "", ""],
    ]);
  });
});
