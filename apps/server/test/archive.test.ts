import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { openDb, schema, type DB } from "@revenuedot/db";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { HttpSource, HttpTarget } from "../../../packages/importer/src/move/clients.js";
import { newMoveState, runMove, type Manifest } from "../../../packages/importer/src/move/core.js";
import { createApp } from "../src/app.js";
import { defaultStores } from "../src/stores/index.js";
import { secretKeyFrom, unseal, type SecretKey } from "../src/services/secrets.js";
import { ARCHIVE_SCHEMA, ARCHIVE_TABLES, NOT_EXPORTED, allSchemaTables, ident, rowsOf, scopeWhere, tableInfos } from "../src/services/archive/tables.js";
import { createImportToken } from "../src/services/archive/import.js";
import { gunzip, sha256Hex, untar } from "../src/services/archive/format.js";
import { tick } from "../src/services/tick.js";
import { moveStateChanged } from "../src/services/archive/gate.js";
import { seedEverything } from "./archive-seed.js";

/**
 * Full export and import (prd/moves-export/PRD.md): a project with a row in every exported table goes through the real
 * HTTP endpoints of two servers (each its own database and sealing key) with the CLI's move client, and every table on
 * the target equals the source, secrets included when a passphrase is given.
 */

const K1 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const K2 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => 200 - i)));
const PASS = "correct horse battery staple";

let src: Harness;
let dst: { db: DB; close: () => Promise<void> };
let k1: SecretKey, k2: SecretKey;
let srcApp: ReturnType<typeof createApp>, dstApp: ReturnType<typeof createApp>;
const fetchOf = (app: { fetch: (r: Request) => Response | Promise<Response> }) => ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url as string, init)))) as typeof fetch;
/** One fake network: requests to target.test reach the target app, source.test the source. */
const net = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  return Promise.resolve((u.includes("target.test") ? dstApp : srcApp).fetch(new Request(u, init)));
}) as typeof fetch;

beforeEach(async () => {
  src = await harness({ encryptionKey: K1 });
  k1 = (await secretKeyFrom(K1))!;
  k2 = (await secretKeyFrom(K2))!;
  await src.db.insert(schema.users).values({ id: "usr_owner", email: "owner@example.com", name: "Owner" });
  await seedEverything(src.db, k1, { userId: "usr_owner" });
  dst = await openDb("pglite://memory");
  await dst.db.insert(schema.users).values([{ id: "usr_target", email: "mover@example.com" }, { id: "usr_owner_t", email: "owner@example.com" }]);
  srcApp = createApp({ db: src.db, now: src.now, stores: defaultStores(), encryptionKey: K1, fetch: net, apiUrl: "http://source.test", moveDrainSeconds: 0 });
  dstApp = createApp({ db: dst.db, now: src.now, stores: defaultStores(), encryptionKey: K2, fetch: net, apiUrl: "http://target.test" });
});
afterEach(async () => { await src.close(); await dst.close(); });

async function rowsIn(db: DB, table: string, project = "proj1") {
  const t = tableInfos().get(table)!;
  const cols = sql.join(t.columns.map((c) => sql`t.${ident(c)}`), sql`, `);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
    const r = rowsOf<{ j: string }>(await tx.execute(sql`SELECT row_to_json(x)::text AS j FROM (SELECT ${cols} FROM ${ident(table)} t WHERE ${scopeWhere(table, project)} ORDER BY ${sql.join(t.pk.map((c) => sql`t.${ident(c)}`), sql`, `)}) x`));
    return r.map((x) => JSON.parse(x.j) as Record<string, unknown>);
  });
}

/** Rows with sealed columns opened, so ciphertexts under two keys compare by what they hold. */
async function opened(db: DB, table: string, key: SecretKey) {
  const t = tableInfos().get(table)!;
  const rows = await rowsIn(db, table);
  for (const r of rows) for (const [c, spec] of Object.entries(t.secrets ?? {})) if (spec.sealed && r[c]) r[c] = await unseal(r[c] as string, key);
  return rows;
}

async function move(passphrase: string | null, mode: "copy" | "finish" = "copy", reuse?: string) {
  const token = reuse ?? (await createImportToken(dst.db, "usr_target", src.now())).token;
  const source = new HttpSource("http://source.test", src.ids.secretKey, { fetch: net, sleep: async () => {} });
  const target = new HttpTarget("http://target.test", token, { fetch: net, sleep: async () => {} });
  const state = newMoveState("http://source.test", "http://target.test", mode);
  const logs: string[] = [];
  await runMove({ source, target, passphrase, drainSeconds: 0, log: (m) => logs.push(m) }, state);
  return { state, logs, token, target };
}

