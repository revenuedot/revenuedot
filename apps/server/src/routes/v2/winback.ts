import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { isEmailAddress, oneClickUnsubscribeHeaders, trySend } from "../../mail/index.js";
import { hit } from "../../services/rate-limit.js";
import { publicOrigin } from "../oauth.js";
import { DEFAULT_AUDIENCE, TEST_EMAIL_TOKEN, audienceOf, campaignStats, candidatesFor, emailOf, offerOf, recentSends, renderFor, runCampaign, type CampaignRow } from "../../services/winback.js";
import { V2Error, body, listOf, notFound, paramError, scope, type V2Router } from "./common.js";

/** Win-back campaigns (RevenueDot extension; prd/lifecycle/PRD.md). */

const AudienceIn = z.object({
  churned_min_days: z.number().int().min(0).max(730), churned_max_days: z.number().int().min(1).max(730),
  product_ids: z.array(z.string().min(1)).max(100).default([]), stores: z.array(z.string().min(1)).max(10).default([]), audience_id: z.string().nullable().default(null),
}).strict().refine((a) => a.churned_max_days > a.churned_min_days, { message: "churned_max_days must be more than churned_min_days", path: ["churned_max_days"] });
const EmailIn = z.object({
  subject: z.string().trim().min(1).max(150), heading: z.string().trim().min(1).max(150), body: z.string().trim().min(1).max(4000),
  button_label: z.string().trim().min(1).max(40), sender_name: z.string().trim().max(80).nullable().optional(),
}).strict();
const OfferIn = z.object({ type: z.enum(["store", "url"]), url: z.string().url().refine((u) => /^https:\/\//.test(u), "the offer link must be https").nullable().optional() }).strict()
  .refine((o) => o.type !== "url" || !!o.url, { message: "a URL offer needs url", path: ["url"] });
const CampaignIn = z.object({
  name: z.string().trim().min(1).max(120), status: z.enum(["draft", "active", "paused"]).default("draft"),
  audience: AudienceIn.optional(), email: EmailIn, offer: OfferIn, send_hour_utc: z.number().int().min(0).max(23).default(16), track_opens: z.boolean().default(false),
}).strict();
const CampaignUpdate = z.object({
  name: z.string().trim().min(1).max(120).optional(), status: z.enum(["draft", "active", "paused"]).optional(), audience: AudienceIn.optional(), email: EmailIn.optional(),
  offer: OfferIn.optional(), send_hour_utc: z.number().int().min(0).max(23).optional(), track_opens: z.boolean().optional(),
}).strict();

export function winbackRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/winback_campaigns";

  const shape = (c: CampaignRow, stats?: Record<string, number>) => {
    const { link_base: _base, ...email } = emailOf(c);
    void _base;
    return {
      object: "winback_campaign" as const, id: c.id, name: c.name, status: c.status, audience: audienceOf(c), email, offer: offerOf(c),
      send_hour_utc: c.sendHourUtc, track_opens: c.trackOpens, last_run_at: c.lastRunAt ? c.lastRunAt.getTime() : null,
      created_at: c.createdAt.getTime(), updated_at: c.updatedAt ? c.updatedAt.getTime() : null, ...(stats ? { stats } : {}),
    };
  };
  const find = async (projectId: string, id: string) => {
    const [c] = await db.select().from(schema.winbackCampaigns).where(and(eq(schema.winbackCampaigns.projectId, projectId), eq(schema.winbackCampaigns.id, id))).limit(1);
    if (!c) throw notFound("Win-back campaign");
    return c;
  };
  const checkAudience = async (projectId: string, a?: { audience_id: string | null }) => {
    if (!a?.audience_id) return;
    const [x] = await db.select().from(schema.audiences).where(and(eq(schema.audiences.projectId, projectId), eq(schema.audiences.id, a.audience_id))).limit(1);
    if (!x) throw paramError("audience.audience_id: no such audience in this project.", "audience.audience_id");
  };

  r.get(P, scope("project_configuration:projects:read"), async (c) => {
    const rows = await db.select().from(schema.winbackCampaigns).where(eq(schema.winbackCampaigns.projectId, c.get("projectId"))).orderBy(asc(schema.winbackCampaigns.createdAt));
    const stats = await campaignStats(db, rows.map((x) => x.id));
    return c.json(listOf(c, rows.map((x) => shape(x, stats.get(x.id))), null));
  });
  r.post(P, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, CampaignIn);
    await checkAudience(projectId, b.audience);
    const [row] = await db.insert(schema.winbackCampaigns).values({
      id: newId("wbc_", 12), projectId, name: b.name, status: b.status, audience: (b.audience ?? DEFAULT_AUDIENCE) as unknown as Record<string, unknown>,
      email: { ...b.email, link_base: deps.publicUrl ?? publicOrigin(c) }, offer: b.offer, sendHourUtc: b.send_hour_utc, trackOpens: b.track_opens, createdAt: deps.now(),
    }).returning();
    return c.json(shape(row!, (await campaignStats(db, [row!.id])).get(row!.id)), 201);
  });
  r.get(`${P}/:campaign_id`, scope("project_configuration:projects:read"), async (c) => {
    const row = await find(c.get("projectId"), c.req.param("campaign_id"));
    const sends = await recentSends(db, row.id);
    return c.json({
      ...shape(row, (await campaignStats(db, [row.id])).get(row.id)),
      recent_sends: sends.map((s) => ({ object: "winback_send", id: s.id, email: s.email, sent_at: s.sentAt.getTime(), opened_at: s.openedAt?.getTime() ?? null, clicked_at: s.clickedAt?.getTime() ?? null, unsubscribed_at: s.unsubscribedAt?.getTime() ?? null, error: s.error })),
    });
  });
  r.post(`${P}/:campaign_id`, scope("project_configuration:projects:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const row = await find(projectId, c.req.param("campaign_id"));
    const b = await body(c, CampaignUpdate);
    await checkAudience(projectId, b.audience);
    const [u] = await db.update(schema.winbackCampaigns).set({
      ...(b.name ? { name: b.name } : {}), ...(b.status ? { status: b.status } : {}), ...(b.audience ? { audience: b.audience as unknown as Record<string, unknown> } : {}),
      ...(b.email || b.status === "active" ? { email: { ...emailOf(row), ...(b.email ?? {}), link_base: deps.publicUrl ?? publicOrigin(c) } } : {}),
      ...(b.offer ? { offer: b.offer } : {}), ...(b.send_hour_utc !== undefined ? { sendHourUtc: b.send_hour_utc } : {}), ...(b.track_opens !== undefined ? { trackOpens: b.track_opens } : {}),
      updatedAt: deps.now(),
    }).where(eq(schema.winbackCampaigns.id, row.id)).returning();
    return c.json(shape(u!, (await campaignStats(db, [u!.id])).get(u!.id)));
  });
  r.delete(`${P}/:campaign_id`, scope("project_configuration:projects:read_write"), async (c) => {
    const row = await find(c.get("projectId"), c.req.param("campaign_id"));
    await db.delete(schema.winbackCampaigns).where(eq(schema.winbackCampaigns.id, row.id));
    return c.json({ object: "winback_campaign", id: row.id, deleted_at: deps.now().getTime() });
  });

  // Who would get the email if the campaign ran now (no email is sent).
  r.post(`${P}/:campaign_id/actions/preview`, scope("project_configuration:projects:read"), async (c) => {
    const row = await find(c.get("projectId"), c.req.param("campaign_id"));
    const { candidates, truncated } = await candidatesFor(db, row, deps.now());
    return c.json({
      object: "winback_preview", eligible: candidates.length, is_approximate: truncated,
      sample: candidates.slice(0, 10).map((x) => ({ app_user_id: x.appUserId, email: x.email, churned_at: x.churnedAt, product_id: x.productId, store: x.store })),
    });
  });
  r.post(`${P}/:campaign_id/actions/send_test`, scope("project_configuration:projects:read_write"), async (c) => {
    const row = await find(c.get("projectId"), c.req.param("campaign_id"));
    const b = await body(c, z.object({ email: z.string().refine(isEmailAddress, "a single email address") }).strict());
    // Test emails go to any address through the server's mailer: a few per hour per project.
    if (!(await hit(db, `winback-test:${row.projectId}`, 10, 3600_000, deps.now()))) throw new V2Error(429, "rate_limit_error", "Too many test emails. Try again in an hour.", undefined, true);
    const [project] = await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, row.projectId));
    const base = deps.publicUrl ?? publicOrigin(c);
    const offer = offerOf(row);
    const mail = renderFor(row, project?.name ?? "Your app", base, TEST_EMAIL_TOKEN, offer.type === "url" && offer.url ? offer.url : "https://apps.apple.com/account/subscriptions");
    // The same one-click headers as a real send, so the test shows what mail providers see.
    const ok = await trySend(deps.mailer, { to: b.email, ...mail, subject: `[Test] ${mail.subject}`, fromName: emailOf(row).sender_name?.trim() || project?.name || undefined, headers: oneClickUnsubscribeHeaders(`${base}/v1/winback/u/${TEST_EMAIL_TOKEN}`) });
    if (!ok) throw new V2Error(502, "server_error", "The mailer did not accept the test email. Check the server's mail settings.", undefined, true);
    return c.json({ object: "winback_test", sent_to: b.email });
  });
  r.post(`${P}/:campaign_id/actions/run`, scope("project_configuration:projects:read_write"), async (c) => {
    const row = await find(c.get("projectId"), c.req.param("campaign_id"));
    if (row.status !== "active") throw new V2Error(422, "unprocessable_entity_error", "Start the campaign before sending it.");
    const { sent, failed, skipped } = await runCampaign({ db, mailer: deps.mailer, now: deps.now }, row, deps.publicUrl ?? publicOrigin(c));
    await db.update(schema.winbackCampaigns).set({ lastRunAt: deps.now() }).where(eq(schema.winbackCampaigns.id, row.id));
    return c.json({ object: "winback_run", sent, failed, skipped });
  });
}
