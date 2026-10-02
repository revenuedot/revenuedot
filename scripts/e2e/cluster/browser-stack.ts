// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: a two-replica stack for checking high availability by hand in a real browser (prd/ha-self-host/PRD.md),
// for machines where a local Kubernetes cluster does not fit. It plays the part of the Ingress: a load balancer that
// health-checks each replica's /readyz every second and sends requests round robin to the ready ones, retrying a request
// on another replica when a connection is refused or reset before any answer (as ingress-nginx's proxy_next_upstream does).
//
//   pnpm --filter @revenuedot/dashboard build
//   pnpm tsx scripts/e2e/cluster/browser-stack.ts       then open http://localhost:5719
//
// Control (for the person or agent testing): GET /__lb/status, POST /__lb/kill?replica=N (SIGKILL, a crashed pod),
// POST /__lb/stop?replica=N (SIGTERM, a drained pod), POST /__lb/start?replica=N. Webhook URLs on any host reach the
// capture server, which answers 200 and lists them at /__lb/webhooks. Ctrl-C stops everything and drops the database.
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Capture, RdServer, ROOT, createDatabase, dropDatabase, hideUrls, startSmtpSink } from "../journeys/lib/stack.ts";

const BASE = Number(process.env.BROWSER_PORT_BASE ?? 5710);
const LB_PORT = BASE + 9;
const lbUrl = `http://localhost:${LB_PORT}`;
const stamp = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${BASE}`;
const runDir = join(ROOT, "scripts/e2e/cluster/build", `browser-${stamp}`);
const dbName = `rd_ha_browser_${stamp}`;

const databaseUrl = await createDatabase(dbName);
const smtp = await startSmtpSink(BASE + 3);
const capture = new Capture(BASE + 4);
await capture.start();
const make = (i: number) => new RdServer({
  databaseUrl, port: BASE + i, smtpPort: BASE + 3, capturePort: BASE + 4, logDir: join(runDir, `replica-${i + 1}`),
  env: { REVENUEDOT_REPLICA_ID: `replica-${i + 1}`, REVENUEDOT_PUBLIC_URL: lbUrl, REVENUEDOT_API_URL: lbUrl, REVENUEDOT_TICK_LOG: "1", REVENUEDOT_SHUTDOWN_DELAY_MS: "2000" },
});
const replicas: Array<RdServer | null> = [make(0), make(1)];
await Promise.all(replicas.map((r) => r!.start()));
const ready = [false, false];
const served = [0, 0];

setInterval(() => {
  replicas.forEach((r, i) => {
    if (!r) { ready[i] = false; return; }
    fetch(`${r.base}/readyz`, { signal: AbortSignal.timeout(900) }).then((res) => { ready[i] = res.ok; }, () => { ready[i] = false; });
  });
}, 1000).unref();

let rr = 0;
function forward(req: IncomingMessage, res: ServerResponse, body: Buffer, tried = new Set<number>()) {
  const order = [0, 1].map((k) => (rr + k) % 2);
  rr++;
  const i = order.find((k) => ready[k] && replicas[k] && !tried.has(k)) ?? order.find((k) => replicas[k] && !tried.has(k));
  if (i === undefined) { res.statusCode = 502; res.end("No replica is up."); return; }
  tried.add(i);
  const up = request({ host: "127.0.0.1", port: BASE + i, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-host": `localhost:${LB_PORT}`, "x-forwarded-proto": "http" } }, (r) => {
    served[i]!++;
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) forward(req, res, body, tried); else res.destroy(); });
  up.end(body);
}

async function control(req: IncomingMessage, res: ServerResponse, url: URL) {
  const n = Number(url.searchParams.get("replica")) - 1;
  const json = (v: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v, null, 2)); };
  if (url.pathname === "/__lb/status") return json(replicas.map((r, i) => ({ replica: i + 1, up: !!r, ready: ready[i], served: served[i] })));
  if (url.pathname === "/__lb/webhooks") return json(capture.requests.filter((r) => r.method === "POST").map((r) => ({ at: new Date(r.at).toISOString(), host: r.host, path: r.path, event: (() => { try { const e = JSON.parse(r.body).event; return { id: e.id, type: e.type, app_user_id: e.app_user_id }; } catch { return null; } })() })));
  if (req.method !== "POST" || !(n === 0 || n === 1)) { res.statusCode = 400; return json({ error: "POST /__lb/kill|stop|start?replica=1|2" }); }
  const r = replicas[n];
  if (url.pathname === "/__lb/kill" && r) { process.kill(-r.child.pid!, "SIGKILL"); replicas[n] = null; return json({ killed: n + 1 }); }
  if (url.pathname === "/__lb/stop" && r) { r.stop(); r.child.once("exit", () => { replicas[n] = null; }); return json({ stopping: n + 1 }); }
  if (url.pathname === "/__lb/start" && !r) { const s = make(n); await s.start(); replicas[n] = s; return json({ started: n + 1 }); }
  res.statusCode = 409; return json({ error: "nothing to do" });
}

const lb = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", lbUrl);
  if (url.pathname.startsWith("/__lb/")) return void control(req, res, url).catch((e) => { res.statusCode = 500; res.end(String(e)); });
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  forward(req, res, Buffer.concat(chunks));
});
lb.listen(LB_PORT, "127.0.0.1");
console.log(`Load balancer ${lbUrl} → replicas :${BASE} and :${BASE + 1} (database ${dbName}, logs ${runDir})`);

const stop = async () => {
  for (const r of replicas) r?.stop();
  lb.close();
  await capture.close().catch(() => {});
  await smtp.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  if (process.env.KEEP_DB === "1") console.log(`Kept ${dbName}`);
  else { await dropDatabase(dbName).catch((e) => console.error("drop failed", hideUrls(String(e)))); console.log(`Dropped ${dbName}`); }
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
