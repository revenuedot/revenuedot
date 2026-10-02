// Several replicas (or the Worker's cron and a request-kicked run) working at once must not send a webhook twice or record
// an expiration twice (prd/ha-self-host/PRD.md). The three-replica run on a real Postgres is scripts/e2e/cluster/run.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import { recordDueExpirations } from "@revenuedot/server/services/tick.js";
import { deliverDue, DELIVERY_LEASE_MS } from "@revenuedot/server/services/webhooks.js";
import { clusterSettingsFromEnv, healthResponse, localLock } from "@revenuedot/server/cluster.js";
import { harness, type Harness } from "../src/harness.js";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const buy = (user: string, product: string, at: Date) =>
  h.fetch("/v1/receipts", { method: "POST", key: h.ids.testKey, json: { app_user_id: user, fetch_token: `test_${at.getTime()}_${crypto.randomUUID()}`, product_id: product, price: 9.99, currency: "USD" } });

describe("background work run twice at once", () => {
  it("sends each webhook delivery once, even when two runs pick the same rows", async () => {
    await h.db.insert(schema.webhooks).values({ id: "wh1", projectId: h.ids.project, name: "Backend", url: "https://hooks.example.com/rc", signingSecret: "whsec_test" });
    for (let i = 0; i < 6; i++) await buy(`cl_user_${i}`, "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    expect(await h.db.select().from(schema.webhookDeliveries)).toHaveLength(6);
    const bodies: string[] = [];
    // A slow receiver, so both runs have selected the due rows before either finishes a send.
    const slow: typeof fetch = async (_u, init) => { bodies.push(String(init!.body)); await new Promise((r) => setTimeout(r, 20)); return new Response("ok", { status: 200 }); };
    const [a, b] = await Promise.all([deliverDue(h.db, slow, h.now()), deliverDue(h.db, slow, h.now())]);
    expect(a + b).toBe(6);
    expect(bodies).toHaveLength(6);
    expect(new Set(bodies.map((x) => JSON.parse(x).event.id)).size).toBe(6);
    const rows = await h.db.select().from(schema.webhookDeliveries);
    expect(rows.every((d) => d.status === "delivered" && d.attempts === 1)).toBe(true);
  });

  it("a burst bigger than one batch goes out in one run, one webhook at a time in order, several webhooks in parallel", async () => {
    await h.db.insert(schema.webhooks).values([
      { id: "wh1", projectId: h.ids.project, name: "A", url: "https://a.example.com/rc", signingSecret: "whsec_a" },
      { id: "wh2", projectId: h.ids.project, name: "B", url: "https://b.example.com/rc", signingSecret: "whsec_b" },
    ]);
    for (let i = 0; i < 5; i++) await buy(`cl_burst_${i}`, "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    const seen: Record<string, string[]> = {};
    let inFlight = 0, maxInFlight = 0;
    const slow: typeof fetch = async (u, init) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      (seen[new URL(String(u)).host] ??= []).push(JSON.parse(String(init!.body)).event.app_user_id);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return new Response("ok", { status: 200 });
    };
    expect(await deliverDue(h.db, slow, h.now(), 3)).toBe(10);
    expect(seen["a.example.com"]).toEqual([0, 1, 2, 3, 4].map((i) => `cl_burst_${i}`));
    expect(seen["b.example.com"]).toHaveLength(5);
    expect(maxInFlight).toBe(2);
  });

  it("a replica that starts draining finishes the send in flight, claims no more, and leaves the rest due for another replica", async () => {
    await h.db.insert(schema.webhooks).values({ id: "wh1", projectId: h.ids.project, name: "Backend", url: "https://hooks.example.com/rc", signingSecret: "whsec_test" });
    for (let i = 0; i < 4; i++) await buy(`cl_drain_${i}`, "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    const stop = new AbortController();
    const ok: typeof fetch = async () => { stop.abort(); return new Response("ok", { status: 200 }); };
    expect(await deliverDue(h.db, ok, h.now(), 50, 20_000, stop.signal)).toBe(1);
    const rows = await h.db.select().from(schema.webhookDeliveries);
    expect(rows.filter((d) => d.status === "delivered")).toHaveLength(1);
    expect(rows.filter((d) => d.status === "pending" && d.nextAttemptAt <= h.now())).toHaveLength(3);
    expect(await deliverDue(h.db, async () => new Response("ok", { status: 200 }), h.now())).toBe(3);
  });

  it("a delivery claimed by a run that died is sent again once its lease lapses", async () => {
    await h.db.insert(schema.webhooks).values({ id: "wh1", projectId: h.ids.project, name: "Backend", url: "https://hooks.example.com/rc", signingSecret: "whsec_test" });
    await buy("cl_dead", "pro_monthly", new Date("2026-09-01T11:00:00Z"));
    const [d] = await h.db.select().from(schema.webhookDeliveries);
    // What a run leaves behind when its process is killed mid-send: the claim, and no result.
    await h.db.update(schema.webhookDeliveries).set({ nextAttemptAt: new Date(h.now().getTime() + DELIVERY_LEASE_MS) }).where(eq(schema.webhookDeliveries.id, d!.id));
    const ok: typeof fetch = async () => new Response("ok", { status: 200 });
    expect(await deliverDue(h.db, ok, h.now())).toBe(0);
    expect(await deliverDue(h.db, ok, new Date(h.now().getTime() + DELIVERY_LEASE_MS))).toBe(1);
    const [after] = await h.db.select().from(schema.webhookDeliveries);
    expect(after!.status).toBe("delivered");
  });

  it("records one EXPIRATION per subscription when two scans run at once", async () => {
    for (let i = 0; i < 4; i++) await buy(`cl_exp_${i}`, "pro_monthly", new Date("2026-08-01T00:00:00Z"));
    const later = new Date("2026-11-02T00:00:00Z");
    const [a, b] = await Promise.all([recordDueExpirations(h.db, later), recordDueExpirations(h.db, later)]);
    expect(a + b).toBe(4);
    const ev = await h.db.select().from(schema.events).where(eq(schema.events.type, "EXPIRATION"));
    expect(ev).toHaveLength(4);
    expect(await recordDueExpirations(h.db, later)).toBe(0);
  });
});

describe("cluster helpers", () => {
  it("the lock lets one of two concurrent runs through", async () => {
    const lock = localLock();
    let release!: () => void;
    const first = lock.tryRun(() => new Promise<string>((r) => { release = () => r("first"); }));
    expect(await lock.tryRun(async () => "second")).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, value: "first" });
    expect(await lock.tryRun(async () => "third")).toEqual({ ran: true, value: "third" });
  });

  it("readiness answers 503 while draining or when the database does not answer; liveness never asks the database", async () => {
    let draining = false;
    let up = true;
    const state = { draining: () => draining, ping: async () => { if (!up) throw new Error("down"); } };
    expect((await healthResponse("/healthz", { ...state, ping: async () => { throw new Error("never called"); } }))!.status).toBe(200);
    expect((await healthResponse("/readyz", state))!.status).toBe(200);
    up = false;
    expect(await (await healthResponse("/readyz", state))!.json()).toEqual({ status: "database_unavailable" });
    up = true; draining = true;
    expect((await healthResponse("/readyz", state))!.status).toBe(503);
    expect(await healthResponse("/v1/health", state)).toBeNull();
  });

  it("reads the cluster settings and refuses unknown values", () => {
    expect(clusterSettingsFromEnv({})).toEqual({ migrate: true, backgroundJobs: true, tickIntervalMs: 30_000, shutdownDelayMs: 5_000, shutdownTimeoutMs: 20_000 });
    expect(clusterSettingsFromEnv({ REVENUEDOT_MIGRATE: "skip", REVENUEDOT_BACKGROUND_JOBS: "off", REVENUEDOT_TICK_INTERVAL_MS: "5000", REVENUEDOT_SHUTDOWN_DELAY_MS: "0" }))
      .toMatchObject({ migrate: false, backgroundJobs: false, tickIntervalMs: 5000, shutdownDelayMs: 0 });
    expect(() => clusterSettingsFromEnv({ REVENUEDOT_MIGRATE: "yes" })).toThrow(/REVENUEDOT_MIGRATE/);
  });
});
