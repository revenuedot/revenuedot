import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { loadAdsOverview, type AdsRange } from "../../services/ads/overview.js";
import { recordReward, verificationShape } from "../../services/ads/rewards.js";
import { AdMobError, admobConfigured, admobRow, admobShape, disconnectAdMob, finishAdMobConnect, startAdMobConnect, syncAdMob } from "../../services/ads/admob.js";
import { depsSecretKey } from "../../services/secrets.js";
import { AppleAdsError, appleAdsReport, syncAppleAdsNames } from "../../services/ads/apple-ads.js";
import { periodDays } from "@revenuedot/core/ads";
import { publicOrigin } from "../oauth.js";
import { V2Error, body, listOf, notFound, pageParams, paramError, scope, type V2Router } from "./common.js";

/**
 * Ads (RevenueDot extension; prd/ads/PRD.md):
 *   GET    /v2/projects/{project_id}/ads/overview                         ad revenue, impressions, eCPM, breakdowns
 *   GET    /v2/projects/{project_id}/ads/reward_rules                     the ordered reward rules
 *   POST   /v2/projects/{project_id}/ads/reward_rules                     create
 *   POST   /v2/projects/{project_id}/ads/reward_rules/actions/reorder     { rule_ids } in the new order
 *   POST   /v2/projects/{project_id}/ads/reward_rules/{rule_id}           update
 *   DELETE /v2/projects/{project_id}/ads/reward_rules/{rule_id}
 *   GET    /v2/projects/{project_id}/ads/reward_verifications             the rewards ledger (?status=, ?app_user_id=)
 *   POST   /v2/projects/{project_id}/ads/reward_verifications/test        a test reward through the same grant path
 *   GET    /v2/projects/{project_id}/ads/admob                            AdMob connection and loaded ad units
 *   POST   /v2/projects/{project_id}/ads/admob/connect                    Google's authorization URL and the browser's nonce
 *   POST   /v2/projects/{project_id}/ads/admob/finish                     { code, state, nonce } from Google's redirect
 *   POST   /v2/projects/{project_id}/ads/admob/refresh                    reload ad units now
 *   DELETE /v2/projects/{project_id}/ads/admob                            disconnect
 *   GET    /v2/projects/{project_id}/ads/apple_search_ads/report             customers and revenue by campaign
 *   POST   /v2/projects/{project_id}/ads/apple_search_ads/sync               load campaign names from Apple
 */

const RANGES = ["7d", "28d", "90d", "12m"] as const;

const RuleIn = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  app_id: z.string().min(1).max(100).nullable().optional(),
  ad_unit_id: z.string().trim().max(200).nullable().optional(),
  reward_item: z.string().trim().max(200).nullable().optional(),
  kind: z.enum(["virtual_currency", "entitlement"]),
  currency_code: z.string().trim().max(100).nullable().optional(),
  amount: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  multiplier: z.number().positive().max(1_000_000).nullable().optional(),
  entitlement_id: z.string().trim().max(200).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(525_600).nullable().optional(),
}).strict();
const RuleUpdate = RuleIn.partial().strict();
const Reorder = z.object({ rule_ids: z.array(z.string().min(1)).max(200) }).strict();
const TestIn = z.object({
  app_user_id: z.string().trim().min(1).max(256), app_id: z.string().min(1).nullable().optional(), ad_unit_id: z.string().trim().max(200).nullable().optional(),
  reward_item: z.string().trim().max(200).nullable().optional(), reward_amount: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  client_transaction_id: z.string().trim().min(1).max(128).optional(),
}).strict();
const FinishIn = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(300), nonce: z.string().max(200) }).strict();
const ConnectIn = z.object({ client_id: z.string().trim().max(300).nullable().optional(), client_secret: z.string().trim().max(500).nullable().optional() }).strict();

type RuleRow = typeof schema.adRewardRules.$inferSelect;
const ruleShape = (x: RuleRow) => ({
  object: "ad_reward_rule" as const, id: x.id, name: x.name, enabled: x.enabled, position: x.position, app_id: x.appId, ad_unit_id: x.adUnitId, reward_item: x.rewardItem,
  kind: x.kind, currency_code: x.currencyCode, amount: x.amount, multiplier: x.multiplier, entitlement_id: x.entitlementId, duration_minutes: x.durationMinutes,
  created_at: x.createdAt.getTime(), updated_at: x.updatedAt ? x.updatedAt.getTime() : null,
});

