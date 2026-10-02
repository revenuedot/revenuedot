import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  computeExperimentResults, dailyCsv, EXPERIMENT_METRICS, EXPERIMENT_TYPE_IDS, METRIC_IDS, newId, PLACEMENT_ID, PRIMARY_METRIC_IDS, summaryCsv, TYPE_DEFAULTS,
  VARIANT_IDS, variantDefaultName, variantSignature, type ChartLifecycle, type ExperimentType, type TxKind,
} from "@revenuedot/core";
import { schema, type ExperimentVariant } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { contextsFor } from "../../services/customer-context.js";
import { fieldSupported, OPERATORS, rulesMatch, variantsOf, type Rules } from "../../services/targeting.js";
import { V2Error, body, embeddedList, listOf, notFound, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { RulesIn } from "./targeting.js";

/**
 * Offering experiments (RevenueDot extension, prd/experiments/PRD.md): up to four variants with placements, enrollment
 * modes, saved or inline audiences, priority order, results with intervals, CSV and a live audience estimate.
 */

const READ = "project_configuration:offerings:read";
const WRITE = "project_configuration:offerings:read_write";
const PAYWALL_VIEW_TYPES = ["paywall_impression", "custom_paywall_impression"];

const VariantIn = z.object({
  id: z.enum(VARIANT_IDS).optional(), name: z.string().trim().min(1).max(100).optional(), offering_id: z.string().min(1),
  placements: z.record(z.string(), z.string().min(1).nullable()).optional(),
}).strict();
const Fields = {
  name: z.string().trim().min(1).max(256),
  type: z.enum(EXPERIMENT_TYPE_IDS),
  primary_metric: z.enum(PRIMARY_METRIC_IDS as [string, ...string[]]),
  secondary_metrics: z.array(z.enum(METRIC_IDS as [string, ...string[]])).max(12),
  notes: z.string().max(20_000),
  enrollment: z.enum(["new", "new_and_existing"]),
  track_paywall_views: z.boolean(),
  audience_id: z.string().min(1).nullable(),
  audience_rules: RulesIn.nullable(),
  enrollment_percent: z.number().int().min(1).max(100),
  variants: z.array(VariantIn).min(2).max(4),
  offering_a: z.string().min(1),
  offering_b: z.string().min(1),
};
const ExperimentIn = z.object({ ...Fields, name: Fields.name }).partial().required({ name: true }).strict();
const ExperimentUpdate = z.object(Fields).partial().strict();
/** Fields that may change while an experiment runs, is paused or has stopped. */
const LIVE_EDITABLE = new Set(["name", "type", "primary_metric", "secondary_metrics", "notes", "enrollment_percent"]);
const Reorder = z.object({ experiment_ids: z.array(z.string().min(1)).min(1).max(500) }).strict();
const Estimate = z.object({
  audience_id: z.string().min(1).nullable().optional(), audience_rules: RulesIn.nullable().optional(), enrollment: z.enum(["new", "new_and_existing"]).optional(),
  enrollment_percent: z.number().int().min(1).max(100).optional(), variant_count: z.number().int().min(2).max(4).optional(),
}).strict();

type Row = typeof schema.experiments.$inferSelect;
const CHUNK = 500;
const ESTIMATE_LIMIT = 5000;
const DAY = 86_400_000;

export function experimentRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const E = "/v2/projects/:project_id/experiments";

  const find = async (c: V2Context) => {
    const [x] = await db.select().from(schema.experiments).where(and(eq(schema.experiments.projectId, c.get("projectId")), eq(schema.experiments.id, c.req.param("experiment_id")!))).limit(1);
    if (!x) throw notFound("Experiment");
    return x;
  };
  const checkRules = (rules: Rules, at: string) => {
    for (const [gi, g] of rules.groups.entries()) for (const [ci, cnd] of g.conditions.entries()) {
      const p = `${at}.groups.${gi}.conditions.${ci}`;
      if (!fieldSupported(cnd.field)) throw paramError(`${p}.field: ${cnd.field} is not supported by this server.`, `${p}.field`);
      if (!OPERATORS.has(cnd.operator)) throw paramError(`${p}.operator: unknown operator ${cnd.operator}.`, `${p}.operator`);
    }
  };
  /** The project's offerings that can be served: archived ones are not in the SDK's offerings list. */
  const offeringIds = async (projectId: string) => new Set((await db.select({ id: schema.offerings.id }).from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.state, "active")))).map((o) => o.id));
  const checkAudience = async (projectId: string, id: string) => {
    const [a] = await db.select({ id: schema.audiences.id }).from(schema.audiences).where(and(eq(schema.audiences.projectId, projectId), eq(schema.audiences.id, id))).limit(1);
    if (!a) throw paramError("audience_id: no such audience in this project.", "audience_id");
  };

  /** Variants from the request: ids by position (a, b, c, d), default names, placements and offerings checked. */
  const buildVariants = async (projectId: string, input: z.infer<typeof VariantIn>[]): Promise<ExperimentVariant[]> => {
    const known = await offeringIds(projectId);
    const out = input.map((v, i) => {
      const id = VARIANT_IDS[i]!;
      if (v.id && v.id !== id) throw paramError(`variants.${i}.id: variant ${i + 1} is "${id}" (control a, then b, c, d).`, `variants.${i}.id`);
      if (!known.has(v.offering_id)) throw paramError(`variants.${i}.offering_id: no such offering in this project, or it is archived.`, `variants.${i}.offering_id`);
      for (const [p, o] of Object.entries(v.placements ?? {})) {
        if (!PLACEMENT_ID.test(p)) throw paramError(`variants.${i}.placements: "${p}" is not a placement id (letters, digits, dots, dashes or underscores, up to 100).`, `variants.${i}.placements`);
        if (o && !known.has(o)) throw paramError(`variants.${i}.placements.${p}: no such offering in this project, or it is archived.`, `variants.${i}.placements.${p}`);
      }
      return { id, name: v.name ?? variantDefaultName(id), offering_id: v.offering_id, placements: v.placements ?? {} };
    });
    const seen = new Map<string, number>();
    out.forEach((v, i) => {
      const sig = variantSignature(v);
      if (seen.has(sig)) throw paramError(`variants.${i}: ${v.name} serves the same offering and placements as ${out[seen.get(sig)!]!.name}. Change its offering or a placement.`, `variants.${i}`);
      seen.set(sig, i);
    });
    return out;
  };

  const counts = async (ids: string[]) => {
    const rows = ids.length ? await db.select({ id: schema.experimentEnrollments.experimentId, n: sql<number>`count(*)::int` }).from(schema.experimentEnrollments)
      .where(inArray(schema.experimentEnrollments.experimentId, ids)).groupBy(schema.experimentEnrollments.experimentId) : [];
    return new Map(rows.map((x) => [x.id, Number(x.n)]));
  };
  const shape = (x: Row, enrolled?: number) => ({
    object: "experiment" as const, id: x.id, project_id: x.projectId, name: x.name, type: x.type, status: x.status, primary_metric: x.primaryMetric,
    secondary_metrics: x.secondaryMetrics, notes: x.notes, enrollment: x.enrollment, track_paywall_views: x.trackPaywallViews, audience_id: x.audienceId,
    audience_rules: x.audienceRules ?? null, enrollment_percent: x.enrollmentPercent, priority: x.priority, variants: variantsOf(x),
    started_at: x.startedAt?.getTime() ?? null, paused_at: x.pausedAt?.getTime() ?? null, stopped_at: x.stoppedAt?.getTime() ?? null,
    created_at: x.createdAt.getTime(), updated_at: x.updatedAt?.getTime() ?? null, ...(enrolled !== undefined ? { enrolled_customers: enrolled } : {}),
  });
  const one = async (x: Row) => shape(x, (await counts([x.id])).get(x.id) ?? 0);

  /** Defaults, cross-field rules and references for a create or a draft update. */
  const settle = async (projectId: string, b: Partial<z.infer<typeof ExperimentUpdate>>, current: Row | null) => {
    if (b.variants && (b.offering_a || b.offering_b)) throw paramError("Send variants, or offering_a and offering_b, not both.", "variants");
    if (b.audience_id && b.audience_rules) throw paramError("Send a saved audience (audience_id) or conditions (audience_rules), not both.", "audience_rules");
    if (b.audience_id) await checkAudience(projectId, b.audience_id);
    if (b.audience_rules) checkRules(b.audience_rules, "audience_rules");
    let variants: ExperimentVariant[] | undefined;
    if (b.variants) variants = await buildVariants(projectId, b.variants);
    else if (b.offering_a || b.offering_b) {
      const was = current ? variantsOf(current) : [];
      const a = b.offering_a ?? was[0]?.offering_id, bb = b.offering_b ?? was[1]?.offering_id;
      if (!a || !bb) throw paramError("Send variants (2 to 4), or both offering_a and offering_b.", "variants");
      variants = await buildVariants(projectId, [{ offering_id: a, name: was[0]?.name, placements: was[0]?.placements }, { offering_id: bb, name: was[1]?.name, placements: was[1]?.placements }, ...was.slice(2).map((v) => ({ offering_id: v.offering_id, name: v.name, placements: v.placements }))]);
    }
    const enrollment = b.enrollment ?? current?.enrollment ?? "new";
    let track = b.track_paywall_views ?? current?.trackPaywallViews ?? false;
    // Enrolling existing customers needs paywall tracking (results can then count viewers from their first view). It is
    // turned on when the request asks for new and existing customers; rows migrated from A/B tests keep their setting.
    if (enrollment === "new_and_existing" && (b.enrollment === "new_and_existing" || b.track_paywall_views === false)) {
      if (b.track_paywall_views === false) throw paramError("Experiments that enroll existing customers need paywall view tracking, so results can count customers from their first paywall view.", "track_paywall_views");
      track = true;
    }
    return { variants, enrollment, track };
  };

  r.get(E, scope(READ), async (c) => {
    const rows = await db.select().from(schema.experiments).where(eq(schema.experiments.projectId, c.get("projectId")));
    const n = await counts(rows.map((x) => x.id));
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), (x) => shape(x, n.get(x.id) ?? 0)));
  });

  r.post(E, scope(WRITE), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, ExperimentIn);
    if (!b.variants && !(b.offering_a && b.offering_b)) throw paramError("Send variants (a control and 1 to 3 treatments), or offering_a and offering_b.", "variants");
    const { variants, enrollment, track } = await settle(projectId, b, null);
    const type = (b.type ?? "other") as ExperimentType;
    const [{ p } = { p: 0 }] = await db.select({ p: sql<number>`coalesce(max(${schema.experiments.priority}), 0)::int` }).from(schema.experiments).where(eq(schema.experiments.projectId, projectId));
    const now = deps.now();
    const [x] = await db.insert(schema.experiments).values({
      id: newId("prexp", 10), projectId, name: b.name, type, primaryMetric: b.primary_metric ?? TYPE_DEFAULTS[type].primary,
      secondaryMetrics: b.secondary_metrics ?? TYPE_DEFAULTS[type].secondary, notes: b.notes ?? "", enrollment, trackPaywallViews: track,
      audienceId: b.audience_id ?? null, audienceRules: b.audience_rules ?? null, enrollmentPercent: b.enrollment_percent ?? 100, variants: variants!,
      offeringA: variants![0]!.offering_id, offeringB: variants![1]!.offering_id, priority: Number(p) + 1, createdAt: now,
    }).returning();
    return c.json(shape(x!, 0), 201);
  });

  r.post(`${E}/actions/reorder`, scope(WRITE), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, Reorder);
    const rows = await db.select().from(schema.experiments).where(eq(schema.experiments.projectId, projectId));
    const open = rows.filter((x) => x.status !== "stopped");
    if (new Set(b.experiment_ids).size !== b.experiment_ids.length || b.experiment_ids.length !== open.length || !open.every((x) => b.experiment_ids.includes(x.id))) {
      throw paramError("experiment_ids must list every draft, running and paused experiment of the project once.", "experiment_ids");
    }
    const stopped = rows.filter((x) => x.status === "stopped").sort((a, z2) => a.priority - z2.priority || a.createdAt.getTime() - z2.createdAt.getTime());
    const order = [...b.experiment_ids, ...stopped.map((x) => x.id)];
    for (const [i, id] of order.entries()) await db.update(schema.experiments).set({ priority: i + 1 }).where(and(eq(schema.experiments.projectId, projectId), eq(schema.experiments.id, id)));
    const out = (await db.select().from(schema.experiments).where(eq(schema.experiments.projectId, projectId)).orderBy(asc(schema.experiments.priority)));
    const n = await counts(out.map((x) => x.id));
    return c.json(listOf(c, out.map((x) => shape(x, n.get(x.id) ?? 0)), null, `/v2/projects/${projectId}/experiments`));
  });

  // Matching customers in the last 7 days: first seen (new customers) or seen (new and existing), up to 5,000 checked.
  // Audience conditions can name one customer (an email, an app user id), so the estimate needs the audience read scope.
  r.post(`${E}/actions/estimate`, scope(READ, "audiences:audiences:read"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, Estimate);
    if (b.audience_id && b.audience_rules) throw paramError("Send a saved audience (audience_id) or conditions (audience_rules), not both.", "audience_rules");
    let rules: Rules | null = b.audience_rules ?? null;
    if (b.audience_id) {
      const [a] = await db.select().from(schema.audiences).where(and(eq(schema.audiences.projectId, projectId), eq(schema.audiences.id, b.audience_id))).limit(1);
      if (!a) throw paramError("audience_id: no such audience in this project.", "audience_id");
      rules = a.rules as Rules;
    }
    if (rules) checkRules(rules, "audience_rules");
    const now = deps.now();
    const since = new Date(now.getTime() - 7 * DAY);
    const C = schema.customers;
    const col = b.enrollment === "new_and_existing" ? C.lastSeen : C.firstSeen;
    const rows = await db.select().from(C).where(and(eq(C.projectId, projectId), gte(col, since))).orderBy(desc(col), desc(C.id)).limit(ESTIMATE_LIMIT + 1);
    const approximate = rows.length > ESTIMATE_LIMIT;
    const sample = rows.slice(0, ESTIMATE_LIMIT);
    let matching = sample.length;
    if (rules && sample.length) {
      const ctxs = await contextsFor(db, projectId, sample, now);
      matching = ctxs.filter((m) => rulesMatch(m.ctx, rules!, now.getTime())).length;
    }
    if (approximate) {
      const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(C).where(and(eq(C.projectId, projectId), gte(col, since)));
      matching = Math.round((matching / ESTIMATE_LIMIT) * Number(n));
    }
    const enrolled = Math.round((matching * (b.enrollment_percent ?? 100)) / 100);
    return c.json({
      object: "experiment_estimate", period_days: 7, matching_customers: matching, enrolled_customers: enrolled,
      customers_per_variant: Math.floor(enrolled / (b.variant_count ?? 2)), is_approximate: approximate,
    });
  });

  r.get(`${E}/:experiment_id`, scope(READ), async (c) => c.json(await one(await find(c))));

  r.post(`${E}/:experiment_id`, scope(WRITE), async (c) => {
    const x = await find(c);
    const b = await body(c, ExperimentUpdate);
    if (x.status !== "draft") {
      const locked = Object.keys(b).filter((k) => !LIVE_EDITABLE.has(k));
      if (locked.length) throw new V2Error(422, "unprocessable_entity_error", `Variants, enrollment, paywall tracking and audience can only change while the experiment is a draft (${locked.join(", ")}).`, locked[0]);
    }
    const { variants, enrollment, track } = await settle(x.projectId, b, x);
    const audienceChange = b.audience_id !== undefined || b.audience_rules !== undefined;
    const [out] = await db.update(schema.experiments).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.type !== undefined ? { type: b.type } : {}), ...(b.primary_metric !== undefined ? { primaryMetric: b.primary_metric } : {}),
      ...(b.secondary_metrics !== undefined ? { secondaryMetrics: b.secondary_metrics } : {}), ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.enrollment_percent !== undefined ? { enrollmentPercent: b.enrollment_percent } : {}),
      ...(x.status === "draft" ? { enrollment, trackPaywallViews: track } : {}),
      // A saved audience and inline conditions exclude each other: setting one clears the other.
      ...(audienceChange ? { audienceId: b.audience_id ?? null, audienceRules: b.audience_id ? null : b.audience_rules ?? null } : {}),
      ...(variants ? { variants, offeringA: variants[0]!.offering_id, offeringB: variants[1]!.offering_id } : {}),
      updatedAt: deps.now(),
    }).where(eq(schema.experiments.id, x.id)).returning();
    return c.json(await one(out!));
  });

  r.delete(`${E}/:experiment_id`, scope(WRITE), async (c) => {
    const x = await find(c);
    if (x.status === "running") throw new V2Error(422, "unprocessable_entity_error", "Stop the experiment before deleting it.");
    await db.delete(schema.experiments).where(eq(schema.experiments.id, x.id));
    return c.json({ object: "experiment", id: x.id, deleted_at: deps.now().getTime() });
  });

  const transition = (action: "start" | "pause" | "stop", from: string[], to: string) => async (c: V2Context) => {
    const x = await find(c);
    if (!from.includes(x.status)) throw new V2Error(422, "unprocessable_entity_error", `A ${x.status} experiment cannot ${action}.${x.status === "stopped" ? " A stopped experiment cannot run again: duplicate it instead." : ""}`);
    if (action === "start") {
      const vs = variantsOf(x);
      const known = await offeringIds(x.projectId);
      const missing = vs.flatMap((v) => [v.offering_id, ...Object.values(v.placements)].filter((o): o is string => !!o && !known.has(o)));
      if (vs.length < 2 || missing.length) throw new V2Error(422, "unprocessable_entity_error", missing.length ? "An offering of this experiment was deleted or archived. Pick another offering in each variant first." : "An experiment needs a control and at least one treatment.");
    }
    const now = deps.now();
    const [out] = await db.update(schema.experiments).set({
      status: to, updatedAt: now,
      ...(action === "start" && !x.startedAt ? { startedAt: now } : {}), ...(action === "start" ? { pausedAt: null } : {}),
      ...(action === "pause" ? { pausedAt: now } : {}), ...(action === "stop" ? { stoppedAt: now } : {}),
    }).where(eq(schema.experiments.id, x.id)).returning();
    return c.json(await one(out!));
  };
  r.post(`${E}/:experiment_id/actions/start`, scope(WRITE), transition("start", ["draft", "paused"], "running"));
  r.post(`${E}/:experiment_id/actions/pause`, scope(WRITE), transition("pause", ["running"], "paused"));
  r.post(`${E}/:experiment_id/actions/stop`, scope(WRITE), transition("stop", ["running", "paused"], "stopped"));

  /** Results of one experiment for one environment and filters (prd/experiments/PRD.md §4). */
  const results = async (c: V2Context, x: Row) => {
    const env = c.req.query("environment") ?? "production";
    if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
    const paywall = c.req.query("paywall") ?? (x.trackPaywallViews ? "viewed" : "all");
    if (paywall !== "all" && paywall !== "viewed" && paywall !== "not_viewed") throw paramError("paywall must be all, viewed or not_viewed.", "paywall");
    const platform = c.req.query("platform")?.trim() || null, country = c.req.query("country")?.trim() || null;
    const sandbox = env === "sandbox";
    const now = deps.now();
    const enrolls = await db.select().from(schema.experimentEnrollments).where(eq(schema.experimentEnrollments.experimentId, x.id));
    const ids = enrolls.map((e) => e.customerId);
    const C = schema.customers, T = schema.transactions, S = schema.subscriptions, X = schema.sdkEvents, A = schema.customerAliases, EV = schema.events;
    const chunks = <T>(load: (part: string[]) => Promise<T[]>) => (async () => { const out: T[] = []; for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await load(ids.slice(i, i + CHUNK)))); return out; })();
    const [custs, txs, subs, products, views, billing] = await Promise.all([
      chunks((p) => db.select({ id: C.id, platform: C.lastSeenPlatform, country: C.lastSeenCountry }).from(C).where(inArray(C.id, p))),
      chunks((p) => db.select().from(T).where(and(inArray(T.customerId, p), eq(T.isSandbox, sandbox)))),
      chunks((p) => db.select().from(S).where(and(inArray(S.customerId, p), eq(S.isSandbox, sandbox)))),
      db.select().from(schema.products).where(eq(schema.products.projectId, x.projectId)),
      x.trackPaywallViews || c.req.query("paywall") ? chunks((p) => db.select({ customerId: sql<string | null>`coalesce(${X.customerId}, ${A.customerId})`, at: X.occurredAt }).from(X)
        .leftJoin(A, and(eq(A.projectId, X.projectId), eq(A.appUserId, X.appUserId)))
        .where(and(eq(X.projectId, x.projectId), eq(X.isSandbox, sandbox), inArray(X.type, PAYWALL_VIEW_TYPES), inArray(sql`coalesce(${X.customerId}, ${A.customerId})`, p)))) : Promise.resolve([]),
      chunks((p) => db.select({ customerId: EV.customerId, at: EV.eventTimestampMs, store: sql<string | null>`${EV.payload}->'event'->>'store'`, productId: sql<string | null>`${EV.payload}->'event'->>'product_id'` })
        .from(EV).where(and(inArray(EV.customerId, p), eq(EV.environment, env), eq(EV.type, "BILLING_ISSUE")))),
    ]);
    const lc = (s: string | null) => (s ?? "").toLowerCase();
    const keep = new Set(custs.filter((cu) => (!platform || lc(cu.platform) === platform.toLowerCase()) && (!country || lc(cu.country) === country.toLowerCase())).map((cu) => cu.id));
    const vs = variantsOf(x);
    const computed = computeExperimentResults({
      now: now.getTime(), variants: vs.map((v) => ({ id: v.id, name: v.name, offering_id: v.offering_id || null })), controlId: vs[0]!.id, primaryMetric: x.primaryMetric,
      enrollments: enrolls.filter((e) => keep.has(e.customerId)).map((e) => ({ customerId: e.customerId, variant: e.variant, enrolledAt: e.enrolledAt.getTime() })),
      txs: txs.filter((t) => keep.has(t.customerId)).map((t) => ({
        id: t.id, customerId: t.customerId, appId: t.appId, store: t.store, storeTransactionId: t.storeTransactionId, productId: t.productIdentifier, kind: t.kind as TxKind,
        at: t.purchasedAt.getTime(), expiresAt: t.expiresAt?.getTime() ?? null, usd: t.revenueUsd, country: t.countryCode,
      })),
      products: products.map((p) => ({ appId: p.appId, storeIdentifier: p.storeIdentifier, type: p.type, duration: p.duration })),
      subStates: subs.map((s) => ({
        customerId: s.customerId, store: s.store, appId: s.appId, productId: s.productIdentifier, expiresAt: s.expiresDate?.getTime() ?? null, autoRenew: !s.unsubscribeDetectedAt,
        billingIssue: !!s.billingIssuesDetectedAt, graceUntil: s.gracePeriodExpiresDate?.getTime() ?? null, familyShared: s.ownershipType === "FAMILY_SHARED", offering: s.presentedOfferingId,
        cancelSurveyReason: s.cancelSurveyReason, unsubscribeAt: s.unsubscribeDetectedAt?.getTime() ?? null,
      })),
      lifecycle: billing.filter((e) => e.customerId).map((e): ChartLifecycle => ({ customerId: e.customerId!, store: (e.store ?? "").toLowerCase(), productId: e.productId ?? "", type: "BILLING_ISSUE", at: Number(e.at) })),
      paywallViews: views.filter((v) => v.customerId).map((v) => ({ customerId: v.customerId!, at: v.at.getTime() })),
      paywall: paywall as "all" | "viewed" | "not_viewed",
      seriesFrom: x.startedAt?.getTime() ?? null,
    });
    const options = (k: "platform" | "country") => [...new Set(custs.map((cu) => cu[k]).filter((v): v is string => !!v))].sort();
    return { computed, env, paywall, platform, country, filterOptions: { platforms: options("platform"), countries: options("country") } };
  };

  r.get(`${E}/:experiment_id/results`, scope(READ), async (c) => {
    const x = await find(c);
    const { computed, env, paywall, platform, country, filterOptions } = await results(c, x);
    const url = `/v2/projects/${x.projectId}/experiments/${x.id}/results`;
    const val = (v: (typeof computed.variants)[number], id: string) => v.metrics[id]?.value ?? 0;
    const b = computed.variants[1];
    return c.json({
      object: "experiment_results", experiment_id: x.id, environment: env, currency: "USD", computed_at: deps.now().getTime(),
      primary_metric: x.primaryMetric, secondary_metrics: x.secondaryMetrics, control_variant_id: computed.variants[0]?.id ?? "a",
      filters: { platform, country, paywall }, filter_options: filterOptions,
      metrics: EXPERIMENT_METRICS.map((m) => ({ id: m.id, display_name: m.name, kind: m.kind, unit: m.unit, better: m.better, description: m.description })),
      variants: embeddedList(url, computed.variants.map((v) => ({
        ...v,
        // Fields of the first results release, kept for API clients.
        conversions: val(v, "initial_conversions"), conversion_rate: Math.round((val(v, "initial_conversion_rate") as number) * 10000) / 10000, trials: val(v, "trials_started"),
        paying_customers: val(v, "paid_customers"), revenue: Math.round((val(v, "realized_ltv") as number) * 100) / 100,
        revenue_per_customer: Math.round((val(v, "realized_ltv_per_customer") as number) * 100) / 100,
      }))),
      guidance: computed.guidance,
      series: computed.series,
      chance_b_beats_a: b?.metrics.initial_conversion_rate?.chance_to_beat_control ?? 0.5,
      enough_data: computed.guidance.enough_data,
    });
  });

  r.get(`${E}/:experiment_id/results/export`, scope(READ), async (c) => {
    const x = await find(c);
    const kind = c.req.query("kind") ?? "summary";
    if (kind !== "summary" && kind !== "daily") throw paramError("kind must be summary or daily.", "kind");
    const { computed, env } = await results(c, x);
    const day = deps.now().toISOString().slice(0, 10);
    return c.body(kind === "summary" ? summaryCsv(computed) : dailyCsv(computed), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="experiment-${x.id}-${kind}-${env}-${day}.csv"`,
    });
  });
}
