import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { chartContributors, chartDef, floorTo, newId, viewQuery, type ChartView, type Contributor } from "@revenuedot/core";
import { schema, type DB } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { chartSources, loadChartInput } from "../../services/charts/load.js";
import { annotationsBetween, authors, MAX_ANNOTATIONS } from "../../services/charts/annotations.js";
import { buildSnapshot, type ChartBody, type ChartOptionsBody, type ChartSnapshot } from "../../services/charts/share.js";
import { csvCell } from "../../services/customer-lists.js";
import { chartRoutes, dimLabels, parseChartQuery } from "./charts.js";
import { View } from "./saved-charts.js";
import { publicOrigin } from "./setup.js";
import { body, listOf, notFound, paramError, scope, V2Error, v2ErrorResponse, type Principal, type V2Context, type V2Router, type V2Vars } from "./common.js";

/**
 * The chart page's extensions (prd/charts/PRD.md "The chart page"), all RevenueDot extensions to RevenueCat's API v2:
 *   GET  /v2/projects/{id}/charts/{chart_name}/customers           the customers behind the chart (`format=csv`: all of them)
 *   GET  /v2/projects/{id}/chart_annotations, POST                 annotations on every chart of the project
 *   GET  /v2/projects/{id}/chart_annotations/{annotation_id}, PATCH, DELETE
 *   GET  /v2/projects/{id}/chart_shares, POST                      public share links (a snapshot of the chart)
 *   DELETE /v2/projects/{id}/chart_shares/{share_id}               revokes one
 * Reads need charts_metrics:charts:read (the Customers list also customer_information:customers:read); writes need
 * charts_metrics:charts:read_write, so Viewers only read. The audit middleware records every write.
 */
const READ = "charts_metrics:charts:read", WRITE = "charts_metrics:charts:read_write";
const CSV_MAX = 100_000;
const SAMPLE_MAX = 100;
const MAX_SHARES = 200;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date such as 2026-01-31").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "is not a real day");

// ---- Customers ----------------------------------------------------------------------------------------------------------
type Status = "active" | "trialing" | "grace_period" | "billing_issue" | "expired" | "none";
interface CustomerInfo { appUserId: string; firstSeen: number; status: Status; latest: { store: string; productId: string } | null }

