import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { fillReferenceSql, REFERENCE_SQL } from "@revenuedot/server/services/charts/reference-sql.js";
import { harness, type Harness } from "../src/harness.js";
import { v2 } from "./v2-helpers.js";
import { NOW, seedChartsHistory } from "./charts-fixture.js";

/**
 * The PostgreSQL we publish for the core charts (apps/server/src/services/charts/reference-sql.ts) returns the same
 * numbers as the API on the chart fixture's history, at monthly and daily resolution.
 */
let h: Harness;
let call: ReturnType<typeof v2>;
beforeAll(async () => {
  h = await harness({ fetch: async () => new Response("", { status: 404 }) });
  call = v2(h);
  await seedChartsHistory(h);
});
afterAll(async () => { await h.close(); });

const RANGES = [
  { resolution: "month", start_date: "2026-05-01", end_date: "2026-09-01" },
  { resolution: "day", start_date: "2026-07-28", end_date: "2026-08-20" },
  { resolution: "week", start_date: "2026-06-10", end_date: "2026-08-31" },
];

describe("published chart SQL", () => {
  for (const q of REFERENCE_SQL) {
    it(`${q.chart}: the SQL equals the API`, async () => {
      for (const r of RANGES) {
        const endExclusive = new Date(Date.parse(`${r.end_date}T00:00:00Z`) + 86_400_000).toISOString();
        const text = fillReferenceSql(q.sql, { project_id: "proj1", resolution: r.resolution, start_date: `${r.start_date}T00:00:00Z`, end_date: endExclusive, now: NOW.toISOString() });
        const res = await h.db.execute(sql.raw(text)) as unknown as { rows: Record<string, unknown>[] };
        const rows = res.rows;
        const api = await call("GET", "/v2/projects/{project_id}/charts/{chart_name}", { chart_name: q.chart }, { query: `resolution=${r.resolution}&start_date=${r.start_date}&end_date=${r.end_date}` });
        const measures: { id: string }[] = api.body.measures;
        const fromApi = (j: number) => api.body.values.filter((v: any) => v.measure === j).map((v: any) => v.value);
        const columns = Object.keys(rows[0]!).filter((k) => k !== "period");
        expect(rows.length, `${q.chart} ${r.resolution}`).toBe(fromApi(0).length);
        // Spot checks against the hand-computed numbers in v2-charts.test.ts, so equal-but-empty answers cannot pass.
        if (r.resolution === "month" && q.chart === "mrr") expect(rows.map((x) => Number(x.mrr))).toEqual([10, 20, 30, 30, 30]);
        if (r.resolution === "month" && q.chart === "revenue") expect(rows.map((x) => Number(x.revenue))).toEqual([10, 20, 30, 35.02, 0]);
        if (r.resolution === "day" && q.chart === "trials") expect(rows.map((x) => Number(x.trials)).slice(4, 13)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 0]);
        columns.forEach((c, j) => {
          const idx = measures.findIndex((m) => m.id === c);
          expect(idx, `${q.chart} has a measure ${c}`).toBeGreaterThanOrEqual(0);
          expect(rows.map((x) => Number(x[c])), `${q.chart}.${c} ${r.resolution}`).toEqual(fromApi(idx === -1 ? j : idx));
        });
      }
    });
  }
});
