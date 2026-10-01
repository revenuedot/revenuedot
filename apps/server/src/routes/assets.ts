import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { paywallIconSvg } from "@revenuedot/core";
import { schema } from "@revenuedot/db";
import type { Deps } from "../context.js";
import { b64decode } from "../services/paywalls.js";
import { ICON_PNG } from "../services/paywall-icons.generated.js";

/**
 * The paywall asset CDN (prd/paywalls/PRD.md §4).
 * - `GET /assets/{project_id}/{object_name}`: uploaded images and fonts. The SDK downloads them from `asset_base_url` +
 *   the object name stored in the paywall. Object names are random ids, so a URL is not guessable and never changes
 *   content: responses are immutable, with a strong ETag (304 on If-None-Match). On Cloud the Worker keeps a copy in the
 *   Cloudflare edge cache, so repeat downloads do not query the database.
 * - `GET /assets/icons/{name}.png|svg`: the built-in icons for icon and timeline components.
 * - `GET /blobs/{ref}`: remote-config blobs by content ref.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";

interface EdgeCache { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> }
/** The Workers edge cache (`caches.default`), absent on Node. */
const edgeCache = (): EdgeCache | null => (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches?.default ?? null;

function send(c: Context, bytes: Uint8Array | string, contentType: string, etag: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    "content-type": contentType, "cache-control": IMMUTABLE, "access-control-allow-origin": "*", "x-content-type-options": "nosniff", etag,
    "content-length": String(typeof bytes === "string" ? new TextEncoder().encode(bytes).length : bytes.length), ...extra,
  };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").map((x) => x.trim().replace(/^W\//, "")).includes(etag)) {
    delete headers["content-length"];
    return new Response(null, { status: 304, headers });
  }
  return new Response(c.req.method === "HEAD" ? null : (bytes as BodyInit), { headers });
}

export function assetRoutes(deps: Deps) {
  const r = new Hono();
  // HEAD is answered by these GET routes (Hono runs the GET handler and drops the body).
  r.get("/assets/icons/:file", (c) => {
    const m = /^([a-z0-9_]+)\.(png|svg|heic|webp)$/.exec(c.req.param("file"));
    const name = m?.[1] ?? "";
    if (!m || !ICON_PNG[name]) return c.json({ object: "error", type: "resource_missing", message: "Icon not found. Icons: see https://revenuedot.app/docs/guides/paywalls#icons." }, 404);
    // .heic and .webp names serve the PNG: the SDKs decode the bytes, not the extension.
    if (m[2] === "svg") return send(c, paywallIconSvg(name, "#000000")!, "image/svg+xml", `"icon-${name}-svg-1"`);
    return send(c, b64decode(ICON_PNG[name]!), "image/png", `"icon-${name}-1"`);
  });
  r.get("/assets/:project_id/:object", async (c) => {
    const cache = edgeCache();
    const key = cache ? new Request(new URL(c.req.url).toString(), { method: "GET" }) : null;
    if (cache && key && c.req.method === "GET" && !c.req.header("if-none-match")) {
      const hitRes = await cache.match(key).catch(() => undefined);
      if (hitRes) return hitRes;
    }
    const [a] = await deps.db.select().from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.projectId, c.req.param("project_id")), eq(schema.mediaAssets.objectName, c.req.param("object")))).limit(1);
    if (!a) return c.json({ object: "error", type: "resource_missing", message: "Asset not found." }, 404);
    const extra: Record<string, string> = a.width && a.height ? { "x-image-width": String(a.width), "x-image-height": String(a.height) } : {};
    const res = send(c, b64decode(a.dataBase64), a.contentType, `"${a.id}"`, extra);
    if (cache && key && c.req.method === "GET" && res.status === 200) {
      const put = cache.put(key, res.clone()).catch(() => undefined);
      try { (c as unknown as { executionCtx: { waitUntil(p: Promise<unknown>): void } }).executionCtx.waitUntil(put); } catch { /* no execution context on Node */ }
    }
    return res;
  });
  // Remote-config blobs by content ref. Public: the SDK downloads them without credentials; a ref is a SHA-256 of the bytes.
  r.get("/blobs/:ref", async (c) => {
    const [b] = await deps.db.select().from(schema.configBlobs).where(eq(schema.configBlobs.ref, c.req.param("ref"))).limit(1);
    if (!b) return c.json({ object: "error", type: "resource_missing", message: "Blob not found." }, 404);
    return send(c, b.data, "application/json", `"${c.req.param("ref")}"`);
  });
  return r;
}
