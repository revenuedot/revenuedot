import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { HISTORY_METRICS, metricHistory, type HistoryMetric, type MetricHistory } from "../../services/metric-history.js";
import { gateOn, pausedMessage, projectGate } from "../../services/billing/gate.js";
import { projectsForUser } from "../../services/sessions.js";
import { METRICS, overviewValues, type OverviewValues } from "./metrics.js";
import { V2Error, allows, listOf, pageParams, paramError, round2, type V2Context, type V2Router } from "./common.js";
import { userProjectPrincipal } from "./project-access.js";

/**
 * Overview across projects (RevenueDot extension; RevenueCat's Overview "All projects" chip). Not in RevenueCat's API.
 *   GET /v2/overview?environment=&days=&project_ids=a,b               the six Overview cards summed over projects
 *   GET /v2/overview/transactions?environment=&limit=&starting_after=&project_ids=   transactions of those projects, newest first
 * Dashboard sessions only. Each of the user's projects is checked like a project route (membership, role, an enterprise
 * extension's custom role or enforced single sign-on): a project counts only where the user may read the Overview
 * (`charts_metrics:overview:read`) or the transactions (`customer_information:purchases:read`). `projects` in the
 * answer lists every project the user belongs to with `included` and, when left out, why. `project_ids` narrows the
 * set; ids the user cannot open are ignored, so ids cannot be probed.
 */

const MONEY = new Set<HistoryMetric>(["mrr", "revenue"]);

/** Sums overview values; money is rounded to cents. */
export function sumOverview(list: OverviewValues[]): OverviewValues {
  const out: OverviewValues = { active_trials: 0, active_subscriptions: 0, mrr: 0, revenue: 0, new_customers: 0, active_users: 0 };
  for (const v of list) for (const k of HISTORY_METRICS) out[k] += v[k];
  out.mrr = round2(out.mrr); out.revenue = round2(out.revenue);
  return out;
}

/**
 * Sums one metric's histories: values per date, the previous value only when every project has one, and no daily
 * series when any project has none (Active customers has no daily history).
 */
export function sumHistories(metric: HistoryMetric, list: MetricHistory[]): MetricHistory {
  const fix = (n: number) => (MONEY.has(metric) ? round2(n) : n);
  if (!list.length) return { metric, value: 0, previous_value: null, values: null };
  const value = fix(list.reduce((a, h) => a + h.value, 0));
  const previous_value = list.every((h) => h.previous_value !== null) ? fix(list.reduce((a, h) => a + h.previous_value!, 0)) : null;
  let values: MetricHistory["values"] = null;
  if (list.every((h) => h.values)) {
    const byDate = new Map<string, number>();
    for (const h of list) for (const p of h.values!) byDate.set(p.date, (byDate.get(p.date) ?? 0) + p.value);
    values = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, v]) => ({ date, value: fix(v) }));
  }
  return { metric, value, previous_value, values };
}

type Scope = "charts_metrics:overview:read" | "customer_information:purchases:read";
interface ProjectAccess { id: string; name: string; included: boolean; reason?: string }

