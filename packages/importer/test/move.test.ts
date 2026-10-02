// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: `npx revenuedot move` and `npx revenuedot export` against two in-process RevenueDot servers, each with its own
// database and sealing key: the dry run's diff, the copy and its verification, resuming, the finish (pause, last copy,
// go live, forward), an export to a .tar and a move from that archive into a third server.
// Docs: https://revenuedot.app/docs/guides/move-projects
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDb, schema, type DB } from "@revenuedot/db";
import { createApp } from "../../../apps/server/src/app.js";
import { defaultStores } from "../../../apps/server/src/stores/index.js";
import { createImportToken } from "../../../apps/server/src/services/archive/import.js";
import { harness, type Harness } from "../../contract/src/harness.js";
import { main, type CliIO } from "../src/cli.js";

const K1 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 3)));
const K2 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => 90 + i)));
let src: Harness;
let dst: { db: DB; close: () => Promise<void> };
let third: { db: DB; close: () => Promise<void> } | undefined;
let apps: Record<string, ReturnType<typeof createApp>>;
let dir: string;
/** Tests: file uploads to target.test fail (the network drops during a copy). */
let targetDown = false;
const net = ((url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url instanceof Request ? url.url : url));
  if (targetDown && u.host === "target.test" && init?.method === "PUT") return Promise.reject(new Error("network down"));
  return Promise.resolve(apps[u.host]!.fetch(new Request(u, init)));
}) as typeof fetch;

