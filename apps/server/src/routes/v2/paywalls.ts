import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema, type PaywallContent } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { b64decode, fontInfo, imageSize, md5Hex, newContent, fontKey, type PaywallRow } from "../../services/paywalls.js";
import { publicOrigin } from "../oauth.js";
import { V2Error, body, conflict, expands, ms, notFound, paginate, paramError, scope, type V2Context, type V2Router } from "./common.js";
import { offeringShape } from "./shapes.js";

/** Paywalls (components), their versions and publishing, and the media assets and fonts they use. */

const Components = z.record(z.unknown());
const Localizations = z.record(z.record(z.unknown()));
const Name = z.string().min(1).max(255);
const OfferingRef = z.string().min(1).max(200);
const CreateEmpty = z.object({ offering_id: OfferingRef, automatically_scale_font_size: z.boolean().optional() }).strict();
const CreateDraft = z.object({
  offering_id: OfferingRef.nullable().optional(), name: Name.nullable().optional(), components_config: Components, components_localizations: Localizations,
  default_locale: z.string().min(1).max(255).optional(), automatically_scale_font_size: z.boolean().optional(),
}).strict();
const Update = z.object({
  revision: z.number().int(), components_config: Components.optional(), components_localizations: Localizations.optional(), default_locale: z.string().min(1).max(255).optional(),
  offering_id: OfferingRef.nullable().optional(), name: Name.nullable().optional(), automatically_scale_font_size: z.boolean().optional(),
  exit_offers: z.record(z.unknown()).nullable().optional(), state_declarations: z.record(z.unknown()).nullable().optional(), play_store_product_change_mode: z.record(z.unknown()).nullable().optional(),
}).strict();
const Duplicate = z.object({
  name: Name.optional(), source_version: z.enum(["draft", "published"]).optional(),
  offering: z.object({ lookup_key: z.string().min(1).max(200), display_name: z.string().min(1).max(1500) }).strict().optional(),
}).strict();
const Attach = z.object({ offering_id: z.string().min(1).max(255) }).strict();
const NewVersion = z.object({ name: Name }).strict();
const MediaIn = z.object({
  filename: z.string().min(1).max(255), content_type: z.enum(["image/jpeg", "image/png", "image/avif", "image/heic", "image/heif", "image/webp"]), file_data_base64: z.string().min(1).max(2_796_204),
}).strict();
const FontIn = z.object({ filename: z.string().min(1).max(255), content_type: z.enum(["font/ttf", "font/otf"]), file_data_base64: z.string().min(1).max(6_990_508) }).strict();

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/avif": "avif", "image/heic": "heic", "image/heif": "heif", "image/webp": "webp", "font/ttf": "ttf", "font/otf": "otf" };

const versionShape = (c: PaywallContent) => ({
  revision: c.revision, components_config: c.components_config, default_locale: c.default_locale, components_localizations: c.components_localizations,
  automatically_scale_font_size: c.automatically_scale_font_size, state_declarations: c.state_declarations ?? null,
});