/** The user's projects with whether each may be read for `need`, narrowed by `?project_ids=`. */
async function accessibleProjects(deps: Deps, c: V2Context, need: Scope): Promise<ProjectAccess[]> {
  const p = c.get("principal");
  if (p.kind !== "user") throw new V2Error(403, "authorization_error", "The account overview needs a dashboard session. API keys belong to one project: use /v2/projects/{project_id}/metrics/overview.");
  if (p.via === "assistant") throw new V2Error(403, "authorization_error", "RevenueDot AI works in one project at a time.");
  const wanted = (c.req.queries("project_ids") ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
  if (wanted.length > 100) throw paramError("project_ids takes at most 100 ids.", "project_ids");
  const mine = (await projectsForUser(deps.db, p.userId))
    .filter((x) => !wanted.length || wanted.includes(x.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  const out: ProjectAccess[] = [];
  for (const x of mine) {
    try {
      const principal = await userProjectPrincipal(deps, c, p, x.id);
      if (!allows(principal, need)) { out.push({ id: x.id, name: x.name, included: false, reason: "Your role in this project does not include this data." }); continue; }
      // Cloud's go-live gate (services/billing/gate.ts): a paused project's live numbers stay out of the totals.
      if (gateOn(deps) && (c.req.query("environment") || "production") === "production") {
        const g = await projectGate(deps.db, x.id, deps.now(), true);
        if (g.stage === "paused") { out.push({ id: x.id, name: x.name, included: false, reason: pausedMessage(g.owner, p.userId) }); continue; }
      }
      out.push({ id: x.id, name: x.name, included: true });
    } catch (e) {
      // 404: the membership is gone or an extension closed the project to this person (deprovisioned): the project route
      // would answer "Project not found", which reads oddly next to a project listed by name.
      if (!(e instanceof V2Error)) console.error(`account overview: project ${x.id} could not be checked`, e);
      const reason = !(e instanceof V2Error) ? "This project cannot be opened right now." : e.status === 404 ? "You no longer have access to this project." : e.message;
      out.push({ id: x.id, name: x.name, included: false, reason });
    }
  }
  return out;
}

/** `fn` over `items`, at most `n` at a time (each project's Overview is seven queries; many projects must not open them all at once). */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

const envOf = (c: V2Context) => {
  const env = c.req.query("environment") || "production";
  if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
  return env;
};

export function accountOverviewRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;

  r.get("/v2/overview", async (c) => {
    const env = envOf(c);
    const days = c.req.query("days") === undefined ? 28 : Number(c.req.query("days"));
    if (!Number.isInteger(days) || days < 1 || days > 366) throw paramError("days must be a whole number from 1 to 366.", "days");
    const currency = c.req.query("currency") ?? "USD";
    if (currency !== "USD") throw paramError("Only USD is supported for now.", "currency");
    const projects = await accessibleProjects(deps, c, "charts_metrics:overview:read");
    const ids = projects.filter((x) => x.included).map((x) => x.id);
    const now = deps.now();
    const per = await mapLimit(ids, 4, async (id) => ({
      values: await overviewValues(db, id, now, env),
      history: await Promise.all(HISTORY_METRICS.map((m) => metricHistory(db, id, now, m, days, env))),
    }));
    const total = sumOverview(per.map((x) => x.values));
    return c.json({
      object: "account_overview", currency: "USD", environment: env, days, projects,
      metrics: METRICS.map((m) => {
        const h = sumHistories(m.id, per.map((x) => x.history[HISTORY_METRICS.indexOf(m.id)]!));
        return {
          object: "overview_metric", ...m, value: total[m.id],
          history: { object: "metric_history", days, resolution: "day", value: h.value, previous_value: h.previous_value, values: h.values },
          last_updated_at: now.getTime(),
        };
      }),
      last_updated_at: now.getTime(),
    });
  });

  r.get("/v2/overview/transactions", async (c) => {
    const env = envOf(c);
    const { limit, startingAfter } = pageParams(c);
    const projects = await accessibleProjects(deps, c, "customer_information:purchases:read");
    const ids = projects.filter((x) => x.included).map((x) => x.id);
    if (!ids.length) return c.json({ ...listOf(c, [], null), projects });
    const T = schema.transactions;
    const conds = [inArray(T.projectId, ids), eq(T.isSandbox, env === "sandbox")];
    if (startingAfter) {
      const [cur] = await db.select().from(T).where(and(inArray(T.projectId, ids), eq(T.id, startingAfter))).limit(1);
      if (!cur) throw paramError("starting_after does not match a transaction in these projects.", "starting_after");
      conds.push(sql`(${T.purchasedAt}, ${T.id}) < (${cur.purchasedAt.toISOString()}::timestamptz, ${cur.id})`);
    }
    const rows = await db.select({ t: T, appUserId: schema.customers.originalAppUserId }).from(T).innerJoin(schema.customers, eq(schema.customers.id, T.customerId))
      .where(and(...conds)).orderBy(desc(T.purchasedAt), desc(T.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({
      ...listOf(c, page.map(({ t, appUserId }) => ({
        object: "transaction", id: t.id, project_id: t.projectId, customer_id: appUserId, app_id: t.appId, store: t.store, store_transaction_id: t.storeTransactionId,
        product_identifier: t.productIdentifier, kind: t.kind, environment: t.isSandbox ? "sandbox" : "production",
        purchased_at: t.purchasedAt.getTime(), expires_at: t.expiresAt ? t.expiresAt.getTime() : null, revenue_in_usd: t.revenueUsd,
        price: t.priceAmount !== null && t.priceCurrency ? { amount: t.priceAmount, currency: t.priceCurrency } : null, country: t.countryCode,
      })), rows.length > limit ? page[page.length - 1]!.t.id : null),
      projects,
    });
  });
}
