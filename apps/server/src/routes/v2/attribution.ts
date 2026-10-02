import { and, eq, isNotNull } from "drizzle-orm";
import { ATTRIBUTION_DIMS, attributionReport, isoDay, NO_ATTRIBUTION, type AttributionDim } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { loadChartInput } from "../../services/charts/load.js";
import { paramError, scope, type V2Router } from "./common.js";

/**
 * Revenue by campaign (prd/attribution-benchmarks-insights §1), a RevenueDot extension:
 *   GET /v2/projects/{project_id}/attribution/report?group_by=campaign&media_source=&start_date=&end_date=&environment=
 * New customers cohorted in [start_date, end_date] (inclusive, UTC; default the last 30 days) by one attribution
 * dimension, with trial starts, paying customers and revenue on day 0, by day 7, by day 30 and to date (USD).
 */
const DAY = 86_400_000;
const GROUPS: AttributionDim[] = ["media_source", "campaign", "ad_group", "keyword"];

const dateParam = (name: string, v: string | undefined) => {
  if (v === undefined || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw paramError(`${name} must be a date such as 2026-01-31.`, name);
  return Date.parse(`${v}T00:00:00Z`);
};

export function attributionRoutes(r: V2Router, deps: Deps) {
  r.get("/v2/projects/:project_id/attribution/report", scope("charts_metrics:charts:read"), async (c) => {
    const projectId = c.get("projectId");
    const now = deps.now();
    const groupBy = (c.req.query("group_by") || "campaign") as AttributionDim;
    if (!GROUPS.includes(groupBy)) throw paramError(`group_by must be one of ${GROUPS.join(", ")}.`, "group_by");
    const env = c.req.query("environment") || "production";
    if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
    const today = Math.floor(now.getTime() / DAY) * DAY;
    const last = dateParam("end_date", c.req.query("end_date")) ?? today;
    const first = dateParam("start_date", c.req.query("start_date")) ?? last - 29 * DAY;
    if (last < first) throw paramError("end_date must not be before start_date.", "end_date");
    if (last - first > 3 * 366 * DAY) throw paramError("The range can be at most 3 years.", "start_date");
    const ms = c.req.query("media_source");
    const mediaSource = ms === undefined ? null : ms === NO_ATTRIBUTION ? "" : ms;
    const input = await loadChartInput(deps.db, { projectId, sandbox: env === "sandbox", now, currency: "USD", fetch: null, sources: { sdkTypes: [], activity: null, refundRequests: false } });
    const report = attributionReport(input, { from: first, to: last + DAY, groupBy, mediaSource });
    const sources = await deps.db.selectDistinct({ v: schema.customerAttribution.mediaSource }).from(schema.customerAttribution)
      .where(and(eq(schema.customerAttribution.projectId, projectId), isNotNull(schema.customerAttribution.mediaSource))).limit(200);
    const label = (k: string) => (k === "" ? NO_ATTRIBUTION : k);
    return c.json({
      object: "attribution_report", group_by: groupBy, media_source: mediaSource, environment: env, currency: "USD",
      start_date: isoDay(first), end_date: isoDay(last), computed_at: now.getTime(),
      dimensions: ATTRIBUTION_DIMS.filter((d) => GROUPS.includes(d)),
      media_sources: sources.map((s) => s.v!).sort((a, b) => a.localeCompare(b)),
      rows: report.rows.map((row) => ({ object: "attribution_report_row", ...row, label: label(row.key) })),
      total: { object: "attribution_report_row", ...report.total, key: "total", label: "Total" },
    });
  });
}