export function paywallRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/paywalls";

  const find = async (c: V2Context) => {
    const [row] = await db.select().from(schema.paywalls).where(and(eq(schema.paywalls.projectId, c.get("projectId")), eq(schema.paywalls.id, c.req.param("paywall_id")!))).limit(1);
    if (!row) throw notFound("Paywall");
    return row;
  };
  const offeringOf = async (projectId: string, ref: string) => {
    const [o] = await db.select().from(schema.offerings).where(and(eq(schema.offerings.projectId, projectId), eq(schema.offerings.id, ref))).limit(1);
    if (!o) throw notFound("Offering");
    const [taken] = await db.select({ id: schema.paywalls.id }).from(schema.paywalls).where(eq(schema.paywalls.offeringId, o.id)).limit(1);
    return { offering: o, taken: taken?.id ?? null };
  };

  /** Draft if there are unpublished changes, else null. A paywall that was never edited after publishing has `draft: null`. */
  const shape = async (c: V2Context, p: PaywallRow, ex: Set<string>) => {
    let offering: unknown = undefined;
    if (ex.has("offering") || ex.has("items.offering")) {
      if (p.offeringId) {
        const [o] = await db.select().from(schema.offerings).where(eq(schema.offerings.id, p.offeringId)).limit(1);
        offering = o ? offeringShape(o, undefined, p.id) : null;
      } else offering = null;
    }
    const base = {
      object: "paywall" as const, id: p.id, name: p.name, offering_id: p.offeringId, created_at: p.createdAt.getTime(), published_at: ms(p.publishedAt),
      automatically_scale_font_size: p.automaticallyScaleFontSize, revision: p.revision,
    };
    return {
      ...base,
      ...(offering !== undefined ? { offering } : {}),
      ...(ex.has("components") ? { components: { published: p.published ? versionShape(p.published) : null, draft: p.draft ? versionShape(p.draft) : null } } : {}),
    };
  };

  r.get(P, scope("project_configuration:offerings:read"), async (c) => {
    const rows = await db.select().from(schema.paywalls).where(eq(schema.paywalls.projectId, c.get("projectId")));
    const ex = expands(c);
    const page = paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), (x) => x);
    const items = await Promise.all(page.items.map((x) => shape(c, x as PaywallRow, ex)));
    return c.json({ ...page, items });
  });

  r.post(P, scope("project_configuration:offerings:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let offeringId: string | null = null;
    let content: PaywallContent;
    let name: string | null = null;
    let scale = true;
    if ("components_config" in raw) {
      const b = CreateDraft.safeParse(raw);
      if (!b.success) throw paramError(`${b.error.issues[0]!.path.join(".")}: ${b.error.issues[0]!.message}`, b.error.issues[0]!.path.join(".") || undefined);
      if (b.data.offering_id) { const { offering, taken } = await offeringOf(projectId, b.data.offering_id); if (taken) throw conflict("That offering already has a paywall.", "offering_id"); offeringId = offering.id; }
      name = b.data.name ?? null; scale = b.data.automatically_scale_font_size ?? true;
      content = newContent({ components_config: b.data.components_config, components_localizations: b.data.components_localizations, default_locale: b.data.default_locale ?? "en_US", automatically_scale_font_size: scale });
    } else {
      const b = CreateEmpty.safeParse(raw);
      if (!b.success) throw paramError(`${b.error.issues[0]!.path.join(".")}: ${b.error.issues[0]!.message}`, b.error.issues[0]!.path.join(".") || "offering_id");
      const { offering, taken } = await offeringOf(projectId, b.data.offering_id);
      if (taken) throw conflict("That offering already has a paywall.", "offering_id");
      offeringId = offering.id; scale = b.data.automatically_scale_font_size ?? true; name = offering.displayName;
      content = newContent({ automatically_scale_font_size: scale });
    }
    const [row] = await db.insert(schema.paywalls).values({
      id: newId("pw", 14), projectId, name, offeringId, automaticallyScaleFontSize: scale, revision: 1, draft: content, createdAt: deps.now(),
    }).returning();
    return c.json(await shape(c, row!, new Set()), 201);
  });

  r.get(`${P}/:paywall_id`, scope("project_configuration:offerings:read"), async (c) => c.json(await shape(c, await find(c), expands(c))));

  r.patch(`${P}/:paywall_id`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    const b = await body(c, Update);
    if (b.revision !== p.revision) throw conflict(`The paywall is at revision ${p.revision}, not ${b.revision}. Fetch it again and retry.`, "revision");
    // The draft starts from the published version when there are no unpublished changes.
    const base = p.draft ?? p.published ?? newContent();
    const next: PaywallContent = {
      ...base, revision: p.revision + 1,
      ...(b.components_config !== undefined ? { components_config: b.components_config } : {}),
      ...(b.components_localizations !== undefined ? { components_localizations: b.components_localizations } : {}),
      ...(b.default_locale !== undefined ? { default_locale: b.default_locale } : {}),
      ...(b.automatically_scale_font_size !== undefined ? { automatically_scale_font_size: b.automatically_scale_font_size } : {}),
      ...(b.exit_offers !== undefined ? { exit_offers: b.exit_offers } : {}),
      ...(b.state_declarations !== undefined ? { state_declarations: b.state_declarations } : {}),
      ...(b.play_store_product_change_mode !== undefined ? { play_store_product_change_mode: b.play_store_product_change_mode } : {}),
    };
    let offeringId = p.offeringId;
    if (b.offering_id !== undefined) {
      if (b.offering_id === null) offeringId = null;
      else { const { offering, taken } = await offeringOf(p.projectId, b.offering_id); if (taken && taken !== p.id) throw conflict("That offering already has a paywall.", "offering_id"); offeringId = offering.id; }
    }
    const [row] = await db.update(schema.paywalls).set({
      draft: next, revision: next.revision, offeringId, ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.automatically_scale_font_size !== undefined ? { automaticallyScaleFontSize: b.automatically_scale_font_size } : {}),
    }).where(eq(schema.paywalls.id, p.id)).returning();
    return c.json(await shape(c, row!, new Set()));
  });

  r.delete(`${P}/:paywall_id`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    await db.delete(schema.paywalls).where(eq(schema.paywalls.id, p.id));
    return c.json({ object: "paywall", id: p.id, deleted_at: deps.now().getTime() });
  });

  r.post(`${P}/:paywall_id/actions/attach_offering`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    const b = await body(c, Attach);
    const { offering, taken } = await offeringOf(p.projectId, b.offering_id);
    if (taken && taken !== p.id) throw conflict("That offering already has a paywall.", "offering_id");
    const [row] = await db.update(schema.paywalls).set({ offeringId: offering.id }).where(eq(schema.paywalls.id, p.id)).returning();
    return c.json(await shape(c, row!, new Set()));
  });
  r.post(`${P}/:paywall_id/actions/detach_offering`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    const [row] = await db.update(schema.paywalls).set({ offeringId: null }).where(eq(schema.paywalls.id, p.id)).returning();
    return c.json(await shape(c, row!, new Set()));
  });

  r.post(`${P}/:paywall_id/actions/publish`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    const draft = p.draft;
    if (!draft) throw new V2Error(422, "unprocessable_entity_error", "There are no unpublished changes to publish.");
    if (!p.offeringId) throw new V2Error(422, "unprocessable_entity_error", "Attach the paywall to an offering before publishing it.", "offering_id");
    const [row] = await db.update(schema.paywalls).set({ published: draft, draft: null, publishedAt: deps.now() }).where(eq(schema.paywalls.id, p.id)).returning();
    return c.json(await shape(c, row!, new Set()));
  });
  r.post(`${P}/:paywall_id/actions/unpublish`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    if (!p.published) throw new V2Error(422, "unprocessable_entity_error", "The paywall is not published.");
    // The unpublished content is kept as the draft unless there is a newer one.
    const [row] = await db.update(schema.paywalls).set({ draft: p.draft ?? p.published, published: null, publishedAt: null }).where(eq(schema.paywalls.id, p.id)).returning();
    return c.json(await shape(c, row!, new Set()));
  });

  r.post(`${P}/:paywall_id/actions/duplicate`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    const b = await body(c, Duplicate);
    const source = b.source_version === "published" ? p.published : p.draft ?? p.published;
    if (!source) throw conflict("The paywall is not published, so there is no published version to duplicate.", "source_version");
    let offeringId: string | null = null;
    if (b.offering) {
      const [dup] = await db.select({ id: schema.offerings.id }).from(schema.offerings).where(and(eq(schema.offerings.projectId, p.projectId), eq(schema.offerings.lookupKey, b.offering.lookup_key))).limit(1);
      if (dup) throw conflict(`An offering with lookup key ${b.offering.lookup_key} already exists.`, "offering.lookup_key");
      const [o] = await db.insert(schema.offerings).values({ id: newId("ofrng", 10), projectId: p.projectId, lookupKey: b.offering.lookup_key, displayName: b.offering.display_name, isCurrent: false, createdAt: deps.now() }).returning();
      offeringId = o!.id;
    }
    const [row] = await db.insert(schema.paywalls).values({
      id: newId("pw", 14), projectId: p.projectId, name: b.name ?? `${p.name ?? "Paywall"} Copy`, offeringId, automaticallyScaleFontSize: p.automaticallyScaleFontSize,
      revision: 1, draft: { ...source, revision: 1 }, createdAt: deps.now(),
    }).returning();
    return c.json(await shape(c, row!, new Set()), 201);
  });

  const versionOut = (v: typeof schema.paywallVersions.$inferSelect) => ({
    object: "paywall_version" as const, id: v.id, name: v.name, revision: v.revision, created_at: v.createdAt.getTime(), components_config: v.content.components_config,
    components_localizations: v.content.components_localizations, default_locale: v.content.default_locale, automatically_scale_font_size: v.content.automatically_scale_font_size,
    exit_offers: v.content.exit_offers ?? null, state_declarations: v.content.state_declarations ?? null, play_store_product_change_mode: v.content.play_store_product_change_mode ?? null,
  });
  r.post(`${P}/:paywall_id/versions`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    const b = await body(c, NewVersion);
    const content = p.draft ?? p.published;
    if (!content) throw new V2Error(422, "unprocessable_entity_error", "The paywall has no content to snapshot.");
    const [v] = await db.insert(schema.paywallVersions).values({ id: newId("pwv", 14), paywallId: p.id, name: b.name, revision: p.revision, content, createdAt: deps.now() }).returning();
    return c.json(versionOut(v!), 201);
  });
  r.get(`${P}/:paywall_id/versions/:version_id`, scope("project_configuration:offerings:read"), async (c) => {
    const p = await find(c);
    const [v] = await db.select().from(schema.paywallVersions).where(and(eq(schema.paywallVersions.paywallId, p.id), eq(schema.paywallVersions.id, c.req.param("version_id")!))).limit(1);
    if (!v) throw notFound("Paywall version");
    return c.json(versionOut(v));
  });

  // RevenueDot extension: the dashboard's template form for a paywall, kept next to the draft it produced.
  r.get(`${P}/:paywall_id/template`, scope("project_configuration:offerings:read"), async (c) => {
    const p = await find(c);
    return c.json({ object: "paywall_template", paywall_id: p.id, template: p.template ?? null });
  });
  r.put(`${P}/:paywall_id/template`, scope("project_configuration:offerings:read_write"), async (c) => {
    const p = await find(c);
    const b = await body(c, z.object({ template: z.record(z.unknown()).nullable() }).strict());
    if (b.template && JSON.stringify(b.template).length > 50_000) throw paramError("template is larger than 50 KB.", "template");
    await db.update(schema.paywalls).set({ template: b.template }).where(eq(schema.paywalls.id, p.id));
    return c.json({ object: "paywall_template", paywall_id: p.id, template: b.template });
  });

  // ---- Media assets and fonts ----
  const assetBase = (c: V2Context) => `${publicOrigin(c)}/assets/${c.get("projectId")}`;
  const mediaShape = (a: typeof schema.mediaAssets.$inferSelect, base: string) => ({
    object: "media_asset" as const, id: a.id, object_name: a.objectName, original_name: a.originalName, original_size: Math.ceil(a.size / 1024), original_width: a.width, original_height: a.height,
    formats: { original: { object: "media_asset_format" as const, object_name: a.objectName, size: Math.ceil(a.size / 1024), width: a.width, height: a.height } },
    alt_text: a.altText, is_decorative: false, asset_base_url: base, asset_type: "image" as const, video_metadata: null, transcoding_status: null,
  });
  const fontOut = (a: typeof schema.mediaAssets.$inferSelect, base: string) => {
    const m = a.meta as { name: string; family_name: string; style: string; weight: number };
    return { object: "font" as const, id: a.id, name: m.name, family_name: m.family_name, style: m.style, weight: m.weight, url: `${base}/${a.objectName}`, font_key: fontKey(a) };
  };
  const ASSET_LIMIT = 200;

  r.get("/v2/projects/:project_id/media_assets", scope("project_configuration:offerings:read"), async (c) => {
    const rows = await db.select().from(schema.mediaAssets).where(and(eq(schema.mediaAssets.projectId, c.get("projectId")), eq(schema.mediaAssets.kind, "image")));
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), (x) => mediaShape(x, assetBase(c))));
  });
  r.post("/v2/projects/:project_id/media_assets", scope("project_configuration:offerings:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, MediaIn);
    const bytes = decodeOrFail(b.file_data_base64);
    const count = await db.select({ id: schema.mediaAssets.id }).from(schema.mediaAssets).where(eq(schema.mediaAssets.projectId, projectId));
    if (count.length >= ASSET_LIMIT) throw new V2Error(422, "unprocessable_entity_error", `A project can hold ${ASSET_LIMIT} assets.`);
    const { width, height } = imageSize(bytes);
    const id = newId("ma", 14);
    const [row] = await db.insert(schema.mediaAssets).values({
      id, projectId, kind: "image", objectName: `${id}.${EXT[b.content_type]}`, originalName: b.filename, contentType: b.content_type, size: bytes.length, width, height, dataBase64: b.file_data_base64, createdAt: deps.now(),
    }).returning();
    return c.json(mediaShape(row!, assetBase(c)), 201);
  });
  r.get("/v2/projects/:project_id/fonts", scope("project_configuration:offerings:read"), async (c) => {
    const rows = await db.select().from(schema.mediaAssets).where(and(eq(schema.mediaAssets.projectId, c.get("projectId")), eq(schema.mediaAssets.kind, "font")));
    return c.json(paginate(c, rows, (x) => x.id, (x) => x.createdAt.getTime(), (x) => fontOut(x, assetBase(c))));
  });
  r.post("/v2/projects/:project_id/fonts", scope("project_configuration:offerings:read_write"), async (c) => {
    const projectId = c.get("projectId");
    const b = await body(c, FontIn);
    if (!/\.(ttf|otf)$/i.test(b.filename)) throw paramError("filename must end in .ttf or .otf.", "filename");
    const bytes = decodeOrFail(b.file_data_base64);
    const info = fontInfo(bytes);
    if (!info) throw paramError("The file is not a readable TrueType or OpenType font.", "file_data_base64");
    const id = newId("fnt", 14);
    const [row] = await db.insert(schema.mediaAssets).values({
      id, projectId, kind: "font", objectName: `${id}.${EXT[b.content_type]}`, originalName: b.filename, contentType: b.content_type, size: bytes.length, dataBase64: b.file_data_base64,
      meta: { ...info, hash: await md5Hex(bytes) }, createdAt: deps.now(),
    }).returning();
    return c.json(fontOut(row!, assetBase(c)), 201);
  });
}

function decodeOrFail(b64: string): Uint8Array {
  try { return b64decode(b64); } catch { throw paramError("file_data_base64 is not valid base64.", "file_data_base64"); }
}
