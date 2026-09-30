import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../../context.js";
import { body, listOf, notFound, paginate, paramError, scope, type V2Router } from "./common.js";
import { appShape } from "./shapes.js";

const APP_TYPES = ["amazon", "app_store", "mac_app_store", "play_store", "stripe", "rc_billing", "roku", "paddle", "test_store"] as const;

/** Public SDK key prefix per store, matching the prefixes the RevenueCat SDKs expect. */
const KEY_PREFIX: Record<string, string> = {
  app_store: "appl_", mac_app_store: "mac_", play_store: "goog_", amazon: "amzn_", stripe: "strp_", rc_billing: "rcb_", roku: "roku_", paddle: "pdl_", test_store: "test_",
};

const details = z.record(z.unknown());
const AppCreate = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(APP_TYPES),
  app_store: details.optional(), mac_app_store: details.optional(), play_store: details.optional(), amazon: details.optional(),
  stripe: details.optional(), rc_billing: details.nullable().optional(), roku: details.nullable().optional(), paddle: details.nullable().optional(),
});
const AppUpdate = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  app_store: details.optional(), mac_app_store: details.optional(), play_store: details.optional(), amazon: details.optional(),
  stripe: details.optional(), rc_billing: details.optional(), roku: details.optional(), paddle: details.optional(),
});

/** The identifier field each store's details must carry (stored in `apps.bundle_id`). */
const ID_FIELD: Record<string, string> = { app_store: "bundle_id", mac_app_store: "bundle_id", play_store: "package_name", amazon: "package_name" };

/** Splits a store details object into the bundle/package id and the rest (credentials and settings, stored as given). */
function splitDetails(type: string, d: Record<string, unknown> | null | undefined) {
  const out: Record<string, unknown> = {};
  let id: string | undefined;
  for (const [k, v] of Object.entries(d ?? {})) {
    if (k === ID_FIELD[type]) { if (typeof v !== "string" || !v) throw paramError(`${type}.${k} must be a non-empty string.`, `${type}.${k}`); id = v; continue; }
    if (v !== undefined) out[k] = v;
  }
  return { id, rest: out };
}

const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export function appRoutes(r: V2Router, deps: Deps) {
  const { db } = deps;
  const P = "/v2/projects/:project_id/apps";
  const find = async (projectId: string, id: string) => {
    const [a] = await db.select().from(schema.apps).where(and(eq(schema.apps.projectId, projectId), eq(schema.apps.id, id))).limit(1);
    if (!a) throw notFound("App");
    return a;
  };

  r.get(P, scope("project_configuration:apps:read"), async (c) => {
    const rows = await db.select().from(schema.apps).where(eq(schema.apps.projectId, c.get("projectId")));
    return c.json(paginate(c, rows, (a) => a.id, (a) => a.createdAt.getTime(), appShape));
  });

  r.post(P, scope("project_configuration:apps:read_write"), async (c) => {
    const b = await body(c, AppCreate);
    const d = b[b.type as keyof typeof b] as Record<string, unknown> | null | undefined;
    const { id: bundleId, rest } = splitDetails(b.type, d);
    if (ID_FIELD[b.type] && !bundleId) throw paramError(`${b.type}.${ID_FIELD[b.type]} is required for ${b.type} apps.`, `${b.type}.${ID_FIELD[b.type]}`);
    const [row] = await db.insert(schema.apps).values({
      id: newId("app", 8), projectId: c.get("projectId"), name: b.name, type: b.type, bundleId: bundleId ?? null,
      publicKey: `${KEY_PREFIX[b.type]}${randomKey()}`, credentials: rest, createdAt: deps.now(),
    }).returning();
    return c.json(appShape(row!), 201);
  });

  r.get(`${P}/:app_id`, scope("project_configuration:apps:read"), async (c) => c.json(appShape(await find(c.get("projectId"), c.req.param("app_id")))));

  r.post(`${P}/:app_id`, scope("project_configuration:apps:read_write"), async (c) => {
    const a = await find(c.get("projectId"), c.req.param("app_id"));
    const b = await body(c, AppUpdate);
    for (const t of APP_TYPES) if (t !== a.type && b[t as keyof typeof b] !== undefined) throw paramError(`${t} details can only be sent for ${t} apps.`, t);
    const { id: bundleId, rest } = splitDetails(a.type, b[a.type as keyof typeof b] as Record<string, unknown> | undefined);
    // null clears a credential; other values replace it.
    const credentials: Record<string, unknown> = { ...a.credentials };
    for (const [k, v] of Object.entries(rest)) { if (v === null) delete credentials[k]; else credentials[k] = v; }
    const [row] = await db.update(schema.apps).set({ ...(b.name ? { name: b.name } : {}), ...(bundleId ? { bundleId } : {}), credentials })
      .where(and(eq(schema.apps.projectId, a.projectId), eq(schema.apps.id, a.id))).returning();
    return c.json(appShape(row!));
  });

  // Deleting an app deletes its products (and their entitlement/package links); purchases keep their history.
  r.delete(`${P}/:app_id`, scope("project_configuration:apps:read_write"), async (c) => {
    const a = await find(c.get("projectId"), c.req.param("app_id"));
    await db.delete(schema.apps).where(and(eq(schema.apps.projectId, a.projectId), eq(schema.apps.id, a.id)));
    return c.json({ object: "app", id: a.id, deleted_at: deps.now().getTime() });
  });

  r.get(`${P}/:app_id/public_api_keys`, scope("project_configuration:apps:read"), async (c) => {
    const a = await find(c.get("projectId"), c.req.param("app_id"));
    return c.json(listOf(c, [{
      object: "public_api_key", id: `pk_${a.id}`, key: a.publicKey, environment: a.type === "test_store" ? "sandbox" : "production", app_id: a.id, created_at: a.createdAt.getTime(),
    }], null));
  });
}

