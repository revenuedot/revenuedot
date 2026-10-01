// RevenueDot: open-source, self-hostable alternative to RevenueCat. Same SDK API, free.
// This file: writes prd/validation/ROUTES.md, every HTTP route the server registers (method and path, from the Hono
// app itself) with the passing journeys that called it on the real Node server (their request logs under
// scripts/e2e/journeys/build/<run>/) and the test files that called it (REVENUEDOT_TEST_REQUEST_LOG=
// scripts/e2e/journeys/build/test-requests.jsonl pnpm vitest run). A route nobody calls shows up as a gap.
//   pnpm tsx scripts/e2e/journeys/coverage.ts
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, defaultStores } from "../../../apps/server/src/index.ts";
import { BUILD, ROOT } from "./lib/stack.ts";

type Route = { method: string; path: string; re: RegExp; journeys: Map<string, Set<number>>; tests: Set<string> };

// Routes as the app registers them. The dependencies are never used: only the route table is read.
const app = createApp({ db: {} as never, now: () => new Date(), stores: defaultStores() });
const seen = new Set<string>();
const routes: Route[] = [];
for (const r of (app as unknown as { routes: { method: string; path: string }[] }).routes) {
  if (r.method === "ALL" || r.path.endsWith("*")) continue;
  const key = `${r.method} ${r.path}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const re = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z_]+/g, "[^/]+")}$`);
  routes.push({ method: r.method, path: r.path, re, journeys: new Map(), tests: new Set() });
}
// The most specific pattern wins (/v2/projects/:id/customers/lists beats /v2/projects/:id/customers/:customer_id).
const specificity = (p: string) => p.split("/").filter((s) => s && !s.startsWith(":")).length * 100 - p.split("/").length;
routes.sort((a, b) => specificity(b.path) - specificity(a.path));
const match = (method: string, path: string) => routes.find((r) => (r.method === method || (r.method === "GET" && method === "HEAD")) && r.re.test(path));

// Journeys: the latest passing run of each journey (a run directory holds <journey>.json and the server's request log).
const latest = new Map<string, string>();
for (const dir of existsSync(BUILD) ? readdirSync(BUILD).filter((d) => /^\d{14}/.test(d)).sort() : []) {
  const sumFile = join(BUILD, dir, "summary.json");
  if (!existsSync(sumFile) || !existsSync(join(BUILD, dir, "requests.jsonl"))) continue;
  const summary = JSON.parse(readFileSync(sumFile, "utf8")) as { journey: string; failed: number }[];
  for (const s of summary) if (s.failed === 0) latest.set(s.journey, dir);
}
const runs = new Map<string, string[]>();
for (const [journey, dir] of latest) runs.set(dir, [...(runs.get(dir) ?? []), journey]);
for (const [dir, journeys] of runs) {
  for (const line of readFileSync(join(BUILD, dir, "requests.jsonl"), "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as { method: string; path: string; status: number };
    const route = match(r.method, decodeURI(r.path));
    if (!route) continue;
    for (const j of journeys) route.journeys.set(j, (route.journeys.get(j) ?? new Set()).add(r.status));
  }
}
// Tests.
const testLog = join(BUILD, "test-requests.jsonl");
if (existsSync(testLog)) {
  for (const line of readFileSync(testLog, "utf8").split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line) as { file: string; method: string; path: string };
    let path = r.path;
    try { path = decodeURI(path); } catch { /* keep raw */ }
    match(r.method, path)?.tests.add(r.file.replace(/^.*?(apps|packages)\//, "$1/"));
  }
}

const group = (p: string) => p.startsWith("/v2/projects/:project_id/") ? `/v2 ${p.split("/")[4]}` : p.split("/").slice(0, 2).join("/") || "/";
routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
const both = routes.filter((r) => r.journeys.size && r.tests.size).length;
const journeyOnly = routes.filter((r) => r.journeys.size && !r.tests.size).length;
const testOnly = routes.filter((r) => !r.journeys.size && r.tests.size).length;
const none = routes.filter((r) => !r.journeys.size && !r.tests.size);
const date = new Date().toISOString().slice(0, 10);
const out: string[] = [
  "# Route coverage",
  "",
  `**${routes.length} routes; ${both + journeyOnly} are called by a passing real-server journey and ${both + testOnly} by the test suite; ${none.length} by neither.** Generated ${date} by \`pnpm tsx scripts/e2e/journeys/coverage.ts\` from the app's own route table, the request logs of the latest passing run of each journey (${[...latest.keys()].sort().join(", ")}) and a test-suite run with \`REVENUEDOT_TEST_REQUEST_LOG\`. Feature-level status is in [COVERAGE.md](COVERAGE.md).`,
  "",
  `- Both a journey and a test: ${both}`,
  `- A journey only: ${journeyOnly}`,
  `- Tests only: ${testOnly}`,
  `- Neither: ${none.length}${none.length ? ` (${none.map((r) => `\`${r.method} ${r.path}\``).join(", ")})` : ""}`,
  "",
  "A journey cell lists the journey and the HTTP statuses it saw. Test cells name the test files.",
  "",
];
let current = "";
for (const r of routes) {
  const g = group(r.path);
  if (g !== current) {
    current = g;
    out.push("", `## ${g}`, "", "| Method | Path | Journeys (statuses) | Tests |", "|---|---|---|---|");
  }
  const j = [...r.journeys].map(([name, st]) => `${name} (${[...st].sort().join("/")})`).join(", ") || "—";
  const t = [...r.tests].sort().map((f) => f.split("/").pop()!.replace(/\.(test|spec)\.ts$/, "")).join(", ") || "—";
  out.push(`| ${r.method} | \`${r.path}\` | ${j} | ${t} |`);
}
writeFileSync(join(ROOT, "prd/validation/ROUTES.md"), out.join("\n") + "\n");
console.log(`${routes.length} routes: ${both} both, ${journeyOnly} journey only, ${testOnly} tests only, ${none.length} neither`);
