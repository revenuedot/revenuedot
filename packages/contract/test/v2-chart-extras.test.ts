import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { CHARTS, contributorsMeasure } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import { createSecretKey } from "@revenuedot/server/services/auth.js";
import { fillReferenceSql, REFERENCE_CUSTOMER_SQL } from "@revenuedot/server/services/charts/reference-sql.js";
import { harness, type Harness } from "../src/harness.js";
import { otherProject, signup, v2 } from "./v2-helpers.js";
import { NOW, seedChartsHistory } from "./charts-fixture.js";

/**
 * The chart page's extensions (prd/charts/PRD.md "The chart page"): the Customers tab, annotations and share links, on the
 * chart fixture's history (charts-fixture.ts). The customers listed add up to the chart, the published customers SQL
 * equals the API, Viewers only read, writes are audited, and a revoked share link stops answering at once.
 */
let h: Harness;
let call: ReturnType<typeof v2>;
beforeAll(async () => {
  h = await harness({ fetch: async () => new Response("", { status: 404 }) });
  call = v2(h);
  await seedChartsHistory(h);
});
afterAll(async () => { await h.close(); });

const CH = "/v2/projects/{project_id}/charts/{chart_name}";
const MONTHS = "resolution=2&start_date=2026-05-01&end_date=2026-09-01";
const customers = (chart_name: string, query = MONTHS, o: { key?: string; cookie?: string } = {}) => call("GET", `${CH}/customers`, { chart_name }, { query, ext: true, ...o });
const chart = (chart_name: string, query = MONTHS) => call("GET", CH, { chart_name }, { query });

/** A dashboard user with `role` in the harness project; returns the session cookie. */
async function member(email: string, role: "admin" | "developer" | "viewer") {
  const cookie = await signup(h, email, `${email} project`);
  const [u] = await h.db.select().from(schema.users).where(eq(schema.users.email, email));
  await h.db.insert(schema.memberships).values({ userId: u!.id, projectId: "proj1", role });
  return { cookie, userId: u!.id };
}

/** What the listed values add up to, read from the chart API's answer. */
function chartTotal(name: string, body: any, selectors: Record<string, string> = {}): number {
  const def = CHARTS.find((c) => c.name === name)!;
  const { measure, sum } = contributorsMeasure(def, selectors);
  if (body.periods) {
    const cohorts = new Map<number, number>();
    for (const v of body.values) if (v.period === 0) cohorts.set(v.cohort, v.value ?? 0);
    return [...cohorts.values()].reduce((s, v) => s + v, 0);
  }
  if (name === "subscription_status") {
    const last = Math.max(...body.values.map((v: any) => v.cohort));
    return body.values.filter((v: any) => v.cohort === last).reduce((s: number, v: any) => s + (v.value ?? 0), 0);
  }
  const j = body.measures.findIndex((m: any) => m.id === measure!.id);
  expect(j, `${name} has measure ${measure!.id}`).toBeGreaterThanOrEqual(0);
  const vals = body.values.filter((v: any) => v.measure === j).sort((a: any, b: any) => a.cohort - b.cohort).map((v: any) => v.value ?? 0);
  return sum === "last" ? vals[vals.length - 1] : vals.reduce((s: number, v: number) => s + v, 0);
}