beforeEach(async () => {
  src = await harness({ encryptionKey: K1 });
  await src.db.insert(schema.users).values({ id: "usr_o", email: "owner@example.com" });
  await src.db.insert(schema.memberships).values({ userId: "usr_o", projectId: "proj1", role: "admin" });
  await src.db.insert(schema.webhooks).values({ id: "wh_1", projectId: "proj1", name: "Backend", url: "https://example.com/hook", signingSecret: "whsec_keepme" });
  // Two customers with a purchase each, through the SDK.
  for (const u of ["alice", "bob"]) {
    const r = await src.fetch("/v1/receipts", { method: "POST", key: src.ids.testKey, json: { app_user_id: u, fetch_token: `test_${src.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect(r.status).toBe(200);
  }
  dst = await openDb("pglite://memory");
  await dst.db.insert(schema.users).values({ id: "usr_t", email: "mover@example.com" });
  apps = {
    "source.test": createApp({ db: src.db, now: src.now, stores: defaultStores(), encryptionKey: K1, fetch: net, apiUrl: "http://source.test" }),
    "target.test": createApp({ db: dst.db, now: src.now, stores: defaultStores(), encryptionKey: K2, fetch: net, apiUrl: "http://target.test" }),
  };
  dir = mkdtempSync(join(tmpdir(), "rd-move-"));
  targetDown = false;
});
afterEach(async () => { await src.close(); await dst.close(); await third?.close(); third = undefined; });

/** The third server (the archive test only): one in-memory database fewer to migrate for every other test. */
async function openThird() {
  third = await openDb("pglite://memory");
  await third.db.insert(schema.users).values({ id: "usr_t", email: "mover@example.com" });
  apps["third.test"] = createApp({ db: third.db, now: src.now, stores: defaultStores(), encryptionKey: K2, fetch: net, apiUrl: "http://third.test" });
  return third;
}

async function cli(args: string[], env: Record<string, string>) {
  const out: string[] = [], err: string[] = [];
  // --finish waits 10 seconds for the pause to reach every server process: the waits move this clock, not the real one.
  let clock = Date.now();
  const io: CliIO = { out: (s) => out.push(s), err: (s) => err.push(s), env, http: { fetch: net, sleep: async () => {} }, sleep: async (ms) => { clock += ms; }, now: () => clock };
  const code = await main(args, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("npx revenuedot move", () => {
  it("dry run, copy, finish: the diff, the verification, then the switch with forwarding", async () => {
    const token = (await createImportToken(dst.db, "usr_t", src.now())).token;
    const env = { REVENUEDOT_FROM_KEY: src.ids.secretKey, REVENUEDOT_TO_TOKEN: token };
    const state = join(dir, "state.json");
    const base = ["move", "--from", "http://source.test", "--to", "http://target.test", "--state", state];

    const dry = await cli([...base, "--dry-run"], env);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/new on the target/);
    expect(dry.out).toMatch(/customers\s+2\s+0\s+\+2/);
    expect(dry.out).toMatch(/Nothing was written/);
    expect(await dst.db.select().from(schema.projects)).toEqual([]);

    const copy = await cli(base, env);
    expect(copy.code, copy.err).toBe(0);
    expect(copy.out).toMatch(/All 68 tables match/);
    expect(copy.out).toMatch(/still serves the project/);
    const [incoming] = await dst.db.select().from(schema.projects);
    expect(incoming!.moveState).toBe("incoming");
    // The state file never holds a key, a token or the passphrase.
    const saved = readFileSync(state, "utf8");
    expect(saved).not.toContain(src.ids.secretKey);
    expect(saved).not.toContain(token);

    // A purchase on the old server after the copy is carried over by --finish.
    await src.fetch("/v1/receipts", { method: "POST", key: src.ids.testKey, json: { app_user_id: "carol", fetch_token: `test_${src.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    const fin = await cli([...base, "--finish"], env);
    expect(fin.code, fin.err).toBe(0);
    expect(fin.err).toMatch(/Paused writes on http:\/\/source\.test/);
    expect(fin.out).toMatch(/Moved\. Project proj1 now lives on http:\/\/target\.test/);
    expect(fin.out).toMatch(/http:\/\/target\.test\/v1\/notifications\/apple\/app_ios/);
    expect(fin.out).toMatch(/App Store Connect/);
    expect(await dst.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, "carol"))).toHaveLength(1);
    const [live] = await dst.db.select().from(schema.projects);
    expect(live!.moveState).toBeNull();
    const [old] = await src.db.select().from(schema.projects);
    expect(old).toMatchObject({ moveState: "forwarded", movedToUrl: "http://target.test" });
    // The webhook keeps its signing secret (the move always carries secrets, encrypted with a passphrase it never shows).
    const [hook] = await dst.db.select().from(schema.webhooks);
    expect(hook!.signingSecret).toBe("whsec_keepme");
    // The app's key still works against the new server, and the old server forwards to it.
    const viaOld = await net("http://source.test/v1/subscribers/carol", { headers: { authorization: `Bearer ${src.ids.testKey}` } });
    expect(viaOld.headers.get("x-revenuedot-moved-to")).toBe("http://target.test");
    expect(((await viaOld.json()) as { subscriber: { entitlements: Record<string, unknown> } }).subscriber.entitlements.pro).toBeTruthy();
  });

  it("--finish that fails before the new server is live gives the old server its writes back; running again finishes", async () => {
    const token = (await createImportToken(dst.db, "usr_t", src.now())).token;
    const env = { REVENUEDOT_FROM_KEY: src.ids.secretKey, REVENUEDOT_TO_TOKEN: token };
    const base = ["move", "--from", "http://source.test", "--to", "http://target.test", "--state", join(dir, "state.json")];
    expect((await cli(base, env)).code).toBe(0);
    targetDown = true;
    const failed = await cli([...base, "--finish"], env);
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/network down/);
    expect(failed.err).toMatch(/http:\/\/source\.test serves the project again/);
    const [old] = await src.db.select().from(schema.projects);
    expect(old!.moveState).toBeNull();
    const buy = await src.fetch("/v1/receipts", { method: "POST", key: src.ids.testKey, json: { app_user_id: "dave", fetch_token: `test_${src.now().getTime()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD" } });
    expect(buy.status).toBe(200);
    targetDown = false;
    const fin = await cli([...base, "--finish"], env);
    expect(fin.code, fin.err).toBe(0);
    expect((await src.db.select().from(schema.projects))[0]).toMatchObject({ moveState: "forwarded", movedToUrl: "http://target.test" });
    expect(await dst.db.select().from(schema.customerAliases).where(eq(schema.customerAliases.appUserId, "dave"))).toHaveLength(1);
  });

  it("refuses bad keys before doing anything, and a wrong token is a clear error", async () => {
    const bad = await cli(["move", "--from", "http://source.test", "--to", "http://target.test"], { REVENUEDOT_FROM_KEY: "appl_public", REVENUEDOT_TO_TOKEN: "rdi_x" });
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/not a RevenueDot secret key/);
    const wrong = await cli(["move", "--from", "http://source.test", "--to", "http://target.test", "--state", join(dir, "s.json")], { REVENUEDOT_FROM_KEY: src.ids.secretKey, REVENUEDOT_TO_TOKEN: `rdi_${"0".repeat(64)}` });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/import token/);
    // The same command with the right token, same state file: it exports again and moves.
    const token = (await createImportToken(dst.db, "usr_t", src.now())).token;
    const right = await cli(["move", "--from", "http://source.test", "--to", "http://target.test", "--state", join(dir, "s.json")], { REVENUEDOT_FROM_KEY: src.ids.secretKey, REVENUEDOT_TO_TOKEN: token });
    expect(right.code, right.err).toBe(0);
    expect(right.out).toMatch(/All 68 tables match/);
  });
});

describe("npx revenuedot export", () => {
  it("saves the archive as a tar, which then moves into another server", async () => {
    const out = join(dir, "proj1.tar");
    const r = await cli(["export", "--from", "http://source.test", "--out", out], { REVENUEDOT_FROM_KEY: src.ids.secretKey });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Saved .*proj1\.tar.*project Scanner \(proj1\).*no secrets/);
    expect(existsSync(out)).toBe(true);
    const third = await openThird();
    const token = (await createImportToken(third.db, "usr_t", src.now())).token;
    const m = await cli(["move", "--from-archive", out, "--to", "http://third.test", "--state", join(dir, "a.json")], { REVENUEDOT_TO_TOKEN: token });
    expect(m.code, m.err).toBe(0);
    expect(m.out).toMatch(/All 68 tables match/);
    expect(await third.db.select().from(schema.customerAliases)).toHaveLength(2);
    // Without secrets the webhook's signing secret is not in the archive.
    const [hook] = await third.db.select().from(schema.webhooks);
    expect(hook!.signingSecret).toBe("");
  });
});
