import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { CHART_TYPES, chartDef, newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { body, notFound, paginate, paramError, scope, V2Error, type V2Context, type V2Router } from "./common.js";

/**
 * Saved charts (RevenueDot extension, prd/paywalls/PRD.md §6): a named chart view from the Charts page. `view` holds the
 * page's URL state: range, start, end, res, segment, filters, sel, env, compare, type and m. Scopes: charts_metrics:charts:read to
 * list, charts_metrics:charts:read_write to change.
 */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-01-31");
export const View = z.object({
  range: z.string().max(20).optional(), start: Day.optional(), end: Day.optional(), res: z.string().max(20).optional(),
  segment: z.string().max(60).optional(), filters: z.string().max(4000).optional(), sel: z.string().max(2000).optional(),
  env: z.enum(["production", "sandbox"]).optional(), compare: z.boolean().optional(),
  // The chart type and the plotted measure group (prd/charts/PRD.md "Chart type").
  type: z.enum(CHART_TYPES).optional(), m: z.string().regex(/^\d{1,2}$/).optional(),
}).strict();
const Create = z.object({ name: z.string().trim().min(1).max(120), chart_name: z.string().min(1).max(80), view: View.optional() }).strict();
const Update = z.object({ name: z.string().trim().min(1).max(120).optional(), view: View.optional() }).strict();
const LIMIT = 200;

type Row = typeof schema.savedCharts.$inferSelect;
const shape = (x: Row) => ({ object: "saved_chart" as const, id: x.id, name: x.name, chart_name: x.chartName, view: x.view, created_at: x.createdAt.getTime(), updated_at: x.updatedAt.getTime() });

export function savedChartRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/saved_charts";
  const find = async (c: V2Context) => {
    const [row] = await db.select().from(schema.savedCharts).where(and(eq(schema.savedCharts.projectId, c.get("projectId")), eq(schema.savedCharts.id, c.req.param("saved_chart_id")!))).limit(1);
    if (!row) throw notFound("Saved chart");
    return row;
  };
  r.get(P, scope("charts_metrics:charts:read"), async (c) => {
    const rows = await db.select().from(schema.savedCharts).where(eq(schema.savedCharts.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), shape));
  });
  r.post(P, scope("charts_metrics:charts:read_write"), async (c) => {
    const b = await body(c, Create);
    if (!chartDef(b.chart_name)) throw paramError("chart_name is not a chart. Charts: see https://revenuedot.app/docs/guides/charts.", "chart_name");
    const projectId = c.get("projectId");
    const count = await db.select({ id: schema.savedCharts.id }).from(schema.savedCharts).where(eq(schema.savedCharts.projectId, projectId));
    if (count.length >= LIMIT) throw new V2Error(422, "unprocessable_entity_error", `A project can save ${LIMIT} charts.`);
    const p = c.get("principal");
    const now = deps.now();
    const [row] = await db.insert(schema.savedCharts).values({
      id: newId("sc", 14), projectId, name: b.name, chartName: b.chart_name, view: b.view ?? {}, createdBy: p.kind === "user" ? p.userId : null, createdAt: now, updatedAt: now,
    }).returning();
    return c.json(shape(row!), 201);
  });
  r.get(`${P}/:saved_chart_id`, scope("charts_metrics:charts:read"), async (c) => c.json(shape(await find(c))));
  r.patch(`${P}/:saved_chart_id`, scope("charts_metrics:charts:read_write"), async (c) => {
    const x = await find(c);
    const b = await body(c, Update);
    const [row] = await db.update(schema.savedCharts).set({ ...(b.name ? { name: b.name } : {}), ...(b.view ? { view: b.view } : {}), updatedAt: deps.now() }).where(eq(schema.savedCharts.id, x.id)).returning();
    return c.json(shape(row!));
  });
  r.delete(`${P}/:saved_chart_id`, scope("charts_metrics:charts:read_write"), async (c) => {
    const x = await find(c);
    await db.delete(schema.savedCharts).where(eq(schema.savedCharts.id, x.id));
    return c.json({ object: "saved_chart", id: x.id, deleted_at: deps.now().getTime() });
  });
}