describe("chart customers", () => {
  it("every chart lists the customers behind it, and their values add up to the chart", async () => {
    for (const c of CHARTS) {
      const q = c.shape === "cohort_table" ? "start_date=2026-05-01&end_date=2026-09-01" : MONTHS;
      const r = await customers(c.name, q);
      expect(r.status, c.name).toBe(200);
      expect(r.body).toMatchObject({ object: "chart_customers", chart_name: c.name, total_count: r.body.items.length });
      if (c.name === "app_store_save_outcomes") { expect(r.body.items).toEqual([]); continue; }
      const sum = r.body.items.reduce((s: number, x: any) => s + x.value, 0);
      const target = c.name === "ad_monetized_customers" || c.name === "ad_arpdau" ? chartTotal("ad_revenue", (await chart("ad_revenue")).body) : chartTotal(c.name, (await chart(c.name, q)).body);
      expect(sum, c.name).toBeCloseTo(target, 2);
    }
  });

  it("revenue: each customer's money in the range, with app user id, status, store and product", async () => {
    const r = await customers("revenue");
    const by = Object.fromEntries(r.body.items.map((x: any) => [x.app_user_id, x]));
    expect(Object.fromEntries(Object.entries(by).map(([k, x]: [string, any]) => [k, x.value]))).toEqual({ u_a: 40.02, u_b: 20, u_d: 0, u_e: 20, u_g: 5, u_p: 10 });
    expect(r.body.value).toEqual({ id: "revenue", display_name: "Revenue", unit: "$" });
    expect(r.body).toMatchObject({ sum: "total", date_label: "Latest purchase", currency: "USD", segment: null });
    expect(by.u_a).toMatchObject({ object: "chart_customer", status: "active", store: "app_store", product_id: "pro_monthly", segment: null });
    expect(by.u_e.status).toBe("expired");
    expect(by.u_g).toMatchObject({ product_id: "coins_100", contributed_at: Date.parse("2026-08-20T00:00:00Z") });
    expect(by.u_p).toMatchObject({ store: "play_store", product_id: "pro" });
    // Most recent contribution first.
    const at = r.body.items.map((x: any) => x.contributed_at);
    expect(at).toEqual([...at].sort((a: number, b: number) => b - a));
    // limit trims the sample, not the count.
    const two = await customers("revenue", `${MONTHS}&limit=2`);
    expect(two.body).toMatchObject({ total_count: 6 });
    expect(two.body.items).toHaveLength(2);
    expect((await customers("revenue", `${MONTHS}&limit=0`)).status).toBe(400);
    expect((await customers("revenue", `${MONTHS}&format=xml`)).status).toBe(400);
  });

  it("respects filters, segments, selectors and the sandbox switch", async () => {
    const gb = await customers("revenue", `${MONTHS}&filters=${encodeURIComponent(JSON.stringify([{ name: "country", values: ["GB"] }]))}`);
    expect(gb.body.items.map((x: any) => x.app_user_id)).toEqual(["u_b"]);
    const seg = await customers("revenue", `${MONTHS}&segment=country&limit_num_segments=1`);
    expect(seg.body.segment).toBe("country");
    expect(new Set(seg.body.items.map((x: any) => x.segment))).toEqual(new Set(["United States", "Other"]));
    expect(seg.body.items.find((x: any) => x.app_user_id === "u_b").segment).toBe("Other");
    const proceeds = await customers("revenue", `${MONTHS}&selectors=${encodeURIComponent(JSON.stringify({ revenue_type: "proceeds" }))}`);
    expect(proceeds.body.value.display_name).toBe("Proceeds");
    expect(proceeds.body.items.find((x: any) => x.app_user_id === "u_g").value).toBeCloseTo(3.5, 6);
    const sandbox = await customers("revenue", `${MONTHS}&environment=sandbox`);
    expect(sandbox.body.items.map((x: any) => [x.app_user_id, x.value, x.store])).toEqual([["u_s", 9.99, "test_store"]]);
    const mrr = await customers("mrr");
    expect(mrr.body).toMatchObject({ sum: "last", date_label: "Paid start" });
    expect(Object.fromEntries(mrr.body.items.filter((x: any) => x.value).map((x: any) => [x.app_user_id, x.value]))).toEqual({ u_a: 10, u_b: 10, u_p: 10 });
    const bad = await customers("revenue", `${MONTHS}&segment=paywall`);
    expect(bad.status).toBe(400);
  });

  it("exports every contributor as CSV", async () => {
    const res = await h.fetch(`/v2/projects/proj1/charts/revenue/customers?${MONTHS}&format=csv`, { key: h.ids.secretKey });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="revenue-customers-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.headers.get("x-revenuedot-total-count")).toBe("6");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("App User ID,Customer ID,Status,Store,Product,Latest purchase,First seen,Revenue (USD)");
    expect(lines).toHaveLength(7);
    const a = lines.find((l) => l.startsWith("u_a,"))!.split(",");
    expect([a[2], a[3], a[4], a[5], a[7]]).toEqual(["Active", "app_store", "pro_monthly", "2026-08-15T10:02:00.000Z", "40.02"]);
    // Segmented: one row per customer and segment, as the chart splits them: u_a's purchases are from the US storefront,
    // while their ad revenue follows the customer's own country, which the SDK never sent ("Unknown").
    const seg = await (await h.fetch(`/v2/projects/proj1/charts/revenue/customers?${MONTHS}&format=csv&segment=country`, { key: h.ids.secretKey })).text();
    const rows = seg.trim().split("\r\n");
    expect(rows[0]!.endsWith(",Revenue (USD),Segment")).toBe(true);
    expect(rows.filter((l) => l.startsWith("u_a,")).map((l) => l.split(",").slice(7))).toEqual([["0.02", "Unknown"], ["40", "United States"]]);
  });

  it("needs the customers read permission on top of the charts one; a Viewer reads", async () => {
    const chartsOnly = (await createSecretKey(h.db, "proj1", "charts only", ["charts_metrics:charts:read"])).key;
    expect((await customers("revenue", MONTHS, { key: chartsOnly })).status).toBe(403);
    const both = (await createSecretKey(h.db, "proj1", "charts and customers", ["charts_metrics:charts:read", "customer_information:customers:read"])).key;
    expect((await customers("revenue", MONTHS, { key: both })).status).toBe(200);
    const viewer = await member("viewer-customers@example.com", "viewer");
    expect((await customers("revenue", MONTHS, { cookie: viewer.cookie })).status).toBe(200);
    const other = await otherProject(h);
    expect((await customers("revenue", MONTHS, { key: other.key })).status).toBe(404);
  });

  it("the published customers SQL returns the same customers and values as the API", async () => {
    const ranges = [{ resolution: "month", start_date: "2026-05-01", end_date: "2026-08-31" }, { resolution: "day", start_date: "2026-07-28", end_date: "2026-08-20" }, { resolution: "week", start_date: "2026-06-10", end_date: "2026-08-31" }];
    for (const q of REFERENCE_CUSTOMER_SQL) {
      for (const r of ranges) {
        const endExclusive = new Date(Date.parse(`${r.end_date}T00:00:00Z`) + 86_400_000).toISOString();
        const text = fillReferenceSql(q.sql, { project_id: "proj1", resolution: r.resolution, start_date: `${r.start_date}T00:00:00Z`, end_date: endExclusive, now: NOW.toISOString() });
        const rows = ((await h.db.execute(sql.raw(text))) as unknown as { rows: Record<string, unknown>[] }).rows;
        const col = Object.keys(rows[0] ?? { customer_id: 0, v: 0 }).find((k) => k !== "customer_id")!;
        const fromSql = Object.fromEntries(rows.map((x) => [String(x.customer_id), Number(x[col])]));
        const api = await customers(q.chart, `resolution=${r.resolution}&start_date=${r.start_date}&end_date=${r.end_date}&expand_periods=false`);
        const fromApi = Object.fromEntries(api.body.items.filter((x: any) => q.chart !== "mrr" || x.value).map((x: any) => [x.customer_id, Math.round(x.value * 100) / 100]));
        expect(fromApi, `${q.chart} ${r.resolution}`).toEqual(fromSql);
        if (r.resolution === "month") expect(Object.keys(fromSql).length, q.chart).toBeGreaterThan(0);
      }
    }
  });
});