/** App user id (a non-anonymous alias first), first seen, subscription status in the chart's environment, latest purchase. */
async function customerInfo(db: DB, projectId: string, ids: string[], sandbox: boolean, now: Date): Promise<Map<string, CustomerInfo>> {
  const out = new Map<string, CustomerInfo>();
  if (!ids.length) return out;
  const C = schema.customers, A = schema.customerAliases, S = schema.subscriptions, N = schema.nonSubscriptions;
  const [customers, aliases, subs, ones] = await Promise.all([
    db.select({ id: C.id, original: C.originalAppUserId, firstSeen: C.firstSeen }).from(C).where(and(eq(C.projectId, projectId), inArray(C.id, ids))),
    db.select({ customerId: A.customerId, appUserId: A.appUserId, createdAt: A.createdAt }).from(A).where(and(eq(A.projectId, projectId), inArray(A.customerId, ids))),
    db.select({ customerId: S.customerId, store: S.store, product: S.productIdentifier, purchaseDate: S.purchaseDate, expiresDate: S.expiresDate, grace: S.gracePeriodExpiresDate, billing: S.billingIssuesDetectedAt, periodType: S.periodType, refundedAt: S.refundedAt })
      .from(S).where(and(eq(S.projectId, projectId), inArray(S.customerId, ids), eq(S.isSandbox, sandbox), ne(S.store, "promotional"))),
    db.select({ customerId: N.customerId, store: N.store, product: N.productIdentifier, purchaseDate: N.purchaseDate }).from(N).where(and(eq(N.projectId, projectId), inArray(N.customerId, ids), eq(N.isSandbox, sandbox))),
  ]);
  const named = new Map<string, string>();
  for (const a of [...aliases].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) if (!a.appUserId.startsWith("$RCAnonymousID:") && !named.has(a.customerId)) named.set(a.customerId, a.appUserId);
  const subsOf = new Map<string, typeof subs>();
  for (const s of subs) subsOf.set(s.customerId, [...(subsOf.get(s.customerId) ?? []), s]);
  const onesOf = new Map<string, typeof ones>();
  for (const o of ones) onesOf.set(o.customerId, [...(onesOf.get(o.customerId) ?? []), o]);
  const t = now.getTime();
  for (const c of customers) {
    const mine = subsOf.get(c.id) ?? [];
    const active = mine.filter((s) => !s.refundedAt && (!s.expiresDate || s.expiresDate.getTime() > t || (!!s.grace && s.grace.getTime() > t)))
      .sort((a, b) => (b.expiresDate?.getTime() ?? Infinity) - (a.expiresDate?.getTime() ?? Infinity));
    const lead = active[0];
    let status: Status = mine.length ? "expired" : "none";
    if (lead) {
      const inGrace = !!lead.grace && lead.grace.getTime() > t && (!lead.expiresDate || lead.expiresDate.getTime() <= t);
      status = inGrace ? "grace_period" : lead.billing ? "billing_issue" : lead.periodType === "trial" ? "trialing" : "active";
    }
    const latest = [...mine.map((s) => ({ store: s.store, productId: s.product, at: s.purchaseDate.getTime() })), ...(onesOf.get(c.id) ?? []).map((o) => ({ store: o.store, productId: o.product, at: o.purchaseDate.getTime() }))]
      .sort((a, b) => b.at - a.at)[0] ?? null;
    out.set(c.id, { appUserId: named.get(c.id) ?? c.original, firstSeen: c.firstSeen.getTime(), status, latest: latest ? { store: latest.store, productId: latest.productId } : null });
  }
  return out;
}

const STATUS_LABEL: Record<Status, string> = { active: "Active", trialing: "Trial", grace_period: "Grace period", billing_issue: "Billing issue", expired: "Expired", none: "No subscription" };
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "");

// ---- Annotations ----------------------------------------------------------------------------------------------------------
const AnnotationCreate = z.object({
  title: z.string().trim().min(1).max(120), description: z.string().trim().max(1000).nullable().optional(), start_date: Day, end_date: Day.nullable().optional(),
}).strict();
const AnnotationUpdate = z.object({
  title: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(1000).nullable().optional(), start_date: Day.optional(), end_date: Day.nullable().optional(),
}).strict();
type AnnotationRow = typeof schema.chartAnnotations.$inferSelect;
type Author = { id: string; email: string; name: string | null };
const annotationShape = (x: AnnotationRow, who: Map<string, Author>) => ({
  object: "chart_annotation" as const, id: x.id, title: x.title, description: x.description, start_date: x.startDate, end_date: x.endDate,
  created_by: x.createdBy ? who.get(x.createdBy) ?? { id: x.createdBy, email: null, name: null } : null, created_at: x.createdAt.getTime(), updated_at: x.updatedAt.getTime(),
});

