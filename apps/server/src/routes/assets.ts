import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { b64decode } from "../services/paywalls.js";

/**
 * Public, cacheable files for paywalls: `GET /assets/{project_id}/{object_name}`. The SDK downloads images and fonts from
 * `asset_base_url` + the object name stored in the paywall. Object names are random ids, so a URL is not guessable and
 * never changes content; every response is immutable.
 */
export function assetRoutes(deps: Deps) {
  const r = new Hono();
  r.get("/assets/:project_id/:object", async (c) => {
    const [a] = await deps.db.select().from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.projectId, c.req.param("project_id")), eq(schema.mediaAssets.objectName, c.req.param("object")))).limit(1);
    if (!a) return c.json({ object: "error", type: "resource_missing", message: "Asset not found." }, 404);
    return new Response(b64decode(a.dataBase64), {
      headers: { "content-type": a.contentType, "cache-control": "public, max-age=31536000, immutable", "access-control-allow-origin": "*", "x-content-type-options": "nosniff", etag: `"${a.id}"` },
    });
  });
  return r;
}