describe("chart annotations", () => {
  const A = "/v2/projects/{project_id}/chart_annotations";
  it("create, list by overlap, read, edit and delete; every write is audited", async () => {
    const dev = await member("dev-annotations@example.com", "developer");
    const one = await call("POST", A, {}, { cookie: dev.cookie, ext: true, json: { title: "Launched 2.0", description: "New paywall", start_date: "2026-07-15" } });
    expect(one.status).toBe(201);
    expect(one.body).toMatchObject({ object: "chart_annotation", title: "Launched 2.0", description: "New paywall", start_date: "2026-07-15", end_date: "2026-07-15", created_by: { id: dev.userId, email: "dev-annotations@example.com" } });
    expect(one.body.id).toMatch(/^chartannot/);
    const range = await call("POST", A, {}, { ext: true, json: { title: "Summer sale", start_date: "2026-08-01", end_date: "2026-08-07" } });
    expect(range.status).toBe(201);
    expect(range.body.created_by).toBeNull();
    const old = await call("POST", A, {}, { ext: true, json: { title: "Old", start_date: "2026-01-01" } });

    const list = await call("GET", A, {}, { ext: true, query: "start_date=2026-07-01&end_date=2026-08-03" });
    expect(list.body.items.map((x: any) => x.title)).toEqual(["Launched 2.0", "Summer sale"]);
    expect((await call("GET", A, {}, { ext: true, query: "start_date=2026-08-05&end_date=2026-08-05" })).body.items.map((x: any) => x.title)).toEqual(["Summer sale"]);
    expect((await call("GET", `${A}/{annotation_id}`, { annotation_id: one.body.id }, { ext: true })).body.title).toBe("Launched 2.0");

    // Moving a one-day annotation keeps it one day; a range keeps its end unless told.
    const moved = await call("PATCH", `${A}/{annotation_id}`, { annotation_id: one.body.id }, { cookie: dev.cookie, ext: true, json: { start_date: "2026-07-16", title: "Launched 2.0.1", description: null } });
    expect(moved.body).toMatchObject({ start_date: "2026-07-16", end_date: "2026-07-16", title: "Launched 2.0.1", description: null });
    const widened = await call("PATCH", `${A}/{annotation_id}`, { annotation_id: range.body.id }, { ext: true, json: { start_date: "2026-07-30" } });
    expect(widened.body).toMatchObject({ start_date: "2026-07-30", end_date: "2026-08-07" });
    expect((await call("PATCH", `${A}/{annotation_id}`, { annotation_id: range.body.id }, { ext: true, json: { start_date: "2026-08-10" } })).status).toBe(400);
    const single = await call("PATCH", `${A}/{annotation_id}`, { annotation_id: range.body.id }, { ext: true, json: { end_date: null } });
    expect(single.body).toMatchObject({ start_date: "2026-07-30", end_date: "2026-07-30" });

    // On chart data, in RevenueCat's ChartAnnotation shape (validated against its schema by `call`).
    const data = await chart("revenue", `${MONTHS}&include_annotations=true`);
    expect(data.status).toBe(200);
    expect(data.body.annotations).toEqual([
      { object: "chart_annotation", id: one.body.id, description: "Launched 2.0.1", start_date: "2026-07-16", end_date: null },
      { object: "chart_annotation", id: range.body.id, description: "Summer sale", start_date: "2026-07-30", end_date: null },
    ]);
    expect((await chart("revenue", MONTHS)).body.annotations).toBeUndefined();

    expect((await call("DELETE", `${A}/{annotation_id}`, { annotation_id: old.body.id }, { cookie: dev.cookie, ext: true })).body).toMatchObject({ object: "chart_annotation", id: old.body.id });
    expect((await call("GET", `${A}/{annotation_id}`, { annotation_id: old.body.id }, { ext: true })).status).toBe(404);

    const log = await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: "limit=50" });
    const mine = log.body.items.filter((x: any) => x.target_type === "chart_annotation");
    expect(mine.map((x: any) => x.action_type).sort()).toEqual(["chart_annotation_created", "chart_annotation_created", "chart_annotation_created", "chart_annotation_deleted", "chart_annotation_updated", "chart_annotation_updated", "chart_annotation_updated"]);
    expect(mine.find((x: any) => x.action_type === "chart_annotation_deleted").target_identifier).toBe(old.body.id);
    expect(mine.some((x: any) => x.actor_identifier === dev.userId && x.actor_type === "user")).toBe(true);
  });

  it("rejects bad input; Viewers and read-only keys only read; other projects never see them", async () => {
    const bad = async (json: unknown) => (await call("POST", A, {}, { ext: true, json })).body;
    expect((await bad({ title: "", start_date: "2026-07-01" })).param).toBe("title");
    expect((await bad({ title: "x", start_date: "2026-02-30" })).param).toBe("start_date");
    expect((await bad({ title: "x", start_date: "2026-07-02", end_date: "2026-07-01" })).param).toBe("end_date");
    expect((await bad({ title: "x", start_date: "2026-07-01", colour: "red" })).type).toBe("parameter_error");
    expect((await bad({ title: "x".repeat(121), start_date: "2026-07-01" })).param).toBe("title");
    expect((await call("GET", A, {}, { ext: true, query: "start_date=July" })).status).toBe(400);

    const viewer = await member("viewer-annotations@example.com", "viewer");
    expect((await call("GET", A, {}, { cookie: viewer.cookie, ext: true })).status).toBe(200);
    expect((await call("POST", A, {}, { cookie: viewer.cookie, ext: true, json: { title: "x", start_date: "2026-07-01" } })).status).toBe(403);
    const some = (await call("GET", A, {}, { ext: true })).body.items[0];
    expect((await call("PATCH", `${A}/{annotation_id}`, { annotation_id: some.id }, { cookie: viewer.cookie, ext: true, json: { title: "y" } })).status).toBe(403);
    expect((await call("DELETE", `${A}/{annotation_id}`, { annotation_id: some.id }, { cookie: viewer.cookie, ext: true })).status).toBe(403);
    const readOnly = (await createSecretKey(h.db, "proj1", "read only", ["charts_metrics:charts:read"])).key;
    expect((await call("GET", A, {}, { key: readOnly, ext: true })).status).toBe(200);
    expect((await call("POST", A, {}, { key: readOnly, ext: true, json: { title: "x", start_date: "2026-07-01" } })).status).toBe(403);

    const otherKey = (await createSecretKey(h.db, "projB", "other annotations")).key;
    expect((await call("GET", A, { project_id: "projB" }, { key: otherKey, ext: true })).body.items).toEqual([]);
    expect((await call("GET", `${A}/{annotation_id}`, { project_id: "projB", annotation_id: some.id }, { key: otherKey, ext: true })).status).toBe(404);
    expect((await call("DELETE", `${A}/{annotation_id}`, { project_id: "projB", annotation_id: some.id }, { key: otherKey, ext: true })).status).toBe(404);
  });
});

