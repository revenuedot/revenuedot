import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { publicOrigin } from "../oauth.js";
import { appleApiFor } from "../../stores/apple/index.js";
import { messageProblems, messagingOf, retentionOffersOf, syncMessaging, type MessagingConfig, type OfferRow } from "../../services/retention.js";
import { V2Error, body, listOf, notFound, paramError, scope, type V2Router } from "./common.js";

/** Retention (RevenueDot extension; prd/lifecycle/PRD.md): Customer Center offers and Apple Retention Messaging per app. */

const OfferIn = z.object({
  trigger: z.enum(["cancel", "refund"]), name: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(120), subtitle: z.string().max(300).default(""),
  store: z.enum(["app_store", "play_store"]), product_mapping: z.record(z.string().min(1).max(200), z.string().trim().min(1).max(200)).refine((m) => Object.keys(m).length > 0, "link at least one product"),
  active: z.boolean().default(true),
}).strict();
const OfferUpdate = OfferIn.partial().strict();

const MessageIn = z.object({
  id: z.string(), kind: z.enum(["text", "switch_plan", "promotional_offer"]), header: z.string(), body: z.string(),
  alternate_product_id: z.string().nullable().optional(), promotional_offer_id: z.string().nullable().optional(),
}).strict();
const MessagingIn = z.object({
  enabled: z.boolean().optional(),
  messages: z.array(MessageIn).max(200).optional(),
  defaults: z.array(z.object({ product_id: z.string().min(1), locale: z.string().regex(/^[a-z]{2,3}([-_][A-Za-z0-9]{2,4})*$/, "a locale such as en-US"), message_id: z.string() }).strict()).max(500).optional(),
  rules: z.array(z.object({ product_id: z.string().nullable(), message_id: z.string() }).strict()).max(100).optional(),
}).strict();

const offerShape = (o: OfferRow) => ({
  object: "retention_offer" as const, id: o.id, trigger: o.trigger, name: o.name, title: o.title, subtitle: o.subtitle, store: o.store,
  product_mapping: o.productMapping, active: o.active, created_at: o.createdAt.getTime(), updated_at: o.updatedAt ? o.updatedAt.getTime() : null,
});

