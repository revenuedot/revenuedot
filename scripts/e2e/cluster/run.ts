// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the high-availability check (prd/ha-self-host/PRD.md). Three real Node replicas (apps/server/src/entry.node.ts)
// share one fresh database on the Railway development Postgres, behind a round-robin "load balancer" that skips replicas
// that refuse connections or answer 503, as a cloud load balancer with health checks does. Then:
//   1. all three start at the same moment on an empty database (concurrent migrations),
//   2. Test Store purchases arrive spread over the replicas, with a working webhook and a failing one,
//   3. one replica gets SIGTERM mid-load (it drains: /readyz 503, then exits 0) and is started again,
//   4. subscriptions are made to expire, so the background job records EXPIRATION events,
// and it checks that every event reached the working webhook exactly once, that the failing webhook opened one alert email,
// that no two background job runs overlapped, and that no request failed at the load balancer.
//
//   pnpm tsx scripts/e2e/cluster/run.ts            (CLUSTER_PURCHASES=300, CLUSTER_PORT_BASE=5700, KEEP_DB=1 keeps the database)
//
// Results: scripts/e2e/cluster/build/<stamp>/ (summary.json, one server.log per replica) and prd/ha-self-host/cluster-results.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks } from "../journeys/lib/check.ts";
import type { Ctx } from "../journeys/lib/context.ts";
import { sdkClient, signUp, standardCatalog } from "../journeys/lib/context.ts";
import { Capture, RdServer, ROOT, createDatabase, dropDatabase, hideUrls, postgres, startSmtpSink, writeJson } from "../journeys/lib/stack.ts";