// ---- Share links ----------------------------------------------------------------------------------------------------------
const ShareCreate = z.object({ chart_name: z.string().min(1).max(80), view: View.optional() }).strict();
type ShareRow = typeof schema.chartShares.$inferSelect;
export const shareToken = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return `cs_${btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};
const shareOrigin = (deps: Deps, c: V2Context) => (deps.apiUrl ?? deps.publicUrl ?? publicOrigin(c)).replace(/\/+$/, "");
const shareShape = (x: ShareRow, origin: string, who: Map<string, Author>) => {
  const snap = x.snapshot as unknown as ChartSnapshot;
  return {
    object: "chart_share" as const, id: x.id, chart_name: x.chartName, title: snap.title, url: `${origin}/share/charts/${x.id}`, image_url: `${origin}/share/charts/${x.id}/og.png`,
    view: x.view, start_date: snap.start_date, end_date: snap.end_date,
    created_by: x.createdBy ? who.get(x.createdBy) ?? { id: x.createdBy, email: null, name: null } : null, created_at: x.createdAt.getTime(), revoked_at: x.revokedAt ? x.revokedAt.getTime() : null,
  };
};

/**
 * Runs the chart and options endpoints in process for the caller, so a share link holds exactly what the chart API
 * answers for that view (same parameters, checks and labels).
 */
async function chartAnswer<T>(deps: Deps, principal: Principal, projectId: string, path: string): Promise<T> {
  const inner = new Hono<{ Variables: V2Vars }>();
  inner.onError((e, c) => v2ErrorResponse(c, e));
  inner.use("*", async (c, next) => { c.set("deps", deps); c.set("principal", principal); c.set("projectId", projectId); await next(); });
  chartRoutes(inner, deps);
  const res = await inner.request(path);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new V2Error(res.status as ContentfulStatusCode, (json.type as never) ?? "server_error", `The chart view is not valid: ${String(json.message ?? res.status)}`, json.param ? `view.${String(json.param)}` : "view");
  return json as T;
}

export function chartExtraRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";
  const user = (c: V2Context) => { const p = c.get("principal"); return p.kind === "user" ? p.userId : null; };

  // ---- Customers behind a chart
  r.get(`${P}/charts/:chart_name/customers`, scope(READ, "customer_information:customers:read"), async (c) => {
    const now = deps.now();
    const p = parseChartQuery(c, now);
    const format = c.req.query("format") || "json";
    if (format !== "json" && format !== "csv") throw paramError("format must be json or csv.", "format");
    const limRaw = c.req.query("limit");
    const limit = limRaw === undefined || limRaw === "" ? SAMPLE_MAX : Number(limRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > SAMPLE_MAX) throw paramError(`limit must be a whole number from 1 to ${SAMPLE_MAX}.`, "limit");
    const projectId = c.get("projectId");
    const sources = chartSources(p.def.name, { from: floorTo(p.rangeStart, p.req.resolution), to: p.req.rangeEnd });
    const input = await loadChartInput(db, { projectId, sandbox: p.sandbox, now, currency: p.currency, fetch: deps.fetch ?? undefined, sources });
    const res = chartContributors(p.def, input, p.req, { filters: p.filters, segment: p.segment, limit: p.limit });
    const labels = p.segment ? await dimLabels(deps, projectId, p.segment) : null;
    const segmentOf = (x: Contributor) => (x.segment === undefined ? null : x.segmentOther ? "Other" : labels!(x.segment));
    const item = (x: Contributor, info: CustomerInfo | undefined) => ({
      object: "chart_customer" as const, customer_id: x.customerId, app_user_id: info?.appUserId ?? null, status: info?.status ?? "none",
      store: x.store ?? info?.latest?.store ?? null, product_id: x.productId ?? info?.latest?.productId ?? null,
      contributed_at: x.at, first_seen_at: info?.firstSeen ?? null, value: Math.round(x.value * 1e6) / 1e6, segment: segmentOf(x),
    });
    const measure = res.measure ? { id: res.measure.id, display_name: res.measure.display_name, unit: res.measure.unit } : null;

    if (format === "json") {
      const page = res.rows.slice(0, limit);
      const info = await customerInfo(db, projectId, [...new Set(page.map((x) => x.customerId))], p.sandbox, now);
      return c.json({
        object: "chart_customers", chart_name: p.def.name, total_count: res.rows.length, value: measure, sum: res.sum, unattributed_value: Math.round(res.unattributed * 1e6) / 1e6, date_label: res.dateLabel,
        currency: p.currency, segment: p.segment, items: page.map((x) => item(x, info.get(x.customerId))),
      });
    }

    // CSV: every contributor, streamed in pages of 500 so a large chart never builds the whole file in memory.
    const rows = res.rows.slice(0, CSV_MAX);
    const unitLabel = measure ? (measure.unit === "$" ? ` (${p.currency})` : measure.unit === "%" ? " (%)" : "") : "";
    const head = ["App User ID", "Customer ID", "Status", "Store", "Product", res.dateLabel, "First seen", ...(measure ? [`${measure.display_name}${unitLabel}`] : []), ...(p.segment ? ["Segment"] : [])];
    const enc = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) { ctl.enqueue(enc.encode(`${head.map(csvCell).join(",")}\r\n`)); },
      async pull(ctl) {
        try {
          if (i >= rows.length) {
            if (res.rows.length > rows.length) ctl.enqueue(enc.encode(`${csvCell(`Export cut at ${CSV_MAX.toLocaleString("en-US")} of ${res.rows.length.toLocaleString("en-US")} customers.`)}\r\n`));
            ctl.close();
            return;
          }
          const chunk = rows.slice(i, i + 500);
          i += chunk.length;
          const info = await customerInfo(db, projectId, [...new Set(chunk.map((x) => x.customerId))], p.sandbox, now);
          ctl.enqueue(enc.encode(chunk.map((x) => {
            const it = item(x, info.get(x.customerId));
            return [it.app_user_id, it.customer_id, STATUS_LABEL[it.status], it.store, it.product_id, iso(it.contributed_at), iso(it.first_seen_at), ...(measure ? [it.value] : []), ...(p.segment ? [it.segment] : [])].map(csvCell).join(",");
          }).join("\r\n") + "\r\n"));
        } catch (e) { ctl.error(e); }
      },
    });
    const day = now.toISOString().slice(0, 10);
    return c.body(stream, 200, {
      "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${p.def.name}-customers-${day}.csv"`, "cache-control": "no-store",
      "x-revenuedot-total-count": String(res.rows.length), ...(res.rows.length > CSV_MAX ? { "x-revenuedot-truncated": "true" } : {}),
    });
  });

  // ---- Annotations
  const A = schema.chartAnnotations;
  const findAnnotation = async (c: V2Context) => {
    const [row] = await db.select().from(A).where(and(eq(A.projectId, c.get("projectId")), eq(A.id, c.req.param("annotation_id")!))).limit(1);
    if (!row) throw notFound("Chart annotation");
    return row;
  };
  const day = (name: string, v: string | undefined) => {
    if (v === undefined || v === "") return null;
    const r = Day.safeParse(v);
    if (!r.success) throw paramError(`${name} must be a date such as 2026-01-31.`, name);
    return v;
  };
  r.get(`${P}/chart_annotations`, scope(READ), async (c) => {
    const from = day("start_date", c.req.query("start_date")), to = day("end_date", c.req.query("end_date"));
    if (from && to && to < from) throw paramError("end_date must not be before start_date.", "end_date");
    const rows = await annotationsBetween(db, c.get("projectId"), from, to);
    const who = await authors(db, rows.map((x) => x.createdBy));
    return c.json(listOf(c, rows.map((x) => annotationShape(x, who)), null));
  });
  r.post(`${P}/chart_annotations`, scope(WRITE), async (c) => {
    const b = await body(c, AnnotationCreate);
    const end = b.end_date ?? b.start_date;
    if (end < b.start_date) throw paramError("end_date must not be before start_date.", "end_date");
    const projectId = c.get("projectId");
    const count = await db.select({ id: A.id }).from(A).where(eq(A.projectId, projectId)).limit(MAX_ANNOTATIONS);
    if (count.length >= MAX_ANNOTATIONS) throw new V2Error(422, "unprocessable_entity_error", `A project can have ${MAX_ANNOTATIONS} chart annotations.`);
    const now = deps.now();
    const [row] = await db.insert(A).values({ id: newId("chartannot", 12), projectId, startDate: b.start_date, endDate: end, title: b.title, description: b.description || null, createdBy: user(c), createdAt: now, updatedAt: now }).returning();
    return c.json(annotationShape(row!, await authors(db, [row!.createdBy])), 201);
  });
  r.get(`${P}/chart_annotations/:annotation_id`, scope(READ), async (c) => {
    const row = await findAnnotation(c);
    return c.json(annotationShape(row, await authors(db, [row.createdBy])));
  });
  r.patch(`${P}/chart_annotations/:annotation_id`, scope(WRITE), async (c) => {
    const x = await findAnnotation(c);
    const b = await body(c, AnnotationUpdate);
    const start = b.start_date ?? x.startDate;
    // A single-day annotation moved to another day stays a single day; `end_date: null` makes it one.
    const end = b.end_date === null ? start : b.end_date ?? (b.start_date && x.endDate === x.startDate ? start : x.endDate);
    if (end < start) throw paramError("end_date must not be before start_date.", b.end_date ? "end_date" : "start_date");
    const [row] = await db.update(A).set({
      startDate: start, endDate: end, ...(b.title !== undefined ? { title: b.title } : {}), ...(b.description !== undefined ? { description: b.description || null } : {}), updatedAt: deps.now(),
    }).where(eq(A.id, x.id)).returning();
    return c.json(annotationShape(row!, await authors(db, [row!.createdBy])));
  });
  r.delete(`${P}/chart_annotations/:annotation_id`, scope(WRITE), async (c) => {
    const x = await findAnnotation(c);
    await db.delete(A).where(eq(A.id, x.id));
    return c.json({ object: "chart_annotation", id: x.id, deleted_at: deps.now().getTime() });
  });

  // ---- Share links
  const S = schema.chartShares;
  r.get(`${P}/chart_shares`, scope(READ), async (c) => {
    const chart = c.req.query("chart_name");
    const rows = await db.select().from(S).where(and(eq(S.projectId, c.get("projectId")), isNull(S.revokedAt), chart ? eq(S.chartName, chart) : undefined)).orderBy(desc(S.createdAt)).limit(MAX_SHARES);
    const who = await authors(db, rows.map((x) => x.createdBy));
    const origin = shareOrigin(deps, c);
    return c.json(listOf(c, rows.map((x) => shareShape(x, origin, who)), null));
  });
  r.post(`${P}/chart_shares`, scope(WRITE), async (c) => {
    const b = await body(c, ShareCreate);
    const def = chartDef(b.chart_name);
    if (!def) throw paramError("chart_name is not a chart. Charts: see https://revenuedot.app/docs/guides/charts.", "chart_name");
    const projectId = c.get("projectId");
    const active = await db.select({ id: S.id }).from(S).where(and(eq(S.projectId, projectId), isNull(S.revokedAt))).limit(MAX_SHARES);
    if (active.length >= MAX_SHARES) throw new V2Error(422, "unprocessable_entity_error", `A project can have ${MAX_SHARES} active share links. Revoke one first.`);
    const view: ChartView = b.view ?? {};
    const now = deps.now();
    const q = new URLSearchParams(viewQuery(def, view, now.getTime()));
    const base = `/v2/projects/${encodeURIComponent(projectId)}/charts/${encodeURIComponent(def.name)}`;
    const principal = c.get("principal");
    const [chart, options, project] = await Promise.all([
      chartAnswer<ChartBody>(deps, principal, projectId, `${base}?${q}`),
      chartAnswer<ChartOptionsBody>(deps, principal, projectId, `${base}/options?environment=${q.get("environment")}`),
      db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1),
    ]);
    const snapshot = buildSnapshot(def, chart, options, view, project[0]?.name ?? "", now.getTime());
    const [row] = await db.insert(S).values({ id: shareToken(), projectId, chartName: def.name, view: view as Record<string, unknown>, snapshot: snapshot as unknown as Record<string, unknown>, createdBy: user(c), createdAt: now }).returning();
    return c.json(shareShape(row!, shareOrigin(deps, c), await authors(db, [row!.createdBy])), 201);
  });
  r.delete(`${P}/chart_shares/:share_id`, scope(WRITE), async (c) => {
    const [row] = await db.select().from(S).where(and(eq(S.projectId, c.get("projectId")), eq(S.id, c.req.param("share_id")!), isNull(S.revokedAt))).limit(1);
    if (!row) throw notFound("Share link");
    const now = deps.now();
    await db.update(S).set({ revokedAt: now }).where(eq(S.id, row.id));
    return c.json({ object: "chart_share", id: row.id, deleted_at: now.getTime() });
  });
}
