import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
    const job = (await call("POST", "/integrations/exports", { ...S3, tables: ["events"], compression: "none" })).body;
    // 10,500 events written by one statement: one created_at, with microseconds, for all of them.
    await h.db.execute(sql`insert into events (id, project_id, type, environment, payload, event_timestamp_ms, created_at)
      select 'bulk' || lpad(g::text, 6, '0'), 'proj1', 'TEST', 'production', '{"api_version":"1.0","event":{}}'::jsonb, 0, timestamptz '2026-09-01 11:00:00.123456+00'
      from generate_series(1, 10500) g`);
    const run = (await call("POST", `/integrations/exports/${job.id}/actions/run`, { mode: "full" })).body;
    const { f, puts } = bucket();
    const rt = { fetch: f, now: h.now(), secretKey: await secretKeyFrom(KEY, null) };
    expect(await runExport(h.db, run.id, rt, 0)).toBe(true);
    let [r] = await h.db.select().from(schema.exportRuns).where(eq(schema.exportRuns.id, run.id));
    expect([r!.status, r!.progress?.part, r!.files.length]).toEqual(["queued", 1, 1]);
    expect(await runExport(h.db, run.id, rt, 0)).toBe(true);
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