export function adsRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/ads";
  const R = schema.adRewardRules;
  const V = schema.adRewardVerifications;

  r.get(`${P}/overview`, scope("charts_metrics:overview:read"), async (c) => {
    const range = (c.req.query("range") ?? "28d") as AdsRange;
    if (!RANGES.includes(range)) throw paramError(`range must be one of ${RANGES.join(", ")}.`, "range");
    const env = c.req.query("environment") ?? "production";
    if (env !== "production" && env !== "sandbox") throw paramError("environment must be production or sandbox.", "environment");
    const appId = c.req.query("app_id") || null;
    return c.json(await loadAdsOverview(db, { projectId: c.get("projectId"), range, sandbox: env === "sandbox", appId, now: deps.now(), fetch: deps.fetch ?? null }));
  });

  /** The merged rule must name what it grants, and that currency or entitlement must exist in the project. */
  const checkRule = async (projectId: string, x: { kind: string; currency_code?: string | null; amount?: number | null; multiplier?: number | null; entitlement_id?: string | null; duration_minutes?: number | null; app_id?: string | null }) => {
    if (x.app_id) {
      const [a] = await db.select({ id: schema.apps.id }).from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, x.app_id))).limit(1);
      if (!a) throw paramError("app_id: no such app in this project.", "app_id");
    }
    if (x.kind === "virtual_currency") {
      if (!x.currency_code) throw paramError("currency_code: choose the in-app currency to grant.", "currency_code");
      const [cur] = await db.select().from(schema.virtualCurrencies).where(and(eq(schema.virtualCurrencies.projectId, projectId), eq(schema.virtualCurrencies.code, x.currency_code))).limit(1);
      if (!cur) throw paramError(`currency_code: no in-app currency ${x.currency_code} in this project.`, "currency_code");
      if (!x.amount && !x.multiplier) throw paramError("amount: set a fixed amount, or a multiplier of the network's reward amount.", "amount");
    } else {
      if (!x.entitlement_id) throw paramError("entitlement_id: choose the entitlement to grant.", "entitlement_id");
      const [ent] = await db.select().from(schema.entitlements).where(and(eq(schema.entitlements.projectId, projectId), eq(schema.entitlements.lookupKey, x.entitlement_id))).limit(1);
      if (!ent) throw paramError(`entitlement_id: no entitlement ${x.entitlement_id} in this project.`, "entitlement_id");
      if (!x.duration_minutes) throw paramError("duration_minutes: how long the entitlement lasts, in minutes.", "duration_minutes");
    }
  };
  const columns = (b: z.infer<typeof RuleUpdate>) => ({
    ...(b.name !== undefined ? { name: b.name } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled } : {}), ...(b.app_id !== undefined ? { appId: b.app_id } : {}),
    ...(b.ad_unit_id !== undefined ? { adUnitId: b.ad_unit_id || null } : {}), ...(b.reward_item !== undefined ? { rewardItem: b.reward_item || null } : {}),
    ...(b.kind !== undefined ? { kind: b.kind } : {}), ...(b.currency_code !== undefined ? { currencyCode: b.currency_code || null } : {}),
    ...(b.amount !== undefined ? { amount: b.amount } : {}), ...(b.multiplier !== undefined ? { multiplier: b.multiplier } : {}),
    ...(b.entitlement_id !== undefined ? { entitlementId: b.entitlement_id || null } : {}), ...(b.duration_minutes !== undefined ? { durationMinutes: b.duration_minutes } : {}),
  });
  /** A rule grants one thing: switching kind clears the other kind's fields. */
  const exclusive = (row: Partial<RuleRow>) => (row.kind === "virtual_currency" ? { ...row, entitlementId: null, durationMinutes: null } : { ...row, currencyCode: null, amount: null, multiplier: null });

  r.get(`${P}/reward_rules`, scope("project_configuration:integrations:read"), async (c) => {
    const rows = await db.select().from(R).where(eq(R.projectId, c.get("projectId"))).orderBy(asc(R.position), asc(R.createdAt));
    return c.json(listOf(c, rows.map(ruleShape), null));
  });

  r.post(`${P}/reward_rules`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, RuleIn);
    await checkRule(projectId, b);
    const existing = await db.select({ p: R.position }).from(R).where(eq(R.projectId, projectId));
    if (existing.length >= 200) throw paramError("A project can have at most 200 reward rules.");
    const [row] = await db.insert(R).values(exclusive({ id: newId("adrr_", 14), projectId, position: existing.reduce((m, x) => Math.max(m, x.p + 1), 0), createdAt: deps.now(), enabled: true, ...columns(b) }) as typeof R.$inferInsert).returning();
    return c.json(ruleShape(row!), 201);
  });

  r.post(`${P}/reward_rules/actions/reorder`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, Reorder);
    const rows = await db.select().from(R).where(eq(R.projectId, projectId));
    const ids = new Set(rows.map((x) => x.id));
    if (b.rule_ids.length !== rows.length || new Set(b.rule_ids).size !== rows.length || b.rule_ids.some((id) => !ids.has(id))) {
      throw paramError("rule_ids: list every rule of the project exactly once.", "rule_ids");
    }
    for (const [i, id] of b.rule_ids.entries()) await db.update(R).set({ position: i, updatedAt: deps.now() }).where(and(eq(R.projectId, projectId), eq(R.id, id)));
    const out = await db.select().from(R).where(eq(R.projectId, projectId)).orderBy(asc(R.position));
    return c.json(listOf(c, out.map(ruleShape), null));
  });

  r.post(`${P}/reward_rules/:rule_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const [cur] = await db.select().from(R).where(and(eq(R.projectId, projectId), eq(R.id, c.req.param("rule_id")))).limit(1);
    if (!cur) throw notFound("Reward rule");
    const b = await body(c, RuleUpdate);
    const merged = { ...cur, ...columns(b) };
    const next = exclusive(merged) as RuleRow;
    await checkRule(projectId, { kind: next.kind, currency_code: next.currencyCode, amount: next.amount, multiplier: next.multiplier, entitlement_id: next.entitlementId, duration_minutes: next.durationMinutes, app_id: next.appId });
    const { id: _id, projectId: _p, createdAt: _c, ...set } = next;
    const [row] = await db.update(R).set({ ...set, updatedAt: deps.now() }).where(eq(R.id, cur.id)).returning();
    return c.json(ruleShape(row!));
  });

  r.delete(`${P}/reward_rules/:rule_id`, scope("project_configuration:integrations:read_write"), async (c) => {
    const rows = await db.delete(R).where(and(eq(R.projectId, c.get("projectId")), eq(R.id, c.req.param("rule_id")))).returning({ id: R.id });
    if (!rows.length) throw notFound("Reward rule");
    return c.json({ object: "ad_reward_rule", id: rows[0]!.id, deleted_at: deps.now().getTime() });
  });

  r.get(`${P}/reward_verifications`, scope("project_configuration:integrations:read"), async (c) => {
    const projectId = c.get("projectId");
    const status = c.req.query("status");
    if (status && !["verified", "failed", "pending"].includes(status)) throw paramError("status must be verified, failed or pending.", "status");
    const user = c.req.query("app_user_id");
    const { limit, startingAfter } = pageParams(c);
    let cursor: { at: Date; id: string } | null = null;
    if (startingAfter) {
      const [x] = await db.select().from(V).where(and(eq(V.projectId, projectId), eq(V.id, startingAfter))).limit(1);
      if (!x) throw paramError("starting_after does not match an object in this list.", "starting_after");
      cursor = { at: x.createdAt, id: x.id };
    }
    const rows = await db.select().from(V).where(and(eq(V.projectId, projectId), status ? eq(V.status, status === "pending" ? "granting" : status) : undefined, user ? eq(V.appUserId, user) : undefined,
      cursor ? or(lt(V.createdAt, cursor.at), and(eq(V.createdAt, cursor.at), lt(V.id, cursor.id))) : undefined))
      .orderBy(desc(V.createdAt), desc(V.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json(listOf(c, page.map(verificationShape), rows.length > limit ? page[page.length - 1]!.id : null));
  });

  // A test reward grants real currency or an entitlement to the customer, like a balance adjustment does.
  r.post(`${P}/reward_verifications/test`, scope("project_configuration:integrations:read_write", "customer_information:purchases:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, TestIn);
    let app: { id: string; type: string } | null = null;
    if (b.app_id) {
      const [a] = await db.select({ id: schema.apps.id, type: schema.apps.type }).from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, b.app_id))).limit(1);
      if (!a) throw paramError("app_id: no such app in this project.", "app_id");
      app = a;
    }
    const now = deps.now();
    const tx = b.client_transaction_id ?? crypto.randomUUID().toUpperCase();
    const { row } = await recordReward(db, {
      projectId, app, appUserId: b.app_user_id, clientTransactionId: tx, network: "test", networkTransactionId: `test_${projectId}_${tx}`, adUnitId: b.ad_unit_id ?? null,
      impressionId: null, rewardItem: b.reward_item ?? null, rewardAmount: b.reward_amount ?? null, occurredAt: now, isSandbox: true, now,
    }, deps.kick);
    return c.json(verificationShape(row), 201);
  });

  const admobDeps = async () => ({ db, fetch: deps.fetch ?? fetch, now: deps.now, secretKey: await depsSecretKey(deps), googleOAuth: deps.googleOAuth });
  const admobView = async (projectId: string, origin: string) => {
    const d = await admobDeps();
    const row = await admobRow(db, projectId);
    const units = await db.select().from(schema.adUnits).where(and(eq(schema.adUnits.projectId, projectId), eq(schema.adUnits.network, "admob"))).orderBy(asc(schema.adUnits.displayName));
    return { ...admobShape(row, await admobConfigured(d, row), units), redirect_uri: `${deps.apiUrl ?? origin}/v1/ads/admob/oauth/callback`, ssv_callback_url: `${deps.apiUrl ?? origin}/v1/ads/admob/ssv` };
  };

  r.get(`${P}/admob`, scope("project_configuration:integrations:read"), async (c) => c.json(await admobView(c.get("projectId"), publicOrigin(c))));

  r.post(`${P}/admob/connect`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, ConnectIn);
    if (b.client_id && !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(b.client_id)) throw paramError("client_id: a Google OAuth client ID ends in .apps.googleusercontent.com.", "client_id");
    const existing = await admobRow(db, projectId);
    if (b.client_id && !b.client_secret && !existing?.secretHints.client_secret) throw paramError("client_secret: enter the OAuth client's secret.", "client_secret");
    try {
      const { url, nonce } = await startAdMobConnect(await admobDeps(), {
        projectId, redirectUri: `${deps.apiUrl ?? publicOrigin(c)}/v1/ads/admob/oauth/callback`,
        ...(b.client_id !== undefined ? { clientId: b.client_id, clientSecret: b.client_secret ?? null } : {}),
      });
      return c.json({ object: "admob_authorization", url, nonce });
    } catch (e) {
      if (e instanceof AdMobError) throw new V2Error(e.code === "not_configured" ? 422 : 502, "invalid_request", e.message);
      throw e;
    }
  });

  r.post(`${P}/admob/finish`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, FinishIn);
    try {
      await finishAdMobConnect(await admobDeps(), { projectId, state: b.state, code: b.code, nonce: b.nonce });
    } catch (e) {
      if (e instanceof AdMobError) throw new V2Error(e.code === "state" ? 400 : e.code === "not_configured" ? 422 : 502, "invalid_request", e.message);
      throw e;
    }
    return c.json(await admobView(projectId, publicOrigin(c)));
  });

  r.post(`${P}/admob/refresh`, scope("project_configuration:integrations:read_write"), async (c) => {
    const projectId = c.get("projectId");
    try { await syncAdMob(await admobDeps(), projectId); } catch (e) {
      if (e instanceof AdMobError) throw new V2Error(e.code === "not_connected" ? 404 : 502, e.code === "not_connected" ? "resource_missing" : "invalid_request", e.message);
      throw e;
    }
    return c.json(await admobView(projectId, publicOrigin(c)));
  });

  r.delete(`${P}/admob`, scope("project_configuration:integrations:read_write"), async (c) => {
    await disconnectAdMob(db, c.get("projectId"));
    return c.json(await admobView(c.get("projectId"), publicOrigin(c)));
  });

  r.get(`${P}/apple_search_ads/report`, scope("charts_metrics:overview:read"), async (c) => {
    const range = (c.req.query("range") ?? "90d") as AdsRange;
    if (!RANGES.includes(range)) throw paramError(`range must be one of ${RANGES.join(", ")}.`, "range");
    const projectId = c.get("projectId");
    const { start, end } = periodDays(range, deps.now());
    const [conn] = await db.select().from(schema.integrations).where(and(eq(schema.integrations.projectId, projectId), eq(schema.integrations.kind, "apple_search_ads"))).limit(1);
    const s = (conn?.settings ?? {}) as Record<string, any>;
    return c.json({
      object: "apple_search_ads_report", range, start_date: start.toISOString().slice(0, 10), currency: "USD",
      campaigns: await appleAdsReport(db, projectId, start, end),
      names_loaded: Object.keys(s.names?.campaigns ?? {}).length, last_sync_at: s.last_sync_at ?? null, last_sync_error: s.last_sync_error ?? null,
    });
  });

  r.post(`${P}/apple_search_ads/sync`, scope("project_configuration:integrations:read_write"), async (c) => {
    try {
      const n = await syncAppleAdsNames({ db, fetch: deps.fetch ?? fetch, now: deps.now, secretKey: await depsSecretKey(deps) }, c.get("projectId"));
      return c.json({ object: "apple_search_ads_sync", campaigns: n });
    } catch (e) {
      if (e instanceof AppleAdsError) throw new V2Error(422, "invalid_request", e.message);
      throw e;
    }
  });
}