describe("chart share links", () => {
  const S = "/v2/projects/{project_id}/chart_shares";
  it("make a public snapshot of the view: page, PNG and SVG without a session, numbers only; revoke stops it at once", async () => {
    const dev = await member("dev-share@example.com", "developer");
    const view = { range: "custom", start: "2026-05-01", end: "2026-08-31", res: "month", segment: "country", type: "stacked_column" };
    const made = await call("POST", S, {}, { cookie: dev.cookie, ext: true, json: { chart_name: "revenue", view } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ object: "chart_share", chart_name: "revenue", title: "Revenue", start_date: "2026-05-01", end_date: "2026-08-31", view, created_by: { email: "dev-share@example.com" }, revoked_at: null });
    expect(made.body.id).toMatch(/^cs_[A-Za-z0-9_-]{32}$/);
    expect(made.body.url).toMatch(new RegExp(`/share/charts/${made.body.id}$`));
    expect(made.body.image_url).toBe(`${made.body.url}/og.png`);
    const path = `/share/charts/${made.body.id}`;

    const page = await h.fetch(path, { key: "" });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    const html = await page.text();
    expect(html).toContain("<h1>Revenue</h1>");
    expect(html).toContain("United States");
    expect(html).toContain("By country");
    expect(html).toContain("$95.02");
    expect(html).toContain(`property="og:image" content="`);
    expect(html).not.toMatch(/<script/i);
    for (const id of ["u_a", "u_b", "u_d", "u_e", "u_g", "u_p"]) expect(html, id).not.toContain(id);
    const custIds = (await h.db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.projectId, "proj1"))).map((x) => x.id);
    for (const id of custIds) expect(html).not.toContain(id);

    const png = await h.fetch(`${path}/og.png`, { key: "" });
    expect(png.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await png.arrayBuffer()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const svg = await h.fetch(`${path}/chart.svg`, { key: "" });
    expect(svg.headers.get("content-type")).toMatch(/image\/svg\+xml/);
    expect(await svg.text()).toContain("Revenue");
    const etag = page.headers.get("etag")!;
    expect((await h.fetch(path, { key: "", headers: { "if-none-match": etag } })).status).toBe(304);

    const list = await call("GET", S, {}, { ext: true, query: "chart_name=revenue" });
    expect(list.body.items.map((x: any) => x.id)).toContain(made.body.id);

    // A Viewer sees the links but cannot make or revoke one.
    const viewer = await member("viewer-share@example.com", "viewer");
    expect((await call("GET", S, {}, { cookie: viewer.cookie, ext: true })).body.items.length).toBeGreaterThan(0);
    expect((await call("POST", S, {}, { cookie: viewer.cookie, ext: true, json: { chart_name: "mrr" } })).status).toBe(403);
    expect((await call("DELETE", `${S}/{share_id}`, { share_id: made.body.id }, { cookie: viewer.cookie, ext: true })).status).toBe(403);

    const revoked = await call("DELETE", `${S}/{share_id}`, { share_id: made.body.id }, { cookie: dev.cookie, ext: true });
    expect(revoked.body).toMatchObject({ object: "chart_share", id: made.body.id });
    expect((await h.fetch(path, { key: "" })).status).toBe(410);
    expect((await h.fetch(path, { key: "", headers: { "if-none-match": etag } })).status).toBe(410);
    expect((await h.fetch(`${path}/og.png`, { key: "" })).status).toBe(410);
    expect((await call("GET", S, {}, { ext: true })).body.items.map((x: any) => x.id)).not.toContain(made.body.id);
    expect((await call("DELETE", `${S}/{share_id}`, { share_id: made.body.id }, { ext: true })).status).toBe(404);
    expect((await h.fetch("/share/charts/cs_nope", { key: "" })).status).toBe(404);

    const log = await call("GET", "/v2/projects/{project_id}/audit_logs", {}, { query: "limit=100" });
    expect(log.body.items.filter((x: any) => x.target_type === "chart_share").map((x: any) => x.action_type).sort()).toEqual(["chart_share_created", "chart_share_deleted"]);
  });

  it("snapshots cohort tables and the chart type; refuses a view the chart API refuses", async () => {
    const cohort = await call("POST", S, {}, { ext: true, json: { chart_name: "subscription_retention", view: { range: "custom", start: "2026-05-01", end: "2026-08-31" } } });
    expect(cohort.status).toBe(201);
    const html = await (await h.fetch(`/share/charts/${cohort.body.id}`, { key: "" })).text();
    expect(html).toContain("Subscription Retention");
    expect(html).toContain("Period 0");
    const [row] = await h.db.select().from(schema.chartShares).where(eq(schema.chartShares.id, cohort.body.id));
    expect((row!.snapshot as any).type).toBe("cohort");
    // A stacked type on one series draws as its unstacked twin.
    const mrr = await call("POST", S, {}, { ext: true, json: { chart_name: "mrr", view: { type: "stacked_area" } } });
    const [m] = await h.db.select().from(schema.chartShares).where(eq(schema.chartShares.id, mrr.body.id));
    expect((m!.snapshot as any)).toMatchObject({ type: "line", series: [{ label: "MRR" }] });
    const bad = await call("POST", S, {}, { ext: true, json: { chart_name: "mrr", view: { segment: "paywall" } } });
    expect(bad.status).toBe(400);
    expect(bad.body.param).toBe("view.segment");
    expect((await call("POST", S, {}, { ext: true, json: { chart_name: "nope" } })).status).toBe(400);
    expect((await call("POST", S, {}, { ext: true, json: { chart_name: "mrr", view: { type: "pie" } } })).status).toBe(400);
  });
});