export function retentionRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id";

  r.get(`${P}/retention_offers`, scope("project_configuration:projects:read"), async (c) =>
    c.json(listOf(c, (await retentionOffersOf(db, c.get("projectId"))).map(offerShape), null)));
  r.post(`${P}/retention_offers`, scope("project_configuration:projects:read_write"), async (c) => {
    const b = await body(c, OfferIn);
    const [o] = await db.insert(schema.retentionOffers).values({
      id: newId("rto_", 12), projectId: c.get("projectId"), trigger: b.trigger, name: b.name, title: b.title, subtitle: b.subtitle, store: b.store,
      productMapping: b.product_mapping, active: b.active, createdAt: deps.now(),
    }).returning();
    return c.json(offerShape(o!), 201);
  });
  const findOffer = async (projectId: string, id: string) => {
    const [o] = await db.select().from(schema.retentionOffers).where(and(eq(schema.retentionOffers.projectId, projectId), eq(schema.retentionOffers.id, id))).limit(1);
    if (!o) throw notFound("Retention offer");
    return o;
  };
  r.post(`${P}/retention_offers/:offer_id`, scope("project_configuration:projects:read_write"), async (c) => {
    const o = await findOffer(c.get("projectId"), c.req.param("offer_id"));
    const b = await body(c, OfferUpdate);
    const [u] = await db.update(schema.retentionOffers).set({
      ...(b.trigger ? { trigger: b.trigger } : {}), ...(b.name ? { name: b.name } : {}), ...(b.title ? { title: b.title } : {}), ...(b.subtitle !== undefined ? { subtitle: b.subtitle } : {}),
      ...(b.store ? { store: b.store } : {}), ...(b.product_mapping ? { productMapping: b.product_mapping } : {}), ...(b.active !== undefined ? { active: b.active } : {}), updatedAt: deps.now(),
    }).where(eq(schema.retentionOffers.id, o.id)).returning();
    return c.json(offerShape(u!));
  });
  r.delete(`${P}/retention_offers/:offer_id`, scope("project_configuration:projects:read_write"), async (c) => {
    const o = await findOffer(c.get("projectId"), c.req.param("offer_id"));
    await db.delete(schema.retentionOffers).where(eq(schema.retentionOffers.id, o.id));
    return c.json({ object: "retention_offer", id: o.id, deleted_at: deps.now().getTime() });
  });

  // ---------- Apple Retention Messaging ----------
  const A = "/v2/projects/:project_id/apps/:app_id/retention_messaging";
  const appleApp = async (projectId: string, appId: string) => {
    const [a] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, appId))).limit(1);
    if (!a) throw notFound("App");
    if (a.type !== "app_store" && a.type !== "mac_app_store") throw paramError("Apple's Retention Messaging API is for App Store apps.", "app_id");
    return a;
  };
  const shape = (a: typeof schema.apps.$inferSelect, origin: string) => ({
    object: "retention_messaging" as const, app_id: a.id, ...messagingOf(a),
    realtime_url: `${deps.publicUrl ?? origin}/v1/retention/apple/${a.id}`,
    app_apple_id: (a.credentials?.app_apple_id as string | undefined) ?? null,
    has_in_app_purchase_key: !!(a.credentials?.subscription_private_key || a.credentials?.private_key),
  });
  r.get(A, scope("project_configuration:apps:read"), async (c) => c.json(shape(await appleApp(c.get("projectId"), c.req.param("app_id")), publicOrigin(c))));
  r.post(A, scope("project_configuration:apps:read_write"), async (c) => {
    const a = await appleApp(c.get("projectId"), c.req.param("app_id"));
    const b = await body(c, MessagingIn);
    const cur = messagingOf(a);
    const next: MessagingConfig = { ...cur, ...(b.enabled !== undefined ? { enabled: b.enabled } : {}) };
    if (b.messages) {
      next.messages = b.messages.map((m, i) => {
        const problem = messageProblems(m);
        if (problem) throw paramError(`messages.${i}: ${problem}`, `messages.${i}`);
        const old = cur.messages.find((x) => x.id === m.id);
        // Apple keeps an uploaded message as it was: a changed text needs a new id.
        if (old?.uploaded?.length && (old.header !== m.header || old.body !== m.body || old.kind !== m.kind)) throw paramError(`messages.${i}: this message is already uploaded to Apple and cannot change. Add a new message instead.`, `messages.${i}`);
        return { ...m, uploaded: old?.uploaded ?? [], error: old?.error ?? null };
      });
      if (new Set(next.messages.map((m) => m.id)).size !== next.messages.length) throw paramError("messages: ids must be unique.", "messages");
    }
    if (b.defaults) next.defaults = b.defaults.map((d) => ({ ...d, configured: cur.defaults.find((x) => x.product_id === d.product_id && x.locale === d.locale && x.message_id === d.message_id)?.configured ?? [] }));
    if (b.rules) next.rules = b.rules;
    const ids = new Set(next.messages.map((m) => m.id));
    // Apple keeps one default message per product and locale.
    const pairs = next.defaults.map((d) => `${d.product_id}\u0000${d.locale.toLowerCase().replace("_", "-")}`);
    if (new Set(pairs).size !== pairs.length) throw paramError("defaults: one default message per product and locale.", "defaults");
    for (const [i, d] of next.defaults.entries()) {
      const m = next.messages.find((x) => x.id === d.message_id);
      if (!m) throw paramError(`defaults.${i}.message_id: no such message.`, `defaults.${i}.message_id`);
      if (m.kind !== "text") throw paramError(`defaults.${i}: default messages must be text messages (Apple's rule).`, `defaults.${i}`);
    }
    for (const [i, x] of next.rules.entries()) if (!ids.has(x.message_id)) throw paramError(`rules.${i}.message_id: no such message.`, `rules.${i}.message_id`);
    await db.update(schema.apps).set({ retentionMessaging: next as unknown as Record<string, unknown> }).where(eq(schema.apps.id, a.id));
    return c.json(shape({ ...a, retentionMessaging: next as unknown as Record<string, unknown> }, publicOrigin(c)));
  });
  r.post(`${A}/actions/sync`, scope("project_configuration:apps:read_write"), async (c) => {
    const a = await appleApp(c.get("projectId"), c.req.param("app_id"));
    const b = await body(c, z.object({ environment: z.enum(["sandbox", "production"]).default("sandbox") }).strict());
    let api;
    try { api = appleApiFor(deps.stores, a, deps.fetch, deps.now); } catch (e) { throw new V2Error(422, "store_error", e instanceof Error ? e.message : String(e)); }
    if (!api) throw new V2Error(422, "unprocessable_entity_error", "Add the app's App Store In-App Purchase key first: the Retention Messaging API uses it.");
    const res = await syncMessaging(db, a, api, b.environment, `${deps.publicUrl ?? publicOrigin(c)}/v1/retention/apple/${a.id}`, deps.now());
    return c.json({ ...shape({ ...a, retentionMessaging: res.config as unknown as Record<string, unknown> }, publicOrigin(c)), sync: { environment: b.environment, errors: res.errors } });
  });
}
