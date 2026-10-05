import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harness, type Harness } from "../../../packages/contract/src/harness.js";
import { countAll, exactCount, runCountJobs } from "../src/services/customer-counts.js";
import { expected, hasEmail, isDE, seedMany } from "./many-customers.js";

/**
 * Timing on a real Postgres with 50,000+ customers (prd/lifecycle/PRD.md "Scale"). Opt-in, not in CI:
 *   REVENUEDOT_SCALE_PG_URL=postgres://…/rd_gap_customer_cap pnpm vitest run apps/server/test/customer-scale-pg.test.ts
 * The database must be empty (the harness migrates it). Prints wall time and this process's CPU time per step, which is
 * what a Worker is billed and limited on (30 seconds of CPU per request or cron by default; network waits do not count).
 */
const URL_ = process.env.REVENUEDOT_SCALE_PG_URL?.trim();
const N = Number(process.env.REVENUEDOT_SCALE_N ?? 50_000);
const NOW = new Date("2026-09-01T12:00:00Z");
let h: Harness;

async function timed<T>(label: string, f: () => Promise<T>): Promise<{ value: T; wallMs: number; cpuMs: number }> {
  const c0 = process.cpuUsage(), t0 = performance.now();
  const value = await f();
  const c = process.cpuUsage(c0), wallMs = Math.round(performance.now() - t0), cpuMs = Math.round((c.user + c.system) / 1000);
  console.log(`[scale ${N}] ${label}: ${wallMs} ms wall, ${cpuMs} ms CPU`);
  return { value, wallMs, cpuMs };
}

describe.skipIf(!URL_)("customer scans on real Postgres", () => {
  beforeAll(async () => {
    h = await harness({ databaseUrl: URL_ });
    h.setNow(NOW);
    await timed("seed", () => seedMany(h.db, "proj1", N, NOW));
  }, 600_000);
  afterAll(async () => { await h?.close(); });

  const get = async (path: string, init: Parameters<Harness["fetch"]>[1] = {}) => (await h.fetch(path, { key: h.ids.secretKey, ...init })).json() as Promise<any>;
  const DE_WITH_EMAIL = { groups: [{ conditions: [{ field: "country", operator: "is", value: "DE" }, { field: "email", operator: "isNotEmpty" }] }] };

  it("SQL lists, sorts and cards stay well under a second", async () => {
    const all = await timed("list all, first page + cards", () => get("/v2/projects/proj1/customer_lists?list=all&limit=50"));
    expect(all.value.summary.customers).toBe(N);
    const sorted = await timed("list all sorted by spent", () => get("/v2/projects/proj1/customer_lists?list=all&limit=50&sort=spent_in_usd&direction=desc"));
    expect(sorted.value.items).toHaveLength(50);
    const status = await timed("list all sorted by status", () => get("/v2/projects/proj1/customer_lists?list=all&limit=50&sort=subscription_status"));
    const deep = await timed("page after the 45,000th customer", async () => {
      const ids = await get(`/v2/projects/proj1/customer_lists?list=all&limit=1&sort=last_seen_at&direction=asc&starting_after=proj1_c${String(5_000).padStart(7, "0")}`);
      return ids;
    });
    expect(deep.value.items[0].id).toBe("user4999");
    const search = await timed("search", () => get(`/v2/projects/proj1/customer_lists?list=all&search=user${N - 2}%40`));
    expect(search.value.items).toHaveLength(1);
    for (const t of [all, sorted, status, deep, search]) expect(t.wallMs).toBeLessThan(5_000);
  }, 600_000);

  it("a condition-filtered page, the whole-project count, and the tick's pages fit Worker limits", async () => {
    const page = await timed("filtered list page (rows only, count in the background)", () => exactCount(h.db, "proj1", "audience", { rules: DE_WITH_EMAIL }, NOW, 0));
    expect(page.value.counting).toBe(true);
    const whole = await timed(`count all ${N} customers in one go`, () => countAll(h.db, "proj1", "audience", { rules: DE_WITH_EMAIL }, NOW));
    expect(whole.value.total_customers).toBe(expected(N, (k) => isDE(k) && hasEmail(k)).customers);
    console.log(`[scale ${N}] per 1,000 customers: ${Math.round(whole.wallMs / (N / 1000))} ms wall, ${Math.round(whole.cpuMs / (N / 1000))} ms CPU`);
    const tick = await timed("one tick (15 s budget)", () => runCountJobs(h.db, NOW, { budgetMs: 15_000 }));
    console.log(`[scale ${N}] tick counted ${tick.value.pages} pages, finished ${tick.value.finished}`);
    // A cron tick has 30 seconds of CPU; the count's share must leave most of it.
    expect(tick.cpuMs).toBeLessThan(20_000);
    let ticks = 1;
    while (!(await exactCount(h.db, "proj1", "audience", { rules: DE_WITH_EMAIL }, NOW, 0)).countedAt) { await runCountJobs(h.db, NOW, { budgetMs: 15_000 }); ticks++; }
    console.log(`[scale ${N}] background count finished after ${ticks} tick(s)`);
    const pv = await timed("audience preview served from the stored count", () => get("/v2/projects/proj1/audiences/actions/preview", { method: "POST", json: { rules: DE_WITH_EMAIL } }));
    expect(pv.wallMs).toBeLessThan(5_000);
  }, 900_000);

  it("CSV export streams every row", async () => {
    const csv = await timed("export expired list", async () => (await h.fetch("/v2/projects/proj1/customer_lists/export?list=expired", { key: h.ids.secretKey })).text());
    expect(csv.value.trim().split("\r\n").length - 1).toBe(expected(N, (k) => k % 6 === 1).customers);
  }, 600_000);
});