const PORT_BASE = Number(process.env.CLUSTER_PORT_BASE ?? 5700);
const PURCHASES = Number(process.env.CLUSTER_PURCHASES ?? 300);
const EXPIRE = Math.min(40, Math.floor(PURCHASES / 3));
const REPLICAS = 3;
const ports = { replicas: Array.from({ length: REPLICAS }, (_, i) => PORT_BASE + i), smtp: PORT_BASE + 3, capture: PORT_BASE + 4 };
const GOOD_HOST = "hooks.cluster.test";
const BAD_HOST = "hooks-down.cluster.test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const stamp = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${PORT_BASE}`;
  const runDir = join(ROOT, "scripts/e2e/cluster/build", stamp);
  const dbName = `rd_ha_cluster_${stamp}`;
  const c = new Checks("cluster");
  console.log(`Cluster run ${stamp}: ${REPLICAS} replicas, ${PURCHASES} purchases\nDatabase ${dbName} on the Railway development Postgres`);
  const databaseUrl = await createDatabase(dbName);
  const smtp = await startSmtpSink(ports.smtp);
  const capture = new Capture(ports.capture);
  await capture.start();
  // The failing webhook's receiver answers 500 every time.
  capture.handlers.push((req, res) => { if (req.host !== BAD_HOST) return false; res.statusCode = 500; res.end("down"); return true; });
  const lbBase = `http://localhost:${ports.replicas[0]}`;
  const makeReplica = (i: number) => new RdServer({
    databaseUrl, port: ports.replicas[i]!, smtpPort: ports.smtp, capturePort: ports.capture, logDir: join(runDir, `replica-${i + 1}`),
    // Emails link to the load balancer's address, as REVENUEDOT_PUBLIC_URL does behind a real one.
    env: { REVENUEDOT_REPLICA_ID: `replica-${i + 1}`, REVENUEDOT_TICK_INTERVAL_MS: "2000", REVENUEDOT_TICK_LOG: "1", REVENUEDOT_SHUTDOWN_DELAY_MS: "1500", REVENUEDOT_PUBLIC_URL: lbBase, REVENUEDOT_API_URL: lbBase },
  });
  const replicas = Array.from({ length: REPLICAS }, (_, i) => makeReplica(i));
  const sql = postgres(databaseUrl, { max: 3, onnotice: () => {} });
  const lbFailures: string[] = [];
  let rr = 0;
  // The load balancer: health-checks /readyz every 500 ms like a cloud load balancer, sends requests round robin to the
  // ready replicas, and retries on the next one when a connection is refused or a replica answers 503.
  const ready = ports.replicas.map(() => true);
  const healthTimer = setInterval(() => {
    ports.replicas.forEach((port, i) => {
      fetch(`http://localhost:${port}/readyz`, { signal: AbortSignal.timeout(400) }).then((r) => { ready[i] = r.ok; }, () => { ready[i] = false; });
    });
  }, 500);
  healthTimer.unref();
  const lbFetch = async (path: string, init: RequestInit): Promise<Response> => {
    for (let tries = 0; tries < REPLICAS * 2; tries++) {
      let i = rr++ % REPLICAS;
      for (let k = 0; k < REPLICAS && !ready[i]; k++) i = rr++ % REPLICAS;
      const port = ports.replicas[i]!;
      try {
        const res = await fetch(`http://localhost:${port}${path}`, init);
        if (res.status !== 503) return res;
      } catch { /* connection refused: that replica is down */ }
      if (tries >= REPLICAS - 1) await sleep(200);
    }
    lbFailures.push(`${init.method ?? "GET"} ${path}`);
    throw new Error(`load balancer: no replica answered ${path}`);
  };

  try {
    c.begin("start three replicas at once on an empty database");
    const t0 = Date.now();
    const started = await Promise.allSettled(replicas.map((r) => r.start()));
    c.check("all three replicas started and answer /v1/health", started.every((s) => s.status === "fulfilled"), started.map((s) => s.status === "rejected" ? hideUrls(String(s.reason)).slice(0, 800) : "ok"));
    if (started.some((s) => s.status === "rejected")) throw new Error("a replica did not start");
    console.log(`    (started in ${Date.now() - t0} ms)`);
    const journal = JSON.parse(readFileSync(join(ROOT, "packages/db/migrations/meta/_journal.json"), "utf8")).entries as { when: number }[];
    const applied = await sql<{ n: number; distinct_hashes: number }[]>`SELECT count(*)::int AS n, count(DISTINCT hash)::int AS distinct_hashes FROM drizzle.__drizzle_migrations`;
    c.eq("each migration was applied exactly once", applied[0], { n: journal.length, distinct_hashes: journal.length });
    for (const [i, r] of replicas.entries()) {
      const live = await fetch(`${r.base}/healthz`);
      const ready = await fetch(`${r.base}/readyz`);
      c.check(`replica ${i + 1}: /healthz 200 and /readyz 200`, live.status === 200 && ready.status === 200, { live: live.status, ready: ready.status });
    }

    c.begin("a developer, a catalog and two webhooks, through the load balancer");
    const ctx = { base: lbBase, stamp } as unknown as Ctx;
    const dev = await signUp(ctx, "ha-owner", "Cluster app");
    const cat = await standardCatalog(dev);
    const good = await dev.v2("POST", "/integrations/webhooks", { name: "Backend", url: `https://${GOOD_HOST}/revenuedot` });
    const bad = await dev.v2("POST", "/integrations/webhooks", { name: "Old backend", url: `https://${BAD_HOST}/revenuedot` });
    c.check("both webhooks were created", good?.id && bad?.id, { good, bad });
    const sdkHeaders = { authorization: `Bearer ${cat.testKey}`, "content-type": "application/json", "x-platform": "iOS", "x-version": "5.92.0", "x-is-sandbox": "true" };
    const purchase = async (i: number) => {
      const res = await lbFetch("/v1/receipts", { method: "POST", headers: sdkHeaders, body: JSON.stringify({ app_user_id: `ha_user_${i}`, fetch_token: `test_${Date.now()}_${crypto.randomUUID()}`, product_id: "pro_monthly", price: 9.99, currency: "USD", is_restore: false }) });
      if (res.status !== 200) throw new Error(`purchase ${i}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    };
    // Unused, but keeps the SDK client shape this harness shares with the journeys type-checked.
    void sdkClient;

    c.begin("load, with one replica stopped mid-way (SIGTERM) and started again");
    const results: Array<PromiseSettledResult<void>> = [];
    const runLoad = async (from: number, to: number, concurrency = 8) => {
      let next = from;
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < to) { const i = next++; results.push(...await Promise.allSettled([purchase(i)])); }
      }));
    };
    const half = Math.floor(PURCHASES / 2);
    await runLoad(0, half);
    // Stop replica 2 while the second half of the purchases is arriving.
    const victim = replicas[1]!;
    let exitedAt = 0;
    const exited = new Promise<number | null>((r) => victim.child.once("exit", (code) => { exitedAt = Date.now(); r(code); }));
    const secondHalf = runLoad(half, PURCHASES);
    await sleep(300);
    const sigtermAt = Date.now();
    victim.stop();
    await sleep(300);
    let drainingStatus = 0;
    try { drainingStatus = (await fetch(`${victim.base}/readyz`)).status; } catch { drainingStatus = -1; }
    c.eq("the stopped replica answers /readyz 503 while it drains", drainingStatus, 503);
    await secondHalf;
    const code = await Promise.race([exited, sleep(30_000).then(() => "timeout" as const)]);
    c.eq("the stopped replica exited 0 after draining", code, 0);
    const victimLog = readFileSync(victim.serverLog, "utf8");
    c.check("its log shows the drain and the stop", /SIGTERM: draining/.test(victimLog) && /Stopped\./.test(victimLog), victimLog.slice(-600));
    c.check("it exited within its delay plus timeout (1.5 s + 20 s)", exitedAt - sigtermAt < 21_500, { ms: exitedAt - sigtermAt });
    console.log(`    (drained and exited ${exitedAt - sigtermAt} ms after SIGTERM, with ${PURCHASES - half} purchases still arriving)`);
    replicas[1] = makeReplica(1);
    await replicas[1].start();
    c.check("replica 2 started again on the migrated database", (await fetch(`${replicas[1].base}/readyz`)).status === 200);
    const failedPurchases = results.filter((r) => r.status === "rejected");
    c.eq(`all ${PURCHASES} purchases succeeded through the load balancer`, { ok: results.length - failedPurchases.length, failed: failedPurchases.map((f) => String((f as PromiseRejectedResult).reason).slice(0, 200)) }, { ok: PURCHASES, failed: [] });

    c.begin("expirations recorded by the background job");
    await sql`UPDATE subscriptions SET expires_date = now() - interval '1 minute'
      WHERE project_id = ${dev.projectId} AND id IN (SELECT id FROM subscriptions WHERE project_id = ${dev.projectId} ORDER BY id LIMIT ${EXPIRE})`;

    c.begin("every event delivered once");
    const deadline = Date.now() + 120_000;
    let pending = -1, expirations = 0;
    while (Date.now() < deadline) {
      [{ n: pending }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${good.id} AND status <> 'delivered'`;
      [{ n: expirations }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM events WHERE project_id = ${dev.projectId} AND type = 'EXPIRATION'`;
      const alerted = smtp.mails.some((m) => /webhook/i.test(m.subject));
      if (pending === 0 && expirations >= EXPIRE && alerted) break;
      await sleep(1000);
    }
    // A few more job runs, so a second send (if there were one) would show.
    await sleep(6_000);
    const events = await sql<{ id: string; type: string }[]>`SELECT payload->'event'->>'id' AS id, type FROM events WHERE project_id = ${dev.projectId}`;
    const byType = events.reduce<Record<string, number>>((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }), {});
    c.eq("events: one INITIAL_PURCHASE per purchase and one EXPIRATION per expired subscription", { INITIAL_PURCHASE: byType.INITIAL_PURCHASE ?? 0, EXPIRATION: byType.EXPIRATION ?? 0 }, { INITIAL_PURCHASE: PURCHASES, EXPIRATION: EXPIRE });
    const received = capture.of(GOOD_HOST, "/revenuedot").map((r) => JSON.parse(r.body).event.id as string);
    const counts = new Map<string, number>();
    for (const id of received) counts.set(id, (counts.get(id) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1);
    c.eq("the working webhook received every event", received.length >= events.length && events.every((e) => counts.has(e.id)), true);
    c.eq("no event reached it twice", { received: received.length, distinct: counts.size, duplicated: dupes.length }, { received: events.length, distinct: events.length, duplicated: 0 });
    const goodRows = await sql<{ status: string; attempts: number; n: number }[]>`SELECT status, attempts, count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${good.id} GROUP BY 1, 2`;
    c.eq("its deliveries are all delivered on the first attempt", goodRows.map((r) => ({ ...r })), [{ status: "delivered", attempts: 1, n: events.length }]);
    const [badRow] = await sql<{ n: number; tried: number; attempts: number }[]>`SELECT count(*)::int AS n, count(*) FILTER (WHERE attempts >= 1)::int AS tried, coalesce(sum(attempts), 0)::int AS attempts FROM webhook_deliveries WHERE webhook_id = ${bad.id}`;
    const badCalls = capture.of(BAD_HOST, "/revenuedot").length;
    c.eq("the failing webhook got one call per recorded attempt, and every event was tried", { deliveries: badRow!.n, tried: badRow!.tried, calls: badCalls }, { deliveries: events.length, tried: events.length, calls: badRow!.attempts });
    const alertMails = smtp.mails.filter((m) => /webhook/i.test(m.subject));
    c.eq("one alert email for the failing webhook, not one per replica", alertMails.map((m) => ({ to: m.to, subject: m.subject })), [{ to: [dev.email], subject: alertMails[0]?.subject ?? "(none)" }]);
    c.check("the alert links to the load balancer address", alertMails[0] && (alertMails[0].text + alertMails[0].html).includes(lbBase), alertMails[0]?.text?.slice(0, 400));

    c.begin("one background job run at a time");
    const runs: Array<{ replica: string; started: number; ended: number; sent: number; expired: number }> = [];
    for (let i = 0; i < REPLICAS; i++) {
      const file = join(runDir, `replica-${i + 1}`, "server.log");
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) { const m = /^tick (\{.*\})$/.exec(line); if (m) runs.push(JSON.parse(m[1]!)); }
    }
    runs.sort((a, b) => a.started - b.started);
    const overlaps = runs.slice(1).filter((r, i) => r.started < runs[i]!.ended).map((r, i) => ({ a: runs[i], b: r }));
    const ranOn = [...new Set(runs.map((r) => r.replica))].sort();
    c.eq("no two runs overlapped (from the replicas' job logs)", { severalRuns: runs.length >= 3, overlaps: overlaps.slice(0, 3) }, { severalRuns: true, overlaps: [] });
    c.check("runs moved between replicas (no fixed leader to lose)", ranOn.length >= 2, ranOn);
    const [{ attempts }] = await sql<{ attempts: number }[]>`SELECT coalesce(sum(d.attempts), 0)::int AS attempts FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE w.project_id = ${dev.projectId}`;
    c.eq("attempts sent by the job runs add up to the attempts recorded", runs.reduce((s, r) => s + r.sent, 0), attempts);
    c.eq("expirations recorded by the job runs add up", runs.reduce((s, r) => s + r.expired, 0), EXPIRE);

    c.begin("the load balancer saw no failed request");
    c.eq("failed requests", lbFailures, []);
    writeJson(join(runDir, "summary.json"), { stamp, replicas: REPLICAS, purchases: PURCHASES, expirations: EXPIRE, events: events.length, received: received.length, jobRuns: runs.length, ranOn, alertEmails: alertMails.length, passed: c.passed, failed: c.failed, checks: c.results });
  } catch (e) {
    c.check("run finished without an exception", false, hideUrls(e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(1, 5).join("\n")}` : String(e)));
  } finally {
    for (const r of replicas) r.stop();
    await sleep(500);
    await sql.end().catch(() => {});
    await capture.close().catch(() => {});
    await smtp.close().catch(() => {});
    if (process.env.KEEP_DB === "1") console.log(`Kept database ${dbName}`);
    else { await dropDatabase(dbName).catch((e) => console.error("drop failed", hideUrls(String(e)))); console.log(`Dropped ${dbName}`); }
  }
  writeFileSync(join(ROOT, "prd/ha-self-host/cluster-results.json"), JSON.stringify({ date: new Date().toISOString().slice(0, 10), run: stamp, replicas: REPLICAS, purchases: PURCHASES, passed: c.passed, failed: c.failed, checks: c.results.map((r) => ({ name: r.name, ok: r.ok })) }, null, 2) + "\n");
  console.log(`\n${c.failed ? "FAIL" : "PASS"} cluster: ${c.passed} passed, ${c.failed} failed`);
  process.exit(c.failed ? 1 : 0);
}

main().catch((e) => { console.error(hideUrls(String(e?.stack ?? e))); process.exit(1); });
