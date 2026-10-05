import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { fieldSupported, OPERATORS, rulesMatch, type Rules } from "../../services/targeting.js";
import { exactCount } from "../../services/customer-counts.js";
import { firstMatches } from "../../services/customer-scan.js";
import { V2Error, body, embeddedList, expands, listOf, notFound, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";

/** Audiences (RevenueCat's v2 shape) and targeting rules (RevenueDot extension). Experiments: ./experiments.ts. */

export const Cond = z.object({ field: z.string().min(1).max(200), operator: z.string(), value: z.string().max(5000).optional(), currency: z.string().optional() }).strict();
export const RulesIn = z.object({ groups: z.array(z.object({ conditions: z.array(Cond).max(50) }).strict()).max(20) }).strict();
const AudienceIn = z.object({ name: z.string().min(1).max(256), rules: RulesIn }).strict();
const AudienceUpdate = z.object({ name: z.string().min(1).max(256).optional(), rules: RulesIn.optional() }).strict();
const Preview = z.union([z.object({ audience_uuid: z.string().min(1) }).strict(), z.object({ rules: RulesIn }).strict()]);
const RuleIn = z.object({
  name: z.string().min(1).max(256), audience_id: z.string().nullable().optional(), offering_id: z.string().min(1),
  placements: z.record(z.string().min(1).max(100), z.string().nullable()).optional(), state: z.enum(["active", "inactive"]).optional(),
  starts_at: z.number().int().nullable().optional(), ends_at: z.number().int().nullable().optional(),
}).strict();
const RuleUpdate = RuleIn.partial().strict();
const Order = z.object({ rule_ids: z.array(z.string()).min(1) }).strict();

export function targetingRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const A = "/v2/projects/:project_id/audiences";

  const checkRules = (rules: Rules) => {
    for (const [gi, g] of rules.groups.entries()) for (const [ci, c] of g.conditions.entries()) {
      const at = `rules.groups.${gi}.conditions.${ci}`;
      if (!fieldSupported(c.field)) throw paramError(`${at}.field: ${c.field} is not supported by this server.`, `${at}.field`);
      if (!OPERATORS.has(c.operator)) throw paramError(`${at}.operator: unknown operator ${c.operator}.`, `${at}.operator`);
    }
  };
  const findAudience = async (projectId: string, id: string) => {
    const [a] = await db.select().from(schema.audiences).where(and(eq(schema.audiences.projectId, projectId), eq(schema.audiences.id, id))).limit(1);
    if (!a) throw notFound("Audience");
    return a;
  };

  /** The audience's exact counts over the whole project (services/customer-counts.ts) and its 10 most recently seen members. */
  const preview = async (projectId: string, rules: Rules) => {
    const now = deps.now();
    const t = now.getTime();
    const [counts, sample] = await Promise.all([
      exactCount(db, projectId, "audience", { rules }, now, deps.countInlineLimit),
      firstMatches(db, projectId, now, {}, (m) => rulesMatch(m.ctx, rules, t), 10),
    ]);
    return {
      // RevenueCat's stats shape has no room for more fields: while a large project's first count runs (services/customer-counts.ts)
      // the totals are 0 and `is_approximate` is true; otherwise they are exact.
      stats: { ...counts.result, currency: "USD", is_approximate: counts.counting },
      customer_sample: sample.map(({ data: { customer: cu }, ctx }) => ({ cu, ctx })).map((m) => ({
        object: "audience_member" as const, app_user_id: m.cu.originalAppUserId, app_uuid: m.cu.id, email: m.ctx.attributes.$email ?? null,
        first_seen_at: m.cu.firstSeen.getTime(), last_seen_at: m.cu.lastSeen.getTime(), status: m.ctx.status, total_spent: m.ctx.totalSpent, currency: "USD", latest_product_name: m.ctx.latestProduct,
      })),
    };
  };
  const usedBy = async (id: string) => {
    const rules = await db.select().from(schema.targetingRules).where(eq(schema.targetingRules.audienceId, id));
    const exps = await db.select().from(schema.experiments).where(eq(schema.experiments.audienceId, id));
    return {
      object: "audience_used_by" as const,
      targeting_rules: rules.map((x) => ({ object: "targeting_rule_reference" as const, id: x.id, display_name: x.name, state: x.state as "active" | "inactive" })),
      experiments: exps.map((x) => ({ object: "experiment_reference" as const, id: x.id, display_name: x.name, status: x.status as "draft" | "running" | "paused" | "stopped" })),
    };
  };
  const audienceShape = async (a: typeof schema.audiences.$inferSelect, ex: Set<string> = new Set()) => {
    const p = ex.has("stats") || ex.has("customer_sample") ? await preview(a.projectId, a.rules as Rules) : null;
    return {
      object: "audience" as const, id: a.id, project_id: a.projectId, customer_list_id: `cl${a.id.slice(3)}`, name: a.name, rules: a.rules,
      created_at: a.createdAt.getTime(), updated_at: a.updatedAt ? a.updatedAt.getTime() : null,
      ...(ex.has("stats") ? { stats: p!.stats } : {}), ...(ex.has("customer_sample") ? { customer_sample: p!.customer_sample } : {}),
      ...(ex.has("used_by") ? { used_by: await usedBy(a.id) } : {}),
    };
  };

  r.get(A, scope("audiences:audiences:read"), async (c) => {
    const rows = await db.select().from(schema.audiences).where(eq(schema.audiences.projectId, c.get("projectId"))).orderBy(asc(schema.audiences.createdAt));
    return c.json(listOf(c, await Promise.all(rows.map((a) => audienceShape(a))), null));
  });
  r.post(A, scope("audiences:audiences:read_write"), async (c) => {
    const b = await body(c, AudienceIn);
    checkRules(b.rules);
    const [a] = await db.insert(schema.audiences).values({ id: newId("aud", 12), projectId: c.get("projectId"), name: b.name, rules: b.rules, createdAt: deps.now() }).returning();
    return c.json(await audienceShape(a!), 201);
  });
  r.post(`${A}/actions/preview`, scope("audiences:audiences:read"), async (c) => {
    const b = await body(c, Preview);
    const rules = "rules" in b ? b.rules : (await findAudience(c.get("projectId"), b.audience_uuid)).rules as Rules;
    checkRules(rules);
    return c.json({ object: "audience_preview", ...(await preview(c.get("projectId"), rules)) });
  });
  r.get(`${A}/filter_options`, scope("audiences:audiences:read"), async (c) => {
    const projectId = c.get("projectId");
    const want = (c.req.queries("fields") ?? []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
    const ATTR: Record<string, string> = { mediaSource: "$mediaSource", campaign: "$campaign", adGroup: "$adGroup", ad: "$ad", keyword: "$keyword", creative: "$creative" };
    const ATTR_COLUMN: Record<string, string> = { mediaSource: "media_source", campaign: "campaign", adGroup: "ad_group", ad: "ad", keyword: "keyword", creative: "creative" };
    const fields = want.length ? want : Object.keys(ATTR);
    const items = [];
    for (const f of fields) {
      const key = ATTR[f] ?? (/^customAttribute:[a-zA-Z][a-zA-Z0-9_-]*$/.test(f) ? f.slice(16) : null);
      if (f === "latestProduct") {
        const prods = await db.select().from(schema.products).where(eq(schema.products.projectId, projectId));
        items.push({ object: "audience_filter_field_options", field: f, options: prods.map((p) => ({ object: "audience_filter_option", id: p.id, display_name: p.displayName ?? p.storeIdentifier })) });
        continue;
      }
      if (!key) throw paramError(`fields: ${f} has no options.`, "fields");
      // Attribution fields read the first-class rows, so Apple Search Ads campaigns are offered by name.
      const col = ATTR_COLUMN[f];
      const rows = col
        ? await db.execute(sql`select distinct ${sql.raw(col)} as value from customer_attribution where project_id = ${projectId} and ${sql.raw(col)} is not null order by 1 limit 201`)
        : await db.execute(sql`select distinct a.value from customer_attributes a join customers c on c.id = a.customer_id where c.project_id = ${projectId} and a.key = ${key} and a.value is not null limit 201`);
      const values = (rows as unknown as { rows?: { value: string }[] }).rows ?? (rows as unknown as { value: string }[]);
      items.push({
        object: "audience_filter_field_options", field: f, options: values.slice(0, 200).map((v) => ({ object: "audience_filter_option", id: v.value, display_name: v.value })),
        ...(key !== ATTR[f] ? { cardinality_exceeded: values.length > 200 } : {}),
      });
    }
    return c.json(listOf(c, items, null));
  });
  r.get(`${A}/:audience_id`, scope("audiences:audiences:read"), async (c) => c.json(await audienceShape(await findAudience(c.get("projectId"), c.req.param("audience_id")!), expands(c))));
  r.post(`${A}/:audience_id`, scope("audiences:audiences:read_write"), async (c) => {
    const a = await findAudience(c.get("projectId"), c.req.param("audience_id")!);
    const b = await body(c, AudienceUpdate);
    if (!b.name && !b.rules) throw paramError("Send name, rules or both.");
    if (b.rules) checkRules(b.rules);
    const [out] = await db.update(schema.audiences).set({ ...(b.name ? { name: b.name } : {}), ...(b.rules ? { rules: b.rules } : {}), updatedAt: deps.now() }).where(eq(schema.audiences.id, a.id)).returning();
    return c.json(await audienceShape(out!));
  });
  // RevenueDot extension: delete an audience that no rule or experiment uses.
  r.delete(`${A}/:audience_id`, scope("audiences:audiences:read_write"), async (c) => {
    const a = await findAudience(c.get("projectId"), c.req.param("audience_id")!);
    const u = await usedBy(a.id);
    if (u.targeting_rules.length || u.experiments.length) throw new V2Error(409, "resource_already_exists", "The audience is used by a targeting rule or an experiment. Remove it there first.");
    const [campaign] = await db.select({ name: schema.winbackCampaigns.name }).from(schema.winbackCampaigns)
      .where(and(eq(schema.winbackCampaigns.projectId, a.projectId), sql`${schema.winbackCampaigns.audience}->>'audience_id' = ${a.id}`)).limit(1);
    if (campaign) throw new V2Error(409, "resource_already_exists", `The audience is used by the win-back campaign "${campaign.name}". Remove it there first.`);
    await db.delete(schema.audiences).where(eq(schema.audiences.id, a.id));
    return c.json({ object: "audience", id: a.id, deleted_at: deps.now().getTime() });
  });

  // ---- Targeting rules (extension) ----
  const T = "/v2/projects/:project_id/targeting_rules";
  const checkOffering = async (projectId: string, id: string, param: string) => {
    const [o] = await db.select({ id: schema.offerings.id }).from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.id, id))).limit(1);
    if (!o) throw paramError(`${param}: no such offering in this project.`, param);
  };
  const checkRefs = async (projectId: string, b: { audience_id?: string | null; offering_id?: string; placements?: Record<string, string | null> }) => {
    if (b.audience_id) await findAudience(projectId, b.audience_id);
    if (b.offering_id) await checkOffering(projectId, b.offering_id, "offering_id");
    for (const [p, o] of Object.entries(b.placements ?? {})) if (o) await checkOffering(projectId, o, `placements.${p}`);
  };
  const ruleShape = (x: typeof schema.targetingRules.$inferSelect) => ({
    object: "targeting_rule" as const, id: x.id, project_id: x.projectId, name: x.name, audience_id: x.audienceId, offering_id: x.offeringId, placements: x.placements,
    position: x.position, state: x.state, starts_at: x.startsAt?.getTime() ?? null, ends_at: x.endsAt?.getTime() ?? null, revision: x.revision, created_at: x.createdAt.getTime(),
  });
  const findRule = async (c: V2Context) => {
    const [x] = await db.select().from(schema.targetingRules).where(and(eq(schema.targetingRules.projectId, c.get("projectId")), eq(schema.targetingRules.id, c.req.param("rule_id")!))).limit(1);
    if (!x) throw notFound("Targeting rule");
    return x;
  };
  const date = (v: number | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

  r.get(T, scope("project_configuration:offerings:read"), async (c) => {
    const rows = await db.select().from(schema.targetingRules).where(eq(schema.targetingRules.projectId, c.get("projectId"))).orderBy(asc(schema.targetingRules.position));
    return c.json(listOf(c, rows.map(ruleShape), null));
  });
  r.post(T, scope("project_configuration:offerings:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, RuleIn);
    await checkRefs(projectId, b);
    const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`coalesce(max(${schema.targetingRules.position}), -1)::int + 1` }).from(schema.targetingRules).where(eq(schema.targetingRules.projectId, projectId));
    const [x] = await db.insert(schema.targetingRules).values({
      id: newId("trgt", 12), projectId, name: b.name, audienceId: b.audience_id ?? null, offeringId: b.offering_id, placements: b.placements ?? {}, position: n,
      state: b.state ?? "inactive", startsAt: date(b.starts_at) ?? null, endsAt: date(b.ends_at) ?? null, createdAt: deps.now(),
    }).returning();
    return c.json(ruleShape(x!), 201);
  });
  r.get(`${T}/:rule_id`, scope("project_configuration:offerings:read"), async (c) => c.json(ruleShape(await findRule(c))));
  r.post(`${T}/:rule_id`, scope("project_configuration:offerings:read_write"), async (c) => {
    const x = await findRule(c);
    const b = await body(c, RuleUpdate);
    await checkRefs(x.projectId, b);
    const [out] = await db.update(schema.targetingRules).set({
      ...(b.name !== undefined ? { name: b.name } : {}), ...(b.audience_id !== undefined ? { audienceId: b.audience_id } : {}), ...(b.offering_id !== undefined ? { offeringId: b.offering_id } : {}),
      ...(b.placements !== undefined ? { placements: b.placements } : {}), ...(b.state !== undefined ? { state: b.state } : {}),
      ...(b.starts_at !== undefined ? { startsAt: date(b.starts_at) } : {}), ...(b.ends_at !== undefined ? { endsAt: date(b.ends_at) } : {}), revision: x.revision + 1,
    }).where(eq(schema.targetingRules.id, x.id)).returning();
    return c.json(ruleShape(out!));
  });
  r.delete(`${T}/:rule_id`, scope("project_configuration:offerings:read_write"), async (c) => {
    const x = await findRule(c);
    await db.delete(schema.targetingRules).where(eq(schema.targetingRules.id, x.id));
    return c.json({ object: "targeting_rule", id: x.id, deleted_at: deps.now().getTime() });
  });
  r.post(`${T}/actions/reorder`, scope("project_configuration:offerings:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, Order);
    const rows = await db.select().from(schema.targetingRules).where(eq(schema.targetingRules.projectId, projectId));
    if (b.rule_ids.length !== rows.length || !rows.every((x) => b.rule_ids.includes(x.id))) throw paramError("rule_ids must list every targeting rule of the project once.", "rule_ids");
    // One transaction: an order half written would match customers by a mix of the old and the new positions.
    await db.transaction(async (raw) => {
      const tx = raw as unknown as typeof db;
      for (const [i, id] of b.rule_ids.entries()) await tx.update(schema.targetingRules).set({ position: i }).where(eq(schema.targetingRules.id, id));
    });
    const out = await db.select().from(schema.targetingRules).where(eq(schema.targetingRules.projectId, projectId)).orderBy(asc(schema.targetingRules.position));
    return c.json(listOf(c, out.map(ruleShape), null, `/v2/projects/${projectId}/targeting_rules`));
  });
}
