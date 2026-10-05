import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { jwtVerify } from "jose";
import { parquetReadObjects } from "hyparquet";
import { schema } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { tick } from "../src/services/tick.js";
import { getOrCreateCustomer, setAttributes } from "../src/repo/customers.js";
import { applyPurchases } from "../src/services/purchases.js";
import { clearGoogleTokens } from "../src/services/google-sa.js";
import { gunzip, parseCsv } from "../src/services/exports/files.js";
import { nextRunAt, runExport } from "../src/services/exports/run.js";
import { secretKeyFrom } from "../src/services/secrets.js";
import { sql } from "drizzle-orm";
import { sha256Hex, signV4 } from "../src/services/exports/sigv4.js";
import { COLUMNS } from "../src/services/exports/tables.js";
import { storeSdkEvents } from "../src/services/sdk-events.js";
import { memoryMailer } from "../src/mail/index.js";
import { dbStore } from "../src/services/archive/store.js";
import { sharedKeyAuthorization } from "../src/services/exports/azure.js";
import type { VerifiedSubscription } from "../src/stores/types.js";
import { makeKeys, type Keys } from "./google-helpers.js";

/**
 * Scheduled data exports with a fake S3, R2 and Google Cloud Storage: what lands in the bucket (CSV and Parquet read back),
 * incremental windows, signing, schedules, retries and the bucket check.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 7)));
const DAY = 86400_000;
let h: Harness;
let keys: Keys;
beforeAll(async () => { keys = await makeKeys(); });
beforeEach(async () => { h = await harness(); clearGoogleTokens(); });
afterEach(async () => { await h.close(); });

interface Put { method: string; url: string; headers: Headers; bytes: Uint8Array }
function bucket(answer: (p: Put) => Response | Promise<Response> = () => new Response("", { status: 200 })) {
  const puts: Put[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = init.body;
    const bytes = body instanceof Uint8Array ? body : typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array();
    const p = { method: (init.method ?? "GET").toUpperCase(), url: String(input), headers: new Headers(init.headers), bytes };
    puts.push(p);
    return answer(p);
  }) as typeof fetch;
  return { f, puts };
}

function api() {
  const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY, fetch: undefined });
  return async (method: string, path: string, json?: unknown, f?: typeof fetch) => {
    const a = f ? createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY, fetch: f }) : app;
    const res = await a.fetch(new Request(`http://localhost/v2/projects/proj1${path}`, {
      method, headers: { Authorization: `Bearer ${h.ids.secretKey}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    }));
    return { status: res.status, body: await res.json() as any };
  };
}
const run = (f: typeof fetch) => tick(h.db, h.now(), f, { encryptionKey: KEY });

async function sub(user: string, over: Partial<VerifiedSubscription> & { at?: Date } = {}) {
  const now = over.at ?? h.now();
  const { customer } = await getOrCreateCustomer(h.db, "proj1", user, now);
  const s: VerifiedSubscription = {
    kind: "subscription", store: "app_store", storeKey: `orig_${user}`, productIdentifier: "pro_monthly", isSandbox: false, purchaseDate: now, originalPurchaseDate: now,
    expiresDate: new Date(now.getTime() + 30 * DAY), periodType: "normal", storeTransactionId: `tx_${user}`, originalTransactionId: `orig_${user}`,
    price: { amount: 9.99, currency: "USD" }, countryCode: "US", ...over,
  };
  await applyPurchases(h.db, customer, [s], { projectId: "proj1", appId: "app_ios", appUserId: user, now, fromDevice: false });
  return { customer, s };
}

const S3 = { destination: "s3", config: { bucket: "acme-exports", prefix: "revenuedot/", region: "eu-west-1", access_key_id: "AKIAEXAMPLE" }, credentials: { secret_access_key: "s3-secret-value" } };

async function csvOf(p: Put) {
  const rows = parseCsv(new TextDecoder().decode(await gunzip(p.bytes)));
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header!.map((k, i) => [k, r[i]!])));
}

describe("data export API", () => {
  it("creates, hides the secret, validates and computes the next run", async () => {
    const call = api();
    const res = await call("POST", "/integrations/exports", { ...S3, tables: ["transactions", "customers"], hour_utc: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "data_export", destination: "s3", format: "csv", compression: "gzip", schedule: "daily", hour_utc: 5, mode: "incremental", environment: null,
      config: { bucket: "acme-exports", prefix: "revenuedot/", region: "eu-west-1", access_key_id: "AKIAEXAMPLE", endpoint: null },
      credentials: { secret_access_key: { configured: true, hint: "••••alue" } }, tables: ["transactions", "customers"],
      next_run_at: new Date("2026-09-02T05:00:00Z").getTime(),
    });
    expect(JSON.stringify(res.body)).not.toContain("s3-secret-value");
    const [row] = await h.db.select().from(schema.exportJobs);
    expect(row!.secrets).toMatch(/^v1:/);
    expect((await call("POST", "/integrations/exports", { ...S3, credentials: {} })).body.param).toBe("credentials.secret_access_key");
    expect((await call("POST", "/integrations/exports", { destination: "gcs", config: { bucket: "b-1" }, credentials: { service_account_json: "nope" } })).body.param).toBe("credentials.service_account_json");
    expect((await call("POST", "/integrations/exports", { ...S3, tables: ["invoices"] })).body.param).toBe("tables.0");
    const weekly = await call("POST", `/integrations/exports/${res.body.id}`, { schedule: "weekly", weekday: 0, hour_utc: 1 });
    expect(weekly.body).toMatchObject({ schedule: "weekly", weekday: 0, next_run_at: new Date("2026-09-06T01:00:00Z").getTime() });
  });

  it("schedules: daily after the hour, weekly on the weekday", () => {
    const t = new Date("2026-09-01T12:00:00Z"); // a Tuesday
    expect(nextRunAt({ schedule: "daily", hourUtc: 3, weekday: null }, t).toISOString()).toBe("2026-09-02T03:00:00.000Z");
    expect(nextRunAt({ schedule: "daily", hourUtc: 13, weekday: null }, t).toISOString()).toBe("2026-09-01T13:00:00.000Z");
    expect(nextRunAt({ schedule: "weekly", hourUtc: 3, weekday: 1 }, t).toISOString()).toBe("2026-09-07T03:00:00.000Z");
    expect(nextRunAt({ schedule: "weekly", hourUtc: 13, weekday: 2 }, t).toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });
});

describe("export runs", () => {
  it("writes signed gzip CSV to S3 with RevenueCat's transaction columns, then exports only what changed", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["transactions", "customers", "subscriptions", "events"], environment: "production" })).body;
    // A trial that converted, a purchase later refunded, and a sandbox purchase the export leaves out.
    const t0 = new Date(h.now().getTime() - 10 * DAY);
    await sub("trialer", { at: t0, periodType: "trial", price: { amount: 0, currency: "USD" }, storeTransactionId: "t_1", expiresDate: new Date(t0.getTime() + 3 * DAY) });
    await sub("trialer", { at: new Date(t0.getTime() + 3 * DAY), originalPurchaseDate: t0, storeTransactionId: "t_2", expiresDate: new Date(t0.getTime() + 33 * DAY) });
    const refunded = await sub("refunded");
    await setAttributes(h.db, refunded.customer.id, { $email: { value: "r@example.com" }, plan_source: { value: "paywall_v3" } }, h.now());
    await sub("sandboxer", { isSandbox: true });
    const started = await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    expect(started.body).toMatchObject({ object: "data_export_run", status: "queued", trigger: "manual", mode: "incremental", window_start: null });
    expect((await call("POST", `/integrations/exports/${job.id}/actions/run`, {})).status).toBe(409);
    // Settings stay fixed while a run is open: a run reads them on every slice.
    const edit = await call("POST", `/integrations/exports/${job.id}`, { tables: ["events"] });
    expect([edit.status, edit.body.type]).toEqual([409, "resource_locked_error"]);

    const { f, puts } = bucket();
    const r = await run(f);
    expect(r.exports).toBe(1);
    expect(puts.map((p) => `${p.method} ${p.url}`)).toEqual([
      "PUT https://acme-exports.s3.eu-west-1.amazonaws.com/revenuedot/2026-09-01/transactions_20260901T120000Z.csv.gz",
      "PUT https://acme-exports.s3.eu-west-1.amazonaws.com/revenuedot/2026-09-01/customers_20260901T120000Z.csv.gz",
      "PUT https://acme-exports.s3.eu-west-1.amazonaws.com/revenuedot/2026-09-01/subscriptions_20260901T120000Z.csv.gz",
      "PUT https://acme-exports.s3.eu-west-1.amazonaws.com/revenuedot/2026-09-01/events_20260901T120000Z.csv.gz",
    ]);
    // SigV4: the payload hash is the body's, and the signature is what signing the same request gives.
    const p = puts[0]!;
    expect(p.headers.get("x-amz-content-sha256")).toBe(await sha256Hex(p.bytes));
    expect(p.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260901\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    const again = await signV4({ method: "PUT", url: p.url, payloadHash: await sha256Hex(p.bytes), headers: { "content-type": "application/gzip" }, accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3-secret-value", region: "eu-west-1", service: "s3", now: h.now(), contentSha256Header: true });
    expect(p.headers.get("authorization")).toBe(again.headers.authorization);

    const header = parseCsv(new TextDecoder().decode(await gunzip(p.bytes)))[0];
    expect(header).toEqual(COLUMNS.transactions.map(([n]) => n));
    const tx = await csvOf(p);
    expect(tx.map((x) => [x.rc_original_app_user_id, x.store_transaction_id, x.is_trial_period, x.renewal_number, x.is_trial_conversion])).toEqual([
      ["trialer", "t_1", "true", "1", "false"], ["trialer", "t_2", "false", "2", "true"], ["refunded", "tx_refunded", "false", "1", "false"],
    ]);
    expect(tx[2]).toMatchObject({
      price_in_usd: "9.99", purchase_price_in_usd: "9.99", commission_percentage: "0.3", takehome_percentage: "0.7", product_identifier: "pro_monthly",
      product_display_name: "pro_monthly", product_duration: "P1M", entitlement_identifiers: '["pro"]', is_sandbox: "false", is_auto_renewable: "true",
      start_time: "2026-09-01 12:00:00", end_time: "2026-10-01 12:00:00", original_store_transaction_id: "orig_refunded", country: "US", country_source: "from_sdk",
      custom_subscriber_attributes: '{"plan_source":{"value":"paywall_v3","updated_at_ms":1788264000000}}', refunded_at: "",
    });
    expect(JSON.parse(tx[2]!.reserved_subscriber_attributes!)).toEqual({ $email: { value: "r@example.com", updated_at_ms: 1788264000000 } });
    expect((await csvOf(puts[1]!)).map((c) => c.rc_original_app_user_id).sort()).toEqual(["refunded", "trialer"]);
    const events = await csvOf(puts[3]!);
    expect(events.map((e) => e.type)).toEqual(["INITIAL_PURCHASE", "RENEWAL", "INITIAL_PURCHASE"]);
    expect(JSON.parse(events[0]!.payload!)).toMatchObject({ type: "INITIAL_PURCHASE", period_type: "TRIAL", app_user_id: "trialer" });

    const runs = (await call("GET", `/integrations/exports/${job.id}/runs`)).body.items;
    expect(runs[0]).toMatchObject({ status: "succeeded", rows: 3 + 2 + 2 + 3, files: [{ table: "transactions", key: "revenuedot/2026-09-01/transactions_20260901T120000Z.csv.gz", rows: 3 }, { table: "customers" }, { table: "subscriptions" }, { table: "events" }] });
    const [j] = await h.db.select().from(schema.exportJobs);
    expect(j!.cursor).toEqual({ transactions: h.now().getTime(), customers: h.now().getTime(), subscriptions: h.now().getTime(), events: h.now().getTime() });

    // Next day: a new purchase and the refund. Only those two transactions are exported.
    h.setNow(new Date(h.now().getTime() + DAY));
    await sub("newcomer");
    const bought = new Date(h.now().getTime() - DAY);
    await sub("refunded", { purchaseDate: bought, originalPurchaseDate: bought, expiresDate: new Date(bought.getTime() + 30 * DAY), refundedAt: h.now() });
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const second = bucket();
    await run(second.f);
    expect(second.puts[0]!.url).toBe("https://acme-exports.s3.eu-west-1.amazonaws.com/revenuedot/2026-09-02/transactions_20260902T120000Z.csv.gz");
    const tx2 = await csvOf(second.puts[0]!);
    expect(tx2.map((x) => [x.rc_original_app_user_id, x.price_in_usd, x.purchase_price_in_usd, x.refunded_at])).toEqual([
      ["refunded", "0", "9.99", "2026-09-02 12:00:00"], ["newcomer", "9.99", "9.99", ""],
    ]);
    const runs2 = (await call("GET", `/integrations/exports/${job.id}/runs`)).body.items;
    expect(runs2[0]).toMatchObject({ status: "succeeded", mode: "incremental", window_start: new Date("2026-09-01T12:00:00Z").getTime() });
  });

  it("writes Parquet to R2 that reads back with the right types", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", {
      destination: "r2", format: "parquet", tables: ["transactions"], config: { bucket: "rd-data", account_id: "0123456789abcdef0123456789abcdef", access_key_id: "r2key" }, credentials: { secret_access_key: "r2secret" },
    })).body;
    const t0 = new Date(h.now().getTime() - 5 * DAY);
    await sub("p1", { at: t0, periodType: "trial", price: { amount: 0, currency: "USD" }, storeTransactionId: "p1_1", expiresDate: new Date(t0.getTime() + 3 * DAY) });
    await sub("p1", { at: new Date(t0.getTime() + 3 * DAY), originalPurchaseDate: t0, storeTransactionId: "p1_2", price: { amount: 12.5, currency: "USD" } });
    await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    const { f, puts } = bucket();
    await run(f);
    expect(puts[0]!.url).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/rd-data/2026-09-01/transactions_20260901T120000Z.parquet");
    expect(puts[0]!.headers.get("authorization")).toContain("/auto/s3/aws4_request");
    expect(new TextDecoder().decode(puts[0]!.bytes.slice(0, 4))).toBe("PAR1");
    const buf = puts[0]!.bytes.buffer.slice(puts[0]!.bytes.byteOffset, puts[0]!.bytes.byteOffset + puts[0]!.bytes.byteLength);
    const rows = await parquetReadObjects({ file: buf as ArrayBuffer });
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]!)).toEqual(COLUMNS.transactions.map(([n]) => n));
    expect(rows[1]).toMatchObject({ rc_original_app_user_id: "p1", store_transaction_id: "p1_2", renewal_number: 2n, is_trial_conversion: true, is_trial_period: false, price_in_usd: 12.5, refunded_at: null });
    expect(rows[1]!.start_time).toEqual(new Date(t0.getTime() + 3 * DAY));
  });

  it("writes a big single-file CSV to Google Cloud Storage as an XML API multipart upload with the service account's token", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { destination: "gcs", tables: ["events"], compression: "none", config: { bucket: "acme-gcs", prefix: "rd" }, credentials: { service_account_json: JSON.stringify(keys.sa) } })).body;
    await h.db.execute(sql`insert into events (id, project_id, type, environment, payload, event_timestamp_ms, created_at)
      select 'g' || lpad(g::text, 6, '0'), 'proj1', 'TEST', 'production', '{"api_version":"1.0","event":{}}'::jsonb, 0, timestamptz '2026-09-01 11:00:00+00' + g * interval '1 millisecond'
      from generate_series(1, 10500) g`);
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const { f, puts } = bucket(async (p) => {
      if (p.url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "ya29.gcs", expires_in: 3600 });
      if (p.url.endsWith("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>gup1</UploadId></InitiateMultipartUploadResult>");
      if (p.url.includes("partNumber=")) return new Response("", { headers: { etag: `"p${new URL(p.url).searchParams.get("partNumber")}"` } });
      return new Response("<CompleteMultipartUploadResult/>");
    });
    const rt = { fetch: f, now: h.now(), secretKey: await secretKeyFrom(KEY, null), store: dbStore(h.db), minPartBytes: 1 };
    await runExport(h.db, run.id, { pageRows: 10_000, ...rt }, 0);
    await runExport(h.db, run.id, { pageRows: 10_000, ...rt }, 0);
    const [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    expect([r!.status, r!.files.map((x) => [x.key, x.rows])]).toEqual(["succeeded", [["rd/2026-09-01/events_20260901T120000Z.csv", 10500]]]);
    const calls = puts.filter((p) => !p.url.startsWith("https://oauth2"));
    const base = "https://storage.googleapis.com/acme-gcs/rd/2026-09-01/events_20260901T120000Z.csv";
    expect(calls.map((p) => `${p.method} ${p.url}`)).toEqual([`POST ${base}?uploads`, `PUT ${base}?partNumber=1&uploadId=gup1`, `PUT ${base}?partNumber=2&uploadId=gup1`, `POST ${base}?uploadId=gup1`]);
    expect(calls.every((p) => p.headers.get("authorization") === "Bearer ya29.gcs")).toBe(true);
    expect(new TextDecoder().decode(calls[3]!.bytes)).toBe("<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;p1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;p2&quot;</ETag></Part></CompleteMultipartUpload>");
    expect(parseCsv(new TextDecoder().decode(new Uint8Array([...calls[1]!.bytes, ...calls[2]!.bytes]))).length).toBe(10501);
  });

  it("uploads to Google Cloud Storage with a service-account token", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { destination: "gcs", tables: ["events"], compression: "none", config: { bucket: "acme-gcs", prefix: "rd" }, credentials: { service_account_json: JSON.stringify(keys.sa) } })).body;
    expect(job.credentials).toEqual({ service_account_json: { configured: true, hint: "rd@scanner.iam.gserviceaccount.com" } });
    await sub("g1");
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const { f, puts } = bucket(async (p) => {
      if (p.url === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(new TextDecoder().decode(p.bytes));
        const { payload } = await jwtVerify(form.get("assertion")!, keys.publicKey, { issuer: keys.sa.client_email, audience: "https://oauth2.googleapis.com/token", currentDate: h.now() });
        expect(payload.scope).toBe("https://www.googleapis.com/auth/devstorage.read_write");
        return Response.json({ access_token: "ya29.gcs", expires_in: 3600 });
      }
      return Response.json({ name: "x" });
    });
    await run(f);
    expect(puts[1]!.url).toBe("https://storage.googleapis.com/upload/storage/v1/b/acme-gcs/o?uploadType=media&name=rd%2F2026-09-01%2Fevents_20260901T120000Z.csv");
    expect(puts[1]!.headers.get("authorization")).toBe("Bearer ya29.gcs");
    expect(puts[1]!.headers.get("content-type")).toBe("text/csv");
    const rows = parseCsv(new TextDecoder().decode(puts[1]!.bytes));
    expect(rows[0]).toEqual(COLUMNS.events.map(([n]) => n));
    expect(rows[1]![1]).toBe("INITIAL_PURCHASE");
  });

  it("retries a failing bucket after 10 and 30 minutes, fails on 403, and runs on schedule", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["transactions"] })).body;
    await sub("x1");
    let status = 500;
    const { f, puts } = bucket(() => new Response("<Error><Code>InternalError</Code></Error>", { status }));
    // The scheduled time passes: the tick queues and runs it.
    h.setNow(new Date("2026-09-02T03:00:30Z"));
    await run(f);
    const R = schema.exportRuns;
    let [r] = await h.db.select().from(R);
    expect([r!.trigger, r!.status, r!.attempts, r!.error, r!.windowEnd.toISOString(), r!.nextAttemptAt.toISOString()])
      .toEqual(["schedule", "queued", 1, "S3 answered HTTP 500 (InternalError).", "2026-09-02T03:00:00.000Z", "2026-09-02T03:10:30.000Z"]);
    expect((await h.db.select().from(schema.exportJobs))[0]!.nextRunAt!.toISOString()).toBe("2026-09-03T03:00:00.000Z");
    h.setNow(new Date("2026-09-02T03:10:30Z"));
    await run(f);
    [r] = await h.db.select().from(R);
    expect([r!.status, r!.attempts, r!.nextAttemptAt.toISOString()]).toEqual(["queued", 2, "2026-09-02T03:40:30.000Z"]);
    status = 403;
    h.setNow(new Date("2026-09-02T03:40:30Z"));
    await run(f);
    [r] = await h.db.select().from(R);
    expect([r!.status, r!.error]).toEqual(["failed", "S3 answered HTTP 403 (InternalError)."]);
    expect(puts).toHaveLength(3);
    const got = (await call("GET", `/integrations/exports/${job.id}`)).body;
    expect(got).toMatchObject({ last_error: "S3 answered HTTP 403 (InternalError).", consecutive_failures: 3, last_run_at: null });
  });

  it("checks the bucket with HeadBucket", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", S3)).body;
    const ok = bucket();
    expect((await call("POST", `/integrations/exports/${job.id}/actions/check`, {}, ok.f)).body).toMatchObject({ object: "storage_check", ok: true });
    expect(ok.puts[0]!.method).toBe("HEAD");
    expect(ok.puts[0]!.url).toBe("https://acme-exports.s3.eu-west-1.amazonaws.com/");
    const denied = bucket(() => new Response("", { status: 403 }));
    expect((await call("POST", `/integrations/exports/${job.id}/actions/check`, {}, denied.f)).body).toMatchObject({ ok: false, message: "S3 answered HTTP 403. Check that the credentials can list and write to the bucket." });
    const audit = await h.db.select().from(schema.auditLogs).where(eq(schema.auditLogs.projectId, "proj1"));
    expect(audit.map((a) => a.actionType)).toEqual(["data_export_created"]);
  });
});

describe("big exports", () => {
  it("spreads a run over several ticks, one file at a time, with rows that share a microsecond timestamp read once", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["events"], compression: "none", split_files: true })).body;
    // 10,500 events written by one statement: one created_at, with microseconds, for all of them.
    await h.db.execute(sql`insert into events (id, project_id, type, environment, payload, event_timestamp_ms, created_at)
      select 'bulk' || lpad(g::text, 6, '0'), 'proj1', 'TEST', 'production', '{"api_version":"1.0","event":{}}'::jsonb, 0, timestamptz '2026-09-01 11:00:00.123456+00'
      from generate_series(1, 10500) g`);
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const { f, puts } = bucket();
    const rt = { fetch: f, now: h.now(), secretKey: await secretKeyFrom(KEY, null) };
    expect(await runExport(h.db, run.id, { pageRows: 10_000, ...rt }, 0)).toBe(true);
    let [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    expect([r!.status, r!.progress?.part, r!.files.length]).toEqual(["queued", 1, 1]);
    expect(await runExport(h.db, run.id, { pageRows: 10_000, ...rt }, 0)).toBe(true);
    [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    expect([r!.status, r!.progress, r!.attempts]).toEqual(["succeeded", null, 0]);
    expect(puts.map((p) => p.url.split("/").pop())).toEqual(["events_20260901T120000Z.csv", "events_20260901T120000Z_part2.csv"]);
    const ids = puts.flatMap((p) => parseCsv(new TextDecoder().decode(p.bytes)).slice(1).map((row) => row[0]!)).filter((id) => id.startsWith("bulk"));
    expect(ids).toHaveLength(10500);
    expect(new Set(ids).size).toBe(10500);
    expect(r!.files.map((x) => x.rows).reduce((a, b) => a + b, 0)).toBe(r!.rows);
  });

  it("a run whose tick keeps dying fails after three tries instead of looping", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["transactions"] })).body;
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, {})).body;
    await h.db.update(schema.exportRuns).set({ status: "running", attempts: 2, nextAttemptAt: new Date(h.now().getTime() - 60_000) }).where(eq(schema.exportRuns.id, run.id));
    const { f, puts } = bucket();
    await tick(h.db, h.now(), f, { encryptionKey: KEY });
    const [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    expect(r!.status).toBe("failed");
    expect(r!.error).toMatch(/stopped before it finished/);
    expect(puts).toHaveLength(0);
  });

  it("a run another tick holds is left alone", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["transactions"] })).body;
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, {})).body;
    await h.db.update(schema.exportRuns).set({ status: "running", nextAttemptAt: new Date(h.now().getTime() + 60_000) }).where(eq(schema.exportRuns.id, run.id));
    const { f, puts } = bucket();
    expect((await tick(h.db, h.now(), f, { encryptionKey: KEY })).exports).toBe(0);
    expect(puts).toHaveLength(0);
  });

  it("refuses an endpoint on the server's own network on Cloud", async () => {
    const cloud = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY, edition: "cloud" });
    const res = await cloud.fetch(new Request("http://localhost/v2/projects/proj1/integrations/exports", {
      method: "POST", headers: { Authorization: `Bearer ${h.ids.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ ...S3, config: { ...S3.config, endpoint: "http://10.1.2.3:9000" } }),
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { param: string }).param).toBe("config.endpoint");
    const call = api();
    expect((await call("POST", "/integrations/exports", { ...S3, config: { ...S3.config, endpoint: "http://169.254.169.254" } })).body.param).toBe("config.endpoint");
    expect((await call("POST", "/integrations/exports", { ...S3, config: { ...S3.config, prefix: "a/../../other" } })).body.param).toBe("config.prefix");
  });
});

const AZ_KEY = btoa(String.fromCharCode(...new Uint8Array(64).map((_, i) => (i * 5) % 256)));

describe("parity with RevenueCat's export options", () => {
  it("writes only the chosen columns, in catalog order, to CSV and Parquet; validates names; empty means every column", async () => {
    const call = api();
    const bad = await call("POST", "/integrations/exports", { ...S3, columns: { transactions: ["store", "nope"] } });
    expect([bad.status, bad.body.param, bad.body.message]).toEqual([400, "columns.transactions", 'columns.transactions: "nope" is not a column of transactions.']);
    expect((await call("POST", "/integrations/exports", { ...S3, columns: { invoices: ["x"] } })).body.param).toBe("columns.invoices");
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["transactions", "customers"], compression: "none", columns: { transactions: ["store_transaction_id", "price_in_usd", "rc_original_app_user_id", "store", "store"], customers: [] } })).body;
    expect(job.columns).toEqual({ transactions: ["rc_original_app_user_id", "store", "price_in_usd", "store_transaction_id"] });
    const catalog = (await call("GET", "/integrations/exports/columns")).body;
    expect(catalog.items.map((t: { table: string }) => t.table)).toEqual(["transactions", "customers", "subscriptions", "events", "paywall_events", "virtual_currency"]);
    expect(catalog.items[0].columns[0]).toEqual({ name: "rc_original_app_user_id", type: "string" });
    await sub("c1");
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const { f, puts } = bucket();
    await run(f);
    const rows = parseCsv(new TextDecoder().decode(puts[0]!.bytes));
    expect(rows[0]).toEqual(["rc_original_app_user_id", "store", "price_in_usd", "store_transaction_id"]);
    expect(rows[1]).toEqual(["c1", "app_store", "9.99", "tx_c1"]);
    expect(parseCsv(new TextDecoder().decode(puts[1]!.bytes))[0]).toEqual(COLUMNS.customers.map(([n]) => n));

    const pq = (await call("POST", `/integrations/exports/${job.id}`, { format: "parquet", columns: { transactions: ["is_sandbox", "renewal_number"] } })).body;
    expect(pq.columns.transactions).toEqual(["is_sandbox", "renewal_number"]);
    await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    const second = bucket();
    await run(second.f);
    const b = second.puts[0]!.bytes;
    const parquet = await parquetReadObjects({ file: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });
    expect(parquet).toEqual([{ is_sandbox: false, renewal_number: 1n }]);
  });

  it("exports paywall events from the SDK, incrementally by when they arrived", async () => {
    const call = api();
    await sub("pw1");
    await storeSdkEvents(h.db, { projectId: "proj1", app: { id: "app_ios", type: "app_store" }, now: h.now(), body: { events: [
      { id: "e1", type: "paywall_impression", app_user_id: "pw1", timestamp: h.now().getTime() - 5000, session_id: "s1", offering_id: "default", paywall_id: "pw_main", paywall_revision: 3, locale: "en_US", display_mode: "full_screen", dark_mode: false },
      { id: "e2", type: "paywall_purchase_initiated", app_user_id: "pw1", timestamp: h.now().getTime() - 4000, session_id: "s1", offering_id: "default", paywall_revision: 3, package_id: "$rc_monthly", product_id: "pro_monthly", presented_offering_context: { paywall_id: "pw_ctx" } },
      { id: "e3", type: "customer_center_impression", app_user_id: "pw1", timestamp: h.now().getTime() - 3000 },
      { id: "e4", type: "paywall_close", app_user_id: "unknown_user", timestamp: h.now().getTime() - 2000, session_id: "s2", offering_id: "other", paywall_revision: 1 },
    ] } });
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["paywall_events"], compression: "none" })).body;
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const first = bucket();
    await run(first.f);
    expect(first.puts[0]!.url).toContain("/paywall_events_20260901T120000Z.csv");
    const rows = parseCsv(new TextDecoder().decode(first.puts[0]!.bytes));
    expect(rows[0]).toEqual(COLUMNS.paywall_events.map(([n]) => n));
    const data = rows.slice(1).map((r) => Object.fromEntries(rows[0]!.map((k, i) => [k, r[i]!])));
    expect(data.map((d) => d.id)).toEqual(["e1", "e2", "e4"]);
    const [cust] = await h.db.select().from(schema.customers).where(eq(schema.customers.originalAppUserId, "pw1"));
    expect(data[0]).toMatchObject({ type: "paywall_impression", app_id: "app_ios", app_user_id: "pw1", customer_id: cust!.id, is_sandbox: "false", paywall_id: "pw_main", offering_id: "default", session_id: "s1", paywall_revision: "3", locale: "en_US", display_mode: "full_screen", occurred_at: "2026-09-01 11:59:55", received_at: "2026-09-01 12:00:00" });
    expect(data[1]).toMatchObject({ paywall_id: "pw_ctx", package_id: "$rc_monthly", product_id: "pro_monthly" });
    expect(data[2]).toMatchObject({ customer_id: "", offering_id: "other" });
    expect(JSON.parse(data[0]!.payload!)).toMatchObject({ dark_mode: false });
    // The next day only the newly received event is exported, even though it happened earlier.
    h.setNow(new Date(h.now().getTime() + DAY));
    await storeSdkEvents(h.db, { projectId: "proj1", app: { id: "app_ios", type: "app_store" }, now: h.now(), body: { events: [{ id: "e5", type: "paywall_cancel", app_user_id: "pw1", timestamp: h.now().getTime() - 2 * DAY }] } });
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const second = bucket();
    await run(second.f);
    expect(parseCsv(new TextDecoder().decode(second.puts[0]!.bytes)).slice(1).map((r) => r[0])).toEqual(["e5"]);
  });

  it("runs every 4, 6, 8 or 12 hours from the chosen hour", async () => {
    const t = new Date("2026-09-01T12:00:00Z");
    expect(nextRunAt({ schedule: "interval", hourUtc: 3, weekday: null, intervalHours: 6 }, t).toISOString()).toBe("2026-09-01T15:00:00.000Z");
    expect(nextRunAt({ schedule: "interval", hourUtc: 3, weekday: null, intervalHours: 6 }, new Date("2026-09-01T21:00:00Z")).toISOString()).toBe("2026-09-02T03:00:00.000Z");
    expect(nextRunAt({ schedule: "interval", hourUtc: 0, weekday: null, intervalHours: 4 }, new Date("2026-09-01T00:00:00Z")).toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(nextRunAt({ schedule: "interval", hourUtc: 23, weekday: null, intervalHours: 12 }, t).toISOString()).toBe("2026-09-01T23:00:00.000Z");
    // A stored value outside 4, 6, 8 or 12 (0 would never end the loop) runs every 6 hours.
    expect(nextRunAt({ schedule: "interval", hourUtc: 3, weekday: null, intervalHours: 0 }, t).toISOString()).toBe("2026-09-01T15:00:00.000Z");
    const call = api();
    expect((await call("POST", "/integrations/exports", { ...S3, schedule: "interval", interval_hours: 5 })).body.param).toBe("interval_hours");
    const job = (await call("POST", "/integrations/exports", { ...S3, schedule: "interval", interval_hours: 8, hour_utc: 1 })).body;
    expect(job).toMatchObject({ schedule: "interval", interval_hours: 8, weekday: null, next_run_at: new Date("2026-09-01T17:00:00Z").getTime() });
    const daily = (await call("POST", `/integrations/exports/${job.id}`, { schedule: "daily" })).body;
    expect([daily.interval_hours, daily.next_run_at]).toEqual([null, new Date("2026-09-02T01:00:00Z").getTime()]);
  });

  it("uploads to Azure Blob Storage with Shared Key, and with a connection string's SAS", async () => {
    const call = api();
    const conn = `DefaultEndpointsProtocol=https;AccountName=acmedata;AccountKey=${AZ_KEY};EndpointSuffix=core.windows.net`;
    expect((await call("POST", "/integrations/exports", { destination: "azure", config: { bucket: "rd-exports" }, credentials: { connection_string: "AccountName=x" } })).body.param).toBe("credentials.connection_string");
    expect((await call("POST", "/integrations/exports", { destination: "azure", config: { bucket: "Bad_Name" }, credentials: { connection_string: conn } })).body.param).toBe("config.bucket");
    const job = (await call("POST", "/integrations/exports", { destination: "azure", tables: ["transactions"], config: { bucket: "rd-exports", prefix: "rd" }, credentials: { connection_string: conn } })).body;
    expect(job).toMatchObject({ destination: "azure", name: "Azure export", credentials: { connection_string: { configured: true } } });
    expect(JSON.stringify(job)).not.toContain(AZ_KEY);
    const ok = bucket();
    expect((await call("POST", `/integrations/exports/${job.id}/actions/check`, {}, ok.f)).body).toMatchObject({ ok: true, message: "RevenueDot can reach the container rd-exports." });
    expect(`${ok.puts[0]!.method} ${ok.puts[0]!.url}`).toBe("GET https://acmedata.blob.core.windows.net/rd-exports?restype=container");
    await sub("az1");
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const { f, puts } = bucket(() => new Response("", { status: 201 }));
    await run(f);
    const p = puts[0]!;
    expect(`${p.method} ${p.url}`).toBe("PUT https://acmedata.blob.core.windows.net/rd-exports/rd/2026-09-01/transactions_20260901T120000Z.csv.gz");
    expect([p.headers.get("x-ms-blob-type"), p.headers.get("x-ms-version"), p.headers.get("x-ms-date"), p.headers.get("content-length")]).toEqual(["BlockBlob", "2021-08-06", h.now().toUTCString(), String(p.bytes.length)]);
    const headers = Object.fromEntries([...(p.headers as unknown as Iterable<[string, string]>)].filter(([k]) => k !== "authorization"));
    expect(p.headers.get("authorization")).toBe((await sharedKeyAuthorization({ method: "PUT", url: p.url, headers, accountName: "acmedata", accountKey: AZ_KEY })).authorization);
    expect((await csvOf(p))[0]).toMatchObject({ rc_original_app_user_id: "az1" });

    // A SAS connection string: no Authorization header, the signature rides on the URL.
    await call("POST", `/integrations/exports/${job.id}`, { credentials: { connection_string: "BlobEndpoint=https://acmedata.blob.core.windows.net;SharedAccessSignature=sv=2022-11-02&sp=cw&sig=s1g" } });
    await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" });
    const sas = bucket(() => new Response("", { status: 201 }));
    await run(sas.f);
    expect(sas.puts[0]!.url).toBe("https://acmedata.blob.core.windows.net/rd-exports/rd/2026-09-01/transactions_20260901T120000Z.csv.gz?sv=2022-11-02&sp=cw&sig=s1g");
    expect(sas.puts[0]!.headers.get("authorization")).toBeNull();
    const denied = bucket(() => new Response("", { status: 403, headers: { "x-ms-error-code": "AuthorizationPermissionMismatch" } }));
    expect((await call("POST", `/integrations/exports/${job.id}/actions/check`, {}, denied.f)).body.message).toBe("Azure Blob Storage answered HTTP 403 (AuthorizationPermissionMismatch). Check that the credentials can list and write to the bucket.");
  });

  it("uploads to Google Cloud Storage with an HMAC key through the XML API", async () => {
    const call = api();
    const job = (await call("POST", "/integrations/exports", { destination: "gcs", tables: ["transactions"], config: { bucket: "acme-gcs", credential_type: "hmac", access_key_id: "GOOG1EXAMPLE" }, credentials: { secret_access_key: "gcs-hmac-secret" } })).body;
    expect(job.credentials).toEqual({ secret_access_key: { configured: true, hint: "••••cret" } });
    await sub("g2");
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const { f, puts } = bucket();
    await run(f);
    expect(puts[0]!.url).toBe("https://storage.googleapis.com/acme-gcs/2026-09-01/transactions_20260901T120000Z.csv.gz");
    expect(puts[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=GOOG1EXAMPLE\/20260901\/auto\/s3\/aws4_request, /);
    // Switching back to a service account drops the HMAC secret.
    const sa = await call("POST", `/integrations/exports/${job.id}`, { config: { credential_type: "service_account" }, credentials: { service_account_json: JSON.stringify(keys.sa) } });
    expect(sa.body.credentials).toEqual({ service_account_json: { configured: true, hint: "rd@scanner.iam.gserviceaccount.com" } });
  });

  it("email: recipients must be members; files are kept, links emailed, downloaded, and deleted after 7 days", async () => {
    await h.db.insert(schema.users).values([{ id: "u1", email: "Owner@Acme.test" }, { id: "u2", email: "outsider@acme.test" }]);
    await h.db.insert(schema.memberships).values({ userId: "u1", projectId: "proj1", role: "admin" });
    const mailer = memoryMailer();
    const app = createApp({ db: h.db, now: h.now, stores: defaultStores(), encryptionKey: KEY, mailer, publicUrl: "https://app.example.test" });
    const call = async (method: string, path: string, json?: unknown) => {
      const res = await app.fetch(new Request(`http://localhost${path.startsWith("/v2/") ? "" : "/v2/projects/proj1"}${path}`, { method, headers: { Authorization: `Bearer ${h.ids.secretKey}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined }));
      return { status: res.status, res, body: res.headers.get("content-type")?.includes("json") ? await res.json() as any : null };
    };
    expect((await call("POST", "/integrations/exports", { destination: "email", config: {} })).body.param).toBe("config.recipients");
    const outsider = await call("POST", "/integrations/exports", { destination: "email", config: { recipients: ["owner@acme.test", "outsider@acme.test"] } });
    expect([outsider.body.param, outsider.body.message]).toEqual(["config.recipients", "config.recipients: outsider@acme.test is not a member of this project. Invite them first."]);
    expect((await call("POST", "/integrations/exports", { destination: "email", config: { recipients: Array.from({ length: 26 }, (_, i) => `u${i}@acme.test`) } })).body.param).toBe("config.recipients");
    const job = (await call("POST", "/integrations/exports", { destination: "email", tables: ["transactions", "paywall_events"], config: { recipients: ["Owner@acme.test"], subject_prefix: "[Acme]" } })).body;
    expect(job).toMatchObject({ destination: "email", name: "Email export", credentials: {}, config: { recipients: ["owner@acme.test"], subject_prefix: "[Acme]" } });
    expect((await call("POST", `/integrations/exports/${job.id}/actions/check`, {})).body).toMatchObject({ ok: true });
    await sub("mail1");
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    const { f, puts } = bucket();
    await tick(h.db, h.now(), f, { encryptionKey: KEY, mailer, publicUrl: "https://app.example.test" });
    expect(puts).toHaveLength(0);
    const [r] = await h.db.select().from(schema.exportRuns);
    expect([r!.status, r!.notifiedAt?.toISOString(), r!.files.map((x) => x.key)]).toEqual(["succeeded", h.now().toISOString(), ["2026-09-01/transactions_20260901T120000Z.csv.gz", "2026-09-01/paywall_events_20260901T120000Z.csv.gz"]]);
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([["owner@acme.test", "[Acme] Email export: data export for 2026-09-01 (2 files)"]]);
    const links = [...mailer.sent[0]!.text.matchAll(/https:\/\/app\.example\.test(\/v2\/data-exports\/download\/\S+)/g)].map((m) => m[1]!);
    expect(links).toHaveLength(2);
    expect(mailer.sent[0]!.html).toContain("1 rows");
    const dl = await call("GET", links[0]!);
    expect([dl.status, dl.res.headers.get("content-disposition")]).toEqual([200, 'attachment; filename="transactions_20260901T120000Z.csv.gz"']);
    const csv = parseCsv(new TextDecoder().decode(await gunzip(new Uint8Array(await dl.res.arrayBuffer()))));
    expect(csv[1]![0]).toBe("mail1");
    expect((await call("GET", `${links[0]!.slice(0, -2)}xx`)).status).toBe(404);
    // A member who leaves does not block pausing; a subject prefix must be one line; duplicates collapse.
    await h.db.insert(schema.users).values({ id: "u3", email: "second@acme.test" });
    await h.db.insert(schema.memberships).values({ userId: "u3", projectId: "proj1", role: "admin" });
    expect((await call("POST", `/integrations/exports/${job.id}`, { config: { recipients: ["owner@acme.test", "second@acme.test", "Second@acme.test"] } })).body.config.recipients).toEqual(["owner@acme.test", "second@acme.test"]);
    await h.db.delete(schema.memberships).where(eq(schema.memberships.userId, "u3"));
    expect((await call("POST", `/integrations/exports/${job.id}`, { enabled: false })).body.enabled).toBe(false);
    expect((await call("POST", `/integrations/exports/${job.id}`, { config: { subject_prefix: "a\r\nBcc: x@evil.test" } })).body.param).toBe("config.subject_prefix");
    // Eight days later the links have expired and the files are gone.
    h.setNow(new Date(h.now().getTime() + 8 * DAY));
    expect((await call("GET", links[0]!)).status).toBe(404);
    await tick(h.db, h.now(), f, { encryptionKey: KEY, mailer, publicUrl: "https://app.example.test", exports: true });
    const [after] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, r!.id));
    expect(after!.filesDeletedAt).not.toBeNull();
    expect(await dbStore(h.db).get(`data-exports/proj1/${job.id}/${r!.id}/${r!.files[0]!.key}`)).toBeNull();
    // Switching an email export to a bucket deletes the files it kept at once (the 7-day cleanup only looks at email exports).
    await call("POST", `/integrations/exports/${job.id}`, { enabled: true });
    await call("POST", `/integrations/exports/${job.id}/actions/run`, {});
    await tick(h.db, h.now(), f, { encryptionKey: KEY, mailer, publicUrl: "https://app.example.test" });
    const [r2] = await h.db.select().from(schema.exportRuns).where(and(eq(schema.exportRuns.jobId, job.id), isNull(schema.exportRuns.filesDeletedAt)));
    const kept = `data-exports/proj1/${job.id}/${r2!.id}/${r2!.files[0]!.key}`;
    expect(await dbStore(h.db).get(kept)).not.toBeNull();
    expect((await call("POST", `/integrations/exports/${job.id}`, S3)).status).toBe(200);
    expect(await dbStore(h.db).get(kept)).toBeNull();
    expect((await h.db.select().from(schema.exportRuns).where(isNull(schema.exportRuns.filesDeletedAt))).length).toBe(0);
  });
});
