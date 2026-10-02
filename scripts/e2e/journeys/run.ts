// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: the real-journey validation runner. Each journey uses RevenueDot the way a developer and their users would:
// a real Node server (apps/server/src/entry.node.ts) on a fresh Railway development database, real sign-ups through
// /auth/signup, real SDK wire calls and SDKs, a real browser, then checks every resulting state through the v2 API,
// direct SQL reads, delivered webhooks, emails and the dashboard.
//
//   pnpm tsx scripts/e2e/journeys/run.ts                 every journey except the device and Docker ones
//   pnpm tsx scripts/e2e/journeys/run.ts onboarding web-sdk
//   pnpm tsx scripts/e2e/journeys/run.ts --all           also ios, android and self-host (heavy: one at a time)
//
// Results: scripts/e2e/journeys/build/<run>/<journey>.json plus requests.jsonl, outbound.jsonl and server.log.
// The database is dropped at the end (KEEP_DB=1 keeps it). Coverage matrix: prd/validation/COVERAGE.md
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Checks } from "./lib/check.ts";
import type { Ctx } from "./lib/context.ts";
import { fakeAnthropic } from "./lib/fake-anthropic.ts";
import { BUILD, Capture, DB_PREFIX, PORTS, RdServer, ROOT, createDatabase, dropDatabase, hideUrls, postgres, startSmtpSink, writeJson } from "./lib/stack.ts";

export interface Journey { name: string; title: string; heavy?: boolean; needsDashboard?: boolean; run: (ctx: Ctx) => Promise<void> }

const JOURNEYS: Record<string, () => Promise<{ default: Journey }>> = {
  "settings-auth": () => import("./settings-auth.ts"),
  move: () => import("./move.ts"),
  billing: () => import("./billing.ts"),
};

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const names = args.filter((a) => !a.startsWith("--"));
  const unknown = names.filter((n) => !JOURNEYS[n]);
  if (unknown.length) { console.error(`Unknown journey: ${unknown.join(", ")}. Known: ${Object.keys(JOURNEYS).join(", ")}`); process.exit(2); }
  const loaded = await Promise.all((names.length ? names : Object.keys(JOURNEYS)).map(async (n) => (await JOURNEYS[n]!()).default));
  const selected = loaded.filter((j) => names.length || all || !j.heavy);

  // Unique per run: parallel runs on other port ranges may start in the same second.
  const stamp = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}${PORTS.server}`;
  const runDir = join(BUILD, stamp);
  mkdirSync(runDir, { recursive: true });
  if (selected.some((j) => j.needsDashboard) && !existsSync(join(ROOT, "apps/dashboard/dist/index.html"))) {
    console.error("Build the dashboard first: pnpm --filter @revenuedot/dashboard build"); process.exit(2);
  }
  const dbName = `${DB_PREFIX}${stamp}`;
  console.log(`Journey run ${stamp}: ${selected.map((j) => j.name).join(", ")}\nDatabase ${dbName} on the Railway development Postgres`);
  const databaseUrl = await createDatabase(dbName);
  const smtp = await startSmtpSink(PORTS.smtp);
  const capture = new Capture(PORTS.capture);
  await capture.start();
  // Model calls (RevenueDot AI, paywall and funnel generators) reach a scripted Messages API on the capture server.
  capture.handlers.push(fakeAnthropic);
  const server = new RdServer({ databaseUrl, port: PORTS.server, smtpPort: PORTS.smtp, capturePort: PORTS.capture, logDir: runDir });
  const sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  const summary: Array<{ journey: string; title: string; passed: number; failed: number; error?: string; ms: number }> = [];
  try {
    await server.start();
    console.log(`Server on ${server.base} (Node entry, SMTP sink :${PORTS.smtp}, capture :${PORTS.capture})`);
    for (const j of selected) {
      const c = new Checks(j.name);
      const out = join(runDir, j.name);
      mkdirSync(out, { recursive: true });
      const t0 = Date.now();
      console.log(`\n=== ${j.name}: ${j.title}`);
      let error: string | undefined;
      try { await j.run({ name: j.name, c, server, base: server.base, capture, mails: smtp.mails, sql, out, stamp }); } catch (e) {
        error = hideUrls(e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(1, 6).join("\n")}` : String(e));
        c.check("journey finished without an exception", false, error);
      }
      const ms = Date.now() - t0;
      writeJson(join(runDir, `${j.name}.json`), { journey: j.name, title: j.title, date: new Date().toISOString(), passed: c.passed, failed: c.failed, error, checks: c.results });
      summary.push({ journey: j.name, title: j.title, passed: c.passed, failed: c.failed, error, ms });
      console.log(`=== ${j.name}: ${c.passed} passed, ${c.failed} failed (${Math.round(ms / 1000)}s)`);
    }
  } finally {
    server.stop();
    await sql.end().catch(() => {});
    await capture.close().catch(() => {});
    await smtp.close().catch(() => {});
    if (process.env.KEEP_DB === "1") console.log(`Kept database ${dbName}`);
    else { await dropDatabase(dbName).catch((e) => console.error("drop failed", hideUrls(String(e)))); console.log(`Dropped ${dbName}`); }
  }
  writeJson(join(runDir, "summary.json"), summary);
  // The latest result of each journey, committed with the coverage matrix.
  const latestFile = join(ROOT, "prd/validation/journey-results.json");
  mkdirSync(join(ROOT, "prd/validation"), { recursive: true });
  const latest = existsSync(latestFile) ? JSON.parse(readFileSync(latestFile, "utf8")) : {};
  for (const s of summary) latest[s.journey] = { title: s.title, date: new Date().toISOString().slice(0, 10), run: stamp, passed: s.passed, failed: s.failed, ...(s.error ? { error: s.error.split("\n")[0] } : {}) };
  writeFileSync(latestFile, JSON.stringify(latest, null, 2) + "\n");
  console.log("\nSummary");
  for (const s of summary) console.log(`  ${s.failed ? "FAIL" : "PASS"} ${s.journey.padEnd(16)} ${String(s.passed).padStart(4)} passed ${String(s.failed).padStart(3)} failed  ${Math.round(s.ms / 1000)}s`);
  process.exit(summary.some((s) => s.failed) ? 1 : 0);
}

main().catch((e) => { console.error(hideUrls(String(e?.stack ?? e))); process.exit(1); });