describe("archive tables", () => {
  it("every table in the schema is exported or listed with a reason, and the schema tag is the last migration", () => {
    const listed = new Set([...ARCHIVE_TABLES.map((t) => t.name), ...Object.keys(NOT_EXPORTED)]);
    expect(allSchemaTables().filter((t) => !listed.has(t))).toEqual([]);
    expect(ARCHIVE_TABLES.filter((t) => NOT_EXPORTED[t.name])).toEqual([]);
    const journal = JSON.parse(readFileSync(new URL("../../../packages/db/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string }[] };
    expect(ARCHIVE_SCHEMA).toBe(journal.entries.at(-1)!.tag);
  });

  it("the seed puts at least one row in every exported table", async () => {
    const empty: string[] = [];
    for (const t of ARCHIVE_TABLES) if (!(await rowsIn(src.db, t.name)).length) empty.push(t.name);
    expect(empty).toEqual([]);
  });
});

describe("export and import round trip", () => {
  it("with a passphrase: every table on the target equals the source, secrets resealed with the target's key, checksums verified", async () => {
    const { state, logs } = await move(PASS);
    expect(state.phase).toBe("done");
    expect(state.verify!.every((t) => t.match)).toBe(true);
    expect(state.verify!.length).toBe(ARCHIVE_TABLES.length);
    expect(logs.join("\n")).toMatch(/every count and checksum matches/);
    for (const t of ARCHIVE_TABLES) {
      const a = await opened(src.db, t.name, k1);
      const b = await opened(dst.db, t.name, k2);
      expect({ table: t.name, rows: b }).toEqual({ table: t.name, rows: a });
    }
    // Sealed with the target's own key: the source's key cannot open it.
    const [app] = await dst.db.select().from(schema.apps).where(eq(schema.apps.id, "app_stripe"));
    await expect(unseal(app!.secrets, k1)).rejects.toThrow();
    expect(await unseal(app!.secrets, k2)).toEqual({ stripe_secret_key: "rk_test_seedSecretKeyValue1234", stripe_webhook_secret: "whsec_seedwebhook" });
    // The project here belongs to the importing user, is held while being copied, and the secret key still works.
    const [p] = await dst.db.select().from(schema.projects).where(eq(schema.projects.id, "proj1"));
    expect(p).toMatchObject({ ownerUserId: "usr_target", moveState: "incoming", movedInFrom: "http://source.test" });
    expect((await dstApp.fetch(new Request("http://target.test/v2/projects/proj1/apps", { headers: { authorization: `Bearer ${src.ids.secretKey}` } }))).status).toBe(200);
    // Not exported: subscriber tokens and accounts.
    expect(await dst.db.select().from(schema.subscriberTokens)).toEqual([]);
  });

  it("without a passphrase: secret columns stay empty, webhooks get new signing secrets, apps needing credentials are listed", async () => {
    const { state, target } = await move(null);
    expect(state.verify!.every((t) => t.match)).toBe(true);
    const [hook] = await dst.db.select().from(schema.webhooks);
    expect(hook).toMatchObject({ signingSecret: "", authorizationHeader: null, url: "https://example.com/hook" });
    const [ios] = await dst.db.select().from(schema.apps).where(eq(schema.apps.id, "app_ios"));
    expect(ios!.credentials).toEqual({});
    const [checkout] = await dst.db.select().from(schema.webCheckouts);
    expect(checkout!.redemptionSeed).toBeNull();
    const report = await target.finish(state.importId!);
    const [after] = await dst.db.select().from(schema.webhooks);
    expect(after!.signingSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(report.webhooks_with_new_secrets.map((w) => w.id)).toEqual(["wh_1"]);
    expect(report.apps_needing_credentials.map((a) => a.id).sort()).toEqual(["app_ios", "app_play", "app_stripe"]);
    expect(report.notification_urls).toContainEqual(expect.objectContaining({ app_id: "app_ios", url: "http://target.test/v1/notifications/apple/app_ios" }));
    expect(report.notification_urls).toContainEqual(expect.objectContaining({ app_id: "app_play", url: "http://target.test/v1/notifications/google/app_play" }));
    // Collaborators by email: the source owner has an account here and joins as Admin.
    expect(report.members_added).toEqual([{ email: "owner@example.com", role: "admin" }]);
    const [p] = await dst.db.select().from(schema.projects);
    expect(p!.moveState).toBeNull();
  });

  it("a wrong passphrase, a newer schema and a damaged file are refused", async () => {
    const token = (await createImportToken(dst.db, "usr_target", src.now())).token;
    const source = new HttpSource("http://source.test", src.ids.secretKey, { fetch: net, sleep: async () => {} });
    const e = await source.startExport(PASS);
    let x = e;
    while (x.status !== "succeeded") x = await source.advanceExport(e.id);
    const manifest = JSON.parse(new TextDecoder().decode(await source.readFile(e.id, "manifest.json"))) as Manifest;
    const call = (path: string, init: RequestInit) => net(`http://target.test${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    const newer = await call("/v2/imports", { method: "POST", body: JSON.stringify({ manifest: { ...manifest, schema: "9999_future" }, dry_run: true }) });
    expect(newer.status).toBe(422);
    expect((await newer.json() as { message: string }).message).toMatch(/newer RevenueDot/);
    const noPass = await call("/v2/imports", { method: "POST", body: JSON.stringify({ manifest }) });
    expect(noPass.status).toBe(400);
    const begun = await call("/v2/imports", { method: "POST", body: JSON.stringify({ manifest, passphrase: "a wrong passphrase!" }) });
    expect(begun.status).toBe(201);
    const imp = await begun.json() as { id: string };
    const target = new HttpTarget("http://target.test", token, { fetch: net, sleep: async () => {}, maxRetries: 0 });
    for (const t of manifest.tables) for (const f of t.files) await target.putFile(imp.id, f.name, await source.readFile(e.id, f.name));
    const secret = manifest.tables.find((t) => t.secret_files?.length)!.secret_files![0]!;
    const wrong = await net(`http://target.test/v2/imports/${imp.id}/files/${secret.name}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: await source.readFile(e.id, secret.name) as Uint8Array<ArrayBuffer> });
    expect(wrong.status).toBe(400);
    expect((await wrong.json() as { message: string }).message).toMatch(/passphrase is wrong/);
    const damaged = await net(`http://target.test/v2/imports/${imp.id}/files/${manifest.tables[0]!.files[0]!.name}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array([1, 2, 3]) });
    expect(damaged.status).toBe(400);
  });

  it("resumes: a copy that stopped after some files continues without sending them again", async () => {
    const token = (await createImportToken(dst.db, "usr_target", src.now())).token;
    const source = new HttpSource("http://source.test", src.ids.secretKey, { fetch: net, sleep: async () => {} });
    let puts = 0, fail = true;
    const counting = ((url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") { puts++; if (fail && puts === 5) return Promise.reject(new Error("network down")); }
      return net(url, init);
    }) as typeof fetch;
    const target = new HttpTarget("http://target.test", token, { fetch: counting, sleep: async () => {}, maxRetries: 0 });
    const state = newMoveState("http://source.test", "http://target.test", "copy");
    await expect(runMove({ source, target, passphrase: PASS, drainSeconds: 0 }, state)).rejects.toThrow(/network down/);
    expect(state.phase).toBe("copy");
    expect(Object.keys(state.done)).toHaveLength(4);
    fail = false;
    const before = puts;
    await runMove({ source, target, passphrase: PASS, drainSeconds: 0 }, state);
    expect(state.phase).toBe("done");
    const total = (JSON.parse(new TextDecoder().decode(await source.readFile(state.exportId!, "manifest.json"))) as Manifest).tables.reduce((n, t) => n + t.files.length + (t.secret_files?.length ?? 0), 0);
    expect(puts - before).toBe(total - 4);
  });

  it("the download link serves the whole archive as a tar whose files match the manifest", async () => {
    const H = { authorization: `Bearer ${src.ids.secretKey}`, "content-type": "application/json" };
    let e = await (await srcApp.fetch(new Request("http://source.test/v2/projects/proj1/exports", { method: "POST", headers: H, body: "{}" }))).json() as { id: string; status: string; download_url?: string };
    while (e.status !== "succeeded") e = await (await srcApp.fetch(new Request(`http://source.test/v2/projects/proj1/exports/${e.id}/actions/advance`, { method: "POST", headers: H }))).json() as typeof e;
    expect(e.download_url).toMatch(/^http:\/\/source\.test\/v2\/exports\/download\/exp_/);
    const res = await srcApp.fetch(new Request(e.download_url!));
    expect(res.headers.get("content-type")).toBe("application/x-tar");
    const files = untar(new Uint8Array(await res.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")!)) as Manifest;
    expect(manifest).toMatchObject({ format: "revenuedot-export", version: 1, schema: ARCHIVE_SCHEMA, project: { id: "proj1", name: "Scanner" }, secrets: { included: false } });
    for (const t of manifest.tables) for (const f of t.files) expect(await sha256Hex(files.get(f.name)!)).toBe(f.sha256);
    const customers = new TextDecoder().decode(await gunzip(files.get("tables/customers/0001.jsonl.gz")!)).trim().split("\n").map((l) => JSON.parse(l));
    expect(customers.map((c) => c.original_app_user_id).sort()).toEqual(["$RCAnonymousID:abc", "u1"]);
    expect(JSON.parse(new TextDecoder().decode(files.get("members.json")!))).toEqual([{ email: "owner@example.com", name: "Owner", role: "admin", owner: true }]);
    // No secret in a plain archive.
    const all = [...files.values()].map((b) => new TextDecoder().decode(b)).join("");
    for (const secret of ["whsec_original_signing_secret", "Bearer backend-token", "BEGIN PRIVATE KEY", "seed-secret-value"]) expect(all).not.toContain(secret);
    // A tampered or expired link is refused.
    expect((await srcApp.fetch(new Request(e.download_url!.replace(/.$/, "x")))).status).toBe(404);
    src.setNow(new Date(src.now().getTime() + 2 * 3600_000));
    expect((await srcApp.fetch(new Request(e.download_url!))).status).toBe(404);
  });
});

describe("move states", () => {
  it("finish: the source pauses, the target goes live, and the source forwards SDK calls, notifications and REST calls", async () => {
    const first = await move(PASS, "copy");
    expect(first.state.phase).toBe("done");
    // A delivery queued on the source waits while it is paused: the tick skips moving projects.
    const sdk = (path: string, init: RequestInit = {}) => srcApp.fetch(new Request(`http://source.test${path}`, { ...init, headers: { authorization: `Bearer ${src.ids.testKey}`, "content-type": "application/json", ...(init.headers ?? {}) } }));
    const pause = await srcApp.fetch(new Request("http://source.test/v2/projects/proj1/move/pause", { method: "POST", headers: { authorization: `Bearer ${src.ids.secretKey}` } }));
    expect(pause.status).toBe(200);
    const paused = await sdk("/v1/receipts", { method: "POST", body: JSON.stringify({ app_user_id: "u9", fetch_token: "test_x", product_id: "pro_monthly" }) });
    expect(paused.status).toBe(503);
    expect(paused.headers.get("retry-after")).toBe("60");
    expect((await sdk("/v1/subscribers/u1")).status).toBe(200);
    const sent: string[] = [];
    await tick(src.db, src.now(), (async (u: string) => { sent.push(String(u)); return new Response("ok"); }) as unknown as typeof fetch, { encryptionKey: K1, archives: false });
    expect(sent).toEqual([]);
    // Finish from the paused state: copy again, verify, live on the target, forward the source.
    const fin = await move(PASS, "finish", first.token);
    expect(fin.state.phase).toBe("done");
    expect(fin.state.report!.project_id).toBe("proj1");
    const [srcP] = await src.db.select().from(schema.projects);
    expect(srcP).toMatchObject({ moveState: "forwarded", movedToUrl: "http://target.test" });
    // An SDK purchase sent to the old server is made on the new one (the old app build keeps working). The buyer is on
    // the project's sandbox allowlist, which moved too, so the Test Store purchase unlocks pro.
    const buy = await sdk("/v1/receipts", { method: "POST", body: JSON.stringify({ app_user_id: "ünïcode", fetch_token: `test_${src.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 4.99, currency: "USD" }) });
    expect({ status: buy.status, body: buy.status === 200 ? null : await buy.clone().text() }).toEqual({ status: 200, body: null });
    expect(buy.headers.get("x-revenuedot-moved-to")).toBe("http://target.test");
    expect((await buy.json() as { subscriber: { entitlements: Record<string, unknown> } }).subscriber.entitlements.pro).toBeTruthy();
    expect(await dst.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, "ünïcode"))).toHaveLength(1);
    expect(await src.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, "ünïcode"))).toHaveLength(0);
    // REST v2 with a secret key goes there too; a dashboard write here is refused.
    const rest = await srcApp.fetch(new Request("http://source.test/v2/projects/proj1/customers/%C3%BCn%C3%AFcode", { headers: { authorization: `Bearer ${src.ids.secretKey}` } }));
    expect(rest.status).toBe(200);
    // A store notification sent to the old URL reaches the new server (until the URL is changed in App Store Connect).
    const note = await srcApp.fetch(new Request("http://source.test/v1/notifications/apple/app_ios", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signedPayload: "not.a.jws" }) }));
    expect(note.headers.get("x-revenuedot-moved-to")).toBe("http://target.test");
    expect(await dst.db.select().from(schema.storeNotifications).where(eq(schema.storeNotifications.body, JSON.stringify({ signedPayload: "not.a.jws" })))).toHaveLength(1);
    // The pending delivery moved with the data and is sent by the target, once.
    const dsent: string[] = [];
    await tick(dst.db, src.now(), (async (u: string) => { dsent.push(String(u)); return new Response("ok"); }) as unknown as typeof fetch, { encryptionKey: K2, archives: false });
    expect(dsent).toContain("https://example.com/hook");
    // Cancel on the old server stops forwarding (a rollback).
    const cancel = await srcApp.fetch(new Request("http://source.test/v2/projects/proj1/move/cancel", { method: "POST", headers: { authorization: `Bearer ${src.ids.secretKey}` } }));
    expect((await cancel.json() as { state: string | null }).state).toBeNull();
    expect((await sdk("/v1/subscribers/u1")).headers.get("x-revenuedot-moved-to")).toBeNull();
  });

  it("a forwarding loop answers 508 and a copy into a project that exists here is refused", async () => {
    await src.db.update(schema.projects).set({ moveState: "forwarded", movedToUrl: "http://source.test" });
    moveStateChanged();
    const loop = await srcApp.fetch(new Request("http://source.test/v1/subscribers/u1", { headers: { authorization: `Bearer ${src.ids.testKey}`, "x-revenuedot-forwarded": "1" } }));
    expect(loop.status).toBe(508);
    await src.db.update(schema.projects).set({ moveState: null, movedToUrl: null });
    moveStateChanged();
    await dst.db.insert(schema.projects).values({ id: "proj1", name: "Someone else's" });
    await expect(move(PASS)).rejects.toThrow(/already exists/);
  });

  it("the dashboard's move: this server runs the copy, the dry run, verification and the finish itself", async () => {
    const token = (await createImportToken(dst.db, "usr_target", src.now())).token;
    const H = { authorization: `Bearer ${src.ids.secretKey}`, "content-type": "application/json" };
    const call = async (path: string, body?: unknown) => (await srcApp.fetch(new Request(`http://source.test/v2/projects/proj1${path}`, { method: body === undefined ? "GET" : "POST", headers: H, body: body === undefined ? undefined : JSON.stringify(body) }))).json() as Promise<Record<string, any>>;
    const until = async (want: string[]) => {
      let m = await call("/move/actions/advance", {});
      for (let i = 0; i < 200 && !want.includes(m.status); i++) m = await call("/move/actions/advance", {});
      return m;
    };
    const bad = await srcApp.fetch(new Request("http://source.test/v2/projects/proj1/move", { method: "POST", headers: H, body: JSON.stringify({ to_url: "http://source.test", to_token: token }) }));
    expect(bad.status).toBe(400);
    let m = await call("/move", { to_url: "http://target.test", to_token: token, dry_run: true });
    m = await until(["ready", "failed"]);
    expect(m).toMatchObject({ status: "ready", dry_run: true });
    expect(m.plan.tables.find((t: { name: string }) => t.name === "customers")).toEqual({ name: "customers", archive_rows: 2, target_rows: 0 });
    expect(await dst.db.select().from(schema.projects)).toEqual([]);
    m = await call("/move", { to_url: "http://target.test", to_token: token });
    m = await until(["copied", "failed"]);
    expect(m.status, m.error).toBe("copied");
    expect(m.verify.every((t: { match: boolean }) => t.match)).toBe(true);
    m = await call("/move/finish", {});
    m = await until(["finished", "failed"]);
    expect(m.status, m.error).toBe("finished");
    expect(m.report.notification_urls.length).toBeGreaterThan(0);
    const state = await call("/move");
    expect(state).toMatchObject({ state: "forwarded", moved_to_url: "http://target.test" });
    const [p] = await dst.db.select().from(schema.projects);
    expect(p!.moveState).toBeNull();
  });
});

